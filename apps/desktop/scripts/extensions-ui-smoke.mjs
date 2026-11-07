/** Disposable Core acceptance: configured extensions and immutable startup MCP tools. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

export function assertCounts(actual, expected) {
  assert.deepEqual(actual, expected, "Configured category counts");
}
export function assertMcpRow(rows, name, source, enabled, status) {
  const row = rows.find(item => item.name === name && item.source.startsWith(source));
  assert(row, `Missing ${source} fixture row`);
  assert.equal(row.enabled, enabled, "Saved switch state");
  assert.equal(row.status, status, "Current host status");
}
export function assertLossless(before, after, names) {
  const expected = structuredClone(before);
  for (const name of names) expected.mcpServers[name].enabled = false;
  assert.deepEqual(after, expected, "Only the requested enabled flags may change");
}
export function observeToolCatalog(input) {
  const tools = input.tools ?? [];
  // Background title requests have no tool catalog and are not agent turns.
  return tools.length ? { echo: tools.some(tool => /healthy.*echo/.test(tool.function?.name ?? "")) } : null;
}
export function assertLayout(view) {
  assert(view.triggerVisible && view.warning, "Visible trigger retains failure warning");
  assert(!view.overflow, "No horizontal overflow");
  assert(view.left >= 0 && view.right <= view.width && view.top >= 0 && view.bottom <= view.height, "Panel fits viewport");
}
export function assertConsentPending(view) {
  assert.equal(view.reason, true, "Consent-pending entry explains where approval is needed");
  assert.equal(view.switches, 0, "Consent-pending MCP entry has no write control");
}
export function assertPluginConsentRows(rows) {
  const trusted = rows.find(row => row.name === "plugin_b-plugin_api");
  assert.equal(trusted?.source, "Plugin", "Trusted project plugin is listed");
  assert.equal(trusted.note, "Read-only; manage in Plugins", "Workspace trust covers the project plugin");
  assert.equal(trusted.switches, 0, "Project plugin MCP stays read-only");
  const pending = rows.find(row => row.name === "plugin_pending-user_api");
  assert.equal(pending?.source, "Plugin", "User plugin without MCP consent is listed");
  assertConsentPending({ reason: pending.note === "Needs approval in Plugins", switches: pending.switches });
}
export function assertNativeUnavailable(view) {
  assert(view.text.includes("These language servers are saved for Core sessions. This engine does not use AnyCode LSP."), "Honest native capability reason");
  assert.equal(view.switches, 0, "Unsupported LSP has no write control");
  assert.equal(view.details, false, "Unsupported LSP has no live status action");
  assert.equal(view.restart, false, "Unsupported LSP has no restart action");
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  assert.equal(process.argv.length, 2, "This driver does not accept attach or profile arguments");
  const profile = mkdtempSync(join(tmpdir(), "anycode-extensions-"));
  const results = { status: "INCOMPLETE", checks: [], profile };
  let app, cdp, api;
  let phase = "launch";
  const requests = [];
  // Retain only tool availability, never model prompts, configuration bytes or tokens.
  const fixture = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      try {
        const input = JSON.parse(body);
        const observed = observeToolCatalog(input);
        if (observed) requests.push(observed);
        const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model" };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Local fixture response." }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
      } catch {
        response.writeHead(400); response.end();
      }
    });
  });
  async function poll(fn, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (results.rendererFailure) throw new Error("Renderer acceptance failure");
      if (app && app.exitCode !== null) throw new Error("Disposable launcher exited");
      const value = await fn(); if (value) return value; await sleep(100); }
    throw new Error(`Timed out: ${phase}`);
  }
  async function evaluate(expression) {
    const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${phase}`);
    return result.result.value;
  }
  async function click(selector) {
    const point = await poll(() => evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || e.disabled) return null;
      const r = e.getBoundingClientRect(); return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null;
    })()`));
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  }
  async function key(key, shift = false) {
    const codes = { Escape: 27, Tab: 9, Enter: 13, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37 };
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 });
  }
  const escape = () => key("Escape");
  async function focused(selector) {
    results.focusStep = selector;
    await poll(() => evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`));
    delete results.focusStep;
  }
  async function keyboard() {
    // Reach the trigger by real browser tab order, starting at the current focus.
    for (let i = 0; i < 80; i++) {
      if (await evaluate(`document.activeElement?.matches('${trigger}')`)) break;
      await key("Tab");
    }
    await focused(trigger);
    await key("ArrowDown"); await focused(".session-extensions-category:first-child");
    await key("ArrowDown"); await focused(".session-extensions-category:nth-child(2)");
    await key("ArrowUp"); await key("ArrowRight"); await focused(".session-extensions-details");
    assert.equal(await evaluate("!!document.querySelector('.session-extensions-back')"), false, "Columns have no Back button");
    await key("Tab"); await focused('[role="switch"]');
    await key("Tab", true); await focused(".session-extensions-category:first-child");
    await key("ArrowRight"); await focused(".session-extensions-details");
    await key("ArrowLeft"); await focused(".session-extensions-category:first-child");
    // Hover only highlights; selection and focus remain stable.
    const rect = await evaluate(`(() => {const r=document.querySelector('.session-extensions-category:nth-child(2)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect });
    await sleep(250); await focused(".session-extensions-category:first-child");
    assert.equal(await evaluate("document.querySelector('.session-extensions-details').getAttribute('aria-label')"), "MCP");
    await escape(); await focused(trigger);
    await key("ArrowDown");
    await key("Tab", true);
    await poll(() => evaluate(`!document.querySelector('${panel}')`));
    assert.equal(await evaluate(`document.activeElement?.matches('${trigger}')`), false, "Tab exit keeps destination focus");
    const destination = await evaluate("document.activeElement?.className");
    await sleep(200);
    assert.equal(await evaluate("document.activeElement?.className"), destination, "No late focus restore");
    for (let i = 0; i < 80; i++) {
      if (await evaluate(`document.activeElement?.matches('${trigger}')`)) break;
      await key("Tab");
    }
    await focused(trigger); await key("ArrowDown");
    for (let i = 0; i < 40; i++) {
      await key("Tab");
      if (await evaluate(`!document.querySelector('${panel}')`)) break;
    }
    assert.equal(await evaluate(`!!document.querySelector('${panel}')`), false, "Forward Tab exits menu");
    assert.equal(await evaluate(`document.activeElement?.matches('${trigger}')`), false, "Forward exit preserves focus");
    results.checks.push("keyboard-arrows-switch-left-escape-shift-tab", "hover-preserves-selection-and-focus");
  }
  async function layouts() {
    // Electron does not expose Chrome's Browser.setWindowBounds. Exercise the
    // renderer viewport at the supported minimum; never emulate below 720px.
    results.layoutDriver = "CDP viewport emulation (720/1100); native window resize not checked";
    const theme = await evaluate("document.documentElement.dataset.theme");
    try {
      for (const width of [1100, 720]) {
        await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
        await poll(() => evaluate(`window.innerWidth === ${width}`));
        for (const theme of ["dark", "light"]) {
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await openMcp();
          assertLayout(await evaluate(`(() => {
            const p=document.querySelector('${panel}'), r=p.getBoundingClientRect();
            const t=document.querySelector('${trigger}'), a=t.getBoundingClientRect();
            return { width:innerWidth, height:innerHeight, left:r.left, right:r.right, top:r.top, bottom:r.bottom,
              overflow:p.scrollWidth > p.clientWidth+1 || document.documentElement.scrollWidth > innerWidth,
              triggerVisible:a.width>0 && a.left>=0 && a.right<=innerWidth,
              warning:!!t.querySelector('.session-extensions-warning') };
          })()`));
          const geometry = () => evaluate(`(() => { const r=document.querySelector('${panel}').getBoundingClientRect(); return {left:r.left, top:r.top, width:r.width}; })()`);
          const before = await geometry();
          await click(".session-extensions-category:nth-child(3)");
          assert.deepEqual(await geometry(), before, "Category selection keeps panel geometry");
          await shot(`layout-${width}-${theme}`); await escape();
        }
      }
    } finally {
      await cdp.call("Emulation.clearDeviceMetricsOverride");
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    }
    results.checks.push("720-and-1100-light-dark-layout");
  }
  async function shot(name) {
    const result = await cdp.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  function json(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  }
  const trigger = ".session-extensions-trigger";
  const panel = ".session-extensions-panel";
  const statusConnected = "Connected in this session";
  const statusUnknown = "Status not reported in this session";
  async function rows() {
    return evaluate(`Array.from(document.querySelectorAll('.session-extensions-list li')).map(e => ({
      name:e.querySelector('.session-extensions-name').textContent,
      source:e.querySelector('.session-extensions-source').textContent,
      note:e.querySelector('.session-extensions-note')?.textContent,
      switches:e.querySelectorAll('[role=switch]').length,
      enabled:e.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true',
      status:e.querySelector('.session-extensions-status')?.textContent
    }))`);
  }
  async function openMcp() {
    await click(trigger);
    await click(".session-extensions-category:first-child");
    await poll(() => evaluate("/^\\d+$/.test(document.querySelector('.session-extensions-category:first-child [aria-live]')?.textContent ?? '') && !!document.querySelector('.session-extensions-list')"));
  }
  async function trustIfNeeded() {
    // A disposable project's declarations go through the normal trust decision.
    await sleep(300);
    const pending = await evaluate("!!document.querySelector('[data-workspace-trust-dialog][open]')");
    if (pending) await click("[data-workspace-trust-dialog] button:last-child");
  }
  async function create(workspace, engine = "core") {
    const tab = await evaluate(`window.anycode.createTab({kind:'new',workspace:${JSON.stringify(workspace)},engine:${JSON.stringify(engine)}})`);
    assert(tab.ok, "Create disposable tab");
    await api(`/tabs/${tab.tabId}/select`, "POST", {});
    await poll(async () => {
      await trustIfNeeded();
      return (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready";
    });
    return tab;
  }
  async function turn(tab, text, echo) {
    await poll(async () => {
      await trustIfNeeded();
      return (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready";
    });
    const before = requests.length;
    const rendered = await evaluate("document.querySelectorAll('.message-loop-end').length");
    await api(`/tabs/${tab.tabId}/prompt`, "POST", { text });
    await poll(async () => {
      await trustIfNeeded();
      return requests.length > before && (await evaluate("document.querySelectorAll('.message-loop-end').length")) > rendered;
    });
    assert.equal(requests.at(-1).echo, echo, "MCP tool availability in loopback request");
    await poll(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId].turn.status === "idle");
  }
  try {
    await new Promise((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
    const binary = join(profile, "unavailable-engine");
    writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const binaries = {}, consents = [];
    const source = readFileSync(join(root, "apps/desktop/src/host/engine-switch-fixtures/native-double.mjs"), "utf8").replace(/^#![^\n]*\n/, "");
    for (const engine of ["codex", "claude"]) {
      const path = join(profile, `${engine}-double`);
      writeFileSync(path, `#!${realpathSync(process.execPath)}\nprocess.argv.push(${JSON.stringify(`--double-log=${join(profile, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n` + source, { mode: 0o700 });
      const stat = statSync(path);
      consents.push({ path: realpathSync(path), fingerprint: { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs }, grantedAt: new Date().toISOString() });
      binaries[engine] = path;
    }
    json(join(profile, "settings.json"), { version: 2,
      provider: { activeConnectionId: "local", custom: [{ id: "custom:local", name: "Local fixture", baseUrl, kind: "openai-compatible", models: ["fixture-model"] }],
        connections: [{ id: "local", providerId: "custom:local", model: "fixture-model", models: ["fixture-model"], transport: "openai-chat-completions", baseUrl, authOptional: true }] },
      tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false, trustedBinaries: consents },
    });
    // Fail promptly if dependency installation omitted the Electron binary.
    createRequire(import.meta.url)("../node_modules/electron");
    const env = { ...buildSmokeEnv(process.env, profile, 0, binaries.codex), HOME: profile,
      ANYCODE_CLAUDE_BIN: binaries.claude, ANYCODE_ENGINE_SWITCH_ENABLED: "1",
      ANYCODE_ISOLATED_NATIVE_FIXTURES: "1", ANYCODE_ISOLATED_FIXTURE_NODE: realpathSync(process.execPath) };
    app = launchSmokeElectron(spawn, { cwd: root, env, detached: true, stdio: "ignore" });
    app.on("error", () => { process.exitCode = 1; });
    cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: fn => poll(fn, 90000) });
    const receive = cdp.ws.onmessage;
    cdp.ws.onmessage = message => {
      receive(message);
      const { data } = message;
      const event = JSON.parse(data);
      if (event.method !== "Runtime.exceptionThrown") return;
      const detail = event.params.exceptionDetails;
      const description = detail.exception?.description ?? "";
      results.rendererFailure = (description.includes("plugins.") && description.includes("onChanged")) ? "Missing plugins.onChanged API" : ["Maximum update depth", "Cannot read properties", "not a function", "ReferenceError"].find(label => description.includes(label)) ?? "Unclassified exception";
      results.rendererLocation = detail.stackTrace?.callFrames?.slice(0, 2).map(frame => ({ line: frame.lineNumber, column: frame.columnNumber }));
    };
    await cdp.call("Runtime.enable");
    phase = "fixture setup";
    const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8"));
    api = async (path, method = "GET", body) => {
      let response;
      const deadline = Date.now() + 30000;
      do {
        response = await cdp.automation(info, path, method, body);
        if (response.status !== 503 || !(method === "GET" || path.endsWith("/select"))) break;
        await sleep(200);
      } while (Date.now() < deadline);
      if (!response.ok || response.result.ok === false) {
        results.refusedOperation = method === "GET" ? "state" : path.split("/").at(-1);
        results.httpStatus = response.status;
        results.refusal = typeof response.result.reason === "string" && /^[a-z_]+$/.test(response.result.reason) ? response.result.reason : "unknown";
        assert.fail("Verified automation request refused");
      }
      return response.result;
    };
    // Startup requires a pristine root: seed fixtures only after ownership verification.
    const a = join(profile, "workspace-a"), b = join(profile, "workspace-b");
    const inert = { command: join(profile, "missing-command-sentinel"), enabled: false };
    json(join(profile, ".anycode/config.json"), { mcpServers: { healthy: inert } });
    json(join(a, ".anycode/config.json"), { mcpServers: { "a-only": inert } });
    const configPath = join(b, ".anycode/config.json");
    const seeded = { mcpServers: {
      healthy: { command: process.execPath, args: [join(root, "packages/core/src/mcp/fixtures/fixture-server.mjs")], cwd: b,
        env: { EXTENSIONS_SENTINEL: "env-value-private-sentinel" }, enabled: true },
      broken: { ...inert, enabled: true }, off: inert,
    }, telemetry: { enabled: false, marker: "unrelated-value" },
      lspServers: [{ name: "fixture-lsp", command: binary, extensions: [".fixture"] }] };
    json(configPath, seeded);
    json(join(b, ".mcp.json"), { mcpServers: { "compat-only": inert } });
    json(join(b, ".anycode/plugins/b-plugin/.anycode-plugin/plugin.json"), {
      manifestVersion: 1, name: "b-plugin", version: "0.1.0", mcpServers: { api: inert },
    });
    // A user plugin has no implicit workspace trust and receives no saved MCP consent.
    json(join(profile, ".anycode/plugins/pending-user/.anycode-plugin/plugin.json"), {
      manifestVersion: 1, name: "pending-user", version: "0.1.0", mcpServers: { api: inert },
    });
    mkdirSync(join(b, ".anycode/skills/b-skill"), { recursive: true });
    writeFileSync(join(b, ".anycode/skills/b-skill/SKILL.md"), "---\nname: b-skill\ndescription: Local fixture skill\n---\nFixture instructions.\n");
    const first = await create(a);
    const second = await create(b);
    phase = "empty header";
    assert.equal(await evaluate(`document.querySelectorAll('.session-header ${trigger}').length`), 0);
    assert.equal(await evaluate("document.querySelectorAll('.session-header .environment-control-header .environment-trigger').length"), 0);
    results.checks.push("empty-header");
    phase = "Core startup";
    await turn(second, "Start local extensions fixture", true);
    // Failure must reach the CLOSED trigger before any menu interaction.
    await poll(() => evaluate(`!!document.querySelector('${trigger} .session-extensions-warning')`));
    await openMcp();
    await poll(async () => (await rows()).some(row => row.name === "healthy" && row.status === statusConnected));
    const counts = await poll(() => evaluate(`(() => {
      const c = [...document.querySelectorAll('.session-extensions-category')].slice(0, 4).map(e => e.querySelector('[aria-live]').textContent);
      return c.length === 4 && c.every(v => /^\\d+$/.test(v)) ? c.map(Number) : null;
    })()`));
    assertCounts(counts, [5, 2, 1, 1]);
    const initial = await rows();
    assertMcpRow(initial, "healthy", "Project", true, statusConnected);
    assertMcpRow(initial, "healthy", "User", false, "Shadowed by another scope");
    assertMcpRow(initial, "broken", "Project", true, "Connection failed");
    assertMcpRow(initial, "off", "Project", false, statusUnknown);
    assertPluginConsentRows(initial);
    assert(initial.some(row => row.name === "compat-only" && row.source.startsWith("Compatibility")));
    const display = await evaluate(`document.querySelector('${panel}').outerHTML`);
    for (const sentinel of ["env-value-private-sentinel", "missing-command-sentinel", "fixture-server.mjs"])
      assert(!display.includes(sentinel), "Private fixture fields must not enter menu DOM");
    await shot("startup-failure");
    await click('.session-extensions-category[data-extension-category="skills"]');
    await poll(() => evaluate("document.querySelector('.session-extensions-details')?.getAttribute('aria-label') === 'Skills' && document.querySelector('.session-extensions-name')?.textContent === 'b-skill'"));
    await shot("skills-final");
    await click('.session-extensions-category[data-extension-category="mcp"]');
    results.checks.push("counts-scopes-statuses", "closed-menu-failure", "display-redaction");
    await escape();
    phase = "keyboard navigation"; await keyboard();
    phase = "window layout and themes"; await layouts();
    await openMcp();
    phase = "save without live apply";
    for (const name of ["healthy", "broken"]) {
      await click(`[role=switch][aria-label="Project: ${name}; enabled for new session starts"]`);
      await poll(() => evaluate(`document.querySelector('[role=switch][aria-label="Project: ${name}; enabled for new session starts"]')?.getAttribute('aria-checked') === 'false'`));
    }
    assertLossless(seeded, JSON.parse(readFileSync(configPath, "utf8")), ["healthy", "broken"]);
    assertMcpRow(await rows(), "healthy", "Project", false, statusConnected);
    assertMcpRow(await rows(), "broken", "Project", false, "Connection failed");
    assert(await evaluate(`!!document.querySelector('${trigger} .session-extensions-warning')`));
    await shot("saved-current-host");
    await escape();
    await turn(second, "Existing host retains startup tools", true);
    results.checks.push("lossless-disable", "existing-host-tools-retained");
    phase = "tab isolation";
    await api(`/tabs/${first.tabId}/select`, "POST", {});
    await turn(first, "Isolated project A", false);
    assert.equal(await evaluate(`!!document.querySelector('${trigger} .session-extensions-warning')`), false);
    await openMcp();
    assert((await rows()).some(row => row.name === "a-only"));
    assert(!(await rows()).some(row => row.name === "broken"));
    await click(".session-extensions-category:nth-child(2)");
    await poll(() => evaluate("document.querySelector('.session-extensions-details .session-extensions-name')?.textContent === 'pending-user'"));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.session-extensions-details .session-extensions-name')].map(e => e.textContent)"),
      ["pending-user"], "Project A sees only the global plugin, not project B's plugin");
    await shot("project-a-isolation");
    await escape();
    await api(`/tabs/${second.tabId}/select`, "POST", {});
    await openMcp();
    assertMcpRow(await rows(), "broken", "Project", false, "Connection failed");
    await escape();
    results.checks.push("tab-status-and-plugin-isolation");
    phase = "new host with disabled-only config";
    const fresh = await create(b);
    await turn(fresh, "New host reads saved disabled state", false);
    await openMcp();
    const current = await rows();
    assertMcpRow(current, "healthy", "Project", false, statusUnknown);
    assertMcpRow(current, "broken", "Project", false, statusUnknown);
    assert.equal(await evaluate(`!!document.querySelector('${trigger} .session-extensions-warning')`), false);
    await shot("new-host-disabled");
    results.checks.push("new-host-tools-absent", "disabled-only-no-failure");
    await escape();
    for (const engine of ["codex", "claude"]) {
      phase = `${engine} native double`;
      const native = await create(b, engine);
      const rendered = await evaluate("document.querySelectorAll('.message-loop-end').length");
      await api(`/tabs/${native.tabId}/prompt`, "POST", { text: "Local native fixture" });
      await poll(async () => {
        await trustIfNeeded();
        return (await evaluate("document.querySelectorAll('.message-loop-end').length")) > rendered;
      });
      const unchanged = readFileSync(configPath, "utf8");
      await openMcp();
      assertMcpRow(await rows(), "healthy", "Project", false, statusUnknown);
      assert.equal(await evaluate(`document.querySelectorAll('${panel} .tone-success').length`), 0);
      assertPluginConsentRows(await rows());
      await shot(`${engine}-consent-pending`);
      await click(".session-extensions-category:nth-child(4)");
      assertNativeUnavailable(await evaluate(`({ text:document.querySelector('.session-extensions-details').textContent,
        switches:document.querySelectorAll('.session-extensions-details [role=switch]').length,
        restart:[...document.querySelectorAll('.session-extensions-details button')].some(e=>e.textContent==='Restart'),
        details:[...document.querySelectorAll('.session-extensions-details button')].some(e=>e.textContent==='Details') })`));
      await shot(`${engine}-lsp-unavailable`);
      for (const index of [2, 3]) {
        await click(`.session-extensions-category:nth-child(${index})`);
        assert(await evaluate("document.querySelector('.session-extensions-details').textContent.includes('Saved in AnyCode; this engine may not load these entries')"));
      }
      const counts = await evaluate("[...document.querySelectorAll('.session-extensions-category [aria-live]')].map(e=>Number(e.textContent))");
      assertCounts(counts, [5, 2, 1, 1]);
      assert.equal(readFileSync(configPath, "utf8"), unchanged, "Unsupported and consent-pending navigation cannot write config");
      await escape(); results.checks.push(`${engine}-catalog-unknown-readonly-unsupported`);
    }
    results.status = "PASS";
  } catch (error) {
    results.status = phase === "launch" ? "INCOMPLETE" : "FAIL";
    results.phase = phase;
    // Do not serialize raw CDP/IPC errors or page text into diagnostic evidence.
    results.reason = error?.code ?? error?.name ?? "Error";
    results.driverLine = Number(error?.stack?.match(/extensions-ui-smoke\.mjs:(\d+)/)?.[1]) || undefined;
    if (cdp) await shot("failure").catch(() => {});
    process.exitCode = 1;
  } finally {
    if (cdp) await cdp.call("Browser.close").catch(() => {});
    cdp?.ws.close();
    await sleep(500);
    if (app?.exitCode === null && app?.signalCode === null) {
      try { process.kill(-app.pid, "SIGTERM"); } catch {}
      await sleep(500);
      try { process.kill(-app.pid, "SIGKILL"); } catch {}
    }
    await new Promise(resolve => fixture.close(resolve));
    json(join(profile, "result.json"), results);
    console.log(JSON.stringify(results));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

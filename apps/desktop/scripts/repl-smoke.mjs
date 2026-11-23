/** Development-only Code Mode smoke. The profile, workspace and provider are disposable. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const offPrompt = "Check the original Native registry";
const replPrompt = "Run the Code Mode fixture";
const description = "Change the fixture once";
const callId = "call_repl_fixture";
const oldText = "const value = 'before';";
const newText = "const value = 'after'; // was: " + oldText;
const code = [
  `await call("Edit", ${JSON.stringify({ file_path: "fixture.js", old_string: oldText, new_string: newText })});`,
  'await call("Bash", { command: "touch should-not-run.txt" });',
  'await call("Write", { file_path: "should-not-follow.txt", content: "unexpected" });',
].join("\n");

async function waitFor(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await fn();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function startProvider(requests) {
  let servedScript = false;
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const latestUser = input.messages.findLast((message) => message.role === "user");
      const prompt = JSON.stringify(latestUser?.content ?? "");
      const tools = input.tools?.map((tool) => tool.function?.name) ?? [];
      requests.push({ prompt, tools });

      const sendScript = prompt.includes(replPrompt) && tools.includes("REPL") && !servedScript;
      const base = { id: "fixture-chat", object: "chat.completion.chunk", created: 0, model: input.model };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      function send(delta, finish = null) {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      }
      if (sendScript) {
        servedScript = true;
        send({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: {
          name: "REPL", arguments: JSON.stringify({ code, description }),
        } }] });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "Fixture finished." });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      console.error("Loopback provider failed:", error);
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
}

async function withDesktop(profile, binary, run) {
  const env = buildSmokeEnv(process.env, profile, 0, binary);
  const app = launchSmokeElectron(spawn, { env });
  let cdp;
  let discovery;
  let launchError;
  app.once("error", (error) => { launchError = error; });
  const exited = () => app.exitCode !== null || app.signalCode !== null;
  const wait = (fn, label) => waitFor(() => {
    if (launchError) throw launchError;
    if (exited()) throw new Error(`Electron exited (${app.exitCode ?? app.signalCode})`);
    return fn();
  }, label, 45_000);
  try {
    cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: (fn) => wait(fn, "verified Electron CDP") });
    discovery = await wait(() => {
      const path = join(profile, "automation.json");
      return existsSync(path) && JSON.parse(readFileSync(path, "utf8"));
    }, "automation discovery");
    async function api(path, body) {
      const { ok, result } = await cdp.automation(discovery, path, body === undefined ? "GET" : "POST", body);
      assert(ok && result?.ok !== false, `${path}: ${JSON.stringify(result)}`);
      return result;
    }
    async function evaluate(expression) {
      const value = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert(!value.exceptionDetails, value.exceptionDetails?.text);
      return value.result.value;
    }
    await wait(() => evaluate("!!document.querySelector('.sidebar-settings')"), "the main workspace shell");
    return await run({ api, evaluate, cdp });
  } finally {
    if (cdp && discovery && !exited()) await cdp.automation(discovery, "/quit", "POST", {}).catch(() => {});
    cdp?.ws.close();
    if (app.pid && !exited()) {
      await waitFor(exited, "Electron to quit", 5_000).catch(() => process.kill(-app.pid, "SIGTERM"));
      await waitFor(exited, "Electron launcher to exit", 5_000);
    }
  }
}

const profile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-repl-smoke-")));
const resumedProfile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-repl-resume-")));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "anycode-repl-workspace-")));
const settings = join(profile, "settings.json");
const binary = join(profile, "unavailable-engine");
const fixture = join(workspace, "fixture.js");
const requests = [];
const provider = startProvider(requests);

async function openTab(api, target) {
  const { tabId } = await api("/tabs", target);
  assert.equal(typeof tabId, "string");
  await api(`/tabs/${tabId}/select`, {});
  const state = async () => (await api(`/state/${tabId}`)).snapshot.states[tabId];
  await waitFor(async () => (await state())?.connection === "ready", "Native host ready");
  assert.equal((await state()).engine, undefined);
  return { tabId, state, post: (suffix, body) => api(`/tabs/${tabId}/${suffix}`, body) };
}

const toggleSelector = '#settings-pane-experimental button[role="switch"]';
const diffExpression = `(() => {
  const parent = document.querySelector('[data-tool-call-id="${callId}"]');
  const edits = parent?.querySelectorAll('[data-tool-call-id="${callId}.1"].tool-call-status-success');
  if (edits?.length !== 1) return null;
  const removed = edits[0].querySelector('.diff-line-del .diff-line-text')?.textContent;
  const added = edits[0].querySelector('.diff-line-add .diff-line-text')?.textContent;
  if (!removed || !added) return null;
  return { removed, added, sourceCollapsed: !parent.querySelector('details')?.open };
})()`;

try {
  await new Promise((resolve, reject) => provider.once("error", reject).listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  writeFileSync(fixture, `${oldText}\n`);
  writeFileSync(settings, JSON.stringify({
    version: 2,
    provider: {
      activeConnectionId: "conn-fixture",
      custom: [{ id: "custom:fixture", name: "Fixture", baseUrl, kind: "openai-compatible", models: ["fixture-model"] }],
      connections: [{ id: "conn-fixture", providerId: "custom:fixture", model: "fixture-model", models: ["fixture-model"],
        transport: "openai-chat-completions", baseUrl, authOptional: true }],
    },
    tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "light" }, security: { allowWeakSecretStorage: false },
  }));

  const { sessionId, liveDiff } = await withDesktop(profile, binary, async ({ api, evaluate, cdp }) => {
    const original = await openTab(api, { kind: "new", workspace });
    await api("/settings/open", {});
    await api("/settings/pane", { paneId: "experimental" });
    assert(await evaluate(`(() => {
      const toggle = document.querySelector(${JSON.stringify(toggleSelector)});
      if (toggle?.getAttribute('aria-checked') !== 'false') return false;
      toggle.focus();
      return document.activeElement === toggle;
    })()`));
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.call("Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    }
    await waitFor(() => JSON.parse(readFileSync(settings, "utf8")).tools.codeMode === true, "keyboard toggle to save");
    await api("/settings/close", {});
    await original.post("prompt", { text: offPrompt });
    const originalRequest = await waitFor(() => requests.find((request) => request.tools.length && request.prompt.includes(offPrompt)), "the original host's provider request");
    assert(!originalRequest.tools.includes("REPL"));
    console.log("PASS: Settings persists Code Mode via Space and leaves the original Native host unchanged.");

    const root = await openTab(api, { kind: "new", workspace });
    await root.post("mode", { mode: "edit" });
    await waitFor(async () => (await root.state()).mode === "edit", "Edit mode");
    await root.post("prompt", { text: replPrompt });
    const liveDiff = await waitFor(() => evaluate(diffExpression), "the live Edit diff");
    assert.deepEqual(liveDiff, { removed: oldText, added: newText, sourceCollapsed: true });
    assert(requests.some((request) => request.prompt.includes(replPrompt) && request.tools.includes("REPL")));
    assert.equal(readFileSync(fixture, "utf8"), `${newText}\n`);

    await waitFor(() => evaluate("document.querySelector('.permission-modal[open]')?.textContent.includes('from a Code Mode script')"), "the nested Bash approval label");
    assert.equal((await root.state()).permission.toolCallId, `${callId}.2`);
    await root.post("stop", {});
    await waitFor(async () => {
      const state = await root.state();
      return state.turn.status === "idle" && state.permission === null &&
        state.transcript.some((block) => block.kind === "tool_call" && block.toolCallId === callId && block.status === "cancelled");
    }, "the stopped Code Mode parent");
    assert(!existsSync(join(workspace, "should-not-run.txt")));
    assert(!existsSync(join(workspace, "should-not-follow.txt")));
    const { tabs } = await api(`/state/${root.tabId}`);
    const sessionId = tabs.find((tab) => tab.tabId === root.tabId)?.sessionId;
    assert.equal(typeof sessionId, "string");
    console.log("PASS: the live Edit applied once and Stop cancelled the parent at the nested approval.");
    return { sessionId, liveDiff };
  });

  const resumedBinary = join(resumedProfile, "unavailable-engine");
  copyFileSync(binary, resumedBinary);
  copyFileSync(settings, join(resumedProfile, "settings.json"));
  await withDesktop(resumedProfile, resumedBinary, async ({ api, evaluate }) => {
    // Each isolated launch requires a fresh profile. After startup, use
    // SQLite's online backup to restore the first run's durable database into
    // the database the second app created. Chromium data is never reused.
    const destination = JSON.stringify(join(resumedProfile, "db.sqlite"));
    execFileSync("/usr/bin/sqlite3", [join(profile, "db.sqlite"), `.backup ${destination}`], { encoding: "utf8", timeout: 5_000 });
    const root = await openTab(api, { kind: "resume", sessionId });
    assert.deepEqual(await waitFor(() => evaluate(diffExpression), "the restored Edit diff"), liveDiff);
    const matches = (await root.state()).transcript.filter((block) => block.kind === "tool_call" && block.toolCallId === callId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, "cancelled");
    assert.equal(matches[0].repl.calls.filter((call) => call.toolName === "Edit").length, 1);
    assert.equal(readFileSync(fixture, "utf8"), `${newText}\n`);
    assert(!existsSync(join(workspace, "should-not-follow.txt")));
    console.log("PASS: the cancelled REPL and one Edit diff rehydrate after Electron restarts.");
  });
} finally {
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  rmSync(profile, { recursive: true, force: true });
  rmSync(resumedProfile, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

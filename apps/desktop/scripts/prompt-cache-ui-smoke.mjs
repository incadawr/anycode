/**
 * GitHub #15 — live GUI + wire smoke for the OPT-IN OpenAI prompt cache.
 *
 * One disposable dev instance, one disposable profile, one LOCAL RECORDING
 * OpenAI-compatible endpoint. Nothing here touches the owner's real
 * `~/.anycode`, a real provider, or a real credential: the "API key" is a
 * fixture string that only ever travels to 127.0.0.1, and the recorder never
 * logs an Authorization header.
 *
 * What it proves, in order:
 *
 *   1. The Advanced drawer shows `Prompt caching` for the two OpenAI
 *      transports (resolved from the catalog entry's own default, not from a
 *      guessed Anthropic fallback) and HIDES it for an Anthropic connection.
 *   2. A connection saved Off sends NO `prompt_cache_options` on either wire
 *      format, and the popover reports the fixture's honest numeric zero.
 *   3. Selecting `Implicit · 30 minutes` persists through save + reopen, and a
 *      NEW host (new tab) sends exactly
 *      `"prompt_cache_options":{"mode":"implicit","ttl":"30m"}` on every
 *      request — with `store:false` still present on `/v1/responses`.
 *   4. The context popover then shows `Latest cache hit: 80% (16K/20K input)`
 *      and the durable audit line reports the same 80% from the LAST STEP.
 *   5. Switching back to Off on a new host returns to the cache-field-free
 *      request, and the persisted settings no longer carry the key.
 *
 * HONESTY LIMIT (repeat it when reporting): this is a RECORDER. It proves
 * outgoing bytes and the display path, not real GPT-5.6+ provider caching or
 * billing. Upstream savings still need an authorized gateway and a stable long
 * prefix.
 *
 * Usage:
 *   node apps/desktop/scripts/prompt-cache-ui-smoke.mjs --transport openai-chat-completions
 *   node apps/desktop/scripts/prompt-cache-ui-smoke.mjs --transport openai-responses [--keep]
 *
 * Requires `pnpm` on PATH (launches `pnpm --filter @anycode/desktop dev`).
 * Every artifact (recorded bodies, screenshots, the isolated profile) lands in
 * a fresh temp directory printed on exit; `--keep` keeps it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ──

const FIXTURE_MODEL = "gpt-5.6-cache-fixture";
const FIXTURE_KEY = "sk-prompt-cache-smoke-only";
const CACHE_OPTIONS_JSON = '{"mode":"implicit","ttl":"30m"}';
const INPUT_TOKENS = 20_000;
const CACHED_TOKENS = 16_000; // 80% — the popover's expected figure
const TURN_PROMPT = "Reply with exactly the word: done. Do not say anything else.";
const CONNECTION_ID = "conn-prompt-cache-smoke";
const ANTHROPIC_CONNECTION_ID = "conn-prompt-cache-anthropic";

let transport = "openai-chat-completions";
let keep = false;
let checkArgs = false;
let transportSeen = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--keep") keep = true;
  else if (arg === "--check-args") checkArgs = true;
  else if (arg === "--transport" || arg.startsWith("--transport=")) {
    if (transportSeen) throw new Error("--transport may be specified only once");
    transportSeen = true;
    transport = arg === "--transport" ? process.argv[++i] : arg.slice("--transport=".length);
    if (transport !== "openai-chat-completions" && transport !== "openai-responses") {
      throw new Error("--transport must be followed by openai-chat-completions or openai-responses");
    }
  } else throw new Error(`Unrecognized argument: ${arg}`);
}
if (checkArgs) {
  console.log(transport);
  process.exit(0);
}

const isResponses = transport === "openai-responses";
const API_PATH = isResponses ? "/v1/responses" : "/v1/chat/completions";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── local recording OpenAI-compatible endpoint ──

/** @type {{path: string, body: string, hasCache: boolean, cacheMatches: boolean, cached: number}[]} */
const recorded = [];

function cachedFor(hasCache) {
  if (!hasCache) return 0;
  // The FIRST request writes the cache; every later one reads it back.
  return recorded.filter((entry) => entry.hasCache).length >= 1 ? CACHED_TOKENS : 0;
}

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  if (!isResponses) res.write("data: [DONE]\n\n");
  res.end();
}

const recorder = createHttpServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: FIXTURE_MODEL, object: "model" }] }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* recorded below as a non-cache body */
    }
    const hasCache = typeof parsed === "object" && parsed !== null && "prompt_cache_options" in parsed;
    const cacheMatches = hasCache && JSON.stringify(parsed.prompt_cache_options) === CACHE_OPTIONS_JSON;
    const cached = hasCache ? cachedFor(cacheMatches) : 0;
    recorded.push({ path: req.url ?? "", body: raw, hasCache, cacheMatches, cached });
    if (isResponses) {
      sse(res, [
        { type: "response.created", response: { id: `resp_${recorded.length}`, created_at: 1_700_000_000, model: FIXTURE_MODEL } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "done" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: INPUT_TOKENS,
              input_tokens_details: { cached_tokens: cached },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]);
      return;
    }
    sse(res, [
      {
        id: `chatcmpl_${recorded.length}`,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
      },
      {
        id: `chatcmpl_${recorded.length}`,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: INPUT_TOKENS,
          completion_tokens: 4,
          total_tokens: INPUT_TOKENS + 4,
          prompt_tokens_details: { cached_tokens: cached },
        },
      },
    ]);
  });
});

await new Promise((resolve, reject) => recorder.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
const recorderPort = recorder.address().port;
const baseUrl = `http://127.0.0.1:${recorderPort}/v1`;

// ── disposable profile ──

const profile = mkdtempSync(join(tmpdir(), `anycode-prompt-cache-${isResponses ? "responses" : "chat"}-`));
const workspace = join(profile, "workspace");
mkdirSync(workspace, { recursive: true });
const settingsPath = join(profile, "settings.json");
const discoveryPath = join(profile, "automation.json");
const screenshotDir = join(profile, "shots");
mkdirSync(screenshotDir, { recursive: true });

/** The seeded document: ONE Off custom connection on the selected transport, plus an Anthropic sibling we only open in the drawer. */
function seededSettings() {
  return {
    version: 2,
    provider: {
      activeConnectionId: CONNECTION_ID,
      connections: [
        {
          id: CONNECTION_ID,
          providerId: "custom:prompt-cache-smoke",
          label: "Cache fixture",
          model: FIXTURE_MODEL,
          baseUrl,
          transport,
          authOptional: true,
        },
        {
          id: ANTHROPIC_CONNECTION_ID,
          providerId: "custom:prompt-cache-anthropic",
          label: "Anthropic fixture",
          model: "claude-fixture",
          baseUrl,
          transport: "anthropic-messages",
          authOptional: true,
        },
      ],
      custom: [
        {
          id: "custom:prompt-cache-smoke",
          name: "Local cache recorder",
          baseUrl,
          kind: isResponses ? "openai" : "openai-compatible",
          models: [FIXTURE_MODEL],
          authOptional: true,
        },
        {
          id: "custom:prompt-cache-anthropic",
          name: "Local anthropic fixture",
          baseUrl,
          kind: "anthropic",
          models: ["claude-fixture"],
          authOptional: true,
        },
      ],
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: true },
  };
}

writeFileSync(settingsPath, JSON.stringify(seededSettings(), null, 2));

// A reserved-then-released loopback port: nothing listens, so any engine probe
// fails instantly without touching a real network.
const probe = createNetServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const debugPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const stubEngine = join(profile, "unavailable-engine");
writeFileSync(stubEngine, "#!/bin/sh\nexit 1\n", { mode: 0o700 });

mkdirSync(join(profile, "home"), { recursive: true });
mkdirSync(join(profile, "tmp"), { recursive: true });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|LANG|LC_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|SYSTEMROOT|WINDIR)$/.test(key))),
  TMPDIR: join(profile, "tmp"),
  APPDATA: join(profile, "app-data"),
  LOCALAPPDATA: join(profile, "local-app-data"),
  HOME: join(profile, "home"),
  XDG_CONFIG_HOME: join(profile, "xdg-config"),
  XDG_DATA_HOME: join(profile, "xdg-data"),
  XDG_CACHE_HOME: join(profile, "xdg-cache"),
  XDG_STATE_HOME: join(profile, "xdg-state"),
  ANYCODE_PROFILE_HOME: join(profile, "home"),
  ANYCODE_MCP_IMPORT_HOME: join(profile, "home"),
  ANYCODE_SKILLS_IMPORT_HOME: join(profile, "home"),
  ANYCODE_SUBAGENTS_HOME: join(profile, "home"),
  ANYCODE_CODEX_PROFILES_HOME: join(profile, "home"),
  ANYCODE_TELEMETRY_DIR: join(profile, "telemetry"),
  ANYCODE_AUTOMATION: "1",
  REMOTE_DEBUGGING_PORT: String(debugPort),
  ANYCODE_AUTOMATION_INFO: discoveryPath,
  ANYCODE_USER_DATA_DIR: join(profile, "user-data"),
  ANYCODE_DB_PATH: join(profile, "db.sqlite"),
  ANYCODE_SETTINGS_PATH: settingsPath,
  ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
  ANYCODE_WORKSPACE: workspace,
  ANYCODE_CODEX_BIN: stubEngine,
  ANYCODE_CLAUDE_BIN: stubEngine,
  CODEX_HOME: join(profile, "codex-home"),
  CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
};
// No ambient provider env may pre-empt the seeded connection.
for (const key of [
  "ANYCODE_API_KEY",
  "ANYCODE_MODEL",
  "ANYCODE_BASE_URL",
  "ANYCODE_PROVIDER",
  "ANYCODE_TRANSPORT",
  "ANYCODE_PROMPT_CACHE_OPTIONS",
]) {
  delete env[key];
}

const app = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});

// ── automation facade ──

let info;
function readDiscovery() {
  try {
    const parsed = JSON.parse(readFileSync(discoveryPath, "utf8"));
    return typeof parsed?.port === "number" && typeof parsed?.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, `${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function poll(fn, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

// ── CDP (only for the DOM reads the facade does not project) ──

let ws;
let nextId = 0;
const pending = new Map();

function cdp(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function screenshot(name) {
  const png = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(screenshotDir, `${name}.png`), Buffer.from(png.data, "base64"));
}

/** The prompt-caching <select> inside the open connection drawer, found by its option copy. */
const CACHE_SELECT = `[...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === 'Implicit · 30 minutes')) ?? null`;

async function setCacheSelect(value) {
  const ok = await evaluate(`(() => {
    const select = ${CACHE_SELECT};
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.ok(ok, "prompt-caching select not found in the open drawer");
  await sleep(200);
}

async function cacheSelectValue() {
  return evaluate(`(() => { const select = ${CACHE_SELECT}; return select === null ? null : select.value; })()`);
}

// ── steps ──

const results = [];
function pass(step, detail) {
  results.push({ step, ok: true, detail });
  console.log(`[step ${step}] PASS ${detail}`);
}

try {
  info = await poll(() => readDiscovery(), "the automation discovery file", 120_000);

  const target = await poll(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        return list.find((entry) => entry.type === "page" && !entry.url.startsWith("devtools://"));
      } catch {
        return false;
      }
    },
    "the devtools page target",
    120_000,
  );
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  };

  // The seeded connection must be ready (no Welcome screen) before anything else.
  await poll(() => evaluate("!!document.querySelector('.start-screen') && !document.querySelector('.welcome-screen')"), "the start screen");

  // ── step 1: the field exists for the OpenAI transport and is Off ──
  assert.equal((await api("POST", "/settings/open", {})).ok, true);
  assert.equal((await api("POST", "/settings/pane", { paneId: "provider" })).ok, true);
  assert.equal((await api("POST", "/settings/provider/menu", { connectionId: CONNECTION_ID, action: "edit" })).ok, true);
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"), "the connection drawer");
  // Advanced must be open for the field to exist in the DOM.
  await evaluate("(() => { const d = document.querySelector('.connection-drawer-advanced'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()");
  await sleep(250);
  assert.equal(await cacheSelectValue(), "off", "a new connection must open with prompt caching Off");
  await screenshot("step-1-off-in-advanced");
  pass(1, `Advanced shows Prompt caching for ${transport}, Off on a connection that never saved a policy`);

  // ── step 2: an Anthropic connection hides the field ──
  assert.equal((await api("POST", "/settings/provider/drawer/close", {})).ok, true);
  assert.equal(
    (await api("POST", "/settings/provider/menu", { connectionId: ANTHROPIC_CONNECTION_ID, action: "edit" })).ok,
    true,
  );
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"), "the anthropic drawer");
  await evaluate("(() => { const d = document.querySelector('.connection-drawer-advanced'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()");
  await sleep(250);
  assert.equal(await cacheSelectValue(), null, "the Anthropic transport must not offer prompt caching");
  await screenshot("step-2-anthropic-hidden");
  pass(2, "the Anthropic connection hides Prompt caching entirely (no effect-less switch)");

  // ── step 3: Off sends no cache options, and the popover says zero ──
  assert.equal((await api("POST", "/settings/close", {})).ok, true);
  const offTab = await api("POST", "/tabs", { kind: "new", workspace });
  assert.equal(offTab.ok, true);
  const offTabId = offTab.tabId;
  const beforeOff = recorded.length;
  for (let turn = 0; turn < 2; turn += 1) {
    assert.equal((await api("POST", `/tabs/${offTabId}/prompt`, { text: TURN_PROMPT })).ok, true);
    const waited = await api("POST", "/wait", { tabId: offTabId, until: { turnStatus: "idle" }, timeoutMs: 120_000 });
    assert.equal(waited.matched, true, "turn did not settle");
  }
  const offBodies = recorded.slice(beforeOff);
  assert.ok(offBodies.length >= 2, `expected at least two provider requests, saw ${offBodies.length}`);
  for (const entry of offBodies) {
    assert.equal(entry.path.endsWith(isResponses ? "/responses" : "/chat/completions"), true, `unexpected path ${entry.path}`);
    assert.equal(entry.hasCache, false, "an Off connection must not send prompt_cache_options");
    if (isResponses) {
      assert.equal(JSON.parse(entry.body).store, false, "Responses must keep store:false");
    }
  }
  writeFileSync(join(profile, "off-bodies.jsonl"), offBodies.map((entry) => entry.body).join("\n"));

  assert.equal((await api("POST", `/tabs/${offTabId}/select`, {})).ok, true);
  await evaluate("(() => { const meter = document.querySelector('.composer-ctx-meter'); if (!meter) return false; meter.click(); return true; })()");
  const offPopover = await poll(
    () => evaluate("(() => { const p = document.querySelector('.ctx-popover'); return p ? p.textContent : null; })()"),
    "the context popover",
  );
  writeFileSync(join(profile, "off-popover.txt"), offPopover);
  assert.ok(
    /Latest cache hit: 0% \(0\/20K input\)/.test(offPopover),
    `the Off popover must report the fixture's numeric zero, got: ${offPopover}`,
  );
  await screenshot("step-3-off-popover");
  await evaluate("(() => { const meter = document.querySelector('.composer-ctx-meter'); if (meter) meter.click(); return true; })()");
  pass(3, `Off: ${offBodies.length} requests, no prompt_cache_options, store:false preserved, popover reports 0%`);

  // ── step 4: enable the policy in the drawer and verify persistence ──
  assert.equal((await api("POST", "/settings/open", {})).ok, true);
  assert.equal((await api("POST", "/settings/pane", { paneId: "provider" })).ok, true);
  assert.equal((await api("POST", "/settings/provider/menu", { connectionId: CONNECTION_ID, action: "edit" })).ok, true);
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"), "the connection drawer");
  await evaluate("(() => { const d = document.querySelector('.connection-drawer-advanced'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()");
  await sleep(250);
  await setCacheSelect("implicit");
  assert.equal(await cacheSelectValue(), "implicit");
  assert.equal((await api("POST", "/settings/provider/drawer/submit", {})).ok, true);
  await poll(() => {
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    return doc.provider.connections.find((connection) => connection.id === CONNECTION_ID)?.promptCache !== undefined;
  }, "the persisted prompt-cache policy");
  // Unmount before reopening so the selection must come from persisted settings.
  assert.equal((await api("POST", "/settings/provider/drawer/close", {})).ok, true);
  await poll(() => evaluate("!document.querySelector('.connection-drawer-body')"), "the closed drawer");
  assert.equal((await api("POST", "/settings/provider/menu", { connectionId: CONNECTION_ID, action: "edit" })).ok, true);
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"), "the reopened drawer");
  await evaluate("(() => { const d = document.querySelector('.connection-drawer-advanced'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()");
  await sleep(250);
  assert.equal(await cacheSelectValue(), "implicit", "the saved policy must reopen as Implicit");
  await screenshot("step-4-enabled-persisted");
  assert.equal((await api("POST", "/settings/provider/drawer/close", {})).ok, true);
  assert.equal((await api("POST", "/settings/close", {})).ok, true);
  pass(4, "Implicit · 30 minutes saved, persisted on disk, and reopened as the selected value");

  // ── step 5: a NEW host sends the option on every request; the popover shows 80% ──
  const onTab = await api("POST", "/tabs", { kind: "new", workspace });
  assert.equal(onTab.ok, true);
  const onTabId = onTab.tabId;
  const beforeOn = recorded.length;
  for (let turn = 0; turn < 2; turn += 1) {
    assert.equal((await api("POST", `/tabs/${onTabId}/prompt`, { text: TURN_PROMPT })).ok, true);
    const waited = await api("POST", "/wait", { tabId: onTabId, until: { turnStatus: "idle" }, timeoutMs: 120_000 });
    assert.equal(waited.matched, true, "enabled turn did not settle");
  }
  const onBodies = recorded.slice(beforeOn);
  assert.ok(onBodies.length >= 2, `expected at least two enabled provider requests, saw ${onBodies.length}`);
  for (const entry of onBodies) {
    assert.equal(entry.hasCache, true, `every enabled request must carry prompt_cache_options: ${entry.body.slice(0, 240)}`);
    assert.equal(entry.cacheMatches, true, `the option object must be exactly ${CACHE_OPTIONS_JSON}`);
    if (isResponses) {
      assert.equal(JSON.parse(entry.body).store, false, "Responses must keep store:false with caching on");
    }
  }
  writeFileSync(join(profile, "on-bodies.jsonl"), onBodies.map((entry) => entry.body).join("\n"));

  assert.equal((await api("POST", `/tabs/${onTabId}/select`, {})).ok, true);
  await evaluate("(() => { const meter = document.querySelector('.composer-ctx-meter'); if (!meter) return false; meter.click(); return true; })()");
  const onPopover = await poll(
    () => evaluate("(() => { const p = document.querySelector('.ctx-popover'); if (!p) return null; const text = p.textContent; return text.includes('cache') ? text : null; })()"),
    "the enabled context popover",
  );
  writeFileSync(join(profile, "on-popover.txt"), onPopover);
  assert.ok(
    onPopover.includes("Latest cache hit: 80% (16K/20K input)"),
    `expected the reported 80% cache hit, got: ${onPopover}`,
  );
  assert.ok(/80% cache \(16K\/20K input\)/.test(onPopover), `expected the audit line to report the last step's 80%, got: ${onPopover}`);
  await screenshot("step-5-on-popover");
  await evaluate("(() => { const meter = document.querySelector('.composer-ctx-meter'); if (meter) meter.click(); return true; })()");
  // Close and resume the same durable session, then inspect its restored audit.
  const state = await api("GET", "/state");
  const sessionId = state.tabs.find((tab) => tab.tabId === onTabId)?.sessionId;
  assert.ok(sessionId, "enabled tab must have a session id");
  assert.equal((await api("POST", `/tabs/${onTabId}/close`, {})).ok, true);
  const resumed = await api("POST", "/tabs", { kind: "resume", sessionId });
  assert.equal(resumed.ok, true);
  assert.equal((await api("POST", `/tabs/${resumed.tabId}/select`, {})).ok, true);
  await poll(() => evaluate("!!document.querySelector('.composer-ctx-meter')"), "the resumed context meter");
  await evaluate("document.querySelector('.composer-ctx-meter').click()");
  const resumedPopover = await poll(
    () => evaluate("(() => { const p = document.querySelector('.ctx-popover'); return p?.textContent?.includes('80% cache') ? p.textContent : null; })()"),
    "the restored audit",
  );
  assert.match(resumedPopover, /80% cache \(16K\/20K input\)/);
  writeFileSync(join(profile, "resumed-popover.txt"), resumedPopover);
  await screenshot("step-5-resumed-audit");
  await evaluate("document.querySelector('.composer-ctx-meter').click()");
  pass(5, `On: ${onBodies.length} requests each carrying ${CACHE_OPTIONS_JSON}, popover and restored audit report 80%`);

  // ── step 6: turning it back Off returns to the cache-free request ──
  assert.equal((await api("POST", "/settings/open", {})).ok, true);
  assert.equal((await api("POST", "/settings/pane", { paneId: "provider" })).ok, true);
  assert.equal((await api("POST", "/settings/provider/menu", { connectionId: CONNECTION_ID, action: "edit" })).ok, true);
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"), "the connection drawer");
  await evaluate("(() => { const d = document.querySelector('.connection-drawer-advanced'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()");
  await sleep(250);
  await setCacheSelect("off");
  assert.equal((await api("POST", "/settings/provider/drawer/submit", {})).ok, true);
  await poll(() => {
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    return doc.provider.connections.find((connection) => connection.id === CONNECTION_ID)?.promptCache === undefined;
  }, "the cleared prompt-cache policy");
  assert.equal((await api("POST", "/settings/provider/drawer/close", {})).ok, true);
  assert.equal((await api("POST", "/settings/close", {})).ok, true);

  const offAgainTab = await api("POST", "/tabs", { kind: "new", workspace });
  assert.equal(offAgainTab.ok, true);
  const beforeOffAgain = recorded.length;
  assert.equal((await api("POST", `/tabs/${offAgainTab.tabId}/prompt`, { text: TURN_PROMPT })).ok, true);
  assert.equal(
    (await api("POST", "/wait", { tabId: offAgainTab.tabId, until: { turnStatus: "idle" }, timeoutMs: 120_000 })).matched,
    true,
  );
  const offAgainBodies = recorded.slice(beforeOffAgain);
  assert.ok(offAgainBodies.length >= 1);
  for (const entry of offAgainBodies) {
    assert.equal(entry.hasCache, false, "clearing the policy must remove the field from the wire again");
  }
  writeFileSync(join(profile, "off-again-bodies.jsonl"), offAgainBodies.map((entry) => entry.body).join("\n"));
  pass(6, "Off again: the key is gone from settings.json and from the outgoing request");

  console.log(`\nPASS: GitHub #15 prompt cache (${transport}) — 6/6 steps.`);
  console.log(`Evidence (recorded bodies, popovers, screenshots, isolated profile): ${profile}`);
  console.log("LIMIT: simulated usage against a local recorder — upstream GPT-5.6+ cache hits and billing still need an authorized gateway.");
} catch (error) {
  console.error(`[step ${results.length + 1}] FAIL ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Evidence so far: ${profile}`);
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) await cdp("Browser.close", {}).catch(() => {});
  ws?.close();
  try {
    await api("POST", "/quit", {});
  } catch {
    /* the app may already be gone */
  }
  await sleep(750);
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    /* already exited */
  }
  await new Promise((resolve) => recorder.close(resolve));
  // The evidence directory is always kept and printed; a failing run needs it
  // most, and a green one is small enough to leave for the report.
  if (keep) console.log(`--keep: artifacts retained at ${profile}`);
}

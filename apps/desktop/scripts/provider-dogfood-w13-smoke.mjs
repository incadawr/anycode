/**
 * Live dogfood smoke for TASK.45 W13 (design/track-43-45-33-47-49-cut.md
 * §"W13 — live dogfood 45"): drives a REAL Electron dev instance end-to-end
 * over the automation HTTP channel against LOCAL mock HTTP servers standing
 * in for a real provider — never a real z.ai/Anthropic credential. The whole
 * live seam (connection -> secret in the vault -> real host fork -> real HTTP
 * request -> stream/error -> health classification -> UI repaint) is
 * exercised deterministically: a mock-success server streams a genuine
 * Anthropic-shaped SSE response, a mock-401/mock-429 server returns a real
 * HTTP error status, and a reserved-then-closed loopback port produces a
 * genuine, instant ECONNREFUSED (same "connect-refused port technique" as
 * retry-ui-smoke.mjs / provider-connections-ui-smoke.mjs).
 *
 * All dogfood connections use the "custom" catalog template (`baseUrl` is the
 * only catalog entry whose baseUrl the drawer form actually exposes —
 * catalog.z-ai/anthropic/etc carry a FIXED baseUrl with no drawer input at
 * all, `SettingsScreen.tsx`'s `needsBaseUrl` gate). "custom"'s
 * `defaultTransport` is `anthropic-messages` — the same wire shape z-ai
 * itself speaks — so the live seam this proves is identical to what a real
 * z-ai connection would exercise; only the catalog id differs. Every request
 * actually lands on `${baseUrl}/v1/messages` (anthropic.ts's
 * `normalizeAnthropicBaseUrl` always appends `/v1`) — the mock servers below
 * route on that exact path.
 *
 * THREE separate profiles (own disposable `mkdtemp` userData/db/discovery/
 * settings.json/secrets.json, same isolation discipline as
 * provider-connections-ui-smoke.mjs, never the owner's real `~/.anycode`):
 *
 *   MAIN profile — a fresh empty install, one continuous run through
 *   scenarios 1 (two-connection isolation), 2 (auth-red only after a real
 *   runtime failure), 3 (429/unreachable -> amber, never red), 4 (default
 *   switch never retargets a running session), 6 (resume pinned +
 *   missing-connection replacement, including the W11-FIX M5 reservation-
 *   release-on-failure proof), 8a (delete-active auto-promotes), 8b
 *   (clearing an explicit transport falls back to the catalog default), 9
 *   (key rotation resets health to Unchecked), 5 (restart persists the last
 *   real health reading) — in that order, since several scenarios reuse
 *   connections/state the earlier ones set up.
 *
 *   MIGRATION profile — a v1-shaped settings.json + secrets.json (old
 *   provider singleton + a legacy `provider.apiKey` vault key) is written to
 *   disk BEFORE the first launch (a copy is kept alongside as the "before"
 *   snapshot). Per `settings/schema.ts`'s `resetV1Provider` (owner-decision
 *   2026-07-15) the real, current, intentional behavior is a full RESET —
 *   `provider.connections` comes back empty and the legacy vault key is
 *   scrubbed — NOT a carry-over of the old credential onto a new connection.
 *   This scenario proves that live (no crash, correct reset) and flags the
 *   mismatch against the original W13 brief's "key available to the active
 *   connection" wording, which predates that owner decision.
 *
 *   SELFHEAL profile — settings.json is seeded with two connections and NO
 *   `activeConnectionId` before the first launch, proving `loadSettings`'s
 *   `normalizeActiveConnection` repair (commit 5aa7555 / files.ts) self-heals
 *   the active id to `connections[0].id` on live boot.
 *
 * Scenarios run independently with try/catch (provider-live-smoke.mjs
 * precedent, NOT provider-connections-ui-smoke.mjs's stop-at-first-failure):
 * this is a survey across 10+ largely-decoupled scenarios and a mid-run
 * failure in one must not silently swallow evidence for the rest. Each
 * dedicated connection is scoped to the scenario that needs it so an earlier
 * failure doesn't cascade.
 *
 * Plain node >=22, ZERO npm deps (node:child_process/fs/http/net/os/path/url
 * + the global `fetch`), matching the `scripts/` precedent.
 *
 * Usage:   node apps/desktop/scripts/provider-dogfood-w13-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspaces/profiles on exit (debugging).
 *
 * Evidence: PNGs under apps/desktop/out/provider-connections-smoke/w13/,
 * redacted secrets.json dumps (ciphertext replaced with "<redacted>", key
 * NAMES kept) under the same directory.
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const EVIDENCE_DIR = join(desktopRoot, "out", "provider-connections-smoke", "w13");

function parseArgs(argv) {
  const flags = { keep: false };
  for (const arg of argv) {
    if (arg === "--keep") flags.keep = true;
    else console.warn(`[provider-dogfood-w13-smoke] ignoring unrecognized argument: ${arg}`);
  }
  return flags;
}
const FLAGS = parseArgs(process.argv.slice(2));

// ── generic process/fs helpers (lifted from provider-connections-ui-smoke.mjs) ──

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function readDiscoveryFile(path) {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof info?.pid === "number" &&
      typeof info?.port === "number" &&
      typeof info?.token === "string" &&
      typeof info?.startedAt === "number"
    ) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}
function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}
function killTree(pid, signal) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(-pid, signal);
  } catch {
    // already gone.
  }
}
/** Reserves a loopback port with nothing listening (genuine, instant ECONNREFUSED). */
function reserveUnusedPort() {
  return new Promise((resolveReserved, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolveReserved(port));
    });
  });
}

// ── failure bookkeeping (per-scenario try/catch — provider-live-smoke.mjs precedent) ──

class SmokeFailure extends Error {}
function fail(label, detail) {
  throw new SmokeFailure(`${label}: ${detail ?? ""}`.trimEnd());
}
function assert(label, cond, detail) {
  if (!cond) fail(label, detail);
}

// ── HTTP helpers against the automation channel (README.md routes) ──

async function api(ctx, method, path, body) {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, init);
  const text = await res.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}
async function apiOk(ctx, label, method, path, body) {
  const resp = await api(ctx, method, path, body);
  if (resp.status !== 200) fail(label, `${method} ${path} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  return resp.body;
}
async function apiAction(ctx, label, path, body) {
  const result = await apiOk(ctx, label, "POST", path, body);
  if (result?.ok !== true) fail(label, `POST ${path} rejected: ${JSON.stringify(result)}`);
  return result;
}
/** Retries an action a few times (settle delay between attempts) — used ONLY for the very first `/settings/open` right after boot, which can race React's initial Sidebar paint (the automation facade installs before the Sidebar necessarily has). Every later `/settings/open` in this script happens well after the app has settled and needs no retry. */
async function apiActionRetry(ctx, label, path, body, attempts = 10, delayMs = 500) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const resp = await api(ctx, "POST", path, body);
    if (resp.status === 200 && resp.body?.ok === true) return resp.body;
    last = resp;
    await sleep(delayMs);
  }
  fail(label, `POST ${path} never succeeded after ${attempts} attempts: HTTP ${last?.status} ${JSON.stringify(last?.body)}`);
}
async function waitUntilTab(ctx, label, tabId, until, timeoutMs) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const result = await apiOk(ctx, label, "POST", "/wait", body);
  if (result.matched !== true) fail(label, `/wait ${JSON.stringify(until)} for tab ${tabId} did not match: ${JSON.stringify(result)}`);
  return result;
}
async function pollUntil(timeoutMs, pollMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}
async function waitForFacade(ctx, label, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    let resp;
    try {
      resp = await api(ctx, "GET", "/state?tail=0");
    } catch {
      resp = { status: 0 };
    }
    if (resp.status === 200) return;
    if (Date.now() - start >= timeoutMs) fail(label, `renderer facade never installed within ${timeoutMs}ms (last GET /state -> HTTP ${resp.status})`);
    await sleep(150);
  }
}
async function saveScreenshot(ctx, name) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[provider-dogfood-w13-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[provider-dogfood-w13-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}
async function pollProviderState(ctx, label, predicate, timeoutMs = 10_000) {
  let last = null;
  const result = await pollUntil(timeoutMs, 150, async () => {
    const resp = await api(ctx, "GET", "/settings/provider");
    if (resp.status === 200) last = resp.body;
    return resp.status === 200 && predicate(resp.body) ? resp.body : undefined;
  });
  assert(label, result !== null, `GET /settings/provider predicate never matched within ${timeoutMs}ms; last seen: ${JSON.stringify(last)}`);
  return result;
}
function readJsonDisk(label, path, fileLabel) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(label, `failed to read/parse ${fileLabel} at ${path}: ${err?.message ?? err}`);
  }
}
/** Redacts ciphertext (keeps cipher kind + key names) so the dump is safe to keep as evidence. */
function redactSecretsFile(raw) {
  const entries = {};
  for (const [k, v] of Object.entries(raw?.entries ?? {})) {
    entries[k] = { cipher: v?.cipher, value: "<redacted>" };
  }
  return { version: raw?.version, entries };
}
function dumpSecrets(label, ctx, name) {
  const raw = readJsonDisk(label, ctx.secretsPath, "secrets.json");
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = join(EVIDENCE_DIR, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(redactSecretsFile(raw), null, 2));
  return { raw, path: filePath };
}
function dumpSettings(label, ctx, name) {
  const raw = readJsonDisk(label, ctx.settingsPath, "settings.json");
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = join(EVIDENCE_DIR, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(raw, null, 2));
  return { raw, path: filePath };
}

// ── local mock provider servers (node:http, zero deps) ──

/** Minimal Anthropic-messages SSE fixture (mirrors sse-fixture.integration.test.ts's shape). */
const SUCCESS_CHUNKS = [
  { type: "message_start", message: { id: "msg_mock", model: "mock-model", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock success reply" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
function serializeAnthropicSse(chunks) {
  return chunks.map((c) => `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`).join("");
}

/**
 * `kind`: "success" (200 SSE on POST /v1/messages, exactly what
 * anthropic.ts's normalizeAnthropicBaseUrl+SDK compute for the
 * anthropic-messages transport; 404 JSON on any other path — used to prove a
 * WRONG transport landed on the wrong path, scenario 8b), "401" or "429"
 * (every path, every method, a real Anthropic-shaped error body at that
 * status). `requests` is a live array of every request this server has ever
 * seen (`{method, path, atMs}`) — callers snapshot `.length` before/after to
 * attribute a turn to a specific server. `state.delayMs` (success only) lets
 * a caller hold a response open long enough to observe an in-flight turn
 * (scenario 4).
 */
function startMockServer(kind) {
  const requests = [];
  const state = { delayMs: 0 };
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      const path = req.url ?? "/";
      requests.push({ method: req.method, path, atMs: Date.now() });
      if (kind === "success" && state.delayMs > 0) await sleep(state.delayMs);
      if (kind === "success") {
        if (req.method === "POST" && path === "/v1/messages") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(serializeAnthropicSse(SUCCESS_CHUNKS));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock: no route for this transport/path", type: "invalid_request_error" } }));
        }
        return;
      }
      if (kind === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "mock: invalid x-api-key" } }));
        return;
      }
      if (kind === "429") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "mock: rate limited" } }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown mock kind" }));
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({
        kind,
        url: `http://127.0.0.1:${port}`,
        requests,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── app profile lifecycle (generalized from provider-connections-ui-smoke.mjs's launchApp) ──

function makeProfile(label) {
  const profile = mkdtempSync(join(tmpdir(), `anycode-w13-dogfood-${label}-profile-`));
  return {
    label,
    profile,
    profileUserDataDir: join(profile, "user-data"),
    profileDbPath: join(profile, "db.sqlite"),
    profileAutomationInfo: join(profile, "automation.json"),
    settingsPath: join(profile, "settings.json"),
    secretsPath: join(profile, "secrets.json"),
    port: undefined,
    token: undefined,
    appPid: null,
    child: null,
    teardownPromise: null,
    workspaces: [],
  };
}

/** (Re)spawns the dev app pointed at ctx's own profile paths; used for both first launch and restart (scenario 5). */
async function spawnDevApp(ctx, extraEnv, label) {
  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ...extraEnv,
  };
  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  ctx.child = child;
  ctx.teardownPromise = null;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(label, `[${ctx.label}] dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) fail(label, `[${ctx.label}] timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  await waitForFacade(ctx, label);
  console.log(`[provider-dogfood-w13-smoke] [${ctx.label}] app launched (pid=${info.pid}), facade ready after ${Date.now() - t0}ms on automation port ${info.port}, profile=${ctx.profile}`);
  return ctx;
}

async function launchApp(label, profileLabel, extraEnv) {
  return spawnDevApp(makeProfile(profileLabel), extraEnv ?? {}, label);
}

function teardown(ctx) {
  if (!ctx.teardownPromise) ctx.teardownPromise = teardownApp(ctx);
  return ctx.teardownPromise;
}
async function teardownApp(ctx) {
  if (ctx.port && ctx.token && ctx.child) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort.
    }
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[provider-dogfood-w13-smoke] [${ctx.label}] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[provider-dogfood-w13-smoke] [${ctx.label}] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }
  const dirs = [ctx.profile, ...ctx.workspaces];
  for (const dir of dirs) {
    if (dir && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[provider-dogfood-w13-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[provider-dogfood-w13-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }
}

function newWorkspace(ctx, tag) {
  const ws = mkdtempSync(join(tmpdir(), `anycode-w13-dogfood-ws-${tag}-`));
  ctx.workspaces.push(ws);
  return ws;
}

// ── shared connection helpers (drawer flow through the real automation UI) ──

/** Creates a "custom" connection via the currently-open drawer (Welcome embed OR Settings Add tile) and saves its key. Caller must have already opened the drawer (provider/add, or the Welcome auto-open). */
async function fillAndSubmitConnection(ctx, label, { name, model, baseUrl, transport, apiKey }) {
  const setResult = await apiOk(ctx, label, "POST", "/settings/provider/drawer/set", {
    providerId: "custom",
    label: name,
    model,
    baseUrl,
    ...(transport !== undefined ? { transport } : {}),
  });
  assert(label, setResult.ok === true, `drawer/set (template) rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, label, "POST", "/settings/provider/drawer/submit", {});
  assert(label, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);
  await pollProviderState(ctx, label, (s) => s.drawer.stage === "credential");
  const setKey = await apiOk(ctx, label, "POST", "/settings/provider/drawer/set", { apiKey });
  assert(label, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, label, "POST", "/settings/provider/drawer/save-key", {});
  assert(label, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
}

/**
 * Opens the provider connection UI and creates a new "custom" connection via
 * it. Branches on which surface actually holds it: the normal case is the
 * Settings dialog's Provider pane (Add tile), but App.tsx's `shouldShowWelcome`
 * gate can ALSO mount WelcomeScreen instead on a truly empty profile —
 * WelcomeScreen "renders full-window with no sidebar" (App.tsx), so there is
 * no `.sidebar-settings` gear for `/settings/open` to click, and its own
 * connection drawer auto-opens embedded on mount instead (same shared
 * `/settings/provider/*` routes read/drive it, per `settingsProviderPaneState`
 * — `provider-connections-ui-smoke.mjs`'s step2WelcomeEmptyState/
 * step5WelcomeUnmountsAndDiskCustody precedent). Whether Welcome or Start
 * shows is env-dependent (App.tsx's async `listAvailableEngines` Codex probe)
 * but settles well before this function's first read, so a single up-front
 * check is enough to pick the right flow. Returns the new connection's id.
 */
async function createConnectionViaGrid(ctx, label, opts) {
  const preState = await apiOk(ctx, label, "GET", "/settings/provider");
  const welcomeEmbedOpen = preState.mounted === false && preState.drawer?.open === true && preState.drawer?.embedded === true;
  let beforeIds;

  if (welcomeEmbedOpen) {
    // WelcomeScreen (App.tsx's shouldShowWelcome) only ever mounts on a
    // profile with ZERO connections — `preState.rows` reads `[]` while
    // unmounted regardless (settingsProviderPaneState), so there is nothing
    // to diff against.
    beforeIds = new Set();
    await fillAndSubmitConnection(ctx, label, opts);
    // The embedded drawer has no close affordance (settingsProviderDrawerClose
    // -> {ok:false, reason:"no_close_affordance"} while embedded) — App's own
    // providerReady gate unmounts it once the save lands, so wait for that
    // instead of trying to close it.
    const unmounted = await pollUntil(20_000, 300, async () => {
      const state = await api(ctx, "GET", "/settings/provider");
      return state.status === 200 && state.body?.drawer?.open === false ? state.body : undefined;
    });
    assert(label, unmounted !== null, "WelcomeScreen's embedded drawer never closed after saving the new connection's key");
  } else {
    await apiActionRetry(ctx, label, "/settings/open", {});
    await apiAction(ctx, label, "/settings/pane", { paneId: "provider" });
    await pollProviderState(ctx, label, (s) => s.mounted === true);
    // `preState.rows` was taken pre-mount (always `[]`) — re-read now that the
    // grid is actually mounted so pre-existing connections are diffed correctly.
    const before = await apiOk(ctx, label, "GET", "/settings/provider");
    beforeIds = new Set(before.rows.map((r) => r.connectionId));
    await apiAction(ctx, label, "/settings/provider/add", {});
    await fillAndSubmitConnection(ctx, label, opts);
    const closeResult = await apiOk(ctx, label, "POST", "/settings/provider/drawer/close", {});
    assert(label, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);
  }

  const settingsDisk = readJsonDisk(label, ctx.settingsPath, "settings.json");
  const created = settingsDisk.provider.connections.find((c) => !beforeIds.has(c.id));
  assert(label, created !== undefined, `newly created connection (${opts.name}) not found on disk`);
  return created.id;
}

async function selectConnection(ctx, label, connectionId) {
  const result = await apiAction(ctx, label, "/settings/provider/tile", { connectionId });
  await pollProviderState(ctx, label, (s) => s.rows.find((r) => r.connectionId === connectionId)?.selected === true);
  return result;
}

async function connectionRow(ctx, label, connectionId) {
  const state = await apiOk(ctx, label, "GET", "/settings/provider");
  const row = state.rows.find((r) => r.connectionId === connectionId);
  assert(label, row !== undefined, `connection ${connectionId} not present in the grid: ${JSON.stringify(state.rows)}`);
  return row;
}

/** New tab pinned to whatever connection is currently active; waits for the host to connect. */
async function newTabReady(ctx, label, tag) {
  const workspace = newWorkspace(ctx, tag);
  const created = await apiOk(ctx, label, "POST", "/tabs", { kind: "new", workspace });
  assert(label, created.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  await waitUntilTab(ctx, label, created.tabId, { connection: "ready" }, 60_000);
  return { tabId: created.tabId, sessionId: created.sessionId, workspace };
}

/**
 * Sends a prompt and waits for the turn to settle. Deliberately does NOT wait
 * for an intermediate `turnStatus:"running"` — the mock servers respond near-
 * instantly, so a turn can start AND finish between two 150ms `/wait` polls,
 * making a `{turnStatus:"running"}` predicate time out forever waiting for a
 * transient state that already came and went. Instead this polls `/state`
 * directly for BOTH the transcript having grown past its pre-send length AND
 * `turnStatus:"idle"` — robust to an already-idle STALE reading from before
 * the prompt was even sent (the growth check), and to a same-instant already-
 * settled turn (no "running" catch required).
 *
 * The growth threshold is `beforeCount + 1`, NOT `beforeCount`: the facade's
 * `sendPrompt` (automation.ts) calls `state.appendUserText` SYNCHRONOUSLY,
 * before the `/tabs/:tabId/prompt` HTTP response even returns — so the
 * transcript has already grown by exactly one (the user's own echoed
 * message) by the time this function's first poll runs, regardless of
 * whether the host has done anything at all yet. `pollUntil` checks its
 * predicate before ever sleeping, so a plain `> beforeCount` check can be
 * satisfied on the very first poll purely by that self-echo, with
 * `turn.status` still reading a STALE "idle" from before `turn_started` -
 * this raced and falsely "settled" turns with zero model-produced blocks
 * (W13 scenario 2/3 diagnosis). Requiring `beforeCount + 1` demands at least
 * one ADDITIONAL block past the guaranteed echo - i.e. real turn output
 * (assistant text or a terminal error block).
 */
async function sendPromptAndWaitIdle(ctx, label, tabId, text) {
  const before = await apiOk(ctx, label, "GET", `/state/${tabId}`);
  const beforeCount = before?.snapshot?.states?.[tabId]?.transcript?.length ?? 0;
  const sendResult = await apiOk(ctx, label, "POST", `/tabs/${tabId}/prompt`, { text: text ?? "w13 dogfood smoke turn" });
  assert(label, sendResult.ok === true, `prompt send rejected: ${JSON.stringify(sendResult)}`);
  const settled = await pollUntil(60_000, 200, async () => {
    const state = await api(ctx, "GET", `/state/${tabId}`);
    if (state.status !== 200) return undefined;
    const tabState = state.body?.snapshot?.states?.[tabId];
    const grew = (tabState?.transcript?.length ?? 0) > beforeCount + 1;
    return grew && tabState?.turn?.status === "idle" ? true : undefined;
  });
  assert(label, settled !== null, `turn never settled idle with a grown transcript within 60s (tab ${tabId})`);
}

async function lastErrorBlock(ctx, label, tabId) {
  const state = await apiOk(ctx, label, "GET", `/state/${tabId}`);
  const blocks = state?.snapshot?.states?.[tabId]?.transcript ?? [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === "error") return blocks[i];
  }
  return null;
}

async function closeTab(ctx, label, tabId) {
  const result = await apiAction(ctx, label, `/tabs/${tabId}/close`, {});
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// scenario runner
// ══════════════════════════════════════════════════════════════════════════

const results = [];
async function runScenario(id, description, fn) {
  console.log(`\n[provider-dogfood-w13-smoke] === scenario ${id}: ${description} ===`);
  try {
    await fn();
    results.push({ id, description, status: "PASS" });
    console.log(`[provider-dogfood-w13-smoke] scenario ${id}: PASS`);
  } catch (err) {
    const detail = err instanceof SmokeFailure ? err.message : (err?.stack ?? String(err));
    results.push({ id, description, status: "FAIL", detail });
    console.error(`[provider-dogfood-w13-smoke] scenario ${id}: FAIL — ${detail}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN profile scenarios
// ══════════════════════════════════════════════════════════════════════════

async function runMainProfile(mocks) {
  const ctx = await launchApp("main-launch", "main", {});
  const ids = {};
  try {
    // ── boot: create connection A. A fresh empty profile shows WelcomeScreen
    // ONLY when no external (non-core) engine is available (App.tsx's
    // shouldShowWelcome requires hasExternalEngine===false) — on a dev
    // machine with Codex already signed in, `codexReady` flips true fast
    // enough that Welcome never mounts and the app opens straight into
    // StartScreen instead. This dogfood run doesn't need Welcome's own UX
    // (that is W12's surface, not W13's) — going through the Settings
    // dialog's provider pane directly is robust to either environment. ──
    ids.A = await createConnectionViaGrid(ctx, "boot", {
      name: "Mock Success A",
      model: "mock-model-a",
      baseUrl: mocks.success.url,
      apiKey: "sk-mock-a",
    });
    console.log(`[provider-dogfood-w13-smoke] boot: connection A (Mock Success) = ${ids.A}`);

    // `TabHostManager.closeTab` unconditionally refuses to close the LAST
    // open tab ("no window with zero hosts" state, tabs.ts) — every scenario
    // below opens exactly one tab and closes it again, which would hit that
    // refusal on the very first scenario with nothing else open. A dedicated
    // keep-alive connection + tab (never touched by any scenario, including
    // 8a's delete-active) is created once here and stays open for the WHOLE
    // profile lifetime, so every scenario's own close always has a sibling
    // tab still open.
    ids.KEEPALIVE = await createConnectionViaGrid(ctx, "boot", {
      name: "Keep-Alive (scenario infra, do not touch)",
      model: "mock-model-keepalive",
      baseUrl: mocks.success.url,
      apiKey: "sk-mock-keepalive",
    });
    await selectConnection(ctx, "boot", ids.KEEPALIVE);
    await apiAction(ctx, "boot", "/settings/close", {});
    const keepAlive = await newTabReady(ctx, "boot", "keepalive");
    ctx.keepAliveTabId = keepAlive.tabId;
    await apiActionRetry(ctx, "boot", "/settings/open", {});
    await apiAction(ctx, "boot", "/settings/pane", { paneId: "provider" });
    await selectConnection(ctx, "boot", ids.A); // restore A as the default for scenario 1 onward.
    await apiAction(ctx, "boot", "/settings/close", {});
    console.log(`[provider-dogfood-w13-smoke] boot: keep-alive connection = ${ids.KEEPALIVE}, tab = ${ctx.keepAliveTabId}`);

    // ── scenario 1: two connections, one provider, independent credentials ──
    await runScenario(1, "two connections, isolated credentials (replace A, delete B)", async () => {
      ids.B = await createConnectionViaGrid(ctx, "s1", {
        name: "Mock Auth-Fail B",
        model: "mock-model-b",
        baseUrl: mocks.auth401.url,
        apiKey: "sk-mock-b",
      });
      const before = dumpSecrets("s1", ctx, "s1-before-replace");
      const keyA = `provider.connection.${ids.A}.apiKey`;
      const keyB = `provider.connection.${ids.B}.apiKey`;
      assert("s1", before.raw.entries[keyA] !== undefined && before.raw.entries[keyB] !== undefined, `expected both connection-scoped secret keys present: ${JSON.stringify(Object.keys(before.raw.entries))}`);

      // replace A's key -> B must be byte-untouched.
      await apiAction(ctx, "s1", "/settings/provider/menu", { connectionId: ids.A, action: "edit" });
      await pollProviderState(ctx, "s1", (s) => s.drawer.open === true);
      const setKey = await apiOk(ctx, "s1", "POST", "/settings/provider/drawer/set", { apiKey: "sk-mock-a-2" });
      assert("s1", setKey.ok === true, `drawer/set (replace apiKey) rejected: ${JSON.stringify(setKey)}`);
      const saveKey = await apiOk(ctx, "s1", "POST", "/settings/provider/drawer/save-key", {});
      assert("s1", saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
      await apiAction(ctx, "s1", "/settings/provider/drawer/close", {});
      const afterReplace = dumpSecrets("s1", ctx, "s1-after-replace-a");
      assert("s1", JSON.stringify(afterReplace.raw.entries[keyB]) === JSON.stringify(before.raw.entries[keyB]), `B's secret entry changed after replacing A's key: before=${JSON.stringify(before.raw.entries[keyB])} after=${JSON.stringify(afterReplace.raw.entries[keyB])}`);
      assert("s1", JSON.stringify(afterReplace.raw.entries[keyA]) !== JSON.stringify(before.raw.entries[keyA]), `A's secret entry did NOT change after a key replace`);

      // delete B -> A must be byte-untouched.
      await apiAction(ctx, "s1", "/settings/provider/menu", { connectionId: ids.B, action: "delete" });
      await pollProviderState(ctx, "s1", (s) => s.rows.every((r) => r.connectionId !== ids.B));
      const afterDelete = dumpSecrets("s1", ctx, "s1-after-delete-b");
      assert("s1", JSON.stringify(afterDelete.raw.entries[keyA]) === JSON.stringify(afterReplace.raw.entries[keyA]), `A's secret entry changed after deleting B`);
      assert("s1", afterDelete.raw.entries[keyB] === undefined, `B's secret entry survived its own delete: ${JSON.stringify(afterDelete.raw.entries[keyB])}`);
      const settingsDisk = readJsonDisk("s1", ctx.settingsPath, "settings.json");
      assert("s1", settingsDisk.provider.connections.every((c) => c.id !== ids.B), "B's metadata survived on disk after delete");
      assert("s1", settingsDisk.provider.connections.some((c) => c.id === ids.A), "A's metadata missing after an unrelated delete");
    });

    // ── scenario 2: red only after a real runtime auth failure ──
    await runScenario(2, "auth failure paints red ONLY after a real runtime request", async () => {
      ids.C = await createConnectionViaGrid(ctx, "s2", {
        name: "Mock Auth Invalid C",
        model: "mock-model-c",
        baseUrl: mocks.auth401.url,
        apiKey: "sk-mock-c",
      });
      const preRow = await connectionRow(ctx, "s2", ids.C);
      assert("s2", preRow.statusText === "Unchecked" && preRow.statusTone === "muted", `expected pre-turn status Unchecked/muted (never probed), got ${preRow.statusText}/${preRow.statusTone}`);
      await saveScreenshot(ctx, "s2-before-red");

      await selectConnection(ctx, "s2", ids.C);
      await apiAction(ctx, "s2", "/settings/close", {});
      const tab = await newTabReady(ctx, "s2", "s2");
      await sendPromptAndWaitIdle(ctx, "s2", tab.tabId);
      const errorBlock = await lastErrorBlock(ctx, "s2", tab.tabId);
      assert("s2", errorBlock !== null, "expected a terminal error block after the mock-401 turn");
      assert("s2", errorBlock.retry?.code === "auth", `expected retry.code="auth" against the mock-401 server, got ${JSON.stringify(errorBlock.retry)}`);

      await apiActionRetry(ctx, "s2", "/settings/open", {});
      await apiAction(ctx, "s2", "/settings/pane", { paneId: "provider" });
      const postRow = await pollUntil(10_000, 200, async () => {
        const r = await connectionRow(ctx, "s2", ids.C);
        return r.statusTone === "danger" ? r : undefined;
      });
      assert("s2", postRow !== null, `expected connection C to paint danger/red after the runtime auth failure`);
      assert("s2", postRow.statusText === "Key invalid", `expected status text "Key invalid", got "${postRow.statusText}"`);
      await saveScreenshot(ctx, "s2-after-red");
      await closeTab(ctx, "s2", tab.tabId);
    });

    // ── scenario 3: 429 / connect-refused -> amber, never red ──
    await runScenario(3, "429 and connect-refused paint amber (never red)", async () => {
      ids.D = await createConnectionViaGrid(ctx, "s3", {
        name: "Mock Rate Limited D",
        model: "mock-model-d",
        baseUrl: mocks.rate429.url,
        apiKey: "sk-mock-d",
      });
      await selectConnection(ctx, "s3", ids.D);
      await apiAction(ctx, "s3", "/settings/close", {});
      const tabD = await newTabReady(ctx, "s3", "s3d");
      await sendPromptAndWaitIdle(ctx, "s3", tabD.tabId);
      const errD = await lastErrorBlock(ctx, "s3", tabD.tabId);
      assert("s3", errD !== null, "expected a terminal error block after the mock-429 turn");
      assert("s3", errD.retry?.code === "rate_limited" || errD.retry?.code === "quota", `expected rate_limited/quota classification, got ${JSON.stringify(errD.retry)}`);
      await apiActionRetry(ctx, "s3", "/settings/open", {});
      await apiAction(ctx, "s3", "/settings/pane", { paneId: "provider" });
      const rowD = await pollUntil(10_000, 200, async () => {
        const r = await connectionRow(ctx, "s3", ids.D);
        return r.statusTone !== "muted" ? r : undefined;
      });
      assert("s3", rowD !== null && rowD.statusTone === "warn", `expected connection D tone "warn" (amber), got ${JSON.stringify(rowD)}`);
      await closeTab(ctx, "s3", tabD.tabId);

      const refusedPort = await reserveUnusedPort();
      ids.E = await createConnectionViaGrid(ctx, "s3", {
        name: "Mock Unreachable E",
        model: "mock-model-e",
        baseUrl: `http://127.0.0.1:${refusedPort}`,
        apiKey: "sk-mock-e",
      });
      await selectConnection(ctx, "s3", ids.E);
      await apiAction(ctx, "s3", "/settings/close", {});
      const tabE = await newTabReady(ctx, "s3", "s3e");
      await sendPromptAndWaitIdle(ctx, "s3", tabE.tabId);
      const errE = await lastErrorBlock(ctx, "s3", tabE.tabId);
      assert("s3", errE !== null, "expected a terminal error block after the connect-refused turn");
      assert("s3", errE.retry?.code === "connect_timeout" || errE.retry?.code === "network", `expected connect_timeout/network classification, got ${JSON.stringify(errE.retry)}`);
      await apiActionRetry(ctx, "s3", "/settings/open", {});
      await apiAction(ctx, "s3", "/settings/pane", { paneId: "provider" });
      const rowE = await pollUntil(10_000, 200, async () => {
        const r = await connectionRow(ctx, "s3", ids.E);
        return r.statusTone !== "muted" ? r : undefined;
      });
      assert("s3", rowE !== null && rowE.statusTone === "warn", `expected connection E tone "warn" (amber), got ${JSON.stringify(rowE)}`);
      await saveScreenshot(ctx, "s3-amber-not-red");
      await closeTab(ctx, "s3", tabE.tabId);
    });

    // ── scenario 4: switching the default connection never retargets a running session ──
    await runScenario(4, "default switch mid-turn never retargets the running session", async () => {
      const mockF = await startMockServer("success");
      try {
        ids.F = await createConnectionViaGrid(ctx, "s4", {
          name: "Mock Slow F",
          model: "mock-model-f",
          baseUrl: mockF.url,
          apiKey: "sk-mock-f",
        });
        await selectConnection(ctx, "s4", ids.F);
        await apiAction(ctx, "s4", "/settings/close", {});
        mockF.state.delayMs = 4_000;
        const aRequestsBefore = mocks.success.requests.length;
        const fRequestsBefore = mockF.requests.length;
        const tab = await newTabReady(ctx, "s4", "s4");
        const sendResult = await apiOk(ctx, "s4", "POST", `/tabs/${tab.tabId}/prompt`, { text: "w13 dogfood scenario 4 turn" });
        assert("s4", sendResult.ok === true, `prompt send rejected: ${JSON.stringify(sendResult)}`);
        await waitUntilTab(ctx, "s4", tab.tabId, { turnStatus: "running" }, 30_000);

        // switch default WHILE F's turn is in flight.
        await apiActionRetry(ctx, "s4", "/settings/open", {});
        await apiAction(ctx, "s4", "/settings/pane", { paneId: "provider" });
        await selectConnection(ctx, "s4", ids.A);
        const rowFDuring = await connectionRow(ctx, "s4", ids.F);
        assert("s4", rowFDuring.selected === false, "expected F to lose the selected marker once A is selected");
        await apiAction(ctx, "s4", "/settings/close", {});

        await waitUntilTab(ctx, "s4", tab.tabId, { turnStatus: "idle" }, 60_000);
        mockF.state.delayMs = 0;
        const fGotRequest = mockF.requests.slice(fRequestsBefore).some((r) => r.method === "POST" && r.path === "/v1/messages");
        assert("s4", fGotRequest, "F's own mock-success server never received the POST /v1/messages request — the running session may have been retargeted");
        assert("s4", mocks.success.requests.length === aRequestsBefore, `A's mock-success server saw new requests during F's in-flight turn — the running session was retargeted (before=${aRequestsBefore}, after=${mocks.success.requests.length})`);
        const errorBlock = await lastErrorBlock(ctx, "s4", tab.tabId);
        assert("s4", errorBlock === null, `expected F's turn to complete successfully on its OWN endpoint, got a terminal error: ${JSON.stringify(errorBlock)}`);
        const settingsDisk = readJsonDisk("s4", ctx.settingsPath, "settings.json");
        assert("s4", settingsDisk.provider.activeConnectionId === ids.A, `expected the default to have actually switched to A on disk, got ${settingsDisk.provider.activeConnectionId}`);
        await closeTab(ctx, "s4", tab.tabId);
      } finally {
        await mockF.close();
      }
    });

    // ── scenario 6: resume pinned + missing-connection replacement (+ M5 reservation-release proof) ──
    await runScenario(6, "resume pinned connection + missing-connection replacement (M5)", async () => {
      await apiActionRetry(ctx, "s6", "/settings/open", {});
      await apiAction(ctx, "s6", "/settings/pane", { paneId: "provider" });
      await selectConnection(ctx, "s6", ids.A);
      ids.G = await createConnectionViaGrid(ctx, "s6", {
        name: "Mock Resume Target G",
        model: "mock-model-g",
        baseUrl: mocks.success.url,
        apiKey: "sk-mock-g",
      });
      await selectConnection(ctx, "s6", ids.G);
      await apiAction(ctx, "s6", "/settings/close", {});

      const pinnedTab = await newTabReady(ctx, "s6", "s6-pinned");
      const sessionId = pinnedTab.sessionId;
      await closeTab(ctx, "s6", pinnedTab.tabId);

      ids.H = await createConnectionViaGrid(ctx, "s6", {
        name: "Mock Replacement H",
        model: "mock-model-h",
        baseUrl: mocks.success.url,
        apiKey: "sk-mock-h",
      });
      await selectConnection(ctx, "s6", ids.A); // known-good default for the filler tabs below.
      await apiAction(ctx, "s6", "/settings/close", {});

      // delete the pinned connection -> resume without a replacement must refuse connection_missing.
      await apiActionRetry(ctx, "s6", "/settings/open", {});
      await apiAction(ctx, "s6", "/settings/pane", { paneId: "provider" });
      await apiAction(ctx, "s6", "/settings/provider/menu", { connectionId: ids.G, action: "delete" });
      await pollProviderState(ctx, "s6", (s) => s.rows.every((r) => r.connectionId !== ids.G));
      await apiAction(ctx, "s6", "/settings/close", {});

      const bareResume = await apiOk(ctx, "s6", "POST", "/tabs", { kind: "resume", sessionId });
      assert("s6", bareResume.ok === false && bareResume.reason === "connection_missing" && bareResume.connectionId === ids.G, `expected {ok:false, reason:"connection_missing", connectionId:"${ids.G}"} for a bare resume of a deleted pin, got ${JSON.stringify(bareResume)}`);

      // saturate capacity (maxTabs=8, tabs.ts) so the replacement resume's OWN
      // createTab call fails AFTER resolveResumePin has already reserved +
      // persisted the replacement — the exact W11-FIX M5 window. The
      // keep-alive tab (boot) already holds one slot, so 7 more fillers hit
      // exactly 8.
      const stateBeforeFiller = await apiOk(ctx, "s6", "GET", "/state?tail=0");
      assert("s6", stateBeforeFiller.tabs.length === 1, `expected only the keep-alive tab open before the capacity fill, got ${stateBeforeFiller.tabs.length}`);
      const fillerTabIds = [];
      for (let i = 0; i < 7; i += 1) {
        const filler = await newTabReady(ctx, "s6", `s6-filler-${i}`);
        fillerTabIds.push(filler.tabId);
      }

      const replacementResume = await apiOk(ctx, "s6", "POST", "/tabs", { kind: "resume", sessionId, replacementConnectionId: ids.H });
      assert("s6", replacementResume.ok === false && replacementResume.reason === "max_tabs", `expected the replacement resume to fail max_tabs at capacity (proving it got PAST the reservation), got ${JSON.stringify(replacementResume)}`);

      // the failed resume must NOT have leaked H's pin reservation (W11-FIX M5).
      await apiActionRetry(ctx, "s6", "/settings/open", {});
      await apiAction(ctx, "s6", "/settings/pane", { paneId: "provider" });
      const deleteH = await apiOk(ctx, "s6", "POST", "/settings/provider/menu", { connectionId: ids.H, action: "delete" });
      assert("s6", deleteH.ok === true, `expected connection H to delete cleanly right after its failed replacement-resume (a leaked reservation would refuse connection_in_use), got ${JSON.stringify(deleteH)}`);
      await apiAction(ctx, "s6", "/settings/close", {});

      for (const tabId of fillerTabIds) {
        await closeTab(ctx, "s6", tabId);
      }
      const stateAfterCleanup = await apiOk(ctx, "s6", "GET", "/state?tail=0");
      assert("s6", stateAfterCleanup.tabs.length === 1, `expected only the keep-alive tab open after cleanup, got ${stateAfterCleanup.tabs.length}`);
    });

    // ── scenario 8a: deleting the active connection auto-promotes a successor ──
    await runScenario("8a", "deleting the active connection auto-promotes a successor (no Welcome fallback)", async () => {
      await apiActionRetry(ctx, "8a", "/settings/open", {});
      await apiAction(ctx, "8a", "/settings/pane", { paneId: "provider" });
      await selectConnection(ctx, "8a", ids.A);
      const before = readJsonDisk("8a", ctx.settingsPath, "settings.json");
      const expectedPromoted = before.provider.connections.filter((c) => c.id !== ids.A)[0]?.id;
      assert("8a", expectedPromoted !== undefined, "need at least 2 connections remaining for a meaningful auto-promote check");

      const deleteResult = await apiOk(ctx, "8a", "POST", "/settings/provider/menu", { connectionId: ids.A, action: "delete" });
      assert("8a", deleteResult.ok === true, `expected deleting the (unused) active connection to succeed, got ${JSON.stringify(deleteResult)}`);
      const after = readJsonDisk("8a", ctx.settingsPath, "settings.json");
      assert("8a", after.provider.activeConnectionId === expectedPromoted, `expected auto-promote to ${expectedPromoted}, got ${after.provider.activeConnectionId}`);

      const gridState = await apiOk(ctx, "8a", "GET", "/settings/provider");
      assert("8a", gridState.mounted === true, "expected the grid still mounted (no crash/fallback) right after deleting the active connection");
      assert("8a", gridState.rows.length > 0, "expected at least one connection tile to remain");
      await saveScreenshot(ctx, "8a-auto-promote");
      delete ids.A; // gone.
    });

    // ── scenario 8b: clearing an explicit transport falls back to the catalog default ──
    await runScenario("8b", "clearing an explicit transport falls back to the catalog default, live", async () => {
      ids.I = await createConnectionViaGrid(ctx, "8b", {
        name: "Mock Transport Clear I",
        model: "mock-model-i",
        baseUrl: mocks.success.url,
        transport: "openai-chat-completions",
        apiKey: "sk-mock-i",
      });
      await selectConnection(ctx, "8b", ids.I);
      await apiAction(ctx, "8b", "/settings/close", {});

      const wrongRequestsBefore = mocks.success.requests.length;
      const tabWrong = await newTabReady(ctx, "8b", "8b-wrong");
      await sendPromptAndWaitIdle(ctx, "8b", tabWrong.tabId);
      assert("8b", mocks.success.requests.length > wrongRequestsBefore, "expected a request to land on the mock server for the wrong-transport turn too");
      const wrongLast = mocks.success.requests.at(-1);
      assert("8b", wrongLast.path === "/chat/completions", `expected the wrong-transport turn to hit /chat/completions, got ${wrongLast.path}`);
      const errWrong = await lastErrorBlock(ctx, "8b", tabWrong.tabId);
      assert("8b", errWrong !== null, "expected the wrong-transport turn (hitting a 404 mock path) to terminate in an error");
      await closeTab(ctx, "8b", tabWrong.tabId);

      await apiActionRetry(ctx, "8b", "/settings/open", {});
      await apiAction(ctx, "8b", "/settings/pane", { paneId: "provider" });
      await apiAction(ctx, "8b", "/settings/provider/menu", { connectionId: ids.I, action: "edit" });
      await pollProviderState(ctx, "8b", (s) => s.drawer.open === true);
      const clearTransport = await apiOk(ctx, "8b", "POST", "/settings/provider/drawer/set", { transport: "" });
      assert("8b", clearTransport.ok === true, `drawer/set (transport clear) rejected: ${JSON.stringify(clearTransport)}`);
      const submitClear = await apiOk(ctx, "8b", "POST", "/settings/provider/drawer/submit", {});
      assert("8b", submitClear.ok === true, `drawer/submit (transport clear) rejected: ${JSON.stringify(submitClear)}`);
      await apiAction(ctx, "8b", "/settings/provider/drawer/close", {});
      const settingsAfterClear = readJsonDisk("8b", ctx.settingsPath, "settings.json");
      const connI = settingsAfterClear.provider.connections.find((c) => c.id === ids.I);
      assert("8b", connI.transport === undefined, `expected transport cleared back to undefined (catalog default), got ${JSON.stringify(connI.transport)}`);
      await apiAction(ctx, "8b", "/settings/close", {});

      const rightRequestsBefore = mocks.success.requests.length;
      const tabRight = await newTabReady(ctx, "8b", "8b-right");
      await sendPromptAndWaitIdle(ctx, "8b", tabRight.tabId);
      assert("8b", mocks.success.requests.length > rightRequestsBefore, "expected a request to land on the mock server for the catalog-default turn");
      const rightLast = mocks.success.requests.at(-1);
      assert("8b", rightLast.path === "/v1/messages", `expected the catalog-default turn to hit /v1/messages (anthropic-messages), got ${rightLast.path}`);
      const errRight = await lastErrorBlock(ctx, "8b", tabRight.tabId);
      assert("8b", errRight === null, `expected the catalog-default turn to succeed, got a terminal error: ${JSON.stringify(errRight)}`);
      await closeTab(ctx, "8b", tabRight.tabId);
    });

    // ── scenario 9: key rotation resets health to Unchecked, next real request repaints it ──
    await runScenario(9, "key rotation resets health to Unchecked; next real request repaints it", async () => {
      // Scenario 8b's own ending explicitly /settings/close's the dialog
      // (after its catalog-default turn) — connectionRow's grid read needs
      // the pane mounted (settingsProviderPaneState reads rows:[] while
      // unmounted), so this scenario cannot inherit 8b's dialog state.
      await apiActionRetry(ctx, "9", "/settings/open", {});
      await apiAction(ctx, "9", "/settings/pane", { paneId: "provider" });
      const rowBefore = await connectionRow(ctx, "9", ids.I);
      assert("9", rowBefore.statusText === "Ready" && rowBefore.statusTone === "ok", `expected connection I to read Ready/ok from scenario 8b's successful turn, got ${rowBefore.statusText}/${rowBefore.statusTone}`);
      await saveScreenshot(ctx, "9-before-rotation");

      await apiAction(ctx, "9", "/settings/provider/menu", { connectionId: ids.I, action: "replace_key" });
      await pollProviderState(ctx, "9", (s) => s.drawer.open === true);
      const setKey = await apiOk(ctx, "9", "POST", "/settings/provider/drawer/set", { apiKey: "sk-mock-i-2" });
      assert("9", setKey.ok === true, `drawer/set (rotate apiKey) rejected: ${JSON.stringify(setKey)}`);
      const saveKey = await apiOk(ctx, "9", "POST", "/settings/provider/drawer/save-key", {});
      assert("9", saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
      await apiAction(ctx, "9", "/settings/provider/drawer/close", {});
      const rowAfterRotate = await connectionRow(ctx, "9", ids.I);
      assert("9", rowAfterRotate.statusText === "Unchecked" && rowAfterRotate.statusTone === "muted", `expected key rotation to reset health to Unchecked/muted, got ${rowAfterRotate.statusText}/${rowAfterRotate.statusTone}`);
      await saveScreenshot(ctx, "9-after-rotation-unchecked");

      await selectConnection(ctx, "9", ids.I);
      await apiAction(ctx, "9", "/settings/close", {});
      const tab = await newTabReady(ctx, "9", "9");
      await sendPromptAndWaitIdle(ctx, "9", tab.tabId);
      await apiActionRetry(ctx, "9", "/settings/open", {});
      await apiAction(ctx, "9", "/settings/pane", { paneId: "provider" });
      const rowAfterTurn = await pollUntil(10_000, 200, async () => {
        const r = await connectionRow(ctx, "9", ids.I);
        return r.statusTone !== "muted" ? r : undefined;
      });
      assert("9", rowAfterTurn !== null && rowAfterTurn.statusText === "Ready" && rowAfterTurn.statusTone === "ok", `expected the next real request to repaint Ready/ok, got ${JSON.stringify(rowAfterTurn)}`);
      await saveScreenshot(ctx, "9-after-real-request-repaint");
      await closeTab(ctx, "9", tab.tabId);
      await apiAction(ctx, "9", "/settings/close", {});
    });

    // ── scenario 5: restart persists the last real health reading (last-known) ──
    await runScenario(5, "restart persists the last real health reading (no reset to Unchecked)", async () => {
      // Scenario 9's own ending explicitly /settings/close's the dialog —
      // same reason as 9's own fix above, this scenario cannot inherit it.
      await apiActionRetry(ctx, "5", "/settings/open", {});
      await apiAction(ctx, "5", "/settings/pane", { paneId: "provider" });
      const rowBefore = await connectionRow(ctx, "5", ids.C);
      assert("5", rowBefore.statusText === "Key invalid" && rowBefore.statusTone === "danger", `expected connection C to still read Key invalid/danger from scenario 2 before restart, got ${rowBefore.statusText}/${rowBefore.statusTone}`);

      await apiAction(ctx, "5", "/quit", {});
      const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
      assert("5", exited === true, "dev app did not exit within the grace period after /quit");

      await spawnDevApp(ctx, {}, "5-relaunch");
      await apiActionRetry(ctx, "5", "/settings/open", {});
      await apiAction(ctx, "5", "/settings/pane", { paneId: "provider" });
      await pollProviderState(ctx, "5", (s) => s.mounted === true);
      const rowAfter = await connectionRow(ctx, "5", ids.C);
      assert("5", rowAfter.statusText === "Key invalid" && rowAfter.statusTone === "danger", `expected the persisted health to survive restart (Key invalid/danger), got ${rowAfter.statusText}/${rowAfter.statusTone} — a reset to Unchecked would mean health does NOT survive restart`);
      await saveScreenshot(ctx, "5-restart-last-known");
    });
  } finally {
    await teardown(ctx);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MIGRATION profile: real v1 settings.json + secrets.json
// ══════════════════════════════════════════════════════════════════════════

async function runMigrationScenario() {
  await runScenario(7, "real v1 settings.json + secrets.json boots without crash (owner-decision reset, not carry-over)", async () => {
    const ctx = makeProfile("migration");
    const v1Settings = {
      version: 1,
      provider: {
        id: "anthropic",
        model: "claude-old-v1-model",
        baseUrl: "https://api.anthropic.com",
        transport: "anthropic-messages",
        defaults: {},
      },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    const v1Secrets = {
      version: 1,
      entries: {
        "provider.apiKey": { cipher: "plaintext", value: "sk-legacy-v1-fake-key-not-a-real-secret" },
      },
    };
    mkdirSync(dirname(ctx.settingsPath), { recursive: true });
    writeFileSync(ctx.settingsPath, JSON.stringify(v1Settings, null, 2));
    writeFileSync(ctx.secretsPath, JSON.stringify(v1Secrets, null, 2));
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, "s7-v1-settings-before.json"), JSON.stringify(v1Settings, null, 2));
    writeFileSync(join(EVIDENCE_DIR, "s7-v1-secrets-before.json"), JSON.stringify(redactSecretsFile(v1Secrets), null, 2));

    try {
      await spawnDevApp(ctx, {}, "s7-launch");
      await apiActionRetry(ctx, "s7", "/settings/open", {});
      await apiAction(ctx, "s7", "/settings/pane", { paneId: "provider" });
      const state = await pollProviderState(ctx, "s7", (s) => s.mounted === true);
      assert("s7", state.rows.length === 0, `expected the v1->v2 migration to RESET to zero connections (owner-decision 2026-07-15, resetV1Provider), got ${state.rows.length} row(s)`);

      const settingsAfter = dumpSettings("s7", ctx, "s7-v2-settings-after");
      assert("s7", settingsAfter.raw.version === 2, `expected migrated settings.json version=2, got ${settingsAfter.raw.version}`);
      assert("s7", Array.isArray(settingsAfter.raw.provider?.connections) && settingsAfter.raw.provider.connections.length === 0, `expected an empty v2 connections array, got ${JSON.stringify(settingsAfter.raw.provider)}`);
      assert("s7", settingsAfter.raw.provider?.activeConnectionId === undefined, `expected no activeConnectionId on a reset provider block, got ${settingsAfter.raw.provider?.activeConnectionId}`);

      const secretsAfter = dumpSecrets("s7", ctx, "s7-secrets-after-boot-scrub");
      assert("s7", secretsAfter.raw.entries["provider.apiKey"] === undefined, `expected the legacy provider.apiKey vault entry scrubbed on boot, still present: ${JSON.stringify(secretsAfter.raw.entries["provider.apiKey"])}`);

      await saveScreenshot(ctx, "s7-migrated-empty-grid");
    } finally {
      await teardown(ctx);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SELFHEAL profile: active<->non-empty invariant repair on first boot
// ══════════════════════════════════════════════════════════════════════════

async function runSelfHealScenario() {
  await runScenario(10, "preflight self-heal: connections present + no activeConnectionId -> active repairs to connections[0]", async () => {
    const ctx = makeProfile("selfheal");
    const seeded = {
      version: 2,
      provider: {
        connections: [
          { id: "conn-selfheal-a", providerId: "custom", label: "Self-heal A", model: "mock-model" },
          { id: "conn-selfheal-b", providerId: "custom", label: "Self-heal B", model: "mock-model" },
        ],
        // deliberately NO activeConnectionId.
      },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    mkdirSync(dirname(ctx.settingsPath), { recursive: true });
    writeFileSync(ctx.settingsPath, JSON.stringify(seeded, null, 2));
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, "s10-settings-seeded.json"), JSON.stringify(seeded, null, 2));

    try {
      await spawnDevApp(ctx, {}, "s10-launch");
      await apiActionRetry(ctx, "s10", "/settings/open", {});
      await apiAction(ctx, "s10", "/settings/pane", { paneId: "provider" });
      const state = await pollProviderState(ctx, "s10", (s) => s.rows.length === 2);
      const rowA = state.rows.find((r) => r.connectionId === "conn-selfheal-a");
      assert("s10", rowA !== undefined, `seeded connection A not present in the live grid: ${JSON.stringify(state.rows)}`);
      assert("s10", rowA.selected === true, `expected the preflight self-heal to select connections[0] ("conn-selfheal-a") as active, got rows=${JSON.stringify(state.rows)}`);
      await saveScreenshot(ctx, "s10-self-healed-active");
    } finally {
      await teardown(ctx);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// orchestration
// ══════════════════════════════════════════════════════════════════════════

function installSignalTeardown(getCtxs) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[provider-dogfood-w13-smoke] received ${signal} — tearing down…`);
    Promise.all(getCtxs().filter(Boolean).map((ctx) => teardown(ctx)))
      .catch((err) => console.error(`[provider-dogfood-w13-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  console.log("[provider-dogfood-w13-smoke] starting local mock provider servers…");
  const mocks = {
    success: await startMockServer("success"),
    auth401: await startMockServer("401"),
    rate429: await startMockServer("429"),
  };
  console.log(`[provider-dogfood-w13-smoke] mock-success ${mocks.success.url}, mock-401 ${mocks.auth401.url}, mock-429 ${mocks.rate429.url}`);

  installSignalTeardown(() => []);

  try {
    await runMainProfile(mocks);
    await runMigrationScenario();
    await runSelfHealScenario();
  } finally {
    await Promise.all([mocks.success.close(), mocks.auth401.close(), mocks.rate429.close()]);
  }

  console.log("\n[provider-dogfood-w13-smoke] ── summary ──");
  for (const r of results) {
    console.log(`  scenario ${r.id}: ${r.status}${r.status === "FAIL" ? ` — ${r.detail}` : ""} — ${r.description}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n[provider-dogfood-w13-smoke] ${results.length - failed.length}/${results.length} scenarios PASSED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(`[provider-dogfood-w13-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

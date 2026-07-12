/**
 * Live GUI smoke for P7.25/F3 W3/W4 (design/slice-P7.25-cut.md §3 W3/§4): drives
 * a REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "LSP / Hooks panel
 * probes/drivers" routes) and asserts BOTH `LspPanel.tsx` and `HooksPanel.tsx`
 * through their dedicated `GET /panels/lsp`/`GET /panels/hooks` probes, plus
 * PNG evidence via `GET /screenshot` — a green gate alone is not sufficient
 * proof here (design's F1 lesson, same posture as todo-panel-smoke.mjs).
 *
 * The fixture workspace's `.anycode/config.json` carries ONE `lspServers`
 * entry pointing at the REAL hermetic fixture server
 * `packages/core/src/lsp/fixtures/fake-lsp-server.cjs` (plain Node CJS, zero
 * deps, already used by `packages/core/src/lsp/manager.test.ts` — no flags
 * means it replies to `initialize` correctly, so the expected transition here
 * is `not_started -> ... -> ready`; a `crashed` reading is still accepted as
 * valid live-push proof per the cut's frozen residual ruling, §5) and ONE
 * command hook (`PostToolUse`, a bare `echo` — hooks are a shell command
 * string, not an argv+args pair, `packages/core/src/dispatch/hook-config.ts`).
 *
 * `LspManager` only spawns a server LAZILY, on the first successful Edit/Write
 * touch of a matching extension (`diagnosticsAfterWrite`, `packages/core/src/tools/diagnostics.ts`)
 * — so step 5 below drives a REAL prompt asking the live model to Write a new
 * `.ts` file in the fixture workspace, with the tab's mode flipped to `"yolo"`
 * first (permission engine §"yolo -> allow everything", no modal to drive).
 * This is the seam's true end-to-end proof: the poll after that prompt makes
 * NO further driver/Refresh call, so it fails outright against a pull-only
 * build (§4 "MUST fail on a pull-only build").
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `todo-panel-smoke.mjs` (same disposable-profile discipline). Plain node
 * >=22, ZERO npm deps — a NEW sibling, not an edit of any existing smoke.
 *
 * Usage:   node apps/desktop/scripts/lsp-hooks-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tabs this script created; it
 *                   does NOT quit an app it did not launch.
 *   --keep         Do not delete the temp workspaces/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires a configured provider (ambient env ANYCODE_API_KEY / ANYCODE_MODEL /
 * ANYCODE_BASE_URL already set by the caller, OR a pre-configured default
 * profile reached via --attach) capable of following an explicit single-tool
 * Write instruction — same precondition as `todo-panel-smoke.mjs`.
 *
 * Each of the 9 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. Step 5 (the live-push proof) allows exactly ONE
 * prompt retry (live-model nondeterminism) before failing red — every other
 * step is hard, no documented SKIP path (same discipline as
 * `todo-panel-smoke.mjs`). PNG evidence is written to
 * `apps/desktop/out/lsp-hooks-smoke/*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const LSP_FIXTURE_PATH = resolve(repoRoot, "packages/core/src/lsp/fixtures/fake-lsp-server.cjs");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 9;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;

const WRITE_PROMPT_PRIMARY =
  'Use the Write tool to create "lsp-fixture-touch.ts" with the content `export const touched = true;\n`. ' +
  "Use the Write tool specifically. Do not do anything other than that one Write call.";
const WRITE_PROMPT_RETRY =
  'Use the Write tool now. Create a file named "lsp-fixture-touch.ts" with the content `export const touched = true;\n`. ' +
  "You must use the Write tool for this. Do not do anything else.";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { attach: false, keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--attach") {
      flags.attach = true;
    } else if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else {
      console.warn(`[lsp-hooks-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from todo-panel-smoke.mjs) ──

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

/** macOS realpath-canonicalizes /var vs /private/var (tmpdir()'s two spellings of the same path). */
function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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

/** Kills the whole spawn tree, not just the direct child (detached -> own process group on POSIX). */
function killTree(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone — nothing to do.
  }
}

// ── step bookkeeping ──

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

let passCount = 0;

function pass(step, detail) {
  passCount += 1;
  console.log(`[step ${step}] PASS ${detail ?? ""}`.trimEnd());
}

function fail(step, detail) {
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
}

function assert(step, cond, detail) {
  if (!cond) {
    fail(step, detail);
  }
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

async function apiOk(ctx, step, method, path, body) {
  let resp;
  try {
    resp = await api(ctx, method, path, body);
  } catch (err) {
    fail(step, `${method} ${path} threw: ${err?.message ?? err}`);
  }
  if (resp.status !== 200) {
    fail(step, `${method} ${path} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function apiAction(ctx, step, path, body) {
  const result = await apiOk(ctx, step, "POST", path, body);
  if (result?.ok !== true) {
    fail(step, `POST ${path} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

async function waitUntilTab(ctx, step, tabId, until, timeoutMs) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} for tab ${tabId} did not match: ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Poll `GET /state` until the renderer facade has finished installing (same
 * rationale as the other smokes: DEV dynamic import races the page load).
 */
async function waitForFacade(ctx, step, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    let resp;
    try {
      resp = await api(ctx, "GET", "/state?tail=0");
    } catch {
      resp = { status: 0 };
    }
    if (resp.status === 200) {
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      fail(step, `renderer facade never installed within ${timeoutMs}ms (last GET /state -> HTTP ${resp.status})`);
    }
    await sleep(150);
  }
}

async function discoverTabByWorkspace(ctx, step, workspace, timeoutMs = 90_000) {
  const target = canonPath(workspace);
  const deadline = Date.now() + timeoutMs;
  let lastTabs = "[]";
  for (;;) {
    let resp;
    try {
      resp = await api(ctx, "GET", "/state");
    } catch {
      resp = { status: 0 };
    }
    if (resp.status === 200) {
      const states = resp.body?.snapshot?.states ?? {};
      lastTabs = JSON.stringify(resp.body?.snapshot?.tabs ?? []);
      for (const [tabId, tabState] of Object.entries(states)) {
        if (typeof tabState?.workspace === "string" && canonPath(tabState.workspace) === target) {
          return tabId;
        }
      }
    }
    if (Date.now() >= deadline) {
      fail(step, `no tab with workspace===${workspace} appeared within ${timeoutMs}ms (tabs=${lastTabs})`);
    }
    await sleep(250);
  }
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[lsp-hooks-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[lsp-hooks-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/** `GET /panels/lsp?tabId=` — the dedicated probe this slice adds (design §3 W3, main/automation/README.md). */
async function getLspPanelState(ctx, step) {
  const resp = await api(ctx, "GET", `/panels/lsp?tabId=${encodeURIComponent(ctx.tabId)}`);
  if (resp.status !== 200) {
    fail(step, `GET /panels/lsp -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /panels/lsp rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

/** `GET /panels/hooks?tabId=` for an ARBITRARY tab (used for the corrupt-config tab too). */
async function getHooksPanelStateFor(ctx, step, tabId) {
  const resp = await api(ctx, "GET", `/panels/hooks?tabId=${encodeURIComponent(tabId)}`);
  if (resp.status !== 200) {
    fail(step, `GET /panels/hooks -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /panels/hooks rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

function getHooksPanelState(ctx, step) {
  return getHooksPanelStateFor(ctx, step, ctx.tabId);
}

async function sendPrompt(ctx, step, prompt) {
  const result = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, result?.ok === true, `prompt send rejected: ${JSON.stringify(result)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
}

/** Stops the current turn and best-effort waits for it to settle to idle — used between retries. */
async function settleTurn(ctx, step) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort — proceed regardless of the settle wait outcome.
  });
}

// ── fixture config ──

/** `.anycode/config.json`: one lspServers entry (the real hermetic fixture, no flags -> speaks a clean initialize) + one PostToolUse command hook (a bare shell command string, `hook-config.ts`). */
function writeFixtureConfig(workspace) {
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  const config = {
    lspServers: [
      {
        name: "fake-lsp",
        command: process.execPath,
        args: [LSP_FIXTURE_PATH],
        extensions: [".ts"],
      },
    ],
    hooks: {
      PostToolUse: [{ command: "echo lsp-hooks-smoke-fired" }],
    },
  };
  writeFileSync(join(workspace, ".anycode", "config.json"), JSON.stringify(config, null, 2));
}

/** A deliberately malformed `.anycode/config.json` — invalid JSON, the easiest deterministic `hookConfigError` trigger (`hook-config.ts`'s `loadOneConfig` throws on JSON.parse; the LSP loader stays fail-soft on the SAME file, so this only ever surfaces via hooksPanelState). */
function writeCorruptConfig(workspace) {
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  writeFileSync(join(workspace, ".anycode", "config.json"), "{ not valid json");
}

// ── step 1: bootstrap fixture workspaces + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-lsp-hooks-smoke-ws-"));
    writeFixtureConfig(ctx.tmpWorkspace);
    ctx.corruptWorkspace = mkdtempSync(join(tmpdir(), "anycode-lsp-hooks-smoke-corrupt-"));
    writeCorruptConfig(ctx.corruptWorkspace);
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(1, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(1, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
    pass(1, `attached to running app (pid=${info.pid}, port=${info.port}); temp workspace=${ctx.tmpWorkspace}`);
    return;
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): isolates
  // userData/db/discovery so this run never collides with a parallel smoke
  // or manual dev session.
  const profile = mkdtempSync(join(tmpdir(), "anycode-lsp-hooks-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
  };
  if (FLAGS.port !== undefined) {
    env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
  }

  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  ctx.child = child;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(1, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(1, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  pass(1, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}, profile=${profile}`);
}

// ── step 2: discover/create the tab for the fixture workspace ──

async function step2DiscoverTab(ctx) {
  await waitForFacade(ctx, 2);

  if (ctx.child === null) {
    const created = await apiOk(ctx, 2, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    if (created?.ok !== true) {
      fail(2, `tab creation failed: ${JSON.stringify(created)}`);
    }
    ctx.tabId = created.tabId;
  } else {
    // Deterministic boot: main opens the boot auto-tab AS our workspace
    // (ANYCODE_WORKSPACE set in step 1).
    ctx.tabId = await discoverTabByWorkspace(ctx, 2, ctx.tmpWorkspace);
  }

  await waitUntilTab(ctx, 2, ctx.tabId, { connection: "ready" });
  // Both panel probes only ever read the ACTIVE tab's DOM (design §3 W3
  // mirrors the todo-panel/transcript-scroll probes' guard).
  await apiAction(ctx, 2, `/tabs/${ctx.tabId}/select`, {});
  pass(2, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: LSP panel closed before any toggle ──

async function step3LspPanelClosed(ctx) {
  const step = 3;
  const state = await getLspPanelState(ctx, step);
  assert(step, state.open === false, `expected open:false before any toggle, got ${JSON.stringify(state)}`);
  assert(step, state.counts === null, `expected counts:null while closed, got ${JSON.stringify(state)}`);
  assert(step, Array.isArray(state.servers) && state.servers.length === 0, `expected empty servers while closed, got ${JSON.stringify(state)}`);
  await saveScreenshot(ctx, "1-lsp-panel-closed");
  pass(step, "LSP panel reports open:false before any toggle");
}

// ── step 4: toggle LSP panel open -> configured server row, not_started ──

async function step4LspPanelOpen(ctx) {
  const step = 4;
  await apiAction(ctx, step, "/panels/lsp/toggle", { tabId: ctx.tabId });
  const state = await getLspPanelState(ctx, step);
  assert(step, state.open === true, `expected open:true after toggle, got ${JSON.stringify(state)}`);
  const row = state.servers.find((s) => s.name === "fake-lsp");
  assert(step, row !== undefined, `expected a "fake-lsp" server row, got ${JSON.stringify(state.servers)}`);
  assert(step, row.state === "not_started", `expected the fixture server's initial state to be not_started, got ${JSON.stringify(row)}`);
  ctx.lspInitialState = row.state;
  await saveScreenshot(ctx, "2-lsp-panel-open-not-started");
  pass(step, `LSP panel open with server row ${JSON.stringify(row)}`);
}

// ── step 5: live-push proof — a REAL Write touch, no further driver action ──

async function pollForLspTransition(ctx, step, previousState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Deliberately GET /panels/lsp ONLY — no toggle, no Refresh click, no
    // second read path. This is the seam's end-to-end evidence (design §4):
    // an unsolicited server-state transition must reach this probe with NO
    // driver action in between.
    const state = await getLspPanelState(ctx, step);
    const row = state.servers.find((s) => s.name === "fake-lsp");
    if (row && row.state !== previousState) {
      return { state, row };
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptWriteTouch(ctx, step, prompt, timeoutMs) {
  await sendPrompt(ctx, step, prompt);
  return pollForLspTransition(ctx, step, ctx.lspInitialState, timeoutMs);
}

async function step5LivePushProof(ctx) {
  const step = 5;
  let result = await attemptWriteTouch(ctx, step, WRITE_PROMPT_PRIMARY, 45_000);
  if (result === null) {
    console.warn(
      "[lsp-hooks-ui-smoke] step 5: the fixture server's state never transitioned on the first attempt — " +
        "retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    result = await attemptWriteTouch(ctx, step, WRITE_PROMPT_RETRY, 60_000);
  }
  if (result === null) {
    fail(step, `the fixture server's state never transitioned away from "${ctx.lspInitialState}" after 1 retry`);
  }

  const { state, row } = result;
  assert(
    step,
    row.state === "ready" || row.state === "crashed",
    `expected the fixture server to reach "ready" or "crashed", got ${JSON.stringify(row)}`,
  );
  assert(
    step,
    typeof state.counts === "string" && state.counts.toLowerCase().includes(row.state === "ready" ? "ready" : "crashed"),
    `expected the counts line to reflect the new state, got ${JSON.stringify(state.counts)}`,
  );

  await settleTurn(ctx, step);
  await saveScreenshot(ctx, "3-lsp-panel-transitioned");
  pass(step, `fixture server transitioned "${ctx.lspInitialState}" -> "${row.state}" with NO driver action in between (counts=${JSON.stringify(state.counts)})`);
}

// ── step 6: toggle LSP panel off ──

async function step6LspPanelClose(ctx) {
  const step = 6;
  await apiAction(ctx, step, "/panels/lsp/toggle", { tabId: ctx.tabId });
  const state = await getLspPanelState(ctx, step);
  assert(step, state.open === false, `expected open:false after closing toggle, got ${JSON.stringify(state)}`);
  pass(step, "LSP panel closed after toggle");
}

// ── step 7: toggle Hooks panel open -> the fixture hook, grouped ──

async function step7HooksPanelOpen(ctx) {
  const step = 7;
  const closed = await getHooksPanelState(ctx, step);
  assert(step, closed.open === false, `expected open:false before any toggle, got ${JSON.stringify(closed)}`);

  await apiAction(ctx, step, "/panels/hooks/toggle", { tabId: ctx.tabId });
  const state = await getHooksPanelState(ctx, step);
  assert(step, state.open === true, `expected open:true after toggle, got ${JSON.stringify(state)}`);
  assert(step, state.configError === null, `expected configError:null for the valid fixture config, got ${JSON.stringify(state)}`);
  const group = state.groups.find((g) => g.event === "PostToolUse");
  assert(step, group !== undefined, `expected a PostToolUse group, got ${JSON.stringify(state.groups)}`);
  assert(step, group.count >= 1, `expected PostToolUse count>=1, got ${JSON.stringify(group)}`);
  // GET /screenshot lags the live DOM by a compositor frame or two; settle
  // before capturing so the PNG evidence reflects the just-toggled hooks panel
  // (the probe above is the authoritative real-time assertion).
  await sleep(600);
  await saveScreenshot(ctx, "4-hooks-panel-open");
  pass(step, `Hooks panel open with group ${JSON.stringify(group)}`);
}

// ── step 8: toggle Hooks panel off ──

async function step8HooksPanelClose(ctx) {
  const step = 8;
  await apiAction(ctx, step, "/panels/hooks/toggle", { tabId: ctx.tabId });
  const state = await getHooksPanelState(ctx, step);
  assert(step, state.open === false, `expected open:false after closing toggle, got ${JSON.stringify(state)}`);
  pass(step, "Hooks panel closed after toggle");
}

// ── step 9: corrupt-config tab -> configError non-null ──

async function step9CorruptConfig(ctx) {
  const step = 9;
  const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.corruptWorkspace });
  assert(step, created?.ok === true, `corrupt-workspace tab creation failed: ${JSON.stringify(created)}`);
  ctx.corruptTabId = created.tabId;

  await waitUntilTab(ctx, step, ctx.corruptTabId, { connection: "ready" });
  await apiAction(ctx, step, `/tabs/${ctx.corruptTabId}/select`, {});
  await apiAction(ctx, step, "/panels/hooks/toggle", { tabId: ctx.corruptTabId });

  const state = await getHooksPanelStateFor(ctx, step, ctx.corruptTabId);
  assert(step, state.open === true, `expected open:true after toggle, got ${JSON.stringify(state)}`);
  assert(
    step,
    typeof state.configError === "string" && state.configError.length > 0,
    `expected a non-null configError for the malformed config, got ${JSON.stringify(state)}`,
  );
  // Settle so the screenshot reflects the toggled hooks panel (see step 7 note).
  await sleep(600);
  await saveScreenshot(ctx, "5-hooks-panel-config-error");
  pass(step, `corrupt-config tab reports configError=${JSON.stringify(state.configError)}`);

  await api(ctx, "POST", `/tabs/${ctx.corruptTabId}/close`, {});
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  let tabCloseFailed = false;

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else if (ctx.tabId) {
        const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
        if (closeResp.body?.ok !== true) {
          tabCloseFailed = true;
          console.warn(
            `[lsp-hooks-ui-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              `a tab is still open on a temp workspace; leaving both on disk instead of deleting out from under it`,
          );
        }
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[lsp-hooks-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[lsp-hooks-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.corruptWorkspace]) {
    if (dir && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[lsp-hooks-ui-smoke] --keep set, workspace preserved at: ${dir}`);
      } else if (tabCloseFailed) {
        console.warn(`[lsp-hooks-ui-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[lsp-hooks-ui-smoke] failed to remove temp workspace ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[lsp-hooks-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[lsp-hooks-ui-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[lsp-hooks-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[lsp-hooks-ui-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[lsp-hooks-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    corruptWorkspace: null,
    port: undefined,
    token: undefined,
    tabId: null,
    corruptTabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    lspInitialState: null,
    screenshotDir: join(desktopRoot, "out", "lsp-hooks-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3LspPanelClosed(ctx);
    await step4LspPanelOpen(ctx);
    await apiAction(ctx, 5, `/tabs/${ctx.tabId}/mode`, { mode: "yolo" });
    await step5LivePushProof(ctx);
    await step6LspPanelClose(ctx);
    await step7HooksPanelOpen(ctx);
    await step8HooksPanelClose(ctx);
    await step9CorruptConfig(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[lsp-hooks-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[lsp-hooks-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

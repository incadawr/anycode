/**
 * Live GUI smoke for the P7.11 F1b perpetual todo panel (design/slice-P7.11-cut.md
 * §3 W2): drives a REAL Electron dev instance end-to-end over the automation
 * HTTP channel (`main/automation/*`) and asserts the `TodoPanel.tsx` overlay
 * through the dedicated `GET /tabs/:tabId/todo-panel` probe (§2's `visible` /
 * `header` / `panelCollapsed` / `completedRow` / `items` shape), plus PNG
 * evidence via `GET /screenshot` — owner judges by the visible artifact
 * (design's F1 lesson), so a green gate alone is not sufficient proof here.
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `todo-subagent-smoke.mjs` (same P7.H per-run disposable profile discipline).
 * Plain node >=22, ZERO npm deps — a NEW sibling of the existing smokes, not
 * an edit of any of them.
 *
 * Usage:   node apps/desktop/scripts/todo-panel-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch.
 *   --keep         Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires a configured provider (ambient env ANYCODE_API_KEY / ANYCODE_MODEL /
 * ANYCODE_BASE_URL already set by the caller, OR a pre-configured default
 * profile reached via --attach) capable of following explicit TodoWrite
 * tool-use instructions.
 *
 * Each of the 5 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. Per the cut's §3 W2 note, ALL steps here are hard —
 * unlike todo-subagent-smoke.mjs's F16 leg, there is no documented SKIP path.
 * Each TodoWrite leg allows exactly ONE prompt retry (live-model
 * nondeterminism) before failing red. PNG evidence is written to
 * `apps/desktop/out/todo-panel-smoke/*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 5;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;

const FIRST_TODOWRITE_PROMPT_PRIMARY =
  "Create a plan with exactly 3 items using TodoWrite (each item is a short task description) " +
  "and mark all three as pending. Use the TodoWrite tool specifically. Do nothing except this " +
  "one TodoWrite call: do not create or read any files.";
const FIRST_TODOWRITE_PROMPT_RETRY =
  'Use the TodoWrite tool now. Call TodoWrite exactly once with a plan of exactly 3 items, all three with ' +
  '"status" set to "pending". You must use the TodoWrite tool for this. Do not do anything else — no files, ' +
  "no other tools.";

const SECOND_TODOWRITE_PROMPT_PRIMARY =
  "Call TodoWrite again with the same 3-item list: mark the first item completed, the second " +
  "in_progress, and leave the third pending. Use the TodoWrite tool specifically. Do nothing " +
  "except this one TodoWrite call.";
const SECOND_TODOWRITE_PROMPT_RETRY =
  'Use the TodoWrite tool now. Call TodoWrite once more with the same 3 items: mark the first item\'s "status" ' +
  'as "completed", the second item\'s "status" as "in_progress", and keep the third item "pending". You must ' +
  "use the TodoWrite tool for this. Do not do anything else.";

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
      console.warn(`[todo-panel-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from todo-subagent-smoke.mjs) ──

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
      console.warn(`[todo-panel-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[todo-panel-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/** `GET /tabs/:tabId/todo-panel` — the dedicated probe this slice adds (design §3 W2, main/automation/README.md). */
async function getTodoPanelState(ctx, step) {
  const resp = await api(ctx, "GET", `/tabs/${ctx.tabId}/todo-panel`);
  if (resp.status !== 200) {
    fail(step, `GET /tabs/${ctx.tabId}/todo-panel -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /tabs/${ctx.tabId}/todo-panel rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
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

/** Parses the panel's "Progress N/M" header text into {done, total}, or null if it doesn't match. */
function parseProgressHeader(header) {
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Progress (\d+)\/(\d+)$/);
  if (!match) {
    return null;
  }
  return { done: Number(match[1]), total: Number(match[2]) };
}

// ── step 1: bootstrap a temp workspace + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-todo-panel-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from todo-panel smoke\n");
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
  const profile = mkdtempSync(join(tmpdir(), "anycode-todo-panel-smoke-profile-"));
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

// ── step 2: discover/create the tab for the temp workspace ──

async function step2DiscoverTab(ctx) {
  await waitForFacade(ctx, 2);

  if (ctx.child === null) {
    // --attach: the foreign instance did not boot with our workspace — create
    // a tab for it explicitly via the main-plane dialog-bypass route.
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
  // The tab this script creates/discovers must also be the ACTIVE tab — both
  // the screenshot route and the todo-panel probe only ever read the active
  // tab's DOM (design §3 W2 mirrors the transcript-scroll probe's guard).
  await apiAction(ctx, 2, `/tabs/${ctx.tabId}/select`, {});
  pass(2, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: panel invisible before any TodoWrite (design §3 W2 step 1) ──

async function step3PanelInvisibleBeforeTodoWrite(ctx) {
  const step = 3;
  const state = await getTodoPanelState(ctx, step);
  assert(step, state.visible === false, `expected visible:false before any TodoWrite, got ${JSON.stringify(state)}`);
  assert(step, state.header === null, `expected header:null before any TodoWrite, got ${JSON.stringify(state)}`);
  assert(step, Array.isArray(state.items) && state.items.length === 0, `expected empty items before any TodoWrite, got ${JSON.stringify(state)}`);
  await saveScreenshot(ctx, "1-before-todowrite");
  pass(step, "todo panel reports visible:false before any TodoWrite");
}

// ── step 4: first TodoWrite (>=3 pending items) -> panel visible (design §3 W2 step 2) ──

async function pollForPanelVisible(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getTodoPanelState(ctx, step);
    if (state.visible === true) {
      return state;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptFirstTodoWrite(ctx, step, prompt, timeoutMs) {
  await sendPrompt(ctx, step, prompt);
  return pollForPanelVisible(ctx, step, timeoutMs);
}

async function step4FirstTodoWrite(ctx) {
  const step = 4;
  let state = await attemptFirstTodoWrite(ctx, step, FIRST_TODOWRITE_PROMPT_PRIMARY, 60_000);
  if (state === null) {
    console.warn(
      "[todo-panel-smoke] step 4: todo panel never became visible on the first attempt — retrying once with a " +
        "more explicit prompt",
    );
    await settleTurn(ctx, step);
    state = await attemptFirstTodoWrite(ctx, step, FIRST_TODOWRITE_PROMPT_RETRY, 90_000);
  }
  if (state === null) {
    fail(step, "todo panel never became visible (visible:true) after 1 retry");
  }

  const progress = parseProgressHeader(state.header);
  assert(step, progress !== null, `header did not match "Progress N/M": ${JSON.stringify(state.header)}`);
  assert(step, progress.total >= 3, `expected header total>=3, got ${JSON.stringify(state.header)}`);
  assert(step, state.panelCollapsed === false, `expected panelCollapsed:false by default, got ${JSON.stringify(state)}`);

  ctx.firstProgress = progress;
  await settleTurn(ctx, step);
  await saveScreenshot(ctx, "2-after-first-todowrite");
  pass(step, `todo panel visible after first TodoWrite (header=${JSON.stringify(state.header)})`);
}

// ── step 5: second TodoWrite flips counters + item glyphs (design §3 W2 step 3) ──

async function pollForProgressIncrease(ctx, step, previousDone, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getTodoPanelState(ctx, step);
    const progress = parseProgressHeader(state.header);
    if (progress !== null && progress.done > previousDone) {
      return { state, progress };
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptSecondTodoWrite(ctx, step, prompt, timeoutMs) {
  await sendPrompt(ctx, step, prompt);
  return pollForProgressIncrease(ctx, step, ctx.firstProgress.done, timeoutMs);
}

async function step5SecondTodoWrite(ctx) {
  const step = 5;
  let result = await attemptSecondTodoWrite(ctx, step, SECOND_TODOWRITE_PROMPT_PRIMARY, 60_000);
  if (result === null) {
    console.warn(
      "[todo-panel-smoke] step 5: todo panel's completed count never increased on the first attempt — retrying " +
        "once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    result = await attemptSecondTodoWrite(ctx, step, SECOND_TODOWRITE_PROMPT_RETRY, 90_000);
  }
  if (result === null) {
    fail(step, "todo panel's completed count never increased after the second TodoWrite, after 1 retry");
  }

  const { state, progress } = result;
  assert(
    step,
    progress.done > ctx.firstProgress.done,
    `expected completed count to increase from ${ctx.firstProgress.done}, got ${JSON.stringify(state.header)}`,
  );
  const hasActiveItem = Array.isArray(state.items) && state.items.some((item) => item.glyph === "active");
  assert(step, hasActiveItem, `expected at least one item with glyph:"active" (in_progress), got ${JSON.stringify(state.items)}`);

  await settleTurn(ctx, step);
  await saveScreenshot(ctx, "3-after-second-todowrite");
  pass(
    step,
    `todo panel counters flipped (header=${JSON.stringify(state.header)}, ` +
      `items=${JSON.stringify(state.items)})`,
  );
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  // An unsuccessful /close (e.g. {ok:false, reason:"last_tab"}) leaves the tab
  // (and the app it lives in) alive pointed at the temp workspace — only
  // meaningful on the --attach path (ctx.child is null there); the owned-app
  // path quits the whole process instead of closing one tab, so the temp
  // workspace is safe to remove regardless.
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
            `[todo-panel-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              `a tab is still open on the temp workspace; leaving it on disk instead of deleting out from under it`,
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
      console.warn(`[todo-panel-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[todo-panel-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[todo-panel-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(
        `[todo-panel-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`,
      );
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[todo-panel-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[todo-panel-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[todo-panel-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[todo-panel-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[todo-panel-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[todo-panel-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    firstProgress: null,
    screenshotDir: join(desktopRoot, "out", "todo-panel-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3PanelInvisibleBeforeTodoWrite(ctx);
    await step4FirstTodoWrite(ctx);
    await step5SecondTodoWrite(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[todo-panel-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[todo-panel-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

/**
 * Live GUI smoke for the P7.14 F15 prompt queue (design/slice-P7.14-cut.md
 * §5 W3 / §6 smoke plan): drives a REAL Electron dev instance end-to-end over
 * the automation HTTP channel (`main/automation/*`) and asserts the
 * queue-while-running flow through the dedicated `POST /queue/*` routes +
 * the additive `promptQueue`/`queuePaused` fields on the existing
 * `GET /state[/:tabId]` snapshot — enqueue-while-running (FIFO), inline
 * edit/delete, automatic drain-on-turn-end, and the cancel -> paused ->
 * resume branch.
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `todo-panel-smoke.mjs` (same P7.H per-run disposable profile discipline;
 * single temp workspace, no start-screen involved). Plain node >=22, ZERO
 * npm deps — a NEW sibling of the existing smokes, not an edit of any of
 * them.
 *
 * Usage:   node apps/desktop/scripts/queue-smoke.mjs [--attach] [--keep] [--port <n>]
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
 * profile reached via --attach) capable of following straightforward Read
 * tool-use instructions in the default "build" permission mode (no mode
 * change needed — Read is readOnly/needsApproval:false).
 *
 * Each of the 5 steps (design §5/§6's smoke plan) prints `[step N] PASS/FAIL
 * <detail>`; the first FAIL tears down and exits 1 — every step here is
 * hard, no documented SKIP path.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Neither a short number count nor a genuinely long (1200-word) creative
 * story turned out to be a reliable way to hold a turn "running" for
 * multiple seconds — the live GLM backend behind this smoke's credentials
 * answers fast enough (well under 200ms end-to-end, observed via a
 * transition-logging QUEUE_SMOKE_DEBUG=1 run) that a single text-generation
 * turn, however long, can complete before a single poll cycle ever catches
 * it running.
 *
 * A chain of SEQUENTIAL Read tool calls forces multiple real round trips
 * instead (host filesystem read + a fresh model completion for each next
 * step), so wall-clock latency compounds even if any one completion is
 * near-instant. Read is readOnly/needsApproval:false
 * (`packages/core/src/tools/read.ts`), so this needs no permission-mode
 * change and never opens a permission_request this script would have to
 * answer — unlike a Bash-tool delay, which would need "yolo" mode to bypass
 * Bash's own approval gate (deliberately not done here).
 */
const SLOW_READ_FILE_COUNT = 10;
const DRAINED_READ_FILE_COUNT = 40;

function readFileName(prefix, index) {
  return `${prefix}-${String(index).padStart(2, "0")}.txt`;
}

function readChainPrompt(prefix, count, doneWord) {
  const names = Array.from({ length: count }, (_, i) => readFileName(prefix, i + 1)).join(", ");
  return (
    `Using the Read tool, read these ${count} files ONE AT A TIME, in this exact order, each in its own tool ` +
    `call (do not batch, do not use Glob or Grep, do not read more than one file per call): ${names}. ` +
    `After reading all of them, reply with exactly the word: ${doneWord}. Do not say anything else.`
  );
}

const SLOW_PROMPT_TEXT = readChainPrompt("note", SLOW_READ_FILE_COUNT, "done1");

const SECOND_PROMPT_ORIGINAL_TEXT = "this queued item will be edited before it drains";
const FIRST_PROMPT_TO_DELETE_TEXT = "this queued item will be deleted before it drains";
// More files than SLOW_PROMPT_TEXT's chain: this drained turn needs its own
// reliably observable "running" window for BOTH step 4's poll (catch it
// running) AND step 5 (enqueue + cancel it while it's genuinely still
// mid-turn, not already completed).
const SECOND_PROMPT_EDITED_TEXT = "edited: " + readChainPrompt("page", DRAINED_READ_FILE_COUNT, "done2");
const PAUSED_BRANCH_PROMPT_TEXT = "queued during the second turn — should pause on cancel";

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
      console.warn(`[queue-smoke] ignoring unrecognized argument: ${arg}`);
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

// ── HTTP helpers against the automation channel (main/automation/README.md routes) ──

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

/** `GET /state/:tabId` narrowed to this run's tab, returning just its `TabStateSnapshot`. */
async function getTabState(ctx, step) {
  const resp = await apiOk(ctx, step, "GET", `/state/${ctx.tabId}`);
  const state = resp?.snapshot?.states?.[ctx.tabId];
  if (state === undefined) {
    fail(step, `GET /state/${ctx.tabId} returned no state for the tab: ${JSON.stringify(resp)}`);
  }
  return state;
}

/** Polls `getTabState` until `predicate(state)` holds, or fails the step on timeout. */
async function pollTabState(ctx, step, predicate, timeoutMs, describeExpectation, pollMs = 50) {
  const debug = process.env.QUEUE_SMOKE_DEBUG === "1";
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let last = null;
  let lastSig = null;
  if (debug) {
    console.error(`[queue-smoke debug] step${step} poll start +0ms`);
  }
  for (;;) {
    last = await getTabState(ctx, step);
    if (debug) {
      const sig = `${last.turn.status}|${last.promptQueue.length}|${last.transcript.length}`;
      if (sig !== lastSig) {
        console.error(`[queue-smoke debug] +${Date.now() - t0}ms turn=${last.turn.status} queueLen=${last.promptQueue.length} transcriptLen=${last.transcript.length}`);
        lastSig = sig;
      }
    }
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `timed out after ${timeoutMs}ms waiting for ${describeExpectation}; last state=${JSON.stringify(last)}`);
    }
    await sleep(pollMs);
  }
}

function transcriptIncludesUserText(transcript, text) {
  return (transcript ?? []).some((block) => block.kind === "user_text" && block.text === text);
}

// ── step 1: bootstrap a temp workspace + launch (or attach to) the dev app,
// discover/select the tab, and kick off a multi-second turn (design §5/§6


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
      fail(step, `timed out after ${timeoutMs}ms discovering a tab for workspace ${workspace}; last tabs=${lastTabs}`);
    }
    await sleep(500);
  }
}

async function step1LaunchAndStartTurn(ctx) {
  const step = 1;
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-queue-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from queue smoke\n");
    // Fixture files for the sequential-Read-tool delay chains (see
    // SLOW_PROMPT_TEXT / SECOND_PROMPT_EDITED_TEXT's comment).
    for (let i = 1; i <= SLOW_READ_FILE_COUNT; i += 1) {
      writeFileSync(join(ctx.tmpWorkspace, readFileName("note", i)), `note ${i} contents\n`);
    }
    for (let i = 1; i <= DRAINED_READ_FILE_COUNT; i += 1) {
      writeFileSync(join(ctx.tmpWorkspace, readFileName("page", i)), `page ${i} contents\n`);
    }
  } catch (err) {
    fail(step, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(step, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(step, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
    await apiOk(ctx, step, "GET", "/health");
  } else {
    // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): isolates
    // userData/db/discovery so this run never collides with a parallel smoke
    // or manual dev session.
    const profile = mkdtempSync(join(tmpdir(), "anycode-queue-smoke-profile-"));
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
        fail(step, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
      }
      const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
      if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
        info = candidate;
        break;
      }
      await sleep(500);
    }
    if (info === null) {
      fail(step, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
  }

  await waitForFacade(ctx, step);

  if (ctx.child === null) {
    // --attach: the foreign instance did not boot with our workspace — create
    // a tab for it explicitly via the main-plane dialog-bypass route.
    const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    if (created?.ok !== true) {
      fail(step, `tab creation failed: ${JSON.stringify(created)}`);
    }
    ctx.tabId = created.tabId;
  } else {
    // Deterministic boot: main opens the boot auto-tab AS our workspace
    // (ANYCODE_WORKSPACE set above).
    ctx.tabId = await discoverTabByWorkspace(ctx, step, ctx.tmpWorkspace);
  }

  await waitUntilTab(ctx, step, ctx.tabId, { connection: "ready" });
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/select`, {});

  const sendResult = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: SLOW_PROMPT_TEXT });
  assert(step, sendResult?.ok === true, `sendPrompt rejected: ${JSON.stringify(sendResult)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 30_000);

  pass(step, `tab ${ctx.tabId} ready, first (multi-second) turn running`);
}

// ── step 2: queue two prompts while running -> FIFO order (design §5 step 2) ──

async function step2EnqueueWhileRunning(ctx) {
  const step = 2;

  const first = await apiOk(ctx, step, "POST", "/queue/prompt", { tabId: ctx.tabId, text: FIRST_PROMPT_TO_DELETE_TEXT });
  assert(step, first?.ok === true, `POST /queue/prompt (1st) rejected: ${JSON.stringify(first)}`);
  ctx.firstQueuedId = first.id;

  const second = await apiOk(ctx, step, "POST", "/queue/prompt", { tabId: ctx.tabId, text: SECOND_PROMPT_ORIGINAL_TEXT });
  assert(step, second?.ok === true, `POST /queue/prompt (2nd) rejected: ${JSON.stringify(second)}`);
  ctx.secondQueuedId = second.id;

  const state = await getTabState(ctx, step);
  assert(step, state.turn.status === "running", `expected the first turn still running, got ${JSON.stringify(state.turn)}`);
  assert(
    step,
    Array.isArray(state.promptQueue) && state.promptQueue.length === 2,
    `expected promptQueue.length===2, got ${JSON.stringify(state.promptQueue)}`,
  );
  assert(
    step,
    state.promptQueue[0]?.id === ctx.firstQueuedId && state.promptQueue[1]?.id === ctx.secondQueuedId,
    `expected FIFO order [1st, 2nd], got ${JSON.stringify(state.promptQueue)}`,
  );

  pass(step, `queued 2 prompts while running, FIFO order confirmed: ${JSON.stringify(state.promptQueue.map((p) => p.id))}`);
}

// ── step 3: edit the 2nd item + delete the 1st -> length 1, text = edited (design §5 step 3) ──

async function step3EditAndDelete(ctx) {
  const step = 3;

  const edit = await apiOk(ctx, step, "POST", "/queue/edit", {
    tabId: ctx.tabId,
    id: ctx.secondQueuedId,
    text: SECOND_PROMPT_EDITED_TEXT,
  });
  assert(step, edit?.ok === true, `POST /queue/edit rejected: ${JSON.stringify(edit)}`);

  const del = await apiOk(ctx, step, "POST", "/queue/delete", { tabId: ctx.tabId, id: ctx.firstQueuedId });
  assert(step, del?.ok === true, `POST /queue/delete rejected: ${JSON.stringify(del)}`);

  const state = await getTabState(ctx, step);
  assert(
    step,
    Array.isArray(state.promptQueue) && state.promptQueue.length === 1,
    `expected promptQueue.length===1 after edit+delete, got ${JSON.stringify(state.promptQueue)}`,
  );
  assert(
    step,
    state.promptQueue[0]?.id === ctx.secondQueuedId && state.promptQueue[0]?.text === SECOND_PROMPT_EDITED_TEXT,
    `expected the surviving item to be the edited 2nd, got ${JSON.stringify(state.promptQueue)}`,
  );

  pass(step, `edited surviving item + deleted the other: promptQueue=${JSON.stringify(state.promptQueue)}`);
}

// ── step 4: first turn ends -> automatic drain (FIFO, edited text) starts a
// new turn (design §5 step 4) ──

async function step4WaitForDrain(ctx) {
  const step = 4;

  // A separate host-side /wait-for-idle hop BEFORE polling for the drained
  // turn's "running" state left a gap (its own 150ms poll granularity, plus
  // a full extra round trip) wide enough for a fast backend to run turn1's
  // remaining Read-tool chain, drain, AND finish turn2's ENTIRE chain before
  // this script ever checked again — observed live as intermittent step 4
  // failures. Polling directly and continuously from here (tight interval,
  // no intermediate hop) removes that gap.
  const state = await pollTabState(
    ctx,
    step,
    (s) => s.promptQueue.length === 0 && s.turn.status === "running" && transcriptIncludesUserText(s.transcript, SECOND_PROMPT_EDITED_TEXT),
    120_000,
    "the queue to auto-drain into a new running turn carrying the edited text",
    20,
  );

  pass(step, `queue drained automatically on turn-end: promptQueue empty, new turn running, transcript carries the edited text (${state.transcript.length} block(s))`);
}

// ── step 5: cancel while a queued item is pending -> paused; Resume drains it (design §5 step 5) ──

async function step5PausedThenResume(ctx) {
  const step = 5;

  const queued = await apiOk(ctx, step, "POST", "/queue/prompt", { tabId: ctx.tabId, text: PAUSED_BRANCH_PROMPT_TEXT });
  assert(step, queued?.ok === true, `POST /queue/prompt rejected: ${JSON.stringify(queued)}`);

  await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000);

  const paused = await pollTabState(
    ctx,
    step,
    (s) => s.queuePaused === true,
    15_000,
    "queuePaused===true after a cancelled turn with a non-empty queue",
  );
  assert(
    step,
    paused.promptQueue.some((p) => p.id === queued.id),
    `expected the queued item to still be present while paused, got ${JSON.stringify(paused.promptQueue)}`,
  );

  const resume = await apiOk(ctx, step, "POST", "/queue/resume", { tabId: ctx.tabId });
  assert(step, resume?.ok === true, `POST /queue/resume rejected: ${JSON.stringify(resume)}`);

  const drained = await pollTabState(
    ctx,
    step,
    (s) => s.promptQueue.length === 0 && s.queuePaused === false,
    30_000,
    "the paused item to drain and queuePaused to clear after Resume",
  );

  pass(step, `cancel -> paused (item held) -> Resume -> drained + un-paused: ${JSON.stringify(drained.promptQueue)}`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  // An unsuccessful /close leaves the tab (and the app it lives in) alive
  // pointed at the temp workspace — only meaningful on the --attach path
  // (ctx.child is null there); the owned-app path quits the whole process
  // instead of closing one tab, so the temp workspace is safe to remove
  // regardless.
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
            `[queue-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
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
      console.warn(`[queue-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[queue-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[queue-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(`[queue-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[queue-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[queue-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[queue-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[queue-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[queue-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[queue-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    firstQueuedId: null,
    secondQueuedId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchAndStartTurn(ctx);
    await step2EnqueueWhileRunning(ctx);
    await step3EditAndDelete(ctx);
    await step4WaitForDrain(ctx);
    await step5PausedThenResume(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[queue-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[queue-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

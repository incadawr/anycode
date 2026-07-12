/**
 * Live GUI smoke for F17 sticky-follow (design/slice-P7.3-cut.md §3.4): drives
 * a REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Transcript sticky-follow
 * routes" section), sends a long streaming answer, and channel-asserts the
 * three product states MessageList.tsx's sticky-follow implements: FOLLOW
 * (transcript pins to the tail while streaming), PAUSE (a manual scroll away
 * from the tail stops the pin and shows the jump-to-latest chip), and RESUME
 * (scrolling back to the tail re-engages follow) — design §3.1's spec a/b/c.
 *
 * `GET /transcript/scroll` reads live DOM geometry (`.message-list`'s
 * scrollTop/scrollHeight/clientHeight) and `atBottom` computed with the exact
 * same `isAtBottom` predicate the product's own `onScroll` handler uses — this
 * script is asserting the product's own state, not re-deriving it.
 * `POST /transcript/scroll {to}` assigns the container's real `scrollTop`
 * property, which fires the container's actual `scroll` event, so "pause" and
 * "resume" below exercise MessageList's real onScroll recompute rather than a
 * synthetic stand-in for it. A genuine mouse-wheel scroll cannot be emitted
 * over this channel (no DOM-event facade exists, design §7 residual) — the
 * scrollTop-assignment proxy is the accepted substitute since both paths funnel
 * through the identical onScroll handler; a real-wheel sanity check is a
 * manual note in PROGRESS.md, not something this script can honestly assert.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * sidebar-ui-smoke.mjs, reasoning-ui-smoke.mjs, git-ui-smoke.mjs) — this file
 * is a NEW sibling of those, not an edit of any of them.
 *
 * Usage:   node apps/desktop/scripts/transcript-follow-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch (git-ui-smoke

 *                   foreign/dev instance, not a license to kill someone
 *                   else's session).
 *   --keep         Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires a configured provider (ambient env ANYCODE_API_KEY / ANYCODE_MODEL /
 * ANYCODE_BASE_URL already set by the caller, OR a pre-configured default
 * profile reached via --attach) capable of streaming a long plain-text answer.
 * If the model's answer is too short to overflow the viewport, the script
 * retries once with a longer-line prompt, then reports the precondition step
 * as an honest FAIL — it does not fabricate transcript content. The FOLLOW /
 * PAUSE / RESUME asserts themselves never retry-until-green (design §3.4).
 *
 * Each of the 8 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/transcript-follow-smoke/step-*.png`.
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
const TOTAL_STEPS = 8;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 700;
const MIN_FOLLOW_POLLS = 3;
const MIN_PAUSE_POLLS = 3;
const MIN_RESUME_POLLS = 2;
// A streaming tail block can drift by a few px per flush before the layout
// effect re-snaps it — the same FOLLOW_THRESHOLD_PX band MessageList.tsx's own
// isAtBottom uses (design §3.1), so a genuinely-paused scrollTop near 0 is
// still allowed a little slack for the poll's own timing jitter, not for the
// product's threshold (which the facade already applies to atBottom).
const PAUSE_SCROLLTOP_SLACK_PX = 64;

// A long plain-text (no-markdown) numbered-lines prompt — enough content to
// overflow the transcript viewport so scrollHeight > clientHeight and the
// sticky-follow / jump-chip machinery actually engages.
const PROMPT_PRIMARY =
  "Output exactly 150 lines with no Markdown (no asterisks, list dashes, headings, " +
  "or backticks): one line at a time in the form 'Line N: value', where N is 1 " +
  "through 150 and value is any short random word. Output nothing else.";
const PROMPT_RETRY =
  "Print exactly 400 lines of plain text, no markdown formatting at all (no asterisks, " +
  "no list dashes, no headings, no backticks) — just one line per number, format " +
  "'Line N: <short random word>', N from 1 to 400. Nothing else, no preamble, no summary.";

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
      console.warn(`[transcript-follow-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from reasoning-ui-smoke.mjs) ──

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
 * rationale as sidebar-ui-smoke.mjs: DEV dynamic import races the page load).
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
      console.warn(`[transcript-follow-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[transcript-follow-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/** `GET /transcript/scroll?tabId=` — throws (fails the given step) on a non-200 or `{ok:false}` response. */
async function getScrollState(ctx, step, tabId) {
  const resp = await api(ctx, "GET", `/transcript/scroll?tabId=${encodeURIComponent(tabId)}`);
  if (resp.status !== 200) {
    fail(step, `GET /transcript/scroll -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /transcript/scroll rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

/** `GET /state?tail=0`'s `turn.status` for one tab, or `null` on a non-200/malformed response (treated as "can't confirm running" by the caller below). */
async function getTurnStatus(ctx, tabId) {
  let resp;
  try {
    resp = await api(ctx, "GET", "/state?tail=0");
  } catch {
    return null;
  }
  if (resp.status !== 200) {
    return null;
  }
  return resp.body?.snapshot?.states?.[tabId]?.turn?.status ?? null;
}

/**
 * codex P7.3-F2 finding 1: follow/pause/resume are only meaningful assertions
 * WHILE the turn is actually streaming — a slow model response or a fast
 * prompt that finishes before the poll loop completes would otherwise let a
 * post-stream steady-state (transcript static, but still honestly at-bottom/
 * paused/resumed by coincidence) read as a false-positive PASS. Every poll in
 * steps 5-7 re-checks this immediately before trusting its scroll sample; a
 * turn that already ended is an honest FAIL with an actionable hint, never a
 * silently-green assertion against dead content.
 */
async function assertStillStreaming(ctx, step, tabId, pollLabel) {
  const status = await getTurnStatus(ctx, tabId);
  if (status !== "running") {
    fail(
      step,
      `turn is no longer running (turnStatus=${JSON.stringify(status)}) at ${pollLabel} — the assertion window outlived ` +
        "the stream. Lengthen PROMPT_PRIMARY/PROMPT_RETRY (more lines) or shorten POLL_INTERVAL_MS/MIN_*_POLLS so the " +
        "follow/pause/resume asserts land while the turn is still genuinely streaming.",
    );
  }
}

// ── step 1: bootstrap a temp workspace + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-follow-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from transcript-follow smoke\n");
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
  const profile = mkdtempSync(join(tmpdir(), "anycode-follow-smoke-profile-"));
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
  // The tab this script creates/discovers must also be the ACTIVE tab —
  // transcriptScrollState/transcriptScrollTo refuse a non-active tabId
  // (design §3.3, only the active tab's DOM exists).
  await apiAction(ctx, 2, `/tabs/${ctx.tabId}/select`, {});
  pass(2, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: send the long streaming prompt, wait for the turn to start running ──

async function step3SendPrompt(ctx, prompt) {
  const result = await apiOk(ctx, 3, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(3, result?.ok === true, `prompt send rejected: ${JSON.stringify(result)}`);

  await waitUntilTab(ctx, 3, ctx.tabId, { turnStatus: "running" }, 60_000);
  pass(3, `turn running after prompt send (requestId=${result.requestId})`);
}

// ── step 4: wait until the transcript actually overflows the viewport (precondition for follow to be observable); one retry allowed with a longer prompt ──

async function waitForOverflow(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await getScrollState(ctx, step, ctx.tabId);
    if (last.scrollHeight > last.clientHeight) {
      return last;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(300);
  }
}

async function step4WaitOverflow(ctx) {
  let state = await waitForOverflow(ctx, 4, 30_000);

  if (state === null) {
    console.warn(
      "[transcript-follow-smoke] transcript never overflowed the viewport on the first attempt — retrying with a longer prompt",
    );
    await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
    await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
      // best-effort — proceed to the retry regardless of the settle wait outcome.
    });
    await step3SendPrompt(ctx, PROMPT_RETRY);
    state = await waitForOverflow(ctx, 4, 45_000);
  }

  if (state === null) {
    // Honest red (design §3.4's one sanctioned retry, precondition only) — do
    // NOT fabricate an overflow condition to force the follow asserts green.
    fail(4, "transcript content never exceeded the viewport height for either prompt attempt");
  }

  ctx.overflowConfirmedAt = state;
  pass(4, `transcript overflows viewport (scrollHeight=${state.scrollHeight} > clientHeight=${state.clientHeight})`);
}

// ── step 5: assert FOLLOW — atBottom===true across >=3 polls while scrollHeight strictly grows ──

async function step5AssertFollow(ctx) {
  const samples = [];
  for (let i = 0; i < MIN_FOLLOW_POLLS; i += 1) {
    await assertStillStreaming(ctx, 5, ctx.tabId, `poll ${i + 1}/${MIN_FOLLOW_POLLS}`);
    const state = await getScrollState(ctx, 5, ctx.tabId);
    samples.push(state);
    assert(
      5,
      state.atBottom === true,
      `poll ${i + 1}/${MIN_FOLLOW_POLLS}: expected atBottom===true while streaming (follow), got ${JSON.stringify(state)}`,
    );
    if (i < MIN_FOLLOW_POLLS - 1) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  // codex P7.3-F2 finding 1: content growth across the poll window is now a
  // hard assertion, not an advisory footnote — without it, a stream that
  // stalled (or already finished but was mid-race with assertStillStreaming
  // above) could still read atBottom===true against perfectly static
  // content, which proves nothing about follow actually tracking a live tail.
  const grew = samples[samples.length - 1].scrollHeight > samples[0].scrollHeight;
  assert(
    5,
    grew,
    `scrollHeight did not grow across ${samples.length} polls (${samples[0].scrollHeight} -> ` +
      `${samples[samples.length - 1].scrollHeight}) — the stream produced no new content during the follow assertion ` +
      "window, so atBottom===true is not evidence of follow; lengthen the prompt or shorten the poll window",
  );
  pass(
    5,
    `atBottom===true across ${samples.length} polls under a live+growing stream (follow engaged); scrollHeight ${samples[0].scrollHeight} -> ${samples[samples.length - 1].scrollHeight}`,
  );
}

// ── step 6: scrollTo("top") -> assert PAUSE — atBottom===false, scrollTop~0, jumpVisible===true ──

async function step6AssertPause(ctx) {
  await apiAction(ctx, 6, "/transcript/scroll", { tabId: ctx.tabId, to: "top" });
  // The scrollTop write's `scroll` event handler flips `followRef` synchronously,
  // but the mirrored `useState` (which the jump-chip's render gate reads) only
  // lands after React's next commit — give it one render tick before the
  // assertion loop starts (not a retry-until-green on the asserts themselves,
  // just settling the known React-commit lag design §3.1 calls out).
  await sleep(200);

  const samples = [];
  for (let i = 0; i < MIN_PAUSE_POLLS; i += 1) {
    await assertStillStreaming(ctx, 6, ctx.tabId, `poll ${i + 1}/${MIN_PAUSE_POLLS}`);
    const state = await getScrollState(ctx, 6, ctx.tabId);
    samples.push(state);
    assert(6, state.atBottom === false, `poll ${i + 1}/${MIN_PAUSE_POLLS}: expected atBottom===false after scrollTo(top), got ${JSON.stringify(state)}`);
    assert(
      6,
      state.scrollTop <= PAUSE_SCROLLTOP_SLACK_PX,
      `poll ${i + 1}/${MIN_PAUSE_POLLS}: expected scrollTop to stay near 0 (pause holds position) while streaming continued, got ${JSON.stringify(state)}`,
    );
    assert(6, state.jumpVisible === true, `poll ${i + 1}/${MIN_PAUSE_POLLS}: expected the jump-to-latest chip visible while paused, got ${JSON.stringify(state)}`);
    if (i < MIN_PAUSE_POLLS - 1) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await saveScreenshot(ctx, "step6-paused-jump-chip");
  pass(6, `pause held (atBottom===false, scrollTop<=${PAUSE_SCROLLTOP_SLACK_PX}, jumpVisible===true) across ${samples.length} polls`);
}

// ── step 7: scrollTo("bottom") -> assert RESUME — atBottom===true again across >=2 polls ──

async function step7AssertResume(ctx) {
  await apiAction(ctx, 7, "/transcript/scroll", { tabId: ctx.tabId, to: "bottom" });
  // Same React-commit settle grace as step 6.
  await sleep(200);

  const samples = [];
  for (let i = 0; i < MIN_RESUME_POLLS; i += 1) {
    await assertStillStreaming(ctx, 7, ctx.tabId, `poll ${i + 1}/${MIN_RESUME_POLLS}`);
    const state = await getScrollState(ctx, 7, ctx.tabId);
    samples.push(state);
    assert(
      7,
      state.atBottom === true,
      `poll ${i + 1}/${MIN_RESUME_POLLS}: expected atBottom===true after scrollTo(bottom) (resume via the product's real onScroll path), got ${JSON.stringify(state)}`,
    );
    if (i < MIN_RESUME_POLLS - 1) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  await saveScreenshot(ctx, "step7-resumed-follow");
  pass(7, `follow re-engaged (atBottom===true across ${samples.length} polls after scrollTo(bottom))`);
}

// ── step 8: finish the turn, assert the jump chip hides once idle+at-bottom, teardown ──

async function step8FinishTurn(ctx) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, 8, ctx.tabId, { turnStatus: "idle" }, 60_000).catch((err) => {
    console.warn(`[transcript-follow-smoke] turn did not settle to idle cleanly: ${err?.message ?? err}`);
  });

  const state = await getScrollState(ctx, 8, ctx.tabId);
  assert(8, state.jumpVisible === false, `expected the jump chip hidden at bottom once idle, got ${JSON.stringify(state)}`);
  await saveScreenshot(ctx, "step8-settled-no-chip");
  pass(8, "turn stopped/settled; jump chip hidden at bottom");
}

// ── teardown ──

/**
 * codex P7.3-F2 finding 3: the old idempotency guard was a plain boolean
 * (`ctx.tornDown`) checked-then-set synchronously at the top of `teardown` —
 * that only dedupes CALLS that start, it says nothing about calls that start
 * WHILE an earlier call is still mid-flight (awaiting `/quit`, `waitForExit`,
 * `rmSync`, …). A concurrent second call (e.g. the SIGINT/SIGTERM handler
 * firing while the normal end-of-run() teardown is still running) saw
 * `tornDown === true` already, returned instantly as if teardown were
 * "done", and the signal handler's unconditional `process.exit(1)` then
 * killed the process out from under the FIRST call's still-in-flight
 * cleanup (a half-quit app, a temp dir mid-`rmSync`). The fix: `teardown`
 * itself is now a thin memoizing wrapper — the actual work runs at most once
 * per process, in `runTeardown`, and every caller (normal or signal) awaits
 * the SAME shared promise, so a concurrent caller genuinely waits for real
 * completion before doing anything else (exiting) rather than racing a
 * boolean.
 */
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
            `[transcript-follow-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
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
      console.warn(`[transcript-follow-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[transcript-follow-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[transcript-follow-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(
        `[transcript-follow-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`,
      );
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[transcript-follow-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[transcript-follow-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[transcript-follow-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[transcript-follow-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

/**
 * Ctrl-C / kill mid-run must still tear the spawned app + per-run temp
 * profile down. `teardown()`'s shared `ctx.teardownPromise` (codex P7.3-F2
 * finding 3) means a signal landing while the normal run()-tail teardown is
 * already executing genuinely AWAITS that same in-flight cleanup instead of
 * treating a stale "already started" flag as "already finished" and
 * `process.exit(1)`-ing out from under it.
 */
function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[transcript-follow-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[transcript-follow-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    overflowConfirmedAt: null,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "transcript-follow-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3SendPrompt(ctx, PROMPT_PRIMARY);
    await step4WaitOverflow(ctx);
    await step5AssertFollow(ctx);
    await step6AssertPause(ctx);
    await step7AssertResume(ctx);
    await step8FinishTurn(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[transcript-follow-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[transcript-follow-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

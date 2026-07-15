/**
 * Live GUI smoke for TASK.33 W8 (design/track-43-45-33-47-49-cut.md §"W8 —
 * renderer retry-UX"): drives a REAL Electron dev instance end-to-end over the
 * automation HTTP channel (`main/automation/*`, see `automation/README.md`)
 * through the observable-retry UX: a failed turn's `stream_retry` lines
 * appearing live in the transcript, the terminal "(failed after N attempts)"
 * error card, the one-shot Try-again button's presence, a click re-sending the
 * prompt as a genuine new turn, and Cancel actually interrupting an in-flight
 * retry loop instead of hanging.
 *
 * Unlike every other `*-ui-smoke.mjs` (which needs a real configured provider
 * and ambient credentials), this script is fully self-contained: it points
 * `ANYCODE_BASE_URL` at a LOCAL loopback TCP port with NOTHING listening on
 * it — reserved (bind to port 0, read the assigned port, close immediately)
 * right before launch so the number is real and free, not guessed. Loopback
 * refuses a connect to a port with no listener INSTANTLY at the kernel level
 * (confirmed live: a `fetch()` against one rejects in <5ms with
 * `ECONNREFUSED`) — a genuine, deterministic connect-class failure, not a
 * silent blackhole (which would make every retry wait out a slow
 * connect-timeout instead of failing fast and repeatably). `ECONNREFUSED` is
 * one of `classifyProviderFailure`'s `network` bucket entries
 * (packages/core/src/provider/failure.ts), so retries fire immediately and
 * repeatably, with no dependency on a real model/network and no risk of
 * accidentally succeeding.
 *
 * An EARLIER version of this script instead ran an active TCP server that
 * called `socket.resetAndDestroy()` on every accepted connection (a genuine
 * TCP RST rather than "nothing listening"). That reproducibly CRASHED the
 * whole host subprocess — an uncaught `Error: setTypeOfService EINVAL` deep in
 * undici's H1 write path (`Socket.setTypeOfService` at node:net, called while
 * configuring a socket undici believes is live, racing the RST tearing it
 * down first) — instead of the fetch rejecting into the model port's own
 * retry/catch path. That crash is real and reproducible on this machine's
 * host runtime (Node v24.17.0, not the v22 this script itself runs under —
 * the host subprocess resolves its own `node` off PATH) but is a Node/undici
 * platform edge case orthogonal to the TASK.33 W8 retry-UX surface this smoke
 * exists to verify, so this script does not chase it further; worth a
 * separate residual (a hostile/misbehaving proxy sending a mid-handshake RST
 * could crash a live session instead of surfacing a retryable failure).
 * `ANYCODE_API_KEY`/`ANYCODE_MODEL` are set to opaque dummy values: the
 * request body/headers are never read (the connect itself fails before any
 * HTTP is sent), so their content is irrelevant — only their presence (the
 * anthropic-messages transport is fail-closed on a missing key) matters.
 *
 * Desktop wires NO retry-policy override into `AiSdkModelPort` (unlike the
 * CLI's `ANYCODE_MAX_RETRIES` — apps/desktop/src/host/index.ts never reads
 * that env var), so every run exercises the real `DEFAULT_RETRY_POLICY`
 * (packages/core/src/provider/retry.ts: 3 retries, 1s/2s/4s-capped jittered
 * backoff) — the exact policy a real user sees, not a smoke-tuned one.
 *
 * No `--attach` flag (unlike its siblings): this script's whole point is a
 * deterministic connect-refused target it owns end-to-end, and an
 * already-running instance was booted with its own (almost certainly
 * different) provider config — attaching to it would silently stop testing
 * what this script claims to test.
 *
 * Plain node >=22, ZERO npm deps (node:child_process/fs/net/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * reasoning-ui-smoke.mjs, git-ui-smoke.mjs) — a NEW sibling, not an edit of
 * any of them.
 *
 * Usage:   node apps/desktop/scripts/retry-ui-smoke.mjs [--keep] [--port <n>]
 *
 *   --keep         Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (the automation channel's OWN port — unrelated to
 *                   the reserved connect-refused port, which is always
 *                   ephemeral).
 *
 * Each of the 8 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/retry-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const PROMPT_TEXT = "trigger the retry smoke (this text is never read — the RST lands before any request body is sent)";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else {
      console.warn(`[retry-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from reasoning-ui-smoke.mjs / git-ui-smoke.mjs) ──

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

/**
 * Reserves a loopback port with nothing listening on it: bind to port 0 (OS
 * assigns a free ephemeral port), read the assignment, close immediately.
 * Tiny TOCTOU window between close and the app's first connect attempt
 * (seconds later) — accepted for a single-run local dev-machine smoke, same
 * trade-off any "reserve a free port for a test" helper makes. See file
 * header for why this replaced an earlier active-RST-server design.
 */
function reserveUnusedPort() {
  return new Promise((resolveReserved, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolveReserved(port));
    });
  });
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
 * rationale as reasoning-ui-smoke.mjs: DEV dynamic import races the page load).
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
      console.warn(`[retry-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[retry-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/** Raw transcript for one tab (no `/wait` needed — the shapes this script inspects, `stream_retry`/`error`/`retryOffer`, aren't covered by `/wait`'s `transcriptIncludes` text search). */
async function getTabState(ctx, tabId) {
  const resp = await api(ctx, "GET", `/state/${tabId}`);
  if (resp.status !== 200) {
    return null;
  }
  return resp.body?.snapshot?.states?.[tabId] ?? null;
}

function countStreamRetryBlocks(tabState) {
  return (tabState?.transcript ?? []).filter((b) => b?.kind === "stream_retry").length;
}

function findTerminalErrorBlock(tabState) {
  const blocks = tabState?.transcript ?? [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === "error") {
      return blocks[i];
    }
  }
  return null;
}

/** Mirrors MessageList.tsx's `formatErrorRetrySuffix` verbatim, for human-readable evidence in this script's own output. */
function formatErrorRetrySuffix(retry) {
  if (!retry || retry.attemptsMade <= 0) {
    return "";
  }
  return ` (failed after ${retry.attemptsMade} attempt${retry.attemptsMade === 1 ? "" : "s"})`;
}

async function pollUntil(timeoutMs, pollMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(pollMs);
  }
}

// ── step 1: reserve the connect-refused port + bootstrap a temp workspace + launch the dev app pointed at it ──

async function step1LaunchApp(ctx) {
  ctx.refusedPort = await reserveUnusedPort();

  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-retry-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from retry smoke\n");
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): isolates
  // userData/db/discovery so this run never collides with a parallel smoke
  // or manual dev session.
  const profile = mkdtempSync(join(tmpdir(), "anycode-retry-smoke-profile-"));
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
    // Deterministic connect-class failure target (a reserved, nothing-
    // listening loopback port) — never the caller's ambient provider config,
    // and no real credentials required. See file header for why.
    ANYCODE_BASE_URL: `http://127.0.0.1:${ctx.refusedPort}`,
    ANYCODE_API_KEY: "sk-retry-smoke-dummy-key",
    ANYCODE_MODEL: "retry-smoke-dummy-model",
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
  pass(
    1,
    `connect-refused target on 127.0.0.1:${ctx.refusedPort}; app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on automation port ${info.port}, profile=${profile}`,
  );
}

// ── step 2: discover the boot tab for the temp workspace ──

async function step2DiscoverTab(ctx) {
  await waitForFacade(ctx, 2);
  ctx.tabId = await discoverTabByWorkspace(ctx, 2, ctx.tmpWorkspace);
  await waitUntilTab(ctx, 2, ctx.tabId, { connection: "ready" });
  pass(2, `tab ${ctx.tabId} ready for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: send the prompt, wait for the turn to start running against the connect-refused target ──

async function step3SendPrompt(ctx) {
  const result = await apiOk(ctx, 3, "POST", `/tabs/${ctx.tabId}/prompt`, { text: PROMPT_TEXT });
  assert(3, result?.ok === true, `prompt send rejected: ${JSON.stringify(result)}`);

  await waitUntilTab(ctx, 3, ctx.tabId, { turnStatus: "running" }, 30_000);
  pass(3, `turn running against connect-refused target (requestId=${result.requestId})`);
}

// ── step 4: observe stream_retry attempts appear live in the transcript ──

async function step4ObserveLiveRetries(ctx) {
  const retries = await pollUntil(30_000, 200, async () => {
    const state = await getTabState(ctx, ctx.tabId);
    const blocks = (state?.transcript ?? []).filter((b) => b?.kind === "stream_retry");
    return blocks.length > 0 ? blocks : undefined;
  });
  assert(4, retries !== null, "no stream_retry transcript block appeared within 30s of the RST-target prompt");
  ctx.firstTurnRetryCount = retries.length;
  pass(
    4,
    `${retries.length} live stream_retry block(s) observed, e.g. attempt ${retries[0].attempt}/${retries[0].maxAttempts} in ${retries[0].delayMs}ms: ${retries[0].reason}`,
  );
}

// ── step 5: observe the terminal "(failed after N attempts)" card once retries exhaust ──

async function step5ObserveTerminalCard(ctx) {
  await waitUntilTab(ctx, 5, ctx.tabId, { turnStatus: "idle" }, 60_000);
  const state = await getTabState(ctx, ctx.tabId);
  const errorBlock = findTerminalErrorBlock(state);
  assert(5, errorBlock !== null, "no terminal error block in the transcript after the turn settled idle");
  const retry = errorBlock.retry;
  assert(5, retry !== undefined, "terminal error block carries no `retry` metadata (event.retry never rode through)");
  assert(5, retry.attemptsMade > 0, `attemptsMade should be > 0, got ${retry.attemptsMade}`);
  assert(5, retry.retryable === true, `retryable should be true for a connect/reset failure, got ${retry.retryable}`);
  assert(5, retry.hadModelOutput === false, `hadModelOutput should be false (failure before any content), got ${retry.hadModelOutput}`);
  ctx.firstTurnAttemptsMade = retry.attemptsMade;
  const suffix = formatErrorRetrySuffix(retry);
  assert(5, suffix.length > 0, "formatErrorRetrySuffix produced an empty suffix for attemptsMade > 0");
  pass(5, `terminal card text would read "...${suffix}" (attemptsMade=${retry.attemptsMade}, maxAttempts=${retry.maxAttempts ?? "n/a"}, code=${retry.code})`);
}

// ── step 6: observe the Try-again button's presence via retryOffer ──

async function step6ObserveTryAgainOffer(ctx) {
  const state = await getTabState(ctx, ctx.tabId);
  const offer = state?.retryOffer ?? null;
  assert(6, offer !== null, "retryOffer is null — the Try-again button would not render");
  assert(6, offer.text === PROMPT_TEXT, `retryOffer.text mismatch: expected the original prompt, got ${JSON.stringify(offer.text)}`);
  ctx.beforeClickRetryCount = countStreamRetryBlocks(state);
  await saveScreenshot(ctx, "step6-try-again-offered");
  pass(6, `Try-again offer armed for loop_end block ${offer.loopEndBlockId} (imageCount=${offer.imageCount})`);
}

// ── step 7: click Try-again — re-sends as a genuine new turn, one-shot consumed ──

async function step7ClickTryAgain(ctx) {
  const result = await apiAction(ctx, 7, `/tabs/${ctx.tabId}/retry`, {});
  assert(7, result.ok === true, `retry click rejected: ${JSON.stringify(result)}`);

  await waitUntilTab(ctx, 7, ctx.tabId, { turnStatus: "running" }, 15_000);
  const state = await getTabState(ctx, ctx.tabId);
  assert(7, state?.retryOffer === null, `retryOffer should be consumed (one-shot) after the click, got ${JSON.stringify(state?.retryOffer)}`);
  pass(7, "Try-again click resent the prompt — a new turn is running against the connect-refused target, offer consumed");
}

// ── step 8: cancel actually interrupts the in-flight retry loop, no hang ──

async function step8CancelMidRetry(ctx) {
  // Prove this is a REAL new turn hitting the connect-refused target again,
  // not a stale reading of turn 1's already-settled retries.
  const grew = await pollUntil(15_000, 200, async () => {
    const state = await getTabState(ctx, ctx.tabId);
    const count = countStreamRetryBlocks(state);
    return count > ctx.beforeClickRetryCount ? count : undefined;
  });
  assert(8, grew !== null, "no NEW stream_retry block appeared on the second (post Try-again) turn — cancel would be testing a settled turn, not a live one");

  await apiAction(ctx, 8, `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, 8, ctx.tabId, { turnStatus: "idle" }, 30_000);
  pass(8, `cancel interrupted the in-flight retry loop (was mid-retry with ${grew} stream_retry blocks total) — turn settled idle, no hang`);
}

// ── teardown ──

/**
 * Same shared-promise discipline as reasoning-ui-smoke.mjs (codex P7.3-F2
 * finding 3): every caller awaits the SAME in-flight teardown rather than a
 * stale "already done" flag racing a signal handler's `process.exit`.
 */
function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      }
    } catch {
      // best-effort — the app may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[retry-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[retry-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[retry-ui-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[retry-ui-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[retry-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[retry-ui-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[retry-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[retry-ui-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[retry-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    refusedPort: undefined,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    firstTurnRetryCount: 0,
    firstTurnAttemptsMade: 0,
    beforeClickRetryCount: 0,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "retry-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3SendPrompt(ctx);
    await step4ObserveLiveRetries(ctx);
    await step5ObserveTerminalCard(ctx);
    await step6ObserveTryAgainOffer(ctx);
    await step7ClickTryAgain(ctx);
    await step8CancelMidRetry(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[retry-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[retry-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

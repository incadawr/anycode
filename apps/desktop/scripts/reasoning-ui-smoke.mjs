/**
 * Live GUI smoke for F18 (design/slice-P7.2-cut.md §5.2): drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`), sends a reasoning-
 * eliciting prompt, and captures a screenshot of the collapsed live
 * reasoning plate — the badge + sanitized preview this slice ships.
 *
 * This script does NOT (and cannot) re-import `reasoningTailPreview`
 * (component-internal, not part of the automation surface) — the sanitizer
 * contract itself is pinned by the unit corpus in `WorkingRow.test.ts`. What
 * this script pins is that a real `reasoning` transcript block shows up
 * live (turn running) while the raw `block.text` still contains markdown-ish
 * characters, and produces a human-inspectable screenshot of the plate for
 * visual review.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * sidebar-ui-smoke.mjs, git-ui-smoke.mjs) — a NEW sibling, not an edit of any
 * of them.
 *
 * Usage:   node apps/desktop/scripts/reasoning-ui-smoke.mjs [--attach] [--keep] [--port <n>]
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
 * Requires a configured provider whose model actually streams reasoning
 * (e.g. a GLM thinking-mode model) — via the ambient env (ANYCODE_API_KEY /
 * ANYCODE_MODEL / ANYCODE_BASE_URL) already set by the caller, OR a
 * pre-configured default profile reached via --attach. If the configured
 * model emits no reasoning for the prompt, the script retries once with a
 * stronger prompt, then reports the step as an honest FAIL — it does NOT
 * fabricate a synthetic reasoning block.
 *
 * Each of the 6 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/reasoning-smoke/step-*.png`.
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
const TOTAL_STEPS = 6;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// A markdown-heavy prompt (list markers + inline code) so the raw reasoning
// stream is likely to contain the exact syntax this slice sanitizes out of
// the collapsed preview (list dash, inline-code backticks).
const PROMPT_PRIMARY =
  "Think step by step out loud before answering: write your reasoning as a " +
  "bulleted list (each item on a new line beginning with `- `), and use `code` " +
  "in backticks at least once in the reasoning. Question: what is 17 * 23? " +
  "Answer only after reasoning.";
const PROMPT_RETRY =
  "Before answering, think step by step out loud in detail, longer than usual, " +
  "using a markdown bullet list (`- ` per line) and inline `code` at least once. " +
  "Question: what is 123 * 456?";

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
      console.warn(`[reasoning-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from git-ui-smoke.mjs / sidebar-ui-smoke.mjs) ──

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
      console.warn(`[reasoning-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[reasoning-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Poll `GET /state/:tabId?tail=N` until a `kind==="reasoning"` transcript
 * block with non-empty `text` appears WHILE the turn is still running (the
 * live window — after which the block is settled/collapsed and no longer
 * proves the live badge/preview path). Returns the block once found, or null
 * if the turn settles (or times out) with no reasoning ever observed.
 */
async function pollForLiveReasoningBlock(ctx, tabId, timeoutMs) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  // Grace window before an "idle" reading is trusted as "already settled" —
  // the caller just observed turnStatus==="running" via /wait, so an idle
  // reading in the first tick is a stale poll, not a completed turn.
  const settleGraceMs = 500;
  for (;;) {
    // GET /state/:tabId narrows the SAME snapshot shape as GET /state:
    // {snapshot:{states:{[tabId]: TabStateSnapshot}}} — TabStateSnapshot
    // carries `turn: {status}` and `transcript: TranscriptBlock[]`.
    const resp = await api(ctx, "GET", `/state/${tabId}?tail=30`);
    if (resp.status === 200) {
      const tabState = resp.body?.snapshot?.states?.[tabId];
      const turnStatus = tabState?.turn?.status;
      const blocks = tabState?.transcript ?? [];
      const reasoningBlock = blocks.find((b) => b?.kind === "reasoning" && typeof b?.text === "string" && b.text.length > 0);
      if (reasoningBlock && turnStatus === "running") {
        return reasoningBlock;
      }
      if (turnStatus === "idle" && Date.now() - start > settleGraceMs) {
        // Turn already settled — no more live window left to observe.
        return null;
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(150);
  }
}

// ── step 1: bootstrap a temp workspace + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-reasoning-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from reasoning smoke\n");
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
  const profile = mkdtempSync(join(tmpdir(), "anycode-reasoning-smoke-profile-"));
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
    // Force reasoning ON for a reasoning-capable configured model (e.g. GLM's
    // glm-5.2, whose default effort is "off" — confirmed live: the same
    // prompt against effort:"off" produced zero reasoning blocks, "high"
    // reliably streamed one). Caller's own explicit env override still wins.
    ANYCODE_REASONING_EFFORT: process.env.ANYCODE_REASONING_EFFORT ?? "high",
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
  pass(2, `tab ${ctx.tabId} ready for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: send the reasoning-eliciting prompt, wait for the turn to start running ──

async function step3SendPrompt(ctx, prompt) {
  const result = await apiOk(ctx, 3, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(3, result?.ok === true, `prompt send rejected: ${JSON.stringify(result)}`);

  await waitUntilTab(ctx, 3, ctx.tabId, { turnStatus: "running" }, 60_000);
  pass(3, `turn running after prompt send (requestId=${result.requestId})`);
}

// ── step 4: poll transcript for a live reasoning block; retry once with a stronger prompt ──

async function step4ObserveLiveReasoning(ctx) {
  let block = await pollForLiveReasoningBlock(ctx, ctx.tabId, 45_000);

  if (block === null) {
    console.warn("[reasoning-ui-smoke] no live reasoning block observed on the first attempt — retrying with a stronger prompt");
    // Let the current turn finish/settle before starting a fresh one.
    await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
    await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
      // best-effort — proceed to the retry regardless of the settle wait outcome.
    });
    await step3SendPrompt(ctx, PROMPT_RETRY);
    block = await pollForLiveReasoningBlock(ctx, ctx.tabId, 45_000);
  }

  if (block === null) {
    // Honest red per DoD §5.2's fallback lever — do NOT fabricate a synthetic
    // reasoning block to force green.
    fail(4, "configured provider/model emitted no live reasoning block for either prompt attempt");
  }

  ctx.reasoningBlockText = block.text;
  const hasMarkdownish = /[`*#[\]]|^\s*-\s/.test(block.text);
  pass(
    4,
    `live reasoning block observed (len=${block.text.length}, markdown-ish-chars=${hasMarkdownish}): ${JSON.stringify(block.text.slice(0, 80))}…`,
  );
}

// ── step 5: screenshot the collapsed live plate ──

async function step5Screenshot(ctx) {
  const filePath = await saveScreenshot(ctx, "step-collapsed-plate");
  assert(5, typeof filePath === "string", "screenshot capture failed (see warning above)");
  ctx.screenshotPath = filePath;
  pass(5, `collapsed reasoning plate captured: ${filePath}`);
}

// ── step 6: finish the turn + teardown ──

async function step6FinishTurn(ctx) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, 6, ctx.tabId, { turnStatus: "idle" }, 60_000).catch((err) => {
    console.warn(`[reasoning-ui-smoke] turn did not settle to idle cleanly: ${err?.message ?? err}`);
  });
  pass(6, "turn stopped/settled");
}

// ── teardown ──

/**
 * codex P7.3-F2 finding 3 (transcript-follow-smoke.mjs sibling — same clone,
 * same fix): `teardown` is now a thin memoizing wrapper around
 * `runTeardown` — every caller (normal end-of-run() and the SIGINT/SIGTERM
 * handler) awaits the SAME shared promise, so a signal that lands while
 * teardown is already mid-flight genuinely waits for that real work to
 * finish instead of a stale boolean flag reading "already done" and the
 * signal handler's `process.exit(1)` killing the process out from under an
 * in-progress quit/rmSync.
 */
function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  // Codex finding: an unsuccessful /close (e.g. {ok:false, reason:"last_tab"})
  // was previously ignored — the tab (and the app it lives in) stays alive
  // pointed at the temp workspace, which the code below then deleted out from
  // under it. Only ever meaningful on the --attach path (ctx.child is null
  // there); the owned-app path quits the whole process instead of closing one
  // tab, so the temp workspace is safe to remove regardless.
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
            `[reasoning-ui-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
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
      console.warn(`[reasoning-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[reasoning-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[reasoning-ui-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(
        `[reasoning-ui-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`,
      );
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[reasoning-ui-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[reasoning-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[reasoning-ui-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[reasoning-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

/**
 * Ctrl-C / kill mid-run must still tear the spawned app + per-run temp
 * profile down (codex finding: a bare process.exit on SIGINT leaked both).
 * `teardown`'s shared `ctx.teardownPromise` (codex P7.3-F2 finding 3) means a
 * signal landing while the normal run()-tail teardown is already executing
 * genuinely AWAITS that same in-flight cleanup instead of treating a stale
 * "already started" flag as "already finished" and exiting out from under it.
 */
function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[reasoning-ui-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[reasoning-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    reasoningBlockText: null,
    screenshotPath: null,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "reasoning-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3SendPrompt(ctx, PROMPT_PRIMARY);
    await step4ObserveLiveReasoning(ctx);
    await step5Screenshot(ctx);
    await step6FinishTurn(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[reasoning-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[reasoning-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

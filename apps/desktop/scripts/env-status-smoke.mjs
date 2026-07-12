/**
 * Live GUI smoke for P7.8 W3 (design/slice-P7.8-cut.md §5): drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`), exercising the
 * `envStatus` seam (telemetry + repo-map status surfaced into
 * `states[tabId].envStatus`, host/index.ts + session.ts §3.2-3.3, wired into
 * `TabStateSnapshot` §3.6) end-to-end against a workspace with BOTH features
 * opted in via `.anycode/config.json`.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (sidebar-ui-smoke.mjs,
 * transcript-follow-smoke.mjs) — this file is a NEW sibling, not an edit of
 * either.
 *
 * Usage:   node apps/desktop/scripts/env-status-smoke.mjs [--attach] [--keep] [--port <n>]
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
 * profile reached via --attach) capable of completing a short prompt turn.
 *
 * Each of the 5 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. This script is honest: no SKIP on partial
 * data — every assert is hard.
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

const PROMPT_TEXT = "Reply with exactly one short sentence. No markdown.";

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
      console.warn(`[env-status-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from transcript-follow-smoke.mjs) ──

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
 * rationale as sidebar-ui-smoke.mjs/transcript-follow-smoke.mjs: DEV dynamic
 * import races the page load).
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

async function getFullState(ctx, step) {
  return apiOk(ctx, step, "GET", "/state");
}

function getTabEnvStatus(state, tabId) {
  return state?.snapshot?.states?.[tabId]?.envStatus ?? null;
}

/**
 * Poll `GET /state` until envStatus.telemetry.written has held the same
 * value for `stableRounds` consecutive polls. The boot session_start write
 * lands async (fire-and-forget host-log append), so a single snapshot taken
 * right after tab-ready can race it — a bare growth-assert later would then
 * pass for the wrong reason (the deferred boot write, not the prompt turn).
 */
async function waitForWrittenQuiescence(ctx, step, timeoutMs = 15_000, pollMs = 300, stableRounds = 3) {
  const deadline = Date.now() + timeoutMs;
  let lastWritten = null;
  let stableCount = 0;
  for (;;) {
    const state = await getFullState(ctx, step);
    const envStatus = getTabEnvStatus(state, ctx.tabId);
    const written = envStatus?.telemetry?.written;
    assert(
      step,
      typeof written === "number",
      `expected envStatus.telemetry.written to be a number while waiting for quiescence, got ${JSON.stringify(envStatus?.telemetry)}`,
    );
    if (written === lastWritten) {
      stableCount += 1;
      if (stableCount >= stableRounds) {
        return written;
      }
    } else {
      stableCount = 1;
      lastWritten = written;
    }
    if (Date.now() >= deadline) {
      fail(
        step,
        `envStatus.telemetry.written never stabilized within ${timeoutMs}ms (last value=${written}) — a boot write may still be in flight`,
      );
    }
    await sleep(pollMs);
  }
}

// ── step 1: bootstrap a temp workspace (telemetry+repoMap opted in) + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-envstatus-smoke-ws-"));
    // A pair of real source files so repo-map has something to count/render.
    writeFileSync(
      join(ctx.tmpWorkspace, "main.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    writeFileSync(
      join(ctx.tmpWorkspace, "util.ts"),
      "export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n",
    );
    mkdirSync(join(ctx.tmpWorkspace, ".anycode"), { recursive: true });
    writeFileSync(
      join(ctx.tmpWorkspace, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { enabled: true }, repoMap: { enabled: true } }, null, 2) + "\n",
    );
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
  const profile = mkdtempSync(join(tmpdir(), "anycode-envstatus-smoke-profile-"));
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
  await apiOk(ctx, 2, "POST", `/tabs/${ctx.tabId}/select`, {});
  pass(2, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── step 3: first envStatus snapshot — telemetry.filePath ends in .jsonl, repoMap.fileCount > 0 ──

async function step3FirstSnapshot(ctx) {
  const state = await getFullState(ctx, 3);
  const envStatus = getTabEnvStatus(state, ctx.tabId);
  assert(3, envStatus !== null, `expected non-null envStatus for tab ${ctx.tabId}, got ${JSON.stringify(envStatus)}`);

  assert(
    3,
    envStatus.telemetry !== null && typeof envStatus.telemetry === "object",
    `expected non-null envStatus.telemetry (telemetry opted in via .anycode/config.json), got ${JSON.stringify(envStatus.telemetry)}`,
  );
  assert(
    3,
    typeof envStatus.telemetry.filePath === "string" && envStatus.telemetry.filePath.endsWith(".jsonl"),
    `expected envStatus.telemetry.filePath to end with ".jsonl", got ${JSON.stringify(envStatus.telemetry.filePath)}`,
  );

  assert(
    3,
    envStatus.repoMap !== null && typeof envStatus.repoMap === "object",
    `expected non-null envStatus.repoMap (repo-map opted in via .anycode/config.json), got ${JSON.stringify(envStatus.repoMap)}`,
  );
  assert(
    3,
    typeof envStatus.repoMap.fileCount === "number" && envStatus.repoMap.fileCount > 0,
    `expected envStatus.repoMap.fileCount > 0 (main.ts + util.ts seeded), got ${JSON.stringify(envStatus.repoMap.fileCount)}`,
  );

  // Take the growth baseline only once `written` has quiesced — a snapshot
  // taken immediately after tab-ready can still be mid-flight on the async
  // boot session_start write, which would otherwise get misread as baseline
  // noise or (worse) counted as the step-4 turn's growth.
  ctx.firstWritten = await waitForWrittenQuiescence(ctx, 3);

  pass(
    3,
    `initial envStatus: telemetry.filePath=${envStatus.telemetry.filePath}, telemetry.written=${ctx.firstWritten} (stable), repoMap.fileCount=${envStatus.repoMap.fileCount}`,
  );
}

// ── step 4: one short prompt-turn, wait for it to settle ──

async function step4PromptTurn(ctx) {
  const sent = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/prompt`, { text: PROMPT_TEXT });
  assert(4, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);

  await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "running" }, 60_000);
  await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "idle" }, 120_000);

  pass(4, `prompt turn sent (requestId=${sent.requestId}) and settled to idle`);
}

// ── step 5: second envStatus snapshot — telemetry.written grew (teardown-push live) ──

async function step5SecondSnapshot(ctx) {
  const state = await getFullState(ctx, 5);
  const envStatus = getTabEnvStatus(state, ctx.tabId);
  assert(5, envStatus !== null, `expected non-null envStatus for tab ${ctx.tabId} after the prompt turn, got ${JSON.stringify(envStatus)}`);
  assert(
    5,
    envStatus.telemetry !== null && typeof envStatus.telemetry.written === "number",
    `expected envStatus.telemetry.written to be a number after the prompt turn, got ${JSON.stringify(envStatus.telemetry)}`,
  );

  const secondWritten = envStatus.telemetry.written;
  assert(
    5,
    secondWritten > ctx.firstWritten,
    // ctx.firstWritten is the step-3 quiesced baseline (waitForWrittenQuiescence),
    // so this growth is attributable to the step-4 turn, not a deferred boot write.
    `expected envStatus.telemetry.written to grow from the stable baseline after the prompt turn (teardown-push), was ${ctx.firstWritten} -> ${secondWritten}`,
  );

  pass(5, `envStatus.telemetry.written grew after the prompt turn: ${ctx.firstWritten} -> ${secondWritten}`);
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
    if (ctx.child) {
      try {
        await api(ctx, "POST", "/quit", {});
      } catch {
        // best-effort — the app may already be gone.
      }
    } else if (ctx.tabId) {
      try {
        const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
        if (closeResp.body?.ok !== true) {
          tabCloseFailed = true;
          console.warn(
            `[env-status-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              `a tab is still open on the temp workspace; leaving it on disk instead of deleting out from under it`,
          );
        }
      } catch (err) {
        // --attach mode: this is a foreign, still-running instance — a failed
        // request (network error, timeout) does NOT mean the tab closed, so
        // treat it the same as an explicit close-rejection instead of
        // silently falling through to a workspace delete under an open tab.
        tabCloseFailed = true;
        console.warn(
          `[env-status-smoke] tab close request failed (${err?.message ?? err}) — ` +
            `a tab may still be open on the temp workspace; leaving it on disk instead of deleting out from under it`,
        );
      }
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[env-status-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[env-status-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[env-status-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(
        `[env-status-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`,
      );
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[env-status-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[env-status-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[env-status-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[env-status-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[env-status-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[env-status-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    firstWritten: null,
    teardownPromise: null,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3FirstSnapshot(ctx);
    await step4PromptTurn(ctx);
    await step5SecondSnapshot(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[env-status-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[env-status-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

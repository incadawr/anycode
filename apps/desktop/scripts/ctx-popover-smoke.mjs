/**
 * Live GUI smoke for P7.17/F12 W4 (design/slice-P7.17-cut.md F12 §6): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Ctx-popover probe/driver"
 * section) and exercises the frozen 4-step scenario — a real turn producing a
 * `context_usage` reading, opening the ctx-meter hover popover for real (a
 * genuine DOM click on `.composer-ctx-meter`, not a store poke), asserting its
 * rendered headline/rows/session-tokens shape, then closing it again.
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted verbatim from
 * `model-pill-smoke.mjs` (same P7.H per-run disposable profile discipline;
 * same `waitForFacade`/`discoverTabByWorkspace`/`saveScreenshot` helpers). A
 * SINGLE short prompt (not the multi-turn Read-chain `model-pill-smoke.mjs`
 * uses) is enough here — this scenario only needs a turn to COMPLETE (so
 * `context_usage`/`sessionTokens` land), never to observe a mid-turn guard.
 * Plain node >=22, ZERO npm deps — a NEW sibling, not an edit of any of them.
 *
 * Usage:   node apps/desktop/scripts/ctx-popover-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach   Do not spawn a dev instance — read the live discovery file
 *              (~/.anycode/automation.json) of one already running. Teardown
 *              then only closes the tab this script created; it does NOT quit
 *              an app it did not launch.
 *   --keep     Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n> Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev process
 *              (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider — read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL), same file `model-pill-smoke.mjs` uses.
 *
 * Each of the 4 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/ctx-popover-smoke/step-*.png` (settled >=400ms before

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
const SMOKE_SECRETS_PATH = join(repoRoot, ".smoke-secrets", "glm.env");
const TOTAL_STEPS = 4;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2"; // reasoning-capable — a real turn on it produces both context_usage and a finish->sessionTokens accumulation.

const TURN_PROMPT = "Reply with exactly the word: done. Do not say anything else.";

/** Row percent tolerance for the "sums to ~100%" assertion (design F12 §2.3 — rows are the on-demand breakdown's own category shares, computed renderer-side, so a small floating-point slop is expected, not a bug). */
const ROW_SUM_TOLERANCE = 1;

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
      console.warn(`[ctx-popover-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from model-pill-smoke.mjs) ──

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

/**
 * Minimal KEY=VALUE .env parser (no quoting/escaping support — the smoke
 * credential file is a flat, hand-written 3-line file). Blank lines and `#`
 * comments are skipped.
 */
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
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

/** Poll `GET /state` until the renderer facade has finished installing (DEV dynamic import races the page load). */
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
      console.warn(`[ctx-popover-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    ctx.mkdirScreenshotDir();
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[ctx-popover-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/* */
async function settledScreenshot(ctx, name) {
  await sleep(400);
  return saveScreenshot(ctx, name);
}

// ── ctx-popover facade helpers (automation/README.md "Ctx-popover probe/driver") ──

async function ctxState(ctx, step, tabId) {
  const resp = await api(ctx, "GET", `/tabs/${encodeURIComponent(tabId)}/ctx-popover`);
  if (resp.status !== 200) {
    fail(step, `GET /tabs/${tabId}/ctx-popover -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `ctx-popover state not ok: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function ctxOpen(ctx, step, tabId, open) {
  const resp = await api(ctx, "POST", `/tabs/${encodeURIComponent(tabId)}/ctx-popover/open`, { open });
  if (resp.status !== 200) {
    fail(step, `POST /tabs/${tabId}/ctx-popover/open ${JSON.stringify({ open })} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `ctx-popover open(${open}) rejected: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

// ── step 1: bootstrap a temp profile/workspace + launch (or attach to) the dev app, discover the boot tab ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-ctx-popover-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from ctx-popover smoke\n");
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  let secretsEnv = {};
  try {
    secretsEnv = parseEnvFile(readFileSync(SMOKE_SECRETS_PATH, "utf8"));
  } catch (err) {
    fail(1, `could not read GLM smoke credentials at ${SMOKE_SECRETS_PATH}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_API_KEY`);
  assert(1, typeof secretsEnv.ANYCODE_BASE_URL === "string" && secretsEnv.ANYCODE_BASE_URL.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_BASE_URL`);

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

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4), same
  // discipline as model-pill-smoke.mjs: isolates userData/db/discovery/
  // settings.json/secrets.json so this run never collides with a parallel
  // smoke, a manual dev session, or the owner's real settings.
  const profile = mkdtempSync(join(tmpdir(), "anycode-ctx-popover-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  const seedSettings = {
    version: 1,
    provider: { id: PROVIDER_ID, model: MODEL_A },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
  writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

  const t0 = Date.now();
  const env = {
    ...process.env,
    ...secretsEnv,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
  };
  // Same anti-false-green discipline as model-pill-smoke.mjs: an env-level
  // model override would mask the settings.json-seeded provider/model this
  // scenario boots with.
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;
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

async function step1DiscoverTab(ctx) {
  await waitForFacade(ctx, 1);

  if (ctx.child === null) {
    const created = await apiOk(ctx, 1, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    if (created?.ok !== true) {
      fail(1, `tab creation failed: ${JSON.stringify(created)}`);
    }
    ctx.tabId = created.tabId;
  } else {
    ctx.tabId = await discoverTabByWorkspace(ctx, 1, ctx.tmpWorkspace);
  }
  await waitUntilTab(ctx, 1, ctx.tabId, { connection: "ready" });

  const closed = await ctxState(ctx, 1, ctx.tabId);
  assert(1, closed.open === false, `expected the popover closed pre-turn: ${JSON.stringify(closed)}`);

  pass(1, `tab ${ctx.tabId} ready`);
}

// ── step 2: a real turn to completion — proves context_usage/sessionTokens actually land ──

async function step2RealTurn(ctx) {
  const sent = await apiOk(ctx, 2, "POST", `/tabs/${ctx.tabId}/prompt`, { text: TURN_PROMPT });
  assert(2, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, 2, ctx.tabId, { turnStatus: "running" }, 60_000);
  await waitUntilTab(ctx, 2, ctx.tabId, { turnStatus: "idle" }, 120_000);

  const live = await apiOk(ctx, 2, "GET", `/state/${ctx.tabId}`);
  const contextUsage = live?.snapshot?.states?.[ctx.tabId]?.contextUsage;
  assert(2, contextUsage != null, `expected contextUsage to be populated after a completed turn, got: ${JSON.stringify(contextUsage)}`);
  assert(2, typeof contextUsage.estimatedTokens === "number" && contextUsage.estimatedTokens > 0, `unexpected contextUsage.estimatedTokens: ${JSON.stringify(contextUsage)}`);

  pass(2, `turn completed, contextUsage=${JSON.stringify(contextUsage)}`);
}

// ── step 3: open the popover for real (a genuine DOM click), assert its rendered shape ──

async function step3OpenAndAssert(ctx) {
  await ctxOpen(ctx, 3, ctx.tabId, true);
  // The on-demand breakdown fetch is a real host round-trip (context_breakdown_request
  // -> host computes -> context_breakdown reply) — poll until the rows land
  // rather than assuming the very next read already has them.
  let state;
  for (let i = 0; i < 30; i += 1) {
    state = await ctxState(ctx, 3, ctx.tabId);
    if (state.open === true && state.rows.length > 0) {
      break;
    }
    await sleep(200);
  }
  assert(3, state.open === true, `expected open:true after ctxPopoverOpen(true): ${JSON.stringify(state)}`);
  assert(3, typeof state.headline === "string" && /^[\d.]+[KM]?\/[\d.]+[KM]?\s\(\d+%\)$/.test(state.headline), `unexpected headline shape: ${JSON.stringify(state.headline)}`);
  assert(3, state.rows.length > 0, `expected at least one breakdown row: ${JSON.stringify(state)}`);

  const messagesRow = state.rows.find((row) => row.label === "Messages");
  const systemPromptRow = state.rows.find((row) => row.label === "System prompt");
  assert(3, messagesRow !== undefined && messagesRow.percent > 0, `expected a "Messages" row with percent>0: ${JSON.stringify(state.rows)}`);
  assert(3, systemPromptRow !== undefined && systemPromptRow.percent > 0, `expected a "System prompt" row with percent>0: ${JSON.stringify(state.rows)}`);

  const rowSum = state.rows.reduce((sum, row) => sum + row.percent, 0);
  assert(3, Math.abs(rowSum - 100) <= ROW_SUM_TOLERANCE, `expected row percents to sum to ~100%, got ${rowSum}: ${JSON.stringify(state.rows)}`);

  assert(3, state.sessionTokens !== null && state.sessionTokens.total > 0, `expected sessionTokens.total>0 after a completed turn: ${JSON.stringify(state.sessionTokens)}`);

  const filePath = await settledScreenshot(ctx, "step-3-popover-open");
  assert(3, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(3, `popover open, headline="${state.headline}", ${state.rows.length} row(s) summing to ${rowSum.toFixed(1)}%, sessionTokens.total=${state.sessionTokens.total}`);
}

// ── step 4: close the popover for real, assert it reports closed ──

async function step4Close(ctx) {
  await ctxOpen(ctx, 4, ctx.tabId, false);
  const state = await ctxState(ctx, 4, ctx.tabId);
  assert(4, state.open === false, `expected open:false after ctxPopoverOpen(false): ${JSON.stringify(state)}`);
  assert(4, state.headline === null && state.rows.length === 0 && state.sessionTokens === null, `expected headline/rows/sessionTokens to reset to their closed defaults: ${JSON.stringify(state)}`);

  const filePath = await settledScreenshot(ctx, "step-4-popover-closed");
  assert(4, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(4, "popover closed, reading back to its empty defaults");
}

// ── teardown ──

/**
 * Thin memoizing wrapper around `runTeardown` (transcript-follow-smoke.mjs /
 * model-pill-smoke.mjs precedent): every caller (normal end-of-run() and the
 * SIGINT/SIGTERM handler) awaits the SAME shared promise.
 */
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
      } else if (typeof ctx.tabId === "string") {
        const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
        if (closeResp.body?.ok !== true) {
          tabCloseFailed = true;
          console.warn(
            `[ctx-popover-smoke] tab ${ctx.tabId} close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              "a tab may still be open on a temp workspace; leaving it on disk instead of deleting out from under it",
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
      console.warn(`[ctx-popover-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[ctx-popover-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.tmpWorkspace === "string" && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[ctx-popover-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(`[ctx-popover-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[ctx-popover-smoke] failed to remove temp workspace ${ctx.tmpWorkspace}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[ctx-popover-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[ctx-popover-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[ctx-popover-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[ctx-popover-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[ctx-popover-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "ctx-popover-smoke"),
  };
  ctx.mkdirScreenshotDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.screenshotDir)}, {recursive:true})`]);
    } catch {
      // fall through to saveScreenshot's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);
    await step2RealTurn(ctx);
    await step3OpenAndAssert(ctx);
    await step4Close(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[ctx-popover-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[ctx-popover-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

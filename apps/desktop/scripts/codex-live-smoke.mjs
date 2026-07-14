/**
 * Live GUI smoke for TASK.42 (design/build/design/slice-codex-fixes-cut.md
 * §5.6 B5-auto): drives a REAL Electron dev instance over the automation
 * HTTP channel (`main/automation/*`, automation/README.md) against a REAL
 * `codex` CLI binary (no fakes, no mocks) — the executable GUI smoke the
 * merged Codex engine has never had (cut: "the channel's start-screen
 * contract currently has no engine field/route ⇒ TASK.42's release gate is
 * not real yet").
 *
 * Exercises, in order: programmatic Codex engine selection on the start
 * screen (the NEW `POST /start-screen/engine` route + `engine`/
 * `availableEngines` snapshot fields this same block added), session
 * creation, sending text, an ALLOWED command approval, a DENIED one, a Stop
 * mid-turn, quit+relaunch on the SAME isolated profile, resume + a
 * transcript check, and a process-group orphan check after EVERY teardown
 * (mid-run quit AND the final quit).
 *
 * Allow/deny are verified against REAL DISK SIDE EFFECTS (a `touch <file>`
 * sentinel each), not just wire status — the project's own durable lesson
 * ("run a real artifact, not a green mock", `working-docs/build/PROGRESS.md`)
 * applies doubly hard to protocol behavior nobody has smoke-tested live yet.
 *
 * Gated behind an explicit env var (`ANYCODE_CODEX_LIVE_SMOKE=1`) so it can
 * never run in the default suite (it is not a vitest file and nothing
 * `import`s it, but the env gate is defense-in-depth against a future CI job
 * invoking it by path). Missing the flag, missing binary, or an
 * out-of-SUPPORTED_CODEX_VERSION binary all print an explicit
 * `[codex-live-smoke] SKIP: …` line and exit 0 — never a silent green pass
 * (cut §7 hazard #11).
 *
 * All lanes this smoke exercises (B1/B2/B5-eng/W6/W8/W17/W20/…) have long
 * since merged into this same branch — every assertion below runs against
 * the one, current engine. Earlier waves tagged each failure with the lane
 * it supposedly "depended on" and a canned "re-run this smoke at the join"
 * suggestion; that hardcoded prose was wrong twice (W17: an assertion
 * labeled a real production defect — the engine not emitting `tool_call` at
 * all — as someone else's unlanded work; W20: a resume readiness race got
 * the same treatment). A failure message may still name the INVARIANT being
 * checked (e.g. "W6: a shadow-logged command keeps its own place") — that is
 * a description of what was measured, not a claim about whose fault a
 * failure is. It never assigns blame to a lane or suggests a re-run; see
 * codex-fixes-HANDOFF.md's "Уроки этого трека" for the incidents this
 * removal is paying down.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * git-ui-smoke.mjs, sidebar-ui-smoke.mjs) — this file is a NEW sibling, not
 * an edit of any of them (lock L9).
 *
 * Usage:
 *   ANYCODE_CODEX_LIVE_SMOKE=1 node apps/desktop/scripts/codex-live-smoke.mjs [--keep] [--port <n>]
 *
 *   ANYCODE_CODEX_LIVE_SMOKE=1   Required — the explicit opt-in. Absent -> SKIP, exit 0.
 *   ANYCODE_CODEX_BIN            Optional absolute path to the codex binary
 *                                 (else `which codex` / `where codex` on PATH).
 *   --keep                       Do not delete the temp workspaces/profile on exit (debugging).
 *   --port <n>                   Forwarded as ANYCODE_AUTOMATION_PORT to BOTH launches.
 *
 * Each of the 10 frozen steps prints `[step N] PASS/FAIL <detail>`; the
 * first FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/codex-live-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const TOTAL_STEPS = 10;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
// Real model turns are minutes-scale, not seconds — generous but bounded.
const TURN_WAIT_TIMEOUT_MS = 180_000;
const PERMISSION_WAIT_TIMEOUT_MS = 120_000;
// Orphan-check settle window (cut §2(l)/§7 hazard: an instantaneous check
// catches a vendored grandchild mid-reap and flakes; poll to zero instead).
const ORPHAN_SETTLE_MS = 5_000;
const ORPHAN_POLL_MS = 250;

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
      console.warn(`[codex-live-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

function skip(message) {
  console.log(`[codex-live-smoke] SKIP: ${message}`);
  process.exit(0);
}

// ── preflight: env gate + real-binary resolution + version check ──
// (mirrors host/engines/codex/protocol.ts's parseCodexVersion/
// isSupportedCodexVersion/SUPPORTED_CODEX_VERSION exactly, duplicated here
// deliberately — this .mjs is dependency-free and does not import
// src/**/*.ts, same posture as codex-contract-extract.mjs.)

const SUPPORTED_CODEX_VERSION = ">=0.144.0 <0.145.0";

function parseCodexVersion(output) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\s*$/.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isSupportedCodexVersion(version) {
  return version.major === 0 && version.minor === 144;
}

function resolveCodexBin() {
  const explicit = process.env.ANYCODE_CODEX_BIN;
  if (explicit && explicit.trim() !== "") {
    return explicit.trim();
  }
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(finder, ["codex"], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

function preflight() {
  if (process.env.ANYCODE_CODEX_LIVE_SMOKE !== "1") {
    skip('ANYCODE_CODEX_LIVE_SMOKE is not "1" — this smoke never runs unless explicitly opted into.');
  }
  const bin = resolveCodexBin();
  if (!bin) {
    skip("no codex binary found (set ANYCODE_CODEX_BIN, or put `codex` on PATH).");
  }
  let rawVersion;
  try {
    rawVersion = execFileSync(bin, ["--version"], { timeout: 10_000, stdio: "pipe" }).toString("utf8").trim();
  } catch (err) {
    skip(`\`${bin} --version\` failed: ${err?.message ?? err}`);
  }
  const version = parseCodexVersion(rawVersion);
  if (version === null) {
    skip(`unrecognized \`${bin} --version\` output: ${JSON.stringify(rawVersion)}`);
  }
  if (!isSupportedCodexVersion(version)) {
    skip(`${rawVersion} is outside SUPPORTED_CODEX_VERSION (${SUPPORTED_CODEX_VERSION}) — this smoke targets the pinned protocol contract only.`);
  }
  console.log(`[codex-live-smoke] preflight OK: bin=${bin}, version=${rawVersion}`);
  return { bin, rawVersion };
}

// ── small process/fs helpers (lifted from sidebar-ui-smoke.mjs / git-ui-smoke.mjs) ──

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
 * Every PID currently in POSIX process group `pgid` (`pgrep -g`, portable
 * across macOS/Linux). `pgrep` exits 1 (not an error) when nothing matches —
 * that IS the "zero" answer. Returns `null` (not `[]`) on win32 or if
 * `pgrep` itself is unavailable — the orphan check below treats `null` as
 * "not checkable here" and WARNS rather than silently claiming success.
 */
function processGroupMembers(pgid) {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const out = execFileSync("pgrep", ["-g", String(pgid)], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch (err) {
    if (err && typeof err.status === "number" && err.status === 1) {
      return [];
    }
    return null;
  }
}

/**
 * Orphan check with a settle window (cut §2(l): "мгновенный pgrep ловит
 * внучатый процесс в момент reap'а"). We spawn the app tree with
 * `detached:true` (Node docs: the child becomes the leader of a NEW process
 * group whose pgid equals its own pid), so EVERY descendant — Electron
 * helpers, the host utility process, and codex-cli plus any vendored
 * grandchild it spawns — inherits that same group unless something along
 * the chain explicitly calls setsid/setpgid. This is the same "whole tree,
 * one signal" assumption `killTree` above already leans on (battle-tested
 * across every existing smoke script here), reused for detection instead of
 * termination.
 */
async function assertZeroOrphans(step, label, pgid) {
  if (pgid === null || pgid === undefined) {
    console.warn(`[codex-live-smoke] step ${step}: no pgid to check (${label}) — orphan check skipped for this checkpoint`);
    return;
  }
  const deadline = Date.now() + ORPHAN_SETTLE_MS;
  let pids = processGroupMembers(pgid);
  while (pids !== null && pids.length > 0 && Date.now() < deadline) {
    await sleep(ORPHAN_POLL_MS);
    pids = processGroupMembers(pgid);
  }
  if (pids === null) {
    console.warn(`[codex-live-smoke] step ${step}: orphan check unavailable on this platform (${label}) — not fail-closed here, see README`);
    return;
  }
  assert(step, pids.length === 0, `${label}: ${pids.length} orphan process(es) still alive in group ${pgid} after a ${ORPHAN_SETTLE_MS}ms settle window: pids=[${pids.join(",")}]`);
  pass(step, `${label}: 0 orphan processes (group ${pgid}, settled)`);
}

// ── step bookkeeping ──

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

// Counts DISTINCT steps, not pass() calls: step 8 reports twice (its own
// checkpoint plus the shared assertZeroOrphans helper, which also runs as
// step 10), which used to inflate the tally to "11/10 steps passed". A smoke
// that miscounts its own steps is a smoke nobody can read a verdict off.
const passedSteps = new Set();

function pass(step, detail) {
  passedSteps.add(step);
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

async function getFullState(ctx, step) {
  return apiOk(ctx, step, "GET", "/state");
}

async function getTabState(ctx, step, tabId) {
  const full = await apiOk(ctx, step, "GET", `/state/${encodeURIComponent(tabId)}`);
  return full?.snapshot?.states?.[tabId];
}

// `main`'s codex-engine readiness (`codexReady` in main/index.ts, gating
// `manager.canSpawn("codex")` -> tab-ipc.ts's `not_ready` refusal) is set by a
// FIRE-AND-FORGET async "codex doctor" probe kicked off at boot
// (`codexOnboarding.recheck()`, main/index.ts, never awaited before the
// window appears) — a real `codex app-server` child spawn + version
// preflight + `initialize` + `account/read` + paginated `model/list`, bounded
// by `CODEX_DOCTOR_WATCHDOG_MS` (20_000ms, shared/codex-timeouts.ts). A
// launch that submits the codex draft before that probe resolves gets refused
// with `not_ready`, rendered as this exact prose by
// `SessionPicker.tsx`'s `describeCreateTabFailure`.
//
// The SAME probe re-runs from scratch after every relaunch (main/index.ts
// re-kicks it at boot, `codexReady` resets to false until it resolves again),
// so step 9's post-relaunch resume (`POST /tabs {kind:"resume"}` ->
// tab-ipc.ts's `handleCreate`) goes through the identical
// `manager.canSpawn("codex")` check and can race it exactly like step 4's
// create does (W20) — same cause, same fix, two call sites below.
//
// The automation snapshot has no read-only signal for this: `GET
// /start-screen`'s `availableEngines` (automation.ts's `startScreenState`) is
// deliberately the STATIC compiled-in engine catalog (`[...ENGINE_IDS]`),
// not draft-scoped and not readiness-gated (codex-fixes TASK.42 cut §3.7) —
// it says "this build knows how to speak Codex", never "Codex is ready right
// now". `GET /settings` and `GET /state` carry no codex-onboarding field
// either. Lacking a proper readiness read, both call sites below poll the one
// thing that DOES reflect the real main-process gate: the create/resume
// endpoint itself, which resolves through the SAME `manager.canSpawn("codex")`
// check either way. A `not_ready` refusal leaves its target (draft or
// session) untouched by design (start-session.ts's own doc comment, §3-D8;
// tab-ipc.ts's `handleCreate` resume branch checks readiness before doing
// anything else), so retrying it is side-effect-free. Any OTHER failure is
// treated as a real, non-transient failure and reported immediately — only
// the exact known not-ready shape is retried.
const CODEX_DOCTOR_WATCHDOG_MS = 20_000; // mirrors apps/desktop/src/shared/codex-timeouts.ts
const CODEX_READY_POLL_TIMEOUT_MS = CODEX_DOCTOR_WATCHDOG_MS + 10_000;
const CODEX_READY_POLL_INTERVAL_MS = 500;
const CODEX_NOT_READY_MESSAGE = "Configure a provider (API key + model) before opening a tab.";

/**
 * Polls `send()` until its response no longer matches `isRetryable`, or until
 * `deadlineMs` from now elapses — whichever comes first. Shared by both
 * codex-doctor-race call sites (step 4's create, step 9's post-relaunch
 * resume): each supplies its own narrow `isRetryable` so a real, non-transient
 * rejection still fails on the very first attempt instead of being retried
 * away.
 */
async function pollUntilNotRetryable(deadlineMs, intervalMs, send, isRetryable) {
  const deadline = Date.now() + deadlineMs;
  let attempts = 0;
  let response;
  for (;;) {
    attempts += 1;
    response = await send();
    if (!isRetryable(response) || Date.now() >= deadline) {
      return { response, attempts };
    }
    await sleep(intervalMs);
  }
}

async function submitCodexDraftWhenReady(ctx, step) {
  const { response: submitted, attempts } = await pollUntilNotRetryable(
    CODEX_READY_POLL_TIMEOUT_MS,
    CODEX_READY_POLL_INTERVAL_MS,
    () => apiOk(ctx, step, "POST", "/start-screen/submit", {}),
    (r) => r?.message === CODEX_NOT_READY_MESSAGE,
  );
  assert(
    step,
    submitted?.ok === true,
    `/start-screen/submit rejected for the codex draft after ${attempts} attempt(s) polling up to ${CODEX_READY_POLL_TIMEOUT_MS}ms for main's async codex-doctor readiness gate (main/index.ts codexReady, main/codex-doctor.ts): ${JSON.stringify(submitted)}`,
  );
  return submitted;
}

/**
 * Same codex-doctor race as `submitCodexDraftWhenReady` above, hitting after
 * step 8's relaunch restarts the probe from scratch: polls the resume
 * endpoint itself and retries ONLY the exact `{ok:false, reason:"not_ready"}`
 * shape tab-ipc.ts's `handleCreate` returns from the same
 * `manager.canSpawn("codex")` check. Any other rejection — `session_not_found`,
 * `already_open`, or any other shape — is a real failure and is reported on
 * the first attempt, not masked by a retry.
 */
async function resumeCodexSessionWhenReady(ctx, step, sessionId) {
  const { response: resumed, attempts } = await pollUntilNotRetryable(
    CODEX_READY_POLL_TIMEOUT_MS,
    CODEX_READY_POLL_INTERVAL_MS,
    () => apiOk(ctx, step, "POST", "/tabs", { kind: "resume", sessionId }),
    (r) => r?.ok === false && r?.reason === "not_ready",
  );
  assert(
    step,
    resumed?.ok === true,
    `resume of session ${sessionId} rejected after ${attempts} attempt(s) polling up to ${CODEX_READY_POLL_TIMEOUT_MS}ms for main's async codex-doctor readiness gate (main/index.ts codexReady, main/codex-doctor.ts) — server said: ${JSON.stringify(resumed)}`,
  );
  return resumed;
}

async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[codex-live-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[codex-live-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

// ── launch / relaunch (shared by step2 and step8) ──

/**
 * Spawns the dev app against a FIXED profile (same userData/db/automation-info
 * paths across launches, so a relaunch can resume a session persisted by the
 * previous launch) and waits for a FRESH discovery file (`startedAt >
 * markerTime`, guarding against reading a stale file from the launch we just
 * quit). Returns the new port/token/pid/child.
 */
async function launchApp(ctx, step, markerTime) {
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_CODEX_BIN: ctx.codexBin,
    // Deterministic boot tab (core, throwaway dir) — see step2's comment for
    // why we pin this rather than leaving it unset or aiming it at a real
    // home directory. The codex session under test is created explicitly via
    // the start-screen automation surface in step4, not this boot tab.
    ANYCODE_WORKSPACE: ctx.bootWs,
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

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(step, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > markerTime && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(step, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${markerTime})`);
  }
  return { child, port: info.port, token: info.token, appPid: info.pid };
}

// ── step 1: bootstrap isolated workspaces (no git needed — codex doesn't require one) ──

function step1BootstrapWorkspaces(ctx) {
  try {
    ctx.bootWs = mkdtempSync(join(tmpdir(), "anycode-codex-smoke-boot-"));
    ctx.codexWs = mkdtempSync(join(tmpdir(), "anycode-codex-smoke-ws-"));
    ctx.sentinelAllow1 = join(ctx.codexWs, "smoke-allow-1.txt");
    ctx.sentinelAllow2 = join(ctx.codexWs, "smoke-allow-2.txt");
    ctx.sentinelDeny = join(ctx.codexWs, "smoke-deny.txt");
  } catch (err) {
    fail(1, `bootstrap error: ${err?.message ?? err}`);
  }
  pass(1, `isolated workspaces bootstrapped: boot=${ctx.bootWs}, codex=${ctx.codexWs}`);
}

// ── step 2: launch the dev app on a fresh, isolated profile ──

async function step2LaunchApp(ctx) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-codex-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");

  const t0 = Date.now();
  const { child, port, token, appPid } = await launchApp(ctx, 2, t0);
  ctx.child = child;
  ctx.port = port;
  ctx.token = token;
  ctx.appPid = appPid;
  // detached:true (POSIX) makes child.pid its own new process group's pgid —
  // captured now so the mid-run orphan check (step8) has something to poll
  // even after this `child` handle itself is gone/replaced by the relaunch.
  ctx.appPgid = process.platform === "win32" ? null : child.pid;

  pass(2, `app launched (pid=${appPid}), discovery ready after ${Date.now() - t0}ms on port ${port}, profile=${profile}`);
}

// ── step 3: wait for the renderer facade (ignore the throwaway core boot tab entirely) ──

async function step3WaitFacadeReady(ctx) {
  await waitForFacade(ctx, 3);
  pass(3, "renderer facade installed");
}

// ── step 4: select Codex on the start screen (the NEW automation surface), create the session, send the ALLOW-flow prompt ──

async function step4CreateCodexSession(ctx) {
  await apiAction(ctx, 4, "/start-screen/open", { workspace: ctx.codexWs });

  const beforeEngine = await apiOk(ctx, 4, "GET", "/start-screen");
  assert(4, Array.isArray(beforeEngine?.availableEngines) && beforeEngine.availableEngines.includes("codex"), `availableEngines does not include "codex": ${JSON.stringify(beforeEngine?.availableEngines)}`);
  assert(4, beforeEngine?.engine === "core", `expected the draft's default engine to be "core" before any pick, got ${JSON.stringify(beforeEngine?.engine)}`);

  await apiAction(ctx, 4, "/start-screen/engine", { engineId: "codex" });

  const afterEngine = await apiOk(ctx, 4, "GET", "/start-screen");
  assert(4, afterEngine?.engine === "codex", `engine read-back after POST /start-screen/engine is not "codex": ${JSON.stringify(afterEngine?.engine)}`);

  // W16 (fact 16: `thread/read` never returns an EMPTY agentMessage — the
  // old "Do not explain, just run it" prompt made the model emit exactly
  // that, so the discriminating agentMessage -> commandExecution ->
  // agentMessage shape was structurally unreachable through this turn, and
  // the W6 invariant (30da16b) went unexercised live). The three-part form
  // forces two non-empty assistant_text blocks around a tool_call — this
  // prompt shape is a proven live compliance precedent (W16/W17).
  //
  // W18: step 7's structural predicate (capturePreStopSnapshot) needs TWO
  // separate approved commands in this same turn, not one, to discriminate a
  // live W6 rollback without depending on whether the model happens to think
  // out loud (reasoning is empty on the wire, per this wave's diagnosis —
  // see twoCommandFormGaps's own header comment). The prompt is
  // explicit that the two `touch` invocations must stay SEPARATE tool calls
  // (never joined with `&&`/`;`/a single shell line) — reusing one process
  // step for both commands would collapse the very shape this scenario
  // exists to produce.
  const allowPrompt =
    `First write one short sentence saying you are about to run the first command. ` +
    `Then run exactly this shell command and nothing else: touch ${JSON.stringify(ctx.sentinelAllow1)}. ` +
    `After it finishes, write one short sentence between the two commands. ` +
    `Then run exactly this second shell command and nothing else: touch ${JSON.stringify(ctx.sentinelAllow2)}. ` +
    `These must be two separate commands - never combine them into a single shell invocation (no && or ; or one process substitution for both). ` +
    `After the second command finishes, write one final short sentence confirming both ran. ` +
    `All five parts are required - do not skip any sentence and do not merge the two commands.`;
  await apiAction(ctx, 4, "/start-screen/prompt", { text: allowPrompt });
  // Poll-retries on the real main-process readiness gate rather than a single
  // shot — see submitCodexDraftWhenReady's own header comment for why (the
  // async codex-doctor boot probe races this step; `not_ready` is a
  // transient hydration state, not an absent provider).
  const submitted = await submitCodexDraftWhenReady(ctx, 4);
  ctx.codexTabId = submitted.tabId;

  await waitUntilTab(ctx, 4, ctx.codexTabId, { connection: "ready" }, TURN_WAIT_TIMEOUT_MS);

  const state = await getTabState(ctx, 4, ctx.codexTabId);
  assert(4, state?.engine?.id === "codex", `tab snapshot's engine.id is not "codex" after host_ready: ${JSON.stringify(state?.engine)}`);

  await saveScreenshot(ctx, "step-4-codex-session-created");
  pass(4, `codex session created (tab ${ctx.codexTabId}), engine picker round-tripped, initial ALLOW-flow prompt queued`);
}

// ── step 5: ALLOW both queued command approvals (W18: the step-4 prompt now
// runs two separate commands in one turn), verify BOTH sentinel files landed
// on disk ──

async function step5AllowCommand(ctx) {
  await waitUntilTab(ctx, 5, ctx.codexTabId, { permissionPending: true }, PERMISSION_WAIT_TIMEOUT_MS);
  await apiAction(ctx, 5, `/tabs/${ctx.codexTabId}/permission`, { behavior: "allow" });

  // Second approval round: the turn is not done after the first accept — it
  // is still running toward the second command's approval request. Reuses
  // the same waitUntilTab({permissionPending:true}) paradigm as the
  // first round rather than inventing a new one.
  await waitUntilTab(ctx, 5, ctx.codexTabId, { permissionPending: true }, PERMISSION_WAIT_TIMEOUT_MS);
  await apiAction(ctx, 5, `/tabs/${ctx.codexTabId}/permission`, { behavior: "allow" });

  await waitUntilTab(ctx, 5, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS);

  assert(5, existsSync(ctx.sentinelAllow1), `first allowed command's sentinel file was not created: ${ctx.sentinelAllow1}`);
  assert(5, existsSync(ctx.sentinelAllow2), `second allowed command's sentinel file was not created: ${ctx.sentinelAllow2}`);
  pass(5, `both command approvals ALLOWED — sentinel files confirmed on disk: ${ctx.sentinelAllow1}, ${ctx.sentinelAllow2}`);
}

// ── step 6: send a second prompt, DENY its command approval, verify the sentinel file was NOT created ──

async function step6DenyCommand(ctx) {
  // W21: a two-part MANDATORY form, same compliance precedent as step 4's
  // ALLOW prompt (W16/W18) — the old prompt ("Do not explain, just run it")
  // let the model emit an EMPTY agentMessage after the decline, which
  // `thread/read` never returns (fact 16), making a missing trailing
  // assistant_text after a DENY indistinguishable from a genuine defect. The
  // closing sentence is now required, not merely permitted, so its absence
  // after resume is evidence of something, not scenario noise.
  const denyPrompt =
    `Run exactly this shell command and nothing else: touch ${JSON.stringify(ctx.sentinelDeny)}. ` +
    `Do not write anything before running it. ` +
    `After the command finishes, fails, or is rejected, write exactly one short sentence stating what happened. ` +
    `Both parts are required - do not skip the final sentence.`;
  await apiAction(ctx, 6, `/tabs/${ctx.codexTabId}/prompt`, { text: denyPrompt });

  await waitUntilTab(ctx, 6, ctx.codexTabId, { permissionPending: true }, PERMISSION_WAIT_TIMEOUT_MS);
  await apiAction(ctx, 6, `/tabs/${ctx.codexTabId}/permission`, { behavior: "deny" });
  // L1 (cut §1a): decline continues the turn to `completed` rather than
  // ending it — the client is reusable, no close/terminal-denial machinery.
  await waitUntilTab(ctx, 6, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS);

  assert(6, !existsSync(ctx.sentinelDeny), `denied command's sentinel file WAS created (deny did not block execution): ${ctx.sentinelDeny}`);

  // W17: the LIVE tab (not just the post-resume projection checked in step 9)
  // must actually render the denied command as a tool_call block — the
  // defect this wave fixes was event-translator.ts's onItemStarted never
  // emitting {type:"tool_call"} at all, so no card existed for
  // tool_execution_start/tool_result to patch and the denied command rendered
  // nothing on screen.
  const state = await getTabState(ctx, 6, ctx.codexTabId);
  const transcript = Array.isArray(state?.transcript) ? state.transcript : [];
  const deniedBlock = transcript.find(
    (b) => b?.kind === "tool_call" && typeof b?.input?.command === "string" && b.input.command.includes(ctx.sentinelDeny),
  );
  assert(
    6,
    deniedBlock !== undefined,
    `live transcript has no tool_call block for the denied command (sentinel ${ctx.sentinelDeny}); transcript kinds: [${transcript.map((b) => b?.kind ?? "?").join(", ")}]`,
  );
  assert(
    6,
    deniedBlock?.status === "denied",
    `live tool_call block for the denied command has status ${JSON.stringify(deniedBlock?.status)}, expected "denied"`,
  );

  pass(6, `command approval DENIED — sentinel file confirmed ABSENT: ${ctx.sentinelDeny}; live transcript shows a tool_call block with status=denied`);
}

// ── pre-Stop capture (W16, facts 13+16): snapshot the ALLOW+DENY transcript
// AFTER step 6 reaches idle but BEFORE step 7 interrupts a new turn — this
// is the last point where the transcript is known-quiescent and provably
// contains the discriminating shape, so step 9 has a known-good normalized
// order to compare the post-resume transcript against. ──

async function capturePreStopSnapshot(ctx, step) {
  const state = await getTabState(ctx, step, ctx.codexTabId);
  const transcript = Array.isArray(state?.transcript) ? state.transcript : [];
  const kindOrder = normalizedKindOrder(transcript);

  // The scenario must itself elicit assistant_text -> tool_call ->
  // assistant_text before any W6/W8 regression can be told apart from a
  // merely-empty transcript (fact 16). W17: a red run here once got
  // mislabeled in this comment/message as "a harness gap, not a production
  // defect" — it was in fact a real production defect (event-translator.ts's
  // onItemStarted never emitted {type:"tool_call"} live). This assertion
  // stays a plain, non-exculpatory description of what is missing.
  assert(
    step,
    hasAdjacentAssistantToolAssistant(kindOrder),
    `scenario did not produce the discriminating form (assistant_text -> tool_call -> assistant_text) in the ALLOW turn; normalized kind order: [${kindOrder.join(", ")}]`,
  );
  // W18: the reasoning-count discriminator this replaces was diagnosed WRONG
  // by the architect — reasoning is empty on the wire for this model/version
  // (`summary:[]`, `content:[]` on both item/started and item/completed; the
  // rollout logs carry only `encrypted_content`, zero `item/reasoning/*`
  // deltas), so ">=1 reasoning block" could never pass live regardless of
  // engine health, and normalizedKindOrder already strips "reasoning" out of
  // the very order this predicate inspects — it could not have discriminated
  // a W6 rollback even when non-vacuous. The structural replacement (W18)
  // makes the step-4 prompt run TWO separate approved commands with
  // narrative text before/between/after them.
  //
  // W21 (2 MEDIUM findings, external codex-review, both REAL): this
  // assertion is a PRECONDITION for step 9's equality check below, not
  // itself a W6 discriminator, and the comment used to claim otherwise. It
  // runs on the LIVE, pre-resume transcript, which never goes through the
  // shadow-log anchor/merge machinery at all — codex-engine.ts:933's
  // `nativeVisibleCompleted` anchor only feeds `recordShadowItem`, a write
  // consumed exclusively by history-projection's resume-time merge; a live
  // turn's blocks come straight from the translator's own events. A live W6
  // rollback cannot sink the second command "here" — there is no merge for
  // it to be sunk by, this early. What this assertion actually buys is
  // upstream of that: without a trailing assistant_text after the second
  // command, a healthy anchor and a rolled-back one both land the second
  // command at or past the resumed turn's shrunken native.length, so the
  // two post-resume kind orders would coincide — step 9's equality check
  // (see twoCommandFormGaps's own header, and the comment above
  // commandKeepsItsPlace in step 9) would be BLIND to the very rollback it
  // exists to catch.
  const allowSegment = firstTurnSegment(kindOrder);
  const formGaps = twoCommandFormGaps(allowSegment);
  assert(
    step,
    formGaps.length === 0,
    `ALLOW turn did not produce the two-command discriminating form (assistant_text, tool_call, assistant_text, tool_call, assistant_text) — missing: ${formGaps.join("; ")}; normalized ALLOW-turn kind order: [${allowSegment.join(", ")}]`,
  );

  // W21: the DENY turn's prompt (step 6) now REQUIRES a closing sentence
  // after the command finishes/fails/is rejected, and this snapshot is taken
  // AFTER step 6 reaches idle, so kindOrder already spans both turns. The
  // scenario only complied with its own prompt if the whole pre-Stop order
  // ends on assistant_text — this names only what was observed, not why: a
  // RED here does not guess whether the model skipped the sentence or
  // something downstream dropped it (that class of pre-written guess is
  // exactly what cost this track W17/W20, see this file's header comment).
  assert(
    step,
    kindOrder[kindOrder.length - 1] === "assistant_text",
    `scenario did not produce the required closing form: pre-Stop normalized kind order does not end on assistant_text; normalized kind order: [${kindOrder.join(", ")}]`,
  );

  ctx.preStopKindOrder = kindOrder;
  await saveScreenshot(ctx, "step-7-pre-stop-transcript");
  return kindOrder;
}

// ── step 7: send a slow prompt, Stop it mid-turn, verify the turn returns to idle promptly ──

async function step7StopTurn(ctx) {
  const preStopKindOrder = await capturePreStopSnapshot(ctx, 7);

  const slowPrompt =
    "Count out loud from one to fifty. For EVERY single number, write a full separate paragraph of at least three sentences describing something interesting about that number before moving to the next one. Do not use any tools.";
  await apiAction(ctx, 7, `/tabs/${ctx.codexTabId}/prompt`, { text: slowPrompt });

  await waitUntilTab(ctx, 7, ctx.codexTabId, { turnStatus: "running" }, TURN_WAIT_TIMEOUT_MS);
  await apiAction(ctx, 7, `/tabs/${ctx.codexTabId}/stop`, {});
  await waitUntilTab(ctx, 7, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS);

  pass(7, `Stop mid-turn returned the session to idle without a tab restart (pre-Stop discriminating shape confirmed: [${preStopKindOrder.join(", ")}])`);
}

// ── step 8: quit, orphan-check #1, relaunch on the SAME profile ──

async function step8QuitRelaunch(ctx) {
  const sessionId = (await getFullState(ctx, 8))?.snapshot?.tabs?.find((t) => t.tabId === ctx.codexTabId)?.sessionId;
  assert(8, typeof sessionId === "string" && sessionId.length > 0, "could not read the codex tab's sessionId before quitting (needed to resume)");
  ctx.codexSessionId = sessionId;

  await api(ctx, "POST", "/quit", {});
  const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
  if (!exited) {
    console.warn(`[codex-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
    killTree(ctx.child.pid, "SIGTERM");
    await sleep(SIGTERM_GRACE_MS);
    if (isPidAlive(ctx.child.pid)) {
      console.warn(`[codex-live-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
      killTree(ctx.child.pid, "SIGKILL");
    }
  }

  // Teardown case #1 (TASK.42 DoD: "0 orphan processes after each teardown case").
  await assertZeroOrphans(8, "quit before relaunch", ctx.appPgid);

  const t1 = Date.now();
  const { child, port, token, appPid } = await launchApp(ctx, 8, t1);
  ctx.child = child;
  ctx.port = port;
  ctx.token = token;
  ctx.appPid = appPid;
  ctx.appPgid = process.platform === "win32" ? null : child.pid;

  await waitForFacade(ctx, 8);
  pass(8, `app quit cleanly (0 orphans) and relaunched on the SAME profile (pid=${appPid}, port=${port})`);
}

// ── pure transcript-order predicates (W13: close a "green-by-construction" gap) ──
//
// Step 9's original two assertions (still below, unchanged) only checked
// "some content exists" and "some tool block exists" — both stay green even
// if W6 (30da16b: a shadow-logged command keeps ITS OWN place relative to
// agent messages) or W8 (895b380: a re-delivered command must not evict the
// turn's own last message) regressed, because neither predicate looks at
// POSITION. These three close that gap by checking ORDER.
//
// Block shape comes from GET /state/:tabId's `transcript`
// (renderer/src/store.ts `TranscriptBlock`, confirmed at
// apps/desktop/src/renderer/src/store.ts:214-236): real `kind` values are
// "user_text" / "assistant_text" / "reasoning" / "tool_call" / "error" /
// "usage_limit" / "output_truncated" / "loop_end" — there is NO separate
// "tool_result" kind. A tool call AND its outcome are the SAME "tool_call"
// block (the outcome lives in its `status` field, store.ts:224). The
// existing `hasToolOutcome` check below ORs in a "tool_result" the store
// never emits — a harmless dead disjunct, left alone (out of this wave's
// one-file scope).
//
// Each predicate is a pure function of a plain TranscriptBlock[] (only
// `.kind` is read), so it can be exercised on synthetic arrays without a
// live run.

function lastIndexOfKind(blocks, kind) {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === kind) return i;
  }
  return -1;
}

function firstIndexOfKind(blocks, kind) {
  return blocks.findIndex((b) => b?.kind === kind);
}

/**
 * W8 invariant: the turn's own last message must survive a re-delivery, not
 * get evicted/truncated by a stale shadow-logged command. True iff an
 * "assistant_text" block exists strictly AFTER the last "tool_call" block —
 * i.e. the transcript is not left ending on a command. Vacuously true when
 * there is no tool_call at all (nothing for a message to be cut off after).
 */
function turnHasAssistantTail(blocks) {
  const lastTool = lastIndexOfKind(blocks, "tool_call");
  if (lastTool === -1) return true;
  return lastIndexOfKind(blocks, "assistant_text") > lastTool;
}

/**
 * Coarse displacement sanity: a shadow-logged command is not stranded outside
 * the conversation entirely. True iff the FIRST "tool_call" sits strictly
 * before the LAST "assistant_text", AND the FIRST "user_text" precedes the
 * FIRST "tool_call" (the prompt that triggered it still comes first).
 *
 * NOT a W6 anchor guard, despite what this predicate used to claim: rolling
 * back codex-engine.ts:933 sinks only the SECOND command (C2) of the ALLOW
 * turn, and this looks solely at the FIRST tool_call, which the anchor never
 * moves. Every RED here is also a RED in the step-9 kindOrdersMatch equality,
 * so this is strictly subsumed by it. The single live guard of that rollback
 * is the equality; the production-side guard is the W18 unit test.
 */
function commandKeepsItsPlace(blocks) {
  const firstTool = firstIndexOfKind(blocks, "tool_call");
  const firstUser = firstIndexOfKind(blocks, "user_text");
  const lastAssistant = lastIndexOfKind(blocks, "assistant_text");
  if (firstTool === -1 || firstUser === -1 || lastAssistant === -1) return false;
  return firstTool < lastAssistant && firstUser < firstTool;
}

/**
 * The eviction bug this smoke exists to catch would leave stale
 * shadow-logged commands as the very FIRST thing a resumed transcript shows.
 * True iff the transcript is non-empty and its first block is not a
 * "tool_call".
 */
function transcriptDoesNotOpenOnTool(blocks) {
  return blocks.length > 0 && blocks[0]?.kind !== "tool_call";
}

// ── normalized kind-order helpers (W16, fact 16: `thread/read` never returns
// an empty agentMessage server-side, but a local live turn can still emit
// one transiently before the server round-trip settles). Shape comparisons
// below are noise-blind to `reasoning` (narration, not part of the
// discriminating shape), to `loop_end` (W18 — see normalizedKindOrder's own
// comment), and to EMPTY `assistant_text` blocks — everything else,
// including block ORDER, is preserved exactly. ──

function isBlankText(block) {
  const combined = `${block?.text ?? ""}${block?.modelText ?? ""}`.trim();
  return combined.length === 0;
}

/**
 * W18: also strips `loop_end` blocks. A live completed turn appends its own
 * `loop_end` footer block (store.ts:1461-1469), one per turn — this smoke
 * runs several turns (steps 4/5/6/7) before step 9's resume, so the live
 * pre-Stop transcript step 7 snapshots carries multiple `loop_end` entries.
 * The resume-hydration path (history-projection.ts's `projectHistoryToBlocks`,
 * store.ts:830-887) builds ONLY user_text/assistant_text/tool_call blocks
 * from `thread/read` by construction — it never emits `loop_end` at all, native
 * or shadow-sourced. Left unfiltered, step 9's pre-Stop-vs-post-resume
 * kind-order comparison would red on a HEALTHY run purely from this
 * structural asymmetry, falsely indicting the W6/W8 anchor this smoke
 * actually exists to police. Filtering `loop_end` out of BOTH sides of that
 * comparison (one function, reused symmetrically) removes the false
 * mismatch without weakening what step 9 checks: the two-command
 * discriminating shape from twoCommandFormGaps is untouched by
 * this filter, since it never inspects `loop_end` either.
 */
function normalizedKindOrder(blocks) {
  return blocks
    .filter((b) => b?.kind !== "reasoning")
    .filter((b) => b?.kind !== "loop_end")
    .filter((b) => b?.kind !== "assistant_text" || !isBlankText(b))
    .map((b) => b?.kind ?? "?");
}

/**
 * W21: extracted so step 9's pre-Stop-vs-post-resume comparison and its own
 * self-check exercise the identical code — pure equality of two normalized
 * kind-order string arrays (same length, same element at every index). This
 * is the ONE live guard against a W6/W8 rollback surviving a real
 * quit/relaunch/resume: see the self-check cases below for a documented
 * rollback form this function is proven to flag as a MISMATCH.
 */
function sameKindOrder(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * The W6/W8 discriminating shape (fact 16): an assistant reply, then a
 * command, then another assistant reply, ADJACENT in the normalized order.
 * This runs on the LIVE pre-Stop order (capturePreStopSnapshot), upstream of
 * any resume/shadow-merge — it cannot see, and is not evidence about, the W6
 * anchor at codex-engine.ts:933 at all (that anchor only feeds the
 * RESUME-side merge step 9's equality check judges; a live turn's blocks
 * come straight from the translator's own events, never through it).
 *
 * W21 (external codex-review, REAL): an earlier version of this comment
 * claimed "neither a W6 rollback nor a W8 rollback can produce this exact
 * triple", implying this predicate discriminates that rollback — it does
 * not, and structurally cannot, this early in the pipeline. What it actually
 * verifies: the two-prompt scenario prior waves shipped never emitted this
 * shape at all (both prompts said "do not explain", so agentMessage was
 * empty and therefore ABSENT, fact 16) — this wave's three-part ALLOW
 * prompt (step 4) is what made the shape reachable through the GUI, a
 * precondition for the W6 invariant being exercised live at all.
 */
function hasAdjacentAssistantToolAssistant(kindOrder) {
  for (let i = 0; i + 2 < kindOrder.length; i += 1) {
    if (kindOrder[i] === "assistant_text" && kindOrder[i + 1] === "tool_call" && kindOrder[i + 2] === "assistant_text") {
      return true;
    }
  }
  return false;
}

/**
 * W19: scopes a normalizedKindOrder array down to the FIRST turn — the ALLOW
 * turn is always first (step 4), and it is the only turn twoCommandFormGaps
 * is meant to judge. capturePreStopSnapshot's kindOrder spans EVERY turn run
 * so far by the time step 7 calls it (ALLOW turn from steps 4/5, THEN the
 * DENY turn from step 6), because step 9 later needs that same full,
 * unscoped order to compare pre-Stop vs. post-resume (see
 * capturePreStopSnapshot's `ctx.preStopKindOrder` and
 * step9ResumeAndCheckTranscript's `expectedKindOrder`) — normalizedKindOrder
 * itself must stay whole-transcript for that reason and is not touched here.
 *
 * Each turn opens with its own "user_text" block (the prompt that started
 * it). The ALLOW turn is therefore the slice from the FIRST "user_text" up
 * to (excluding) the SECOND "user_text", or to the end of the array if no
 * second turn has run yet. W19's own defect: a prior version counted
 * tool_call blocks across the WHOLE array, so a healthy 2-command ALLOW turn
 * plus a healthy 1-command DENY turn read as "3 tool_call blocks found" and
 * failed for a reason that had nothing to do with the ALLOW turn's shape.
 */
function firstTurnSegment(kindOrder) {
  const firstUser = kindOrder.indexOf("user_text");
  if (firstUser === -1) return kindOrder.slice();
  const secondUser = kindOrder.indexOf("user_text", firstUser + 1);
  return secondUser === -1 ? kindOrder.slice(firstUser) : kindOrder.slice(firstUser, secondUser);
}

/**
 * W18: the two-command ALLOW turn's discriminating shape — replaces the
 * architect-retired ">=1 reasoning block" check (reasoning is empty on the
 * wire for this model/version; see capturePreStopSnapshot's comment). True
 * iff the normalized kind order contains the subsequence assistant_text,
 * tool_call, assistant_text, tool_call, assistant_text: EXACTLY two
 * "tool_call" entries, with a non-blank assistant_text before the first,
 * strictly BETWEEN the two, and strictly AFTER the second.
 *
 * W21 (external codex-review, REAL): the trailing assistant_text is
 * load-bearing, but not for the reason an earlier version of this comment
 * gave — it does not make a live W6 rollback "visible here"; this function
 * runs on the LIVE pre-Stop order, which the shadow-log anchor at
 * codex-engine.ts:933 (`nativeVisibleCompleted`) never touches (see
 * capturePreStopSnapshot's own comment). It is load-bearing on the RESUME
 * side instead: without a reply after the second command, step 9's
 * post-resume kind order would coincide with the pre-Stop one whether the
 * anchor placed the second command correctly or not, once native.length
 * shrinks to match the missing summary — leaving step 9's equality check
 * (sameKindOrder) blind to the very rollback it exists to catch. Requiring
 * the trailing reply here, live and pre-resume, is what makes that later
 * equality check meaningful in the first place.
 *
 * Returns the list of missing parts (empty = the form is fully present) so
 * the caller can fail closed with a specific diagnosis rather than a bare
 * boolean — no "harness gap, not a production defect" style excuse: the W17
 * incident was exactly that claim turning out to be false.
 *
 * W19: the caller MUST already scope `kindOrder` to a single turn (see
 * firstTurnSegment) — this function counts tool_call blocks across whatever
 * it is given, with no turn-boundary awareness of its own.
 */
function twoCommandFormGaps(kindOrder) {
  const gaps = [];
  const toolIndices = [];
  kindOrder.forEach((kind, index) => {
    if (kind === "tool_call") toolIndices.push(index);
  });
  if (toolIndices.length !== 2) {
    gaps.push(`expected exactly 2 tool_call blocks, found ${toolIndices.length}`);
    return gaps;
  }
  const [firstTool, secondTool] = toolIndices;
  if (!kindOrder.slice(0, firstTool).includes("assistant_text")) {
    gaps.push("no assistant_text before the first tool_call");
  }
  if (!kindOrder.slice(firstTool + 1, secondTool).includes("assistant_text")) {
    gaps.push("no assistant_text strictly between the two tool_call blocks");
  }
  if (!kindOrder.slice(secondTool + 1).includes("assistant_text")) {
    gaps.push("no assistant_text strictly after the second tool_call (missing trailing summary)");
  }
  return gaps;
}

// ── self-check (W19): firstTurnSegment + twoCommandFormGaps are pure
// functions of a plain string[] (per this file's own "each predicate is a
// pure function ... can be exercised on synthetic arrays without a live
// run" precedent, above) — so their ALLOW-turn scoping is proven here on
// synthetic kind orders, unconditionally, before any live step runs. A
// failure here means the harness itself is broken and must not be trusted
// to judge a live run at all; it exits 1 with the mismatching case named
// rather than letting a broken predicate silently rubber-stamp step 7.
const SELF_CHECK_CASES = [
  {
    name: "real live pre-Stop order (ALLOW turn: 2 tool_call; DENY turn appends a 3rd) must PASS",
    kindOrder: [
      "user_text", "assistant_text", "tool_call", "assistant_text", "tool_call", "assistant_text",
      "user_text", "tool_call", "assistant_text",
    ],
    expectGaps: false,
  },
  {
    name: "W6 tail drift inside the ALLOW turn (2nd tool_call sinks behind an extra assistant_text, no trailing summary) must RED",
    kindOrder: [
      "user_text", "assistant_text", "tool_call", "assistant_text", "assistant_text", "tool_call",
      "user_text", "tool_call", "assistant_text",
    ],
    expectGaps: true,
  },
  {
    name: "ALLOW turn runs only one command instead of two must RED",
    kindOrder: ["user_text", "assistant_text", "tool_call", "assistant_text", "user_text", "tool_call", "assistant_text"],
    expectGaps: true,
  },
  {
    name: "ALLOW turn has no trailing assistant_text after its 2nd command must RED",
    kindOrder: [
      "user_text", "assistant_text", "tool_call", "assistant_text", "tool_call",
      "user_text", "tool_call", "assistant_text",
    ],
    expectGaps: true,
  },
];

function selfCheckTwoCommandFormGaps() {
  for (const { name, kindOrder, expectGaps } of SELF_CHECK_CASES) {
    const gaps = twoCommandFormGaps(firstTurnSegment(kindOrder));
    const gotGaps = gaps.length > 0;
    if (gotGaps !== expectGaps) {
      console.error(
        `[codex-live-smoke] SELF-CHECK FAILED: "${name}" — expected ${expectGaps ? "RED (gaps)" : "PASS (no gaps)"}, got ${gotGaps ? `RED: ${JSON.stringify(gaps)}` : "PASS"}`,
      );
      process.exit(1);
    }
  }
  console.log(`[codex-live-smoke] self-check OK: ${SELF_CHECK_CASES.length}/${SELF_CHECK_CASES.length} synthetic form-gap cases matched expectations`);
}

// The healthy shape both self-check groups below check against: the pre-Stop
// order (ALLOW turn's 2 commands, then the DENY turn's 1) plus the trailing
// "user_text" step 9 always expects (the interrupted step-7 turn's own
// userMessage, fact 13) — exactly what step9ResumeAndCheckTranscript's
// `expectedKindOrder` computes on a clean run.
const HEALTHY_POST_RESUME_KIND_ORDER = [
  "user_text", "assistant_text", "tool_call", "assistant_text", "tool_call", "assistant_text",
  "user_text", "tool_call", "assistant_text", "user_text",
];

function toBlocks(kindOrder) {
  return kindOrder.map((kind) => ({ kind }));
}

// ── self-check (W21): turnHasAssistantTail is a pure function of a plain
// TranscriptBlock[] (only `.kind` is read, per this file's own block-shape
// comment above `lastIndexOfKind`) — proven here on synthetic blocks built
// from a bare kind string via `toBlocks`, unconditionally, before any live
// step runs. Case (a) is HEALTHY_POST_RESUME_KIND_ORDER itself; cases (b)
// and (c) are two DIFFERENT single-field mutations of that SAME healthy
// order, each isolating one observed failure mode: (b) is the W8 eviction
// shape (the DENY turn's own trailing assistant_text is gone, so the resumed
// transcript ends on the interrupted turn's bare user_text right after a
// tool_call) and (c) is a W6-style reorder inside the DENY turn itself (its
// tool_call sinks behind its own assistant_text, so the last assistant_text
// again precedes the last tool_call). Pairing each RED case against the same
// healthy baseline is what proves the RED is about the one field that
// differs, not a coincidence of the fixture.
const ASSISTANT_TAIL_SELF_CHECK_CASES = [
  {
    name: "(a) healthy post-resume order (pre-Stop shape + trailing user_text) must PASS",
    kindOrder: HEALTHY_POST_RESUME_KIND_ORDER,
    expectPass: true,
  },
  {
    name: "(b) W8 eviction: DENY turn's trailing assistant_text is gone, transcript ends on bare user_text right after its tool_call must RED",
    kindOrder: [
      "user_text", "assistant_text", "tool_call", "assistant_text", "tool_call", "assistant_text",
      "user_text", "tool_call", "user_text",
    ],
    expectPass: false,
  },
  {
    name: "(c) W6-style reorder: DENY turn's tool_call sinks behind its own assistant_text, then the interrupted turn's user_text must RED",
    kindOrder: [
      "user_text", "assistant_text", "tool_call", "assistant_text", "tool_call", "assistant_text",
      "user_text", "assistant_text", "tool_call", "user_text",
    ],
    expectPass: false,
  },
];

function selfCheckTurnHasAssistantTail() {
  for (const { name, kindOrder, expectPass } of ASSISTANT_TAIL_SELF_CHECK_CASES) {
    const got = turnHasAssistantTail(toBlocks(kindOrder));
    if (got !== expectPass) {
      console.error(
        `[codex-live-smoke] SELF-CHECK FAILED: "${name}" — expected ${expectPass ? "PASS" : "RED"}, got ${got ? "PASS" : "RED"}`,
      );
      process.exit(1);
    }
  }
  console.log(`[codex-live-smoke] self-check OK: ${ASSISTANT_TAIL_SELF_CHECK_CASES.length}/${ASSISTANT_TAIL_SELF_CHECK_CASES.length} synthetic turnHasAssistantTail cases matched expectations`);
}

// ── self-check (W21): sameKindOrder is a pure equality of two plain
// string[] — proven against a documented W6 rollback SHAPE (the ALLOW turn's
// second command, C2, sinks behind its own reply A3 instead of preceding
// it — the same tail-drift shape twoCommandFormGaps's own self-check cases
// already exercise, here checked at the whole-transcript equality layer
// step 9 actually gates on) compared to HEALTHY_POST_RESUME_KIND_ORDER, and
// against that healthy order compared to itself.
const SAME_KIND_ORDER_ROLLBACK = [
  "user_text", "assistant_text", "tool_call", "assistant_text", "assistant_text", "tool_call",
  "user_text", "tool_call", "assistant_text", "user_text",
];

function selfCheckSameKindOrder() {
  const cases = [
    {
      name: "documented W6 rollback form (C2 sinks behind A3) vs the healthy expected order must MISMATCH",
      a: SAME_KIND_ORDER_ROLLBACK,
      b: HEALTHY_POST_RESUME_KIND_ORDER,
      expectMatch: false,
    },
    {
      name: "healthy expected order vs itself must MATCH",
      a: HEALTHY_POST_RESUME_KIND_ORDER,
      b: HEALTHY_POST_RESUME_KIND_ORDER,
      expectMatch: true,
    },
  ];
  for (const { name, a, b, expectMatch } of cases) {
    const got = sameKindOrder(a, b);
    if (got !== expectMatch) {
      console.error(
        `[codex-live-smoke] SELF-CHECK FAILED: "${name}" — expected ${expectMatch ? "MATCH" : "MISMATCH"}, got ${got ? "MATCH" : "MISMATCH"}`,
      );
      process.exit(1);
    }
  }
  console.log(`[codex-live-smoke] self-check OK: ${cases.length}/${cases.length} synthetic sameKindOrder cases matched expectations`);
}

// ── step 9: resume the codex session, check the transcript ──

async function step9ResumeAndCheckTranscript(ctx) {
  const resumed = await resumeCodexSessionWhenReady(ctx, 9, ctx.codexSessionId);
  const resumedTabId = resumed.tabId;

  await waitUntilTab(ctx, 9, resumedTabId, { connection: "ready" }, TURN_WAIT_TIMEOUT_MS);

  const state = await getTabState(ctx, 9, resumedTabId);
  const transcript = Array.isArray(state?.transcript) ? state.transcript : [];
  const text = transcript.map((b) => `${b.text ?? ""} ${b.modelText ?? ""}`).join(" | ");

  // Native `thread/read` persists userMessage/agentMessage unconditionally
  // (cut §1a L4).
  assert(
    9,
    text.includes("touch") || text.length > 0,
    `resumed transcript shows no prior user/assistant content at all (tab ${resumedTabId}): ${JSON.stringify(transcript).slice(0, 500)}`,
  );
  // Tool OUTCOMES (the command executions from steps 5/6) are the part cut
  // §2(e) reroutes through the engine-owned shadow-log (native thread/read
  // never persists commandExecution at all, L4).
  const hasToolOutcome = transcript.some((b) => b.kind === "tool_call" || b.kind === "tool_result");
  assert(
    9,
    hasToolOutcome,
    `resumed transcript shows no tool_call/tool_result block for the earlier allow/deny commands (tab ${resumedTabId})`,
  );

  const kindOrder = transcript.map((b) => b?.kind ?? "?").join(", ");

  // W8 invariant: the turn's own last message must not be evicted by a
  // re-delivered stale shadow-logged command — the transcript must not end
  // mid-command. (W16: the failure prose used to claim the transcript "ends
  // on a tool_call", which is false whenever a later turn appends more
  // history after that tool_call without ever adding an assistant_text of
  // its own (fact 13) — the actual invariant this checks is narrower: no
  // assistant_text anywhere after the LAST tool_call.)
  assert(
    9,
    turnHasAssistantTail(transcript),
    `resumed transcript has no assistant_text after the last tool_call — kind order: [${kindOrder}]`,
  );
  // W21: gross-displacement sanity check, not the discriminator. Any
  // transcript that fails this also fails the kindOrdersMatch equality check
  // below (a RED here is always a RED there too — this check is SUBSUMED by
  // it), and it does NOT catch the shadow-log anchor rollback this smoke is
  // built to detect (codex-engine.ts:933): that rollback sinks the SECOND
  // command (C2), while this predicate only looks at the FIRST tool_call's
  // position, which the anchor never moves. Left in as a coarse,
  // human-readable diagnosis for the common case (a command displaced
  // entirely out of the turn), not as an independent W6 verification.
  assert(
    9,
    commandKeepsItsPlace(transcript),
    `resumed transcript's first tool_call is not strictly between the first user_text and the last assistant_text (command lost its place) — kind order: [${kindOrder}]`,
  );
  // The eviction bug this smoke exists to catch would leave stale
  // shadow-logged commands as the very first thing a resumed transcript shows.
  assert(
    9,
    transcriptDoesNotOpenOnTool(transcript),
    `resumed transcript opens with a tool_call block instead of the original user/assistant history — kind order: [${kindOrder}]`,
  );
  // W16 (facts 13+16): the post-resume normalized order must equal the
  // pre-Stop normalized order (captured in step 7, before the Stop) PLUS a
  // trailing "user_text" — fact 13: the interrupted step-7 turn persists
  // ONLY its userMessage (zero agent-items). Any other delta — a shifted
  // tool_call, a dropped assistant_text, a mismatched length anywhere but
  // the expected tail — is a live W6/W8 rollback. This is the ONE assertion
  // in this file that actually discriminates the shadow-log anchor rollback
  // (codex-engine.ts:933, see twoCommandFormGaps's and
  // capturePreStopSnapshot's own comments for why the trailing summary
  // requirement upstream is what makes it discriminating) — proven by
  // construction in selfCheckSameKindOrder above, not by prose.
  const postKindOrder = normalizedKindOrder(transcript);
  const expectedKindOrder = [...(ctx.preStopKindOrder ?? []), "user_text"];
  const kindOrdersMatch = sameKindOrder(postKindOrder, expectedKindOrder);
  assert(
    9,
    kindOrdersMatch,
    `resumed normalized kind order != pre-Stop normalized kind order + trailing "user_text" (fact 13: an interrupted turn persists only userMessage) — pre-Stop: [${(ctx.preStopKindOrder ?? []).join(", ")}], post-resume: [${postKindOrder.join(", ")}]`,
  );

  await saveScreenshot(ctx, "step-9-resumed-transcript");
  pass(9, `resume verified: tab ${resumedTabId} shows prior turns and tool outcomes before any new prompt`);
  ctx.codexTabId = resumedTabId; // final teardown below closes/quits through this handle
}

// ── step 10: final teardown + orphan-check #2 ──

function step10Teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runStep10Teardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runStep10Teardown(ctx, failedStep) {
  if (ctx.port && ctx.token && ctx.child) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort — the app may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[codex-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of final /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[codex-live-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  // Teardown case #2 (final): best-effort — a prior step may already have
  // failed, so this must never THROW past the cleanup below, only report.
  try {
    await assertZeroOrphans(10, "final teardown", ctx.appPgid);
  } catch (err) {
    console.error(`[codex-live-smoke] ${err?.message ?? err}`);
    if (failedStep === null) {
      failedStep = 10;
    }
  }

  for (const tmp of [ctx.bootWs, ctx.codexWs]) {
    if (tmp && existsSync(tmp)) {
      if (FLAGS.keep) {
        console.log(`[codex-live-smoke] --keep set, workspace preserved at: ${tmp}`);
      } else {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[codex-live-smoke] failed to remove temp workspace ${tmp}: ${err?.message ?? err}`);
        }
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[codex-live-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-live-smoke] failed to remove automation profile ${ctx.profile}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[codex-live-smoke] ${passedSteps.size}/${TOTAL_STEPS} steps passed — ${verdict}`);
  return failedStep;
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[codex-live-smoke] received ${signal} — tearing down…`);
    step10Teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[codex-live-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  selfCheckTwoCommandFormGaps();
  selfCheckTurnHasAssistantTail();
  selfCheckSameKindOrder();
  const { bin, rawVersion } = preflight();

  const ctx = {
    codexBin: bin,
    codexVersion: rawVersion,
    bootWs: null,
    codexWs: null,
    sentinelAllow1: null,
    sentinelAllow2: null,
    sentinelDeny: null,
    port: undefined,
    token: undefined,
    codexTabId: null,
    codexSessionId: null,
    child: null,
    appPid: null,
    appPgid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    preStopKindOrder: null,
    screenshotDir: join(desktopRoot, "out", "codex-live-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapWorkspaces(ctx);
    await step2LaunchApp(ctx);
    await step3WaitFacadeReady(ctx);
    await step4CreateCodexSession(ctx);
    await step5AllowCommand(ctx);
    await step6DenyCommand(ctx);
    await step7StopTurn(ctx);
    await step8QuitRelaunch(ctx);
    await step9ResumeAndCheckTranscript(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[codex-live-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  const teardownFailedStep = await step10Teardown(ctx, failedStep);
  process.exit(teardownFailedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[codex-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

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
 * Some steps exercise engine behavior other lanes are landing concurrently
 * (B1: approve/deny/stop; B2: engine-aware `thread/start`; B5-eng:
 * resume-history projection). Each such assertion's failure message names
 * the lane it depends on, per this block's brief: a step that cannot pass
 * yet because its lane has not landed says so explicitly rather than
 * skipping silently — this driver is meant to be re-run at the join, once
 * every lane has merged.
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

/** Same as `assert`, but the failure message is tagged with which lane the checked behavior depends on (this block's brief: name the dependency, do not skip silently). */
function assertLane(step, cond, detail, lane) {
  if (!cond) {
    fail(step, `${detail} — depends on ${lane}; if that lane has not landed yet, re-run this smoke at the join`);
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

/** Same as `waitUntilTab`, but a non-match fails with a lane-tagged message instead of a generic one. */
async function waitUntilTabLane(ctx, step, tabId, until, timeoutMs, lane) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  assertLane(step, result.matched === true, `/wait ${JSON.stringify(until)} for tab ${tabId} did not match within ${timeoutMs ?? "default"}ms: ${JSON.stringify(result)}`, lane);
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
    ctx.sentinelAllow = join(ctx.codexWs, "smoke-allow.txt");
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

  const allowPrompt = `Run exactly this shell command and nothing else: touch ${JSON.stringify(ctx.sentinelAllow)}. Do not explain, just run it.`;
  await apiAction(ctx, 4, "/start-screen/prompt", { text: allowPrompt });
  const submitted = await apiOk(ctx, 4, "POST", "/start-screen/submit", {});
  assertLane(4, submitted?.ok === true, `/start-screen/submit rejected for the codex draft: ${JSON.stringify(submitted)}`, "B2-host (TASK.39 thread/start engine-aware wiring, cut §5.3)");
  ctx.codexTabId = submitted.tabId;

  await waitUntilTabLane(ctx, 4, ctx.codexTabId, { connection: "ready" }, TURN_WAIT_TIMEOUT_MS, "B2-host (TASK.39 thread/start, cut §5.3)");

  const state = await getTabState(ctx, 4, ctx.codexTabId);
  assertLane(4, state?.engine?.id === "codex", `tab snapshot's engine.id is not "codex" after host_ready: ${JSON.stringify(state?.engine)}`, "B2-host (EnginePresentation on host_ready, cut §3.1)");

  await saveScreenshot(ctx, "step-4-codex-session-created");
  pass(4, `codex session created (tab ${ctx.codexTabId}), engine picker round-tripped, initial ALLOW-flow prompt queued`);
}

// ── step 5: ALLOW the queued command approval, verify the sentinel file landed on disk ──

async function step5AllowCommand(ctx) {
  await waitUntilTabLane(ctx, 5, ctx.codexTabId, { permissionPending: true }, PERMISSION_WAIT_TIMEOUT_MS, "B1 (TASK.38 approval-bridge, cut §2(c))");
  await apiAction(ctx, 5, `/tabs/${ctx.codexTabId}/permission`, { behavior: "allow" });
  await waitUntilTabLane(ctx, 5, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS, "B1 (TASK.38 accept mapping, cut §2(c))");

  assertLane(5, existsSync(ctx.sentinelAllow), `allowed command's sentinel file was not created: ${ctx.sentinelAllow}`, "B1 (TASK.38 accept -> {decision:\"accept\"} mapping, cut §2(c))");
  pass(5, `command approval ALLOWED — sentinel file confirmed on disk: ${ctx.sentinelAllow}`);
}

// ── step 6: send a second prompt, DENY its command approval, verify the sentinel file was NOT created ──

async function step6DenyCommand(ctx) {
  const denyPrompt = `Run exactly this shell command and nothing else: touch ${JSON.stringify(ctx.sentinelDeny)}. Do not explain, just run it.`;
  await apiAction(ctx, 6, `/tabs/${ctx.codexTabId}/prompt`, { text: denyPrompt });

  await waitUntilTabLane(ctx, 6, ctx.codexTabId, { permissionPending: true }, PERMISSION_WAIT_TIMEOUT_MS, "B1 (TASK.38 approval-bridge, cut §2(c))");
  await apiAction(ctx, 6, `/tabs/${ctx.codexTabId}/permission`, { behavior: "deny" });
  // L1 (cut §1a): decline continues the turn to `completed` rather than
  // ending it — the client is reusable, no close/terminal-denial machinery.
  await waitUntilTabLane(ctx, 6, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS, "B1 (TASK.38 §2(c) decline-continuation, L1)");

  assertLane(6, !existsSync(ctx.sentinelDeny), `denied command's sentinel file WAS created (deny did not block execution): ${ctx.sentinelDeny}`, "B1 (TASK.38 deny -> {decision:\"decline\"} mapping, cut §2(c))");
  pass(6, `command approval DENIED — sentinel file confirmed ABSENT: ${ctx.sentinelDeny}`);
}

// ── step 7: send a slow prompt, Stop it mid-turn, verify the turn returns to idle promptly ──

async function step7StopTurn(ctx) {
  const slowPrompt =
    "Count out loud from one to fifty. For EVERY single number, write a full separate paragraph of at least three sentences describing something interesting about that number before moving to the next one. Do not use any tools.";
  await apiAction(ctx, 7, `/tabs/${ctx.codexTabId}/prompt`, { text: slowPrompt });

  await waitUntilTabLane(ctx, 7, ctx.codexTabId, { turnStatus: "running" }, TURN_WAIT_TIMEOUT_MS, "B1 (TASK.38 turn/start response handling, cut §2(b))");
  await apiAction(ctx, 7, `/tabs/${ctx.codexTabId}/stop`, {});
  await waitUntilTabLane(ctx, 7, ctx.codexTabId, { turnStatus: "idle" }, TURN_WAIT_TIMEOUT_MS, "B1 (TASK.38 single-fire abort-promise / sendInterruptOnce, cut §2(b))");

  pass(7, "Stop mid-turn returned the session to idle without a tab restart");
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
 * W6 invariant: a shadow-logged command keeps ITS OWN place between agent
 * messages instead of sinking to the end on re-delivery. True iff the FIRST
 * "tool_call" sits strictly before the LAST "assistant_text" (the command is
 * not stranded after every reply), AND the FIRST "user_text" precedes the
 * FIRST "tool_call" (the prompt that triggered it still comes first).
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

// ── step 9: resume the codex session, check the transcript ──

async function step9ResumeAndCheckTranscript(ctx) {
  const resumed = await apiOk(ctx, 9, "POST", "/tabs", { kind: "resume", sessionId: ctx.codexSessionId });
  assertLane(9, resumed?.ok === true, `resume of session ${ctx.codexSessionId} was rejected: ${JSON.stringify(resumed)}`, "B1/B2 (thread/resume wiring)");
  const resumedTabId = resumed.tabId;

  await waitUntilTabLane(ctx, 9, resumedTabId, { connection: "ready" }, TURN_WAIT_TIMEOUT_MS, "B1/B2 (thread/resume wiring)");

  const state = await getTabState(ctx, 9, resumedTabId);
  const transcript = Array.isArray(state?.transcript) ? state.transcript : [];
  const text = transcript.map((b) => `${b.text ?? ""} ${b.modelText ?? ""}`).join(" | ");

  // Native `thread/read` persists userMessage/agentMessage unconditionally
  // (cut §1a L4) — this half does NOT depend on the shadow-log lane.
  assertLane(
    9,
    text.includes("touch") || text.length > 0,
    `resumed transcript shows no prior user/assistant content at all (tab ${resumedTabId}): ${JSON.stringify(transcript).slice(0, 500)}`,
    "B1/B2 (host boot-history wiring, cut §3.6 bootHistory)",
  );
  // Tool OUTCOMES (the command executions from steps 5/6) are the part cut
  // §2(e) reroutes through the engine-owned shadow-log (native thread/read
  // never persists commandExecution at all, L4) — this half is the one most
  // likely to still be red before B5-eng lands.
  const hasToolOutcome = transcript.some((b) => b.kind === "tool_call" || b.kind === "tool_result");
  assertLane(
    9,
    hasToolOutcome,
    `resumed transcript shows no tool_call/tool_result block for the earlier allow/deny commands (tab ${resumedTabId})`,
    "B5-eng (TASK.42 history-projection shadow-log, cut §2(e))",
  );

  const kindOrder = transcript.map((b) => b?.kind ?? "?").join(", ");

  // W8: the turn's own last message must not be evicted by a re-delivered
  // stale shadow-logged command — the transcript must not end mid-command.
  assertLane(
    9,
    turnHasAssistantTail(transcript),
    `resumed transcript ends on a tool_call with no assistant_text after it (turn cut off on a command) — kind order: [${kindOrder}]`,
    "W8 (895b380: let a re-delivered command enrich its row, and stop old commands from evicting live history)",
  );
  // W6: the command must keep ITS OWN place between the agent messages that
  // surround it, not sink to the tail of the transcript on re-delivery.
  assertLane(
    9,
    commandKeepsItsPlace(transcript),
    `resumed transcript's first tool_call is not strictly between the first user_text and the last assistant_text (command lost its place) — kind order: [${kindOrder}]`,
    "W6 (30da16b: anchor the shadow command log to the domain thread/read actually returns)",
  );
  // The eviction bug this smoke exists to catch would leave stale
  // shadow-logged commands as the very first thing a resumed transcript shows.
  assertLane(
    9,
    transcriptDoesNotOpenOnTool(transcript),
    `resumed transcript opens with a tool_call block instead of the original user/assistant history — kind order: [${kindOrder}]`,
    "W8 (895b380: stop old commands from evicting live history)",
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
  console.log(`\n[codex-live-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
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
  const { bin, rawVersion } = preflight();

  const ctx = {
    codexBin: bin,
    codexVersion: rawVersion,
    bootWs: null,
    codexWs: null,
    sentinelAllow: null,
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

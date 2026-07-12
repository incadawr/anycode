/**
 * Live GUI smoke for P7.22 F19 (design/slice-P7.22-cut.md §4 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Profile pane
 * probe/driver" routes) against a seeded, ISOLATED `ANYCODE_PROFILE_HOME`
 * fixture directory standing in for `~` — two synthetic session JSONLs in
 * `<home>/.anycode/telemetry/*.jsonl` spanning 3 known local days, plus a
 * seeded `<home>/.anycode/config.json` (`telemetry.enabled:false` + an
 * unrelated `mcpServers` preservation sentinel).
 *
 * FULLY DETERMINISTIC — no live-model leg at all: Profile is a user-scope-only
 * page (design §2-D2, no per-tab workspace concept), so this smoke never even
 * creates a tab (`ANYCODE_WORKSPACE` is deliberately left unset/deleted — the
 * app boots straight to the zero-tab shell, Sidebar + Settings render
 * regardless). Every assertion is hand-computed from the exact fixture
 * timestamps below (see the inline arithmetic in `step1SeedFixtures`), not
 * re-derived from the aggregator's own implementation.
 *
 * It exercises the full stack: the aggregation read (tiles/insights/top-tools/
 * heatmap, the data+disabled "frozen" banner), the user-scope telemetry
 * enable toggle (`setUserTelemetryEnabled`, preserving the unrelated
 * `mcpServers` key byte-for-byte), and the empty-state hero (a second,
 * genuinely empty `ANYCODE_PROFILE_HOME`).
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted from
 * `skills-ui-smoke.mjs` (same disposable-profile discipline), generalized
 * into a `launchLeg`/`quitLeg` pair since THIS smoke boots two isolated app
 * instances in sequence (a populated leg, then an empty-dir leg) rather than
 * one.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/profile-ui-smoke.mjs [--keep] [--port <n>]
 *
 *   --keep         Do not delete the temp home / import-home / automation
 *                   profile dirs on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to BOTH spawned dev
 *                   processes (they run sequentially, never concurrently, so
 *                   reusing one fixed port is safe).
 *
 * Each of the 5 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (populated pane, empty-state
 * pane) is written to the two `--screenshot-*` paths below.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const TOTAL_STEPS = 5;
const LAUNCH_TIMEOUT_MS = 120_000;
const PANE_SETTLE_TIMEOUT_MS = 15_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// -- fixed screenshot destinations (orchestrator-specified, design §4 W4) --
const POPULATED_SCREENSHOT = "/Users/incadawr/.claude/jobs/acfddfb7/tmp/profile-populated.png";
const EMPTY_SCREENSHOT = "/Users/incadawr/.claude/jobs/acfddfb7/tmp/profile-empty.png";

// -- CLI flags --

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
      console.warn(`[profile-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// -- small process/fs helpers (lifted from skills-ui-smoke.mjs) --

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
    // already gone -- nothing to do.
  }
}

/** Cheap deep-equality for plain JSON values (all our fixtures are JSON-round-tripped, so key order is stable). */
function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// -- step bookkeeping --

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

// -- HTTP helpers against the automation channel (README.md routes) --

async function api(leg, method, path, body) {
  const headers = { Authorization: `Bearer ${leg.token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${leg.port}${path}`, init);
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

/** `api()` + hard-fail on transport error or non-200 (the request never even reached the facade). */
async function apiOk(leg, step, method, path, body) {
  let resp;
  try {
    resp = await api(leg, method, path, body);
  } catch (err) {
    fail(step, `${method} ${path} threw: ${err?.message ?? err}`);
  }
  if (resp.status !== 200) {
    fail(step, `${method} ${path} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

/** A POST action expected to succeed at the facade level too (`{ok:true, ...}`). */
async function apiAction(leg, step, path, body) {
  const result = await apiOk(leg, step, "POST", path, body);
  if (result?.ok !== true) {
    fail(step, `POST ${path} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Poll `GET /state` until the renderer facade has finished installing (DEV
 * dynamic import races the page load) -- same readiness signal as every
 * other `*-ui-smoke.mjs` in this directory.
 */
async function waitForFacade(leg, step, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    let resp;
    try {
      resp = await api(leg, "GET", "/state?tail=0");
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

async function getProfilePane(leg, step) {
  return apiOk(leg, step, "GET", "/settings/profile");
}

/** Best-effort PNG evidence via `GET /screenshot` -- never fails the step it's called from. A short settle delay first (subagents-ui-smoke.mjs's `settledScreenshot` precedent): the DOM read above can observe React's committed state a frame or two before Electron's compositor has actually painted it, so an immediate capture risks a blank/stale frame. */
async function saveScreenshot(leg, step, filePath) {
  await sleep(400);
  try {
    const resp = await api(leg, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[profile-ui-smoke] screenshot "${filePath}" unavailable (HTTP ${resp.status})`);
      return false;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`[profile-ui-smoke] screenshot "${filePath}" failed: ${err?.message ?? err}`);
    return false;
  }
}

// -- fixture record builders --

/** `{v:1, ts, session, ...fields}` JSONL line. */
function record(ts, session, fields) {
  return JSON.stringify({ v: 1, ts, session, ...fields });
}

/** Local noon (`daysAgo` days before `base`), as an epoch-ms number -- robust to month/day rollover (the Date constructor normalizes) and to DST (every cross-day gap this fixture uses is engineered to blow past the 5-minute activity-gap cap regardless of a +/-1h DST shift, so the shift never changes an expected SUM, only an unused exact gap value). */
function localNoon(daysAgo, base) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo, 12, 0, 0, 0).getTime();
}

// -- step 1: seed fixtures + boot the populated leg + open the profile pane --

/**
 * Hand-computed fixture math (design §4 W4 DoD point 1/2): two sessions,
 * 3 distinct local days (D2, D1, D0=today -- so the streak is anchored at
 * "today" and both current/longest streak land on the same exact value).
 *
 * sess-alpha.jsonl (session "sess-alpha"), every record on day D2:
 *   ts=D2+0        session_start  model=claude-alpha
 *   ts=D2+120000   usage          totalTokens=1000
 *   ts=D2+300000   tool           tool=Read
 *   ts=D2+360000   tool           tool=Read
 *   ts=D2+420000   usage          totalTokens=500
 *   ts=D2+1200000  loop_end
 *   ts=D2+1260000  subagent_start
 *   ts=D2+1320000  session_end
 *   consecutive gaps (ms): 120000, 180000, 60000, 60000, 780000(->capped 300000), 60000, 60000
 *   active(gap-capped) sum = 120000+180000+60000+60000+300000+60000+60000 = 840000ms = 14m
 *
 * sess-beta.jsonl (session "sess-beta"), D1 then D0:
 *   ts=D1+0        session_start  model=claude-beta
 *   ts=D1+180000   usage          totalTokens=2000
 *   ts=D1+240000   tool           tool=Write
 *   ts=D0+0        usage          totalTokens=3000
 *   ts=D0+120000   loop_end
 *   ts=D0+180000   session_end
 *   consecutive gaps (ms): 180000, 60000, ~86160000(->capped 300000), 120000, 60000
 *   active(gap-capped) sum = 180000+60000+300000+120000+60000 = 720000ms = 12m (< sess-alpha's 14m)
 *
 * Derived aggregate values (asserted EXACT in step 2):
 *   lifetimeTokens  = 1000+500+2000+3000 = 6500        -> "6.5k"
 *   dailyTokens     = {D2:1500, D1:2000, D0:3000}
 *   peakDay         = D0, 3000 tokens                  -> "3k"
 *   longestSession  = max(840000, 720000) = 840000ms   -> "14m"
 *   currentStreak = longestStreak = 3 (D2,D1,D0 consecutive, ending today) -> "3 days"
 *   totalSessions   = 2 (both files yield >=1 valid record)
 *   totalRuns       = 2 (one loop_end per session)
 *   toolCalls       = 3 (Read x2, Write x1)
 *   subagentRuns    = 1 (sess-alpha only)
 *   topTools        = [Read(2), Write(1)]
 *   topModels       = claude-beta(5000) > claude-alpha(1500) -> "Most used model" = claude-beta
 *   heatmapNonEmptyCells = 3 (D2, D1, D0 all >0 tokens)
 */
function step1SeedFixtures(ctx) {
  const now = new Date();
  const D0 = localNoon(0, now);
  const D1 = localNoon(1, now);
  const D2 = localNoon(2, now);

  const home = mkdtempSync(join(tmpdir(), "anycode-profile-smoke-home-"));
  ctx.populatedHome = home;
  const telemetryDir = join(home, ".anycode", "telemetry");
  mkdirSync(telemetryDir, { recursive: true });

  const sessAlpha = [
    record(D2 + 0, "sess-alpha", { t: "session_start", model: "claude-alpha", provider: "anthropic", mode: "build" }),
    record(D2 + 120_000, "sess-alpha", { t: "usage", totalTokens: 1000 }),
    record(D2 + 300_000, "sess-alpha", { t: "tool", tool: "Read", status: "success", durationMs: 50 }),
    record(D2 + 360_000, "sess-alpha", { t: "tool", tool: "Read", status: "success", durationMs: 40 }),
    record(D2 + 420_000, "sess-alpha", { t: "usage", totalTokens: 500 }),
    record(D2 + 1_200_000, "sess-alpha", { t: "loop_end", reason: "completed", turns: 3 }),
    record(D2 + 1_260_000, "sess-alpha", { t: "subagent_start", agentType: "general-purpose" }),
    record(D2 + 1_320_000, "sess-alpha", { t: "session_end" }),
  ].join("\n");
  writeFileSync(join(telemetryDir, "sess-alpha.jsonl"), `${sessAlpha}\n`);

  const sessBeta = [
    record(D1 + 0, "sess-beta", { t: "session_start", model: "claude-beta", provider: "anthropic", mode: "build" }),
    record(D1 + 180_000, "sess-beta", { t: "usage", totalTokens: 2000 }),
    record(D1 + 240_000, "sess-beta", { t: "tool", tool: "Write", status: "success", durationMs: 30 }),
    record(D0 + 0, "sess-beta", { t: "usage", totalTokens: 3000 }),
    record(D0 + 120_000, "sess-beta", { t: "loop_end", reason: "completed", turns: 2 }),
    record(D0 + 180_000, "sess-beta", { t: "session_end" }),
  ].join("\n");
  writeFileSync(join(telemetryDir, "sess-beta.jsonl"), `${sessBeta}\n`);

  ctx.seededConfig = {
    telemetry: { enabled: false },
    mcpServers: {
      "profile-ui-smoke-sentinel-mcp": {
        command: "/nonexistent/dummy-mcp-binary",
        args: ["--dummy-flag"],
      },
    },
  };
  ctx.populatedConfigPath = join(home, ".anycode", "config.json");
  writeFileSync(ctx.populatedConfigPath, JSON.stringify(ctx.seededConfig, null, 2));

  ctx.expected = {
    tiles: {
      "Lifetime tokens": "6.5k",
      "Peak tokens · 1 day": "3k",
      "Longest task": "14m",
      "Current streak": "3 days",
      "Longest streak": "3 days",
    },
    totalSessions: 2,
    totalRuns: 2,
    toolCalls: 3,
    subagentRuns: 1,
    mostUsedModel: "claude-beta",
    topTools: ["Read", "Write"],
    heatmapNonEmptyCells: 3,
  };

  // Not a `pass()` in its own right -- step 1's single PASS line (below, in
  // `step1BootPopulatedLeg`) covers both fixture-seeding and the boot, so
  // `passCount` lands on exactly `TOTAL_STEPS` for a clean run.
  console.log(`[step 1] fixtures seeded at ${home} (sess-alpha D2-only, sess-beta D1->D0, telemetry.enabled:false, mcpServers sentinel)`);
}

/** Spawns (or reuses) a dev instance pointed at `homeDir` via `ANYCODE_PROFILE_HOME`, waits for the facade, opens Settings -> "profile". No tab is ever created (Profile is user-scope-only, design §2-D2) -- `ANYCODE_WORKSPACE` is deliberately deleted so the app boots to the zero-tab shell. */
async function launchLeg(leg, step, homeDir) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-profile-smoke-profile-"));
  leg.profile = profile;
  const profileUserDataDir = join(profile, "user-data");
  const profileDbPath = join(profile, "db.sqlite");
  const profileAutomationInfo = join(profile, "automation.json");

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: profileUserDataDir,
    ANYCODE_DB_PATH: profileDbPath,
    ANYCODE_AUTOMATION_INFO: profileAutomationInfo,
    // dev/test-only override (automation/README.md "Profile pane
    // probe/driver" section) -- points the Profile pane's user-scope home at
    // our disposable fixture directory instead of the real machine's `~`.
    // Production code path is unaffected (falls back to os.homedir() when
    // unset, and even this var is refused outside ANYCODE_AUTOMATION=1 &&
    // !isPackaged).
    ANYCODE_PROFILE_HOME: homeDir,
  };
  delete env.ANYCODE_WORKSPACE; // this smoke never creates a tab -- Profile is user-scope-only.
  if (FLAGS.port !== undefined) {
    env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
  }

  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  leg.child = child;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(step, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(step, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${profileAutomationInfo} (startedAt > ${t0})`);
  }
  leg.port = info.port;
  leg.token = info.token;
  leg.appPid = info.pid;

  await waitForFacade(leg, step);

  const opened = await apiAction(leg, step, "/settings/open", {});
  assert(step, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);
  const selected = await apiAction(leg, step, "/settings/pane", { paneId: "profile" });
  assert(step, selected.ok === true, `settings/pane("profile") rejected: ${JSON.stringify(selected)}`);
}

async function step1BootPopulatedLeg(ctx) {
  ctx.legA = { name: "populated" };
  await launchLeg(ctx.legA, 1, ctx.populatedHome);

  // The stats read is a real main-process fs scan + aggregation round-tripped
  // over IPC -- poll briefly until the pane's first snapshot has settled.
  const start = Date.now();
  let probe = null;
  for (;;) {
    probe = await getProfilePane(ctx.legA, 1);
    if (probe.mounted && (probe.tiles.length > 0 || probe.emptyStateHero)) {
      break;
    }
    if (Date.now() - start >= PANE_SETTLE_TIMEOUT_MS) {
      fail(1, `profile pane never settled within ${PANE_SETTLE_TIMEOUT_MS}ms -- last probe: ${JSON.stringify(probe)}`);
    }
    await sleep(200);
  }
  ctx.populatedProbe = probe;

  pass(1, `app launched against ${ctx.populatedHome}, Settings -> "profile" open, pane settled with ${probe.tiles.length} tiles`);
}

// -- step 2: assert the data+disabled branch EXACTLY against the fixture math, screenshot --

async function step2AssertPopulatedBranch(ctx) {
  const probe = await getProfilePane(ctx.legA, 2);
  const exp = ctx.expected;

  assert(2, probe.tiles.length === 5, `expected 5 tiles, got ${probe.tiles.length}: ${JSON.stringify(probe.tiles)}`);
  for (const tile of probe.tiles) {
    const expectedValue = exp.tiles[tile.label];
    assert(
      2,
      expectedValue !== undefined,
      `unexpected tile label "${tile.label}" -- known labels: ${Object.keys(exp.tiles).join(", ")}`,
    );
    assert(2, tile.value === expectedValue, `tile "${tile.label}" expected "${expectedValue}", got "${tile.value}"`);
  }

  assert(2, probe.insights.totalSessions === exp.totalSessions, `totalSessions expected ${exp.totalSessions}, got ${probe.insights.totalSessions}`);
  assert(2, probe.insights.totalRuns === exp.totalRuns, `totalRuns expected ${exp.totalRuns}, got ${probe.insights.totalRuns}`);
  assert(2, probe.insights.toolCalls === exp.toolCalls, `toolCalls expected ${exp.toolCalls}, got ${probe.insights.toolCalls}`);
  assert(2, probe.insights.subagentRuns === exp.subagentRuns, `subagentRuns expected ${exp.subagentRuns}, got ${probe.insights.subagentRuns}`);
  assert(2, probe.insights.mostUsedModel === exp.mostUsedModel, `mostUsedModel expected "${exp.mostUsedModel}", got "${probe.insights.mostUsedModel}"`);

  assert(2, probe.topTools.length === exp.topTools.length, `topTools expected ${JSON.stringify(exp.topTools)}, got ${JSON.stringify(probe.topTools)}`);
  for (let i = 0; i < exp.topTools.length; i += 1) {
    assert(2, probe.topTools[i] === exp.topTools[i], `topTools[${i}] expected "${exp.topTools[i]}", got "${probe.topTools[i]}"`);
  }

  assert(2, probe.heatmapNonEmptyCells === exp.heatmapNonEmptyCells, `heatmapNonEmptyCells expected ${exp.heatmapNonEmptyCells}, got ${probe.heatmapNonEmptyCells}`);

  assert(2, probe.truncated === false, `expected truncated:false, got ${probe.truncated}`);
  assert(2, probe.emptyStateHero === false, `expected emptyStateHero:false (data present), got ${probe.emptyStateHero}`);
  assert(2, probe.frozenBanner === true, `expected frozenBanner:true (data present + disabled), got ${probe.frozenBanner}`);
  assert(2, probe.telemetryEnabled === false, `expected telemetryEnabled:false (fixture config), got ${probe.telemetryEnabled}`);
  assert(2, probe.killSwitchActive === false, `expected killSwitchActive:false (no kill-switch env set), got ${probe.killSwitchActive}`);

  await saveScreenshot(ctx.legA, 2, POPULATED_SCREENSHOT);

  pass(2, `all 5 tiles + insights + topTools + heatmap(=3) EXACT vs fixture math; frozenBanner=true, emptyStateHero=false`);
}

// -- step 3: toggle telemetry on, assert probe + on-disk config (sibling preservation) --

async function step3ToggleAndAssertDisk(ctx) {
  const toggled = await apiAction(ctx.legA, 3, "/settings/profile/telemetry", {});
  assert(3, toggled.ok === true, `settings/profile/telemetry rejected: ${JSON.stringify(toggled)}`);

  const probe = await getProfilePane(ctx.legA, 3);
  assert(3, probe.telemetryEnabled === true, `expected telemetryEnabled:true after toggle, got ${probe.telemetryEnabled}`);

  const onDisk = JSON.parse(readFileSync(ctx.populatedConfigPath, "utf8"));
  assert(3, onDisk.telemetry?.enabled === true, `on-disk telemetry.enabled expected true, got ${JSON.stringify(onDisk.telemetry)}`);
  assert(
    3,
    deepEqualJson(onDisk.mcpServers, ctx.seededConfig.mcpServers),
    `on-disk sibling "mcpServers" key must be preserved byte-identically -- before=${JSON.stringify(ctx.seededConfig.mcpServers)} after=${JSON.stringify(onDisk.mcpServers)}`,
  );

  await quitLeg(ctx.legA);
  ctx.legA = null;

  pass(3, `telemetry toggled on (probe + on-disk config.json), sentinel "mcpServers" key byte-preserved; populated leg quit`);
}

// -- step 4: empty-dir leg -- a genuinely empty ANYCODE_PROFILE_HOME --

async function step4EmptyDirLeg(ctx) {
  const home = mkdtempSync(join(tmpdir(), "anycode-profile-smoke-empty-home-"));
  ctx.emptyHome = home;

  ctx.legB = { name: "empty" };
  await launchLeg(ctx.legB, 4, home);

  const start = Date.now();
  let probe = null;
  for (;;) {
    probe = await getProfilePane(ctx.legB, 4);
    if (probe.mounted && probe.emptyStateHero) {
      break;
    }
    if (Date.now() - start >= PANE_SETTLE_TIMEOUT_MS) {
      fail(4, `empty-dir profile pane never settled to emptyStateHero within ${PANE_SETTLE_TIMEOUT_MS}ms -- last probe: ${JSON.stringify(probe)}`);
    }
    await sleep(200);
  }

  assert(4, probe.emptyStateHero === true, `expected emptyStateHero:true for a genuinely empty home, got ${probe.emptyStateHero}`);
  assert(4, probe.tiles.length === 0, `expected zero tiles for the empty-dir leg, got ${JSON.stringify(probe.tiles)}`);
  assert(4, probe.insights.totalSessions === 0, `expected totalSessions:0, got ${probe.insights.totalSessions}`);
  assert(4, probe.insights.mostUsedModel === "", `expected mostUsedModel:"" (no session_start records), got "${probe.insights.mostUsedModel}"`);
  assert(4, probe.topTools.length === 0, `expected zero topTools, got ${JSON.stringify(probe.topTools)}`);
  assert(4, probe.heatmapNonEmptyCells === 0, `expected heatmapNonEmptyCells:0, got ${probe.heatmapNonEmptyCells}`);
  assert(4, probe.frozenBanner === false, `expected frozenBanner:false (hero, not banner) for an empty home, got ${probe.frozenBanner}`);

  await saveScreenshot(ctx.legB, 4, EMPTY_SCREENSHOT);

  pass(4, `empty ANYCODE_PROFILE_HOME (${home}) -> emptyStateHero:true, zero/absent tiles`);
}

// -- step 5: confirm both PNG evidence files landed on disk --

function step5ConfirmScreenshots() {
  for (const filePath of [POPULATED_SCREENSHOT, EMPTY_SCREENSHOT]) {
    assert(5, existsSync(filePath), `expected screenshot at ${filePath} to exist`);
    const size = readFileSync(filePath).length;
    assert(5, size > 0, `expected screenshot at ${filePath} to be non-empty, got ${size} bytes`);
  }
  pass(5, `both PNGs present and non-empty: ${POPULATED_SCREENSHOT}, ${EMPTY_SCREENSHOT}`);
}

// -- per-leg teardown --

async function quitLeg(leg) {
  if (!leg || leg.quitPromise) {
    return leg?.quitPromise;
  }
  leg.quitPromise = (async () => {
    if (leg.port && leg.token) {
      try {
        await api(leg, "POST", "/quit", {});
      } catch {
        // best-effort -- the app may already be gone.
      }
    }
    if (leg.child) {
      const exited = await waitForExit(leg.child, APP_EXIT_GRACE_MS);
      if (!exited) {
        console.warn(`[profile-ui-smoke] leg "${leg.name}" app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
        killTree(leg.child.pid, "SIGTERM");
        await sleep(SIGTERM_GRACE_MS);
        if (isPidAlive(leg.child.pid)) {
          console.warn(`[profile-ui-smoke] leg "${leg.name}" app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
          killTree(leg.child.pid, "SIGKILL");
        }
      }
    }
    if (leg.profile && existsSync(leg.profile) && !FLAGS.keep) {
      try {
        rmSync(leg.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[profile-ui-smoke] failed to remove ${leg.profile}: ${err?.message ?? err}`);
      }
    } else if (leg.profile && FLAGS.keep) {
      console.log(`[profile-ui-smoke] --keep set, preserved: ${leg.profile}`);
    }
  })();
  return leg.quitPromise;
}

// -- overall teardown --

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  await Promise.all([quitLeg(ctx.legA), quitLeg(ctx.legB)]);

  for (const dir of [ctx.populatedHome, ctx.emptyHome]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[profile-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[profile-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[profile-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// -- orchestration --

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[profile-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[profile-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    populatedHome: null,
    populatedConfigPath: null,
    seededConfig: null,
    expected: null,
    emptyHome: null,
    legA: null,
    legB: null,
    populatedProbe: null,
    teardownPromise: null,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1SeedFixtures(ctx);
    await step1BootPopulatedLeg(ctx);
    await step2AssertPopulatedBranch(ctx);
    await step3ToggleAndAssertDisk(ctx);
    await step4EmptyDirLeg(ctx);
    step5ConfirmScreenshots();
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[profile-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[profile-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

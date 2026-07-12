/**
 * Live GUI smoke for P7.23 F24 (design/slice-P7.23-cut.md §7 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Slash-command menu
 * probe/driver" section) and exercises the frozen 8-step scenario — the
 * composer's `/`-triggered command menu: full registry on open, fuzzy
 * filter + highlight, a real command dispatch (Plan mode -> `set_mode`),
 * the Esc/dismiss/no-match lifecycle, and a skill-row `$name ` insert.
 *
 * FULLY DETERMINISTIC — no live-model leg at all: every command this scenario
 * exercises is renderer-local or the single `set_mode` wire ack (design §5's
 * wire-delta-zero proof); no prompt is ever sent. `providerReady` comes from
 * the real, already-configured provider on the machine running this script
 * (same posture as `skills-ui-smoke.mjs`/other tab-creating smokes in this
 * directory — this smoke does not override `ANYCODE_SETTINGS_PATH`/
 * `ANYCODE_SECRETS_PATH`).
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted from
 * `skills-ui-smoke.mjs` (own temp workspace + own disposable profile +
 * `ANYCODE_SKILLS_IMPORT_HOME` fixture-home override, explicit `POST /tabs`
 * tab creation) and `profile-ui-smoke.mjs` (step/pass/fail bookkeeping,
 * `saveScreenshot` pre-paint settle delay). Plain node >=22, ZERO npm deps —
 * a NEW sibling, not an edit of any of them.
 *
 * Usage:   node apps/desktop/scripts/slash-menu-ui-smoke.mjs [--keep] [--port <n>]
 *
 *   --keep      Do not delete the temp workspace/home/profile dirs on exit
 *               (debugging).
 *   --port <n>  Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *               process.
 *
 * Each of the 8 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (full menu, filtered menu) is
 * written to the two fixed destinations below.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const TOTAL_STEPS = 8;
const LAUNCH_TIMEOUT_MS = 120_000;
const MODE_SETTLE_TIMEOUT_MS = 15_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const SKILL_NAME = "dark-mode-notes"; // collides with the "/mod" filter (design §7 step 1)

// -- fixed screenshot destinations (orchestrator-specified, design §7 W4) --
const FULL_MENU_SCREENSHOT = "/Users/incadawr/.claude/jobs/d551192e/tmp/w4-slash-full.png";
const FILTERED_MENU_SCREENSHOT = "/Users/incadawr/.claude/jobs/d551192e/tmp/w4-slash-filtered.png";

// -- the exact §2 command-table order (registry order = rank-tie order) --
const REGISTRY_NAMES = [
  "Plan mode",
  "Mode",
  "Model",
  "New task",
  "Sessions",
  "Git changes",
  "Terminal",
  "MCP",
  "Skills",
  "Settings",
];

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
      console.warn(`[slash-menu-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// -- small process/fs helpers (lifted from skills-ui-smoke.mjs / profile-ui-smoke.mjs) --

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

async function waitUntilTab(ctx, step, until, timeoutMs) {
  const body = { tabId: ctx.tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} for tab ${ctx.tabId} did not match: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Poll `GET /state` until the renderer facade has finished installing (DEV dynamic import races the page load) -- same readiness signal as every other `*-ui-smoke.mjs` in this directory. */
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

/* */
async function settledScreenshot(ctx, step, filePath) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[slash-menu-ui-smoke] screenshot "${filePath}" unavailable (HTTP ${resp.status})`);
      return false;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`[slash-menu-ui-smoke] screenshot "${filePath}" failed: ${err?.message ?? err}`);
    return false;
  }
}

// -- slash-menu facade helpers (automation/README.md "Slash-command menu probe/driver") --

async function slashState(ctx, step) {
  const resp = await api(ctx, "GET", `/tabs/${encodeURIComponent(ctx.tabId)}/slash-menu`);
  if (resp.status !== 200) {
    fail(step, `GET /tabs/${ctx.tabId}/slash-menu -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `slash-menu state not ok: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function typeSlash(ctx, step, text) {
  return apiAction(ctx, step, `/tabs/${encodeURIComponent(ctx.tabId)}/slash-menu/type`, { text });
}

async function keySlash(ctx, step, key) {
  return apiAction(ctx, step, `/tabs/${encodeURIComponent(ctx.tabId)}/slash-menu/key`, { key });
}

/**
 * Polls `GET /slash-menu` until `predicate` holds or `timeoutMs` elapses.
 * The Skills section is populated by Composer.tsx's open-transition effect
 * (`useEffect` keyed on `[slashOpen, slashTabId]` -> `window.anycode.skills.list`
 * -> `setSlashSkills`, cut §3) -- commands render synchronously the instant
 * the menu opens, but that fetch resolves a beat later, so a bare
 * `slashState()` read right after typing "/" can race it and see `[]`. This
 * is the harness-side wait for that fetch, not a product timing contract.
 */
async function waitForSlashState(ctx, step, predicate, label, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await slashState(ctx, step);
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `timed out after ${timeoutMs}ms waiting for ${label} (last state: ${JSON.stringify(last)})`);
    }
    await sleep(intervalMs);
  }
}

function skillMd({ name, description, body }) {
  return [`---`, `name: ${name}`, `description: ${description}`, `---`, body, ""].join("\n");
}

// -- step 1: seed fixtures + launch the app + create a tab + wait ready --

function step1SeedFixtures(ctx) {
  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-slash-menu-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "seed.txt"), "hello from slash-menu smoke\n");

  // Isolated skills-import home, standing in for ~ (design §7 step 1: one
  // enabled user skill named to collide with the "/mod" filter).
  ctx.skillsHome = mkdtempSync(join(tmpdir(), "anycode-slash-menu-smoke-home-"));
  const userSkillsDir = join(ctx.skillsHome, ".anycode", "skills", SKILL_NAME);
  mkdirSync(userSkillsDir, { recursive: true });
  writeFileSync(
    join(userSkillsDir, "SKILL.md"),
    skillMd({
      name: SKILL_NAME,
      description: "Notes about dark mode, for the slash-menu smoke.",
      body: "Body content for dark-mode-notes.",
    }),
  );

  // Not a `pass()` in its own right -- step 1's single PASS line (below, in
  // `step1LaunchAndCreateTab`) covers both fixture-seeding and the boot, so
  // `passCount` lands on exactly `TOTAL_STEPS` for a clean run (profile-ui-
  // smoke.mjs precedent).
  console.log(`[step 1] fixtures seeded: workspace=${ctx.workspace}, user skill "${SKILL_NAME}" at ${ctx.skillsHome}`);
}

async function step1LaunchAndCreateTab(ctx) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-slash-menu-smoke-profile-"));
  ctx.profile = profile;
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
    // dev/test-only override (automation/README.md "Slash-command menu
    // probe/driver" section) -- points the skills scan's `home` at our
    // disposable fixture directory instead of the real machine's `~`.
    // Production code path is unaffected (falls back to os.homedir() when
    // unset, and even this var is refused outside ANYCODE_AUTOMATION=1 &&
    // !isPackaged).
    ANYCODE_SKILLS_IMPORT_HOME: ctx.skillsHome,
  };
  delete env.ANYCODE_WORKSPACE; // this smoke creates its own tab explicitly (below)
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
    const candidate = readDiscoveryFile(profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(1, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${profileAutomationInfo} (startedAt > ${t0})`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;

  await waitForFacade(ctx, 1);

  const created = await apiOk(ctx, 1, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(1, created?.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  ctx.tabId = created.tabId;
  await waitUntilTab(ctx, 1, { connection: "ready" }, 60_000);

  pass(1, `app launched (pid=${info.pid}), tab ${ctx.tabId} ready for ${ctx.workspace}`);
}

// -- step 2: type "/" -> full registry + Skills section, screenshot --

async function step2FullMenu(ctx) {
  await typeSlash(ctx, 2, "/");

  const state = await slashState(ctx, 2);
  assert(2, state.open === true, `expected menu open, got: ${JSON.stringify(state)}`);
  assert(2, state.selectedIndex === 0, `expected selectedIndex 0, got ${state.selectedIndex}`);
  assert(2, state.query === "", `expected empty query, got ${JSON.stringify(state.query)}`);

  const commandItems = state.items.filter((item) => item.section === "commands");
  const commandNames = commandItems.map((item) => item.name);
  assert(
    2,
    JSON.stringify(commandNames) === JSON.stringify(REGISTRY_NAMES),
    `expected registry order ${JSON.stringify(REGISTRY_NAMES)}, got ${JSON.stringify(commandNames)}`,
  );

  const withSkills = await waitForSlashState(
    ctx,
    2,
    (s) => s.items.some((item) => item.section === "skills"),
    "Skills section to populate after the open-transition fetch",
  );

  const skillItems = withSkills.items.filter((item) => item.section === "skills");
  assert(2, skillItems.length === 1, `expected exactly 1 skill row, got ${JSON.stringify(skillItems)}`);
  assert(2, skillItems[0].name === SKILL_NAME, `expected skill row "${SKILL_NAME}", got ${JSON.stringify(skillItems[0])}`);
  assert(2, skillItems[0].sourceLabel === "Personal", `expected sourceLabel "Personal", got ${JSON.stringify(skillItems[0].sourceLabel)}`);

  await settledScreenshot(ctx, 2, FULL_MENU_SCREENSHOT);

  pass(2, `menu open, ${commandNames.length} commands in registry order, Skills section has "${SKILL_NAME}" (Personal)`);
}

// -- step 3: type "/mod" -> filtered order + highlight, screenshot --

async function step3FilteredMenu(ctx) {
  await typeSlash(ctx, 3, "/mod");

  const state = await slashState(ctx, 3);
  assert(3, state.open === true, `expected menu open after "/mod", got: ${JSON.stringify(state)}`);
  assert(3, state.query === "mod", `expected query "mod", got ${JSON.stringify(state.query)}`);

  const modelIndex = state.items.findIndex((item) => item.name === "Model");
  const planModeIndex = state.items.findIndex((item) => item.name === "Plan mode");
  assert(3, modelIndex >= 0, `"Model" missing from filtered items: ${JSON.stringify(state.items)}`);
  assert(3, planModeIndex >= 0, `"Plan mode" missing from filtered items: ${JSON.stringify(state.items)}`);
  assert(3, modelIndex < planModeIndex, `expected "Model" (${modelIndex}) before "Plan mode" (${planModeIndex})`);
  assert(3, state.items[modelIndex].highlighted === true, `"Model" row expected highlighted`);
  assert(3, state.items[planModeIndex].highlighted === true, `"Plan mode" row expected highlighted`);

  const withSkill = await waitForSlashState(
    ctx,
    3,
    (s) => s.items.some((item) => item.section === "skills" && item.name === SKILL_NAME),
    `skill row "${SKILL_NAME}" to survive the "/mod" filter`,
  );
  const skillItem = withSkill.items.find((item) => item.section === "skills" && item.name === SKILL_NAME);
  assert(3, skillItem !== undefined, `expected skill row "${SKILL_NAME}" to survive the "/mod" filter (substring match): ${JSON.stringify(withSkill.items)}`);
  assert(3, skillItem.highlighted === true, `"${SKILL_NAME}" row expected highlighted`);

  await settledScreenshot(ctx, 3, FILTERED_MENU_SCREENSHOT);

  pass(3, `filtered to ${withSkill.items.length} rows, "Model"(${modelIndex}) before "Plan mode"(${planModeIndex}), all matches highlighted`);
}

// -- step 4: arrow to "Plan mode", Enter -> real set_mode ack, draft cleared, menu closed --

async function step4SelectPlanMode(ctx) {
  const before = await slashState(ctx, 4);
  const targetIndex = before.items.findIndex((item) => item.name === "Plan mode");
  assert(4, targetIndex >= 0, `"Plan mode" not present before arrowing: ${JSON.stringify(before.items)}`);

  for (let i = 0; i < targetIndex; i += 1) {
    await keySlash(ctx, 4, "ArrowDown");
  }
  const positioned = await slashState(ctx, 4);
  assert(4, positioned.selectedIndex === targetIndex, `expected selectedIndex ${targetIndex} after arrowing, got ${positioned.selectedIndex}`);

  const stateBefore = await apiOk(ctx, 4, "GET", `/state/${ctx.tabId}`);
  const modeBefore = stateBefore?.snapshot?.states?.[ctx.tabId]?.mode;
  const expectedMode = modeBefore === "plan" ? "build" : "plan";

  await keySlash(ctx, 4, "Enter");

  let liveMode;
  const deadline = Date.now() + MODE_SETTLE_TIMEOUT_MS;
  for (;;) {
    const live = await apiOk(ctx, 4, "GET", `/state/${ctx.tabId}`);
    liveMode = live?.snapshot?.states?.[ctx.tabId]?.mode;
    if (liveMode === expectedMode) {
      break;
    }
    if (Date.now() >= deadline) {
      fail(4, `mode never settled on "${expectedMode}" within ${MODE_SETTLE_TIMEOUT_MS}ms (last=${liveMode})`);
    }
    await sleep(150);
  }

  const after = await slashState(ctx, 4);
  assert(4, after.open === false, `expected menu closed after Enter, got: ${JSON.stringify(after)}`);
  assert(4, after.draft === "", `expected draft cleared, got ${JSON.stringify(after.draft)}`);

  pass(4, `"Plan mode" selected (index ${targetIndex}), snapshot mode="${liveMode}" (wire-real), draft cleared, menu closed`);
}

// -- step 5: Esc dismiss / no-match / query-change reopen lifecycle --

async function step5EscLifecycle(ctx) {
  await typeSlash(ctx, 5, "/");
  const opened = await slashState(ctx, 5);
  assert(5, opened.open === true, `expected menu open before Esc, got: ${JSON.stringify(opened)}`);

  await keySlash(ctx, 5, "Escape");
  const dismissed = await slashState(ctx, 5);
  assert(5, dismissed.open === false, `expected menu closed after Esc, got: ${JSON.stringify(dismissed)}`);
  assert(5, dismissed.draft === "/", `expected draft still "/", got ${JSON.stringify(dismissed.draft)}`);

  await typeSlash(ctx, 5, "/zzzz");
  const noMatch = await slashState(ctx, 5);
  assert(5, noMatch.open === false, `expected menu to stay closed on a zero-match query, got: ${JSON.stringify(noMatch)}`);

  await typeSlash(ctx, 5, "/mod");
  const reopened = await slashState(ctx, 5);
  assert(5, reopened.open === true, `expected menu to reopen after a query change (dismissed cleared), got: ${JSON.stringify(reopened)}`);

  pass(5, `Esc dismissed (draft preserved), "/zzzz" stayed closed (0 matches), "/mod" reopened (query change cleared dismissed)`);
}

// -- step 6: skill insert -> "$dark-mode-notes " --

async function step6SkillInsert(ctx) {
  await typeSlash(ctx, 6, `/${SKILL_NAME.slice(0, 4)}`); // "/dark"

  const state = await waitForSlashState(
    ctx,
    6,
    (s) => s.open === true && s.items.some((item) => item.section === "skills" && item.name === SKILL_NAME),
    `menu open with skill row "${SKILL_NAME}" after "/dark"`,
  );
  assert(6, state.open === true, `expected menu open after "/dark", got: ${JSON.stringify(state)}`);
  const skillIndex = state.items.findIndex((item) => item.section === "skills" && item.name === SKILL_NAME);
  assert(6, skillIndex >= 0, `skill row "${SKILL_NAME}" missing after "/dark": ${JSON.stringify(state.items)}`);

  for (let i = 0; i < skillIndex; i += 1) {
    await keySlash(ctx, 6, "ArrowDown");
  }
  await keySlash(ctx, 6, "Enter");

  const after = await slashState(ctx, 6);
  assert(6, after.open === false, `expected menu closed after skill insert, got: ${JSON.stringify(after)}`);
  const expectedDraft = `$${SKILL_NAME} `;
  assert(6, after.draft === expectedDraft, `expected draft ${JSON.stringify(expectedDraft)}, got ${JSON.stringify(after.draft)}`);

  pass(6, `skill row selected, draft="${after.draft}"`);
}

// -- step 7: no-match -> closed, no swallow --

async function step7NoMatch(ctx) {
  await typeSlash(ctx, 7, "/zzz");
  const state = await slashState(ctx, 7);
  assert(7, state.open === false, `expected menu closed on a zero-match query, got: ${JSON.stringify(state)}`);
  assert(7, state.draft === "/zzz", `expected draft "/zzz" preserved (no swallow), got ${JSON.stringify(state.draft)}`);

  pass(7, `"/zzz" (0 matches) left the menu closed, draft preserved`);
}

// -- step 8: confirm both PNG evidence files landed on disk --

function step8ConfirmScreenshots() {
  for (const filePath of [FULL_MENU_SCREENSHOT, FILTERED_MENU_SCREENSHOT]) {
    assert(8, existsSync(filePath), `expected screenshot at ${filePath} to exist`);
    const size = readFileSync(filePath).length;
    assert(8, size > 0, `expected screenshot at ${filePath} to be non-empty, got ${size} bytes`);
  }
  pass(8, `both PNGs present and non-empty: ${FULL_MENU_SCREENSHOT}, ${FILTERED_MENU_SCREENSHOT}`);
}

// -- teardown --

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  if (ctx.port && ctx.token) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort -- the app may already be gone.
    }
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[slash-menu-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[slash-menu-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.workspace, ctx.skillsHome, ctx.profile]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[slash-menu-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[slash-menu-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[slash-menu-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// -- orchestration --

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[slash-menu-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[slash-menu-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    workspace: null,
    skillsHome: null,
    profile: null,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    teardownPromise: null,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1SeedFixtures(ctx);
    await step1LaunchAndCreateTab(ctx);
    await step2FullMenu(ctx);
    await step3FilteredMenu(ctx);
    await step4SelectPlanMode(ctx);
    await step5EscLifecycle(ctx);
    await step6SkillInsert(ctx);
    await step7NoMatch(ctx);
    step8ConfirmScreenshots();
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[slash-menu-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[slash-menu-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

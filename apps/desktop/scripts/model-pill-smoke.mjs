/**
 * Live GUI smoke for P7.15 F14 (design/slice-P7.15-cut.md §5): drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Model pill probe/driver"
 * section) and exercises the frozen 7-step scenario — the unified model+
 * effort pill's label/menu, the ack-gated per-provider persist (§2.4), the
 * LIVE between-turns guard negative (§2.1), and the owner-pain proof that a
 * brand-new chat inherits the last-picked effort instead of defaulting back
 * to "off".
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `reasoning-ui-smoke.mjs` / `todo-panel-smoke.mjs` (same P7.H per-run
 * disposable profile discipline). The sequential-Read-tool delay-chain
 * technique (`readChainPrompt`) is lifted verbatim from `queue-smoke.mjs`'s
 * own comment/rationale — a real multi-turn prompt is the only reliable way
 * to hold a turn "running" long enough to observe the between-turns guard
 * live. Plain node >=22, ZERO npm deps — a NEW sibling, not an edit of any of
 * them.
 *
 * Usage:   node apps/desktop/scripts/model-pill-smoke.mjs [--attach] [--keep] [--port <n>] [--settings-path <path>]
 *
 *   --attach            Do not spawn a dev instance — read the live discovery
 *                        file (~/.anycode/automation.json) of one already
 *                        running. Teardown then only closes the tabs this
 *                        script created; it does NOT quit an app it did not
 *                        launch. Without an explicit --settings-path this
 *                        mode CANNOT prove the disk-persist assertions (steps
 *                        3/7) — the script WARNS and skips just those reads
 *                        rather than guessing at (or worse, clobbering) some
 *                        other instance's settings.json.
 *   --keep              Do not delete the temp workspace(s)/profile on exit
 *                        (debugging).
 *   --port <n>           Forwarded as ANYCODE_AUTOMATION_PORT to the spawned
 *                        dev process (ignored with --attach).
 *   --settings-path <p>  The absolute settings.json path the (attached)
 *                        instance was booted with — required to read disk
 *                        evidence under --attach; ignored otherwise (the
 *                        script always knows its own spawned profile's path).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider — read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL). `ANYCODE_MODEL` and
 * `ANYCODE_REASONING_EFFORT` are then DELETED from the child env after
 * loading that file — design §5's explicit anti-false-green requirement:
 * either var left in place would override the settings.json ladder this

 * default inheritance this smoke is FOR.
 *
 * Each of the 7 frozen steps (design §5) prints `[step N] PASS/FAIL <detail>`;
 * the first FAIL tears down and exits 1. PNG evidence is written to
 * `apps/desktop/out/model-pill-smoke/step-*.png` (settled >=400ms before every

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
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2"; // reasoning:true, effortLevels off/high/max (catalog-data.ts)
const MODEL_B = "glm-4.6"; // non-reasoning — no effort segment, no Effort row

/**
 * A chain of SEQUENTIAL Read tool calls forces multiple real round trips
 * (host filesystem read + a fresh model completion per step), so wall-clock
 * latency compounds into a several-second turn even against a fast backend —
 * lifted verbatim from queue-smoke.mjs (same rationale: a single text
 * generation, however long, can complete before a single poll cycle ever
 * catches it "running"). Read is readOnly/needsApproval:false
 * (`packages/core/src/tools/read.ts`), so this needs no permission-mode
 * change and never opens a permission_request this script would have to
 * answer.
 */
const READ_FILE_COUNT = 12;

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

const TURN_A_PROMPT = readChainPrompt("noteA", READ_FILE_COUNT, "done-a"); // sent on glm-5.2 (steps 4/5)
const TURN_B_PROMPT = readChainPrompt("noteB", READ_FILE_COUNT, "done-b"); // sent on glm-4.6 (step 6)

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { attach: false, keep: false, port: undefined, settingsPath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--attach") {
      flags.attach = true;
    } else if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else if (arg === "--settings-path") {
      i += 1;
      flags.settingsPath = argv[i];
    } else {
      console.warn(`[model-pill-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from reasoning-ui-smoke.mjs / queue-smoke.mjs) ──

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
      console.warn(`[model-pill-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    ctx.mkdirScreenshotDir();
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[model-pill-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/* */
async function settledScreenshot(ctx, name) {
  await sleep(400);
  return saveScreenshot(ctx, name);
}

// ── model-pill facade helpers (automation/README.md "Model pill probe/driver") ──

async function pillState(ctx, step, tabId) {
  const resp = await api(ctx, "GET", `/tabs/${encodeURIComponent(tabId)}/model-pill`);
  if (resp.status !== 200) {
    fail(step, `GET /tabs/${tabId}/model-pill -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `model-pill state not ok: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

/** Drives a pick WITHOUT asserting acceptance — some calls in this scenario (step 4) expect a refusal. */
async function pillPick(ctx, step, tabId, pick) {
  const resp = await api(ctx, "POST", `/tabs/${encodeURIComponent(tabId)}/model-pill/pick`, pick);
  if (resp.status !== 200) {
    fail(step, `POST /tabs/${tabId}/model-pill/pick ${JSON.stringify(pick)} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function pillPickOk(ctx, step, tabId, pick) {
  const result = await pillPick(ctx, step, tabId, pick);
  assert(step, result?.ok === true, `pick ${JSON.stringify(pick)} rejected: ${JSON.stringify(result)}`);
  return result;
}

/** Reads+parses settings.json straight off disk — the ack-gated persist proof (design §2.4/§5). Returns null (with a warning) when no settings path is known (unguarded --attach). */
function readSettingsDisk(ctx, step) {
  if (ctx.settingsPath === undefined) {
    console.warn(`[model-pill-smoke] step ${step}: no known settings.json path (--attach without --settings-path) — skipping disk read`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(ctx.settingsPath, "utf8"));
  } catch (err) {
    fail(step, `failed to read/parse settings.json at ${ctx.settingsPath}: ${err?.message ?? err}`);
  }
}

// ── step 1: bootstrap a temp profile/workspace + launch (or attach to) the dev app, seed settings.json ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-model-pill-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from model-pill smoke\n");
    for (let i = 1; i <= READ_FILE_COUNT; i += 1) {
      writeFileSync(join(ctx.tmpWorkspace, readFileName("noteA", i)), `note A file ${i}\n`);
      writeFileSync(join(ctx.tmpWorkspace, readFileName("noteB", i)), `note B file ${i}\n`);
    }
    ctx.tmpWorkspace2 = mkdtempSync(join(tmpdir(), "anycode-model-pill-smoke-ws2-"));
    writeFileSync(join(ctx.tmpWorkspace2, "seed.txt"), "second tab workspace\n");
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
    ctx.settingsPath = FLAGS.settingsPath; // may be undefined — readSettingsDisk warns+skips
    if (ctx.settingsPath === undefined) {
      console.warn(
        "[model-pill-smoke] --attach without --settings-path: this run CANNOT verify the on-disk persist " +
          "(steps 3/7) — it will only check the live facade/pill state.",
      );
    }
    pass(1, `attached to running app (pid=${info.pid}, port=${info.port}); temp workspaces=${ctx.tmpWorkspace}, ${ctx.tmpWorkspace2}`);
    return;
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4 + slice-P7.15-cut.md
  // §2.6 W0): isolates userData/db/discovery AND settings.json/secrets.json so
  // this run's persisted model/effort defaults never collide with (or clobber)
  // a parallel smoke, a manual dev session, or the owner's real settings.
  const profile = mkdtempSync(join(tmpdir(), "anycode-model-pill-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  // Seed shape mirrors settings/schema.ts's DEFAULT_SETTINGS exactly, plus the
  // provider selection this scenario needs pre-set (design §5 setup): a
  // catalog id ("z-ai") + its boot model (glm-5.2) — no `provider.defaults`
  // yet, so step 1's "No thinking" reading is a genuinely fresh boot, not a
  // stale leftover default.
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
  // Design §5's explicit anti-false-green requirement: either var left in the
  // child env would override the settings.json provider/effort ladder this

  // default inheritance this smoke is FOR. Deleted AFTER merging secretsEnv
  // (whose ANYCODE_MODEL, if present, would otherwise reintroduce exactly
  // this masking) and after copying the caller's own ambient process.env
  // (which might also carry a leftover ANYCODE_REASONING_EFFORT from a prior
  // manual run).
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

// ── step 1 (cont'd): discover the boot tab, wait ready, read the initial pill ──

async function step1PillInitial(ctx) {
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

  const state = await pillState(ctx, 1, ctx.tabId);
  assert(1, state.present === true, `pill not present: ${JSON.stringify(state)}`);
  assert(1, state.label === "GLM-5.2 · No thinking", `unexpected initial label: ${JSON.stringify(state.label)}`);
  assert(1, state.currentModel === MODEL_A, `unexpected currentModel: ${state.currentModel}`);
  assert(1, state.effortRowVisible === true, "effort row should be visible for a reasoning-capable model");

  const filePath = await settledScreenshot(ctx, "step-1-pill-initial");
  assert(1, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(1, `tab ${ctx.tabId} ready, pill label="${state.label}"`);
}

// ── step 2: open the menu, assert Model/Effort rows + effort values + disabled Manage-models ──

async function step2MenuOpen(ctx) {
  const opened = await pillPickOk(ctx, 2, ctx.tabId, { kind: "open" });
  assert(2, opened.ok === true, "open pick was refused");

  const state = await pillState(ctx, 2, ctx.tabId);
  assert(2, state.menuOpen === true, "menu did not report open after the pick");
  assert(2, state.page === "root", `expected root page, got ${state.page}`);
  assert(2, state.effortRowVisible === true, "Effort row should be visible on glm-5.2");
  assert(2, JSON.stringify(state.effortItems) === JSON.stringify(["off", "high", "max"]), `unexpected effort values: ${JSON.stringify(state.effortItems)}`);
  assert(2, state.manageModelsDisabled === true, "Manage-models row should be disabled");
  assert(2, state.modelItems.some((m) => m.id === MODEL_A), "model list missing glm-5.2");
  assert(2, state.modelItems.some((m) => m.id === MODEL_B), "model list missing glm-4.6");

  const filePath = await settledScreenshot(ctx, "step-2-menu-open");
  assert(2, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(2, `menu open on root page, ${state.modelItems.length} model(s), effort=${JSON.stringify(state.effortItems)}`);
}

// ── step 3: pick effort high, assert the pill label + the on-disk ack-gated persist ──

async function step3PickEffortHigh(ctx) {
  await pillPickOk(ctx, 3, ctx.tabId, { kind: "effort", value: "high" });

  // Give the ack-gated persist's fire-and-forget settings.set() a moment to
  // land on disk before reading it back.
  let state;
  for (let i = 0; i < 20; i += 1) {
    state = await pillState(ctx, 3, ctx.tabId);
    if (state.label === "GLM-5.2 · High") {
      break;
    }
    await sleep(150);
  }
  assert(3, state.label === "GLM-5.2 · High", `pill did not settle on High: ${JSON.stringify(state.label)}`);

  const disk = await pollSettingsDiskUntil(ctx, 3, (s) => s?.provider?.defaults?.[PROVIDER_ID]?.reasoningEffort === "high");
  if (disk !== null) {
    assert(3, disk.provider.defaults[PROVIDER_ID].reasoningEffort === "high", "settings.json missing persisted high effort");
  }

  const filePath = await settledScreenshot(ctx, "step-3-pill-high");
  assert(3, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(3, `pill label="${state.label}"${disk ? `, disk defaults[${PROVIDER_ID}]=${JSON.stringify(disk.provider.defaults[PROVIDER_ID])}` : " (disk check skipped)"}`);
}

/** Polls settings.json on disk until `predicate` matches or a short deadline elapses — the persist write is fire-and-forget (design §2.4), so the first read can race it. Returns null (not a failure) when no settings path is known. */
async function pollSettingsDiskUntil(ctx, step, predicate, timeoutMs = 5_000) {
  if (ctx.settingsPath === undefined) {
    console.warn(`[model-pill-smoke] step ${step}: no known settings.json path — skipping disk assertion`);
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = readSettingsDisk(ctx, step);
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `settings.json at ${ctx.settingsPath} never matched the expected shape: ${JSON.stringify(last)}`);
    }
    await sleep(150);
  }
}

// ── step 4: start a real multi-turn prompt, and WHILE running, assert the between-turns guard refuses a model pick ──

async function step4GuardNegative(ctx) {
  const sent = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/prompt`, { text: TURN_A_PROMPT });
  assert(4, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "running" }, 60_000);

  const refused = await pillPick(ctx, 4, ctx.tabId, { kind: "model", value: MODEL_B });
  assert(4, refused?.ok === false, `expected the pick to be REFUSED while running, got: ${JSON.stringify(refused)}`);
  assert(4, refused.reason === "pick_disabled", `expected reason "pick_disabled", got: ${JSON.stringify(refused)}`);

  const liveState = await apiOk(ctx, 4, "GET", `/state/${ctx.tabId}`);
  const liveModel = liveState?.snapshot?.states?.[ctx.tabId]?.model;
  assert(4, liveModel === MODEL_A, `model changed under a running turn (between-turns guard breach): ${liveModel}`);

  await waitUntilTab(ctx, 4, ctx.tabId, { turnStatus: "idle" }, 120_000);
  pass(4, `pick refused (${refused.reason}) while running; model stayed ${liveModel}; turn A settled`);
}

// ── step 5: after completion, pick glm-4.6 for real — assert /state + the pill's no-effort-segment shape ──

async function step5PickModelB(ctx) {
  await pillPickOk(ctx, 5, ctx.tabId, { kind: "model", value: MODEL_B });

  let live;
  for (let i = 0; i < 20; i += 1) {
    live = await apiOk(ctx, 5, "GET", `/state/${ctx.tabId}`);
    if (live?.snapshot?.states?.[ctx.tabId]?.model === MODEL_B) {
      break;
    }
    await sleep(150);
  }
  assert(5, live?.snapshot?.states?.[ctx.tabId]?.model === MODEL_B, `model did not switch to ${MODEL_B}`);

  const state = await pillState(ctx, 5, ctx.tabId);
  assert(5, state.currentModel === MODEL_B, `pill currentModel mismatch: ${state.currentModel}`);
  assert(5, state.effortRowVisible === false, "effort row should be hidden for non-reasoning glm-4.6");
  assert(5, !state.label.includes("·"), `pill label should carry no effort segment: ${JSON.stringify(state.label)}`);

  const filePath = await settledScreenshot(ctx, "step-5-pill-glm46");
  assert(5, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(5, `model switched to ${MODEL_B}, pill label="${state.label}" (no effort segment)`);
}

// ── step 6: a second real turn ON glm-4.6, to completion — proves the new port actually serves traffic ──

async function step6SecondTurn(ctx) {
  const sent = await apiOk(ctx, 6, "POST", `/tabs/${ctx.tabId}/prompt`, { text: TURN_B_PROMPT });
  assert(6, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, 6, ctx.tabId, { turnStatus: "running" }, 60_000);
  await waitUntilTab(ctx, 6, ctx.tabId, { transcriptIncludes: "done-b" }, 120_000);
  await waitUntilTab(ctx, 6, ctx.tabId, { turnStatus: "idle" }, 60_000);
  pass(6, 'second turn on glm-4.6 completed ("done-b" observed in the transcript)');
}

// ── step 7: switch back to glm-5.2 + effort max, open a SECOND tab (new host fork) — the owner-pain inheritance proof ──

async function step7SecondTabInherits(ctx) {
  await pillPickOk(ctx, 7, ctx.tabId, { kind: "model", value: MODEL_A });
  await pillPickOk(ctx, 7, ctx.tabId, { kind: "effort", value: "max" });

  let state;
  for (let i = 0; i < 20; i += 1) {
    state = await pillState(ctx, 7, ctx.tabId);
    if (state.label === "GLM-5.2 · Max") {
      break;
    }
    await sleep(150);
  }
  assert(7, state.label === "GLM-5.2 · Max", `tab 1 pill did not settle on GLM-5.2 · Max: ${JSON.stringify(state.label)}`);

  const disk = await pollSettingsDiskUntil(
    ctx,
    7,
    (s) => s?.provider?.defaults?.[PROVIDER_ID]?.model === MODEL_A && s?.provider?.defaults?.[PROVIDER_ID]?.reasoningEffort === "max",
  );


  // re-reads settings.json fresh per fork) on a DISTINCT workspace: reusing
  // tab 1's workspace would hit tabs.ts's `already_open` session->workspace
  // binding refusal instead of proving anything about inheritance.
  const created = await apiOk(ctx, 7, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace2 });
  assert(7, created?.ok === true, `second tab creation failed: ${JSON.stringify(created)}`);
  ctx.tabId2 = created.tabId;
  await waitUntilTab(ctx, 7, ctx.tabId2, { connection: "ready" });
  // ModelPill only mounts inside the ACTIVE tab's chat UI (App.tsx's
  // ActiveTabBody) — addTab does NOT switch focus away from an already-active
  // tab 1, so the new tab must be explicitly selected before its pill is probed.
  await apiAction(ctx, 7, `/tabs/${ctx.tabId2}/select`, {});

  const tab2Live = await apiOk(ctx, 7, "GET", `/state/${ctx.tabId2}`);
  const tab2Model = tab2Live?.snapshot?.states?.[ctx.tabId2]?.model;
  assert(7, tab2Model === MODEL_A, `new tab did not boot on the inherited model: ${tab2Model}`);

  const tab2State = await pillState(ctx, 7, ctx.tabId2);
  assert(7, tab2State.label === "GLM-5.2 · Max", `new tab's pill did not inherit the persisted effort: ${JSON.stringify(tab2State.label)}`);

  const filePath = await settledScreenshot(ctx, "step-7-second-tab-inherited");
  assert(7, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(
    7,
    `new tab ${ctx.tabId2} booted with model=${tab2Model}, pill="${tab2State.label}"` +
      (disk ? `, disk defaults[${PROVIDER_ID}]=${JSON.stringify(disk.provider.defaults[PROVIDER_ID])}` : " (disk check skipped)"),
  );
}

// ── teardown ──

/**
 * Thin memoizing wrapper around `runTeardown` (codex P7.3-F2 finding 3 /
 * transcript-follow-smoke.mjs precedent): every caller (normal end-of-run()
 * and the SIGINT/SIGTERM handler) awaits the SAME shared promise, so a signal
 * landing while teardown is already mid-flight genuinely waits for that real
 * work instead of racing it.
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
      } else {
        for (const tabId of [ctx.tabId2, ctx.tabId].filter((id) => typeof id === "string")) {
          const closeResp = await api(ctx, "POST", `/tabs/${tabId}/close`, {});
          if (closeResp.body?.ok !== true) {
            tabCloseFailed = true;
            console.warn(
              `[model-pill-smoke] tab ${tabId} close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
                "a tab may still be open on a temp workspace; leaving both on disk instead of deleting out from under it",
            );
          }
        }
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[model-pill-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[model-pill-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const ws of [ctx.tmpWorkspace, ctx.tmpWorkspace2].filter((w) => typeof w === "string")) {
    if (!existsSync(ws)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[model-pill-smoke] --keep set, workspace preserved at: ${ws}`);
    } else if (tabCloseFailed) {
      console.warn(`[model-pill-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ws}`);
    } else {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[model-pill-smoke] failed to remove temp workspace ${ws}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[model-pill-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[model-pill-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[model-pill-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[model-pill-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[model-pill-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    tmpWorkspace2: null,
    port: undefined,
    token: undefined,
    tabId: null,
    tabId2: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "model-pill-smoke"),
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
    await step1PillInitial(ctx);
    await step2MenuOpen(ctx);
    await step3PickEffortHigh(ctx);
    await step4GuardNegative(ctx);
    await step5PickModelB(ctx);
    await step6SecondTurn(ctx);
    await step7SecondTabInherits(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[model-pill-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[model-pill-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

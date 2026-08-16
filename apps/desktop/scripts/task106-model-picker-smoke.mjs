/**
 * Live GUI smoke for TASK.106 cut-1 (design: grouped all-connections model
 * picker on the New Session start screen): drives a REAL Electron dev
 * instance over the automation HTTP channel (`main/automation/*`, see
 * `automation/README.md`'s "Start screen" section, "Model-menu (TASK.106
 * cut-1)" subsection) through the full live path — two z-ai connections
 * created via the real Settings drawer, the New Session model popover
 * grouped by connection, a real click-select of a model from the NON-default
 * connection's group, then a real prompt dispatched through the picked
 * connection's host fork, and finally a disk-backed proof that picking a
 * task-scoped model never mutates the GLOBAL default connection.
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `start-screen-smoke.mjs` (per-run disposable profile discipline); the
 * Settings-drawer connection-creation sequence is lifted from
 * `provider-connections-ui-smoke.mjs`'s phase 1 (steps 3/4 for the FIRST
 * connection via the embedded WelcomeScreen drawer, step 7 for the SECOND via
 * the Settings dialog's Add tile) — both proven live sequences, not
 * reinvented here.
 *
 * Usage:   node apps/desktop/scripts/task106-model-picker-smoke.mjs [--keep] [--port <n>]
 *
 *   --keep       Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n>   Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev process.
 *
 * Requires `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines:
 * ANYCODE_API_KEY / ANYCODE_MODEL / ANYCODE_BASE_URL) for a real `z-ai`
 * catalog credential — both connections use the SAME key (independent
 * credentials aren't the point of this slice; the grouped-by-connection
 * picker is).
 *
 * Each step prints `[step N] PASS/FAIL <detail>`; the first FAIL tears down
 * and exits 1. PNG evidence is written to a per-run directory under the
 * system temp folder.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const SMOKE_SECRETS_PATH = join(repoRoot, ".smoke-secrets", "glm.env");
const TOTAL_STEPS = 9;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const PROVIDER_ID = "z-ai";

const FIRST_PROMPT_TEXT = "Reply with exactly one word: pong";

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
      console.warn(`[task106-model-picker-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from start-screen-smoke.mjs) ──

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

/** Minimal KEY=VALUE .env parser (flat, hand-written 3-line file). */
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

// ── HTTP helpers against the automation channel ──

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

/** Polls `GET /settings/provider` until `predicate` matches (store-vs-DOM settle gap, provider-connections-ui-smoke precedent). */
async function pollProviderState(ctx, step, predicate, timeoutMs = 20_000) {
  let last = null;
  const result = await pollUntil(timeoutMs, 150, async () => {
    const resp = await api(ctx, "GET", "/settings/provider");
    if (resp.status === 200) {
      last = resp.body;
    }
    return resp.status === 200 && predicate(resp.body) ? resp.body : undefined;
  });
  assert(step, result !== null, `GET /settings/provider predicate never matched within ${timeoutMs}ms; last seen: ${JSON.stringify(last)}`);
  return result;
}

async function getStartScreenState(ctx, step) {
  const resp = await api(ctx, "GET", "/start-screen");
  if (resp.status !== 200) {
    fail(step, `GET /start-screen -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /start-screen rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function getModelMenuState(ctx, step) {
  const resp = await api(ctx, "GET", "/start-screen/model-menu");
  if (resp.status !== 200) {
    fail(step, `GET /start-screen/model-menu -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  if (resp.body?.ok !== true) {
    fail(step, `GET /start-screen/model-menu rejected: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

function readJsonDisk(step, path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(step, `failed to read/parse ${label} at ${path}: ${err?.message ?? err}`);
  }
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[task106-model-picker-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[task106-model-picker-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

// ── step 1: bootstrap disposable profile + launch dev, NO connections at boot ──
// (mirrors provider-connections-ui-smoke.mjs phase 1: providerReady false,
// tabs.length 0 -> WelcomeScreen mounts with its embedded drawer already open
// in "template" stage — the ONLY boot shape reaching that real empty state,
// which this script then drives through to create connection "Main".)

async function step1LaunchApp(ctx) {
  let secretsEnv;
  try {
    secretsEnv = parseEnvFile(readFileSync(SMOKE_SECRETS_PATH, "utf8"));
  } catch (err) {
    fail(1, `failed to read GLM smoke secrets at ${SMOKE_SECRETS_PATH}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `missing ANYCODE_API_KEY in ${SMOKE_SECRETS_PATH}`);
  ctx.apiKey = secretsEnv.ANYCODE_API_KEY;
  ctx.model = secretsEnv.ANYCODE_MODEL && secretsEnv.ANYCODE_MODEL.length > 0 ? secretsEnv.ANYCODE_MODEL : "glm-5.2";

  const profile = mkdtempSync(join(tmpdir(), "anycode-task106-model-picker-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
  };
  delete env.ANYCODE_API_KEY;
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_BASE_URL;
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
  await apiOk(ctx, 1, "GET", "/health");
  await waitForFacade(ctx, 1);
  pass(1, `app launched (pid=${info.pid}), facade ready after ${Date.now() - t0}ms on port ${info.port}, profile=${profile}`);
}

// ── step 2: create connection "Main" via WelcomeScreen's embedded drawer ──

async function step2CreateMainConnection(ctx) {
  const step = 2;
  const state = await pollProviderState(ctx, step, (s) => s.drawer.open === true && s.drawer.embedded === true);
  assert(step, state.mounted === false, `expected the Settings-dialog grid NOT mounted on a Welcome boot, got mounted=${state.mounted}`);
  assert(step, state.drawer.stage === "template", `expected stage="template" before any connection exists, got ${state.drawer.stage}`);

  const setResult = await apiOk(ctx, step, "POST", "/settings/provider/drawer/set", {
    providerId: PROVIDER_ID,
    label: "Main",
  });
  assert(step, setResult.ok === true, `drawer/set (template fields) rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, step, "POST", "/settings/provider/drawer/submit", {});
  assert(step, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);

  const afterCreate = await pollProviderState(ctx, step, (s) => s.drawer.stage === "credential");
  assert(step, afterCreate.drawer.providerId === PROVIDER_ID, `expected providerId="${PROVIDER_ID}" to survive creation, got ${afterCreate.drawer.providerId}`);

  // The Model field only renders post-creation (ConnectionDrawer.tsx:761,
  // gated on createdConnectionId !== null) — set it here, once the drawer has
  // moved to the "credential" stage, not in the pre-creation template set above.
  const setKey = await apiOk(ctx, step, "POST", "/settings/provider/drawer/set", { apiKey: ctx.apiKey, model: ctx.model });
  assert(step, setKey.ok === true, `drawer/set (apiKey + model) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, step, "POST", "/settings/provider/drawer/save-key", {});
  assert(step, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);

  const unmounted = await pollUntil(20_000, 300, async () => {
    const s = await api(ctx, "GET", "/settings/provider");
    return s.status === 200 && s.body?.drawer?.open === false ? s.body : undefined;
  });
  assert(step, unmounted !== null, "WelcomeScreen's embedded drawer never closed within 20s of saving Main's key");

  const settingsDisk = readJsonDisk(step, ctx.settingsPath, "settings.json");
  const connections = settingsDisk?.provider?.connections ?? [];
  assert(step, connections.length === 1, `expected exactly 1 persisted connection on disk, got ${connections.length}`);
  ctx.mainConnId = connections[0].id;
  assert(step, settingsDisk.provider.activeConnectionId === ctx.mainConnId, `expected Main to auto-activate as the sole connection, got activeConnectionId=${settingsDisk.provider.activeConnectionId}`);

  pass(step, `connection "Main" created (${ctx.mainConnId}, providerId=${PROVIDER_ID}, model=${ctx.model}), auto-activated as the default connection`);
}

// ── step 3: create connection "Second" via the Settings dialog's Add tile ──

async function step3CreateSecondConnection(ctx) {
  const step = 3;
  const openResult = await apiOk(ctx, step, "POST", "/settings/open", {});
  assert(step, openResult.ok === true, `settings/open rejected: ${JSON.stringify(openResult)}`);
  const paneResult = await apiOk(ctx, step, "POST", "/settings/pane", { paneId: "provider" });
  assert(step, paneResult.ok === true, `settings/pane provider rejected: ${JSON.stringify(paneResult)}`);
  await pollProviderState(ctx, step, (s) => s.mounted === true && s.rows.length === 1);

  const addResult = await apiOk(ctx, step, "POST", "/settings/provider/add", {});
  assert(step, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);

  const setResult = await apiOk(ctx, step, "POST", "/settings/provider/drawer/set", {
    providerId: PROVIDER_ID,
    label: "Second",
  });
  assert(step, setResult.ok === true, `drawer/set rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, step, "POST", "/settings/provider/drawer/submit", {});
  assert(step, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);
  await pollProviderState(ctx, step, (s) => s.drawer.stage === "credential");

  // Model field is post-creation only (ConnectionDrawer.tsx:761) — same fix as step2.
  const setKey = await apiOk(ctx, step, "POST", "/settings/provider/drawer/set", { apiKey: ctx.apiKey, model: ctx.model });
  assert(step, setKey.ok === true, `drawer/set (apiKey + model) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, step, "POST", "/settings/provider/drawer/save-key", {});
  assert(step, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
  const closeResult = await apiOk(ctx, step, "POST", "/settings/provider/drawer/close", {});
  assert(step, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const state = await pollProviderState(ctx, step, (s) => s.rows.length === 2);
  const rowSecond = state.rows.find((r) => r.connectionId !== ctx.mainConnId);
  assert(step, rowSecond !== undefined, `second connection tile not found: ${JSON.stringify(state.rows)}`);
  ctx.secondConnId = rowSecond.connectionId;

  const settingsDisk = readJsonDisk(step, ctx.settingsPath, "settings.json");
  assert(step, settingsDisk.provider.activeConnectionId === ctx.mainConnId, `creating a SECOND connection must not steal the default — expected activeConnectionId=${ctx.mainConnId}, got ${settingsDisk.provider.activeConnectionId}`);

  await apiOk(ctx, step, "POST", "/settings/close", {});
  pass(step, `connection "Second" created (${ctx.secondConnId}) via the Settings grid's Add tile; Main (${ctx.mainConnId}) remains the default`);
}

// ── step 4: two connections confirmed on disk + via GET /settings/provider ──

async function step4ConfirmTwoConnections(ctx) {
  const step = 4;
  // rows[] are a DOM read of the Settings grid — step 3 closed the dialog at
  // its tail, so re-open the pane first (`mounted:false` would read rows:[]).
  await apiOk(ctx, step, "POST", "/settings/open", {});
  await apiOk(ctx, step, "POST", "/settings/pane", { paneId: "provider" });
  const resp = await pollProviderState(ctx, step, (s) => s.mounted === true && s.rows.length === 2);
  pass(step, `GET /settings/provider confirms 2 rows (${resp.rows.map((r) => r.displayName).join(", ")})`);
  await apiOk(ctx, step, "POST", "/settings/close", {});
}

// ── step 5: open the New Session draft on a temp workspace, open the model-menu popover, assert two groups ──

async function step5OpenDraftAndModelMenu(ctx) {
  const step = 5;
  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-task106-model-picker-ws-"));
  writeFileSync(join(ctx.workspace, "seed.txt"), "hello from task106 model-picker smoke\n");

  await apiAction(ctx, step, "/start-screen/open", { workspace: ctx.workspace });
  const draft = await getStartScreenState(ctx, step);
  assert(step, draft.active === true, `expected active:true after open, got ${JSON.stringify(draft)}`);

  const openResult = await apiOk(ctx, step, "POST", "/start-screen/model-menu", { open: true });
  assert(step, openResult.ok === true, `open model-menu rejected: ${JSON.stringify(openResult)}`);

  const menuState = await getModelMenuState(ctx, step);
  assert(step, menuState.open === true, `expected model-menu open:true, got ${JSON.stringify(menuState)}`);
  assert(step, Array.isArray(menuState.groups) && menuState.groups.length === 2, `expected exactly 2 groups (one per connection), got ${menuState.groups?.length}: ${JSON.stringify(menuState.groups)}`);

  const groupLabels = menuState.groups.map((g) => g.label);
  assert(step, groupLabels.includes("Main"), `expected a group labeled "Main", got labels=${JSON.stringify(groupLabels)}`);
  assert(step, groupLabels.includes("Second"), `expected a group labeled "Second", got labels=${JSON.stringify(groupLabels)}`);

  for (const group of menuState.groups) {
    assert(step, Array.isArray(group.items) && group.items.length > 0, `expected group "${group.label}" (${group.connectionId}) to have at least one model item, got ${JSON.stringify(group.items)}`);
  }

  const secondGroup = menuState.groups.find((g) => g.connectionId === ctx.secondConnId);
  assert(step, secondGroup !== undefined, `expected a group with connectionId===${ctx.secondConnId} (Second), got connectionIds=${JSON.stringify(menuState.groups.map((g) => g.connectionId))}`);
  ctx.secondGroup = secondGroup;

  await saveScreenshot(ctx, "1-model-menu-open-two-groups");
  pass(step, `New Session model-menu popover shows 2 groups: ${groupLabels.join(", ")}, each with >=1 model item`);
}

// ── step 6: select a model from the "Second" connection's group via a real click-driven select ──

async function step6SelectFromSecondGroup(ctx) {
  const step = 6;
  const pickedItem = ctx.secondGroup.items[0];
  assert(step, typeof pickedItem?.id === "string" && pickedItem.id.length > 0, `expected a real model id in the Second group, got ${JSON.stringify(pickedItem)}`);
  ctx.pickedModelId = pickedItem.id;
  ctx.pickedModelName = pickedItem.name;

  const selectResult = await apiOk(ctx, step, "POST", "/start-screen/model-menu/select", {
    connectionId: ctx.secondConnId,
    modelId: ctx.pickedModelId,
  });
  assert(step, selectResult.ok === true, `model-menu/select rejected: ${JSON.stringify(selectResult)}`);

  const draft = await getStartScreenState(ctx, step);
  assert(step, draft.model === ctx.pickedModelId, `expected draft.model===${ctx.pickedModelId} after select, got ${JSON.stringify(draft.model)}`);

  const closedMenu = await getModelMenuState(ctx, step);
  assert(step, closedMenu.open === false, `expected the model-menu popover to close after a successful select, got open=${closedMenu.open}`);

  await saveScreenshot(ctx, "2-model-chip-picked-second");
  pass(step, `selected model "${ctx.pickedModelId}" (name="${ctx.pickedModelName}") from connection "Second" (${ctx.secondConnId}) via a real row click; draft.model confirms the pick`);
}

// ── step 7: submit the prompt through the picked connection, wait for a live assistant reply ──

async function step7SubmitAndWaitForReply(ctx) {
  const step = 7;
  await apiAction(ctx, step, "/start-screen/prompt", { text: FIRST_PROMPT_TEXT });
  const afterPrompt = await getStartScreenState(ctx, step);
  assert(step, afterPrompt.prompt === FIRST_PROMPT_TEXT, `expected prompt to echo back, got ${JSON.stringify(afterPrompt)}`);
  assert(step, afterPrompt.sendEnabled === true, `expected sendEnabled:true (workspace set at open + non-blank prompt), got ${JSON.stringify(afterPrompt)}`);

  const submitResult = await apiOk(ctx, step, "POST", "/start-screen/submit", {});
  assert(step, submitResult.ok === true, `submit rejected: ${JSON.stringify(submitResult)}`);
  ctx.tabId = submitResult.tabId;
  assert(step, typeof ctx.tabId === "string" && ctx.tabId.length > 0, `expected a tabId, got ${JSON.stringify(submitResult)}`);

  await waitUntilTab(ctx, step, ctx.tabId, { connection: "ready" }, 60_000);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle", transcriptIncludes: FIRST_PROMPT_TEXT }, 120_000);

  const stateResp = await apiOk(ctx, step, "GET", `/state/${ctx.tabId}`);
  const finalTabState = stateResp?.snapshot?.states?.[ctx.tabId];
  const transcript = finalTabState?.transcript ?? [];
  assert(step, transcript.length > 0, `expected a non-empty transcript, got ${JSON.stringify(transcript)}`);
  const head = transcript[0];
  assert(step, head?.kind === "user_text" && head?.text === FIRST_PROMPT_TEXT, `expected the head block to be the exact submitted prompt, got ${JSON.stringify(head)}`);
  assert(step, transcript.length > 1, `expected at least one assistant block after the head user_text, got only ${transcript.length} block(s) — the host never replied`);

  await saveScreenshot(ctx, "3-session-after-submit");
  pass(step, `first turn ran on tab ${ctx.tabId}: head=user_text(${JSON.stringify(head.text)}), ${transcript.length} block(s) total, a live assistant reply landed`);
}

// ── step 8: pin proof — the task-scoped pick must never mutate the GLOBAL default connection ──

async function step8ConfirmDefaultConnectionUnchanged(ctx) {
  const step = 8;
  // rows[] are a DOM read of the Settings grid — reopen the pane first
  // (`mounted:false` after step 7's session view would read rows:[]).
  await apiOk(ctx, step, "POST", "/settings/open", {});
  await apiOk(ctx, step, "POST", "/settings/pane", { paneId: "provider" });
  const resp = await pollProviderState(ctx, step, (s) => s.mounted === true && s.rows.length === 2);
  const rowMain = resp.rows.find((r) => r.connectionId === ctx.mainConnId);
  assert(step, rowMain !== undefined, `Main connection tile missing from GET /settings/provider: ${JSON.stringify(resp.rows)}`);
  assert(step, rowMain.selected === true, `expected Main (${ctx.mainConnId}) to STILL be the selected/default connection after picking a Second-group model for the task, got selected=${rowMain.selected}`);

  pass(step, `GET /settings/provider confirms Main is still the selected/default connection (selected:true) after the task-model pick`);
}

// ── step 9: disk-backed pin proof — settings.json's activeConnectionId still points at Main ──

async function step9ConfirmDiskActiveConnection(ctx) {
  const step = 9;
  const settingsDisk = readJsonDisk(step, ctx.settingsPath, "settings.json");
  assert(
    step,
    settingsDisk.provider.activeConnectionId === ctx.mainConnId,
    `expected settings.json provider.activeConnectionId===${ctx.mainConnId} (Main), got ${settingsDisk.provider.activeConnectionId}`,
  );
  pass(step, `settings.json on disk confirms provider.activeConnectionId===${ctx.mainConnId} (Main) — the task-scoped model pick never touched the global default`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
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
      console.warn(`[task106-model-picker-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[task106-model-picker-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const [label, dir] of [
    ["workspace", ctx.workspace],
    ["profile", ctx.profile],
  ]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[task106-model-picker-smoke] --keep set, ${label} preserved at: ${dir}`);
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[task106-model-picker-smoke] failed to remove ${label} at ${dir}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[task106-model-picker-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[task106-model-picker-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[task106-model-picker-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    apiKey: null,
    model: null,
    port: undefined,
    token: undefined,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: null,
    secretsPath: null,
    mainConnId: null,
    secondConnId: null,
    workspace: null,
    tabId: null,
    pickedModelId: null,
    pickedModelName: null,
    secondGroup: null,
    teardownPromise: null,
    screenshotDir: mkdtempSync(join(tmpdir(), "anycode-task106-model-picker-evidence-")),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2CreateMainConnection(ctx);
    await step3CreateSecondConnection(ctx);
    await step4ConfirmTwoConnections(ctx);
    await step5OpenDraftAndModelMenu(ctx);
    await step6SelectFromSecondGroup(ctx);
    await step7SubmitAndWaitForReply(ctx);
    await step8ConfirmDefaultConnectionUnchanged(ctx);
    await step9ConfirmDiskActiveConnection(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[task106-model-picker-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[task106-model-picker-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

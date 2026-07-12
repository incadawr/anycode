/**
 * Live GUI smoke for P7.24 F20 (design/slice-P7.24-cut.md §4 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Keyboard shortcuts pane
 * probe/driver" routes) exercising the Settings "Keyboard shortcuts" page:
 * defaults, re-recording a chord (probe + on-disk `keybindings.overrides`
 * persist), the rebind taking effect end-to-end through the REAL global
 * `App.tsx` `matchKeymap` dispatcher (and the OLD default no longer firing),
 * a conflict refusal, deletion to Unassigned, and Reset back to the built-in
 * default.
 *
 * Isolated profile (design §4 W4): userData/db/discovery AND
 * settings.json/secrets.json are all per-run disposable paths — this smoke
 * NEVER touches the owner's real `~/.anycode`. `settings.json` is not even
 * pre-seeded: `loadSettings` (settings/files.ts) treats a missing file as
 * "use defaults", so the first `setPatch` write creates it atomically.
 * `providerReady` (main's boot-tab gate) comes from a pair of DUMMY
 * `ANYCODE_API_KEY`/`ANYCODE_MODEL` env vars — `computeProviderReady`
 * (main/host-env.ts) only checks PRESENCE of an API key + model, never
 * validity, and this smoke never sends a prompt, so no live network call
 * ever touches this key. `ANYCODE_WORKSPACE` is pinned to a disposable tmp
 * dir so main's boot path (main/index.ts `startInitialTab` ->
 * `resolveWorkspace`) opens an auto-tab with no open-dir dialog — the shell
 * then has an active tab, which is what `App.tsx`'s global keymap dispatcher
 * and the Welcome-screen gate (`shouldShowWelcome`) both require in order to
 * exercise the real end-to-end shortcut-effect step (step 5).
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted from
 * `profile-ui-smoke.mjs` (same disposable-profile discipline).
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/keybindings-ui-smoke.mjs [--keep] [--port <n>]
 *
 *   --keep         Do not delete the temp profile/workspace dirs on exit
 *                   (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process.
 *
 * Each of the 8 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (default list, recorded state) is
 * written under the job tmp dir.
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
const SETTLE_TIMEOUT_MS = 15_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// -- fixed screenshot destinations (job tmp dir) --
const JOB_TMP_DIR = join(process.env.CLAUDE_JOB_DIR ?? tmpdir(), "tmp");
const DEFAULT_SCREENSHOT = join(JOB_TMP_DIR, "keybindings-default.png");
const RECORDED_SCREENSHOT = join(JOB_TMP_DIR, "keybindings-recorded.png");

const IS_DARWIN = process.platform === "darwin";

/** "⌘D" on darwin, "Ctrl+D" elsewhere — same `formatBinding` grammar as keymap.ts (mod-only, no shift, single letter). */
function glyph(key) {
  return IS_DARWIN ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

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
      console.warn(`[keybindings-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// -- small process/fs helpers (lifted from profile-ui-smoke.mjs) --

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

/** `api()` + hard-fail on transport error or non-200 (the request never even reached the facade). */
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

/** A POST action expected to succeed at the facade level too (`{ok:true, ...}`). */
async function apiAction(ctx, step, path, body) {
  const result = await apiOk(ctx, step, "POST", path, body);
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

/** Poll `pred()` (may be async) until it returns true or `timeoutMs` elapses. */
async function waitUntilTrue(pred, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  for (;;) {
    if (await pred()) {
      return true;
    }
    if (Date.now() - start >= timeoutMs) {
      return false;
    }
    await sleep(intervalMs);
  }
}

async function getShortcutsPane(ctx, step) {
  return apiOk(ctx, step, "GET", "/settings/shortcuts");
}

function findRow(pane, action) {
  return pane?.rows?.find((r) => r.action === action);
}

/** Reads the tab's `terminalOpen` flag straight off the renderer-plane `snapshot.tabs` array (the SAME `TabInfo[]` `SessionHeader.tsx`'s toggle button reads). */
async function readTerminalOpen(ctx, step) {
  const state = await apiOk(ctx, step, "GET", "/state?tail=0");
  const tab = state?.snapshot?.tabs?.find((t) => t.tabId === ctx.tabId);
  assert(step, tab !== undefined, `expected tab ${ctx.tabId} in snapshot.tabs, got ${JSON.stringify(state?.snapshot?.tabs)}`);
  return tab.terminalOpen;
}

/** Reads+parses the isolated settings.json straight off disk — the persist proof (design §4 W4). */
function readSettingsDisk(ctx, step) {
  try {
    return JSON.parse(readFileSync(ctx.settingsPath, "utf8"));
  } catch (err) {
    fail(step, `failed to read/parse settings.json at ${ctx.settingsPath}: ${err?.message ?? err}`);
  }
}

/** Best-effort PNG evidence via `GET /screenshot` -- never fails the step it's called from. A short settle delay first (subagents/profile-ui-smoke precedent): the DOM read above can observe React's committed state a frame or two before Electron's compositor has actually painted it. */
async function saveScreenshot(ctx, step, filePath) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[keybindings-ui-smoke] screenshot "${filePath}" unavailable (HTTP ${resp.status})`);
      return false;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`[keybindings-ui-smoke] screenshot "${filePath}" failed: ${err?.message ?? err}`);
    return false;
  }
}

// -- step 1: launch (isolated profile + dummy provider env + pinned boot workspace), open Settings -> "shortcuts" --

async function step1LaunchAndOpen(ctx) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-keybindings-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  // Deliberately NOT pre-created (design §4 W4): `loadSettings` treats ENOENT
  // as "use defaults", so a bare path inside the disposable profile is
  // enough -- the first `setPatch` write creates the file atomically.
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-keybindings-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "seed.txt"), "hello from keybindings smoke\n");

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ANYCODE_WORKSPACE: ctx.workspace,
    // Dummy provider credential (design §4 W4): `computeProviderReady`
    // (main/host-env.ts) only checks PRESENCE of an API key + model, never
    // validity -- this smoke never sends a prompt, so no live network call
    // ever touches this key. Present ONLY so main's boot-tab gate opens the
    // pinned ANYCODE_WORKSPACE tab with no open-dir dialog.
    ANYCODE_API_KEY: "sk-keybindings-smoke-dummy",
    ANYCODE_MODEL: "keybindings-smoke-dummy-model",
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

  await waitForFacade(ctx, 1);

  // The boot auto-tab (ANYCODE_WORKSPACE pinned, providerReady via dummy env)
  // -- discover it via GET /state rather than creating one explicitly.
  const found = await waitUntilTrue(async () => {
    const resp = await api(ctx, "GET", "/state?tail=0");
    if (resp.status !== 200) {
      return false;
    }
    const tab = resp.body?.snapshot?.tabs?.find((t) => t.workspace === ctx.workspace);
    if (tab) {
      ctx.tabId = tab.tabId;
      return true;
    }
    return false;
  }, SETTLE_TIMEOUT_MS);
  assert(1, found, `boot auto-tab for workspace ${ctx.workspace} never appeared within ${SETTLE_TIMEOUT_MS}ms`);

  const opened = await apiAction(ctx, 1, "/settings/open", {});
  assert(1, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);
  const selected = await apiAction(ctx, 1, "/settings/pane", { paneId: "shortcuts" });
  assert(1, selected.ok === true, `settings/pane("shortcuts") rejected: ${JSON.stringify(selected)}`);

  const pane = await getShortcutsPane(ctx, 1);
  assert(1, pane.mounted === true, `expected shortcuts pane mounted, got ${JSON.stringify(pane)}`);

  pass(1, `app launched (tab ${ctx.tabId}), Settings -> "shortcuts" open, pane mounted with ${pane.rows.length} rows`);
}

// -- step 2: assert defaults --

async function step2AssertDefaults(ctx) {
  const pane = await getShortcutsPane(ctx, 2);
  assert(2, pane.mounted === true, `expected mounted, got ${JSON.stringify(pane)}`);

  const sessionNew = findRow(pane, "session.new");
  assert(2, sessionNew !== undefined, `missing row "session.new"`);
  assert(2, sessionNew.editable === true, `expected session.new editable`);
  assert(
    2,
    JSON.stringify(sessionNew.bindings) === JSON.stringify([glyph("n")]),
    `expected session.new bindings [${glyph("n")}], got ${JSON.stringify(sessionNew.bindings)}`,
  );
  assert(2, sessionNew.overridden === false, `expected session.new not overridden`);

  const paletteSessions = findRow(pane, "palette.sessions");
  assert(2, paletteSessions !== undefined, `missing row "palette.sessions"`);
  assert(
    2,
    JSON.stringify(paletteSessions.bindings) === JSON.stringify([glyph("p"), glyph("g")]),
    `expected palette.sessions bindings [${glyph("p")}, ${glyph("g")}], got ${JSON.stringify(paletteSessions.bindings)}`,
  );

  const terminalToggle = findRow(pane, "terminal.toggle");
  assert(2, terminalToggle !== undefined, `missing row "terminal.toggle"`);
  assert(2, terminalToggle.editable === true, `expected terminal.toggle editable`);
  assert(
    2,
    JSON.stringify(terminalToggle.bindings) === JSON.stringify([glyph("j")]),
    `expected terminal.toggle bindings [${glyph("j")}], got ${JSON.stringify(terminalToggle.bindings)}`,
  );
  assert(2, terminalToggle.overridden === false, `expected terminal.toggle not overridden yet`);

  const tabActivate = findRow(pane, "tab.activate");
  assert(2, tabActivate !== undefined, `missing row "tab.activate"`);
  assert(2, tabActivate.editable === false, `expected tab.activate NOT editable (built-in, no pencil)`);

  const turnInterrupt = findRow(pane, "turn.interrupt");
  assert(2, turnInterrupt !== undefined, `missing row "turn.interrupt"`);
  assert(2, turnInterrupt.editable === false, `expected turn.interrupt NOT editable (built-in, no pencil)`);

  await saveScreenshot(ctx, 2, DEFAULT_SCREENSHOT);

  pass(
    2,
    `defaults verified: session.new=${JSON.stringify(sessionNew.bindings)}, palette.sessions=${JSON.stringify(paletteSessions.bindings)}, terminal.toggle=${JSON.stringify(terminalToggle.bindings)}; tab.activate/turn.interrupt read-only`,
  );
}

// -- step 3: record a NEW chord (mod+d) onto terminal.toggle, replacing its default slot --

async function step3RecordNewChord(ctx) {
  const started = await apiAction(ctx, 3, "/settings/shortcuts/record", { action: "terminal.toggle", slotIndex: 0 });
  assert(3, started.ok === true, `shortcuts/record rejected: ${JSON.stringify(started)}`);

  let pane = await getShortcutsPane(ctx, 3);
  let row = findRow(pane, "terminal.toggle");
  assert(3, row?.recording === true, `expected terminal.toggle recording=true after record start, got ${JSON.stringify(row)}`);

  const pressed = await apiOk(ctx, 3, "POST", "/settings/shortcuts/press", { key: "d", mod: true });
  assert(3, pressed?.ok === true, `shortcuts/press rejected: ${JSON.stringify(pressed)}`);

  const expected = glyph("d");
  const updated = await waitUntilTrue(async () => {
    pane = await getShortcutsPane(ctx, 3);
    row = findRow(pane, "terminal.toggle");
    return row !== undefined && row.recording === false && row.bindings.length === 1 && row.bindings[0] === expected;
  }, SETTLE_TIMEOUT_MS);
  assert(3, updated, `terminal.toggle badge never updated to "${expected}" within ${SETTLE_TIMEOUT_MS}ms -- last row: ${JSON.stringify(row)}`);
  assert(3, row.overridden === true, `expected terminal.toggle overridden=true after rebind, got ${JSON.stringify(row)}`);

  await saveScreenshot(ctx, 3, RECORDED_SCREENSHOT);

  pass(3, `terminal.toggle re-recorded: ${glyph("j")} -> ${expected}`);
}

// -- step 4: assert the override persisted to the isolated on-disk settings.json --

async function step4AssertDiskPersist(ctx) {
  const onDisk = readSettingsDisk(ctx, 4);
  const overrides = onDisk?.keybindings?.overrides;
  assert(4, Array.isArray(overrides), `expected keybindings.overrides array on disk, got ${JSON.stringify(onDisk?.keybindings)}`);
  const entry = overrides.find((o) => o.action === "terminal.toggle");
  assert(4, entry !== undefined, `expected an on-disk override entry for "terminal.toggle", got ${JSON.stringify(overrides)}`);
  assert(
    4,
    JSON.stringify(entry.bindings) === JSON.stringify(["mod+d"]),
    `expected on-disk bindings ["mod+d"], got ${JSON.stringify(entry.bindings)}`,
  );

  pass(4, `on-disk ${ctx.settingsPath} carries keybindings.overrides entry: ${JSON.stringify(entry)}`);
}

// -- step 5: the rebind takes effect END TO END through the REAL global dispatcher; the OLD default no longer fires --

async function step5AssertEffectTakesHold(ctx) {
  const closed = await apiAction(ctx, 5, "/settings/close", {});
  assert(5, closed.ok === true, `settings/close rejected: ${JSON.stringify(closed)}`);

  const initiallyClosed = await readTerminalOpen(ctx, 5);
  assert(5, initiallyClosed === false, `expected terminal initially closed before dispatching any chord, got terminalOpen=${initiallyClosed}`);

  // The NEW chord (mod+d) at the window level -- Settings is now closed, so
  // no dialog[open] airspace guard blocks App.tsx's real global matchKeymap
  // dispatcher from seeing it.
  const pressedNew = await apiOk(ctx, 5, "POST", "/settings/shortcuts/press", { key: "d", mod: true });
  assert(5, pressedNew?.ok === true, `shortcuts/press (new chord) rejected: ${JSON.stringify(pressedNew)}`);

  const opened = await waitUntilTrue(() => readTerminalOpen(ctx, 5), SETTLE_TIMEOUT_MS);
  assert(5, opened, `terminal never opened after dispatching the rebound chord (${glyph("d")}) within ${SETTLE_TIMEOUT_MS}ms`);

  // The OLD default chord (mod+j) must no longer trigger anything at all --
  // resolveKeymap (keymap.ts) drops its default row the moment the override
  // replaced it, so terminalOpen must stay exactly as it is (true).
  const pressedOld = await apiOk(ctx, 5, "POST", "/settings/shortcuts/press", { key: "j", mod: true });
  assert(5, pressedOld?.ok === true, `shortcuts/press (old chord) rejected: ${JSON.stringify(pressedOld)}`);
  await sleep(500); // a settle window with nothing to poll FOR -- absence of a state change is what's being proven.
  const stillOpen = await readTerminalOpen(ctx, 5);
  assert(
    5,
    stillOpen === true,
    `the OLD default chord (${glyph("j")}) changed terminalOpen (expected it to stay unaffected/true), got ${stillOpen}`,
  );

  pass(5, `rebound chord (${glyph("d")}) opened the terminal end-to-end via the REAL global dispatcher; old default (${glyph("j")}) no longer fires`);
}

// -- step 6: conflict refusal -- re-record session.new onto a chord already owned by palette.toggle --

async function step6ConflictRefusal(ctx) {
  const opened = await apiAction(ctx, 6, "/settings/open", {});
  assert(6, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);
  const selected = await apiAction(ctx, 6, "/settings/pane", { paneId: "shortcuts" });
  assert(6, selected.ok === true, `settings/pane("shortcuts") rejected: ${JSON.stringify(selected)}`);

  const started = await apiAction(ctx, 6, "/settings/shortcuts/record", { action: "session.new", slotIndex: 0 });
  assert(6, started.ok === true, `shortcuts/record rejected: ${JSON.stringify(started)}`);

  const pressed = await apiOk(ctx, 6, "POST", "/settings/shortcuts/press", { key: "k", mod: true });
  assert(6, pressed?.ok === true, `shortcuts/press rejected: ${JSON.stringify(pressed)}`);

  let pane = null;
  const refused = await waitUntilTrue(async () => {
    pane = await getShortcutsPane(ctx, 6);
    return typeof pane.errorText === "string" && pane.errorText.length > 0;
  }, SETTLE_TIMEOUT_MS);
  assert(6, refused, `expected an inline conflict error within ${SETTLE_TIMEOUT_MS}ms, last pane: ${JSON.stringify(pane)}`);
  assert(6, pane.errorText.includes("Already used by"), `expected errorText to mention "Already used by", got ${JSON.stringify(pane.errorText)}`);
  const conflictErrorText = pane.errorText; // captured before the cancel below overwrites `pane`

  let row = findRow(pane, "session.new");
  assert(6, row?.recording === true, `expected session.new still recording (a refusal keeps the chip open), got ${JSON.stringify(row)}`);
  assert(6, row.overridden === false, `expected session.new NOT overridden after a refused conflict, got ${JSON.stringify(row)}`);

  // Cancel the still-open recorder (Escape) so the pane is clean for step 7/8.
  const cancelled = await apiOk(ctx, 6, "POST", "/settings/shortcuts/press", { key: "Escape", mod: false });
  assert(6, cancelled?.ok === true, `shortcuts/press (Escape cancel) rejected: ${JSON.stringify(cancelled)}`);
  const cancelledSettled = await waitUntilTrue(async () => {
    pane = await getShortcutsPane(ctx, 6);
    return findRow(pane, "session.new")?.recording === false;
  }, SETTLE_TIMEOUT_MS);
  assert(6, cancelledSettled, `session.new recording never cancelled within ${SETTLE_TIMEOUT_MS}ms`);
  row = findRow(pane, "session.new");
  assert(
    6,
    JSON.stringify(row.bindings) === JSON.stringify([glyph("n")]),
    `expected session.new bindings unchanged [${glyph("n")}] after cancel, got ${JSON.stringify(row.bindings)}`,
  );

  pass(6, `conflict refused: ${JSON.stringify(conflictErrorText)}; session.new left un-overridden; recorder cancelled cleanly`);
}

// -- step 7: delete -- remove terminal.toggle's sole binding down to Unassigned --

async function step7DeleteToUnassigned(ctx) {
  let pane = await getShortcutsPane(ctx, 7);
  let row = findRow(pane, "terminal.toggle");
  assert(7, row !== undefined, `missing row "terminal.toggle"`);
  assert(7, row.bindings.length === 1, `expected terminal.toggle to carry exactly 1 binding before deletion, got ${JSON.stringify(row.bindings)}`);

  const removed = await apiAction(ctx, 7, "/settings/shortcuts/remove", { action: "terminal.toggle", slotIndex: 0 });
  assert(7, removed.ok === true, `shortcuts/remove rejected: ${JSON.stringify(removed)}`);

  const settled = await waitUntilTrue(async () => {
    pane = await getShortcutsPane(ctx, 7);
    row = findRow(pane, "terminal.toggle");
    return row !== undefined && row.unassigned === true;
  }, SETTLE_TIMEOUT_MS);
  assert(7, settled, `terminal.toggle never settled to Unassigned within ${SETTLE_TIMEOUT_MS}ms, last row: ${JSON.stringify(row)}`);
  assert(7, row.bindings.length === 0, `expected zero bindings, got ${JSON.stringify(row.bindings)}`);

  const onDisk = readSettingsDisk(ctx, 7);
  const entry = onDisk?.keybindings?.overrides?.find((o) => o.action === "terminal.toggle");
  assert(7, entry !== undefined, `expected an on-disk override entry for "terminal.toggle" after deletion, got ${JSON.stringify(onDisk?.keybindings)}`);
  assert(
    7,
    Array.isArray(entry.bindings) && entry.bindings.length === 0,
    `expected on-disk bindings:[] for terminal.toggle, got ${JSON.stringify(entry.bindings)}`,
  );

  pass(7, `terminal.toggle deleted to Unassigned; on-disk override carries explicit bindings:[]`);
}

// -- step 8: reset -- terminal.toggle back to its built-in default --

async function step8Reset(ctx) {
  const reset = await apiAction(ctx, 8, "/settings/shortcuts/reset", { action: "terminal.toggle" });
  assert(8, reset.ok === true, `shortcuts/reset rejected: ${JSON.stringify(reset)}`);

  let pane = null;
  let row = null;
  const settled = await waitUntilTrue(async () => {
    pane = await getShortcutsPane(ctx, 8);
    row = findRow(pane, "terminal.toggle");
    return row !== undefined && row.overridden === false;
  }, SETTLE_TIMEOUT_MS);
  assert(8, settled, `terminal.toggle never reset within ${SETTLE_TIMEOUT_MS}ms, last row: ${JSON.stringify(row)}`);
  assert(
    8,
    JSON.stringify(row.bindings) === JSON.stringify([glyph("j")]),
    `expected terminal.toggle back to default [${glyph("j")}], got ${JSON.stringify(row.bindings)}`,
  );
  assert(8, row.unassigned === false, `expected terminal.toggle no longer Unassigned after reset, got ${JSON.stringify(row)}`);

  const onDisk = readSettingsDisk(ctx, 8);
  const entry = onDisk?.keybindings?.overrides?.find((o) => o.action === "terminal.toggle");
  assert(8, entry === undefined, `expected NO on-disk override entry for "terminal.toggle" after reset, got ${JSON.stringify(entry)}`);

  pass(8, `terminal.toggle reset to default [${glyph("j")}]; on-disk override entry removed`);
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
      console.warn(`[keybindings-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[keybindings-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.profile, ctx.workspace]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[keybindings-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[keybindings-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[keybindings-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// -- orchestration --

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[keybindings-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[keybindings-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
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
    workspace: null,
    tabId: null,
    teardownPromise: null,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchAndOpen(ctx);
    await step2AssertDefaults(ctx);
    await step3RecordNewChord(ctx);
    await step4AssertDiskPersist(ctx);
    await step5AssertEffectTakesHold(ctx);
    await step6ConflictRefusal(ctx);
    await step7DeleteToUnassigned(ctx);
    await step8Reset(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[keybindings-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[keybindings-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

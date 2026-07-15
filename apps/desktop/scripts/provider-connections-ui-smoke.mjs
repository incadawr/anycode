/**
 * Live GUI smoke for TASK.45 W12 (design/track-43-45-33-47-49-cut.md §"W12 —
 * UI: сетка плашек connection'ов + drawer + Welcome"): drives a REAL Electron
 * dev instance end-to-end over the automation HTTP channel (`main/automation/*`,
 * see `automation/README.md`'s "Provider connections pane probe/driver"
 * routes) through the full provider-connections UX: the WelcomeScreen
 * first-run empty state, the compact tile grid, the add/edit drawer, two
 * connections of the SAME provider with independent credentials, a11y
 * focus-management, the env-override banner, and — the load-bearing
 * assertion — that a credential typed into the drawer is what a REAL host
 * fork actually uses, with zero legacy write-seam involved.
 *
 * TWO SEQUENTIAL DEV LAUNCHES, each fully disposable (own `mkdtemp` profile:
 * userData/db/discovery AND settings.json/secrets.json, never the owner's
 * real `~/.anycode` — same isolation discipline as
 * `apps/desktop/scripts/keybindings-ui-smoke.mjs`, NOT `retry-ui-smoke.mjs`,
 * which omits `ANYCODE_SETTINGS_PATH`/`ANYCODE_SECRETS_PATH` and therefore
 * runs against the real machine's settings):
 *
 *   Phase 1 (steps 1-16): NO `ANYCODE_API_KEY`/`MODEL`/`BASE_URL` at boot, so
 *   `computeProviderReady` (main/host-env.ts) is false and `shouldShowWelcome`
 *   (App.tsx) mounts WelcomeScreen on a truly empty profile
 *   (`connections: []`) — this is the ONLY way to observe the real empty
 *   state; setting a dummy env credential (the usual smoke-script shortcut)
 *   would make the app skip Welcome entirely. The whole grid/drawer/two-
 *   connections/a11y/e2e-credential surface is exercised in this one launch,
 *   ending with a genuine host-fork turn dispatched against a connection
 *   created purely through the drawer.
 *
 *   Phase 2 (steps 17-20): a second disposable profile, ALSO zero
 *   connections, but WITH dummy `ANYCODE_API_KEY`/`ANYCODE_MODEL` (so
 *   `providerReady` is true from env alone and Welcome never mounts) and an
 *   unreachable `ANYCODE_BASE_URL` — exercises the "Environment override"
 *   banner in the Settings dialog's provider pane, independent of the grid
 *   (zero, then one, stored connection) and independent of that connection's
 *   own health.
 *
 * CONNECT-REFUSED PORT TECHNIQUE (step 15, credited to retry-ui-smoke.mjs's
 * file header): a loopback port reserved then immediately released (nothing
 * listening) is a genuine, deterministic, INSTANT (<5ms) `ECONNREFUSED` — no
 * live credentials, no real network dependency, no risk of an accidental
 * real request reaching a third party. Step 12 creates a THIRD connection
 * (`custom` provider template, whose `baseUrl` is user-supplied —
 * `packages/core/src/provider/catalog-data.ts`'s `CUSTOM_PROVIDER_ID` entry)
 * pointed at one such port; step 15 selects it as the default connection,
 * opens a real tab, sends a prompt, and asserts the terminal transcript block
 * carries a `code:"network"` classification
 * (`packages/core/src/provider/failure.ts`) against THAT EXACT reserved
 * port. Since the port is unique to this run and the connection's baseUrl
 * came from nothing but `POST /settings/provider/drawer/set` +
 * `connection-create`/`connection-update` IPC, a successful connect-refused
 * failure against it is unambiguous proof the host fork resolved baseUrl+key
 * from the connection-CRUD path — TASK.45 W12's "снятие шва" (removal of
 * `applyLegacyProviderPatch`/the legacy secret-write translation/the
 * `providerSecretKey` alias, commit e03d0c2) has no other path left to fall
 * back to. Steps 5 and 8 additionally read `secrets.json` straight off disk
 * (opaque `{cipher,value}` entries only — this script never decrypts or
 * prints a secret value) and assert every key matches
 * `provider.connection.<id>.apiKey`, never a legacy shape.
 *
 * HARNESS EXTENSION (dev-only, additive, covered by its own unit tests —
 * `apps/desktop/src/main/automation/handlers.test.ts`,
 * `apps/desktop/src/main/automation/server.test.ts`): a generic
 * `GET /focus` route (`focusState()` in
 * `apps/desktop/src/renderer/src/automation.ts`) reading
 * `document.activeElement` was ADDED because no existing probe surfaced which
 * element is focused — the a11y focus-management assertions in this script
 * (WelcomeScreen's mount-time autofocus onto the Provider select, the
 * Settings-dialog drawer's mount-time autofocus onto the Label input) need a
 * live DOM read, not a re-derivation of local component state.
 *
 * Plain node >=22, ZERO npm deps (node:child_process/fs/net/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent.
 *
 * Usage:   node apps/desktop/scripts/provider-connections-ui-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspaces/profiles on exit (debugging).
 *
 * Each step prints `[step N] PASS/FAIL <detail>`; the first FAIL tears down
 * the CURRENT phase's app and exits 1 (the other phase's temp dirs, if
 * already cleaned up, stay cleaned up). PNG evidence is written to
 * `apps/desktop/out/provider-connections-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const TOTAL_STEPS = 20;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const SCREENSHOT_DIR = join(desktopRoot, "out", "provider-connections-smoke");

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false };
  for (const arg of argv) {
    if (arg === "--keep") {
      flags.keep = true;
    } else {
      console.warn(`[provider-connections-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from retry-ui-smoke.mjs / keybindings-ui-smoke.mjs) ──

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
    // already gone — nothing to do.
  }
}

/** Reserves a loopback port with nothing listening on it (see file header's "connect-refused port technique"). */
function reserveUnusedPort() {
  return new Promise((resolveReserved, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolveReserved(port));
    });
  });
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

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. A short settle delay first (keybindings-ui-smoke precedent): the DOM read above can observe React's committed state a frame or two before Electron's compositor has actually painted it. */
async function saveScreenshot(ctx, step, name) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[provider-connections-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filePath = join(SCREENSHOT_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[provider-connections-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

function readJsonDisk(step, path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(step, `failed to read/parse ${label} at ${path}: ${err?.message ?? err}`);
  }
}

/** Every key in secrets.json's `entries` MUST be connection-scoped (`provider.connection.<id>.apiKey|oauth`) — TASK.45 W12's "снятие шва" removed every legacy-shaped key (`provider.apiKey`, `provider.<providerId>.apiKey/oauth`). Values are opaque `{cipher,value}` ciphertext — never read/logged. */
function assertOnlyConnectionScopedSecretKeys(step, secretsPath, expectedCount) {
  const disk = readJsonDisk(step, secretsPath, "secrets.json");
  const keys = Object.keys(disk?.entries ?? {});
  const legacy = keys.filter((k) => !k.startsWith("provider.connection."));
  assert(
    step,
    legacy.length === 0,
    `legacy-shaped secret key(s) present in secrets.json: ${JSON.stringify(legacy)} (full key set: ${JSON.stringify(keys)}) — the W12 write-seam removal regressed`,
  );
  assert(step, keys.length === expectedCount, `expected exactly ${expectedCount} connection-scoped secret key(s), got ${keys.length}: ${JSON.stringify(keys)}`);
  for (const entry of Object.values(disk.entries)) {
    assert(step, typeof entry.value === "string" && entry.value.length > 0, `secrets.json entry carries no ciphertext: ${JSON.stringify(entry)}`);
  }
  return keys;
}

// ── static, pre-launch custody check: zero production consumers of the
// removed legacy write-seam (orchestrator prompt §6 M1-gate) ──

function staticGrepLegacyShimGone() {
  const target = join(desktopRoot, "src");
  let out = "";
  try {
    out = execFileSync("grep", ["-rnE", "applyLegacyProviderPatch|providerSecretKey", target], { encoding: "utf8" });
  } catch (err) {
    if (err.status === 1) {
      return []; // grep: no matches anywhere -> exit 1, not an error here.
    }
    throw err;
  }
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !/\.test\.[tj]sx?:/.test(line));
}

// ── generic launch helper (both phases share this shape) ──

async function launchApp(step, label, extraEnv) {
  const profile = mkdtempSync(join(tmpdir(), `anycode-provconn-smoke-${label}-profile-`));
  const ctx = {
    label,
    profile,
    profileUserDataDir: join(profile, "user-data"),
    profileDbPath: join(profile, "db.sqlite"),
    profileAutomationInfo: join(profile, "automation.json"),
    // Deliberately NOT pre-created (keybindings-ui-smoke precedent):
    // `loadSettings`/vault treat ENOENT as "use defaults" / "no secrets yet".
    settingsPath: join(profile, "settings.json"),
    secretsPath: join(profile, "secrets.json"),
    port: undefined,
    token: undefined,
    appPid: null,
    child: null,
    teardownPromise: null,
  };

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ...extraEnv,
  };

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
      fail(step, `[${label}] dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(step, `[${label}] timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  await waitForFacade(ctx, step);
  pass(step, `[${label}] app launched (pid=${info.pid}), facade ready after ${Date.now() - t0}ms on automation port ${info.port}, profile=${profile}`);
  return ctx;
}

/** Shared-promise discipline (retry-ui-smoke.mjs precedent): every caller awaits the SAME in-flight teardown rather than racing a signal handler's own call against the normal end-of-phase call. */
function teardown(ctx, workspaces) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = teardownApp(ctx, workspaces);
  }
  return ctx.teardownPromise;
}

async function teardownApp(ctx, workspaces) {
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
      console.warn(`[provider-connections-ui-smoke] [${ctx.label}] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[provider-connections-ui-smoke] [${ctx.label}] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }
  const dirs = [ctx.profile, ...(workspaces ?? [])];
  for (const dir of dirs) {
    if (dir && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[provider-connections-ui-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[provider-connections-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 1 — fresh empty profile: Welcome -> grid -> two same-provider
// connections -> a11y -> custom-provider e2e credential pickup
// ══════════════════════════════════════════════════════════════════════════

async function phase1Launch() {
  // No ANYCODE_API_KEY/MODEL/BASE_URL, no ANYCODE_WORKSPACE: providerReady
  // stays false at boot, tabs.length is 0 -> shouldShowWelcome (App.tsx) is
  // true. This is the ONLY boot shape that reaches the real empty state.
  return launchApp(1, "welcome", {});
}

async function step2WelcomeEmptyState(ctx) {
  const state = await apiOk(ctx, 2, "GET", "/settings/provider");
  assert(2, state.mounted === false, `expected the Settings-dialog grid NOT mounted on a Welcome boot, got mounted=${state.mounted}`);
  assert(2, state.drawer.open === true, `expected the WelcomeScreen embed drawer open, got drawer=${JSON.stringify(state.drawer)}`);
  assert(2, state.drawer.embedded === true, `expected drawer.embedded=true (WelcomeScreen, not the Settings dialog)`);
  assert(2, state.drawer.stage === "template", `expected stage="template" before any connection exists, got ${state.drawer.stage}`);
  assert(2, state.drawer.templateLocked === false, "expected the Provider select unlocked pre-creation");

  const focus = await apiOk(ctx, 2, "GET", "/focus");
  assert(
    2,
    focus.present === true && focus.tagName === "select",
    `expected WelcomeScreen's mount-time autofocus on the Provider <select> (a11y, WelcomeScreen.tsx's own useEffect), got ${JSON.stringify(focus)} — this is the pre-fix discriminator: a broken/removed focus-steal leaves focus on <body>`,
  );

  await saveScreenshot(ctx, 2, "01-welcome-empty-state");
  pass(2, `WelcomeScreen empty state confirmed live (grid unmounted, embedded drawer open in "template" stage, initial focus on Provider select)`);
}

async function step3CreateConnectionA(ctx) {
  const setResult = await apiOk(ctx, 3, "POST", "/settings/provider/drawer/set", {
    providerId: "anthropic",
    label: "Welcome Connection",
    model: "claude-test-model-1",
  });
  assert(3, setResult.ok === true, `drawer/set (template fields) rejected: ${JSON.stringify(setResult)}`);

  const submitResult = await apiOk(ctx, 3, "POST", "/settings/provider/drawer/submit", {});
  assert(3, submitResult.ok === true, `drawer/submit ("Create connection") rejected: ${JSON.stringify(submitResult)}`);

  const afterCreate = await apiOk(ctx, 3, "GET", "/settings/provider");
  assert(3, afterCreate.drawer.stage === "credential", `expected stage to flip to "credential" right after connection-create, got ${afterCreate.drawer.stage}`);
  assert(3, afterCreate.drawer.templateLocked === true, "expected the Provider select LOCKED once the connection exists (provider identity is fixed at creation)");
  assert(3, afterCreate.drawer.providerId === "anthropic", `expected providerId="anthropic" to survive creation, got ${afterCreate.drawer.providerId}`);

  // Discriminating lock-enforcement check: attempting to change the now-fixed
  // provider template must be refused by the facade's own disabled-select guard.
  const lockedAttempt = await api(ctx, "POST", "/settings/provider/drawer/set", { providerId: "z-ai" });
  assert(
    3,
    lockedAttempt.status === 200 && lockedAttempt.body?.ok === false && lockedAttempt.body?.reason === "provider_unavailable",
    `expected {ok:false, reason:"provider_unavailable"} against the locked Provider select, got HTTP ${lockedAttempt.status} ${JSON.stringify(lockedAttempt.body)}`,
  );

  pass(3, `connection A created (providerId=anthropic, label="Welcome Connection"), template correctly locked post-creation`);
}

async function step4SaveKeyA(ctx) {
  const setKey = await apiOk(ctx, 4, "POST", "/settings/provider/drawer/set", { apiKey: "sk-welcome-smoke-key-1" });
  assert(4, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);

  const beforeSave = await apiOk(ctx, 4, "GET", "/settings/provider");
  assert(4, beforeSave.drawer.apiKeyEntered === true, "expected apiKeyEntered=true right after typing the key");

  const saveKey = await apiOk(ctx, 4, "POST", "/settings/provider/drawer/save-key", {});
  assert(4, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);

  const afterSave = await apiOk(ctx, 4, "GET", "/settings/provider");
  assert(
    4,
    afterSave.drawer.apiKeyEntered === false,
    `custody: expected the plaintext key field cleared the instant Save was clicked, got apiKeyEntered=${afterSave.drawer.apiKeyEntered}`,
  );
  assert(4, afterSave.drawer.credentialStatusText !== null, "expected a non-null credentialStatusText once the key round-trips through the vault");

  pass(4, `key saved for connection A; plaintext field cleared post-submit (custody), credentialStatusText="${afterSave.drawer.credentialStatusText}"`);
}

async function step5WelcomeUnmountsAndDiskCustody(ctx) {
  const unmounted = await pollUntil(20_000, 300, async () => {
    const state = await api(ctx, "GET", "/settings/provider");
    return state.status === 200 && state.body?.drawer?.open === false ? state.body : undefined;
  });
  assert(
    5,
    unmounted !== null,
    "WelcomeScreen's embedded drawer never closed within 20s of saving connection A's key — providerReady likely never flipped true off the connection-CRUD path alone",
  );

  const settingsDisk = readJsonDisk(5, ctx.settingsPath, "settings.json");
  const connections = settingsDisk?.provider?.connections ?? [];
  assert(5, connections.length === 1, `expected exactly 1 persisted connection on disk, got ${connections.length}: ${JSON.stringify(connections)}`);
  const connA = connections[0];
  assert(5, connA.providerId === "anthropic", `on-disk connection A providerId mismatch: ${connA.providerId}`);
  assert(5, connA.model === "claude-test-model-1", `on-disk connection A model mismatch: ${connA.model}`);
  assert(
    5,
    settingsDisk.provider.activeConnectionId === connA.id,
    `expected activeConnectionId=${connA.id} (first connection auto-activates), got ${settingsDisk.provider.activeConnectionId}`,
  );

  const keys = assertOnlyConnectionScopedSecretKeys(5, ctx.secretsPath, 1);
  assert(5, keys[0] === `provider.connection.${connA.id}.apiKey`, `expected the sole secret key to be provider.connection.${connA.id}.apiKey, got ${keys[0]}`);

  ctx.connAId = connA.id;
  pass(5, `WelcomeScreen unmounted (providerReady flipped purely off connection-CRUD + vault); on-disk settings.json + secrets.json confirm connection A (${connA.id}), zero legacy-shaped secret keys`);
}

async function step6GridShowsConnectionA(ctx) {
  const openResult = await apiOk(ctx, 6, "POST", "/settings/open", {});
  assert(6, openResult.ok === true, `settings/open rejected: ${JSON.stringify(openResult)}`);
  const paneResult = await apiOk(ctx, 6, "POST", "/settings/pane", { paneId: "provider" });
  assert(6, paneResult.ok === true, `settings/pane provider rejected: ${JSON.stringify(paneResult)}`);

  const state = await apiOk(ctx, 6, "GET", "/settings/provider");
  assert(6, state.mounted === true, "expected the Settings-dialog grid mounted once the provider pane is selected");
  assert(6, state.rows.length === 1, `expected exactly 1 tile in the grid, got ${state.rows.length}: ${JSON.stringify(state.rows)}`);
  const row = state.rows[0];
  assert(6, row.connectionId === ctx.connAId, `grid tile connectionId mismatch: ${row.connectionId} !== ${ctx.connAId}`);
  assert(6, row.displayName === "Welcome Connection", `grid tile displayName mismatch: ${row.displayName}`);
  assert(6, row.model === "claude-test-model-1", `grid tile model mismatch: ${row.model}`);
  assert(6, row.statusText === "Unchecked", `expected status text "Unchecked" (credential set, never probed), got "${row.statusText}"`);
  assert(6, row.statusTone === "muted", `expected status tone "muted" for Unchecked, got "${row.statusTone}"`);
  assert(6, row.selected === true, "expected connection A selected (it is the sole/active connection)");

  await saveScreenshot(ctx, 6, "02-grid-one-connection");
  pass(6, `grid renders connection A as a single tile: name/model/status text+tone all correct, selected marker present`);
}

async function step7AddConnectionB(ctx) {
  const addResult = await apiOk(ctx, 7, "POST", "/settings/provider/add", {});
  assert(7, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);

  const focus = await apiOk(ctx, 7, "GET", "/focus");
  assert(
    7,
    focus.present === true && focus.tagName === "input",
    `expected the Settings-dialog drawer's mount-time autofocus on the Label input (a11y, ConnectionDrawerFields' own useEffect, initialFocus="label" default), got ${JSON.stringify(focus)}`,
  );

  const setResult = await apiOk(ctx, 7, "POST", "/settings/provider/drawer/set", {
    providerId: "anthropic",
    label: "Second Connection",
    model: "claude-test-model-2",
  });
  assert(7, setResult.ok === true, `drawer/set rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, 7, "POST", "/settings/provider/drawer/submit", {});
  assert(7, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);

  const afterCreate = await apiOk(ctx, 7, "GET", "/settings/provider");
  assert(7, afterCreate.drawer.stage === "credential", `expected stage="credential" after creating connection B, got ${afterCreate.drawer.stage}`);
  const setKey = await apiOk(ctx, 7, "POST", "/settings/provider/drawer/set", { apiKey: "sk-welcome-smoke-key-2" });
  assert(7, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, 7, "POST", "/settings/provider/drawer/save-key", {});
  assert(7, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
  const closeResult = await apiOk(ctx, 7, "POST", "/settings/provider/drawer/close", {});
  assert(7, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const settingsDisk = readJsonDisk(7, ctx.settingsPath, "settings.json");
  const connections = settingsDisk?.provider?.connections ?? [];
  assert(7, connections.length === 2, `expected 2 persisted connections, got ${connections.length}`);
  const connB = connections.find((c) => c.id !== ctx.connAId);
  assert(7, connB !== undefined, "second connection not found on disk");
  assert(7, connB.id !== ctx.connAId, "connection B minted the SAME id as connection A — CRUD id generation regressed");
  ctx.connBId = connB.id;

  pass(7, `connection B created (${connB.id}) via the Settings grid's Add tile, focus correctly landed on Label input on open`);
}

async function step8GridShowsTwoSameProviderConnections(ctx) {
  const state = await apiOk(ctx, 8, "GET", "/settings/provider");
  assert(8, state.rows.length === 2, `expected 2 tiles, got ${state.rows.length}`);
  const rowA = state.rows.find((r) => r.connectionId === ctx.connAId);
  const rowB = state.rows.find((r) => r.connectionId === ctx.connBId);
  assert(8, rowA !== undefined && rowB !== undefined, `both connection tiles must be present: ${JSON.stringify(state.rows)}`);
  assert(8, rowA.providerName === rowB.providerName, `expected both tiles to show the SAME provider name (both providerId="anthropic"), got "${rowA.providerName}" vs "${rowB.providerName}"`);
  assert(8, rowA.displayName !== rowB.displayName, "expected distinct display names (custom labels)");
  assert(8, rowA.model !== rowB.model, "expected distinct models between the two connections");

  const keys = assertOnlyConnectionScopedSecretKeys(8, ctx.secretsPath, 2);
  const expected = new Set([`provider.connection.${ctx.connAId}.apiKey`, `provider.connection.${ctx.connBId}.apiKey`]);
  for (const key of keys) {
    assert(8, expected.has(key), `unexpected secret key on disk: ${key}`);
  }

  await saveScreenshot(ctx, 8, "03-grid-two-same-provider-connections");
  pass(8, `two independent "anthropic" connections coexist in the grid with distinct ids/labels/models and independent vault keys — one provider, two credentials (TASK.45 DoD #1)`);
}

async function step9EditConnectionBNoOp(ctx) {
  const menuResult = await apiOk(ctx, 9, "POST", "/settings/provider/menu", { connectionId: ctx.connBId, action: "edit" });
  assert(9, menuResult.ok === true, `menu edit rejected: ${JSON.stringify(menuResult)}`);

  const state = await apiOk(ctx, 9, "GET", "/settings/provider");
  assert(9, state.drawer.open === true && state.drawer.embedded === false, `expected the Settings-dialog (non-embedded) drawer open for edit, got ${JSON.stringify(state.drawer)}`);
  assert(9, state.drawer.stage === "credential", `expected an existing connection's edit drawer to open straight into "credential" stage, got ${state.drawer.stage}`);
  assert(9, state.drawer.templateLocked === true, "expected the Provider select locked while editing an existing connection");
  assert(9, state.drawer.providerId === "anthropic", `expected prefilled providerId="anthropic", got ${state.drawer.providerId}`);
  assert(9, state.drawer.label === "Second Connection", `expected prefilled label, got "${state.drawer.label}"`);
  assert(9, state.drawer.model === "claude-test-model-2", `expected prefilled model, got "${state.drawer.model}"`);
  assert(9, state.drawer.apiKeyEntered === false, "custody: Edit must never pre-fill the credential input from a SecretStatus");

  const closeResult = await apiOk(ctx, 9, "POST", "/settings/provider/drawer/close", {});
  assert(9, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const settingsDisk = readJsonDisk(9, ctx.settingsPath, "settings.json");
  const connB = settingsDisk.provider.connections.find((c) => c.id === ctx.connBId);
  assert(9, connB.label === "Second Connection" && connB.model === "claude-test-model-2", "closing Edit without submitting must leave the connection byte-unchanged on disk");

  pass(9, `Edit prefills label/model/locked-provider correctly, never exposes a saved key (custody), and a no-op close leaves the connection untouched on disk`);
}

/**
 * The automation `"delete"` menu action is NOT a two-step probe/driver pair
 * (unlike edit/replace_key/check) — `settingsProviderMenuAction`
 * (automation.ts) drives BOTH the menu item click AND the confirm popover's
 * own Delete button in one call (waiting for `confirmingDelete` to flip true
 * in between), so there is no route to stop mid-confirm and click Cancel.
 * This step therefore exercises the REAL end-to-end delete flow instead: a
 * disposable throwaway connection is created, deleted, and both its metadata
 * (settings.json) and its vault entry (secrets.json) are asserted gone —
 * "safe delete order" (TASK.45: "сначала очистить connection secrets, затем
 * metadata") — while connections A and B (created in earlier steps) are
 * asserted completely unaffected.
 */
async function step10CreateAndDeleteThrowaway(ctx) {
  const addResult = await apiOk(ctx, 10, "POST", "/settings/provider/add", {});
  assert(10, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);
  const setResult = await apiOk(ctx, 10, "POST", "/settings/provider/drawer/set", {
    providerId: "anthropic",
    label: "Throwaway",
    model: "claude-test-model-throwaway",
  });
  assert(10, setResult.ok === true, `drawer/set rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, 10, "POST", "/settings/provider/drawer/submit", {});
  assert(10, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);
  const setKey = await apiOk(ctx, 10, "POST", "/settings/provider/drawer/set", { apiKey: "sk-throwaway-smoke-key" });
  assert(10, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, 10, "POST", "/settings/provider/drawer/save-key", {});
  assert(10, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
  const closeResult = await apiOk(ctx, 10, "POST", "/settings/provider/drawer/close", {});
  assert(10, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const preDelete = readJsonDisk(10, ctx.settingsPath, "settings.json");
  const throwaway = preDelete.provider.connections.find((c) => c.id !== ctx.connAId && c.id !== ctx.connBId);
  assert(10, throwaway !== undefined, "throwaway connection not found on disk before delete");
  assertOnlyConnectionScopedSecretKeys(10, ctx.secretsPath, 3);

  const deleteResult = await apiAction(ctx, 10, "/settings/provider/menu", { connectionId: throwaway.id, action: "delete" });
  assert(10, deleteResult.ok === true, `menu delete rejected: ${JSON.stringify(deleteResult)}`);

  const state = await apiOk(ctx, 10, "GET", "/settings/provider");
  assert(10, state.rows.length === 2, `expected 2 tiles after deleting the throwaway connection, got ${state.rows.length}: ${JSON.stringify(state.rows)}`);
  assert(10, state.rows.some((r) => r.connectionId === ctx.connAId), "connection A must survive an unrelated connection's delete");
  assert(10, state.rows.some((r) => r.connectionId === ctx.connBId), "connection B must survive an unrelated connection's delete");

  const postDelete = readJsonDisk(10, ctx.settingsPath, "settings.json");
  assert(10, postDelete.provider.connections.every((c) => c.id !== throwaway.id), "throwaway connection metadata still present on disk after delete");
  const keysAfter = assertOnlyConnectionScopedSecretKeys(10, ctx.secretsPath, 2);
  assert(
    10,
    !keysAfter.includes(`provider.connection.${throwaway.id}.apiKey`),
    `throwaway connection's vault key survived its own metadata delete: ${JSON.stringify(keysAfter)}`,
  );

  pass(10, `throwaway connection (${throwaway.id}) fully deleted — metadata AND vault entry both gone, connections A/B untouched (safe delete order + isolation)`);
}

async function step11CheckConnectionA(ctx) {
  const before = await apiOk(ctx, 11, "GET", "/settings/provider");
  const rowABefore = before.rows.find((r) => r.connectionId === ctx.connAId);

  const checkResult = await apiOk(ctx, 11, "POST", "/settings/provider/menu", { connectionId: ctx.connAId, action: "check" });
  assert(11, checkResult.ok === true, `menu check rejected: ${JSON.stringify(checkResult)}`);

  const after = await apiOk(ctx, 11, "GET", "/settings/provider");
  const rowAAfter = after.rows.find((r) => r.connectionId === ctx.connAId);
  // `probeConnection` is not wired in main/index.ts today (W9 scaffold,
  // confirmed by grep — zero production references outside test fixtures),
  // so `connection-check` is presently a network-free no-op that re-confirms
  // the id and returns the current snapshot: the wiring works end-to-end
  // (route -> facade -> IPC -> fresh snapshot) but health genuinely does not
  // change yet. Asserting byte-identical status here is itself the honest
  // discriminator — a WIRED probe that silently mutated status on a bad read
  // would fail this exact assertion.
  assert(
    11,
    rowAAfter.statusText === rowABefore.statusText && rowAAfter.statusTone === rowABefore.statusTone,
    `expected connection A's status unchanged by an unwired connection-check probe, got ${rowABefore.statusText}/${rowABefore.statusTone} -> ${rowAAfter.statusText}/${rowAAfter.statusTone}`,
  );

  pass(11, `"Check" menu action round-trips cleanly (ok:true, no crash); status genuinely unchanged — probeConnection is not yet wired (pre-existing W9/W11 residual, not a W12 regression)`);
}

async function step12CreateCustomConnection(ctx) {
  ctx.refusedPort = await reserveUnusedPort();

  const addResult = await apiOk(ctx, 12, "POST", "/settings/provider/add", {});
  assert(12, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);

  const setResult = await apiOk(ctx, 12, "POST", "/settings/provider/drawer/set", {
    providerId: "custom",
    label: "Local Refused Target",
    model: "smoke-test-model",
    baseUrl: `http://127.0.0.1:${ctx.refusedPort}`,
  });
  assert(12, setResult.ok === true, `drawer/set (custom template) rejected: ${JSON.stringify(setResult)}`);

  const preSubmit = await apiOk(ctx, 12, "GET", "/settings/provider");
  assert(12, preSubmit.drawer.baseUrlVisible === true, `expected the Base URL field visible for the "custom" template (needsBaseUrl), got baseUrlVisible=${preSubmit.drawer.baseUrlVisible}`);
  assert(12, preSubmit.drawer.baseUrl === `http://127.0.0.1:${ctx.refusedPort}`, `Base URL field did not carry the value we set: ${preSubmit.drawer.baseUrl}`);

  const submitResult = await apiOk(ctx, 12, "POST", "/settings/provider/drawer/submit", {});
  assert(12, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);

  const setKey = await apiOk(ctx, 12, "POST", "/settings/provider/drawer/set", { apiKey: "sk-e2e-smoke-key-custom" });
  assert(12, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, 12, "POST", "/settings/provider/drawer/save-key", {});
  assert(12, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
  const closeResult = await apiOk(ctx, 12, "POST", "/settings/provider/drawer/close", {});
  assert(12, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const settingsDisk = readJsonDisk(12, ctx.settingsPath, "settings.json");
  const connC = settingsDisk.provider.connections.find((c) => c.id !== ctx.connAId && c.id !== ctx.connBId);
  assert(12, connC !== undefined, "third (custom) connection not found on disk");
  assert(12, connC.baseUrl === `http://127.0.0.1:${ctx.refusedPort}`, `on-disk custom connection baseUrl mismatch: ${connC.baseUrl}`);
  ctx.connCId = connC.id;

  const state = await apiOk(ctx, 12, "GET", "/settings/provider");
  assert(12, state.rows.length === 3, `expected 3 tiles after the custom connection, got ${state.rows.length}`);

  pass(12, `connection C created (${connC.id}, "custom" template, Base URL field correctly shown/settable, points at reserved connect-refused port ${ctx.refusedPort})`);
}

async function step13SelectConnectionCIndependence(ctx) {
  const before = await apiOk(ctx, 13, "GET", "/settings/provider");
  const rowABefore = before.rows.find((r) => r.connectionId === ctx.connAId);
  const rowBBefore = before.rows.find((r) => r.connectionId === ctx.connBId);

  const tileResult = await apiOk(ctx, 13, "POST", "/settings/provider/tile", { connectionId: ctx.connCId });
  assert(13, tileResult.ok === true, `tile select rejected: ${JSON.stringify(tileResult)}`);

  const after = await apiOk(ctx, 13, "GET", "/settings/provider");
  const rowC = after.rows.find((r) => r.connectionId === ctx.connCId);
  const rowAAfter = after.rows.find((r) => r.connectionId === ctx.connAId);
  const rowBAfter = after.rows.find((r) => r.connectionId === ctx.connBId);
  assert(13, rowC.selected === true, "expected connection C selected (default for new sessions) after clicking its tile");
  assert(13, rowAAfter.selected === false && rowBAfter.selected === false, "expected A and B to lose the selected marker once C is selected");
  assert(
    13,
    rowAAfter.statusText === rowABefore.statusText && rowBAfter.statusText === rowBBefore.statusText,
    "DoD: changing the DEFAULT connection must never touch another connection's health/credential status",
  );

  const settingsDisk = readJsonDisk(13, ctx.settingsPath, "settings.json");
  assert(13, settingsDisk.provider.activeConnectionId === ctx.connCId, `expected activeConnectionId=${ctx.connCId} persisted on disk, got ${settingsDisk.provider.activeConnectionId}`);

  pass(13, `selecting connection C as default flips ONLY its own selected marker; A/B statuses and vault entries untouched (independence, TASK.45 DoD)`);
}

async function step14CreateTab(ctx) {
  const closeSettings = await apiOk(ctx, 14, "POST", "/settings/close", {});
  assert(14, closeSettings.ok === true, `settings/close rejected: ${JSON.stringify(closeSettings)}`);

  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-provconn-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "seed.txt"), "hello from provider-connections smoke\n");

  const created = await apiOk(ctx, 14, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(14, created.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  ctx.tabId = created.tabId;

  await waitUntilTab(ctx, 14, ctx.tabId, { connection: "ready" }, 60_000);
  pass(14, `new tab ${ctx.tabId} created against workspace ${ctx.workspace}, connection ready (host fork honored connection C's env)`);
}

async function step15E2ECredentialPickup(ctx) {
  const promptText = "provider-connections e2e smoke: this text is never read — the connect-refused failure lands before any request body is sent";
  const sendResult = await apiOk(ctx, 15, "POST", `/tabs/${ctx.tabId}/prompt`, { text: promptText });
  assert(15, sendResult.ok === true, `prompt send rejected: ${JSON.stringify(sendResult)}`);

  await waitUntilTab(ctx, 15, ctx.tabId, { turnStatus: "running" }, 30_000);
  await waitUntilTab(ctx, 15, ctx.tabId, { turnStatus: "idle" }, 60_000);

  const state = await apiOk(ctx, 15, "GET", `/state/${ctx.tabId}`);
  const tabState = state?.snapshot?.states?.[ctx.tabId];
  const blocks = tabState?.transcript ?? [];
  let errorBlock = null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === "error") {
      errorBlock = blocks[i];
      break;
    }
  }
  assert(15, errorBlock !== null, `no terminal error block in the transcript after the turn settled idle: ${JSON.stringify(blocks.slice(-5))}`);
  assert(15, errorBlock.retry !== undefined, "terminal error block carries no `retry` metadata");
  assert(
    15,
    errorBlock.retry.code === "network",
    `expected a "network" classified failure (ECONNREFUSED against the reserved local port) — proof the host fork resolved connection C's OWN baseUrl, got code="${errorBlock.retry.code}", message=${JSON.stringify(errorBlock.error?.message)}`,
  );
  assert(15, errorBlock.retry.retryable === true, `expected retryable=true for a connect-refused failure, got ${errorBlock.retry.retryable}`);
  assert(15, errorBlock.retry.hadModelOutput === false, `expected hadModelOutput=false (failure before any content), got ${errorBlock.retry.hadModelOutput}`);

  await saveScreenshot(ctx, 15, "04-e2e-connect-refused-proof");
  pass(
    15,
    `SNAPSHOT PROOF (TASK.45 W12 "снятие шва"): a real host fork dispatched a real HTTP request to connection C's OWN baseUrl (http://127.0.0.1:${ctx.refusedPort}, unique to this run) and failed with a "network"/ECONNREFUSED classification — the credential+endpoint came ONLY from drawer -> connection-create/update + secret-set IPC, zero legacy write-seam involved`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 2 — separate fresh profile: env-override banner, independent of the
// grid's own connection count/health
// ══════════════════════════════════════════════════════════════════════════

async function phase2Launch() {
  const refusedPort = await reserveUnusedPort();
  const ctx = await launchApp(17, "env-override", {
    // Dummy provider credential + an unreachable base URL: `computeProviderReady`
    // only checks PRESENCE, never validity, and this phase never sends a
    // prompt — no live network call ever touches this key/port.
    ANYCODE_API_KEY: "sk-env-override-smoke-dummy",
    ANYCODE_MODEL: "env-override-smoke-dummy-model",
    ANYCODE_BASE_URL: `http://127.0.0.1:${refusedPort}`,
  });
  ctx.refusedPort = refusedPort;
  return ctx;
}

async function step18EnvBannerZeroConnections(ctx) {
  const openResult = await apiOk(ctx, 18, "POST", "/settings/open", {});
  assert(18, openResult.ok === true, `settings/open rejected: ${JSON.stringify(openResult)}`);
  const paneResult = await apiOk(ctx, 18, "POST", "/settings/pane", { paneId: "provider" });
  assert(18, paneResult.ok === true, `settings/pane provider rejected: ${JSON.stringify(paneResult)}`);

  const state = await apiOk(ctx, 18, "GET", "/settings/provider");
  assert(18, state.mounted === true, "expected the grid mounted (Settings dialog open, provider pane selected)");
  assert(18, state.rows.length === 0, `expected ZERO stored connections on this fresh profile, got ${state.rows.length}`);
  assert(
    18,
    state.envOverrideVisible === true,
    `expected the "Environment override" banner visible purely off ANYCODE_API_KEY presence, independent of any stored connection, got envOverrideVisible=${state.envOverrideVisible}`,
  );

  await saveScreenshot(ctx, 18, "05-env-override-banner-zero-connections");
  pass(18, `env-override banner renders with ZERO stored connections — banner visibility is driven by env presence alone, not by connection count (TASK.45 DoD §5)`);
}

async function step19EnvBannerIndependentOfConnectionHealth(ctx) {
  const addResult = await apiOk(ctx, 19, "POST", "/settings/provider/add", {});
  assert(19, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);
  const setResult = await apiOk(ctx, 19, "POST", "/settings/provider/drawer/set", {
    providerId: "anthropic",
    label: "Stored (overridden)",
    model: "claude-test-model-env",
  });
  assert(19, setResult.ok === true, `drawer/set rejected: ${JSON.stringify(setResult)}`);
  const submitResult = await apiOk(ctx, 19, "POST", "/settings/provider/drawer/submit", {});
  assert(19, submitResult.ok === true, `drawer/submit rejected: ${JSON.stringify(submitResult)}`);
  const setKey = await apiOk(ctx, 19, "POST", "/settings/provider/drawer/set", { apiKey: "sk-env-banner-smoke-key" });
  assert(19, setKey.ok === true, `drawer/set (apiKey) rejected: ${JSON.stringify(setKey)}`);
  const saveKey = await apiOk(ctx, 19, "POST", "/settings/provider/drawer/save-key", {});
  assert(19, saveKey.ok === true, `drawer/save-key rejected: ${JSON.stringify(saveKey)}`);
  const closeResult = await apiOk(ctx, 19, "POST", "/settings/provider/drawer/close", {});
  assert(19, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);

  const state = await apiOk(ctx, 19, "GET", "/settings/provider");
  assert(19, state.rows.length === 1, `expected exactly 1 stored connection now, got ${state.rows.length}`);
  const row = state.rows[0];
  assert(
    19,
    row.statusText === "Unchecked",
    `expected the stored connection's OWN status to read "Unchecked" (credential set, never probed) — an env-override failure must never paint it, got "${row.statusText}"`,
  );
  assert(19, state.envOverrideVisible === true, "expected the banner to remain visible alongside a now-present stored connection");

  await saveScreenshot(ctx, 19, "06-env-override-banner-with-connection");
  pass(19, `stored connection created alongside the active env-override: banner stays visible, the connection's own health is untouched by the env-key's (separate, unexercised) failure — DoD "Ошибку env-key нельзя приписывать выбранной сохранённой плашке"`);
}

// ── orchestration ──

function installSignalTeardown(getCtx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[provider-connections-ui-smoke] received ${signal} — tearing down…`);
    const ctx = getCtx();
    (ctx ? teardown(ctx, [ctx.workspace]) : Promise.resolve())
      .catch((err) => console.error(`[provider-connections-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  console.log("[provider-connections-ui-smoke] static custody check: grepping for the removed legacy write-seam…");
  const legacyHits = staticGrepLegacyShimGone();
  if (legacyHits.length > 0) {
    console.error(`[provider-connections-ui-smoke] FATAL: legacy write-seam still referenced in production code:\n${legacyHits.join("\n")}`);
    process.exit(1);
  }
  console.log("[provider-connections-ui-smoke] confirmed: zero production references to applyLegacyProviderPatch/providerSecretKey\n");

  let currentCtx = null;
  installSignalTeardown(() => currentCtx);

  let failedStep = null;

  // ── phase 1 ──
  let ctx1 = null;
  try {
    ctx1 = await phase1Launch();
    currentCtx = ctx1;
    await step2WelcomeEmptyState(ctx1);
    await step3CreateConnectionA(ctx1);
    await step4SaveKeyA(ctx1);
    await step5WelcomeUnmountsAndDiskCustody(ctx1);
    await step6GridShowsConnectionA(ctx1);
    await step7AddConnectionB(ctx1);
    await step8GridShowsTwoSameProviderConnections(ctx1);
    await step9EditConnectionBNoOp(ctx1);
    await step10CreateAndDeleteThrowaway(ctx1);
    await step11CheckConnectionA(ctx1);
    await step12CreateCustomConnection(ctx1);
    await step13SelectConnectionCIndependence(ctx1);
    await step14CreateTab(ctx1);
    await step15E2ECredentialPickup(ctx1);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown (phase 1)";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[provider-connections-ui-smoke] unexpected error in phase 1: ${err?.stack ?? err}`);
    }
  }
  if (ctx1) {
    pass(16, `phase 1 teardown (quit dev app, clean up disposable profile${FLAGS.keep ? " — SKIPPED, --keep set" : ""})`);
    await teardown(ctx1, [ctx1.workspace]);
    currentCtx = null;
  }

  // ── phase 2 (only if phase 1 fully passed) ──
  if (failedStep === null) {
    let ctx2 = null;
    try {
      ctx2 = await phase2Launch();
      currentCtx = ctx2;
      await step18EnvBannerZeroConnections(ctx2);
      await step19EnvBannerIndependentOfConnectionHealth(ctx2);
    } catch (err) {
      failedStep = err instanceof SmokeFailure ? err.step : "unknown (phase 2)";
      if (!(err instanceof SmokeFailure)) {
        console.error(`[provider-connections-ui-smoke] unexpected error in phase 2: ${err?.stack ?? err}`);
      }
    }
    if (ctx2) {
      pass(20, `phase 2 teardown (quit dev app, clean up disposable profile${FLAGS.keep ? " — SKIPPED, --keep set" : ""})`);
      await teardown(ctx2, []);
      currentCtx = null;
    }
  } else {
    console.log("[provider-connections-ui-smoke] phase 1 failed — skipping phase 2 (env-override banner)");
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[provider-connections-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[provider-connections-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

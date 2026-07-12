/**
 * Live GUI smoke for GUI-P1 (design slice-GUI-P1-cut.md §2F.6): drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`) exercising directive #2
 * (sidebar project `…` menu actions: new-session-in-project / remove-project,
 * mirrored by the dev-only `/projects/new` and `/projects/hide` routes) and
 * directive #3 (the model chip relocated into the composer footer).
 *
 * `/projects/new` deliberately drives the RENDERER-IPC path (the same
 * `window.anycode.createTab({kind:"new", workspace})` contextBridge call the
 * sidebar menu item makes) rather than the pre-existing main-plane
 * `POST /tabs` dialog-bypass — that is the real product path directive #2

 * `/projects/hide` mirrors the menu's "Remove project from list" action,
 * whose refusal (an open tab in that workspace) is decided by the REAL
 * `hideWorkspace()` store action, not re-implemented here.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * git-ui-smoke.mjs) — this file is a NEW sibling of git-ui-smoke.mjs, not an
 * edit of it (lock L9).
 *
 * Usage:   node apps/desktop/scripts/sidebar-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tabs this script created; it

 *                   attaching is an explicit opt-in to reuse a foreign/dev
 *                   instance, not a license to kill someone else's session).
 *   --keep         Do not delete the two temp project dirs on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Each of the 10 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (chip + sidebar groups) is written
 * to `apps/desktop/out/sidebar-smoke/step-*.png`.
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
const TOTAL_STEPS = 10;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

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
      console.warn(`[sidebar-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from git-ui-smoke.mjs) ──

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

/**
 * Canonicalizes a filesystem path for identity comparison. The host reports a
 * tab's workspace as `process.cwd()` (host/index.ts) and persists sessions with
 * the same value, which macOS resolves through the `/var`->`/private/var`
 * symlink and strips of any trailing slash — so a tab/session `workspace` never
 * matches the raw `mkdtempSync` path byte-for-byte. Resolving BOTH sides with
 * `realpathSync` collapses that difference. Falls back to the raw string when
 * the path no longer exists (e.g. a temp dir already torn down).
 */
function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True iff two paths refer to the same real location (see `canonPath`). */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  return canonPath(a) === canonPath(b);
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

/** `POST /wait` for a specific tab + hard-fail if the condition never matched within the timeout. */
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
 * Poll `GET /state` until the renderer facade has finished installing. main.tsx
 * installs `window.__anycodeAutomation` via a DEV-gated *dynamic* import
 * (`import("./automation.js").then(installAutomation)`), so there is a brief
 * window after the page first loads where any facade-backed call (snapshot /
 * wait) returns 503 `facade_not_installed`. `/state` reaches the facade too, so
 * a 200 from it is the readiness signal every subsequent facade call depends on.
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

/**
 * `GET /state` (the FULL snapshot, not narrowed to one tab) — needed because
 * the shell-level `hiddenWorkspaces` set (§2F.5) lives at the top of
 * `SnapshotJson`, not inside any one tab's `TabStateSnapshot`.
 */
async function getFullState(ctx, step) {
  return apiOk(ctx, step, "GET", "/state");
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[sidebar-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[sidebar-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

// ── step 1: bootstrap two temp project dirs (no git needed) ──

function step1BootstrapWorkspaces(ctx) {
  try {
    const a = mkdtempSync(join(tmpdir(), "anycode-sidebar-smoke-a-"));
    ctx.tmpA = a; // set immediately: teardown can clean this up even if a later step throws
    writeFileSync(join(a, "seed-a.txt"), "hello from project A\n");

    const b = mkdtempSync(join(tmpdir(), "anycode-sidebar-smoke-b-"));
    ctx.tmpB = b;
    writeFileSync(join(b, "seed-b.txt"), "hello from project B\n");
  } catch (err) {
    if (err instanceof SmokeFailure) {
      throw err;
    }
    fail(1, `bootstrap error: ${err?.message ?? err}`);
  }

  pass(1, `two temp project dirs bootstrapped: A=${ctx.tmpA}, B=${ctx.tmpB}`);
}

// ── step 2: launch (or attach to) the dev app ──

async function step2LaunchApp(ctx) {
  if (FLAGS.attach) {
    // --attach means "a foreign instance with the default profile" — read the
    // global discovery file, do NOT isolate (design/slice-P7.H-cut.md §4.4).
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(2, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(2, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
    pass(2, `attached to running app (pid=${info.pid}, port=${info.port})`);
    return;
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): a fresh
  // userData dir + SQLite DB + discovery file per invocation kills the
  // cross-run localStorage/discovery-file pollution that made step 4's
  // hiddenWorkspaces===[] assert non-reproducible. Set on ctx immediately so
  // teardown can remove it even if a later step throws.
  const profile = mkdtempSync(join(tmpdir(), "anycode-sidebar-smoke-profile-"));
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
  };
  // Deterministic boot: a provider IS configured (TabHostManager.createTab
  // refuses otherwise), so main's ready-boot path (index.ts startInitialTab ->
  // resolveWorkspace) ALWAYS opens a boot auto-tab. Pinning ANYCODE_WORKSPACE
  // to project A makes resolveWorkspace return A with NO open-dir dialog, so the
  // boot tab IS project A (mirrors reality) — instead of deleting the var, which
  // dropped main to the dialog fallback and produced a stray ~/Downloads tab.
  // Step 3 then discovers this boot tab rather than creating A itself.
  env.ANYCODE_WORKSPACE = ctx.tmpA;
  if (FLAGS.port !== undefined) {
    env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
  }
  // ELECTRON_EXEC_PATH, if the caller set it, passes through via {...process.env} above.

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
      fail(2, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    // startedAt > t0 (and a live pid) guards against reading a stale/foreign

    // suspenders alongside the per-run discovery path already isolating us.
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(2, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  pass(2, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}, profile=${profile}`);
}

// ── step 3: discover the boot auto-tab (deterministic-boot = project A) ──

/**
 * Polls `GET /state` until a tab whose `states[tabId].workspace` canonically
 * equals `workspace` appears, returning its tabId. The boot tab shows up in
 * `snapshot.tabs` as soon as its port is delivered, but `states[tabId].workspace`
 * stays `null` until `host_ready` lands (store.ts) — so matching on the
 * canonicalized workspace both identifies the right tab AND gates on it having
 * received its host_ready fields. Uses the soft `api()` (not `apiOk`) so a
 * transient 503 during the facade-install / port-delivery reflow re-polls
 * rather than hard-failing the step.
 */
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

async function step3DiscoverBootTabA(ctx) {
  // The facade install races the page load (DEV dynamic import); wait it out
  // before any facade-backed call (/wait, /state) so the readiness poll below
  // doesn't 503 on a not-yet-installed facade.
  await waitForFacade(ctx, 3);

  if (ctx.child === null) {
    // --attach: we did NOT control the attached instance's boot env, so it has
    // no project-A boot tab to discover. Preserve the original behaviour and
    // create A explicitly through the main-plane dialog-bypass route.
    const created = await apiOk(ctx, 3, "POST", "/tabs", { kind: "new", workspace: ctx.tmpA });
    if (created?.ok !== true) {
      fail(3, `tab creation for A failed: ${JSON.stringify(created)}`);
    }
    ctx.tabA = created.tabId;
  } else {
    // Deterministic boot: main opened the boot auto-tab AS project A (step 2 set
    // ANYCODE_WORKSPACE=A). Discover it by workspace rather than by index.
    ctx.tabA = await discoverTabByWorkspace(ctx, 3, ctx.tmpA);
  }

  await waitUntilTab(ctx, 3, ctx.tabA, { connection: "ready" });
  pass(3, `boot tab ${ctx.tabA} is project A (${ctx.tmpA}), connection ready`);
}

// ── step 4: renderer-IPC project-new for workspace B (directive #2, item 1) ──

async function step4ProjectNewB(ctx) {
  // `/projects/new` mirrors the sidebar's "New session in this project" item:
  // `bridge.createTab({kind:"new", workspace})` through the REAL preload ->
  // tab-ipc zod -> dialog-skip -> manager.createTab path (§2F.4/§2F.5), NOT
  // the pre-existing main-plane `/tabs` dialog-bypass step 3 used.
  const result = await apiOk(ctx, 4, "POST", "/projects/new", { workspace: ctx.tmpB });
  assert(4, result?.ok === true, `/projects/new rejected: ${JSON.stringify(result)}`);
  assert(4, result.workspace === ctx.tmpB, `workspace mismatch in /projects/new response: ${JSON.stringify(result)}`);
  assert(4, typeof result.tabId === "string" && result.tabId.length > 0, `missing tabId in /projects/new response: ${JSON.stringify(result)}`);
  ctx.tabB = result.tabId;

  await waitUntilTab(ctx, 4, ctx.tabB, { connection: "ready" });

  const state = await getFullState(ctx, 4);
  const tabCount = state?.snapshot?.tabs?.length;
  assert(4, tabCount === 2, `expected 2 tabs after /projects/new, got ${tabCount}: ${JSON.stringify(state?.snapshot?.tabs)}`);
  const tabBState = state?.snapshot?.states?.[ctx.tabB];
  assert(4, tabBState !== undefined, `no snapshot state for tab B (${ctx.tabB}): ${JSON.stringify(state?.snapshot?.states)}`);
  // state.workspace is host_ready's process.cwd() (realpath'd) — canonicalize
  // both sides so the /var<->/private/var symlink doesn't spuriously mismatch.
  assert(4, samePath(tabBState.workspace, ctx.tmpB), `tab-B state.workspace mismatch: ${JSON.stringify(tabBState.workspace)} vs ${ctx.tmpB}`);
  const hidden = state?.snapshot?.hiddenWorkspaces;
  assert(4, Array.isArray(hidden) && hidden.length === 0, `expected snapshot.hiddenWorkspaces===[] before any hide, got ${JSON.stringify(hidden)}`);

  pass(4, `renderer-IPC /projects/new created tab ${ctx.tabB} for B; 2 tabs total; hiddenWorkspaces=[]`);
}

// ── step 5: composer model chip datum + screenshot #1 (directive #3) ──

async function step5ChipDatum(ctx) {
  const state = await getFullState(ctx, 5);
  const tabBState = state?.snapshot?.states?.[ctx.tabB];
  assert(5, tabBState !== undefined, `no snapshot state for tab B (${ctx.tabB})`);
  assert(5, typeof tabBState.model === "string" && tabBState.model.length > 0, `tab-B state.model is not a non-empty string: ${JSON.stringify(tabBState.model)}`);
  await saveScreenshot(ctx, "step-1-chip-and-groups");
  pass(5, `tab-B model chip datum present: "${tabBState.model}"`);
}

// ── step 6: close tab B (project B becomes session-only) ──

async function step6CloseTabB(ctx) {
  await apiAction(ctx, 6, `/tabs/${ctx.tabB}/close`, {});

  const state = await getFullState(ctx, 6);
  const tabCount = state?.snapshot?.tabs?.length;
  assert(6, tabCount === 1, `expected 1 tab after closing B, got ${tabCount}: ${JSON.stringify(state?.snapshot?.tabs)}`);

  const sessions = await apiOk(ctx, 6, "GET", "/sessions");
  assert(6, Array.isArray(sessions), `GET /sessions did not return an array: ${JSON.stringify(sessions)}`);
  // A persisted session's workspace is the host's process.cwd() (realpath'd) —
  // canonicalize both sides (see samePath / the /var<->/private/var symlink).
  const hasSessionB = sessions.some((s) => samePath(s?.workspace, ctx.tmpB));
  assert(6, hasSessionB, `no session with workspace===B found in /sessions after close: ${JSON.stringify(sessions)}`);

  pass(6, "tab B closed: 1 tab remains, session-only group B present in /sessions");
}

// ── step 7: hide project B + screenshot #2 (directive #2, item 2) ──

async function step7HideB(ctx) {
  await apiAction(ctx, 7, "/projects/hide", { workspace: ctx.tmpB });

  const state = await getFullState(ctx, 7);
  const hidden = state?.snapshot?.hiddenWorkspaces ?? [];
  assert(7, hidden.includes(ctx.tmpB), `hiddenWorkspaces does not include B after hide: ${JSON.stringify(hidden)}`);

  await saveScreenshot(ctx, "step-2-hidden");
  pass(7, "project B hidden: hiddenWorkspaces includes B");
}

// ── step 8: guard negative — hiding a project with an open tab is refused ──

async function step8GuardOpenTabs(ctx) {
  const resp = await api(ctx, "POST", "/projects/hide", { workspace: ctx.tmpA });
  assert(8, resp.status === 200, `expected HTTP 200 for the guarded hide attempt on A, got ${resp.status}: ${JSON.stringify(resp.body)}`);
  assert(8, resp.body?.ok === false, `expected {ok:false} hiding A (open tab), got: ${JSON.stringify(resp.body)}`);
  assert(
    8,
    resp.body?.reason === "project_has_open_tabs",
    `expected reason "project_has_open_tabs", got: ${JSON.stringify(resp.body)}`,
  );

  const state = await getFullState(ctx, 8);
  const hidden = state?.snapshot?.hiddenWorkspaces ?? [];
  assert(
    8,
    hidden.length === 1 && hidden.includes(ctx.tmpB) && !hidden.includes(ctx.tmpA),
    `hiddenWorkspaces should still be exactly [B], got ${JSON.stringify(hidden)}`,
  );

  pass(8, "guard negative verified: hiding A (open tab) rejected, hiddenWorkspaces unchanged ([B] only)");
}

// ── step 9: self-heal — reopening B prunes it from hiddenWorkspaces + screenshot #3 ──

async function step9SelfHealB(ctx) {
  const result = await apiOk(ctx, 9, "POST", "/projects/new", { workspace: ctx.tmpB });
  assert(9, result?.ok === true, `/projects/new (self-heal) rejected: ${JSON.stringify(result)}`);
  assert(9, result.workspace === ctx.tmpB, `workspace mismatch in self-heal /projects/new response: ${JSON.stringify(result)}`);
  assert(9, typeof result.tabId === "string" && result.tabId.length > 0, `missing tabId in self-heal /projects/new response: ${JSON.stringify(result)}`);
  ctx.tabB = result.tabId; // a NEW tab id — the earlier B tab was closed in step 6

  await waitUntilTab(ctx, 9, ctx.tabB, { connection: "ready" });

  const state = await getFullState(ctx, 9);
  const hidden = state?.snapshot?.hiddenWorkspaces ?? [];
  assert(9, !hidden.includes(ctx.tmpB), `hiddenWorkspaces still includes B after self-heal: ${JSON.stringify(hidden)}`);

  await saveScreenshot(ctx, "step-3-self-heal");
  pass(9, `self-heal verified: reopening B (tab ${ctx.tabB}) pruned it from hiddenWorkspaces`);
}

// ── step 10: teardown ──

/**
 * codex P7.3-F2 finding 3 (transcript-follow-smoke.mjs sibling — same clone,
 * same fix): `step10Teardown` is now a thin memoizing wrapper around
 * `runStep10Teardown` — every caller (normal end-of-run() and the
 * SIGINT/SIGTERM handler) awaits the SAME shared promise, so a signal that
 * lands while teardown is already mid-flight genuinely waits for that real
 * work to finish instead of a stale boolean flag reading "already done" and
 * the signal handler's `process.exit(1)` killing the process out from under
 * an in-progress quit/rmSync.
 */
function step10Teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runStep10Teardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runStep10Teardown(ctx, failedStep) {
  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        // We own this app instance (spawned it ourselves) — quit it outright.
        await api(ctx, "POST", "/quit", {});
      } else {
        // --attach: this instance was NOT ours to begin with (opt-in reuse of a

        // created, never quit someone else's running session.
        if (ctx.tabA) {
          await api(ctx, "POST", `/tabs/${ctx.tabA}/close`, {});
        }
        if (ctx.tabB) {
          await api(ctx, "POST", `/tabs/${ctx.tabB}/close`, {});
        }
      }
    } catch {
      // best-effort — the app/tabs may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[sidebar-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[sidebar-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const tmp of [ctx.tmpA, ctx.tmpB]) {
    if (tmp && existsSync(tmp)) {
      if (FLAGS.keep) {
        console.log(`[sidebar-ui-smoke] --keep set, workspace preserved at: ${tmp}`);
      } else {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[sidebar-ui-smoke] failed to remove temp workspace ${tmp}: ${err?.message ?? err}`);
        }
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[sidebar-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[sidebar-ui-smoke] failed to remove automation profile ${ctx.profile}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[sidebar-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

/**
 * Ctrl-C / kill mid-run must still tear the spawned app + per-run temp
 * profile down (codex finding: a bare process.exit on SIGINT leaked both).
 * `step10Teardown`'s shared `ctx.teardownPromise` (codex P7.3-F2 finding 3)
 * means a signal landing while the normal run()-tail teardown is already
 * executing genuinely AWAITS that same in-flight cleanup instead of treating
 * a stale "already started" flag as "already finished" and exiting out from
 * under it.
 */
function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[sidebar-ui-smoke] received ${signal} — tearing down…`);
    step10Teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[sidebar-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpA: null,
    tmpB: null,
    port: undefined,
    token: undefined,
    tabA: null,
    tabB: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "sidebar-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapWorkspaces(ctx);
    await step2LaunchApp(ctx);
    await step3DiscoverBootTabA(ctx);
    await step4ProjectNewB(ctx);
    await step5ChipDatum(ctx);
    await step6CloseTabB(ctx);
    await step7HideB(ctx);
    await step8GuardOpenTabs(ctx);
    await step9SelfHealB(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[sidebar-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await step10Teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[sidebar-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

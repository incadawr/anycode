/**
 * Live GUI smoke for the "New Task" start screen — P7.12 F5#1a (design
 * §5 W2 / §6) extended by F5#1b (design/slice-F5-1b-cut.md §2-D2/D3/D4):
 * drives a REAL Electron dev instance end-to-end over the automation HTTP
 * channel (`main/automation/*`) and asserts the start screen
 * (`StartScreen.tsx`) through the dedicated `GET /start-screen` probe + the
 * `POST /start-screen/*` action routes — including F5#1b's merged
 * project-picker popover (`project-menu`) and task-model chip (`model`) — then
 * verifies the post-submit session actually ran the first prompt with the
 * PICKED model (transcript head block + a live assistant reply + the tab's
 * effective model), plus PNG evidence via `GET /screenshot` — owner judges by
 * the visible artifact (task-vocabulary labels + project control + model chip
 * on the start card), so a green gate alone is not sufficient proof here. No
 * new automation surface is needed to assert the F5#1b rename itself: D4
 * confines the new facade surface to `model`/`projectMenuOpen` (data), so the
 * rename is proven visually through the PNGs below, not a new text probe.
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `todo-panel-smoke.mjs` (same P7.H per-run disposable profile discipline);
 * `discoverTabByWorkspace` is the same helper too (used here to find the BOOT
 * tab so its already-mounted ModelPill can supply a real catalog model id —
 * see step 2).
 *
 * Usage:   node apps/desktop/scripts/start-screen-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch.
 *   --keep         Do not delete the temp workspaces/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires a configured provider (ambient env ANYCODE_API_KEY / ANYCODE_MODEL /
 * ANYCODE_BASE_URL already set by the caller, OR a pre-configured default
 * profile reached via --attach) capable of trivially answering one prompt,
 * with a catalog exposing at least one model id (step 2 reads it live off the
 * boot tab's ModelPill state — never invented/hardcoded).
 *
 * Each of the 7 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1 — every step here is hard, no documented SKIP path.
 * PNG evidence is written to a per-run directory under the system temp folder,
 * never under `apps/desktop/out` (which is a release-build input).
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
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 250;

/** Trivially answerable — the assertion only needs a non-empty assistant reply, not a specific answer. */
const FIRST_PROMPT_TEXT = "Reply with exactly one word: pong";

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
      console.warn(`[start-screen-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from todo-panel-smoke.mjs) ──

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

// ── HTTP helpers against the automation channel (main/automation/README.md routes) ──

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

/**
 * Poll `GET /state` until the renderer facade has finished installing (same
 * rationale as the other smokes: DEV dynamic import races the page load).
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

/** Lifted verbatim from `todo-panel-smoke.mjs`: polls `GET /state` until a tab with this exact (canonicalized) workspace shows up. */
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

/** `GET /start-screen` — the dedicated probe this slice adds (design §5 W2, main/automation/README.md). */
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

/** Polls `GET /start-screen` until `predicate(state)` holds, or fails the step on timeout. */
async function pollStartScreenState(ctx, step, predicate, timeoutMs, describeExpectation) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await getStartScreenState(ctx, step);
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `timed out after ${timeoutMs}ms waiting for ${describeExpectation}; last state=${JSON.stringify(last)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Polls `GET /state/:tabId` until `predicate(tabState)` holds, or fails the step on timeout. */
async function pollTabState(ctx, step, tabId, predicate, timeoutMs, describeExpectation) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const resp = await apiOk(ctx, step, "GET", `/state/${tabId}`);
    last = resp?.snapshot?.states?.[tabId];
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `timed out after ${timeoutMs}ms waiting for ${describeExpectation}; last tab state=${JSON.stringify(last)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[start-screen-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[start-screen-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

// ── step 1: bootstrap two temp workspaces + launch (or attach to) the dev app ──
// tmpWorkspaceA is the BOOT workspace (existing scaffold -> shell + one boot
// tab, so the app never lands on the first-run Welcome gate); tmpWorkspaceB
// is the workspace the start-screen draft is submitted against in step 3/4.

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspaceA = mkdtempSync(join(tmpdir(), "anycode-start-screen-smoke-boot-"));
    writeFileSync(join(ctx.tmpWorkspaceA, "seed.txt"), "hello from start-screen smoke (boot workspace)\n");
    ctx.tmpWorkspaceB = mkdtempSync(join(tmpdir(), "anycode-start-screen-smoke-draft-"));
    writeFileSync(join(ctx.tmpWorkspaceB, "seed.txt"), "hello from start-screen smoke (draft workspace)\n");
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

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
    await apiOk(ctx, 1, "GET", "/health");
    pass(1, `attached to running app (pid=${info.pid}, port=${info.port}); draft workspace=${ctx.tmpWorkspaceB}`);
    return;
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): isolates
  // userData/db/discovery so this run never collides with a parallel smoke
  // or manual dev session.
  const profile = mkdtempSync(join(tmpdir(), "anycode-start-screen-smoke-profile-"));
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
    ANYCODE_WORKSPACE: ctx.tmpWorkspaceA,
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
  await apiOk(ctx, 1, "GET", "/health");
  pass(1, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}, profile=${profile}`);
}

// ── step 2: discover a REAL catalog model id off the boot tab's ModelPill
// (F5#1b, design §2-D3) — the task-model chip's picker lists the active
// provider's catalog, same source `ModelPill.tsx`/`StartScreen.tsx` both
// read; this step never invents/hardcodes an id, it reads one live. ──

async function step2DiscoverCatalogModel(ctx) {
  const step = 2;
  await waitForFacade(ctx, step);

  // The model catalog is provider/settings-derived (ModelPill reads the active
  // provider's catalog, not anything workspace-specific), so ANY real,
  // ready tab can supply it. Fresh-launch reuses the app's own boot tab
  // (tmpWorkspaceA is wired to it via ANYCODE_WORKSPACE at spawn time in step
  // 1). --attach never gets that boot tab — ANYCODE_WORKSPACE only applies to
  // a process THIS script spawns, and under --attach it spawns nothing — so
  // discoverTabByWorkspace(tmpWorkspaceA) would poll for a tab that can never
  // appear and time out after 90s (codex #4). Fixed by creating a real tab of
  // our own under --attach, the same way model-pill-smoke.mjs's step 1 does.
  if (ctx.child === null) {
    const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspaceA });
    if (created?.ok !== true) {
      fail(step, `tab creation failed under --attach: ${JSON.stringify(created)}`);
    }
    ctx.bootTabId = created.tabId;
    ctx.bootTabSelfCreated = true;
  } else {
    ctx.bootTabId = await discoverTabByWorkspace(ctx, step, ctx.tmpWorkspaceA);
  }
  await waitUntilTab(ctx, step, ctx.bootTabId, { connection: "ready" }, 60_000);
  // ModelPill (and thus modelItems) only ever reads off the ACTIVE tab.
  await apiAction(ctx, step, `/tabs/${ctx.bootTabId}/select`, {});

  const deadline = Date.now() + 20_000;
  let pillState = null;
  for (;;) {
    pillState = await apiOk(ctx, step, "GET", `/tabs/${ctx.bootTabId}/model-pill`);
    if (pillState?.ok === true && Array.isArray(pillState.modelItems) && pillState.modelItems.length > 0) {
      break;
    }
    if (Date.now() >= deadline) {
      fail(step, `boot tab's model-pill never reported a non-empty catalog within 20000ms, last=${JSON.stringify(pillState)}`);
    }
    await sleep(200);
  }

  // MUST be an id DIFFERENT from the tab's current model — otherwise every
  // downstream "model changed" assertion (steps 5/7) would trivially pass
  // against a no-op pick even if the write-through were completely broken
  // (codex #2: a same-as-boot fallback makes the smoke tautological). If the
  // catalog only ever exposes the boot model, this smoke CANNOT prove a
  // switch on this provider, so it fails loudly instead of silently
  // degrading into that tautology.
  const alternative = pillState.modelItems.find((item) => item.id !== pillState.currentModel);
  assert(
    step,
    alternative !== undefined,
    `catalog has no alternative model to prove a task-model switch — cannot validate F5#1b on this provider ` +
      `(currentModel=${JSON.stringify(pillState.currentModel)}, modelItems=${JSON.stringify(pillState.modelItems)})`,
  );
  ctx.pickedModelId = alternative.id;
  assert(step, typeof ctx.pickedModelId === "string" && ctx.pickedModelId.length > 0, `expected a real model id, got ${JSON.stringify(pillState)}`);

  pass(step, `picked model "${ctx.pickedModelId}" from the live catalog (boot tab's current model: ${JSON.stringify(pillState.currentModel)})`);
}

// ── step 3: open the draft -> GET /start-screen (design §6 step 2; F5#1b
// rename + slice-start-composer-cut §5 preselect): the draft now seeds its
// workspace from `deriveRecentWorkspaces(...)[0]` once recents arrive after
// listSessions, so workspace is the boot workspace (recents[0]) — NOT null
// as in the pre-§5 cut. sendEnabled stays false here only because the prompt
// is still empty (§3-D3 gate); once a prompt lands (step 4), it flips true
// without a manual folder pick — the §5 proof. ──

async function step3OpenStartScreen(ctx) {
  const step = 3;

  await apiAction(ctx, step, "/start-screen/open", {});
  // §5: the seed writes setDraftWorkspace(recents[0]) asynchronously after
  // listSessions resolves — poll for the workspace to be preselected (or fall
  // through to empty-recents if the boot session hasn't recorded yet).
  const state = await pollStartScreenState(
    ctx,
    step,
    (s) => s.rendered === true && s.active === true,
    20_000,
    "rendered:true + active:true after open",
  );

  assert(step, state.active === true, `expected active:true, got ${JSON.stringify(state)}`);
  assert(step, state.projectMenuOpen === false, `expected projectMenuOpen:false before the project control is clicked, got ${JSON.stringify(state)}`);
  // §5 preselect: once the boot session's workspace enters recents, the seed
  // writes it onto the draft. This is the new contract — the OLD cut asserted
  // workspace:null here. If recents haven't populated yet the draft stays
  // null (legitimate empty-recents gate); either way sendEnabled is false
  // because the prompt is still empty (§3-D3), asserted in step 4.
  if (state.workspace !== null) {
    assert(
      step,
      canonPath(state.workspace) === canonPath(ctx.tmpWorkspaceA),
      `§5 seed: expected workspace===boot workspace ${ctx.tmpWorkspaceA} (recents[0]), got ${JSON.stringify(state.workspace)}`,
    );
  }
  // Compositor paint lags a tick behind the React commit the assertions above
  // just observed — without this the screenshot can capture a blank frame.
  await sleep(400);
  // Visual proof of the composer-style new-task state (slice-start-composer-
  // cut): env-row above the composer card, project chip preselected, model
  // chip in the footer-left, circular send in footer-right. The owner
  // eyeballs this PNG; no JSON field carries raw label text (design §2-D4
  // keeps the facade surface to model/projectMenuOpen only).
  await saveScreenshot(ctx, "1-start-screen-open");
  pass(step, `start screen open and rendered, §5 seed workspace=${JSON.stringify(state.workspace)} (${JSON.stringify(state)})`);
}

// ── step 4: project popover (F5#1b §2-D2) + prompt/workspace (design §6 step 3) ──

async function step4ProjectMenuPromptWorkspace(ctx) {
  const step = 4;

  await apiAction(ctx, step, "/start-screen/prompt", { text: FIRST_PROMPT_TEXT });
  const afterPrompt = await getStartScreenState(ctx, step);
  assert(step, afterPrompt.prompt === FIRST_PROMPT_TEXT, `expected prompt to echo back, got ${JSON.stringify(afterPrompt)}`);
  // §5 seed + §3-D3 gate interaction: if the seed preselected a workspace in
  // step 3, a non-empty prompt now satisfies BOTH gate conditions → sendEnabled
  // is true (the NEW contract the pre-§5 cut couldn't assert here). If recents
  // were empty at step 3 (seed stayed null), sendEnabled is still false here
  // — the empty-recents gate. Either way the explicit setDraftWorkspace below
  // then flips it true, proving an explicit pick overwrites the seed (§5
  // invariant: explicit choice is never clobbered).
  if (afterPrompt.workspace === null) {
    assert(
      step,
      afterPrompt.sendEnabled === false,
      `D3 proof: expected sendEnabled:false with a prompt but no folder (empty recents), got ${JSON.stringify(afterPrompt)}`,
    );
  }

  const openResult = await apiOk(ctx, step, "POST", "/start-screen/project-menu", { open: true });
  assert(step, openResult?.ok === true, `open project menu rejected: ${JSON.stringify(openResult)}`);
  const openedState = await getStartScreenState(ctx, step);
  assert(step, openedState.projectMenuOpen === true, `expected projectMenuOpen:true after open, got ${JSON.stringify(openedState)}`);
  // The boot tab's own workspace (step 2) should already be a "recent" once
  // its session is up — a loose lower bound (not an exact count) so this
  // step doesn't overfit the fixture's session history.
  assert(
    step,
    openedState.recentCount >= 1,
    `expected recentCount>=1 with the boot workspace's session recorded, got ${JSON.stringify(openedState)}`,
  );

  // "or set workspace" (design task note): the facade has no click-a-specific-
  // recent-row driver, so this picks the project the same way Browse… would —
  // through the draft's own setDraftWorkspace seam — while the popover is
  // open, proving the popover state and the workspace write coexist correctly.
  await apiAction(ctx, step, "/start-screen/workspace", { workspace: ctx.tmpWorkspaceB });

  const closeResult = await apiOk(ctx, step, "POST", "/start-screen/project-menu", { open: false });
  assert(step, closeResult?.ok === true, `close project menu rejected: ${JSON.stringify(closeResult)}`);
  const afterWorkspace = await getStartScreenState(ctx, step);
  assert(step, afterWorkspace.projectMenuOpen === false, `expected projectMenuOpen:false after close, got ${JSON.stringify(afterWorkspace)}`);
  assert(step, afterWorkspace.recentCount === 0, `expected recentCount:0 while the popover is closed, got ${JSON.stringify(afterWorkspace)}`);
  assert(
    step,
    afterWorkspace.sendEnabled === true,
    `expected sendEnabled:true once a folder is chosen, got ${JSON.stringify(afterWorkspace)}`,
  );
  assert(
    step,
    afterWorkspace.workspace === ctx.tmpWorkspaceB,
    `expected workspace===${ctx.tmpWorkspaceB}, got ${JSON.stringify(afterWorkspace)}`,
  );

  pass(step, `project popover open->recents(${openedState.recentCount})->closed, sendEnabled flips false->true (${JSON.stringify(afterWorkspace)})`);
}

// ── step 5: task-model pick (F5#1b §2-D3) ──

async function step5SetModel(ctx) {
  const step = 5;

  const setResult = await apiOk(ctx, step, "POST", "/start-screen/model", { model: ctx.pickedModelId });
  assert(step, setResult?.ok === true, `set model rejected: ${JSON.stringify(setResult)}`);
  const afterModel = await getStartScreenState(ctx, step);
  assert(
    step,
    afterModel.model === ctx.pickedModelId,
    `expected draft.model===${ctx.pickedModelId}, got ${JSON.stringify(afterModel)}`,
  );

  // Same compositor-settle rationale as step 3's screenshot — this is the PNG
  // showing the start card WITH the model chip + project control populated,
  // just before submit.
  await sleep(400);
  await saveScreenshot(ctx, "2-start-screen-env-set");
  pass(step, `task-model set to "${ctx.pickedModelId}" (${JSON.stringify(afterModel)})`);
}

// ── step 6: submit -> new tab created + start screen closes (design §6 step 4) ──

async function step6Submit(ctx) {
  const step = 6;

  const submitResult = await apiOk(ctx, step, "POST", "/start-screen/submit", {});
  assert(step, submitResult?.ok === true, `submit rejected: ${JSON.stringify(submitResult)}`);
  assert(step, typeof submitResult.tabId === "string" && submitResult.tabId.length > 0, `expected a tabId, got ${JSON.stringify(submitResult)}`);
  ctx.tabId = submitResult.tabId;

  const afterSubmit = await getStartScreenState(ctx, step);
  assert(step, afterSubmit.active === false, `expected active:false after submit, got ${JSON.stringify(afterSubmit)}`);

  const stateResp = await apiOk(ctx, step, "GET", "/state");
  const snapshot = stateResp?.snapshot ?? {};
  const tabs = snapshot.tabs ?? [];
  const tabIds = tabs.map((t) => t.tabId);
  assert(step, tabIds.includes(ctx.tabId), `expected tab ${ctx.tabId} in /state, got tabs=${JSON.stringify(tabIds)}`);
  assert(step, snapshot.activeTabId === ctx.tabId, `expected activeTabId===${ctx.tabId}, got ${JSON.stringify(snapshot.activeTabId)}`);
  // tabs[].workspace (tabs-store TabInfo) is set synchronously by addTab at submit time;
  // states[tabId].workspace (host session state) stays null until host_ready arrives for
  // this tab, which races this step — see step 7 for the host-state-backed assertion.
  const tabInfo = tabs.find((t) => t.tabId === ctx.tabId);
  assert(
    step,
    canonPath(tabInfo?.workspace ?? "") === canonPath(ctx.tmpWorkspaceB),
    `expected the new tab's workspace===${ctx.tmpWorkspaceB}, got ${JSON.stringify(tabInfo?.workspace)}`,
  );

  pass(step, `submit created+focused tab ${ctx.tabId} for workspace ${ctx.tmpWorkspaceB}`);
}

// ── step 7: the queued first prompt actually ran, WITH the picked model
// (design §6 step 5, extended by F5#1b §2-D3) ──

async function step7WaitForFirstTurn(ctx) {
  const step = 7;

  await waitUntilTab(ctx, step, ctx.tabId, { connection: "ready" }, 60_000);

  const readyStateResp = await apiOk(ctx, step, "GET", `/state/${ctx.tabId}`);
  const readyTabState = readyStateResp?.snapshot?.states?.[ctx.tabId];
  assert(
    step,
    canonPath(readyTabState?.workspace ?? "") === canonPath(ctx.tmpWorkspaceB),
    `expected the host session's workspace===${ctx.tmpWorkspaceB} once connection is ready, got ${JSON.stringify(readyTabState?.workspace)}`,
  );
  // The F5#1b delivery seam (design §2-D3): host_ready flips connection:"ready"
  // with the BOOT model FIRST — the pending set_model for the picked model
  // lands asynchronously afterwards via model_changed. A single synchronous
  // read here would race that ack and could observe the stale boot model even
  // when the write-through is working correctly (codex #1), so convergence to
  // the picked model must be POLLED, not read once off the same snapshot as
  // the connection-ready check above.
  await pollTabState(
    ctx,
    step,
    ctx.tabId,
    (s) => s?.model === ctx.pickedModelId,
    20_000,
    `the new tab's effective model to converge to ${ctx.pickedModelId} (started at ${JSON.stringify(readyTabState?.model)})`,
  );

  // Both predicates in one /wait call so a fast/trivial reply that completes
  // between two separate polls can't be missed (matchesUntil ANDs every key
  // against the SAME snapshot read).
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle", transcriptIncludes: FIRST_PROMPT_TEXT }, 120_000);

  const stateResp = await apiOk(ctx, step, "GET", `/state/${ctx.tabId}`);
  const finalTabState = stateResp?.snapshot?.states?.[ctx.tabId];
  const transcript = finalTabState?.transcript ?? [];
  assert(step, transcript.length > 0, `expected a non-empty transcript, got ${JSON.stringify(transcript)}`);
  const head = transcript[0];
  assert(step, head?.kind === "user_text", `expected the head block to be user_text, got ${JSON.stringify(head)}`);
  assert(step, head?.text === FIRST_PROMPT_TEXT, `expected the head block's text to be the exact submitted prompt, got ${JSON.stringify(head)}`);
  assert(
    step,
    transcript.length > 1,
    `expected at least one assistant block after the head user_text, got only ${transcript.length} block(s)`,
  );
  assert(
    step,
    finalTabState?.model === ctx.pickedModelId,
    `expected the tab's effective model to STILL be ${ctx.pickedModelId} after the first turn, got ${JSON.stringify(finalTabState?.model)}`,
  );

  // Same compositor-settle rationale as step 3's screenshot.
  await sleep(400);
  await saveScreenshot(ctx, "3-session-after-submit");
  pass(step, `first turn ran with model=${finalTabState.model}: head=user_text(${JSON.stringify(head.text)}), ${transcript.length} block(s) total`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  // An unsuccessful tab close leaves the tab (and the app it lives in) alive
  // pointed at the draft workspace — only meaningful on the --attach path
  // (ctx.child is null there); the owned-app path quits the whole process
  // instead of closing one tab, so both temp workspaces are safe to remove
  // regardless.
  let tabCloseFailed = false;

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else {
        if (ctx.tabId) {
          const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
          if (closeResp.body?.ok !== true) {
            tabCloseFailed = true;
            console.warn(
              `[start-screen-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
                `a tab is still open on the draft workspace; leaving it on disk instead of deleting out from under it`,
            );
          }
        }
        // Under --attach, step 2 creates its own tab (the app's real boot tab
        // scaffold doesn't exist there) — close it too so this run doesn't
        // leak a stray tab into the attached app.
        if (ctx.bootTabSelfCreated && ctx.bootTabId && ctx.bootTabId !== ctx.tabId) {
          const closeBootResp = await api(ctx, "POST", `/tabs/${ctx.bootTabId}/close`, {});
          if (closeBootResp.body?.ok !== true) {
            console.warn(
              `[start-screen-smoke] self-created boot tab close rejected (reason=${closeBootResp.body?.reason ?? "unknown"})`,
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
      console.warn(`[start-screen-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[start-screen-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const [label, dir] of [
    ["boot", ctx.tmpWorkspaceA],
    ["draft", ctx.tmpWorkspaceB],
  ]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[start-screen-smoke] --keep set, ${label} workspace preserved at: ${dir}`);
    } else if (label === "draft" && tabCloseFailed) {
      console.warn(`[start-screen-smoke] tab close failed — NOT deleting draft workspace (a live tab may still reference it): ${dir}`);
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[start-screen-smoke] failed to remove ${label} workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[start-screen-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[start-screen-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[start-screen-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[start-screen-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[start-screen-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspaceA: null,
    tmpWorkspaceB: null,
    port: undefined,
    token: undefined,
    tabId: null,
    bootTabId: null,
    bootTabSelfCreated: false,
    pickedModelId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    screenshotDir: mkdtempSync(join(tmpdir(), "anycode-start-screen-smoke-evidence-")),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverCatalogModel(ctx);
    await step3OpenStartScreen(ctx);
    await step4ProjectMenuPromptWorkspace(ctx);
    await step5SetModel(ctx);
    await step6Submit(ctx);
    await step7WaitForFirstTurn(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[start-screen-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[start-screen-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

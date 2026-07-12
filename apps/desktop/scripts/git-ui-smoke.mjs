/**
 * Live GUI smoke for the git UI (design slice-5.8-R8-cut.md §2.4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`) against a real temp git
 * repository, exercising the full stack facade -> sendToTab -> host GitBridge
 * -> NodeGitAdapter -> real `git` -> git_result -> store -> facade readback.
 * It deliberately does NOT re-implement what the UI does on its own: opening
 * the panel and switching to the history tab must trigger the REAL
 * GitPanel effects (refresh+branches / lazy log) — if those effects break,

 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (assert-package.mjs,
 * fix-node-pty-perms.mjs).
 *
 * Usage:   node apps/desktop/scripts/git-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it

 *                   attaching is an explicit opt-in to reuse a foreign/dev
 *                   instance, not a license to kill someone else's session).
 *   --keep         Do not delete the temp git workspace on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Each of the 13 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (panel/diff/confirm-dialog) is
 * written to `apps/desktop/out/git-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
/** Mirrors protocol.ts's GIT_WIRE_DIFF_MAX_CHARS — kept as a local literal (this
 *  script must have zero deps, so it cannot import the shared TS module). */
const GIT_WIRE_DIFF_MAX_CHARS = 500_000;
/** Comfortably above the wire cap so the worktree diff of big.txt is guaranteed
 *  to be truncated (design §2.4 step 1: "~600k+ chars of new content"). */
const BIG_FILE_MIN_CHARS = 650_000;
const TOTAL_STEPS = 13;
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
      console.warn(`[git-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers ──

/** Runs one git command in `cwd`, throwing a descriptive Error on non-zero exit. */
function git(cwd, ...gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(`git ${gitArgs.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

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

/** Deterministic, uniquely-lined filler so the whole file lands in one big diff hunk. */
function buildBigContent(minChars) {
  const parts = [];
  let total = 0;
  let i = 0;
  while (total < minChars) {
    const line = `bigfile-line-${i}-${"x".repeat(40)}\n`;
    parts.push(line);
    total += line.length;
    i += 1;
  }
  return parts.join("");
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

/** `POST /wait` + hard-fail if the condition never matched within the timeout. */
async function waitUntil(ctx, step, until, timeoutMs) {
  const body = { tabId: ctx.tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} did not match: ${JSON.stringify(result)}`);
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

/** `GET /state/:tabId`, narrowed to this run's tab (design §2.1a: git rides the existing snapshot). */
async function getTabState(ctx, step) {
  const resp = await apiOk(ctx, step, "GET", `/state/${encodeURIComponent(ctx.tabId)}`);
  const state = resp?.snapshot?.states?.[ctx.tabId];
  if (state === undefined) {
    fail(step, `no state for tab ${ctx.tabId} in /state/:tabId response: ${JSON.stringify(resp)}`);
  }
  return state;
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[git-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[git-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

// ── step 1: bootstrap a real temp git workspace ──

function step1BootstrapWorkspace(ctx) {
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "anycode-git-smoke-"));
    ctx.tmp = tmp; // set immediately: teardown can clean this up even if a later git op throws

    git(tmp, "init", "-b", "main");
    git(tmp, "config", "user.name", "AnyCode Smoke");
    git(tmp, "config", "user.email", "smoke@anycode.local");
    // Defensive: a machine-wide `commit.gpgsign=true` would otherwise hang/fail
    // the seed commit below; this is local to the temp repo only.
    git(tmp, "config", "commit.gpgsign", "false");

    const seedA = "hello from a.txt\n";
    writeFileSync(join(tmp, "a.txt"), seedA);
    writeFileSync(join(tmp, "big.txt"), "seed content for big.txt\n");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-m", "seed: initial commit");

    // This exact content is what steps 6/7 later stage+commit as "smoke: R8" —
    // captured now as the expected value for step 10's discard round-trip and
    // step 12's disk-invariance check.
    const dirtyA = seedA + "a dirty edit line\n";
    writeFileSync(join(tmp, "a.txt"), dirtyA);
    ctx.committedA = dirtyA;

    // Rewrite big.txt wholesale with >600k chars of unique content so its
    // worktree diff exceeds GIT_WIRE_DIFF_MAX_CHARS, guaranteeing truncation.
    writeFileSync(join(tmp, "big.txt"), buildBigContent(BIG_FILE_MIN_CHARS));

    const uContent = "untracked scratch file\n";
    writeFileSync(join(tmp, "u.txt"), uContent);
    ctx.uContent = uContent;

    const statusOut = git(tmp, "status", "--porcelain=v1");
    const dirtyLines = statusOut.split("\n").filter((l) => l.trim().length > 0);
    if (dirtyLines.length !== 3) {
      fail(1, `expected 3 dirty entries after bootstrap, git status shows ${dirtyLines.length}:\n${statusOut}`);
    }
  } catch (err) {
    if (err instanceof SmokeFailure) {
      throw err;
    }
    fail(1, `bootstrap error: ${err?.message ?? err}`);
  }

  pass(1, `temp workspace bootstrapped at ${tmp} (dirtyCount=3: a.txt+big.txt unstaged, u.txt untracked)`);
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
  // ~/.anycode/automation.json collision between concurrent sessions. Set on
  // ctx immediately so teardown can remove it even if a later step throws.
  const profile = mkdtempSync(join(tmpdir(), "anycode-git-smoke-profile-"));
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
  delete env.ANYCODE_WORKSPACE; // the smoke creates its own tab explicitly (step 3)
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

// ── step 3: create the tab against the temp workspace ──

async function step3CreateTab(ctx) {
  const created = await apiOk(ctx, 3, "POST", "/tabs", { kind: "new", workspace: ctx.tmp });
  if (created?.ok !== true) {
    fail(3, `tab creation failed: ${JSON.stringify(created)}`);
  }
  ctx.tabId = created.tabId;
  // The facade install races the page load (DEV dynamic import); wait it out
  // before any facade-backed call (/wait, /state) so the readiness poll below
  // doesn't 503 on a not-yet-installed facade.
  await waitForFacade(ctx, 3);
  await waitUntil(ctx, 3, { connection: "ready" });
  pass(3, `tab ${ctx.tabId} created for ${ctx.tmp}, connection ready`);
}

// ── step 4: git pill alive + initial dirty status ──

async function step4GitStatusKnown(ctx) {
  // The host pushes the first git_status via `sendDirect` on UI-port bind
  // (host/index.ts pushSnapshot → git-bridge.ts). sendDirect is un-buffered and
  // NOT replayed, so if the renderer's port receiver isn't wired at that instant
  // the snapshot is lost with no recovery — a freshly-opened single tab can miss
  // its git pill entirely (pre-existing slice-5.7 race; see PROGRESS residual
  // "git_status-on-bind delivery"). Bounded so this surfaces as a crisp
  // diagnosis rather than a 60 s stall.
  let waited;
  try {
    waited = await waitUntil(ctx, 4, { gitStatusKnown: true }, 25_000);
  } catch (err) {
    console.error(
      "           HINT: git.statusKnown never flipped true — the host's bind-time\n" +
        "           git_status (sendDirect, no replay) likely raced the renderer port\n" +
        "           setup and was dropped. This is a pre-existing 5.7 host delivery\n" +
        "           race the R8 live smoke exposed; it is NOT an R8-facade defect.",
    );
    throw err;
  }
  void waited;
  const state = await getTabState(ctx, 4);
  const git = state.git;
  assert(4, git != null && git.status !== null, `git.status is null: ${JSON.stringify(git)}`);
  assert(4, git.status.dirtyCount === 3, `expected dirtyCount=3, got ${git.status.dirtyCount}`);
  const unstagedPaths = git.status.unstaged.map((f) => f.path);
  assert(
    4,
    unstagedPaths.includes("a.txt") && unstagedPaths.includes("big.txt"),
    `unstaged missing a.txt/big.txt: ${JSON.stringify(unstagedPaths)}`,
  );
  assert(4, git.status.untracked.includes("u.txt"), `untracked missing u.txt: ${JSON.stringify(git.status.untracked)}`);
  pass(4, "git pill alive: dirtyCount=3, unstaged ⊇ {a.txt,big.txt}, untracked ⊇ {u.txt}");
}

// ── step 5: open the panel (real panel-effect must fire refresh+branches) ──

async function step5OpenPanel(ctx) {
  await apiAction(ctx, 5, `/tabs/${ctx.tabId}/git/panel`, { open: true });
  await waitUntil(ctx, 5, { gitPendingEmpty: true });
  const state = await getTabState(ctx, 5);
  assert(5, state.git.panelOpen === true, "git.panelOpen is not true after open");
  const branchNames = (state.git.branches ?? []).map((b) => b.name);
  assert(5, branchNames.includes("main"), `git.branches missing "main" (panel-effect did not fire?): ${JSON.stringify(branchNames)}`);
  await saveScreenshot(ctx, "step-05-panel-open");
  pass(5, "panel open; real panel-effect dispatched refresh+branches (branches include main)");
}

// ── step 6: stage a.txt ──

async function step6Stage(ctx) {
  await apiAction(ctx, 6, `/tabs/${ctx.tabId}/git`, { command: { op: "stage", paths: ["a.txt"] } });
  await waitUntil(ctx, 6, { gitPendingEmpty: true });
  const state = await getTabState(ctx, 6);
  const stagedPaths = (state.git.status?.staged ?? []).map((f) => f.path);
  assert(6, stagedPaths.includes("a.txt"), `staged missing a.txt: ${JSON.stringify(stagedPaths)}`);
  pass(6, "a.txt staged");
}

// ── step 7: commit ──

async function step7Commit(ctx) {
  await apiAction(ctx, 7, `/tabs/${ctx.tabId}/git`, { command: { op: "commit", message: "smoke: R8" } });
  await waitUntil(ctx, 7, { gitPendingEmpty: true });
  const state = await getTabState(ctx, 7);
  assert(7, (state.git.status?.staged ?? []).length === 0, `staged not empty after commit: ${JSON.stringify(state.git.status.staged)}`);
  assert(7, state.git.lastError === null, `lastError not null after commit: ${JSON.stringify(state.git.lastError)}`);
  pass(7, 'committed "smoke: R8": staged empty, lastError null');
}

// ── step 8: history via the real lazy-log effect ──

async function step8History(ctx) {
  await apiAction(ctx, 8, `/tabs/${ctx.tabId}/git/view`, { view: "history" });
  await waitUntil(ctx, 8, { gitPendingEmpty: true });
  const state = await getTabState(ctx, 8);
  const log = state.git.log;
  assert(8, Array.isArray(log) && log.length > 0, `git.log empty/missing (lazy-log-effect did not fire?): ${JSON.stringify(log)}`);
  assert(8, log[0].subject === "smoke: R8", `log[0].subject mismatch: ${JSON.stringify(log[0])}`);
  pass(8, 'history lazy-effect fired: log[0].subject === "smoke: R8"');
}

// ── step 9: big diff, wire-truncated ──

async function step9Diff(ctx) {
  await apiAction(ctx, 9, `/tabs/${ctx.tabId}/git`, { command: { op: "diff", target: "worktree", path: "big.txt" } });
  await apiAction(ctx, 9, `/tabs/${ctx.tabId}/git/view`, { view: "diff" }); // dispatch -> setView, mirrors handleDiff order
  await waitUntil(ctx, 9, { gitPendingEmpty: true });
  const state = await getTabState(ctx, 9);
  const diff = state.git.diff;
  assert(9, diff !== null, "git.diff is null");
  assert(9, diff.path === "big.txt", `diff.path mismatch: ${JSON.stringify(diff.path)}`);
  assert(9, diff.truncated === true, `diff.truncated expected true, got ${diff.truncated}`);
  assert(
    9,
    diff.text.length > 0 && diff.text.length <= GIT_WIRE_DIFF_MAX_CHARS,
    `diff.text.length out of range: ${diff.text.length}`,
  );
  await saveScreenshot(ctx, "step-09-diff-truncated");
  pass(9, `big diff truncated=true, text.length=${diff.text.length}`);
}

// ── step 10: discard with confirm (disk assertion) ──

async function step10Discard(ctx) {
  appendFileSync(join(ctx.tmp, "a.txt"), "more garbage after commit\n");

  await apiAction(ctx, 10, `/tabs/${ctx.tabId}/git`, { command: { op: "refresh" } });
  await waitUntil(ctx, 10, { gitPendingEmpty: true });
  let state = await getTabState(ctx, 10);
  let unstagedPaths = (state.git.status?.unstaged ?? []).map((f) => f.path);
  assert(10, unstagedPaths.includes("a.txt"), `a.txt not back in unstaged after the disk edit: ${JSON.stringify(unstagedPaths)}`);

  await apiAction(ctx, 10, `/tabs/${ctx.tabId}/git/confirm`, { intent: { op: "discard", paths: ["a.txt"] } });
  state = await getTabState(ctx, 10);
  assert(10, state.git.confirm !== null, "git.confirm is null right after staging a discard intent (no dialog on screen)");
  await saveScreenshot(ctx, "step-10-confirm-dialog");

  await apiAction(ctx, 10, `/tabs/${ctx.tabId}/git/confirm/accept`, {});
  await waitUntil(ctx, 10, { gitPendingEmpty: true });
  state = await getTabState(ctx, 10);
  assert(10, state.git.confirm === null, "git.confirm not cleared after accept");
  unstagedPaths = (state.git.status?.unstaged ?? []).map((f) => f.path);
  assert(10, !unstagedPaths.includes("a.txt"), `a.txt still unstaged after discard: ${JSON.stringify(unstagedPaths)}`);

  const onDisk = readFileSync(join(ctx.tmp, "a.txt"), "utf8");
  assert(10, onDisk === ctx.committedA, "a.txt on disk does not match the committed version after discard");

  pass(10, "discard-with-confirm verified: real dialog appeared, disk content restored to the committed version");
}

// ── step 11: cancel path (no wire side effect) ──

async function step11Cancel(ctx) {
  await apiAction(ctx, 11, `/tabs/${ctx.tabId}/git/confirm`, { intent: { op: "stash_pop" } });
  await apiAction(ctx, 11, `/tabs/${ctx.tabId}/git/confirm/cancel`, {});

  const state = await getTabState(ctx, 11);
  assert(11, state.git.confirm === null, "git.confirm not null after cancel");
  assert(11, Object.keys(state.git.pending ?? {}).length === 0, "git.pending not empty after cancel");

  const uOnDisk = readFileSync(join(ctx.tmp, "u.txt"), "utf8");
  assert(11, uOnDisk === ctx.uContent, "u.txt on disk was touched by the cancelled stash_pop");

  pass(11, "cancel path verified: confirm cleared, pending empty, u.txt untouched on disk");
}

// ── step 12: destructive-bypass negative probe ──

async function step12Bypass(ctx) {
  const resp = await api(ctx, "POST", `/tabs/${ctx.tabId}/git`, {
    command: { op: "reset", mode: "hard", confirmed: true },
  });
  assert(
    12,
    resp.status === 200,
    `expected HTTP 200 for the schema-valid bypass attempt, got ${resp.status}: ${JSON.stringify(resp.body)}`,
  );
  assert(12, resp.body?.ok === false, `expected {ok:false}, got: ${JSON.stringify(resp.body)}`);
  assert(
    12,
    resp.body?.reason === "destructive_requires_confirm",
    `expected reason "destructive_requires_confirm", got: ${JSON.stringify(resp.body)}`,
  );

  const onDisk = readFileSync(join(ctx.tmp, "a.txt"), "utf8");
  assert(12, onDisk === ctx.committedA, "a.txt on disk changed despite the bypass being rejected — reset --hard executed!");

  pass(12, "bypass probe correctly rejected (destructive_requires_confirm); disk unchanged");
}

// ── step 13: teardown ──

/**
 * codex P7.3-F2 finding 3 (transcript-follow-smoke.mjs sibling — same clone,
 * same fix): `step13Teardown` is now a thin memoizing wrapper around
 * `runStep13Teardown` — every caller (normal end-of-run() and the
 * SIGINT/SIGTERM handler) awaits the SAME shared promise, so a signal that
 * lands while teardown is already mid-flight genuinely waits for that real
 * work to finish instead of a stale boolean flag reading "already done" and
 * the signal handler's `process.exit(1)` killing the process out from under
 * an in-progress quit/rmSync.
 */
function step13Teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runStep13Teardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runStep13Teardown(ctx, failedStep) {

  if (ctx.tabId && ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        // We own this app instance (spawned it ourselves) — quit it outright.
        await api(ctx, "POST", "/quit", {});
      } else {
        // --attach: this instance was NOT ours to begin with (opt-in reuse of a

        // never quit someone else's running session.
        await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[git-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[git-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmp && existsSync(ctx.tmp)) {
    if (FLAGS.keep) {
      console.log(`[git-ui-smoke] --keep set, workspace preserved at: ${ctx.tmp}`);
    } else {
      try {
        rmSync(ctx.tmp, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[git-ui-smoke] failed to remove temp workspace ${ctx.tmp}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[git-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[git-ui-smoke] failed to remove automation profile ${ctx.profile}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[git-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

/**
 * Ctrl-C / kill mid-run must still tear the spawned app + per-run temp
 * profile down (codex finding: a bare process.exit on SIGINT leaked both).
 * `step13Teardown`'s shared `ctx.teardownPromise` (codex P7.3-F2 finding 3)
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
    console.error(`\n[git-ui-smoke] received ${signal} — tearing down…`);
    step13Teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[git-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmp: null,
    committedA: null,
    uContent: null,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "git-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapWorkspace(ctx);
    await step2LaunchApp(ctx);
    await step3CreateTab(ctx);
    await step4GitStatusKnown(ctx);
    await step5OpenPanel(ctx);
    await step6Stage(ctx);
    await step7Commit(ctx);
    await step8History(ctx);
    await step9Diff(ctx);
    await step10Discard(ctx);
    await step11Cancel(ctx);
    await step12Bypass(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[git-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await step13Teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[git-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

/**
 * Live smoke for Taskana 4703 (docs/development/dock.md): the owner's exact
 * squash stack — md preview + browser preview + subagents split + git panel,
 * all open at once in a ~2000px window — must now produce ONE dock column
 * with the conversation keeping its 420px floor (it was `minmax(0,1fr)`
 * getting the scraps under ~1680px of stacked fixed columns).
 *
 * Drives a REAL Electron dev instance over the automation HTTP channel
 * (`main/automation/*`, automation/README.md) exactly the way
 * `preview-panel-live-smoke.mjs` does — no live model, mechanical only:
 * `POST /tabs/:id/previews`, `/tabs/:id/child/open`, `/tabs/:id/git/panel`,
 * the 4703-added `/dock/*` + `/window/size` routes, `GET /screenshot`.
 *
 * Legs (Stage 1 = 1-6; Stage 2 adds leg 7 via `--split`):
 *  1. tab + facade ready
 *  2. two previews (md + html) → 2 dock tabs, column mode, conversation ≥420
 *  3. THE REPRO: + subagents + git → 4 tabs, STILL one column, conversation
 *     ≥420, dock width ≤ available-428
 *  4. tab click → active switches, both previews still listed (main
 *     select/close contract intact); screenshot dock-after.png
 *  5. tab close → previews list drops it (D5 round-trip)
 *  6. window 760×600 → drawer mode, conversation ≥400; back to 1600×900 →
 *     column mode, dock re-clamped
 *  7. (Stage 2) split leg at 1800 → split:true; at 900 → auto-merged
 *
 * Every assertion is PASS/FAIL recorded, never silently assumed.
 * Plain node >=22, ZERO npm deps. Usage:
 *   node apps/desktop/scripts/dock-squash-smoke.mjs [--keep] [--split]
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const FLAGS = {
  keep: process.argv.includes("--keep"),
  split: process.argv.includes("--split"),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
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

const dodItems = [];
function record(name, status, detail) {
  dodItems.push({ name, status, detail });
  console.log(`[DoD] ${status} — ${name}${detail ? `: ${detail}` : ""}`);
}

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}
function fail(step, detail) {
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
}
function stepLog(step, detail) {
  console.log(`[step ${step}] ${detail ?? ""}`.trimEnd());
}
function assert(step, cond, detail) {
  if (!cond) fail(step, detail);
}

// ── HTTP helpers ──

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
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = { parse_error: text.slice(0, 500) };
  }
  return { status: res.status, body: parsed };
}

async function apiOk(ctx, step, method, path, body) {
  const { status, body: parsed } = await api(ctx, method, path, body);
  assert(step, status === 200, `${method} ${path} -> HTTP ${status}: ${JSON.stringify(parsed)}`);
  return parsed;
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
    if (resp.status === 200) return;
    if (Date.now() - start >= timeoutMs) {
      fail(step, `renderer facade never installed within ${timeoutMs}ms (last GET /state -> HTTP ${resp.status})`);
    }
    await sleep(150);
  }
}

// ── steps ──

function step1Prepare() {
  const ctx = {};
  const profile = mkdtempSync(join(tmpdir(), "anycode-dock-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.logPath = join(profile, "dev.log");
  const workspace = mkdtempSync(join(tmpdir(), "anycode-dock-smoke-ws-"));
  ctx.workspace = workspace;
  // The git-panel leg needs `git.statusKnown` in the tab's store — a real
  // repo in the workspace (git-ui-smoke.mjs's seed shape, minimal: init +
  // one commit so status is known and clean).
  const git = (...args) =>
    execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.name", "AnyCode Dock Smoke");
  git("config", "user.email", "dock-smoke@anycode.local");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(workspace, "README.md"), "# dock smoke workspace\n");
  git("add", "-A");
  git("commit", "-m", "seed: initial commit");
  stepLog(1, `profile=${profile} workspace=${workspace} log=${ctx.logPath}`);
  return ctx;
}

async function step2LaunchApp(ctx) {
  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    // Dummy provider credential (keybindings-ui-smoke.mjs precedent):
    // `computeProviderReady` (main/host-env.ts) only checks PRESENCE of an
    // API key + model, never validity — this smoke never sends a prompt, so
    // no live network call ever touches this key. Present only so
    // POST /tabs' not_ready gate opens.
    ANYCODE_API_KEY: "sk-dock-smoke-dummy",
    ANYCODE_MODEL: "dock-smoke-dummy-model",
  };
  delete env.ANYCODE_WORKSPACE;

  const logFd = openSync(ctx.logPath, "a");
  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  closeSync(logFd);
  ctx.child = child;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(2, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery — see ${ctx.logPath}`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(2, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  stepLog(2, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}`);
}

async function step3CreateTab(ctx) {
  const created = await apiOk(ctx, 3, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(3, created?.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  await waitForFacade(ctx, 3);
  ctx.tabId = created.tabId;
  stepLog(3, `tab ${ctx.tabId} created`);
}

/** Polls GET /dock/state until `predicate(state)` holds (layout settles async). */
async function waitForDockState(ctx, step, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await apiOk(ctx, step, "GET", "/dock/state");
    if (predicate(last)) {
      return last;
    }
    await sleep(400);
  }
  fail(step, `dock state never reached ${label} within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

async function step4TwoPreviews(ctx) {
  // A wide window first — the owner's repro was ~2000px.
  await apiOk(ctx, 4, "POST", "/window/size", { width: 1900, height: 1000 });

  const mdPath = join(ctx.workspace, "doc.md");
  const htmlPath = join(ctx.workspace, "page.html");
  writeFileSync(mdPath, "# Dock smoke\n\nMarkdown body.\n");
  writeFileSync(htmlPath, `<!doctype html><html><head><title>page</title></head><body><p>DOCK SMOKE HTML</p></body></html>\n`);

  const mdOpen = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/previews`, { path: mdPath });
  assert(4, mdOpen?.ok === true, `md open failed: ${JSON.stringify(mdOpen)}`);
  ctx.mdPreviewId = mdOpen.value.previewId;

  const htmlOpen = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/previews`, { path: htmlPath });
  assert(4, htmlOpen?.ok === true, `html open failed: ${JSON.stringify(htmlOpen)}`);
  ctx.htmlPreviewId = htmlOpen.value.previewId;

  const state = await waitForDockState(
    ctx,
    4,
    (s) => s.tabs.filter((t) => t.kind === "preview").length === 2,
    "2 preview tabs",
  );
  const convOk = state.conversationWidth !== null && state.conversationWidth >= 420;
  record(
    "two previews → 2 dock tabs, column mode, conversation ≥ 420px",
    state.mode === "column" && convOk ? "PASS" : "FAIL",
    `mode=${state.mode} conversation=${state.conversationWidth} tabs=${state.tabs.map((t) => t.id).join(",")}`,
  );
  ctx.columnAvailable = (state.conversationWidth ?? 0) + (state.width ?? 0) + 8;
}

async function step5OwnerReproStack(ctx) {
  // + subagents split + git panel — the owner's full squash stack. Entering
  // split needs layout B first (`child/open` with ANY spawnToolCallId — the
  // facade's childOpen is deliberately unconditional, automation.ts), then
  // the REAL "Split" breadcrumb click (`child/split`), which is the only
  // path into the split layout (no direct store driver by design).
  const childOpen = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: "dock-smoke-child-1" });
  assert(5, childOpen?.ok === true, `child/open failed: ${JSON.stringify(childOpen)}`);
  const enterSplit = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/child/split`);
  assert(5, enterSplit?.ok === true, `child/split failed: ${JSON.stringify(enterSplit)}`);
  const gitOpen = await (async () => {
    // The tab needs `git.statusKnown` — the store's own refresh settles
    // asynchronously after tab creation; poll the open action like the
    // facade's honest-refusal contract intends.
    const deadline = Date.now() + 20_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/git/panel`, { open: true });
      if (last?.ok === true) {
        return last;
      }
      await sleep(500);
    }
    return last;
  })();
  assert(5, gitOpen?.ok === true, `git/panel open failed: ${JSON.stringify(gitOpen)}`);

  const state = await waitForDockState(
    ctx,
    5,
    (s) => s.tabs.length === 4 && s.tabs.some((t) => t.id === "subagents") && s.tabs.some((t) => t.id === "git"),
    "4 tabs (2 previews + subagents + git)",
  );
  const available = (state.conversationWidth ?? 0) + (state.width ?? 0) + 8;
  const convOk = (state.conversationWidth ?? 0) >= 420;
  const dockClamped = (state.width ?? 0) <= Math.max(available - 428, 320);
  const stillOneColumn = state.mode === "column";
  record(
    "REPRO: previews+subagents+git → 4 tabs, ONE column, conversation ≥ 420px, dock clamped",
    convOk && dockClamped && stillOneColumn ? "PASS" : "FAIL",
    `mode=${state.mode} conversation=${state.conversationWidth} dock=${state.width} available≈${available}`,
  );
}

async function step6TabSwitch(ctx) {
  const clicked = await apiOk(ctx, 6, "POST", `/dock/tabs/${encodeURIComponent(`preview:${ctx.mdPreviewId}`)}/click`);
  assert(6, clicked?.ok === true, `dock tab click failed: ${JSON.stringify(clicked)}`);

  const state = await waitForDockState(
    ctx,
    6,
    (s) => s.tabs.find((t) => t.id === `preview:${ctx.mdPreviewId}`)?.active === true,
    "md preview tab active",
  );
  record("dock tab click focuses that tab", "PASS", `active=${state.tabs.find((t) => t.active)?.id}`);

  // The main-side list is untouched by focus switches.
  const listed = await apiOk(ctx, 6, "GET", `/tabs/${ctx.tabId}/previews`);
  const bothListed = (listed?.previews ?? []).length === 2;
  record("main preview list still has both after switch", bothListed ? "PASS" : "FAIL", `previews=${JSON.stringify(listed?.previews?.map((p) => p.previewId))}`);

  const shot = await api(ctx, "GET", "/screenshot");
  assert(6, shot.status === 200, `screenshot -> HTTP ${shot.status}`);
  const b64 = shot.body?.png ?? null;
  const png = b64 !== null ? Buffer.from(b64, "base64") : null;
  ctx.dockAfterPath = join(ctx.workspace, "dock-after.png");
  if (png !== null) {
    writeFileSync(ctx.dockAfterPath, png);
    record("screenshot dock-after.png saved", "PASS", ctx.dockAfterPath);
  } else {
    record("screenshot dock-after.png saved", "FAIL", `unexpected body keys: ${Object.keys(shot.body ?? {})}`);
  }
}

async function step7CloseTab(ctx) {
  const closed = await apiOk(ctx, 7, "POST", `/dock/tabs/${encodeURIComponent(`preview:${ctx.mdPreviewId}`)}/close`);
  assert(7, closed?.ok === true, `dock tab close failed: ${JSON.stringify(closed)}`);

  const state = await waitForDockState(ctx, 7, (s) => s.tabs.length === 3 && !s.tabs.some((t) => t.id === `preview:${ctx.mdPreviewId}`), "3 tabs, md gone");
  record("dock tab close drops the tab", "PASS", `tabs=${state.tabs.map((t) => t.id).join(",")}`);

  // D5 round-trip: the main-side close actually happened (list drops it too).
  const listed = await apiOk(ctx, 7, "GET", `/tabs/${ctx.tabId}/previews`);
  const dropped = !(listed?.previews ?? []).some((p) => p.previewId === ctx.mdPreviewId);
  record("main preview list drops the closed preview (D5 round-trip)", dropped ? "PASS" : "FAIL", `previews=${JSON.stringify(listed?.previews?.map((p) => p.previewId))}`);
}

async function step8DrawerMode(ctx) {
  await apiOk(ctx, 8, "POST", "/window/size", { width: 760, height: 600 });
  const drawer = await waitForDockState(ctx, 8, (s) => s.mode === "drawer", "drawer mode", 30_000);
  const convOk = (drawer.conversationWidth ?? 0) >= 400;
  record("760px window → drawer mode, conversation ≥ 400px (full width)", drawer.mode === "drawer" && convOk ? "PASS" : "FAIL", `mode=${drawer.mode} conversation=${drawer.conversationWidth}`);

  await apiOk(ctx, 8, "POST", "/window/size", { width: 1600, height: 900 });
  const column = await waitForDockState(ctx, 8, (s) => s.mode === "column", "column mode", 30_000);
  const reclamped = (column.width ?? 0) <= 960;
  record("back to 1600px → column mode, dock width re-clamped", column.mode === "column" && reclamped ? "PASS" : "FAIL", `mode=${column.mode} dock=${column.width}`);
}

async function step9SplitLeg(ctx) {
  if (!FLAGS.split) {
    record("split leg (Stage 2)", "SKIPPED", "run with --split");
    return;
  }
  await apiOk(ctx, 9, "POST", "/window/size", { width: 1800, height: 900 });
  await waitForDockState(ctx, 9, (s) => s.mode === "column", "column at 1800", 30_000);
  const split = await apiOk(ctx, 9, "POST", `/dock/tabs/${encodeURIComponent(`preview:${ctx.htmlPreviewId}`)}/split`);
  assert(9, split?.ok === true, `split failed: ${JSON.stringify(split)}`);
  const splitState = await waitForDockState(ctx, 9, (s) => s.split === true, "split:true", 20_000);
  record("1800px: split right → split:true", splitState.split === true ? "PASS" : "FAIL", JSON.stringify(splitState.split));

  await apiOk(ctx, 9, "POST", "/window/size", { width: 900, height: 700 });
  const merged = await waitForDockState(ctx, 9, (s) => s.split !== true, "auto-merged", 30_000);
  record("900px: below canSplit → auto-merged", merged.split !== true ? "PASS" : "FAIL", JSON.stringify(merged.split));
}

// ── teardown ──

async function runTeardown(ctx, failedStep) {
  if (ctx.port && ctx.token) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort
    }
  }
  let orphanCheckDetail = "no child process was ever spawned (step2 never ran)";
  let orphanCheckOk = true;
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (exited) {
      orphanCheckDetail = `app (pid=${ctx.child.pid}) exited cleanly within ${APP_EXIT_GRACE_MS}ms of POST /quit`;
    } else {
      console.warn(`[dock-squash-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        killTree(ctx.child.pid, "SIGKILL");
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) did not exit on /quit or SIGTERM — escalated to SIGKILL`;
      } else {
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) needed SIGTERM (no orphan left alive, but not a clean /quit-driven exit)`;
      }
    }
  }
  record("teardown: /quit leaves no orphan processes", orphanCheckOk ? "PASS" : "FAIL", orphanCheckDetail);

  if (ctx.dockAfterPath && existsSync(ctx.dockAfterPath)) {
    // Keep the screenshot OUT of the temp cleanup for the report.
    const keepPath = join(tmpdir(), "anycode-dock-smoke", `dock-after-${Date.now()}.png`);
    try {
      mkdirSync(dirname(keepPath), { recursive: true });
      copyFileSync(ctx.dockAfterPath, keepPath);
      console.log(`[dock-squash-smoke] screenshot kept at ${keepPath}`);
      ctx.keptScreenshot = keepPath;
    } catch {
      // best-effort
    }
  }

  if (!FLAGS.keep) {
    for (const dir of [ctx.workspace, ctx.profile]) {
      if (dir && existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  } else {
    console.log(`[dock-squash-smoke] --keep set, preserved: profile=${ctx.profile} workspace=${ctx.workspace}`);
  }

  console.log("\n[dock-squash-smoke] DoD summary:");
  for (const item of dodItems) {
    console.log(`  ${item.status.padEnd(8)} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  const verdict = failedStep !== null ? `STOPPED at step ${failedStep}` : anyFail ? "COMPLETED WITH FAILURES" : "ALL GREEN";
  console.log(`\n[dock-squash-smoke] ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[dock-squash-smoke] received ${signal} — tearing down…`);
    runTeardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[dock-squash-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = step1Prepare();
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step2LaunchApp(ctx);
    await step3CreateTab(ctx);
    await step4TwoPreviews(ctx);
    await step5OwnerReproStack(ctx);
    await step6TabSwitch(ctx);
    await step7CloseTab(ctx);
    await step8DrawerMode(ctx);
    await step9SplitLeg(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[dock-squash-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await runTeardown(ctx, failedStep);
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  process.exit(failedStep === null && !anyFail ? 0 : 1);
}

run().catch((err) => {
  console.error(`[dock-squash-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

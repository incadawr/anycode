/**
 * Live smoke for the detached markdown popout's main-process hardening
 * (preview-ipc-risk F1/F2): drives a REAL Electron dev instance over the
 * automation HTTP channel (main/automation/*, automation/README.md) and pins
 * the app-level behavior the unit tests cannot reach:
 *
 *   - the md preview still opens, still transfers to the WINDOW container
 *     (the popout) and back, and the popout still renders a REAL screenshot
 *     after the transfer AND its document really shows the smoke's DOC_MARKER
 *     (a PNG signature alone would pass an all-white window) — i.e. the
 *     narrowed webPreferences (dedicated in-memory `md-preview` partition,
 *     narrow-bridge argv flag), the channel-scoped IPC allow-list entry, and
 *     the (tabId, previewId) target binding did not break the feature;
 *   - the guard/target/registry entries do not outlive the window: teardown
 *     with a popout OPEN (the exact repro of the owner-visible
 *     "Object has been destroyed" main-process modal — PreviewHost.closeAll
 *     destroying a live md window whose "closed" handler used to re-read
 *     `.webContents`) must exit CLEANLY on POST /quit within the grace
 *     window. Needing SIGTERM/SIGKILL here is recorded FAIL, not tolerated;
 *   - no orphan windows/processes and no leftover temp dirs.
 *
 * The channel-scoping and own-preview binding themselves are proven by the
 * unit suites (md-window-adapter.test.ts / md-window-targets.test.ts /
 * md-doc-ipc.test.ts / panel-ipc.test.ts / artifacts-ipc.test.ts /
 * ipc-guard.test.ts / preload/index.test.ts); this smoke is the live
 * regression net for the window lifecycle + plumbing.
 *
 * Mechanical only — no live-model leg: containers are driven the same way
 * preview-panel-live-smoke.mjs drives them (POST /tabs/:id/previews[...],
 * POST .../container), which reaches PreviewHost identically to a real model
 * tool call. Every assertion is PASS/FAIL, never silently assumed.
 *
 * Plain node >=22, ZERO npm deps, matching the scripts/ precedent.
 *
 * Usage: node apps/desktop/scripts/md-popout-isolation-smoke.mjs [--keep]
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const FLAGS = { keep: process.argv.includes("--keep") };

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
    if (typeof info?.pid === "number" && typeof info?.port === "number" && typeof info?.token === "string" && typeof info?.startedAt === "number") {
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

// ── HTTP helpers (same contract as preview-panel-live-smoke.mjs) ──

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

// ── step 1: isolated profile + workspace (disposable, never the dev profile) ──

function step1Prepare() {
  const ctx = {};
  const profile = mkdtempSync(join(tmpdir(), "anycode-mdpopout-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.logPath = join(profile, "dev.log");
  const workspace = mkdtempSync(join(tmpdir(), "anycode-mdpopout-smoke-ws-"));
  ctx.workspace = workspace;
  stepLog(1, `profile=${profile} workspace=${workspace} log=${ctx.logPath}`);
  return ctx;
}

// ── step 2: launch the dev app ──

async function step2LaunchApp(ctx) {
  const t0 = Date.now();
  // A free port for Chromium's debugger: electron-vite appends
  // --remote-debugging-port when REMOTE_DEBUGGING_PORT is set (smoke-electron-
  // launch.mjs documents the lever). The document-marker assertion below reads
  // the popout's DOM over this endpoint — the same CDP route the other
  // DOM-assertion smokes use — so no new automation endpoint is invented.
  ctx.cdpPort = await pickFreePort();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    REMOTE_DEBUGGING_PORT: String(ctx.cdpPort),
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
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

// ── step 3: create a tab ──

async function step3CreateTab(ctx) {
  const created = await apiOk(ctx, 3, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(3, created?.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  await waitForFacade(ctx, 3);
  ctx.tabId = created.tabId;
  stepLog(3, `tab ${ctx.tabId} created for ${ctx.workspace}`);
}

// ── step 4: open a dom-md preview and let it settle ──

const DOC_MARKER = "md-popout isolation smoke";

async function step4OpenMdPreview(ctx) {
  const docMdPath = join(ctx.workspace, "doc.md");
  writeFileSync(docMdPath, `# ${DOC_MARKER}\n\nSome *markdown* content.\n`);
  const opened = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/previews`, { path: docMdPath });
  assert(4, opened?.ok === true, `md open failed: ${JSON.stringify(opened)}`);
  ctx.mdPreviewId = opened.value.previewId;

  let entry = null;
  for (let i = 0; i < 40; i++) {
    const listed = await apiOk(ctx, 4, "GET", `/tabs/${ctx.tabId}/previews`);
    entry = (listed?.previews ?? []).find((p) => p.previewId === ctx.mdPreviewId);
    if (entry !== undefined && entry.status !== "loading") break;
    await sleep(250);
  }
  const ok = entry !== undefined && entry.viewKind === "dom-md" && entry.status === "ready" && entry.container === "panel";
  if (ok) {
    record("doc.md opens as a native dom-md record, status ready, container panel", "PASS", JSON.stringify(entry));
  } else {
    record("doc.md opens as a native dom-md record, status ready, container panel", "FAIL", `entry=${JSON.stringify(entry)}`);
    fail(4, `md record did not settle ready in the panel: ${JSON.stringify(entry)}`);
  }
}

// ── step 5: transfer to the WINDOW container (creates the md popout) ──

/** Binds a port on 127.0.0.1, then releases it (the compact-submit smoke's free-port probe). */
function pickFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * One Runtime.evaluate channel bound to a single page target, found over
 * `/json/list` on the launch's debugger port (compact-submit-ui-smoke.mjs
 * pattern: plain node WebSocket, zero npm deps). Returns an `evaluate`
 * function and a `close()`; `null` when no matching page appeared in time.
 */
async function connectPageEvaluate(ctx, urlMatches, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let target = null;
    try {
      const list = await (await fetch(`http://127.0.0.1:${ctx.cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://") && urlMatches(t.url)) ?? null;
    } catch {
      // debugger endpoint not accepting connections yet
    }
    if (target !== null) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", resolveOpen, { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error(`CDP websocket to ${target.url} failed`)), { once: true });
      });
      const pending = new Map();
      let nextId = 0;
      ws.addEventListener("message", ({ data }) => {
        const response = JSON.parse(String(data));
        const waiter = pending.get(response.id);
        if (waiter === undefined) return;
        pending.delete(response.id);
        clearTimeout(waiter.timer);
        response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result);
      });
      const evaluate = async (expression) => {
        const id = ++nextId;
        const result = await new Promise((resolveResult, rejectResult) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectResult(new Error("Runtime.evaluate timed out"));
          }, 10_000);
          pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
          ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        });
        if (result.exceptionDetails !== undefined) {
          throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
        }
        return result.result.value;
      };
      return {
        evaluate,
        close: () => {
          try {
            ws.close();
          } catch {
            // already gone
          }
        },
      };
    }
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

/**
 * Polls the popout's DOCUMENT text until DOC_MARKER shows up. The PNG check
 * in assertMdScreenshotPng cannot tell a rendered document from an all-white
 * window (any PNG-signature file over 1000 bytes passes it), so this is the
 * assertion that proves the markdown really rendered inside the popout.
 */
async function assertMdPopoutDocument(ctx, step, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  let text = "";
  while (Date.now() < deadline) {
    if (probe === null) {
      probe = await connectPageEvaluate(
        ctx,
        (url) => url.includes("view=md-preview") && url.includes(ctx.mdPreviewId),
        Math.max(1000, deadline - Date.now()),
      );
      if (probe === null) break;
    }
    try {
      text = String(await probe.evaluate("document.body.textContent"));
      if (text.includes(DOC_MARKER)) break;
    } catch {
      // the popout renderer may still be booting — reconnect and retry
      probe.close();
      probe = null;
    }
    await sleep(300);
  }
  if (probe !== null) probe.close();
  const ok = text.includes(DOC_MARKER);
  record(
    "md popout document contains the doc marker (a real render, not a blank window)",
    ok ? "PASS" : "FAIL",
    ok ? JSON.stringify(DOC_MARKER) : `marker absent — last document text: ${JSON.stringify(text.slice(0, 200))}`,
  );
  if (!ok) fail(step, `the popout's document never showed the doc marker within ${timeoutMs}ms`);
  return ok;
}

/** Polls the preview's screenshot until a real PNG comes back (the popout must boot its renderer first). */
async function assertMdScreenshotPng(ctx, step, containerLabel, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/screenshot`);
    if (typeof last?.png === "string" && last.png.length > 0) break;
    if (Date.now() >= deadline) break;
    await sleep(300);
  }
  const png = last?.png;
  if (typeof png !== "string" || png.length === 0) {
    record(`md screenshot in the ${containerLabel} container returns a non-empty PNG`, "FAIL", `response=${JSON.stringify(last).slice(0, 300)}`);
    return false;
  }
  const buf = Buffer.from(png, "base64");
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ok = buf.subarray(0, 8).equals(magic) && buf.length > 1000;
  record(
    `md screenshot in the ${containerLabel} container returns a non-empty PNG`,
    ok ? "PASS" : "FAIL",
    `${buf.length} bytes, PNG magic verified=${buf.subarray(0, 8).equals(magic)}`,
  );
  return ok;
}

async function step5TransferToWindow(ctx) {
  const toWindow = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/container`, {
    target: "window",
  });
  if (toWindow?.ok !== true) {
    record("md preview transfers to the window container (md popout opens)", "FAIL", `response=${JSON.stringify(toWindow)}`);
    fail(5, `window transfer failed: ${JSON.stringify(toWindow)}`);
  }
  record("md preview transfers to the window container (md popout opens)", "PASS", JSON.stringify(toWindow));

  // The popout is now alive with the F2 wiring: dedicated in-memory
  // partition, narrow-bridge argv flag, channel-scoped allow-list entry,
  // (tabId, previewId) target registration. It must still RENDER — poll for
  // a real PNG (boot takes a moment on a fresh BrowserWindow).
  const shotOk = await assertMdScreenshotPng(ctx, 5, "window (md popout)");
  if (!shotOk) fail(5, "popout never produced a real screenshot after the transfer");

  // The PNG check above cannot tell a rendered document from an all-white
  // window — find the doc marker in the popout's DOM itself (additional
  // assertion on top of the PNG, over the same CDP evaluate route; no new
  // app endpoint).
  await assertMdPopoutDocument(ctx, 5);

  // The MAIN-side registry/allow-list must not have disturbed the roster:
  // the list route (a separate read of the live record) still shows the
  // preview, now with container:"window".
  let entry = null;
  for (let i = 0; i < 20; i++) {
    const listed = await apiOk(ctx, 5, "GET", `/tabs/${ctx.tabId}/previews`);
    entry = (listed?.previews ?? []).find((p) => p.previewId === ctx.mdPreviewId);
    if (entry !== undefined && entry.container === "window" && entry.status !== "loading") break;
    await sleep(250);
  }
  const listOk = entry !== undefined && entry.container === "window";
  record("list still shows the preview with container:window while the popout is open", listOk ? "PASS" : "FAIL", JSON.stringify(entry));
  if (!listOk) fail(5, `list lost or miscategorized the windowed preview: ${JSON.stringify(entry)}`);
}

// ── step 6: transfer back to the panel (tears the popout down mid-session) ──

async function step6TransferBackToPanel(ctx) {
  const toPanel = await apiOk(ctx, 6, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/container`, {
    target: "panel",
  });
  if (toPanel?.ok !== true) {
    record("md preview transfers back to the panel (popout closes mid-session)", "FAIL", `response=${JSON.stringify(toPanel)}`);
    fail(6, `panel transfer failed: ${JSON.stringify(toPanel)}`);
  }
  record("md preview transfers back to the panel (popout closes mid-session)", "PASS", JSON.stringify(toPanel));

  // The popout's guard/target entries died with it; the app must still serve
  // the preview from the panel (a screenshot proves the main process is
  // healthy after a live close of a windowed preview).
  const shotOk = await assertMdScreenshotPng(ctx, 6, "panel (after popout close)");
  if (!shotOk) fail(6, "panel screenshot broken after the popout closed");

  const listed = await apiOk(ctx, 6, "GET", `/tabs/${ctx.tabId}/previews`);
  const entry = (listed?.previews ?? []).find((p) => p.previewId === ctx.mdPreviewId);
  const ok = entry !== undefined && entry.container === "panel" && entry.status === "ready";
  record("list shows the preview back in container:panel, status ready", ok ? "PASS" : "FAIL", JSON.stringify(entry));
  if (!ok) fail(6, `list did not settle back to panel: ${JSON.stringify(entry)}`);
}

// ── step 7: reopen the popout and leave it OPEN across teardown (F1 repro) ──

async function step7ReopenPopoutForTeardown(ctx) {
  const toWindow = await apiOk(ctx, 7, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/container`, {
    target: "window",
  });
  if (toWindow?.ok !== true) {
    record("md popout reopened for the teardown leg", "FAIL", `response=${JSON.stringify(toWindow)}`);
    fail(7, `reopen failed: ${JSON.stringify(toWindow)}`);
  }
  record("md popout reopened for the teardown leg", "PASS", JSON.stringify(toWindow));
  // Do NOT transfer back — /quit in teardown must destroy a LIVE popout via
  // closeAll() and still exit cleanly (the "Object has been destroyed"
  // regression used to fire exactly here).
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
  // F1 DoD leg: teardown must destroy a LIVE md popout (step7 leaves it
  // open) and exit CLEANLY — a "closed" handler that re-read `.webContents`
  // off the destroyed window used to throw straight into the main process
  // here. Clean /quit-driven exit within grace is the PASS signal; needing
  // SIGTERM/SIGKILL is recorded FAIL, never tolerated.
  let orphanCheckDetail = "no child process was ever spawned (step2 never ran)";
  let orphanCheckOk = true;
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (exited) {
      orphanCheckDetail = `app (pid=${ctx.child.pid}) exited cleanly within ${APP_EXIT_GRACE_MS}ms of POST /quit — with a LIVE md popout open`;
    } else {
      console.warn(`[md-popout-isolation-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[md-popout-isolation-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) did not exit on /quit or SIGTERM — escalated to SIGKILL`;
      } else {
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) did not exit on /quit within ${APP_EXIT_GRACE_MS}ms — needed SIGTERM (no orphan left alive, but not a clean /quit-driven exit)`;
      }
    }
  }
  record("teardown: /quit with a LIVE md popout open exits cleanly (no destroyed-object throw, no orphans)", orphanCheckOk ? "PASS" : "FAIL", orphanCheckDetail);
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
    console.log(`[md-popout-isolation-smoke] --keep set, preserved: profile=${ctx.profile} workspace=${ctx.workspace}`);
  }

  console.log("\n[md-popout-isolation-smoke] DoD summary:");
  for (const item of dodItems) {
    console.log(`  ${item.status.padEnd(8)} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  const verdict = failedStep !== null ? `STOPPED at step ${failedStep}` : anyFail ? "COMPLETED WITH FAILURES" : "ALL GREEN";
  console.log(`\n[md-popout-isolation-smoke] ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[md-popout-isolation-smoke] received ${signal} — tearing down…`);
    runTeardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[md-popout-isolation-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    await step4OpenMdPreview(ctx);
    await step5TransferToWindow(ctx);
    await step6TransferBackToPanel(ctx);
    await step7ReopenPopoutForTeardown(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[md-popout-isolation-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await runTeardown(ctx, failedStep);
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  process.exit(failedStep === null && !anyFail ? 0 : 1);
}

run().catch((err) => {
  console.error(`[md-popout-isolation-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

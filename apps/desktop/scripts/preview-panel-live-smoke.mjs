/**
 * Live smoke for TASK.96 96-P4 (panel-track CUT.md §3 "96-P4"): drives a REAL
 * Electron dev instance over the automation HTTP channel
 * (`main/automation/*`, automation/README.md) to prove the WebContentsView
 * RIGHT-SIDE PANEL container (96-P0..P3) actually opens, actually shows
 * `container:"panel"` previews, actually screenshots, and actually enforces
 * the SAME security invariants as the stage-1 window container (invariant 7)
 * — all reached the mechanical way `preview-live-smoke.mjs` (96-E) reaches
 * PreviewHost, i.e. `POST /tabs/:tabId/previews` directly, no live model
 * needed (this is a container-plumbing smoke, not a model-behavior smoke).
 *
 * Mechanical only — no live-model leg (unlike 96-E's script): P4's DoD is
 * about the panel container/security wiring, which `openForTab` reaches
 * identically whether the caller is BrowserOpen or this HTTP route.
 *
 * Every assertion is PASS/FAIL/SKIPPED-why, never silently assumed.
 *
 * Plain node >=22, ZERO npm deps (node:child_process/fs/os/path/url + global
 * fetch), matching the `scripts/` precedent.
 *
 * Usage: node apps/desktop/scripts/preview-panel-live-smoke.mjs [--keep]
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// ── step 1: isolated profile + workspace ──

function step1Prepare() {
  const ctx = {};
  const profile = mkdtempSync(join(tmpdir(), "anycode-panel-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.logPath = join(profile, "dev.log");
  const workspace = mkdtempSync(join(tmpdir(), "anycode-panel-smoke-ws-"));
  ctx.workspace = workspace;
  stepLog(1, `profile=${profile} workspace=${workspace} log=${ctx.logPath}`);
  return ctx;
}

// ── step 2: launch the dev app ──

async function step2LaunchApp(ctx) {
  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
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

// ── step 4: positive smoke — html + md artifacts open into the PANEL ──

const OK_MARKER = "PANEL SMOKE OK";

async function step4PositiveSmoke(ctx) {
  const htmlPath = join(ctx.workspace, "panel-smoke-ok.html");
  const mdPath = join(ctx.workspace, "panel-smoke-ok.md");
  writeFileSync(htmlPath, `<!doctype html><html><head><title>ok</title></head><body><p>${OK_MARKER}</p></body></html>\n`);
  writeFileSync(mdPath, `# Panel smoke\n\nSome *markdown* content — ${OK_MARKER}.\n`);

  const htmlOpen = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/previews`, { path: htmlPath });
  assert(4, htmlOpen?.ok === true, `html open failed: ${JSON.stringify(htmlOpen)}`);
  ctx.htmlPreviewId = htmlOpen.value.previewId;

  const mdOpen = await apiOk(ctx, 4, "POST", `/tabs/${ctx.tabId}/previews`, { path: mdPath });
  assert(4, mdOpen?.ok === true, `md open failed: ${JSON.stringify(mdOpen)}`);
  ctx.mdPreviewId = mdOpen.value.previewId;

  // Poll the list until both settle out of "loading".
  let previews = null;
  for (let i = 0; i < 40; i++) {
    const listed = await apiOk(ctx, 4, "GET", `/tabs/${ctx.tabId}/previews`);
    previews = listed?.previews ?? [];
    const bothSettled = previews.length === 2 && previews.every((p) => p.status !== "loading");
    if (bothSettled) break;
    await sleep(250);
  }
  ctx.positivePreviews = previews ?? [];

  // M1 (TASK.99 CUT.md CONTRACTS): a `.md` artifact opens as a native dom-md
  // record — no WebContentsView, no rendered-HTML temp file (that pipeline
  // is dead code from M1 on, removed in M5). `renderedFrom` stays the
  // ORIGINAL .md path (tool-contract continuity across viewKinds) and `url`
  // is the .md file's OWN `file://` URL, never a rendered-.html temp.
  // Compared with `.startsWith`/`.endsWith` rather than strict equality
  // against `pathToFileURL(mdPath)`: a realpath divergence (e.g. macOS
  // /tmp -> /private/tmp) would make a strict string compare
  // environment-brittle without asserting anything security-meaningful.
  const mdListEntry = (previews ?? []).find((p) => p.previewId === ctx.mdPreviewId);
  const mdRenderedFromMatches = mdOpen.value.renderedFrom === mdPath;
  const mdUrlIsMdFile =
    typeof mdOpen.value.url === "string" &&
    mdOpen.value.url.startsWith("file://") &&
    mdOpen.value.url.endsWith(".md") &&
    !mdOpen.value.url.endsWith(".html");
  const mdListShapeOk =
    mdListEntry !== undefined && mdListEntry.viewKind === "dom-md" && mdListEntry.container === "panel" && mdListEntry.status === "ready";
  if (mdRenderedFromMatches && mdUrlIsMdFile && mdListShapeOk) {
    record(
      "md artifact opens as native dom-md record",
      "PASS",
      `renderedFrom=${mdOpen.value.renderedFrom} url=${mdOpen.value.url} list=${JSON.stringify(mdListEntry)}`,
    );
  } else {
    record(
      "md artifact opens as native dom-md record",
      "FAIL",
      `open value=${JSON.stringify(mdOpen.value)} listEntry=${JSON.stringify(mdListEntry)}`,
    );
  }

  const bothReady = (previews ?? []).length === 2 && previews.every((p) => p.status === "ready");
  const bothPanel = (previews ?? []).every((p) => p.container === "panel");
  if (bothReady && bothPanel) {
    record("list shows both artifacts, container:panel, status:ready", "PASS", JSON.stringify(previews.map((p) => ({ url: p.url, status: p.status, container: p.container }))));
  } else {
    record("list shows both artifacts, container:panel, status:ready", "FAIL", JSON.stringify(previews));
  }
}

// ── step 5: screenshot ──

/**
 * TASK.99 M4: polls `GET .../screenshot` for `ctx.mdPreviewId` until it
 * returns a `png`, then asserts real PNG bytes (magic + a non-trivial size —
 * same thresholds as the html leg's own check below). Polling (not a single
 * shot) accounts for the WINDOW leg specifically: right after a panel->window
 * transfer, the md window is a brand-new `BrowserWindow` that still has to
 * boot the renderer bundle before its FIRST paint — the host's own one-shot
 * empty-image fallback (show()+recapture) is not meant to cover a boot delay
 * that long, so this loop is the smoke's job, not the host's.
 */
async function assertMdScreenshotPng(ctx, containerLabel, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await apiOk(ctx, 5, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/screenshot`);
    if (typeof last?.png === "string" && last.png.length > 0) break;
    if (Date.now() >= deadline) break;
    await sleep(300);
  }
  const png = last?.png;
  if (typeof png !== "string" || png.length === 0) {
    record(`md screenshot (${containerLabel}) returns a non-empty PNG`, "FAIL", `response=${JSON.stringify(last).slice(0, 300)}`);
    return;
  }
  const buf = Buffer.from(png, "base64");
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const magicOk = buf.subarray(0, 8).equals(magic);
  const sizeOk = buf.length > 1000; // a trivial/empty capture is far smaller than a real render
  if (magicOk && sizeOk) {
    record(`md screenshot (${containerLabel}) returns a non-empty PNG`, "PASS", `${buf.length} bytes, PNG magic verified`);
  } else {
    record(`md screenshot (${containerLabel}) returns a non-empty PNG`, "FAIL", `magicOk=${magicOk} sizeOk=${sizeOk} bytes=${buf.length}`);
  }
}

async function step5Screenshot(ctx) {
  const resp = await apiOk(ctx, 5, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.htmlPreviewId)}/screenshot`);
  const png = resp?.png;
  if (typeof png !== "string" || png.length === 0) {
    record("screenshot returns a non-empty PNG", "FAIL", `response=${JSON.stringify(resp).slice(0, 300)}`);
    return;
  }
  const buf = Buffer.from(png, "base64");
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const magicOk = buf.subarray(0, 8).equals(magic);
  const sizeOk = buf.length > 1000; // a trivial/empty capture is far smaller than a real panel screenshot
  if (magicOk && sizeOk) {
    record("screenshot returns a non-empty PNG", "PASS", `${buf.length} bytes, PNG magic verified`);
  } else {
    record("screenshot returns a non-empty PNG", "FAIL", `magicOk=${magicOk} sizeOk=${sizeOk} bytes=${buf.length}`);
  }

  // TASK.99 M4 (CUT.md GAP 2): a dom-md preview now has a REAL capture
  // surface in BOTH containers — PANEL via capturePage(rect) of the main
  // window, WINDOW via the md preview's own MdPreviewWindowLike. Assert a
  // real PNG in the panel, transfer to a window via the M3 automation route
  // and assert a real PNG there too, then transfer back to the panel so this
  // run ends in the same container state step4 left it in.
  await assertMdScreenshotPng(ctx, "panel");

  const toWindow = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/container`, {
    target: "window",
  });
  if (toWindow?.ok !== true) {
    record("md preview transfers to a window container", "FAIL", `response=${JSON.stringify(toWindow)}`);
  } else {
    record("md preview transfers to a window container", "PASS", JSON.stringify(toWindow));
    await assertMdScreenshotPng(ctx, "window");
  }

  const toPanel = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.mdPreviewId)}/container`, {
    target: "panel",
  });
  if (toPanel?.ok === true) {
    record("md preview transfers back to the panel container (tidy end state)", "PASS", JSON.stringify(toPanel));
  } else {
    record("md preview transfers back to the panel container (tidy end state)", "FAIL", `response=${JSON.stringify(toPanel)}`);
  }
}

// ── step 6: negative security smoke (invariant 7) ──

const REMOTE_ORIGIN = "https://example.com";
const LEAK_TARGET = "/etc/hosts";

async function step6NegativeSmoke(ctx) {
  let realHosts = "";
  try {
    realHosts = readFileSync(LEAK_TARGET, "utf8");
  } catch {
    realHosts = "";
  }
  // A distinctive line (not just "127.0.0.1" — too common) to search for in the console ring.
  const hostsLines = realHosts.split("\n").map((l) => l.trim()).filter((l) => l.length > 8 && !l.startsWith("#"));

  const maliciousPath = join(ctx.workspace, "panel-smoke-malicious.html");
  writeFileSync(
    maliciousPath,
    `<!doctype html><html><head><title>malicious</title></head><body><p>negative smoke</p>
<script>
  try {
    var w = window.open(${JSON.stringify(REMOTE_ORIGIN + "/")}, "_blank");
    console.log("POPUP_RESULT:" + (w === null || w === undefined ? "null" : "NON-NULL"));
  } catch (e) {
    console.log("POPUP_RESULT:threw:" + e.message);
  }
  fetch(${JSON.stringify(REMOTE_ORIGIN + "/")}).then(
    function(){ console.log("FETCH_RESULT:unexpectedly-succeeded"); },
    function(e){ console.log("FETCH_RESULT:blocked:" + e.message); }
  );
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      function(){ console.log("GEO_RESULT:unexpectedly-succeeded"); },
      function(err){ console.log("GEO_RESULT:denied:" + err.code + ":" + err.message); }
    );
  } else {
    console.log("GEO_RESULT:no-api");
  }
</script>
<iframe src="file://${LEAK_TARGET}" onload="console.log('IFRAME_ONLOAD')" onerror="console.log('IFRAME_ONERROR')"></iframe>
</body></html>
`,
  );

  const opened = await apiOk(ctx, 6, "POST", `/tabs/${ctx.tabId}/previews`, { path: maliciousPath });
  if (opened?.ok !== true) {
    record("negative smoke: probe page opened", "FAIL", `open failed (a blocked subresource must not fail the whole open): ${JSON.stringify(opened)}`);
    return;
  }
  ctx.maliciousPreviewId = opened.value.previewId;
  record("negative smoke: probe page opened", "PASS", `previewId=${ctx.maliciousPreviewId}`);

  let entries = [];
  for (let i = 0; i < 24; i++) {
    const console_ = await apiOk(ctx, 6, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.maliciousPreviewId)}/console?tail=200`);
    entries = console_?.entries ?? [];
    const messages = entries.map((e) => e.message ?? "");
    const haveAll =
      messages.some((m) => m.includes("POPUP_RESULT:")) &&
      messages.some((m) => m.includes("FETCH_RESULT:")) &&
      messages.some((m) => m.includes("GEO_RESULT:"));
    if (haveAll) break;
    await sleep(250);
  }
  const messages = entries.map((e) => e.message ?? "");
  const dump = () => JSON.stringify(entries);

  // (a) window.open denied — no popup.
  const popupMsg = messages.find((m) => m.includes("POPUP_RESULT:"));
  if (popupMsg !== undefined && popupMsg.includes("POPUP_RESULT:null")) {
    record("negative smoke: window.open denied (no popup)", "PASS", popupMsg);
  } else {
    record("negative smoke: window.open denied (no popup)", "FAIL", `popupMsg=${popupMsg} entries=${dump()}`);
  }

  // (b) fetch to a non-consented remote origin blocked by the request gate.
  const gateBlockedRemote = messages.some((m) => m.includes("blocked by security policy") && m.includes("example.com"));
  const fetchOwnResult = messages.find((m) => m.includes("FETCH_RESULT:"));
  if (gateBlockedRemote || (fetchOwnResult !== undefined && fetchOwnResult.includes("blocked"))) {
    record("negative smoke: non-consented remote fetch blocked", "PASS", `gate entry present=${gateBlockedRemote}, page-side=${fetchOwnResult}`);
  } else {
    record("negative smoke: non-consented remote fetch blocked", "FAIL", `entries=${dump()}`);
  }

  // (c) geolocation denied.
  const geoMsg = messages.find((m) => m.includes("GEO_RESULT:"));
  if (geoMsg !== undefined && geoMsg.includes("GEO_RESULT:denied")) {
    record("negative smoke: geolocation denied", "PASS", geoMsg);
  } else {
    record("negative smoke: geolocation denied", "FAIL", `geoMsg=${geoMsg} entries=${dump()}`);
  }

  // (d) file:// iframe outside allowed roots blocked by the request gate.
  const gateBlockedFile = messages.some((m) => m.includes("blocked by security policy") && m.includes("subFrame") && m.includes("etc/hosts"));
  if (gateBlockedFile) {
    record("negative smoke: outside-roots file:// iframe blocked", "PASS", messages.find((m) => m.includes("etc/hosts")));
  } else {
    record("negative smoke: outside-roots file:// iframe blocked", "FAIL", `entries=${dump()}`);
  }

  // (e) no leak: none of /etc/hosts' real content lines appear anywhere in the console ring.
  const leaked = hostsLines.length > 0 && hostsLines.some((line) => messages.some((m) => m.includes(line)));
  if (!leaked) {
    record("negative smoke: no /etc/hosts content leaked into console", "PASS", `checked ${hostsLines.length} real hosts-file line(s) against ${messages.length} console message(s)`);
  } else {
    record("negative smoke: no /etc/hosts content leaked into console", "FAIL", `a real /etc/hosts line appeared in the console ring: ${dump()}`);
  }

  // (f) sanity: the tab's preview list is exactly the 3 we opened ourselves — no surprise extra (popup) entry.
  const listed = await apiOk(ctx, 6, "GET", `/tabs/${ctx.tabId}/previews`);
  const finalPreviews = listed?.previews ?? [];
  if (finalPreviews.length === 3) {
    record("negative smoke: no extra (popup) preview appeared", "PASS", `previews=${finalPreviews.length}`);
  } else {
    record("negative smoke: no extra (popup) preview appeared", "FAIL", `expected 3, got ${finalPreviews.length}: ${JSON.stringify(finalPreviews)}`);
  }
}

// ── step 7: transfer (honesty note — no automation route exists) ──

function step7TransferNote() {
  record(
    "transfer panel<->window via automation",
    "SKIPPED",
    "no automation HTTP route drives previewPanel.setContainer (main/automation/server.ts + handlers.ts have no such route; the renderer preload API is the only caller). Per the brief, not inventing one — covered by preview-host.test.ts's setContainer suite + the owner checklist.",
  );
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
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[preview-panel-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[preview-panel-live-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
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
    console.log(`[preview-panel-live-smoke] --keep set, preserved: profile=${ctx.profile} workspace=${ctx.workspace}`);
  }

  console.log("\n[preview-panel-live-smoke] DoD summary:");
  for (const item of dodItems) {
    console.log(`  ${item.status.padEnd(8)} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  const verdict = failedStep !== null ? `STOPPED at step ${failedStep}` : anyFail ? "COMPLETED WITH FAILURES" : "ALL GREEN";
  console.log(`\n[preview-panel-live-smoke] ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[preview-panel-live-smoke] received ${signal} — tearing down…`);
    runTeardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[preview-panel-live-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    await step4PositiveSmoke(ctx);
    await step5Screenshot(ctx);
    await step6NegativeSmoke(ctx);
    step7TransferNote();
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[preview-panel-live-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await runTeardown(ctx, failedStep);
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  process.exit(failedStep === null && !anyFail ? 0 : 1);
}

run().catch((err) => {
  console.error(`[preview-panel-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

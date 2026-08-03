/**
 * Live smoke for TASK.96 96-P4 (panel-track CUT.md §3 "96-P4") + TASK.99 M5
 * (CUT.md M5 "full DoD live smoke"): drives a REAL Electron dev instance over
 * the automation HTTP channel (`main/automation/*`, automation/README.md) to
 * prove the WebContentsView RIGHT-SIDE PANEL container (96-P0..P3) actually
 * opens, actually shows `container:"panel"` previews, actually screenshots,
 * and actually enforces the SAME security invariants as the stage-1 window
 * container (invariant 7) — all reached the mechanical way
 * `preview-live-smoke.mjs` (96-E) reaches PreviewHost, i.e.
 * `POST /tabs/:tabId/previews` directly, no live model needed (this is a
 * container-plumbing smoke, not a model-behavior smoke).
 *
 * TASK.99 M5 extension (steps 8-14 below): the native DOM markdown preview's
 * full DoD — a doc.md with a relative probe image + a relative `.md` link is
 * opened, its rendered image is asserted VISIBLE by decoding the panel's own
 * screenshot (the owner's original live repro this whole track exists to
 * fix), its source is read back, a link-navigate REPLACES its content
 * in-place via the M5-added `POST .../navigate` route (CUT.md M5 scope item
 * 3), the navigate+transfer interplay is exercised, and every honest refusal
 * (containment/not-found/too-large) is driven and asserted, never assumed.
 *
 * Mechanical only — no live-model leg (unlike 96-E's script): the DoD here is
 * about the panel/window container + native-markdown wiring, which
 * `openForTab`/`navigateMdDoc` reach identically whether the caller is a real
 * model tool call or this HTTP route.
 *
 * Every assertion is PASS/FAIL/SKIPPED-why, never silently assumed.
 *
 * Plain node >=22, ZERO npm deps (node:child_process/fs/os/path/url/zlib +
 * global fetch), matching the `scripts/` precedent — the M5 PNG encode/decode
 * below is hand-rolled over `node:zlib` rather than pulling in an image lib.
 *
 * Usage: node apps/desktop/scripts/preview-panel-live-smoke.mjs [--keep]
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

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

// ── PNG (TASK.99 M5): a zero-dep raw encoder for the solid-color probe
// fixture + a minimal decoder for the panel/window screenshot, both over
// node:zlib only. Encoder emits 8-bit RGB (color type 2), no interlace, one
// IDAT, filter type 0 (None) on every scanline — the simplest valid PNG.
// Decoder handles what Electron's `nativeImage.toPNG()` actually emits:
// 8-bit, non-interlaced, color type 2 (RGB) or 6 (RGBA) — anything else
// (16-bit, interlaced, palette) throws, and the caller falls back honestly
// rather than mis-decoding. ──

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard PNG/zlib CRC-32 (ISO 3309), computed by hand — the only bit of "codec" this script hand-rolls beyond calling node:zlib for the DEFLATE stream itself. */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Encodes a solid `[r,g,b]` PNG at `width`x`height` — the probe fixture (`assets/probe.png`), a pure, unambiguous color a screenshot decode can later search for. */
function makeSolidColorPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB (no alpha — a solid opaque probe needs none)
  ihdr[10] = 0; // compression method (only valid value)
  ihdr[11] = 0; // filter method (only valid value)
  ihdr[12] = 0; // interlace method: none

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // per-scanline filter type: None
    for (let x = 0; x < width; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG defiltering (spec §9.2): reconstructs byte `x` of the current scanline given the same byte one pixel left (`a`), the byte directly above (`b`), and above-left (`c`) — the standard predictor, needed only for filter type 4. */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes an 8-bit, non-interlaced RGB/RGBA PNG (color type 2 or 6) into
 * `{width, height, channels, pixels}` — `pixels` is one flat top-to-bottom,
 * left-to-right RGB(A) byte buffer, already defiltered. Throws honestly
 * (bit depth/interlace/color-type/palette not handled) rather than ever
 * silently mis-decoding — the caller's own fallback path depends on that.
 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idatParts = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 8 + len + 4; // length + type + data + crc
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit handled)`);
  }
  if (interlace !== 0) {
    throw new Error("unsupported interlaced PNG");
  }
  let channels;
  if (colorType === 2) channels = 3;
  else if (colorType === 6) channels = 4;
  else throw new Error(`unsupported PNG color type ${colorType} (only RGB/RGBA handled)`);

  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[prevRowStart + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevRowStart + x - channels] : 0;
      let value;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + a) & 0xff;
          break;
        case 2:
          value = (rawByte + b) & 0xff;
          break;
        case 3:
          value = (rawByte + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          value = (rawByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      pixels[rowStart + x] = value;
    }
    rawOffset += stride;
  }
  return { width, height, channels, pixels };
}

/** Counts pixels within `tolerance` (per-channel, Manhattan on each of R/G/B independently) of `[r,g,b]` — a full-image scan rather than a fixed coordinate, since a rendered image's on-screen position depends on layout the smoke does not control (panel width, font metrics, header height). */
function countMatchingPixels(decoded, [r, g, b], tolerance) {
  const { width, height, channels, pixels } = decoded;
  let count = 0;
  for (let i = 0; i < width * height; i++) {
    const off = i * channels;
    if (Math.abs(pixels[off] - r) <= tolerance && Math.abs(pixels[off + 1] - g) <= tolerance && Math.abs(pixels[off + 2] - b) <= tolerance) {
      count++;
    }
  }
  return count;
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

// ── step 7: transfer (TASK.99 M3 added POST .../container — this leg used
// to be a SKIPPED placeholder claiming no such route existed; that note went
// stale the moment M3 landed (step5 above already drives the SAME route for
// the md preview). Replaced with a REAL driven leg proving the route is
// viewKind-agnostic: it also transfers a "web" (html) preview, not just a
// "dom-md" one — D14's `setContainer` never branches on viewKind. ──

async function step7TransferCheck(ctx) {
  const toWindow = await apiOk(ctx, 7, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.htmlPreviewId)}/container`, {
    target: "window",
  });
  if (toWindow?.ok === true) {
    record("html preview transfers to a window container via the automation route", "PASS", JSON.stringify(toWindow));
  } else {
    record("html preview transfers to a window container via the automation route", "FAIL", `response=${JSON.stringify(toWindow)}`);
  }

  const toPanel = await apiOk(ctx, 7, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.htmlPreviewId)}/container`, {
    target: "panel",
  });
  if (toPanel?.ok === true) {
    record("html preview transfers back to the panel container (tidy end state)", "PASS", JSON.stringify(toPanel));
  } else {
    record("html preview transfers back to the panel container (tidy end state)", "FAIL", `response=${JSON.stringify(toPanel)}`);
  }
}

// ── steps 8-14: TASK.99 M5 full DoD — native DOM markdown preview ──
// (CUT.md M5 "live smoke on package:dir per DoD"). A fresh doc.md with a
// relative probe image + a relative `.md` link, opened, its image asserted
// VISIBLE via a real screenshot decode (the owner's original live repro),
// its source read back, a link-navigate REPLACING its content via the
// M5-added `POST .../navigate` route, the navigate+transfer interplay, and
// every honest refusal (containment/not-found/too-large) — never assumed.

/** Pure #FF0000 — a color no themed UI chrome plausibly produces by accident, so a tolerant match is still a strong, low-false-positive signal. */
const PROBE_COLOR = [255, 0, 0];
const PROBE_WIDTH = 240;
const PROBE_HEIGHT = 180;
/** `.md-artifact-img` caps at `max-height:240px` (app.css) — a big enough rendered probe that even a conservative pixel-count floor is a meaningful assertion, not a coin flip. */
const PROBE_MATCH_TOLERANCE = 25;
const PROBE_MATCH_MIN_PIXELS = 500;

const DOC_MD_HEADING = "Doc heading — TASK.99 M5 probe";
const NEXT_MD_MARKER = "NAVIGATED-TO content, distinct from doc.md — TASK.99 M5";
const OVERSIZED_MD_BYTES = 2 * 1024 * 1024 + 4096; // MD_PREVIEW_MAX_SOURCE_BYTES (2 MiB) + headroom

function docMdSource() {
  return `# ${DOC_MD_HEADING}\n\nProbe image: ![probe](assets/probe.png)\n\nLink: [next](sub/next.md)\n`;
}

function nextMdSource() {
  return `# Next doc\n\n${NEXT_MD_MARKER}\n`;
}

async function step8PrepareDocFixtures(ctx) {
  ctx.docMdPath = join(ctx.workspace, "doc.md");
  ctx.assetsDir = join(ctx.workspace, "assets");
  ctx.probePngPath = join(ctx.assetsDir, "probe.png");
  ctx.subDir = join(ctx.workspace, "sub");
  ctx.nextMdPath = join(ctx.subDir, "next.md");
  ctx.oversizedMdPath = join(ctx.workspace, "oversized.md");

  mkdirSync(ctx.assetsDir, { recursive: true });
  mkdirSync(ctx.subDir, { recursive: true });
  writeFileSync(ctx.docMdPath, docMdSource());
  writeFileSync(ctx.probePngPath, makeSolidColorPng(PROBE_WIDTH, PROBE_HEIGHT, PROBE_COLOR));
  writeFileSync(ctx.nextMdPath, nextMdSource());
  writeFileSync(ctx.oversizedMdPath, `# oversized\n\n${"x".repeat(OVERSIZED_MD_BYTES)}\n`);

  stepLog(8, `doc.md=${ctx.docMdPath} probe.png=${ctx.probePngPath} (${PROBE_WIDTH}x${PROBE_HEIGHT} solid #FF0000) next.md=${ctx.nextMdPath} oversized.md=${ctx.oversizedMdPath}`);
}

// ── step 9: open doc.md ──

async function step9OpenDocMd(ctx) {
  const opened = await apiOk(ctx, 9, "POST", `/tabs/${ctx.tabId}/previews`, { path: ctx.docMdPath });
  if (opened?.ok !== true) {
    record("doc.md opens as a dom-md preview", "FAIL", `open failed: ${JSON.stringify(opened)}`);
    fail(9, `doc.md open failed: ${JSON.stringify(opened)}`);
  }
  ctx.docPreviewId = opened.value.previewId;

  let listed = null;
  let entry = null;
  for (let i = 0; i < 40; i++) {
    const resp = await apiOk(ctx, 9, "GET", `/tabs/${ctx.tabId}/previews`);
    listed = resp?.previews ?? [];
    entry = listed.find((p) => p.previewId === ctx.docPreviewId);
    if (entry !== undefined && entry.status !== "loading") break;
    await sleep(250);
  }
  const ok = entry !== undefined && entry.viewKind === "dom-md" && entry.status === "ready" && entry.container === "panel";
  if (ok) {
    record("doc.md opens as a native dom-md record, status ready, container panel", "PASS", JSON.stringify(entry));
  } else {
    record("doc.md opens as a native dom-md record, status ready, container panel", "FAIL", `entry=${JSON.stringify(entry)} list=${JSON.stringify(listed)}`);
    fail(9, `doc.md dom-md record did not settle ready: ${JSON.stringify(entry)}`);
  }
}

// ── step 10: IMAGE-VISIBLE (the owner's original live repro) ──

/**
 * The image is loaded async (`ArtifactPreview`'s `IntersectionObserver` ->
 * `api.readImage` IPC round trip, Markdown.tsx) — the FIRST screenshot the
 * panel can produce may well predate that fetch completing, so this polls
 * DECODE-AND-COUNT itself (not just "a screenshot exists") across the whole
 * timeout window, retrying until the probe color actually shows up or time
 * runs out. `decodeFailed` short-circuits the retry loop into the documented
 * fallback the first time a decode throws — a format the decoder cannot
 * handle will never start matching on a later retry either.
 */
async function step10ImageVisible(ctx) {
  const deadline = Date.now() + 30_000;
  let lastBuf = null;
  let lastMagicOk = false;
  let lastMatches = 0;
  let lastDecoded = null;
  let decodeError = null;
  for (;;) {
    const resp = await apiOk(ctx, 10, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/screenshot`);
    if (typeof resp?.png === "string" && resp.png.length > 0) {
      lastBuf = Buffer.from(resp.png, "base64");
      const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      lastMagicOk = lastBuf.subarray(0, 8).equals(magic);
      if (lastMagicOk) {
        try {
          lastDecoded = decodePng(lastBuf);
          lastMatches = countMatchingPixels(lastDecoded, PROBE_COLOR, PROBE_MATCH_TOLERANCE);
          if (lastMatches >= PROBE_MATCH_MIN_PIXELS) break;
        } catch (err) {
          decodeError = err;
          break; // a format the decoder cannot handle will not start matching on a retry
        }
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(300);
  }

  if (lastBuf === null) {
    record("doc.md panel screenshot returns a non-empty PNG", "FAIL", "no screenshot returned before the timeout");
    record("IMAGE-VISIBLE: probe color found in the panel screenshot", "FAIL", "no screenshot to decode");
    return;
  }
  record("doc.md panel screenshot returns a non-empty PNG", lastMagicOk ? "PASS" : "FAIL", `${lastBuf.length} bytes, PNG magic=${lastMagicOk}`);
  if (!lastMagicOk) {
    record("IMAGE-VISIBLE: probe color found in the panel screenshot", "FAIL", "screenshot bytes are not a valid PNG");
    return;
  }

  if (decodeError !== null) {
    // Honest, documented fallback (per the brief): decode proved
    // impractical for the actual PNG format emitted — fall back to a
    // materially-different-screenshots comparison (before the probe image
    // existed vs. after a Reload picks it up) rather than silently passing.
    record(
      "IMAGE-VISIBLE: probe color found in the panel screenshot (pixel-probe decode)",
      "SKIPPED",
      `decodePng threw: ${decodeError?.message ?? decodeError} — pixel-probe mechanics documented as impractical for this PNG; see the fallback leg below`,
    );
    await step10bImageVisibleFallback(ctx);
    return;
  }
  const ok = lastMatches >= PROBE_MATCH_MIN_PIXELS;
  record(
    "IMAGE-VISIBLE: probe color found in the panel screenshot (pixel-probe decode)",
    ok ? "PASS" : "FAIL",
    `decoded ${lastDecoded.width}x${lastDecoded.height} (${lastDecoded.channels}ch), ${lastMatches} pixels within tolerance ${PROBE_MATCH_TOLERANCE} of rgb(${PROBE_COLOR.join(",")}), floor=${PROBE_MATCH_MIN_PIXELS}`,
  );
}

/** Fallback mechanics (only reached if `decodePng` above throws): screenshot the panel with the probe image DELETED, screenshot again after restoring it + Reload, and assert the two screenshots are materially different byte-for-byte — an honest, cruder substitute for a pixel-probe, labeled as such. */
async function step10bImageVisibleFallback(ctx) {
  const withImage = Buffer.from((await apiOk(ctx, 10, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/screenshot`))?.png ?? "", "base64");
  rmSync(ctx.probePngPath, { force: true });
  await apiOk(ctx, 10, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, { href: ctx.docMdPath });
  await sleep(500);
  const withoutImage = Buffer.from((await apiOk(ctx, 10, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/screenshot`))?.png ?? "", "base64");
  writeFileSync(ctx.probePngPath, makeSolidColorPng(PROBE_WIDTH, PROBE_HEIGHT, PROBE_COLOR));
  const materiallyDifferent = !withImage.equals(withoutImage) && Math.abs(withImage.length - withoutImage.length) > 200;
  record(
    "IMAGE-VISIBLE fallback: screenshot materially differs with vs. without the probe image file",
    materiallyDifferent ? "PASS" : "FAIL",
    `withImage=${withImage.length}B withoutImage=${withoutImage.length}B`,
  );
}

// ── step 11: BrowserRead-equivalent — source contains the probe markdown ──

/**
 * TASK.99 M5: there is no dedicated automation "read" route — `readForTab`
 * (the model-facing BrowserRead op) is reachable only via a real tool call
 * through a live model turn, and the brief authorizes exactly ONE new
 * dev-only route (navigate). A SELF-navigate (`href` = the doc's own current
 * relative filename) drives the EXACT SAME resolve+re-read+replace chain
 * `navigateMdDoc` runs for a real link click, and `MdDocReadResult`'s
 * success shape already carries the full `sourceText` — so it doubles as an
 * honest, mechanically-real "read the current source" leg without inventing
 * a second route. Labeled explicitly as self-navigate, not a literal
 * BrowserRead call, so the mechanism is never silently misrepresented.
 */
async function step11ReadSourceViaSelfNavigate(ctx) {
  const result = await apiOk(ctx, 11, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, {
    href: "doc.md",
  });
  const containsProbe = result?.ok === true && typeof result.doc?.sourceText === "string" && result.doc.sourceText.includes("![probe](assets/probe.png)");
  if (containsProbe) {
    record(
      "BrowserRead-equivalent (self-navigate) returns markdown source containing the probe image link",
      "PASS",
      `docVersion=${result.doc.docVersion} sourceText.length=${result.doc.sourceText.length}`,
    );
  } else {
    record("BrowserRead-equivalent (self-navigate) returns markdown source containing the probe image link", "FAIL", `response=${JSON.stringify(result).slice(0, 500)}`);
  }
  ctx.docVersionAfterSelfNav = result?.ok === true ? result.doc.docVersion : undefined;
}

// ── step 12: md->md navigate replaces content ──

async function step12NavigateReplace(ctx) {
  const result = await apiOk(ctx, 12, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, {
    href: "sub/next.md",
  });
  const sameDoc = result?.ok === true && result.doc.previewId === ctx.docPreviewId;
  const gotNextContent = result?.ok === true && typeof result.doc.sourceText === "string" && result.doc.sourceText.includes(NEXT_MD_MARKER);
  const versionBumped =
    result?.ok === true && ctx.docVersionAfterSelfNav !== undefined && result.doc.docVersion === ctx.docVersionAfterSelfNav + 1;
  if (sameDoc && gotNextContent && versionBumped) {
    record("md->md navigate replaces content in place (same previewId, docVersion bumped)", "PASS", `docVersion ${ctx.docVersionAfterSelfNav} -> ${result.doc.docVersion}`);
  } else {
    record(
      "md->md navigate replaces content in place (same previewId, docVersion bumped)",
      "FAIL",
      `sameDoc=${sameDoc} gotNextContent=${gotNextContent} versionBumped=${versionBumped} response=${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  ctx.docVersionAfterNavigate = result?.ok === true ? result.doc.docVersion : undefined;

  // Cross-check via the LIST route (a SEPARATE read of the live record, not
  // just the navigate call's own echoed return value) — proves the mutation
  // actually propagated into PreviewHost's own record, not merely into the
  // response this one call happened to construct.
  let listEntry = null;
  for (let i = 0; i < 20; i++) {
    const listed = await apiOk(ctx, 12, "GET", `/tabs/${ctx.tabId}/previews`);
    listEntry = (listed?.previews ?? []).find((p) => p.previewId === ctx.docPreviewId);
    if (listEntry !== undefined && listEntry.docVersion === ctx.docVersionAfterNavigate) break;
    await sleep(200);
  }
  const listMatches = listEntry !== undefined && listEntry.docVersion === ctx.docVersionAfterNavigate && listEntry.previewId === ctx.docPreviewId;
  if (listMatches) {
    record("navigate's docVersion bump is visible via a separate GET /previews list call", "PASS", JSON.stringify(listEntry));
  } else {
    record("navigate's docVersion bump is visible via a separate GET /previews list call", "FAIL", `listEntry=${JSON.stringify(listEntry)} expected docVersion=${ctx.docVersionAfterNavigate}`);
  }
}

// ── step 13: navigate-then-transfer interplay ──

async function step13TransferInterplay(ctx) {
  const toWindow = await apiOk(ctx, 13, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/container`, {
    target: "window",
  });
  if (toWindow?.ok !== true) {
    record("post-navigate doc.md preview transfers to a window container", "FAIL", `response=${JSON.stringify(toWindow)}`);
  } else {
    record("post-navigate doc.md preview transfers to a window container", "PASS", JSON.stringify(toWindow));
    const deadline = Date.now() + 30_000;
    let last = null;
    for (;;) {
      last = await apiOk(ctx, 13, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/screenshot`);
      if (typeof last?.png === "string" && last.png.length > 0) break;
      if (Date.now() >= deadline) break;
      await sleep(300);
    }
    const buf = Buffer.from(last?.png ?? "", "base64");
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = buf.length > 1000 && buf.subarray(0, 8).equals(magic);
    record("post-navigate doc.md screenshot in the window container is a real PNG", ok ? "PASS" : "FAIL", `${buf.length} bytes, magicOk=${buf.subarray(0, 8).equals(magic)}`);
  }

  const toPanel = await apiOk(ctx, 13, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/container`, {
    target: "panel",
  });
  if (toPanel?.ok === true) {
    record("doc.md preview transfers back to the panel container (tidy end state)", "PASS", JSON.stringify(toPanel));
  } else {
    record("doc.md preview transfers back to the panel container (tidy end state)", "FAIL", `response=${JSON.stringify(toPanel)}`);
  }
}

// ── step 14: honest refusals ──
// Every href below is ABSOLUTE (CUT.md CONTRACTS: "href = doc-relative or
// absolute .md target") — deliberately independent of the record's CURRENT
// docDir (which step12 just changed to .../sub), so these legs are not
// order-fragile.

async function step14Refusals(ctx) {
  // (a) containment: a real file that exists but sits outside every allowed
  // root (workspace / <home>/.anycode / OS temp dir / darwin literal /tmp).
  // realpath() must succeed for `outside_roots` to be distinguishable from
  // `not_found` (artifacts-ipc.ts's `resolveArtifactPath`) — a NONEXISTENT
  // out-of-bounds path collapses to `not_found` instead, so this leg targets
  // a file virtually guaranteed to exist on any POSIX box.
  const outsideResult = await apiOk(ctx, 14, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, {
    href: "/etc/hosts",
  });
  const outsideOk = outsideResult?.ok === false && outsideResult.reason === "outside_roots";
  record("honest refusal: navigate outside the allowed roots", outsideOk ? "PASS" : "FAIL", JSON.stringify(outsideResult));

  // (b) not_found: an absolute path inside the workspace root (so containment
  // would otherwise pass) that simply does not exist.
  const missingPath = join(ctx.workspace, "definitely-does-not-exist.md");
  const missingResult = await apiOk(ctx, 14, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, {
    href: missingPath,
  });
  const missingOk = missingResult?.ok === false && missingResult.reason === "not_found";
  record("honest refusal: navigate to a nonexistent .md target", missingOk ? "PASS" : "FAIL", JSON.stringify(missingResult));

  // (c) too_large: a real, contained .md file over MD_PREVIEW_MAX_SOURCE_BYTES.
  const oversizedResult = await apiOk(ctx, 14, "POST", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(ctx.docPreviewId)}/navigate`, {
    href: ctx.oversizedMdPath,
  });
  const oversizedOk = oversizedResult?.ok === false && oversizedResult.reason === "too_large";
  record("honest refusal: navigate to an oversized (>2MiB) .md target", oversizedOk ? "PASS" : "FAIL", JSON.stringify(oversizedResult));
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
  // TASK.99 M5 DoD leg (h): teardown must leave no orphan windows/processes.
  // `killTree(-pid, …)` targets the WHOLE detached process group (pnpm dev
  // -> electron -> every BrowserWindow it owns, including a live md-preview
  // window from steps 9-13 above) — a clean `/quit`-driven exit within grace
  // is the PASS signal; needing to escalate to SIGTERM/SIGKILL is recorded
  // FAIL, not silently treated as an acceptable teardown path.
  let orphanCheckDetail = "no child process was ever spawned (step2 never ran)";
  let orphanCheckOk = true;
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (exited) {
      orphanCheckDetail = `app (pid=${ctx.child.pid}) exited cleanly within ${APP_EXIT_GRACE_MS}ms of POST /quit`;
    } else {
      console.warn(`[preview-panel-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[preview-panel-live-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) did not exit on /quit or SIGTERM — escalated to SIGKILL`;
      } else {
        orphanCheckOk = false;
        orphanCheckDetail = `app (pid=${ctx.child.pid}) did not exit on /quit within ${APP_EXIT_GRACE_MS}ms — needed SIGTERM (no orphan left alive, but not a clean /quit-driven exit)`;
      }
    }
  }
  record("teardown: closeAll via /quit leaves no orphan windows/processes", orphanCheckOk ? "PASS" : "FAIL", orphanCheckDetail);
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
    await step7TransferCheck(ctx);
    await step8PrepareDocFixtures(ctx);
    await step9OpenDocMd(ctx);
    await step10ImageVisible(ctx);
    await step11ReadSourceViaSelfNavigate(ctx);
    await step12NavigateReplace(ctx);
    await step13TransferInterplay(ctx);
    await step14Refusals(ctx);
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

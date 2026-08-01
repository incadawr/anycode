/**
 * Live DoD smoke for TASK.96 96-E (night-track wave-1 cut §3 "96-E"): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`), exercising the FULL
 * preview stack live — turn-end auto-open detection is NOT what this proves
 * (that is 96-E's collector unit tests); this proves the PreviewHost window
 * really opens, really runs a page, really captures a real console pageerror,
 * and really tears down on tab close, all reached the way a live agent turn
 * would reach them (BrowserOpen/BrowserScreenshot), same "real artifact over
 * green gate" discipline as `git-ui-smoke.mjs`/`todo-subagent-smoke.mjs`.
 *
 * Two run modes, chosen automatically:
 *  - LIVE (preferred): prompts the tab's configured model to create two HTML
 *    files under /tmp (one deliberately throwing from an inline <script>),
 *    open both via BrowserOpen, screenshot both via BrowserScreenshot, and
 *    report a comparison — mirroring the `using-browser-preview` builtin
 *    skill's own documented flow. Requires a REAL, working, non-kimi-k3
 *    provider connection (owner constraint — kimi-k3 is never used in a
 *    smoke). This script does NOT accept raw credentials on the command line
 *    or via ANYCODE_API_KEY/MODEL/BASE_URL (unlike provider-live-smoke.mjs):
 *    it reuses the machine's own already-configured `~/.anycode/settings.json`
 *    + `secrets.json` (vault-encrypted, OS-keychain-backed) by COPYING them
 *    into this run's isolated profile (see step 1) — the real files on disk
 *    are NEVER opened for writing. If the copy carries no usable non-kimi
 *    connection, or the active one turns out to be kimi and no substitute
 *    exists, or the model never actually produces the two files within the
 *    bounded wait, this script falls back to MECHANICAL mode rather than
 *    hang or fake a pass.
 *  - MECHANICAL (fallback, model-free): this script creates the two files
 *    itself and opens them via `POST /tabs/:tabId/previews` (the SAME
 *    `PreviewHost.openForTab` a live BrowserOpen call reaches — cut §2.8),
 *    so every downstream assertion (console pageerror, `preview_console`
 *    transcript block, lifecycle-on-close) is proven identically; only the
 *    model's own "create the files + compare + report" narrative is skipped
 *    (there being no model in the loop to produce it).
 *
 * Every DoD item is reported PASS/FAIL/SKIPPED-why, never silently assumed.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent (git-ui-smoke.mjs,
 * todo-subagent-smoke.mjs).
 *
 * Usage:   node apps/desktop/scripts/preview-live-smoke.mjs [--attach] [--keep] [--port <n>] [--mechanical-only]
 *
 *   --attach            Do not spawn a dev instance — read the live discovery
 *                        file (~/.anycode/automation.json) of one already
 *                        running (design/slice-P7.H-cut.md §4.4 posture,
 *                        same as git-ui-smoke.mjs's --attach). Teardown then
 *                        only closes the tabs this script created.
 *   --keep              Do not delete the temp profile/workspace on exit.
 *   --port <n>           Forwarded as ANYCODE_AUTOMATION_PORT to the spawned
 *                        dev process (ignored with --attach).
 *   --mechanical-only    Skip the live-model attempt entirely and run the
 *                        mechanical fallback from the start.
 *
 * Log is written to stdout; the caller redirects it (see the builder report).
 */

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const REAL_SETTINGS_PATH = join(homedir(), ".anycode", "settings.json");
const REAL_SECRETS_PATH = join(homedir(), ".anycode", "secrets.json");
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
/** How long the live attempt waits for the model to finish its whole turn (file creation + both opens + both screenshots + report) before this script gives up on LIVE and falls back to MECHANICAL. */
const LIVE_TURN_TIMEOUT_MS = 240_000;

const OK_HTML_PATH = "/tmp/anycode-preview-smoke-ok.html";
const ERROR_HTML_PATH = "/tmp/anycode-preview-smoke-error.html";
const OK_MARKER = "PREVIEW SMOKE OK";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { attach: false, keep: false, port: undefined, mechanicalOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--attach") flags.attach = true;
    else if (arg === "--keep") flags.keep = true;
    else if (arg === "--mechanical-only") flags.mechanicalOnly = true;
    else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else {
      console.warn(`[preview-live-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (precedent: git-ui-smoke.mjs) ──

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

// ── DoD item bookkeeping: PASS / FAIL / SKIPPED-why, never silently assumed ──

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

async function waitUntilMatch(ctx, step, tabId, until, timeoutMs) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  return apiOk(ctx, step, "POST", "/wait", body);
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

async function getTabState(ctx, step, tabId) {
  const resp = await apiOk(ctx, step, "GET", `/state/${encodeURIComponent(tabId)}`);
  const state = resp?.snapshot?.states?.[tabId];
  if (state === undefined) {
    fail(step, `no state for tab ${tabId} in /state/:tabId response: ${JSON.stringify(resp)}`);
  }
  return state;
}

// ── step 1: per-run isolated profile, seeded from the machine's REAL provider config ──

/**
 * Copies `~/.anycode/settings.json` + `secrets.json` (if present) into a
 * disposable per-run profile dir — NEVER opens the real files for writing.
 * `secrets.json` is vault-encrypted via OS `safeStorage`; a byte-for-byte
 * copy keeps every entry decryptable under the SAME keychain-backed key as
 * long as this run's Electron binary shares the real one's keychain scope
 * (typically true when both are the unpackaged dev build — `electron-vite
 * dev` — which is what this script and a normal `pnpm dev` session both are).
 * If decryption does NOT carry over, the live attempt degrades honestly
 * later (providerReady stays false / the tab never reaches a working
 * connection) rather than silently using a fake key.
 */
function seedProfileSettings(ctx) {
  const settingsCopy = join(ctx.profile, "settings.json");
  const secretsCopy = join(ctx.profile, "secrets.json");
  ctx.profileSettingsPath = settingsCopy;
  ctx.profileSecretsPath = secretsCopy;

  if (!existsSync(REAL_SETTINGS_PATH)) {
    stepLog(1, `no real settings.json at ${REAL_SETTINGS_PATH} — live mode will have no configured connection`);
    ctx.hasRealSettings = false;
    return;
  }
  copyFileSync(REAL_SETTINGS_PATH, settingsCopy);
  if (existsSync(REAL_SECRETS_PATH)) {
    copyFileSync(REAL_SECRETS_PATH, secretsCopy);
  }
  ctx.hasRealSettings = true;

  // Pick a non-kimi connection to make active (owner constraint: never
  // kimi-k3 in a smoke) — prefer the currently-active one if it already
  // qualifies, else the healthiest non-kimi candidate, so the LIVE attempt
  // never even boots pinned to kimi in the first place. The runtime check in
  // step 4 (ensureNonKimiModel) is a defense-in-depth net for exactly the
  // case this heuristic guesses wrong.
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsCopy, "utf8"));
  } catch (err) {
    stepLog(1, `failed to parse copied settings.json (${err?.message ?? err}) — leaving as-is`);
    return;
  }
  const connections = settings?.provider?.connections ?? [];
  const isKimi = (c) => c?.providerId === "kimi" || /kimi|k3/i.test(String(c?.model ?? ""));
  const active = connections.find((c) => c.id === settings?.provider?.activeConnectionId);
  if (active !== undefined && !isKimi(active) && String(active.model ?? "").trim() !== "") {
    stepLog(1, `active connection already non-kimi: ${active.providerId}/${active.label} (model=${active.model})`);
    return;
  }
  const candidates = connections.filter((c) => !isKimi(c) && String(c.model ?? "").trim() !== "");
  candidates.sort((a, b) => {
    const rank = (c) => (c.lastHealth?.status === "ready" ? 0 : c.lastHealth?.status === "unchecked" ? 1 : 2);
    return rank(a) - rank(b);
  });
  const chosen = candidates[0];
  if (chosen === undefined) {
    stepLog(1, "no non-kimi connection with a usable model found in the copied settings.json — live mode will likely be unavailable");
    return;
  }
  settings.provider.activeConnectionId = chosen.id;
  writeFileSync(settingsCopy, JSON.stringify(settings, null, 2));
  stepLog(1, `pre-selected non-kimi active connection: ${chosen.providerId}/${chosen.label} (model=${chosen.model}, id=${chosen.id})`);
}

function step1PrepareProfile() {
  const ctx = {};
  const profile = mkdtempSync(join(tmpdir(), "anycode-preview-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  seedProfileSettings(ctx);
  const workspace = mkdtempSync(join(tmpdir(), "anycode-preview-smoke-ws-"));
  ctx.workspace = workspace;
  stepLog(1, `profile=${profile} workspace=${workspace}`);
  return ctx;
}

// ── step 2: launch (or attach to) the dev app ──

async function step2LaunchApp(ctx) {
  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) fail(2, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    if (!isPidAlive(info.pid)) fail(2, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
    stepLog(2, `attached to running app (pid=${info.pid}, port=${info.port})`);
    return;
  }

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
  };
  delete env.ANYCODE_WORKSPACE;
  if (ctx.hasRealSettings) {
    env.ANYCODE_SETTINGS_PATH = ctx.profileSettingsPath;
    env.ANYCODE_SECRETS_PATH = ctx.profileSecretsPath;
  }
  if (FLAGS.port !== undefined) env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);

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
  stepLog(2, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}, profile=${ctx.profile}`);
}

// ── step 3: ensure the active connection is not kimi-k3 BEFORE any tab exists ──
// (owner constraint — this script must never run a smoke turn on kimi-k3.
// step 1 already pre-selected a non-kimi connection when possible; this is a
// defense-in-depth runtime check over the SAME automation "model routes" the
// builder prompt names, for the case that heuristic guessed wrong or the
// real settings.json was absent/unusable.)

async function step3EnsureNonKimiActiveConnection(ctx) {
  await waitForFacade(ctx, 3);
  await apiAction(ctx, 3, "/settings/open", {});
  await apiAction(ctx, 3, "/settings/pane", { paneId: "provider" });
  const state = await apiOk(ctx, 3, "GET", "/settings/provider");
  const rows = state?.rows ?? [];
  const active = rows.find((r) => r.selected === true);
  const isKimiRow = (r) => /kimi/i.test(String(r?.providerName ?? "")) || /kimi|k3/i.test(String(r?.model ?? ""));
  if (active === undefined) {
    stepLog(3, "no active connection tile found (fresh install / no connections configured) — live mode unavailable, proceeding (mechanical fallback will cover the DoD)");
    ctx.liveUnavailableReason = "no provider connection configured";
  } else if (!isKimiRow(active)) {
    stepLog(3, `active connection already non-kimi: ${active.providerName} (${active.displayName ?? ""}) — no switch needed`);
  } else {
    const candidate = rows.find((r) => r.connectionId !== active.connectionId && !isKimiRow(r));
    if (candidate === undefined) {
      stepLog(3, "active connection is kimi-k3 and no other configured connection is available — live mode unavailable (owner constraint), falling back to mechanical");
      ctx.liveUnavailableReason = "only kimi-k3 configured — owner constraint forbids using it";
    } else {
      stepLog(3, `active connection is kimi-k3 — switching to ${candidate.providerName} (${candidate.displayName ?? ""}) via POST /settings/provider/tile`);
      await apiAction(ctx, 3, "/settings/provider/tile", { connectionId: candidate.connectionId });
      const after = await apiOk(ctx, 3, "GET", "/settings/provider");
      const nowActive = (after?.rows ?? []).find((r) => r.selected === true);
      assert(3, nowActive !== undefined && nowActive.connectionId === candidate.connectionId, "provider tile switch did not settle");
      stepLog(3, `switched active connection to ${nowActive.providerName} (${nowActive.displayName ?? ""})`);
    }
  }
  await apiAction(ctx, 3, "/settings/close", {});
}

// ── step 4: create the tab ──

async function step4CreateTab(ctx, label) {
  const created = await apiOk(ctx, 4, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  if (created?.ok !== true) {
    fail(4, `${label} tab creation failed: ${JSON.stringify(created)}`);
  }
  await waitForFacade(ctx, 4);
  await waitUntilMatch(ctx, 4, created.tabId, { connection: "ready" }, 30_000).then((r) => {
    if (r.matched !== true) stepLog(4, `${label}: connection never reached "ready" within 30s (state=${JSON.stringify(r.state)})`);
  });
  stepLog(4, `${label} tab ${created.tabId} created for ${ctx.workspace}`);
  return created.tabId;
}

/** Reads the tab's resolved model and reports whether it is (still) kimi-k3 — a final honest confirmation before the live prompt is ever sent. */
async function modelIsKimi(ctx, tabId) {
  const state = await getTabState(ctx, 4, tabId);
  const model = String(state?.model ?? "");
  return { isKimi: /kimi|k3/i.test(model), model };
}

// ── LIVE attempt: prompt the model, wait for it to do the work itself ──

const LIVE_PROMPT = `You have tool-calling ability. Call tools directly — do not just describe what you would do. Do exactly these 6 steps, in order, in this one turn, with no questions and no confirmation:

1. Call the Write tool: file_path="${OK_HTML_PATH}", content="<!doctype html><html><body><p>${OK_MARKER}</p></body></html>"
2. Call the Write tool: file_path="${ERROR_HTML_PATH}", content="<!doctype html><html><body><script>anycodeSmokeUndefinedFunction();</script></body></html>"
3. Call the BrowserOpen tool: path="${OK_HTML_PATH}"
4. Call the BrowserOpen tool: path="${ERROR_HTML_PATH}"
5. Call the BrowserScreenshot tool once for each of the two previews you just opened (using their preview_id from steps 3 and 4).
6. Reply with one short sentence saying which preview showed an error.`;

async function attemptLiveRun(ctx) {
  const { isKimi, model } = await modelIsKimi(ctx, ctx.tabId);
  if (isKimi) {
    record("live model run", "SKIPPED", `resolved model is kimi-k3-shaped ("${model}") after every switch attempt — owner constraint forbids using it`);
    return false;
  }
  stepLog(5, `live attempt using model "${model}"`);
  const sent = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/prompt`, { text: LIVE_PROMPT });
  if (sent?.ok !== true) {
    record("live model run", "SKIPPED", `prompt was rejected: ${JSON.stringify(sent)}`);
    return false;
  }
  const waited = await waitUntilMatch(ctx, 5, ctx.tabId, { turnStatus: "idle" }, LIVE_TURN_TIMEOUT_MS);
  if (waited.matched !== true) {
    record(
      "live model run",
      "SKIPPED",
      `turn did not go idle within ${LIVE_TURN_TIMEOUT_MS}ms — treating as an environment/model limitation, not a product defect`,
    );
    return false;
  }
  const okExists = existsSync(OK_HTML_PATH);
  const errExists = existsSync(ERROR_HTML_PATH);
  if (!okExists || !errExists) {
    // Diagnostic dump (not a product assertion): what did the model actually
    // do this turn? Helps distinguish "never touched a tool" from "tried and
    // got the path/content wrong" — both are model-dependent limitations
    // (cut §3 96-E risk note), but the log should say which.
    let diagnostic = "";
    try {
      const resp = await api(ctx, "GET", `/state/${encodeURIComponent(ctx.tabId)}?tail=30`);
      const transcript = resp?.body?.snapshot?.states?.[ctx.tabId]?.transcript ?? [];
      const kinds = transcript.map((b) => b.kind);
      const toolCalls = transcript.filter((b) => b.kind === "tool_call").map((b) => ({ name: b.name, input: b.input }));
      diagnostic = ` transcript kinds=${JSON.stringify(kinds)} toolCalls=${JSON.stringify(toolCalls)}`;
    } catch (err) {
      diagnostic = ` (diagnostic dump itself failed: ${err?.message ?? err})`;
    }
    record(
      "live model run",
      "SKIPPED",
      `model did not create both files (ok=${okExists}, error=${errExists}) — model-dependent limitation (cut §3 96-E note), not a product failure.${diagnostic}`,
    );
    return false;
  }
  record("live model run", "PASS", "model created both files and completed its turn");
  return true;
}

// ── MECHANICAL fallback: this script creates the files + opens them itself ──

function writeSmokeFiles() {
  writeFileSync(
    OK_HTML_PATH,
    `<!doctype html><html><head><title>ok</title></head><body><p>${OK_MARKER}</p></body></html>\n`,
  );
  writeFileSync(
    ERROR_HTML_PATH,
    `<!doctype html><html><head><title>error</title></head><body><p>about to throw</p><script>anycodeSmokeUndefinedFunction();</script></body></html>\n`,
  );
}

async function attemptMechanicalRun(ctx) {
  writeSmokeFiles();
  const okOpen = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/previews`, { path: OK_HTML_PATH });
  assert(5, okOpen?.ok === true, `mechanical open of ${OK_HTML_PATH} failed: ${JSON.stringify(okOpen)}`);
  const errOpen = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/previews`, { path: ERROR_HTML_PATH });
  assert(5, errOpen?.ok === true, `mechanical open of ${ERROR_HTML_PATH} failed: ${JSON.stringify(errOpen)}`);
  record("mechanical open (2 files)", "PASS", `previewId(ok)=${okOpen.value.previewId} previewId(error)=${errOpen.value.previewId}`);
}

// ── shared DoD assertions (identical regardless of which mode produced the two open previews) ──

async function assertTwoLivePreviews(ctx) {
  const listed = await apiOk(ctx, 6, "GET", `/tabs/${ctx.tabId}/previews`);
  const previews = listed?.previews ?? [];
  if (previews.length !== 2) {
    record("2 live previews", "FAIL", `expected 2, got ${previews.length}: ${JSON.stringify(previews)}`);
    return null;
  }
  record("2 live previews", "PASS", JSON.stringify(previews.map((p) => ({ url: p.url, status: p.status }))));
  return previews;
}

async function assertConsolePageerror(ctx, previews) {
  for (const preview of previews) {
    const console_ = await apiOk(ctx, 7, "GET", `/tabs/${ctx.tabId}/previews/${encodeURIComponent(preview.previewId)}/console?tail=50`);
    const hasPageerror = (console_?.entries ?? []).some((e) => e.level === "pageerror");
    if (hasPageerror) {
      record("console route shows the pageerror", "PASS", `previewId=${preview.previewId} entries=${JSON.stringify(console_.entries)}`);
      return preview.previewId;
    }
  }
  record("console route shows the pageerror", "FAIL", `no preview's console ring carried a pageerror entry (previews=${JSON.stringify(previews)})`);
  return null;
}

async function assertTranscriptPreviewConsole(ctx) {
  const resp = await apiOk(ctx, 8, "GET", `/state/${encodeURIComponent(ctx.tabId)}?tail=200`);
  const transcript = resp?.snapshot?.states?.[ctx.tabId]?.transcript ?? [];
  const previewBlocks = transcript.filter((b) => b.kind === "preview_console");
  if (previewBlocks.length === 0) {
    record("GET /state transcript tail contains preview_console", "FAIL", `no preview_console block in the last 200: ${JSON.stringify(transcript.slice(-5))}`);
    return;
  }
  // Prefer a pageerror-level block as the headline evidence (stronger proof
  // than "some preview_console block landed") — any block at all still
  // satisfies the DoD wording, so this is a quality-of-evidence upgrade, not
  // a stricter gate.
  const block = previewBlocks.find((b) => b.level === "pageerror") ?? previewBlocks[0];
  record("GET /state transcript tail contains preview_console", "PASS", `${previewBlocks.length} preview_console block(s); example: ${JSON.stringify(block)}`);
}

async function assertLifecycleOnClose(ctx) {
  const secondTabId = await step4CreateTab(ctx, "second");
  ctx.secondTabId = secondTabId;
  await apiAction(ctx, 9, `/tabs/${ctx.tabId}/close`, {});
  // closeTab's own facade path is async main-plane teardown; poll briefly rather than assume instant.
  let previews = null;
  for (let i = 0; i < 20; i++) {
    const listed = await apiOk(ctx, 9, "GET", `/tabs/${ctx.tabId}/previews`);
    previews = listed?.previews ?? [];
    if (previews.length === 0) break;
    await sleep(250);
  }
  if (previews === null || previews.length !== 0) {
    record("closing the tab kills its previews", "FAIL", `expected 0 previews for the closed tab, got ${JSON.stringify(previews)}`);
    return;
  }
  record("closing the tab kills its previews", "PASS", "second tab opened, first tab closed, first tab's previews are gone");
}

async function assertQuitClean(ctx) {
  const result = await apiOk(ctx, 10, "POST", "/quit", {});
  if (result?.ok !== true) {
    record("POST /quit clean", "FAIL", JSON.stringify(result));
    return;
  }
  record("POST /quit clean", "PASS", "");
}

// ── teardown ──

function step99Teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) ctx.teardownPromise = runTeardown(ctx, failedStep);
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  if (ctx.tabId && ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else {
        if (ctx.secondTabId) await api(ctx, "POST", `/tabs/${ctx.secondTabId}/close`, {});
        await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
      }
    } catch {
      // best-effort — app/tab may already be gone (assertQuitClean may have already quit it).
    }
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[preview-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[preview-live-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }
  for (const p of [OK_HTML_PATH, ERROR_HTML_PATH]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
  if (ctx.workspace && existsSync(ctx.workspace) && !FLAGS.keep) {
    try {
      rmSync(ctx.workspace, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[preview-live-smoke] --keep set, profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  console.log("\n[preview-live-smoke] DoD summary:");
  for (const item of dodItems) {
    console.log(`  ${item.status.padEnd(6)} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  const verdict = failedStep !== null ? `STOPPED at step ${failedStep}` : anyFail ? "COMPLETED WITH FAILURES" : "ALL GREEN";
  console.log(`\n[preview-live-smoke] ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[preview-live-smoke] received ${signal} — tearing down…`);
    step99Teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[preview-live-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

// ── orchestration ──

async function run() {
  const ctx = step1PrepareProfile();
  ctx.teardownPromise = null;
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step2LaunchApp(ctx);
    await step3EnsureNonKimiActiveConnection(ctx);
    ctx.tabId = await step4CreateTab(ctx, "first");

    let liveOk = false;
    if (!FLAGS.mechanicalOnly && ctx.liveUnavailableReason === undefined) {
      liveOk = await attemptLiveRun(ctx);
    } else if (ctx.liveUnavailableReason !== undefined) {
      record("live model run", "SKIPPED", ctx.liveUnavailableReason);
    } else {
      record("live model run", "SKIPPED", "--mechanical-only was passed");
    }
    if (!liveOk) {
      await attemptMechanicalRun(ctx);
    }

    const previews = await assertTwoLivePreviews(ctx);
    if (previews !== null) {
      await assertConsolePageerror(ctx, previews);
    } else {
      record("console route shows the pageerror", "SKIPPED", "no previews to inspect (previous assertion failed)");
    }
    await assertTranscriptPreviewConsole(ctx);
    await assertLifecycleOnClose(ctx);
    await assertQuitClean(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[preview-live-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await step99Teardown(ctx, failedStep);
  const anyFail = dodItems.some((i) => i.status === "FAIL");
  process.exit(failedStep === null && !anyFail ? 0 : 1);
}

run().catch((err) => {
  console.error(`[preview-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

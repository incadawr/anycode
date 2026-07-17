/**
 * Live GUI smoke for codex-profiles W4-S2 (ruling w4-remainder-ruling-fable-
 * iter9.md §1d row 5): the IN-APP install wiring of the Codex binary plane —
 * Settings→Codex pane button → controller → download/extract under the
 * `ANYCODE_CODEX_PROFILES_HOME` lever home → doctor/manifest state → pane
 * button state — plus the HONEST OFFLINE degradation of the same buttons.
 *
 * ── NOT A DUPLICATE of the module-level live smoke ──
 * `apps/desktop/src/main/codex-install.live-smoke.test.ts` (env-gated,
 * ANYCODE_CODEX_LIVE_SMOKE=1) already proves the module-level B-S facts:
 * the REAL `@openai/codex` platform artifact downloads from
 * registry.npmjs.org, the registry sha512 verifies, the vendor subtree
 * extracts with the production reader, and `bin/codex --version` answers.
 * This script does NOT re-assert any of that inventory — its value is the
 * APP-LEVEL wiring on top (ruling §1c-2 п.3): the pane's own rendered
 * button drives the one product path end-to-end and the resulting state is
 * observed through probe (a) + the lever home + the persisted settings.
 *
 * ── Reaching the button on THIS stand (test-fixture note, no product delta) ──
 * The discovery ladder's `common` rung unconditionally probes
 * `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin` — all three
 * hold the owner's REAL codex 0.144.5, which is INSIDE the supported range,
 * so `not_installed`/`update_required` (the only two states that render an
 * install-plane primary button, CodexEnginePane.tsx) are unreachable with a
 * neutral seed. The smoke therefore seeds the ISOLATED settings.json's
 * `codex.binaryPath` (the `settings` rung — ABOVE path/common) with a stub
 * that answers `codex-cli 0.100.0` to `--version`: the doctor's version
 * preflight lands on `update_required` (codex-doctor.ts returns BEFORE any
 * app-server spawn, so the stub needs nothing else), and the pane renders
 * its REAL "Update to <recommended>" primary + "Use anyway" risk toggle —
 * the same `installBinary(support.recommended)` product path the
 * `not_installed` Install button drives, and one of the two exact buttons
 * the W4-F0 install driver documents (automation/README.md). This models a
 * real user state: a saved binary path whose binary became outdated.
 *
 * ── Offline lever (deviation from ruling iter-8/iter-9 wording, ESCALATED) ──
 * The ruling mandates offline via `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9`.
 * Empirically (Electron 43 = Node 24.17.0, ELECTRON_RUN_AS_NODE probe): the
 * main-process global `fetch` is Node's undici, which IGNORES proxy env vars
 * by default — with the bare mandated vars the "offline" run fetches the
 * registry fine (HTTP 200). Node 24's documented `NODE_USE_ENV_PROXY=1`
 * runtime knob makes undici honor exactly those mandated vars
 * (ECONNREFUSED on the dead port). The offline lane therefore sets the
 * mandated proxy vars PLUS `NODE_USE_ENV_PROXY=1` + `NO_PROXY=127.0.0.1,
 * localhost` (loopback exempt: automation channel, LM Studio base URL) —
 * same lever, activated; recorded as an ESCALATE in W4-findings-S2.md.
 * Ordering guard: the offline lane drives `manifest-refresh` FIRST — a
 * `source:"network"` reading would prove the offline env ineffective and
 * RED the lane BEFORE the install click can download ~115 MiB through a
 * run that claims to be offline.
 *
 * Case map per lane (PASS/FAIL first-FAIL-tears-down, exit 1):
 *   --lane online   S2-BASELINE → S2-LAUNCH → S2-PRESTATE (update_required
 *                   form: headline/tone, "Update to <recommended>" enabled,
 *                   risk toggle, stub path + "saved path" source, range/
 *                   recommended lines, System account row) → B-S/install
 *                   (driver fires the pane button; terminal state: button
 *                   gone, path under the lever codex bin tree,
 *                   "Sign in required" on the ambient sentinel CODEX_HOME —
 *                   the same discriminant S1 A-S used: a product that read
 *                   the owner's real ~/.codex would report Ready) →
 *                   B-S/disk (binary exists+executable under lever, bin dir
 *                   holds EXACTLY the one version dir — no tmp/download
 *                   litter, the settings.json binaryPath repointed) →
 *                   S2-REAL-HOME-NEG →
 *                   ORPHANS.
 *   --lane offline  S2-BASELINE → S2-LAUNCH → S2-PRESTATE (same stub form
 *                   proves the app BOOTS and diagnoses fine offline) →
 *                   B-S-OFFLINE/manifest (refresh degrades to source
 *                   "bundled"/"cache", never "network"; pane alive, busy
 *                   cleared) → B-S-OFFLINE/install (click → honest failure
 *                   notice, button back enabled — no crash, no eternal
 *                   busy, state still update_required) → B-S-OFFLINE/disk
 *                   (no version dir, no partial litter under the lever) →
 *                   S2-REAL-HOME-NEG → ORPHANS.
 *
 * Custody: `~/.codex`/`~/.codex-accounts` are never referenced; the ambient
 * CODEX_HOME sentinel keeps every doctor spawn (stub and the freshly
 * installed real binary) off the owner's real ~/.codex — the post-install
 * "Sign in required" assert IS the custody discriminant. The real
 * `~/.anycode/codex` gets the S1b lstat before/after pin (absent must stay
 * absent). No e-mail can appear anywhere (nothing ever signs in).
 *
 * Discipline: ONE Electron per invocation, foreground under the caller's
 * `timeout`; mktemp user-data + mktemp lever home + signal teardown +
 * orphan gate. The online lane downloads the real tarball exactly ONCE
 * (into the lever home); the offline lane downloads nothing.
 *
 * Usage:  node apps/desktop/scripts/codex-install-live-smoke.mjs --lane online|offline [--keep] [--port <n>]
 *
 * Evidence: working-docs/references/w4-live-evidence/s2-*.{png,log} (untracked).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "references", "w4-live-evidence");

const LAUNCH_TIMEOUT_MS = 150_000;
const PRESTATE_TIMEOUT_MS = 120_000;
// Download (~115 MiB) + extract (~311 MB) + post-install doctor + refreshAll.
const INSTALL_TERMINAL_TIMEOUT_MS = 360_000;
const OFFLINE_REFUSAL_TIMEOUT_MS = 120_000;
const MANIFEST_SETTLE_TIMEOUT_MS = 60_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const ORPHAN_SETTLE_MS = 5_000;

const REAL_CODEX_PROFILES_ROOT = join(homedir(), ".anycode", "codex");

// LM Studio (localhost) — providerReady for the boot tab only; no turn is ever sent.
const LM_BASE_URL = "http://127.0.0.1:1234/v1";
const LM_MODEL = "openai/gpt-oss-20b";

// Out-of-range on purpose (bundled manifest: >=0.144.0 <0.145.0) — the doctor
// preflight must land on update_required, never on a usable status.
const STUB_VERSION = "0.100.0";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined, lane: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") flags.keep = true;
    else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else if (arg === "--lane") {
      i += 1;
      flags.lane = argv[i];
    } else console.warn(`[codex-install-live-smoke] ignoring unrecognized argument: ${arg}`);
  }
  if (!["online", "offline"].includes(flags.lane)) {
    console.error(`[codex-install-live-smoke] --lane online|offline is required (got ${JSON.stringify(flags.lane)})`);
    process.exit(1);
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── bookkeeping (S1b scaffold) ──

class SmokeFailure extends Error {
  constructor(caseName, detail) {
    super(`${caseName} failed: ${detail}`);
    this.caseName = caseName;
  }
}

const verdicts = [];

function pass(caseName, detail) {
  verdicts.push({ caseName, verdict: "PASS", detail });
  console.log(`[${caseName}] PASS ${detail ?? ""}`.trimEnd());
}

function fail(caseName, detail) {
  verdicts.push({ caseName, verdict: "FAIL", detail });
  console.error(`[${caseName}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(caseName, detail);
}

function assert(caseName, cond, detail) {
  if (!cond) fail(caseName, detail);
}

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
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(-pid, signal);
  } catch {
    // already gone
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

function readDiscoveryFile(path) {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (typeof info?.pid === "number" && typeof info?.port === "number" && typeof info?.token === "string" && typeof info?.startedAt === "number") return info;
    return null;
  } catch {
    return null;
  }
}

// ── real-profiles-root custody snapshot (lstat only — content is NEVER read) ──

/** Recursive lstat map path -> "type mode size mtimeMs [linkTarget]". Never opens a file. */
function snapshotTree(root) {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      map.set(dir, "unreadable");
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        map.set(p, "unstatable");
        continue;
      }
      const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file";
      const link = st.isSymbolicLink() ? ` -> ${readlinkSync(p)}` : "";
      map.set(p, `${kind} ${(st.mode & 0o7777).toString(8)} ${st.isDirectory() ? "-" : st.size} ${st.mtimeMs}${link}`);
      if (st.isDirectory()) walk(p);
    }
  };
  const rootStat = lstatSync(root);
  map.set(root, `dir ${(rootStat.mode & 0o7777).toString(8)} - ${rootStat.mtimeMs}`);
  walk(root);
  return map;
}

function diffSnapshots(before, after) {
  const deltas = [];
  for (const [p, v] of before) {
    if (!after.has(p)) deltas.push(`REMOVED ${p}`);
    else if (after.get(p) !== v) deltas.push(`CHANGED ${p}: "${v}" -> "${after.get(p)}"`);
  }
  for (const p of after.keys()) {
    if (!before.has(p)) deltas.push(`ADDED ${p}`);
  }
  return deltas;
}

// ── process baseline (orphan gate, S1b scaffold) ──

function pgrepSnapshot() {
  try {
    const out = execFileSync("pgrep", ["-fl", "electron|codex"], { encoding: "utf8" });
    const map = new Map();
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (m) map.set(Number(m[1]), m[2]);
    }
    return map;
  } catch {
    return new Map(); // pgrep exits 1 when nothing matches
  }
}

function isAppLineage(cmd, ctx) {
  if ((typeof ctx.root === "string" && cmd.includes(ctx.root)) || cmd.includes(repoRoot)) return true;
  const base = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
  return ["codex", "codex-code-mode-host", "electron", "Electron"].includes(base);
}

// ── HTTP helpers (S1b scaffold) ──

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

async function apiOk(ctx, caseName, method, path, body) {
  let resp;
  try {
    resp = await api(ctx, method, path, body);
  } catch (err) {
    fail(caseName, `${method} ${path} threw: ${err?.message ?? err}`);
  }
  if (resp.status !== 200) fail(caseName, `${method} ${path} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function waitForFacade(ctx, caseName, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    let resp;
    try {
      resp = await api(ctx, "GET", "/state?tail=0");
    } catch {
      resp = { status: 0 };
    }
    if (resp.status === 200) return;
    if (Date.now() - start >= timeoutMs) fail(caseName, `renderer facade never installed within ${timeoutMs}ms (last GET /state -> HTTP ${resp.status})`);
    await sleep(150);
  }
}

async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[codex-install-live-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[codex-install-live-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

async function settledScreenshot(ctx, name) {
  await sleep(500);
  return saveScreenshot(ctx, name);
}

function readIsolatedSettings(ctx) {
  try {
    return JSON.parse(readFileSync(ctx.settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function leverBinDir(ctx) {
  return join(ctx.leverHome, ".anycode", "codex", "bin");
}

// ── case S2-BASELINE ──

function caseBaseline(ctx) {
  ctx.realRootBefore = existsSync(REAL_CODEX_PROFILES_ROOT) ? snapshotTree(REAL_CODEX_PROFILES_ROOT) : null;
  ctx.procBaseline = pgrepSnapshot();
  pass(
    "S2-BASELINE",
    `real ~/.anycode/codex ${ctx.realRootBefore === null ? "ABSENT (must stay absent)" : `snapshotted (${ctx.realRootBefore.size} entries)`}; ${ctx.procBaseline.size} pre-existing electron|codex pids`,
  );
}

// ── case S2-LAUNCH ──

async function caseLaunch(ctx) {
  const caseName = "S2-LAUNCH";
  ctx.root = mkdtempSync(join(tmpdir(), `anycode-s2-${FLAGS.lane}-`));
  ctx.tmpWorkspace = join(ctx.root, "ws");
  mkdirSync(ctx.tmpWorkspace);
  writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from codex-install-live-smoke\n");

  // Ambient sentinel CODEX_HOME: every doctor spawn (the stub now, the real
  // installed binary after B-S) must diagnose against THIS empty home, never
  // the owner's signed-in ~/.codex (which would flip signed_out -> ready).
  ctx.sentinelHome = join(ctx.root, "sentinel-codex-home");
  mkdirSync(ctx.sentinelHome, { mode: 0o700 });

  // The lane's lever home — the install/manifest plane must derive every
  // write from THIS root (W4-F0/F0b/F0d wiring).
  ctx.leverHome = join(ctx.root, "lever");
  mkdirSync(ctx.leverHome, { mode: 0o700 });

  // The update_required stub (see the header): answers `--version` with an
  // out-of-range release so the doctor preflight stops at update_required.
  const stubDir = join(ctx.root, "stub-bin");
  mkdirSync(stubDir, { mode: 0o700 });
  ctx.stubPath = join(stubDir, "codex");
  writeFileSync(
    ctx.stubPath,
    `#!/bin/sh\n# W4-S2 fixture: an outdated "codex" — version preflight only, never an app-server.\nif [ "$1" = "--version" ]; then\n  echo "codex-cli ${STUB_VERSION}"\n  exit 0\nfi\nexit 1\n`,
    { mode: 0o755 },
  );

  ctx.profileUserDataDir = join(ctx.root, "user-data");
  ctx.profileDbPath = join(ctx.root, "db.sqlite");
  ctx.profileAutomationInfo = join(ctx.root, "automation.json");
  ctx.settingsPath = join(ctx.root, "settings.json");
  ctx.secretsPath = join(ctx.root, "secrets.json");

  // `codex.binaryPath` = the settings rung of the discovery ladder (above
  // path/common — the only rung this smoke can own on a stand whose common
  // locations hold a real, in-range codex).
  const seedSettings = {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    codex: { binaryPath: ctx.stubPath },
  };
  writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
    // providerReady via env creds pointing at LM Studio — the boot tab spawns
    // and Welcome yields; NO turn is ever sent in this smoke.
    ANYCODE_API_KEY: "lm-studio-local",
    ANYCODE_BASE_URL: LM_BASE_URL,
    ANYCODE_MODEL: LM_MODEL,
    CODEX_HOME: ctx.sentinelHome,
    ANYCODE_CODEX_PROFILES_HOME: ctx.leverHome,
  };
  delete env.ANYCODE_REASONING_EFFORT;
  delete env.ANYCODE_CODEX_BIN;
  // Ambient proxy hygiene: the ONLINE lane must not inherit a stray proxy;
  // the OFFLINE lane sets its own controlled set below.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]) delete env[key];
  if (FLAGS.lane === "offline") {
    // The ruling's lever (dead-port proxy) + the Node 24 knob that makes
    // undici honor it (see the header's ESCALATE note). Loopback exempt:
    // the automation channel and the LM base URL stay reachable.
    env.HTTP_PROXY = "http://127.0.0.1:9";
    env.HTTPS_PROXY = "http://127.0.0.1:9";
    env.NO_PROXY = "127.0.0.1,localhost";
    env.NODE_USE_ENV_PROXY = "1";
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
    if (child.exitCode !== null || child.signalCode !== null) fail(caseName, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) fail(caseName, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  ctx.port = info.port;
  ctx.token = info.token;

  await waitForFacade(ctx, caseName);
  pass(caseName, `lane ${FLAGS.lane}: app up (pid=${info.pid}, port=${info.port}), lever=${ctx.leverHome}, stub=${ctx.stubPath}, sentinel CODEX_HOME=${ctx.sentinelHome}`);
}

// ── case S2-PRESTATE (the update_required "before" form) ──

async function openCodexPane(ctx, caseName) {
  let opened = null;
  for (let i = 0; i < 20; i += 1) {
    opened = await apiOk(ctx, caseName, "POST", "/settings/open", {});
    if (opened?.ok === true) break;
    await sleep(500);
  }
  assert(caseName, opened?.ok === true, `POST /settings/open never succeeded: ${JSON.stringify(opened)}`);
  const paneResp = await apiOk(ctx, caseName, "POST", "/settings/pane", { paneId: "codex" });
  assert(caseName, paneResp?.ok === true, `pane switch to codex refused: ${JSON.stringify(paneResp)}`);
}

async function codexPaneState(ctx, caseName) {
  return apiOk(ctx, caseName, "GET", "/settings/codex");
}

async function casePrestate(ctx) {
  const caseName = "S2-PRESTATE";
  await openCodexPane(ctx, caseName);

  // The pane mount kicks the sequential doctor pass; poll until the binary
  // block settles on the stub's update_required form (the primary renders).
  const deadline = Date.now() + PRESTATE_TIMEOUT_MS;
  let state = null;
  for (;;) {
    state = await codexPaneState(ctx, caseName);
    if (state?.mounted === true && state?.binary?.installButton !== null && state?.binary?.installButton !== undefined) break;
    if (Date.now() >= deadline) {
      fail(caseName, `binary block never settled on an install-plane primary within ${PRESTATE_TIMEOUT_MS}ms; binary=${JSON.stringify(state?.binary)} notices=${JSON.stringify(state?.notices)}`);
    }
    await sleep(1000);
  }

  const binary = state.binary;
  assert(caseName, binary.statusHeadline === "Update required", `expected headline "Update required" for the ${STUB_VERSION} stub, got: ${JSON.stringify(binary.statusHeadline)} (detail: ${JSON.stringify(binary.statusDetail)})`);
  assert(caseName, binary.statusTone === "warn", `expected tone "warn", got: ${JSON.stringify(binary.statusTone)}`);
  assert(caseName, binary.statusDetail.includes(STUB_VERSION), `status detail does not name the stub version ${STUB_VERSION}: ${JSON.stringify(binary.statusDetail)}`);
  assert(caseName, binary.binaryPath === ctx.stubPath, `binary path line != the seeded stub path;\n  shown=${JSON.stringify(binary.binaryPath)}\n  stub=${JSON.stringify(ctx.stubPath)}`);
  assert(caseName, binary.sourceLabel === "saved path", `expected source "saved path" (settings rung), got: ${JSON.stringify(binary.sourceLabel)}`);
  assert(caseName, typeof binary.supportedRange === "string" && binary.supportedRange.length > 0, `supported range line missing: ${JSON.stringify(binary.supportedRange)}`);
  const recommended = binary.recommended;
  assert(caseName, typeof recommended === "string" && /^\d+\.\d+\.\d+$/.test(recommended), `recommended version missing/malformed: ${JSON.stringify(recommended)}`);
  ctx.recommended = recommended;
  assert(
    caseName,
    binary.installButton.label === `Update to ${recommended}` && binary.installButton.disabled === false,
    `expected an enabled "Update to ${recommended}" primary, got: ${JSON.stringify(binary.installButton)}`,
  );
  assert(caseName, binary.riskToggleVisible === true, `"Use anyway" risk toggle not rendered for update_required: ${JSON.stringify(binary)}`);
  assert(caseName, Array.isArray(state.rows) && state.rows.length >= 1 && state.rows[0].label === "System (current environment)", `accounts block lacks the System row: ${JSON.stringify(state.rows?.map((r) => r.label))}`);
  assert(caseName, state.notices.length === 0, `unexpected pre-existing notices: ${JSON.stringify(state.notices)}`);

  const shot = await settledScreenshot(ctx, `s2-${FLAGS.lane}-before-install`);
  assert(caseName, typeof shot === "string", "pre-state screenshot capture failed");
  pass(
    caseName,
    `update_required form produced: "Update to ${recommended}" enabled + "Use anyway" rendered, stub path via "saved path", range=${binary.supportedRange}, System account row present`,
  );
}

// ── case B-S/install (online lane) ──

async function caseInstallOnline(ctx) {
  const caseName = "B-S/install";
  const fired = await apiOk(ctx, caseName, "POST", "/settings/codex/install", {});
  assert(caseName, fired?.ok === true, `install driver refused: ${JSON.stringify(fired)}`);

  // Fire-and-return driver: poll the pane for the terminal state — the
  // primary disappears only when the recheck after a SUCCESSFUL install
  // lands on a usable status; any failure surfaces as a notice instead.
  const deadline = Date.now() + INSTALL_TERMINAL_TIMEOUT_MS;
  let state = null;
  for (;;) {
    state = await codexPaneState(ctx, caseName);
    const binary = state?.binary;
    if (state?.notices?.length > 0) {
      fail(caseName, `install surfaced a failure notice: ${JSON.stringify(state.notices)}`);
    }
    if (binary && binary.installButton === null && typeof binary.binaryPath === "string" && binary.binaryPath !== ctx.stubPath) break;
    if (Date.now() >= deadline) {
      fail(caseName, `install never reached the terminal state within ${INSTALL_TERMINAL_TIMEOUT_MS}ms; binary=${JSON.stringify(binary)} notices=${JSON.stringify(state?.notices)}`);
    }
    await sleep(2000);
  }

  const binary = state.binary;
  const installDir = join(leverBinDir(ctx), ctx.recommended);
  assert(
    caseName,
    binary.binaryPath.startsWith(installDir + "/"),
    `terminal binary path is not under the lever install dir;\n  shown=${JSON.stringify(binary.binaryPath)}\n  wanted prefix=${JSON.stringify(installDir + "/")}`,
  );
  assert(caseName, binary.sourceLabel === "saved path", `post-install source expected "saved path" (persisted binaryPath), got: ${JSON.stringify(binary.sourceLabel)}`);
  // signed_out on the ambient SENTINEL home — the custody discriminant: had
  // the post-install doctor read the owner's real ~/.codex it would say Ready.
  assert(caseName, binary.statusHeadline === "Sign in required", `post-install headline expected "Sign in required" (signed_out on the sentinel home), got: ${JSON.stringify(binary.statusHeadline)} (detail: ${JSON.stringify(binary.statusDetail)})`);
  assert(caseName, binary.statusDetail.includes(`Codex ${ctx.recommended}`), `post-install detail does not name the installed version ${ctx.recommended}: ${JSON.stringify(binary.statusDetail)}`);
  assert(caseName, binary.riskToggleVisible === false, `"Use anyway" still rendered after a successful install: ${JSON.stringify(binary)}`);
  ctx.installedBinaryPath = binary.binaryPath;

  const shot = await settledScreenshot(ctx, "s2-online-after-install");
  assert(caseName, typeof shot === "string", "post-install screenshot capture failed");
  pass(caseName, `pane button drove the real install: primary gone, "Sign in required" @ Codex ${ctx.recommended}, path under lever (${binary.binaryPath})`);
}

// ── case B-S/disk (online lane) ──

function caseDiskOnline(ctx) {
  const caseName = "B-S/disk";
  const binDir = leverBinDir(ctx);
  const entries = readdirSync(binDir).sort();
  assert(caseName, JSON.stringify(entries) === JSON.stringify([ctx.recommended]), `lever bin dir expected EXACTLY ["${ctx.recommended}"] (no .tmp-*/.download-* litter, no stray versions), got: ${JSON.stringify(entries)}`);

  const st = lstatSync(ctx.installedBinaryPath);
  assert(caseName, st.isFile() && (st.mode & 0o111) !== 0, `installed binary is not an executable regular file: ${ctx.installedBinaryPath} (mode 0${(st.mode & 0o7777).toString(8)})`);

  const settings = readIsolatedSettings(ctx);
  assert(
    caseName,
    settings?.codex?.binaryPath === ctx.installedBinaryPath,
    `settings.codex.binaryPath was not repointed to the installed binary;\n  settings=${JSON.stringify(settings?.codex?.binaryPath)}\n  installed=${JSON.stringify(ctx.installedBinaryPath)}`,
  );
  assert(caseName, !JSON.stringify(settings?.codex ?? {}).includes("@"), `persisted codex slice contains a "@" (possible e-mail leak into settings.json)`);
  pass(caseName, `lever tree clean: bin/=[${ctx.recommended}], binary executable, settings.json repointed stub -> installed path`);
}

// ── case B-S-OFFLINE/manifest (offline lane) ──

async function caseManifestOffline(ctx) {
  const caseName = "B-S-OFFLINE/manifest";
  const fired = await apiOk(ctx, caseName, "POST", "/settings/codex/manifest-refresh", {});
  assert(caseName, fired?.ok === true, `manifest-refresh driver refused: ${JSON.stringify(fired)}`);

  // The pane renders "(<source>)" only after its refreshManifest round-trip
  // resolves — poll for it, then judge the source. This runs BEFORE the
  // install click on purpose: source "network" here = the offline env is NOT
  // cutting the app's fetch, and clicking install would download ~115 MiB
  // through a run that claims to be offline — RED immediately instead.
  const sourceDeadline = Date.now() + MANIFEST_SETTLE_TIMEOUT_MS;
  let state = null;
  for (;;) {
    state = await codexPaneState(ctx, caseName);
    if (typeof state?.binary?.manifestSource === "string") break;
    if (Date.now() >= sourceDeadline) fail(caseName, `manifest source never rendered within ${MANIFEST_SETTLE_TIMEOUT_MS}ms: ${JSON.stringify(state?.binary)}`);
    await sleep(1000);
  }
  const source = state.binary.manifestSource;
  assert(caseName, source !== "network", `manifest refresh reported source "network" while offline — the dead-port proxy env is NOT cutting the app's fetch (offline lane invalid, aborting before the install click can download)`);
  assert(caseName, source === "bundled" || source === "cache", `unexpected manifest source: ${JSON.stringify(source)}`);
  assert(caseName, typeof state.binary.supportedRange === "string" && state.binary.supportedRange.length > 0, `supported range line vanished after the offline refresh: ${JSON.stringify(state.binary.supportedRange)}`);

  // Second settle phase: the pane's own refreshManifest sets the source line
  // FIRST, then re-runs the sequential doctor pass and only then clears
  // `busy` — the "no eternal busy" judgment belongs AFTER that settles, not
  // at the first frame the source renders.
  const busyDeadline = Date.now() + MANIFEST_SETTLE_TIMEOUT_MS;
  for (;;) {
    state = await codexPaneState(ctx, caseName);
    const button = state?.binary?.installButton;
    if (button !== null && button !== undefined && button.disabled === false) break;
    if (Date.now() >= busyDeadline) {
      fail(caseName, `pane stuck busy after the offline manifest refresh (primary missing/disabled past ${MANIFEST_SETTLE_TIMEOUT_MS}ms): ${JSON.stringify(state?.binary?.installButton)}`);
    }
    await sleep(1000);
  }

  const shot = await settledScreenshot(ctx, "s2-offline-manifest-bundled");
  assert(caseName, typeof shot === "string", "offline manifest screenshot capture failed");
  pass(caseName, `offline manifest refresh degraded fail-closed: source "${source}" (never "network"), range still rendered, pane responsive`);
}

// ── case B-S-OFFLINE/install (offline lane) ──

async function caseInstallOffline(ctx) {
  const caseName = "B-S-OFFLINE/install";
  const fired = await apiOk(ctx, caseName, "POST", "/settings/codex/install", {});
  assert(caseName, fired?.ok === true, `install driver refused: ${JSON.stringify(fired)}`);

  // Terminal = an honest failure notice AND the primary back enabled (busy
  // cleared). The primary DISAPPEARING would mean the install SUCCEEDED —
  // the offline env failed to cut the network: RED.
  const deadline = Date.now() + OFFLINE_REFUSAL_TIMEOUT_MS;
  let state = null;
  for (;;) {
    state = await codexPaneState(ctx, caseName);
    const binary = state?.binary;
    if (binary && binary.installButton === null) {
      fail(caseName, `the offline install SUCCEEDED (primary gone, path=${JSON.stringify(binary.binaryPath)}) — the dead-port proxy env did not cut the download`);
    }
    if (state?.notices?.length > 0 && binary?.installButton?.disabled === false) break;
    if (Date.now() >= deadline) {
      fail(caseName, `no failure notice within ${OFFLINE_REFUSAL_TIMEOUT_MS}ms (no crash but no honest refusal either); binary=${JSON.stringify(binary)} notices=${JSON.stringify(state?.notices)}`);
    }
    await sleep(1000);
  }

  const notices = state.notices;
  assert(
    caseName,
    notices.some((n) => /registry metadata fetch failed|tarball download (failed|answered)/i.test(n)),
    `failure notice does not carry the installer's honest network-failure copy: ${JSON.stringify(notices)}`,
  );
  const binary = state.binary;
  assert(caseName, binary.statusHeadline === "Update required", `binary status should be UNCHANGED (update_required) after the refused install, got: ${JSON.stringify(binary.statusHeadline)}`);
  assert(caseName, binary.binaryPath === ctx.stubPath, `binary path changed despite the refused install: ${JSON.stringify(binary.binaryPath)}`);
  assert(caseName, binary.installButton.label === `Update to ${ctx.recommended}`, `primary label changed after the refused install: ${JSON.stringify(binary.installButton)}`);

  // Liveness: the window still answers /health — degraded, not crashed.
  const health = await apiOk(ctx, caseName, "GET", "/health");
  assert(caseName, health?.ok === true, `/health does not answer ok after the offline degradation: ${JSON.stringify(health)}`);

  const shot = await settledScreenshot(ctx, "s2-offline-install-degraded");
  assert(caseName, typeof shot === "string", "offline degradation screenshot capture failed");
  pass(caseName, `offline install degraded honestly: notice ${JSON.stringify(notices[0])}, primary re-enabled (no eternal busy), state still update_required, app alive`);
}

// ── case B-S-OFFLINE/disk (offline lane) ──

function caseDiskOffline(ctx) {
  const caseName = "B-S-OFFLINE/disk";
  const binDir = leverBinDir(ctx);
  if (existsSync(binDir)) {
    const entries = readdirSync(binDir);
    assert(caseName, entries.length === 0, `offline run left entries under the lever bin dir (partial download/extract litter or a version dir): ${JSON.stringify(entries)}`);
    pass(caseName, `lever bin dir exists (installer mkdir before the refused fetch) and is EMPTY — no partial artifact`);
  } else {
    pass(caseName, "lever bin dir was never created — no partial artifact");
  }
}

// ── case S2-REAL-HOME-NEG (after teardown) ──

function caseRealRootPin(ctx) {
  const caseName = "S2-REAL-HOME-NEG";
  const afterExists = existsSync(REAL_CODEX_PROFILES_ROOT);
  if (ctx.realRootBefore === null) {
    if (afterExists) {
      const after = snapshotTree(REAL_CODEX_PROFILES_ROOT);
      const listing = [...after.keys()].slice(0, 20).join("\n  ");
      fail(caseName, `real ~/.anycode/codex did not exist before the run but EXISTS after (${after.size} entries) — a write leaked past the lever into the owner's real home:\n  ${listing}`);
    }
    pass(caseName, "real ~/.anycode/codex ABSENT before AND after the run — zero writes into the owner's real profiles root");
    return;
  }
  if (!afterExists) {
    fail(caseName, "real ~/.anycode/codex existed before the run but is GONE after (something REMOVED the owner's real profiles root)");
  }
  const deltas = diffSnapshots(ctx.realRootBefore, snapshotTree(REAL_CODEX_PROFILES_ROOT));
  if (deltas.length > 0) {
    fail(caseName, `real ~/.anycode/codex changed during the run (${deltas.length} delta(s)):\n  ${deltas.slice(0, 20).join("\n  ")}`);
  }
  pass(caseName, `real ~/.anycode/codex byte-stable (${ctx.realRootBefore.size} entries, zero name/mode/size/mtime deltas)`);
}

// ── case ORPHANS (after teardown) ──

async function caseOrphans(ctx) {
  await sleep(ORPHAN_SETTLE_MS);
  const now = pgrepSnapshot();
  const orphans = [];
  for (const [pid, cmd] of now) {
    if (!ctx.procBaseline.has(pid) && isPidAlive(pid) && isAppLineage(cmd, ctx)) orphans.push(`${pid} ${cmd}`);
  }
  if (orphans.length > 0) {
    fail("ORPHANS", `new electron|codex pids survive teardown (settle ${ORPHAN_SETTLE_MS}ms):\n  ${orphans.join("\n  ")}`);
  }
  pass("ORPHANS", `0 new electron|codex pids after teardown + ${ORPHAN_SETTLE_MS}ms settle (baseline ${ctx.procBaseline.size} pre-existing pids untouched)`);
}

// ── teardown (S1b scaffold) ──

function teardown(ctx, failedCase) {
  if (!ctx.teardownPromise) ctx.teardownPromise = runTeardown(ctx, failedCase);
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedCase) {
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
      console.warn(`[codex-install-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[codex-install-live-smoke] still alive after SIGTERM — SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.root === "string" && existsSync(ctx.root)) {
    if (FLAGS.keep) console.log(`[codex-install-live-smoke] --keep set, tmp root preserved at: ${ctx.root}`);
    else {
      try {
        rmSync(ctx.root, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-install-live-smoke] failed to remove tmp root ${ctx.root}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedCase === null ? "ALL CASES SETTLED" : `STOPPED at ${failedCase}`;
  const summary = verdicts.map((v) => `${v.caseName}=${v.verdict}`).join(" · ");
  console.log(`\n[codex-install-live-smoke] lane=${FLAGS.lane} ${summary} — ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[codex-install-live-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = { teardownPromise: null, child: null, root: null };
  installSignalTeardown(ctx);

  let failedCase = null;
  const capture = (err) => {
    if (failedCase === null) failedCase = err instanceof SmokeFailure ? err.caseName : "unknown";
    if (!(err instanceof SmokeFailure)) console.error(`[codex-install-live-smoke] unexpected error: ${err?.stack ?? err}`);
  };

  try {
    caseBaseline(ctx);
    await caseLaunch(ctx);
    await casePrestate(ctx);
    if (FLAGS.lane === "online") {
      await caseInstallOnline(ctx);
      caseDiskOnline(ctx);
    } else {
      await caseManifestOffline(ctx);
      await caseInstallOffline(ctx);
      caseDiskOffline(ctx);
    }
  } catch (err) {
    capture(err);
  }

  await teardown(ctx, failedCase);

  // Custody + orphan gates run AFTER teardown by design — judgments about
  // what the whole run left behind. Each gets its own try so one FAIL can
  // never mask the other verdict.
  try {
    caseRealRootPin(ctx);
  } catch (err) {
    capture(err);
  }
  try {
    await caseOrphans(ctx);
  } catch (err) {
    capture(err);
  }

  process.exit(failedCase === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[codex-install-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

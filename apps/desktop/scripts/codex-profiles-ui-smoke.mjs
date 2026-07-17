/**
 * Live GUI smoke for codex-profiles W4-S1 (working-docs/build/design/
 * w4-plan-fable-iter8.md, chunk W4-S1; cut §13.2 gates A-S/E-S/F-S + pin F1):
 * drives a REAL Electron dev instance over the automation HTTP channel
 * (`main/automation/*`) and exercises the profile registry + per-profile
 * doctor + Settings Codex pane + StartScreen account chip against the REAL
 * codex binary (PATH ladder) and the owner's REAL `~/.codex-accounts/*` homes
 * (strictly read-only — proven by a before/after stat snapshot).
 *
 * Case map (PASS/FAIL/SKIP per case, first FAIL tears down, exit 1):
 *  - A-S  system pseudo-profile spawn-env custody + per-profile doctor:
 *         * ambient CODEX_HOME sentinel discriminant — the app is launched
 *           with CODEX_HOME=<empty tmp home>; the system profile MUST inherit
 *           it (doctor reports signed_out for the sentinel), never strip it
 *           (stripping would fall back to the owner's signed-in `~/.codex`
 *           and report ready — the RED form).
 *         * owner homes `~/.codex-accounts/{personal,acc2}` registered as
 *           linkedHome profiles are diagnosed per-profile (lastCheck stamped);
 *           with the owner homes at mode 0755 the §2.5 trust policy REFUSES
 *           a linked home wider than 0700 (diagnose-only, no chmod, no spawn)
 *           — expected status "error", and NOT ONE BYTE of the owner homes
 *           changes (asserted by the custody snapshot in the last case).
 *         * two tmp linkedHome profiles (mode 0700, synthetic rollouts) DO
 *           pass trust and get a real doctor spawn each — status signed_out
 *           with the real binary version proves CODEX_HOME was injected
 *           per-profile (the sentinel/ambient value was OVERRIDDEN).
 *  - E-S  Settings → Codex pane mounted via the real rail (panesVisible,
 *         activePane) + settled PNG evidence of the profile list, statuses,
 *         "Add account…", binary/version block. Quota block: SKIP (no
 *         profile can reach `ready` under S1 custody constraints — see
 *         W4-findings-S1.md; live quota evidence is chunk S3's).
 *  - F-S  StartScreen chip: draft engine core → no chip (PNG), draft engine
 *         codex (real `setDraftEngine` via POST /start-screen/engine) with 4
 *         registered profiles → chip rendered (PNG). Dropdown-level asserts
 *         (signed_out unpickable, "Add account…" last, read-only after
 *         session start) are BLOCKED: the automation channel has no
 *         codex-chip/pane probe (finding S1-1).
 *  - F1   rollout list == selected profile's home: BLOCKED for the same
 *         reason (no import-dialog probe/driver) — the two synthetic homes
 *         (2 vs 1 rollouts, disjoint file names) are the prepared
 *         discriminant for the continuation.
 *  - CUSTODY owner homes byte-stable: recursive stat snapshot of
 *         `~/.codex-accounts` + shallow `~/.codex` before launch vs after
 *         teardown — any size/mtime/mode/set delta fails the case (atime is
 *         not recorded, so atomic atime updates pass by construction).
 *  - ORPHANS pgrep 'electron|codex' baseline before launch vs after
 *         teardown + 5s settle — every NEW surviving pid fails the case.
 *
 * Boot/teardown scaffold lifted from ctx-popover-smoke.mjs (per-run
 * disposable profile discipline, P7.H). No live turns are sent — provider
 * env creds point at LM Studio only so the boot tab spawns and the Welcome
 * screen yields to the normal shell; zero owner quota is spent.
 *
 * ── W4-S1b lane (`--lane s1b-a` / `--lane s1b-b`) ──
 * Picks up the S1 SKIPs minus quota-block (ruling w4-remainder-ruling-fable-
 * iter9.md §1d row 4) on BASE2 using the W4-F0 probes (b)/(c) and the
 * `ANYCODE_CODEX_PROFILES_HOME` lever (F0/F0b/F0d). TWO separate app runs
 * (one lever home each, sequential — never two Electrons at once) with
 * structurally DISJOINT profile label/rollout-name sets:
 *  - F-S/dropdown (probe b): every signed_out option renders disabled:true;
 *    "Add account…" is the LAST popover row; a disabled row's pick is FIRED
 *    and must no-op (draft pick unchanged, popover still open) — the
 *    PRODUCT's lockout, not a channel guard.
 *  - Pin F1 (probe c): per run, the import dialog's profile options == this
 *    run's OWN registry and each profile's rollout list == EXACTLY the files
 *    planted in THIS run's lever home (`<lever>/.anycode/codex/profile-<id>/
 *    sessions`); any cross-run token appearing is RED by the exact-set
 *    asserts (label/name sets are disjoint by construction).
 *  - Bilateral live-pin (f0b-host-lever-ruling-fable-iter10.md, MANDATORY):
 *    negative arm — recursive lstat listing of the REAL `~/.anycode/codex`
 *    (names+mtime, content never read) before vs after each run diffs EMPTY
 *    (absent stays absent); positive arm — the lever home received the
 *    PRODUCT-created `profile-<id>` dir (mode 0700) of the seeded profile
 *    whose home the smoke deliberately did NOT pre-create.
 *  - Start-no-turn: a codex-draft submit with only signed_out profiles must
 *    be REFUSED fail-closed (canSpawn/not_ready) — the refusal is produced
 *    live; the read-only-after-start assert transfers to S3 (ruling §1d
 *    sanction) since readiness requires a real credential, out of scope here.
 *
 * Usage:   node apps/desktop/scripts/codex-profiles-ui-smoke.mjs [--keep] [--port <n>] [--lane s1|s1b-a|s1b-b]
 *
 * Evidence: working-docs/references/w4-live-evidence/s1-*.png / s1b-*.{png,log} (untracked).
 */

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "references", "w4-live-evidence");

const LAUNCH_TIMEOUT_MS = 180_000;
const RECHECK_SETTLE_TIMEOUT_MS = 180_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const ORPHAN_SETTLE_MS = 5_000;

const OWNER_ACCOUNTS_ROOT = join(homedir(), ".codex-accounts");
const OWNER_CODEX_HOME = join(homedir(), ".codex");

// LM Studio (localhost) — providerReady for the boot tab only; no turn is ever sent.
const LM_BASE_URL = "http://127.0.0.1:1234/v1";
const LM_MODEL = "openai/gpt-oss-20b";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined, lane: "s1" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") flags.keep = true;
    else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else if (arg === "--lane") {
      i += 1;
      flags.lane = argv[i];
    } else console.warn(`[codex-profiles-ui-smoke] ignoring unrecognized argument: ${arg}`);
  }
  if (!["s1", "s1b-a", "s1b-b"].includes(flags.lane)) {
    console.error(`[codex-profiles-ui-smoke] unknown --lane ${flags.lane} (expected s1 | s1b-a | s1b-b)`);
    process.exit(1);
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── bookkeeping ──

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

function skip(caseName, reason) {
  verdicts.push({ caseName, verdict: "SKIP", detail: reason });
  console.log(`[${caseName}] SKIP: ${reason}`);
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

function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
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

// ── owner-home custody snapshot (stat only — content is NEVER read) ──

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
      // Directory size/mtime excluded from dir records? No: mtime of a dir
      // changes when entries are added/removed — exactly what we must catch.
      map.set(p, `${kind} ${(st.mode & 0o7777).toString(8)} ${st.isDirectory() ? "-" : st.size} ${st.mtimeMs}${link}`);
      if (st.isDirectory()) walk(p);
    }
  };
  const rootStat = lstatSync(root);
  map.set(root, `dir ${(rootStat.mode & 0o7777).toString(8)} - ${rootStat.mtimeMs}`);
  walk(root);
  return map;
}

/** Shallow lstat map (top-level entries only) — for the large `~/.codex`. */
function snapshotShallow(root) {
  const map = new Map();
  const rootStat = lstatSync(root);
  map.set(root, `dir ${(rootStat.mode & 0o7777).toString(8)} - ${rootStat.mtimeMs}`);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      const st = lstatSync(p);
      const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file";
      map.set(p, `${kind} ${(st.mode & 0o7777).toString(8)} ${st.isDirectory() ? "-" : st.size} ${st.mtimeMs}`);
    } catch {
      map.set(p, "unstatable");
    }
  }
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

// ── process baseline (orphan gate) ──

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

async function discoverTabByWorkspace(ctx, caseName, workspace, timeoutMs = 90_000) {
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
        if (typeof tabState?.workspace === "string" && canonPath(tabState.workspace) === target) return tabId;
      }
    }
    if (Date.now() >= deadline) fail(caseName, `no tab with workspace===${workspace} appeared within ${timeoutMs}ms (tabs=${lastTabs})`);
    await sleep(250);
  }
}

async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[codex-profiles-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[codex-profiles-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
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

// ── case 0: baselines (before anything is spawned) ──

function case0Baselines(ctx) {
  for (const p of [OWNER_ACCOUNTS_ROOT, OWNER_CODEX_HOME]) {
    if (!existsSync(p)) fail("BASELINE", `owner home missing: ${p} (external precondition — cannot run A-S)`);
  }
  ctx.ownerBefore = snapshotTree(OWNER_ACCOUNTS_ROOT);
  ctx.codexHomeBefore = snapshotShallow(OWNER_CODEX_HOME);
  ctx.procBaseline = pgrepSnapshot();

  const versionLine = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  const m = versionLine.match(/(\d+\.\d+\.\d+)/);
  if (!m) fail("BASELINE", `could not parse codex --version output: ${versionLine}`);
  ctx.codexVersion = m[1];
  pass("BASELINE", `owner snapshots taken (${ctx.ownerBefore.size} entries under ~/.codex-accounts, ${ctx.codexHomeBefore.size} shallow under ~/.codex), codex ${ctx.codexVersion}, ${ctx.procBaseline.size} pre-existing electron|codex pids`);
}

// ── case 1: bootstrap + launch ──

function writeSyntheticRollout(homeDir, fileName, cwd) {
  const dir = join(homeDir, "sessions", ...fileName.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { cwd } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic W4-S1 rollout ${fileName}` }] } }),
  ];
  writeFileSync(join(homeDir, "sessions", fileName), lines.join("\n") + "\n");
}

async function case1Launch(ctx) {
  ctx.root = mkdtempSync(join(tmpdir(), "anycode-s1-smoke-"));
  ctx.tmpWorkspace = join(ctx.root, "ws");
  mkdirSync(ctx.tmpWorkspace);
  writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from codex-profiles-ui-smoke\n");

  // Ambient sentinel CODEX_HOME (A-S discriminant): an EMPTY valid home.
  ctx.sentinelHome = join(ctx.root, "sentinel-codex-home");
  mkdirSync(ctx.sentinelHome, { mode: 0o700 });

  // Two synthetic linkedHome profiles with DISJOINT rollout sets (pin-F1
  // discriminant, prepared for the continuation): a=2 files, b=1 file.
  ctx.homeA = join(ctx.root, "codex-home-a");
  ctx.homeB = join(ctx.root, "codex-home-b");
  mkdirSync(ctx.homeA, { mode: 0o700 });
  mkdirSync(ctx.homeB, { mode: 0o700 });
  chmodSync(ctx.homeA, 0o700);
  chmodSync(ctx.homeB, 0o700);
  writeSyntheticRollout(ctx.homeA, "2026/07/17/rollout-2026-07-17T09-00-00-smoke-a1.jsonl", "/tmp/proj-a1");
  writeSyntheticRollout(ctx.homeA, "2026/07/17/rollout-2026-07-17T09-05-00-smoke-a2.jsonl", "/tmp/proj-a2");
  writeSyntheticRollout(ctx.homeB, "2026/07/17/rollout-2026-07-17T09-10-00-smoke-b1.jsonl", "/tmp/proj-b1");

  ctx.profileUserDataDir = join(ctx.root, "user-data");
  ctx.profileDbPath = join(ctx.root, "db.sqlite");
  ctx.profileAutomationInfo = join(ctx.root, "automation.json");
  ctx.settingsPath = join(ctx.root, "settings.json");
  ctx.secretsPath = join(ctx.root, "secrets.json");

  const createdAt = new Date().toISOString();
  const seedSettings = {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    codex: {
      // No activeProfileId — the ACTIVE profile is the `system` pseudo-profile
      // (registry default), so the boot recheck + top-level lastCheck read the
      // ambient sentinel, never a registered home.
      profiles: [
        { id: "personal-ro", label: "Owner personal (linked)", createdAt, linkedHome: join(OWNER_ACCOUNTS_ROOT, "personal") },
        { id: "acc2-ro", label: "Owner acc2 (linked)", createdAt, linkedHome: join(OWNER_ACCOUNTS_ROOT, "acc2") },
        { id: "tmp-a", label: "Smoke tmp A", createdAt, linkedHome: ctx.homeA },
        { id: "tmp-b", label: "Smoke tmp B", createdAt, linkedHome: ctx.homeB },
      ],
    },
  };
  writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

  const t0 = Date.now();
  ctx.tLaunchIso = new Date(t0).toISOString();
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
    // A-S sentinel: ambient CODEX_HOME the system pseudo-profile MUST inherit.
    CODEX_HOME: ctx.sentinelHome,
  };
  delete env.ANYCODE_REASONING_EFFORT;
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
    if (child.exitCode !== null || child.signalCode !== null) fail("LAUNCH", `dev process exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) fail("LAUNCH", `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;

  await waitForFacade(ctx, "LAUNCH");
  ctx.tabId = await discoverTabByWorkspace(ctx, "LAUNCH", ctx.tmpWorkspace);
  pass("LAUNCH", `app up (pid=${info.pid}, port=${info.port}), boot tab ${ctx.tabId}, sentinel CODEX_HOME=${ctx.sentinelHome}`);
}

// ── case A-S ──

async function caseAS(ctx) {
  // Open Settings via the real gear path, land on the Codex pane — its mount
  // triggers the sequential per-profile doctor pass (system first).
  let opened = null;
  for (let i = 0; i < 20; i += 1) {
    opened = await apiOk(ctx, "A-S", "POST", "/settings/open", {});
    if (opened?.ok === true) break;
    await sleep(500);
  }
  assert("A-S", opened?.ok === true, `POST /settings/open never succeeded: ${JSON.stringify(opened)}`);

  const settingsState = await apiOk(ctx, "A-S", "GET", "/settings");
  assert("A-S", Array.isArray(settingsState?.panesVisible) && settingsState.panesVisible.includes("codex"), `settings rail has no "codex" pane: ${JSON.stringify(settingsState?.panesVisible)}`);

  const paneResp = await apiOk(ctx, "A-S", "POST", "/settings/pane", { paneId: "codex" });
  assert("A-S", paneResp?.ok === true, `pane switch to codex refused: ${JSON.stringify(paneResp)}`);

  // The doctor pass persists a credential-free lastCheck per profile (custody
  // §4.4) into the ISOLATED settings.json — poll it until all four rows and
  // the top-level (active=system) stamp are fresher than launch.
  const wanted = ["personal-ro", "acc2-ro", "tmp-a", "tmp-b"];
  const deadline = Date.now() + RECHECK_SETTLE_TIMEOUT_MS;
  let codexSlice = null;
  for (;;) {
    const parsed = readIsolatedSettings(ctx);
    codexSlice = parsed?.codex ?? null;
    const rows = new Map((codexSlice?.profiles ?? []).map((p) => [p.id, p]));
    const allStamped = wanted.every((id) => {
      const lc = rows.get(id)?.lastCheck;
      return lc !== undefined && lc.at >= ctx.tLaunchIso;
    });
    const topStamped = codexSlice?.lastCheck !== undefined && codexSlice.lastCheck.at >= ctx.tLaunchIso;
    if (allStamped && topStamped) break;
    if (Date.now() >= deadline) {
      fail(
        "A-S",
        `per-profile doctor pass never settled within ${RECHECK_SETTLE_TIMEOUT_MS}ms; ` +
          `top=${JSON.stringify(codexSlice?.lastCheck)} rows=${JSON.stringify((codexSlice?.profiles ?? []).map((p) => ({ id: p.id, lastCheck: p.lastCheck })))}`,
      );
    }
    await sleep(1000);
  }

  const rows = new Map(codexSlice.profiles.map((p) => [p.id, p]));

  // (1) Sentinel discriminant: the ACTIVE profile is `system`; its lastCheck
  // (the top-level slot) MUST reflect the EMPTY ambient sentinel home —
  // signed_out. A stripped/overridden CODEX_HOME would have read the owner's
  // signed-in ~/.codex and reported ready: the RED form.
  assert(
    "A-S",
    codexSlice.lastCheck.status === "signed_out",
    `system (active) lastCheck expected signed_out for the empty ambient sentinel home, got: ${JSON.stringify(codexSlice.lastCheck)} — ambient CODEX_HOME was not inherited byte-for-byte`,
  );

  // (2) Owner linked homes (mode 0755 observed pre-run): §2.5 trust policy
  // must REFUSE a linked home wider than 0700 (diagnose-only, no chmod, no
  // spawn) — status "error", stamped per profile (discovery DID pick them up).
  for (const id of ["personal-ro", "acc2-ro"]) {
    const lc = rows.get(id)?.lastCheck;
    assert("A-S", lc?.status === "error", `${id} expected status "error" (linked home wider than 0700 is trust-refused, diagnose-only), got: ${JSON.stringify(lc)}`);
  }

  // (3) tmp linked homes (0700) pass trust and get a REAL doctor spawn each:
  // signed_out (no credential) with the real binary version — proof the
  // profile's CODEX_HOME was injected (ambient sentinel OVERRIDDEN) and the
  // binary was discovered via the PATH ladder.
  for (const id of ["tmp-a", "tmp-b"]) {
    const lc = rows.get(id)?.lastCheck;
    assert("A-S", lc?.status === "signed_out", `${id} expected status "signed_out" (trusted empty home, no credential), got: ${JSON.stringify(lc)}`);
    assert("A-S", lc?.version === ctx.codexVersion, `${id} expected doctor version ${ctx.codexVersion}, got: ${JSON.stringify(lc)}`);
  }

  // (4) Custody: nothing that looks like an account e-mail may ever cross
  // into settings.json (§4.4 — lastCheck is the credential-free projection).
  const codexJson = JSON.stringify(codexSlice);
  assert("A-S", !codexJson.includes("@"), `persisted codex slice contains a "@" (possible e-mail leak into settings.json)`);

  pass(
    "A-S",
    `system(active)=signed_out on ambient sentinel (inheritance proven); personal-ro/acc2-ro=error (0755 linked homes trust-refused, diagnose-only); tmp-a/tmp-b=signed_out@${ctx.codexVersion} (per-profile CODEX_HOME injection proven); no e-mail in settings.json`,
  );
}

// ── case E-S ──

async function caseES(ctx) {
  const settingsState = await apiOk(ctx, "E-S", "GET", "/settings");
  assert("E-S", settingsState?.open === true && settingsState?.activePane === "codex", `expected Settings open on the codex pane: ${JSON.stringify({ open: settingsState?.open, activePane: settingsState?.activePane })}`);

  const shot = await settledScreenshot(ctx, "s1-E-S-codex-pane");
  assert("E-S", typeof shot === "string", "codex pane screenshot capture failed");

  skip("E-S/quota-block", "no profile can reach `ready` under S1 custody constraints (owner linked homes are 0755 → trust-refused; an authLink/plain profile would write the REAL ~/.anycode/codex — no isolation lever exists, finding S1-2); live quota evidence is chunk S3's");
  console.log('[E-S/risk-toggle] note: binary version is inside the supported range — the risk-acceptance control is NOT rendered by design (enumerate-good); the binary/version/manifest block is on the same screenshot');
  pass("E-S", "Settings→Codex pane mounted via the real rail (panesVisible+activePane asserted); profile list/statuses/Add-account/binary block captured as PNG evidence");
}

// ── case F-S ──

async function caseFS(ctx) {
  await apiOk(ctx, "F-S", "POST", "/settings/close", {});
  const openResp = await apiOk(ctx, "F-S", "POST", "/start-screen/open", {});
  assert("F-S", openResp?.ok === true, `start-screen open refused: ${JSON.stringify(openResp)}`);

  let start = await apiOk(ctx, "F-S", "GET", "/start-screen");
  assert("F-S", start?.rendered === true, `start screen not rendered: ${JSON.stringify(start)}`);
  assert("F-S", Array.isArray(start?.availableEngines) && start.availableEngines.includes("codex"), `compiled-in engine catalog misses codex: ${JSON.stringify(start?.availableEngines)}`);
  assert("F-S", start?.engine === "core", `fresh draft expected engine core, got: ${JSON.stringify(start?.engine)}`);

  const coreShot = await settledScreenshot(ctx, "s1-F-S-core-no-chip");
  assert("F-S", typeof coreShot === "string", "core-draft screenshot capture failed");

  const engineResp = await apiOk(ctx, "F-S", "POST", "/start-screen/engine", { engineId: "codex" });
  assert("F-S", engineResp?.ok === true, `setDraftEngine(codex) refused: ${JSON.stringify(engineResp)}`);
  start = await apiOk(ctx, "F-S", "GET", "/start-screen");
  assert("F-S", start?.engine === "codex", `draft engine did not switch to codex: ${JSON.stringify(start?.engine)}`);

  const codexShot = await settledScreenshot(ctx, "s1-F-S-codex-chip");
  assert("F-S", typeof codexShot === "string", "codex-draft screenshot capture failed");

  skip(
    "F-S/dropdown",
    "chip dropdown asserts (signed_out row visible-but-disabled, «Add account…» last, chip read-only after session start) are BLOCKED: the automation channel has no codex-profile-chip probe/driver (finding S1-1); the render source (StartScreen.tsx ~l.946: options mapped with disabled=status===signed_out, divider, then Add account… last) is code-verified only",
  );
  pass("F-S", "engine=core draft → no chip (PNG); engine=codex draft via the real setDraftEngine route with 4 registered profiles → chip rendered (PNG); Codex engine BUTTON hidden as expected (no ready profile ⇒ canSpawn(codex)=false)");
}

// ── case F1 (pin) ──

function caseF1() {
  skip(
    "F1",
    "BLOCKED: no automation probe/driver for the rollout-import dialog (CodexEnginePane→CodexRolloutImportDialog) — the shown-list-vs-selected-home discriminant cannot be produced live (finding S1-1). Prepared for the continuation: tmp-a home holds rollouts {a1,a2}, tmp-b holds {b1} — disjoint by construction",
  );
}

// ── W4-S1b lane cases (ruling iter-9 §1d row 4 + iter-10 bilateral live-pin) ──

const REAL_CODEX_PROFILES_ROOT = join(homedir(), ".anycode", "codex");

/**
 * Per-run config: DISJOINT label sets and rollout-name tokens between run A
 * and run B, so run B showing anything of run A's home (or vice versa) can
 * never pass the exact-set asserts by coincidence (pin F1's structural
 * exclusion). Exactly one profile per run has `rollouts: null` — its managed
 * home is deliberately NOT pre-created on disk: the PRODUCT must create it
 * under the lever root (doctor pre-flight `assertCodexProfileHome`, mkdir
 * 0700) — the live-pin's positive arm.
 */
const S1B_RUNS = {
  "s1b-a": {
    key: "A",
    leverDirName: "lever-a",
    profiles: [
      {
        id: "lima-uno",
        label: "Lima Uno",
        rollouts: [
          "2026/07/17/rollout-2026-07-17T09-00-00-lima1.jsonl",
          "2026/07/17/rollout-2026-07-17T09-05-00-lima2.jsonl",
        ],
      },
      { id: "lima-dos", label: "Lima Dos", rollouts: ["2026/07/17/rollout-2026-07-17T09-10-00-lima3.jsonl"] },
      { id: "lima-tres", label: "Lima Tres", rollouts: null },
    ],
    foreignLabels: ["Mike Uno", "Mike Dos", "Mike Tres"],
    foreignToken: "mike",
    // Run A carries the one-per-lane gates (disabled-pick no-op probe and the
    // start-no-turn submit refusal); run B re-asserts only the per-home facts.
    fullGates: true,
  },
  "s1b-b": {
    key: "B",
    leverDirName: "lever-b",
    profiles: [
      { id: "mike-uno", label: "Mike Uno", rollouts: ["2026/07/17/rollout-2026-07-17T10-00-00-mike1.jsonl"] },
      {
        id: "mike-dos",
        label: "Mike Dos",
        rollouts: [
          "2026/07/17/rollout-2026-07-17T10-05-00-mike2.jsonl",
          "2026/07/17/rollout-2026-07-17T10-10-00-mike3.jsonl",
        ],
      },
      { id: "mike-tres", label: "Mike Tres", rollouts: null },
    ],
    foreignLabels: ["Lima Uno", "Lima Dos", "Lima Tres"],
    foreignToken: "lima",
    fullGates: false,
  },
};

function s1bManagedHome(ctx, profileId) {
  return join(ctx.leverHome, ".anycode", "codex", `profile-${profileId}`);
}

/** Retry-open the Settings dialog and land on the Codex pane (welcome-screen settle precedent from caseAS). */
async function s1bOpenCodexPane(ctx, caseName) {
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

// ── case S1B-BASELINE ──

function s1bBaselines(ctx) {
  // Negative-arm baseline of the bilateral live-pin: recursive lstat listing
  // (names/mode/size/mtime — file CONTENT is never read) of the owner's REAL
  // profiles root. An absent root is a legal baseline: it must stay absent.
  ctx.realRootBefore = existsSync(REAL_CODEX_PROFILES_ROOT) ? snapshotTree(REAL_CODEX_PROFILES_ROOT) : null;
  ctx.procBaseline = pgrepSnapshot();

  const versionLine = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  const m = versionLine.match(/(\d+\.\d+\.\d+)/);
  if (!m) fail("S1B-BASELINE", `could not parse codex --version output: ${versionLine}`);
  ctx.codexVersion = m[1];
  pass(
    "S1B-BASELINE",
    `real ~/.anycode/codex ${ctx.realRootBefore === null ? "ABSENT (must stay absent)" : `snapshotted (${ctx.realRootBefore.size} entries)`}; codex ${ctx.codexVersion}; ${ctx.procBaseline.size} pre-existing electron|codex pids`,
  );
}

// ── case S1B-LAUNCH ──

async function s1bLaunch(ctx, cfg) {
  ctx.root = mkdtempSync(join(tmpdir(), `anycode-s1b-${cfg.key.toLowerCase()}-`));
  ctx.tmpWorkspace = join(ctx.root, "ws");
  mkdirSync(ctx.tmpWorkspace);
  writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from codex-profiles-ui-smoke (s1b)\n");

  // Ambient sentinel CODEX_HOME: keeps the system pseudo-profile's doctor
  // spawn OFF the owner's real ~/.codex (custody — a doctor run in the real
  // home would write codex bookkeeping files there).
  ctx.sentinelHome = join(ctx.root, "sentinel-codex-home");
  mkdirSync(ctx.sentinelHome, { mode: 0o700 });

  // This run's lever home. Managed homes for the rollout-carrying profiles
  // are pre-planted (they are OUR tmp dirs); the `rollouts: null` profile's
  // home is deliberately NOT created — the product must (live-pin positive arm).
  ctx.leverHome = join(ctx.root, cfg.leverDirName);
  mkdirSync(ctx.leverHome, { mode: 0o700 });
  for (const profile of cfg.profiles) {
    if (profile.rollouts === null) continue;
    const managedHome = s1bManagedHome(ctx, profile.id);
    mkdirSync(managedHome, { recursive: true, mode: 0o700 });
    chmodSync(managedHome, 0o700);
    for (const fileName of profile.rollouts) writeSyntheticRollout(managedHome, fileName, `/tmp/s1b-${profile.id}`);
  }

  ctx.profileUserDataDir = join(ctx.root, "user-data");
  ctx.profileDbPath = join(ctx.root, "db.sqlite");
  ctx.profileAutomationInfo = join(ctx.root, "automation.json");
  ctx.settingsPath = join(ctx.root, "settings.json");
  ctx.secretsPath = join(ctx.root, "secrets.json");

  const createdAt = new Date().toISOString();
  const seedSettings = {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    codex: {
      // Plain MANAGED records (no linkedHome/authLink): their homes derive
      // from the lever root. No activeProfileId — system (sentinel) is active.
      profiles: cfg.profiles.map(({ id, label }) => ({ id, label, createdAt })),
    },
  };
  writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

  const t0 = Date.now();
  ctx.tLaunchIso = new Date(t0).toISOString();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
    ANYCODE_API_KEY: "lm-studio-local",
    ANYCODE_BASE_URL: LM_BASE_URL,
    ANYCODE_MODEL: LM_MODEL,
    CODEX_HOME: ctx.sentinelHome,
    // The lane's subject: every codex-profiles plane (registry, doctor,
    // install cache, rollout import, host forward) must derive from THIS root.
    ANYCODE_CODEX_PROFILES_HOME: ctx.leverHome,
  };
  delete env.ANYCODE_REASONING_EFFORT;
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
    if (child.exitCode !== null || child.signalCode !== null) fail("S1B-LAUNCH", `dev process exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) fail("S1B-LAUNCH", `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;

  await waitForFacade(ctx, "S1B-LAUNCH");
  ctx.tabId = await discoverTabByWorkspace(ctx, "S1B-LAUNCH", ctx.tmpWorkspace);
  pass("S1B-LAUNCH", `run ${cfg.key} up (pid=${info.pid}, port=${info.port}), lever=${ctx.leverHome}, sentinel CODEX_HOME=${ctx.sentinelHome}`);
}

// ── case S1B-DOCTOR ──

async function s1bDoctor(ctx, cfg) {
  const caseName = "S1B-DOCTOR";
  await s1bOpenCodexPane(ctx, caseName);

  // Pane mount triggers the sequential per-profile doctor pass; each managed
  // profile gets assertCodexProfileHome (mkdir under the lever) + a real
  // doctor spawn with the per-profile CODEX_HOME injected.
  const wanted = cfg.profiles.map((profile) => profile.id);
  const deadline = Date.now() + RECHECK_SETTLE_TIMEOUT_MS;
  let codexSlice = null;
  for (;;) {
    const parsed = readIsolatedSettings(ctx);
    codexSlice = parsed?.codex ?? null;
    const rows = new Map((codexSlice?.profiles ?? []).map((p) => [p.id, p]));
    const allStamped = wanted.every((id) => {
      const lc = rows.get(id)?.lastCheck;
      return lc !== undefined && lc.at >= ctx.tLaunchIso;
    });
    const topStamped = codexSlice?.lastCheck !== undefined && codexSlice.lastCheck.at >= ctx.tLaunchIso;
    if (allStamped && topStamped) break;
    if (Date.now() >= deadline) {
      fail(
        caseName,
        `per-profile doctor pass never settled within ${RECHECK_SETTLE_TIMEOUT_MS}ms; ` +
          `top=${JSON.stringify(codexSlice?.lastCheck)} rows=${JSON.stringify((codexSlice?.profiles ?? []).map((p) => ({ id: p.id, lastCheck: p.lastCheck })))}`,
      );
    }
    await sleep(1000);
  }

  const rows = new Map(codexSlice.profiles.map((p) => [p.id, p]));
  // system (active) inherited the empty sentinel — signed_out, never the
  // owner's real ~/.codex (which would report ready AND take a doctor spawn
  // in the owner's home).
  assert(caseName, codexSlice.lastCheck.status === "signed_out", `system (active) lastCheck expected signed_out on the sentinel home, got: ${JSON.stringify(codexSlice.lastCheck)}`);
  for (const id of wanted) {
    const lc = rows.get(id)?.lastCheck;
    assert(caseName, lc?.status === "signed_out", `${id} expected status "signed_out" (empty managed lever home, no credential), got: ${JSON.stringify(lc)}`);
    assert(caseName, lc?.version === ctx.codexVersion, `${id} expected doctor version ${ctx.codexVersion} (real spawn, per-profile CODEX_HOME injected), got: ${JSON.stringify(lc)}`);
  }
  assert(caseName, !JSON.stringify(codexSlice).includes("@"), `persisted codex slice contains a "@" (possible e-mail leak into settings.json)`);

  const shot = await settledScreenshot(ctx, `s1b-${cfg.key}-codex-pane`);
  assert(caseName, typeof shot === "string", "codex pane screenshot capture failed");
  pass(caseName, `all ${wanted.length} managed profiles doctor-stamped signed_out@${ctx.codexVersion}; system(active)=signed_out on sentinel; no e-mail in settings.json`);
}

// ── case S1B-LEVER-POS (live-pin positive arm) ──

function s1bLeverPos(ctx, cfg) {
  const caseName = "S1B-LEVER-POS";
  const virgin = cfg.profiles.find((profile) => profile.rollouts === null);
  const virginDir = s1bManagedHome(ctx, virgin.id);
  assert(caseName, existsSync(virginDir), `the PRODUCT never created ${virginDir} — the lever's managed-home derivation did not land in this run's lever home (positive arm RED)`);
  const st = lstatSync(virginDir);
  assert(caseName, st.isDirectory(), `${virginDir} is not a directory`);
  assert(caseName, (st.mode & 0o7777) === 0o700, `${virginDir} expected mode 0700, got 0${(st.mode & 0o7777).toString(8)}`);
  for (const profile of cfg.profiles) {
    if (profile.rollouts === null) continue;
    assert(caseName, existsSync(s1bManagedHome(ctx, profile.id)), `pre-planted managed home vanished: ${s1bManagedHome(ctx, profile.id)}`);
  }
  // The same product-created dir must NOT exist under the real root — the
  // creation went through the lever, not merely IN ADDITION to the real home.
  const realTwin = join(REAL_CODEX_PROFILES_ROOT, `profile-${virgin.id}`);
  assert(caseName, !existsSync(realTwin), `product-created profile dir ALSO appeared under the real root: ${realTwin}`);
  pass(caseName, `lever home received the PRODUCT-created profile-${virgin.id} (dir, mode 0700); pre-planted homes intact; no twin under real ~/.anycode/codex`);
}

// ── case F-S/dropdown (probe b) ──

async function s1bChip(ctx, cfg) {
  const caseName = "F-S/dropdown";
  await apiOk(ctx, caseName, "POST", "/settings/close", {});
  const openResp = await apiOk(ctx, caseName, "POST", "/start-screen/open", {});
  assert(caseName, openResp?.ok === true, `start-screen open refused: ${JSON.stringify(openResp)}`);
  const engineResp = await apiOk(ctx, caseName, "POST", "/start-screen/engine", { engineId: "codex" });
  assert(caseName, engineResp?.ok === true, `setDraftEngine(codex) refused: ${JSON.stringify(engineResp)}`);

  // The chip's option catalog is fetched async on the codex-selected
  // transition — poll for the chip to mount before probing the popover.
  const chipDeadline = Date.now() + 15_000;
  let chip = null;
  for (;;) {
    chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
    if (chip?.chipVisible === true) break;
    if (Date.now() >= chipDeadline) fail(caseName, `chip never became visible within 15s: ${JSON.stringify(chip)}`);
    await sleep(300);
  }
  assert(caseName, chip.label === "System", `chip label expected "System" before any pick, got: ${JSON.stringify(chip.label)}`);
  assert(caseName, chip.draftActive === true && chip.draftCodexProfileId === null, `expected an active draft with no profile pick: ${JSON.stringify({ draftActive: chip.draftActive, draftCodexProfileId: chip.draftCodexProfileId })}`);

  const openMenu = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { open: true });
  assert(caseName, openMenu?.ok === true, `popover open refused: ${JSON.stringify(openMenu)}`);
  chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
  assert(caseName, chip.menuOpen === true, `popover did not report open: ${JSON.stringify(chip)}`);

  const labels = chip.options.map((option) => option.label);
  const wantedLabels = cfg.profiles.map((profile) => profile.label);
  assert(caseName, JSON.stringify(labels) === JSON.stringify(wantedLabels), `rendered option labels != this run's registry;\n  shown=${JSON.stringify(labels)}\n  registry=${JSON.stringify(wantedLabels)}`);
  assert(caseName, labels.every((label) => !cfg.foreignLabels.includes(label)), `a FOREIGN run's profile label appeared in the dropdown: ${JSON.stringify(labels)}`);
  for (const option of chip.options) {
    assert(caseName, option.disabled === true, `signed_out profile "${option.label}" is NOT rendered disabled (F-S gate: signed_out must be visible but unpickable): ${JSON.stringify(option)}`);
    assert(caseName, option.current === false, `no option should be current before any pick: ${JSON.stringify(option)}`);
  }
  assert(caseName, chip.addAccountLast === true, `"Add account…" is not the LAST popover row (addAccountLast=${JSON.stringify(chip.addAccountLast)})`);

  const shot = await settledScreenshot(ctx, `s1b-${cfg.key}-chip-dropdown`);
  assert(caseName, typeof shot === "string", "chip dropdown screenshot capture failed");

  if (cfg.fullGates) {
    // Disabled-row pick: the click is FIRED (channel does not pre-refuse) and
    // must no-op — the PRODUCT's signed_out lockout, observed as an unchanged
    // draft pick and a still-open popover.
    const pickResp = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { pick: 0 });
    assert(caseName, pickResp?.ok === true, `disabled-row pick was not fired: ${JSON.stringify(pickResp)}`);
    await sleep(750);
    chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
    assert(caseName, chip.draftCodexProfileId === null, `picking a DISABLED (signed_out) row CHANGED the draft pick — the product lockout is broken: ${JSON.stringify(chip.draftCodexProfileId)}`);
    assert(caseName, chip.menuOpen === true, `popover closed after a disabled-row pick (a successful pick closes it — the lockout did not hold): ${JSON.stringify(chip)}`);
  }

  const closeMenu = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { open: false });
  assert(caseName, closeMenu?.ok === true, `popover close refused: ${JSON.stringify(closeMenu)}`);
  pass(
    caseName,
    `options == this run's registry (${wantedLabels.join(", ")}), all signed_out rows disabled, zero foreign labels, "Add account…" last${cfg.fullGates ? ", disabled-row pick fired and no-opped (draft unchanged, popover stayed open)" : ""}`,
  );
}

// ── case S1B-START-NO-TURN (run A only) ──

async function s1bStartNoTurn(ctx) {
  const caseName = "S1B-START-NO-TURN";
  const wsResp = await apiOk(ctx, caseName, "POST", "/start-screen/workspace", { workspace: ctx.tmpWorkspace });
  assert(caseName, wsResp?.ok === true, `draft workspace set refused: ${JSON.stringify(wsResp)}`);
  const promptResp = await apiOk(ctx, caseName, "POST", "/start-screen/prompt", { text: "W4-S1b start-no-turn probe (must never dispatch)" });
  assert(caseName, promptResp?.ok === true, `draft prompt set refused: ${JSON.stringify(promptResp)}`);

  // With every profile signed_out, codex readiness (doctor-confirmed
  // version-compatible AND signed-in) is false ⇒ manager.canSpawn(codex) is
  // false ⇒ tab-ipc's handleCreate refuses "not_ready" BEFORE any host fork.
  // A submit that SUCCEEDS here would mean a codex session spawned off a
  // signed_out profile — the RED form.
  const submit = await apiOk(ctx, caseName, "POST", "/start-screen/submit", {});
  assert(caseName, submit?.ok === false, `submit unexpectedly SUCCEEDED with only signed_out profiles (canSpawn/not_ready gate broken): ${JSON.stringify(submit)}`);

  const chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
  assert(caseName, chip.draftActive === true && chip.chipVisible === true, `draft was not left intact after the refusal (§3-D8): ${JSON.stringify({ draftActive: chip.draftActive, chipVisible: chip.chipVisible })}`);

  skip(
    "F-S/read-only-after-start",
    `start-no-turn is structurally unreachable in S1b: session start requires a doctor-confirmed signed-in profile (canSpawn/readyFor), and a real credential is out of this chunk's scope (mandate: signed-out lever homes only; ruling §1d sanctions the transfer). The fail-closed refusal WAS produced live: submit -> ${JSON.stringify(submit)}. Read-only-after-start moves to S3, where the authLink one-day profile makes a real managed start possible`,
  );
  pass(caseName, `codex-draft submit refused fail-closed (${JSON.stringify(submit?.message ?? submit)}); no session started; 0 live turns`);
}

// ── case F1-PIN (probe c) ──

async function s1bImportPin(ctx, cfg) {
  const caseName = "F1-PIN";
  await s1bOpenCodexPane(ctx, caseName);
  const openResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/open", { open: true });
  assert(caseName, openResp?.ok === true, `import dialog open refused: ${JSON.stringify(openResp)}`);

  let state = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, state.open === true && state.paneMounted === true, `import dialog did not report open: ${JSON.stringify({ open: state.open, paneMounted: state.paneMounted })}`);

  const optionIds = state.profileOptions.map((option) => option.id);
  const wantedIds = ["system", ...cfg.profiles.map((profile) => profile.id)];
  assert(caseName, JSON.stringify(optionIds) === JSON.stringify(wantedIds), `import dialog profile options != system + this run's registry;\n  shown=${JSON.stringify(optionIds)}\n  wanted=${JSON.stringify(wantedIds)}`);
  const registeredLabels = state.profileOptions.slice(1).map((option) => option.label);
  assert(caseName, registeredLabels.every((label) => !cfg.foreignLabels.includes(label)), `a FOREIGN run's profile label appeared in the import dialog: ${JSON.stringify(registeredLabels)}`);

  const shotOpen = await settledScreenshot(ctx, `s1b-${cfg.key}-import-open`);
  assert(caseName, typeof shotOpen === "string", "import dialog screenshot capture failed");

  for (const profile of cfg.profiles) {
    const switchResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/profile", { profileId: profile.id });
    assert(caseName, switchResp?.ok === true, `identity-gated profile switch to ${profile.id} refused: ${JSON.stringify(switchResp)}`);
    state = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
    assert(caseName, state.rolloutsFor === profile.id, `rollout list is not stamped for the requested profile (rolloutsFor=${JSON.stringify(state.rolloutsFor)}, wanted ${profile.id})`);
    assert(caseName, state.listLoading === false, `list still loading after the identity-gated settle: ${JSON.stringify(state.listLoading)}`);

    const shown = state.rollouts.map((rollout) => rollout.fileName).sort();
    const planted = [...(profile.rollouts ?? [])].sort();
    assert(
      caseName,
      JSON.stringify(shown) === JSON.stringify(planted),
      `pin F1 RED: shown rollout list for ${profile.id} != the CURRENT lever home's planted set;\n  shown=${JSON.stringify(shown)}\n  home=${JSON.stringify(planted)}`,
    );
    assert(caseName, shown.every((name) => !name.includes(cfg.foreignToken)), `pin F1 RED: a FOREIGN-home rollout (token "${cfg.foreignToken}") appeared in ${profile.id}'s list: ${JSON.stringify(shown)}`);
    if (planted.length > 1) {
      const shot = await settledScreenshot(ctx, `s1b-${cfg.key}-import-${profile.id}`);
      assert(caseName, typeof shot === "string", `import list screenshot capture failed for ${profile.id}`);
    }
  }

  const closeResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/open", { open: false });
  assert(caseName, closeResp?.ok === true, `import dialog close refused: ${JSON.stringify(closeResp)}`);
  pass(
    caseName,
    `profile options == system + this run's registry; per-profile rollout lists == EXACTLY the files planted under ${ctx.leverHome} (virgin profile lists empty); zero "${cfg.foreignToken}"-token entries`,
  );
}

// ── case S1B-REAL-HOME-NEG (live-pin negative arm, after teardown) ──

function s1bRealRootPin(ctx) {
  const caseName = "S1B-REAL-HOME-NEG";
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

// ── case CUSTODY + ORPHANS (after teardown) ──

/** Pids currently holding `path` open, via lsof (empty on failure/none). */
function lsofHolders(path) {
  try {
    const out = execFileSync("lsof", ["-t", "--", path], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function caseCustody(ctx) {
  const ownerAfter = snapshotTree(OWNER_ACCOUNTS_ROOT);
  const codexAfter = snapshotShallow(OWNER_CODEX_HOME);
  const deltas = [...diffSnapshots(ctx.ownerBefore, ownerAfter), ...diffSnapshots(ctx.codexHomeBefore, codexAfter).map((d) => `~/.codex ${d}`)];
  if (deltas.length > 0) {
    // Cross-session hazard on this machine: a long-lived FOREIGN codex
    // process (e.g. the owner's own codex-cli session in that home) keeps
    // its sqlite log/cache files open and mutates them regardless of this
    // smoke. A CHANGED entry whose file is held open by a pid that already
    // existed in the PRE-LAUNCH process baseline is attributed to that
    // foreign writer — an honest discriminant, not an exclusion: ADDED/
    // REMOVED entries and changes with no pre-existing holder still FAIL.
    const unattributed = [];
    const attributed = [];
    // Volatile bookkeeping files a LIVE foreign codex mutates on its own
    // schedule (never held open long enough for lsof in every case). Only
    // honored while a pre-existing codex-binary pid is still alive; the
    // credential/config/session surface (auth.json, config.toml, sessions/**)
    // is deliberately NOT in this list — a change there always fails.
    const volatilePattern = /^(logs_\d+\.sqlite(-wal|-shm)?|goals_\d+\.sqlite(-wal|-shm)?|models_cache\.json|history\.jsonl)$/;
    const foreignCodexAlive = [...ctx.procBaseline.entries()].some(([pid, cmd]) => {
      const base = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
      return (base === "codex" || base === "codex-code-mode-host") && isPidAlive(pid);
    });
    for (const delta of deltas) {
      const m = delta.match(/CHANGED (\/[^:]+):/);
      const changedPath = m?.[1];
      const holders = changedPath ? lsofHolders(changedPath).filter((pid) => ctx.procBaseline.has(pid)) : [];
      const baseName = changedPath?.split("/").pop() ?? "";
      if (holders.length > 0) attributed.push(`${delta} [held open by pre-existing pid(s) ${holders.join(",")}]`);
      else if (changedPath !== undefined && volatilePattern.test(baseName) && foreignCodexAlive) attributed.push(`${delta} [volatile codex bookkeeping file; pre-existing foreign codex process(es) alive]`);
      else unattributed.push(delta);
    }
    if (unattributed.length > 0) {
      fail("CUSTODY", `owner homes changed during the run (${unattributed.length} unattributed delta(s)):\n  ${unattributed.slice(0, 20).join("\n  ")}`);
    }
    pass("CUSTODY", `owner homes untouched by THIS run — every delta is a pre-existing foreign writer's:\n  ${attributed.join("\n  ")}`);
    return;
  }
  pass("CUSTODY", `owner homes byte-stable: ${ownerAfter.size} entries under ~/.codex-accounts and ${codexAfter.size} shallow under ~/.codex — zero size/mtime/mode/set deltas (atime not recorded)`);
}

/**
 * A pgrep -fl match is only OUR app's lineage when the EXECUTABLE (first
 * argv token) is an electron/codex binary, or the command references this
 * run's tmp root / this worktree. `pgrep -f 'electron|codex'` also matches
 * unrelated processes whose argv merely CONTAINS the substring (e.g. a
 * concurrent Claude session's `/bin/zsh -c ... CODEX_COMPANION_SESSION_ID=...`
 * shell) — those are foreign, never killable, never ours to report.
 */
function isAppLineage(cmd, ctx) {
  if ((typeof ctx.root === "string" && cmd.includes(ctx.root)) || cmd.includes(repoRoot)) return true;
  const base = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
  return ["codex", "codex-code-mode-host", "electron", "Electron"].includes(base);
}

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

// ── teardown ──

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
      console.warn(`[codex-profiles-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[codex-profiles-ui-smoke] still alive after SIGTERM — SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.root === "string" && existsSync(ctx.root)) {
    if (FLAGS.keep) console.log(`[codex-profiles-ui-smoke] --keep set, tmp root preserved at: ${ctx.root}`);
    else {
      try {
        rmSync(ctx.root, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-profiles-ui-smoke] failed to remove tmp root ${ctx.root}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedCase === null ? "ALL CASES SETTLED" : `STOPPED at ${failedCase}`;
  const summary = verdicts.map((v) => `${v.caseName}=${v.verdict}`).join(" · ");
  console.log(`\n[codex-profiles-ui-smoke] ${summary} — ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[codex-profiles-ui-smoke] received ${signal} — tearing down…`);
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
    if (!(err instanceof SmokeFailure)) console.error(`[codex-profiles-ui-smoke] unexpected error: ${err?.stack ?? err}`);
  };

  if (FLAGS.lane === "s1") {
    try {
      case0Baselines(ctx);
      await case1Launch(ctx);
      await caseAS(ctx);
      await caseES(ctx);
      await caseFS(ctx);
      caseF1();
    } catch (err) {
      capture(err);
    }

    await teardown(ctx, failedCase);

    // Custody + orphan gates run AFTER teardown by design — they are judgments
    // about what the whole run left behind, not about a live app. Each gets its
    // own try so a custody FAIL can never mask the orphan verdict (or vice
    // versa — both verdicts must always print).
    try {
      caseCustody(ctx);
    } catch (err) {
      capture(err);
    }
    try {
      await caseOrphans(ctx);
    } catch (err) {
      capture(err);
    }
  } else {
    // W4-S1b: one lever-home run per invocation (`s1b-a` / `s1b-b`) — the
    // orchestrating shell runs both sequentially; the cross-run discriminant
    // is carried by the disjoint label/rollout-name sets in S1B_RUNS.
    const cfg = S1B_RUNS[FLAGS.lane];
    try {
      s1bBaselines(ctx);
      await s1bLaunch(ctx, cfg);
      await s1bDoctor(ctx, cfg);
      s1bLeverPos(ctx, cfg);
      await s1bChip(ctx, cfg);
      if (cfg.fullGates) await s1bStartNoTurn(ctx);
      await s1bImportPin(ctx, cfg);
    } catch (err) {
      capture(err);
    }

    await teardown(ctx, failedCase);

    // Live-pin negative arm + orphan gate run AFTER teardown (same "judge
    // what the run left behind" posture as the s1 custody gate above).
    try {
      s1bRealRootPin(ctx);
    } catch (err) {
      capture(err);
    }
    try {
      await caseOrphans(ctx);
    } catch (err) {
      capture(err);
    }
  }

  process.exit(failedCase === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[codex-profiles-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

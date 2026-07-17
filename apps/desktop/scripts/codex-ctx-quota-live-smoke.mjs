/**
 * Live GUI smoke for codex-profiles W4-S3 (working-docs/build/design/
 * w4-plan-fable-iter8.md row W4-S3 + w4-remainder-ruling-fable-iter9.md §1d
 * row 6): ctx meter + subscription quotas on ONE real live turn, plus the
 * S1b-transferred read-only-after-start assert and the E-S quota-block.
 *
 * Setup (all product-created, nothing pre-planted inside the lever root):
 *  - mktemp lever home via `ANYCODE_CODEX_PROFILES_HOME` (W4-F0/F0b/F0d) —
 *    every codex-profiles plane (registry, doctor, install cache, rollout
 *    import, HOST spawn forward) derives from it; the real `~/.anycode/codex`
 *    must stay byte-untouched (bilateral live-pin, ruling F0b iter-10).
 *  - profile `s3-live`: authLink "~/.codex/auth.json" (the owner's plus
 *    account, same credential the W0-R1 probe ran on). The PRODUCT creates
 *    `<lever>/.anycode/codex/profile-s3-live` + the auth.json SYMLINK there
 *    (doctor pre-flight assertCodexProfileHome/ensureAuthLink) — the symlink
 *    lives on OUR side only; the owner's auth.json content is never read into
 *    logs (the in-script integrity parse below logs a boolean + byte size).
 *  - profile `s3-bare`: plain managed record, no credential — the E-S
 *    quota-block NEGATIVE arm (signed_out ⇒ quota block HIDDEN, never "0%")
 *    and the F-S disabled-row contra-form next to an ENABLED ready row.
 *
 * Case map (PASS/FAIL/SKIP per case; first FAIL tears down, exit 1):
 *  - S3-BASELINE   stand preconditions + custody snapshots (recursive lstat of
 *                  ~/.codex and ~/.codex-accounts — content never read; real
 *                  ~/.anycode/codex absent-ok baseline; pgrep baseline).
 *  - S3-LAUNCH     isolated app boot (mktemp user-data/db/settings + sentinel
 *                  ambient CODEX_HOME + lever root).
 *  - S3-DOCTOR     pane-mount doctor pass settles: s3-live=ready (authLink
 *                  credential visible through the product-created symlink),
 *                  s3-bare=signed_out, system=signed_out on the sentinel.
 *                  s3-live not ready ⇒ external precondition gone ⇒ the live
 *                  chain SKIPs (plan §2), custody gates still run.
 *  - S3-LEVER-POS  the PRODUCT created both profile homes under the lever
 *                  root (0700) + the s3-live auth.json symlink -> the recorded
 *                  target; no twin under the real root.
 *  - E-S/quota-block  probe (a): ready row renders a non-empty quota block,
 *                  signed_out row renders NONE (hidden, not "0%"); PNG.
 *  - S3-PAYLOAD    independent `account/rateLimits/read` fetch (own
 *                  `codex app-server --stdio` spawn, CODEX_HOME = the lever
 *                  profile home; read-call, no quota spend — plan §3) ⇒ the
 *                  rendered quota lines are asserted AGAINST the live payload:
 *                  window label derived from `windowDurationMins` (cut §6.2
 *                  table recomputed here as the independent expectation),
 *                  "% left" == 100-usedPercent (±1), reset suffix from
 *                  resetsAt (±1 unit), line COUNT == populated windows (+
 *                  credits) — a hardcoded "5h"/"weekly" pair = RED by count
 *                  and label.
 *  - F-S/chip-pick probe (b): ready row enabled+pickable (the contra-form
 *                  S1b could not produce), signed_out row disabled, "Add
 *                  account…" last; pick lands draftCodexProfileId.
 *  - S3-TURN (C-S) ONE live turn "Reply exactly: pong" via the real
 *                  start-screen submit; hard cap 1 + 1 retry (W4 wave budget
 *                  §3) — cap exhausted ⇒ stop + SKIP for the turn-gated rest.
 *  - S3-CTX (C-S/G-S) "N% ctx" chip text VISIBLE (C-bug-1 closure) + popover
 *                  open: headline + sessionTokens (live store copy) + PNG of
 *                  ring/popover incl. the quota lines. The ctx-popover PROBE
 *                  carries no quota-line field (infra gap — reported as a
 *                  finding), so the popover quota labels are PNG evidence;
 *                  the machine assert against the live payload rides probe
 *                  (a) above (same §6.2 derivation, doctor-fetched payload).
 *  - S3-READONLY-AFTER-START  (S1b transfer, ruling §1d) after the managed
 *                  session started the start screen (and chip) unmounted:
 *                  GET reads chipVisible:false/draftActive:false and a pick
 *                  is REFUSED `not_present` — the asserted refusal form.
 *  - S3-SESSION-FILES  (A1 seam + F0b host-plane forward) the REAL codex
 *                  child wrote its rollout under the LEVER profile home —
 *                  explicit assert line; the on-disk session row (sqlite at
 *                  ANYCODE_DB_PATH) carries codex_profile_id == "s3-live".
 *  - S3-REAL-HOME-NEG  real ~/.anycode/codex absent before ⇒ absent after.
 *  - S3-OWNER-CUSTODY  recursive diffs of ~/.codex and ~/.codex-accounts:
 *                  the ONLY sanctioned write is codex's own token refresh of
 *                  the owner auth.json through the symlink chain (validated
 *                  as still-parseable JSON, content never logged); volatile
 *                  bookkeeping changes are attributed to PRE-EXISTING foreign
 *                  codex processes (owner's codex-cli / Codex.app) via the
 *                  S1 lsof/volatile discipline; everything else fails.
 *  - S3-AUTH-VALID owner auth.json parses as JSON post-run (in-memory only;
 *                  log carries a boolean + byte size, never content).
 *  - ORPHANS       pgrep baseline vs post-teardown + settle; new pids = FAIL.
 *
 * Usage:   node apps/desktop/scripts/codex-ctx-quota-live-smoke.mjs [--keep] [--port <n>]
 * Evidence: working-docs/references/w4-live-evidence/s3-*.{png,log} (untracked).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "references", "w4-live-evidence");

const LAUNCH_TIMEOUT_MS = 180_000;
const RECHECK_SETTLE_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 150_000;
const RETRY_TURN_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 20_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const ORPHAN_SETTLE_MS = 5_000;

const OWNER_CODEX_HOME = join(homedir(), ".codex");
const OWNER_ACCOUNTS_ROOT = join(homedir(), ".codex-accounts");
const OWNER_AUTH_LINK = join(OWNER_CODEX_HOME, "auth.json");
const REAL_CODEX_PROFILES_ROOT = join(homedir(), ".anycode", "codex");

// Live profile ids/labels — disjoint from every other lane's token sets.
const LIVE_ID = "s3-live";
const LIVE_LABEL = "S3 Live";
const BARE_ID = "s3-bare";
const BARE_LABEL = "S3 Bare";

// LM Studio (localhost) — providerReady for the boot tab only; the live turn
// itself runs on the codex engine, not this provider.
const LM_BASE_URL = "http://127.0.0.1:1234/v1";
const LM_MODEL = "openai/gpt-oss-20b";

// Hard cap on live turns spent against the owner's account (plan §3: S3 gets
// 1 + 1 retry out of the wave's total 4).
const LIVE_TURN_CAP = 2;

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") flags.keep = true;
    else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else console.warn(`[codex-ctx-quota-live-smoke] ignoring unrecognized argument: ${arg}`);
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── bookkeeping (verdict ladder mirrors codex-profiles-ui-smoke.mjs) ──

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

// ── custody snapshots (lstat only — file content is NEVER read here) ──

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

// ── process baseline (orphan gate + foreign-writer attribution) ──

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

/**
 * Foreign codex-lineage writers this machine legitimately runs alongside the
 * smoke: the owner's codex-cli sessions in ~/.codex AND the OpenAI Codex.app
 * desktop app (both were live at S3 baseline on this stand). Only consulted
 * for the volatile-bookkeeping attribution below — never for our own orphans.
 */
function foreignCodexLineage(cmd) {
  const base = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
  if (base === "codex" || base === "codex-code-mode-host") return true;
  return cmd.includes("Codex.app") || cmd.includes("com.openai.codex");
}

// ── owner auth.json integrity (DoD-8: parse in memory, log NOTHING of it) ──

/**
 * Validity check of the owner credential: JSON.parse in process memory only.
 * The parsed value and raw bytes never reach a log, the findings file, or an
 * assertion message — only `valid` + `bytes` do (plan §3 custody).
 */
function ownerAuthIntegrity() {
  try {
    const raw = readFileSync(OWNER_AUTH_LINK, "utf8");
    let valid = false;
    try {
      const parsed = JSON.parse(raw);
      valid = parsed !== null && typeof parsed === "object";
    } catch {
      valid = false;
    }
    return { present: true, valid, bytes: Buffer.byteLength(raw, "utf8") };
  } catch {
    return { present: false, valid: false, bytes: 0 };
  }
}

// ── HTTP helpers (automation channel) ──

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
      console.warn(`[codex-ctx-quota-live-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[codex-ctx-quota-live-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
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

function profileHome(ctx, profileId) {
  return join(ctx.leverHome, ".anycode", "codex", `profile-${profileId}`);
}

/** Retry-open the Settings dialog and land on the Codex pane (welcome-settle precedent). */
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

// ── independent quota expectation (recomputed from the live payload) ──
//
// These mirror the DOCUMENTED cut §6.2 rules (the same table CodexEnginePane's
// formatters implement) as this script's independent expectation — computed
// from the raw `account/rateLimits/read` payload, so a product-side hardcode
// ("5h"/"weekly" pair, fabricated second window, "0%" placeholder) diverges
// from the expectation and fails the compare.

function expectedWindowLabel(windowDurationMins, limitName) {
  if (windowDurationMins === null || windowDurationMins === undefined) return limitName ?? "Limit";
  const table = { 60: "1h", 300: "5h", 1440: "Daily", 10080: "Weekly", 43200: "Monthly" };
  const known = table[windowDurationMins];
  if (known !== undefined) return known;
  return windowDurationMins % 1440 === 0 ? `${windowDurationMins / 1440}d` : `${Math.round(windowDurationMins / 60)}h`;
}

function expectedReset(resetsAtSeconds, nowMs) {
  if (resetsAtSeconds === null || resetsAtSeconds === undefined) return null;
  const diffMs = resetsAtSeconds * 1000 - nowMs;
  if (diffMs <= 0) return { unit: "now", value: 0 };
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return { unit: "m", value: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { unit: "h", value: hours };
  return { unit: "d", value: Math.round(hours / 24) };
}

/**
 * Asserts one rendered quota-window line against the live payload window:
 * exact derived label prefix, "% left" within ±1 of 100-usedPercent (the
 * doctor's fetch and this script's fetch are separate read-calls minutes
 * apart), reset suffix within ±1 of the same-unit expectation.
 */
function assertWindowLine(caseName, line, window, limitName, which) {
  const label = expectedWindowLabel(window.windowDurationMins, limitName);
  assert(caseName, line.startsWith(`${label} · `), `${which} line does not start with the payload-derived label "${label} · ": "${line}"`);
  const leftMatch = line.match(/· (\d+(?:\.\d+)?)% left/);
  assert(caseName, leftMatch !== null, `${which} line carries no "% left" segment: "${line}"`);
  const shownLeft = Number(leftMatch[1]);
  const expectedLeft = Math.max(0, 100 - window.usedPercent);
  assert(
    caseName,
    Math.abs(shownLeft - expectedLeft) <= 1,
    `${which} "% left" diverges from the live payload: shown ${shownLeft}, payload-derived ${expectedLeft} (usedPercent=${window.usedPercent})`,
  );
  const expReset = expectedReset(window.resetsAt, Date.now());
  const resetMatch = line.match(/· resets in (\d+)([mhd])$/);
  if (expReset === null) {
    assert(caseName, resetMatch === null && !line.includes("resets"), `${which} line fabricates a reset suffix with no payload resetsAt: "${line}"`);
  } else if (expReset.unit === "now") {
    assert(caseName, line.includes("resets"), `${which} line lacks a reset suffix despite payload resetsAt: "${line}"`);
  } else {
    assert(caseName, resetMatch !== null, `${which} line lacks the "resets in N${expReset.unit}" suffix (payload resetsAt=${window.resetsAt}): "${line}"`);
    assert(
      caseName,
      resetMatch[2] === expReset.unit && Math.abs(Number(resetMatch[1]) - expReset.value) <= 1,
      `${which} reset suffix diverges from payload: shown "${resetMatch[1]}${resetMatch[2]}", expected ~"${expReset.value}${expReset.unit}"`,
    );
  }
}

// ── independent rateLimits payload fetch (own app-server spawn) ──

/**
 * Spawns `codex app-server --stdio` with CODEX_HOME = the LEVER profile home
 * (auth visible through the product-created symlink; bookkeeping writes land
 * in tmp), performs initialize/initialized, calls account/rateLimits/read
 * (read-call — plan §3: not rate-limited, zero generation), tears down
 * bounded (EOF -> group SIGTERM -> group SIGKILL; the W0-R1 probe recipe).
 * Returns ONLY the numeric/plan fields; account/read is never called, no
 * e-mail can enter this process.
 */
async function fetchRateLimitsPayload(codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const child = spawn("codex", ["app-server", "--stdio"], {
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lineBuffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk.toString("utf8");
    for (;;) {
      const nl = lineBuffer.indexOf("\n");
      if (nl < 0) break;
      const line = lineBuffer.slice(0, nl).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(nl + 1);
      if (line === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    }
  });
  child.stderr.on("data", () => {});

  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRpc(new Error(`timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve: resolveRpc, timer });
      write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  };

  const teardownChild = async () => {
    const pid = child.pid;
    const exited = new Promise((r) => child.once("close", () => r(true)));
    const race = (ms) => Promise.race([exited, sleep(ms).then(() => false)]);
    try {
      child.stdin.end();
    } catch {
      // stdin already closed
    }
    if (await race(2000)) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // group already gone
    }
    if (await race(2000)) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // group already gone
    }
    await race(2000);
  };

  try {
    await request("initialize", {
      clientInfo: { name: "anycode-s3-quota-smoke", title: "AnyCode W4-S3 Quota Smoke", version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    write({ method: "initialized" });
    const envelope = await request("account/rateLimits/read");
    if (envelope.error !== undefined) throw new Error(`account/rateLimits/read error: ${JSON.stringify(envelope.error)}`);
    const rl = envelope.result?.rateLimits ?? null;
    if (rl === null) throw new Error("account/rateLimits/read result carries no rateLimits");
    const projectWindow = (w) =>
      w == null
        ? null
        : {
            usedPercent: w.usedPercent,
            windowDurationMins: w.windowDurationMins ?? null,
            resetsAt: w.resetsAt ?? null,
          };
    return {
      primary: projectWindow(rl.primary),
      secondary: projectWindow(rl.secondary),
      credits:
        rl.credits == null
          ? null
          : { hasCredits: rl.credits.hasCredits === true, unlimited: rl.credits.unlimited === true, balance: rl.credits.balance ?? null },
      limitName: envelope.result?.limitName ?? rl.limitName ?? null,
      planType: envelope.result?.planType ?? rl.planType ?? null,
    };
  } finally {
    await teardownChild();
  }
}

// ── case S3-BASELINE ──

function caseBaseline(ctx) {
  for (const p of [OWNER_CODEX_HOME, OWNER_ACCOUNTS_ROOT]) {
    if (!existsSync(p)) fail("S3-BASELINE", `owner home missing: ${p} (external precondition)`);
  }
  const authStat = (() => {
    try {
      return lstatSync(OWNER_AUTH_LINK);
    } catch {
      return null;
    }
  })();
  if (authStat === null) fail("S3-BASELINE", `${OWNER_AUTH_LINK} missing (external precondition — no plus credential to link)`);
  ctx.ownerAuthWasSymlink = authStat.isSymbolicLink();

  const authBefore = ownerAuthIntegrity();
  if (!authBefore.valid) fail("S3-BASELINE", `owner auth.json did not parse as JSON BEFORE the run (bytes=${authBefore.bytes}) — refusing to touch a broken credential`);
  ctx.authBytesBefore = authBefore.bytes;

  ctx.codexHomeBefore = snapshotTree(OWNER_CODEX_HOME);
  ctx.accountsBefore = snapshotTree(OWNER_ACCOUNTS_ROOT);
  ctx.realRootBefore = existsSync(REAL_CODEX_PROFILES_ROOT) ? snapshotTree(REAL_CODEX_PROFILES_ROOT) : null;
  ctx.procBaseline = pgrepSnapshot();

  // The version check runs with a SCRATCH CODEX_HOME: a bare `codex` spawn
  // derives its bookkeeping tmp (tmp/arg0 shim rotation) from CODEX_HOME and
  // would otherwise write into the owner's real ~/.codex — observed live on
  // the first run as tmp/arg0/codex-arg0* churn in the custody diff.
  const scratchCodexHome = mkdtempSync(join(tmpdir(), "anycode-s3-verscratch-"));
  let versionLine;
  try {
    versionLine = execFileSync("codex", ["--version"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: scratchCodexHome } }).trim();
  } finally {
    rmSync(scratchCodexHome, { recursive: true, force: true });
  }
  const m = versionLine.match(/(\d+\.\d+\.\d+)/);
  if (!m) fail("S3-BASELINE", `could not parse codex --version output: ${versionLine}`);
  ctx.codexVersion = m[1];
  pass(
    "S3-BASELINE",
    `owner auth.json ${ctx.ownerAuthWasSymlink ? "is a symlink (account-switch scheme)" : "is a regular file"}, valid JSON (${authBefore.bytes}B); ` +
      `~/.codex snapshot ${ctx.codexHomeBefore.size} entries, ~/.codex-accounts ${ctx.accountsBefore.size} entries; ` +
      `real ~/.anycode/codex ${ctx.realRootBefore === null ? "ABSENT (must stay absent)" : `snapshotted (${ctx.realRootBefore.size})`}; ` +
      `codex ${ctx.codexVersion}; ${ctx.procBaseline.size} pre-existing electron|codex pids`,
  );
}

// ── case S3-LAUNCH ──

async function caseLaunch(ctx) {
  ctx.root = mkdtempSync(join(tmpdir(), "anycode-s3-smoke-"));
  ctx.tmpWorkspace = join(ctx.root, "ws");
  mkdirSync(ctx.tmpWorkspace);
  writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from codex-ctx-quota-live-smoke\n");

  // Ambient sentinel CODEX_HOME: keeps the system pseudo-profile's doctor
  // spawn OFF the owner's real ~/.codex (custody — a doctor run there would
  // write codex bookkeeping into the owner home).
  ctx.sentinelHome = join(ctx.root, "sentinel-codex-home");
  mkdirSync(ctx.sentinelHome, { mode: 0o700 });

  // The lever root. NEITHER profile home is pre-created: the PRODUCT must
  // create both (doctor pre-flight), incl. the s3-live auth.json symlink —
  // DoD-2's "product-created profile" and the live-pin positive arm at once.
  ctx.leverHome = join(ctx.root, "lever");
  mkdirSync(ctx.leverHome, { mode: 0o700 });

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
      // authLink is the ABSOLUTE owner path: under the lever a `~/`-form
      // expands against the LEVER root (`expandAuthLink(raw, home)` — the
      // lever-threaded home, coherent isolation semantics observed live on
      // the first run: "~/.codex/auth.json" resolved to <lever>/.codex/
      // auth.json, a dangling target). The absolute form passes through the
      // single expansion point untouched. s3-bare is a plain managed record.
      profiles: [
        { id: LIVE_ID, label: LIVE_LABEL, createdAt, authLink: OWNER_AUTH_LINK },
        { id: BARE_ID, label: BARE_LABEL, createdAt },
      ],
      // Live-produced finding (run 2 of this lane): the tab-create readiness
      // gate (`manager.canSpawn(engine)` -> `readyFor(cachedActiveProfileId)`)
      // consults the ACTIVE profile only — the draft's picked profile id is
      // never threaded into it (index.ts's own "once the tab layer threads
      // it (lane C)" comment), so a READY picked profile under a signed_out
      // system account is refused not_ready. Aligning activeProfileId with
      // the picked profile is the documented workaround, not the fix.
      activeProfileId: LIVE_ID,
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
    // and Welcome yields; the LIVE turn runs on the codex engine instead.
    ANYCODE_API_KEY: "lm-studio-local",
    ANYCODE_BASE_URL: LM_BASE_URL,
    ANYCODE_MODEL: LM_MODEL,
    CODEX_HOME: ctx.sentinelHome,
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
    if (child.exitCode !== null || child.signalCode !== null) fail("S3-LAUNCH", `dev process exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) fail("S3-LAUNCH", `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;

  await waitForFacade(ctx, "S3-LAUNCH");
  ctx.bootTabId = await discoverTabByWorkspace(ctx, "S3-LAUNCH", ctx.tmpWorkspace);
  pass("S3-LAUNCH", `app up (pid=${info.pid}, port=${info.port}), boot tab ${ctx.bootTabId}, lever=${ctx.leverHome}, sentinel CODEX_HOME=${ctx.sentinelHome}`);
}

// ── case S3-DOCTOR ──

async function caseDoctor(ctx) {
  const caseName = "S3-DOCTOR";
  await openCodexPane(ctx, caseName);

  const wanted = [LIVE_ID, BARE_ID];
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
  const bare = rows.get(BARE_ID)?.lastCheck;
  assert(caseName, bare?.status === "signed_out", `${BARE_ID} expected signed_out (empty managed lever home), got: ${JSON.stringify(bare)}`);
  assert(caseName, bare?.version === ctx.codexVersion, `${BARE_ID} expected doctor version ${ctx.codexVersion} (real spawn, per-profile CODEX_HOME), got: ${JSON.stringify(bare)}`);
  assert(caseName, !JSON.stringify(codexSlice).includes("@"), `persisted codex slice contains a "@" (possible e-mail leak into settings.json)`);

  const live = rows.get(LIVE_ID)?.lastCheck;
  if (live?.status !== "ready") {
    // External precondition (plan §2 SKIP semantics): the owner credential is
    // signed out / expired — the live chain cannot run. Custody gates still do.
    ctx.liveReady = false;
    skip(
      caseName,
      `${LIVE_ID} settled to "${live?.status}" (expected ready) — the owner plus credential behind ~/.codex/auth.json is not usable ` +
        `(signed_out/protух per plan §2 external-precondition list). Every turn-gated case below SKIPs; custody/orphan gates still run. lastCheck=${JSON.stringify(live)}`,
    );
    return;
  }
  ctx.liveReady = true;
  assert(caseName, live?.version === ctx.codexVersion, `${LIVE_ID} expected doctor version ${ctx.codexVersion}, got: ${JSON.stringify(live)}`);
  // The top-level lastCheck slot is "the ACTIVE profile's last check"
  // (codex-ipc.ts) — the seed pins activeProfileId to s3-live.
  assert(
    caseName,
    codexSlice.lastCheck.status === live.status,
    `top-level lastCheck (active=${LIVE_ID}) diverges from the active profile's row: top=${JSON.stringify(codexSlice.lastCheck)} row=${JSON.stringify(live)}`,
  );
  pass(
    caseName,
    `doctor settled: ${LIVE_ID}=ready@${live.version} (authLink credential visible through the product-created symlink), ` +
      `${BARE_ID}=signed_out@${bare.version}, top-level(active=${LIVE_ID})=${codexSlice.lastCheck.status}; no e-mail in settings.json`,
  );
}

// ── case S3-LEVER-POS (bilateral live-pin positive arm + DoD-2 product path) ──

function caseLeverPos(ctx) {
  const caseName = "S3-LEVER-POS";
  for (const id of [LIVE_ID, BARE_ID]) {
    const dir = profileHome(ctx, id);
    assert(caseName, existsSync(dir), `the PRODUCT never created ${dir} under the lever root (positive arm RED)`);
    const st = lstatSync(dir);
    assert(caseName, st.isDirectory(), `${dir} is not a directory`);
    assert(caseName, (st.mode & 0o7777) === 0o700, `${dir} expected mode 0700, got 0${(st.mode & 0o7777).toString(8)}`);
    const realTwin = join(REAL_CODEX_PROFILES_ROOT, `profile-${id}`);
    assert(caseName, !existsSync(realTwin), `product-created profile dir ALSO appeared under the real root: ${realTwin}`);
  }
  // The authLink symlink: product-created, on OUR side only, pointing at the
  // recorded owner target. readlink reads the link TARGET string — never the
  // credential content.
  const linkPath = join(profileHome(ctx, LIVE_ID), "auth.json");
  const linkStat = (() => {
    try {
      return lstatSync(linkPath);
    } catch {
      return null;
    }
  })();
  assert(caseName, linkStat !== null, `the PRODUCT never created the auth.json entry at ${linkPath}`);
  assert(caseName, linkStat.isSymbolicLink(), `${linkPath} is not a symlink (authLink profile must hold a symlink, amended §A1.1)`);
  const target = readlinkSync(linkPath);
  assert(caseName, target === OWNER_AUTH_LINK, `auth.json symlink target mismatch: "${target}" != "${OWNER_AUTH_LINK}"`);
  pass(caseName, `product created profile-${LIVE_ID} + profile-${BARE_ID} under the lever (0700) and the auth.json symlink -> ${OWNER_AUTH_LINK}; no twins under the real root`);
}

// ── case E-S/quota-block (probe a) ──

async function caseQuotaBlock(ctx) {
  const caseName = "E-S/quota-block";
  const state = await apiOk(ctx, caseName, "GET", "/settings/codex");
  assert(caseName, state?.mounted === true, `codex pane not mounted: ${JSON.stringify(state?.mounted)}`);
  assert(caseName, state?.binary !== null, "binary/manifest block missing from the mounted pane");

  const rowByLabel = new Map((state.rows ?? []).map((row) => [row.label, row]));
  const labels = (state.rows ?? []).map((row) => row.label);
  assert(caseName, rowByLabel.has(LIVE_LABEL) && rowByLabel.has(BARE_LABEL), `expected rows "${LIVE_LABEL}"+"${BARE_LABEL}", shown: ${JSON.stringify(labels)}`);

  // Negative arm (S1b-transferred E-S gate): a profile with NO quota report
  // renders NO quota block — hidden, never a fabricated "0%".
  const bareRow = rowByLabel.get(BARE_LABEL);
  assert(caseName, bareRow.statusHeadline === "Sign in required", `${BARE_LABEL} expected "Sign in required" headline, got: ${JSON.stringify(bareRow.statusHeadline)}`);
  assert(
    caseName,
    Array.isArray(bareRow.quotaLines) && bareRow.quotaLines.length === 0,
    `signed_out profile renders a quota block (must be HIDDEN, not "0%"): ${JSON.stringify(bareRow.quotaLines)}`,
  );

  if (!ctx.liveReady) {
    const shot = await settledScreenshot(ctx, "s3-codex-pane");
    assert(caseName, typeof shot === "string", "codex pane screenshot capture failed");
    skip(`${caseName}/ready-arm`, "s3-live never reached ready (see S3-DOCTOR SKIP) — the positive quota-block arm is unproducible on this stand");
    pass(caseName, `negative arm only: ${BARE_LABEL} signed_out row renders ZERO quota lines (block hidden, not "0%")`);
    return;
  }

  // Positive arm: the ready row renders a non-empty quota block, derived from
  // the doctor's live rateLimits fetch. Line-level payload asserts happen in
  // S3-PAYLOAD once the independent payload is in hand.
  const liveRow = rowByLabel.get(LIVE_LABEL);
  assert(caseName, liveRow.statusHeadline === "Ready", `${LIVE_LABEL} expected "Ready" headline, got: ${JSON.stringify(liveRow.statusHeadline)}`);
  assert(caseName, liveRow.emailRendered === true, `${LIVE_LABEL} ready row did not render the account identity (emailRendered=false)`);
  assert(
    caseName,
    Array.isArray(liveRow.quotaLines) && liveRow.quotaLines.length > 0,
    `ready profile renders NO quota block (rateLimits were fetched on a ready doctor pass — expected rendered lines): ${JSON.stringify(liveRow.quotaLines)}`,
  );
  ctx.paneQuotaLines = liveRow.quotaLines;

  const shot = await settledScreenshot(ctx, "s3-codex-pane");
  assert(caseName, typeof shot === "string", "codex pane screenshot capture failed");
  pass(
    caseName,
    `ready row "${LIVE_LABEL}" renders ${liveRow.quotaLines.length} quota line(s) [${liveRow.quotaLines.join(" | ")}]; ` +
      `signed_out row "${BARE_LABEL}" renders ZERO (block hidden, not "0%")`,
  );
}

// ── case S3-PAYLOAD (quota lines vs live account/rateLimits/read) ──

async function casePayload(ctx) {
  const caseName = "S3-PAYLOAD";
  if (!ctx.liveReady) {
    skip(caseName, "s3-live never reached ready — no credential to fetch a live payload with (see S3-DOCTOR SKIP)");
    return;
  }
  let payload;
  try {
    payload = await fetchRateLimitsPayload(profileHome(ctx, LIVE_ID));
  } catch (err) {
    fail(caseName, `independent account/rateLimits/read fetch failed: ${err?.message ?? err}`);
  }
  ctx.payload = payload;
  console.log(
    `           live payload: primary=${JSON.stringify(payload.primary)} secondary=${JSON.stringify(payload.secondary)} ` +
      `credits=${JSON.stringify(payload.credits)} limitName=${JSON.stringify(payload.limitName)} planType=${JSON.stringify(payload.planType)}`,
  );

  const lines = ctx.paneQuotaLines ?? [];
  const windows = [
    { window: payload.primary, which: "primary" },
    { window: payload.secondary, which: "secondary" },
  ].filter((entry) => entry.window !== null);
  const creditsExpected = payload.credits !== null && (payload.credits.unlimited || payload.credits.hasCredits) ? 1 : 0;
  const expectedCount = windows.length + creditsExpected;

  // Count == populated payload windows (+credits): a hardcoded "5h"/"weekly"
  // PAIR against this single-window plus account renders 2 window lines and
  // fails here; a fabricated "0%" placeholder for the null window likewise.
  assert(
    caseName,
    lines.length === expectedCount,
    `rendered quota line count ${lines.length} != payload-derived ${expectedCount} (windows=${windows.length}, credits=${creditsExpected}); lines=${JSON.stringify(lines)}`,
  );
  windows.forEach((entry, i) => assertWindowLine(caseName, lines[i], entry.window, payload.limitName, entry.which));
  if (payload.secondary === null) {
    const has5h = lines.some((line) => line.startsWith("5h · "));
    assert(caseName, !has5h, `a "5h" window line is rendered while the live payload has NO 300-min window — hardcoded pair (RED): ${JSON.stringify(lines)}`);
  }
  if (creditsExpected === 0) {
    assert(caseName, !lines.some((line) => line.startsWith("Credits")), `credits line rendered while payload says hasCredits=false: ${JSON.stringify(lines)}`);
  }
  pass(
    caseName,
    `pane quota block == live payload: ${windows.length} window line(s) with derived label(s) [${windows
      .map((entry) => expectedWindowLabel(entry.window.windowDurationMins, payload.limitName))
      .join(", ")}], % left and reset within tolerance, no fabricated lines`,
  );
}

// ── case F-S/chip-pick (probe b — the S1b contra-form: enabled ready row) ──

async function caseChipPick(ctx) {
  const caseName = "F-S/chip-pick";
  if (!ctx.liveReady) {
    skip(caseName, "s3-live never reached ready — no enabled row to pick (see S3-DOCTOR SKIP)");
    return;
  }
  await apiOk(ctx, caseName, "POST", "/settings/close", {});
  const openResp = await apiOk(ctx, caseName, "POST", "/start-screen/open", {});
  assert(caseName, openResp?.ok === true, `start-screen open refused: ${JSON.stringify(openResp)}`);
  const engineResp = await apiOk(ctx, caseName, "POST", "/start-screen/engine", { engineId: "codex" });
  assert(caseName, engineResp?.ok === true, `setDraftEngine(codex) refused: ${JSON.stringify(engineResp)}`);

  const chipDeadline = Date.now() + 15_000;
  let chip = null;
  for (;;) {
    chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
    if (chip?.chipVisible === true) break;
    if (Date.now() >= chipDeadline) fail(caseName, `chip never became visible within 15s: ${JSON.stringify(chip)}`);
    await sleep(300);
  }

  const openMenu = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { open: true });
  assert(caseName, openMenu?.ok === true, `popover open refused: ${JSON.stringify(openMenu)}`);
  chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
  assert(caseName, chip.menuOpen === true, `popover did not report open: ${JSON.stringify(chip)}`);
  assert(caseName, chip.addAccountLast === true, `"Add account…" is not the LAST popover row`);

  const labels = chip.options.map((option) => option.label);
  assert(caseName, JSON.stringify(labels) === JSON.stringify([LIVE_LABEL, BARE_LABEL]), `options != this run's registry: ${JSON.stringify(labels)}`);
  const liveOption = chip.options[0];
  const bareOption = chip.options[1];
  // The S1b honesty-note contra-form: a NON-signed_out row is enabled.
  assert(caseName, liveOption.disabled === false, `ready profile "${LIVE_LABEL}" is rendered DISABLED (ready rows must be pickable): ${JSON.stringify(liveOption)}`);
  assert(caseName, bareOption.disabled === true, `signed_out profile "${BARE_LABEL}" is NOT rendered disabled: ${JSON.stringify(bareOption)}`);

  const shot = await settledScreenshot(ctx, "s3-chip-dropdown");
  assert(caseName, typeof shot === "string", "chip dropdown screenshot capture failed");

  const pickResp = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { pick: 0 });
  assert(caseName, pickResp?.ok === true, `pick of the ready row refused: ${JSON.stringify(pickResp)}`);
  const pickDeadline = Date.now() + 10_000;
  for (;;) {
    chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
    if (chip.draftCodexProfileId === LIVE_ID) break;
    if (Date.now() >= pickDeadline) fail(caseName, `draft pick never landed on ${LIVE_ID}: ${JSON.stringify(chip.draftCodexProfileId)}`);
    await sleep(250);
  }
  assert(caseName, chip.label === LIVE_LABEL, `chip label did not follow the pick: ${JSON.stringify(chip.label)}`);
  pass(caseName, `ready row enabled+picked (draftCodexProfileId=${LIVE_ID}), signed_out row disabled, "Add account…" last`);
}

// ── case S3-TURN (C-S: ONE live turn, hard cap 1+1 retry) ──

function transcriptPong(state) {
  const blocks = state?.transcript ?? [];
  return blocks.some((block) => block.kind === "assistant_text" && typeof block.text === "string" && block.text.toLowerCase().includes("pong"));
}

function transcriptError(state) {
  const blocks = state?.transcript ?? [];
  return blocks.find((block) => block.kind === "error") ?? null;
}

async function waitForPong(ctx, caseName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await apiOk(ctx, caseName, "GET", `/state/${ctx.liveTabId}?tail=40`);
    const state = resp?.snapshot?.states?.[ctx.liveTabId];
    if (state !== undefined) {
      if (transcriptPong(state)) return { outcome: "pong", state };
      const errBlock = transcriptError(state);
      if (errBlock !== null && state.turn?.status === "idle") return { outcome: "error", state, errBlock };
    }
    if (Date.now() >= deadline) return { outcome: "timeout", state };
    await sleep(1000);
  }
}

async function caseTurn(ctx) {
  const caseName = "S3-TURN";
  if (!ctx.liveReady) {
    skip(caseName, "s3-live never reached ready — no live turn is possible (see S3-DOCTOR SKIP)");
    return;
  }
  const wsResp = await apiOk(ctx, caseName, "POST", "/start-screen/workspace", { workspace: ctx.tmpWorkspace });
  assert(caseName, wsResp?.ok === true, `draft workspace set refused: ${JSON.stringify(wsResp)}`);
  const promptResp = await apiOk(ctx, caseName, "POST", "/start-screen/prompt", { text: "Reply exactly: pong" });
  assert(caseName, promptResp?.ok === true, `draft prompt set refused: ${JSON.stringify(promptResp)}`);

  assert(caseName, ctx.turnsSpent < LIVE_TURN_CAP, `live-turn cap ${LIVE_TURN_CAP} already exhausted before submit — refusing to spend more`);
  const submit = await apiOk(ctx, caseName, "POST", "/start-screen/submit", {});
  assert(caseName, submit?.ok === true, `codex-draft submit refused with a READY profile (canSpawn gate broken the other way): ${JSON.stringify(submit)}`);
  ctx.liveTabId = submit.tabId;
  ctx.turnsSpent += 1;
  console.log(`           live turn 1/${LIVE_TURN_CAP} dispatched (tab ${ctx.liveTabId})`);

  const readyWait = await apiOk(ctx, caseName, "POST", "/wait", { tabId: ctx.liveTabId, until: { connection: "ready" }, timeoutMs: 120_000 });
  assert(caseName, readyWait?.matched === true, `codex session never reached connection=ready: ${JSON.stringify(readyWait?.state ?? readyWait)}`);

  let result = await waitForPong(ctx, caseName, TURN_TIMEOUT_MS);
  if (result.outcome !== "pong") {
    if (ctx.turnsSpent >= LIVE_TURN_CAP) {
      fail(caseName, `first turn ${result.outcome} (${JSON.stringify(result.errBlock?.error ?? null)}) and the live-turn cap is exhausted — stopping per plan §3`);
    }
    console.warn(`[${caseName}] first turn ${result.outcome} — spending the ONE sanctioned retry`);
    const retryPrompt = await apiOk(ctx, caseName, "POST", `/tabs/${ctx.liveTabId}/prompt`, { text: "Reply exactly: pong" });
    assert(caseName, retryPrompt?.ok === true, `retry prompt refused: ${JSON.stringify(retryPrompt)}`);
    ctx.turnsSpent += 1;
    console.log(`           live turn 2/${LIVE_TURN_CAP} dispatched (retry)`);
    result = await waitForPong(ctx, caseName, RETRY_TURN_TIMEOUT_MS);
    if (result.outcome !== "pong") {
      ctx.liveTurnDone = false;
      fail(caseName, `retry turn ${result.outcome} — cap exhausted (2/${LIVE_TURN_CAP}), no further turns will be spent; last error=${JSON.stringify(result.errBlock?.error ?? null)}`);
    }
  }
  ctx.liveTurnDone = true;

  const engineInfo = result.state?.engine ?? null;
  assert(caseName, engineInfo?.id === "codex", `live tab snapshot engine != codex: ${JSON.stringify(engineInfo)}`);
  const shot = await settledScreenshot(ctx, "s3-transcript-pong");
  assert(caseName, typeof shot === "string", "transcript screenshot capture failed");
  pass(caseName, `assistant replied (contains "pong") on turn ${ctx.turnsSpent}/${LIVE_TURN_CAP}; engine=${JSON.stringify(engineInfo)}`);
}

// ── case S3-CTX (C-S/G-S: the "N% ctx" chip + ring/popover PNG) ──

async function caseCtx(ctx) {
  const caseName = "S3-CTX";
  if (!ctx.liveTurnDone) {
    skip(caseName, "no completed live turn (see S3-TURN) — the ctx meter/popover cannot be exercised");
    return;
  }
  // The meter mounts on the first context_usage push; poll briefly.
  const deadline = Date.now() + 30_000;
  let probe = null;
  for (;;) {
    probe = await apiOk(ctx, caseName, "GET", `/tabs/${ctx.liveTabId}/ctx-popover`);
    if (probe?.ok === true && typeof probe.percentText === "string") break;
    if (Date.now() >= deadline) {
      fail(caseName, `"N% ctx" chip never rendered after the live turn (C-bug-1 regression — C-S gate RED): ${JSON.stringify(probe)}`);
    }
    await sleep(500);
  }
  assert(caseName, /^\d+% ctx$/.test(probe.percentText), `chip text is not "N% ctx": ${JSON.stringify(probe.percentText)}`);

  const openResp = await apiOk(ctx, caseName, "POST", `/tabs/${ctx.liveTabId}/ctx-popover/open`, { open: true });
  assert(caseName, openResp?.ok === true, `ctx popover open refused: ${JSON.stringify(openResp)}`);
  probe = await apiOk(ctx, caseName, "GET", `/tabs/${ctx.liveTabId}/ctx-popover`);
  assert(caseName, probe?.open === true, `popover did not report open: ${JSON.stringify(probe)}`);
  assert(caseName, probe.headline !== null, "popover headline missing");
  assert(
    caseName,
    probe.sessionTokens !== null && probe.sessionTokens.total > 0 && probe.sessionTokens.input > 0 && probe.sessionTokens.output > 0,
    `session tokens line absent or zero after a live turn: ${JSON.stringify(probe.sessionTokens)}`,
  );
  ctx.ctxReading = { percentText: probe.percentText, headline: probe.headline, sessionTokens: probe.sessionTokens };

  // The popover's quota LINES have no probe field (infra gap — reported as a
  // finding): the ring + quota-window labels are PNG evidence here; their
  // payload-derivation machine assert rides probe (a) in S3-PAYLOAD.
  const shot = await settledScreenshot(ctx, "s3-ctx-popover");
  assert(caseName, typeof shot === "string", "ctx popover screenshot capture failed");
  await apiOk(ctx, caseName, "POST", `/tabs/${ctx.liveTabId}/ctx-popover/open`, { open: false });
  pass(
    caseName,
    `"${probe.percentText}" visible (C-bug-1 closed); popover headline "${ctx.ctxReading.headline}"; ` +
      `sessionTokens=${JSON.stringify(ctx.ctxReading.sessionTokens)}; ring+quota lines on PNG`,
  );
}

// ── case S3-READONLY-AFTER-START (S1b transfer, ruling §1d) ──

async function caseReadOnlyAfterStart(ctx) {
  const caseName = "F-S/read-only-after-start";
  if (!ctx.liveTurnDone) {
    skip(caseName, "no started managed session (see S3-TURN) — the after-start form is unproducible");
    return;
  }
  const chip = await apiOk(ctx, caseName, "GET", "/start-screen/codex-profile");
  assert(
    caseName,
    chip?.chipVisible === false && chip?.draftActive === false && chip?.draftCodexProfileId === null,
    `after the managed session started the chip must be unmounted (read-only): ${JSON.stringify({ chipVisible: chip?.chipVisible, draftActive: chip?.draftActive, draftCodexProfileId: chip?.draftCodexProfileId })}`,
  );
  // The refusal FORM (DoD-5): a pick of another profile is refused, not applied.
  const pickResp = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { pick: 1 });
  assert(caseName, pickResp?.ok === false, `pick unexpectedly SUCCEEDED after session start (read-only broken): ${JSON.stringify(pickResp)}`);
  assert(caseName, pickResp?.reason === "not_present", `pick refusal reason expected "not_present", got: ${JSON.stringify(pickResp?.reason)}`);
  const openResp = await apiOk(ctx, caseName, "POST", "/start-screen/codex-profile", { open: true });
  assert(caseName, openResp?.ok === false && openResp?.reason === "not_present", `popover open after start expected not_present refusal: ${JSON.stringify(openResp)}`);
  pass(caseName, `chip unmounted after start (chipVisible=false, draftActive=false); pick -> {ok:false, reason:"not_present"} — the asserted refusal form`);
}

// ── case S3-SESSION-FILES (DoD-2 lever rollouts + DoD-7 codexProfileId row) ──

function findRollouts(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl") && st.size > 0) found.push({ path: p, size: st.size });
    }
  };
  walk(dir);
  return found;
}

async function caseSessionFiles(ctx) {
  const caseName = "S3-SESSION-FILES";
  if (!ctx.liveTurnDone) {
    skip(caseName, "no live session ran (see S3-TURN) — no session files to assert");
    return;
  }
  // DoD-2 explicit assert: the REAL codex child wrote its session/rollout
  // under the LEVER profile home — the live proof of the A1 seam AND the
  // host-plane lever forward (F0b) at once.
  const sessionsDir = join(profileHome(ctx, LIVE_ID), "sessions");
  const rollouts = findRollouts(sessionsDir);
  assert(caseName, rollouts.length >= 1, `no rollout-*.jsonl appeared under the LEVER profile home ${sessionsDir} — the live session did not write into the lever (host-plane forward RED)`);
  for (const r of rollouts) console.log(`           lever rollout: ${r.path} (${r.size}B)`);

  // The real ~/.codex/sessions must NOT have received this session — checked
  // globally by the custody diff after teardown; here the lever side is the
  // positive assert.

  // DoD-7: the persisted session ROW pins the profile id (Q1.3 re-resolve
  // input) — read straight off the isolated sqlite DB, read-only.
  let rows = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const out = execFileSync("sqlite3", ["-readonly", ctx.profileDbPath, "SELECT id, codex_profile_id, workspace FROM sessions;"], { encoding: "utf8" });
      rows = out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split("|"));
      break;
    } catch (err) {
      if (attempt === 2) fail(caseName, `sqlite read of ${ctx.profileDbPath} failed: ${err?.message ?? err}`);
      await sleep(1000);
    }
  }
  const pinned = rows.filter((cols) => cols[1] === LIVE_ID);
  assert(caseName, pinned.length === 1, `expected exactly ONE session row pinned to ${LIVE_ID}, got ${pinned.length} of ${rows.length} rows: ${JSON.stringify(rows)}`);
  assert(caseName, canonPath(pinned[0][2]) === canonPath(ctx.tmpWorkspace), `pinned session row workspace mismatch: ${JSON.stringify(pinned[0])}`);
  pass(
    caseName,
    `${rollouts.length} rollout file(s) written by the REAL codex child UNDER THE LEVER HOME (${sessionsDir}); ` +
      `sqlite session row ${pinned[0][0]} carries codex_profile_id=${LIVE_ID}`,
  );
}

// ── post-teardown gates ──

function caseRealRootPin(ctx) {
  const caseName = "S3-REAL-HOME-NEG";
  const afterExists = existsSync(REAL_CODEX_PROFILES_ROOT);
  if (ctx.realRootBefore === null) {
    if (afterExists) {
      const after = snapshotTree(REAL_CODEX_PROFILES_ROOT);
      fail(caseName, `real ~/.anycode/codex did not exist before the run but EXISTS after (${after.size} entries) — a write leaked past the lever:\n  ${[...after.keys()].slice(0, 20).join("\n  ")}`);
    }
    pass(caseName, "real ~/.anycode/codex ABSENT before AND after the run — zero writes into the owner's real profiles root");
    return;
  }
  if (!afterExists) fail(caseName, "real ~/.anycode/codex existed before the run but is GONE after");
  const deltas = diffSnapshots(ctx.realRootBefore, snapshotTree(REAL_CODEX_PROFILES_ROOT));
  if (deltas.length > 0) fail(caseName, `real ~/.anycode/codex changed during the run:\n  ${deltas.slice(0, 20).join("\n  ")}`);
  pass(caseName, `real ~/.anycode/codex byte-stable (${ctx.realRootBefore.size} entries)`);
}

function caseOwnerCustody(ctx) {
  const caseName = "S3-OWNER-CUSTODY";
  const codexAfter = snapshotTree(OWNER_CODEX_HOME);
  const accountsAfter = snapshotTree(OWNER_ACCOUNTS_ROOT);
  const deltas = [
    ...diffSnapshots(ctx.codexHomeBefore, codexAfter).map((d) => ({ tree: "~/.codex", delta: d })),
    ...diffSnapshots(ctx.accountsBefore, accountsAfter).map((d) => ({ tree: "~/.codex-accounts", delta: d })),
  ];
  if (deltas.length === 0) {
    pass(caseName, `owner homes byte-stable: ${codexAfter.size} entries under ~/.codex, ${accountsAfter.size} under ~/.codex-accounts — zero deltas (no token refresh occurred)`);
    return;
  }

  // The ONE sanctioned write: codex's own token refresh of the owner
  // credential through the authLink symlink chain (~/.codex/auth.json is
  // itself a symlink to ~/.codex-accounts/personal/auth.json on this stand) —
  // recognized as a CHANGED entry at either path that still parses as JSON.
  const authPaths = new Set([OWNER_AUTH_LINK, canonPath(OWNER_AUTH_LINK)]);
  // Volatile bookkeeping a live FOREIGN codex (owner's codex-cli session or
  // Codex.app, both in the pre-launch baseline) mutates on its own schedule.
  // The credential/config/session surface is deliberately NOT here.
  const volatilePattern = /^(logs_\d+\.sqlite(-wal|-shm)?|goals_\d+\.sqlite(-wal|-shm)?|models_cache\.json|history\.jsonl|version_check\.json)$/;
  const foreignAlive = [...ctx.procBaseline.entries()].some(([pid, cmd]) => foreignCodexLineage(cmd) && isPidAlive(pid));

  const unattributed = [];
  const attributed = [];
  for (const { tree, delta } of deltas) {
    const m = delta.match(/^CHANGED (\/[^:]+):/);
    const changedPath = m?.[1];
    if (changedPath !== undefined && authPaths.has(changedPath)) {
      const integrity = ownerAuthIntegrity();
      if (integrity.valid) {
        attributed.push(`${tree} ${delta.split(":")[0]} [sanctioned codex token refresh via authLink; auth.json still valid JSON, ${integrity.bytes}B]`);
        continue;
      }
      unattributed.push(`${tree} ${delta} [auth.json NO LONGER VALID JSON — corrupted]`);
      continue;
    }
    // A dir-kind CHANGED entry is an mtime-only reading: any real content
    // change inside is caught by the child's OWN ADDED/REMOVED/CHANGED entry
    // in the same recursive diff, so the dir record alone is the footprint of
    // a child rename/atomic-write (e.g. the auth.json refresh temp file) and
    // is judged by its children, not by itself.
    const isDirMtime = delta.includes(': "dir ') && delta.includes('-> "dir ');
    const holders = changedPath ? lsofHolders(changedPath).filter((pid) => ctx.procBaseline.has(pid)) : [];
    const baseName = changedPath?.split("/").pop() ?? "";
    if (isDirMtime) attributed.push(`${tree} ${delta.split(":")[0]} [directory mtime only — children judged individually]`);
    else if (holders.length > 0) attributed.push(`${tree} ${delta} [held open by pre-existing pid(s) ${holders.join(",")}]`);
    else if (changedPath !== undefined && volatilePattern.test(baseName) && foreignAlive) attributed.push(`${tree} ${delta} [volatile codex bookkeeping; pre-existing foreign codex lineage alive]`);
    else unattributed.push(`${tree} ${delta}`);
  }
  if (unattributed.length > 0) {
    fail(caseName, `owner homes changed during the run (${unattributed.length} unattributed delta(s)):\n  ${unattributed.slice(0, 25).join("\n  ")}`);
  }
  pass(caseName, `owner homes untouched by this run beyond sanctioned/attributed writes:\n  ${attributed.join("\n  ")}`);
}

function caseAuthValid(ctx) {
  const caseName = "S3-AUTH-VALID";
  const integrity = ownerAuthIntegrity();
  assert(caseName, integrity.present, `owner auth.json is GONE after the run`);
  assert(caseName, integrity.valid, `owner auth.json no longer parses as JSON after the run (${integrity.bytes}B) — CORRUPTED`);
  const st = lstatSync(OWNER_AUTH_LINK);
  assert(
    caseName,
    st.isSymbolicLink() === ctx.ownerAuthWasSymlink,
    `owner ~/.codex/auth.json changed FORM (symlink<->file) during the run — something replaced the owner-side entry`,
  );
  const changed = integrity.bytes !== ctx.authBytesBefore;
  pass(caseName, `owner auth.json valid JSON post-run (${integrity.bytes}B${changed ? `, size changed from ${ctx.authBytesBefore}B — token refresh` : ", byte-size unchanged"}); owner-side entry form intact`);
}

/**
 * A pgrep -fl match is only OUR app's lineage when the EXECUTABLE (first argv
 * token) is an electron/codex binary, or the command references this run's
 * tmp root / this worktree — `pgrep -f` also matches foreign processes whose
 * argv merely CONTAINS the substring (PATH strings, Codex.app helpers).
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
      console.warn(`[codex-ctx-quota-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[codex-ctx-quota-live-smoke] still alive after SIGTERM — SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.root === "string" && existsSync(ctx.root)) {
    if (FLAGS.keep) console.log(`[codex-ctx-quota-live-smoke] --keep set, tmp root preserved at: ${ctx.root}`);
    else {
      try {
        rmSync(ctx.root, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-ctx-quota-live-smoke] failed to remove tmp root ${ctx.root}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedCase === null ? "ALL CASES SETTLED" : `STOPPED at ${failedCase}`;
  const summary = verdicts.map((v) => `${v.caseName}=${v.verdict}`).join(" · ");
  console.log(`\n[codex-ctx-quota-live-smoke] live turns spent: ${ctx.turnsSpent}/${LIVE_TURN_CAP}`);
  console.log(`[codex-ctx-quota-live-smoke] ${summary} — ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[codex-ctx-quota-live-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    teardownPromise: null,
    child: null,
    root: null,
    liveReady: false,
    liveTurnDone: false,
    turnsSpent: 0,
    paneQuotaLines: null,
  };
  installSignalTeardown(ctx);

  let failedCase = null;
  const capture = (err) => {
    if (failedCase === null) failedCase = err instanceof SmokeFailure ? err.caseName : "unknown";
    if (!(err instanceof SmokeFailure)) console.error(`[codex-ctx-quota-live-smoke] unexpected error: ${err?.stack ?? err}`);
  };

  try {
    caseBaseline(ctx);
    await caseLaunch(ctx);
    await caseDoctor(ctx);
    caseLeverPos(ctx);
    await caseQuotaBlock(ctx);
    await casePayload(ctx);
    await caseChipPick(ctx);
    await caseTurn(ctx);
    await caseCtx(ctx);
    await caseReadOnlyAfterStart(ctx);
    await caseSessionFiles(ctx);
  } catch (err) {
    capture(err);
  }

  await teardown(ctx, failedCase);

  // Custody/orphan gates run AFTER teardown by design — they judge what the
  // whole run left behind. Each gets its own try so one FAIL never masks
  // another verdict.
  try {
    caseRealRootPin(ctx);
  } catch (err) {
    capture(err);
  }
  try {
    caseOwnerCustody(ctx);
  } catch (err) {
    capture(err);
  }
  try {
    caseAuthValid(ctx);
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
  console.error(`[codex-ctx-quota-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

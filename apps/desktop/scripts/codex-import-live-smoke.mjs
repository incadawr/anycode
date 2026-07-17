/**
 * Live GUI smoke for codex-profiles W4-S4 (w4-plan-fable-iter8.md row W4-S4 +
 * w4-remainder-ruling-fable-iter9.md §1d row 7: H-S import + D-S turn on
 * another model; pin F1 excluded — closed in S1b). Runs on BASE2=`b96325d`
 * with production byte-frozen: every defect found goes to the findings file,
 * never fixed here.
 *
 * Material: copies of REAL rollout files from the owner's `~/.codex/sessions/
 * 2026/**` (source strictly read-only — proven by a recursive lstat snapshot
 * diff), planted into a disposable lever home
 * (`ANYCODE_CODEX_PROFILES_HOME=<mktemp>`) under one plain managed profile.
 * Two sources are pinned deliberately:
 *  - SOURCE_A: an owner codex-tui session (cli 0.125.0) whose session_meta
 *    line fits the 16 KiB head-peek -> the list row renders its cwd; carries
 *    ONE `function_call`/`exec_command` pair (the function_call mapping arm).
 *  - SOURCE_B: an anycode-originated dogfood session (cli 0.144.3) whose
 *    session_meta line alone exceeds 16 KiB -> head-peek finds nothing (an
 *    honest real-material observation, see findings); carries THREE
 *    `custom_tool_call`/`exec` pairs (the custom mapping arm) — the import +
 *    live-turn target.
 * Expected row redactions / honest-loss lines / pair counts are RE-DERIVED at
 * runtime from the copies by an independent re-implementation of the
 * importer's counting rules (never hardcoded, never read via the app).
 *
 * Case map (first FAIL tears down, exit 1):
 *  - S4-BASELINE   owner-home snapshots (recursive lstat, content never read),
 *                  pgrep baseline, LM Studio precondition (D-S ladder rung 2:
 *                  no settings.local.json with a live key exists in this
 *                  worktree -> LM Studio; one `lms server start` attempt on
 *                  failure, then SKIP for the turn only).
 *  - S4-SOURCE     copy rollouts into the lever profile home; derive expected
 *                  stats/rows from the copies.
 *  - S4-LAUNCH     isolated app boot (mktemp user-data/db/settings/secrets,
 *                  sentinel CODEX_HOME, lever root). Provider readiness comes
 *                  PURELY from a hand-edited `custom:<id>` connection pointing
 *                  at LM Studio (S5 posture: env API creds deleted).
 *  - H-S/rows      import dialog rows == the planted set; per-row custody
 *                  redaction (cwdRendered / preview{rendered,length,sha256_12})
 *                  == the replicated 16 KiB head-peek expectation.
 *  - H-S/fxh-pin   active connection switched (real provider-pane tile click)
 *                  to a model-less connection over an empty-catalog custom
 *                  provider -> preview loaded, modelValue=="" -> Import
 *                  DISABLED (FXH honest gate) and `import/apply` refused
 *                  fail-closed (`import_disabled`) with a VALID profile+rollout
 *                  (the discriminant against profile_not_found: the sole
 *                  blocker is the empty model, proven by the phase-2 flip).
 *  - H-S/import    active connection switched back (tile click) -> reopen ->
 *                  preview A then B (identity-gated settle across a row
 *                  switch) -> honest-loss lines == independent recount ->
 *                  model EXPLICITLY set to the turn model (differs from the
 *                  connection default — deliberate) -> Import & open -> dialog
 *                  closed, tab opened.
 *  - S4-TAB-PAIRS  the imported tab renders the hydrated history: tool_call
 *                  block count == the recount's mapped-exec count, EVERY
 *                  tool_call block paired (status!=="proposed",
 *                  modelText!==null); user_text count == recount; core engine
 *                  (no `engine` key on the snapshot).
 *  - S4-MODEL-IDENTITY  the sqlite session row carries the PICKED model; the
 *                  live tab's model (model-pill) is read and compared — a
 *                  mismatch is recorded as a finding (production byte-frozen)
 *                  and the lane pivots via the model-pill's own real pick
 *                  driver so D-S still runs on the mandated model.
 *  - D-S/turn      one prompt through the imported tab on `openai/gpt-oss-20b`
 *                  (zero owner quota — LM Studio); permission watchdog denies
 *                  anything that pops; asserts the reply rendered.
 *  - S4-REAL-HOME-NEG  real `~/.anycode/codex` absent before => absent after
 *                  (or byte-stable diff), after teardown.
 *  - S4-CUSTODY    `~/.codex/**` (recursive) + `~/.codex-accounts/**`
 *                  (recursive) byte-stable; CHANGED entries attributable to
 *                  pre-existing foreign writers (lsof holders / volatile codex
 *                  bookkeeping) are attributed, ADDED/REMOVED always fail.
 *  - ORPHANS       0 new electron|codex pids after teardown + settle.
 *
 * Usage:   node apps/desktop/scripts/codex-import-live-smoke.mjs [--keep] [--port <n>]
 * Evidence: working-docs/references/w4-live-evidence/s4-*.{png,log} (untracked).
 */

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "references", "w4-live-evidence");

const LAUNCH_TIMEOUT_MS = 180_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const ORPHAN_SETTLE_MS = 5_000;
const TURN_TIMEOUT_MS = 240_000; // LM Studio may JIT-load the model on the first request
const RETRY_TURN_TIMEOUT_MS = 180_000;

const OWNER_CODEX_HOME = join(homedir(), ".codex");
const OWNER_ACCOUNTS_ROOT = join(homedir(), ".codex-accounts");
const OWNER_SESSIONS_ROOT = join(OWNER_CODEX_HOME, "sessions");
const REAL_CODEX_PROFILES_ROOT = join(homedir(), ".anycode", "codex");

// ── D-S model ladder (plan W4-S4): rung 1 (live key in the worktree's
// settings.local.json) is EMPTY — no such file exists (checked by the lane);
// rung 2: LM Studio custom provider, mandated turn model. ──
const LM_BASE_URL = "http://127.0.0.1:1234/v1";
const TURN_MODEL = "openai/gpt-oss-20b";
// The connection's DEFAULT model deliberately differs from TURN_MODEL so the
// dialog's explicit model pick is discriminable from the default resolution.
const DEFAULT_MODEL = "google/gemma-4-12b-qat";
const CURATED_MODELS = [DEFAULT_MODEL, TURN_MODEL];

const CUSTOM_READY_ID = "custom:lmstudio";
const CUSTOM_EMPTY_ID = "custom:empty-catalog";
const CONN_READY = "conn-lmstudio";
const CONN_EMPTY = "conn-empty";

const PROFILE_ID = "s4-import";
const PROFILE_LABEL = "S4 Import";

// Pinned REAL source rollouts (relative to ~/.codex/sessions — the exact
// on-disk `YYYY/MM/DD/rollout-*.jsonl` shape the profile home reuses).
const SOURCE_A = "2026/04/25/rollout-2026-04-25T00-18-34-019dc15b-d4ce-7f72-8797-201949ffaadd.jsonl";
const SOURCE_B = "2026/07/14/rollout-2026-07-14T07-04-39-019f5ecc-5d7e-75c0-9b33-532fe5f143fc.jsonl";
const IMPORT_TARGET = SOURCE_B;

// The imported session's workspace is the ROLLOUT's original cwd (main
// persists `report.meta.cwd`). Recreating a vanished cwd is only ever allowed
// under these disposable roots — anything else refuses the run rather than
// touching a real directory.
const RECREATABLE_CWD_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

const HEAD_PEEK_BYTES = 16 * 1024;
const FIRST_MESSAGE_PREVIEW_CAP = 96;

const TURN_PROMPT = "Do not use any tools. Reply with exactly: pong";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") flags.keep = true;
    else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else console.warn(`[codex-import-live-smoke] ignoring unrecognized argument: ${arg}`);
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

// ── owner-home custody snapshots (lstat only — content is NEVER read) ──

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
      resp = await api(ctx, "GET", "/state?tail=0");
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
      console.warn(`[codex-import-live-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[codex-import-live-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

async function settledScreenshot(ctx, name) {
  await sleep(500);
  return saveScreenshot(ctx, name);
}

// ── independent rollout recount (mirrors main/codex-rollout.ts's counting
// rules — the assert oracle is derived OUTSIDE the app, from the copy) ──

const KNOWN_RECORD_TYPES = new Set(["session_meta", "turn_context", "response_item", "event_msg", "world_state"]);
const KNOWN_PART_TYPES = new Set(["input_text", "output_text", "input_image"]);
const BASH_MAPPED_FUNCTION_NAMES = new Set(["exec_command"]);
const BASH_MAPPED_CUSTOM_NAMES = new Set(["exec"]);
const SELF_CONTAINED_COLLAPSE_TYPES = new Set(["web_search_call", "image_generation_call", "agent_message"]);
const OUTPUT_RECORD_TYPES = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

function analyzeRolloutFile(path) {
  const content = readFileSync(path, "utf8");
  const stats = { reasoning: 0, collapsed: 0, images: 0, malformed: 0, unknownRecords: 0, unknownItems: 0, unknownParts: 0, developer: 0 };
  let cwd;
  let users = 0;
  let assistants = 0;
  let execCalls = 0;
  let execPaired = 0;
  const bashPendingIds = new Set();

  const countParts = (contentField, countImages) => {
    if (!Array.isArray(contentField)) return;
    for (const raw of contentField) {
      const type = raw && typeof raw === "object" ? raw.type : undefined;
      if (!KNOWN_PART_TYPES.has(type)) {
        stats.unknownParts += 1;
        continue;
      }
      if (countImages && type === "input_image") stats.images += 1;
    }
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.malformed += 1;
      continue;
    }
    if (typeof record !== "object" || record === null) {
      stats.malformed += 1;
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (!KNOWN_RECORD_TYPES.has(type)) {
      stats.unknownRecords += 1;
      continue;
    }
    if (type === "event_msg" || type === "world_state") continue;
    const p = record.payload && typeof record.payload === "object" ? record.payload : {};
    if (type === "session_meta") {
      if (cwd === undefined && typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (type === "turn_context") continue;
    // response_item
    const pt = typeof p.type === "string" ? p.type : "";
    if (pt === "message") {
      if (p.role === "developer") {
        stats.developer += 1;
        continue;
      }
      if (p.role === "user") {
        users += 1;
        countParts(p.content, true);
        continue;
      }
      if (p.role === "assistant") {
        assistants += 1;
        countParts(p.content, true);
        continue;
      }
      stats.unknownItems += 1;
      continue;
    }
    if (pt === "reasoning") {
      stats.reasoning += 1;
      continue;
    }
    if (pt === "agent_message") {
      countParts(p.content, false);
      stats.collapsed += 1;
      continue;
    }
    if (SELF_CONTAINED_COLLAPSE_TYPES.has(pt)) {
      stats.collapsed += 1;
      continue;
    }
    if (pt === "function_call" || pt === "custom_tool_call" || pt === "tool_search_call") {
      const callId = typeof p.call_id === "string" ? p.call_id : "";
      if (callId === "") {
        stats.unknownItems += 1;
        continue;
      }
      const name = typeof p.name === "string" ? p.name : "";
      const isBash =
        (pt === "function_call" && BASH_MAPPED_FUNCTION_NAMES.has(name)) ||
        (pt === "custom_tool_call" && BASH_MAPPED_CUSTOM_NAMES.has(name));
      if (isBash) {
        execCalls += 1;
        bashPendingIds.add(callId);
      } else {
        stats.collapsed += 1;
      }
      continue;
    }
    if (OUTPUT_RECORD_TYPES.has(pt)) {
      const callId = typeof p.call_id === "string" ? p.call_id : "";
      if (callId !== "" && bashPendingIds.has(callId)) {
        bashPendingIds.delete(callId);
        execPaired += 1;
      }
      continue;
    }
    stats.unknownItems += 1;
  }

  return { cwd, stats, users, assistants, execCalls, execPaired, execOrphans: bashPendingIds.size };
}

/** Mirror of formatRolloutStatsLines (CodexRolloutImportDialog.tsx). */
function expectedStatsLines(analysis) {
  const lines = [];
  const s = analysis.stats;
  if (s.reasoning > 0) lines.push(`${s.reasoning} reasoning dropped`);
  if (s.collapsed > 0) lines.push(`${s.collapsed} tools collapsed to text`);
  if (s.images > 0) lines.push(`${s.images} images omitted`);
  const unrecognized = s.malformed + s.unknownRecords + s.unknownItems + s.unknownParts;
  if (unrecognized > 0) lines.push(`${unrecognized} unrecognized lines skipped`);
  return lines;
}

/** Mirror of codex-rollout-ipc.ts's peekRolloutMeta: HEAD_PEEK_BYTES only. */
function replicateHeadPeek(path) {
  const fd = openSync(path, "r");
  let head = "";
  try {
    const buf = Buffer.alloc(HEAD_PEEK_BYTES);
    const n = readSync(fd, buf, 0, HEAD_PEEK_BYTES, 0);
    head = buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
  const result = {};
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    if (record.type === "session_meta" && result.cwd === undefined) {
      if (typeof record.payload?.cwd === "string") result.cwd = record.payload.cwd;
    }
    if (record.type === "response_item" && result.firstUserMessage === undefined) {
      const payload = record.payload;
      if (payload?.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
        const texts = payload.content
          .map((part) => (part && typeof part === "object" && part.type === "input_text" ? part.text : undefined))
          .filter((text) => typeof text === "string");
        if (texts.length > 0) result.firstUserMessage = texts.join("\n");
      }
    }
    if (result.cwd !== undefined && result.firstUserMessage !== undefined) break;
  }
  return result;
}

/** Mirror of truncateRolloutPreview + the facade's trimmed-textContent read + sha256Prefix12. */
function expectedRowRedaction(peek) {
  const cwdRendered = typeof peek.cwd === "string" && peek.cwd.length > 0;
  if (typeof peek.firstUserMessage !== "string" || peek.firstUserMessage === "") {
    return { cwdRendered, preview: { rendered: false, length: 0, sha256_12: null } };
  }
  const collapsed = peek.firstUserMessage.replace(/\s+/g, " ").trim();
  const rendered = collapsed.length <= FIRST_MESSAGE_PREVIEW_CAP ? collapsed : `${collapsed.slice(0, FIRST_MESSAGE_PREVIEW_CAP)}…`;
  if (rendered === "") return { cwdRendered, preview: { rendered: false, length: 0, sha256_12: null } };
  return {
    cwdRendered,
    preview: { rendered: true, length: rendered.length, sha256_12: createHash("sha256").update(rendered, "utf8").digest("hex").slice(0, 12) },
  };
}

// ── case S4-BASELINE ──

async function caseBaselines(ctx) {
  const caseName = "S4-BASELINE";
  for (const p of [OWNER_CODEX_HOME, OWNER_ACCOUNTS_ROOT]) {
    if (!existsSync(p)) fail(caseName, `owner home missing: ${p} (external precondition)`);
  }
  for (const rel of [SOURCE_A, SOURCE_B]) {
    if (!existsSync(join(OWNER_SESSIONS_ROOT, rel))) fail(caseName, `pinned source rollout missing: ~/.codex/sessions/${rel}`);
  }
  ctx.codexHomeBefore = snapshotTree(OWNER_CODEX_HOME);
  ctx.accountsBefore = snapshotTree(OWNER_ACCOUNTS_ROOT);
  ctx.realRootBefore = existsSync(REAL_CODEX_PROFILES_ROOT) ? snapshotTree(REAL_CODEX_PROFILES_ROOT) : null;
  ctx.procBaseline = pgrepSnapshot();

  // D-S ladder rung 2 precondition: LM Studio serving the mandated model.
  // One `lms server start` attempt on failure (plan §2 SKIP semantics).
  ctx.lmAlive = false;
  ctx.lmReason = "";
  const probeLm = async () => {
    try {
      const res = await fetch(`${LM_BASE_URL}/models`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return `GET /v1/models -> HTTP ${res.status}`;
      const parsed = await res.json();
      const ids = (parsed?.data ?? []).map((m) => m?.id);
      if (!ids.includes(TURN_MODEL)) return `model ${TURN_MODEL} not served (have: ${JSON.stringify(ids)})`;
      return null;
    } catch (err) {
      return `GET /v1/models threw: ${err?.message ?? err}`;
    }
  };
  let lmErr = await probeLm();
  if (lmErr !== null) {
    console.warn(`[${caseName}] LM Studio probe failed (${lmErr}) — one \`lms server start\` attempt`);
    try {
      execFileSync("lms", ["server", "start"], { encoding: "utf8", timeout: 20_000 });
    } catch (err) {
      console.warn(`[${caseName}] lms server start: ${err?.message ?? err}`);
    }
    await sleep(3000);
    lmErr = await probeLm();
  }
  if (lmErr === null) ctx.lmAlive = true;
  else ctx.lmReason = lmErr;

  pass(
    caseName,
    `owner snapshots: ${ctx.codexHomeBefore.size} entries ~/.codex, ${ctx.accountsBefore.size} ~/.codex-accounts; ` +
      `real ~/.anycode/codex ${ctx.realRootBefore === null ? "ABSENT (must stay absent)" : `${ctx.realRootBefore.size} entries`}; ` +
      `${ctx.procBaseline.size} pre-existing electron|codex pids; LM Studio ${ctx.lmAlive ? `alive, ${TURN_MODEL} served` : `DEAD (${ctx.lmReason}) — D-S will SKIP`}`,
  );
}

// ── case S4-SOURCE (copy + derive oracles) ──

function caseSource(ctx) {
  const caseName = "S4-SOURCE";
  ctx.root = mkdtempSync(join(tmpdir(), "anycode-s4-smoke-"));
  ctx.leverHome = join(ctx.root, "lever");
  mkdirSync(ctx.leverHome, { mode: 0o700 });
  const profileHome = join(ctx.leverHome, ".anycode", "codex", `profile-${PROFILE_ID}`);
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });

  ctx.sources = {};
  for (const rel of [SOURCE_A, SOURCE_B]) {
    const src = join(OWNER_SESSIONS_ROOT, rel);
    const dst = join(profileHome, "sessions", rel);
    mkdirSync(dirname(dst), { recursive: true });
    // COPYFILE semantics: source opened read-only; mtime preserved separately
    // is unnecessary (rows are addressed by fileName, not order).
    copyFileSync(src, dst);
    const srcStat = lstatSync(src);
    const dstStat = lstatSync(dst);
    assert(caseName, srcStat.size === dstStat.size, `copy size mismatch for ${rel}: src=${srcStat.size} dst=${dstStat.size}`);
    const analysis = analyzeRolloutFile(dst);
    const redaction = expectedRowRedaction(replicateHeadPeek(dst));
    ctx.sources[rel] = { rel, copyPath: dst, sizeBytes: dstStat.size, analysis, redaction };
  }

  const target = ctx.sources[IMPORT_TARGET];
  assert(caseName, target.analysis.execCalls > 0, `import target ${IMPORT_TARGET} carries no mapped exec tool calls — pick a different source`);
  assert(caseName, typeof target.analysis.cwd === "string" && target.analysis.cwd.length > 0, `import target has no session_meta cwd`);
  assert(
    caseName,
    RECREATABLE_CWD_PREFIXES.some((prefix) => target.analysis.cwd.startsWith(prefix)),
    `import target cwd "${target.analysis.cwd}" is not under a disposable tmp root — refusing (the resumed tab would host a REAL directory)`,
  );

  pass(
    caseName,
    Object.values(ctx.sources)
      .map(
        (s) =>
          `${s.rel}: ${s.sizeBytes}B, execCalls=${s.analysis.execCalls} (paired=${s.analysis.execPaired}, orphans=${s.analysis.execOrphans}), ` +
          `users=${s.analysis.users}, statsLines=${JSON.stringify(expectedStatsLines(s.analysis))}, ` +
          `rowRedaction={cwdRendered:${s.redaction.cwdRendered}, previewRendered:${s.redaction.preview.rendered}}`,
      )
      .join(" · "),
  );
}

// ── case S4-LAUNCH ──

async function caseLaunch(ctx) {
  const caseName = "S4-LAUNCH";
  ctx.tmpWorkspace = join(ctx.root, "ws");
  mkdirSync(ctx.tmpWorkspace);
  writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from codex-import-live-smoke\n");

  // Sentinel ambient CODEX_HOME: keeps the system pseudo-profile's doctor
  // spawn OFF the owner's real ~/.codex (S1b/S3 custody precedent).
  ctx.sentinelHome = join(ctx.root, "sentinel-codex-home");
  mkdirSync(ctx.sentinelHome, { mode: 0o700 });

  ctx.profileUserDataDir = join(ctx.root, "user-data");
  ctx.profileDbPath = join(ctx.root, "db.sqlite");
  ctx.profileAutomationInfo = join(ctx.root, "automation.json");
  ctx.settingsPath = join(ctx.root, "settings.json");
  ctx.secretsPath = join(ctx.root, "secrets.json");

  const createdAt = new Date().toISOString();
  // THE hand-edit (plan W4-S4 mandate, same config family as S5): readiness
  // comes PURELY from the custom:lmstudio connection; a SECOND, deliberately
  // model-less connection over an EMPTY-catalog custom record is the FXH
  // empty-model rig (resolveDefaultImportModel bottoms out at "").
  const seedSettings = {
    version: 2,
    provider: {
      activeConnectionId: CONN_READY,
      connections: [
        { id: CONN_READY, providerId: CUSTOM_READY_ID, label: "LM Studio (hand-edit)", model: DEFAULT_MODEL },
        { id: CONN_EMPTY, providerId: CUSTOM_EMPTY_ID, label: "Empty catalog (FXH rig)" },
      ],
      custom: [
        { id: CUSTOM_READY_ID, name: "LM Studio", baseUrl: LM_BASE_URL, kind: "openai-compatible", models: CURATED_MODELS },
        { id: CUSTOM_EMPTY_ID, name: "Empty catalog", baseUrl: LM_BASE_URL, kind: "openai-compatible", models: [] },
      ],
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    codex: {
      // One plain MANAGED profile (no linkedHome/authLink): its home derives
      // from the lever root, where S4-SOURCE planted the rollout copies.
      profiles: [{ id: PROFILE_ID, label: PROFILE_LABEL, createdAt }],
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
    CODEX_HOME: ctx.sentinelHome,
    ANYCODE_CODEX_PROFILES_HOME: ctx.leverHome,
  };
  // S5 posture: readiness must come PURELY from the hand-edited custom
  // connection — an env credential would mask a broken custom route AND would
  // hijack the import dialog's model resolution (env model wins).
  delete env.ANYCODE_API_KEY;
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_BASE_URL;
  delete env.ANYCODE_REASONING_EFFORT;
  if (FLAGS.port !== undefined) env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);

  // Capture the host's own boot lines so S4-MODEL-IDENTITY can self-assert the
  // resumed session's model (`[host] initialized. ... model=<picked> session=<id>
  // resumed=true`). Piped rather than inherited, but written straight through so
  // the run stays fully visible in the combined smoke log.
  ctx.hostInitLines = [];
  let hostLineResidual = "";
  const scanHostLines = (chunk) => {
    process.stdout.write(chunk);
    hostLineResidual += chunk.toString("utf8");
    const parts = hostLineResidual.split("\n");
    hostLineResidual = parts.pop() ?? "";
    for (const line of parts) {
      if (line.includes("[host] initialized.")) ctx.hostInitLines.push(line);
    }
  };
  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", scanHostLines);
  child.stderr.on("data", scanHostLines);
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
  ctx.appPid = info.pid;

  await waitForFacade(ctx, caseName);
  ctx.bootTabId = await discoverTabByWorkspace(ctx, caseName, ctx.tmpWorkspace);
  pass(caseName, `app up (pid=${info.pid}, port=${info.port}), boot tab ${ctx.bootTabId}, lever=${ctx.leverHome}`);
}

// ── settings navigation helpers ──

async function openSettingsPane(ctx, caseName, paneId) {
  const settingsState = await apiOk(ctx, caseName, "GET", "/settings");
  if (settingsState?.open !== true) {
    let opened = null;
    for (let i = 0; i < 20; i += 1) {
      opened = await apiOk(ctx, caseName, "POST", "/settings/open", {});
      if (opened?.ok === true) break;
      await sleep(500);
    }
    assert(caseName, opened?.ok === true, `POST /settings/open never succeeded: ${JSON.stringify(opened)}`);
  }
  const paneResp = await apiOk(ctx, caseName, "POST", "/settings/pane", { paneId });
  assert(caseName, paneResp?.ok === true, `pane switch to ${paneId} refused: ${JSON.stringify(paneResp)}`);
}

/** Make `connectionId` the active (default-for-new-sessions) connection via the REAL tile click. */
async function activateConnection(ctx, caseName, connectionId) {
  await openSettingsPane(ctx, caseName, "provider");
  const grid = await apiOk(ctx, caseName, "GET", "/settings/provider");
  assert(caseName, grid?.mounted === true, `provider grid not mounted: ${JSON.stringify(grid?.mounted)}`);
  assert(
    caseName,
    (grid.rows ?? []).some((row) => row.connectionId === connectionId),
    `connection ${connectionId} not present in the grid: ${JSON.stringify((grid.rows ?? []).map((r) => r.connectionId))}`,
  );
  const tileResp = await apiOk(ctx, caseName, "POST", "/settings/provider/tile", { connectionId });
  assert(caseName, tileResp?.ok === true, `tile select of ${connectionId} refused: ${JSON.stringify(tileResp)}`);
  const after = await apiOk(ctx, caseName, "GET", "/settings/provider");
  const selectedRow = (after.rows ?? []).find((row) => row.selected === true);
  assert(caseName, selectedRow?.connectionId === connectionId, `active connection did not switch to ${connectionId}: selected=${JSON.stringify(selectedRow)}`);
}

/** Soft (non-gating) wait for the codex pane's boot doctor pass to settle, so teardown never races an in-flight codex spawn. */
async function softDoctorSettle(ctx) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(ctx.settingsPath, "utf8"));
    } catch {
      parsed = null;
    }
    const slice = parsed?.codex ?? null;
    const row = (slice?.profiles ?? []).find((p) => p.id === PROFILE_ID);
    const rowStamped = row?.lastCheck !== undefined && row.lastCheck.at >= ctx.tLaunchIso;
    const topStamped = slice?.lastCheck !== undefined && slice.lastCheck.at >= ctx.tLaunchIso;
    if (rowStamped && topStamped) {
      console.log(`           doctor pass settled (profile=${JSON.stringify(row.lastCheck?.status)}, system=${JSON.stringify(slice.lastCheck?.status)})`);
      return;
    }
    if (Date.now() >= deadline) {
      console.warn("[codex-import-live-smoke] doctor pass did not settle within 120s — proceeding (S4 gates do not depend on it)");
      return;
    }
    await sleep(1000);
  }
}

// ── import dialog helpers ──

async function openImportDialog(ctx, caseName) {
  await openSettingsPane(ctx, caseName, "codex");
  const openResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/open", { open: true });
  assert(caseName, openResp?.ok === true, `import dialog open refused: ${JSON.stringify(openResp)}`);
  const state = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, state.paneMounted === true && state.open === true, `import dialog did not report open: ${JSON.stringify({ paneMounted: state.paneMounted, open: state.open })}`);
  return state;
}

async function pickProfile(ctx, caseName) {
  const switchResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/profile", { profileId: PROFILE_ID });
  assert(caseName, switchResp?.ok === true, `identity-gated profile switch refused: ${JSON.stringify(switchResp)}`);
  const state = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, state.rolloutsFor === PROFILE_ID && state.listLoading === false, `rollout list not settled for ${PROFILE_ID}: ${JSON.stringify({ rolloutsFor: state.rolloutsFor, listLoading: state.listLoading })}`);
  return state;
}

async function pickRollout(ctx, caseName, state, rel) {
  const index = (state.rollouts ?? []).findIndex((row) => row.fileName === rel);
  assert(caseName, index >= 0, `rollout ${rel} not in the rendered list: ${JSON.stringify((state.rollouts ?? []).map((r) => r.fileName))}`);
  const pickResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/rollout", { index });
  assert(caseName, pickResp?.ok === true, `rollout pick (index ${index}) refused: ${JSON.stringify(pickResp)}`);
  const after = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, after.previewFor === rel && after.previewLoading === false, `preview not settled for ${rel}: ${JSON.stringify({ previewFor: after.previewFor, previewLoading: after.previewLoading })}`);
  return after;
}

// ── case H-S/rows ──

async function caseRows(ctx) {
  const caseName = "H-S/rows";
  // FXH rig FIRST: the dialog resolves its default model off the ACTIVE
  // connection; switch to the model-less one via the REAL provider-pane tile.
  await activateConnection(ctx, caseName, CONN_EMPTY);
  let state = await openImportDialog(ctx, caseName);

  const optionIds = (state.profileOptions ?? []).map((option) => option.id);
  assert(caseName, JSON.stringify(optionIds) === JSON.stringify(["system", PROFILE_ID]), `profile options != [system, ${PROFILE_ID}]: ${JSON.stringify(optionIds)}`);

  state = await pickProfile(ctx, caseName);
  const shownNames = (state.rollouts ?? []).map((row) => row.fileName).sort();
  const plantedNames = [SOURCE_A, SOURCE_B].sort();
  assert(caseName, JSON.stringify(shownNames) === JSON.stringify(plantedNames), `rendered rollout list != planted set;\n  shown=${JSON.stringify(shownNames)}\n  planted=${JSON.stringify(plantedNames)}`);

  for (const rel of [SOURCE_A, SOURCE_B]) {
    const row = state.rollouts.find((r) => r.fileName === rel);
    const expected = ctx.sources[rel].redaction;
    assert(caseName, typeof row.timestamp === "string" && row.timestamp.length > 0, `${rel}: empty timestamp label`);
    assert(caseName, typeof row.size === "string" && row.size.length > 0, `${rel}: empty size label`);
    assert(caseName, row.cwdRendered === expected.cwdRendered, `${rel}: cwdRendered=${JSON.stringify(row.cwdRendered)}, head-peek replication expects ${expected.cwdRendered}`);
    assert(
      caseName,
      row.preview?.rendered === expected.preview.rendered,
      `${rel}: preview.rendered=${JSON.stringify(row.preview?.rendered)}, head-peek replication expects ${expected.preview.rendered}`,
    );
    if (expected.preview.rendered) {
      assert(caseName, row.preview.length === expected.preview.length, `${rel}: preview.length=${row.preview.length}, expected ${expected.preview.length}`);
      assert(caseName, row.preview.sha256_12 === expected.preview.sha256_12, `${rel}: preview digest mismatch (channel=${row.preview.sha256_12}, local recompute=${expected.preview.sha256_12})`);
    } else {
      assert(caseName, row.preview.length === 0 && row.preview.sha256_12 === null, `${rel}: unrendered preview must be {length:0, sha256_12:null}: ${JSON.stringify(row.preview)}`);
    }
    // Custody: the raw cwd / first-message text must never cross the channel.
    const rowJson = JSON.stringify(row);
    assert(caseName, !rowJson.includes(ctx.sources[rel].analysis.cwd ?? " never"), `${rel}: RAW session cwd crossed the channel: ${rowJson}`);
  }

  const shot = await settledScreenshot(ctx, "s4-import-rows");
  assert(caseName, typeof shot === "string", "import rows screenshot capture failed");
  ctx.rowsState = state;
  pass(
    caseName,
    `2 real-rollout rows rendered == planted set; per-row custody redaction matches the replicated 16KiB head-peek ` +
      `(${SOURCE_A.slice(0, 10)}…: cwdRendered=${ctx.sources[SOURCE_A].redaction.cwdRendered}, ` +
      `${SOURCE_B.slice(0, 10)}…: cwdRendered=${ctx.sources[SOURCE_B].redaction.cwdRendered}; both previews unrendered — head-peek blind, see findings); raw cwd never crossed`,
  );
}

// ── case H-S/fxh-pin (Import disabled on empty model) ──

async function caseFxhPin(ctx) {
  const caseName = "H-S/fxh-pin";
  const target = ctx.sources[IMPORT_TARGET];
  const state = await pickRollout(ctx, caseName, ctx.rowsState, IMPORT_TARGET);

  // Honest-loss lines == independent recount of the copy.
  const expectedLines = expectedStatsLines(target.analysis);
  assert(
    caseName,
    JSON.stringify(state.statsLines) === JSON.stringify(expectedLines),
    `statsLines != independent recount;\n  shown=${JSON.stringify(state.statsLines)}\n  recount=${JSON.stringify(expectedLines)}`,
  );

  // FXH pin: valid profile + valid rollout + loaded preview, model resolves
  // to "" (model-less connection over an empty catalog) => Import DISABLED.
  assert(caseName, state.modelValue === "", `expected empty model under the FXH rig, got: ${JSON.stringify(state.modelValue)}`);
  assert(
    caseName,
    JSON.stringify(state.modelOptions) === JSON.stringify([{ id: "", name: "" }]),
    `model select expected the single empty entry (modelMenuItems("", [])): ${JSON.stringify(state.modelOptions)}`,
  );
  assert(caseName, state.importDisabled === true, `FXH pin RED: Import is NOT disabled on an empty model (importDisabled=${JSON.stringify(state.importDisabled)})`);

  // The apply driver must refuse WITHOUT clicking (fail-closed on the
  // button's own rendered disabled state).
  const applyResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/apply", {});
  assert(caseName, applyResp?.ok === false && applyResp?.reason === "import_disabled", `apply on a disabled Import expected {ok:false, reason:"import_disabled"}, got: ${JSON.stringify(applyResp)}`);

  const after = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, after.open === true && after.importing === false, `dialog state changed after the refused apply: ${JSON.stringify({ open: after.open, importing: after.importing })}`);
  // Discriminant against profile_not_found: the profile/rollout plane is
  // VALID (stamped list+preview above), and no "profile no longer exists"
  // copy is rendered — the sole blocker is the empty model. The client gate
  // fail-closes BEFORE main, so invalid_model's copy must be absent too.
  assert(caseName, !(after.notices ?? []).some((n) => n.includes("no longer exists")), `profile_not_found copy rendered under the FXH rig: ${JSON.stringify(after.notices)}`);

  const shot = await settledScreenshot(ctx, "s4-fxh-import-disabled");
  assert(caseName, typeof shot === "string", "FXH pin screenshot capture failed");
  pass(caseName, `preview loaded (statsLines=${JSON.stringify(state.statsLines)}), modelValue="", Import disabled, apply refused fail-closed (import_disabled); no profile_not_found copy`);
}

// ── case H-S/import (real model -> Import & open) ──

async function caseImport(ctx) {
  const caseName = "H-S/import";
  // Close the dialog, restore the ready connection via the real tile, reopen.
  const closeResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/open", { open: false });
  assert(caseName, closeResp?.ok === true, `import dialog close refused: ${JSON.stringify(closeResp)}`);
  await activateConnection(ctx, caseName, CONN_READY);
  await openImportDialog(ctx, caseName);
  let state = await pickProfile(ctx, caseName);

  // Preview A first (identity-gated settle exercised across a row switch),
  // its honest-loss lines against the independent recount, then the target.
  state = await pickRollout(ctx, caseName, state, SOURCE_A);
  const expectedA = expectedStatsLines(ctx.sources[SOURCE_A].analysis);
  assert(caseName, JSON.stringify(state.statsLines) === JSON.stringify(expectedA), `SOURCE_A statsLines != recount;\n  shown=${JSON.stringify(state.statsLines)}\n  recount=${JSON.stringify(expectedA)}`);

  state = await pickRollout(ctx, caseName, state, IMPORT_TARGET);
  const expectedB = expectedStatsLines(ctx.sources[IMPORT_TARGET].analysis);
  assert(caseName, JSON.stringify(state.statsLines) === JSON.stringify(expectedB), `target statsLines != recount;\n  shown=${JSON.stringify(state.statsLines)}\n  recount=${JSON.stringify(expectedB)}`);

  // The FXH-pin flip completes the empty-model discriminant: SAME profile,
  // SAME rollout — only the model plane changed, Import is now enabled with
  // the connection-default model resolved.
  assert(caseName, state.modelValue === DEFAULT_MODEL, `default model expected ${DEFAULT_MODEL} (connection model in catalog), got: ${JSON.stringify(state.modelValue)}`);
  assert(caseName, state.importDisabled === false, `Import still disabled with a resolved model: ${JSON.stringify({ modelValue: state.modelValue, importDisabled: state.importDisabled })}`);
  const optionIds = (state.modelOptions ?? []).map((o) => o.id);
  assert(caseName, JSON.stringify(optionIds) === JSON.stringify(CURATED_MODELS), `model options != curated catalog: ${JSON.stringify(optionIds)}`);

  // EXPLICIT pick of the turn model (differs from the default — the pick must
  // ride, not the default).
  const modelResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/model", { model: TURN_MODEL });
  assert(caseName, modelResp?.ok === true, `import model set refused: ${JSON.stringify(modelResp)}`);
  state = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, state.modelValue === TURN_MODEL, `model select did not take ${TURN_MODEL}: ${JSON.stringify(state.modelValue)}`);

  const shotSet = await settledScreenshot(ctx, "s4-import-model-set");
  assert(caseName, typeof shotSet === "string", "model-set screenshot capture failed");

  // The imported session's workspace = the rollout's original cwd. Recreate
  // it (guarded to disposable tmp roots by S4-SOURCE) so the resume-path tab
  // can actually host there.
  const cwd = ctx.sources[IMPORT_TARGET].analysis.cwd;
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    ctx.createdCwd = cwd;
    console.log(`           recreated the rollout's vanished tmp cwd: ${cwd}`);
  }

  const applyResp = await apiOk(ctx, caseName, "POST", "/settings/codex/import/apply", {});
  assert(caseName, applyResp?.ok === true, `Import & open refused: ${JSON.stringify(applyResp)}`);
  const after = await apiOk(ctx, caseName, "GET", "/settings/codex/import");
  assert(caseName, after.open === false, `dialog still open after a successful import: ${JSON.stringify(after.open)}`);

  // Close the Settings SCREEN (import only closes its own <dialog>, leaving
  // Settings overlaying the app) so the imported tab's transcript is what the
  // window actually renders — otherwise every downstream PNG captures the
  // Codex settings pane, not the hydrated/replied transcript it claims to.
  const closeSettings = await apiOk(ctx, caseName, "POST", "/settings/close", {});
  assert(caseName, closeSettings?.ok === true, `Settings screen close refused: ${JSON.stringify(closeSettings)}`);

  pass(caseName, `A→B previews identity-settled, statsLines == recount both; empty-model flip completed (default ${DEFAULT_MODEL} -> enabled); picked ${TURN_MODEL} explicitly; Import & open succeeded, dialog closed, Settings screen dismissed`);
}

// ── case S4-TAB-PAIRS (hydrated transcript of the imported session) ──

async function caseTabPairs(ctx) {
  const caseName = "S4-TAB-PAIRS";
  const target = ctx.sources[IMPORT_TARGET];
  ctx.importTabId = await discoverTabByWorkspace(ctx, caseName, target.analysis.cwd, 60_000);
  assert(caseName, ctx.importTabId !== ctx.bootTabId, `imported tab id collides with the boot tab`);

  const readyWait = await apiOk(ctx, caseName, "POST", "/wait", { tabId: ctx.importTabId, until: { connection: "ready" }, timeoutMs: 120_000 });
  assert(caseName, readyWait?.matched === true, `imported session never reached connection=ready: ${JSON.stringify(readyWait?.state?.connection ?? readyWait)}`);

  // Hydration lands via session_history after host_ready — poll for it.
  const deadline = Date.now() + 60_000;
  let state = null;
  let toolBlocks = [];
  for (;;) {
    const resp = await apiOk(ctx, caseName, "GET", `/state/${ctx.importTabId}`);
    state = resp?.snapshot?.states?.[ctx.importTabId];
    toolBlocks = (state?.transcript ?? []).filter((b) => b.kind === "tool_call");
    if (toolBlocks.length >= target.analysis.execCalls) break;
    if (Date.now() >= deadline) {
      fail(
        caseName,
        `hydrated transcript never reached ${target.analysis.execCalls} tool_call blocks (have ${toolBlocks.length}; kinds=${JSON.stringify((state?.transcript ?? []).map((b) => b.kind))})`,
      );
    }
    await sleep(500);
  }

  // Core engine: the per-tab `engine` snapshot key is codex-only — absent (or
  // null) proves the imported session runs OUR engine, not codex.
  assert(caseName, state.engine === undefined || state.engine === null, `imported tab is not a core-engine session: engine=${JSON.stringify(state.engine)}`);

  // Pair consistency: exactly the recount's mapped-exec count, and EVERY
  // tool_call block carries its paired result (the importer synthesizes
  // orphans as `cancelled` — "proposed" would mean an unpaired call leaked).
  assert(caseName, toolBlocks.length === target.analysis.execCalls, `tool_call block count ${toolBlocks.length} != independent recount ${target.analysis.execCalls}`);
  for (const block of toolBlocks) {
    assert(caseName, block.toolName === "Bash", `mapped tool_call is not Bash: ${JSON.stringify({ toolCallId: block.toolCallId, toolName: block.toolName })}`);
    assert(caseName, block.status !== "proposed", `UNPAIRED tool_call in the imported transcript (status=proposed): ${JSON.stringify({ toolCallId: block.toolCallId })}`);
    assert(caseName, block.modelText !== null, `tool_call ${block.toolCallId} carries no paired result text`);
  }
  // This file's calls are all output-paired in the source => all "success".
  if (target.analysis.execOrphans === 0) {
    assert(
      caseName,
      toolBlocks.every((b) => b.status === "success"),
      `all source pairs are complete, yet a block is not "success": ${JSON.stringify(toolBlocks.map((b) => b.status))}`,
    );
  }

  const userBlocks = (state.transcript ?? []).filter((b) => b.kind === "user_text");
  assert(caseName, userBlocks.length === target.analysis.users, `user_text block count ${userBlocks.length} != recount ${target.analysis.users}`);
  assert(caseName, (state.transcript ?? []).some((b) => b.kind === "assistant_text"), "no assistant_text blocks hydrated");

  const shot = await settledScreenshot(ctx, "s4-imported-tab");
  assert(caseName, typeof shot === "string", "imported tab screenshot capture failed");
  ctx.hydratedBlockCount = state.transcript.length;
  pass(
    caseName,
    `imported tab ${ctx.importTabId} (workspace = rollout cwd) hydrated: ${toolBlocks.length}/${target.analysis.execCalls} Bash tool_call blocks, ` +
      `ALL paired (statuses=${JSON.stringify([...new Set(toolBlocks.map((b) => b.status))])}), ${userBlocks.length} user_text; core engine (no engine key)`,
  );
}

// ── case S4-MODEL-IDENTITY (picked model: persisted row vs live host) ──

async function caseModelIdentity(ctx) {
  const caseName = "S4-MODEL-IDENTITY";
  // Persisted plane: the session row must carry the PICKED model (read-only
  // sqlite read of the isolated DB).
  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const out = execFileSync("sqlite3", ["-readonly", ctx.profileDbPath, "SELECT id, model, engine_id, workspace FROM sessions;"], { encoding: "utf8" });
      rows = out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split("|"));
      break;
    } catch (err) {
      if (attempt === 3) fail(caseName, `sqlite read of ${ctx.profileDbPath} failed: ${err?.message ?? err}`);
      await sleep(1000);
    }
  }
  const targetCwd = canonPath(ctx.sources[IMPORT_TARGET].analysis.cwd);
  const imported = rows.filter((r) => canonPath(r[3] ?? "") === targetCwd);
  assert(caseName, imported.length === 1, `expected exactly one imported session row for ${targetCwd}, got ${imported.length}: ${JSON.stringify(rows)}`);
  const [rowId, rowModel, rowEngine] = imported[0];
  assert(caseName, rowModel === TURN_MODEL, `session row model="${rowModel}" != picked ${TURN_MODEL} — the dialog did not persist the pick`);
  assert(caseName, rowEngine === "core" || rowEngine === "", `imported session engine_id="${rowEngine}" != core`);

  // Live plane: what model does the resumed host ACTUALLY run? Post-L4 (the
  // S4-1 fix) the dialog's model pick GOVERNS the resumed session, so any
  // divergence from the picked model is now a HARD failure — not a recorded
  // workaround. The active connection deliberately defaults to gemma, so a live
  // model of openai/gpt-oss-20b can only come from the import pick riding
  // through (connectionId pin + ENV_MODEL override). Pre-fix form: RED.
  const pill = await apiOk(ctx, caseName, "GET", `/tabs/${ctx.importTabId}/model-pill`);
  assert(caseName, pill?.ok === true && pill?.present === true, `model pill not present on the imported tab: ${JSON.stringify(pill)}`);
  ctx.liveModelAtOpen = pill.currentModel;
  assert(
    caseName,
    pill.currentModel === TURN_MODEL,
    `imported tab live model=${JSON.stringify(pill.currentModel)} != picked ${TURN_MODEL} while the active connection defaults to ${DEFAULT_MODEL} — ` +
      `the import pick must govern the resumed session (S4-1 fix regressed)`,
  );

  // Host-plane corroboration: the resumed host's OWN boot line must name the
  // picked model for THIS session on a resume. session=<id> matches the sqlite
  // row id (sessionMeta.id); openai/gpt-oss-20b is never a connection default,
  // so its presence on a resumed init line proves the ENV_MODEL override rode
  // through boot. Pre-fix this line named the gemma default (RED).
  let initLine;
  const initDeadline = Date.now() + 10_000;
  for (;;) {
    initLine = ctx.hostInitLines.find((line) => line.includes(`session=${rowId}`));
    if (initLine !== undefined || Date.now() >= initDeadline) break;
    await sleep(250);
  }
  assert(
    caseName,
    initLine !== undefined,
    `no '[host] initialized' boot line for imported session=${rowId}; captured init lines: ${JSON.stringify(ctx.hostInitLines)}`,
  );
  assert(
    caseName,
    initLine.includes(`model=${TURN_MODEL}`) && initLine.includes("resumed=true"),
    `imported host boot line did not carry the picked model on a resume: ${JSON.stringify(initLine)}`,
  );

  pass(
    caseName,
    `picked model rides end-to-end: session row model=${rowModel}, live model-pill=${pill.currentModel}, ` +
      `host boot line names model=${TURN_MODEL} on resumed session ${rowId} (active connection default ${DEFAULT_MODEL})`,
  );
}

// ── case D-S/turn ──

function transcriptTail(state) {
  return (state?.transcript ?? []).map((b) => b.kind).join(",");
}

async function waitForReply(ctx, caseName, sinceIndex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await apiOk(ctx, caseName, "GET", `/state/${ctx.importTabId}`);
    const state = resp?.snapshot?.states?.[ctx.importTabId];
    if (state !== undefined) {
      // Permission watchdog: nothing should ask during a no-tools reply, but a
      // model that tries anyway gets a fail-closed DENY, never a grant.
      if (state.permission !== null && state.permission !== undefined) {
        console.warn(`[${caseName}] permission request popped during the turn (${JSON.stringify(state.permission?.toolName ?? state.permission)}) — denying`);
        await apiOk(ctx, caseName, "POST", `/tabs/${ctx.importTabId}/permission`, { behavior: "deny" });
      }
      const blocks = state.transcript ?? [];
      const reply = blocks
        .slice(sinceIndex)
        .find((b) => b.kind === "assistant_text" && typeof b.text === "string" && b.text.toLowerCase().includes("pong"));
      if (reply !== undefined && state.turn?.status === "idle") return { outcome: "pong", state, reply };
      const errBlock = blocks.slice(sinceIndex).find((b) => b.kind === "error");
      if (errBlock !== undefined && state.turn?.status === "idle") return { outcome: "error", state, errBlock };
    }
    if (Date.now() >= deadline) return { outcome: "timeout", state };
    await sleep(1000);
  }
}

async function caseTurn(ctx) {
  const caseName = "D-S/turn";
  if (!ctx.lmAlive) {
    skip(caseName, `LM Studio unavailable after one \`lms server start\` attempt (${ctx.lmReason}) — the model ladder's rung 2 external precondition is absent; rung 1 (live key in settings.local.json) is empty in this worktree`);
    return;
  }

  const idleWait = await apiOk(ctx, caseName, "POST", "/wait", { tabId: ctx.importTabId, until: { turnStatus: "idle" }, timeoutMs: 30_000 });
  assert(caseName, idleWait?.matched === true, `imported tab never idle before the turn: ${JSON.stringify(idleWait?.state?.turn ?? idleWait)}`);

  const baseline = ctx.hydratedBlockCount ?? 0;
  const promptResp = await apiOk(ctx, caseName, "POST", `/tabs/${ctx.importTabId}/prompt`, { text: TURN_PROMPT });
  assert(caseName, promptResp?.ok === true, `prompt refused: ${JSON.stringify(promptResp)}`);
  console.log(`           D-S turn dispatched on ${TURN_MODEL} (LM Studio — zero owner quota)`);

  let result = await waitForReply(ctx, caseName, baseline, TURN_TIMEOUT_MS);
  if (result.outcome !== "pong") {
    console.warn(`[${caseName}] first turn ${result.outcome} (${JSON.stringify(result.errBlock?.error ?? null)}) — one local retry (LM Studio, zero owner quota)`);
    const retryResp = await apiOk(ctx, caseName, "POST", `/tabs/${ctx.importTabId}/prompt`, { text: TURN_PROMPT });
    assert(caseName, retryResp?.ok === true, `retry prompt refused: ${JSON.stringify(retryResp)}`);
    result = await waitForReply(ctx, caseName, baseline, RETRY_TURN_TIMEOUT_MS);
    if (result.outcome !== "pong") {
      fail(caseName, `retry turn ${result.outcome}; last error=${JSON.stringify(result.errBlock?.error ?? null)}; tail=${transcriptTail(result.state)}`);
    }
  }

  // The turn ran in the IMPORTED session: our prompt landed as a user_text
  // block AFTER the hydrated history, and the reply followed it.
  const blocks = result.state.transcript ?? [];
  const promptBlock = blocks.slice(baseline).find((b) => b.kind === "user_text" && b.text === TURN_PROMPT);
  assert(caseName, promptBlock !== undefined, `the dispatched prompt never appeared after the hydrated history (baseline ${baseline}; tail=${transcriptTail(result.state)})`);
  assert(caseName, result.state.engine === undefined || result.state.engine === null, `engine key appeared on the imported core tab: ${JSON.stringify(result.state.engine)}`);

  const pill = await apiOk(ctx, caseName, "GET", `/tabs/${ctx.importTabId}/model-pill`);
  assert(caseName, pill?.currentModel === TURN_MODEL, `live model at reply time != ${TURN_MODEL}: ${JSON.stringify(pill?.currentModel)}`);

  const shot = await settledScreenshot(ctx, "s4-turn-pong");
  assert(caseName, typeof shot === "string", "turn screenshot capture failed");
  pass(caseName, `assistant replied (contains "pong") on ${TURN_MODEL} via OUR core engine in the imported session (original codex model was different — see findings header); 0 owner-quota turns spent`);
}

// ── post-teardown gates ──

function caseRealRootPin(ctx) {
  const caseName = "S4-REAL-HOME-NEG";
  const afterExists = existsSync(REAL_CODEX_PROFILES_ROOT);
  if (ctx.realRootBefore === null) {
    if (afterExists) {
      const after = snapshotTree(REAL_CODEX_PROFILES_ROOT);
      fail(caseName, `real ~/.anycode/codex did not exist before the run but EXISTS after (${after.size} entries) — a write leaked past the lever`);
    }
    pass(caseName, "real ~/.anycode/codex ABSENT before AND after the run — zero writes into the owner's real profiles root");
    return;
  }
  if (!afterExists) fail(caseName, "real ~/.anycode/codex existed before the run but is GONE after");
  const deltas = diffSnapshots(ctx.realRootBefore, snapshotTree(REAL_CODEX_PROFILES_ROOT));
  if (deltas.length > 0) fail(caseName, `real ~/.anycode/codex changed during the run (${deltas.length} delta(s)):\n  ${deltas.slice(0, 20).join("\n  ")}`);
  pass(caseName, `real ~/.anycode/codex byte-stable (${ctx.realRootBefore.size} entries)`);
}

function caseCustody(ctx) {
  const caseName = "S4-CUSTODY";
  const codexAfter = snapshotTree(OWNER_CODEX_HOME);
  const accountsAfter = snapshotTree(OWNER_ACCOUNTS_ROOT);
  const deltas = [
    ...diffSnapshots(ctx.codexHomeBefore, codexAfter).map((d) => `~/.codex ${d}`),
    ...diffSnapshots(ctx.accountsBefore, accountsAfter).map((d) => `~/.codex-accounts ${d}`),
  ];
  if (deltas.length === 0) {
    pass(caseName, `owner homes byte-stable: ${codexAfter.size} entries ~/.codex (incl. both source rollouts), ${accountsAfter.size} ~/.codex-accounts — zero deltas (atime not recorded)`);
    return;
  }
  // Foreign-writer attribution (S1/S3 precedent): a CHANGED entry held open by
  // a PRE-EXISTING pid, or a volatile codex bookkeeping file while a
  // pre-existing codex process is alive, is attributed. ADDED/REMOVED, the
  // credential/config/session surface, and unattributable changes always FAIL.
  const volatilePattern = /^(logs_\d+\.sqlite(-wal|-shm)?|goals_\d+\.sqlite(-wal|-shm)?|models_cache\.json|history\.jsonl|version_check\.json)$/;
  const foreignCodexAlive = [...ctx.procBaseline.entries()].some(([pid, cmd]) => {
    const base = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
    return (base === "codex" || base === "codex-code-mode-host") && isPidAlive(pid);
  });
  const unattributed = [];
  const attributed = [];
  for (const delta of deltas) {
    const m = delta.match(/CHANGED ([^:]+):/);
    const changedPath = m?.[1];
    const baseName = changedPath?.split("/").pop() ?? "";
    const inSessionsOrCreds = changedPath !== undefined && (changedPath.includes("/sessions/") || baseName === "auth.json" || baseName === "config.toml");
    const holders = changedPath ? lsofHolders(changedPath).filter((pid) => ctx.procBaseline.has(pid)) : [];
    if (!inSessionsOrCreds && holders.length > 0) attributed.push(`${delta} [held open by pre-existing pid(s) ${holders.join(",")}]`);
    else if (!inSessionsOrCreds && changedPath !== undefined && volatilePattern.test(baseName) && foreignCodexAlive) attributed.push(`${delta} [volatile codex bookkeeping; pre-existing foreign codex alive]`);
    else unattributed.push(delta);
  }
  if (unattributed.length > 0) {
    fail(caseName, `owner homes changed during the run (${unattributed.length} unattributed delta(s)):\n  ${unattributed.slice(0, 20).join("\n  ")}`);
  }
  pass(caseName, `owner homes untouched by THIS run — every delta is a pre-existing foreign writer's:\n  ${attributed.join("\n  ")}`);
}

/** pgrep -fl matches substrings anywhere in argv — only electron/codex EXECUTABLES or this run's paths count as our lineage. */
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
  pass("ORPHANS", `0 new electron|codex pids after teardown + ${ORPHAN_SETTLE_MS}ms settle (baseline ${ctx.procBaseline.size} untouched)`);
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
      console.warn(`[codex-import-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[codex-import-live-smoke] still alive after SIGTERM — SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.root === "string" && existsSync(ctx.root)) {
    if (FLAGS.keep) console.log(`[codex-import-live-smoke] --keep set, tmp root preserved at: ${ctx.root}`);
    else {
      try {
        rmSync(ctx.root, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-import-live-smoke] failed to remove tmp root ${ctx.root}: ${err?.message ?? err}`);
      }
    }
  }
  // The recreated rollout cwd (guarded to disposable tmp roots at creation).
  if (typeof ctx.createdCwd === "string" && RECREATABLE_CWD_PREFIXES.some((p) => ctx.createdCwd.startsWith(p)) && existsSync(ctx.createdCwd)) {
    if (FLAGS.keep) console.log(`[codex-import-live-smoke] --keep set, recreated cwd preserved at: ${ctx.createdCwd}`);
    else {
      try {
        rmSync(ctx.createdCwd, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-import-live-smoke] failed to remove recreated cwd ${ctx.createdCwd}: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedCase === null ? "ALL CASES SETTLED" : `STOPPED at ${failedCase}`;
  const summary = verdicts.map((v) => `${v.caseName}=${v.verdict}`).join(" · ");
  console.log(`\n[codex-import-live-smoke] ${summary} — ${verdict}`);
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) return;
    handling = true;
    console.error(`\n[codex-import-live-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = { teardownPromise: null, child: null, root: null, createdCwd: null };
  installSignalTeardown(ctx);

  let failedCase = null;
  const capture = (err) => {
    if (failedCase === null) failedCase = err instanceof SmokeFailure ? err.caseName : "unknown";
    if (!(err instanceof SmokeFailure)) console.error(`[codex-import-live-smoke] unexpected error: ${err?.stack ?? err}`);
  };

  try {
    await caseBaselines(ctx);
    caseSource(ctx);
    await caseLaunch(ctx);
    await openSettingsPane(ctx, "S4-PANE", "codex");
    await softDoctorSettle(ctx);
    await caseRows(ctx);
    await caseFxhPin(ctx);
    await caseImport(ctx);
    await caseTabPairs(ctx);
    await caseModelIdentity(ctx);
    await caseTurn(ctx);
  } catch (err) {
    capture(err);
  }

  await teardown(ctx, failedCase);

  // Post-teardown judgments about what the run left behind — each in its own
  // try so one FAIL never masks the next verdict.
  try {
    caseRealRootPin(ctx);
  } catch (err) {
    capture(err);
  }
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

  process.exit(failedCase === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[codex-import-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

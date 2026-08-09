/**
 * Live smoke for TASK.102 CUT-S2 §10.9.3 F4-wiring / §4.2 п.13: drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`) and proves the ONE thing
 * a unit matrix cannot (architect verdict §10.10.4 — `shared/settings.test.ts`
 * covers the `resolveProviderConnection` POLICY, but a unit test never runs
 * through the real `main/index.ts` wiring): with a SINGLE configured
 * provider connection, a real model calling
 * `Agent(tier:"session", provider:<the parent's own providerId>)` makes the
 * child ACTUALLY start (a second live process, admitted into
 * `TabHostManager`'s in-memory `childRuns` ledger — TASK.102 S2d D1's new
 * `/state` projection), and the child's persisted SQLite row (`/child-runs`,
 * the SAME D1 slice's maintenance route) carries the SAME `connectionId` as
 * the one connection the whole app was configured with. Per the cut's own
 * text, no SECOND provider is needed for discrimination here — the
 * discriminating fact is that the EXPLICIT `provider` resolution branch in
 * `TabHostManager.spawnChild` (`main/tabs.ts`, `resolveProviderConnection`)
 * runs for real in production and does not fail closed / silently drop the
 * pin. This script confirms the model actually exercised that branch (not
 * the default/omitted-provider path) by reading the Agent tool_call's own
 * `input.provider`/`input.tier` back off `GET /state`'s transcript — a
 * `tool_call` block's `input` is populated at creation time (renderer
 * `store.ts`'s `case "tool_call"`), before any subagent sub-status exists.
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted verbatim
 * from `subagent-card-smoke.mjs` (itself lifted from `ctx-popover-smoke.mjs`
 * — same P7.H per-run disposable profile + `.smoke-secrets/glm.env`
 * discipline). UNLIKE `subagent-card-smoke.mjs`, this script seeds a REAL
 * settings v2 `provider.connections[]` entry (not the vestigial v1-shaped
 * `provider:{id,model}` that predates TASK.45 and validates to nothing under
 * the current zod schema, `settings/schema.ts`'s `settingsSchema` requiring
 * `version:2` + `provider.connections: array`) — this scenario's whole point
 * is a REAL `connectionId`, which only a real v2 connection entry produces;
 * an env-override ("unpinned") boot would give both parent and child
 * `connectionId === undefined`, a trivial non-discriminating match. Plain
 * node >=22, ZERO npm deps — a NEW sibling, not an edit of either precedent.
 *
 * Usage:   node apps/desktop/scripts/child-session-explicit-provider-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach   Do not spawn a dev instance — read the live discovery file
 *              (~/.anycode/automation.json) of one already running. NOTE:
 *              an attached instance's settings.json is whatever it already
 *              booted with — this script does NOT reseed it, so the
 *              single-connection/connectionId assertions below only hold if
 *              the attached instance was itself launched with this script's
 *              seed (i.e. --attach is for iterating on THIS script against
 *              an instance a prior non-attached run left up, not for
 *              pointing it at an arbitrary running app).
 *   --keep     Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n> Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev process
 *              (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider — read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL), same file `ctx-popover-smoke.mjs` and
 * `subagent-card-smoke.mjs` use.
 *
 * Each step prints `[step N] PASS/FAIL <detail>`; the first FAIL tears down
 * and exits 1. The Agent-dispatch leg allows exactly ONE prompt retry
 * (live-model nondeterminism, same discipline as `subagent-card-smoke.mjs`)
 * before a documented SKIP (exit 0) if the model never calls the Agent tool
 * with the required `tier`/`provider` params at all — that is a live-model
 * limitation, not a product failure, and is reported as such, distinctly
 * from a real FAIL. Evidence (a screenshot + a JSON result dump) is written
 * to `working-docs/task102-track/evidence/S2/`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const SMOKE_SECRETS_PATH = join(repoRoot, ".smoke-secrets", "glm.env");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "task102-track", "evidence", "S2");
const TOTAL_STEPS = 4;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 300;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2";
// Hand-authored settings.json: `settingsSchema`'s `connectionSchema` only
// requires `id: z.string()` (main's `conn-<uuid>` format is a creation-flow
// convention, not a schema constraint) — any distinctive literal round-trips.
const CONNECTION_ID = "conn-f4-smoke";

const SPAWN_PROMPT_PRIMARY =
  'Call the Agent tool right now, in this turn. Use these exact parameter values: tier: "session", ' +
  `provider: "${PROVIDER_ID}", agent_type: "general-purpose", description: a short 3-5 word summary of the task, ` +
  "and prompt: an instruction telling the subagent to reply with exactly the single word DONE and to use no tools " +
  'at all. You MUST include both the tier and provider parameters exactly as given above — do not omit either one, ' +
  'and do not use tier "inline". Invoke the tool now.';
const SPAWN_PROMPT_RETRY =
  "You did not call the Agent tool with the required parameters. The Agent tool you have access to accepts a " +
  '`tier` parameter and, for tier "session", a `provider` parameter — both are real parameters of that tool. Call ' +
  `it NOW with tier set to the literal string "session" and provider set to the literal string "${PROVIDER_ID}". ` +
  'Also set agent_type to "general-purpose", a short description, and a prompt asking the subagent to reply with ' +
  "the single word DONE and use no tools. You must invoke the tool itself, with a real tool call — do not just " +
  "describe what you would do.";

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
      console.warn(`[child-session-explicit-provider-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from subagent-card-smoke.mjs) ──

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** macOS realpath-canonicalizes /var vs /private/var (tmpdir()'s two spellings of the same path). */
export function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function readDiscoveryFile(path) {
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

export function waitForExit(child, timeoutMs) {
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
export function killTree(pid, signal) {
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

/** Minimal KEY=VALUE .env parser (no quoting/escaping support). Blank lines and `#` comments are skipped. */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ── step bookkeeping ──

export class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

// Distinct step numbers that reported a PASS. Counting pass() CALLS overstates
// the score: step 1 alone emits two (launch, then boot-tab discovery), which is
// why runs printed "5/4 steps passed".
const passedSteps = new Set();

export function pass(step, detail) {
  passedSteps.add(step);
  console.log(`[step ${step}] PASS ${detail ?? ""}`.trimEnd());
}

export function fail(step, detail) {
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
}

export function assert(step, cond, detail) {
  if (!cond) {
    fail(step, detail);
  }
}

// ── HTTP helpers against the automation channel (README.md routes) ──

export async function api(ctx, method, path, body) {
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

export async function apiOk(ctx, step, method, path, body) {
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

export async function apiAction(ctx, step, path, body) {
  const result = await apiOk(ctx, step, "POST", path, body);
  if (result?.ok !== true) {
    fail(step, `POST ${path} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

export async function waitUntilTab(ctx, step, tabId, until, timeoutMs) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} for tab ${tabId} did not match: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Poll `GET /state` until the renderer facade has finished installing (DEV dynamic import races the page load). */
export async function waitForFacade(ctx, step, timeoutMs = 45_000) {
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

export async function discoverTabByWorkspace(ctx, step, workspace, timeoutMs = 90_000) {
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
        if (typeof tabState?.workspace === "string" && canonPath(tabState.workspace) === target) {
          return tabId;
        }
      }
    }
    if (Date.now() >= deadline) {
      fail(step, `no tab with workspace===${workspace} appeared within ${timeoutMs}ms (tabs=${lastTabs})`);
    }
    await sleep(250);
  }
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
export async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[child-session-explicit-provider-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    ctx.mkdirEvidenceDir();
    const filePath = join(ctx.evidenceDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[child-session-explicit-provider-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/** Fetches the current transcript block array for the active tab from `GET /state`. */
export async function getTranscriptBlocks(ctx, step, tabId) {
  const resp = await api(ctx, "GET", "/state");
  if (resp.status !== 200) {
    fail(step, `GET /state -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  const transcript = resp.body?.snapshot?.states?.[tabId]?.transcript;
  if (!Array.isArray(transcript)) {
    fail(step, `GET /state returned no transcript array for tab ${tabId}`);
  }
  return { transcript, mainTabs: resp.body?.tabs, childRuns: resp.body?.childRuns };
}

export function findAnyAgentBlock(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent") ?? null;
}

/**
 * Polls `GET /state` for BOTH signals at once: the Agent tool_call block (to
 * read back `input.tier`/`input.provider`, proving the model exercised the
 * EXPLICIT-provider branch and not the default/omitted-provider one) and the
 * main-plane `childRuns` ledger projection (TASK.102 S2d D1's new seam,
 * `TabHostManager.listChildRuns` via `main/tabs.ts` — proof the child was
 * REALLY admitted server-side, independent of anything the renderer
 * transcript reports). Returns as soon as EITHER settles into a stable
 * outcome worth deciding on, or the deadline passes.
 */
export async function pollForDispatch(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let anyAgentSeen = false;
  let lastBlock = null;
  for (;;) {
    const { transcript, mainTabs, childRuns } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = findAnyAgentBlock(transcript);
    if (block !== null) {
      anyAgentSeen = true;
      lastBlock = block;
    }
    if (Array.isArray(childRuns) && childRuns.length > 0) {
      return { anyAgentSeen, block: lastBlock, childRuns, mainTabs };
    }
    // The block settling to a terminal status with no childRuns entry ever
    // having appeared means the spawn was REJECTED (or the block errored for
    // some other reason) before admission — no point polling further once
    // settled; the outer caller diagnoses `block.status`/`block.modelText`.
    if (block !== null && (block.status === "success" || block.status === "error")) {
      return { anyAgentSeen, block, childRuns: childRuns ?? [], mainTabs };
    }
    if (Date.now() >= deadline) {
      return { anyAgentSeen, block: lastBlock, childRuns: childRuns ?? [], mainTabs };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Stops the current turn and best-effort waits for it to settle to idle — used before a retry. */
export async function settleTurn(ctx, step) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort — proceed regardless of the settle wait outcome.
  });
}

export async function attemptDispatch(ctx, step, prompt, timeoutMs) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  return pollForDispatch(ctx, step, timeoutMs);
}

function hasRequiredInput(block) {
  const input = block?.input;
  return input !== null && typeof input === "object" && input.tier === "session" && input.provider === PROVIDER_ID;
}

// ── step 2: dispatch the explicit-provider session-tier Agent call ──

async function step2Dispatch(ctx) {
  const step = 2;

  let anyAgentSeen = false;
  let result = await attemptDispatch(ctx, step, SPAWN_PROMPT_PRIMARY, 60_000);
  anyAgentSeen = anyAgentSeen || result.anyAgentSeen;

  if (!hasRequiredInput(result.block) && result.childRuns.length === 0) {
    console.warn(
      "[child-session-explicit-provider-smoke] the Agent tool was not called with the required " +
        `tier:"session"/provider:"${PROVIDER_ID}" params on the first attempt (block=${JSON.stringify(result.block)}) ` +
        "— retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    result = await attemptDispatch(ctx, step, SPAWN_PROMPT_RETRY, 90_000);
    anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
  }

  if (!anyAgentSeen) {
    console.warn(
      "[child-session-explicit-provider-smoke] SKIPPED: the model never called the Agent tool at all, after 1 " +
        "retry. This is a documented live-model-nondeterminism SKIP, NOT a product failure.",
    );
    ctx.skipped = true;
    ctx.skipReason = "model never called Agent";
    await settleTurn(ctx, step);
    pass(step, "SKIPPED (documented) — Agent tool never dispatched by the live model after 1 retry; see warning above");
    return;
  }

  if (!hasRequiredInput(result.block) && result.childRuns.length === 0) {
    console.warn(
      "[child-session-explicit-provider-smoke] SKIPPED: the model called Agent but never with the required " +
        `tier:"session"/provider:"${PROVIDER_ID}" params, after 1 retry (last block: ${JSON.stringify(result.block)}). ` +
        "This is documented live-model non-compliance, NOT a product failure — the model chose different " +
        "parameters (e.g. tier omitted/\"inline\", or a different provider string) despite explicit instructions.",
    );
    ctx.skipped = true;
    ctx.skipReason = "model did not use tier:session + provider:" + PROVIDER_ID;
    await settleTurn(ctx, step);
    pass(step, "SKIPPED (documented) — model never issued the exact tier/provider params after 1 retry; see warning above");
    return;
  }

  ctx.toolCallId = result.block.toolCallId;
  ctx.dispatchResult = result;
  pass(
    step,
    `Agent tool_call dispatched with tier="session" provider="${PROVIDER_ID}" (toolCallId=${ctx.toolCallId})`,
  );
}

// ── step 3: the child REALLY started — /state's main-plane childRuns ledger + two distinct live PIDs ──

async function step3RealStart(ctx) {
  const step = 3;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — no Agent dispatch to verify, see step 2");
    return;
  }

  const { childRuns, mainTabs, block } = ctx.dispatchResult;
  if (childRuns.length === 0) {
    // The Agent call WAS made with the right params but never got admitted —
    // this is the discriminating RED this script exists to surface. Report
    // whatever the transcript block itself says (a rejected-spawn ChildRunEvent
    // is relayed to the parent and lands here as the tool_call's own error).
    fail(
      step,
      `Agent tool_call ${ctx.toolCallId} was dispatched with tier="session" provider="${PROVIDER_ID}" but ` +
        `GET /state's childRuns projection never showed an admitted run (still empty after the poll deadline). ` +
        `Final transcript block: ${JSON.stringify(block)}`,
    );
  }

  assert(step, childRuns.length === 1, `expected exactly 1 childRuns entry, got ${childRuns.length}: ${JSON.stringify(childRuns)}`);
  const entry = childRuns[0];
  ctx.childEntry = entry;

  const rootSummary = (mainTabs ?? []).find((t) => t.tabId === ctx.tabId);
  assert(step, rootSummary !== undefined, `root tab ${ctx.tabId} missing from /state's main-plane tabs list`);
  assert(step, typeof rootSummary.pid === "number", `expected root tab to have a live pid, got ${JSON.stringify(rootSummary.pid)}`);
  assert(step, typeof entry.pid === "number", `expected the child run's own pid to be a live number, got ${JSON.stringify(entry.pid)}`);
  assert(
    step,
    entry.pid !== rootSummary.pid,
    `expected the child's host pid (${entry.pid}) to differ from the parent's (${rootSummary.pid}) — two distinct processes`,
  );
  assert(step, entry.parentSessionId === rootSummary.sessionId, `childRuns entry.parentSessionId (${entry.parentSessionId}) !== parent's own sessionId (${rootSummary.sessionId})`);

  pass(step, `child really started: parent pid=${rootSummary.pid}, child pid=${entry.pid}, childSessionId=${entry.childSessionId}`);
}

// ── step 4: connectionId parity — the durable SQLite row (via /child-runs) carries the SAME connectionId as the single configured connection ──

/**
 * The child's own row is written by the CHILD host's own boot sequence
 * (`resolveBootSession`/session creation), an entirely separate process from
 * the one this ledger's `pid` proves live in step 3 — `utilityProcess.fork()`
 * returns a pid synchronously, well before the new Node process has even
 * started executing, let alone durably persisted its session row. Polling
 * here (not a single GET) is closing that ordinary process-boot race, not
 * weakening the assertion: the row is expected to exist, just not
 * necessarily in the same instant the fork call returned.
 */
async function pollForChildRow(ctx, step, childSessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSessionIds = [];
  for (;;) {
    const rows = await apiOk(ctx, step, "GET", "/child-runs");
    assert(step, rows?.ok === true, `GET /child-runs did not answer ok:true: ${JSON.stringify(rows)}`);
    const sessions = rows.sessions ?? [];
    lastSessionIds = sessions.map((s) => s.id);
    const row = sessions.find((s) => s.id === childSessionId);
    if (row !== undefined) {
      return row;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function step4ConnectionIdParity(ctx) {
  const step = 4;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — no child run to verify, see step 2");
    return;
  }

  const row = await pollForChildRow(ctx, step, ctx.childEntry.childSessionId, 30_000);
  assert(
    step,
    row !== null,
    `no durable SQLite row for childSessionId=${ctx.childEntry.childSessionId} appeared in /child-runs within 30000ms`,
  );
  assert(
    step,
    row.connectionId === CONNECTION_ID,
    `expected the child session's durable connectionId to equal the single configured connection (${CONNECTION_ID}), got ${JSON.stringify(row.connectionId)}`,
  );
  assert(
    step,
    row.parentSessionId === ctx.childEntry.parentSessionId,
    `durable row's parentSessionId (${row.parentSessionId}) !== the live ledger's own parentSessionId (${ctx.childEntry.parentSessionId})`,
  );

  await settledScreenshot(ctx, "step-4-connection-id-parity");
  pass(step, `child's durable SQLite row carries connectionId="${row.connectionId}" — matches the parent's single configured connection`);
}

export async function settledScreenshot(ctx, name) {
  await sleep(200);
  return saveScreenshot(ctx, name);
}

// ── step 1: bootstrap a temp profile/workspace + launch (or attach to) the dev app, discover the boot tab ──

export async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-f4-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "README.md"), "# smoke\n\nhello from child-session-explicit-provider smoke\n");
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  let secretsEnv = {};
  try {
    secretsEnv = parseEnvFile(readFileSync(SMOKE_SECRETS_PATH, "utf8"));
  } catch (err) {
    fail(1, `could not read GLM smoke credentials at ${SMOKE_SECRETS_PATH}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_API_KEY`);
  assert(1, typeof secretsEnv.ANYCODE_BASE_URL === "string" && secretsEnv.ANYCODE_BASE_URL.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_BASE_URL`);

  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(1, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(1, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
    pass(1, `attached to running app (pid=${info.pid}, port=${info.port}); temp workspace=${ctx.tmpWorkspace}`);
    return;
  }

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4), same
  // discipline as subagent-card-smoke.mjs: isolates userData/db/discovery/
  // settings.json/secrets.json so this run never collides with a parallel
  // smoke, a manual dev session, or the owner's real settings.
  const profile = mkdtempSync(join(tmpdir(), "anycode-f4-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  // A REAL settings v2 provider connection (unlike subagent-card-smoke.mjs's
  // vestigial v1-shaped seed, which fails `settingsSchema` validation
  // entirely and silently falls back to DEFAULT_SETTINGS/env-override boot —
  // this scenario's whole point is a real, provable `connectionId`, which
  // only a genuine `provider.connections[]` entry produces). The credential
  // itself still rides `ANYCODE_API_KEY`/`ANYCODE_BASE_URL` in the process
  // boot env below (`buildHostEnv`: an env value always wins over the vault,
  // REGARDLESS of which connection is active, `host-env.ts`'s own doc) — no
  // vault/secrets.json entry is needed for this connection to be ready.
  const seedSettings = {
    version: 2,
    provider: {
      activeConnectionId: CONNECTION_ID,
      connections: [{ id: CONNECTION_ID, providerId: PROVIDER_ID, model: MODEL_A }],
    },
    tools: {},
    permissions: { alwaysAllow: [{ toolName: "Agent" }, { toolName: "Read" }, { toolName: "Glob" }, { toolName: "Grep" }, { toolName: "Bash" }] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
  writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

  const t0 = Date.now();
  const env = {
    ...process.env,
    ...secretsEnv,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
  };
  // Same anti-false-green discipline as subagent-card-smoke.mjs: an env-level
  // model override would mask the settings.json-seeded connection's model.
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;
  if (FLAGS.port !== undefined) {
    env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
  }

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
      fail(1, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(1, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  pass(1, `app launched (pid=${info.pid}), discovery ready after ${Date.now() - t0}ms on port ${info.port}, profile=${profile}`);
}

export async function step1DiscoverTab(ctx) {
  await waitForFacade(ctx, 1);

  if (ctx.child === null) {
    const created = await apiOk(ctx, 1, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    if (created?.ok !== true) {
      fail(1, `tab creation failed: ${JSON.stringify(created)}`);
    }
    ctx.tabId = created.tabId;
  } else {
    ctx.tabId = await discoverTabByWorkspace(ctx, 1, ctx.tmpWorkspace);
  }
  await waitUntilTab(ctx, 1, ctx.tabId, { connection: "ready" });
  // The tab this script creates/discovers must also be the ACTIVE tab — the
  // screenshot route only ever reads the active tab's mounted transcript.
  await apiAction(ctx, 1, `/tabs/${ctx.tabId}/select`, {});

  pass(1, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── teardown ──

/**
 * Thin memoizing wrapper around `runTeardown` (subagent-card-smoke.mjs
 * precedent): every caller (normal end-of-run() and the SIGINT/SIGTERM
 * handler) awaits the SAME shared promise.
 */
function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  let tabCloseFailed = false;

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else if (typeof ctx.tabId === "string") {
        const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
        if (closeResp.body?.ok !== true) {
          tabCloseFailed = true;
          console.warn(
            `[child-session-explicit-provider-smoke] tab ${ctx.tabId} close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              "a tab may still be open on a temp workspace; leaving it on disk instead of deleting out from under it",
          );
        }
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[child-session-explicit-provider-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[child-session-explicit-provider-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.tmpWorkspace === "string" && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[child-session-explicit-provider-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(`[child-session-explicit-provider-smoke] tab close failed — NOT deleting temp workspace: ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[child-session-explicit-provider-smoke] failed to remove temp workspace ${ctx.tmpWorkspace}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[child-session-explicit-provider-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[child-session-explicit-provider-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = ctx.skipped ? `SKIPPED (${ctx.skipReason})` : failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[child-session-explicit-provider-smoke] ${passedSteps.size}/${TOTAL_STEPS} steps passed — ${verdict}`);

  try {
    ctx.mkdirEvidenceDir();
    const resultPath = join(ctx.evidenceDir, "result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verdict,
          failedStep,
          skipped: ctx.skipped === true,
          skipReason: ctx.skipReason ?? null,
          toolCallId: ctx.toolCallId ?? null,
          childEntry: ctx.childEntry ?? null,
          passCount: passedSteps.size,
          totalSteps: TOTAL_STEPS,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`           result json: ${resultPath}`);
  } catch (err) {
    console.warn(`[child-session-explicit-provider-smoke] failed to write result.json: ${err?.message ?? err}`);
  }
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[child-session-explicit-provider-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[child-session-explicit-provider-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    port: undefined,
    token: undefined,
    tabId: null,
    toolCallId: null,
    dispatchResult: null,
    childEntry: null,
    skipped: false,
    skipReason: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    evidenceDir: EVIDENCE_DIR,
  };
  ctx.mkdirEvidenceDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.evidenceDir)}, {recursive:true})`]);
    } catch {
      // fall through to the caller's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);
    await step2Dispatch(ctx);
    await step3RealStart(ctx);
    await step4ConnectionIdParity(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[child-session-explicit-provider-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

// TASK.102 S2d D2: guarded so `child-session-scenario-smoke.mjs` can `import`
// this module's helpers (step1LaunchApp/step1DiscoverTab/api/… above, all now
// `export`ed) without triggering ITS OWN app launch/dispatch/teardown cycle as
// an unwanted side effect of the import — auto-run only fires when this file
// is the process's own entry point, exactly the standard "if main module" ESM
// idiom. Byte-identical behavior for a direct `node
// child-session-explicit-provider-smoke.mjs` invocation (the condition is
// true in that case, same as before this guard existed).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(`[child-session-explicit-provider-smoke] fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

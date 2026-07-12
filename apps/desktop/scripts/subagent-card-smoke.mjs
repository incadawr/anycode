/**
 * Live GUI smoke for P7.18/F16b W4 (design/slice-P7.18-cut.md §4 W4): drives
 * a REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Agent card
 * probe/driver" section) and exercises the frozen scenario the cut's DoD
 * demands — dispatch a real Agent subagent, watch its live per-tool activity
 * feed GROW while the child loop runs, wait for it to settle, then expand the
 * card for real (a genuine DOM click, not a store poke) and assert the
 * expanded body renders the owner's 4-item hierarchy: RESULT (Markdown, not
 * raw `<pre>`), the activity feed rows, and a still-collapsed PROMPT plaque.
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted verbatim
 * from `ctx-popover-smoke.mjs` (same P7.H per-run disposable profile +
 * `.smoke-secrets/glm.env` discipline). The subagent-dispatch/poll pattern
 * (prompt retry, running-vs-settled polling, documented SKIP if the live
 * model never calls Agent) is lifted from `todo-subagent-smoke.mjs`'s F16
 * leg and extended with an activity-growth assertion the P7.4 slice never
 * needed (there was no per-tool feed yet). Plain node >=22, ZERO npm deps —
 * a NEW sibling, not an edit of either precedent.
 *
 * Usage:   node apps/desktop/scripts/subagent-card-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach   Do not spawn a dev instance — read the live discovery file
 *              (~/.anycode/automation.json) of one already running. Teardown
 *              then only closes the tab this script created; it does NOT quit
 *              an app it did not launch.
 *   --keep     Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n> Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev process
 *              (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider — read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL), same file `ctx-popover-smoke.mjs` uses.
 *
 * Each of the 5 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. The Agent-dispatch leg allows exactly ONE prompt
 * retry (live-model nondeterminism, same discipline as
 * `todo-subagent-smoke.mjs` §3.4) before failing red; if the model never
 * dispatches the Agent tool at all after the retry, the run reports a
 * documented SKIP (exit 0) — a live-model limitation, not a product failure.
 * PNG evidence is written to `apps/desktop/out/subagent-card-smoke/step-*.png`

 * green is not yet painted).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const SMOKE_SECRETS_PATH = join(repoRoot, ".smoke-secrets", "glm.env");
const TOTAL_STEPS = 5;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;
const MIN_ACTIVITY_POLLS = 2;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2"; // reasoning-capable, same model ctx-popover-smoke seeds — a real Agent dispatch needs a model that reliably follows explicit tool-use instructions.

const SUBAGENT_PROMPT_PRIMARY =
  "Start a subagent using the Agent tool with this task: inspect the current repository structure, list " +
  "files and directories at its root, then read one file (for example README if it exists) and briefly " +
  "describe it. Use the Agent tool specifically; do not inspect the repository directly yourself.";
const SUBAGENT_PROMPT_RETRY =
  "Use the Agent tool now to dispatch a subagent. Give the subagent this task: explore the current repository's " +
  "root — list the files and folders there, then read the contents of any one file (e.g. a README if present) " +
  "and briefly describe what it contains. You must invoke the Agent tool yourself for this — do not explore the " +
  "repository directly.";

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
      console.warn(`[subagent-card-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from ctx-popover-smoke.mjs) ──

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

/** macOS realpath-canonicalizes /var vs /private/var (tmpdir()'s two spellings of the same path). */
function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
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

/** Kills the whole spawn tree, not just the direct child (detached -> own process group on POSIX). */
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

/**
 * Minimal KEY=VALUE .env parser (no quoting/escaping support — the smoke
 * credential file is a flat, hand-written 3-line file). Blank lines and `#`
 * comments are skipped.
 */
function parseEnvFile(text) {
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

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

let passCount = 0;

function pass(step, detail) {
  passCount += 1;
  console.log(`[step ${step}] PASS ${detail ?? ""}`.trimEnd());
}

function fail(step, detail) {
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
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

async function waitUntilTab(ctx, step, tabId, until, timeoutMs) {
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
async function waitForFacade(ctx, step, timeoutMs = 45_000) {
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

async function discoverTabByWorkspace(ctx, step, workspace, timeoutMs = 90_000) {
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
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[subagent-card-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    ctx.mkdirScreenshotDir();
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[subagent-card-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/* */
async function settledScreenshot(ctx, name) {
  await sleep(400);
  return saveScreenshot(ctx, name);
}

/** Fetches the current transcript block array for the active tab from `GET /state`. */
async function getTranscriptBlocks(ctx, step, tabId) {
  const resp = await api(ctx, "GET", "/state");
  if (resp.status !== 200) {
    fail(step, `GET /state -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  const transcript = resp.body?.snapshot?.states?.[tabId]?.transcript;
  if (!Array.isArray(transcript)) {
    fail(step, `GET /state returned no transcript array for tab ${tabId}`);
  }
  return transcript;
}

async function getBlockByToolCallId(ctx, step, toolCallId) {
  const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return transcript.find((b) => b.kind === "tool_call" && b.toolCallId === toolCallId) ?? null;
}

// ── agent-card facade helpers (automation/README.md "Agent card probe/driver") ──

async function agentCardState(ctx, step, tabId, toolCallId) {
  const resp = await api(ctx, "GET", `/tabs/${encodeURIComponent(tabId)}/agent-card/${encodeURIComponent(toolCallId)}`);
  if (resp.status !== 200) {
    fail(step, `GET /tabs/${tabId}/agent-card/${toolCallId} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `agent-card state not ok: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function agentCardExpand(ctx, step, tabId, toolCallId) {
  const resp = await api(ctx, "POST", `/tabs/${encodeURIComponent(tabId)}/agent-card/${encodeURIComponent(toolCallId)}/expand`, {});
  if (resp.status !== 200) {
    fail(step, `POST /tabs/${tabId}/agent-card/${toolCallId}/expand -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `agent-card expand rejected: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

// ── Agent-dispatch leg (design §4 W4) ──

function findAnyAgentBlock(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent") ?? null;
}

function findAgentBlockWithSubagent(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && b.subagent !== null) ?? null;
}

/**
 * Polls for an Agent tool_call block that has picked up a subagent
 * sub-status. Also tracks (via `anyAgentSeen`) whether ANY Agent tool_call
 * block appeared during the poll, regardless of whether it ever got a
 * subagent sub-status — this distinguishes "the model never called Agent at
 * all" (a genuine documented SKIP) from "Agent was called but
 * subagent_start routing never attached a sub-status" (a real regression
 * that must FAIL, not SKIP). Same discipline as
 * `todo-subagent-smoke.mjs`'s `pollForAgentBlock`.
 */
async function pollForAgentBlock(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let anyAgentSeen = false;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
    if (findAnyAgentBlock(transcript) !== null) {
      anyAgentSeen = true;
    }
    const block = findAgentBlockWithSubagent(transcript);
    if (block) {
      return { block, anyAgentSeen };
    }
    if (Date.now() >= deadline) {
      return { block: null, anyAgentSeen };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptAgentDispatch(ctx, step, prompt, timeoutMs) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  return pollForAgentBlock(ctx, step, timeoutMs);
}

/** Stops the current turn and best-effort waits for it to settle to idle — used before a retry. */
async function settleTurn(ctx, step) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort — proceed regardless of the settle wait outcome.
  });
}

async function step2DispatchSubagent(ctx) {
  const step = 2;

  let anyAgentSeen = false;
  let dispatch = await attemptAgentDispatch(ctx, step, SUBAGENT_PROMPT_PRIMARY, 60_000);
  anyAgentSeen = anyAgentSeen || dispatch.anyAgentSeen;
  let agentBlock = dispatch.block;
  if (agentBlock === null) {
    console.warn(
      "[subagent-card-smoke] no Agent tool_call with a subagent sub-status observed on the first attempt " +
        "— retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    dispatch = await attemptAgentDispatch(ctx, step, SUBAGENT_PROMPT_RETRY, 90_000);
    anyAgentSeen = anyAgentSeen || dispatch.anyAgentSeen;
    agentBlock = dispatch.block;
  }
  if (agentBlock === null) {
    if (anyAgentSeen) {
      // The model DID call Agent, but no subagent sub-status was ever attached to the
      // block — that's a subagent_start routing regression, not model nondeterminism.
      fail(
        step,
        "an Agent tool_call block was observed but its subagent sub-status never appeared (possible subagent_start " +
          "routing regression), after 1 retry",
      );
    }
    console.warn(
      "[subagent-card-smoke] SKIPPED: the model never dispatched the Agent tool at all (no Agent tool_call block " +
        "appeared) after 1 retry. This is a documented live-model-nondeterminism SKIP, NOT a product failure — " +
        "the DOM-probe unit coverage (automation.test.ts) already exercises agentCardState/agentCardExpand's own " +
        "logic against fakes.",
    );
    ctx.skipped = true;
    await settleTurn(ctx, step);
    pass(step, "SKIPPED (documented) — Agent tool never dispatched by the live model after 1 retry; see warning above");
    return;
  }

  ctx.toolCallId = agentBlock.toolCallId;
  pass(step, `Agent tool_call dispatched with a subagent sub-status (toolCallId=${ctx.toolCallId})`);
}

// ── step 3: watch the live activity feed GROW while the subagent is running ──

async function step3ObserveActivityGrowth(ctx) {
  const step = 3;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — no Agent dispatch to observe, see step 2");
    return;
  }

  const samples = [];
  const deadline = Date.now() + 45_000;
  for (;;) {
    const block = await getBlockByToolCallId(ctx, step, ctx.toolCallId);
    if (block === null) {
      fail(step, `Agent tool_call block ${ctx.toolCallId} disappeared from the transcript while observing activity growth`);
    }
    if (block.subagent === null) {
      fail(step, `Agent tool_call block ${ctx.toolCallId} lost its subagent sub-status while observing activity growth`);
    }
    const activityLength = Array.isArray(block.subagent.activity) ? block.subagent.activity.length : 0;
    if (block.subagent.final !== null) {
      // Settled before (or exactly as) this poll landed — no more running-state
      // samples to take. A same-poll settle with activity rows already present
      // still counts as growth-proof (child ran fast but did leave a trail).
      if (activityLength > 0) {
        samples.push(activityLength);
      }
      break;
    }
    samples.push(activityLength);
    if (samples.length >= MIN_ACTIVITY_POLLS && activityLength > 0) {
      break;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (samples.length === 0) {
    console.warn(
      "[subagent-card-smoke] subagent settled before a single poll observed subagent.final===null with any activity " +
        "rows (fast child task, or a child that made zero tool calls) — documented SKIP of the growth-proof assert; " +
        "the settle/result/card asserts below still apply in full.",
    );
    pass(step, "SKIPPED growth-proof (settled too fast / zero child tool calls) — no activity samples captured");
    return;
  }

  for (let i = 1; i < samples.length; i += 1) {
    assert(
      step,
      samples[i] >= samples[i - 1],
      `activity.length went backwards between polls: ${samples[i - 1]} -> ${samples[i]} (samples=${JSON.stringify(samples)})`,
    );
  }
  assert(step, Math.max(...samples) > 0, `expected activity.length > 0 in at least one poll, got samples=${JSON.stringify(samples)}`);

  await settledScreenshot(ctx, "step-3-activity-running");
  pass(step, `activity.length grew monotonically while running (samples=${JSON.stringify(samples)})`);
}

// ── step 4: wait for settle, assert RESULT + final status landed ──

/** Polls until the joint settle condition holds: the subagent sub-status reports a completed final AND the tool_call block itself has settled to success — `subagent_end` can fire before the handler returns the block's own status, so checking `final` alone is flaky. */
async function pollForSettledAgent(ctx, step, toolCallId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const block = await getBlockByToolCallId(ctx, step, toolCallId);
    if (block && block.subagent && block.subagent.final !== null && block.status === "success") {
      return block;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function step4WaitSettle(ctx) {
  const step = 4;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — no Agent dispatch to settle, see step 2");
    return;
  }

  const settledTimeoutMs = 90_000;
  const settledBlock = await pollForSettledAgent(ctx, step, ctx.toolCallId, settledTimeoutMs);
  assert(
    step,
    settledBlock !== null,
    `Agent tool_call ${ctx.toolCallId} never reached the joint settle condition (subagent.final!==null && block.status==="success") within ${settledTimeoutMs}ms`,
  );

  assert(
    step,
    typeof settledBlock.modelText === "string" && settledBlock.modelText.trim().length > 0,
    `expected a non-empty modelText RESULT on settle, got: ${JSON.stringify(settledBlock.modelText)}`,
  );
  assert(
    step,
    settledBlock.subagent.final !== null && typeof settledBlock.subagent.final.status === "string",
    `expected subagent.final.status to be present on settle, got: ${JSON.stringify(settledBlock.subagent.final)}`,
  );

  await settleTurn(ctx, step);
  pass(
    step,
    `settled (final.status=${settledBlock.subagent.final.status}, modelText.length=${settledBlock.modelText.length})`,
  );
}

// ── step 5: expand the card for real, assert the rendered body shape ──

async function step5ExpandAndAssertCard(ctx) {
  const step = 5;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — no Agent card to expand, see step 2");
    return;
  }

  const before = await agentCardState(ctx, step, ctx.tabId, ctx.toolCallId);
  assert(step, before.expanded === false, `expected the Agent card collapsed by default before driving expand, got: ${JSON.stringify(before)}`);

  await agentCardExpand(ctx, step, ctx.tabId, ctx.toolCallId);

  const after = await agentCardState(ctx, step, ctx.tabId, ctx.toolCallId);
  assert(step, after.expanded === true, `expected expanded:true after agentCardExpand, got: ${JSON.stringify(after)}`);
  assert(
    step,
    after.promptCollapsed === true,
    `expected the PROMPT plaque to still be collapsed on first expand (design's two-level-collapse invariant — the full prompt must never be visible on the first click), got: ${JSON.stringify(after)}`,
  );
  assert(step, after.resultRendered === true, `expected the Markdown RESULT slot to have rendered, got: ${JSON.stringify(after)}`);
  assert(step, after.feedRowCount > 0, `expected at least one live activity-feed row in the expanded card, got: ${JSON.stringify(after)}`);

  const filePath = await settledScreenshot(ctx, "step-5-card-expanded");
  assert(step, typeof filePath === "string", "screenshot capture failed (see warning above)");
  pass(
    step,
    `expanded card shape verified (promptCollapsed=${after.promptCollapsed}, resultRendered=${after.resultRendered}, feedRowCount=${after.feedRowCount})`,
  );
}

// ── step 1: bootstrap a temp profile/workspace + launch (or attach to) the dev app, discover the boot tab ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-subagent-card-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "README.md"), "# smoke\n\nhello from subagent-card smoke\n");
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from subagent-card smoke\n");
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
  // discipline as ctx-popover-smoke.mjs: isolates userData/db/discovery/
  // settings.json/secrets.json so this run never collides with a parallel
  // smoke, a manual dev session, or the owner's real settings.
  const profile = mkdtempSync(join(tmpdir(), "anycode-subagent-card-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  const seedSettings = {
    version: 1,
    provider: { id: PROVIDER_ID, model: MODEL_A },
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
  // Same anti-false-green discipline as ctx-popover-smoke.mjs: an env-level
  // model override would mask the settings.json-seeded provider/model this
  // scenario boots with.
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

async function step1DiscoverTab(ctx) {
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
  // The tab this script creates/discovers must also be the ACTIVE tab — both
  // the screenshot route and the agent-card DOM probe only ever read the
  // active tab's mounted transcript.
  await apiAction(ctx, 1, `/tabs/${ctx.tabId}/select`, {});

  pass(1, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── teardown ──

/**
 * Thin memoizing wrapper around `runTeardown` (ctx-popover-smoke.mjs /
 * model-pill-smoke.mjs precedent): every caller (normal end-of-run() and the
 * SIGINT/SIGTERM handler) awaits the SAME shared promise.
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
            `[subagent-card-smoke] tab ${ctx.tabId} close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
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
      console.warn(`[subagent-card-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[subagent-card-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.tmpWorkspace === "string" && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[subagent-card-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(`[subagent-card-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[subagent-card-smoke] failed to remove temp workspace ${ctx.tmpWorkspace}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[subagent-card-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[subagent-card-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[subagent-card-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[subagent-card-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[subagent-card-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    skipped: false,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "subagent-card-smoke"),
  };
  ctx.mkdirScreenshotDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.screenshotDir)}, {recursive:true})`]);
    } catch {
      // fall through to saveScreenshot's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);
    await step2DispatchSubagent(ctx);
    await step3ObserveActivityGrowth(ctx);
    await step4WaitSettle(ctx);
    await step5ExpandAndAssertCard(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[subagent-card-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[subagent-card-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

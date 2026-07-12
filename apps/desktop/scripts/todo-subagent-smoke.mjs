/**
 * Live GUI smoke for the P7.4 ToolCallCard additions (design/slice-P7.4-cut.md
 * §3.4): drives a REAL Electron dev instance end-to-end over the automation
 * HTTP channel (`main/automation/*`) and channel-asserts the two product
 * surfaces Wave 1 added to `ToolCallCard.tsx` — the TodoWrite checklist (F1)
 * and the compact collapsed-by-default subagent card (F16).
 *
 * `GET /state` returns the renderer facade's full snapshot
 * (`snapshot.states[tabId].transcript`, an array of `TranscriptBlock`s) — the
 * `tool_call` variant already carries raw `input` (⇒ `input.todos` for a
 * TodoWrite call) and the whole `subagent: SubagentSubStatus | null`
 * sub-status (`turns`, `toolCalls`, `lastTool`, `final`) for an Agent call.
 * Per the cut's §2 wiring note, this slice needed ZERO automation-channel
 * delta — every assert below rides the existing snapshot + `/screenshot`,
 * exactly like `reasoning-ui-smoke.mjs` and `transcript-follow-smoke.mjs`.
 * This script re-implements the `parseTodos` enum/shape check inline (it
 * cannot import the renderer's TypeScript helper) rather than trusting the
 * product's own validator — an honest independent check.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`), matching the `scripts/` precedent — this file is a NEW
 * sibling of the four existing smokes (git/sidebar/reasoning/transcript-follow),
 * not an edit of any of them.
 *
 * Usage:   node apps/desktop/scripts/todo-subagent-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch (git-ui-smoke

 *   --keep         Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires a configured provider (ambient env ANYCODE_API_KEY / ANYCODE_MODEL /
 * ANYCODE_BASE_URL already set by the caller, OR a pre-configured default
 * profile reached via --attach) capable of following explicit tool-use
 * instructions (TodoWrite, Agent).
 *
 * Each of the 4 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. Both the TodoWrite (F1) and subagent (F16) legs
 * allow exactly ONE prompt retry (live-model nondeterminism — design §3.4)
 * before failing red; shape/counter asserts themselves never retry-until-green.
 * If the model never dispatches the Agent tool at all after the retry, step 4
 * reports a documented SKIP (exit 0, F1 leg already asserted+screenshotted) —
 * per the cut's model-dependency note, this is a live-model limitation, not a
 * product failure, and is logged loudly rather than silently passed.
 * PNG evidence is written to `apps/desktop/out/todo-subagent-smoke/*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 4;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;
const MIN_RUNNING_POLLS = 2;

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

const TODOWRITE_PROMPT_PRIMARY =
  "Create a plan with exactly 3 items using TodoWrite (each item is a short task description), " +
  "mark the FIRST item in_progress and the rest pending. Then, in a SECOND separate TodoWrite " +
  "call, repeat the same 3-item list but change the first item's status to completed. Use TodoWrite " +
  "both times. Do nothing except these two TodoWrite calls: do not create or read files.";
const TODOWRITE_PROMPT_RETRY =
  "Use the TodoWrite tool now. Call TodoWrite with a plan of exactly 3 items, marking the first item's " +
  '"status" as "in_progress" and the other two as "pending". Then call TodoWrite a SECOND time with the ' +
  'same 3 items but the first item\'s "status" changed to "completed". You must use the TodoWrite tool for ' +
  "both calls. Do not do anything else — no files, no other tools.";

const SUBAGENT_PROMPT_PRIMARY =
  "Start a subagent using the Agent tool with a short task: list the names of files and directories " +
  "at the root of the current working directory and return the list. Use the Agent tool specifically; " +
  "do not read the directory directly yourself.";
const SUBAGENT_PROMPT_RETRY =
  "Use the Agent tool now to dispatch a subagent. Give the subagent this short task: list the file and " +
  "folder names in the current working directory's root and return the list. You must invoke the Agent " +
  "tool yourself for this — do not read the directory directly.";

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
      console.warn(`[todo-subagent-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from transcript-follow-smoke.mjs) ──

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

/**
 * Poll `GET /state` until the renderer facade has finished installing (same
 * rationale as sidebar-ui-smoke.mjs: DEV dynamic import races the page load).
 */
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
      console.warn(`[todo-subagent-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[todo-subagent-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
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

async function sendPrompt(ctx, step, prompt) {
  const result = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, result?.ok === true, `prompt send rejected: ${JSON.stringify(result)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
}

/** Stops the current turn and best-effort waits for it to settle to idle — used between retries/legs. */
async function settleTurn(ctx, step) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort — proceed regardless of the settle wait outcome.
  });
}

// ── F1 leg: TodoWrite checklist round-trip (design §3.4 step 2) ──

/** Independent re-implementation of ToolCallCard's `parseTodos` fail-soft shape check — the script cannot import TS. */
function isValidTodoList(todos) {
  if (!Array.isArray(todos)) {
    return false;
  }
  for (const item of todos) {
    if (item === null || typeof item !== "object") {
      return false;
    }
    if (typeof item.content !== "string" || item.content.trim().length === 0) {
      return false;
    }
    if (typeof item.status !== "string" || !TODO_STATUSES.has(item.status)) {
      return false;
    }
  }
  return true;
}

function findToolCallBlocks(transcript, toolName) {
  return transcript.filter((b) => b.kind === "tool_call" && b.toolName === toolName);
}

/** Snapshots the toolCallIds of every TodoWrite block seen so far — the per-attempt baseline that keeps a retry's transcript reads from re-matching a prior attempt's blocks. */
async function getExistingTodoWriteIds(ctx, step) {
  const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return new Set(findToolCallBlocks(transcript, "TodoWrite").map((b) => b.toolCallId));
}

async function pollForFirstTodoWrite(ctx, step, timeoutMs, excludeIds) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = findToolCallBlocks(transcript, "TodoWrite").find(
      (b) => b.status === "success" && !excludeIds.has(b.toolCallId),
    );
    if (block) {
      return block;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Polls for the SECOND (different toolCallId, not part of `excludeIds`) TodoWrite
 * block of this attempt — the earliest one to appear, by toolCallId, after
 * `firstBlock`. Once that specific block reaches `status: "success"` it is
 * validated immediately (shape, same item count as the first call, and a
 * flipped status vs the first call) — a malformed or mismatched second call
 * fails the step right here instead of being silently skipped until the
 * overall leg times out and masquerades as a prompt-retry case.
 */
async function pollForSecondTodoWrite(ctx, step, firstBlock, timeoutMs, excludeIds) {
  const deadline = Date.now() + timeoutMs;
  let targetToolCallId = null;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const newBlocks = findToolCallBlocks(transcript, "TodoWrite").filter(
      (b) => b.toolCallId !== firstBlock.toolCallId && !excludeIds.has(b.toolCallId),
    );
    if (newBlocks.length > 0) {
      if (targetToolCallId === null) {
        targetToolCallId = newBlocks[0].toolCallId;
      }
      const target = newBlocks.find((b) => b.toolCallId === targetToolCallId);
      if (target && target.status === "success") {
        const todos = target.input?.todos;
        assert(
          step,
          isValidTodoList(todos),
          `second TodoWrite input.todos failed shape validation: ${JSON.stringify(target.input)}`,
        );
        const initialTodos = firstBlock.input?.todos ?? [];
        assert(
          step,
          todos.length === initialTodos.length,
          `second TodoWrite item count (${todos.length}) does not match the first call's (${initialTodos.length}) — expected a same-size replace-all`,
        );
        const key = (item) => (item?.id !== undefined && item?.id !== null ? `id:${item.id}` : `content:${item?.content}`);
        const initialStatus = new Map(initialTodos.map((t) => [key(t), t.status]));
        const flipped = todos.some((t) => initialStatus.has(key(t)) && initialStatus.get(key(t)) !== t.status);
        assert(
          step,
          flipped,
          `second TodoWrite did not flip any item's status vs the first call: ${JSON.stringify(todos)}`,
        );
        return target;
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptF1Leg(ctx, step, prompt, firstTimeoutMs, secondTimeoutMs, excludeIds) {
  await sendPrompt(ctx, step, prompt);
  const firstBlock = await pollForFirstTodoWrite(ctx, step, firstTimeoutMs, excludeIds);
  if (firstBlock === null) {
    return null;
  }
  const secondBlock = await pollForSecondTodoWrite(ctx, step, firstBlock, secondTimeoutMs, excludeIds);
  if (secondBlock === null) {
    return null;
  }
  return { firstBlock, secondBlock };
}

async function step3F1Leg(ctx) {
  const step = 3;
  let excludeIds = await getExistingTodoWriteIds(ctx, step);
  let result = await attemptF1Leg(ctx, step, TODOWRITE_PROMPT_PRIMARY, 60_000, 60_000, excludeIds);
  if (result === null) {
    console.warn(
      "[todo-subagent-smoke] F1 leg: no complete TodoWrite round-trip (success block + flipped-status replace-all " +
        "block) observed on the first attempt — retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    // Re-baseline against everything seen so far (including attempt 1's blocks) so the
    // retry's first/second matching never re-picks up a prior attempt's TodoWrite calls.
    excludeIds = await getExistingTodoWriteIds(ctx, step);
    result = await attemptF1Leg(ctx, step, TODOWRITE_PROMPT_RETRY, 90_000, 90_000, excludeIds);
  }
  if (result === null) {
    fail(step, "TodoWrite round-trip (first success block + second flipped-status replace-all block) never observed, after 1 retry");
  }

  const { firstBlock, secondBlock } = result;

  const firstTodos = firstBlock.input?.todos;
  assert(
    step,
    Array.isArray(firstTodos) && firstTodos.length >= 2 && isValidTodoList(firstTodos),
    `first TodoWrite input.todos failed shape validation (>=2 items, valid content/status): ${JSON.stringify(firstBlock.input)}`,
  );

  // secondBlock was already shape/count/flip-validated inline by pollForSecondTodoWrite.

  await settleTurn(ctx, step);
  await saveScreenshot(ctx, "f1-todo-checklist");
  pass(
    step,
    `TodoWrite round-trip observed (first toolCallId=${firstBlock.toolCallId} with ${firstTodos.length} items, ` +
      `second toolCallId=${secondBlock.toolCallId} showing a flipped status)`,
  );
}

// ── F16 leg: compact subagent card round-trip (design §3.4 step 3) ──

function findAnyAgentBlock(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent") ?? null;
}

function findAgentBlockWithSubagent(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && b.subagent !== null) ?? null;
}

/**
 * Polls for an Agent tool_call block that has picked up a subagent sub-status.
 * Also tracks (via `anyAgentSeen`) whether ANY Agent tool_call block appeared
 * during the poll, regardless of whether it ever got a subagent sub-status —
 * this distinguishes "the model never called Agent at all" (a genuine
 * documented SKIP) from "Agent was called but subagent_start routing never
 * attached a sub-status" (a real regression that must FAIL, not SKIP).
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
  await sendPrompt(ctx, step, prompt);
  return pollForAgentBlock(ctx, step, timeoutMs);
}

async function getBlockByToolCallId(ctx, step, toolCallId) {
  const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return transcript.find((b) => b.kind === "tool_call" && b.toolCallId === toolCallId) ?? null;
}

/**
 * While `subagent.final === null`, samples `turns`/`toolCalls` up to
 * `minPolls` times, so callers can assert they never go backwards (live
 * progress line data-proof, design §3.4 step 3). `settledEarly: true` means
 * NOT EVEN ONE poll observed `subagent.final === null` (the subagent settled
 * between the dispatch and the very first poll) — that's the only case where
 * there is zero running-progress data to assert on or screenshot. Settling
 * after 1+ samples but before `minPolls` still counts as running-proof
 * observed (`settledEarly: false`).
 */
async function observeRunningProgress(ctx, step, toolCallId, minPolls, timeoutMs) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const block = await getBlockByToolCallId(ctx, step, toolCallId);
    if (block === null) {
      fail(step, `Agent tool_call block ${toolCallId} disappeared from the transcript while observing running progress`);
    }
    if (block.subagent === null) {
      fail(step, `Agent tool_call block ${toolCallId} lost its subagent sub-status while observing running progress`);
    }
    if (block.subagent.final !== null) {
      return { samples, settledEarly: samples.length === 0 };
    }
    samples.push({ turns: block.subagent.turns, toolCalls: block.subagent.toolCalls });
    if (samples.length >= minPolls || Date.now() >= deadline) {
      return { samples, settledEarly: false };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Polls until the joint settle condition holds: the subagent sub-status reports a completed final AND the tool_call block itself has settled to success — `subagent_end` can fire before the handler returns the block's own status, so checking `final` alone is flaky. */
async function pollForSettledAgent(ctx, step, toolCallId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const block = await getBlockByToolCallId(ctx, step, toolCallId);
    if (
      block &&
      block.subagent &&
      block.subagent.final !== null &&
      block.subagent.final.status === "completed" &&
      block.status === "success"
    ) {
      return block;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function step4F16Leg(ctx) {
  const step = 4;

  let anyAgentSeen = false;
  let dispatch = await attemptAgentDispatch(ctx, step, SUBAGENT_PROMPT_PRIMARY, 60_000);
  anyAgentSeen = anyAgentSeen || dispatch.anyAgentSeen;
  let agentBlock = dispatch.block;
  if (agentBlock === null) {
    console.warn(
      "[todo-subagent-smoke] F16 leg: no Agent tool_call with a subagent sub-status observed on the first attempt " +
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
      "[todo-subagent-smoke] SKIPPED F16 leg: the model never dispatched the Agent tool at all (no Agent tool_call " +
        "block appeared) after 1 retry. This is a documented live-model-nondeterminism SKIP per " +
        "design/slice-P7.4-cut.md §3.4, NOT a product failure — the F1 leg (step 3) already asserted the TodoWrite " +
        "round-trip and captured its screenshot.",
    );
    await settleTurn(ctx, step);
    pass(step, "SKIPPED (documented) — Agent tool never dispatched by the live model after 1 retry; see warning above");
    return;
  }

  const { samples, settledEarly } = await observeRunningProgress(ctx, step, agentBlock.toolCallId, MIN_RUNNING_POLLS, 30_000);
  let runningProofNote;
  if (settledEarly) {
    runningProofNote = "SKIPPED running-proof (settled too fast, 0 polls observed subagent.final===null)";
    console.warn(
      "[todo-subagent-smoke] subagent settled before a single running poll could observe subagent.final===null " +
        "(fast child task) — no running-progress data captured; documented SKIP of the running-proof assert and " +
        "screenshot only, the leg's block asserts below still apply in full",
    );
  } else {
    for (let i = 1; i < samples.length; i += 1) {
      assert(
        step,
        samples[i].turns >= samples[i - 1].turns && samples[i].toolCalls >= samples[i - 1].toolCalls,
        `subagent progress counters went backwards between polls: ${JSON.stringify(samples[i - 1])} -> ${JSON.stringify(samples[i])}`,
      );
    }
    runningProofNote = `running-proof observed (${samples.length} poll(s) with subagent.final===null)`;
    await saveScreenshot(ctx, "f16-subagent-running");
  }

  const settledTimeoutMs = 60_000;
  const settledBlock = await pollForSettledAgent(ctx, step, agentBlock.toolCallId, settledTimeoutMs);
  assert(
    step,
    settledBlock !== null,
    `Agent tool_call ${agentBlock.toolCallId} never reached the joint settle condition (subagent.final.status==="completed" && block.status==="success") within ${settledTimeoutMs}ms`,
  );

  await settleTurn(ctx, step);
  await saveScreenshot(ctx, "f16-subagent-settled");
  pass(
    step,
    `subagent observed running->completed (toolCallId=${agentBlock.toolCallId}, ${runningProofNote}, ` +
      `turns=${settledBlock.subagent.turns}, toolCalls=${settledBlock.subagent.toolCalls})`,
  );
}

// ── step 1: bootstrap a temp workspace + launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-todo-subagent-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "seed.txt"), "hello from todo-subagent smoke\n");
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

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

  // Per-run disposable profile (design/slice-P7.H-cut.md §4.4): isolates
  // userData/db/discovery so this run never collides with a parallel smoke
  // or manual dev session.
  const profile = mkdtempSync(join(tmpdir(), "anycode-todo-subagent-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_WORKSPACE: ctx.tmpWorkspace,
  };
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

// ── step 2: discover/create the tab for the temp workspace ──

async function step2DiscoverTab(ctx) {
  await waitForFacade(ctx, 2);

  if (ctx.child === null) {
    // --attach: the foreign instance did not boot with our workspace — create
    // a tab for it explicitly via the main-plane dialog-bypass route.
    const created = await apiOk(ctx, 2, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    if (created?.ok !== true) {
      fail(2, `tab creation failed: ${JSON.stringify(created)}`);
    }
    ctx.tabId = created.tabId;
  } else {
    // Deterministic boot: main opens the boot auto-tab AS our workspace
    // (ANYCODE_WORKSPACE set in step 1).
    ctx.tabId = await discoverTabByWorkspace(ctx, 2, ctx.tmpWorkspace);
  }

  await waitUntilTab(ctx, 2, ctx.tabId, { connection: "ready" });
  // The tab this script creates/discovers must also be the ACTIVE tab — the
  // screenshot route renders the active tab's DOM only.
  await apiAction(ctx, 2, `/tabs/${ctx.tabId}/select`, {});
  pass(2, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  // An unsuccessful /close (e.g. {ok:false, reason:"last_tab"}) leaves the tab
  // (and the app it lives in) alive pointed at the temp workspace — only
  // meaningful on the --attach path (ctx.child is null there); the owned-app
  // path quits the whole process instead of closing one tab, so the temp
  // workspace is safe to remove regardless.
  let tabCloseFailed = false;

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else if (ctx.tabId) {
        const closeResp = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
        if (closeResp.body?.ok !== true) {
          tabCloseFailed = true;
          console.warn(
            `[todo-subagent-smoke] tab close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
              `a tab is still open on the temp workspace; leaving it on disk instead of deleting out from under it`,
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
      console.warn(`[todo-subagent-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[todo-subagent-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.tmpWorkspace && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[todo-subagent-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(
        `[todo-subagent-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`,
      );
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[todo-subagent-smoke] failed to remove temp workspace: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[todo-subagent-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[todo-subagent-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[todo-subagent-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[todo-subagent-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[todo-subagent-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "todo-subagent-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step2DiscoverTab(ctx);
    await step3F1Leg(ctx);
    await step4F16Leg(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[todo-subagent-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[todo-subagent-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

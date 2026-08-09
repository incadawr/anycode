/**
 * Live smoke for TASK.102 CUT-S2 §4.2 пп.9,10,11 (S2d D3) — the track's race
 * probes. Drives a REAL Electron dev instance end-to-end over the automation
 * HTTP channel and proves four things a synchronous fake-fork unit test
 * cannot (`tabs.test.ts`'s admission-atomicity/drain matrix uses a FAKE
 * `fork` — CUT-S2 §5.1's own anti-facade risk: "юниты main НЕ доказывают
 * parentPort-провод, boot-argv, отдельный SQLite-коннект"):
 *
 *   A. §4.2 п.10 (per-parent half): 4 REAL `Agent(tier:"session")` calls
 *      issued by a live model IN ONE TURN admit exactly 3 (three genuinely
 *      live, distinct OS pids) and refuse the 4th with the VERBATIM §2.7
 *      `limit_parent` text (`main/tabs.ts:99-100`) — never a queued retry:
 *      the 3 admitted children are left to finish on their own and the
 *      refused 4th is proven to NEVER start afterward (main's `spawnChild`
 *      has no queue data structure at all — `reject()` is a terminal
 *      action — so this is a structural guarantee, checked live by polling
 *      the tab's childRuns back to 0 after the 3 finish and confirming it
 *      stays 0, not just asserted from reading the source).
 *   B. §4.2 п.9 (cascade half): closing a root tab with a REAL running
 *      child cascades — the child's OS pid dies (`isPidAlive` polled to
 *      false), the ledger entry disappears (slot freed) — and resuming the
 *      CLOSED session afterward shows the parent's own Agent tool_call card
 *      in status "cancelled" (`.tool-call-status-badge` "Cancelled"), a
 *      REAL renderer geometry + PNG, not a transcript-JSON-only claim
 *      (anti-facade §5.4's "DOM-presence ≠ visibility" applies here exactly
 *      as it did to S2d/D2's child-pane checks).
 *   C. §4.2 п.11: an EXTERNAL `SIGKILL` on the child's own OS pid (this
 *      script's own `process.kill`, never an app-internal lever — the
 *      point is proving main's exit-detection survives a kill it did not
 *      initiate) lands the parent's card in status "error" with the exact
 *      §2.7 `CHILD_HOST_EXITED_MESSAGE` text, within an explicit timeout —
 *      "eternal running" is a FAIL only a deadline can catch, so the poll
 *      below has one and treats exhausting it as red, not as "still
 *      settling."
 *   D. Anti-facade §5.8's own named risk ("Close-тест без гонки: `spawn;
 *      await; close` не ловит spawn в окне closing"): a spawn detected the
 *      INSTANT it is admitted (tight polling, no `await turnStatus running`
 *      first) is raced by an immediate `close` fired in the very next line
 *      — the closest a black-box HTTP driver can get to "a spawn flying in
 *      around close" without white-box control of main's event loop. The
 *      invariant proven is orphan-freedom: the child's OS pid (captured at
 *      the moment of admission, before close is even sent) is confirmed
 *      dead afterward, and the ledger/tab entries are confirmed gone.
 *
 * Global limit 8 (§4.2 п.10's second half) is NOT exercised live here — it
 * needs 3 separate root tabs summing to 9 spawns, and per this slice's own
 * cut text ("если живьём не вытянешь, НЕ подделывай: доложи честно") that
 * is reported honestly rather than faked: it IS covered by
 * `apps/desktop/src/main/tabs.test.ts`, the test named "the 9th global
 * spawn (spread across 3 parents, each under ITS OWN per-parent cap) is
 * refused limit_global" (asserts the exact §2.7 `limit_global` text and
 * `hosts` count, real per-parent caps of 3/3/2 summing to 8).
 *
 * REUSE (same discipline as `child-session-scenario-smoke.mjs`, S2d D2 —
 * the seam is exports, not a rewrite): every generic process/fs/HTTP/
 * dispatch helper below is IMPORTED, unmodified, from the already-green
 * `child-session-explicit-provider-smoke.mjs`. `step1LaunchApp` is reused
 * UNMODIFIED for the whole launch/profile/settings-seed sequence (the same
 * real v2 `provider.connections[]` seed — the "ГРАБЛИ" lesson: only that
 * file's seed round-trips the current settings schema). `attemptDispatch`/
 * `settleTurn`/`waitUntilTab` are reused for EVERY probe's dispatch by
 * temporarily pointing the shared `ctx.tabId` at whichever tab is currently
 * being dispatched to — safe because this script runs every probe fully
 * SEQUENTIALLY (never two dispatches in flight at once), documented at each
 * call site.
 *
 * NOT reused (deliberately): the CDP client and `pollUntil`/
 * `reserveUnusedPort` are written fresh (same ~45-line, product-code-free
 * shape `child-session-scenario-smoke.mjs` already established for this
 * exact command surface) because neither script exports them; this
 * script's own teardown/result-json trio is local (not the imported one)
 * for the same reason D2 gives — reusing it verbatim would silently
 * overwrite `evidence/S2/result.json`, the standing closing evidence for
 * F4 (§10.10.4) recorded in STATE.md. This script writes its own
 * `evidence/S2/race-result.json` instead.
 *
 * DESIGN NOTE — probes run independently, not fail-fast: unlike the linear
 * D1/D2 harnesses (step N assumes step N-1 succeeded), A/B/C/D here are 4
 * disjoint race probes sharing one app instance purely for launch-cost
 * amortization. Each is wrapped in its own try/catch; one probe's FAIL does
 * NOT abort the others — this is deliberately MORE informative than
 * fail-fast for a race-probe suite (CUT-S2's own framing: "Гоночные пробы —
 * ровно то место, где продукт может реально треснуть"), and the exit code
 * still reflects the worst outcome across all four.
 *
 * Usage:   node apps/desktop/scripts/child-session-race-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspace/profile on exit (debugging).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider, read (by the
 * reused `step1LaunchApp`) from `.smoke-secrets/glm.env`, same file every
 * other live smoke in this repo uses.
 *
 * Each probe prints `[probe X] PASS/FAIL/SKIP <detail>`. Evidence (PNGs for
 * B/C + a JSON result dump) lands in `working-docs/task102-track/evidence/S2/`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SmokeFailure,
  api,
  apiAction,
  apiOk,
  assert,
  attemptDispatch,
  fail,
  getTranscriptBlocks,
  isPidAlive,
  killTree,
  saveScreenshot,
  settleTurn,
  sleep,
  step1DiscoverTab,
  step1LaunchApp,
  waitForExit,
  waitUntilTab,
} from "./child-session-explicit-provider-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const EVIDENCE_DIR = join(repoRoot, "working-docs", "task102-track", "evidence", "S2");
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const FLAGS = { keep: process.argv.slice(2).includes("--keep") };

// ── §2.7 verbatim texts (CUT-S2 §2.7 / `main/tabs.ts:99-133`) — copied, not
// imported (main is not an importable module from a script; these are the
// exact frozen strings review checks byte-for-byte). ──
const CHILD_LIMIT_PARENT_MESSAGE =
  'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".';
const CHILD_HOST_EXITED_MESSAGE = "Agent: the child session host exited before completing.";
/**
 * `shared/child-sessions.ts:171` — the deadline main gives an admitted child
 * to send `child-ready` before `handleChildStartTimeout` reaps it as
 * `not_ready`/timeout. A drain-wait shorter than this can go red for a
 * reason that has nothing to do with the per-parent-limit invariant this
 * probe exists to check: run 1 of this harness hit exactly that (2 of 3
 * concurrently-forked children lost a real SQLite write-lock race during
 * their own `createSession` — "database is locked", no `busy_timeout` set
 * anywhere in `packages/core/src/adapters/node/sqlite-persistence.ts` — and
 * were only reaped once this FULL deadline elapsed, not on their own 8s
 * sleep). See this run's own report under "КРАСНОЕ" for the finding; the
 * fix here is a correct wait, not a queue-forgiving one.
 */
const CHILD_START_DEADLINE_MS = 30_000;

// ── small local helpers (generic poll + port reservation — same shape
// `child-session-scenario-smoke.mjs` already established for this exact
// need; neither existing script exports them) ──

function reserveUnusedPort() {
  return new Promise((resolveReserved, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolveReserved(port));
    });
  });
}

async function pollUntil(timeoutMs, intervalMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(intervalMs);
  }
}

// ── CDP client (Node 22 global WebSocket/fetch, zero deps) — fresh, same
// technique as `child-session-scenario-smoke.mjs`'s own (not exported there). ──

async function cdpConnect(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
      if (target) break;
    } catch {
      // CDP endpoint not up yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`no CDP page target on port ${port} within ${timeoutMs}ms`);
    }
    await sleep(400);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = () => resolveOpen();
    ws.onerror = () => rejectOpen(new Error("CDP websocket failed to open"));
  });
  const pending = new Map();
  let nextId = 1;
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: resolveMsg } = pending.get(msg.id);
      pending.delete(msg.id);
      resolveMsg(msg);
    }
  };
  return {
    async eval(expression) {
      const id = nextId++;
      const msg = await new Promise((resolveMsg, rejectMsg) => {
        pending.set(id, { resolve: resolveMsg });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rejectMsg(new Error("CDP eval timed out (20s)"));
          }
        }, 20_000);
      });
      if (msg.error) {
        throw new Error(`CDP protocol error: ${JSON.stringify(msg.error)}`);
      }
      if (msg.result?.exceptionDetails) {
        throw new Error(`CDP page exception: ${JSON.stringify(msg.result.exceptionDetails).slice(0, 600)}`);
      }
      return msg.result?.result?.value;
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed.
      }
    },
  };
}

/**
 * Locates the Agent tool_call card by `data-tool-call-id` (the automation
 * probe's own DOM hook, `ToolCallCard.tsx:889`) and reads its geometry + the
 * ALWAYS-visible (even collapsed) `.tool-call-status-badge` text
 * (`ToolCallCard.tsx:923` — the badge lives in the toggle row, not just the
 * expanded body, precisely so a collapsed-by-default card is still provably
 * showing its status). `elementFromPoint` at the card's own center lands
 * INSIDE the card — the same anti-facade discriminator (DOM-presence ≠
 * visibility) `child-session-scenario-smoke.mjs` established for the child
 * pane.
 */
function cardGeometryJs(toolCallId) {
  const idLiteral = JSON.stringify(toolCallId);
  return `(() => {
    const id = ${idLiteral};
    const card = Array.from(document.querySelectorAll('[data-tool-call-id]')).find(
      (el) => el.getAttribute('data-tool-call-id') === id,
    );
    if (!card) return { ok: false, reason: 'no_card' };
    const badge = card.querySelector('.tool-call-status-badge');
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      ok: true,
      className: card.className,
      badgeText: badge ? badge.textContent : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      offsetHeight: card.offsetHeight,
      hitInsideCard: hit ? (card.contains(hit) || hit === card) : false,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  })()`;
}

// ── prompts ──

function spawnOnePrompt(sleepSeconds, label, retry) {
  if (!retry) {
    return (
      'Call the Agent tool exactly once, right now, in this turn. Use these exact parameter values: ' +
      `tier: "session", agent_type: "general-purpose", description: "${label}", ` +
      'and prompt: an instruction telling the subagent to FIRST call the Bash tool with the exact command ' +
      `"sleep ${sleepSeconds}" and wait for it to finish, and ONLY THEN reply with exactly the single word DONE ` +
      'and use no further tools. You MUST include the tier parameter set to the literal string "session" — do ' +
      'not omit it, and do not use tier "inline". Invoke the tool now.'
    );
  }
  return (
    'You did not call the Agent tool with the required tier parameter. The Agent tool you have access to ' +
    'accepts a `tier` parameter, and for a real child session it must be the literal string "session". Call it ' +
    `NOW with tier set to "session", agent_type set to "general-purpose", description "${label}", and a prompt ` +
    `instructing the subagent to first run the Bash tool with the command "sleep ${sleepSeconds}", wait for it ` +
    'to finish, then reply with exactly the single word DONE and use no further tools. You must invoke the tool ' +
    'itself, with a real tool call — do not just describe what you would do.'
  );
}

function spawnQuadPrompt(sleepSeconds, retry) {
  if (!retry) {
    return (
      'In this SAME turn, call the Agent tool FOUR SEPARATE times — four distinct real tool calls, not one call ' +
      'described four ways, and not four calls spread across separate turns. For EACH of the four calls use ' +
      'tier: "session", agent_type: "general-purpose", a short description ("Race probe 1" through "Race probe ' +
      `4"), and a prompt telling the subagent to run the Bash tool with the exact command "sleep ${sleepSeconds}", ` +
      'wait for it to finish, then reply with exactly the single word DONE and use no further tools. Issue all ' +
      'four tool calls now, in this one turn, without waiting for any of their individual results in between. ' +
      'You MUST include tier:"session" on all four — do not use tier "inline" for any of them.'
    );
  }
  return (
    'You did not issue four separate Agent tool calls in one turn. Try again: in THIS turn, call the Agent tool ' +
    'FOUR separate times (four distinct tool invocations in the same response), each with tier set to the ' +
    'literal string "session", agent_type "general-purpose", a short distinct description, and a prompt telling ' +
    `the subagent to run Bash "sleep ${sleepSeconds}" then reply DONE. Do not describe what you would do — issue ` +
    'four real tool calls, right now, in this one turn.'
  );
}

// ── shared small utilities ──

function hasSessionTierInput(block) {
  const input = block?.input;
  return input !== null && typeof input === "object" && input.tier === "session";
}

function findSessionAgentBlocks(transcript) {
  return transcript.filter((b) => b.kind === "tool_call" && b.toolName === "Agent" && hasSessionTierInput(b));
}

const NON_TERMINAL_STATUSES = new Set(["proposed", "running"]);

function isTerminalStatus(status) {
  return !NON_TERMINAL_STATUSES.has(status);
}

/** Creates a fresh root tab via the sanctioned dialog-bypass route (README §"Action plane"). */
async function createRootTab(ctx, step, workspace) {
  const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace });
  assert(step, created?.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  await waitUntilTab(ctx, step, created.tabId, { connection: "ready" });
  return { tabId: created.tabId, sessionId: created.sessionId };
}

/**
 * How many times a single-spawn probe re-asks the live model before it gives
 * up with a documented SKIP. The base harness asks twice (initial + one
 * retry); probes B and C need the model to volunteer ONE
 * `Agent(tier:"session")` call and skipped on two separate runs at that
 * budget, while §10.14.7 п.3 needs them to actually execute. The extra
 * attempt only re-asks — no assertion below is relaxed, and the skip reason
 * carries the attempt count so a SKIP is never readable as proof.
 */
const DISPATCH_ATTEMPTS = 3;

/**
 * Dispatches ONE `Agent(tier:"session")` call on `tabId`, reusing the base
 * harness's `attemptDispatch`/`settleTurn` by temporarily pointing the
 * shared `ctx.tabId` at this probe's own tab — safe because this script
 * never has two dispatches in flight at once (fully sequential probes).
 * Same retry-then-documented-SKIP discipline as
 * `child-session-explicit-provider-smoke.mjs`/`child-session-scenario-smoke.mjs`,
 * widened to `DISPATCH_ATTEMPTS` asks.
 */
async function dispatchOneSpawn(ctx, step, tabId, sleepSeconds, label) {
  const priorTabId = ctx.tabId;
  ctx.tabId = tabId;
  try {
    let result = await attemptDispatch(ctx, step, spawnOnePrompt(sleepSeconds, label, false), 60_000);
    let anyAgentSeen = result.anyAgentSeen;
    let attempts = 1;

    while (attempts < DISPATCH_ATTEMPTS && !hasSessionTierInput(result.block) && result.childRuns.length === 0) {
      console.warn(
        `[child-session-race-smoke] probe ${step}: tier:"session" not seen on attempt ${attempts} — ` +
          `retrying (attempt ${attempts + 1} of ${DISPATCH_ATTEMPTS})`,
      );
      await settleTurn(ctx, step);
      result = await attemptDispatch(ctx, step, spawnOnePrompt(sleepSeconds, label, true), 90_000);
      anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
      attempts += 1;
    }

    if (!anyAgentSeen) {
      await settleTurn(ctx, step);
      return { skipped: true, reason: `model never called Agent (${attempts} of ${DISPATCH_ATTEMPTS} attempts)` };
    }
    if (!hasSessionTierInput(result.block) && result.childRuns.length === 0) {
      await settleTurn(ctx, step);
      return { skipped: true, reason: `model did not use tier:"session" (${attempts} of ${DISPATCH_ATTEMPTS} attempts)` };
    }
    if (result.childRuns.length === 0) {
      fail(step, `Agent(tier:"session") dispatched but never admitted (childRuns empty). Block: ${JSON.stringify(result.block)}`);
    }
    return { skipped: false, toolCallId: result.block.toolCallId, entry: result.childRuns[0] };
  } finally {
    ctx.tabId = priorTabId;
  }
}

// ── probe A (§4.2 п.10, per-parent half): 4 spawns one turn -> 3 admitted + 1 refused ──

async function probeA(ctx) {
  const step = "A";
  const tab = await createRootTab(ctx, step, ctx.tmpWorkspace);
  const priorTabId = ctx.tabId;
  ctx.tabId = tab.tabId;
  const SLEEP_S = 8;
  try {
    let result = await attemptDispatch(ctx, step, spawnQuadPrompt(SLEEP_S, false), 60_000);
    let anyAgentSeen = result.anyAgentSeen;
    let before = new Set();

    let sessionBlocks = findSessionAgentBlocks((await getTranscriptBlocks(ctx, step, tab.tabId)).transcript);
    if (sessionBlocks.length !== 4) {
      console.warn(
        `[child-session-race-smoke] probe A: expected 4 tier:"session" Agent calls in one turn, got ${sessionBlocks.length} — retrying once`,
      );
      before = new Set(sessionBlocks.map((b) => b.toolCallId));
      await settleTurn(ctx, step);
      result = await attemptDispatch(ctx, step, spawnQuadPrompt(SLEEP_S, true), 90_000);
      anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
    }

    if (!anyAgentSeen) {
      await settleTurn(ctx, step);
      return { name: "A", status: "SKIP", detail: "model never called Agent at all, after 1 retry" };
    }

    // Re-read after the (possible) retry, isolating this attempt's OWN blocks
    // from anything a failed first attempt left behind.
    sessionBlocks = findSessionAgentBlocks((await getTranscriptBlocks(ctx, step, tab.tabId)).transcript).filter(
      (b) => !before.has(b.toolCallId),
    );
    if (sessionBlocks.length !== 4) {
      await settleTurn(ctx, step);
      return {
        name: "A",
        status: "SKIP",
        detail: `model never issued exactly 4 tier:"session" Agent calls in one turn after 1 retry (got ${sessionBlocks.length})`,
      };
    }

    // Stability check (anti-facade §5.9's own risk: "надо мерить, когда все
    // четыре запроса УЖЕ обработаны, иначе намеришь 3 просто потому, что
    // четвёртый не успел"): poll until the split settles to 3 non-terminal +
    // 1 terminal and STAYS that way across a second read.
    const stable = await pollUntil(20_000, 300, async () => {
      const { transcript, childRuns } = await getTranscriptBlocks(ctx, step, tab.tabId);
      const ids = new Set(sessionBlocks.map((b) => b.toolCallId));
      const blocks = transcript.filter((b) => ids.has(b.toolCallId));
      if (blocks.length !== 4) return undefined;
      const nonTerminal = blocks.filter((b) => !isTerminalStatus(b.status));
      const terminal = blocks.filter((b) => isTerminalStatus(b.status));
      if (nonTerminal.length !== 3 || terminal.length !== 1) return undefined;
      return { blocks, nonTerminal, terminal, childRuns };
    });
    assert(step, stable !== null, "the 4-block split never settled to 3 non-terminal + 1 terminal within 20s");
    await sleep(500);
    const second = (await getTranscriptBlocks(ctx, step, tab.tabId));
    const idsSet = new Set(sessionBlocks.map((b) => b.toolCallId));
    const secondBlocks = second.transcript.filter((b) => idsSet.has(b.toolCallId));
    const secondNonTerminal = secondBlocks.filter((b) => !isTerminalStatus(b.status));
    const secondTerminal = secondBlocks.filter((b) => isTerminalStatus(b.status));
    assert(
      step,
      secondNonTerminal.length === 3 && secondTerminal.length === 1,
      `split was NOT stable across a second read 500ms later: first=${stable.nonTerminal.length}running/${stable.terminal.length}term, second=${secondNonTerminal.length}running/${secondTerminal.length}term`,
    );

    // PID arithmetic: exactly 3 childRuns entries, each a genuinely live,
    // distinct OS pid, distinct from the parent's own pid.
    const rootSummary = (second.mainTabs ?? []).find((t) => t.tabId === tab.tabId);
    assert(step, rootSummary !== undefined, "root tab missing from /state's main-plane tabs");
    assert(step, second.childRuns.length === 3, `expected exactly 3 childRuns entries, got ${second.childRuns.length}: ${JSON.stringify(second.childRuns)}`);
    const pids = second.childRuns.map((e) => e.pid);
    assert(step, pids.every((p) => typeof p === "number"), `not every childRuns entry has a live pid: ${JSON.stringify(pids)}`);
    assert(step, new Set(pids).size === 3, `expected 3 DISTINCT child pids, got ${JSON.stringify(pids)}`);
    assert(step, pids.every((p) => p !== rootSummary.pid), `a child pid equals the parent's own pid: parent=${rootSummary.pid} children=${JSON.stringify(pids)}`);
    assert(step, pids.every((p) => isPidAlive(p)), `not every reported child pid is actually alive right now: ${JSON.stringify(pids)}`);

    // Refusal text: verbatim §2.7 limit_parent.
    const refused = secondTerminal[0];
    assert(step, refused.status === "error", `expected the refused 4th call's status to be "error", got ${refused.status}`);
    assert(
      step,
      refused.modelText === CHILD_LIMIT_PARENT_MESSAGE,
      `refusal text mismatch — expected verbatim §2.7 limit_parent text, got: ${JSON.stringify(refused.modelText)}`,
    );

    // Refusal is terminal, not queued: wait for the 3 admitted children to
    // finish their own sleep naturally, then confirm NOTHING starts
    // afterward — childRuns for this tab drops to 0 and STAYS 0. Bounded by
    // the GREATER of the sleep duration and main's own start-deadline (a
    // child that lost a real SQLite write-lock race is only reaped at the
    // deadline, not on its own sleep — see CHILD_START_DEADLINE_MS's doc).
    const drained = await pollUntil(Math.max(SLEEP_S * 1000, CHILD_START_DEADLINE_MS) + 20_000, 500, async () => {
      const { childRuns } = await getTranscriptBlocks(ctx, step, tab.tabId);
      return childRuns.length === 0 ? true : undefined;
    });
    assert(step, drained === true, "the 3 admitted children never finished/drained within the expected window");
    await sleep(1500);
    const afterDrain = await getTranscriptBlocks(ctx, step, tab.tabId);
    assert(
      step,
      afterDrain.childRuns.length === 0,
      `expected 0 childRuns 1.5s after drain (proving the refused 4th never starts later), got ${afterDrain.childRuns.length}: ${JSON.stringify(afterDrain.childRuns)}`,
    );

    return {
      name: "A",
      status: "PASS",
      detail: `3 admitted (pids=${JSON.stringify(pids)}, parent pid=${rootSummary.pid}), 4th refused verbatim limit_parent text, refusal confirmed non-queued (childRuns stayed 0 after the 3 finished)`,
    };
  } catch (err) {
    if (err instanceof SmokeFailure) {
      return { name: "A", status: "FAIL", detail: err.message };
    }
    return { name: "A", status: "FAIL", detail: `unexpected error: ${err?.stack ?? err}` };
  } finally {
    ctx.tabId = priorTabId;
  }
}

// ── probe B (§4.2 п.9): close master with a running child -> cascade cancel, PNG-verified ──

async function probeB(ctx) {
  const step = "B";
  try {
    const tab = await createRootTab(ctx, step, ctx.tmpWorkspace);
    const dispatch = await dispatchOneSpawn(ctx, step, tab.tabId, 30, "Race probe B (cascade close)");
    if (dispatch.skipped) {
      return { name: "B", status: "SKIP", detail: dispatch.reason };
    }
    const childPid = dispatch.entry.pid;
    assert(step, typeof childPid === "number", `expected a live child pid, got ${JSON.stringify(childPid)}`);
    assert(step, isPidAlive(childPid), `child pid ${childPid} is not alive right after admission`);

    // Close the master (root count is >=2 here: probe A's tab, still open,
    // plus this one — never the last tab).
    await apiAction(ctx, step, `/tabs/${tab.tabId}/close`, {});

    const pidDead = await pollUntil(20_000, 300, async () => (isPidAlive(childPid) ? undefined : true));
    assert(step, pidDead === true, `child pid ${childPid} was still alive 20s after closing the master (drainChildren never reaped it)`);

    const freed = await pollUntil(5_000, 300, async () => {
      const resp = await api(ctx, "GET", "/state");
      if (resp.status !== 200) return undefined;
      const stillListed = (resp.body?.childRuns ?? []).some((e) => e.pid === childPid);
      const tabStillListed = (resp.body?.tabs ?? []).some((t) => t.tabId === tab.tabId);
      return !stillListed && !tabStillListed ? true : undefined;
    });
    assert(step, freed === true, "childRuns entry / parent tab still listed in /state 5s after close resolved");

    // Resume the closed session to see the persisted card.
    const resumed = await apiOk(ctx, step, "POST", "/tabs", { kind: "resume", sessionId: tab.sessionId });
    assert(step, resumed?.ok === true, `resume failed: ${JSON.stringify(resumed)}`);
    const resumedTabId = resumed.tabId;
    await waitUntilTab(ctx, step, resumedTabId, { connection: "ready" });
    await apiAction(ctx, step, `/tabs/${resumedTabId}/select`, {});

    const settled = await pollUntil(15_000, 300, async () => {
      const { transcript } = await getTranscriptBlocks(ctx, step, resumedTabId);
      const block = transcript.find((b) => b.kind === "tool_call" && b.toolCallId === dispatch.toolCallId);
      return block && isTerminalStatus(block.status) ? block : undefined;
    });
    assert(step, settled !== null, `the resumed session's Agent tool_call never reached a terminal status within 15s`);
    assert(step, settled.status === "cancelled", `expected status "cancelled" on the resumed card, got "${settled.status}" (modelText=${JSON.stringify(settled.modelText)})`);

    await apiAction(ctx, step, `/tabs/${resumedTabId}/agent-card/${dispatch.toolCallId}/expand`, {});
    await sleep(250);
    const geo = await ctx.cdp.eval(cardGeometryJs(dispatch.toolCallId));
    assert(step, geo.ok === true, `no card found in the DOM after resume+expand: ${JSON.stringify(geo)}`);
    assert(step, geo.rect.width > 0 && geo.rect.height > 0, `card has zero getBoundingClientRect: ${JSON.stringify(geo.rect)}`);
    assert(step, geo.offsetHeight > 0, "card offsetHeight is 0");
    assert(step, geo.hitInsideCard === true, `elementFromPoint at the card's own center did NOT land inside the card (hit outside)`);
    assert(step, geo.className.includes("tool-call-status-cancelled"), `card class does not include tool-call-status-cancelled: ${geo.className}`);
    assert(step, geo.badgeText === "Cancelled", `expected badge text "Cancelled", got ${JSON.stringify(geo.badgeText)}`);

    const pngPath = await saveScreenshot(ctx, "race-probeB-cancelled-card");

    return {
      name: "B",
      status: "PASS",
      detail: `child pid ${childPid} reaped, slot freed, resumed card status=cancelled badge="${geo.badgeText}" (modelText=${JSON.stringify(settled.modelText)})`,
      pngPath,
    };
  } catch (err) {
    if (err instanceof SmokeFailure) {
      return { name: "B", status: "FAIL", detail: err.message };
    }
    return { name: "B", status: "FAIL", detail: `unexpected error: ${err?.stack ?? err}` };
  }
}

// ── probe C (§4.2 п.11): external SIGKILL on the child pid -> error card, not eternal running ──

async function probeC(ctx) {
  const step = "C";
  try {
    const tab = await createRootTab(ctx, step, ctx.tmpWorkspace);
    const dispatch = await dispatchOneSpawn(ctx, step, tab.tabId, 30, "Race probe C (external SIGKILL)");
    if (dispatch.skipped) {
      return { name: "C", status: "SKIP", detail: dispatch.reason };
    }
    const childPid = dispatch.entry.pid;
    assert(step, typeof childPid === "number", `expected a live child pid, got ${JSON.stringify(childPid)}`);
    assert(step, isPidAlive(childPid), `child pid ${childPid} is not alive right after admission`);

    // Real external kill — this script's own process.kill, NOT any
    // app-internal lever (`/tabs/:id/host/kill` targets a TAB by id and
    // would be main-initiated; the point here is proving main's
    // exit-detection survives a kill it did NOT initiate).
    process.kill(childPid, "SIGKILL");

    const pidDead = await pollUntil(15_000, 300, async () => (isPidAlive(childPid) ? undefined : true));
    assert(step, pidDead === true, `child pid ${childPid} was still alive 15s after SIGKILL`);

    // Explicit timeout — "eternal running" is a FAIL only a deadline catches.
    const settled = await pollUntil(30_000, 300, async () => {
      const { transcript } = await getTranscriptBlocks(ctx, step, tab.tabId);
      const block = transcript.find((b) => b.kind === "tool_call" && b.toolCallId === dispatch.toolCallId);
      return block && isTerminalStatus(block.status) ? block : undefined;
    });
    assert(
      step,
      settled !== null,
      `the master's Agent tool_call NEVER reached a terminal status within 30s of the external SIGKILL — this is exactly the "eternal running" defect the probe exists to catch`,
    );
    assert(step, settled.status === "error", `expected status "error" after external kill, got "${settled.status}" (modelText=${JSON.stringify(settled.modelText)})`);
    assert(
      step,
      settled.modelText === CHILD_HOST_EXITED_MESSAGE,
      `error text mismatch — expected verbatim §2.7 text, got: ${JSON.stringify(settled.modelText)}`,
    );

    await apiAction(ctx, step, `/tabs/${tab.tabId}/select`, {});
    await apiAction(ctx, step, `/tabs/${tab.tabId}/agent-card/${dispatch.toolCallId}/expand`, {});
    await sleep(250);
    const geo = await ctx.cdp.eval(cardGeometryJs(dispatch.toolCallId));
    assert(step, geo.ok === true, `no card found in the DOM: ${JSON.stringify(geo)}`);
    assert(step, geo.rect.width > 0 && geo.rect.height > 0, `card has zero getBoundingClientRect: ${JSON.stringify(geo.rect)}`);
    assert(step, geo.offsetHeight > 0, "card offsetHeight is 0");
    assert(step, geo.hitInsideCard === true, "elementFromPoint at the card's own center did NOT land inside the card");
    assert(step, geo.className.includes("tool-call-status-error"), `card class does not include tool-call-status-error: ${geo.className}`);
    assert(step, geo.badgeText === "Error", `expected badge text "Error", got ${JSON.stringify(geo.badgeText)}`);

    const pngPath = await saveScreenshot(ctx, "race-probeC-error-card");

    return {
      name: "C",
      status: "PASS",
      detail: `child pid ${childPid} confirmed dead after external SIGKILL, card status=error badge="${geo.badgeText}" text verbatim §2.7`,
      pngPath,
    };
  } catch (err) {
    if (err instanceof SmokeFailure) {
      return { name: "C", status: "FAIL", detail: err.message };
    }
    return { name: "C", status: "FAIL", detail: `unexpected error: ${err?.stack ?? err}` };
  }
}

// ── probe D (anti-facade §5.8): spawn detected the instant it's admitted, raced by an immediate close ──

async function probeD(ctx) {
  const step = "D";
  const priorTabId = ctx.tabId;
  try {
    const tab = await createRootTab(ctx, step, ctx.tmpWorkspace);

    // Defensive: make sure no prior probe's children are still draining
    // (keeps the global-8 counter and pid bookkeeping clean/uncontaminated).
    const clean = await pollUntil(15_000, 300, async () => {
      const resp = await api(ctx, "GET", "/state");
      return resp.status === 200 && (resp.body?.childRuns ?? []).length === 0 ? true : undefined;
    });
    assert(step, clean === true, "prior probes' children were still draining before probe D could start cleanly");

    ctx.tabId = tab.tabId;
    const sent = await apiOk(ctx, step, "POST", `/tabs/${tab.tabId}/prompt`, { text: spawnOnePrompt(20, "Race probe D (spawn vs close)", false) });
    assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);

    // Tight poll (no `waitUntilTab turnStatus running` first) — the closest
    // black-box approximation of "detect admission the instant it happens."
    const admitted = await pollUntil(60_000, 100, async () => {
      const resp = await api(ctx, "GET", "/state");
      if (resp.status !== 200) return undefined;
      const entry = (resp.body?.childRuns ?? []).find((e) => e.parentSessionId === (resp.body?.tabs ?? []).find((t) => t.tabId === tab.tabId)?.sessionId);
      return entry ?? undefined;
    });

    if (admitted === null) {
      // Live-model nondeterminism (never called Agent, or called it with a
      // different tier) is a documented SKIP, same discipline as every
      // other probe — not a product FAIL.
      await settleTurn(ctx, step);
      return { name: "D", status: "SKIP", detail: "no childRuns entry ever appeared within 60s (model never dispatched tier:\"session\", or dispatched too slowly to observe)" };
    }

    const childPid = admitted.pid;
    const childTabId = admitted.childTabId;

    // Fire close in the very next line — no intermediate awaits/checks.
    await apiAction(ctx, step, `/tabs/${tab.tabId}/close`, {});

    const pidDead =
      typeof childPid === "number"
        ? await pollUntil(20_000, 300, async () => (isPidAlive(childPid) ? undefined : true))
        : true; // pid was still null (fork hadn't landed yet) at admission time — nothing to check for aliveness.
    assert(step, pidDead === true, `child pid ${childPid} was still alive 20s after the racing close resolved — an orphan`);

    const clear = await pollUntil(5_000, 300, async () => {
      const resp = await api(ctx, "GET", "/state");
      if (resp.status !== 200) return undefined;
      const childRunLeft = (resp.body?.childRuns ?? []).some((e) => e.requestId === admitted.requestId);
      const tabsLeft = (resp.body?.tabs ?? []).some((t) => t.tabId === tab.tabId || t.tabId === childTabId);
      return !childRunLeft && !tabsLeft ? true : undefined;
    });
    assert(step, clear === true, "ledger/tab entries for the raced spawn were still present 5s after close resolved");

    return {
      name: "D",
      status: "PASS",
      detail: `spawn admitted (requestId=${admitted.requestId}, pid=${childPid}) then immediately raced by close; no orphan (pid dead, ledger+tab entries gone)`,
    };
  } catch (err) {
    if (err instanceof SmokeFailure) {
      return { name: "D", status: "FAIL", detail: err.message };
    }
    return { name: "D", status: "FAIL", detail: `unexpected error: ${err?.stack ?? err}` };
  } finally {
    ctx.tabId = priorTabId;
  }
}

// ── teardown (own trio, NOT the imported one — same reason D2 gives: the
// imported teardown hard-codes the OTHER script's own name and would
// overwrite evidence/S2/result.json, the standing F4 closing evidence) ──

function teardown(ctx, failedProbes) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedProbes);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedProbes) {
  if (ctx.cdp) {
    ctx.cdp.close();
    ctx.cdp = null;
  }

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      }
    } catch {
      // best-effort — the app may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[child-session-race-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[child-session-race-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[child-session-race-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[child-session-race-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const passCount = (ctx.results ?? []).filter((r) => r.status === "PASS").length;
  const total = (ctx.results ?? []).length;
  const verdict = failedProbes.length === 0 ? "ALL GREEN (or documented SKIP)" : `FAILED: ${failedProbes.join(", ")}`;
  console.log(`\n[child-session-race-smoke] ${passCount}/${total} probes PASS — ${verdict}`);
  for (const r of ctx.results ?? []) {
    console.log(`  [probe ${r.name}] ${r.status} ${r.detail ?? ""}`.trimEnd());
  }

  try {
    ctx.mkdirEvidenceDir();
    const resultPath = join(ctx.evidenceDir, "race-result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verdict,
          results: ctx.results ?? [],
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`           result json: ${resultPath}`);
  } catch (err) {
    console.warn(`[child-session-race-smoke] failed to write race-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[child-session-race-smoke] received ${signal} — tearing down…`);
    teardown(ctx, ["signal:" + signal])
      .catch((err) => console.error(`[child-session-race-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

// ── orchestration ──

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
    cdp: null,
    cdpPort: null,
    results: [],
  };
  ctx.mkdirEvidenceDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.evidenceDir)}, {recursive:true})`]);
    } catch {
      // fall through to the caller's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  const failedProbes = [];
  try {
    ctx.cdpPort = await reserveUnusedPort();
    process.env.REMOTE_DEBUGGING_PORT = String(ctx.cdpPort);

    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);
    ctx.cdp = await cdpConnect(ctx.cdpPort);

    for (const probe of [probeA, probeB, probeC, probeD]) {
      const result = await probe(ctx);
      ctx.results.push(result);
      console.log(`[probe ${result.name}] ${result.status} ${result.detail ?? ""}`.trimEnd());
      if (result.status === "FAIL") {
        failedProbes.push(result.name);
      }
    }
  } catch (err) {
    console.error(`[child-session-race-smoke] fatal setup error: ${err?.stack ?? err}`);
    failedProbes.push("setup");
  }

  await teardown(ctx, failedProbes);
  process.exit(failedProbes.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(`[child-session-race-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

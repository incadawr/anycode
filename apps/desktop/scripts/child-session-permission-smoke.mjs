/**
 * Live smoke for TASK.102 CUT-S2 §4.2 пп.6, 7, 12 — S2d D3. Drives a REAL
 * Electron dev instance end-to-end and proves, on a real screen and a real
 * SQLite file, what a unit matrix structurally cannot:
 *
 *   п.6  A real permission-ask raised by a RUNNING child: the "waiting for
 *        permission" badge appears on the MASTER's own Agent card (the
 *        always-visible toggle row, ToolCallCard.tsx) while the master's OWN
 *        `PermissionModal` never mounts (its binding is `ConnectedPermissionModal`
 *        inside `SessionSurface`, scoped to whichever `<TabContext>` is
 *        currently wrapped around it — while the pane shows "master", that's
 *        the ROOT tab's own store, and the ask landed on the CHILD's own
 *        connection/store instead, so the root's `permission` field is
 *        structurally never touched, PermissionModal.tsx / App.tsx). After
 *        `POST /tabs/:tabId/child/open`, the SAME modal component, now bound
 *        to the child's own TabContext (ChildSessionPane, App.tsx), IS
 *        mounted and visible with real content (title/input/allow button);
 *        answering it through the child's OWN tabId continues the child's
 *        turn and clears the badge.
 *   п.7  Steering a RUNNING child: a message typed into the child pane's own
 *        composer WHILE its turn is running must reach the host's steer
 *        queue (`session.ts`'s `enqueueSteerMessage`/`steerQueue`,
 *        CUT-S2 §1.1/§2.6.3) and get fulfilled BEFORE the parent's Agent
 *        tool_call goes terminal — proven by the child's own OWN
 *        activity/tool-call count growing by exactly the steered
 *        instruction, not just by a UI element materializing. Driven through
 *        the REAL composer DOM (native-setter + `input` event + a real
 *        `.click()` on `.composer-send`), not a facade shortcut — the
 *        automation channel's own `sendPrompt`/`queuePrompt` routes are
 *        proven (by code reading, cited in this run's own report under
 *        "КРАСНОЕ" if this goes red) to be unusable for this exact scenario:
 *        `sendPrompt` busy-rejects unconditionally (automation.ts, mirrors
 *        Composer's direct-send guard, not its enqueue branch) and
 *        `queuePrompt` writes into the SAME renderer-side `promptQueue`
 *        `tab-registry.ts` deliberately never wires a drainer for
 *        (`registerPort`'s `if (child) {...}` branch skips the P7.14
 *        subscription — the child-port comment literally says "not this
 *        renderer-side one").
 *   п.12 SQLite cascade after root deletion: `PersistencePort.deleteSessionTree`
 *        (already exhaustively unit-tested across every dependent table,
 *        `sqlite-persistence.test.ts`) driven for REAL against a live app's
 *        REAL db file via a NEW dev-only automation route (CUT-S2 §6's own
 *        "UI удаления сессий — вне S2 ... automation зовёт его напрямую для
 *        теста" contract) — verified two ways: the live `/child-runs`
 *        maintenance projection (before/after), AND a raw post-quit
 *        `node:sqlite` scan of every table in the actual db FILE for any
 *        trace of the deleted session ids, closing the "cascade proven only
 *        on the sessions row, not history/checkpoints/shadow tables" facade
 *        risk (CUT-S2 §5 point 7) live, not just in the unit suite.
 *
 * Пп.1,2,3,5,8 are covered by `child-session-scenario-smoke.mjs`;
 * пп.9-11 by a parallel job's own file — not duplicated here.
 *
 * REUSE (CUT-S2 §3 D2/D3's own directive): every generic process/fs/HTTP/
 * dispatch-retry helper below is IMPORTED, unmodified, from the already-green
 * `child-session-explicit-provider-smoke.mjs` — `step1LaunchApp` in
 * particular is reused UNMODIFIED for the whole launch/profile/settings-seed
 * sequence (the SAME real v2 `provider.connections[]` seed, permissions
 * always-allow list `[Agent, Read, Glob, Grep, Bash]` — Write is
 * DELIBERATELY absent from that list, which is exactly what makes mode
 * "build" ask for it below). The CDP client is written fresh here (same
 * technique `child-session-scenario-smoke.mjs`/`custom-provider-live-smoke.mjs`
 * already established for this command surface) because neither precedent
 * exports one.
 *
 * NOT reused: `teardown`/`runTeardown`/`installSignalTeardown` (this script
 * writes its OWN `evidence/S2/permission-result.json`, and additionally does
 * a post-quit, pre-cleanup raw SQLite read that must run BEFORE the profile
 * directory is removed — the imported teardown has no hook for that).
 *
 * Usage: node apps/desktop/scripts/child-session-permission-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspace/profile on exit (debugging).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider, read (by the
 * reused `step1LaunchApp`) from `.smoke-secrets/glm.env`.
 *
 * Each step prints `[step N] PASS/FAIL <detail>` where N is the CUT-S2 §4.2
 * item number itself (6, 7, or 12) — not a 1..N sequence — so the report's
 * step numbers read directly against the spec. The first FAIL tears down and
 * exits 1. A live-model non-compliance on either spawn (Agent never called,
 * or never with tier:"session") gets exactly ONE retry, then a documented
 * SKIP (exit 0), same discipline as every other harness in this directory.
 * Evidence (2 required PNGs + up to 1 diagnostic PNG + a JSON result dump)
 * lands in `working-docs/task102-track/evidence/S2/`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SmokeFailure,
  api,
  apiAction,
  apiOk,
  assert,
  fail,
  getTranscriptBlocks,
  isPidAlive,
  killTree,
  pass,
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
const STEER_SLEEP_SECONDS = 8;
const TERMINAL_WAIT_TIMEOUT_MS = 60_000;

const FLAGS = { keep: process.argv.slice(2).includes("--keep") };

// ── local helpers (generic poll + port reservation + CDP client — same
// posture/precedent as child-session-scenario-smoke.mjs's own header doc:
// small, well-understood, product-code-free, not exported by either
// precedent so written fresh here) ──

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

// ── browser-side geometry/DOM expressions (product-code-free, see header) ──

/**
 * Locates the MASTER's Agent card by its `data-tool-call-id` (ToolCallCard.tsx,
 * present on the outer `.tool-call-card` in EVERY render, collapsed or not —
 * design/slice-P7.18-cut.md §4 W4) and reads the session-child badge's real
 * Blink geometry, plus whether ANY permission modal exists anywhere in the
 * document (the master-modal-absent half of п.6).
 */
function masterBadgeGeometryJs(toolCallId) {
  return `(() => {
    const card = document.querySelector('[data-tool-call-id="${toolCallId}"]');
    if (!card) return { ok: false, reason: 'no_card' };
    const badge = card.querySelector('.tool-call-child-badge');
    const globalModal = document.querySelector('dialog.permission-modal');
    if (!badge) {
      return { ok: true, hasBadge: false, globalModalPresent: !!globalModal, globalModalOpen: globalModal ? globalModal.open : false };
    }
    badge.scrollIntoView({ block: 'center' });
    const rect = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      ok: true,
      hasBadge: true,
      badgeClass: badge.className,
      badgeText: badge.textContent,
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
      offsetHeight: badge.offsetHeight,
      display: style.display, visibility: style.visibility, opacity: style.opacity,
      hitInsideBadge: hit ? (badge.contains(hit) || hit === badge) : false,
      hitTag: hit ? hit.tagName : null,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      globalModalPresent: !!globalModal,
      globalModalOpen: globalModal ? globalModal.open : false,
    };
  })()`;
}

/** Reads the (sole, while a child pane is shown) permission modal's real geometry + content. */
const CHILD_PERMISSION_MODAL_JS = `(() => {
  const modal = document.querySelector('dialog.permission-modal');
  if (!modal) return { ok: false, reason: 'no_modal' };
  const rect = modal.getBoundingClientRect();
  const style = getComputedStyle(modal);
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const title = modal.querySelector('.permission-modal-title');
  const inputValue = modal.querySelector('.permission-input-value');
  const allowBtn = modal.querySelector('.permission-allow-button');
  return {
    ok: true,
    open: modal.open,
    rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
    offsetHeight: modal.offsetHeight,
    display: style.display, visibility: style.visibility, opacity: style.opacity,
    hitInsideModal: hit ? (modal.contains(hit) || hit === modal) : false,
    hitTag: hit ? hit.tagName : null,
    titleText: title ? title.textContent : null,
    inputValueText: inputValue ? inputValue.textContent : null,
    allowBtnText: allowBtn ? allowBtn.textContent : null,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  };
})()`;

const CHILD_PANE_MOUNTED_JS = `(() => !!document.querySelector('.child-session-breadcrumb'))()`;

/** True iff Composer.tsx's `running` branch is rendering (`.composer-stop` only exists then) — the child's OWN turn is live, read off the currently-shown pane's DOM (no product-state mirror). */
const COMPOSER_RUNNING_JS = `(() => !!document.querySelector('.composer-stop'))()`;

/** Snapshot of the currently-shown pane's transcript length + queued-prompt items — the discriminator between "direct-sent" (transcript grows, no queue item) and "renderer-enqueued" (queue item appears, transcript does not grow) for п.7. */
const COMPOSER_OBSERVATION_JS = `(() => ({
  messageCount: document.querySelectorAll('.message-list .message').length,
  queueItems: Array.from(document.querySelectorAll('.prompt-queue-item')).map((el) => el.querySelector('.prompt-queue-text')?.textContent ?? null),
  composerRunning: !!document.querySelector('.composer-stop'),
}))()`;

function typeIntoComposerJs(text) {
  return `(() => {
    const ta = document.querySelector('.composer-textarea');
    if (!ta) return { ok: false, reason: 'no_textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value };
  })()`;
}

const CLICK_COMPOSER_SEND_JS = `(() => {
  const btn = document.querySelector('.composer-send');
  if (!btn) return { ok: false, reason: 'no_button' };
  const ariaLabel = btn.getAttribute('aria-label');
  const disabled = btn.disabled;
  if (disabled) return { ok: false, reason: 'disabled', ariaLabel };
  btn.click();
  return { ok: true, ariaLabel };
})()`;

const CLICK_BREADCRUMB_MASTER_JS = `(() => {
  const btn = document.querySelector('.child-breadcrumb-master');
  if (!btn) return { ok: false, reason: 'no_button' };
  btn.click();
  return { ok: true };
})()`;

// ── prompt text (own copies — content differs from every precedent's spawn prompt) ──

function spawnPromptPrimary(taskInstruction) {
  return (
    'Call the Agent tool exactly once, right now, in this turn. Use these exact parameter values: ' +
    'tier: "session", agent_type: "general-purpose", description: a short 3-5 word summary of the task, ' +
    `and prompt: ${taskInstruction} You MUST include the tier parameter set to the literal string "session" — ` +
    'do not omit it, and do not use tier "inline". Invoke the tool now.'
  );
}
function spawnPromptRetry(taskInstruction) {
  return (
    'You did not call the Agent tool with the required tier parameter. The Agent tool you have access to ' +
    'accepts a `tier` parameter, and for a real child session it must be the literal string "session". Call ' +
    `it NOW with tier set to "session", agent_type set to "general-purpose", a short description, and ${taskInstruction} ` +
    'You must invoke the tool itself, with a real tool call — do not just describe what you would do.'
  );
}

function hasSessionTierInput(block) {
  const input = block?.input;
  return input !== null && typeof input === "object" && input.tier === "session";
}

/**
 * Transcript-aware replacement for the base harness's own `pollForDispatch`/
 * `attemptDispatch` — NOT a byte-identical copy, a deliberate fix. Both
 * precedents' `findAnyAgentBlock` matches the FIRST `Agent` tool_call in the
 * WHOLE transcript, which is correct for a single-spawn-per-conversation
 * script (both existing harnesses) but wrong here: this script dispatches
 * TWO separate Agent calls on the SAME root tab (п.6 then п.7), and a naive
 * find would hand step 7 step 6's own stale, already-terminal block — caught
 * live on this harness's own first full run past step 6 (see this run's own
 * report under "КРАСНОЕ"). `excludeToolCallIds` filters those out; `childRuns`
 * needs no equivalent filter (main-process ledger, self-clearing on
 * finalize — `handlers.ts`'s own doc on `ChildRunSummary`).
 */
async function pollForNewDispatch(ctx, step, timeoutMs, excludeToolCallIds) {
  const deadline = Date.now() + timeoutMs;
  let anyAgentSeen = false;
  let lastBlock = null;
  for (;;) {
    const { transcript, mainTabs, childRuns } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && !excludeToolCallIds.has(b.toolCallId)) ?? null;
    if (block !== null) {
      anyAgentSeen = true;
      lastBlock = block;
    }
    if (Array.isArray(childRuns) && childRuns.length > 0) {
      return { anyAgentSeen, block: lastBlock, childRuns, mainTabs };
    }
    if (block !== null && (block.status === "success" || block.status === "error")) {
      return { anyAgentSeen, block, childRuns: childRuns ?? [], mainTabs };
    }
    if (Date.now() >= deadline) {
      return { anyAgentSeen, block: lastBlock, childRuns: childRuns ?? [], mainTabs };
    }
    await sleep(300);
  }
}

async function attemptNewDispatch(ctx, step, prompt, timeoutMs, excludeToolCallIds) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  return pollForNewDispatch(ctx, step, timeoutMs, excludeToolCallIds);
}

/**
 * Shared spawn-dispatch dance (1 retry then documented SKIP, same discipline
 * as every precedent's own step1Discovery/step2Dispatch) — generalized over
 * the task instruction text since п.6 and п.7 spawn two DIFFERENT children,
 * and over `excludeToolCallIds` (see `pollForNewDispatch`'s own doc above).
 */
async function spawnChild(ctx, step, taskInstruction, dispatchTimeoutMs, excludeToolCallIds) {
  let anyAgentSeen = false;
  let result = await attemptNewDispatch(ctx, step, spawnPromptPrimary(taskInstruction), dispatchTimeoutMs, excludeToolCallIds);
  anyAgentSeen = anyAgentSeen || result.anyAgentSeen;

  if (!hasSessionTierInput(result.block) && result.childRuns.length === 0) {
    console.warn(`[child-session-permission-smoke] step ${step}: tier:"session" not seen on the first attempt — retrying once`);
    await settleTurn(ctx, step);
    result = await attemptNewDispatch(ctx, step, spawnPromptRetry(taskInstruction), dispatchTimeoutMs + 30_000, excludeToolCallIds);
    anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
  }

  if (!anyAgentSeen) {
    return { skipped: true, skipReason: "model never called Agent" };
  }
  if (!hasSessionTierInput(result.block) && result.childRuns.length === 0) {
    return { skipped: true, skipReason: 'model did not use tier:"session"' };
  }
  if (result.childRuns.length === 0) {
    fail(step, `Agent called with tier:"session" (input=${JSON.stringify(result.block?.input)}) but no childRuns entry ever appeared. Final block: ${JSON.stringify(result.block)}`);
  }
  assert(step, result.childRuns.length === 1, `expected exactly 1 childRuns entry, got ${result.childRuns.length}: ${JSON.stringify(result.childRuns)}`);
  return { skipped: false, entry: result.childRuns[0], toolCallId: result.block.toolCallId };
}

async function findToolCallBlock(ctx, step, toolCallId) {
  const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return transcript.find((b) => b.kind === "tool_call" && b.toolCallId === toolCallId) ?? null;
}

async function rootPermissionState(ctx) {
  const resp = await api(ctx, "GET", "/state");
  return resp.body?.snapshot?.states?.[ctx.tabId]?.permission ?? null;
}

// ── п.6: real permission-ask on a running child ──

async function step6PermissionAsk(ctx) {
  const step = 6;

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/mode`, { mode: "build" });
  const modeApplied = await pollUntil(10_000, 250, async () => {
    const resp = await api(ctx, "GET", "/state");
    const mode = resp.body?.snapshot?.states?.[ctx.tabId]?.mode;
    return mode === "build" ? mode : undefined;
  });
  assert(step, modeApplied === "build", `mode "build" never reflected on /state's per-tab snapshot within 10s (last seen: ${JSON.stringify(modeApplied)})`);
  ctx.modeConfirmed = modeApplied;

  const permProofPath = join(ctx.tmpWorkspace, "perm-proof.txt");
  const taskInstruction =
    'an instruction telling the subagent to call the Write tool with file_path set to the exact absolute path ' +
    `"${permProofPath}" and content set to the exact string "PERMISSION-OK" (no code fence, no extra text), wait ` +
    'for the tool result, and then reply with exactly the single word DONE and use no further tools.';

  const spawn = await spawnChild(ctx, step, taskInstruction, 60_000, new Set());
  if (spawn.skipped) {
    ctx.step6Skipped = true;
    ctx.step6SkipReason = spawn.skipReason;
    await settleTurn(ctx, step);
    pass(step, `SKIPPED (documented) — ${spawn.skipReason}`);
    return;
  }
  ctx.step6ToolCallId = spawn.toolCallId;
  ctx.step6ChildEntry = spawn.entry;

  // Poll for the master card's badge to flip to "waiting_permission" (the
  // subagent_attention relay, store.ts's patchSubagentAttention) — distinct
  // sub-cases matter: the child could finish WITHOUT ever asking (diagnose,
  // don't silently pass), or the poll could simply time out mid-run.
  const waitingSeen = await pollUntil(30_000, 300, async () => {
    const block = await findToolCallBlock(ctx, step, ctx.step6ToolCallId);
    if (block === null) return undefined;
    if (block.subagent?.waiting === true) return block;
    if (block.subagent?.final !== null && block.subagent?.final !== undefined) return { neverAsked: true, block };
    if (block.status === "success" || block.status === "error") return { neverAsked: true, block };
    return undefined;
  });
  assert(step, waitingSeen !== null, `master card never reached a decidable state (waiting OR terminal) for toolCallId=${ctx.step6ToolCallId} within 30s`);
  assert(
    step,
    waitingSeen.neverAsked !== true,
    `child reached a terminal/final state WITHOUT ever raising subagent.waiting===true — Write was never asked for ` +
      `under mode="build" (either the model skipped Write, or the ask was bypassed). Final block: ${JSON.stringify(waitingSeen.block ?? waitingSeen)}`,
  );

  // Master modal must NOT be up (structural: the master pane's own
  // ConnectedPermissionModal reads the ROOT tab's own store, untouched by a
  // child's own connection).
  const rootPermission = await rootPermissionState(ctx);
  assert(step, rootPermission === null, `master's OWN /state permission field is non-null while the child is asking — the MASTER modal would be up: ${JSON.stringify(rootPermission)}`);

  const badgeGeo = await ctx.cdp.eval(masterBadgeGeometryJs(ctx.step6ToolCallId));
  assert(step, badgeGeo.ok === true && badgeGeo.hasBadge === true, `master card badge not found in the DOM: ${JSON.stringify(badgeGeo)}`);
  assert(step, badgeGeo.badgeClass.includes("waiting_permission"), `badge class does not indicate waiting_permission: ${badgeGeo.badgeClass}`);
  assert(step, badgeGeo.rect.width > 0 && badgeGeo.rect.height > 0, `badge has zero getBoundingClientRect: ${JSON.stringify(badgeGeo.rect)}`);
  assert(step, badgeGeo.offsetHeight > 0, "badge offsetHeight is 0");
  assert(step, badgeGeo.display !== "none" && badgeGeo.visibility !== "hidden" && Number(badgeGeo.opacity) > 0, `badge not visually visible: display=${badgeGeo.display} visibility=${badgeGeo.visibility} opacity=${badgeGeo.opacity}`);
  assert(step, badgeGeo.hitInsideBadge === true, `elementFromPoint at the badge's own center (hit tag=${badgeGeo.hitTag}) did NOT land inside the badge`);
  assert(step, badgeGeo.globalModalPresent === false, `a permission modal exists in the DOM while viewing master — expected NONE: globalModalPresent=${badgeGeo.globalModalPresent} open=${badgeGeo.globalModalOpen}`);
  ctx.step6BadgeGeo = badgeGeo;

  await saveScreenshot(ctx, "permission-step6-badge-master-no-modal");

  // Open on the running child — the modal must now be visible in the CHILD surface.
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.step6ToolCallId });
  const paneMounted = await pollUntil(10_000, 200, async () => ((await ctx.cdp.eval(CHILD_PANE_MOUNTED_JS)) === true ? true : undefined));
  assert(step, paneMounted === true, "child pane never mounted (.child-session-breadcrumb) within 10s of Open");

  // `.permission-modal[open]` runs a `scale-in`/opacity CSS animation
  // (app.css) — the FIRST poll tick to see `open:true` can still land
  // mid-animation (opacity 0..1 in flight), so the success condition here
  // waits for the animation to have visibly SETTLED (opacity>0), not just
  // for the dialog to exist. Caught live on the first run of this harness
  // (opacity:"0" at the very first `open:true` reading) — a poll-strength
  // fix, not an assertion weakening (see this run's own report).
  const modalGeo = await pollUntil(10_000, 250, async () => {
    const geo = await ctx.cdp.eval(CHILD_PERMISSION_MODAL_JS);
    return geo.ok === true && Number(geo.opacity) > 0 ? geo : undefined;
  });
  assert(step, modalGeo !== null, "no permission modal appeared VISIBLY (opacity>0) in the child surface's DOM within 10s of Open");
  assert(step, modalGeo.open === true, `modal <dialog> exists but .open is false: ${JSON.stringify(modalGeo)}`);
  assert(step, modalGeo.rect.width > 0 && modalGeo.rect.height > 0, `child modal has zero getBoundingClientRect: ${JSON.stringify(modalGeo.rect)}`);
  assert(step, modalGeo.offsetHeight > 0, "child modal offsetHeight is 0");
  assert(step, modalGeo.display !== "none" && modalGeo.visibility !== "hidden" && Number(modalGeo.opacity) > 0, `child modal not visually visible: ${JSON.stringify(modalGeo)}`);
  assert(step, modalGeo.hitInsideModal === true, `elementFromPoint at the modal's own center (hit tag=${modalGeo.hitTag}) did NOT land inside the modal`);
  assert(step, typeof modalGeo.titleText === "string" && modalGeo.titleText.includes("Write"), `modal title does not mention Write (real content check): ${JSON.stringify(modalGeo.titleText)}`);
  assert(step, typeof modalGeo.inputValueText === "string" && modalGeo.inputValueText.includes(permProofPath), `modal input preview does not show the Write file path: ${JSON.stringify(modalGeo.inputValueText)}`);
  ctx.step6ModalGeo = modalGeo;

  await saveScreenshot(ctx, "permission-step6-modal-child-surface");

  // Answer it through the CHILD's own tabId — must continue the child's turn.
  await apiAction(ctx, step, `/tabs/${ctx.step6ChildEntry.childTabId}/permission`, { behavior: "allow" });

  const settled = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 300, async () => {
    const block = await findToolCallBlock(ctx, step, ctx.step6ToolCallId);
    if (block === null) return undefined;
    const badgeCleared = block.subagent?.waiting !== true;
    const terminal = block.status === "success" || block.status === "error";
    return badgeCleared && terminal ? block : undefined;
  });
  assert(step, settled !== null, `master card never both cleared the waiting badge AND reached a terminal status within ${TERMINAL_WAIT_TIMEOUT_MS}ms after allow`);
  assert(step, settled.status === "success", `expected the child's task to succeed after allow, got status=${settled.status}: ${JSON.stringify(settled)}`);

  const fileExists = existsSync(permProofPath);
  assert(step, fileExists, `Write was allowed but ${permProofPath} does not exist on disk — the effectful tool never actually ran`);
  if (fileExists) {
    const content = readFileSync(permProofPath, "utf8").trim();
    assert(step, content === "PERMISSION-OK", `expected ${permProofPath} to contain PERMISSION-OK, got ${JSON.stringify(content)}`);
  }

  ctx.step6ChildSessionId = ctx.step6ChildEntry.childSessionId;

  // Direct SQLite-row proof of mode inheritance (not just the behavioral
  // argument that Write asking at all implies build/edit) — the durable
  // child-session row's own `mode` column (`SessionMeta.mode`, persistence.ts),
  // read back off the SAME dev-only maintenance route п.12 also uses.
  const childRuns = await apiOk(ctx, step, "GET", "/child-runs");
  const childRow = (childRuns?.sessions ?? []).find((s) => s.id === ctx.step6ChildSessionId);
  assert(step, childRow !== undefined, `no durable /child-runs row found for childSessionId=${ctx.step6ChildSessionId}: ${JSON.stringify(childRuns)}`);
  assert(step, childRow.mode === "build", `child's own durable SQLite row.mode is not "build" (inheritance not proven at the row level): ${JSON.stringify(childRow)}`);
  ctx.step6ChildRowMode = childRow.mode;

  pass(
    step,
    `real permission-ask on a running child: badge visible on master (rect=${JSON.stringify(badgeGeo.rect)}), no master modal, ` +
      `child-surface modal visible+real content after Open (rect=${JSON.stringify(modalGeo.rect)}, title="${modalGeo.titleText}"), ` +
      `allow via child tabId continued the child turn to success, badge cleared, ${permProofPath} written with PERMISSION-OK, ` +
      `child's durable row.mode="${childRow.mode}" (inherited from the root's own mode set before spawn)`,
  );
}

// ── п.7: steering a running child ──

async function step7Steering(ctx) {
  const step = 7;
  if (ctx.step6Skipped) {
    // mode was never confirmed in step 6 if it skipped before setting it —
    // ensure it here so this step is independent of step 6's own outcome.
    await apiAction(ctx, step, `/tabs/${ctx.tabId}/mode`, { mode: "build" }).catch(() => {});
  }

  // The ROOT's own turn (the model call that dispatched step 6's Agent tool)
  // does not go "idle" the instant that tool_call's OWN status reaches
  // "success" — the root model still has to consume the tool_result and
  // produce its own final reply before turn.status flips. Sending step 7's
  // spawn prompt without waiting for that first-run bug (b): `attemptDispatch`
  // -> `sendPrompt` busy-rejected with reason:"busy" outright (caught live on
  // this harness's own first full run past step 6 — see this run's own
  // report under "КРАСНОЕ"). Fixed by waiting for the shared root tab's own
  // idle, not by loosening any assertion.
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000);

  const steerProofPath = join(ctx.tmpWorkspace, "steer-proof.txt");
  const taskInstruction =
    'an instruction telling the subagent to FIRST call the Bash tool with the exact command ' +
    `"sleep ${STEER_SLEEP_SECONDS}" and wait for it to finish, and ONLY THEN reply with exactly the single word ` +
    'DONE and use no further tools.';

  const exclude = new Set(typeof ctx.step6ToolCallId === "string" ? [ctx.step6ToolCallId] : []);
  const spawn = await spawnChild(ctx, step, taskInstruction, 60_000, exclude);
  if (spawn.skipped) {
    ctx.step7Skipped = true;
    await settleTurn(ctx, step);
    pass(step, `SKIPPED (documented) — ${spawn.skipReason}`);
    return;
  }
  ctx.step7ToolCallId = spawn.toolCallId;
  ctx.step7ChildEntry = spawn.entry;

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.step7ToolCallId });
  const paneMounted = await pollUntil(10_000, 200, async () => ((await ctx.cdp.eval(CHILD_PANE_MOUNTED_JS)) === true ? true : undefined));
  assert(step, paneMounted === true, "child pane (Open on the sleep child) never mounted within 10s");

  const running = await pollUntil(20_000, 300, async () => ((await ctx.cdp.eval(COMPOSER_RUNNING_JS)) === true ? true : undefined));
  assert(step, running === true, "child's own composer never showed .composer-stop (turn never observed running) within 20s — no busy window to steer into");

  // Precondition: the MASTER's own Agent tool_call must still be "running" at
  // the moment the steer is injected — otherwise this isn't testing "before
  // the master's tool unblocks" at all.
  const preSteerBlock = await findToolCallBlock(ctx, step, ctx.step7ToolCallId);
  assert(step, preSteerBlock !== null && preSteerBlock.status === "running", `master's Agent tool_call is not "running" at steer-injection time: ${JSON.stringify(preSteerBlock)}`);

  const baseline = await ctx.cdp.eval(COMPOSER_OBSERVATION_JS);
  const steerText = `Also run the Bash tool with the exact command "echo STEERED > ${steerProofPath}" before you reply DONE, in addition to the sleep.`;

  const typed = await ctx.cdp.eval(typeIntoComposerJs(steerText));
  assert(step, typed.ok === true && typed.value === steerText, `typing into the child composer failed or textarea value mismatched: ${JSON.stringify(typed)}`);

  const clicked = await ctx.cdp.eval(CLICK_COMPOSER_SEND_JS);
  ctx.step7SendClick = clicked;

  // Re-check the master's tool_call status right after the click — still
  // proving the injection happened strictly before the master unblocked.
  const postClickBlock = await findToolCallBlock(ctx, step, ctx.step7ToolCallId);
  const stillRunningAtInjection = postClickBlock !== null && postClickBlock.status === "running";

  await sleep(2_000);
  const afterClick = await ctx.cdp.eval(COMPOSER_OBSERVATION_JS);
  ctx.step7Observation = { baseline, afterClick, clicked };

  const terminal = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 500, async () => {
    const block = await findToolCallBlock(ctx, step, ctx.step7ToolCallId);
    return block !== null && (block.status === "success" || block.status === "error") ? block : undefined;
  });
  assert(step, terminal !== null, `master's Agent tool_call for the steer child never reached a terminal status within ${TERMINAL_WAIT_TIMEOUT_MS}ms`);
  ctx.step7Terminal = terminal;

  // NOTE (own bug, caught on this harness's own first full run past step 7):
  // the RENDERER's `SubagentSubStatus` (what /state's snapshot actually
  // serializes, store.ts/automation.ts's `snapshot()`) is FLAT —
  // `subagent.toolCalls`, not `subagent.counters.toolCalls` (that nested
  // shape is core's PERSISTED `SubagentCardSnapshotV1.counters`, a
  // different type). Reading the wrong field produced `toolCallsMade:null`
  // in this run's diagnostic — it did NOT change the FAIL verdict itself
  // (the independent steer-file-existence check already failed on its own),
  // but the field is corrected here for an honest artifact, not weakened.
  const toolCallsMade = terminal.subagent?.toolCalls ?? null;
  const steerFileExists = existsSync(steerProofPath);
  const steerFileContent = steerFileExists ? readFileSync(steerProofPath, "utf8").trim() : null;

  ctx.step7ChildSessionId = ctx.step7ChildEntry.childSessionId;
  ctx.step7Result = { toolCallsMade, steerFileExists, steerFileContent, stillRunningAtInjection };

  const steeringWorked = steerFileExists && steerFileContent === "STEERED" && toolCallsMade >= 2;

  assert(
    step,
    stillRunningAtInjection === true,
    `the steer click landed AFTER the master's Agent tool_call had already gone terminal (status=${postClickBlock?.status}) — this run cannot demonstrate steering-before-unblock at all`,
  );
  assert(
    step,
    steeringWorked,
    `steer message did not affect the child's result: sent via the REAL composer (click=${JSON.stringify(clicked)}, ` +
      `queueItems-after-click=${JSON.stringify(afterClick.queueItems)}, messageCount ${baseline.messageCount}->${afterClick.messageCount}), ` +
      `but toolCallsMade=${toolCallsMade} (expected >=2: sleep + the steered echo) and ${steerProofPath} exists=${steerFileExists} content=${JSON.stringify(steerFileContent)}. ` +
      `Final master block: ${JSON.stringify(terminal)}`,
  );

  pass(
    step,
    `steering worked: injected while master tool_call was still "running" (composer click=${JSON.stringify(clicked)}), ` +
      `child's own toolCalls=${toolCallsMade}, ${steerProofPath} written with STEERED`,
  );
}

// ── п.12: SQLite cascade after root deletion ──

async function step12SqliteCascade(ctx) {
  const step = 12;

  const stateResp = await api(ctx, "GET", "/state");
  const rootSummary = (stateResp.body?.tabs ?? []).find((t) => t.tabId === ctx.tabId);
  assert(step, rootSummary !== undefined && typeof rootSummary.sessionId === "string", `could not resolve the root tab's own sessionId off /state: ${JSON.stringify(rootSummary)}`);
  ctx.rootSessionId = rootSummary.sessionId;

  const expectedChildIds = [ctx.step6ChildSessionId, ctx.step7ChildSessionId].filter((id) => typeof id === "string");
  assert(step, expectedChildIds.length > 0, "no child session ids survived from steps 6/7 (both skipped?) — nothing for the cascade to prove");

  const before = await apiOk(ctx, step, "GET", "/child-runs");
  assert(step, before?.ok === true, `GET /child-runs (before) did not answer ok:true: ${JSON.stringify(before)}`);
  const beforeIds = new Set((before.sessions ?? []).map((s) => s.id));
  for (const id of expectedChildIds) {
    assert(step, beforeIds.has(id), `expected child session ${id} present in /child-runs BEFORE delete — baseline is not meaningful otherwise. Rows: ${JSON.stringify(before.sessions)}`);
  }

  const del = await apiOk(ctx, step, "POST", `/sessions/${encodeURIComponent(ctx.rootSessionId)}/delete-tree`, {});
  assert(step, del?.ok === true, `POST /sessions/:id/delete-tree did not answer ok:true: ${JSON.stringify(del)}`);
  assert(step, Array.isArray(del.deletedSessionIds) && del.deletedSessionIds.includes(ctx.rootSessionId), `deletedSessionIds does not include the root id ${ctx.rootSessionId}: ${JSON.stringify(del.deletedSessionIds)}`);
  for (const id of expectedChildIds) {
    assert(step, del.deletedSessionIds.includes(id), `deletedSessionIds does not include child ${id}: ${JSON.stringify(del.deletedSessionIds)}`);
  }
  ctx.deletedSessionIds = del.deletedSessionIds;

  const after = await apiOk(ctx, step, "GET", "/child-runs");
  assert(step, after?.ok === true, `GET /child-runs (after) did not answer ok:true: ${JSON.stringify(after)}`);
  const afterIds = new Set((after.sessions ?? []).map((s) => s.id));
  for (const id of expectedChildIds) {
    assert(step, !afterIds.has(id), `child session ${id} STILL present in /child-runs after delete-tree: ${JSON.stringify(after.sessions)}`);
  }

  // Quit NOW (before the raw db read) — the file must be closed by the app's
  // own process before a second, independent connection reads it.
  await api(ctx, "POST", "/quit", {}).catch(() => {});
  const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
  if (!exited) {
    console.warn("[child-session-permission-smoke] app did not exit within grace period after /quit — escalating SIGTERM");
    killTree(ctx.child.pid, "SIGTERM");
    await sleep(SIGTERM_GRACE_MS);
    if (isPidAlive(ctx.child.pid)) {
      killTree(ctx.child.pid, "SIGKILL");
    }
  }
  ctx.appQuitByStep12 = true;

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(ctx.profileDbPath, { readOnly: true });
  let leaked = [];
  let tableNames = [];
  try {
    tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const table of tableNames) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all();
      for (const row of rows) {
        const json = JSON.stringify(row);
        for (const id of ctx.deletedSessionIds) {
          if (json.includes(id)) {
            leaked.push({ table, id, row });
          }
        }
      }
    }
  } finally {
    db.close();
  }
  ctx.step12TableNames = tableNames;
  ctx.step12Leaked = leaked;
  assert(step, leaked.length === 0, `raw SQLite scan of ${ctx.profileDbPath} found residual references to deleted session ids across tables ${JSON.stringify(tableNames)}: ${JSON.stringify(leaked).slice(0, 2000)}`);

  pass(
    step,
    `cascade proven live: /child-runs showed both children before (${JSON.stringify([...beforeIds])}) and neither after; ` +
      `delete-tree deleted ${JSON.stringify(del.deletedSessionIds)}; raw post-quit scan of ${tableNames.length} tables ` +
      `(${JSON.stringify(tableNames)}) in ${ctx.profileDbPath} found ZERO residual rows referencing any deleted id`,
  );
}

// ── teardown (own trio) ──

function teardown(ctx, failedStep, stepStatus) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep, stepStatus);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep, stepStatus) {
  if (ctx.cdp) {
    ctx.cdp.close();
    ctx.cdp = null;
  }

  if (!ctx.appQuitByStep12 && ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else if (typeof ctx.tabId === "string") {
        await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[child-session-permission-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[child-session-permission-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[child-session-permission-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[child-session-permission-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[child-session-permission-smoke] steps: ${JSON.stringify(stepStatus)} — ${verdict}`);

  try {
    ctx.mkdirEvidenceDir();
    const resultPath = join(ctx.evidenceDir, "permission-result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verdict,
          failedStep,
          stepStatus,
          modeConfirmed: ctx.modeConfirmed ?? null,
          step6: {
            skipped: ctx.step6Skipped === true,
            skipReason: ctx.step6SkipReason ?? null,
            toolCallId: ctx.step6ToolCallId ?? null,
            childSessionId: ctx.step6ChildSessionId ?? null,
            childRowMode: ctx.step6ChildRowMode ?? null,
            badgeGeo: ctx.step6BadgeGeo ?? null,
            modalGeo: ctx.step6ModalGeo ?? null,
          },
          step7: {
            skipped: ctx.step7Skipped === true,
            toolCallId: ctx.step7ToolCallId ?? null,
            childSessionId: ctx.step7ChildSessionId ?? null,
            observation: ctx.step7Observation ?? null,
            result: ctx.step7Result ?? null,
          },
          step12: {
            rootSessionId: ctx.rootSessionId ?? null,
            deletedSessionIds: ctx.deletedSessionIds ?? null,
            tableNames: ctx.step12TableNames ?? null,
            leaked: ctx.step12Leaked ?? null,
          },
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`           result json: ${resultPath}`);
  } catch (err) {
    console.warn(`[child-session-permission-smoke] failed to write permission-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[child-session-permission-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`, ctx.stepStatus ?? {})
      .catch((err) => console.error(`[child-session-permission-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    appQuitByStep12: false,
    stepStatus: { 6: "not_run", 7: "not_run", 12: "not_run" },
  };
  ctx.mkdirEvidenceDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.evidenceDir)}, {recursive:true})`]);
    } catch {
      // fall through to the caller's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  // Each of the three tracked items (6, 7, 12) gets its own real, reported
  // attempt — a FAIL on one must not silently rob the others of a live run.
  // Only a SmokeFailure (an assert() inside one of these three functions) is
  // caught per-step and swallowed to let the next item run; any OTHER error
  // (infra: launch/CDP/etc.) still aborts the whole run, same as every
  // precedent script.
  let failedStep = null;
  async function runTrackedStep(num, fn) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof SmokeFailure) {
        ctx.stepStatus[num] = "FAIL";
        failedStep = failedStep ?? num;
        console.error(`[child-session-permission-smoke] step ${num} FAILED — continuing to the remaining tracked steps for a full report`);
        return false;
      }
      throw err;
    }
  }

  try {
    ctx.cdpPort = await reserveUnusedPort();
    process.env.REMOTE_DEBUGGING_PORT = String(ctx.cdpPort);

    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);

    ctx.cdp = await cdpConnect(ctx.cdpPort);

    if (await runTrackedStep(6, () => step6PermissionAsk(ctx))) {
      ctx.stepStatus[6] = ctx.step6Skipped ? "skipped" : "pass";
    }
    if (await runTrackedStep(7, () => step7Steering(ctx))) {
      ctx.stepStatus[7] = ctx.step7Skipped ? "skipped" : "pass";
    }
    if (await runTrackedStep(12, () => step12SqliteCascade(ctx))) {
      ctx.stepStatus[12] = "pass";
    }
  } catch (err) {
    failedStep = failedStep ?? (err instanceof SmokeFailure ? err.step : "unknown");
    if (typeof err?.step === "number" && ctx.stepStatus[err.step] !== undefined) {
      ctx.stepStatus[err.step] = "FAIL";
    }
    if (!(err instanceof SmokeFailure)) {
      console.error(`[child-session-permission-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep, ctx.stepStatus);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[child-session-permission-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

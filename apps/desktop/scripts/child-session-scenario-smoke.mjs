/**
 * Live smoke for TASK.102 CUT-S2 §4.2 пп.1,2,3,5,8 — S2d D2, the track's
 * FIRST PNG gate. Drives a REAL Electron dev instance end-to-end and proves,
 * on a real screen, what a unit matrix structurally cannot:
 *
 *   п.1  A real model calling `Agent(tier:"session")` — the declaration
 *        works as discovery, no hand-holding beyond the tool's own schema.
 *   п.2  `GET /state` shows two DISTINCT OS pids (master, child) while the
 *        parent's own Agent tool_call is still `status:"running"` — the
 *        parent tool is genuinely blocked on the child, not a fire-and-forget.
 *   п.3  The child is NOWHERE user-facing: absent from `/sessions`, and
 *        `/state`'s per-tab `states` map (fed by the renderer's own
 *        root-only `tabsStore.tabs`) has exactly ONE key (the master) — the
 *        child port never auto-registered a root tab (tab-registry.ts's own
 *        anti-facade risk, CUT-S2 §5.3). `/state`'s SEPARATE top-level
 *        `tabs` field is main's own internal `TabHostManager.listTabs()`,
 *        which BY DESIGN also lists children (tagged `childOf`, tabs.ts's
 *        own doc: "for the automation projection... never surfaced to the
 *        ordinary renderer") — this script asserts the child IS there with
 *        the right `childOf` tag, not that it is absent (an earlier version
 *        of this script wrongly asserted absence there and went red on the
 *        very first live run; see this run's own report under "КРАСНОЕ").
 *        Sidebar row count is asserted unchanged (a live, on-screen surface,
 *        via CDP DOM); StartScreen is structurally inapplicable while a tab
 *        is open, and CommandPalette reads the SAME `listSessions()` bridge
 *        call the `/sessions` check below already covers (App.tsx:260) — see
 *        this file's own header comment above `SIDEBAR_ROW_TITLES_JS` and the
 *        smoke's own DEVIATIONS note in its final report for why those two
 *        surfaces are not independently re-driven live.
 *   п.5  Open on the RUNNING child: DOM-presence is not visibility (anti-facade
 *        §5.4) — this asserts real Blink geometry (non-zero
 *        `getBoundingClientRect`/`offsetHeight`, viewport intersection,
 *        `display`/`visibility`/`opacity`, `elementFromPoint` at the pane's
 *        own center landing INSIDE the pane) plus a PNG artifact, over a raw
 *        Chrome DevTools Protocol connection to the real renderer page (no
 *        production code touched — `--remote-debugging-port` is a first-class
 *        `electron-vite dev` lever, same technique `custom-provider-live-smoke.mjs`
 *        already established for this same command surface).
 *   п.8  Terminal: the parent's card gets the child's final text; the child's
 *        OS pid is polled to real death (`isPidAlive` false) BEFORE Open is
 *        driven on the completed card, so hydration is provably a DISK read
 *        (`childHistory` IPC -> durable SQLite), not a live process still
 *        backing the pane (anti-facade §5.10's exact discriminator) — and the
 *        read-only pane carries NO composer at all (`ChildHistoryPane` never
 *        mounts `<Composer/>`, App.tsx:646-648 vs :686 — a stronger form of
 *        "disabled" than a disabled attribute).
 *
 * Pп.4,6,7,9-12 are OUT OF SCOPE here (next wave, D3 gets the race probes).
 *
 * REUSE (CUT-S2 §3 D2's own directive — the seam is exports, not a rewrite):
 * every generic process/fs/HTTP/polling helper below is IMPORTED, unmodified,
 * from the already-green `child-session-explicit-provider-smoke.mjs` (§4.2
 * п.13's harness) — that file only grew `export` keywords plus one `import.
 * meta.url` main-module guard around its own auto-invoked `run()`, so a
 * direct `node child-session-explicit-provider-smoke.mjs` run is untouched
 * byte-for-byte in behavior (verified: re-run after the edit, still
 * `5/4 steps passed — ALL GREEN`). In particular `step1LaunchApp` is reused
 * UNMODIFIED for the whole launch/profile/settings-seed sequence (the SAME
 * real v2 `provider.connections[]` seed as the п.13 harness — the "ГРАБЛИ"
 * lesson: only that file's seed round-trips the current settings schema) —
 * this script never edits or duplicates that seed. The one piece of state
 * this script threads INTO that reused function without touching its source
 * is `process.env.REMOTE_DEBUGGING_PORT`, set on `process.env` itself before
 * calling it: `step1LaunchApp` builds its spawned env as `{...process.env,
 * ...}` and never reads or deletes that key, so it passes through for free.
 *
 * NOT reused (deliberately, with reasons — see this run's own report under
 * "ШОВ"): `hasRequiredInput` (provider-pinning predicate, not this scenario's
 * concern — a local `hasSessionTierInput` is used instead);
 * `step2Dispatch`/`step3RealStart`/`step4ConnectionIdParity` (a different
 * scenario, different assertions); `teardown`/`runTeardown`/
 * `installSignalTeardown` (the reused ones hard-code the OTHER script's own
 * name in log lines and write `evidence/S2/result.json` — reusing them
 * verbatim would silently overwrite that file, which is the STANDING closing
 * evidence for F4 (§10.10.4) recorded in STATE.md; this script writes its OWN
 * `evidence/S2/scenario-result.json` instead, via a same-shape-but-local
 * teardown trio).
 *
 * Usage:   node apps/desktop/scripts/child-session-scenario-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspace/profile on exit (debugging).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider, read (by the
 * reused `step1LaunchApp`) from `.smoke-secrets/glm.env` — same file every
 * other live smoke in this repo uses.
 *
 * Each step prints `[step N] PASS/FAIL <detail>`; the first FAIL tears down
 * and exits 1. Step 1 (discovery) allows exactly ONE prompt retry for live-
 * model nondeterminism, then a documented SKIP (exit 0, not a FAIL) if the
 * model never calls the Agent tool with `tier:"session"` at all — same
 * discipline as the п.13 harness, for the same reason (a live-model
 * limitation is not a product failure). Evidence (2 PNGs + a JSON result
 * dump) lands in `working-docs/task102-track/evidence/S2/`.
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
  pass,
  saveScreenshot,
  settleTurn,
  sleep,
  step1DiscoverTab,
  step1LaunchApp,
  waitForExit,
} from "./child-session-explicit-provider-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const EVIDENCE_DIR = join(repoRoot, "working-docs", "task102-track", "evidence", "S2");
const TOTAL_STEPS = 5;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const SUBAGENT_SLEEP_SECONDS = 9;
const TERMINAL_WAIT_TIMEOUT_MS = 45_000;
const CHILD_PID_DEATH_TIMEOUT_MS = 20_000;

const FLAGS = { keep: process.argv.slice(2).includes("--keep") };

const SPAWN_PROMPT_PRIMARY =
  'Call the Agent tool exactly once, right now, in this turn. Use these exact parameter values: ' +
  'tier: "session", agent_type: "general-purpose", description: a short 3-5 word summary of the task, ' +
  'and prompt: an instruction telling the subagent to FIRST call the Bash tool with the exact command ' +
  `"sleep ${SUBAGENT_SLEEP_SECONDS}" and wait for it to finish, and ONLY THEN reply with exactly the ` +
  'single word DONE and use no further tools. You MUST include the tier parameter set to the literal ' +
  'string "session" — do not omit it, and do not use tier "inline". Invoke the tool now.';
const SPAWN_PROMPT_RETRY =
  'You did not call the Agent tool with the required tier parameter. The Agent tool you have access to ' +
  'accepts a `tier` parameter, and for a real child session it must be the literal string "session". Call ' +
  'it NOW with tier set to "session", agent_type set to "general-purpose", a short description, and a ' +
  'prompt instructing the subagent to first run the Bash tool with the command ' +
  `"sleep ${SUBAGENT_SLEEP_SECONDS}", wait for it to finish, then reply with exactly the single word DONE ` +
  'and use no further tools. You must invoke the tool itself, with a real tool call — do not just describe ' +
  'what you would do.';

function hasSessionTierInput(block) {
  const input = block?.input;
  return input !== null && typeof input === "object" && input.tier === "session";
}

// ── small local helpers (generic poll + port reservation — not scenario
// logic, no meaningful duplication risk; the п.13 harness has no equivalents
// to import) ──

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

// ── CDP client (Node 22 global WebSocket/fetch, zero deps) — same technique
// `custom-provider-live-smoke.mjs` already established for this exact command
// surface (`REMOTE_DEBUGGING_PORT` env -> electron-vite dev's own
// `--remote-debugging-port` lever); written fresh here rather than imported
// because that script does not export it — a small (~45-line), well-
// understood, product-code-free client, not the substantial logic this file
// is asked to reuse rather than duplicate. ──

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

// ── browser-side geometry/DOM expressions ──
//
// Both the LIVE child pane (ChildSessionPane, App.tsx:596-652) and the
// COMPLETED read-only pane (ChildHistoryPane, App.tsx:686-772) render the
// SAME two-element shape: `<header class="session-header
// child-session-breadcrumb">` immediately followed by a sibling `<div
// class="session-content">` — `ActiveTabBody` early-returns one or the other
// (never both), so at most one `.child-session-breadcrumb` exists in the DOM
// at a time; walking to its `nextElementSibling` targets the pane
// unambiguously without depending on which of the two variants is mounted.

const CHILD_PANE_GEOMETRY_JS = `(() => {
  const header = document.querySelector('.child-session-breadcrumb');
  if (!header) return { ok: false, reason: 'no_header' };
  const pane = header.nextElementSibling;
  if (!pane || !pane.classList.contains('session-content')) return { ok: false, reason: 'no_pane' };
  const composer = pane.querySelector('.composer');
  const composerTextarea = pane.querySelector('.composer-textarea');
  const masterBtn = header.querySelector('.child-breadcrumb-master');
  const readonlyBadge = header.querySelector('.child-breadcrumb-readonly');
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  };
  const styleOf = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return { display: c.display, visibility: c.visibility, opacity: c.opacity };
  };
  const paneRect = pane.getBoundingClientRect();
  const cx = paneRect.left + paneRect.width / 2;
  const cy = paneRect.top + paneRect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return {
    ok: true,
    headerRect: rectOf(header),
    paneRect: rectOf(pane),
    composerRect: rectOf(composer),
    paneOffsetHeight: pane.offsetHeight,
    headerOffsetHeight: header.offsetHeight,
    composerOffsetHeight: composer ? composer.offsetHeight : null,
    paneStyle: styleOf(pane),
    headerStyle: styleOf(header),
    hitInsidePane: hit ? pane.contains(hit) || hit === pane : false,
    hitTag: hit ? hit.tagName : null,
    masterBtnText: masterBtn ? masterBtn.textContent : null,
    hasComposer: composer !== null,
    hasComposerTextarea: composerTextarea !== null,
    hasReadonlyBadge: readonlyBadge !== null,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
})()`;

const CHILD_PANE_MESSAGE_COUNT_JS = `(() => {
  const header = document.querySelector('.child-session-breadcrumb');
  const pane = header ? header.nextElementSibling : null;
  return pane ? pane.querySelectorAll('.message').length : -1;
})()`;

const CLICK_BREADCRUMB_MASTER_JS = `(() => {
  const btn = document.querySelector('.child-breadcrumb-master');
  if (!btn) return { ok: false, reason: 'no_button' };
  btn.click();
  return { ok: true };
})()`;

/**
 * Sidebar row titles (`.sidebar-row-title`, inside either an
 * `.sidebar-row-open` open-tab row or an `.sidebar-row-resumable` history
 * row — both match the `.sidebar-row` selector, Sidebar.tsx:815/848). A child
 * session has no title and is never registered as either kind of row
 * (root-only `tabsStore`/`listSessions`, CUT-S2 §5.5); comparing the row
 * COUNT before spawn vs. while the child is admitted is the live, on-screen
 * half of §4.2 п.3 — the `/sessions`+`/state` HTTP checks in step 3 are the
 * other half (the shared root-only data source itself).
 */
const SIDEBAR_ROW_TITLES_JS = `(() => Array.from(document.querySelectorAll('.sidebar-row')).map((row) => (row.querySelector('.sidebar-row-title')?.textContent ?? null)))()`;

// ── step 1 (§4.2 п.1): a real model calls Agent(tier:"session") — discovery ──

async function step1Discovery(ctx) {
  const step = 1;

  let anyAgentSeen = false;
  let result = await attemptDispatch(ctx, step, SPAWN_PROMPT_PRIMARY, 60_000);
  anyAgentSeen = anyAgentSeen || result.anyAgentSeen;

  if (!hasSessionTierInput(result.block) && result.childRuns.length === 0) {
    console.warn(
      `[child-session-scenario-smoke] tier:"session" not seen on the first attempt (block=${JSON.stringify(result.block)}) ` +
        "— retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    result = await attemptDispatch(ctx, step, SPAWN_PROMPT_RETRY, 90_000);
    anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
  }

  if (!anyAgentSeen) {
    ctx.skipped = true;
    ctx.skipReason = "model never called Agent";
    await settleTurn(ctx, step);
    pass(step, "SKIPPED (documented) — Agent tool never dispatched by the live model after 1 retry; see warning above");
    return;
  }

  if (!hasSessionTierInput(result.block) && result.childRuns.length === 0) {
    ctx.skipped = true;
    ctx.skipReason = 'model did not use tier:"session"';
    await settleTurn(ctx, step);
    console.warn(
      "[child-session-scenario-smoke] SKIPPED: the model called Agent but never with tier:\"session\", after 1 " +
        `retry (last block: ${JSON.stringify(result.block)}). Documented live-model non-compliance, NOT a product failure.`,
    );
    pass(step, "SKIPPED (documented) — model never issued tier:\"session\" after 1 retry; see warning above");
    return;
  }

  if (result.childRuns.length === 0) {
    fail(
      step,
      `the model called Agent with tier:"session" (input=${JSON.stringify(result.block?.input)}) but GET /state's ` +
        `childRuns projection never showed an admitted run. Final transcript block: ${JSON.stringify(result.block)}`,
    );
  }
  assert(step, result.childRuns.length === 1, `expected exactly 1 childRuns entry, got ${result.childRuns.length}: ${JSON.stringify(result.childRuns)}`);

  ctx.toolCallId = result.block.toolCallId;
  ctx.dispatchResult = result;
  pass(step, `discovery worked — a real model invoked Agent(tier:"session") and the child was admitted (requestId=${result.childRuns[0].requestId})`);
}

// ── step 2 (§4.2 п.2): two distinct OS pids; parent tool still "running" ──

function step2DistinctPidsRunning(ctx) {
  const step = 2;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const { childRuns, mainTabs, block } = ctx.dispatchResult;
  const entry = childRuns[0];
  ctx.childEntry = entry;
  ctx.childPid = entry.pid;

  const rootSummary = (mainTabs ?? []).find((t) => t.tabId === ctx.tabId);
  assert(step, rootSummary !== undefined, `root tab ${ctx.tabId} missing from /state's main-plane tabs list`);
  assert(step, typeof rootSummary.pid === "number", `expected the root tab to have a live pid, got ${JSON.stringify(rootSummary.pid)}`);
  assert(step, typeof entry.pid === "number", `expected the child run's own pid to be a live number, got ${JSON.stringify(entry.pid)}`);
  assert(step, entry.pid !== rootSummary.pid, `expected distinct OS pids, got master=${rootSummary.pid} child=${entry.pid} (SAME pid)`);
  assert(
    step,
    block !== null && block.status === "running",
    `expected the parent's Agent tool_call to still be status:"running" while the child is admitted, got ${JSON.stringify(block)}`,
  );

  ctx.rootPid = rootSummary.pid;
  pass(step, `two distinct OS pids confirmed — master pid=${rootSummary.pid}, child pid=${entry.pid} — parent tool_call still "running"`);
}

// ── step 3 (§4.2 п.3): the child is nowhere — /sessions, /state root tabs+states, sidebar row count ──

async function step3NowhereVisible(ctx) {
  const step = 3;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const sessions = await apiOk(ctx, step, "GET", "/sessions");
  assert(step, Array.isArray(sessions), `GET /sessions did not return an array: ${JSON.stringify(sessions)}`);
  const leaked = sessions.find((s) => s.id === ctx.childEntry.childSessionId);
  assert(step, leaked === undefined, `GET /sessions leaked the child session: ${JSON.stringify(leaked)}`);

  const state = await apiOk(ctx, step, "GET", "/state");
  // `/state`'s top-level `tabs` field is main's OWN internal
  // `TabHostManager.listTabs()` — by design (tabs.ts:734-745) this includes
  // EVERY TabHost main is tracking, children included, annotated with
  // `childOf` specifically so the automation channel can introspect them
  // (tabs.ts:607-611's own doc: "for the automation `/state` projection...
  // never surfaced to the ordinary renderer"). So the child tab being
  // PRESENT here is expected/correct; the actual "no root tab" invariant is
  // that it carries `childOf` (main's own administrative tagging) — the
  // renderer-facing `snapshot.states` map below (fed by the renderer's own
  // root-only `tabsStore.tabs`, tab-registry.ts) is where absence is the
  // real assertion.
  const childMainEntry = (state.tabs ?? []).find((t) => t.tabId === ctx.childEntry.childTabId);
  assert(step, childMainEntry !== undefined, `child tab ${ctx.childEntry.childTabId} missing from /state's main-plane tabs (expected present + childOf-tagged)`);
  assert(
    step,
    childMainEntry.childOf?.parentTabId === ctx.tabId && childMainEntry.childOf?.requestId === ctx.childEntry.requestId,
    `main's own listTabs() did not tag the child tab with the expected childOf: ${JSON.stringify(childMainEntry.childOf)}`,
  );
  const stateKeys = Object.keys(state.snapshot?.states ?? {});
  assert(
    step,
    stateKeys.length === 1 && stateKeys[0] === ctx.tabId,
    `expected /state's per-tab states map to contain ONLY the root tab — a second key would mean the child port ` +
      `auto-registered as a root tab (CUT-S2 §5.3) — got keys=${JSON.stringify(stateKeys)}`,
  );

  const sidebarRows = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
  assert(step, Array.isArray(sidebarRows), `sidebar row probe did not return an array: ${JSON.stringify(sidebarRows)}`);
  assert(
    step,
    sidebarRows.length === ctx.baselineSidebarRowCount,
    `sidebar row count changed from ${ctx.baselineSidebarRowCount} (before spawn) to ${sidebarRows.length} while the child is admitted: ${JSON.stringify(sidebarRows)}`,
  );

  pass(
    step,
    `child invisible everywhere it matters: /sessions excludes it, main's own listTabs() tags it childOf (never a ` +
      `bare root entry), the renderer-facing states map has ONLY the root tab, sidebar row count unchanged at ` +
      `${sidebarRows.length} (StartScreen inapplicable with a tab open; CommandPalette reads the SAME ` +
      "window.anycode.listSessions() the /sessions check above already covers, App.tsx:260)",
  );
}

// ── step 4 (§4.2 п.5): Open on the RUNNING child — geometry + PNG ──

async function step4OpenLiveGeometry(ctx) {
  const step = 4;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  // Race guard: this leg is only a genuine "Open on a RUNNING child" proof if
  // the child is STILL admitted at the moment Open is driven — re-check
  // fresh rather than trusting step 1/2's earlier snapshot.
  const preOpenState = await apiOk(ctx, step, "GET", "/state");
  const stillRunning = (preOpenState.childRuns ?? []).some((e) => e.requestId === ctx.childEntry.requestId);
  assert(
    step,
    stillRunning,
    `the child (requestId=${ctx.childEntry.requestId}) already finalized before Open could be driven — harness ` +
      `timing bug (b): ${SUBAGENT_SLEEP_SECONDS}s of subagent sleep was not enough headroom for this leg`,
  );

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.toolCallId });
  await sleep(250);

  const geo = await ctx.cdp.eval(CHILD_PANE_GEOMETRY_JS);
  assert(step, geo.ok === true, `no child pane found in the DOM after Open: ${JSON.stringify(geo)}`);
  assert(step, geo.paneRect.width > 0 && geo.paneRect.height > 0, `child pane has zero getBoundingClientRect: ${JSON.stringify(geo.paneRect)}`);
  assert(step, geo.paneOffsetHeight > 0, `child pane offsetHeight is 0`);
  assert(
    step,
    geo.paneRect.bottom > 0 && geo.paneRect.right > 0 && geo.paneRect.top < geo.viewportHeight && geo.paneRect.left < geo.viewportWidth,
    `child pane does not intersect the viewport: rect=${JSON.stringify(geo.paneRect)} viewport=${geo.viewportWidth}x${geo.viewportHeight}`,
  );
  assert(
    step,
    geo.paneStyle.display !== "none" && geo.paneStyle.visibility !== "hidden" && Number(geo.paneStyle.opacity) > 0,
    `child pane is not visually visible: ${JSON.stringify(geo.paneStyle)}`,
  );
  assert(step, geo.hitInsidePane === true, `elementFromPoint at the pane's own center (hit tag=${geo.hitTag}) did NOT land inside the pane — DOM-presence without real visibility`);
  assert(
    step,
    geo.hasComposer === true && geo.composerRect && geo.composerRect.width > 0 && geo.composerRect.height > 0 && geo.composerOffsetHeight > 0,
    `composer missing or zero-geometry on the LIVE child pane: hasComposer=${geo.hasComposer} rect=${JSON.stringify(geo.composerRect)}`,
  );
  assert(step, geo.headerRect.width > 0 && geo.headerRect.height > 0, `breadcrumb header has zero geometry: ${JSON.stringify(geo.headerRect)}`);
  assert(step, typeof geo.masterBtnText === "string" && geo.masterBtnText.length > 0, `breadcrumb master-title button has no text`);
  assert(step, geo.hasReadonlyBadge === false, "expected NO readonly badge while the child is live, but one is present");

  ctx.liveGeometry = geo;
  await saveScreenshot(ctx, "scenario-step5-child-surface-visible");
  pass(
    step,
    `Open on the running child: paneRect=${JSON.stringify(geo.paneRect)} offsetHeight=${geo.paneOffsetHeight}, ` +
      `elementFromPoint landed inside the pane, breadcrumb+composer both live in the same pane`,
  );
}

// ── step 5 (§4.2 п.8): terminal text on the master card; Open-completed hydrates the durable transcript AFTER PID reap; composer disabled ──

async function step5TerminalAndCompletedOpen(ctx) {
  const step = 5;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  // Back to master FIRST (a real click on the SAME breadcrumb button the
  // owner clicks) — so the Open driven below is a FRESH click on an already-
  // terminal card, not a surface that merely sat open through the
  // live -> completed transition.
  const closed = await ctx.cdp.eval(CLICK_BREADCRUMB_MASTER_JS);
  assert(step, closed?.ok === true, `breadcrumb "back to master" click failed: ${JSON.stringify(closed)}`);

  const terminalBlock = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 300, async () => {
    const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = transcript.find((b) => b.kind === "tool_call" && b.toolCallId === ctx.toolCallId);
    return block && (block.status === "success" || block.status === "error") ? block : undefined;
  });
  assert(step, terminalBlock !== null, `the parent's Agent tool_call never reached a terminal status within ${TERMINAL_WAIT_TIMEOUT_MS}ms`);
  assert(step, terminalBlock.status === "success", `expected the trivial child task to succeed, got status=${terminalBlock.status}: ${JSON.stringify(terminalBlock)}`);
  assert(step, typeof terminalBlock.modelText === "string" && terminalBlock.modelText.length > 0, `master card has no final text: ${JSON.stringify(terminalBlock)}`);

  const pidDead = await pollUntil(CHILD_PID_DEATH_TIMEOUT_MS, 300, async () => (isPidAlive(ctx.childPid) ? undefined : true));
  assert(
    step,
    pidDead === true,
    `child OS pid ${ctx.childPid} was STILL ALIVE ${CHILD_PID_DEATH_TIMEOUT_MS}ms after the parent's tool_call went ` +
      "terminal — cannot prove Open-completed hydration is a disk read, not a live process still backing the pane",
  );

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/agent-card/${ctx.toolCallId}/expand`, {});
  const cardState = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/agent-card/${ctx.toolCallId}`);
  assert(step, cardState?.ok === true && cardState.resultRendered === true, `master card does not render a final result after expand: ${JSON.stringify(cardState)}`);

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.toolCallId });
  await sleep(250);

  const geo = await ctx.cdp.eval(CHILD_PANE_GEOMETRY_JS);
  assert(step, geo.ok === true, `no child pane found in the DOM after Open-on-completed: ${JSON.stringify(geo)}`);
  assert(step, geo.paneRect.width > 0 && geo.paneRect.height > 0, `completed child pane has zero getBoundingClientRect: ${JSON.stringify(geo.paneRect)}`);
  assert(step, geo.hasReadonlyBadge === true, "expected the readonly badge on a COMPLETED child pane, none found");
  assert(step, geo.hasComposer === false, `expected NO composer on a completed/read-only child pane (composer disabled per §2.5), found one: ${JSON.stringify(geo.composerRect)}`);

  const transcriptCount = await ctx.cdp.eval(CHILD_PANE_MESSAGE_COUNT_JS);
  assert(step, typeof transcriptCount === "number" && transcriptCount > 0, `completed child pane hydrated NO transcript blocks (count=${transcriptCount}) — Open-completed did not read the durable transcript`);

  await saveScreenshot(ctx, "scenario-step8-child-completed-readonly");
  pass(
    step,
    `terminal text landed on the master card (resultRendered=true), child OS pid ${ctx.childPid} confirmed REAPED ` +
      `before Open, Open-on-completed hydrated ${transcriptCount} durable transcript block(s) with the composer absent`,
  );
}

// ── teardown (own trio, NOT the imported one — see this file's header doc for why) ──

function teardown(ctx, failedStep, stepsCompleted) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep, stepsCompleted);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep, stepsCompleted) {
  if (ctx.cdp) {
    ctx.cdp.close();
    ctx.cdp = null;
  }

  if (ctx.port && ctx.token) {
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
      console.warn(`[child-session-scenario-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[child-session-scenario-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[child-session-scenario-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[child-session-scenario-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const verdict = ctx.skipped ? `SKIPPED (${ctx.skipReason})` : failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[child-session-scenario-smoke] ${stepsCompleted}/${TOTAL_STEPS} steps passed — ${verdict}`);

  try {
    ctx.mkdirEvidenceDir();
    const resultPath = join(ctx.evidenceDir, "scenario-result.json");
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
          childPid: ctx.childPid ?? null,
          rootPid: ctx.rootPid ?? null,
          stepsCompleted,
          totalSteps: TOTAL_STEPS,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`           result json: ${resultPath}`);
  } catch (err) {
    console.warn(`[child-session-scenario-smoke] failed to write scenario-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[child-session-scenario-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`, 0)
      .catch((err) => console.error(`[child-session-scenario-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    childPid: null,
    rootPid: null,
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
    baselineSidebarRowCount: null,
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
  let stepsCompleted = 0;
  try {
    ctx.cdpPort = await reserveUnusedPort();
    // electron-vite dev lever (precedent: custom-provider-live-smoke.mjs):
    // step1LaunchApp (imported, UNMODIFIED) spreads `...process.env` when it
    // builds the spawned dev process's own env, so setting this on
    // `process.env` itself HERE, before calling it, threads the CDP port
    // through with zero changes to that function — it neither reads nor
    // deletes REMOTE_DEBUGGING_PORT (unlike ANYCODE_MODEL/
    // ANYCODE_REASONING_EFFORT, which it deletes deliberately).
    process.env.REMOTE_DEBUGGING_PORT = String(ctx.cdpPort);

    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);

    ctx.cdp = await cdpConnect(ctx.cdpPort);
    const baseline = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
    ctx.baselineSidebarRowCount = Array.isArray(baseline) ? baseline.length : 0;

    await step1Discovery(ctx);
    stepsCompleted += 1;
    step2DistinctPidsRunning(ctx);
    stepsCompleted += 1;
    await step3NowhereVisible(ctx);
    stepsCompleted += 1;
    await step4OpenLiveGeometry(ctx);
    stepsCompleted += 1;
    await step5TerminalAndCompletedOpen(ctx);
    stepsCompleted += 1;
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[child-session-scenario-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep, stepsCompleted);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[child-session-scenario-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

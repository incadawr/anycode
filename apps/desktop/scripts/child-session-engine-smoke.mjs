/**
 * Live smoke for TASK.102 CUT-S4 §6.2/§6.3 (slice S4d) — the ONE gate that
 * proves the security hole S4 closes is actually closed: an `engine:
 * claude|codex` md-profile, spawned through the Agent tool, now runs as a
 * REAL child SESSION (startClaudeEngine/startCodexEngine, the same
 * interactive brokered runtime S2 built for core children) instead of the
 * pre-S4 bare `claude -p --permission-mode acceptEdits` / `codex exec
 * --sandbox workspace-write -c approval_policy=never` one-shot that never
 * touched AnyCode's own permission gate at all. A unit matrix can pin every
 * call site; only a REAL dev instance, a REAL external CLI subprocess, and a
 * REAL click on a REAL modal can prove the gate is actually IN the path
 * (CUT-S4 §8's whole anti-facade list).
 *
 * Drives a REAL Electron dev instance end-to-end over the automation HTTP
 * channel + CDP, exactly the class of harness CUT-S4 §6.2 names as its own
 * precedent: `child-session-permission-smoke.mjs` (same GLM-master /
 * `.smoke-secrets/glm.env` / per-run disposable profile discipline, same
 * modal-geometry technique). `child-session-split-smoke.mjs` supplied the
 * newer, stricter mechanics this file also uses: the viewport-CLAMPED
 * hit-test centre (an element whose own rect centre sits off-screen makes
 * `elementFromPoint` return null there by definition — a false "hit outside"
 * this track has already paid for once; CUT-S4's own law #1 makes this
 * mandatory here, not optional), the app-stderr fd-2 redirection +
 * startup-window sentinel (a boot-race stderr dump above the sentinel is
 * allowlisted, the SAME dump below it is a real finding), and the
 * `0 = ALL GREEN / 1 = FAIL / 2 = SKIP` exit-code arbitration (a SKIP proves
 * nothing and must never look like 7/7 to a caller reading only the exit
 * code — CUT-S4 §0.8).
 *
 * SCOPE / one invocation = one engine (CUT-S4 §6.2's own "сценарий
 * параметризуется движком... тем же кодом вторым прогоном"): this script
 * takes `--engine claude|codex` (default `claude`, the mandatory engine per
 * §0.6 п.2's ordering — "бридж богаче, бинарь гарантирован дев-машиной").
 * The orchestrator runs it TWICE, once per engine, and arbitrates §0.6 п.2
 * ("движок без зелёного прогона -> честный unsupported-отказ, не остаётся на
 * one-shot") off the two independent exit codes/result JSONs — this script
 * does not itself decide that policy, it only supplies the evidence.
 *
 * Contracts this script is written against are FROZEN by CUT-S4 (this
 * builder's own fence is this ONE file — core/wire/host are two OTHER
 * builders' concurrent work in the same worktree, not yet landed at the time
 * this file was written): `ChildSpawnRequest.engine`/`SubagentProgress{kind:
 * "start"}.engine` (§2.3/§3.1) surfaces on the master's own transcript block
 * as `block.subagent.engine` (already wired end-to-end from TASK.97 R5 up to
 * the renderer chip, `ToolCallCard.tsx`'s `formatSubagentCounters` — S4 only
 * makes the PRODUCER at the session route set it); the durable child row's
 * `SessionMeta.engineId` (persistence.ts, existing field, stamped for engine
 * children by S4c) surfaces through the existing dev-only `GET /child-runs`
 * maintenance route verbatim (no route-shape change needed — that route
 * already returns full `SessionMeta` rows, `automation/handlers.ts`'s
 * `listChildRunsMaintenance`). Nothing in this file assumes a NEW route or a
 * NEW facade method beyond what S2/S3 already shipped.
 *
 * Engine-profile seeding (CUT-S4 §6.2: "сид-профиль `engine: claude` в
 * `.anycode/agents/` воркспейса кладёт САМ скрипт (и убирает за собой)"):
 * `seedEngineProfile`/`removeEngineProfile` below write/remove exactly one
 * `<workspace>/.anycode/agents/task-helper.md` file, project-root precedence
 * (`admin-scan.ts`'s `buildAgentProfileRoots`), format verified against
 * `parseAgentProfileMd` (packages/core/src/subagents/profiles.ts) and its own
 * `profiles.test.ts` fixtures: flat `---\nname:\ndescription:\nengine:\n---\n`
 * frontmatter, NO `tools:` line (combining `tools:` with `engine:` is a fatal
 * `engine_tools_conflict` parse error, TASK.97 R4, byte-frozen by this cut).
 * Discovery is a live rescan gated on the master's OWN next turn start
 * (`host/index.ts`'s `refreshExtensionProfiles`, called from `onBeforeTurn`)
 * — no app restart needed, the file only has to exist before this script's
 * FIRST prompt dispatch, which it does (seeded right after the workspace
 * directory exists, well before any turn is sent).
 *
 * Tool-name substring choice (used to assert the permission modal is showing
 * the RIGHT ask, not a stale/wrong one): a REAL Claude Code CLI child's own
 * `can_use_tool` wire message reports its file-write tool as literally
 * `"Write"`, passed through UNMAPPED by `engines/claude/approval-bridge.ts`'s
 * `toPermissionRequest` (byte-pinned against a real captured CLI session,
 * `engines/claude/contract/fixtures/w0-02-control-writeprobe.jsonl`) — so
 * Claude's modal title reads "Allow Write to write this file?" and its
 * `.permission-input-value` shows the exact file path (`summarizeInput`'s
 * Write/Edit branch, `PermissionModal.tsx`). Codex's app-server protocol has
 * NO per-tool name at all (method + item-index only) — AnyCode's own
 * `engines/codex/approval-bridge.ts` INVENTS the label `"CodexApplyPatch"`
 * for a file-change ask (no `TITLE_ACTIONS` entry, so the modal title is the
 * generic "Allow CodexApplyPatch?"), and its content preview is a raw
 * `JSON.stringify` of `{reason, grantRoot, changes, paths}` — `changes`/
 * `paths` are populated by an `item/started` CORRELATION that is documented
 * as fallible ("No entry -> degraded description, still shown" — L9), so the
 * exact-path substring check on Codex's own preview is best-effort/logged,
 * never hard-asserted (see `openChildAndWaitModal`'s callers) — the load-
 * bearing assertions for BOTH engines are the modal TITLE substring and,
 * above everything else, the negative/positive FILE-EXISTENCE proof (§6.2
 * пп.3-5), which is engine-agnostic by construction.
 *
 * LAWS enforced throughout (this track's own, restated because a violation
 * here would silently pass a broken gate): (1) DOM-presence != visibility —
 * every click goes through `hitTestClickJs`, hit-testing the ON-SCREEN
 * INTERSECTION centre of the target's rect with the viewport (not the rect's
 * own centre) and clicking the FOUND element, never a bare `el.click()`.
 * (2) Green exit != no error — CDP `Runtime.consoleAPICalled(type==="error")`
 * + the app's own redirected stderr are grepped clean, with a startup-window
 * sentinel drawing the boot-race/steady-state boundary (step 7). (3) Exit
 * discipline `0/1/2`, SKIP is never silently green (`run()`, bottom of file).
 * (4) The scenario's CORE assertions are NEGATIVE: no file while pending
 * (step 3), still no file after Deny (step 4) — a visible modal and a green
 * exit prove nothing on their own; only "the effect did NOT happen" does.
 * (5) Every assert prints the observed payload on failure (rect/hit target/
 * file existence/mtime/block JSON), never a bare `{ok:false}`. (6) The
 * sentinel filename is a plain, ordinary-sounding "task-status.md" carrying
 * "Status: ready" — NOT "*-proof.txt"/"injection", per this cut's own new
 * rule that a live model can recognize and refuse an obviously-adversarial
 * bait filename, producing a false SKIP that looks like a product defect.
 * (7) Generous wait budgets (240s per live terminal wait) instead of
 * "tightened" prompt wording to fix timing — a live model's own pace is not
 * this harness's to control.
 *
 * Usage:   node apps/desktop/scripts/child-session-engine-smoke.mjs [--engine claude|codex] [--keep]
 *
 *   --engine   Which engine's child to drive (default "claude" — the
 *              mandatory engine per CUT-S4 §0.6 п.2). Pass "codex" for the
 *              second, best-effort run — SAME script, SAME steps.
 *   --keep     Do not delete the temp workspace/profile on exit (debugging).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider (the MASTER's
 * own connection — the engine CHILD runs on its own separate CLI account,
 * never this connection), read from `.smoke-secrets/glm.env`, same file
 * every live smoke in this repo uses.
 *
 * Steps print `[step N] PASS/FAIL <detail>`, N matching CUT-S4 §6.2's own
 * 1..7 item numbers verbatim:
 *   1 = spawn via the engine profile; card running + engine chip + childRuns=1
 *   2 = Open -> modal live+real in the CHILD surface; badge on master, no
 *       master modal (anti-facade §8 п.1/п.2: a chujoy/wrong broker, or a
 *       modal showing before a real ask, would fail this step)
 *   3 = NEGATIVE: no file yet, tool_call still running, while pending
 *   4 = Deny -> NEGATIVE: still no file, child reaches terminal (§8 п.1/п.3)
 *   5 = re-spawn, Allow via a REAL click -> file appears AFTER the click
 *       (mtime check) with exact content (§8 п.1)
 *   6 = post-terminal re-Open -> non-empty universal-snapshot transcript,
 *       durable row's engineId/parentSessionId/spawnToolCallId match, child
 *       absent from every session list (§8 пп.4,6,7)
 *   7 = 3 PNGs captured + CDP console-error grep + app-stderr grep, both
 *       clean above AND below the startup-window sentinel (§8 п.5's own
 *       "SKIP closes the gate" risk is closed by the exit-code arbitration
 *       at the bottom of this file, not by this step)
 *
 * The dual-spawn dispatch gets exactly ONE retry per spawn for live-model
 * tool-call non-compliance, then a documented SKIP (exit 2) — same
 * discipline as every harness in this directory. A distinct SKIP path also
 * exists for a spawn that WAS issued correctly but got rejected `not_ready`
 * for an environment reason (engine binary/doctor validation unavailable on
 * this dev machine) rather than a real defect — recognized by the rejection
 * text matching `/not (ready|available)/i`; anything else that leaves
 * childRuns empty is a hard FAIL with the full block payload, never silently
 * absorbed. Evidence (3 PNGs, a JSON result dump, the redirected app-stderr
 * log) lands in `working-docs/task102-track/evidence/S4/`, filenames scoped
 * by `--engine` so a claude run and a codex run never clobber each other.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  waitForFacade,
  waitUntilTab,
} from "./child-session-explicit-provider-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const EVIDENCE_DIR = join(repoRoot, "working-docs", "task102-track", "evidence", "S4");
const TOTAL_STEPS = 7;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
/** Budgeted for the worst honest live-turn case, not the observed one (CUT-S4 law #7 — split-smoke's own TERMINAL_WAIT_TIMEOUT_MS precedent for the same reason: a tightened timeout reddens a run purely on where the model's own pace happened to fall, never a real product signal). */
const TERMINAL_WAIT_TIMEOUT_MS = 240_000;
const CHILD_ADMIT_TIMEOUT_MS = 60_000;

const PROFILE_NAME = "task-helper";
const ENGINES = new Set(["claude", "codex"]);
/** Chosen per CUT-S4 §8 (see this file's own header doc) — the exact tool-name substring a REAL modal for a file-write ask shows for each engine. */
const TOOL_NAME_BY_ENGINE = { claude: "Write", codex: "CodexApplyPatch" };

function parseArgs(argv) {
  const flags = { engine: "claude", keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--engine") {
      i += 1;
      flags.engine = argv[i];
    } else if (arg === "--keep") {
      flags.keep = true;
    } else {
      console.warn(`[child-session-engine-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  if (!ENGINES.has(flags.engine)) {
    console.error(`[child-session-engine-smoke] --engine must be "claude" or "codex", got ${JSON.stringify(flags.engine)}`);
    process.exit(1);
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));
const ENGINE = FLAGS.engine;
const LOG = `[child-session-engine-smoke:${ENGINE}]`;

// ── app-stderr redirection (CUT-S4 law #2 — same technique/rationale as
// `child-session-split-smoke.mjs`'s own header doc: `child.stderr` is null
// for an inherited stdio slot, so this process's OWN fd 2 is reopened onto a
// log file BEFORE `step1LaunchApp` spawns the app, and POSIX hands the app
// the just-freed fd number). Own copy (not exported by the split-smoke
// precedent), engine-scoped log filename so a claude run and a codex run
// never clobber each other's evidence. ──

const APP_STDERR_LOG = join(EVIDENCE_DIR, `app-stderr-${ENGINE}.log`);

function redirectAppStderr() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (existsSync(APP_STDERR_LOG)) {
    rmSync(APP_STDERR_LOG, { force: true });
  }
  closeSync(openSync(APP_STDERR_LOG, "a"));
  closeSync(2);
  openSync(APP_STDERR_LOG, "a");
}

/** Written into the captured app-stderr the instant the renderer facade first answers `GET /state` with 200 — step 7 splits the log on it: above is the startup boot-race window (its own allowlist), below is steady state (only the general allowlist). No marker -> step 7 FAILS rather than widening the allowlist over the whole run. */
const STARTUP_WINDOW_SENTINEL = `${LOG} ── renderer facade installed: startup window closed ──`;

function markStartupWindowClosed() {
  writeSync(2, `${STARTUP_WINDOW_SENTINEL}\n`);
}

/** Known-benign noise, explicit + comment-justified (same 4 patterns `child-session-split-smoke.mjs` already established and reasoned about for this exact dev/CI environment — reused verbatim, not re-derived, since the noise sources are process-wide, not scenario-specific). */
const APP_STDERR_ALLOWLIST = [
  // Node's one-time process-level warning the instant `node:sqlite` is first
  // required (packages/core's persistence layer, used by the main process) —
  // an API-stability notice, not a runtime defect.
  /ExperimentalWarning: SQLite is an experimental feature/,
  // Chromium/Electron DevTools-protocol noise: any CDP client that does not
  // implement the OPTIONAL `Autofill` domain (this script's own connection
  // included) gets this benign "failed" line — unrelated to the product.
  /Request Autofill\.(enable|setAddresses) failed/,
  // Chromium's own boot banner, printed once because this script launches
  // the app with `--remote-debugging-port` (its CDP client IS the reason the
  // port exists). Carries no product signal.
  /^DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//,
  // Environment noise, NOT a product defect: the host rejects skills whose
  // directory name violates the CLI's own name regex (developer's personal
  // `~/.anycode/skills` entries, unrelated to this repo).
  /^\[host\] extensions: Skill discovery: skipping .+ does not match \^\[A-Za-z0-9\]/,
];

/** Allowed ONLY above `STARTUP_WINDOW_SENTINEL` — the boot race this harness itself creates (`waitForFacade` polling `/state?tail=0` before the renderer facade installs, each early poll logged as a full 503 dump by the automation server). The SAME dump after the sentinel would be a real finding (the facade going away mid-run) — never promote these to `APP_STDERR_ALLOWLIST`. */
const APP_STDERR_STARTUP_ALLOWLIST = [
  /^\[automation\] GET \/state\?tail=0 -> 503 FacadeUnavailableError: facade_unavailable: facade_not_installed$/,
  /^at .*chunks\/server-[^\s]*\.js:\d+:\d+/,
  /^detail: .*'facade_not_installed'/,
  /^\}$/,
];

/** Empty by design (no known CDP console-error noise yet observed for this scenario) — extend with a comment-justified regex the first time a real run needs one, same discipline as `APP_STDERR_ALLOWLIST`. */
const CDP_CONSOLE_ERROR_ALLOWLIST = [];

// ── small local helpers (generic poll + port reservation — not exported by any precedent) ──

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
// every precedent script establishes, extended with Runtime.enable + a live
// console.error collector (CUT-S4 law #2), own copy since neither precedent
// exports one. ──

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
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: resolveMsg, reject: rejectMsg } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        rejectMsg(new Error(`CDP protocol error: ${JSON.stringify(msg.error)}`));
      } else {
        resolveMsg(msg);
      }
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = (msg.params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type ?? "")))
        .join(" ");
      consoleErrors.push({ text, timestamp: msg.params.timestamp ?? null });
    }
  };

  function sendCommand(method, params = {}) {
    const id = nextId++;
    return new Promise((resolveMsg, rejectMsg) => {
      pending.set(id, { resolve: resolveMsg, reject: rejectMsg });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectMsg(new Error(`CDP command ${method} timed out (20s)`));
        }
      }, 20_000);
    });
  }

  await sendCommand("Runtime.enable");

  return {
    async eval(expression) {
      const msg = await sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (msg.result?.exceptionDetails) {
        throw new Error(`CDP page exception: ${JSON.stringify(msg.result.exceptionDetails).slice(0, 600)}`);
      }
      return msg.result?.result?.value;
    },
    consoleErrors,
    close() {
      try {
        ws.close();
      } catch {
        // already closed.
      }
    },
  };
}

// ── browser-side geometry/DOM expressions (product-code-free). Every
// geometry read below uses the viewport-CLAMPED intersection centre (CUT-S4
// law #1) — an element whose own rect centre sits off-screen makes
// `elementFromPoint` return null there by definition, the false "hit
// outside" this track has already paid for once (`child-session-race-smoke.
// mjs`'s own `cardGeometryJs` doc, re-affirmed by `child-session-split-
// smoke.mjs`'s `hitTestClickJs`). ──

/** Hit-tests THEN clicks a single element — every real DOM-transition click in this file goes through this one helper. `selectorExprJs` is a Node-side JS EXPRESSION STRING (already safely built via `JSON.stringify`) that evaluates, INSIDE the browser, to the CSS selector. On failure the full geometry/hit payload comes back, never a bare `{ok:false}` (CUT-S4 law #5). */
function hitTestClickJs(selectorExprJs) {
  return `(() => {
    const el = document.querySelector(${selectorExprJs});
    if (!el) return { ok: false, reason: 'not_found' };
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const visLeft = Math.max(rect.left, 0);
    const visTop = Math.max(rect.top, 0);
    const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
    const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
    const geometry = {
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      visible: { width: visWidth, height: visHeight },
    };
    if (visWidth <= 0 || visHeight <= 0) {
      return { ok: false, reason: 'no_onscreen_area', ...geometry };
    }
    const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
    const hit = document.elementFromPoint(cx, cy);
    const hitInside = hit ? (el.contains(hit) || hit === el) : false;
    if (!hitInside) {
      return {
        ok: false,
        reason: 'hit_outside',
        ...geometry,
        point: { x: cx, y: cy },
        hitTag: hit ? hit.tagName : null,
        hitClass: hit && typeof hit.className === 'string' ? hit.className : null,
      };
    }
    el.click();
    return { ok: true };
  })()`;
}

const CLICK_DENY_JS = hitTestClickJs(JSON.stringify(".permission-deny-button"));
const CLICK_ALLOW_JS = hitTestClickJs(JSON.stringify(".permission-allow-button"));
const CLICK_BREADCRUMB_MASTER_JS = hitTestClickJs(JSON.stringify(".child-breadcrumb-master"));

/** Master card's session-child badge (`.tool-call-child-badge`, `ToolCallCard.tsx`) — the attention signal proving the ask reached the MASTER's own always-visible card, distinct from the child-surface modal itself (§8 п.1's "attention from the wrong broker" risk: this reads the badge's OWN geometry, plus whether ANY permission modal exists anywhere in the document — the master-modal-absent half of the same anti-facade check). */
function masterBadgeGeometryJs(toolCallId) {
  return `(() => {
    const card = document.querySelector('[data-tool-call-id="${toolCallId}"]');
    if (!card) return { ok: false, reason: 'no_card' };
    const badge = card.querySelector('.tool-call-child-badge');
    const globalModal = document.querySelector('dialog.permission-modal');
    if (!badge) {
      return { ok: true, hasBadge: false, globalModalPresent: !!globalModal, globalModalOpen: globalModal ? globalModal.open : false };
    }
    const rect = badge.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const visLeft = Math.max(rect.left, 0);
    const visTop = Math.max(rect.top, 0);
    const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
    const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
    const style = getComputedStyle(badge);
    let hitInsideBadge = false, hitTag = null;
    if (visWidth > 0 && visHeight > 0) {
      const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
      const hit = document.elementFromPoint(cx, cy);
      hitInsideBadge = hit ? (badge.contains(hit) || hit === badge) : false;
      hitTag = hit ? hit.tagName : null;
    }
    return {
      ok: true, hasBadge: true,
      badgeClass: badge.className,
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      visible: { width: visWidth, height: visHeight },
      display: style.display, visibility: style.visibility, opacity: style.opacity,
      hitInsideBadge, hitTag,
      globalModalPresent: !!globalModal,
      globalModalOpen: globalModal ? globalModal.open : false,
    };
  })()`;
}

/** The permission modal in whichever surface is currently shown (child, once Opened) — geometry + real content (title/input preview), same shape `child-session-permission-smoke.mjs` established, rewritten with the viewport-clamped hit-test (law #1). */
const CHILD_PERMISSION_MODAL_JS = `(() => {
  const modal = document.querySelector('dialog.permission-modal');
  if (!modal) return { ok: false, reason: 'no_modal' };
  const rect = modal.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const visLeft = Math.max(rect.left, 0);
  const visTop = Math.max(rect.top, 0);
  const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
  const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
  const style = getComputedStyle(modal);
  let hitInsideModal = false, hitTag = null;
  if (visWidth > 0 && visHeight > 0) {
    const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
    const hit = document.elementFromPoint(cx, cy);
    hitInsideModal = hit ? (modal.contains(hit) || hit === modal) : false;
    hitTag = hit ? hit.tagName : null;
  }
  const title = modal.querySelector('.permission-modal-title');
  const inputValue = modal.querySelector('.permission-input-value');
  return {
    ok: true,
    open: modal.open,
    rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    visible: { width: visWidth, height: visHeight },
    display: style.display, visibility: style.visibility, opacity: style.opacity,
    hitInsideModal, hitTag,
    titleText: title ? title.textContent : null,
    inputValueText: inputValue ? inputValue.textContent : null,
  };
})()`;

const CHILD_PANE_MOUNTED_JS = `(() => !!document.querySelector('.child-session-breadcrumb'))()`;

/** Layout-B pane geometry for a COMPLETED child (readonly badge, no composer — the C4 branch every precedent already exercises for a terminal child), rewritten with the viewport-clamped hit-test. */
const CHILD_B_PANE_GEOMETRY_JS = `(() => {
  const header = document.querySelector('.child-session-breadcrumb');
  if (!header) return { ok: false, reason: 'no_header' };
  const pane = header.nextElementSibling;
  if (!pane || !pane.classList.contains('session-content')) return { ok: false, reason: 'no_pane' };
  const composer = pane.querySelector('.composer');
  const readonlyBadge = header.querySelector('.child-breadcrumb-readonly');
  const rect = pane.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const visLeft = Math.max(rect.left, 0);
  const visTop = Math.max(rect.top, 0);
  const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
  const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
  let hitInsidePane = false, hitTag = null;
  if (visWidth > 0 && visHeight > 0) {
    const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
    const hit = document.elementFromPoint(cx, cy);
    hitInsidePane = hit ? (pane.contains(hit) || hit === pane) : false;
    hitTag = hit ? hit.tagName : null;
  }
  return {
    ok: true,
    rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    visible: { width: visWidth, height: visHeight },
    hitInsidePane, hitTag,
    hasComposer: composer !== null,
    hasReadonlyBadge: readonlyBadge !== null,
  };
})()`;

const CHILD_B_MESSAGE_COUNT_JS = `(() => {
  const header = document.querySelector('.child-session-breadcrumb');
  const pane = header ? header.nextElementSibling : null;
  return pane ? pane.querySelectorAll('.message-list .message').length : -1;
})()`;

/** Sidebar row titles (border-sanity, I5) — same technique `child-session-scenario-smoke.mjs`/`child-session-split-smoke.mjs` already established (not exported by either), reused here to prove the sidebar's own row count never grows across either child's lifetime. */
const SIDEBAR_ROW_TITLES_JS = `(() => Array.from(document.querySelectorAll('.sidebar-row')).map((row) => (row.querySelector('.sidebar-row-title')?.textContent ?? null)))()`;

/**
 * On-screen text of the card's own sub-status counter line — the "engine
 * chip" CUT-S4 §4.6/§6.2 п.1 calls for is a `"<engine> · "` TEXT PREFIX on
 * this element while running (TASK.97 R5's `formatSubagentCounters`,
 * `ToolCallCard.tsx`), not a separate badge element. An Agent card is
 * COLLAPSED BY DEFAULT in EVERY status (`defaultExpanded` returns `false`
 * unconditionally for `toolName === "Agent"`) — the state this smoke
 * actually observes, and the state the owner sees without touching anything
 * — so `.tool-call-subagent-counters` (mounted by `SubagentStatus`, only
 * inside the EXPANDED card body) is not on screen there. The same text
 * renders, while running and collapsed, in the always-visible toggle row as
 * `.subagent-collapsed-progress` (same `formatSubagentCounters` call, gated
 * on `!expanded && block.subagent.final === null`). This probe reads the
 * collapsed-row node FIRST (the stronger evidence, since it is the default
 * state) and falls back to the expanded-body node for a card the caller
 * happens to have expanded. DOM-presence != visibility (this track's law
 * #1): whichever node is found must also have a non-zero on-screen box
 * (`getBoundingClientRect()`), or the read counts as absent, not present —
 * the returned `reason` distinguishes "no such node" (`no_card`/`no_node`)
 * from "node present but not visible" (`zero_rect`) for the caller's own
 * failure message.
 */
function subagentCounterTextJs(toolCallId) {
  return `(() => {
    const card = document.querySelector('[data-tool-call-id="${toolCallId}"]');
    if (!card) return { text: null, node: 'none', reason: 'no_card' };
    const collapsedEl = card.querySelector('.subagent-collapsed-progress');
    const expandedEl = card.querySelector('.tool-call-subagent-counters');
    const el = collapsedEl ?? expandedEl;
    if (!el) return { text: null, node: 'none', reason: 'no_node' };
    const node = collapsedEl ? 'collapsed' : 'expanded';
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) {
      return { text: null, node, reason: 'zero_rect', rect: { width: rect.width, height: rect.height } };
    }
    return { text: el.textContent, node, reason: null };
  })()`;
}

// ── engine-profile seeding (CUT-S4 §6.2 — see this file's own header doc) ──

function seedEngineProfile(ctx) {
  const agentsDir = join(ctx.tmpWorkspace, ".anycode", "agents");
  mkdirSync(agentsDir, { recursive: true });
  ctx.profileMdPath = join(agentsDir, `${PROFILE_NAME}.md`);
  const md = [
    "---",
    `name: ${PROFILE_NAME}`,
    "description: Small file-editing helper for local tasks.",
    `engine: ${ENGINE}`,
    "---",
    "You help with small file-editing tasks in this workspace. Use whichever of your own tools fits the request; do not narrate your plan, just do the work.",
    "",
  ].join("\n");
  writeFileSync(ctx.profileMdPath, md);
}

/** "…и убирает за собой" (CUT-S4 §6.2): removes the ONE file this script itself seeded, independent of (and before) the outer workspace-directory teardown — explicit hygiene, not reliance on the outer wipe. No-op under --keep, matching every other piece of this script's own cleanup. */
function removeEngineProfile(ctx) {
  if (FLAGS.keep) {
    return;
  }
  if (typeof ctx.profileMdPath === "string" && existsSync(ctx.profileMdPath)) {
    try {
      rmSync(ctx.profileMdPath, { force: true });
    } catch (err) {
      console.warn(`${LOG} failed to remove seeded profile ${ctx.profileMdPath}: ${err?.message ?? err}`);
    }
  }
}

// ── dispatch (own copies — profile-aware, not tier-aware like the base
// harness's own `attemptDispatch`/`pollForDispatch`: this scenario's spawn
// discriminator is `agent_type === PROFILE_NAME`, and it dispatches TWICE on
// the SAME root tab (deny-child then allow-child), so a naive "first Agent
// block in the whole transcript" match would hand step 5 step 1's own stale
// toolCallId — same bug class `child-session-permission-smoke.mjs`'s own
// `pollForNewDispatch` doc names live; `excludeToolCallIds` closes it here
// too. ──

function hasAgentTypeInput(block) {
  const input = block?.input;
  return input !== null && typeof input === "object" && input.agent_type === PROFILE_NAME;
}

async function pollForEngineDispatch(ctx, step, timeoutMs, excludeToolCallIds) {
  const deadline = Date.now() + timeoutMs;
  let anyAgentSeen = false;
  let lastBlock = null;
  for (;;) {
    const { transcript, childRuns } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && !excludeToolCallIds.has(b.toolCallId)) ?? null;
    if (block !== null) {
      anyAgentSeen = true;
      lastBlock = block;
    }
    if (Array.isArray(childRuns) && childRuns.length > 0) {
      return { anyAgentSeen, block: lastBlock, childRuns };
    }
    if (block !== null && (block.status === "success" || block.status === "error")) {
      return { anyAgentSeen, block, childRuns: childRuns ?? [] };
    }
    if (Date.now() >= deadline) {
      return { anyAgentSeen, block: lastBlock, childRuns: childRuns ?? [] };
    }
    await sleep(300);
  }
}

async function attemptEngineDispatch(ctx, step, prompt, timeoutMs, excludeToolCallIds) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  return pollForEngineDispatch(ctx, step, timeoutMs, excludeToolCallIds);
}

function spawnPromptPrimary(taskInstruction) {
  return (
    'Call the Agent tool exactly once, right now, in this turn. Use these exact parameter values: ' +
    `agent_type: "${PROFILE_NAME}", description: a short 3-5 word summary of the task, and prompt: an ` +
    `instruction telling the subagent to ${taskInstruction} Do not set a "provider" parameter. Invoke the tool now.`
  );
}
function spawnPromptRetry(taskInstruction) {
  return (
    'You did not call the Agent tool with the required agent_type parameter. The Agent tool you have access to ' +
    `accepts an "agent_type" parameter naming which profile to run. Call it NOW with agent_type set to the ` +
    `literal string "${PROFILE_NAME}", a short description, and a prompt telling the subagent to ${taskInstruction} ` +
    'You must invoke the tool itself, with a real tool call — do not just describe what you would do.'
  );
}

/**
 * Shared spawn-dispatch dance: primary prompt, one retry, then a SKIP —
 * except this scenario's SKIP has TWO distinct causes, and only one of them
 * is "documented live-model non-compliance" (every other harness's own sole
 * SKIP reason). If the model DID call Agent correctly but admission still
 * never produced a childRuns entry, the block's own `modelText` is checked
 * for an environment-shaped rejection (`/not (ready|available)/i` — the
 * `not_ready` family of texts, main/tabs.ts's `CHILD_ENGINE_NOT_READY_
 * MESSAGE`-style wording, §3.2 п.2's "Отказ `not_ready` называет движок")
 * before falling through to a hard FAIL with the full payload. This is the
 * distinction CUT-S4 §0.6 п.2 needs from a run's own evidence: "the model
 * never engaged" and "this dev machine cannot boot this engine right now"
 * are not proof of a product defect the same way an unexplained admission
 * failure is.
 */
async function spawnEngineChild(ctx, step, taskInstruction, excludeToolCallIds) {
  let anyAgentSeen = false;
  let result = await attemptEngineDispatch(ctx, step, spawnPromptPrimary(taskInstruction), CHILD_ADMIT_TIMEOUT_MS, excludeToolCallIds);
  anyAgentSeen = anyAgentSeen || result.anyAgentSeen;

  if (!hasAgentTypeInput(result.block) && result.childRuns.length === 0) {
    console.warn(`${LOG} step ${step}: agent_type:"${PROFILE_NAME}" not seen on the first attempt — retrying once`);
    await settleTurn(ctx, step);
    result = await attemptEngineDispatch(ctx, step, spawnPromptRetry(taskInstruction), CHILD_ADMIT_TIMEOUT_MS + 30_000, excludeToolCallIds);
    anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
  }

  if (!anyAgentSeen) {
    return { skipped: true, skipReason: "model never called Agent" };
  }
  if (!hasAgentTypeInput(result.block) && result.childRuns.length === 0) {
    return { skipped: true, skipReason: `model did not use agent_type:"${PROFILE_NAME}"` };
  }
  if (result.childRuns.length === 0) {
    const text = typeof result.block?.modelText === "string" ? result.block.modelText : "";
    if (/not (ready|available)/i.test(text)) {
      return { skipped: true, skipReason: `environment: "${ENGINE}" engine not ready on this host — ${text}` };
    }
    fail(
      step,
      `Agent called with agent_type:"${PROFILE_NAME}" (input=${JSON.stringify(result.block?.input)}) but no childRuns entry ever appeared, and the rejection text does not read as an environment/not-ready ` +
        `cause. Final block: ${JSON.stringify(result.block)}`,
    );
  }
  assert(step, result.childRuns.length === 1, `expected exactly 1 NEW childRuns entry, got ${result.childRuns.length}: ${JSON.stringify(result.childRuns)}`);
  return { skipped: false, entry: result.childRuns[0], toolCallId: result.block.toolCallId };
}

async function findMasterToolCallBlock(ctx, step, toolCallId) {
  const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return transcript.find((b) => b.kind === "tool_call" && b.toolCallId === toolCallId) ?? null;
}

async function rootPermissionState(ctx) {
  const resp = await api(ctx, "GET", "/state");
  return resp.body?.snapshot?.states?.[ctx.tabId]?.permission ?? null;
}

/** Opens the given toolCallId's child and waits for its OWN permission modal to be visibly settled (opacity>0 past the `.permission-modal[open]` scale-in animation — the SAME poll-strength fix `child-session-permission-smoke.mjs` had to add after seeing `opacity:"0"` on the very first reading). Returns the modal's full geometry+content payload. */
async function openChildAndWaitModal(ctx, step, toolCallId) {
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: toolCallId });
  const paneMounted = await pollUntil(10_000, 200, async () => ((await ctx.cdp.eval(CHILD_PANE_MOUNTED_JS)) === true ? true : undefined));
  assert(step, paneMounted === true, "child pane (.child-session-breadcrumb) never mounted within 10s of Open");
  const modalGeo = await pollUntil(10_000, 250, async () => {
    const geo = await ctx.cdp.eval(CHILD_PERMISSION_MODAL_JS);
    return geo.ok === true && Number(geo.opacity) > 0 ? geo : undefined;
  });
  assert(step, modalGeo !== null, "no permission modal appeared VISIBLY (opacity>0) in the child surface within 10s of Open");
  assert(step, modalGeo.open === true, `modal <dialog> exists but .open is false: ${JSON.stringify(modalGeo)}`);
  assert(step, modalGeo.rect.width > 0 && modalGeo.rect.height > 0, `child modal has zero rect: ${JSON.stringify(modalGeo.rect)}`);
  assert(step, modalGeo.display !== "none" && modalGeo.visibility !== "hidden" && Number(modalGeo.opacity) > 0, `child modal not visually visible: ${JSON.stringify(modalGeo)}`);
  assert(step, modalGeo.hitInsideModal === true, `elementFromPoint at the modal's on-screen intersection centre (hit=${modalGeo.hitTag}) did NOT land inside it`);
  return modalGeo;
}

async function pollForChildRow(ctx, step, childSessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await apiOk(ctx, step, "GET", "/child-runs");
    assert(step, rows?.ok === true, `GET /child-runs did not answer ok:true: ${JSON.stringify(rows)}`);
    const row = (rows.sessions ?? []).find((s) => s.id === childSessionId);
    if (row !== undefined) {
      return row;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(300);
  }
}

// ── step 1: spawn via the engine profile — card running, engine chip, childRuns=1 (CUT-S4 §6.2 п.1) ──

async function step1Spawn(ctx) {
  const step = 1;

  // mode="build" -> Claude child preset "ask" (mode "default") / Codex
  // posture "ask" ("on-request"+user+workspace-write) per CUT-S4 §4.2's
  // frozen table — the ONE root mode that reliably forces an ask for a
  // Write/file-change under BOTH engines, snapshotted at spawn (inherited by
  // BOTH children below, so it is set once here, not re-applied per spawn).
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/mode`, { mode: "build" });
  const modeApplied = await pollUntil(10_000, 250, async () => {
    const resp = await api(ctx, "GET", "/state");
    const mode = resp.body?.snapshot?.states?.[ctx.tabId]?.mode;
    return mode === "build" ? mode : undefined;
  });
  assert(step, modeApplied === "build", `mode "build" never reflected on /state's per-tab snapshot within 10s (last seen: ${JSON.stringify(modeApplied)})`);

  // Neutral, ordinary-sounding sentinel (CUT-S4 law #6 — NOT "*-proof.txt"):
  // a ready model would refuse an obviously-adversarial bait filename,
  // producing a false SKIP indistinguishable from a real product defect.
  ctx.sentinelPath = join(ctx.tmpWorkspace, "task-status.md");
  ctx.taskInstruction = `create a file at the exact absolute path "${ctx.sentinelPath}" containing the exact text "Status: ready" (no code fence, no extra commentary), then reply with exactly the single word DONE and stop.`;

  const spawn = await spawnEngineChild(ctx, step, ctx.taskInstruction, new Set());
  if (spawn.skipped) {
    ctx.skipped = true;
    ctx.skipReason = spawn.skipReason;
    await settleTurn(ctx, step);
    pass(step, `SKIPPED (documented) — ${spawn.skipReason}`);
    return;
  }
  ctx.denyToolCallId = spawn.toolCallId;
  ctx.denyChildEntry = spawn.entry;
  ctx.denyChildSessionId = spawn.entry.childSessionId;

  // Stability poll requires BOTH "running" AND the chip's own subagent.engine
  // field to have settled — a raw immediate read would race subagent_start
  // landing just after admission; timing out here (rather than a bare
  // one-shot check) turns a genuinely missing chip wiring into an honest
  // FAIL instead of a flaky pass/fail coin-flip.
  const stable = await pollUntil(20_000, 300, async () => {
    const block = await findMasterToolCallBlock(ctx, step, ctx.denyToolCallId);
    if (block === null || block.status !== "running" || block.subagent?.engine !== ENGINE) {
      return undefined;
    }
    return block;
  });
  assert(step, stable !== null, `master card for toolCallId=${ctx.denyToolCallId} never reached status:"running" with subagent.engine==="${ENGINE}" within 20s`);
  await sleep(400);
  const second = await findMasterToolCallBlock(ctx, step, ctx.denyToolCallId);
  assert(step, second !== null && second.status === "running", `card not still "running" 400ms later: ${JSON.stringify(second)}`);

  const counter = await ctx.cdp.eval(subagentCounterTextJs(ctx.denyToolCallId));
  const counterText = counter.text;
  assert(
    step,
    typeof counterText === "string" && counterText.startsWith(`${ENGINE} · `),
    counterText === null
      ? counter.reason === "zero_rect"
        ? `on-screen chip node found (${counter.node}) but not visible — zero on-screen box: ${JSON.stringify(counter.rect)}`
        : `on-screen chip node not found (reason=${counter.reason})`
      : `on-screen chip text does not start with "${ENGINE} · ": ${JSON.stringify(counterText)}`,
  );

  pass(step, `spawned via engine-profile "${PROFILE_NAME}": card running with engine chip "${counterText}" (${counter.node}), childRuns=1 (childSessionId=${ctx.denyChildSessionId})`);
}

// ── step 2: Open -> modal live+real in the CHILD surface; badge on master, no master modal (CUT-S4 §6.2 п.2, anti-facade §8 пп.1,2) ──

async function step2OpenModal(ctx) {
  const step = 2;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const waitingSeen = await pollUntil(30_000, 300, async () => {
    const block = await findMasterToolCallBlock(ctx, step, ctx.denyToolCallId);
    if (block === null) return undefined;
    if (block.subagent?.waiting === true) return block;
    if (block.subagent?.final !== null && block.subagent?.final !== undefined) return { neverAsked: true, block };
    if (block.status === "success" || block.status === "error") return { neverAsked: true, block };
    return undefined;
  });
  assert(step, waitingSeen !== null, `master card never reached a decidable state (waiting OR terminal) for toolCallId=${ctx.denyToolCallId} within 30s`);
  assert(
    step,
    waitingSeen.neverAsked !== true,
    `child reached a terminal/final state WITHOUT ever raising subagent.waiting===true — mode="build" should have forced an ask. Final block: ${JSON.stringify(waitingSeen.block ?? waitingSeen)}`,
  );

  // Structural half of the "attention from the wrong broker" risk: the
  // MASTER's own /state permission field must stay untouched while the
  // CHILD's own connection is the one asking (§8 п.2).
  const rootPermission = await rootPermissionState(ctx);
  assert(step, rootPermission === null, `master's OWN /state permission field is non-null while the child is asking — the MASTER modal would be up: ${JSON.stringify(rootPermission)}`);

  const badgeGeo = await ctx.cdp.eval(masterBadgeGeometryJs(ctx.denyToolCallId));
  assert(step, badgeGeo.ok === true && badgeGeo.hasBadge === true, `master card badge not found in the DOM: ${JSON.stringify(badgeGeo)}`);
  assert(step, badgeGeo.badgeClass.includes("waiting_permission"), `badge class does not indicate waiting_permission: ${badgeGeo.badgeClass}`);
  assert(step, badgeGeo.rect.width > 0 && badgeGeo.rect.height > 0, `badge has zero rect: ${JSON.stringify(badgeGeo.rect)}`);
  assert(step, badgeGeo.display !== "none" && badgeGeo.visibility !== "hidden" && Number(badgeGeo.opacity) > 0, `badge not visually visible: ${JSON.stringify(badgeGeo)}`);
  assert(step, badgeGeo.hitInsideBadge === true, `elementFromPoint at the badge's on-screen intersection centre (hit=${badgeGeo.hitTag}) did NOT land inside the badge`);
  assert(step, badgeGeo.globalModalPresent === false, `a permission modal exists in the DOM while viewing master — expected NONE: ${JSON.stringify(badgeGeo)}`);

  const modalGeo = await openChildAndWaitModal(ctx, step, ctx.denyToolCallId);
  ctx.step2ModalGeo = modalGeo;

  const expectedTool = TOOL_NAME_BY_ENGINE[ENGINE];
  assert(step, typeof modalGeo.titleText === "string" && modalGeo.titleText.includes(expectedTool), `modal title does not mention "${expectedTool}": ${JSON.stringify(modalGeo.titleText)}`);
  if (ENGINE === "claude") {
    // Claude's Write ask carries the raw file_path verbatim (summarizeInput's
    // Write/Edit branch) — hard-asserted, same confidence as
    // `child-session-permission-smoke.mjs`'s own equivalent check.
    assert(step, typeof modalGeo.inputValueText === "string" && modalGeo.inputValueText.includes(ctx.sentinelPath), `modal input preview does not show the file path: ${JSON.stringify(modalGeo.inputValueText)}`);
  } else {
    // Codex's own path field depends on an `item/started` correlation that
    // is documented as fallible ("degraded description, still shown") — best
    // -effort only, logged for the evidence trail, never hard-asserted
    // (see this file's own header doc).
    console.log(`${LOG} step ${step}: modal input preview (best-effort, not hard-asserted): ${JSON.stringify(modalGeo.inputValueText)}`);
  }

  ctx.pngModal = await saveScreenshot(ctx, `s4-${ENGINE}-1-child-modal`);
  pass(step, `permission modal visible+real in the child surface (title="${modalGeo.titleText}"), badge visible on master, no master modal`);
}

// ── step 3: NEGATIVE — no file yet, tool_call still running, while pending (CUT-S4 §6.2 п.3) ──

async function step3PendingNegative(ctx) {
  const step = 3;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  assert(step, !existsSync(ctx.sentinelPath), `sentinel file already exists WHILE approval is pending — the effect happened before any decision was made: ${ctx.sentinelPath}`);
  const block = await findMasterToolCallBlock(ctx, step, ctx.denyToolCallId);
  assert(step, block !== null && block.status === "running", `master's Agent tool_call is not "running" while approval is pending: ${JSON.stringify(block)}`);

  pass(step, `negative proof: ${ctx.sentinelPath} does not exist and the tool_call is still "running" while approval is pending`);
}

// ── step 4: Deny (REAL click) -> NEGATIVE — still no file, child reaches terminal (CUT-S4 §6.2 п.4, anti-facade §8 п.3) ──

async function step4Deny(ctx) {
  const step = 4;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const clicked = await ctx.cdp.eval(CLICK_DENY_JS);
  assert(step, clicked.ok === true, `click on .permission-deny-button failed: ${JSON.stringify(clicked)}`);

  const TERMINAL_STATUSES = new Set(["success", "error", "denied", "cancelled", "max_turns", "timed_out"]);
  let lastSeenBlock = null;
  const terminal = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 500, async () => {
    const block = await findMasterToolCallBlock(ctx, step, ctx.denyToolCallId);
    lastSeenBlock = block;
    const badgeCleared = block?.subagent?.waiting !== true;
    return badgeCleared && block !== null && TERMINAL_STATUSES.has(block.status) ? block : undefined;
  });
  assert(step, terminal !== null, `child never reached a terminal status after Deny within ${TERMINAL_WAIT_TIMEOUT_MS}ms. Last observed: ${JSON.stringify(lastSeenBlock)}`);
  ctx.denyTerminal = terminal;

  // The load-bearing assertion (CUT-S4 §8 п.3: "Отказ показан, эффект уже
  // случился" — a visible Deny outcome proves nothing; only file-absence
  // does). Deliberately NOT asserting a specific `terminal.status` value: a
  // real external CLI reacting to a decline can legitimately finish its turn
  // several different "honest" ways (explain it couldn't comply, retry and
  // give up, etc.) — the invariant this step exists to prove is narrower and
  // stronger than any single status string.
  const fileExists = existsSync(ctx.sentinelPath);
  assert(step, !fileExists, `Write was DENIED but ${ctx.sentinelPath} exists on disk — the denied effect happened anyway`);

  ctx.pngDeny = await saveScreenshot(ctx, `s4-${ENGINE}-2-deny-outcome`);
  pass(step, `deny honored: ${ctx.sentinelPath} absent, child reached terminal status="${terminal.status}"`);
}

// ── step 5: re-spawn, Allow (REAL click) -> file appears AFTER the click, exact content (CUT-S4 §6.2 п.5, anti-facade §8 п.1) ──

async function step5AllowRespawn(ctx) {
  const step = 5;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  // The ROOT's own turn does not go idle the instant step 4's tool_call
  // itself reaches terminal — the root model still has to consume the
  // tool_result and produce its own reply first. Dispatching the second
  // spawn without waiting for idle busy-rejects outright (the exact bug
  // `child-session-split-smoke.mjs`'s own step 7 doc names and fixes the
  // same way).
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000);

  const spawn = await spawnEngineChild(ctx, step, ctx.taskInstruction, new Set([ctx.denyToolCallId]));
  if (spawn.skipped) {
    ctx.step5Skipped = true;
    ctx.skipReason = ctx.skipReason ?? spawn.skipReason;
    await settleTurn(ctx, step);
    pass(step, `SKIPPED (documented) — ${spawn.skipReason}`);
    return;
  }
  ctx.allowToolCallId = spawn.toolCallId;
  ctx.allowChildEntry = spawn.entry;
  ctx.allowChildSessionId = spawn.entry.childSessionId;

  const modalGeo = await openChildAndWaitModal(ctx, step, ctx.allowToolCallId);
  const expectedTool = TOOL_NAME_BY_ENGINE[ENGINE];
  assert(step, typeof modalGeo.titleText === "string" && modalGeo.titleText.includes(expectedTool), `second modal's title does not mention "${expectedTool}": ${JSON.stringify(modalGeo.titleText)}`);

  // Re-confirms the deny path really left nothing (belt-and-suspenders on
  // top of step 4's own check) immediately before capturing the click
  // timestamp this step's whole proof hinges on.
  assert(step, !existsSync(ctx.sentinelPath), `sentinel unexpectedly present BEFORE the allow click (the deny path should have left it absent): ${ctx.sentinelPath}`);
  const preClickAt = Date.now();

  const clicked = await ctx.cdp.eval(CLICK_ALLOW_JS);
  assert(step, clicked.ok === true, `click on .permission-allow-button failed: ${JSON.stringify(clicked)}`);

  const settled = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 500, async () => {
    const block = await findMasterToolCallBlock(ctx, step, ctx.allowToolCallId);
    if (block === null) return undefined;
    const badgeCleared = block.subagent?.waiting !== true;
    const terminal = block.status === "success" || block.status === "error";
    return badgeCleared && terminal ? block : undefined;
  });
  assert(step, settled !== null, `child never both cleared the waiting badge AND reached terminal within ${TERMINAL_WAIT_TIMEOUT_MS}ms after allow`);
  ctx.allowTerminal = settled;
  assert(step, settled.status === "success", `expected the allowed child's task to succeed, got status="${settled.status}": ${JSON.stringify(settled)}`);

  // Existence-transition proof (stronger than mtime alone: this file
  // provably did NOT exist a moment ago, per the re-check above) PLUS the
  // mtime check CUT-S4 §6.2 п.5 asks for verbatim ("mtime после timestamp'а
  // клика") — both kept, neither substitutes for the other.
  const fileAppeared = await pollUntil(15_000, 300, async () => (existsSync(ctx.sentinelPath) ? true : undefined));
  assert(step, fileAppeared === true, `Write was allowed but ${ctx.sentinelPath} never appeared on disk within 15s of terminal`);
  const stat = statSync(ctx.sentinelPath);
  assert(
    step,
    stat.mtimeMs >= preClickAt - 500,
    `${ctx.sentinelPath}'s mtime (${stat.mtimeMs}) predates the allow click (${preClickAt}) by more than the FS-timestamp grace window — cannot prove the effect happened AFTER the decision`,
  );
  const content = readFileSync(ctx.sentinelPath, "utf8").trim();
  assert(step, content === "Status: ready", `expected ${ctx.sentinelPath} to contain "Status: ready", got ${JSON.stringify(content)}`);

  ctx.pngAllow = await saveScreenshot(ctx, `s4-${ENGINE}-3-allow-outcome`);
  pass(step, `allow effective: ${ctx.sentinelPath} appeared AFTER the click (mtime=${stat.mtimeMs} >= click=${preClickAt}) with exact content, child terminal status="${settled.status}"`);
}

// ── step 6: post-terminal re-Open -> non-empty universal-snapshot transcript, durable row identity, absent from lists (CUT-S4 §6.2 п.6, anti-facade §8 пп.4,6,7) ──

async function step6PostTerminal(ctx) {
  const step = 6;
  if (ctx.skipped || ctx.step5Skipped) {
    pass(step, "SKIPPED (documented) — see step 1/5");
    return;
  }

  const stateResp = await api(ctx, "GET", "/state");
  const rootSummary = (stateResp.body?.tabs ?? []).find((t) => t.tabId === ctx.tabId);
  assert(step, rootSummary !== undefined && typeof rootSummary.sessionId === "string", `could not resolve the root tab's own sessionId off /state: ${JSON.stringify(rootSummary)}`);
  ctx.rootSessionId = rootSummary.sessionId;

  // "Open заново" (CUT-S4 §6.2 п.6): navigate away, then re-Open fresh —
  // proves the OPEN code path itself renders the persisted history for an
  // already-terminal child, not just a still-mounted live view continuing to
  // render (the exact anti-facade risk §8 п.4 names: "карточка done, Open
  // пуст").
  const backToMaster = await ctx.cdp.eval(CLICK_BREADCRUMB_MASTER_JS);
  assert(step, backToMaster.ok === true, `breadcrumb "back to master" click failed: ${JSON.stringify(backToMaster)}`);
  await sleep(250);
  const probeMaster = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probeMaster?.ok === true && probeMaster.view?.kind === "master", `expected view.kind==="master" after breadcrumb click, got ${JSON.stringify(probeMaster)}`);

  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.allowToolCallId });
  await sleep(250);
  const probeChild = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(
    step,
    probeChild?.ok === true && probeChild.view?.kind === "child" && probeChild.view?.spawnToolCallId === ctx.allowToolCallId,
    `expected view targeting the allow child after re-Open, got ${JSON.stringify(probeChild)}`,
  );

  const bGeo = await ctx.cdp.eval(CHILD_B_PANE_GEOMETRY_JS);
  assert(step, bGeo.ok === true, `no child pane found on re-Open: ${JSON.stringify(bGeo)}`);
  assert(step, bGeo.hitInsidePane === true, `elementFromPoint at the re-opened pane's on-screen centre did NOT land inside it (hit=${bGeo.hitTag})`);
  assert(step, bGeo.hasReadonlyBadge === true, `expected the readonly badge on the now-completed child, none found: ${JSON.stringify(bGeo)}`);
  assert(step, bGeo.hasComposer === false, `expected NO composer on the completed child's re-opened surface, found one: ${JSON.stringify(bGeo)}`);

  const messageCount = await ctx.cdp.eval(CHILD_B_MESSAGE_COUNT_JS);
  assert(step, typeof messageCount === "number" && messageCount > 0, `re-opened completed child shows an EMPTY transcript — the universal-snapshot flush (§4.4) is not proven: count=${messageCount}`);

  const row = await pollForChildRow(ctx, step, ctx.allowChildSessionId, 30_000);
  assert(step, row !== null, `no durable /child-runs row for childSessionId=${ctx.allowChildSessionId} appeared within 30s`);
  assert(step, row.engineId === ENGINE, `child's durable row.engineId is not "${ENGINE}" (engine identity not stamped, or wrong) — the exact "molчаливый фолбэк в core" risk §8 п.7 names: ${JSON.stringify(row)}`);
  assert(step, row.spawnToolCallId === ctx.allowToolCallId, `child's durable row.spawnToolCallId (${row.spawnToolCallId}) !== the spawning Agent tool_call (${ctx.allowToolCallId})`);
  assert(step, row.parentSessionId === ctx.rootSessionId, `child's durable row.parentSessionId (${row.parentSessionId}) !== the root session's own id (${ctx.rootSessionId})`);
  ctx.allowChildRow = row;

  // Border sanity (I5) — the SAME class of assert every S2/S3 harness in
  // this directory reuses for "the child never joins the ordinary session
  // surfaces", re-run here for both children (§8 п.6: "ребёнок засветился в
  // списках" — a missing stamp on either engine's own boot path).
  const sessions = await apiOk(ctx, step, "GET", "/sessions");
  assert(step, Array.isArray(sessions), `GET /sessions did not return an array: ${JSON.stringify(sessions)}`);
  for (const id of [ctx.denyChildSessionId, ctx.allowChildSessionId]) {
    const leaked = sessions.find((s) => s.id === id);
    assert(step, leaked === undefined, `GET /sessions leaked a child session (${id}): ${JSON.stringify(leaked)}`);
  }
  const stateAfter = await apiOk(ctx, step, "GET", "/state");
  const stateKeys = Object.keys(stateAfter.snapshot?.states ?? {});
  assert(step, stateKeys.length === 1 && stateKeys[0] === ctx.tabId, `expected /state's per-tab states map to contain ONLY the root tab, got keys=${JSON.stringify(stateKeys)}`);
  const sidebarRows = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
  assert(
    step,
    Array.isArray(sidebarRows) && sidebarRows.length === ctx.baselineSidebarRowCount,
    `sidebar row count changed from ${ctx.baselineSidebarRowCount} (before either spawn) to ${sidebarRows?.length}: ${JSON.stringify(sidebarRows)}`,
  );

  pass(
    step,
    `universal snapshot proven: re-opened completed child shows ${messageCount} transcript message(s); durable row engineId="${row.engineId}" ` +
      `parentSessionId/spawnToolCallId match; both children absent from /sessions, /state's per-tab states, and the sidebar (still ${sidebarRows.length} row(s))`,
  );
}

// ── step 7: PNG evidence complete + console/stderr grep clean (CUT-S4 §6.2 п.7, law #2) ──

async function step7GrepAndEvidence(ctx) {
  const step = 7;

  assert(
    step,
    ctx.stderrRedirected === true,
    "app-stderr redirection was never established at startup (see the WARNING printed before step 1) — cannot honestly grep app stderr, so this gate FAILS rather than silently skipping it",
  );

  const consoleErrors = ctx.cdp?.consoleErrors ?? [];
  const unexpectedConsoleErrors = consoleErrors.filter((e) => !CDP_CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(e.text)));
  assert(step, unexpectedConsoleErrors.length === 0, `${unexpectedConsoleErrors.length} unexpected CDP console-error record(s): ${JSON.stringify(unexpectedConsoleErrors)}`);

  let stderrText = "";
  try {
    stderrText = readFileSync(APP_STDERR_LOG, "utf8");
  } catch (err) {
    fail(step, `could not read the redirected app-stderr log at ${APP_STDERR_LOG}: ${err?.message ?? err}`);
  }
  const stderrLines = stderrText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const sentinelIndex = stderrLines.indexOf(STARTUP_WINDOW_SENTINEL);
  assert(
    step,
    sentinelIndex !== -1,
    `the startup-window sentinel was never written into ${APP_STDERR_LOG} — the boot-race/steady-state boundary is unknowable, so this gate FAILS rather than applying the startup allowlist to the whole run`,
  );
  const unexpectedStderrLines = stderrLines.filter((line, index) => {
    if (index === sentinelIndex) {
      return false;
    }
    if (APP_STDERR_ALLOWLIST.some((re) => re.test(line))) {
      return false;
    }
    return !(index < sentinelIndex && APP_STDERR_STARTUP_ALLOWLIST.some((re) => re.test(line)));
  });
  ctx.unexpectedStderrLines = unexpectedStderrLines;
  assert(
    step,
    unexpectedStderrLines.length === 0,
    `${unexpectedStderrLines.length} unexpected app-stderr line(s) (of ${stderrLines.length} total, sentinel at line ${sentinelIndex + 1}): ${JSON.stringify(unexpectedStderrLines.slice(0, 20))}`,
  );

  if (!ctx.skipped && !ctx.step5Skipped) {
    for (const [label, path] of [
      ["modal", ctx.pngModal],
      ["deny", ctx.pngDeny],
      ["allow", ctx.pngAllow],
    ]) {
      assert(step, typeof path === "string" && path.length > 0, `evidence PNG "${label}" was never captured`);
    }
  }

  pass(
    step,
    `console/stderr clean (0 unexpected of ${consoleErrors.length} console-error records, 0 unexpected of ${stderrLines.length} app-stderr lines); PNG evidence complete`,
  );
}

// ── teardown (own trio — NOT the imported one, which hard-codes S2's own evidence dir/result filename) ──

function teardown(ctx, failedStep, stepsCompleted) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep, stepsCompleted);
  }
  return ctx.teardownPromise;
}

function reportAppStderr(ctx) {
  if (!ctx.stderrRedirected) {
    console.log(`${LOG} app-stderr was never redirected (see the startup WARNING) — nothing captured`);
    return;
  }
  try {
    const text = readFileSync(APP_STDERR_LOG, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    console.log(`${LOG} captured app-stderr: ${lines.length} line(s) at ${APP_STDERR_LOG}`);
    if (Array.isArray(ctx.unexpectedStderrLines) && ctx.unexpectedStderrLines.length > 0) {
      console.log(`${LOG} ${ctx.unexpectedStderrLines.length} UNEXPECTED (non-allowlisted) line(s):`);
      for (const line of ctx.unexpectedStderrLines) {
        console.log(`  ${line}`);
      }
    }
  } catch (err) {
    console.log(`${LOG} could not read back ${APP_STDERR_LOG} for the final report: ${err?.message ?? err}`);
  }
}

async function runTeardown(ctx, failedStep, stepsCompleted) {
  const consoleErrorCount = ctx.cdp?.consoleErrors?.length ?? null;
  if (ctx.cdp) {
    ctx.cdp.close();
    ctx.cdp = null;
  }

  removeEngineProfile(ctx);

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
      console.log(`${LOG} app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.log(`${LOG} app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`${LOG} --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.log(`${LOG} failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const skippedOverall = ctx.skipped === true || ctx.step5Skipped === true;
  const verdict = skippedOverall ? `SKIPPED (${ctx.skipReason ?? "see result json"})` : failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n${LOG} ${stepsCompleted}/${TOTAL_STEPS} steps passed — ${verdict}`);
  reportAppStderr(ctx);

  try {
    mkdirSync(ctx.evidenceDir, { recursive: true });
    const resultPath = join(ctx.evidenceDir, `engine-smoke-${ENGINE}-result.json`);
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verdict,
          engine: ENGINE,
          failedStep,
          skipped: ctx.skipped === true,
          step5Skipped: ctx.step5Skipped === true,
          skipReason: ctx.skipReason ?? null,
          denyToolCallId: ctx.denyToolCallId ?? null,
          denyChildSessionId: ctx.denyChildSessionId ?? null,
          allowToolCallId: ctx.allowToolCallId ?? null,
          allowChildSessionId: ctx.allowChildSessionId ?? null,
          rootSessionId: ctx.rootSessionId ?? null,
          allowChildRow: ctx.allowChildRow ?? null,
          pngPaths: { modal: ctx.pngModal ?? null, deny: ctx.pngDeny ?? null, allow: ctx.pngAllow ?? null },
          stderrRedirected: ctx.stderrRedirected === true,
          unexpectedStderrLines: ctx.unexpectedStderrLines ?? null,
          consoleErrorCount,
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
    console.log(`${LOG} failed to write engine-smoke-${ENGINE}-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.log(`\n${LOG} received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`, ctx.stepsCompleted ?? 0)
      .catch((err) => console.log(`${LOG} teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    stderrRedirected: false,
    skipped: false,
    step5Skipped: false,
    skipReason: null,
    baselineSidebarRowCount: null,
    profileMdPath: null,
    sentinelPath: null,
    taskInstruction: null,
    denyToolCallId: null,
    denyChildEntry: null,
    denyChildSessionId: null,
    denyTerminal: null,
    allowToolCallId: null,
    allowChildEntry: null,
    allowChildSessionId: null,
    allowTerminal: null,
    allowChildRow: null,
    rootSessionId: null,
    pngModal: null,
    pngDeny: null,
    pngAllow: null,
    unexpectedStderrLines: null,
  };
  ctx.mkdirEvidenceDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.evidenceDir)}, {recursive:true})`]);
    } catch {
      // fall through to the caller's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  // MUST run before step1LaunchApp spawns the dev app — see this file's own
  // header doc / the redirectAppStderr doc for why fd 2 (not `ctx.child.
  // stderr`, which is `null` for an inherited stdio slot) is the only lever
  // available.
  try {
    redirectAppStderr();
    ctx.stderrRedirected = true;
  } catch (err) {
    console.log(`${LOG} WARNING: could not redirect app stderr for capture (${err?.message ?? err}) — step 7 will FAIL on this honestly instead of silently skipping the gate`);
  }

  let failedStep = null;
  let stepsCompleted = 0;
  try {
    ctx.cdpPort = await reserveUnusedPort();
    process.env.REMOTE_DEBUGGING_PORT = String(ctx.cdpPort);

    await step1LaunchApp(ctx);
    // The profile must exist before the FIRST prompt dispatch (agent-profile
    // rescan is gated on the master's own next turn start, not a live fs
    // watch — see this file's own header doc) — seeded right after the
    // workspace directory exists, well before that.
    seedEngineProfile(ctx);

    // Connect CDP (Runtime.enable + the console-error collector) BEFORE
    // waiting on the facade, so a renderer console.error during the boot
    // race itself still lands in the count step 7 later asserts is zero.
    ctx.cdp = await cdpConnect(ctx.cdpPort);
    await waitForFacade(ctx, 1);
    markStartupWindowClosed();
    await step1DiscoverTab(ctx);

    const baseline = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
    ctx.baselineSidebarRowCount = Array.isArray(baseline) ? baseline.length : 0;

    await step1Spawn(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step2OpenModal(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step3PendingNegative(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step4Deny(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step5AllowRespawn(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step6PostTerminal(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
    await step7GrepAndEvidence(ctx);
    stepsCompleted += 1;
    ctx.stepsCompleted = stepsCompleted;
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    // `fail()`/`assert()` (imported) report via `console.error`, which is fd
    // 2 — redirected to APP_STDERR_LOG above, not this run's own stdout.
    // Reprint the failure reason here so it is visible in the run's normal
    // output too, not only in the evidence log file.
    console.log(`${LOG} ${err instanceof SmokeFailure ? err.message : `unexpected error: ${err?.stack ?? err}`}`);
  }

  await teardown(ctx, failedStep, stepsCompleted);
  // Exit-code arbitration (CUT-S4 §0.8, law #3): a documented SKIP snapped
  // fewer PNGs and proved no deny/allow effect, so it must never be
  // indistinguishable from 7/7 ALL GREEN to a caller reading only the exit
  // code. `failedStep !== null` still wins over a skip flag (a real
  // assertion failure is never downgraded to "just a skip").
  const skippedOverall = ctx.skipped === true || ctx.step5Skipped === true;
  process.exit(failedStep !== null ? 1 : skippedOverall ? 2 : 0);
}

run().catch((err) => {
  console.log(`${LOG} fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

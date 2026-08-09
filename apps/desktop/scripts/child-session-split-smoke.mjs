/**
 * Live smoke for TASK.102 CUT-S3 §6.3 — the split/accordion layout's ONLY
 * PNG gate (S3c). Drives a REAL Electron dev instance end-to-end over the
 * automation HTTP channel and proves, on a real screen, what
 * `child-layout.test.ts`'s pure-reducer matrix structurally cannot: that the
 * five real button/click wires (Split, Open×2, row-click, ⤢, ×) actually
 * reach `childLayoutStore`'s new `enterSplit`/`expandRow`/`exitSplit`
 * methods, and that the resulting DOM (`ActiveTabBody`'s third grid column +
 * `ChildSplitPane`) is REALLY on screen, not just present-in-DOM (anti-facade
 * §8 п.1/п.2).
 *
 * §6.1 (LAW, not a style choice): the facade's ONLY new surface this slice
 * adds is `childLayoutState` — a READ-ONLY probe (`GET /tabs/:tabId/child/layout`).
 * There is deliberately NO facade driver for `enterSplit`/`exitSplit`/
 * `expandRow` (CUT-S3 §9 п.8) — every layout TRANSITION below is a REAL
 * `.click()` on the exact DOM node the product renders, found via the
 * FROZEN §3.5 selector contract. A facade shortcut for these would open a
 * second path around the button→store wiring this smoke exists to pin
 * (S2d's own named grabli: reducers can be green while the buttons are
 * dead — CUT-S3 §8 п.3 predicts this class by name, "RS2-15-3").
 *
 * REUSE (same discipline as every script in this directory): every generic
 * process/fs/HTTP/dispatch helper below is IMPORTED, unmodified, from the
 * already-green `child-session-explicit-provider-smoke.mjs` — `step1LaunchApp`
 * in particular is reused UNMODIFIED for the whole launch/profile/settings-seed
 * sequence (the SAME real v2 `provider.connections[]` seed — the settings
 * seed is copied from THAT file only; `subagent-card-smoke.mjs`'s seed is a
 * vestigial v1 shape that fails the current zod schema outright and would
 * silently fall back to env-override boot). The CDP client is written fresh
 * (same ~50-line, product-code-free technique every precedent script already
 * establishes for this exact command surface — none of them export one),
 * extended here with `Runtime.enable` + a `Runtime.consoleAPICalled`
 * listener (§6.3 п.10's mandatory console-error grep — no precedent script
 * needed this before). The dual-spawn dispatch/stability-poll shape mirrors
 * `child-session-race-smoke.mjs`'s probe A (two, not four, session-tier
 * `Agent` calls in one turn); the steering technique (type via native
 * setter + `input` event, real `.click()` on `.composer-send`, verify via a
 * "echo > proof file" Bash side-effect + `subagent.toolCalls` count) mirrors
 * `child-session-permission-smoke.mjs`'s п.7 steering probe verbatim, just
 * re-scoped to the composer INSIDE `.child-split-pane` instead of the bare
 * B-position composer (CUT-S3 §6.3 п.6's own instruction: "переиспользовать
 * ассерт §4.2 п.7 S2d — шов композер→хост в сплит-позиции, не в B-позиции").
 *
 * DEVIATION (honestly named, not hidden — report this under "ШОВ" if this
 * run goes red near it): §6.3 п.7's lossless assert needs transcript-block
 * COUNTS for the master AND BOTH children, snapshotted before entering
 * split and after leaving it. The master is always readable via `GET /state`
 * (a root tab). A CHILD's own transcript is NOT — S2d's own invariant is
 * that a child tab never joins `tabsStore`/`snapshot.states` (§6.3 step 9's
 * own border-sanity check below re-proves this), so the ONLY way to read a
 * child's block count is the DOM count already established by
 * `child-session-scenario-smoke.mjs`'s `CHILD_PANE_MESSAGE_COUNT_JS`
 * (count-only, no per-block ids — matched here, not strengthened, since no
 * stronger read is available). The accordion (§3.3) mounts at most ONE
 * child surface at a time (a collapsed row is "только строка-заголовок", no
 * surface), so c2's own count is naturally observable only once (step 4,
 * when it is first opened/expanded). `captureC2FinalCount` below adds ONE
 * small pair of REAL row clicks (transiently re-expand c2, read its count,
 * re-expand c1) between steps 6 and 8 purely to give c2 a genuine two-point
 * "before/after" reading for §6.3 п.7 — still zero facade shortcuts (§6.1
 * fully honored, it is the SAME `.child-split-row` click lever step 5
 * already uses), just one extra pair of clicks the 11-item list does not
 * enumerate by number. See `step7LosslessCompare`'s own doc for the exact
 * comparison this produces.
 *
 * §6.3 п.10 (mandatory console/stderr grep) — the CDP half is exact: every
 * `Runtime.consoleAPICalled` event of `type==="error"` is collected from
 * the moment the client connects. The app's OWN stderr is harder: `step1LaunchApp`
 * (out of this slice's fence, reused unmodified) spawns the dev app with
 * `stdio: ["ignore", "inherit", "inherit"]` — Node hands the child the RAW
 * OS file descriptor number this process currently owns for stderr at spawn
 * time, not a JS stream, so `child.stderr` is `null` (an inherited slot
 * exposes no stream to listen on) and there is no way to intercept it
 * without touching that file. `redirectAppStderr` below reopens THIS
 * process's own fd 2 onto a log file BEFORE `step1LaunchApp` runs (POSIX
 * guarantees the just-freed fd number is handed to the very next `open()`),
 * so the app's inherited writes land in one grep-able file. This also
 * redirects this script's OWN `console.error`/`console.warn` calls (same fd
 * 2 under the hood) — by design, not a side effect to route around: they
 * are read back and reprinted via `console.log` (fd 1, never touched) at
 * teardown (`reportAppStderr`), so nothing is silently lost, only
 * consolidated to the end of the run. POSIX-only (this repo's actual
 * dev/CI platform is macOS); a redirection failure is an honest step 10
 * FAIL, never a silent skip (`fail`, not `console.warn`+continue) — "не
 * подделывай: доложи честно."
 *
 * Usage:   node apps/desktop/scripts/child-session-split-smoke.mjs [--keep]
 *
 *   --keep   Do not delete the temp workspace/profile on exit (debugging).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider, read (by the
 * reused `step1LaunchApp`) from `.smoke-secrets/glm.env`, same file every
 * other live smoke in this repo uses.
 *
 * Each step prints `[step N] PASS/FAIL <detail>`, N matching CUT-S3 §6.3's
 * own 1..10 item numbers (step 7's PASS/FAIL line is printed after step 8
 * runs — its comparison needs data step 8 produces — see step7's own doc).
 * The first FAIL tears down and exits 1. A live-model non-compliance on the
 * dual spawn gets exactly ONE retry, then a documented SKIP (exit 0), same
 * discipline as every other harness in this directory. Evidence (5 required
 * PNGs + a JSON result dump + the redirected app-stderr log) lands in
 * `working-docs/task102-track/evidence/S3/`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const EVIDENCE_DIR = join(repoRoot, "working-docs", "task102-track", "evidence", "S3");
const APP_STDERR_LOG = join(EVIDENCE_DIR, "app-stderr.log");
const TOTAL_STEPS = 10;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
/**
 * How long each of the two children sleeps before replying DONE. Chosen
 * with headroom for the ~7 real DOM-interaction steps (2 through 6 plus the
 * extra c2 re-expand) between admission and the steer, each of which is a
 * sub-second CDP eval/API call plus a couple of short `sleep()`s and up to
 * 5 screenshots — same reasoning `child-session-race-smoke.mjs` gives for
 * its own per-probe sleep constants, scaled up for this script's longer
 * step chain (race-smoke's probes each have 1-2 interaction steps; this one
 * has 7 before it even injects the steer).
 */
const CHILD_SLEEP_SECONDS = 60;
const TERMINAL_WAIT_TIMEOUT_MS = 120_000;

const FLAGS = { keep: process.argv.slice(2).includes("--keep") };

// ── app-stderr redirection (§6.3 п.10 — see this file's own header doc) ──

/**
 * Reopens fd 2 onto `APP_STDERR_LOG`. The dry-run open+close FIRST (before
 * fd 2 is touched at all) validates the path is writable while there is
 * still a safe fallback (the caller's catch) if it is not — the actual
 * `closeSync(2)` only runs once that has already proven to succeed on the
 * IDENTICAL path, minimizing the (already POSIX-guaranteed, but not
 * Node-API-guaranteed) chance fd 2 ends up closed with nothing reopened
 * onto it.
 */
function redirectAppStderr() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (existsSync(APP_STDERR_LOG)) {
    rmSync(APP_STDERR_LOG, { force: true });
  }
  closeSync(openSync(APP_STDERR_LOG, "a"));
  closeSync(2);
  openSync(APP_STDERR_LOG, "a");
}

/**
 * Known-benign noise, explicit + comment-justified per CUT-S3 §6.3 п.10's
 * own allowance ("аллоулист известного шума ... явным списком ... с
 * комментарием-обоснованием"). Anything NOT matched here fails step 10.
 */
const APP_STDERR_ALLOWLIST = [
  // Node's one-time process-level warning the instant `node:sqlite` is first
  // required (packages/core's persistence layer, used by the main process) —
  // an API-stability notice, not a runtime defect. Observed directly on this
  // repo's own `vitest run` output moments before this script was written:
  // "(node:PID) ExperimentalWarning: SQLite is an experimental feature and
  // might change at any time" — expected once per app boot.
  /ExperimentalWarning: SQLite is an experimental feature/,
  // Well-documented Chromium/Electron DevTools-protocol noise: any CDP
  // client that does not implement the OPTIONAL `Autofill` domain (this
  // script's own `--remote-debugging-port` connection included) gets this
  // benign "failed" line logged by Electron's devtools-protocol bridge —
  // unrelated to the product, which has no form-autofill surface at all.
  /Request Autofill\.(enable|setAddresses) failed/,
];

/** Empty by design (see file header) — extend with a comment-justified regex the same way `APP_STDERR_ALLOWLIST` is, the first time a real run needs one. */
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
// every precedent script in this directory already establishes, extended
// with Runtime.enable + a live console.error collector (§6.3 п.10). ──

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

  // Console-error events only stream once the Runtime domain is enabled for
  // this session — `Runtime.evaluate` (used by `eval` below) works with or
  // without it, but `consoleAPICalled` does not fire at all otherwise.
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

// ── browser-side geometry/DOM expressions (product-code-free) ──

/**
 * Reads `.child-split-pane` (§3.5, FROZEN contract) end to end: pane
 * geometry + viewport-clamped hit-test (the "hit at the on-screen
 * INTERSECTION centre, not the raw rect centre" lesson — an element whose
 * own centre sits off-screen makes `elementFromPoint` return null by
 * definition, a false "hit outside" this repo has already paid for once,
 * `child-session-race-smoke.mjs`'s `cardGeometryJs` doc), the head (single
 * vs roster variant, ⤢/× buttons), every `.child-split-row` (spawn id,
 * expanded modifier, whether/how-tall its own `.child-split-surface` is),
 * and — for the N=1 case, where §3.3 says NO row element exists at all, just
 * "голова-single + поверхность" — a loose surface hanging directly off the
 * pane/head.
 */
function childSplitStateJs() {
  return `(() => {
    const pane = document.querySelector('.child-split-pane');
    if (!pane) return { ok: false, reason: 'no_pane' };
    const rect = pane.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const visLeft = Math.max(rect.left, 0);
    const visTop = Math.max(rect.top, 0);
    const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
    const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
    const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
    const hit = visWidth > 0 && visHeight > 0 ? document.elementFromPoint(cx, cy) : null;

    const head = pane.querySelector('.child-split-head');
    const headRoster = head ? head.classList.contains('child-split-head-roster') : false;
    const headExpandBtn = pane.querySelector('.child-split-head-expand');
    const headCloseBtn = pane.querySelector('.child-split-head-close');

    const rows = Array.from(pane.querySelectorAll('.child-split-row')).map((row) => {
      const expanded = row.classList.contains('child-split-row-expanded');
      const surface = row.querySelector('.child-split-surface');
      return {
        spawnId: row.getAttribute('data-spawn-id'),
        expanded,
        hasSurface: !!surface,
        surfaceHeight: surface ? surface.offsetHeight : 0,
      };
    });

    // N=1 layout (§3.3): no .child-split-row at all — the single child's
    // surface hangs directly off the pane, sibling to the head.
    const looseSurface = rows.length === 0 ? pane.querySelector('.child-split-surface') : null;

    const composerTextarea = pane.querySelector('.composer-textarea');
    const composerSend = pane.querySelector('.composer-send');

    return {
      ok: true,
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      visible: { left: visLeft, top: visTop, width: visWidth, height: visHeight },
      hitInside: hit ? (pane.contains(hit) || hit === pane) : false,
      hitTag: hit ? hit.tagName : null,
      hasHead: !!head,
      headRoster,
      headText: head ? head.textContent : null,
      hasExpandBtn: !!headExpandBtn,
      hasCloseBtn: !!headCloseBtn,
      rows,
      hasLooseSurface: !!looseSurface,
      looseSurfaceHeight: looseSurface ? looseSurface.offsetHeight : 0,
      hasComposerTextarea: !!composerTextarea,
      hasComposerSend: !!composerSend,
      breadcrumbPresent: !!document.querySelector('.child-session-breadcrumb'),
      sessionHeaderPresent: !!document.querySelector('.session-header:not(.child-session-breadcrumb)'),
      viewportWidth: vw, viewportHeight: vh,
    };
  })()`;
}

/**
 * The MASTER'S OWN `.session-conversation` (App.tsx's `SessionSurface`,
 * shared verbatim by the master pane, layout B's child pane, AND split's
 * live child surfaces per that component's own doc — so in split mode
 * MULTIPLE `.session-conversation` nodes exist in the DOM at once; the
 * master's is whichever one is NOT nested under `.child-split-pane`).
 * Same viewport-clamped hit-test discipline as `childSplitStateJs` above.
 */
const MASTER_PANEL_GEOMETRY_JS = `(() => {
  const all = Array.from(document.querySelectorAll('.session-conversation'));
  const master = all.find((el) => !el.closest('.child-split-pane'));
  if (!master) return { ok: false, reason: 'no_master_panel' };
  const rect = master.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const visLeft = Math.max(rect.left, 0);
  const visTop = Math.max(rect.top, 0);
  const visWidth = Math.max(0, Math.min(rect.right, vw) - visLeft);
  const visHeight = Math.max(0, Math.min(rect.bottom, vh) - visTop);
  const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
  const hit = visWidth > 0 && visHeight > 0 ? document.elementFromPoint(cx, cy) : null;
  return {
    ok: true,
    rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    visible: { left: visLeft, top: visTop, width: visWidth, height: visHeight },
    hitInside: hit ? (master.contains(hit) || hit === master) : false,
    hitTag: hit ? hit.tagName : null,
    viewportWidth: vw, viewportHeight: vh,
  };
})()`;

/** Layout B's pane geometry (same shape `child-session-scenario-smoke.mjs`'s `CHILD_PANE_GEOMETRY_JS` established), rewritten fresh here (not exported by that script) with the viewport-clamped hit-test. */
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
  const cx = visLeft + visWidth / 2, cy = visTop + visHeight / 2;
  const hit = visWidth > 0 && visHeight > 0 ? document.elementFromPoint(cx, cy) : null;
  return {
    ok: true,
    paneRect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    paneOffsetHeight: pane.offsetHeight,
    hitInsidePane: hit ? (pane.contains(hit) || hit === pane) : false,
    hitTag: hit ? hit.tagName : null,
    hasComposer: composer !== null,
    hasReadonlyBadge: readonlyBadge !== null,
    viewportWidth: vw, viewportHeight: vh,
  };
})()`;

const CHILD_B_PANE_MOUNTED_JS = `(() => !!document.querySelector('.child-session-breadcrumb'))()`;
const CHILD_B_MESSAGE_COUNT_JS = `(() => {
  const header = document.querySelector('.child-session-breadcrumb');
  const pane = header ? header.nextElementSibling : null;
  return pane ? pane.querySelectorAll('.message-list .message').length : -1;
})()`;
/** Whichever child surface is CURRENTLY mounted inside the split pane (at most one at a time, §3.3) — works uniformly for the N=1 loose-surface and N>=2 row-nested-surface shapes, since it searches the whole subtree. */
const CHILD_SPLIT_MESSAGE_COUNT_JS = `(() => {
  const surface = document.querySelector('.child-split-pane .child-split-surface');
  return surface ? surface.querySelectorAll('.message-list .message').length : -1;
})()`;

const CLICK_BREADCRUMB_MASTER_JS = `(() => {
  const btn = document.querySelector('.child-breadcrumb-master');
  if (!btn) return { ok: false, reason: 'no_button' };
  btn.click();
  return { ok: true };
})()`;

function clickSelectorJs(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not_found' };
    el.click();
    return { ok: true };
  })()`;
}

function clickRowJs(spawnId) {
  return `(() => {
    const row = document.querySelector('.child-split-row[data-spawn-id="' + CSS.escape(${JSON.stringify(spawnId)}) + '"]');
    if (!row) return { ok: false, reason: 'not_found' };
    row.click();
    return { ok: true };
  })()`;
}

function typeIntoSplitComposerJs(text) {
  return `(() => {
    const ta = document.querySelector('.child-split-pane .composer-textarea');
    if (!ta) return { ok: false, reason: 'no_textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value };
  })()`;
}

const SPLIT_COMPOSER_RUNNING_JS = `(() => !!document.querySelector('.child-split-pane .composer-stop'))()`;
const CLICK_SPLIT_COMPOSER_SEND_JS = `(() => {
  const btn = document.querySelector('.child-split-pane .composer-send');
  if (!btn) return { ok: false, reason: 'no_button' };
  if (btn.disabled) return { ok: false, reason: 'disabled' };
  btn.click();
  return { ok: true };
})()`;

/** Sidebar row titles (border-sanity §6.3 step 9 / I5) — same technique `child-session-scenario-smoke.mjs`'s own `SIDEBAR_ROW_TITLES_JS` established (not exported there). */
const SIDEBAR_ROW_TITLES_JS = `(() => Array.from(document.querySelectorAll('.sidebar-row')).map((row) => (row.querySelector('.sidebar-row-title')?.textContent ?? null)))()`;

// ── prompts ──

function spawnDualPrompt(sleepSeconds, retry) {
  if (!retry) {
    return (
      'In this SAME turn, call the Agent tool TWO SEPARATE times — two distinct real tool calls, not one call ' +
      'described twice, and not two calls spread across separate turns. For EACH of the two calls use ' +
      'tier: "session", agent_type: "general-purpose", a short description ("Split probe 1" and "Split probe 2"), ' +
      `and a prompt telling the subagent to run the Bash tool with the exact command "sleep ${sleepSeconds}", ` +
      'wait for it to finish, then reply with exactly the single word DONE and use no further tools. Issue both ' +
      "tool calls now, in this one turn, without waiting for either one's individual result in between. You MUST " +
      'include tier:"session" on both — do not use tier "inline" for either of them.'
    );
  }
  return (
    'You did not issue two separate Agent tool calls in one turn. Try again: in THIS turn, call the Agent tool ' +
    'TWO separate times (two distinct tool invocations in the same response), each with tier set to the literal ' +
    'string "session", agent_type "general-purpose", a short distinct description, and a prompt telling the ' +
    `subagent to run Bash "sleep ${sleepSeconds}" then reply DONE. Do not describe what you would do — issue two ` +
    'real tool calls, right now, in this one turn.'
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

async function findMasterToolCallBlock(ctx, step, toolCallId) {
  const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
  return transcript.find((b) => b.kind === "tool_call" && b.toolCallId === toolCallId) ?? null;
}

/** Root tab's own transcript block ids/count + turn.status, read via `GET /state` (works regardless of what the DOM currently shows — the master is always a root tab). Used for the I4 lossless compare (§6.3 step 7). */
async function captureMasterSnapshot(ctx, step) {
  const resp = await api(ctx, "GET", "/state");
  if (resp.status !== 200) {
    fail(step, `GET /state -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  const state = resp.body?.snapshot?.states?.[ctx.tabId];
  const transcript = state?.transcript;
  if (!Array.isArray(transcript)) {
    fail(step, "GET /state returned no transcript array for the root tab");
  }
  return { ids: transcript.map((b) => b.id), turnStatus: state?.turn?.status ?? null };
}

function assertIdsSubset(step, label, beforeIds, afterIds) {
  const afterSet = new Set(afterIds);
  const missing = beforeIds.filter((id) => !afterSet.has(id));
  assert(step, missing.length === 0, `${label}: ${missing.length} block id(s) present BEFORE are missing AFTER (nothing should ever disappear): ${JSON.stringify(missing)}`);
  assert(step, afterIds.length >= beforeIds.length, `${label}: block count shrank from ${beforeIds.length} to ${afterIds.length}`);
}

function assertCountNonDecreasing(step, label, before, after) {
  assert(step, typeof before === "number" && before >= 0, `${label}: no valid BEFORE count captured (${JSON.stringify(before)})`);
  assert(step, typeof after === "number" && after >= 0, `${label}: no valid AFTER count captured (${JSON.stringify(after)})`);
  assert(step, after >= before, `${label}: count shrank from ${before} to ${after} (nothing should ever disappear)`);
}

// ── step 1: master spawns TWO session-tier children in one turn ──

async function step1SpawnTwo(ctx) {
  const step = 1;
  let result = await attemptDispatch(ctx, step, spawnDualPrompt(CHILD_SLEEP_SECONDS, false), 60_000);
  let anyAgentSeen = result.anyAgentSeen;
  let before = new Set();

  let sessionBlocks = findSessionAgentBlocks((await getTranscriptBlocks(ctx, step, ctx.tabId)).transcript);
  if (sessionBlocks.length !== 2) {
    console.warn(`[child-session-split-smoke] step 1: expected 2 tier:"session" Agent calls in one turn, got ${sessionBlocks.length} — retrying once`);
    before = new Set(sessionBlocks.map((b) => b.toolCallId));
    await settleTurn(ctx, step);
    result = await attemptDispatch(ctx, step, spawnDualPrompt(CHILD_SLEEP_SECONDS, true), 90_000);
    anyAgentSeen = anyAgentSeen || result.anyAgentSeen;
  }

  if (!anyAgentSeen) {
    await settleTurn(ctx, step);
    ctx.skipped = true;
    ctx.skipReason = "model never called Agent at all, after 1 retry";
    pass(step, `SKIPPED (documented) — ${ctx.skipReason}`);
    return;
  }

  sessionBlocks = findSessionAgentBlocks((await getTranscriptBlocks(ctx, step, ctx.tabId)).transcript).filter((b) => !before.has(b.toolCallId));
  if (sessionBlocks.length !== 2) {
    await settleTurn(ctx, step);
    ctx.skipped = true;
    ctx.skipReason = `model never issued exactly 2 tier:"session" Agent calls in one turn after 1 retry (got ${sessionBlocks.length})`;
    pass(step, `SKIPPED (documented) — ${ctx.skipReason}`);
    return;
  }

  const stable = await pollUntil(20_000, 300, async () => {
    const { transcript, childRuns } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const ids = new Set(sessionBlocks.map((b) => b.toolCallId));
    const blocks = transcript.filter((b) => ids.has(b.toolCallId));
    if (blocks.length !== 2) return undefined;
    if (!blocks.every((b) => b.status === "running")) return undefined;
    if (childRuns.length !== 2) return undefined;
    return { blocks, childRuns };
  });
  assert(step, stable !== null, 'two session-tier children never both reached status:"running" with 2 childRuns entries within 20s');
  await sleep(400);
  const second = await getTranscriptBlocks(ctx, step, ctx.tabId);
  const idsSet = new Set(sessionBlocks.map((b) => b.toolCallId));
  const secondBlocks = second.transcript.filter((b) => idsSet.has(b.toolCallId));
  assert(step, secondBlocks.every((b) => b.status === "running"), `not both children still "running" 400ms later: ${JSON.stringify(secondBlocks.map((b) => b.status))}`);
  assert(step, second.childRuns.length === 2, `expected 2 childRuns entries on the second read, got ${second.childRuns.length}`);

  ctx.c1ToolCallId = sessionBlocks[0].toolCallId;
  ctx.c2ToolCallId = sessionBlocks[1].toolCallId;
  ctx.childSessionIds = second.childRuns.map((e) => e.childSessionId);

  pass(step, `two session-tier children admitted & running: c1=${ctx.c1ToolCallId} c2=${ctx.c2ToolCallId}, childRuns=${second.childRuns.length}`);
}

// ── step 2: Open c1 -> layout B; probe=child; PNG s3-1-layout-B ──

async function step2OpenChild1ToB(ctx) {
  const step = 2;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.c1ToolCallId });
  const mounted = await pollUntil(10_000, 200, async () => ((await ctx.cdp.eval(CHILD_B_PANE_MOUNTED_JS)) === true ? true : undefined));
  assert(step, mounted === true, "child pane (.child-session-breadcrumb) never mounted within 10s of Open");

  const probe = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probe?.ok === true, `childLayoutState probe rejected: ${JSON.stringify(probe)}`);
  assert(step, probe.view?.kind === "child", `expected view.kind==="child" after Open, got ${JSON.stringify(probe.view)}`);
  assert(step, probe.view?.spawnToolCallId === ctx.c1ToolCallId, `expected view targeting c1, got ${JSON.stringify(probe.view)}`);

  await sleep(250);
  ctx.pngLayoutB = await saveScreenshot(ctx, "s3-1-layout-B");
  pass(step, `Open on c1 -> layout B, probe view=${JSON.stringify(probe.view)}`);
}

// ── step 3: click .child-breadcrumb-split -> split, order=[c1]; geometry C; PNG s3-2-layout-C ──

async function step3EnterSplit(ctx) {
  const step = 3;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  // Lossless baseline (§6.3 step 7 / I4) — captured HERE, right before the
  // split-entry click, per the cut's own "снята до шага 3" wording. c1's
  // count is read off the CURRENTLY-shown B pane (still mounted at this
  // instant); the master is always readable via /state regardless.
  ctx.losslessBaselineMaster = await captureMasterSnapshot(ctx, step);
  ctx.losslessBaselineC1 = await ctx.cdp.eval(CHILD_B_MESSAGE_COUNT_JS);

  const clicked = await ctx.cdp.eval(clickSelectorJs(".child-breadcrumb-split"));
  assert(step, clicked.ok === true, `click on .child-breadcrumb-split failed: ${JSON.stringify(clicked)}`);
  await sleep(250);

  const probe = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probe?.ok === true, `childLayoutState probe rejected: ${JSON.stringify(probe)}`);
  assert(step, probe.view?.kind === "split", `expected view.kind==="split" after Split click, got ${JSON.stringify(probe.view)}`);
  assert(
    step,
    Array.isArray(probe.view?.order) && probe.view.order.length === 1 && probe.view.order[0] === ctx.c1ToolCallId,
    `expected order=[c1], got ${JSON.stringify(probe.view)}`,
  );
  assert(step, probe.view?.expandedId === ctx.c1ToolCallId, `expected expandedId===c1, got ${JSON.stringify(probe.view)}`);

  const state = await ctx.cdp.eval(childSplitStateJs());
  assert(step, state.ok === true, `no .child-split-pane found in the DOM: ${JSON.stringify(state)}`);
  assert(step, state.rect.width > 300, `child-split-pane width not > 300: ${JSON.stringify(state.rect)}`);
  assert(step, state.rect.height > 0, "child-split-pane height is 0");
  assert(step, state.visible.width > 0 && state.visible.height > 0, `child-split-pane has no on-screen area at all: ${JSON.stringify(state)}`);
  assert(step, state.hitInside === true, `elementFromPoint at .child-split-pane's on-screen centre (hit=${state.hitTag}) did NOT land inside it`);
  assert(step, state.breadcrumbPresent === false, "expected NO .child-session-breadcrumb in split mode, one is present");
  assert(step, state.sessionHeaderPresent === true, "expected the master's own .session-header present in split mode, none found");
  assert(step, state.hasComposerTextarea === true && state.hasComposerSend === true, `expected the child's composer inside .child-split-pane, found none: ${JSON.stringify(state)}`);

  const master = await ctx.cdp.eval(MASTER_PANEL_GEOMETRY_JS);
  assert(step, master.ok === true, `no master .session-conversation panel found (outside .child-split-pane): ${JSON.stringify(master)}`);
  assert(step, master.rect.width >= 320, `master panel width not >= 320: ${JSON.stringify(master.rect)}`);
  assert(
    step,
    master.hitInside === true,
    `elementFromPoint at the master panel's own centre (hit=${master.hitTag}) did NOT land inside it — split is only real if BOTH panels are (CUT-S3 §6.3 п.3)`,
  );

  ctx.pngLayoutC = await saveScreenshot(ctx, "s3-2-layout-C");
  pass(step, `Split click -> layout C: pane rect=${JSON.stringify(state.rect)}, master rect=${JSON.stringify(master.rect)}, both hit-testable`);
}

// ── step 4: Open c2 while split -> accordion, order=[c1,c2] expanded=c2; PNG s3-3-layout-D ──

async function step4OpenChild2Accordion(ctx) {
  const step = 4;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/child/open`, { spawnToolCallId: ctx.c2ToolCallId });
  await sleep(250);

  const probe = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probe?.ok === true, `childLayoutState probe rejected: ${JSON.stringify(probe)}`);
  assert(step, probe.view?.kind === "split", `expected view.kind==="split", got ${JSON.stringify(probe.view)}`);
  assert(
    step,
    Array.isArray(probe.view?.order) && probe.view.order.length === 2 && probe.view.order[0] === ctx.c1ToolCallId && probe.view.order[1] === ctx.c2ToolCallId,
    `expected order=[c1,c2], got ${JSON.stringify(probe.view)}`,
  );
  assert(step, probe.view?.expandedId === ctx.c2ToolCallId, `expected expandedId===c2, got ${JSON.stringify(probe.view)}`);

  const state = await ctx.cdp.eval(childSplitStateJs());
  assert(step, state.ok === true, `no .child-split-pane in the DOM: ${JSON.stringify(state)}`);
  assert(step, state.headRoster === true, `expected the roster head variant (N=2), got: ${JSON.stringify(state)}`);
  assert(step, state.rows.length === 2, `expected exactly 2 .child-split-row elements, got ${state.rows.length}: ${JSON.stringify(state.rows)}`);

  const expandedRows = state.rows.filter((r) => r.expanded);
  assert(step, expandedRows.length === 1, `expected exactly ONE .child-split-row-expanded, got ${expandedRows.length}: ${JSON.stringify(state.rows)}`);
  assert(step, expandedRows[0].spawnId === ctx.c2ToolCallId, `expected the expanded row to be c2, got ${JSON.stringify(expandedRows[0])}`);
  assert(step, expandedRows[0].hasSurface === true && expandedRows[0].surfaceHeight > 0, `expanded row (c2) has no live surface / zero height: ${JSON.stringify(expandedRows[0])}`);
  for (const row of state.rows.filter((r) => !r.expanded)) {
    assert(step, row.hasSurface === false || row.surfaceHeight === 0, `collapsed row ${row.spawnId} unexpectedly has a non-zero-height surface: ${JSON.stringify(row)}`);
  }
  // Roster text sourced from live data (§8 п.4 anti-facade risk: a hardcoded
  // "Subagents · 3 · 2 running" literal would still pass a naive DOM check).
  assert(step, typeof state.headText === "string" && state.headText.includes("2"), `roster head text does not mention total=2: ${JSON.stringify(state.headText)}`);

  ctx.losslessC2Early = await ctx.cdp.eval(CHILD_SPLIT_MESSAGE_COUNT_JS);
  ctx.pngLayoutD = await saveScreenshot(ctx, "s3-3-layout-D");
  pass(step, `Open on c2 while split -> accordion: order=[c1,c2] expanded=c2, roster head="${state.headText}", exactly 1 expanded row`);
}

// ── step 5: click collapsed row c1 -> expanded=c1, geometry inverted; PNG s3-4-accordion-switch ──

async function step5SwitchRow(ctx) {
  const step = 5;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }
  const clicked = await ctx.cdp.eval(clickRowJs(ctx.c1ToolCallId));
  assert(step, clicked.ok === true, `click on .child-split-row[data-spawn-id=c1] failed: ${JSON.stringify(clicked)}`);
  await sleep(250);

  const probe = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probe?.ok === true && probe.view?.kind === "split", `probe not split after row click: ${JSON.stringify(probe)}`);
  assert(step, probe.view.expandedId === ctx.c1ToolCallId, `expected expandedId===c1 after clicking its row, got ${JSON.stringify(probe.view)}`);
  assert(
    step,
    JSON.stringify(probe.view.order) === JSON.stringify([ctx.c1ToolCallId, ctx.c2ToolCallId]),
    `order should be UNCHANGED by a row click (only expandedId moves), got ${JSON.stringify(probe.view.order)}`,
  );

  const state = await ctx.cdp.eval(childSplitStateJs());
  const expandedRows = state.rows.filter((r) => r.expanded);
  assert(step, expandedRows.length === 1 && expandedRows[0].spawnId === ctx.c1ToolCallId, `expected exactly one expanded row (c1) after the switch, got ${JSON.stringify(state.rows)}`);
  const collapsedC2 = state.rows.find((r) => r.spawnId === ctx.c2ToolCallId);
  assert(
    step,
    collapsedC2 !== undefined && (collapsedC2.hasSurface === false || collapsedC2.surfaceHeight === 0),
    `c2's row should now be collapsed (no live-height surface), got ${JSON.stringify(collapsedC2)}`,
  );

  ctx.pngAccordionSwitch = await saveScreenshot(ctx, "s3-4-accordion-switch");
  pass(step, "row click switched expanded c2->c1, geometry inverted from step 4");
}

// ── step 6: steer c1 (RUNNING, split position) via the REAL composer inside .child-split-pane ──

async function step6Steering(ctx) {
  const step = 6;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const preSteerBlock = await findMasterToolCallBlock(ctx, step, ctx.c1ToolCallId);
  assert(
    step,
    preSteerBlock !== null && preSteerBlock.status === "running",
    `c1's master Agent tool_call is not "running" at steer-injection time — no busy window left to steer into: ${JSON.stringify(preSteerBlock)}`,
  );

  const running = await pollUntil(10_000, 300, async () => ((await ctx.cdp.eval(SPLIT_COMPOSER_RUNNING_JS)) === true ? true : undefined));
  assert(step, running === true, "c1's own composer inside .child-split-pane never showed .composer-stop within 10s — no busy window to steer into");

  ctx.steerProofPath = join(ctx.tmpWorkspace, "split-steer-proof.txt");
  const steerText = `Also run the Bash tool with the exact command "echo STEERED > ${ctx.steerProofPath}" before you reply DONE, in addition to the sleep.`;

  const typed = await ctx.cdp.eval(typeIntoSplitComposerJs(steerText));
  assert(step, typed.ok === true && typed.value === steerText, `typing into the split child composer failed or textarea value mismatched: ${JSON.stringify(typed)}`);

  const clicked = await ctx.cdp.eval(CLICK_SPLIT_COMPOSER_SEND_JS);
  assert(step, clicked.ok === true, `click on .child-split-pane .composer-send failed: ${JSON.stringify(clicked)}`);

  const postClickBlock = await findMasterToolCallBlock(ctx, step, ctx.c1ToolCallId);
  const stillRunningAtInjection = postClickBlock !== null && postClickBlock.status === "running";
  assert(
    step,
    stillRunningAtInjection === true,
    `the steer click landed AFTER c1's master Agent tool_call had already gone terminal (status=${postClickBlock?.status}) — this run cannot demonstrate steering-before-unblock`,
  );

  const terminal = await pollUntil(TERMINAL_WAIT_TIMEOUT_MS, 500, async () => {
    const block = await findMasterToolCallBlock(ctx, step, ctx.c1ToolCallId);
    return block !== null && (block.status === "success" || block.status === "error") ? block : undefined;
  });
  assert(step, terminal !== null, `c1's master Agent tool_call never reached a terminal status within ${TERMINAL_WAIT_TIMEOUT_MS}ms after the split-position steer`);
  ctx.step6Terminal = terminal;

  const toolCallsMade = terminal.subagent?.toolCalls ?? null;
  const steerFileExists = existsSync(ctx.steerProofPath);
  const steerFileContent = steerFileExists ? readFileSync(ctx.steerProofPath, "utf8").trim() : null;
  const steeringWorked = steerFileExists && steerFileContent === "STEERED" && toolCallsMade >= 2;

  assert(
    step,
    steeringWorked,
    "steer message (typed+sent via the REAL composer INSIDE .child-split-pane) did not affect c1's result: " +
      `toolCallsMade=${toolCallsMade}, ${ctx.steerProofPath} exists=${steerFileExists} content=${JSON.stringify(steerFileContent)}. Final block: ${JSON.stringify(terminal)}`,
  );

  pass(step, `steering in split position worked: injected while c1 was still "running", toolCalls=${toolCallsMade}, ${ctx.steerProofPath} written with STEERED`);
}

// ── NOT one of §6.3's 11 enumerated steps — see this file's own header "DEVIATION" note ──

async function captureC2FinalCount(ctx) {
  const step = 7; // reports under step 7 (I4) — the measurement this produces belongs to that comparison, not a new numbered step.
  if (ctx.skipped) {
    return;
  }
  const toC2 = await ctx.cdp.eval(clickRowJs(ctx.c2ToolCallId));
  assert(step, toC2.ok === true, `transient re-expand click on c2's row (for the I4 "after" reading) failed: ${JSON.stringify(toC2)}`);
  await sleep(200);
  ctx.losslessC2Final = await ctx.cdp.eval(CHILD_SPLIT_MESSAGE_COUNT_JS);

  const backToC1 = await ctx.cdp.eval(clickRowJs(ctx.c1ToolCallId));
  assert(step, backToC1.ok === true, `restoring expandedId=c1 before step 8's ⤢ failed: ${JSON.stringify(backToC1)}`);
  await sleep(200);
  const probe = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probe?.ok === true && probe.view?.expandedId === ctx.c1ToolCallId, `expandedId not restored to c1 before step 8: ${JSON.stringify(probe)}`);
}

// ── step 8: ⤢ -> layout B on c1 (terminal per step 6 -> read-only); breadcrumb -> master; PNG s3-5-back-to-B ──

async function step8ExitSplitBackToMaster(ctx) {
  const step = 8;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }

  const clickedExpand = await ctx.cdp.eval(clickSelectorJs(".child-split-head-expand"));
  assert(step, clickedExpand.ok === true, `click on .child-split-head-expand (⤢) failed: ${JSON.stringify(clickedExpand)}`);
  await sleep(250);

  const probeAfterExpand = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probeAfterExpand?.ok === true, `probe rejected after ⤢: ${JSON.stringify(probeAfterExpand)}`);
  assert(step, probeAfterExpand.view?.kind === "child", `expected view.kind==="child" after ⤢, got ${JSON.stringify(probeAfterExpand.view)}`);
  assert(step, probeAfterExpand.view?.spawnToolCallId === ctx.c1ToolCallId, `expected view targeting c1 after ⤢, got ${JSON.stringify(probeAfterExpand.view)}`);

  const bGeo = await ctx.cdp.eval(CHILD_B_PANE_GEOMETRY_JS);
  assert(step, bGeo.ok === true, `no child pane (.child-session-breadcrumb) found after ⤢: ${JSON.stringify(bGeo)}`);
  assert(step, bGeo.paneRect.width > 0 && bGeo.paneRect.height > 0, `B pane has zero rect after ⤢: ${JSON.stringify(bGeo.paneRect)}`);
  assert(step, bGeo.hitInsidePane === true, `elementFromPoint at the B pane's own on-screen centre did NOT land inside it after ⤢ (hit=${bGeo.hitTag})`);
  // c1 was steered to a terminal status in step 6 (this script waits for it
  // before returning) — the B surface here is deterministically the
  // READ-ONLY C4 branch, the same variant `child-session-scenario-smoke.mjs`
  // exercises for an already-terminal child (readonly badge, no composer).
  assert(step, bGeo.hasReadonlyBadge === true, `expected the readonly badge on c1's B surface (terminal per step 6), none found: ${JSON.stringify(bGeo)}`);
  assert(step, bGeo.hasComposer === false, `expected NO composer on c1's now-completed B surface, found one: ${JSON.stringify(bGeo)}`);

  ctx.losslessFinalC1 = await ctx.cdp.eval(CHILD_B_MESSAGE_COUNT_JS);
  ctx.pngBackToB = await saveScreenshot(ctx, "s3-5-back-to-B");

  const clickedMaster = await ctx.cdp.eval(CLICK_BREADCRUMB_MASTER_JS);
  assert(step, clickedMaster?.ok === true, `breadcrumb "back to master" click failed: ${JSON.stringify(clickedMaster)}`);
  await sleep(250);

  const probeAfterMaster = await apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/child/layout`);
  assert(step, probeAfterMaster?.ok === true && probeAfterMaster.view?.kind === "master", `expected view.kind==="master" after breadcrumb click, got ${JSON.stringify(probeAfterMaster)}`);

  pass(step, "⤢ -> layout B (read-only, c1 terminal), breadcrumb -> master; probe confirms both transitions");
}

// ── step 7: lossless round-trip (I4) — compared HERE, after step 8, using the baseline step 3 captured (see this file's own DEVIATION note for c2's reading) ──

async function step7LosslessCompare(ctx) {
  const step = 7;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }
  const finalMaster = await captureMasterSnapshot(ctx, step);

  assertIdsSubset(step, "master transcript", ctx.losslessBaselineMaster.ids, finalMaster.ids);
  assert(
    step,
    finalMaster.turnStatus === ctx.losslessBaselineMaster.turnStatus,
    `master turn.status changed across the split round-trip: ${ctx.losslessBaselineMaster.turnStatus} -> ${finalMaster.turnStatus} (c2 was designed to still be admitted/blocking throughout)`,
  );
  assertCountNonDecreasing(step, "c1 transcript (B before-split -> B after-exit, read-only)", ctx.losslessBaselineC1, ctx.losslessFinalC1);
  assertCountNonDecreasing(step, "c2 transcript (split-open -> transient re-expand)", ctx.losslessC2Early, ctx.losslessC2Final);

  pass(
    step,
    `lossless round-trip (I4): master ${ctx.losslessBaselineMaster.ids.length}->${finalMaster.ids.length} blocks (turn.status stable="${finalMaster.turnStatus}"), ` +
      `c1 ${ctx.losslessBaselineC1}->${ctx.losslessFinalC1} messages, c2 ${ctx.losslessC2Early}->${ctx.losslessC2Final} messages — nothing disappeared`,
  );
}

// ── step 9: border sanity (I5) — children nowhere in Sidebar/StartScreen/palette's shared data source ──

async function step9BorderSanity(ctx) {
  const step = 9;
  if (ctx.skipped) {
    pass(step, "SKIPPED (documented) — see step 1");
    return;
  }
  const sessions = await apiOk(ctx, step, "GET", "/sessions");
  assert(step, Array.isArray(sessions), `GET /sessions did not return an array: ${JSON.stringify(sessions)}`);
  for (const id of ctx.childSessionIds ?? []) {
    const leaked = sessions.find((s) => s.id === id);
    assert(step, leaked === undefined, `GET /sessions leaked a child session: ${JSON.stringify(leaked)}`);
  }

  const state = await apiOk(ctx, step, "GET", "/state");
  const stateKeys = Object.keys(state.snapshot?.states ?? {});
  assert(
    step,
    stateKeys.length === 1 && stateKeys[0] === ctx.tabId,
    `expected /state's per-tab states map to contain ONLY the root tab (a second key would mean a child port auto-registered as one), got keys=${JSON.stringify(stateKeys)}`,
  );

  const sidebarRows = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
  assert(step, Array.isArray(sidebarRows), `sidebar row probe did not return an array: ${JSON.stringify(sidebarRows)}`);
  assert(
    step,
    sidebarRows.length === ctx.baselineSidebarRowCount,
    `sidebar row count changed from ${ctx.baselineSidebarRowCount} (before spawn) to ${sidebarRows.length} while split is open: ${JSON.stringify(sidebarRows)}`,
  );

  pass(
    step,
    `border sanity (I5): /sessions excludes both children, /state's per-tab states map has ONLY the root tab, sidebar row count unchanged at ${sidebarRows.length} ` +
      "(StartScreen inapplicable with a tab open; CommandPalette reads the SAME window.anycode.listSessions() the /sessions check above already covers)",
  );
}

// ── step 10: mandatory console/stderr grep (§6.3 п.10) — see this file's own header doc ──

async function step10ConsoleGrep(ctx) {
  const step = 10;
  assert(
    step,
    ctx.stderrRedirected === true,
    "app-stderr redirection was never established at startup (see the WARNING printed before step 1) — cannot honestly grep app stderr, so this gate FAILS rather than silently skipping it",
  );

  const consoleErrors = ctx.cdp.consoleErrors ?? [];
  const unexpectedConsoleErrors = consoleErrors.filter((e) => !CDP_CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(e.text)));
  assert(
    step,
    unexpectedConsoleErrors.length === 0,
    `${unexpectedConsoleErrors.length} unexpected CDP console-error record(s) (Runtime.consoleAPICalled type==="error"): ${JSON.stringify(unexpectedConsoleErrors)}`,
  );

  let stderrText = "";
  try {
    stderrText = readFileSync(APP_STDERR_LOG, "utf8");
  } catch (err) {
    fail(step, `could not read the redirected app-stderr log at ${APP_STDERR_LOG}: ${err?.message ?? err}`);
  }
  const stderrLines = stderrText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const unexpectedStderrLines = stderrLines.filter((line) => !APP_STDERR_ALLOWLIST.some((re) => re.test(line)));
  ctx.stderrLineCount = stderrLines.length;
  ctx.unexpectedStderrLines = unexpectedStderrLines;
  assert(
    step,
    unexpectedStderrLines.length === 0,
    `${unexpectedStderrLines.length} unexpected app-stderr line(s) (of ${stderrLines.length} total, ${APP_STDERR_ALLOWLIST.length}-pattern allowlist applied): ${JSON.stringify(unexpectedStderrLines.slice(0, 20))}`,
  );

  pass(
    step,
    `console/stderr grep clean: 0 unexpected CDP console-error records (of ${consoleErrors.length} total), 0 unexpected app-stderr lines (of ${stderrLines.length} total)`,
  );
}

// ── teardown (own trio — NOT the imported one, which hard-codes S2's own evidence dir/result filename) ──

function teardown(ctx, failedStep, stepsCompleted) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep, stepsCompleted);
  }
  return ctx.teardownPromise;
}

/** Best-effort final report of the redirected app-stderr log (console.log/fd 1 — unaffected by the redirection) so nothing captured only into the log file is silently lost from the human-visible report. */
function reportAppStderr(ctx) {
  if (!ctx.stderrRedirected) {
    console.log("[child-session-split-smoke] app-stderr was never redirected (see the startup WARNING) — nothing captured");
    return;
  }
  try {
    const text = readFileSync(APP_STDERR_LOG, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    console.log(`[child-session-split-smoke] captured app-stderr: ${lines.length} line(s) at ${APP_STDERR_LOG}`);
    if (Array.isArray(ctx.unexpectedStderrLines) && ctx.unexpectedStderrLines.length > 0) {
      console.log(`[child-session-split-smoke] ${ctx.unexpectedStderrLines.length} UNEXPECTED (non-allowlisted) line(s):`);
      for (const line of ctx.unexpectedStderrLines) {
        console.log(`  ${line}`);
      }
    }
  } catch (err) {
    console.log(`[child-session-split-smoke] could not read back ${APP_STDERR_LOG} for the final report: ${err?.message ?? err}`);
  }
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
      console.log(`[child-session-split-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.log(`[child-session-split-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[child-session-split-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.log(`[child-session-split-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const verdict = ctx.skipped ? `SKIPPED (${ctx.skipReason})` : failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[child-session-split-smoke] ${stepsCompleted}/${TOTAL_STEPS} steps passed — ${verdict}`);
  reportAppStderr(ctx);

  try {
    mkdirSync(ctx.evidenceDir, { recursive: true });
    const resultPath = join(ctx.evidenceDir, "split-result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verdict,
          failedStep,
          skipped: ctx.skipped === true,
          skipReason: ctx.skipReason ?? null,
          c1ToolCallId: ctx.c1ToolCallId ?? null,
          c2ToolCallId: ctx.c2ToolCallId ?? null,
          pngPaths: {
            layoutB: ctx.pngLayoutB ?? null,
            layoutC: ctx.pngLayoutC ?? null,
            layoutD: ctx.pngLayoutD ?? null,
            accordionSwitch: ctx.pngAccordionSwitch ?? null,
            backToB: ctx.pngBackToB ?? null,
          },
          stderrRedirected: ctx.stderrRedirected === true,
          stderrLineCount: ctx.stderrLineCount ?? null,
          unexpectedStderrLines: ctx.unexpectedStderrLines ?? null,
          consoleErrorCount: ctx.cdp?.consoleErrors?.length ?? null,
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
    console.log(`[child-session-split-smoke] failed to write split-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.log(`\n[child-session-split-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`, 0)
      .catch((err) => console.log(`[child-session-split-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    c1ToolCallId: null,
    c2ToolCallId: null,
    childSessionIds: [],
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
    stderrRedirected: false,
  };
  installSignalTeardown(ctx);

  // MUST run before step1LaunchApp spawns the dev app — see this file's own
  // header doc for why fd 2 (not `ctx.child.stderr`, which is `null` for an
  // inherited stdio slot) is the only lever available.
  try {
    redirectAppStderr();
    ctx.stderrRedirected = true;
  } catch (err) {
    console.log(
      `[child-session-split-smoke] WARNING: could not redirect app stderr for capture (${err?.message ?? err}) — ` +
        "step 10 will FAIL on this honestly instead of silently skipping the gate",
    );
  }

  let failedStep = null;
  let stepsCompleted = 0;
  try {
    ctx.cdpPort = await reserveUnusedPort();
    process.env.REMOTE_DEBUGGING_PORT = String(ctx.cdpPort);

    await step1LaunchApp(ctx);
    // Creates (normal launch) or discovers (--attach) the boot tab AND
    // selects it — same call every precedent script in this directory makes
    // unmodified; no local reimplementation needed.
    await step1DiscoverTab(ctx);

    ctx.cdp = await cdpConnect(ctx.cdpPort);
    const baseline = await ctx.cdp.eval(SIDEBAR_ROW_TITLES_JS);
    ctx.baselineSidebarRowCount = Array.isArray(baseline) ? baseline.length : 0;

    await step1SpawnTwo(ctx);
    stepsCompleted += 1;
    await step2OpenChild1ToB(ctx);
    stepsCompleted += 1;
    await step3EnterSplit(ctx);
    stepsCompleted += 1;
    await step4OpenChild2Accordion(ctx);
    stepsCompleted += 1;
    await step5SwitchRow(ctx);
    stepsCompleted += 1;
    await step6Steering(ctx);
    stepsCompleted += 1;
    await captureC2FinalCount(ctx);
    await step8ExitSplitBackToMaster(ctx);
    stepsCompleted += 1;
    await step7LosslessCompare(ctx);
    stepsCompleted += 1;
    await step9BorderSanity(ctx);
    stepsCompleted += 1;
    await step10ConsoleGrep(ctx);
    stepsCompleted += 1;
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.log(`[child-session-split-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep, stepsCompleted);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.log(`[child-session-split-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

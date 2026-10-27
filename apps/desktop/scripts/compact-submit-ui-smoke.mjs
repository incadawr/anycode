/**
 * Live GUI smoke for GitHub #14 — submit-time slash-command interception.
 *
 * Drives a REAL Electron dev build through the isolated CDP launch pattern of
 * `first-run-ui-smoke.mjs` (`REMOTE_DEBUGGING_PORT` + `/json/list` +
 * `Runtime.evaluate`) and uses REAL composer DOM events only: a native
 * `HTMLTextAreaElement.value` setter + `input` event, a bubbling `keydown`
 * (`Enter`), a `.composer-send` click, a real file-input upload and a real
 * permission-modal click. No production automation route is added, and no
 * existing one is used to mutate state — the assertions read the DOM, exactly
 * like a user would.
 *
 * WHAT IT PROVES (the issue's two reported failure modes plus the plan's
 * product decisions):
 *  1. `/compact ` (trailing space, caret after the space) typed into the
 *     composer and submitted with Enter runs a REAL manual compaction
 *     (`Conversation compacted: X → Y tokens`) instead of a model-written
 *     pseudo-summary. No `/compact` user bubble appears.
 *  2. The same for `\n/compact\t` submitted with the Send button.
 *  3. A second bare `/compact` submitted while a compaction is running is
 *     VISIBLY refused with the exact busy copy, keeps the draft, and never
 *     queues/steers/sends anything.
 *  4. While a real tool turn (Bash `sleep`) is running, both Enter and the
 *     queue button (`aria-label="Queue message"`) refuse the same way, and
 *     the command is NOT replayed after the turn ends.
 *  5. Ordinary prose (`Please explain /compact`, `/compact explain`) still
 *     reaches the model as text, and a bare `/compact` with an attached image
 *     is refused with the attachment copy, retaining BOTH the draft and the
 *     image.
 *
 * Provider: a GLM/DeepSeek round trip is required for the compaction legs, so
 * the operator supplies the credential through the process environment:
 *
 *   ANYCODE_SMOKE_API_KEY    (falls back to ANYCODE_API_KEY)
 *   ANYCODE_SMOKE_BASE_URL   (falls back to ANYCODE_BASE_URL)
 *   ANYCODE_SMOKE_MODEL      (default "glm-5.2")
 *   ANYCODE_SMOKE_PROVIDER   (default "z-ai")
 *
 * Without them the script prints `SKIP` and exits 2 — it never claims a live
 * validation it did not run. The profile, workspace and connection are fresh
 * temp dirs seeded through `smoke-provider-profile.mjs`; no owner settings,
 * vault or credential file is read or copied.
 *
 * Native-engine parity is checked with deterministic Claude and Codex
 * protocol fixtures: the composer runs against real host and engine wiring,
 * and the fixtures record received frames without contacting a provider.
 *
 * Evidence (screenshots + `facts.json`) is written to the temp dir printed on
 * line 1 as `Evidence: <dir>` and is deliberately never deleted.
 *
 * Usage: node apps/desktop/scripts/compact-submit-ui-smoke.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { smokeProviderProfile } from "./smoke-provider-profile.mjs";
import { userMessageTexts, noSlashBubble, waitForApprovedTool } from "./compact-smoke-observations.mjs";
import { isolatedSmokeHome } from "./compact-smoke-home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

// ── exact product copy under test (must match slash-menu.ts / session.ts) ──
const BUSY_COMPACT_TEXT = "Cannot compact while this session is busy. Try again after this turn.";
const ATTACHMENT_REFUSAL_TEXT = "Remove attachments before running a slash command.";

const TURN_TIMEOUT_MS = 240_000;
const COMPACTION_TIMEOUT_MS = 300_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const TOTAL_STEPS = 9;

const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), "anycode-compact-submit-smoke-"));
mkdirSync(EVIDENCE_DIR, { recursive: true });
const facts = { evidenceDir: EVIDENCE_DIR, steps: {} };

// Tiny but REAL 1x1 PNG — `createImageBitmap` must accept it, so a byte stub
// would not do.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── step bookkeeping (profile-ui-smoke.mjs precedent) ──

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

function assertStep(step, cond, detail) {
  if (!cond) {
    fail(step, detail);
  }
}

// ── CDP helpers (first-run-ui-smoke.mjs pattern) ──

let ws;
const pending = new Map();
let nextId = 0;

function call(method, params) {
  const id = ++nextId;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30_000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

async function screenshot(name) {
  const png = await call("Page.captureScreenshot", { format: "png" });
  const file = join(EVIDENCE_DIR, name);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`           screenshot: ${file}`);
}

// ── page-side probes (all read the real DOM) ──

const COMPOSER_STATE_JS = `(() => {
  const ta = document.querySelector('.composer-textarea');
  const modal = document.querySelector('dialog.permission-modal');
  return {
    hasComposer: ta !== null,
    startScreen: document.querySelector('.start-screen') !== null,
    ready: ta !== null && !ta.disabled,
    draft: ta === null ? null : ta.value,
    caret: ta === null ? null : ta.selectionStart,
    running: document.querySelector('.composer-stop') !== null,
    sendLabel: document.querySelector('.composer-send')?.getAttribute('aria-label') ?? null,
    queueItems: [...document.querySelectorAll('.prompt-queue-item')].map((el) => el.querySelector('.prompt-queue-text')?.textContent ?? null),
    userMessages: (${userMessageTexts.toString()})(document),
    assistantCount: document.querySelectorAll('.message-assistant').length,
    errorCount: document.querySelectorAll('.message-error').length,
    compactions: [...document.querySelectorAll('[data-compaction-status]')].map((el) => ({
      status: el.getAttribute('data-compaction-status'),
      text: el.textContent ?? '',
    })),
    notices: [...document.querySelectorAll('.notice-toast-text')].map((el) => el.textContent ?? ''),
    imagePills: [...document.querySelectorAll('.composer-image-pill-name')].map((el) => el.textContent ?? ''),
    permissionOpen: modal !== null && modal.open === true,
    permissionTool: modal?.querySelector(".permission-modal-tool")?.textContent ?? "",
    permissionInput: modal?.querySelector(".permission-input-value")?.textContent ?? "",
  };
})()`;

/** Types through the native textarea setter + a real `input` event, caret last. */
function typeDraftJs(text) {
  return `(() => {
    const ta = document.querySelector('.composer-textarea');
    if (ta === null) return { ok: false, reason: 'no_textarea' };
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value, caret: ta.selectionStart };
  })()`;
}

/** A real bubbling Enter keydown; `dispatchEvent` returns false iff preventDefault ran. */
const PRESS_ENTER_JS = `(() => {
  const ta = document.querySelector('.composer-textarea');
  if (ta === null) return { ok: false, reason: 'no_textarea' };
  const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  const notPrevented = ta.dispatchEvent(event);
  return { ok: true, prevented: !notPrevented, draft: ta.value };
})()`;

function clickSendJs(label) {
  return `(() => {
    const button = [...document.querySelectorAll('.composer-send')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (button === undefined) return { ok: false, reason: 'no_button', label: ${JSON.stringify(label)} };
    if (button.disabled) return { ok: false, reason: 'disabled', label: ${JSON.stringify(label)} };
    button.click();
    return { ok: true };
  })()`;
}

const CLICK_ALLOW_JS = `(() => {
  const button = document.querySelector('.permission-allow-button');
  if (button === null) return { ok: false, reason: 'no_allow_button' };
  button.click();
  return { ok: true };
})()`;

function parseCompactionTokens(text) {
  const match = /compacted:\s*([\d,]+)\s*→\s*([\d,]+)\s*tokens/i.exec(text);
  if (match === null) {
    return null;
  }
  return { pre: Number(match[1].replaceAll(",", "")), post: Number(match[2].replaceAll(",", "")) };
}

// ── polling helpers ──

async function readState() {
  return evaluate(COMPOSER_STATE_JS);
}

async function pollState(step, predicate, label, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readState();
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      fail(step, `timed out after ${timeoutMs}ms waiting for ${label} (last state: ${JSON.stringify(last)})`);
    }
    await sleep(intervalMs);
  }
}

async function waitComposerReady(step, timeoutMs = 120_000) {
  return pollState(step, (s) => s.hasComposer && s.ready, "the composer to mount and go ready", timeoutMs);
}

/** One full human turn: type, Enter, wait for the reply to land and the turn to end. */
async function sendTurn(ctx, step, text) {
  const idle = await pollState(step, (s) => s.ready && !s.running, "an idle composer before typing a turn", 60_000);
  const typed = await evaluate(typeDraftJs(text));
  assertStep(step, typed.ok === true && typed.caret === text.length, `typing a prompt failed or the caret was wrong: ${JSON.stringify(typed)}`);
  const pressed = await evaluate(PRESS_ENTER_JS);
  assertStep(step, pressed.ok === true, `Enter dispatch failed: ${JSON.stringify(pressed)}`);
  const done = await pollState(
    step,
    (s) => !s.running && (s.assistantCount > idle.assistantCount || s.errorCount > idle.errorCount),
    `a completed turn for ${JSON.stringify(text.slice(0, 48))}`,
    TURN_TIMEOUT_MS,
    300,
  );
  assertStep(step, done.errorCount === idle.errorCount, `the turn failed instead of answering: ${JSON.stringify(done.userMessages.slice(-2))}`);
  return done;
}

// ── step 1: isolated launch + a compactable conversation ──

function resolveProvider() {
  const apiKey = process.env.ANYCODE_SMOKE_API_KEY ?? process.env.ANYCODE_API_KEY;
  const baseUrl = process.env.ANYCODE_SMOKE_BASE_URL ?? process.env.ANYCODE_BASE_URL;
  return {
    apiKey: typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey : null,
    baseUrl: typeof baseUrl === "string" && baseUrl.trim() !== "" ? baseUrl : null,
    model: process.env.ANYCODE_SMOKE_MODEL ?? "glm-5.2",
    providerId: process.env.ANYCODE_SMOKE_PROVIDER ?? "z-ai",
  };
}

function smokeLaunchEnv(ctx) {
  const { profile, settingsPath, workspace, importHome, cdpPort, provider } = ctx;
  const env = {
    ...isolatedSmokeHome(process.env, importHome),
    ANYCODE_AUTOMATION: "1",
    REMOTE_DEBUGGING_PORT: String(cdpPort),
    ANYCODE_USER_DATA_DIR: join(profile, "user-data"),
    ANYCODE_DB_PATH: join(profile, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
    ANYCODE_SETTINGS_PATH: settingsPath,
    ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
    ANYCODE_WORKSPACE: workspace,
    // Dev-only import-home override used by the sibling smokes: the skills scan
    // must not read the owner's real ~/.anycode/skills.
    ANYCODE_SKILLS_IMPORT_HOME: importHome,
    ANYCODE_CODEX_BIN: join(here, "compact-fixtures", "codex.mjs"),
    ANYCODE_CLAUDE_BIN: join(here, "compact-fixtures", "claude.mjs"),
    CODEX_HOME: join(profile, "codex-home"),
    CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
    ANYCODE_API_KEY: provider.apiKey,
    ANYCODE_BASE_URL: provider.baseUrl,
  };
  // Anti-false-green: an env model override would mask the settings.json seed.
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;
  return env;
}

async function launch(ctx) {
  const provider = resolveProvider();
  if (provider.apiKey === null || provider.baseUrl === null) {
    console.log(
      "SKIP: no live provider credential in the environment. Set ANYCODE_SMOKE_API_KEY and " +
        "ANYCODE_SMOKE_BASE_URL (or ANYCODE_API_KEY / ANYCODE_BASE_URL) and run again — this smoke " +
        "needs a real GLM/DeepSeek round trip for the compaction legs and will not pretend otherwise.",
    );
    process.exit(2);
  }
  ctx.provider = provider;

  ctx.workspace = join(EVIDENCE_DIR, "workspace");
  mkdirSync(ctx.workspace);
  writeFileSync(join(ctx.workspace, "seed.txt"), "disposable workspace for the GitHub #14 smoke\n");
  ctx.importHome = join(EVIDENCE_DIR, "home");
  mkdirSync(ctx.importHome);

  const profile = join(EVIDENCE_DIR, "profile");
  mkdirSync(profile);
  ctx.profile = profile;
  const settingsPath = join(profile, "settings.json");
  ctx.settingsPath = settingsPath;

  // v2 seed, exactly the shape smokeProviderProfile documents: an env-backed
  // credential (`credentialFromEnv`), no persisted key, no owner copy.
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        version: 2,
        provider: smokeProviderProfile(provider.providerId, provider.model, { credentialFromEnv: true }),
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      null,
      2,
    ),
  );

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  ctx.cdpPort = port;

  const env = smokeLaunchEnv(ctx);

  ctx.child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });

  const target = await pollTarget(port);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    ws.onopen = resolvePromise;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    const item = pending.get(response.id);
    if (!item) {
      return;
    }
    pending.delete(response.id);
    clearTimeout(item.timer);
    if (response.error) {
      item.reject(new Error(JSON.stringify(response.error)));
    } else {
      item.resolve(response.result);
    }
  };
}

async function pollTarget(port) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
      if (page !== undefined) {
        return page;
      }
    } catch {
      // dev build not up yet
    }
    if (Date.now() >= deadline) {
      throw new SmokeFailure(1, `CDP target never appeared on 127.0.0.1:${port} within ${LAUNCH_TIMEOUT_MS}ms`);
    }
    await sleep(400);
  }
}

const BRIEF_LINES = Array.from(
  { length: 80 },
  (_, i) => `Line ${i + 1}: this is a synthetic disposable note for the GitHub #14 compaction smoke.`,
);

async function step1(ctx) {
  await launch(ctx);
  await waitComposerReady(1);
  // Seven human turns with a substantial opening context (the compactor keeps
  // the last 10 messages, so the prefix must exist before the keep-recent
  // window — 7 turns = 14 messages).
  await sendTurn(ctx, 1, `Read this synthetic brief and reply with exactly: noted.\n\n${BRIEF_LINES.join("\n")}`);
  for (let i = 2; i <= 7; i += 1) {
    await sendTurn(ctx, 1, `Reply with exactly: ack ${i}.`);
  }

  const state = await waitComposerReady(1);
  assertStep(1, state.userMessages.length >= 7, `expected at least 7 user turns, got ${state.userMessages.length}`);
  await screenshot("01-seven-turns-idle.png");
  facts.steps.step1 = { userTurns: state.userMessages.length, compactions: state.compactions.length };
  pass(1, `isolated core tab ready, ${state.userMessages.length} human turns, no compaction yet`);
}

// ── step 2: `/compact ` + Enter is a real compaction (the reported bug) ──

async function step2(ctx) {
  const before = await pollState(2, (s) => s.ready && !s.running, "an idle composer before the trailing-space compact", 60_000);
  assertStep(2, before.compactions.length === 0, `expected no compaction before this step, got ${JSON.stringify(before.compactions)}`);

  const typed = await evaluate(typeDraftJs("/compact "));
  assertStep(2, typed.ok === true && typed.caret === 9, `typing "/compact " failed or the caret was not after the space: ${JSON.stringify(typed)}`);

  // The slash menu must be CLOSED here — that is precisely why the old code
  // sent the text. Recorded as evidence, not asserted as product behavior
  // beyond the menu's own caret semantics.
  const menuOpen = await evaluate("(() => document.querySelector('#slash-menu-list') !== null)()");
  facts.steps.step2 = { menuOpen };

  const pressed = await evaluate(PRESS_ENTER_JS);
  assertStep(2, pressed.ok === true && pressed.prevented === true, `Enter on a bare command must be intercepted, got ${JSON.stringify(pressed)}`);

  const during = await pollState(2, (s) => s.compactions.some((c) => c.status === "running"), "the manual compaction to start", 30_000);
  assertStep(2, during.draft === "", `the command must clear the draft, got ${JSON.stringify(during.draft)}`);
  assertStep(2, during.queueItems.length === 0, `a command must never be queued: ${JSON.stringify(during.queueItems)}`);

  const ended = await pollState(2, (s) => s.compactions.every((c) => c.status !== "running"), "the manual compaction to end", COMPACTION_TIMEOUT_MS, 400);
  assertStep(2, ended.compactions.length === 1, `expected exactly ONE compaction card, got ${JSON.stringify(ended.compactions)}`);
  const card = ended.compactions[0];
  assertStep(2, card.status === "done", `the compaction did not complete: ${JSON.stringify(card)}`);
  const tokens = parseCompactionTokens(card.text);
  assertStep(2, tokens !== null, `the compaction card did not report token readings: ${JSON.stringify(card.text)}`);
  assertStep(2, tokens.post < tokens.pre, `compaction must shrink the context: ${JSON.stringify(tokens)}`);
  assertStep(2, ended.assistantCount === before.assistantCount, "the model answered the command instead of compacting (pseudo-summary)");
  assertStep(2, noSlashBubble(ended), `a /compact user bubble leaked into the transcript: ${JSON.stringify(ended.userMessages.slice(-3))}`);

  await screenshot("02-trailing-space-compacted.png");
  facts.steps.step2 = { ...facts.steps.step2, tokens, notice: ended.notices };
  pass(2, `"/compact " + Enter ran a real manual compaction (${tokens.pre} → ${tokens.post} tokens), no bubble, no model reply`);
}

// ── step 3: rebuild the prefix, then `\n/compact\t` via the Send button ──

async function step3(ctx) {
  // After a compaction the keep-recent window (10 messages) is all that's left,
  // so a new compactable prefix needs ~6 more turns.
  for (let i = 1; i <= 6; i += 1) {
    await sendTurn(ctx, 3, `Reply with exactly: again ${i}.`);
  }
  const before = await pollState(3, (s) => s.ready && !s.running, "an idle composer before the whitespace compact", 60_000);
  assertStep(3, before.compactions.length === 1, `expected the step-2 card to be the only compaction, got ${JSON.stringify(before.compactions)}`);

  const typed = await evaluate(typeDraftJs("\n/compact\t"));
  assertStep(3, typed.ok === true && typed.caret === 10, `typing "\\n/compact\\t" failed: ${JSON.stringify(typed)}`);
  const clicked = await evaluate(clickSendJs("Send"));
  assertStep(3, clicked.ok === true, `the Send button was not clickable: ${JSON.stringify(clicked)}`);

  const during = await pollState(3, (s) => s.compactions.filter((c) => c.status === "running").length === 1, "the whitespace-triggered compaction to start", 30_000);
  assertStep(3, during.draft === "", `the Send path must clear the draft, got ${JSON.stringify(during.draft)}`);
  pass(3, "surrounding whitespace and Send started a manual compaction");
  return during;
}

// ── step 4: a second bare command while a compaction runs is refused ──

async function step4(ctx, runningState) {
  const before = runningState ?? (await readState());
  assertStep(4, before.running === true, "expected the session to be busy (a compaction in flight) for this step");

  const typed = await evaluate(typeDraftJs("/compact"));
  assertStep(4, typed.ok === true, `typing "/compact" while compacting failed: ${JSON.stringify(typed)}`);
  const pressed = await evaluate(PRESS_ENTER_JS);
  assertStep(4, pressed.ok === true && pressed.prevented === true, `Enter while busy must be intercepted: ${JSON.stringify(pressed)}`);

  const refused = await readState();
  assertStep(
    4,
    refused.notices.includes(BUSY_COMPACT_TEXT),
    `expected the visible busy refusal ${JSON.stringify(BUSY_COMPACT_TEXT)}, got ${JSON.stringify(refused.notices)}`,
  );
  assertStep(4, refused.draft === "/compact", `the refusal must retain the draft, got ${JSON.stringify(refused.draft)}`);
  assertStep(4, refused.queueItems.length === 0, `a refused command must not be queued: ${JSON.stringify(refused.queueItems)}`);
  assertStep(4, refused.assistantCount === before.assistantCount, "the model replied to a refused command");
  assertStep(4, noSlashBubble(refused), "a /compact user bubble leaked into the transcript");

  await screenshot("04-refused-while-compacting.png");

  const ended = await pollState(4, (s) => s.compactions.every((c) => c.status !== "running"), "the in-flight compaction to end", COMPACTION_TIMEOUT_MS, 400);
  assertStep(4, ended.compactions.length === 2, `the refused command must not add a compaction card, got ${JSON.stringify(ended.compactions)}`);
  const card = ended.compactions[1];
  assertStep(4, card.status === "done", `the whitespace/ Send compaction did not complete: ${JSON.stringify(card)}`);
  const tokens = parseCompactionTokens(card.text);
  assertStep(4, tokens !== null && tokens.post < tokens.pre, `the second compaction must shrink the context: ${JSON.stringify(card.text)}`);

  facts.steps.step4 = { busyRefusal: BUSY_COMPACT_TEXT, tokens };
  pass(4, `second "/compact" while compacting refused visibly, draft kept, exactly one extra compaction (${tokens.pre} → ${tokens.post})`);
}

// ── step 5: a real busy tool turn refuses Enter AND the queue button ──

async function step5(ctx) {
  const before = await pollState(5, (s) => s.ready && !s.running, "an idle composer before the tool turn", 60_000);

  await evaluate(typeDraftJs("Use the Bash tool exactly once to run this command: touch compact-smoke-started; sleep 25. Do not do anything else."));
  const pressed = await evaluate(PRESS_ENTER_JS);
  assertStep(5, pressed.ok === true, `Enter to start the tool turn failed: ${JSON.stringify(pressed)}`);

  // Approval alone does not prove execution: the command creates a marker
  // before sleeping, and we observe that marker while the turn is still busy.
  const busy = await waitForApprovedTool({
    readState,
    approve: () => evaluate(CLICK_ALLOW_JS),
    markerExists: () => existsSync(join(ctx.workspace, "compact-smoke-started")),
    sleep,
    now: Date.now,
    timeoutMs: 60_000,
  });

  const userCountWhileBusy = busy.userMessages.length;
  const assistantWhileBusy = busy.assistantCount;
  const compactionCountWhileBusy = busy.compactions.length;

  // (a) Enter
  await evaluate(typeDraftJs("/compact "));
  const enterRefused = await evaluate(PRESS_ENTER_JS);
  assertStep(5, enterRefused.ok === true && enterRefused.prevented === true, `Enter on a bare command while busy must be intercepted: ${JSON.stringify(enterRefused)}`);
  let state = await readState();
  assertStep(5, state.notices.includes(BUSY_COMPACT_TEXT), `expected the busy refusal after Enter, got ${JSON.stringify(state.notices)}`);
  assertStep(5, state.draft === "/compact ", `the refusal must retain the draft, got ${JSON.stringify(state.draft)}`);
  assertStep(5, state.queueItems.length === 0, `the refused command was queued: ${JSON.stringify(state.queueItems)}`);
  assertStep(5, state.userMessages.length === userCountWhileBusy, "the refused command became a user message");
  assertStep(5, state.assistantCount === assistantWhileBusy, "the model replied to the refused command");

  // (b) the busy-mode Send button ("Queue message") — same handleSend closure.
  await evaluate(typeDraftJs("/compact"));
  const queued = await evaluate(clickSendJs("Queue message"));
  assertStep(5, queued.ok === true, `the queue button was not clickable: ${JSON.stringify(queued)}`);
  state = await readState();
  assertStep(5, state.notices.includes(BUSY_COMPACT_TEXT), `expected the busy refusal after the queue button, got ${JSON.stringify(state.notices)}`);
  assertStep(5, state.queueItems.length === 0, `the queue button queued a command: ${JSON.stringify(state.queueItems)}`);
  assertStep(5, state.userMessages.length === userCountWhileBusy, "the queue-button submission became a user message");

  await screenshot("05-refused-during-tool-turn.png");

  // Let the turn finish, then prove nothing was deferred.
  await pollState(5, (s) => !s.running, "the tool turn to finish", TURN_TIMEOUT_MS, 400);
  await sleep(2500);
  const after = await readState();
  assertStep(5, after.compactions.length === compactionCountWhileBusy, `a compaction ran after the busy turn: ${JSON.stringify(after.compactions)}`);
  assertStep(5, after.queueItems.length === 0, `a queued command survived the turn: ${JSON.stringify(after.queueItems)}`);

  facts.steps.step5 = { busyRefusal: BUSY_COMPACT_TEXT, queueItems: after.queueItems.length, compactions: after.compactions.length };
  pass(5, "busy tool turn: Enter and Queue-message both refused visibly, nothing queued, steered, sent or replayed");
}

// ── step 6: prose still works; attachments are refused without data loss ──

async function uploadPng(filePath) {
  const remote = await call("Runtime.evaluate", {
    expression: "document.querySelector('.composer-file-input')",
  });
  if (remote.result.subtype === "null" || remote.result.objectId === undefined) {
    return { ok: false, reason: "no_file_input" };
  }
  const node = await call("DOM.requestNode", { objectId: remote.result.objectId });
  await call("DOM.setFileInputFiles", { files: [filePath], nodeId: node.nodeId });
  return { ok: true };
}

async function step6(ctx) {
  // Toasts live 5s; take a baseline so step 5's refusal cannot leak into these
  // assertions.
  const entry = await pollState(6, (s) => s.ready && !s.running, "an idle composer before the prose leg", 60_000);
  assertStep(6, entry.notices.includes(BUSY_COMPACT_TEXT) === false, "stale busy notice still on screen before the prose leg");

  // Prose is never intercepted.
  const prose = "Please explain /compact";
  const afterProse = await sendTurn(ctx, 6, prose);
  assertStep(6, afterProse.notices.includes(BUSY_COMPACT_TEXT) === false, "prose containing /compact was refused as a command");
  assertStep(6, afterProse.userMessages.some((text) => text.includes("Please explain /compact")), "the prose prompt never reached the transcript");

  const slashProse = await sendTurn(ctx, 6, "/compact explain");
  assertStep(6, slashProse.notices.includes(BUSY_COMPACT_TEXT) === false, `"/compact explain" was refused instead of sent: ${JSON.stringify(slashProse.notices)}`);

  // Attachments: a real 1x1 PNG through the real file input.
  const before = await pollState(6, (s) => s.ready && !s.running, "an idle composer before the attachment leg", 60_000);
  const pngPath = join(EVIDENCE_DIR, "attachment-1x1.png");
  writeFileSync(pngPath, ONE_PIXEL_PNG);
  const uploaded = await uploadPng(pngPath);
  assertStep(6, uploaded.ok === true, `the image upload failed: ${JSON.stringify(uploaded)}`);
  await evaluate("(() => { const input = document.querySelector('.composer-file-input'); input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  const attached = await pollState(6, (s) => s.imagePills.length === 1, "the image pill to appear", 10_000);
  assertStep(6, attached.imagePills.length === 1, `expected one attached image, got ${JSON.stringify(attached.imagePills)}`);

  await evaluate(typeDraftJs("/compact"));
  const pressed = await evaluate(PRESS_ENTER_JS);
  assertStep(6, pressed.ok === true && pressed.prevented === true, `Enter with an attachment must be intercepted: ${JSON.stringify(pressed)}`);
  const refused = await readState();
  assertStep(6, refused.notices.includes(ATTACHMENT_REFUSAL_TEXT), `expected ${JSON.stringify(ATTACHMENT_REFUSAL_TEXT)}, got ${JSON.stringify(refused.notices)}`);
  assertStep(6, refused.draft === "/compact", `the attachment refusal must retain the draft, got ${JSON.stringify(refused.draft)}`);
  assertStep(6, refused.imagePills.length === 1, `the attachment refusal dropped the image: ${JSON.stringify(refused.imagePills)}`);
  assertStep(6, refused.userMessages.length === before.userMessages.length, "the refused command became a user message");
  assertStep(6, refused.queueItems.length === 0, "the refused command was queued");

  await screenshot("06-attachment-refused.png");
  facts.steps.step6 = { prose: true, slashProse: true, attachmentRefusal: ATTACHMENT_REFUSAL_TEXT, imagesKept: refused.imagePills.length };
  pass(6, "prose prompts still send; a bare /compact with an image is refused while draft AND image survive");
}

// Create a native tab through the same project menu and start screen as a user.
async function startFixtureTab(step, engine) {
  const clicked = await evaluate(`(() => {
    const b = document.querySelector('.sidebar-group-menu-button');
    if (!b) return false; b.click(); return true;
  })()`);
  assertStep(step, clicked, "project menu button missing");
  assertStep(step, await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar-project-menu-item')].find(x => x.textContent.trim() === 'New task in this project');
    if (!b) return false; b.click(); return true;
  })()`), "new task menu item missing");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await evaluate(`(() => [...document.querySelectorAll('.start-engine-choice')].some(b => b.textContent.trim() === ${JSON.stringify(engine)}))()`))) await sleep(200);
  assertStep(step, await evaluate(`(() => {
    const b = [...document.querySelectorAll('.start-engine-choice')].find(x => x.textContent.trim() === ${JSON.stringify(engine)});
    if (!b) return false; b.click(); return true;
  })()`), `${engine} fixture is not ready`);
  await evaluate(typeDraftJs("fixture ready"));
  const sent = await evaluate(clickSendJs("Send"));
  assertStep(step, sent.ok, `could not create ${engine} tab: ${JSON.stringify(sent)}`);
  await pollState(step, (s) => s.ready && !s.startScreen, `${engine} composer`, 120_000);
}

function fixtureFrames(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function step7(ctx) {
  await startFixtureTab(7, "Claude");
  await pollState(7, (s) => s.ready && !s.running && s.assistantCount > 0, "Claude fixture's first turn", 60_000);
  const file = join(ctx.importHome, "claude-frames.jsonl");
  const before = fixtureFrames(file).length;
  await evaluate(typeDraftJs("/compact "));
  await evaluate(PRESS_ENTER_JS);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && fixtureFrames(file).length === before) await sleep(100);
  let frames = fixtureFrames(file);
  assertStep(7, frames.length === before + 1 && frames.at(-1)?.message?.content === "/compact", "Claude did not receive exactly one allowlisted compact frame");
  await pollState(7, (s) => s.ready && !s.running && s.compactions.some(c => c.status === "done"), "Claude fixture compaction", 60_000);
  await sleep(250);
  await evaluate(typeDraftJs("fixture: hold"));
  await evaluate(PRESS_ENTER_JS);
  const busy = await pollState(7, (s) => s.running, "Claude fixture's held turn", 30_000);
  const heldDeadline = Date.now() + 30_000;
  while (Date.now() < heldDeadline && fixtureFrames(file).length < before + 2) await sleep(100);
  const heldFrames = fixtureFrames(file).length;
  assertStep(7, heldFrames === before + 2, "Claude held turn did not reach fixture");
  await evaluate(typeDraftJs("/compact "));
  await evaluate(PRESS_ENTER_JS);
  const refused = await readState();
  assertStep(7, refused.notices.includes(BUSY_COMPACT_TEXT) && refused.draft === "/compact ", "Claude busy compact was not visibly refused with draft retained");
  assertStep(7, fixtureFrames(file).length === heldFrames && refused.queueItems.length === 0 && refused.userMessages.length === busy.userMessages.length, "Claude busy compact reached the fixture, transcript or queue");
  await screenshot("07-claude-busy-refusal.png");
  writeFileSync(join(ctx.importHome, "release-claude"), "release");
  await pollState(7, (s) => !s.running, "Claude held turn completion", 60_000);
  await sleep(500);
  frames = fixtureFrames(file);
  assertStep(7, frames.length === heldFrames, "Claude compact ran after the held turn");
  facts.steps.step7 = { compactFrames: 1, busyExtraFrames: frames.length - heldFrames };
  pass(7, "Claude fixture: one compact frame when idle; busy command refused and never replayed");
}

async function step8(ctx) {
  await startFixtureTab(8, "Codex");
  const busy = await pollState(8, (s) => s.running, "Codex fixture's held initial turn", 60_000);
  const file = join(ctx.importHome, "codex-turns.jsonl");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && fixtureFrames(file).length === 0) await sleep(100);
  const count = fixtureFrames(file).length;
  assertStep(8, count === 1, "Codex initial turn did not reach fixture");
  await evaluate(typeDraftJs("/compact "));
  await evaluate(PRESS_ENTER_JS);
  const refused = await readState();
  assertStep(8, refused.notices.includes("Manual compaction is not available in this session.") && refused.draft === "/compact ", "Codex unsupported compact was not visibly refused with draft retained");
  assertStep(8, fixtureFrames(file).length === count && refused.userMessages.length === busy.userMessages.length && refused.queueItems.length === 0, "Codex compact leaked into a turn or queue");
  await screenshot("08-codex-unsupported.png");
  facts.steps.step8 = { initialTurns: count, extraTurns: fixtureFrames(file).length - count };
  pass(8, "Codex fixture: unsupported compact refused without a new turn or queue item");
}

// ── step 9: the evidence dir is complete ──

function step9() {
  const expected = [
    "01-seven-turns-idle.png",
    "02-trailing-space-compacted.png",
    "04-refused-while-compacting.png",
    "05-refused-during-tool-turn.png",
    "06-attachment-refused.png",
    "07-claude-busy-refusal.png",
    "08-codex-unsupported.png",
  ];
  for (const name of expected) {
    const file = join(EVIDENCE_DIR, name);
    assertStep(9, existsSync(file), `expected screenshot ${file} to exist`);
    assertStep(9, readFileSync(file).length > 0, `expected screenshot ${file} to be non-empty`);
  }
  writeFileSync(join(EVIDENCE_DIR, "facts.json"), JSON.stringify(facts, null, 2));
  pass(9, `evidence complete in ${EVIDENCE_DIR}`);
}

// ── teardown (first-run-ui-smoke.mjs pattern; evidence is never deleted) ──

async function teardown(ctx) {
  if (ws?.readyState === WebSocket.OPEN) {
    await call("Browser.close", {}).catch(() => {});
  }
  ws?.close();
  await sleep(500);
  if (ctx.child !== null) {
    try {
      if (process.platform === "win32") {
        ctx.child.kill("SIGTERM");
      } else {
        process.kill(-ctx.child.pid, "SIGTERM");
      }
    } catch {
      // already gone
    }
  }
}

async function run() {
  const ctx = {
    workspace: null,
    importHome: null,
    profile: null,
    settingsPath: null,
    cdpPort: null,
    child: null,
    provider: null,
  };
  let failedStep = null;
  console.log(`Evidence: ${EVIDENCE_DIR}`);
  try {
    await step1(ctx);
    await step2(ctx);
    const runningState = await step3(ctx);
    await step4(ctx, runningState);
    await step5(ctx);
    await step6(ctx);
    await step7(ctx);
    await step8(ctx);
    step9();
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[compact-submit-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }
  await teardown(ctx);
  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[compact-submit-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
  console.log(`Evidence: ${EVIDENCE_DIR}`);
  process.exit(failedStep === null ? 0 : 1);
}

if (process.argv.includes("--check-isolation")) {
  const home = join(EVIDENCE_DIR, "check-home");
  mkdirSync(home);
  const env = smokeLaunchEnv({ importHome: home, profile: EVIDENCE_DIR, settingsPath: join(EVIDENCE_DIR, "settings.json"), workspace: EVIDENCE_DIR, cdpPort: 1, provider: { apiKey: "fixture", baseUrl: "https://example.invalid" } });
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env, encoding: "utf8" });
  const keys = ["ANYCODE_PROFILE_HOME", "ANYCODE_MCP_IMPORT_HOME", "ANYCODE_SKILLS_IMPORT_HOME", "ANYCODE_SUBAGENTS_HOME", "ANYCODE_CODEX_PROFILES_HOME"];
  if (child.status !== 0 || child.stdout !== home || keys.some((key) => env[key] !== home) || env.ANYCODE_COMMUNICATION_CONFIG !== undefined) process.exit(1);
  console.log("isolation verified");
  process.exit(0);
}

run().catch((err) => {
  console.error(`[compact-submit-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

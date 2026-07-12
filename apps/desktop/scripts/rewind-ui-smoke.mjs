/**
 * Live GUI smoke for P7.26/R2 W3 (design/slice-P7.26-R2-ratification.md §1):
 * drives a REAL Electron dev instance end-to-end over the automation HTTP
 * channel (`main/automation/*`, see `automation/README.md`'s "Checkpoint
 * timeline / rewind probe+driver" routes) and proves the whole checkpoint ->
 * timeline -> rewind -> transcript-truncation -> rewind-then-continue arc
 * against a REAL shadow-git checkpoint store (no fakes) — a green unit gate
 * alone is not sufficient proof here (same posture as every other
 * `*-ui-smoke.mjs` in this directory).
 *
 * Two real model turns each force a Write, so a checkpoint is auto-captured
 * BEFORE each turn's own write-effect tool call runs (`dispatcher.ts`'s
 * auto-checkpoint arc): the checkpoint captured during turn N stores the
 * history/file state from immediately BEFORE turn N started, labeled from
 * turn N's own prompt. So the NEWEST checkpoint in the newest-first list —
 * captured just before the SECOND write — is the one whose historySnapshot
 * is "everything up through turn 1, nothing from turn 2"; rewinding to it is
 * exactly "undo turn 2" (§4 below rewinds via `index:0`, not `index:1` — see
 * that step's comment for the full reasoning).
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted from
 * `subagents-ui-smoke.mjs` (same disposable-profile discipline). A NEW
 * sibling, not an edit of any existing smoke. Plain node >=22, ZERO npm deps
 * (only node:child_process/fs/os/path/url + the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/rewind-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance -- read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch (the live GLM
 *                   credentials must already be configured on that instance).
 *   --keep         Do not delete the temp workspace / automation profile dirs
 *                   on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider. Resolution
 * order: `$SMOKE_SECRETS_PATH` env override first, else `.smoke-secrets/glm.env`
 * at the repo root (KEY=VALUE lines: ANYCODE_API_KEY / ANYCODE_BASE_URL /
 * ANYCODE_MODEL) — the env override lets this run from a worktree that has no
 * secrets file of its own.
 *
 * Every step is HARD -- no documented SKIP path (unlike `subagents-ui-smoke.mjs`'s
 * step 5): the two Write-triggering prompts are single, maximally explicit
 * instructions with no retry, same discipline as the R2 smoke plan. Each of
 * the 5 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL tears down
 * and exits 1. PNG evidence (steps 2/4/5, settled 600ms before capture --
 * `GET /screenshot` lags live DOM by 1-2 frames, so probe asserts stay
 * authoritative and the PNG is best-effort evidence only) is written to
 * `$CLAUDE_JOB_DIR/tmp/rewind-smoke/*.png` if that env var is set, else
 * `<os.tmpdir()>/rewind-smoke/*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const SMOKE_SECRETS_PATH = process.env.SMOKE_SECRETS_PATH ?? join(repoRoot, ".smoke-secrets", "glm.env");
const TOTAL_STEPS = 5;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

const PROVIDER_ID = "z-ai";
const MODEL_ID = "glm-5.2"; // reasoning-capable, same model subagents-ui-smoke/subagent-card-smoke seed -- a real Write dispatch needs a model that reliably follows an explicit single-tool instruction.

const FILE_A = "checkpoint-a.txt";
const FILE_B = "checkpoint-b.txt";
const FILE_C = "checkpoint-c.txt";
const CONTENT_A = "checkpoint-a-content\n";
const CONTENT_B = "checkpoint-b-content\n";
const CONTENT_C = "checkpoint-c-content\n";

const PROMPT_A = `Use the Write tool right now to create a file named "${FILE_A}" with the exact content: ${CONTENT_A.trim()}. You must call the Write tool for this and do nothing else.`;
const PROMPT_B = `Use the Write tool right now to create a file named "${FILE_B}" with the exact content: ${CONTENT_B.trim()}. You must call the Write tool for this and do nothing else.`;
const PROMPT_C = `Use the Write tool right now to create a file named "${FILE_C}" with the exact content: ${CONTENT_C.trim()}. You must call the Write tool for this and do nothing else.`;

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
      console.warn(`[rewind-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from subagents-ui-smoke.mjs) ──

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
    // already gone -- nothing to do.
  }
}

/**
 * Minimal KEY=VALUE .env parser (no quoting/escaping support -- the smoke
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

/**
 * Independent re-implementation of core's `deriveCheckpointLabel`
 * (packages/core/src/checkpoints/shadow-git.ts) -- first line of the raw
 * turn prompt, C0-control-stripped, trimmed, capped at 64 chars. Deliberately
 * NOT imported (track precedent: this smoke verifies the real running app
 * independently, the same way the renderer probes above reimplement their
 * own shape checks rather than importing product helpers).
 */
const CHECKPOINT_LABEL_MAX_CHARS = 64;
function deriveCheckpointLabel(userInput) {
  const firstLine = userInput.split("\n", 1)[0] ?? "";
  let cleaned = "";
  for (const ch of firstLine) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += ch;
  }
  return cleaned.trim().slice(0, CHECKPOINT_LABEL_MAX_CHARS);
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

/** `api()` + hard-fail on transport error or non-200 (the request never even reached the facade). */
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

/** A POST action expected to succeed at the facade level too (`{ok:true, ...}`). */
async function apiAction(ctx, step, path, body) {
  const result = await apiOk(ctx, step, "POST", path, body);
  if (result?.ok !== true) {
    fail(step, `POST ${path} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

/** `POST /wait` for the tab + hard-fail if the condition never matched within the timeout. */
async function waitUntilTab(ctx, step, until, timeoutMs) {
  const body = { tabId: ctx.tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} for tab ${ctx.tabId} did not match: ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Poll `GET /state` until the renderer facade has finished installing (DEV
 * dynamic import races the page load) -- same readiness signal as every
 * other `*-ui-smoke.mjs` in this directory.
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

/** `GET /tabs/:tabId/checkpoints` -- opens/refreshes the timeline panel and returns its rows (README.md). */
async function getCheckpoints(ctx, step) {
  return apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/checkpoints`);
}

/** `GET /tabs/:tabId/rewind` -- read-only `lastResult`/`transcriptBlockCount` (no drive). */
async function getRewindState(ctx, step) {
  return apiOk(ctx, step, "GET", `/tabs/${ctx.tabId}/rewind`);
}

/** Sends a prompt and waits for the resulting turn to go idle again. */
async function sendPromptAndWaitIdle(ctx, step, text, timeoutMs) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, { turnStatus: "running" }, 60_000);
  await waitUntilTab(ctx, step, { turnStatus: "idle" }, timeoutMs);
}

/** Best-effort PNG evidence via `GET /screenshot` -- never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[rewind-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[rewind-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

/** Settle (durable lesson: `GET /screenshot` lags live DOM by 1-2 frames) then capture. */
async function settledScreenshot(ctx, name) {
  await sleep(600);
  await saveScreenshot(ctx, name);
}

// ── step 1: bootstrap fixtures, launch the dev app, create + select a tab, first Write ──

function step1BootstrapFixtures(ctx) {
  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-rewind-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "README.md"), "# rewind smoke fixture workspace\n");

  let secretsEnv = {};
  try {
    secretsEnv = parseEnvFile(readFileSync(SMOKE_SECRETS_PATH, "utf8"));
  } catch (err) {
    fail(1, `could not read GLM smoke credentials at ${SMOKE_SECRETS_PATH}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_API_KEY`);
  assert(1, typeof secretsEnv.ANYCODE_BASE_URL === "string" && secretsEnv.ANYCODE_BASE_URL.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_BASE_URL`);
  ctx.secretsEnv = secretsEnv;

  pass(1, `workspace fixture seeded at ${ctx.workspace} (1 seed file)`);
}

async function step1LaunchAndFirstWrite(ctx) {
  const step = 1;

  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(step, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(step, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
  } else {
    const profile = mkdtempSync(join(tmpdir(), "anycode-rewind-smoke-profile-"));
    ctx.profile = profile;
    ctx.profileUserDataDir = join(profile, "user-data");
    ctx.profileDbPath = join(profile, "db.sqlite");
    ctx.profileAutomationInfo = join(profile, "automation.json");
    ctx.settingsPath = join(profile, "settings.json");
    ctx.secretsPath = join(profile, "secrets.json");

    const seedSettings = {
      version: 1,
      provider: { id: PROVIDER_ID, model: MODEL_ID },
      tools: {},
      permissions: { alwaysAllow: [{ toolName: "Write" }, { toolName: "Read" }] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    writeFileSync(ctx.settingsPath, JSON.stringify(seedSettings, null, 2));

    const t0 = Date.now();
    const env = {
      ...process.env,
      ...ctx.secretsEnv,
      ANYCODE_AUTOMATION: "1",
      ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
      ANYCODE_DB_PATH: ctx.profileDbPath,
      ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
      ANYCODE_SETTINGS_PATH: ctx.settingsPath,
      ANYCODE_SECRETS_PATH: ctx.secretsPath,
    };
    delete env.ANYCODE_WORKSPACE; // this smoke creates its own tab explicitly (below)
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
        fail(step, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
      }
      const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
      if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
        info = candidate;
        break;
      }
      await sleep(500);
    }
    if (info === null) {
      fail(step, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
  }

  await waitForFacade(ctx, step);

  const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(step, created.ok === true, `POST /tabs rejected: ${JSON.stringify(created)}`);
  ctx.tabId = created.tabId;
  await waitUntilTab(ctx, step, { connection: "ready" }, 60_000);
  await apiAction(ctx, step, `/tabs/${ctx.tabId}/select`, {});

  await sendPromptAndWaitIdle(ctx, step, PROMPT_A, 90_000);

  const filePathA = join(ctx.workspace, FILE_A);
  assert(step, existsSync(filePathA), `expected ${filePathA} to exist on disk after turn 1`);
  // Trim both sides: the prompt asks for CONTENT_A.trim(), and real models are
  // non-deterministic about a trailing newline -- the requested text is what matters.
  assert(step, readFileSync(filePathA, "utf8").trim() === CONTENT_A.trim(), `expected ${filePathA} to carry the exact content, got:\n${readFileSync(filePathA, "utf8")}`);

  pass(step, `app launched, tab ${ctx.tabId} ready for ${ctx.workspace}, turn 1 wrote ${FILE_A}`);
}

// ── step 2: baseline checkpoint-1 + transcript-block count C1 ──

async function step2CaptureBaseline(ctx) {
  const step = 2;

  const checkpoints = await getCheckpoints(ctx, step);
  assert(step, checkpoints.ok === true, `GET checkpoints rejected: ${JSON.stringify(checkpoints)}`);
  assert(step, checkpoints.items.length >= 1, `expected at least 1 checkpoint after turn 1, got ${JSON.stringify(checkpoints.items)}`);

  const expectedLabel = deriveCheckpointLabel(PROMPT_A);
  const checkpoint1 = checkpoints.items.find((it) => it.label === expectedLabel);
  assert(
    step,
    checkpoint1 !== undefined,
    `expected a checkpoint labeled "${expectedLabel}" (derived from prompt 1), got items=${JSON.stringify(checkpoints.items)}`,
  );

  const rewind = await getRewindState(ctx, step);
  assert(step, rewind.ok === true, `GET rewind rejected: ${JSON.stringify(rewind)}`);
  assert(step, rewind.transcriptBlockCount > 0, `expected a non-zero transcriptBlockCount after turn 1, got ${rewind.transcriptBlockCount}`);
  ctx.blockCountC1 = rewind.transcriptBlockCount;

  await settledScreenshot(ctx, "step2-checkpoint-1-baseline");

  pass(step, `checkpoint-1 present (label="${expectedLabel}"), C1=${ctx.blockCountC1}`);
}

// ── step 3: second Write -> checkpoint-2, block count C2 > C1, file B on disk ──

async function step3SecondWrite(ctx) {
  const step = 3;

  await sendPromptAndWaitIdle(ctx, step, PROMPT_B, 90_000);

  const filePathB = join(ctx.workspace, FILE_B);
  assert(step, existsSync(filePathB), `expected ${filePathB} to exist on disk after turn 2`);
  assert(step, readFileSync(filePathB, "utf8").trim() === CONTENT_B.trim(), `expected ${filePathB} to carry the exact content, got:\n${readFileSync(filePathB, "utf8")}`);

  const checkpoints = await getCheckpoints(ctx, step);
  assert(step, checkpoints.ok === true, `GET checkpoints rejected: ${JSON.stringify(checkpoints)}`);
  assert(step, checkpoints.items.length >= 2, `expected at least 2 checkpoints after turn 2, got ${JSON.stringify(checkpoints.items)}`);

  const expectedLabel = deriveCheckpointLabel(PROMPT_B);
  const checkpoint2 = checkpoints.items.find((it) => it.label === expectedLabel);
  assert(
    step,
    checkpoint2 !== undefined,
    `expected a checkpoint labeled "${expectedLabel}" (derived from prompt 2), got items=${JSON.stringify(checkpoints.items)}`,
  );
  ctx.checkpoint2Id = checkpoint2.id;
  ctx.checkpointIdsBeforeRewind = new Set(checkpoints.items.map((it) => it.id));

  const rewind = await getRewindState(ctx, step);
  assert(step, rewind.ok === true, `GET rewind rejected: ${JSON.stringify(rewind)}`);
  assert(
    step,
    rewind.transcriptBlockCount > ctx.blockCountC1,
    `expected transcriptBlockCount to grow past C1=${ctx.blockCountC1} after turn 2, got ${rewind.transcriptBlockCount}`,
  );
  ctx.blockCountC2 = rewind.transcriptBlockCount;

  pass(step, `checkpoint-2 present (label="${expectedLabel}"), C2=${ctx.blockCountC2} > C1=${ctx.blockCountC1}, ${FILE_B} on disk`);
}

// ── step 4: rewind to "before prompt-2" -- file B gone, file A present, transcript back to ~C1 ──

async function step4Rewind(ctx) {
  const step = 4;

  // The auto-checkpoint arc captures its snapshot BEFORE the triggering
  // turn's own write-effect tool runs (packages/core/src/dispatch/dispatcher.ts:
  // "the checkpoint is taken BEFORE the write-effect handler runs"), labeled
  // from THAT turn's own prompt (deriveCheckpointLabel(req.userInput),
  // shadow-git.ts:231). So checkpoint-2 (captured during turn 2, labeled from
  // PROMPT_B) stores the history/file state from immediately BEFORE turn 2's
  // Write ran -- i.e. exactly "after turn 1, before prompt 2". checkpoint-2 is
  // the NEWER of the two checkpoints (turn 2 ran after turn 1), so it sits at
  // newest-first `index:0` -- NOT `index:1` as the originating brief's literal
  // step description said. `index:1` would resolve to checkpoint-1 (an EMPTY
  // pre-turn-1 snapshot), which would blank the transcript entirely and
  // contradict the brief's own "transcriptBlockCount back to ~C1" outcome.
  // This smoke follows the OBSERVABLE spec (the assertions below), not the
  // literal index value.
  const result = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/rewind`, { index: 0, scope: "both" });
  assert(step, result.ok === true, `POST rewind rejected: ${JSON.stringify(result)}`);
  assert(step, result.lastResult !== null, `expected a non-null lastResult after rewind, got ${JSON.stringify(result)}`);
  assert(step, result.lastResult.conversationRestored === true, `expected conversationRestored:true, got ${JSON.stringify(result.lastResult)}`);
  assert(
    step,
    typeof result.lastResult.safetyId === "string" && result.lastResult.safetyId.length > 0,
    `expected a non-empty safetyId (mandatory pre-rewind safety checkpoint), got ${JSON.stringify(result.lastResult)}`,
  );
  assert(
    step,
    Math.abs(result.transcriptBlockCount - ctx.blockCountC1) <= 1,
    `expected transcriptBlockCount back to ~C1=${ctx.blockCountC1} after rewind, got ${result.transcriptBlockCount}`,
  );

  const filePathA = join(ctx.workspace, FILE_A);
  const filePathB = join(ctx.workspace, FILE_B);
  assert(step, existsSync(filePathA), `expected ${filePathA} to still exist after rewind (files-restore, scope:"both")`);
  assert(step, !existsSync(filePathB), `expected ${filePathB} to be GONE after rewind (files-restore, scope:"both")`);

  await settledScreenshot(ctx, "step4-rewound");

  pass(
    step,
    `rewound to checkpoint ${ctx.checkpoint2Id} (index 0) -- conversationRestored, transcriptBlockCount=${result.transcriptBlockCount} (~C1=${ctx.blockCountC1}), ` +
      `${FILE_B} gone, ${FILE_A} present, safetyId=${result.lastResult.safetyId}`,
  );
}

// ── step 5: rewind-then-continue -- a new turn from the truncated history writes checkpoint-3 on top ──

async function step5ContinueAfterRewind(ctx) {
  const step = 5;

  await sendPromptAndWaitIdle(ctx, step, PROMPT_C, 90_000);

  const filePathC = join(ctx.workspace, FILE_C);
  assert(step, existsSync(filePathC), `expected ${filePathC} to exist on disk after the post-rewind turn`);
  assert(step, readFileSync(filePathC, "utf8").trim() === CONTENT_C.trim(), `expected ${filePathC} to carry the exact content, got:\n${readFileSync(filePathC, "utf8")}`);

  const checkpoints = await getCheckpoints(ctx, step);
  assert(step, checkpoints.ok === true, `GET checkpoints rejected: ${JSON.stringify(checkpoints)}`);
  // The id-diff is the ONE authoritative proof here (W3-FIX): every
  // Write-triggering prompt in this smoke truncates to the same 64-char
  // `deriveCheckpointLabel` prefix once the shared "Use the Write tool right
  // now to create a file named..." wording is cut, so a label-based lookup
  // (the prior version of this assertion) cannot distinguish checkpoint-3
  // from checkpoint-1/2 -- only the checkpoint's own stable `id` (now carried
  // by GET /tabs/:tabId/checkpoints, W3-FIX finding D) can.
  const newIds = checkpoints.items.map((it) => it.id).filter((id) => !ctx.checkpointIdsBeforeRewind.has(id));
  assert(
    step,
    newIds.length > 0,
    `expected at least one NEW checkpoint (the mandatory pre-rewind safety checkpoint + a new auto checkpoint from the truncated history) on top of the pre-rewind set, got items=${JSON.stringify(checkpoints.items)}`,
  );

  await settledScreenshot(ctx, "step5-continued-after-rewind");

  pass(step, `post-rewind turn started from the truncated history and wrote ${FILE_C}; ${newIds.length} new checkpoint id(s) landed on top of the pre-rewind set`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else if (typeof ctx.tabId === "string") {
        await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
      }
    } catch {
      // best-effort -- the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[rewind-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[rewind-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.workspace, ctx.profile]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[rewind-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[rewind-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[rewind-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[rewind-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[rewind-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    workspace: null,
    secretsEnv: null,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: null,
    secretsPath: null,
    blockCountC1: null,
    blockCountC2: null,
    checkpoint2Id: null,
    checkpointIdsBeforeRewind: new Set(),
    teardownPromise: null,
    // Job tmp dir if set (process.env.CLAUDE_JOB_DIR/tmp), else os.tmpdir() --
    // unlike the sibling smokes (which always write under apps/desktop/out/),
    // this one is expected to run from ephemeral CI/agent job contexts too.
    screenshotDir: join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "rewind-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapFixtures(ctx);
    await step1LaunchAndFirstWrite(ctx);
    await step2CaptureBaseline(ctx);
    await step3SecondWrite(ctx);
    await step4Rewind(ctx);
    await step5ContinueAfterRewind(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[rewind-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[rewind-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

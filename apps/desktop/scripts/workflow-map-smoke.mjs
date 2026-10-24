/**
 * Live GUI smoke for Taskana 4161 (TASK.232, "живой смоук карты без человека"):
 * the FIRST end-to-end run of the Workflow run map + collapsed tick strip on
 * a REAL Electron dev instance, driven entirely over the automation HTTP
 * channel (`main/automation/*` — this card's own probes/drivers from
 * commit 18d0479b: `workflowMapState`/`workflowMapToggle`/
 * `workflowTicksState`/`agentCardCollapse`, see `automation/README.md`'s
 * "Workflow map / ticks probes + toggle & collapse drivers" section).
 *
 * The scenario the card's board line names — proof the map and the tick
 * strip paint REAL mixed states on a REAL multi-step run, without a human:
 *
 *   1. boot: disposable profile + a temp workspace carrying a PLANTED
 *      3-step workflow definition (`.anycode/workflows/smoke-map-flow.json`
 *      — a diamond: two parallel `gather-*` sources feeding one `report`
 *      sink), GLM credentials seeded from `.smoke-secrets/glm.env`.
 *   2. dispatch: ONE prompt asking the live model to run the Workflow tool
 *      with that exact name; the model must call the tool itself (one retry
 *      on live-model nondeterminism, then a documented SKIP — same
 *      discipline as `subagent-card-smoke.mjs`'s Agent leg).
 *   3. mid-run ticks: COLLAPSE the running card (the collapse driver's whole
 *      reason to exist — pre-4161 automation could only ensure-expanded),
 *      read `workflow-ticks`, assert the strip is present with one tick per
 *      step and a MIXED bag (>=1 settled + >=1 not) — mixed tick colours
 *      were provable only by a hand-run stand until this route pair.
 *   4. mid-run map: EXPAND back, read `workflow-map`, assert every step id
 *      has exactly one node and every declared dependency exactly one
 *      `from`→`to` edge; toggle the map closed and open again (the toggle
 *      driver is an idempotent binary, so both directions get exercised).
 *   5. wait for the run to settle (`workflow.final` lands on the block).
 *   6. terminal map: every node must carry a terminal `substatus-*` kind.
 *
 * Boot/attach/teardown scaffold: `subagent-card-smoke.mjs`'s structure,
 * lifted verbatim where it is generic (per-run disposable profile,
 * `.smoke-secrets/glm.env` discipline, signal teardown, PNG evidence to
 * `apps/desktop/out/workflow-map-smoke/`). The workflow-dispatch leg follows
 * `subagent-card-smoke.mjs`'s Agent leg shape (prompt retry → poll →
 * documented SKIP), retargeted at the Workflow tool. Every shape judgement
 * on a probe body is delegated to `workflow-map-smoke-assertions.mjs` (pure,
 * vitest-covered — see `src/main/workflow-map-smoke-assertions.test.ts`).
 *
 * Usage:   node apps/desktop/scripts/workflow-map-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach   Do not spawn a dev instance — read the live discovery file
 *              (~/.anycode/automation.json) of one already running. Teardown
 *              then only closes the tab this script created; it does NOT quit
 *              an app it did not launch, and it does NOT re-seed that
 *              instance's workspace (the planted workflow definition must
 *              already exist in the attached instance's tab workspace).
 *   --keep     Do not delete the temp workspace/profile on exit (debugging).
 *   --port <n> Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *              process (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider — read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL), same file `subagent-card-smoke.mjs`
 * uses; in a git worktree without its own `.smoke-secrets`, fall back to the
 * main checkout three levels up (same rule as
 * `orchestration-loop-live-smoke.mjs`'s `secretsPath()`).
 *
 * Each of the 6 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. The dispatch leg allows exactly ONE prompt retry
 * before failing red; if the model never dispatches the Workflow tool at
 * all after the retry, the run reports a documented SKIP (exit 0) — a
 * live-model limitation, not a product failure. PNG evidence is written to
 * `apps/desktop/out/workflow-map-smoke/step-*.png`.
 *
 * RUN NOTE: this is a LIVE smoke — it spawns `pnpm --filter @anycode/desktop
 * dev` (a real Electron window + a real GLM turn) and never runs in CI or
 * the release path (`docs/development/automation-smoke.md`'s dev-only
 * boundary). Dev-only: the automation channel is double-gated
 * (`ANYCODE_AUTOMATION === "1" && !app.isPackaged`) and stripped from every
 * packaged build.
 */

import {
  checkMapMidRun,
  checkMapTerminal,
  checkTicksMidRun,
  formatVerdictTable,
} from "./workflow-map-smoke-assertions.mjs";
import { smokeProviderProfile, activeSmokeConnection } from "./smoke-provider-profile.mjs";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 6;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2"; // reasoning-capable, same model subagent-card-smoke seeds — a real tool dispatch needs a model that reliably follows explicit tool-use instructions.

// The planted workflow definition (step 1): a 3-step DIAMOND — two parallel
// sources feeding one sink — so the run map has both a real shape (two
// columns, three nodes, two edges) and a real mid-run window where one
// source settles while the other still runs (mixed ticks). Step prompts
// deliberately need no tools (read-only answers off the prompt text), so a
// green run is fast and deterministic; `general-purpose` is a built-in
// persona, resolved by the engine without any agent-profile fixture.
const WORKFLOW_NAME = "smoke-map-flow";
const WORKFLOW_DEFINITION = {
  name: WORKFLOW_NAME,
  description: "Taskana 4161 smoke: a 3-step diamond whose map and tick strip a live run must paint.",
  steps: [
    {
      id: "gather-berries",
      agentType: "general-purpose",
      promptTemplate: "Reply with the single word BERRY and nothing else. Do not use any tools.",
    },
    {
      id: "gather-nuts",
      agentType: "general-purpose",
      promptTemplate: "Reply with the single word NUT and nothing else. Do not use any tools.",
    },
    {
      id: "report",
      agentType: "general-purpose",
      promptTemplate: "Two gatherers reported ${steps.gather-berries} and ${steps.gather-nuts}. Reply with one short sentence naming both. Do not use any tools.",
      dependsOn: ["gather-berries", "gather-nuts"],
    },
  ],
  outputTemplate: "${steps.report}",
};
const WORKFLOW_STEP_IDS = WORKFLOW_DEFINITION.steps.map((step) => step.id);
const WORKFLOW_DEPENDENCIES = [
  { from: "gather-berries", to: "report" },
  { from: "gather-nuts", to: "report" },
];

const WORKFLOW_PROMPT_PRIMARY =
  `Run the workflow named "${WORKFLOW_NAME}" now, using the Workflow tool: call the Workflow tool with name "${WORKFLOW_NAME}" ` +
  "and a short input describing the task. You must invoke the Workflow tool yourself — do not try to perform the steps yourself.";
const WORKFLOW_PROMPT_RETRY =
  `Use the Workflow tool now and run the workflow named "${WORKFLOW_NAME}". Pass name: "${WORKFLOW_NAME}" and a one-line input. ` +
  "You must invoke the Workflow tool itself for this — do not answer directly and do not use the Agent tool.";

// How long the mid-run legs may poll for their window before failing red:
// the run settles in a few seconds on an honest green path, so these budgets
// only ever reddens a genuinely stuck run, never a slow-but-correct one.
const DISPATCH_TIMEOUT_MS = 90_000;
const FIRST_STEP_END_TIMEOUT_MS = 120_000;
const RUN_SETTLE_TIMEOUT_MS = 240_000;

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
      console.warn(`[workflow-map-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from subagent-card-smoke.mjs) ──

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

/** `.smoke-secrets/glm.env` location: env override, then this checkout, then the main checkout (worktree discipline). */
function secretsPath() {
  if (process.env.ANYCODE_SMOKE_SECRETS) return process.env.ANYCODE_SMOKE_SECRETS;
  const local = join(repoRoot, ".smoke-secrets", "glm.env");
  if (existsSync(local)) return local;
  return join(repoRoot, "..", "..", "..", ".smoke-secrets", "glm.env");
}

// ── step bookkeeping ──

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

const verdictRows = [];

function pass(step, detail) {
  verdictRows.push({ step, verdict: "PASS", detail });
  console.log(`[step ${step}] PASS ${detail ?? ""}`.trimEnd());
}

function fail(step, detail) {
  verdictRows.push({ step, verdict: "FAIL", detail });
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
}

function assert(step, cond, detail) {
  if (!cond) {
    fail(step, detail);
  }
}

/** Turns a helper's problem list into the step's verdict (empty list = PASS). */
function assertNoProblems(step, problems, context) {
  if (problems.length > 0) {
    fail(step, `${context ? context + ": " : ""}${problems.join("; ")}`);
  }
}

function skip(step, detail) {
  verdictRows.push({ step, verdict: "SKIP", detail });
  console.log(`[step ${step}] SKIP ${detail ?? ""}`.trimEnd());
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
      console.warn(`[workflow-map-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    ctx.mkdirScreenshotDir();
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[workflow-map-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

/* */
async function settledScreenshot(ctx, name) {
  await sleep(400);
  return saveScreenshot(ctx, name);
}

/** Fetches the current transcript block array for the active tab from `GET /state`. */
async function getTranscriptBlocks(ctx, step) {
  const resp = await api(ctx, "GET", "/state");
  if (resp.status !== 200) {
    fail(step, `GET /state -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  const transcript = resp.body?.snapshot?.states?.[ctx.tabId]?.transcript;
  if (!Array.isArray(transcript)) {
    fail(step, `GET /state returned no transcript array for tab ${ctx.tabId}`);
  }
  return transcript;
}

// ── workflow probe/driver helpers (automation/README.md, Taskana 4161 section) ──

async function workflowMapState(ctx, step, toolCallId) {
  const resp = await api(
    ctx,
    "GET",
    `/tabs/${encodeURIComponent(ctx.tabId)}/agent-card/${encodeURIComponent(toolCallId)}/workflow-map`,
  );
  if (resp.status !== 200) {
    fail(step, `GET workflow-map -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function workflowTicksState(ctx, step, toolCallId) {
  const resp = await api(
    ctx,
    "GET",
    `/tabs/${encodeURIComponent(ctx.tabId)}/agent-card/${encodeURIComponent(toolCallId)}/workflow-ticks`,
  );
  if (resp.status !== 200) {
    fail(step, `GET workflow-ticks -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function workflowMapToggle(ctx, step, toolCallId, open) {
  const resp = await api(
    ctx,
    "POST",
    `/tabs/${encodeURIComponent(ctx.tabId)}/agent-card/${encodeURIComponent(toolCallId)}/workflow-map/toggle`,
    { open },
  );
  if (resp.status !== 200) {
    fail(step, `POST workflow-map/toggle -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `workflow-map/toggle {open:${open}} rejected: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function agentCardCollapse(ctx, step, toolCallId) {
  const resp = await api(
    ctx,
    "POST",
    `/tabs/${encodeURIComponent(ctx.tabId)}/agent-card/${encodeURIComponent(toolCallId)}/collapse`,
    {},
  );
  if (resp.status !== 200) {
    fail(step, `POST agent-card/collapse -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `agent-card/collapse rejected: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

async function agentCardExpand(ctx, step, toolCallId) {
  const resp = await api(
    ctx,
    "POST",
    `/tabs/${encodeURIComponent(ctx.tabId)}/agent-card/${encodeURIComponent(toolCallId)}/expand`,
    {},
  );
  if (resp.status !== 200) {
    fail(step, `POST agent-card/expand -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  assert(step, resp.body?.ok === true, `agent-card/expand rejected: ${JSON.stringify(resp.body)}`);
  return resp.body;
}

/** The Workflow tool_call block, once it has a live `workflow` sub-status attached (workflow_start landed). */
function findWorkflowBlock(transcript) {
  return (
    transcript.find((b) => b.kind === "tool_call" && b.toolName === "Workflow" && b.workflow !== null && b.workflow !== undefined) ??
    null
  );
}

function findAnyWorkflowToolCall(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Workflow") ?? null;
}

// ── step 1: bootstrap workspace (+ planted workflow definition), launch (or attach to) the dev app ──

async function step1LaunchApp(ctx) {
  try {
    ctx.tmpWorkspace = mkdtempSync(join(tmpdir(), "anycode-workflow-map-smoke-ws-"));
    writeFileSync(join(ctx.tmpWorkspace, "README.md"), "# smoke\n\nhello from workflow-map smoke\n");
    // THE plant: the workflow definition this whole run dispatches. Flat
    // `*.json` under `<workspace>/.anycode/workflows/` is exactly what
    // discovery scans (project source, `extensions/bootstrap.ts`'s roots).
    mkdirSync(join(ctx.tmpWorkspace, ".anycode", "workflows"), { recursive: true });
    writeFileSync(
      join(ctx.tmpWorkspace, ".anycode", "workflows", `${WORKFLOW_NAME}.json`),
      JSON.stringify(WORKFLOW_DEFINITION, null, 2),
    );
  } catch (err) {
    fail(1, `workspace bootstrap error: ${err?.message ?? err}`);
  }

  let secretsEnv = {};
  try {
    secretsEnv = parseEnvFile(readFileSync(secretsPath(), "utf8"));
  } catch (err) {
    fail(1, `could not read GLM smoke credentials at ${secretsPath()}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `${secretsPath()} missing ANYCODE_API_KEY`);
  assert(1, typeof secretsEnv.ANYCODE_BASE_URL === "string" && secretsEnv.ANYCODE_BASE_URL.length > 0, `${secretsPath()} missing ANYCODE_BASE_URL`);

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
  const profile = mkdtempSync(join(tmpdir(), "anycode-workflow-map-smoke-profile-"));
  ctx.profile = profile;
  ctx.profileUserDataDir = join(profile, "user-data");
  ctx.profileDbPath = join(profile, "db.sqlite");
  ctx.profileAutomationInfo = join(profile, "automation.json");
  ctx.settingsPath = join(profile, "settings.json");
  ctx.secretsPath = join(profile, "secrets.json");

  const seedSettings = {
    version: 2,
    provider: smokeProviderProfile(PROVIDER_ID, MODEL_A, { credentialFromEnv: true }),
    tools: {},
    permissions: { alwaysAllow: [{ toolName: "Workflow" }, { toolName: "Agent" }] },
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
  // The tab this script creates/discovers must also be the ACTIVE tab — the
  // workflow map/ticks probes only ever read the active tab's mounted
  // transcript (`tab_not_active` refusal).
  await apiAction(ctx, 1, `/tabs/${ctx.tabId}/select`, {});

  pass(1, `tab ${ctx.tabId} ready + active for workspace ${ctx.tmpWorkspace}`);
}

// ── step 2: dispatch the Workflow tool through a real GLM turn ──

/**
 * Sends the prompt and polls until a Workflow tool_call block with a live
 * `workflow` sub-status appears (workflow_start landed — the card exists).
 * Also tracks whether ANY Workflow tool_call was seen at all, to separate
 * "the model never called Workflow" (documented SKIP) from "it called
 * Workflow but workflow_start routing never attached a sub-status" (a real
 * regression that must FAIL) — subagent-card-smoke's Agent-leg discipline.
 */
async function attemptWorkflowDispatch(ctx, step, prompt, timeoutMs) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  const deadline = Date.now() + timeoutMs;
  let anyWorkflowToolCallSeen = false;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step);
    if (findAnyWorkflowToolCall(transcript) !== null) {
      anyWorkflowToolCallSeen = true;
    }
    const block = findWorkflowBlock(transcript);
    if (block !== null) {
      return { block, anyWorkflowToolCallSeen };
    }
    if (Date.now() >= deadline) {
      return { block: null, anyWorkflowToolCallSeen };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Stops the current turn and best-effort waits for it to settle to idle — used before a retry. */
async function settleTurn(ctx, step) {
  await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort — proceed regardless of the settle wait outcome.
  });
}

async function step2DispatchWorkflow(ctx) {
  const step = 2;

  let attempt = await attemptWorkflowDispatch(ctx, step, WORKFLOW_PROMPT_PRIMARY, DISPATCH_TIMEOUT_MS);
  let workflowBlock = attempt.block;
  let anyWorkflowToolCallSeen = attempt.anyWorkflowToolCallSeen;
  if (workflowBlock === null) {
    console.warn(
      "[workflow-map-smoke] no Workflow tool_call with a workflow sub-status observed on the first attempt — retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step);
    attempt = await attemptWorkflowDispatch(ctx, step, WORKFLOW_PROMPT_RETRY, DISPATCH_TIMEOUT_MS);
    workflowBlock = attempt.block;
    anyWorkflowToolCallSeen = anyWorkflowToolCallSeen || attempt.anyWorkflowToolCallSeen;
  }
  if (workflowBlock === null) {
    if (anyWorkflowToolCallSeen) {
      // The model DID call Workflow, but no workflow sub-status was ever
      // attached to the block — a workflow_start routing regression, not
      // model nondeterminism.
      fail(
        step,
        "a Workflow tool_call block was observed but its workflow sub-status never appeared (possible workflow_start routing regression), after 1 retry",
      );
    }
    console.warn(
      "[workflow-map-smoke] SKIPPED: the model never dispatched the Workflow tool at all (no Workflow tool_call block " +
        "appeared) after 1 retry. This is a documented live-model-nondeterminism SKIP, NOT a product failure — the probe " +
        "logic itself is unit-covered (workflow-map-smoke-assertions.test.ts) and the facade layer by automation.test.ts.",
    );
    ctx.skipped = true;
    await settleTurn(ctx, step);
    skip(step, "documented SKIP — Workflow tool never dispatched by the live model after 1 retry; see warning above");
    return;
  }

  ctx.toolCallId = workflowBlock.toolCallId;
  const workflow = workflowBlock.workflow;
  assert(step, workflow.workflow === WORKFLOW_NAME, `expected workflow name "${WORKFLOW_NAME}", got ${JSON.stringify(workflow.workflow)}`);
  assert(step, Array.isArray(workflow.steps) && workflow.steps.length === WORKFLOW_STEP_IDS.length, `expected ${WORKFLOW_STEP_IDS.length} seeded steps, got ${JSON.stringify(workflow.steps?.length)}`);
  pass(step, `Workflow "${WORKFLOW_NAME}" dispatched (toolCallId=${ctx.toolCallId}, ${workflow.steps.length} steps seeded)`);
}

// ── step 3: mid-run — collapse the card, read the tick strip ──

/**
 * Waits until the run reaches the mixed window: at least one step has a
 * terminal `final` while the run itself has not settled (`workflow.final`
 * still null). The two source steps run in parallel; the first one to
 * finish opens the window, which stays open until BOTH sources and the sink
 * complete — seconds on the green path.
 */
async function waitForMixedWindow(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step);
    const block = transcript.find((b) => b.kind === "tool_call" && b.toolCallId === ctx.toolCallId) ?? null;
    if (block === null) {
      fail(step, `Workflow tool_call block ${ctx.toolCallId} disappeared from the transcript mid-run`);
    }
    const workflow = block.workflow;
    if (workflow === null || workflow === undefined) {
      fail(step, `Workflow tool_call block ${ctx.toolCallId} lost its workflow sub-status mid-run`);
    }
    const settledSteps = workflow.steps.filter((s) => s.final !== null).length;
    if (workflow.final === null && settledSteps > 0) {
      return { block, settledSteps };
    }
    if (workflow.final !== null) {
      // The whole run settled before a single poll caught the mixed window
      // (a very fast green run). The mid-run legs below degrade honestly:
      // step 3 still reads the ticks (terminal kinds — a homogeneous bag,
      // so the MIXED assertion is waived), step 4's map assertions are all
      // terminal-state-invariant. The waiving is recorded, not silent.
      return { block, settledSteps, runSettledEarly: true };
    }
    if (Date.now() >= deadline) {
      fail(step, `no step reached a terminal state within ${timeoutMs}ms (steps=${JSON.stringify(workflow.steps.map((s) => ({ id: s.stepId, final: s.final !== null })))})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function step3CollapseAndReadTicks(ctx) {
  const step = 3;
  if (ctx.skipped) {
    skip(step, "documented SKIP — no Workflow dispatch to observe, see step 2");
    return;
  }

  const window = await waitForMixedWindow(ctx, step, FIRST_STEP_END_TIMEOUT_MS);
  ctx.runSettledEarly = window.runSettledEarly === true;
  if (ctx.runSettledEarly) {
    console.warn(
      "[workflow-map-smoke] the whole run settled before a poll caught the mixed window (fast green run) — " +
        "the ticks' MIXED-kind assertion is waived for this run; presence/count/vocabulary assertions still apply in full",
    );
  }

  // The collapse driver: a REAL click on the card's own header toggle — the
  // one state where the tick strip renders (this card's whole reason to be).
  await agentCardCollapse(ctx, step, ctx.toolCallId);

  const ticks = await workflowTicksState(ctx, step, ctx.toolCallId);
  assertNoProblems(
    step,
    checkTicksMidRun(ticks, { stepCount: WORKFLOW_STEP_IDS.length, expectMixed: !ctx.runSettledEarly }),
    "mid-run workflow-ticks",
  );

  await settledScreenshot(ctx, "step-3-ticks-collapsed");
  pass(
    step,
    `tick strip present mid-run, ${ticks.kinds.length} ticks (kinds=${JSON.stringify(ticks.kinds)}, label=${JSON.stringify(ticks.label)})${ctx.runSettledEarly ? " [mixed-kind waived: run settled early]" : ""}`,
  );
}

// ── step 4: mid-run — expand, read the map, toggle it closed and open ──

async function step4ExpandAndReadMap(ctx) {
  const step = 4;
  if (ctx.skipped) {
    skip(step, "documented SKIP — no Workflow dispatch to observe, see step 2");
    return;
  }

  // Expand back (the expand route is unchanged: ensure-expanded).
  await agentCardExpand(ctx, step, ctx.toolCallId);

  const map = await workflowMapState(ctx, step, ctx.toolCallId);
  assertNoProblems(step, checkMapMidRun(map, { stepIds: WORKFLOW_STEP_IDS, dependencies: WORKFLOW_DEPENDENCIES }), "mid-run workflow-map");

  // Toggle the map CLOSED, then OPEN again — the idempotent binary in both
  // directions (a re-run smoke must not collapse a map it wanted open, and
  // this run wants it open for step 6).
  await workflowMapToggle(ctx, step, ctx.toolCallId, false);
  const closed = await workflowMapState(ctx, step, ctx.toolCallId);
  assert(step, closed.ok === true && closed.open === false && closed.togglePresent === true, `expected map closed after toggle, got: ${JSON.stringify(closed)}`);
  assert(step, Array.isArray(closed.nodes) && closed.nodes.length === 0, `expected no map nodes while collapsed, got: ${JSON.stringify(closed.nodes)}`);

  await workflowMapToggle(ctx, step, ctx.toolCallId, true);
  const reopened = await workflowMapState(ctx, step, ctx.toolCallId);
  assert(step, reopened.ok === true && reopened.open === true, `expected map reopened, got: ${JSON.stringify(reopened)}`);
  assertNoProblems(step, checkMapMidRun(reopened, { stepIds: WORKFLOW_STEP_IDS, dependencies: WORKFLOW_DEPENDENCIES }), "reopened workflow-map");

  await settledScreenshot(ctx, "step-4-map-open");
  pass(step, `map nodes/edges verified (nodes=${reopened.nodes.length}, edges=${reopened.edges.length}) and toggle round-tripped closed->open`);
}

// ── step 5: wait for the run to settle ──

async function step5WaitForSettle(ctx) {
  const step = 5;
  if (ctx.skipped) {
    skip(step, "documented SKIP — no Workflow dispatch to settle, see step 2");
    return;
  }

  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step);
    const block = transcript.find((b) => b.kind === "tool_call" && b.toolCallId === ctx.toolCallId) ?? null;
    if (block === null) {
      fail(step, `Workflow tool_call block ${ctx.toolCallId} disappeared from the transcript while waiting for settle`);
    }
    const workflow = block.workflow;
    if (workflow !== null && workflow !== undefined && workflow.final !== null) {
      ctx.runFinalStatus = workflow.final.status;
      await settleTurn(ctx, step);
      pass(step, `run settled (final.status=${workflow.final.status}, completedSteps=${workflow.final.completedSteps}/${workflow.totalSteps})`);
      return;
    }
    if (Date.now() >= deadline) {
      fail(step, `workflow never reached a terminal final within ${RUN_SETTLE_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── step 6: terminal — every map node reached a terminal state ──

async function step6TerminalMap(ctx) {
  const step = 6;
  if (ctx.skipped) {
    skip(step, "documented SKIP — no Workflow dispatch to verify, see step 2");
    return;
  }

  // A settled successful run auto-collapses the card (`shouldAutoCollapse`:
  // success folds), so expand once more — the map only mounts expanded.
  await agentCardExpand(ctx, step, ctx.toolCallId);
  const map = await workflowMapState(ctx, step, ctx.toolCallId);
  assertNoProblems(step, checkMapTerminal(map), "terminal workflow-map");

  const kinds = map.nodes.map((node) => `${node.stepId}:${node.kind}`).join(", ");
  await settledScreenshot(ctx, "step-6-terminal-map");
  pass(step, `every node terminal after workflow_end (${kinds})`);
}

// ── teardown ──

/**
 * Thin memoizing wrapper around `runTeardown` (subagent-card-smoke.mjs /
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
            `[workflow-map-smoke] tab ${ctx.tabId} close rejected (reason=${closeResp.body?.reason ?? "unknown"}) — ` +
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
      console.warn(`[workflow-map-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[workflow-map-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (typeof ctx.tmpWorkspace === "string" && existsSync(ctx.tmpWorkspace)) {
    if (FLAGS.keep) {
      console.log(`[workflow-map-smoke] --keep set, workspace preserved at: ${ctx.tmpWorkspace}`);
    } else if (tabCloseFailed) {
      console.warn(`[workflow-map-smoke] tab close failed — NOT deleting temp workspace (a live tab may still reference it): ${ctx.tmpWorkspace}`);
    } else {
      try {
        rmSync(ctx.tmpWorkspace, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[workflow-map-smoke] failed to remove temp workspace ${ctx.tmpWorkspace}: ${err?.message ?? err}`);
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[workflow-map-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[workflow-map-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  // The PASS/FAIL table (the brief's own DoD for this smoke's output).
  const table = formatVerdictTable(verdictRows);
  console.log(`\n[workflow-map-smoke] ${table.header}`);
  for (const line of table.lines) {
    console.log(`  ${line}`);
  }
  console.log(`[workflow-map-smoke] ${table.summary}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[workflow-map-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[workflow-map-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
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
    runSettledEarly: false,
    runFinalStatus: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "workflow-map-smoke"),
  };
  ctx.mkdirScreenshotDir = () => {
    try {
      mkdirSync(ctx.screenshotDir, { recursive: true });
    } catch {
      // fall through to saveScreenshot's own writeFileSync, whose ENOENT would surface as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);
    await step2DispatchWorkflow(ctx);
    await step3CollapseAndReadTicks(ctx);
    await step4ExpandAndReadMap(ctx);
    await step5WaitForSettle(ctx);
    await step6TerminalMap(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[workflow-map-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[workflow-map-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

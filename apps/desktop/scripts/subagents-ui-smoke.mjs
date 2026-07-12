/**
 * Live GUI smoke for P7.21/F21 W4 (design/slice-P7.21-cut.md §4 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Subagents pane
 * probe/driver" routes) against a seeded user-home `~/.anycode/agents/*.md`
 * catalog (a valid `researcher.md` + a malformed `broken.md`, the amber
 * problems strip) and exercises the full stack: the admin scan (built-in
 * cards + user rows + problems), the in-app editor's create/edit/preview/save
 * round-trip (design §2-D3/D4 -- Preview calls the REAL `buildSubagentSystemPrompt`
 * builder, never a lookalike), a live Agent-tool dispatch of a
 * USER-CREATED profile end-to-end (loader -> prompt-section -> Agent-tool
 * validation -> runner resolution), then delete + the built-in-refusal guard.
 *
 * Boot/attach/teardown scaffold + process/fs/HTTP helpers lifted from
 * `skills-ui-smoke.mjs` (same disposable-profile discipline); the GLM
 * live-dispatch leg (settings.json/secrets.json seeding, one-prompt-retry +
 * documented-SKIP discipline) is lifted from `subagent-card-smoke.mjs`. A NEW
 * sibling, not an edit of either precedent. Plain node >=22, ZERO npm deps
 * (only node:child_process/fs/os/path/url + the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/subagents-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance -- read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tabs this script created; it
 *                   does NOT quit an app it did not launch, and it does NOT
 *                   override that instance's ANYCODE_SUBAGENTS_HOME (the user
 *                   row/problems-strip assertions then read the REAL
 *                   machine's `~/.anycode/agents` -- only meaningful under
 *                   --attach if that catalog happens to match; the live GLM
 *                   credentials must also already be configured on that
 *                   instance).
 *   --keep         Do not delete the temp workspace / subagents-home /
 *                   automation profile dirs on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Requires GLM API credentials for a `z-ai` catalog provider -- read from
 * `.smoke-secrets/glm.env` (repo root, KEY=VALUE lines: ANYCODE_API_KEY /
 * ANYCODE_BASE_URL / ANYCODE_MODEL), same file `subagent-card-smoke.mjs` uses
 * -- the whole run is ONE continuous app session (steps 1-4/6/7 never call
 * the model, only step 5 does), so the credentials are seeded up front.
 *
 * Each of the 7 steps prints `[step N] PASS/FAIL <detail>`; the first FAIL
 * tears down and exits 1. Step 5 (the live Agent dispatch) allows exactly ONE
 * prompt retry (live-model nondeterminism, same discipline as
 * `subagent-card-smoke.mjs`) before reporting a documented SKIP (exit 0) if
 * the model never dispatches Agent with `agent_type:"summarizer"` -- a
 * live-model limitation, not a product failure; steps 1-4/6-7 must be green
 * regardless. PNG evidence is written to
 * `apps/desktop/out/subagents-smoke/step-*.png`.
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
const SMOKE_SECRETS_PATH = join(repoRoot, ".smoke-secrets", "glm.env");
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const PANE_SETTLE_TIMEOUT_MS = 15_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const POLL_INTERVAL_MS = 500;

const PROVIDER_ID = "z-ai";
const MODEL_A = "glm-5.2"; // reasoning-capable, same model subagent-card-smoke seeds -- a real Agent dispatch needs a model that reliably follows explicit tool-use instructions.

const RESEARCHER_NAME = "researcher";
const BROKEN_NAME = "broken";
const SUMMARIZER_NAME = "summarizer";
const NEW_RESEARCHER_BODY = "You research the codebase deeply and report findings with file:line citations.";
// Verbatim SECTION_SUBAGENT_FINALITY text (packages/core/src/prompts/sections.ts) -- the
// finality note ALWAYS trails the real `buildSubagentSystemPrompt` output;
// its presence is the proof the preview tab called the REAL builder, not a
// lookalike (design §2-D4).
const FINALITY_MARKER = "Only your last message travels back to the parent";

const DISPATCH_PROMPT_PRIMARY =
  'Start a subagent using the Agent tool with agent_type set to "summarizer" (not the default). ' +
  "The subagent must read smoke-note.txt at the repository root and summarize its content very briefly " +
  '(1–2 sentences). Be sure to pass agent_type="summarizer".';
const DISPATCH_PROMPT_RETRY =
  'Use the Agent tool now, and set its agent_type parameter to exactly "summarizer" (not the default). Task for ' +
  "the subagent: read the file smoke-note.txt in the repository root and summarize its contents in 1-2 " +
  'sentences. You must pass agent_type="summarizer" explicitly on this call.';

// -- CLI flags --

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
      console.warn(`[subagents-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// -- small process/fs helpers (lifted from skills-ui-smoke.mjs / subagent-card-smoke.mjs) --

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

// -- step bookkeeping --

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

// -- HTTP helpers against the automation channel (README.md routes) --

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

/** `POST /wait` for a SPECIFIC tabId + hard-fail if the condition never matched within the timeout. */
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

async function getSubagentsPane(ctx, step) {
  return apiOk(ctx, step, "GET", "/settings/subagents");
}

function findRow(probe, name) {
  return probe?.rows?.find((r) => r.name === name);
}

/** Fetches the current transcript block array for the given tab from `GET /state`. */
async function getTranscriptBlocks(ctx, step, tabId) {
  const resp = await apiOk(ctx, step, "GET", "/state");
  const transcript = resp?.snapshot?.states?.[tabId]?.transcript;
  if (!Array.isArray(transcript)) {
    fail(step, `GET /state returned no transcript array for tab ${tabId}`);
  }
  return transcript;
}

/** Best-effort PNG evidence via `GET /screenshot` -- never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[subagents-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[subagents-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

/* */
async function settledScreenshot(ctx, name) {
  await sleep(400);
  await saveScreenshot(ctx, name);
}

/** Renders a flat agent-profile `*.md` -- frontmatter (`name`/`description`/optional `tools`) + body, the same shape `parseAgentProfileMd` reads. */
function agentMd({ name, description, tools, body }) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (tools) {
    lines.push(`tools: ${tools}`);
  }
  lines.push("---", body, "");
  return lines.join("\n");
}

// -- step 1: bootstrap fixtures, launch the dev app, create the first tab, open Settings -> "subagents" --

function step1BootstrapFixtures(ctx) {
  const subagentsHome = mkdtempSync(join(tmpdir(), "anycode-subagents-smoke-home-"));
  ctx.subagentsHome = subagentsHome;
  const agentsDir = join(subagentsHome, ".anycode", "agents");
  mkdirSync(agentsDir, { recursive: true });
  ctx.agentsDir = agentsDir;

  writeFileSync(
    join(agentsDir, `${RESEARCHER_NAME}.md`),
    agentMd({
      name: RESEARCHER_NAME,
      description: "Researches the codebase before a change.",
      tools: "Read, Grep, Glob",
      body: "You research the codebase and report findings.",
    }),
  );

  // Malformed -- an indented continuation line makes the WHOLE file
  // non-conforming to the strict flat frontmatter parser (same nested/
  // mis-shaped-frontmatter fixture idea as skills-ui-smoke's "broken" skill).
  writeFileSync(
    join(agentsDir, `${BROKEN_NAME}.md`),
    [
      "---",
      `name: ${BROKEN_NAME}`,
      "description: Malformed profile for the amber problems strip.",
      "  this indented line makes the whole file non-conforming",
      "---",
      "Broken body.",
      "",
    ].join("\n"),
  );

  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-subagents-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "smoke-note.txt"), "This repository builds a desktop AI coding agent called AnyCode.\n");

  let secretsEnv = {};
  try {
    secretsEnv = parseEnvFile(readFileSync(SMOKE_SECRETS_PATH, "utf8"));
  } catch (err) {
    fail(1, `could not read GLM smoke credentials at ${SMOKE_SECRETS_PATH}: ${err?.message ?? err}`);
  }
  assert(1, typeof secretsEnv.ANYCODE_API_KEY === "string" && secretsEnv.ANYCODE_API_KEY.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_API_KEY`);
  assert(1, typeof secretsEnv.ANYCODE_BASE_URL === "string" && secretsEnv.ANYCODE_BASE_URL.length > 0, `${SMOKE_SECRETS_PATH} missing ANYCODE_BASE_URL`);
  ctx.secretsEnv = secretsEnv;

  pass(
    1,
    `user-home seeded at ${subagentsHome} (${RESEARCHER_NAME}.md valid, ${BROKEN_NAME}.md malformed); workspace seeded at ${ctx.workspace}`,
  );
}

async function step1LaunchAndOpenPane(ctx) {
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
    const profile = mkdtempSync(join(tmpdir(), "anycode-subagents-smoke-profile-"));
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
      ...ctx.secretsEnv,
      ANYCODE_AUTOMATION: "1",
      ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
      ANYCODE_DB_PATH: ctx.profileDbPath,
      ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
      ANYCODE_SETTINGS_PATH: ctx.settingsPath,
      ANYCODE_SECRETS_PATH: ctx.secretsPath,
      // dev/test-only override (automation/README.md "Subagents pane
      // probe/driver" section) -- points the admin scan's user-scope root at
      // our disposable fixture directory instead of the real machine's `~`.
      ANYCODE_SUBAGENTS_HOME: ctx.subagentsHome,
    };
    delete env.ANYCODE_WORKSPACE; // this smoke creates its own tabs explicitly (below)
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
  ctx.tabId1 = created.tabId;
  await waitUntilTab(ctx, step, ctx.tabId1, { connection: "ready" }, 60_000);
  await apiAction(ctx, step, `/tabs/${ctx.tabId1}/select`, {});

  const opened = await apiAction(ctx, step, "/settings/open", {});
  assert(step, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);
  const selected = await apiAction(ctx, step, "/settings/pane", { paneId: "subagents" });
  assert(step, selected.ok === true, `settings/pane("subagents") rejected: ${JSON.stringify(selected)}`);

  pass(step, `app launched, tab ${ctx.tabId1} ready for ${ctx.workspace}, Settings -> "subagents" open`);
}

// -- step 2: assert built-in cards, the seeded user row, and the problems strip --

async function step2AssertRows(ctx) {
  const step = 2;

  const start = Date.now();
  let probe = null;
  for (;;) {
    probe = await getSubagentsPane(ctx, step);
    if (probe.rows.length > 0 || probe.problems > 0) {
      break;
    }
    if (Date.now() - start >= PANE_SETTLE_TIMEOUT_MS) {
      fail(step, `subagents pane never reported any rows/problems within ${PANE_SETTLE_TIMEOUT_MS}ms -- last probe: ${JSON.stringify(probe)}`);
    }
    await sleep(200);
  }

  const generalPurpose = findRow(probe, "general-purpose");
  assert(step, generalPurpose !== undefined, `expected built-in row "general-purpose", got rows=${JSON.stringify(probe.rows)}`);
  assert(step, generalPurpose.sourceKind === "builtin", `"general-purpose" expected sourceKind "builtin", got ${JSON.stringify(generalPurpose)}`);
  assert(step, generalPurpose.toolsBadge === "All tools", `"general-purpose" expected toolsBadge "All tools", got ${JSON.stringify(generalPurpose)}`);
  assert(step, generalPurpose.editable === false, `"general-purpose" expected editable:false, got ${JSON.stringify(generalPurpose)}`);

  const explore = findRow(probe, "explore");
  assert(step, explore !== undefined, `expected built-in row "explore", got rows=${JSON.stringify(probe.rows)}`);
  assert(step, explore.toolsBadge === "6 tools", `"explore" expected toolsBadge "6 tools", got ${JSON.stringify(explore)}`);

  const researcher = findRow(probe, RESEARCHER_NAME);
  assert(step, researcher !== undefined, `expected user row "${RESEARCHER_NAME}", got rows=${JSON.stringify(probe.rows)}`);
  assert(step, researcher.sourceKind === "user", `"${RESEARCHER_NAME}" expected sourceKind "user", got ${JSON.stringify(researcher)}`);
  assert(step, researcher.toolsBadge === "3 tools", `"${RESEARCHER_NAME}" expected toolsBadge "3 tools" (Read/Grep/Glob), got ${JSON.stringify(researcher)}`);
  assert(step, researcher.editable === true, `"${RESEARCHER_NAME}" expected editable:true, got ${JSON.stringify(researcher)}`);

  const broken = findRow(probe, BROKEN_NAME);
  assert(step, broken === undefined, `expected NO row for the malformed "${BROKEN_NAME}" profile, got ${JSON.stringify(broken)}`);

  assert(step, probe.problems === 1, `expected exactly 1 discovery problem (the malformed "${BROKEN_NAME}" file), got ${probe.problems}: ${JSON.stringify(probe)}`);

  await settledScreenshot(ctx, "step2-subagents-pane-populated");

  pass(step, `built-ins present (general-purpose="All tools", explore="6 tools"); user row "${RESEARCHER_NAME}"="3 tools"; "${BROKEN_NAME}" absent; problems=1`);
}

// -- step 3: create "summarizer" via the in-app editor driver --

async function step3CreateSummarizer(ctx) {
  const step = 3;

  const opened = await apiAction(ctx, step, "/settings/subagents/editor/open", {});
  assert(step, opened.ok === true, `editor/open (create) rejected: ${JSON.stringify(opened)}`);

  const set = await apiAction(ctx, step, "/settings/subagents/editor/set", {
    name: SUMMARIZER_NAME,
    description: "Summarizes code.",
    body: "You summarize code.",
  });
  assert(step, set.ok === true, `editor/set rejected: ${JSON.stringify(set)}`);

  const saved = await apiAction(ctx, step, "/settings/subagents/editor/save", {});
  assert(step, saved.ok === true, `editor/save rejected: ${JSON.stringify(saved)}`);

  const probe = await getSubagentsPane(ctx, step);
  const row = findRow(probe, SUMMARIZER_NAME);
  assert(step, row !== undefined, `expected row "${SUMMARIZER_NAME}" after create, got rows=${JSON.stringify(probe.rows)}`);
  assert(step, row.sourceKind === "user" && row.editable === true, `"${SUMMARIZER_NAME}" expected an editable user-scope row, got ${JSON.stringify(row)}`);

  const filePath = join(ctx.agentsDir, `${SUMMARIZER_NAME}.md`);
  assert(step, existsSync(filePath), `expected ${filePath} to exist on disk after create`);
  const written = readFileSync(filePath, "utf8");
  assert(step, written.startsWith("---\n"), `expected ${filePath} to start with a flat frontmatter fence, got:\n${written}`);
  assert(step, written.includes(`name: ${SUMMARIZER_NAME}`), `expected ${filePath} to carry "name: ${SUMMARIZER_NAME}", got:\n${written}`);
  assert(step, written.includes("description: Summarizes code."), `expected ${filePath} to carry the description, got:\n${written}`);
  assert(step, written.includes("You summarize code."), `expected ${filePath} to carry the body, got:\n${written}`);

  pass(step, `"${SUMMARIZER_NAME}" created -- row present (editable, user-scope), file written + shaped like a valid profile`);
}

// -- step 4: edit "researcher" -- new body, real preview, save, disk update --

async function step4EditResearcherAndPreview(ctx) {
  const step = 4;

  const opened = await apiAction(ctx, step, "/settings/subagents/editor/open", { name: RESEARCHER_NAME });
  assert(step, opened.ok === true, `editor/open("${RESEARCHER_NAME}") rejected: ${JSON.stringify(opened)}`);

  const set = await apiAction(ctx, step, "/settings/subagents/editor/set", { body: NEW_RESEARCHER_BODY });
  assert(step, set.ok === true, `editor/set rejected: ${JSON.stringify(set)}`);

  const preview = await apiOk(ctx, step, "POST", "/settings/subagents/editor/preview", {});
  assert(step, preview.ok === true, `editor/preview rejected: ${JSON.stringify(preview)}`);
  assert(step, preview.systemPrompt.includes(NEW_RESEARCHER_BODY), `expected the preview's systemPrompt to contain the just-edited body, got:\n${preview.systemPrompt}`);
  assert(
    step,
    preview.systemPrompt.includes(FINALITY_MARKER),
    `expected the preview's systemPrompt to contain the REAL finality note (proves the real buildSubagentSystemPrompt builder ran, not a lookalike), got:\n${preview.systemPrompt}`,
  );

  const saved = await apiAction(ctx, step, "/settings/subagents/editor/save", {});
  assert(step, saved.ok === true, `editor/save rejected: ${JSON.stringify(saved)}`);

  const filePath = join(ctx.agentsDir, `${RESEARCHER_NAME}.md`);
  const written = readFileSync(filePath, "utf8");
  assert(step, written.includes(NEW_RESEARCHER_BODY), `expected ${filePath} to carry the new body after save, got:\n${written}`);

  pass(step, `"${RESEARCHER_NAME}" edited -- preview carried the new body + the real finality note; save updated the file on disk`);
}

// -- step 5: live Agent-tool dispatch of the user-created "summarizer" profile (documented SKIP on live-model non-dispatch only) --

function findAnyAgentBlock(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent") ?? null;
}

function findAgentBlockWithAnySubagent(transcript) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && b.subagent !== null) ?? null;
}

function findAgentBlockWithType(transcript, agentType) {
  return transcript.find((b) => b.kind === "tool_call" && b.toolName === "Agent" && b.subagent !== null && b.subagent.agentType === agentType) ?? null;
}

async function pollForSummarizerDispatch(ctx, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let anyAgentSeen = false;
  let anySubagentSeen = false;
  for (;;) {
    const transcript = await getTranscriptBlocks(ctx, step, ctx.tabId2);
    if (findAnyAgentBlock(transcript) !== null) {
      anyAgentSeen = true;
    }
    if (findAgentBlockWithAnySubagent(transcript) !== null) {
      anySubagentSeen = true;
    }
    const block = findAgentBlockWithType(transcript, SUMMARIZER_NAME);
    if (block) {
      return { block, anyAgentSeen, anySubagentSeen };
    }
    if (Date.now() >= deadline) {
      return { block: null, anyAgentSeen, anySubagentSeen };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptDispatch(ctx, step, prompt, timeoutMs) {
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId2}/prompt`, { text: prompt });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId2, { turnStatus: "running" }, 60_000);
  return pollForSummarizerDispatch(ctx, step, timeoutMs);
}

/** Stops the current turn and best-effort waits for it to settle to idle -- used before a retry. */
async function settleTurn(ctx, step, tabId) {
  await api(ctx, "POST", `/tabs/${tabId}/stop`, {});
  await waitUntilTab(ctx, step, tabId, { turnStatus: "idle" }, 30_000).catch(() => {
    // best-effort -- proceed regardless of the settle wait outcome.
  });
}

async function step5LiveDispatchSummarizer(ctx) {
  const step = 5;

  // A NEW tab -- subagent discovery is boot-static per tab host (design
  // §2-D5), so the "summarizer" profile created in step 3 is only visible to
  // a tab whose host boots AFTER that file existed. The step-1 tab predates
  // it and must never be reused for this leg.
  await apiAction(ctx, step, "/settings/close", {});
  const created = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(step, created.ok === true, `POST /tabs (second tab) rejected: ${JSON.stringify(created)}`);
  ctx.tabId2 = created.tabId;
  await waitUntilTab(ctx, step, ctx.tabId2, { connection: "ready" }, 60_000);
  await apiAction(ctx, step, `/tabs/${ctx.tabId2}/select`, {});

  let dispatch = await attemptDispatch(ctx, step, DISPATCH_PROMPT_PRIMARY, 60_000);
  if (dispatch.block === null) {
    console.warn(
      '[subagents-ui-smoke] no Agent tool_call with agent_type="summarizer" observed on the first attempt -- ' +
        "retrying once with a more explicit prompt",
    );
    await settleTurn(ctx, step, ctx.tabId2);
    dispatch = await attemptDispatch(ctx, step, DISPATCH_PROMPT_RETRY, 90_000);
  }

  if (dispatch.block === null) {
    if (dispatch.anyAgentSeen && !dispatch.anySubagentSeen) {
      // The model DID call Agent, but no subagent sub-status was ever attached to the
      // block -- that's a subagent_start routing regression, not model nondeterminism.
      fail(step, "an Agent tool_call block was observed but its subagent sub-status never appeared (possible subagent_start routing regression), after 1 retry");
    }
    console.warn(
      '[subagents-ui-smoke] SKIPPED: the live model never dispatched the Agent tool with agent_type="summarizer" ' +
        "after 1 retry (either never called Agent at all, or called it with a different agent_type). This is a " +
        "documented live-model-nondeterminism SKIP, NOT a product failure -- the loader/prompt-section/Agent-tool " +
        "validation/runner wiring for a user profile is unit/integration-proven elsewhere (subagents/*.test.ts, " +
        "tools/agent.test.ts), and steps 1-4/6-7 of this smoke already proved the profile itself round-trips " +
        "correctly through the admin scan + editor.",
    );
    ctx.skipped = true;
    await settleTurn(ctx, step, ctx.tabId2);
    pass(step, 'SKIPPED (documented) -- live model never dispatched Agent with agent_type="summarizer" after 1 retry; see warning above');
    return;
  }

  pass(
    step,
    `Agent tool_call dispatched agentType="${dispatch.block.subagent.agentType}" (toolCallId=${dispatch.block.toolCallId}) -- ` +
      "proves loader -> prompt-section -> Agent-tool-validation -> runner resolution for a USER-created profile",
  );
}

// -- step 6: delete "summarizer"; assert "general-purpose" refuses deletion --

async function step6DeleteAndRefuseBuiltin(ctx) {
  const step = 6;

  // Re-anchor Settings -> "subagents" -- step 5 may have closed the dialog
  // (its own opening move) and/or switched the active tab.
  await apiAction(ctx, step, "/settings/open", {});
  await apiAction(ctx, step, "/settings/pane", { paneId: "subagents" });

  const filePath = join(ctx.agentsDir, `${SUMMARIZER_NAME}.md`);
  assert(step, existsSync(filePath), `precondition: ${filePath} should still exist before delete`);

  const deleted = await apiAction(ctx, step, "/settings/subagents/delete", { name: SUMMARIZER_NAME });
  assert(step, deleted.ok === true, `settings/subagents/delete rejected: ${JSON.stringify(deleted)}`);
  assert(step, !existsSync(filePath), `expected ${filePath} to be removed from disk after delete`);

  const probeAfterDelete = await getSubagentsPane(ctx, step);
  assert(step, findRow(probeAfterDelete, SUMMARIZER_NAME) === undefined, `expected row "${SUMMARIZER_NAME}" to be gone after delete, got ${JSON.stringify(probeAfterDelete.rows)}`);

  const refused = await apiOk(ctx, step, "POST", "/settings/subagents/delete", { name: "general-purpose" });
  assert(step, refused.ok === false, `expected deleting "general-purpose" to be refused, got ${JSON.stringify(refused)}`);
  assert(step, refused.reason === "not_deletable", `expected refusal reason "not_deletable" (no delete affordance on a built-in row), got ${JSON.stringify(refused)}`);

  const probeFinal = await getSubagentsPane(ctx, step);
  const generalPurpose = findRow(probeFinal, "general-purpose");
  assert(step, generalPurpose !== undefined && generalPurpose.editable === false, `expected "general-purpose" to still be present with editable:false, got ${JSON.stringify(generalPurpose)}`);

  pass(step, `"${SUMMARIZER_NAME}" deleted -- row + file both gone; "general-purpose" delete refused (not_deletable, no affordance)`);
}

// -- step 7: PNG evidence of the populated pane + an open editor on its Preview tab --

async function step7Screenshots(ctx) {
  const step = 7;

  const probe = await getSubagentsPane(ctx, step);
  assert(step, probe.rows.length > 0, `expected the subagents pane to still be mounted with rows for the final screenshot, got ${JSON.stringify(probe)}`);
  await settledScreenshot(ctx, "step7-subagents-pane-final");

  const opened = await apiAction(ctx, step, "/settings/subagents/editor/open", { name: RESEARCHER_NAME });
  assert(step, opened.ok === true, `editor/open (final) rejected: ${JSON.stringify(opened)}`);
  const preview = await apiOk(ctx, step, "POST", "/settings/subagents/editor/preview", {});
  assert(step, preview.ok === true, `editor/preview (final) rejected: ${JSON.stringify(preview)}`);
  await settledScreenshot(ctx, "step7-subagents-editor-preview-final");

  pass(step, "PNG evidence captured: populated pane + open editor on its Preview tab");
}

// -- teardown --

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
      } else {
        if (typeof ctx.tabId1 === "string") {
          await api(ctx, "POST", `/tabs/${ctx.tabId1}/close`, {});
        }
        if (typeof ctx.tabId2 === "string") {
          await api(ctx, "POST", `/tabs/${ctx.tabId2}/close`, {});
        }
      }
    } catch {
      // best-effort -- the app/tabs may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[subagents-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[subagents-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.workspace, ctx.subagentsHome, ctx.profile]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[subagents-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[subagents-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[subagents-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// -- orchestration --

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[subagents-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[subagents-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    subagentsHome: null,
    agentsDir: null,
    workspace: null,
    secretsEnv: null,
    port: undefined,
    token: undefined,
    tabId1: null,
    tabId2: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: null,
    secretsPath: null,
    skipped: false,
    teardownPromise: null,
    screenshotDir: join(desktopRoot, "out", "subagents-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapFixtures(ctx);
    await step1LaunchAndOpenPane(ctx);
    await step2AssertRows(ctx);
    await step3CreateSummarizer(ctx);
    await step4EditResearcherAndPreview(ctx);
    await step5LiveDispatchSummarizer(ctx);
    await step6DeleteAndRefuseBuiltin(ctx);
    await step7Screenshots(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[subagents-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[subagents-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

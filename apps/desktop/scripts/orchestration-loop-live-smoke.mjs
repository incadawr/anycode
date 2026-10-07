/**
 * Live smoke for the orchestration loop (Codex supervisor -> GLM lead):
 * a REAL dev instance, a REAL `codex` CLI supervisor and a REAL GLM child.
 *
 * Proves, end to end:
 *   1. the supervisor dispatches the lead with `detach: true` and its turn
 *      ends right after the dispatch (no in-turn tool calls = no polling);
 *   2. the child's report wakes the supervisor as a new turn;
 *   3. the supervisor returns a defect to the SAME child (`continue_session`)
 *      — main resumes the one child session instead of minting a second;
 *   4. the reworked result is accepted and the file on disk is correct.
 *
 * The defect is scripted (the brief withholds the second line until the
 * review), so the rework round is deterministic rather than hoping the lead
 * makes a mistake.
 *
 * Requires: ANYCODE_ORCH_LIVE_SMOKE=1, a signed-in ambient Codex account, and
 * GLM credentials in `.smoke-secrets/glm.env` (ANYCODE_API_KEY,
 * ANYCODE_BASE_URL). The secrets path can be overridden with
 * ANYCODE_SMOKE_SECRETS (a git worktree has no `.smoke-secrets` of its own).
 * Exit 0 = PASS, 1 = FAIL, 2 = SKIP. Evidence (transcript JSON) is written to
 * the printed temp profile directory, which is kept on failure or --keep.
 *
 * Usage:
 *   ANYCODE_ORCH_LIVE_SMOKE=1 node apps/desktop/scripts/orchestration-loop-live-smoke.mjs [--keep] [--no-chromium-sandbox]
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  api,
  apiOk,
  isPidAlive,
  killTree,
  parseEnvFile,
  readDiscoveryFile,
  sleep,
  waitForExit,
  waitForFacade,
} from "./child-session-explicit-provider-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const LOG = "[orchestration-loop-live-smoke]";
const KEEP = process.argv.includes("--keep");
const NO_CHROMIUM_SANDBOX = process.argv.includes("--no-chromium-sandbox");

const LAUNCH_TIMEOUT_MS = 180_000;
const CODEX_READY_TIMEOUT_MS = 60_000;
const LOOP_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 2_000;
const CONNECTION_ID = "conn-orch-smoke";
const GLM_MODEL = "glm-5.3";
const CODEX_NOT_READY = [
  "Configure a provider (API key + model) before opening a tab.",
  "Sign in to a Codex account in Settings → Codex before opening a tab.",
];

function log(message) {
  console.log(`${LOG} ${message}`);
}

class Failure extends Error {}
function check(cond, message) {
  if (!cond) throw new Failure(message);
}

function secretsPath() {
  if (process.env.ANYCODE_SMOKE_SECRETS) return process.env.ANYCODE_SMOKE_SECRETS;
  const local = join(repoRoot, ".smoke-secrets", "glm.env");
  if (existsSync(local)) return local;
  // A worktree under <main>/.anycode/worktrees/<name>: fall back to the main checkout.
  return join(repoRoot, "..", "..", "..", ".smoke-secrets", "glm.env");
}

function codexBin() {
  if (process.env.ANYCODE_CODEX_BIN) return process.env.ANYCODE_CODEX_BIN;
  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function seedWorkspace(ws) {
  execFileSync("git", ["init", "-q"], { cwd: ws });
  writeFileSync(join(ws, "README.md"), "# orchestration smoke\n");
  execFileSync("git", ["add", "."], { cwd: ws });
  execFileSync("git", ["-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "init"], { cwd: ws });
  mkdirSync(join(ws, ".anycode", "agents"), { recursive: true });
  copyFileSync(join(repoRoot, "examples", "orchestration", "glm-lead.md"), join(ws, ".anycode", "agents", "glm-lead.md"));
}

function supervisorPrompt() {
  return [
    "You are the supervisor in a validation run of AnyCode's orchestration loop. Follow these steps exactly.",
    "",
    "Step 1. Call the `anycode_agent` tool once with agent_type \"glm-lead\", description \"create greeting file\",",
    "detach true, and prompt: \"Create the file greeting.txt in the workspace root containing exactly one line: hello",
    "(with a trailing newline). Touch nothing else. Report the file content when done.\"",
    "Then end your turn immediately with one short sentence. Do not wait, poll, sleep, or check anything.",
    "",
    "Step 2. When the lead's report arrives (a new message containing its <agent-id>), read greeting.txt yourself.",
    "The real requirement is TWO lines: hello, then world. Return this as a defect to the SAME lead: call `anycode_agent`",
    "with agent_type \"glm-lead\", description \"add second line\", detach true, continue_session set to the <agent-id>",
    "from the report, and prompt: \"Defect 1: greeting.txt must contain exactly two lines, hello then world, each",
    "followed by a newline. Fix it and report the file content.\" Then end your turn immediately with one short sentence.",
    "",
    "Step 3. When the second report arrives, read greeting.txt yourself. If it is exactly hello and world on two lines,",
    "reply with the single word ACCEPT followed by one line of evidence. Otherwise reply BLOCKED with the reason.",
    "",
    "Never edit files yourself. Never run tests or anything else while the lead works.",
  ].join("\n");
}

async function launch(ctx) {
  const secrets = parseEnvFile(readFileSync(ctx.secretsPath, "utf8"));
  check(secrets.ANYCODE_API_KEY && secrets.ANYCODE_BASE_URL, `${ctx.secretsPath} lacks ANYCODE_API_KEY/ANYCODE_BASE_URL`);
  writeFileSync(
    ctx.settingsPath,
    JSON.stringify(
      {
        version: 2,
        provider: {
          activeConnectionId: CONNECTION_ID,
          connections: [{ id: CONNECTION_ID, providerId: "z-ai", model: GLM_MODEL }],
        },
        tools: {},
        permissions: {
          alwaysAllow: ["Agent", "Read", "Glob", "Grep", "Bash", "Write", "Edit", "MultiEdit"].map((toolName) => ({ toolName })),
        },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    ...secrets,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: join(ctx.profile, "user-data"),
    ANYCODE_DB_PATH: join(ctx.profile, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: ctx.discoveryPath,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: join(ctx.profile, "secrets.json"),
    ANYCODE_CODEX_PROFILES_HOME: ctx.profile,
    ANYCODE_CODEX_BIN: ctx.codexBin,
    ANYCODE_WORKSPACE: ctx.bootWs,
  };
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;
  const t0 = Date.now();
  // --no-chromium-sandbox: for a runner that is itself inside a macOS seatbelt
  // (e.g. an agent's shell), where Chromium cannot apply its own sandbox and
  // the GPU process dies at boot. Only this disposable dev instance is affected.
  const devArgs = ["--filter", "@anycode/desktop", "dev", ...(NO_CHROMIUM_SANDBOX ? ["--noSandbox"] : [])];
  ctx.child = spawn("pnpm", devArgs, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  const deadline = t0 + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    check(ctx.child.exitCode === null && ctx.child.signalCode === null, "dev process exited before publishing discovery");
    const info = readDiscoveryFile(ctx.discoveryPath);
    if (info !== null && info.startedAt > t0 && isPidAlive(info.pid)) {
      ctx.port = info.port;
      ctx.token = info.token;
      ctx.appPid = info.pid;
      log(`app up (pid ${info.pid}) after ${Date.now() - t0}ms`);
      return;
    }
    await sleep(500);
  }
  throw new Failure("timed out waiting for the automation discovery file");
}

async function createCodexSession(ctx) {
  await apiOk(ctx, 2, "POST", "/start-screen/open", { workspace: ctx.ws });
  await apiOk(ctx, 2, "POST", "/start-screen/engine", { engineId: "codex" });
  await apiOk(ctx, 2, "POST", "/start-screen/prompt", { text: supervisorPrompt() });
  const deadline = Date.now() + CODEX_READY_TIMEOUT_MS;
  for (;;) {
    const submitted = await apiOk(ctx, 2, "POST", "/start-screen/submit", {});
    if (submitted?.ok === true) {
      ctx.tabId = submitted.tabId;
      log(`codex supervisor tab ${ctx.tabId}`);
      return;
    }
    check(CODEX_NOT_READY.includes(submitted?.message) && Date.now() < deadline, `codex session refused: ${JSON.stringify(submitted)}`);
    await sleep(500);
  }
}

async function state(ctx) {
  const resp = await api(ctx, "GET", "/state");
  check(resp.status === 200, `GET /state -> ${resp.status}`);
  return resp.body;
}

/** Approves whatever permission prompt is pending on any tab, so neither model blocks on the UI. */
async function allowPendingPermissions(ctx, body) {
  const states = body?.snapshot?.states ?? {};
  for (const [tabId, tabState] of Object.entries(states)) {
    if (tabState?.permission !== null && tabState?.permission !== undefined) {
      const resp = await api(ctx, "POST", `/tabs/${tabId}/permission`, { behavior: "allow" });
      log(`auto-allowed a permission on tab ${tabId} -> ${resp.status}`);
    }
  }
}

function lastAssistantText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const block = transcript[i];
    if (block.kind === "assistant_text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function isAgentCall(block) {
  return block.kind === "tool_call" && /anycode_agent|^agent$|^Agent$/.test(String(block.toolName ?? ""));
}

async function runLoop(ctx) {
  const deadline = Date.now() + LOOP_TIMEOUT_MS;
  let lastLen = -1;
  for (;;) {
    const body = await state(ctx);
    await allowPendingPermissions(ctx, body);
    const tab = body?.snapshot?.states?.[ctx.tabId];
    const transcript = Array.isArray(tab?.transcript) ? tab.transcript : [];
    if (transcript.length !== lastLen) {
      lastLen = transcript.length;
      const agentCalls = transcript.filter(isAgentCall).length;
      log(`supervisor transcript: ${transcript.length} blocks, ${agentCalls} anycode_agent call(s), turn=${tab?.turn?.status ?? "?"}`);
    }
    const text = lastAssistantText(transcript);
    const idle = tab?.turn?.status === "idle";
    const childRunsLive = Array.isArray(body?.childRuns) ? body.childRuns.length : 0;
    if (idle && childRunsLive === 0 && /\b(ACCEPT|BLOCKED)\b/.test(text)) {
      ctx.finalText = text;
      ctx.transcript = transcript;
      return;
    }
    check(Date.now() < deadline, `loop did not reach ACCEPT/BLOCKED within ${LOOP_TIMEOUT_MS}ms (last text: ${text.slice(0, 200)})`);
    await sleep(POLL_MS);
  }
}

async function verify(ctx) {
  const transcript = ctx.transcript;
  writeFileSync(join(ctx.profile, "supervisor-transcript.json"), JSON.stringify(transcript, null, 2));
  check(/\bACCEPT\b/.test(ctx.finalText), `supervisor did not accept: ${ctx.finalText.slice(0, 300)}`);

  const greeting = readFileSync(join(ctx.ws, "greeting.txt"), "utf8");
  check(greeting.replace(/\r\n/g, "\n").trimEnd() === "hello\nworld", `greeting.txt is ${JSON.stringify(greeting)}`);

  const calls = transcript.filter(isAgentCall);
  check(calls.length === 2, `expected 2 anycode_agent calls, saw ${calls.length}`);
  const [first, second] = calls;
  check(first.input?.detach === true, `first dispatch not detached: ${JSON.stringify(first.input)}`);
  check(second.input?.detach === true, `follow-up not detached: ${JSON.stringify(second.input)}`);
  check(typeof second.input?.continue_session === "string", `follow-up did not continue the child: ${JSON.stringify(second.input)}`);

  // Polling check: after each dispatch, nothing else runs in the same turn —
  // the next block that is not assistant text must be the child's report
  // (a user-side message), never another tool call.
  for (const call of calls) {
    const index = transcript.indexOf(call);
    const after = transcript.slice(index + 1);
    const nextTurnStart = after.findIndex((b) => b.kind !== "assistant_text" && b.kind !== "tool_call" && b.kind !== "reasoning");
    const sameTurn = nextTurnStart === -1 ? after : after.slice(0, nextTurnStart);
    const extraTools = sameTurn.filter((b) => b.kind === "tool_call");
    check(extraTools.length === 0, `supervisor kept working after a detached dispatch: ${extraTools.map((b) => b.toolName).join(", ")}`);
  }

  const runs = await apiOk(ctx, 4, "GET", "/child-runs");
  const rows = Array.isArray(runs?.sessions) ? runs.sessions : [];
  writeFileSync(join(ctx.profile, "child-runs.json"), JSON.stringify(runs, null, 2));
  const childIds = new Set(rows.map((r) => r.id));
  check(childIds.size === 1, `expected exactly 1 child session (continued, not re-spawned), saw ${childIds.size}`);
  check(childIds.has(second.input.continue_session), `continue_session ${second.input.continue_session} is not the child row ${[...childIds]}`);
  log(`PASS: 2 detached dispatches, 0 in-turn tool calls after dispatch, 1 child session continued, file correct`);
}

async function teardown(ctx, ok) {
  if (ctx.port !== undefined) {
    await api(ctx, "POST", "/quit", {}).catch(() => {});
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, 15_000);
    if (!exited && ctx.child.pid) killTree(ctx.child.pid, "SIGKILL");
  }
  if (ok && !KEEP) {
    for (const dir of [ctx.profile, ctx.ws, ctx.bootWs]) rmSync(dir, { recursive: true, force: true });
  } else {
    log(`kept: profile=${ctx.profile} workspace=${ctx.ws}`);
  }
}

async function main() {
  if (process.env.ANYCODE_ORCH_LIVE_SMOKE !== "1") {
    log("SKIP: set ANYCODE_ORCH_LIVE_SMOKE=1 to run (spends real Codex and GLM quota)");
    process.exit(2);
  }
  const ctx = { secretsPath: secretsPath(), codexBin: codexBin() };
  if (!existsSync(ctx.secretsPath)) {
    log(`SKIP: no GLM credentials at ${ctx.secretsPath}`);
    process.exit(2);
  }
  if (!ctx.codexBin) {
    log("SKIP: no codex binary (set ANYCODE_CODEX_BIN)");
    process.exit(2);
  }
  ctx.profile = mkdtempSync(join(tmpdir(), "anycode-orch-smoke-profile-"));
  ctx.ws = mkdtempSync(join(tmpdir(), "anycode-orch-smoke-ws-"));
  ctx.bootWs = mkdtempSync(join(tmpdir(), "anycode-orch-smoke-boot-"));
  ctx.settingsPath = join(ctx.profile, "settings.json");
  ctx.discoveryPath = join(ctx.profile, "automation.json");
  seedWorkspace(ctx.ws);

  let ok = false;
  try {
    await launch(ctx);
    await waitForFacade(ctx, 1);
    await createCodexSession(ctx);
    await runLoop(ctx);
    await verify(ctx);
    ok = true;
  } catch (error) {
    log(`FAIL: ${error?.message ?? error}`);
    if (ctx.port !== undefined) {
      const body = await state(ctx).catch(() => null);
      const transcript = body?.snapshot?.states?.[ctx.tabId]?.transcript;
      if (transcript) writeFileSync(join(ctx.profile, "supervisor-transcript.json"), JSON.stringify(transcript, null, 2));
    }
  } finally {
    await teardown(ctx, ok);
  }
  process.exit(ok ? 0 : 1);
}

await main();

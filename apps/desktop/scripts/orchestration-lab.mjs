/**
 * Orchestration lab: run a REAL Codex supervisor + GLM lead on a real task in a
 * dev instance, and watch it from outside (a coding agent or a human).
 *
 * Dev-only, like every automation script: needs ANYCODE_AUTOMATION (set here)
 * and never touches a packaged app. State lives in the lab directory
 * (default $TMPDIR/anycode-orch-lab, override with --lab <dir>).
 *
 *   start   --workspace <dir> --brief <file> [--no-chromium-sandbox]
 *           launch the app (detached, outlives this script), open a Codex tab
 *           on <dir> and send <file> as its first prompt.
 *   task    --workspace <dir> --brief <file>
 *           open a NEW Codex supervisor tab in the already running app (no
 *           relaunch — keeps the sandbox of an app the owner started from a
 *           terminal) and make it the lab's supervisor.
 *   watch   [--quiet-min N]  poll until something worth a look happens, print
 *           it and exit 0: supervisor turn ended, a child started/finished,
 *           a permission is pending, a tab repeats the same tool call, nothing
 *           moved for N minutes (default 8), or the app is gone (exit 3).
 *   show    [tabId] [--last N]  compact transcript of a tab (default: supervisor).
 *   child   [sessionId-prefix] [--last N]  compact history of a child session
 *           (from the lab DB; child tabs are not in the renderer snapshot).
 *   tabs    list tabs with turn status and transcript size.
 *   allow|deny <tabId>   answer the pending permission.
 *   send    <tabId> <text>   send a prompt to a tab.
 *   stop    <tabId>      stop the running turn.
 *   quit    close the app.
 *
 * Credentials: GLM from .smoke-secrets/glm.env (or ANYCODE_SMOKE_SECRETS),
 * Codex = the ambient signed-in account.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { api, isPidAlive, parseEnvFile, readDiscoveryFile, sleep } from "./child-session-explicit-provider-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const argv = process.argv.slice(2);
const command = argv[0];

function flag(name) {
  return argv.includes(name);
}
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const VALUE_OPTS = new Set(["--workspace", "--brief", "--lab", "--quiet-min", "--last", "--width"]);
function positional(n) {
  return argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_OPTS.has(argv[i - 1])))[n];
}

const LAB = resolve(opt("--lab", join(tmpdir(), "anycode-orch-lab")));
const LAB_FILE = join(LAB, "lab.json");
const EVENTS = join(LAB, "events.log");
const CONNECTION_ID = "conn-orch-lab";
const GLM_MODEL = "glm-5.3";

function now() {
  return new Date().toISOString().slice(11, 19);
}
function event(line) {
  const text = `${now()} ${line}`;
  appendFileSync(EVENTS, text + "\n");
  console.log(text);
}
function readLab() {
  if (!existsSync(LAB_FILE)) throw new Error(`no lab at ${LAB} (run start first)`);
  return JSON.parse(readFileSync(LAB_FILE, "utf8"));
}
function writeLab(lab) {
  writeFileSync(LAB_FILE, JSON.stringify(lab, null, 2));
}
function ctxOf(lab) {
  const info = readDiscoveryFile(lab.discoveryPath);
  if (info === null || !isPidAlive(info.pid)) return null;
  return { port: info.port, token: info.token, pid: info.pid };
}

function secretsPath() {
  if (process.env.ANYCODE_SMOKE_SECRETS) return process.env.ANYCODE_SMOKE_SECRETS;
  const local = join(repoRoot, ".smoke-secrets", "glm.env");
  if (existsSync(local)) return local;
  return join(repoRoot, "..", "..", "..", ".smoke-secrets", "glm.env");
}

async function start() {
  const workspace = resolve(opt("--workspace", ""));
  const briefPath = opt("--brief");
  if (!existsSync(workspace) || !briefPath || !existsSync(briefPath)) throw new Error("need --workspace <dir> and --brief <file>");
  mkdirSync(LAB, { recursive: true });
  const secrets = parseEnvFile(readFileSync(secretsPath(), "utf8"));
  const lab = {
    workspace,
    discoveryPath: join(LAB, "automation.json"),
    settingsPath: join(LAB, "settings.json"),
    startedAt: Date.now(),
  };
  writeFileSync(
    lab.settingsPath,
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
  const codexBin = process.env.ANYCODE_CODEX_BIN ?? execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  const env = {
    ...process.env,
    ...secrets,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: join(LAB, "user-data"),
    ANYCODE_DB_PATH: join(LAB, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: lab.discoveryPath,
    ANYCODE_SETTINGS_PATH: lab.settingsPath,
    ANYCODE_SECRETS_PATH: join(LAB, "secrets.json"),
    ANYCODE_CODEX_PROFILES_HOME: LAB,
    ANYCODE_CODEX_BIN: codexBin,
    ANYCODE_WORKSPACE: workspace,
  };
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;
  const out = openSync(join(LAB, "app.log"), "a");
  const devArgs = ["--filter", "@anycode/desktop", "dev", ...(flag("--no-chromium-sandbox") ? ["--noSandbox"] : [])];
  const child = spawn("pnpm", devArgs, { cwd: repoRoot, env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  lab.devPid = child.pid;
  const deadline = Date.now() + 180_000;
  let ctx = null;
  while (Date.now() < deadline) {
    const info = readDiscoveryFile(lab.discoveryPath);
    if (info !== null && info.startedAt > lab.startedAt && isPidAlive(info.pid)) {
      ctx = { port: info.port, token: info.token };
      break;
    }
    await sleep(500);
  }
  if (ctx === null) throw new Error(`app did not come up; see ${join(LAB, "app.log")}`);
  // Wait for the renderer facade.
  for (let i = 0; i < 90; i += 1) {
    const r = await api(ctx, "GET", "/state").catch(() => ({ status: 0 }));
    if (r.status === 200) break;
    await sleep(500);
  }
  await api(ctx, "POST", "/start-screen/open", { workspace });
  await api(ctx, "POST", "/start-screen/engine", { engineId: "codex" });
  await api(ctx, "POST", "/start-screen/prompt", { text: readFileSync(briefPath, "utf8") });
  for (let i = 0; i < 120; i += 1) {
    const r = await api(ctx, "POST", "/start-screen/submit", {});
    if (r.body?.ok === true) {
      lab.supervisorTabId = r.body.tabId;
      break;
    }
    await sleep(500);
  }
  if (!lab.supervisorTabId) throw new Error("codex tab was not created");
  writeLab(lab);
  event(`START supervisor tab ${lab.supervisorTabId} on ${workspace}`);
}

async function task() {
  const workspace = resolve(opt("--workspace", ""));
  const briefPath = opt("--brief");
  if (!existsSync(workspace) || !briefPath || !existsSync(briefPath)) throw new Error("need --workspace <dir> and --brief <file>");
  const lab = readLab();
  const ctx = ctxOf(lab);
  if (ctx === null) throw new Error("app is not running (the owner launches it; do not relaunch from here)");
  await api(ctx, "POST", "/start-screen/open", { workspace });
  await api(ctx, "POST", "/start-screen/engine", { engineId: "codex" });
  await api(ctx, "POST", "/start-screen/prompt", { text: readFileSync(briefPath, "utf8") });
  let tabId = null;
  for (let i = 0; i < 120; i += 1) {
    const r = await api(ctx, "POST", "/start-screen/submit", {});
    if (r.body?.ok === true) {
      tabId = r.body.tabId;
      break;
    }
    await sleep(500);
  }
  if (tabId === null) throw new Error("codex tab was not created");
  writeLab({ ...lab, workspace, supervisorTabId: tabId });
  event(`TASK supervisor tab ${tabId} on ${workspace}`);
  console.log(tabId);
}

/** Child tabs are not in the renderer snapshot; their history is in the lab DB. */
function sqlite(query) {
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", join(LAB, "db.sqlite"), query], { encoding: "utf8" });
    return out.trim() === "" ? [] : JSON.parse(out);
  } catch {
    return [];
  }
}
function childSessions() {
  return sqlite("select id, model, parent_session_id as parent from sessions where parent_session_id is not null order by created_at");
}
function childHistory(sessionId) {
  return sqlite(`select seq, data from history_items where session_id = '${sessionId.replace(/'/g, "")}' order by seq`).map((row) => {
    try {
      return JSON.parse(row.data).message ?? {};
    } catch {
      return {};
    }
  });
}
function childToolCalls(messages) {
  const calls = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === "tool_call") calls.push({ toolName: part.toolName, input: part.input });
    }
  }
  return calls;
}

function blockSig(b) {
  return `${b.toolName}:${JSON.stringify(b.input ?? {})}`;
}
function toolCalls(transcript) {
  return transcript.filter((b) => b.kind === "tool_call");
}
function lastText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) if (transcript[i].kind === "assistant_text") return transcript[i].text ?? "";
  return "";
}

async function watch() {
  const lab = readLab();
  const quietMs = Number(opt("--quiet-min", "8")) * 60_000;
  const prevFile = join(LAB, "watch-state.json");
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, "utf8")) : { tabs: {}, children: [], repeats: {} };
  let lastChange = Date.now();
  let lastSizes = null;
  for (;;) {
    const ctx = ctxOf(lab);
    if (ctx === null) {
      event("APP GONE");
      process.exit(3);
    }
    const r = await api(ctx, "GET", "/state").catch(() => null);
    if (r === null || r.status !== 200) {
      await sleep(3000);
      continue;
    }
    const states = r.body?.snapshot?.states ?? {};
    writeFileSync(join(LAB, "state.json"), JSON.stringify(r.body, null, 2));
    const reasons = [];
    const sizes = {};
    for (const [tabId, st] of Object.entries(states)) {
      const transcript = Array.isArray(st?.transcript) ? st.transcript : [];
      const status = st?.turn?.status ?? "?";
      sizes[tabId] = `${transcript.length}:${status}`;
      const was = prev.tabs[tabId];
      const who = tabId === lab.supervisorTabId ? "supervisor" : `tab ${tabId.slice(0, 8)}`;
      if (was === undefined) reasons.push(`${who} appeared (${status})`);
      else if (was.status !== "idle" && status === "idle") reasons.push(`${who} turn ended: ${lastText(transcript).slice(0, 300).replace(/\n/g, " ")}`);
      else if (was.status !== status && status !== "running") reasons.push(`${who} turn ${was.status} -> ${status}`);
      if (st?.permission) reasons.push(`${who} PERMISSION pending: ${JSON.stringify(st.permission).slice(0, 400)}`);
      const recent = toolCalls(transcript).slice(-10).map(blockSig);
      const counts = {};
      for (const s of recent) counts[s] = (counts[s] ?? 0) + 1;
      for (const [s, c] of Object.entries(counts)) {
        const key = `${tabId}|${s}`;
        if (c >= 3 && (prev.repeats[key] ?? 0) < c) {
          reasons.push(`${who} REPEATS x${c}: ${s.slice(0, 200)}`);
          prev.repeats[key] = c;
        }
      }
      prev.tabs[tabId] = { status, len: transcript.length };
    }
    for (const child of childSessions()) {
      const messages = childHistory(child.id);
      const calls = childToolCalls(messages);
      sizes[`child:${child.id}`] = messages.length;
      const who = `child ${child.id.slice(0, 8)}`;
      const counts = {};
      for (const s of calls.slice(-12).map(blockSig)) counts[s] = (counts[s] ?? 0) + 1;
      for (const [s, c] of Object.entries(counts)) {
        const key = `${child.id}|${s}`;
        if (c >= 3 && (prev.repeats[key] ?? 0) < c) {
          reasons.push(`${who} REPEATS x${c}: ${s.slice(0, 200)}`);
          prev.repeats[key] = c;
        }
      }
    }
    const children = (Array.isArray(r.body?.childRuns) ? r.body.childRuns : []).map((c) => c.childSessionId ?? c.id ?? JSON.stringify(c).slice(0, 60));
    for (const c of children) if (!prev.children.includes(c)) reasons.push(`child run started ${c}`);
    for (const c of prev.children) if (!children.includes(c)) reasons.push(`child run ended ${c}`);
    prev.children = children;
    const sizeKey = JSON.stringify(sizes);
    if (sizeKey !== lastSizes) {
      lastSizes = sizeKey;
      lastChange = Date.now();
    }
    if (reasons.length === 0 && Date.now() - lastChange > quietMs) reasons.push(`QUIET for ${Math.round(quietMs / 60000)} min: ${sizeKey}`);
    writeFileSync(prevFile, JSON.stringify(prev));
    if (reasons.length > 0) {
      for (const reason of reasons) event(reason);
      process.exit(0);
    }
    await sleep(3000);
  }
}

function clip(v, n) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "" : s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
}

async function show() {
  const lab = readLab();
  const ctx = ctxOf(lab);
  if (ctx === null) throw new Error("app is not running");
  const r = await api(ctx, "GET", "/state");
  const tabId = positional(1) ?? lab.supervisorTabId;
  const st = r.body?.snapshot?.states?.[tabId];
  if (!st) throw new Error(`no tab ${tabId}`);
  const transcript = st.transcript ?? [];
  const last = Number(opt("--last", "40"));
  const width = Number(opt("--width", "400"));
  console.log(`tab ${tabId} turn=${st.turn?.status} blocks=${transcript.length}`);
  transcript.slice(-last).forEach((b, i) => {
    const n = transcript.length - Math.min(last, transcript.length) + i;
    if (b.kind === "tool_call") {
      console.log(`#${n} CALL ${b.toolName} ${clip(b.input, width)}${b.status ? ` [${b.status}]` : ""}`);
      if (b.result !== undefined || b.output !== undefined) console.log(`     -> ${clip(b.result ?? b.output, width)}`);
    } else {
      console.log(`#${n} ${b.kind} ${clip(b.text ?? b, width)}`);
    }
  });
}

async function child() {
  const all = childSessions();
  const id = positional(1) ?? all.at(-1)?.id;
  if (!id) throw new Error("no child sessions");
  const full = all.find((c) => c.id.startsWith(id))?.id ?? id;
  const messages = childHistory(full);
  const last = Number(opt("--last", "30"));
  const width = Number(opt("--width", "300"));
  console.log(`child ${full} messages=${messages.length} toolCalls=${childToolCalls(messages).length}`);
  messages.slice(-last).forEach((m, i) => {
    const n = messages.length - Math.min(last, messages.length) + i;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    for (const part of parts) {
      if (part.type === "tool_call") console.log(`#${n} CALL ${part.toolName} ${clip(part.input, width)}`);
      else if (part.type === "tool_result") console.log(`#${n}   -> ${part.toolName} ${clip(part.text ?? part, width)}`);
      else console.log(`#${n} ${m.role} ${part.type} ${clip(part.text ?? part, width)}`);
    }
  });
}

async function tabs() {
  const lab = readLab();
  const ctx = ctxOf(lab);
  if (ctx === null) throw new Error("app is not running");
  const r = await api(ctx, "GET", "/state");
  for (const [tabId, st] of Object.entries(r.body?.snapshot?.states ?? {})) {
    const t = st.transcript ?? [];
    console.log(`${tabId} ${tabId === lab.supervisorTabId ? "SUPERVISOR " : ""}turn=${st.turn?.status} blocks=${t.length} tools=${toolCalls(t).length}${st.permission ? " PERMISSION" : ""}`);
  }
  console.log(`childRuns: ${clip(r.body?.childRuns ?? [], 1000)}`);
}

async function simple(method, pathFor, bodyFor) {
  const lab = readLab();
  const ctx = ctxOf(lab);
  if (ctx === null) throw new Error("app is not running");
  const r = await api(ctx, method, pathFor(lab), bodyFor(lab));
  event(`${command} ${positional(1) ?? ""} -> ${r.status} ${clip(r.body, 300)}`);
}

const handlers = {
  start,
  task,
  watch,
  show,
  child,
  tabs,
  allow: () => simple("POST", () => `/tabs/${positional(1)}/permission`, () => ({ behavior: "allow" })),
  deny: () => simple("POST", () => `/tabs/${positional(1)}/permission`, () => ({ behavior: "deny" })),
  send: () => simple("POST", () => `/tabs/${positional(1)}/prompt`, () => ({ text: argv.slice(2).join(" ") })),
  stop: () => simple("POST", () => `/tabs/${positional(1)}/stop`, () => ({})),
  quit: () => simple("POST", () => "/quit", () => ({})),
};

const handler = handlers[command];
if (!handler) {
  console.error("usage: orchestration-lab.mjs start|watch|show|tabs|allow|deny|send|stop|quit (see header)");
  process.exit(2);
}
try {
  await handler();
} catch (error) {
  console.error(`orchestration-lab: ${error?.message ?? error}`);
  process.exit(1);
}

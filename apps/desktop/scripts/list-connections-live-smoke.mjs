/** Live two-connection routing smoke. Usage: node apps/desktop/scripts/list-connections-live-smoke.mjs [--attach <profile>] [--keep] [--port <port>]
 * --attach uses only the specified disposable profile from a prior --keep run.
 * Credentials are read at runtime and written only to the disposable profile.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, readDiscoveryFile, isPidAlive, sleep, waitForExit, killTree, canonPath } from "./child-session-explicit-provider-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const glmId = "conn-list-smoke-glm";
const dsId = "conn-list-smoke-deepseek";
const label = "Smoke DeepSeek";
const args = process.argv.slice(2);
let attach, port, keep = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--keep") keep = true;
  else if (args[i] === "--attach" && args[i + 1]) attach = resolve(args[++i]);
  else if (args[i] === "--port" && args[i + 1]) port = args[++i];
  else throw new Error("Usage: [--attach <disposable-profile>] [--keep] [--port <port>]");
}
let step = 1, profile, workspace, child, info, tabId, teardownPromise;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const pass = (message) => console.log(`[step ${step}] PASS ${message}`);
async function request(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method, headers: { Authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(res.ok, `${method} ${path} returned HTTP ${res.status}`);
  return res.json();
}
async function poll(fn, timeout) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await sleep(300); } while (Date.now() < end);
  return null;
}
async function teardown() {
  if (teardownPromise) return teardownPromise;
  teardownPromise = (async () => {
    if (info && child) { try { await request("POST", "/quit", {}); } catch {} }
    else if (info && tabId) { try { await request("POST", `/tabs/${tabId}/close`, {}); } catch {} }
    if (child && !(await waitForExit(child, 15000))) {
      killTree(child.pid, "SIGTERM"); await sleep(750);
      if (isPidAlive(child.pid)) { killTree(child.pid, "SIGKILL"); await waitForExit(child, 5000); }
    }
    if (workspace && !keep && (!child || child.exitCode !== null || child.signalCode !== null)) rmSync(workspace, { recursive: true, force: true });
    if (profile && !attach && !keep && (!child || child.exitCode !== null || child.signalCode !== null)) rmSync(profile, { recursive: true, force: true });
    if (keep && profile) console.log(`Disposable profile: ${profile}`);
  })();
  return teardownPromise;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void teardown().finally(() => process.exit(1)); });

async function run() {
  const glm = parseEnvFile(readFileSync(join(root, ".smoke-secrets/glm.env"), "utf8"));
  const ds = parseEnvFile(readFileSync(join(root, ".smoke-secrets/deepseek.env"), "utf8"));
  check(glm.ANYCODE_API_KEY && glm.ANYCODE_BASE_URL && glm.ANYCODE_MODEL && ds.ANYCODE_API_KEY && ds.ANYCODE_BASE_URL, "missing required smoke credentials or model");
  check(ds.ANYCODE_BASE_URL === "https://api.deepseek.com/anthropic", "unexpected DeepSeek endpoint");
  workspace = mkdtempSync(join(tmpdir(), "anycode-list-connections-ws-"));
  writeFileSync(join(workspace, "README.md"), "# Disposable smoke workspace\n");
  profile = attach || mkdtempSync(join(tmpdir(), "anycode-list-connections-profile-"));
  if (attach) {
    check(attach.startsWith(join(tmpdir(), "anycode-list-connections-profile-")), "--attach requires a disposable smoke profile");
    info = readDiscoveryFile(join(profile, "automation.json"));
    check(info && isPidAlive(info.pid), "disposable profile has no live discovery record");
  } else {
    const settings = { version: 2, provider: { activeConnectionId: glmId, connections: [
      { id: glmId, providerId: "z-ai", label: "Smoke GLM", model: glm.ANYCODE_MODEL, baseUrl: glm.ANYCODE_BASE_URL },
      { id: dsId, providerId: "deepseek", label, model: "deepseek-flash", baseUrl: ds.ANYCODE_BASE_URL },
    ] }, tools: {}, permissions: { alwaysAllow: [{ toolName: "Agent" }] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: true } };
    writeFileSync(join(profile, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
    writeFileSync(join(profile, "secrets.json"), JSON.stringify({ version: 1, entries: {
      [`provider.connection.${glmId}.apiKey`]: { cipher: "plaintext", value: glm.ANYCODE_API_KEY },
      [`provider.connection.${dsId}.apiKey`]: { cipher: "plaintext", value: ds.ANYCODE_API_KEY },
    } }), { mode: 0o600 });
    const env = { ...process.env, ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"), ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"), ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"), ANYCODE_WORKSPACE: workspace, ANYCODE_TELEMETRY_DIR: join(profile, "telemetry"), ANYCODE_SUBAGENTS_HOME: profile, ANYCODE_PROFILE_HOME: profile, ANYCODE_CODEX_PROFILES_HOME: profile, ANYCODE_MCP_IMPORT_HOME: profile, ANYCODE_SKILLS_IMPORT_HOME: profile, CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home") };
    for (const key of ["ANYCODE_API_KEY", "ANYCODE_BASE_URL", "ANYCODE_MODEL", "ANYCODE_REASONING_EFFORT", "ANYCODE_AUTOMATION_PORT"]) delete env[key];
    if (port) env.ANYCODE_AUTOMATION_PORT = port;
    const started = Date.now();
    child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], { cwd: root, env, stdio: "ignore", detached: process.platform !== "win32" });
    info = await poll(() => { const candidate = readDiscoveryFile(join(profile, "automation.json")); return candidate && candidate.startedAt > started && isPidAlive(candidate.pid) ? candidate : null; }, 120000);
    check(info, "dev instance did not publish discovery");
  }
  const ready = await poll(async () => { try { return await request("GET", "/state?tail=0"); } catch { return null; } }, 45000);
  check(ready, "automation facade did not become ready");
  if (attach) {
    const created = await request("POST", "/tabs", { kind: "new", workspace });
    check(created.ok && created.tabId, "could not create tab"); tabId = created.tabId;
  } else {
    tabId = await poll(async () => { const s = await request("GET", "/state"); return Object.entries(s.snapshot?.states ?? {}).find(([, v]) => typeof v.workspace === "string" && canonPath(v.workspace) === canonPath(workspace))?.[0]; }, 90000);
  }
  check(tabId, "workspace tab missing");
  const wait = await request("POST", "/wait", { tabId, until: { connection: "ready" }, timeoutMs: 90000 });
  check(wait.matched, "parent tab not ready");
  pass("isolated profile booted with GLM active and DeepSeek configured");
  step = 2;
  const prompt = `Call ListConnections first. From its result find the connection labelled "${label}". Then call Agent with tier "session", provider set to that returned connection's id, agent_type "general-purpose", a short description, and a prompt asking the child to reply DONE without tools. Make both real tool calls.`;
  let snapshot;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = await request("POST", `/tabs/${tabId}/prompt`, { text: attempt ? `Retry now: ${prompt}` : prompt });
    check(sent.ok, "prompt rejected");
    snapshot = await poll(async () => {
      const s = await request("GET", "/state");
      const blocks = s.snapshot?.states?.[tabId]?.transcript ?? [];
      const list = blocks.find(b => b.kind === "tool_call" && b.toolName === "ListConnections" && b.modelText !== null);
      const agents = blocks.filter(b => b.kind === "tool_call" && b.toolName === "Agent");
      const agent = agents.length === 1 && agents[0].input?.tier === "session" && agents[0].input?.provider === dsId ? agents[0] : null;
      return list && agent && blocks.indexOf(list) < blocks.indexOf(agent) ? { s, list, agent } : null;
    }, attempt ? 90000 : 60000);
    if (snapshot) break;
    if (!attempt) { try { await request("POST", `/tabs/${tabId}/stop`, {}); await request("POST", "/wait", { tabId, until: { turnStatus: "idle" }, timeoutMs: 30000 }); } catch {} }
  }
  check(snapshot, "ListConnections and a DeepSeek Agent child were not observed after one retry");
  pass("parent called ListConnections and Agent using the returned DeepSeek connection id");
  step = 3;
  check(snapshot.list.status === "success" && typeof snapshot.list.modelText === "string", "ListConnections did not succeed");
  const raw = snapshot.list.modelText;
  for (const secret of [glm.ANYCODE_API_KEY, ds.ANYCODE_API_KEY, glm.ANYCODE_BASE_URL, ds.ANYCODE_BASE_URL]) check(!raw.includes(secret), "ListConnections result contains secret or endpoint material");
  check(!/api[_-]?key|base[_-]?url|secret|https?:\/\//i.test(raw), "ListConnections result contains a secret or endpoint field");
  let data; try { data = JSON.parse(raw); } catch { throw new Error("ListConnections result is not JSON"); }
  check(Array.isArray(data.connections), "ListConnections result lacks connections");
  check(data.connections.some(c => c.id === glmId && c.providerId === "z-ai") && data.connections.some(c => c.id === dsId && c.providerId === "deepseek" && c.label === label), "ListConnections result lacks seeded connections");
  pass("tool result lists both connections without keys, URLs, or secret fields");
  step = 4;
  const parent = snapshot.s.tabs?.find(t => t.tabId === tabId);
  const childId = /child session ([0-9a-f-]{36})/i.exec(snapshot.agent.modelText ?? "")?.[1];
  check(parent && childId, "Agent result did not report a child session under the parent");
  const row = await poll(async () => { const result = await request("GET", "/child-runs"); check(result.ok, "child-runs unavailable"); return result.sessions?.find(s => s.id === childId); }, 30000);
  check(row && row.connectionId === dsId && row.connectionId !== glmId && row.parentSessionId === parent.sessionId, "persisted child row does not carry the DeepSeek route");
  pass("child session started and its persisted row carries the DeepSeek connection id");
}
try { await run(); } catch (err) { console.error(`[step ${step}] FAIL ${err.message}`); process.exitCode = 1; } finally { await teardown(); }

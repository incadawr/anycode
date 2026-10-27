/**
 * Taskana 4896 — LIVE acceptance driver (brief /tmp/anycode-night/lab/briefs/live-4896.md).
 * Plain node >=22 (node:sqlite), zero npm deps. Launches the dev app from this
 * worktree with an isolated /tmp/anycode-live/4896 profile, then drives the
 * 5-step scenario over the automation HTTP channel. Temporary; delete after the run.
 *
 * Usage: node live-4896.mjs
 * Secrets are read from the repo's .smoke-secrets/deepseek.env into env only.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const WT = resolve(here, "..", "..", "..");
const LAB = "/tmp/anycode-live/4896";
const SECRETS = "/Users/incadawr/projects/tools/anycode/.smoke-secrets/deepseek.env";
const EVIDENCE = join(LAB, "evidence");
const APP_LOG = join(LAB, "app.log");

const CONNECTION_ID = "conn-4896";
const PROVIDER = "deepseek";
const MODEL = "deepseek-flash";

const LAUNCH_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 600_000; // deep turns with 25/19 tool calls are long
const POLL = 500;

const screenshots = [];
let pass = 0;
const stepResults = [];

function log(msg) {
  console.log(`[4896] ${msg}`);
}
function ok(step, detail) {
  pass += 1;
  stepResults.push(`step ${step}: PASS — ${detail}`);
  console.log(`[step ${step}] PASS ${detail}`);
}
function hardFail(step, detail) {
  stepResults.push(`step ${step}: FAIL — ${detail}`);
  console.error(`[step ${step}] FAIL ${detail}`);
  throw Object.assign(new Error(`step ${step}: ${detail}`), { step });
}
function assert(step, cond, detail) {
  if (!cond) hardFail(step, detail);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}
function canonPath(p) {
  try { return realpathSync(p); } catch { return p; }
}
function readDiscovery(path) {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (typeof info?.pid === "number" && typeof info?.port === "number" && typeof info?.token === "string" && typeof info?.startedAt === "number") return info;
  } catch {}
  return null;
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function killTree(pid, sig) {
  try { process.kill(-pid, sig); } catch {}
}

// ── automation HTTP ──
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
  if (text.length) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed };
}
async function apiOk(ctx, step, method, path, body) {
  const r = await api(ctx, method, path, body).catch((e) => { throw Object.assign(new Error(`${method} ${path} threw: ${e?.message ?? e}`), { step }); });
  if (r.status !== 200) hardFail(step, `${method} ${path} -> HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitTab(ctx, step, tabId, until, timeoutMs = TURN_TIMEOUT_MS) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const r = await api(ctx, "POST", "/wait", body).catch((e) => ({ status: 0, body: { err: String(e) } }));
  if (r.status !== 200 || r.body?.matched !== true) {
    const st = await api(ctx, "GET", `/state?tabId=${encodeURIComponent(tabId)}&tail=0`).catch(() => null);
    hardFail(step, `/wait ${JSON.stringify(until)} not matched: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}; state=${JSON.stringify(st?.body?.snapshot?.states?.[tabId])?.slice(0, 400)}`);
  }
  return r.body;
}
async function sendPrompt(ctx, step, text, extraWait = {}) {
  const r = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text });
  if (r?.ok !== true) hardFail(step, `prompt rejected: ${JSON.stringify(r)}`);
  await waitTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000).catch(() => {});
  if (Object.keys(extraWait).length) await waitTab(ctx, step, ctx.tabId, extraWait);
}
async function screenshot(ctx, name) {
  try {
    const r = await api(ctx, "GET", "/screenshot");
    if (r.status === 200 && typeof r.body?.png === "string") {
      const p = join(EVIDENCE, `${name}.png`);
      writeFileSync(p, Buffer.from(r.body.png, "base64"));
      screenshots.push(p);
      log(`screenshot: ${p}`);
      return p;
    }
    log(`screenshot ${name} unavailable (HTTP ${r.status})`);
  } catch (e) { log(`screenshot ${name} failed: ${e?.message ?? e}`); }
  return null;
}
async function todoPanel(ctx, step) {
  const r = await api(ctx, "GET", `/tabs/${ctx.tabId}/todo-panel`);
  if (r.status !== 200 || r.body?.ok !== true) hardFail(step, `todo-panel probe failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Badge presence/hint/count via the extended /todo-panel probe fields. */
async function badge(ctx) {
  const r = await api(ctx, "GET", `/tabs/${ctx.tabId}/todo-panel`);
  if (r.status !== 200 || r.body?.ok !== true) return null;
  const b = r.body;
  return { stale: b.stale === true, hint: b.staleHint ?? "" };
}

// ── sqlite history probe (hard rule: only the ISOLATED db) ──
let db = null;
function openDb(path) {
  db = new DatabaseSync(path, { readOnly: true });
}
function historyItems() {
  try {
    return db.prepare("SELECT data FROM history_items").all().map((r) => String(r.data));
  } catch (e) {
    log(`history_items read failed: ${e.message}`);
    return [];
  }
}
function reminderCount() {
  return historyItems().filter((p) => p.includes("<system-reminder>")).length;
}

// ── workspace bootstrap ──
function bootstrapWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "anycode-4896-ws-"));
  writeFileSync(join(ws, "counter.txt"), "0\n");
  for (let i = 1; i <= 30; i++) writeFileSync(join(ws, `file${i}.txt`), `line one\nline two\nline three\n`);
  return ws;
}

// ── prompts ──
const P_TODOWRITE =
  "Begin by calling the TodoWrite tool exactly once with this single-item plan: " +
  '[{"content": "Explore the workspace", "status": "pending"}]. ' +
  "Do not use any other tool in this turn. Do not read or create files. Reply briefly after the tool call.";
const P_READS =
  "Using the Read tool only, read these 25 files one at a time (25 separate Read calls): file1.txt through file25.txt. " +
  "Do NOT use TodoWrite. Do NOT edit anything. Do not summarize each file; after all 25 reads finish, reply with just 'done reading 25'.";
const P_EDITS_19 =
  "You will now perform exactly 19 separate Edit calls, one per number N = 1,2,...,19 in order. " +
  "Before the FIRST edit, read counter.txt once with Read. Each Edit N: old_str = the previous last line of counter.txt (for N=1 that is '0'), new_str = that same line followed by '\\nedit N'. " +
  "So after all edits the file is '0\\nedit 1\\n...\\nedit 19\\n'. Example: Edit 1 replaces '0' with '0\\nedit 1'; Edit 2 replaces 'edit 1' with 'edit 1\\nedit 2'. " +
  "Do NOT use TodoWrite. Do not use any tool other than the one initial Read and the 19 Edits. After all 19 edits finish, reply with just 'done 19 edits'.";
const P_EDIT_20 =
  "Make exactly one more Edit call: replace the last line 'edit 19' in counter.txt with 'edit 19\\nedit 20'. " +
  "Do NOT use TodoWrite. Do not use any other tool (do not Read first — the last line IS 'edit 19'). Then reply with just 'done 20'.";
const P_TODOWRITE2 =
  "Call the TodoWrite tool exactly once now with: " +
  '[{"content": "Explore the workspace", "status": "completed"}]. ' +
  "Do not use any other tool. Reply briefly.";

// ── main ──
async function main() {
  mkdirSync(LAB, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const ws = bootstrapWorkspace();
  log(`workspace: ${ws}`);

  const secrets = parseEnvFile(readFileSync(SECRETS, "utf8"));
  const settings = {
    version: 2,
    provider: {
      activeConnectionId: CONNECTION_ID,
      connections: [{ id: CONNECTION_ID, providerId: PROVIDER, model: MODEL }],
    },
    tools: {},
    permissions: {
      alwaysAllow: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "MultiEdit", "TodoWrite", "Agent"].map((toolName) => ({ toolName })),
    },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
  writeFileSync(join(LAB, "settings.json"), JSON.stringify(settings, null, 2));

  // free port for remote debugging
  const rdp = 39000 + (Date.now() % 9000);

  const env = {
    ...process.env,
    ...secrets,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: join(LAB, "user-data"),
    ANYCODE_DB_PATH: join(LAB, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: join(LAB, "automation.json"),
    ANYCODE_SETTINGS_PATH: join(LAB, "settings.json"),
    ANYCODE_SECRETS_PATH: join(LAB, "secrets.json"),
    REMOTE_DEBUGGING_PORT: String(rdp),
    ANYCODE_WORKSPACE: ws,
  };
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_REASONING_EFFORT;

  const t0 = Date.now();
  const out = openSync(APP_LOG, "a");
  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "exec", "electron-vite", "dev", "--", "--no-sandbox", "--disable-gpu"], {
    cwd: WT,
    env,
    stdio: ["ignore", out, out],
    detached: process.platform !== "win32",
  });
  log(`dev spawned pid=${child.pid} (log ${APP_LOG}) rdp=${rdp}`);

  let info = null;
  while (Date.now() - t0 < LAUNCH_TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) hardFail("launch", `dev exited early code=${child.exitCode} signal=${child.signalCode}; see ${APP_LOG}`);
    const c = readDiscovery(join(LAB, "automation.json"));
    if (c !== null && c.startedAt > t0 - 2000 && isPidAlive(c.pid)) { info = c; break; }
    await sleep(500);
  }
  if (!info) hardFail("launch", `no discovery file within ${LAUNCH_TIMEOUT_MS}ms; see ${APP_LOG}`);
  const ctx = { port: info.port, token: info.token, tabId: null };
  log(`app up pid=${info.pid} port=${info.port} after ${Date.now() - t0}ms`);

  // wait for renderer facade
  for (let i = 0; i < 180; i++) {
    const r = await api(ctx, "GET", "/state?tail=0").catch(() => ({ status: 0 }));
    if (r.status === 200) break;
    if (i === 179) hardFail("launch", "renderer facade never came up");
    await sleep(500);
  }
  // discover boot tab for our workspace
  const target = canonPath(ws);
  let tabId = null;
  for (let i = 0; i < 180; i++) {
    const r = await api(ctx, "GET", "/state").catch(() => null);
    const states = r?.body?.snapshot?.states ?? {};
    for (const [id, st] of Object.entries(states)) {
      if (typeof st?.workspace === "string" && canonPath(st.workspace) === target) { tabId = id; break; }
    }
    if (tabId) break;
    await sleep(500);
  }
  if (!tabId) {
    const r = await apiOk(ctx, "launch", "POST", "/tabs", { kind: "new", workspace: ws });
    tabId = r.tabId;
  }
  ctx.tabId = tabId;
  await waitTab(ctx, "launch", tabId, { connection: "ready" }, 60_000);
  await api(ctx, "POST", `/tabs/${tabId}/select`, {}).catch(() => {});
  openDb(join(LAB, "db.sqlite"));
  ok("launch", `tab ${tabId} ready (connection ready), model ${MODEL} via seeded settings; isolated db open`);

  try {
    // S1 — TodoWrite
    await sendPrompt(ctx, 1, P_TODOWRITE, { turnStatus: "idle" });
    let deadline = Date.now() + 30_000;
    let panel = null;
    while (Date.now() < deadline) {
      panel = await todoPanel(ctx, 1);
      if (panel.visible) break;
      await sleep(500);
    }
    assert(1, panel?.visible === true, `todo panel not visible after TodoWrite: ${JSON.stringify(panel)}`);
    const badge1 = await badge(ctx);
    assert(1, badge1?.stale === false, `expected no stale badge after fresh TodoWrite, got ${JSON.stringify(badge1)}`);
    await screenshot(ctx, "s1-fresh-plan");
    ok(1, `plan visible (header=${JSON.stringify(panel.header)}), no "may be stale" badge`);

    // S2 — 25 reads
    const remindersBefore = reminderCount();
    await sendPrompt(ctx, 2, P_READS, { turnStatus: "idle" });
    panel = await todoPanel(ctx, 2);
    const badge2 = await badge(ctx);
    assert(2, badge2?.stale === false, `stale badge appeared after read-only work: ${JSON.stringify(badge2)}`);
    assert(2, reminderCount() === remindersBefore, `<system-reminder> count changed after read-only work: ${remindersBefore} -> ${reminderCount()}`);
    await screenshot(ctx, "s2-after-25-reads-fresh");
    ok(2, `panel still fresh after 25 Read calls; history_items <system-reminder> count unchanged (${remindersBefore})`);

    // S3 — 19 edits
    await sendPrompt(ctx, 3, P_EDITS_19, { turnStatus: "idle" });
    panel = await todoPanel(ctx, 3);
    const badge3 = await badge(ctx);
    assert(3, badge3?.stale === false, `stale badge appeared at 19 mutations: ${JSON.stringify(badge3)}`);
    await screenshot(ctx, "s3-after-19-edits-fresh");
    ok(3, `panel still fresh after 19 Edit calls (no badge, count < 20)`);

    // S3b — sanity: how many Edit calls actually landed? (diagnostic guard)
    const editCount = historyItems().filter((p) => p.includes('"toolName":"Edit"') || p.includes('"toolName\\":\\"Edit\\"')).length;
    log(`diagnostic: Edit tool_result entries in history: ${editCount}`);

    // S4 — edit #20
    await sendPrompt(ctx, 4, P_EDIT_20, { turnStatus: "idle" });
    deadline = Date.now() + 20_000;
    let badge4 = null;
    while (Date.now() < deadline) {
      badge4 = await badge(ctx);
      if (badge4?.stale) break;
      await sleep(500);
    }
    assert(4, badge4?.stale === true, `no stale badge after 20th mutation: ${JSON.stringify(badge4)}`);
    assert(4, /20/.test(badge4.hint ?? ""), `stale hint does not report 20 mutating calls: ${JSON.stringify(badge4)}`);
    const items = historyItems();
    const withReminder = items.filter((p) => p.includes("<system-reminder>"));
    assert(4, withReminder.length > 0, "no <system-reminder> found in history_items after 20th mutation");
    const lastReminder = withReminder[withReminder.length - 1];
    assert(4, /20 mutating tool calls/.test(lastReminder), `last reminder does not report 20 mutating calls: ${lastReminder.slice(0, 300)}`);
    await screenshot(ctx, "s4-stale-20-mutations");
    ok(4, `"may be stale" badge + hint reports 20 mutating calls; last history item carries <system-reminder> with 20 mutating calls (${withReminder.length} reminders total)`);

    // S5 — renderer reload via CDP (REMOTE_DEBUGGING_PORT)
    const reloaded = await cdpReload(rdp);
    if (!reloaded) {
      log("CDP reload unavailable — S5 reload leg NOT VERIFIED");
      stepResults.push("step 5 (reload): NOT VERIFIED — CDP reload unavailable");
    } else {
      await sleep(5000);
      for (let i = 0; i < 60; i++) {
        const r = await api(ctx, "GET", "/state?tail=0").catch(() => ({ status: 0 }));
        if (r.status === 200) break;
        if (i === 59) hardFail(5, "automation /state never came back after reload");
        await sleep(1000);
      }
      const r2 = await api(ctx, "GET", "/state").catch(() => null);
      const states = r2?.body?.snapshot?.states ?? {};
      let postTab = null;
      for (const [id, st] of Object.entries(states)) {
        if (typeof st?.workspace === "string" && canonPath(st.workspace) === target) postTab = id;
      }
      assert(5, postTab !== null, `no tab for workspace after reload: ${JSON.stringify(Object.keys(states))}`);
      ctx.tabId = postTab;
      await api(ctx, "POST", `/tabs/${postTab}/select`, {}).catch(() => {});
      await waitTab(ctx, 5, postTab, { connection: "ready" }, 90_000).catch(() => {});
      const badge5 = await badge(ctx);
      assert(5, badge5?.stale === true && /20/.test(badge5.hint ?? ""), `stale badge+count did not return after reload: ${JSON.stringify(badge5)}`);
      await screenshot(ctx, "s5-reloaded-stale-persists");
      ok(5, `after renderer reload the stale badge and count 20 returned`);
    }

    // S5b — TodoWrite resets
    await sendPrompt(ctx, "5b", P_TODOWRITE2, { turnStatus: "idle" });
    deadline = Date.now() + 20_000;
    let badge5b = null;
    while (Date.now() < deadline) {
      badge5b = await badge(ctx);
      if (badge5b && badge5b.stale === false) break;
      await sleep(500);
    }
    assert("5b", badge5b?.stale === false, `stale badge did not clear after TodoWrite: ${JSON.stringify(badge5b)}`);
    await screenshot(ctx, "s5b-reset-after-todowrite");
    ok("5b", `stale badge disappeared and count reset after TodoWrite`);
  } finally {
    // teardown: stop only the dev instance we started
    await api(ctx, "POST", "/quit", {}).catch(() => {});
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), 15_000);
      child.once("exit", () => { clearTimeout(t); res(true); });
    });
    if (!exited) { killTree(child.pid, "SIGTERM"); await sleep(1000); if (isPidAlive(child.pid)) killTree(child.pid, "SIGKILL"); }
    log(`dev instance stopped (graceful=${exited})`);
    try { rmSync(ws, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n[4896] RESULT: ${pass} checks passed; steps:\n  ${stepResults.join("\n  ")}`);
  if (stepResults.some((s) => s.includes("FAIL"))) process.exit(1);
}

/** Minimal CDP WebSocket client: fetch /json list, connect to the page target, Runtime.evaluate location.reload(). */
async function cdpReload(rdp) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${rdp}/json/list`)).json();
    const page = list.find((p) => p?.type === "page" && p?.webSocketDebuggerUrl);
    if (!page) return false;
    const G = globalThis.WebSocket;
    if (!G) return false;
    return await new Promise((resolve) => {
      const ws = new G(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));
      ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch {} resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
    });
  } catch (e) {
    log(`cdpReload failed: ${e?.message ?? e}`);
    return false;
  }
}

main().catch((e) => {
  console.error(`[4896] FATAL step=${e?.step ?? "?"}: ${e?.stack ?? e}`);
  process.exit(1);
});

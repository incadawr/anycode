import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const root = mkdtempSync(join(tmpdir(), "anycode-roles-smoke-"));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
mkdirSync(join(root, "workspace"));
const binary = join(root, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const route = { primary: { connection: "conn-smoke", model: "a-very-long-custom-model-id-for-layout-check" }, fallbacks: [{ connection: "conn-smoke" }, { connection: "conn-smoke", model: "another-model" }] };
writeFileSync(join(root, "settings.json"), JSON.stringify({ version: 2, provider: { connections: [{ id: "conn-smoke", providerId: "custom:smoke", label: "A connection with a long name for layout testing" }], activeConnectionId: "conn-smoke", custom: [{ id: "custom:smoke", name: "Smoke", baseUrl: "http://127.0.0.1:1234/v1", kind: "openai-compatible" }] }, roleProfiles: { activeId: "p", profiles: [{ id: "p", name: "A long profile name for layout testing", roles: { orchestrator: route, planner: route, executor: route, reviewer: route, explore: route } }], projects: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const env = { ...buildSmokeEnv(process.env, root, port, binary), ANYCODE_WORKSPACE: join(root, "workspace"), ANYCODE_API_KEY: "local", ANYCODE_BASE_URL: "http://127.0.0.1:1234/v1", ANYCODE_MODEL: "test" };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: "inherit" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn) { for (let i = 0; i < 300; i++) { try { const value = await fn(); if (value) return value; } catch {} if (app.exitCode !== null) throw new Error(`app exited ${app.exitCode}`); await sleep(200); } throw new Error("Timed out waiting for app"); }
let ws, info;
const pending = new Map(); let id = 0;
function call(method, params) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); }); }
async function evaluate(expression) { const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function api(method, path, body) { const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method, headers: { Authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return response.json(); }
try {
  info = await poll(() => JSON.parse(readFileSync(join(root, "automation.json"), "utf8")));
  const target = await poll(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && !t.url.startsWith("devtools://")));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const response = JSON.parse(data); const entry = pending.get(response.id); if (!entry) return; pending.delete(response.id); response.error ? entry.reject(new Error(JSON.stringify(response.error))) : entry.resolve(response.result); };
  await poll(async () => (await api("POST", "/settings/open", {})).ok);
  assert.equal((await api("POST", "/settings/pane", { paneId: "roles" })).ok, true);
  await poll(() => evaluate("!!document.querySelector('[data-testid=settings-roles-pane]')"));
  await api("POST", "/window/size", { width: 1280, height: 800 });
  await sleep(800);
  const inspect = `(() => { const pane = document.querySelector('[data-testid=settings-roles-pane]'); const table = pane.querySelector('.roles-table'); const header = pane.querySelector('.roles-header'); const save = pane.querySelector('.roles-actions'); const rect = (e) => { const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }; return {height:innerHeight,width:innerWidth,header:rect(header),table:rect(table),save:rect(save),rows:table.querySelectorAll('.roles-row').length,closed:[...pane.querySelectorAll('details')].every(d=>!d.open), selects:[...pane.querySelectorAll('select')].every(e=>e.classList.contains('settings-field-select')), background:getComputedStyle(pane.querySelector('select')).backgroundColor}; })()`;
  const data = await evaluate(inspect);
  assert.equal(data.rows, 5); assert.equal(data.closed, true); assert.equal(data.selects, true); assert.notEqual(data.background, "rgba(0, 0, 0, 0)");
  assert(data.header.top >= 0 && data.table.bottom <= data.height && data.save.bottom <= data.height, JSON.stringify(data));
  assert(data.table.right <= data.width && data.table.left >= 0, JSON.stringify(data));
  mkdirSync("/tmp/anycode-night/gh23-shots", { recursive: true });
  const shot = await api("GET", "/screenshot"); assert(shot.png); writeFileSync("/tmp/anycode-night/gh23-shots/after.png", Buffer.from(shot.png, "base64"));
  await api("POST", "/window/size", { width: 860, height: 800 }); await sleep(500);
  const narrow = await evaluate(`(() => { const pane=document.querySelector('[data-testid=settings-roles-pane]'); return {scroll:pane.scrollWidth, client:pane.clientWidth, viewport:innerWidth}; })()`);
  assert(narrow.scroll <= narrow.client + 1, JSON.stringify(narrow));
  console.log("Roles UI smoke passed", JSON.stringify({ data, narrow }));
} finally {
  if (info) { try { await api("POST", "/quit", {}); } catch {} }
  ws?.close();
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000); rmSync(root, { recursive: true, force: true });
}

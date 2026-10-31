import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRolesSmokeDirs } from "./roles-smoke-dirs.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const { profile: root, workspace } = createRolesSmokeDirs();
const binary = join(root, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const route = { primary: { connection: "conn-smoke", model: "a-very-long-custom-model-id-for-layout-check" }, fallbacks: [{ connection: "conn-smoke" }, { connection: "conn-smoke", model: "another-model" }] };
writeFileSync(join(root, "settings.json"), JSON.stringify({ version: 2, provider: { connections: [{ id: "conn-smoke", providerId: "custom:smoke", label: "A connection with a long name for layout testing" }], activeConnectionId: "conn-smoke", custom: [{ id: "custom:smoke", name: "Smoke", baseUrl: "http://127.0.0.1:1234/v1", kind: "openai-compatible" }] }, roleProfiles: { activeId: "p", profiles: [{ id: "p", name: "A long profile name for layout testing", roles: { orchestrator: route, planner: route, executor: route, reviewer: route, explore: route } }], projects: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const env = { ...buildSmokeEnv(process.env, root, 0, binary), ANYCODE_WORKSPACE: workspace, ANYCODE_API_KEY: "local", ANYCODE_BASE_URL: "http://127.0.0.1:1234/v1", ANYCODE_MODEL: "test" };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: "inherit" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn) { for (let i = 0; i < 300; i++) { try { const value = await fn(); if (value) return value; } catch {} if (app.exitCode !== null) throw new Error(`app exited ${app.exitCode}`); await sleep(200); } throw new Error("Timed out waiting for app"); }
let ws, info, cdp;
const call = (method, params) => cdp.call(method, params);
async function evaluate(expression) { const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function api(method, path, body) { return (await cdp.automation(info, path, method, body)).result; }
try {
  cdp = await connectIsolatedCdp({ profile: root, env, launcher: app, wait: poll });
  ws = cdp.ws;
  info = await poll(() => JSON.parse(readFileSync(join(root, "automation.json"), "utf8")));
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
  const screenshotDir = mkdtempSync(join(tmpdir(), "anycode-roles-shots-"));
  const shot = await api("GET", "/screenshot"); assert(shot.png); writeFileSync(join(screenshotDir, "roles.png"), Buffer.from(shot.png, "base64"));
  console.log(`Roles screenshot: ${join(screenshotDir, "roles.png")}`);
  await api("POST", "/window/size", { width: 860, height: 800 }); await sleep(500);
  const narrow = await evaluate(`(() => { const pane=document.querySelector('[data-testid=settings-roles-pane]'); return {scroll:pane.scrollWidth, client:pane.clientWidth, viewport:innerWidth}; })()`);
  assert(narrow.scroll <= narrow.client + 1, JSON.stringify(narrow));
  console.log("Roles UI smoke passed", JSON.stringify({ data, narrow }));
} finally {
  if (info) { try { await api("POST", "/quit", {}); } catch {} }
  ws?.close();
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000); rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true });
}

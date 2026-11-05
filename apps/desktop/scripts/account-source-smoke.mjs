/** Isolated account catalog and budget smoke using a synthetic loopback gateway. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const profile = mkdtempSync(join(tmpdir(), "anycode-account-smoke-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let budgetMode = "normal";
const gateway = createHttpServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const data = req.url === "/account/catalog"
    ? { schemaVersion: "anycode.account-catalog.v1", accountId: "synthetic", revision: "1", complete: true, models: [{ id: "onprem/code", billing: "free" }, { id: "cloud/model", billing: "metered" }] }
    : { schemaVersion: "anycode.account-budget.v1", accountId: budgetMode === "other" ? "other-employee" : "synthetic", budgetId: "shared", currency: "USD", scale: 6, observedAt: new Date(Date.now() - (budgetMode === "stale" ? 180000 : 0)).toISOString(), windows: [{ kind: "day", limit: "10000000", spent: "3200000", remaining: budgetMode === "exhausted" ? "0" : "6800000", resetsAt: new Date(Date.now() + 86400000).toISOString() }, { kind: "month", limit: "220000000", spent: "36000000", remaining: "184000000", resetsAt: new Date(Date.now() + 86400000).toISOString() }] };
  res.end(JSON.stringify(data));
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${gateway.address().port}`;
const descriptor = { id: "cluster", protocol: "anycode.account.v1", displayName: "Example cluster", gateway: { name: "Example gateway", baseUrl: `${origin}/v1`, kind: "openai-compatible" }, apiBaseUrl: `${origin}/account/` };
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
const hash = createHash("sha256").update(canonical({ id: descriptor.id, protocol: descriptor.protocol, gateway: { baseUrl: descriptor.gateway.baseUrl, kind: descriptor.gateway.kind }, apiBaseUrl: descriptor.apiBaseUrl })).digest("hex");
const plugin = join(profile, ".anycode", "plugins", "company", ".anycode-plugin");
mkdirSync(plugin, { recursive: true });
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "company", version: "1.0.0", skills: [], agents: [], workflows: [], accountSources: [descriptor] }));
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "conn-test", connections: [{ id: "conn-test", providerId: "custom:corp", model: "onprem/code", authOptional: true }], custom: [{ id: "custom:corp", name: "Example", baseUrl: `${origin}/v1`, kind: "openai-compatible", models: ["onprem/code"], authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "light" }, security: { allowWeakSecretStorage: false }, plugins: { accountSources: [{ plugin: "company", source: "cluster", descriptorHash: hash, connectionId: "conn-test", accountId: "synthetic", ownership: {} }] } }));
const portServer = createTcpServer(); await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve)); const port = portServer.address().port; await new Promise((resolve) => portServer.close(resolve));
const unavailable = join(profile, "unavailable"); writeFileSync(unavailable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: profile, ANYCODE_PROFILE_HOME: profile, ANYCODE_CODEX_PROFILES_HOME: profile, ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"), ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"), ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"), ANYCODE_CODEX_BIN: unavailable, ANYCODE_CLAUDE_BIN: unavailable, CLAUDE_CONFIG_DIR: join(profile, "claude") };
const app = launchSmokeElectron(spawn, { env, remoteDebuggingPort: port, detached: true });
let ws; let next = 0; const pending = new Map();
async function poll(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await sleep(150); } throw new Error("Timed out waiting for account budget"); }
function call(method, params = {}) { const id = ++next; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Renderer evaluation failed"); return result.result.value; }
try {
  const target = await poll(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page" && !x.url.startsWith("devtools://")));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error("debugger request failed")) : item.resolve(message.result); };
  await poll(() => evaluate("document.querySelector('.account-budget')?.textContent.includes('3.20')"));
  assert(await evaluate("document.querySelector('.account-budget').textContent.includes('36.00')"));
  await sleep(1000);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "account-budget.png"), Buffer.from(shot.data, "base64"));
  const create = JSON.stringify({ kind: "new", workspace: profile, engine: "core", connectionId: "conn-test" });
  const firstTab = await evaluate(`window.anycode.createTab(${create})`);
  const secondTab = await evaluate(`window.anycode.createTab(${create})`);
  assert(firstTab.ok && secondTab.ok, "synthetic tabs should open");
  await poll(() => evaluate("document.querySelectorAll('.sidebar-row-open').length >= 2"));
  await evaluate("document.querySelectorAll('.sidebar-row-open')[0].click()");
  assert(await evaluate("document.querySelector('.account-budget').textContent.includes('3.20')"));
  await evaluate("document.querySelectorAll('.sidebar-row-open')[1].click()");
  assert(await evaluate("document.querySelector('.account-budget').textContent.includes('3.20')"));
  await evaluate("document.querySelector('.sidebar-collapse').click()");
  await poll(() => evaluate("!!document.querySelector('.account-budget-floating .account-budget-toggle')"));
  await evaluate("document.querySelector('.account-budget-floating .account-budget-toggle').click()");
  await poll(() => evaluate("document.querySelector('.account-budget-floating').textContent.includes('3.20')"));
  budgetMode = "exhausted";
  await evaluate("[...document.querySelectorAll('.account-budget-floating button')].find(b => b.textContent === 'Refresh').click()");
  await poll(() => evaluate("document.querySelector('.account-budget-floating').textContent.includes('Budget exhausted')"));
  await sleep(200);
  budgetMode = "stale";
  await evaluate("[...document.querySelectorAll('.account-budget-floating button')].find(b => b.textContent === 'Refresh').click()");
  await poll(() => evaluate("document.querySelector('.account-budget-floating').textContent.includes('stale')"));
  await sleep(200);
  budgetMode = "normal";
  await evaluate("[...document.querySelectorAll('.account-budget-floating button')].find(b => b.textContent === 'Refresh').click()");
  await poll(() => evaluate("!document.querySelector('.account-budget-floating').textContent.includes('stale')"));
  await sleep(200);
  budgetMode = "other";
  await evaluate("[...document.querySelectorAll('.account-budget-floating button')].find(b => b.textContent === 'Refresh').click()");
  await poll(() => evaluate("document.querySelector('.account-budget-floating').textContent.includes('needs approval')"));
  assert.equal(await evaluate("document.querySelector('.account-budget-floating').textContent.includes('3.20')"), false);
  await sleep(200);
  budgetMode = "normal";
  await evaluate("[...document.querySelectorAll('.account-budget-floating button')].find(b => b.textContent === 'Refresh').click()");
  await poll(() => evaluate("document.querySelector('.account-budget-floating').textContent.includes('3.20')"));
  await evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
  await sleep(1000);
  const dark = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "account-budget-dark-collapsed.png"), Buffer.from(dark.data, "base64"));
  console.log(`PASS: isolated budget, catalog, light and collapsed dark view. Screenshots: ${profile}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) await call("Browser.close").catch(() => {});
  ws?.close(); try { process.kill(-app.pid, "SIGTERM"); } catch {} gateway.close();
}

/** Isolated provider-error and session-resume smoke. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const profile = mkdtempSync(join(tmpdir(), "anycode-turn-error-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;
const fixture = createServer((req, res) => { requests++; req.resume(); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture denied", type: "authentication_error" } })); });
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, 0, binary);
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "conn-smoke", custom: [{ id: "custom:smoke", name: "Smoke", baseUrl: url, kind: "openai-compatible", models: ["a"] }], connections: [{ id: "conn-smoke", providerId: "custom:smoke", label: "Smoke", model: "a", models: ["a"], transport: "openai-chat-completions", baseUrl: url, authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const app = launchSmokeElectron(spawn, { env, detached: true });
let cdp;
async function poll(fn, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(150); } throw new Error("Timed out waiting for smoke state"); }
async function evaluate(expression) { const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: (fn) => poll(fn) });
  const info = await poll(() => existsSync(join(profile, "automation.json")) && JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")));
  async function api(method, path, body) { const { ok, result } = await cdp.automation(info, path, method, body); assert(ok, JSON.stringify(result)); return result; }
  const tab = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert(tab.ok);
  await poll(async () => { try { return (await api("GET", `/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready"; } catch { return false; } });
  await api("POST", `/tabs/${tab.tabId}/prompt`, { text: "trigger fixture error" });
  await poll(() => evaluate("document.querySelector('.message-error-name')?.parentElement?.textContent"));
  const settled = await api("POST", "/wait", { tabId: tab.tabId, until: { turnStatus: "idle" }, timeoutMs: 120000 });
  assert(settled.matched, JSON.stringify(settled));
  const before = await evaluate("document.querySelector('.message-error-name').parentElement.textContent");
  const state = await api("GET", "/state");
  const sessionId = state.tabs.find((item) => item.tabId === tab.tabId)?.sessionId;
  assert(sessionId); assert(requests > 0);
  const spare = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert(spare.ok, JSON.stringify(spare));
  const closed = await api("POST", `/tabs/${tab.tabId}/close`, {});
  assert(closed.ok, JSON.stringify(closed));
  const resumed = await api("POST", "/tabs", { kind: "resume", sessionId });
  assert(resumed.ok, JSON.stringify(resumed));
  await api("POST", `/tabs/${resumed.tabId}/select`, {});
  await poll(async () => {
    try {
      const state = (await api("GET", `/state/${resumed.tabId}`)).snapshot.states[resumed.tabId];
      return state?.connection === "ready" && state.transcript.some((block) => block.kind === "error" && !block.id.startsWith("error:"));
    } catch { return false; }
  });
  const after = await poll(() => evaluate("document.querySelector('.message-error-name')?.parentElement?.textContent"));
  assert.equal(after, before);
  const png = await cdp.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "resumed-error.png"), Buffer.from(png.data, "base64"));
  console.log(`PASS: fixture returned 401 and the resumed session shows the same error row. Evidence: ${profile}`);
} finally {
  if (cdp?.ws?.readyState === WebSocket.OPEN) await cdp.call("Browser.close", {}).catch(() => {});
  cdp?.ws?.close();
  await sleep(500);
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => fixture.close(resolve));
}

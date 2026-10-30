/** Development-only approval expiry smoke using a loopback provider and isolated profile. */
import assert from "node:assert/strict";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const profile = mkdtempSync(join(tmpdir(), "anycode-approval-expiry-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const fixture = createHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const input = JSON.parse(body);
    const lastUser = input.messages.findLastIndex((message) => message.role === "user");
    const prompt = JSON.stringify(input.messages[lastUser]?.content ?? "");
    const answered = input.messages.slice(lastUser + 1).some((message) => message.role === "tool");
    const child = prompt.includes("CHILD-WRITE");
    const spawn = prompt.includes("CHILD-HANDOFF") && !child;
    const call = spawn
      ? { name: "Agent", arguments: JSON.stringify({ description: "Approval smoke child", prompt: "CHILD-WRITE", agent_type: "general-purpose", tier: "session", detach: false }) }
      : { name: "Write", arguments: JSON.stringify({ file_path: join(profile, child ? "child.txt" : "root.txt"), content: "fixture" }) };
    const base = { id: "fixture-chat", object: "chat.completion.chunk", created: 0, model: input.model };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!answered) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: call }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      const finish = () => {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture finished." }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (child) setTimeout(finish, 30000); else finish();
    }
  });
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, port, binary);
writeFileSync(join(profile, "settings.json"), JSON.stringify({
  version: 2, provider: { activeConnectionId: "conn-smoke", custom: [{ id: "custom:smoke", name: "Smoke", baseUrl: fixtureUrl, kind: "openai-compatible", models: ["a"] }], connections: [{ id: "conn-smoke", providerId: "custom:smoke", label: "Approval smoke", model: "a", models: ["a"], transport: "openai-chat-completions", baseUrl: fixtureUrl, authOptional: true }] },
  tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false },
}));
const app = spawn("pnpm", ["--filter", "@anycode/desktop", "dev", ...(process.env.ANYCODE_SMOKE_NO_SANDBOX === "1" ? ["--noSandbox"] : [])], { env, stdio: ["ignore", "inherit", "inherit"], detached: true });
let ws;
const pending = new Map();
let nextId = 0;
async function poll(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error("Timed out waiting for GUI state");
}
function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function click(text) {
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.click(); return true; })()`), `Button missing: ${text}`);
  await sleep(250);
}
try {
  const target = await poll(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && !t.url.startsWith("devtools://")); } catch { return false; }
  }, 180000);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer);
    if (response.error) item.reject(new Error(JSON.stringify(response.error))); else item.resolve(response.result);
  };
  await poll(() => evaluate("!!document.querySelector('.sidebar-settings')"));
  const info = await poll(() => existsSync(join(profile, "automation.json")) && JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")));
  async function api(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method, headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  }
  async function capture(name) {
    const png = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, `${name}.png`), Buffer.from(png.data, "base64"));
  }
  const tab = await evaluate(`window.anycode.createTab({kind:'new', workspace:${JSON.stringify(profile)}})`);
  assert(tab.ok);
  await poll(async () => {
    try { return (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready"; } catch { return false; }
  });
  await api(`/tabs/${tab.tabId}/prompt`, "POST", { text: "CHILD-HANDOFF" });
  await poll(() => evaluate("document.querySelector('.permission-modal-body')?.textContent.includes('Automatically denied in')"), 30000);
  await capture("countdown");
  try {
    await poll(() => evaluate("document.body.textContent.includes('Approval smoke child') && document.body.textContent.includes('denied automatically')"), 360000);
  } catch (error) {
    await capture("child-expiry-debug");
    writeFileSync(join(profile, "child-expiry-debug.txt"), await evaluate("document.body.innerText"));
    throw error;
  }
  await capture("child-expiry");
  assert(await evaluate("[...document.querySelectorAll('.approval-status')].some(e => e.textContent.includes('Approval smoke child'))"));
  await evaluate("[...document.querySelectorAll('.approval-status')].find(e => e.textContent.includes('Approval smoke child')).querySelector('button').click()");
  await poll(() => evaluate("![...document.querySelectorAll('.approval-status')].some(e => e.textContent.includes('Approval smoke child'))"));
  await capture("child-recovery");
  const rootTab = await evaluate(`window.anycode.createTab({kind:'new', workspace:${JSON.stringify(profile)}})`);
  assert(rootTab.ok);
  await api(`/tabs/${rootTab.tabId}/select`, "POST", {});
  await poll(async () => {
    try { return (await api(`/state/${rootTab.tabId}`)).snapshot.states[rootTab.tabId]?.connection === "ready"; } catch { return false; }
  });
  await api(`/tabs/${rootTab.tabId}/prompt`, "POST", { text: "ROOT-WRITE" });
  await poll(() => evaluate("document.querySelector('.permission-modal-body')?.textContent.includes('Automatically denied in')"), 30000);
  await poll(() => evaluate("document.querySelector('.approval-status')?.textContent.includes('denied automatically')"), 360000);
  await capture("root-expiry");
  assert(await evaluate("[...document.querySelectorAll('.tool-call-status-denied')].some(e => e.textContent.includes('Write'))"));
  assert(await evaluate("![...document.querySelectorAll('.tool-call-status-denied')].some(e => e.textContent.includes('Waiting for file snapshot'))"));
  await capture("denied-card");
  await evaluate("document.querySelector('.approval-status button').click()");
  await poll(() => evaluate("!document.querySelector('.approval-status')"));
  await capture("root-recovery");
  console.log(`PASS: approval countdown, child handoff and expiry, recovery, and denied card. Evidence: ${profile}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) await call("Browser.close", {}).catch(() => {});
  ws?.close();
  if (existsSync(join(profile, "automation.json"))) {
    const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8"));
    try { process.kill(info.pid, "SIGTERM"); } catch {}
  }
  await sleep(500);
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => fixture.close(resolve));
}

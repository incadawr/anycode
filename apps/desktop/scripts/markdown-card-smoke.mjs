/** Development-only Markdown card smoke using a loopback provider and isolated profile. */
import assert from "node:assert/strict";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";
import { createServer as createHttpServer } from "node:http";

const profile = mkdtempSync(join(tmpdir(), "anycode-approval-expiry-"));
const tool = process.argv.includes("--write") ? "Write" : "Read";
const outside = join(process.cwd(), ".markdown-card-smoke-fixture.markdown");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = createHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const input = JSON.parse(body);
    const lastUser = input.messages.findLastIndex((message) => message.role === "user");
    const prompt = JSON.stringify(input.messages[lastUser]?.content ?? "");
    const answered = input.messages.slice(lastUser + 1).some((message) => message.role === "tool");
    const call = { name: tool, arguments: JSON.stringify(tool === "Write" ? { file_path: outside, content: "# Isolated smoke fixture\n" } : { file_path: outside }) };
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
      finish();
    }
  });
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, 0, binary);
writeFileSync(join(profile, "settings.json"), JSON.stringify({
  version: 2, provider: { activeConnectionId: "conn-smoke", custom: [{ id: "custom:smoke", name: "Smoke", baseUrl: fixtureUrl, kind: "openai-compatible", models: ["a"] }], connections: [{ id: "conn-smoke", providerId: "custom:smoke", label: "Approval smoke", model: "a", models: ["a"], transport: "openai-chat-completions", baseUrl: fixtureUrl, authOptional: true }] },
  tools: {}, permissions: { alwaysAllow: [{ toolName: "Read" }, { toolName: "Write" }] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false },
}));
const app = launchSmokeElectron(spawn, { env, detached: true });
let ws, cdp, createdFixture = false;
async function poll(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error("Timed out waiting for GUI state");
}
const call = (method, params) => cdp.call(method, params);
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
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: fn => poll(fn, 180000) });
  ws = cdp.ws;
  await poll(() => evaluate("!!document.querySelector('.sidebar-settings')"));
  const info = await poll(() => existsSync(join(profile, "automation.json")) && JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")));
  async function api(path, method = "GET", body) {
    const {ok, result} = await cdp.automation(info, path, method, body);
    assert(ok, JSON.stringify(result));
    return result;
  }
  async function capture(name) {
    const png = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, `${name}.png`), Buffer.from(png.data, "base64"));
  }
  writeFileSync(outside, "# Isolated smoke fixture\n", { flag: "wx" });
  createdFixture = true;
  const tab = await evaluate(`window.anycode.createTab({kind:'new', workspace:${JSON.stringify(profile)}})`);
  assert(tab.ok);
  await poll(async () => { try { return (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready"; } catch { return false; } });
  await api(`/tabs/${tab.tabId}/prompt`, "POST", { text: `${tool} the fixture` });
  await poll(() => evaluate(`([...document.querySelectorAll('.tool-call-toggle-row')].some(e => e.textContent.includes(${JSON.stringify(tool)}) && e.textContent.includes('Success') && e.querySelector('.tool-call-open')))`) , 60000);
  await evaluate(`([...document.querySelectorAll('.tool-call-toggle-row')].find(e => e.textContent.includes(${JSON.stringify(tool)}) && e.textContent.includes('Success')).querySelector('.tool-call-open').click())`);
  await poll(() => evaluate("document.querySelector('.tool-call-open-error')?.textContent.includes('Open externally')"));
  const geometry = await evaluate(`(() => { const e=document.querySelector('.tool-call-open-error'); const row=e.closest('.tool-call-toggle-row'); const b=row.querySelector('.tool-call-status-badge'); const a=e.getBoundingClientRect(), c=b.getBoundingClientRect(); return {error:e.innerText, status:b.innerText, separated:a.top >= c.bottom, errorRect:{top:a.top,bottom:a.bottom},statusRect:{top:c.top,bottom:c.bottom}}; })()`);
  assert(geometry.separated, JSON.stringify(geometry));
  await capture("markdown-card");
  console.log(`PASS: ${JSON.stringify(geometry)} screenshot=${join(profile, "markdown-card.png")}`);

} finally {
  if (createdFixture) try { unlinkSync(outside); } catch {}
  if (ws?.readyState === WebSocket.OPEN) await call("Browser.close", {}).catch(() => {});
  ws?.close();
  await sleep(500);
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => fixture.close(resolve));
}

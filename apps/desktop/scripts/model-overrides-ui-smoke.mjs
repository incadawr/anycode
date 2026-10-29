/** GitHub #26: isolated model-settings GUI/host smoke; loopback provider fixture, no external credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const profile = mkdtempSync(join(tmpdir(), "anycode-model-overrides-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const fixtureRequests = [];
const fixture = createHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const input = JSON.parse(body);
    fixtureRequests.push(input.model);
    response.writeHead(200, {"Content-Type":"text/event-stream"});
    const base = {id:"fixture-chat", object:"chat.completion.chunk", created:0, model:input.model};
    response.write(`data: ${JSON.stringify({...base, choices:[{index:0, delta:{role:"assistant", content:"fixture answer"}, finish_reason:null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({...base, choices:[{index:0, delta:{}, finish_reason:"stop"}], usage:{prompt_tokens:100, completion_tokens:2, total_tokens:102}})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = { ...process.env,
  ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: profile, REMOTE_DEBUGGING_PORT: String(port),
  ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"),
  ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
  ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
  ANYCODE_CODEX_BIN: binary, ANYCODE_CLAUDE_BIN: binary,
  CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
};
for (const key of ["ANYCODE_API_KEY", "ANYCODE_MODEL", "ANYCODE_BASE_URL", "ANYCODE_PROVIDER", "ANYCODE_TRANSPORT", "ANYCODE_REASONING_EFFORT", "ANYCODE_CONTEXT_WINDOW", "ANYCODE_CONTEXT_WINDOW_MODEL"]) delete env[key];
writeFileSync(join(profile, "settings.json"), JSON.stringify({
  version:2, provider:{activeConnectionId:"conn-smoke", connections:[{
    id:"conn-smoke", providerId:"vllm", label:"Model overrides smoke", model:"a", models:["a","b","unknown"],
    transport:"openai-chat-completions", baseUrl:fixtureUrl, authOptional:true,
  }]}, tools:{}, permissions:{alwaysAllow:[]}, ui:{theme:"dark"}, security:{allowWeakSecretStorage:false},
}));
const app = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
  env, stdio: ["ignore", "inherit", "inherit"], detached: true,
});
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
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page" && !t.url.startsWith("devtools://")); }
    catch { return false; }
  }, 60000);
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
  await click("Settings");
  await evaluate("document.querySelector('#settings-tab-provider').click()");
  await poll(() => evaluate("!!document.querySelector('.connection-tile-menu-trigger') || !!document.querySelector('.connection-tile button[aria-haspopup=menu]')"));
  await evaluate("document.querySelector('.connection-tile button[aria-haspopup=menu]').click()");
  await click("Edit");
  await poll(() => evaluate("document.querySelector('.connection-drawer')?.open"));
  const field = label => `(() => { const label = [...document.querySelectorAll('.connection-drawer label')].find(l => l.querySelector('.settings-field-label')?.textContent.trim().startsWith(${JSON.stringify(label)})); return label?.querySelector('input'); })()`;
  async function input(expression, value) {
    await evaluate(`(() => { const input = ${expression}; if (!input) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(100);
  }
  async function select(label, value) {
    await evaluate(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await sleep(100);
  }
  await evaluate("document.querySelector('.connection-drawer-advanced').open = true");
  await input(field("Context window"), "128000");
  await select("Reasoning support", "on");
  await select("Reasoning effort", "max");
  await click("Save");
  await poll(() => JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).provider.connections[0].modelOverrides?.a?.contextWindowTokens === 128000);
  await input("document.querySelector('input[list=connection-drawer-model-suggestions]')", "b");
  assert.equal(await evaluate(`${field("Context window")}.value`), "");
  await input(field("Context window"), "64000");
  await select("Reasoning support", "on");
  await select("Reasoning effort", "low");
  await click("Save");
  await poll(() => JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).provider.connections[0].modelOverrides?.b?.contextWindowTokens === 64000);
  await input("document.querySelector('input[list=connection-drawer-model-suggestions]')", "a");
  assert.equal(await evaluate(`${field("Context window")}.value`), "128000");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Reasoning effort\"]').value"), "max");
  await evaluate(`${field("Context window")}.scrollIntoView({block:"center"})`);
  await sleep(400);
  const png = await call("Page.captureScreenshot", {format:"png"});
  writeFileSync(join(profile, "model-a-settings.png"), Buffer.from(png.data, "base64"));
  await click("Save");
  await click("Done");
  await evaluate("document.querySelector('.settings-dialog').dispatchEvent(new Event('cancel', {cancelable:true}))");
  await call("Page.reload", {});
  await poll(() => evaluate("!!document.querySelector('.sidebar-settings')"));
  const saved = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).provider.connections[0];
  assert.deepEqual(saved.modelOverrides, { a: {contextWindowTokens:128000, reasoningSupported:true, reasoningEffort:"max"}, b:{contextWindowTokens:64000, reasoningSupported:true, reasoningEffort:"low"} });
  assert(!Object.hasOwn(saved, "contextWindowTokens"));
  assert(!Object.hasOwn(saved, "contextWindowModel"));
  const info = await poll(() => existsSync(join(profile, "automation.json")) && JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")));
  async function api(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {method, headers:{Authorization:`Bearer ${info.token}`, "Content-Type":"application/json"}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  }
  const tab = await evaluate(`window.anycode.createTab({kind:'new', workspace:${JSON.stringify(profile)}})`);
  assert(tab.ok, JSON.stringify(tab));
  const pill = async () => {
    try { return await api(`/tabs/${tab.tabId}/model-pill`); }
    catch { return {ok:false}; }
  };
  await poll(async () => { const p = await pill(); return p.ok && p.currentModel === "a" && p.currentEffort === "max"; }, 30000);
  await api(`/tabs/${tab.tabId}/model-pill/pick`, "POST", {kind:"effort", value:"max"});
  async function turn(model, budget) {
    const text = `smoke-${model}-${fixtureRequests.length}`;
    await api(`/tabs/${tab.tabId}/prompt`, "POST", {text});
    const waited = await api("/wait", "POST", {tabId:tab.tabId, until:{transcriptIncludes:text, turnStatus:"idle"}, timeoutMs:15000});
    assert(waited.matched, `Turn did not finish: ${model}`);
    const state = (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId];
    assert.equal(state.contextUsage?.budgetTokens, budget, `Wrong context budget for ${model}`);
    assert(fixtureRequests.includes(model), `Fixture received no request for ${model}`);
  }
  await turn("a", 104000);
  await api(`/tabs/${tab.tabId}/model-pill/pick`, "POST", {kind:"model", value:"b"});
  await poll(async () => { const p = await pill(); return p.currentModel === "b" && p.currentEffort === "low"; });
  await turn("b", 40000);
  await api(`/tabs/${tab.tabId}/model-pill/pick`, "POST", {kind:"model", value:"a"});
  await poll(async () => { const p = await pill(); return p.currentModel === "a" && p.currentEffort === "max"; });
  await turn("a", 104000);
  await api(`/tabs/${tab.tabId}/model-pill/pick`, "POST", {kind:"model", value:"unknown"});
  await poll(async () => (await pill()).currentModel === "unknown");
  await turn("unknown", 2048);
  await api(`/tabs/${tab.tabId}/ctx-popover/open`, "POST", {open:true});
  await poll(() => evaluate("!!document.querySelector('.ctx-popover-assumed')"));
  assert(await evaluate("document.querySelector('.ctx-popover-assumed').textContent.includes('output reserve: 2K')"));
  await click("Set context window");
  await poll(() => evaluate("document.querySelector('.connection-drawer')?.open && document.activeElement?.type === 'number'"));
  assert.equal(await evaluate("document.querySelector('input[list=connection-drawer-model-suggestions]').value"), "unknown");
  assert.equal(await evaluate(`${field("Context window")}.value`), "");
  const shortcut = await call("Page.captureScreenshot", {format:"png"});
  writeFileSync(join(profile, "context-window-shortcut.png"), Buffer.from(shortcut.data, "base64"));
  console.log(`PASS: two model windows and efforts, A → B → A, persisted reload, live context budgets, assumed-window hint and focused settings shortcut. Evidence: ${profile}`);

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

/** Isolated first-run GUI check; no provider request or account login is made. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const profile = mkdtempSync(join(tmpdir(), "anycode-first-run-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const signedOutEngines = process.argv.includes("--signed-out-engines");
let codexBinary = binary;
let claudeBinary = binary;
if (signedOutEngines) {
  for (const engine of ["codex", "claude"]) {
    const fixture = fileURLToPath(new URL(`../src/main/${engine}-doctor-fixtures/fake-${engine}.mjs`, import.meta.url));
    const target = join(profile, `signed-out-${engine}`);
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@" --signed-out\n`, { mode: 0o700 });
    if (engine === "codex") codexBinary = target; else claudeBinary = target;
  }
}
const env = { ...process.env,
  ANYCODE_AUTOMATION: "1", REMOTE_DEBUGGING_PORT: String(port),
  ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"),
  ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
  ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
  ANYCODE_CODEX_BIN: codexBinary, ANYCODE_CLAUDE_BIN: claudeBinary,
  CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
};
for (const key of ["ANYCODE_API_KEY", "ANYCODE_MODEL", "ANYCODE_BASE_URL", "ANYCODE_PROVIDER", "ANYCODE_TRANSPORT", "ANYCODE_PROVIDER_ID", "ANYCODE_PROVIDER_TRANSPORT", "ANYCODE_AUTOMATIC_MODEL_ROUTING", "ANYCODE_ROUTING_ENV_OVERRIDE"]) delete env[key];
const app = launchSmokeElectron(spawn, { env, detached: true });
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
  await poll(() => evaluate("document.querySelectorAll('.welcome-paths .welcome-path').length === 3"));
  assert.equal(await evaluate("document.querySelectorAll('.welcome-subscription').length === 4"), true);
  assert.equal(await evaluate("document.querySelector('.connection-drawer-body') === null"), true);
  assert.equal(await evaluate("document.activeElement?.classList.contains('welcome-path')"), true);
  await sleep(500);
  const png = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "welcome.png"), Buffer.from(png.data, "base64"));
  await click("ChatGPT / CodexUse your ChatGPT account");
  await poll(() => evaluate("document.querySelector('.welcome-setup')?.textContent.includes('Codex')"));
  if (signedOutEngines) {
    await poll(() => evaluate("[...document.querySelectorAll('.welcome-setup button')].some(b => b.textContent === 'Sign in with a code')"));
    assert(await evaluate("[...document.querySelectorAll('.welcome-setup button')].some(b => b.textContent === 'Sign in with ChatGPT')"));
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, "codex-signed-out.png"), Buffer.from(shot.data, "base64"));
  }
  await click("Claude CodeUse your Claude account");
  await poll(() => evaluate("document.querySelector('.welcome-setup')?.textContent.includes('Claude')"));
  if (signedOutEngines) {
    await poll(() => evaluate("[...document.querySelectorAll('.welcome-setup button')].some(b => b.textContent === 'Sign in with Claude')"));
    assert(await evaluate("document.querySelector('.welcome-setup').textContent.includes('Terminal')"));
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, "claude-signed-out.png"), Buffer.from(shot.data, "base64"));
  }
  await click("Open settings");
  await poll(() => evaluate("document.querySelector('.settings-dialog')?.open"));
  await evaluate("document.querySelector('.settings-dialog').dispatchEvent(new Event('cancel', {cancelable:true}))");
  await poll(() => evaluate("!document.querySelector('.settings-dialog')?.open"));
  await click("API key or local modelConnect any provider or your own server");
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"));
  assert.equal(await evaluate("document.querySelector('.connection-drawer-advanced').open"), false);
  // No template picked yet: the Provider select sits on its empty option and
  // the key link is absent.
  assert.equal(await evaluate("document.querySelector('.welcome-setup select').value"), "");
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key') === null"), true);
  // Subscription shortcuts: each seeds the Provider template at mount and
  // links the provider's own key page; switching picks remounts the form.
  await click("GLM Coding PlanUse your Z.AI coding plan key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'z-ai'"));
  assert(await evaluate("document.querySelector('input[list=welcome-model-suggestions]').value.length > 0"));
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key a')?.href ?? null"), "https://z.ai/manage-apikey/apikey-list");
  assert.equal(await evaluate("document.querySelector('.connection-drawer-advanced').open"), false);
  await click("MiniMax M PlanUse your MiniMax M Plan key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'minimax'"));
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key a')?.href ?? null"), "https://platform.minimax.io/console/plan");
  await click("Kimi (kimi.com)Use your Kimi for Coding key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'kimi'"));
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key a')?.href ?? null"), "https://www.kimi.com/code/console");
  await click("OpenCode GoUse your OpenCode Go key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'opencode'"));
  assert.equal(await evaluate("document.querySelector('input[list=welcome-model-suggestions]').value"), "kimi-k3");
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key a')?.href"), "https://opencode.ai/console");
  assert.equal(await evaluate("document.querySelectorAll('.welcome-subscription').length"), 4);
  assert.equal(await evaluate("document.querySelectorAll('.welcome-setup option[value=opencode-openai]').length"), 0);
  assert.equal(await evaluate("[...document.querySelectorAll('.connection-drawer-advanced .settings-field-label')].some(e => e.textContent === 'Transport')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('.welcome-subscription')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.querySelector('strong').textContent).join()"), "OpenCode Go");
  assert.equal(await evaluate("[...document.querySelectorAll('.welcome-paths button')].some(b => b.getAttribute('aria-pressed') === 'true')"), false);
  const goPng = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "opencode-go.png"), Buffer.from(goPng.data, "base64"));
  await click("GLM Coding PlanUse your Z.AI coding plan key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'z-ai'"));
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key a')?.href ?? null"), "https://z.ai/manage-apikey/apikey-list");
  await click("OpenCode GoUse your OpenCode Go key");
  await poll(() => evaluate("document.querySelector('.welcome-setup select')?.value === 'opencode'"));
  assert(await evaluate("document.querySelector('.welcome-setup .ak-btn--primary').disabled"), "Missing API key must block Connect");
  await sleep(400);
  const setupPng = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "api-setup.png"), Buffer.from(setupPng.data, "base64"));
  await evaluate(`(() => { const input = document.querySelector('.connection-drawer-create-key'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'sk-first-run-smoke-only'); input.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  await click("Connect");
  await poll(() => evaluate("!document.querySelector('.welcome-screen') || !!document.querySelector('.consent-dialog')"));
  if (await evaluate("!!document.querySelector('.consent-dialog')")) {
    // This disposable fake credential never leaves this isolated smoke profile.
    await click("Store anyway");
  }
  await poll(() => evaluate("!document.querySelector('.welcome-screen')"));
  await poll(() => evaluate("!!document.querySelector('.start-screen')"));
  await call("Page.reload", {});
  // Post-reload the app boots to the empty task shell (zero tabs, no active
  // start-screen draft — the shell fallback since slice P7.12), so readiness
  // retained means exactly this: the welcome screen must not come back and
  // the shell must render.
  await poll(() => evaluate("!!document.querySelector('.sidebar-empty') && !document.querySelector('.welcome-screen')"));
  assert.equal(await evaluate("document.querySelector('.connection-drawer-body') === null"), true);
  const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
  assert.equal(settings.provider.connections.length, 1);
  assert.equal(settings.provider.connections[0].providerId, "opencode");
  assert.equal(settings.provider.connections[0].model, "kimi-k3");
  assert(!settings.provider.connections[0].baseUrl);
  assert(!settings.provider.connections[0].transport);
  assert(settings.provider.connections[0].model);
  assert(!JSON.stringify(settings).includes("sk-first-run-smoke-only"));
  console.log(`PASS: first-run choices, focus, engine panes, settings escape, subscription shortcuts (template seed + key link + pick switch), one-click API connection on the catalog default model, ready-profile reload. Evidence: ${profile}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) await call("Browser.close", {}).catch(() => {});
  ws?.close();
  if (existsSync(join(profile, "automation.json"))) {
    const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8"));
    try { process.kill(info.pid, "SIGTERM"); } catch {}
  }
  await sleep(500);
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
}

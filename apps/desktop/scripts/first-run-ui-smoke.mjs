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
  await poll(() => evaluate("[\"codex\", \"claude\", \"api\"].every(id => document.querySelector(`[data-welcome-path=\"${id}\"]`))"));
  assert.equal(await evaluate("document.querySelectorAll('.welcome-subscription').length === 4"), true);
  assert.equal(await evaluate("document.querySelector('.connection-drawer-body') === null"), true);
  assert.equal(await evaluate("document.activeElement?.matches('[data-welcome-path=\"codex\"]')"), true);
  await sleep(500);
  const png = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "welcome.png"), Buffer.from(png.data, "base64"));
  await evaluate("document.querySelector('[data-welcome-path=\"codex\"]').click()");
  await poll(() => evaluate("document.querySelector('.welcome-setup')?.textContent.includes('Codex')"));
  if (signedOutEngines) {
    await poll(() => evaluate("[...document.querySelectorAll('.welcome-setup button')].some(b => b.textContent === 'Sign in with a code')"));
    assert(await evaluate("[...document.querySelectorAll('.welcome-setup button')].some(b => b.textContent === 'Sign in with ChatGPT')"));
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, "codex-signed-out.png"), Buffer.from(shot.data, "base64"));
  }
  await evaluate("document.querySelector('[data-welcome-path=\"claude\"]').click()");
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
  await evaluate("document.querySelector('[data-welcome-path=\"api\"]').click()");
  await poll(() => evaluate("!!document.querySelector('.connection-drawer-body')"));
  assert.equal(await evaluate("document.querySelector('.connection-drawer-advanced').open"), false);
  // No template picked yet: the Provider select sits on its empty option and
  // the key link is absent.
  assert.equal(await evaluate("document.querySelector('.welcome-setup select').value"), "");
  assert.equal(await evaluate("document.querySelector('.welcome-subscription-key') === null"), true);
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const shot = async name => writeFileSync(join(profile, name), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const shotFull = async name => {
    const height = await evaluate("document.querySelector('.welcome-screen').scrollHeight + 80");
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height, deviceScaleFactor: 1, mobile: false });
    await sleep(200); await shot(name);
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  };
  const type = async (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const choices = [
    ["GLM Coding Plan", "Use your Z.AI coding plan key", "https://z.ai/subscribe", "https://z.ai/manage-apikey/apikey-list"],
    ["MiniMax M Plan", "Use your MiniMax M Plan key", "https://www.minimax.io/m-plan", "https://platform.minimax.io/console/plan"],
    ["Kimi (kimi.com)", "Use your Kimi for Coding key", "https://www.kimi.com/code", "https://www.kimi.com/code/console"],
    ["OpenCode Go", "Use your OpenCode Go key", "https://opencode.ai/go", "https://opencode.ai/console"],
  ];
  for (const [title, description, planUrl, keyUrl] of choices) {
    await click(title + description);
    await poll(() => evaluate("!!document.querySelector('.welcome-selected-subscription')"));
    assert.equal(await evaluate("document.querySelector('.welcome-selected-subscription strong').textContent"), title);
    assert.equal(await evaluate("document.querySelector('.welcome-selected-subscription a').href"), planUrl);
    assert.equal(await evaluate("document.querySelector('.welcome-key-link').href"), keyUrl);
    assert(await evaluate("document.querySelector('.welcome-paths').hidden"));
    assert(await evaluate("document.activeElement.matches('.connection-drawer-create-key')"));
    assert(await evaluate("!document.querySelector('.welcome-setup .connection-drawer-identity') && !document.querySelector('.welcome-setup [data-section]')"));
    assert(await evaluate("document.querySelector('.welcome-setup input').type === 'password'"));
    assert(await evaluate("document.querySelector('.connection-drawer-model-line button').textContent === '↻ Refresh'"));
    assert(await evaluate("document.querySelector('.connection-drawer-model-line button').disabled"));
    assert(await evaluate("document.querySelector('.connection-drawer-advanced').open === false && !!document.querySelector('.connection-drawer-advanced [aria-label=Pricing]')"));
    assert(await evaluate("!document.querySelector('.welcome-setup table')"));
    await type('.connection-drawer-create-key', 'sk-draft-smoke-only');
    await click('← Change');
    assert(await evaluate("!document.querySelector('.welcome-paths').hidden && document.querySelector('.welcome-setup').hidden"));
    await click(title + description);
    assert.equal(await evaluate("document.querySelector('.connection-drawer-create-key').value"), 'sk-draft-smoke-only');
    await type('.connection-drawer-create-key', '');
    await evaluate("document.querySelector('.connection-drawer-advanced summary').click()");
    await poll(() => evaluate("document.querySelector('.connection-drawer-advanced').open"));
    assert(await evaluate("!!document.querySelector('.connection-drawer-price-card')"));
    if (title.startsWith('Kimi')) assert(await evaluate("document.querySelector('.connection-drawer-price-card').textContent.includes('No per-token price')"));
    if (title.startsWith('Kimi')) {
      await click('Set price');
      await type('input[list=welcome-model-suggestions]', 'k3');
      await evaluate("document.querySelector('.connection-drawer-advanced summary').click()");
      await type('.connection-drawer-create-key', 'sk-local-validation-only');
      await click('Connect');
      await poll(() => evaluate("document.querySelector('.connection-drawer-advanced').open"));
      assert.equal(await evaluate("document.querySelector('.connection-drawer-price-card strong').textContent"), 'k3.1-pro');
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'k3.1-pro Input');
      assert(await evaluate("document.querySelector('.welcome-setup').textContent.includes('k3.1-pro: enter non-negative prices')"));
      await shotFull('pricing-validation.png');
      await click('Use inherited');
      await type('.connection-drawer-create-key', '');
    }
    if (title === 'OpenCode Go') {
      assert(await evaluate("document.querySelector('.connection-drawer-price-card').textContent.includes('Go reference price')"));
      await shotFull('pricing.png');
      await click('Edit');
      assert.equal(await evaluate("document.querySelectorAll('.connection-drawer-price-edit input').length"), 4);
      await shotFull('pricing-edit.png');
      await click('Use inherited');
      await evaluate("[...document.querySelectorAll('.welcome-setup button')].find(b => b.textContent.startsWith('Show all models')).click()");
      assert(await evaluate("document.querySelectorAll('.connection-drawer-price-list button').length > 1"));
      await shotFull('all-models.png');
      await evaluate("document.querySelectorAll('.connection-drawer-price-list button')[1].click()");
      assert.equal(await evaluate("document.querySelector('input[list=welcome-model-suggestions]').value"), await evaluate("document.querySelector('.connection-drawer-price-card strong').textContent"));
      await type('input[list=welcome-model-suggestions]', 'unknown-smoke-model');
      assert(await evaluate("document.querySelector('.connection-drawer-price-card').textContent.includes('Price unknown')"));
      await click('Set price');
      assert(await evaluate("!!document.querySelector('.connection-drawer-price-edit input')"));
      await click('Use inherited');
    }
    await evaluate("document.querySelector('.connection-drawer-advanced summary').click()");
    await click('← Change');
  }
  await click("GLM Coding PlanUse your Z.AI coding plan key");
  await type('.connection-drawer-create-key', 'sk-reset-smoke-only');
  await click('← Change');
  await click("OpenCode GoUse your OpenCode Go key");
  assert.equal(await evaluate("document.querySelector('.connection-drawer-create-key').value"), '');
  assert.equal(await evaluate("document.querySelector('input[list=welcome-model-suggestions]').value"), "kimi-k3");
  assert(await evaluate("document.querySelector('.welcome-setup .ak-btn--primary').disabled"));
  await sleep(400);
  assert(await evaluate("(() => { const b = document.querySelector('.welcome-setup .ak-btn--primary').getBoundingClientRect(); return b.top > 0 && b.bottom <= 800; })()"), 'Connect must fit on one screen');
  await shot('api-setup.png');
  await type('.connection-drawer-create-key', 'sk-first-run-smoke-only');
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

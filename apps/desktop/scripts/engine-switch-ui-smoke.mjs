/** Isolated engine-switch acceptance: loopback model and executable native doubles. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const profile = mkdtempSync(join(tmpdir(), "anycode-engine-switch-"));
const fixturePath = fileURLToPath(new URL("../src/host/engine-switch-fixtures/native-double.mjs", import.meta.url));
const binaries = {};
const consents = [];
for (const engine of ["codex", "claude"]) {
  const binary = join(profile, `${engine}-double`);
  const source = readFileSync(fixturePath, "utf8").replace(/^#![^\n]*\n/, "");
  const prefix = `#!${realpathSync(process.execPath)}\nprocess.argv.push(${JSON.stringify(`--double-log=${join(profile, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n`;
  writeFileSync(binary, prefix + source, { mode: 0o700 });
  const stat = statSync(binary);
  consents.push({ path: realpathSync(binary), fingerprint: { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs }, grantedAt: new Date().toISOString() });
  binaries[engine] = binary;
}
let providerCalls = 0;
const fixture = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (request.method === "GET") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "core-model" }] })); return; }
    const input = JSON.parse(body);
    assert.equal(input.model, "core-model");
    providerCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "local-fixture", object: "chat.completion.chunk", created: 0, model: input.model };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "core fixture answer" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2,
  provider: { activeConnectionId: "local", custom: [{ id: "custom:local", name: "Local fixture", baseUrl, kind: "openai-compatible", models: ["core-model"] }], connections: [{ id: "local", providerId: "custom:local", model: "core-model", models: ["core-model"], transport: "openai-chat-completions", baseUrl, authOptional: true }] },
  tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false, trustedBinaries: consents },
}));
writeFileSync(join(profile, "unavailable-engine"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = { ...buildSmokeEnv(process.env, profile, 0, binaries.codex), ANYCODE_CLAUDE_BIN: binaries.claude, ANYCODE_ENGINE_SWITCH_ENABLED: "1", ANYCODE_ISOLATED_NATIVE_FIXTURES: "1", ANYCODE_ISOLATED_FIXTURE_NODE: realpathSync(process.execPath) };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let launchLog = "";
app.stdout.on("data", chunk => { launchLog += chunk; });
app.stderr.on("data", chunk => { launchLog += chunk; });
let cdp;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error("Timed out waiting for isolated engine-switch state");
}
async function evaluate(expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: poll });
  const info = await poll(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (path, method = "GET", body) => { const result = await cdp.automation(info, path, method, body); assert(result.ok, JSON.stringify(result.result)); return result.result; };
  await poll(() => evaluate("typeof window.anycode?.createTab === 'function'"));
  const tab = await evaluate(`window.anycode.createTab({ kind: 'new', workspace: ${JSON.stringify(profile)} })`);
  assert(tab.ok, JSON.stringify(tab));
  await poll(() => evaluate("!!document.querySelector('button[aria-label=\"Switch engine\"]')"));
  async function turn(text) {
    const before = await evaluate("document.querySelectorAll('.message-loop-end').length");
    await api(`/tabs/${tab.tabId}/prompt`, "POST", { text });
    await poll(async () => (await evaluate("document.querySelectorAll('.message-loop-end').length")) > before);
    await poll(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId].turn.status === "idle");
  }
  await turn("original conversation");
  let boundaries = 0;
  // Covers every directed engine pair without creating another host or tab.
  for (const engine of ["codex", "claude", "core", "claude", "codex", "core"]) {
    await evaluate("document.querySelector('button[aria-label=\"Switch engine\"]').click()");
    await poll(() => evaluate(`!![...document.querySelectorAll('select[aria-label="Target engine and model"] option')].find(option => option.textContent.startsWith(${JSON.stringify(engine === "core" ? "Core ·" : engine === "codex" ? "Codex ·" : "Claude ·")}))`));
    assert(await evaluate("document.querySelector('[role=dialog][aria-label=\"Switch engine and model\"]').textContent.includes('Native engine context will not be transferred.')"));
    if (boundaries === 0) {
      const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(profile, "picker.png"), Buffer.from(shot.data, "base64"));
    }
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Target engine and model"]'); const option = [...select.options].find(option => option.textContent.startsWith(${JSON.stringify(engine === "core" ? "Core ·" : engine === "codex" ? "Codex ·" : "Claude ·")})); select.value = option.value; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Switch engine').click()");
    await poll(() => evaluate(`document.querySelector('button[aria-label="Switch engine"]')?.textContent === ${JSON.stringify(`${engine} ▾`)}`));
    boundaries++;
    assert.equal(await evaluate("document.querySelectorAll('[data-block-id^=\"engine-boundary:\"]').length"), boundaries);
    const db = new DatabaseSync(join(profile, "db.sqlite"), { readOnly: true });
    try {
      const identity = db.prepare("SELECT engine_id, model FROM sessions ORDER BY updated_at DESC LIMIT 1").get();
      assert.equal(identity.engine_id, engine);
      assert.equal(identity.model, engine === "core" ? "core-model" : engine === "codex" ? "model-first" : "default");
    } finally { db.close(); }
    await turn(`turn after switch ${boundaries}`);
  }
  assert(providerCalls >= 3);
  assert.equal(await evaluate("document.querySelectorAll('[data-block-id^=\"engine-boundary:\"]').length"), 6);
  const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "all-pairs.png"), Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ ok: true, enginePairs: 6, boundaries: 6, profile }));
} catch (error) {
  writeFileSync(join(profile, "launcher.log"), launchLog);
  console.error(`Isolated artifacts: ${profile}`);
  throw error;
} finally {
  cdp?.ws.close();
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  try { process.kill(-app.pid, "SIGKILL"); } catch {}
  await new Promise(resolve => fixture.close(resolve));
}

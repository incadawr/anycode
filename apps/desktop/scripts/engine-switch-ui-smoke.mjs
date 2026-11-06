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
  const prefix = `#!${realpathSync(process.execPath)}\nprocess.argv.push("--double-orchestration", ${JSON.stringify(`--double-log=${join(profile, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n`;
  writeFileSync(binary, prefix + source, { mode: 0o700 });
  const stat = statSync(binary);
  consents.push({ path: realpathSync(binary), fingerprint: { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs }, grantedAt: new Date().toISOString() });
  binaries[engine] = binary;
}
let providerCalls = 0;
const providerInputs = [];
const fixture = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (request.method === "GET") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "core-model" }] })); return; }
    const input = JSON.parse(body);
    assert(["core-model","core-other"].includes(input.model));
    providerCalls++;
    providerInputs.push(input.messages);
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
  provider: { activeConnectionId: "local", custom: [{ id: "custom:local", name: "Local fixture", baseUrl, kind: "openai-compatible", models: ["core-model","core-other"] }], connections: [{ id: "local", providerId: "custom:local", model: "core-model", models: ["core-model","core-other"], transport: "openai-chat-completions", baseUrl, authOptional: true, modelOverrides:{"core-model":{contextWindowTokens:128000,imageInput:"on",reasoningSupported:true,effortLevels:["low","high"]},"core-other":{contextWindowTokens:64000,imageInput:"off",reasoningSupported:false}} }] },
  roles:{executor:{primary:{connection:"local",model:"core-model"}}},
  tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false, trustedBinaries: consents },
}));
writeFileSync(join(profile, "unavailable-engine"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = { ...buildSmokeEnv(process.env, profile, 0, binaries.codex), ANYCODE_CLAUDE_BIN: binaries.claude, ANYCODE_ENGINE_SWITCH_ENABLED: "1", ANYCODE_ISOLATED_NATIVE_FIXTURES: "1", ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES: "1", ANYCODE_ISOLATED_FIXTURE_NODE: realpathSync(process.execPath) };
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
  let tab = await evaluate(`window.anycode.createTab({ kind: 'new', workspace: ${JSON.stringify(profile)} })`);
  assert(tab.ok, JSON.stringify(tab));
  await poll(() => evaluate("!!document.querySelector('button[aria-label=\"Switch engine\"]')"));
  async function turn(text) {
    const before = await evaluate("document.querySelectorAll('.message-loop-end').length");
    await api(`/tabs/${tab.tabId}/prompt`, "POST", { text });
    await poll(async () => (await evaluate("document.querySelectorAll('.message-loop-end').length")) > before);
    await poll(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId].turn.status === "idle");
  }
  const originalTexts = ["original conversation"];
  await turn(originalTexts[0]);
  const logicalSessionId = (() => {
    const db = new DatabaseSync(join(profile,"db.sqlite"),{readOnly:true});
    try { return db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1").get().id; }
    finally { db.close(); }
  })();
  const placeholder = await evaluate(`window.anycode.createTab({kind:'new',workspace:${JSON.stringify(profile)}})`);
  assert(placeholder.ok,JSON.stringify(placeholder));
  const readRuntime = () => {
    const db = new DatabaseSync(join(profile,"db.sqlite"),{readOnly:true});
    try {
      const row = db.prepare("SELECT id,engine_id,model,codex_profile_id,active_runtime_segment FROM sessions WHERE id=?").get(logicalSessionId);
      return {row,segment:db.prepare("SELECT native_state,selected_json,applied_json FROM runtime_segments WHERE session_id=? AND segment_id=?").get(row.id,row.active_runtime_segment),handoff:JSON.parse(db.prepare("SELECT data FROM runtime_handoffs WHERE session_id=? AND segment_id=?").get(row.id,row.active_runtime_segment)?.data ?? "null"),items:db.prepare("SELECT data FROM runtime_transcript WHERE session_id=? ORDER BY seq").all(row.id).map(item => JSON.parse(item.data)),boundaries:db.prepare("SELECT data FROM runtime_boundaries WHERE session_id=?").all(row.id)};
    } finally { db.close(); }
  };
  async function verify(engine,boundaries) {
    await poll(() => evaluate(`document.querySelector('button[aria-label="Switch engine"]')?.textContent === ${JSON.stringify(`${engine} ▾`)}`));
    await poll(async () => (await evaluate("document.querySelectorAll('[data-block-id^=\"engine-boundary:\"]').length")) === boundaries);
    const runtime = readRuntime();
    assert.equal(runtime.row.engine_id,engine);
    assert.equal(runtime.row.model,engine === "core" ? "core-model" : engine === "codex" ? "model-first" : "default");
    if (engine === "codex") assert.equal(runtime.row.codex_profile_id,"system");
    assert.equal(runtime.boundaries.length,boundaries);
    for (const text of originalTexts) {
      assert.equal(runtime.items.filter(item => item.message.role === "user" && item.message.content === text).length,1,`canonical once: ${text}`);
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.message-user')).filter(node => node.textContent.includes(${JSON.stringify(text)})).length`),1,`renderer once: ${text}`);
    }
    assert(!runtime.items.some(item => item.message.role === "user" && typeof item.message.content === "string" && item.message.content.includes("# user (current message)")));
  }
  let rendererReloads = 0;
  let hostRestarts = 0;
  async function reload(engine,boundaries) {
    rendererReloads++;
    await cdp.call("Page.reload");
    await poll(() => evaluate("typeof window.anycode?.createTab === 'function'"));
    await verify(engine,boundaries);
  }
  async function restartHost(engine,boundaries) {
    hostRestarts++;
    const sessionId = readRuntime().row.id;
    const closed = await evaluate(`window.anycode.closeTab(${JSON.stringify(tab.tabId)})`);
    assert(closed.ok,JSON.stringify(closed));
    tab = await evaluate(`window.anycode.createTab({kind:'resume',sessionId:${JSON.stringify(sessionId)}})`);
    assert(tab.ok,JSON.stringify(tab));
    await evaluate(`window.anycode.selectTab(${JSON.stringify(tab.tabId)})`);
    await reload(engine,boundaries);
  }
  const state = async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId];
  async function pick(kind,value) {
    const result = await api(`/tabs/${tab.tabId}/model-pill/pick`,"POST",{kind,value});
    assert.equal(result.ok,true,JSON.stringify({kind,value,result}));
  }
  async function controls(engine) {
    console.log(JSON.stringify({stage:"controls",engine}));
    const original = engine === "core" ? "core-model" : engine === "codex" ? "model-first" : "default";
    const alternate = engine === "core" ? "core-other" : engine === "codex" ? "model-chosen" : "haiku";
    await pick("model",alternate);
    await poll(() => JSON.parse(readRuntime().segment.selected_json).model === alternate);
    if (engine !== "claude") assert.equal(await evaluate("document.querySelector('button[aria-label=\"Attach image\"]')?.disabled"),true,`${engine} text-only gate`);
    await pick("model",original);
    await poll(() => JSON.parse(readRuntime().segment.selected_json).model === original);
    await pick("effort","high");
    await poll(() => JSON.parse(readRuntime().segment.selected_json).effort === "high");
    assert.equal(await evaluate("document.querySelector('button[aria-label=\"Attach image\"]')?.disabled"),false,`${engine} image gate`);
    if (engine === "core") {
      await api(`/tabs/${tab.tabId}/mode`,"POST",{mode:"edit"});
      await poll(async () => (await state()).mode === "edit");
      await api(`/tabs/${tab.tabId}/mode`,"POST",{mode:"plan"});
      await poll(async () => (await state()).mode === "plan");
    } else {
      await evaluate("document.querySelector('button[aria-label=\"Codex permission preset\"]').click()");
      await poll(() => evaluate("!![...document.querySelectorAll('[role=menuitemradio]')].find(button => button.querySelector('.model-pill-item-name')?.textContent === 'Ask for approval' || button.querySelector('.model-pill-item-name')?.textContent === 'Ask')"));
      await evaluate("[...document.querySelectorAll('[role=menuitemradio]')].find(button => button.querySelector('.model-pill-item-name')?.textContent === 'Ask for approval' || button.querySelector('.model-pill-item-name')?.textContent === 'Ask').click()");
      await poll(() => JSON.parse(readRuntime().segment.selected_json).mode === "ask");
      if (engine === "codex") {
        assert.equal(JSON.parse(readRuntime().segment.applied_json).mode,"read-only");
        await evaluate("document.querySelector('button[aria-label=\"Codex speed\"]').click()");
        await poll(() => JSON.parse(readRuntime().segment.selected_json).fast === true);
      }
    }
  }
  async function switchTo(engine) {
    await evaluate("document.querySelector('button[aria-label=\"Switch engine\"]').click()");
    const label = engine === "core" ? "Core ·" : engine === "codex" ? "Codex ·" : "Claude ·";
    await poll(() => evaluate(`!![...document.querySelectorAll('select[aria-label="Target engine and model"] option')].find(option => option.textContent.startsWith(${JSON.stringify(label)}))`));
    await evaluate(`(() => {const select = document.querySelector('select[aria-label="Target engine and model"]'); select.value = [...select.options].find(option => option.textContent.startsWith(${JSON.stringify(label)})).value; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Switch engine').click()");
  }
  let boundaries = 0;
  // Covers every directed engine pair with fresh host boots around each target turn.
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
    assert.equal((await state()).contextUsage,null,`${engine} context reset`);
    await controls(engine);
    await reload(engine,boundaries);
    await restartHost(engine,boundaries);
    assert.equal(JSON.parse(readRuntime().segment.selected_json).effort,"high");
    assert.equal(readRuntime().segment.native_state,"fresh");
    assert.equal(readRuntime().handoff.state,"pending");
    const text = `turn after switch ${boundaries}`;
    await turn(text);
    originalTexts.push(text);
    await poll(() => readRuntime().handoff.state === "accepted");
    assert.equal(readRuntime().segment.native_state,"materialized");
    await poll(() => JSON.parse(readRuntime().segment.applied_json).effort === "high");
    await reload(engine,boundaries);
    await restartHost(engine,boundaries);
    await verify(engine,boundaries);
  }
  assert(providerCalls >= 3);
  const messages = engine => readFileSync(join(profile,`${engine}.jsonl`),"utf8").trim().split("\n").map(line => JSON.parse(line));
  const codexMessages = messages("codex");
  const claudeMessages = messages("claude");
  const wireInputs = [
    ...codexMessages.filter(message => message.method === "turn/start").map(message => message.params.input.map(item => item.text ?? "").join("")),
    ...claudeMessages.filter(message => message.type === "user").map(message => typeof message.message.content === "string" ? message.message.content : message.message.content.map(item => item.text ?? "").join("")),
    ...providerInputs.slice(1).map(items => { const content = items.findLast(item => item.role === "user")?.content; return typeof content === "string" ? content : content?.map(item => item.text ?? "").join(""); }),
  ];
  for (const index of [1,2,3,4,5,6]) {
    const wire = wireInputs.find(input => typeof input === "string" && input.split("# user (current message)\n")[1]?.startsWith(`turn after switch ${index}`));
    assert(wire?.includes("original conversation"),`first imported wire turn ${index}`);
    assert.equal(wire.split("# user (current message)").length,2,`one import prefix ${index}`);
  }
  const db = new DatabaseSync(join(profile,"db.sqlite"),{readOnly:true});
  try {
    const refs = db.prepare("SELECT engine,native_ref FROM runtime_segments WHERE session_id=?").all(logicalSessionId);
    const codexRefs = new Set(refs.filter(ref => ref.engine === "codex").map(ref => ref.native_ref));
    const claudeRefs = new Set(refs.filter(ref => ref.engine === "claude").map(ref => ref.native_ref));
    for (const message of codexMessages.filter(message => message.method === "thread/resume")) {
      assert(codexRefs.has(message.params.threadId)); assert(!claudeRefs.has(message.params.threadId));
    }
    for (const message of claudeMessages.filter(message => message.fixtureBoot?.args.includes("--resume"))) {
      const args = message.fixtureBoot.args; const ref = args[args.indexOf("--resume")+1];
      assert(claudeRefs.has(ref)); assert(!codexRefs.has(ref));
    }
  } finally { db.close(); }
  assert.equal(await evaluate("document.querySelectorAll('[data-block-id^=\"engine-boundary:\"]').length"), 6);
  await api(`/tabs/${tab.tabId}/orchestrate`,"POST",{enabled:true});
  await poll(async () => (await state()).orchestrateActive);
  for (const engine of ["codex","core"]) {
    await switchTo(engine); boundaries++;
    await verify(engine,boundaries);
    assert.equal((await state()).orchestrateActive,true);
    // Exercise the committed core candidate before a host boot can rebuild its services.
    if (engine !== "core") {
      await restartHost(engine,boundaries);
      assert.equal((await state()).orchestrateActive,true,`${engine} overlay restored`);
    }
    const text = `orchestrated target ${engine}`;
    await turn(text); originalTexts.push(text);
    await reload(engine,boundaries);
    await restartHost(engine,boundaries);
    assert.equal((await state()).orchestrateActive,true,`${engine} overlay resumed after target turn`);
  }
  await switchTo("claude");
  await poll(() => evaluate("!document.querySelector('[role=dialog][aria-label=\"Switch engine and model\"]')"));
  await poll(() => evaluate("!!document.querySelector('.toast') || document.body.textContent.includes('orchestration')"));
  assert.equal(readRuntime().row.engine_id,"core");
  assert.equal(readRuntime().boundaries.length,boundaries);
  assert.equal((await state()).orchestrateActive,true);
  await turn("source survives Claude orchestration refusal");
  originalTexts.push("source survives Claude orchestration refusal");
  await verify("core",boundaries);
  const policyFrames = messages("codex");
  assert(policyFrames.some(frame => frame.fixtureBoot?.args.includes("features.multi_agent=false")),"process policy overlay was configured");
  assert(policyFrames.some(frame => frame.method === "thread/resume" && frame.params.approvalPolicy === "never"),"native policy was applied");
  await api(`/tabs/${tab.tabId}/orchestrate`,"POST",{enabled:false});
  await poll(async () => !(await state()).orchestrateActive);
  // Direct core → codex → core, with no restart between commit and compaction.
  for (const engine of ["codex","core"]) {
    await switchTo(engine); boundaries++;
    await verify(engine,boundaries);
  }
  await turn("core services after round trip");
  originalTexts.push("core services after round trip");
  await evaluate("document.querySelector('.composer-textarea').focus()");
  await cdp.call("Input.insertText",{text:"/compact"});
  await cdp.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await cdp.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  const compactionCount = () => {
    const db = new DatabaseSync(join(profile,"db.sqlite"),{readOnly:true});
    try {return db.prepare("SELECT count(*) AS n FROM compaction_records WHERE session_id=?").get(logicalSessionId).n;}
    finally {db.close();}
  };
  await poll(() => compactionCount() > 0);
  await poll(async () => (await state()).turn.status === "idle");
  await reload("core",boundaries);
  await restartHost("core",boundaries);
  assert(compactionCount() > 0,"round-trip compaction survives restart");
  const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(profile, "all-pairs.png"), Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ ok: true, enginePairs: 6, boundaries, rendererReloads, hostRestarts, settingsChecks:6, orchestrationSwitches:2, coreServiceRoundTrips:1, durableCompactionChecks:1, claudeOrchestrationRefusals:1, canonicalOriginals:originalTexts.length, profile }));
} catch (error) {
  writeFileSync(join(profile, "launcher.log"), launchLog);
  if (cdp) { try { writeFileSync(join(profile,"failure-page.txt"),await evaluate("document.body.innerText")); } catch {} }
  console.error(`Isolated artifacts: ${profile}`);
  throw error;
} finally {
  cdp?.ws.close();
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  try { process.kill(-app.pid, "SIGKILL"); } catch {}
  await new Promise(resolve => fixture.close(resolve));
}

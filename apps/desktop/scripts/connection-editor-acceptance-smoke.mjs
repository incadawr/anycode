/** Independent connection editor acceptance using a disposable profile and loopback fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const profile = mkdtempSync(join(tmpdir(), "anycode-connection-editor-acceptance-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
const debugPort = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
let failFetch = false;
let fetches = 0;
const fixture = createHttpServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    fetches++;
    if (failFetch) { response.writeHead(503); response.end("unavailable"); return; }
    response.writeHead(200, {"Content-Type":"application/json"});
    response.end(JSON.stringify({data: [{id:"alpha"}, {id:"remote",supported_parameters:["reasoning"],architecture:{input_modalities:["text","image"]}}, {id:"bad model"}]}));
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", {mode:0o700});
writeFileSync(join(profile, "settings.json"), JSON.stringify({
  version:2, provider:{activeConnectionId:"conn-one", custom:[{id:"custom:fixture",name:"Fixture",baseUrl:fixtureUrl,kind:"openai-compatible",models:["alpha"],authOptional:true}],connections:[
    {id:"conn-one",providerId:"custom:fixture",label:"One",model:"alpha",authOptional:true},
    {id:"conn-two",providerId:"custom:fixture",label:"Two",model:"alpha",authOptional:true},
    {id:"conn-catalog",providerId:"vllm",label:"Catalog fixture",model:"alpha",baseUrl:fixtureUrl,authOptional:true,models:["alpha"],modelCapabilities:{alpha:{reasoning:true}}},
  ]}, tools:{}, permissions:{alwaysAllow:[]}, ui:{theme:"dark"}, security:{allowWeakSecretStorage:false},
}));
const env = buildSmokeEnv(process.env, profile, debugPort, binary);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = launchSmokeElectron(spawn, {env, cwd: repoRoot, detached:true});
let ws;
let nextId = 0;
const pending = new Map();
async function poll(fn, timeout=30000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) { const value=await fn(); if (value) return value; await delay(100); }
  throw new Error("Timed out waiting for UI state");
}
function call(method,params) {
  const id=++nextId;
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); },10000);
    pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector) {
  assert(await evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)return false;node.click();return true})()`), `Cannot click ${selector}`);
  await delay(180);
}
async function button(text, root=".connection-drawer") {
  assert(await evaluate(`(() => {const root=document.querySelector(${JSON.stringify(root)});const node=[...(root?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!node||node.disabled)return false;node.click();return true})()`), `Missing button ${text}`);
  await delay(180);
}
async function input(selector,value) {
  await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await delay(120);
}
async function selectLabel(label,value) {
  await evaluate(`(() => {const label=[...document.querySelectorAll('label.settings-field')].find(e=>e.querySelector('.settings-field-label')?.textContent.trim()===${JSON.stringify(label)});const el=label?.querySelector('select');if(!el)throw Error('select missing');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await delay(200);
}
async function screenshot(name) {
  await delay(250);
  const result=await call("Page.captureScreenshot",{format:"png"});
  writeFileSync(join(profile,name),Buffer.from(result.data,"base64"));
}
const snapshot=()=>JSON.parse(readFileSync(join(profile,"settings.json"),"utf8"));
async function editConnection(id) {
  const tile=`[data-connection-id="${id}"]`;
  await click(`${tile} .connection-tile-menu-trigger`);
  await button("Edit",tile);
  await poll(()=>evaluate("document.querySelector('.connection-drawer')?.open"));
}
const editFirst=()=>editConnection("conn-one");

try {
  const identity = await poll(() => { try { return JSON.parse(readFileSync(join(profile, "identity.json"), "utf8")); } catch { return null; } });
  assert.equal(identity.nonce, env.ANYCODE_SMOKE_IDENTITY);
  assert.equal(identity.desktopRoot, realpathSync(env.ANYCODE_EXPECTED_DESKTOP_ROOT));
  assert.equal(identity.userData, realpathSync(join(profile, "user-data")));
  assert.equal(identity.sessionData, realpathSync(join(profile, "session-data")));
  const target=await poll(async()=>{try{return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t=>t.type==="page"&&!t.url.startsWith("devtools://"));}catch{return false;}},60000);
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=({data})=>{const msg=JSON.parse(data);const item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);msg.error?item.reject(new Error(JSON.stringify(msg.error))):item.resolve(msg.result);};
  await poll(()=>evaluate("!!document.querySelector('.sidebar-settings')"));
  await click('.sidebar-settings');
  await click('#settings-tab-provider');
  await poll(()=>evaluate("!!document.querySelector('[data-connection-id=\"conn-one\"]')"));
  await editFirst();
  assert(await evaluate("document.querySelector('.connection-drawer').textContent.includes('Not set')"));
  await screenshot("01-existing-dark.png");
  await click('.connection-drawer-model-open');
  await poll(()=>evaluate("!!document.querySelector('.connection-drawer-model-popup')"));
  await poll(()=>fetches>0);
  await poll(()=>evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].some(e=>e.textContent.includes('remote'))"));
  assert.equal(await evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].some(e=>e.textContent.includes('bad model'))"),false,"invalid endpoint model must be excluded");
  await screenshot("02-model-popup-dark.png");
  await evaluate("document.querySelector('[aria-label=\"Filter models\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await poll(()=>evaluate("!document.querySelector('.connection-drawer-model-popup')"));
  assert.deepEqual(snapshot().provider.custom[0].models,["alpha"],"cancel must not mutate shared provider");
  assert.equal(snapshot().provider.connections[1].visibleModels,undefined,"sibling selection must remain unchanged");
  await click('.connection-drawer-model-open');
  await poll(()=>evaluate("!!document.querySelector('[aria-label=\"Manual model ID\"]')"));
  await evaluate("(() => { const row=[...document.querySelectorAll('.connection-drawer-popup-row')].find(e=>e.querySelector('button')?.getAttribute('aria-label')==='Set remote as default'); const box=row.querySelector('input'); if (!box.checked) box.click(); })()");
  await input('[aria-label="Manual model ID"]',"manual-model");
  await click('.connection-drawer-model-add');
  await poll(()=>evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].some(e=>e.textContent.includes('manual-model'))"));
  await evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].find(e=>e.querySelector('button')?.getAttribute('aria-label')==='Set alpha as default').querySelector('input').click()");
  await click('.connection-drawer-model-done');
  await button("Save");
  await poll(()=>snapshot().provider.connections.find(c=>c.id==="conn-one")?.visibleModels?.includes("manual-model"));
  assert.equal(snapshot().provider.connections.find(c=>c.id==="conn-one").model,"remote","first selected model must become the default");
  assert.deepEqual(snapshot().provider.custom[0].models,["alpha"]);
  assert.equal(snapshot().provider.connections[1].visibleModels,undefined);
  await click('.connection-drawer-close');
  await editFirst();
  assert(await evaluate("[...document.querySelectorAll('.connection-drawer-model-chip')].some(e=>e.dataset.modelId==='manual-model')"),"manual model must survive reopening");
  await click('[aria-label="manual-model set custom price"]');
  await input('[aria-label="manual-model Input"]',"1.25");
  await input('[aria-label="manual-model Cached input"]',"0.5");
  await input('[aria-label="manual-model Output"]',"2.5");
  await screenshot("03-pricing-dark.png");
  await button("Save");
  await poll(()=>snapshot().provider.connections.find(c=>c.id==="conn-one")?.modelOverrides?.["manual-model"]?.pricing?.input===1.25);
  await click('[aria-label="manual-model use inherited price"]');
  await button("Save");
  await poll(()=>!snapshot().provider.connections.find(c=>c.id==="conn-one")?.modelOverrides?.["manual-model"]?.pricing);
  await evaluate("document.querySelector('.connection-drawer-advanced').open=true;document.querySelector('.connection-drawer-advanced').scrollIntoView({block:'start'})");
  await screenshot("04-advanced-dark.png");
  await evaluate("document.querySelector('.connection-drawer-model-open').scrollIntoView({block:'center'})");
  await click('.connection-drawer-model-open');
  failFetch=true;
  await button("Refresh",'.connection-drawer-model-popup');
  await poll(()=>evaluate("!!document.querySelector('.connection-drawer-model-popup [role=alert]')"));
  await screenshot("05-fetch-error-dark.png");
  failFetch=false;
  await evaluate("document.querySelector('[aria-label=\"Filter models\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await click('.connection-drawer-close');
  await editConnection("conn-catalog");
  const beforeCatalog = snapshot().provider.connections.find(c=>c.id==="conn-catalog");
  const fetchCountBefore = fetches;
  await click('.connection-drawer-model-open');
  await poll(()=>fetches>fetchCountBefore);
  await poll(()=>evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].some(e=>e.textContent.includes('remote'))"));
  await evaluate("document.querySelector('[aria-label=\"Filter models\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await poll(()=>evaluate("!document.querySelector('.connection-drawer-model-popup')"));
  const canceledCatalog = snapshot().provider.connections.find(c=>c.id==="conn-catalog");
  assert.deepEqual(canceledCatalog.models,beforeCatalog.models,"cancel must not save fetched catalog model IDs");
  assert.deepEqual(canceledCatalog.modelCapabilities,beforeCatalog.modelCapabilities,"cancel must not save fetched model capabilities");
  await click('.connection-drawer-close');
  await editConnection("conn-catalog");
  await click('.connection-drawer-model-open');
  await poll(()=>evaluate("[...document.querySelectorAll('.connection-drawer-popup-row')].some(e=>e.textContent.includes('remote'))"));
  await poll(()=>evaluate("!document.querySelector('.connection-drawer-model-done')?.disabled"));
  await click('.connection-drawer-model-done');
  await button("Save");
  await poll(()=>snapshot().provider.connections.find(c=>c.id==="conn-catalog")?.modelCapabilities?.remote?.imageInput===true);
  const savedCatalog = snapshot().provider.connections.find(c=>c.id==="conn-catalog");
  assert(savedCatalog.models.includes("remote"),"fetched IDs must persist on save");
  assert.equal(savedCatalog.modelCapabilities.remote.reasoning,true,"fetched capability must persist on save");
  assert(savedCatalog.visibleModels.includes("remote"),"selected model must persist on save");
  await screenshot("06-catalog-saved-dark.png");
  await click('.connection-drawer-close');
  await click('#settings-tab-appearance');
  await selectLabel("Theme","light");
  await poll(()=>evaluate("document.documentElement.dataset.theme==='light'"));
  await click('#settings-tab-provider');
  await editFirst();
  await screenshot("06-existing-light.png");
  await click('.connection-drawer-close');
  await click('.connection-tile-add');
  await poll(()=>evaluate("document.querySelector('.connection-drawer')?.open"));
  await screenshot("07-new-empty-light.png");
  await selectLabel("Provider","custom");
  await poll(()=>evaluate("!![...document.querySelectorAll('.connection-drawer label')].find(e=>e.textContent.includes('Provider name'))"));
  await selectLabel("Kind","anthropic");
  assert(await evaluate("document.querySelector('.connection-drawer-no-auth input').disabled"),"Anthropic keyless toggle must be disabled");
  assert(await evaluate("document.querySelector('.connection-drawer').textContent.includes('always requires an API key')"));
  await screenshot("08-new-anthropic-no-key-light.png");
  console.log(`PASS independent connection editor acceptance; evidence: ${profile}`);
} catch(error) {
  console.error(`FAIL independent connection editor acceptance; evidence: ${profile}`);
  throw error;
} finally {
  try { ws?.close(); } catch {}
  try { process.kill(-app.pid,"SIGTERM"); } catch { try {app.kill("SIGTERM");}catch{} }
  await new Promise(resolve=>fixture.close(resolve));
}

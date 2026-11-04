import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';

const profile = mkdtempSync(join(tmpdir(), 'anycode-session-isolation-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixture = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
  const input = JSON.parse(body); const prompt = JSON.stringify(input.messages.findLast(m => m.role === 'user')?.content ?? '');
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: input.model };
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({...base, choices:[{index:0, delta:{role:'assistant', content:`Fixture response ${prompt}`}, finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({...base, choices:[{index:0, delta:{}, finish_reason:'stop'}], usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\ndata: [DONE]\n\n`);
}); });
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fixture.address().port}/v1`;
const binary = join(profile, 'unavailable-engine'); writeFileSync(binary, '#!/bin/sh\nexit 1\n', {mode:0o700});
const env = buildSmokeEnv(process.env, profile, 0, binary);
const canonical = realpathSync(profile);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({version:2,provider:{activeConnectionId:'conn-smoke',custom:[{id:'custom:smoke',name:'Smoke',baseUrl:url,kind:'openai-compatible',models:['a']}],connections:[{id:'conn-smoke',providerId:'custom:smoke',label:'Smoke',model:'a',models:['a'],transport:'openai-chat-completions',baseUrl:url,authOptional:true}]},tools:{},permissions:{alwaysAllow:[]},ui:{theme:'dark'},security:{allowWeakSecretStorage:false}}));
const app = launchSmokeElectron(spawn, {env, detached:true}); let cdp;
async function poll(fn, timeout=60000) { const end=Date.now()+timeout; while(Date.now()<end){ const v=await fn(); if(v) return v; await sleep(150); } throw new Error('Timed out waiting for state'); }
async function evaluate(expression) {const result=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(result.exceptionDetails) throw new Error('Evaluation failed'); return result.result.value;}
try {
  cdp=await connectIsolatedCdp({profile,env,launcher:app,wait:fn=>poll(fn,180000)});
  await poll(()=>evaluate("!!document.querySelector('.sidebar-settings')"));
  const info=await poll(()=>existsSync(join(profile,'automation.json')) && JSON.parse(readFileSync(join(profile,'automation.json'),'utf8')));
  const api=async(path,method='GET',body)=>{const r=await cdp.automation(info,path,method,body); assert(r.ok); return r.result;};
  console.log("Creating tab"); const first=await evaluate(`window.anycode.createTab({kind:'new',workspace:${JSON.stringify(profile)}})`); assert(first.ok);
  console.log("Selecting tab"); await api(`/tabs/${first.tabId}/select`,'POST',{});
  await poll(async()=>{try{return (await api(`/state/${first.tabId}`)).snapshot.states[first.tabId]?.connection==='ready';}catch{return false;}});
  console.log("Deciding trust"); const decision=await evaluate(`window.anycode.workspaceTrust.decide({tabId:${JSON.stringify(first.tabId)},decision:'trust'})`);
  mkdirSync(join(profile, '.anycode'), {recursive:true});
  writeFileSync(join(profile, '.anycode', 'workspace-trust.json'), JSON.stringify({version:1,folders:{[canonical]:{decision:'trusted',hash:'fixture',decidedAt:new Date().toISOString()}}}));
  const allowed=await evaluate(`window.anycode.communication.agentProjectsSet(${JSON.stringify(profile)},true)`);
  console.log("Enabling API"); const enabled=await evaluate("window.anycode.communication.setEnabled(true)");
  console.log('Setup status:', JSON.stringify({decision,allowed:allowed.ok,enabled:enabled.ok}));
  const discovery=await poll(()=>existsSync(join(profile,'user-data','communication.json')) && JSON.parse(readFileSync(join(profile,'user-data','communication.json'),'utf8')));
  let sid; async function rpc(method, params, id) {
    const response=await fetch(discovery.url,{method:'POST',headers:{Authorization:`Bearer ${discovery.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(sid?{'Mcp-Session-Id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',...(id!==undefined?{id}:{}),method,params})});
    sid=response.headers.get('mcp-session-id') ?? sid; const text=await response.text();
    if (!response.ok) throw new Error(`MCP request failed ${response.status}`);
    if(id===undefined) return; const line=text.startsWith('data:')?text.split('\n').find(x=>x.startsWith('data:'))?.slice(5):text; return JSON.parse(line);
  }
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'isolation-smoke',version:'1'}},1); await rpc('notifications/initialized',{});
  const created=[]; for(let i=0;i<3;i++) { const result=await rpc('tools/call',{name:'create_session',arguments:{workspace:profile,firstMessage:`Marker ${i}`}},i+2); if(result.error || result.result?.isError) throw new Error(`create_session refused: ${JSON.stringify(result)}`); created.push(JSON.parse(result.result.content[0].text)); }
  await sleep(5000);
  for (const item of created) {
    await api(`/tabs/${item.tabId}/select`, 'POST', {});
    await sleep(500);
    const info=await evaluate(`JSON.stringify({lists:[...document.querySelectorAll('.message-list')].map(e=>({ancestors:[e.parentElement?.outerHTML.slice(0,180),e.parentElement?.parentElement?.outerHTML.slice(0,180)],id:e.dataset.tabId,rect:e.getBoundingClientRect().toJSON(),text:e.innerText,panels:e.querySelectorAll('.todo-panel').length})),arrows:document.querySelectorAll('.jump-to-latest').length})`);
    const actual=JSON.parse(info); const index=created.indexOf(item); assert(actual.lists[actual.lists.length-1].text.includes(`Marker ${index}`)); for(let j=0;j<created.length;j++) if(j!==index) assert(!actual.lists[actual.lists.length-1].text.includes(`Marker ${j}`));
    const shot=await cdp.call('Page.captureScreenshot',{format:'png'}); writeFileSync(join(profile,`${item.tabId}.png`),Buffer.from(shot.data,'base64'));
    assert.deepEqual(JSON.parse(info).lists.map(list=>list.id), [item.tabId], 'Only the selected conversation should be mounted');
  }
  const close=await rpc('tools/call',{name:'close_session',arguments:{sessionId:created[0].sessionId}},10);
  assert(!close.error && !close.result?.isError, 'close_session failed');
  await api(`/tabs/${created[1].tabId}/select`, 'POST', {});
  await sleep(250);
  const remaining=await evaluate(`JSON.stringify([...document.querySelectorAll('.message-list')].map(e=>({id:e.dataset.tabId,text:e.innerText})))`);
  const remainingLists=JSON.parse(remaining); assert.equal(remainingLists.length,1); assert.equal(remainingLists[0].id,created[1].tabId); assert(remainingLists[0].text.includes('Marker 1')); assert(!remainingLists[0].text.includes('Marker 0'));
  const nodes=await evaluate(`JSON.stringify([...document.querySelectorAll('.message-list,.todo-panel')].map(e=>({class:e.className,tab:e.closest('.message-list')?.dataset.tabId,rect:e.getBoundingClientRect().toJSON(),display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility})))`);
  const shot=await cdp.call('Page.captureScreenshot',{format:'png'}); writeFileSync(join(profile,'baseline.png'),Buffer.from(shot.data,'base64'));
  console.log('PASS: isolated session creation, selection and close; nodes:',nodes,'Evidence:',profile);
} finally {
  if(cdp?.ws?.readyState===WebSocket.OPEN) await cdp.call('Browser.close',{}).catch(()=>{});
  cdp?.ws?.close(); await sleep(500); if(app.exitCode===null && app.signalCode===null) try {process.kill(-app.pid,'SIGTERM');} catch {}
  await new Promise(r=>fixture.close(r));
}

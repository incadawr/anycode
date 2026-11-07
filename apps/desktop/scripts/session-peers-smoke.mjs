/** Credential-free GUI driver. CLI: --png-dir DIR. Exit 0 PASS, 1 FAIL, 2 SKIP.
 * Extension API: createPeerSmoke() returns start/close, openPeers(tab),
 * sendPeer(source,target,payload), waitNative(engine,after,nonce), native(engine),
 * openPeer(coreSource,input), cards(tab), grant(source,target,enabled), httpOff(), screenshot(name).
 * Tool-emitting prompts currently require a core source. Native doubles receive
 * and answer requests; they do not interpret core command prompts.
 * Hooks return raw observations; UI/reply acceptance belongs to the caller.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { createEngineSmokeFixtures, evaluateSmoke } from './engine-smoke-fixtures.mjs';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { smokeProviderProfile } from './smoke-provider-profile.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function inside(root, path) {
  const rel = relative(realpathSync(root), resolve(path));
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'Fixture path escaped root');
  // Existing ancestors may not redirect a future write outside the root.
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  const actual = relative(realpathSync(root), realpathSync(parent));
  assert(!isAbsolute(actual) && actual !== '..' && !actual.startsWith('../'), 'Fixture symlink escaped root');
  return path;
}
export function peerEnv(parent, root, binaries) {
  const env = { ...buildSmokeEnv(parent, root, 0, binaries.codex),
    HOME: root, USERPROFILE: root, TMPDIR: dirname(root), TMP: root, TEMP: root,
    XDG_CONFIG_HOME: join(root,'config'), XDG_CACHE_HOME: join(root,'cache'), XDG_DATA_HOME: join(root,'data'),
    ANYCODE_CLAUDE_BIN: binaries.claude, ANYCODE_NATIVE_SESSIONS_ENABLED: '1',
    ANYCODE_ENGINE_SWITCH_ENABLED: '1', ANYCODE_ISOLATED_NATIVE_FIXTURES: '1',
    ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES: '1', ANYCODE_ISOLATED_FIXTURE_NODE: realpathSync(process.execPath),
    ELECTRON_DISABLE_SANDBOX: '1' };
  for (const [key,value] of Object.entries(env)) {
    if (/HOME$|^TMP|^TEMP$|_DIR$|_PATH$|_INFO$|_BIN$|_ROOT$/.test(key) && !['ANYCODE_EXPECTED_DESKTOP_ROOT','TMPDIR'].includes(key)) inside(root,value);
  }
  // Startup gate requires a fresh root directly below the system temp directory.
  assert.equal(env.TMPDIR, dirname(root));
  assert.equal(env.HOME, root);
  assert.equal(env.ANYCODE_SECRETS_PATH, join(root,'secrets.json'));
  return env;
}
export async function wait(probe, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r,100)); } while (Date.now() < end);
  throw new Error('Timed out waiting for smoke observation');
}
/** Only a NEW target model request is evidence; a main ACK/card alone is not. */
export function judgeDelivery({ before, requests, nonce }) {
  assert(nonce && requests.slice(before).some(request => JSON.stringify(request).includes(nonce)), 'No new target native request: broker delivery unproven');
}
/** Commands occupy one JSON line; real host mode reminders follow on later lines. */
export function parsePeerCommand(message) {
  return message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith('peer-command:')
    ? JSON.parse(message.content.split('\n',1)[0].slice(13)) : null;
}
/** Buffer until startup gating completes: the fresh-root gate forbids extra files. */
export function captureLaunchLog(app, file, privateValues = []) {
  let output = '';
  const pending = { stdout: '', stderr: '' };
  const redact = line => {
    line = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (/[{[]\s*["']|authorization|bearer|api.?key|secret|token|password|payload|prompt|peer-command|messages|\binput\b/i.test(line)) return '[redacted sensitive output]';
    for (const value of privateValues.filter(Boolean).sort((a,b) => b.length-a.length)) line = line.replaceAll(value, '<private>');
    return line.replace(/\/(?:Users|home)\/[^\s:)]+/g, '<private-path>');
  };
  const append = (name, line) => { output = (output + `[${name}] ${redact(line)}\n`).slice(-1048576); };
  for (const name of Object.keys(pending)) app[name].on('data', chunk => {
    const lines = (pending[name] + String(chunk)).split(/\r?\n/);
    pending[name] = lines.pop();
    for (const line of lines) append(name,line);
  });
  return note => {
    if (note) append('driver',note);
    for (const name of Object.keys(pending)) if (pending[name]) { append(name,pending[name]); pending[name] = ''; }
    writeFileSync(file,output,{mode:0o600});
    return output;
  };
}
export async function createPeerSmoke({ pngDir = join(tmpdir(), `peer-png-${randomUUID()}`) } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'anycode-peers-')));
  let fixtures, app, cdp, info, closed = false, launchIssue, saveLog;
  const nonce = randomUUID();
  const check = (name,status) => console.log(`[${nonce}] ${status} ${name}`);
  const path = leaf => inside(root,join(root,leaf));
  const evaluate = expression => evaluateSmoke(cdp,expression);
  const invoke = (name,...args) => evaluate(`window.anycode.${name}(...${JSON.stringify(args)})`);
  const native = engine => engine === 'core' ? fixtures.providerInputs : (existsSync(path(`${engine}.jsonl`)) ? readFileSync(path(`${engine}.jsonl`),'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(frame => engine === 'claude' ? frame.type === 'user' : frame.method === 'turn/start') : []);
  async function api(route,body) {
    const response = await cdp.automation(info,route,body ? 'POST' : 'GET',body);
    assert(response.ok, 'Automation request failed'); return response.result;
  }
  async function close() {
    if (closed) return; closed = true;
    if (cdp) { await cdp.call('Browser.close').catch(() => {}); cdp.ws.close(); }
    if (app) {
      try { process.kill(-app.pid,'SIGTERM'); } catch { /* already exited */ }
      await new Promise(r => setTimeout(r,500));
      try { process.kill(-app.pid,'SIGKILL'); } catch { /* already exited */ }
    }
    if (fixtures) { fixtures.fixture.closeAllConnections(); await new Promise(r => fixtures.fixture.close(r)); }
    saveLog?.();
    rmSync(root,{recursive:true,force:true});
  }
  const driver = {
    root, nonce, check, native, evaluate, invoke, api, close,
    reportFailure(error) { if (!closed) console.error(`Launcher log (temporary root/launcher.log; removed at teardown):\n${saveLog?.(error.message) ?? ''}`); },
    async start() {
      try {
        fixtures = await createEngineSmokeFixtures(root);
        // Reuse the reviewed CLI doubles; replace only the local model protocol.
        fixtures.fixture.removeAllListeners('request');
        fixtures.fixture.on('request',(request,response) => {
          let body = ''; request.on('data',chunk => { body += chunk; });
          request.on('end',() => {
            if (request.method === 'GET') { response.end(JSON.stringify({data:[{id:'core-model'}]})); return; }
            try {
              const input = JSON.parse(body); fixtures.providerInputs.push(input.messages);
              const last = input.messages.at(-1);
              const command = parsePeerCommand(last);
              const delta = command ? {tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:command.tool ?? 'SessionSend',arguments:JSON.stringify(command.input)}}]} : {content:'fixture ready'};
              response.writeHead(200,{'Content-Type':'text/event-stream'});
              const frame = {id:randomUUID(),object:'chat.completion.chunk',created:0,model:'core-model'};
              response.write(`data: ${JSON.stringify({...frame,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
              response.end(`data: ${JSON.stringify({...frame,choices:[{index:0,delta:{},finish_reason:command ? 'tool_calls' : 'stop'}]})}\n\ndata: [DONE]\n\n`);
            } catch { response.writeHead(400); response.end(); }
          });
        });
        const provider = smokeProviderProfile('custom:local','core-model',{credentialFromEnv:true});
        provider.custom = [{id:'custom:local',name:'Fixture',baseUrl:fixtures.baseUrl,kind:'openai-compatible',models:['core-model']}];
        Object.assign(provider.connections[0],{baseUrl:fixtures.baseUrl,transport:'openai-chat-completions',authOptional:true});
        writeFileSync(path('settings.json'),JSON.stringify({version:2,provider,tools:{},permissions:{alwaysAllow:[]},security:{allowWeakSecretStorage:false,trustedBinaries:fixtures.consents},ui:{theme:'dark'}}));
        writeFileSync(path('unavailable-engine'),'#!/bin/sh\nexit 1\n',{mode:0o700});
        const env = peerEnv(process.env,root,fixtures.binaries);
        check('isolation','PASS');
        app = launchSmokeElectron(spawn,{cwd:resolve(desktop,'../..'),env,stdio:['ignore','pipe','pipe']});
        app.on('error',() => { launchIssue = 'launcher-error'; });
        saveLog = captureLaunchLog(app,path('launcher.log'),[root,desktop,nonce]);
        cdp = await connectIsolatedCdp({profile:root,env,launcher:app,wait: probe => wait(() => { if (launchIssue || app.exitCode !== null) throw new Error(launchIssue ?? 'launcher-exited'); return probe(); })});
        info = await wait(() => existsSync(path('automation.json')) && JSON.parse(readFileSync(path('automation.json'),'utf8')));
        await wait(() => evaluate("typeof window.anycode?.createTab === 'function' && !!window.__anycodeAutomation"));
        check('launch','PASS');
        driver.tabs = [];
        for (const [name,engine] of [['A','core'],['B','codex']]) {
          mkdirSync(path(name));
          const tab = await invoke('createTab',{kind:'new',workspace:path(name),engine});
          assert(tab.ok,'Could not create fixture tab');
          driver.tabs.push({...tab,workspace:path(name),engine});
          await wait(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === 'ready');
          await api(`/tabs/${tab.tabId}/prompt`,{text:'fixture ready'});
          await wait(async () => {
            await invoke('workspaceTrust.decide',{tabId:tab.tabId,decision:'once'});
            const state = await api(`/state/${tab.tabId}`);
            return native(engine).length > 0 && state.snapshot.states[tab.tabId]?.turn?.status === 'idle';
          });
        }
        const [a,b] = driver.tabs;
        await driver.grant(a,b,true);
        check('two-workspaces','PASS');
        return driver;
      } catch (error) { driver.reportFailure(error); check(launchIssue ?? (error.message === 'launcher-exited' ? 'launcher-exited' : 'start-incomplete'),'FAIL'); await close(); throw error; }
    },
    async openPeers(tab) {
      await invoke('selectTab',tab.tabId);
      await evaluate(`document.querySelector('button[aria-label="Open environment menu"]')?.click()`);
      return invoke('sessionPeers.get',tab.tabId);
    },
    async grant(source,target,enabled) {
      const result = await invoke('sessionPeers.set',{tabId:source.tabId,projectKey:source.workspace,peerKey:target.workspace,enabled});
      assert(result.ok,'Pair grant mutation failed'); return result;
    },
    openPeer(source,input = {}) { return driver.tool(source,'SessionOpen',input); },
    async selectMode(source,mode) {
      await invoke('selectTab',source.tabId);
      assert((await api(`/tabs/${source.tabId}/mode-menu/click-chip`,{})).ok);
      await wait(async () => (await api(`/tabs/${source.tabId}/mode-menu`,{})).open);
      assert((await api(`/tabs/${source.tabId}/mode-menu/click-row`,{name:mode})).ok);
      await wait(async () => (await api(`/state/${source.tabId}`)).snapshot.states[source.tabId]?.mode === mode);
    },
    async orchestrate(source,enabled) {
      assert((await api(`/tabs/${source.tabId}/orchestrate`,{enabled})).ok);
      await wait(async () => (await api(`/state/${source.tabId}`)).snapshot.states[source.tabId]?.orchestrateActive === enabled);
    },
    async tool(source,tool,input,{approve = true} = {}) {
      assert.equal(source.engine,'core','Tool-emitting fixture source must be core');
      const before = native('core').length;
      const oldTools = new Set(native('core').flat().filter(m => m.role === 'tool').map(m => m.tool_call_id));
      const sent = await api(`/tabs/${source.tabId}/prompt`,{text:`peer-command:${JSON.stringify({tool,input})}`});
      assert(sent.ok,'Fixture tool prompt refused');
      if (approve) {
        const permission = await wait(async () => (await api(`/state/${source.tabId}`)).snapshot.states[source.tabId]?.permission);
        assert.equal(permission.toolName,tool,'Unexpected fixture approval request');
        const approved = await api(`/tabs/${source.tabId}/permission`,{behavior:'allow',requestId:permission.requestId});
        assert(approved.ok,'Fixture tool approval failed');
      }
      const result = await wait(() => native('core').slice(before).flat().filter(message => message.role === 'tool' && !oldTools.has(message.tool_call_id)).at(-1));
      await wait(async () => (await api(`/state/${source.tabId}`)).snapshot.states[source.tabId]?.turn?.status === 'idle');
      return result.content;
    },
    async sendPeer(source,target,payload,options) {
      const state = await api(`/state/${target.tabId}`);
      const sessionId = state.tabs.find(t => t.tabId === target.tabId)?.sessionId;
      assert(sessionId,'Target logical session missing');
      return driver.tool(source,'SessionSend',{sessionId,payload,reply:'explicit'},options);
    },
    waitNative(engine,after,token) { return wait(() => native(engine).slice(after).find(frame => !token || JSON.stringify(frame).includes(token))); },
    async cards(tab) {
      await invoke('selectTab',tab.tabId);
      return evaluate(`Array.from(document.querySelectorAll('[data-block-id^="agent-message:"]')).map(el => ({id:el.dataset.blockId,text:el.textContent,links:Array.from(el.querySelectorAll('.agent-message-identity button')).map(b=>b.textContent)}))`);
    },
    async httpOff(port) {
      const result = await invoke('communication.get');
      assert(result.ok,'HTTP control unavailable');
      assert.equal(result.view.enabled,false,'HTTP must be OFF');
      port ??= result.view.port;
      assert(Number.isInteger(port),'HTTP port unavailable');
      return new Promise((resolveSocket,reject) => {
        const socket = createConnection({host:'127.0.0.1',port});
        socket.once('connect',() => {socket.destroy(); resolveSocket(false);});
        socket.once('error',error => error.code === 'ECONNREFUSED' ? resolveSocket(true) : reject(error));
        socket.setTimeout(2000,() => {socket.destroy(); reject(new Error('Socket check timed out'));});
      });
    },
    async screenshot(name) {
      assert(/^[a-z0-9-]+\.png$/i.test(name)); mkdirSync(pngDir,{recursive:true});
      const {data} = await cdp.call('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(pngDir,name),Buffer.from(data,'base64'));
    },
  };
  return driver;
}
/** Each write mode must prove a distinct new native request; plan never gets auto-approved. */
export async function checkAuthoritySteps(driver,source,target) {
  async function deliver(label,nonce) {
    const before = driver.native(target.engine).length;
    try {
      await driver.sendPeer(source,target,nonce);
      await driver.waitNative(target.engine,before,nonce);
      judgeDelivery({before,requests:driver.native(target.engine),nonce});
      driver.check(label,'PASS');
    } catch (error) { driver.check(label,'FAIL'); throw error; }
  }
  await deliver('broker-to-target-native-request',driver.nonce);
  await driver.screenshot('peer-delivered.png');
  await driver.orchestrate(source,true);
  await deliver('orchestrate-to-target-native-request',`${driver.nonce}-orchestrate`);
  await driver.screenshot('peer-orchestrate.png');
  await driver.orchestrate(source,false);
  await driver.selectMode(source,'plan');
  const before = driver.native(target.engine).length;
  const result = await driver.sendPeer(source,target,`${driver.nonce}-plan`,{approve:false});
  assert.equal(driver.native(target.engine).length,before,'Plan sent a native request');
  // Core may deny the tool before it reaches the peer host. Do not label that "refused".
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (/"status"\s*:\s*"refused"/.test(text)) driver.check('plan-refused','PASS');
  else {
    assert.match(text,/only read-only tools are permitted in plan mode/,'Unexpected plan result');
    driver.check('plan-core-permission-denied','PASS');
    driver.check('plan-host-refused-not-reached','SKIP');
  }
  await driver.screenshot('peer-plan.png');
}
export async function runSmoke(options) {
  const driver = await createPeerSmoke(options);
  const stop = () => { void driver.close().finally(() => { process.exitCode = 1; }); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await driver.start();
    await driver.screenshot('peer-ready.png');
    driver.check('peer-ready-png','PASS');
    const [source,target] = driver.tabs;
    await driver.selectMode(source,'build');
    driver.check('source-build-mode','PASS');
    await checkAuthoritySteps(driver,source,target);
    driver.check('cards-replies-acceptance','SKIP');
    return 0;
  } catch (error) { driver.reportFailure(error); driver.check('driver','FAIL'); return 1; }
  finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); await driver.close(); driver.check('teardown','PASS'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--png-dir');
  process.exitCode = await runSmoke(index < 0 ? {} : {pngDir:resolve(process.argv[index+1])});
}

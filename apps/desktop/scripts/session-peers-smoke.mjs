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
export async function createPeerSmoke({ pngDir = join(tmpdir(), `peer-png-${randomUUID()}`) } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'anycode-peers-')));
  let fixtures, app, cdp, info, closed = false, launchIssue;
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
    rmSync(root,{recursive:true,force:true});
  }
  const driver = {
    root, nonce, check, native, evaluate, invoke, api, close,
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
              const command = last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('peer-command:') ? JSON.parse(last.content.slice(13)) : null;
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
        writeFileSync(path('settings.json'),JSON.stringify({version:2,provider,tools:{},permissions:{alwaysAllow:[]},security:{trustedBinaries:fixtures.consents},ui:{theme:'dark'}}));
        writeFileSync(path('unavailable-engine'),'#!/bin/sh\nexit 1\n',{mode:0o700});
        const env = peerEnv(process.env,root,fixtures.binaries);
        check('isolation','PASS');
        app = launchSmokeElectron(spawn,{cwd:resolve(desktop,'../..'),env,stdio:['ignore','pipe','pipe']});
        app.on('error',() => { launchIssue = 'launcher-error'; });
        // Keep payload-bearing app output private, never print it as evidence.
        app.stdout.on('data',() => {}); app.stderr.on('data',chunk => { if (/\bcac\b/.test(String(chunk))) launchIssue = 'launcher-cac-resolution'; });
        cdp = await connectIsolatedCdp({profile:root,env,launcher:app,wait: probe => wait(() => { if (launchIssue || app.exitCode !== null) throw new Error(launchIssue ?? 'launcher-exited'); return probe(); })});
        info = await wait(() => existsSync(path('automation.json')) && JSON.parse(readFileSync(path('automation.json'),'utf8')));
        await wait(() => evaluate("typeof window.anycode?.createTab === 'function'"));
        check('launch','PASS');
        driver.tabs = [];
        for (const [name,engine] of [['A','core'],['B','codex']]) {
          mkdirSync(path(name));
          const tab = await invoke('createTab',{kind:'new',workspace:path(name),engine});
          assert(tab.ok,'Could not create fixture tab');
          driver.tabs.push({...tab,workspace:path(name),engine});
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
      } catch (error) { check(launchIssue ?? (error.message === 'launcher-exited' ? 'launcher-exited' : 'start-incomplete'),'FAIL'); await close(); throw error; }
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
    async tool(source,tool,input) {
      assert.equal(source.engine,'core','Tool-emitting fixture source must be core');
      await api(`/tabs/${source.tabId}/prompt`,{text:`peer-command:${JSON.stringify({tool,input})}`});
    },
    async sendPeer(source,target,payload) {
      const state = await api(`/state/${target.tabId}`);
      const sessionId = state.tabs.find(t => t.tabId === target.tabId)?.sessionId;
      assert(sessionId,'Target logical session missing');
      return driver.tool(source,'SessionSend',{sessionId,payload,reply:'explicit'});
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
export async function runSmoke(options) {
  const driver = await createPeerSmoke(options);
  const stop = () => { void driver.close().finally(() => { process.exitCode = 1; }); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await driver.start();
    const [source,target] = driver.tabs;
    const before = driver.native(target.engine).length;
    await driver.sendPeer(source,target,driver.nonce);
    await driver.waitNative(target.engine,before,driver.nonce);
    judgeDelivery({before,requests:driver.native(target.engine),nonce:driver.nonce});
    driver.check('broker-to-target-native-request','PASS');
    await driver.screenshot('peer-delivered.png');
    driver.check('cards-replies-acceptance','SKIP');
    return 0;
  } catch { driver.check('driver','FAIL'); return 1; }
  finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); await driver.close(); driver.check('teardown','PASS'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--png-dir');
  process.exitCode = await runSmoke(index < 0 ? {} : {pngDir:resolve(process.argv[index+1])});
}

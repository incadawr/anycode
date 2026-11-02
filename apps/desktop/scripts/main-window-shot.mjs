/** Capture the main window using a disposable, isolated automation profile. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'anycode-main-window-'));
const output = process.argv[2] ? resolve(process.argv[2]) : '/tmp/mock-shots/terra';
mkdirSync(output, { recursive: true });
const binary = join(profile, 'unavailable-engine');
writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, 0, binary);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  version: 2, provider: { activeConnectionId: 'fixture', custom: [{ id: 'custom:fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1:9/v1', kind: 'openai-compatible', models: ['fixture'] }], connections: [{ id: 'fixture', providerId: 'custom:fixture', label: 'Fixture', model: 'fixture', models: ['fixture'], transport: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:9/v1', authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: 'dark' }, security: { allowWeakSecretStorage: false },
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw Error('Timed out waiting for isolated UI'); }
const app = launchSmokeElectron(spawn, { env, detached: true });
let cdp;
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: poll });
  const call = (method, params = {}) => cdp.call(method, params);
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const info = await poll(() => { try { return JSON.parse(readFileSync(join(profile, 'automation.json'), 'utf8')); } catch { return null; } });
  const api = async (method, path, body) => { const response = await cdp.automation(info, path, method, body); if (!response.ok) throw Error(`${method} ${path}: ${JSON.stringify(response.result)}`); return response.result; };
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await poll(() => evaluate(`!!document.querySelector('.sidebar-settings')`));
  await api('POST', '/window/size', { width: 1440, height: 900 });
  const tabs = [];
  for (let i = 0; i < 3; i++) { const tab = await api('POST', '/tabs', { kind: 'new', workspace: root }); if (!tab.ok) throw Error(JSON.stringify(tab)); tabs.push(tab); }
  const tab = tabs.at(-1);
  await api('POST', `/tabs/${tab.tabId}/select`, {});
  await poll(async () => { const result = await api('POST', `/tabs/${tab.tabId}/git/panel`, { open: true }); return result.ok; });
  const md = await api('POST', `/tabs/${tab.tabId}/previews`, { path: join(root, 'README.md') });
  if (!md.ok) throw Error(`Markdown preview: ${JSON.stringify(md)}`);
  const web = await api('POST', `/tabs/${tab.tabId}/previews`, { path: join(root, 'mini-presentation.html') });
  if (!web.ok) console.log('Local web preview unavailable:', JSON.stringify(web));
  await call('Page.reload');
  await poll(() => evaluate(`!!document.querySelector('.sidebar-settings')`));
  await api('POST', `/tabs/${tab.tabId}/select`, {});
  await poll(async () => (await api('POST', `/tabs/${tab.tabId}/git/panel`, { open: true })).ok);
  await poll(() => evaluate(`document.querySelectorAll('.dock-tab').length >= 2`));
  await evaluate(`(async () => { const { tabRegistry } = await import('/src/tab-registry.ts'); const store = tabRegistry.getStore(${JSON.stringify(tab.tabId)}); store.setState({transcript: [
    {kind:'user_text',id:'fixture-user',text:'Review the implementation and summarize the changes.'},
    {kind:'assistant_text',id:'fixture-assistant',text:'### Review complete\\n\\nThe changes are ready for review. The sidebar, conversation and dock use the updated design tokens.'},
    {kind:'reasoning',id:'fixture-thinking',text:'Checking the layout and color tokens.',collapsed:true},
    {kind:'tool_call',id:'fixture-tool',toolCallId:'fixture-tool',toolName:'Read',input:{path:'README.md'},status:'success',modelText:null,snapshots:{before:null,after:null},subagent:null,workflow:null}
  ]}); })()`);
  await poll(() => evaluate(`document.querySelectorAll('.dock-tab').length >= 2`));
  await sleep(1000);
  console.log('Transcript layout:', await evaluate(`JSON.stringify([...document.querySelectorAll('.message-list')].map(e=>({empty:!!e.querySelector('.transcript-empty'),blocks:e.querySelectorAll('.message').length,rect:e.getBoundingClientRect().toJSON()})))`));
  await evaluate(`document.documentElement.removeAttribute('data-density')`);
  await evaluate(`(async()=>{const s=document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.append(s); await document.fonts.ready; document.activeElement?.blur();})()`);
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await sleep(400);
    for (const [name, id] of [['', 'git'], ['-markdown', `preview:${md.value.previewId}`], ...(web.ok ? [['-web', `preview:${web.value.previewId}`]] : [])]) {
      const selected = await api('POST', `/dock/tabs/${encodeURIComponent(id)}/click`, {});
      if (!selected.ok) throw Error(`Select ${id}: ${JSON.stringify(selected)}`);
      await sleep(500);
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, `${theme}${name}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  console.log(`Screenshots: ${output} (dark, light, markdown and web)`);
  console.log('Local HTML preview:', web.ok ? 'opened' : 'unavailable');
  console.log('Web preview body is not captured: it is a separate WebContentsView; the PNG shows the renderer and preview header only.');
} finally {
  cdp?.ws?.close();
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}

/** Device-local accent picker and unchanged-default visual smoke. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';
const profile = mkdtempSync(join(tmpdir(), 'anycode-accent-'));
const binary = join(profile, 'unavailable-engine');
writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, 0, binary);
const fixtureUrl = 'http://127.0.0.1:9/v1';
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  version:2, provider:{activeConnectionId:'conn-smoke', custom:[{id:'custom:smoke', name:'Smoke', baseUrl:fixtureUrl, kind:'openai-compatible', models:['unknown']}], connections:[{
    id:'conn-smoke', providerId:'custom:smoke', label:'Model overrides smoke', model:'a', models:['a','b','unknown','glm-like-52','glm-like-53'],
    modelCapabilities:{'glm-like-52':{reasoning:true, effortLevels:['off','high','max']}, 'glm-like-53':{reasoning:true, effortLevels:['low','medium','high','max']}},
    transport:'openai-chat-completions', baseUrl:fixtureUrl, authOptional:true, imageInputOverride:'on', imageInputModel:'a',
  }]}, tools:{}, permissions:{alwaysAllow:[]}, ui:{theme:'dark'}, security:{allowWeakSecretStorage:false},
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout=30000) { const end=Date.now()+timeout; while(Date.now()<end) { const v=await fn(); if(v) return v; await sleep(150); } throw Error('GUI timeout'); }
const app = launchSmokeElectron(spawn, {env, detached:true});
let cdp;
const call = (method, params={}) => cdp.call(method, params).catch(error => { throw new Error(`${method}: ${error.message}`, {cause:error}); });
async function evaluate(expression) { const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function pane(id) { await evaluate(`document.querySelector('.sidebar-settings').click()`); await poll(()=>evaluate(`!!document.querySelector('#settings-tab-${id}')`)); await evaluate(`document.querySelector('#settings-tab-${id}').click()`); await sleep(200); }
async function closeSettings() { await evaluate(`document.querySelector('.settings-dialog')?.dispatchEvent(new Event('cancel',{cancelable:true}))`); await sleep(200); }
async function capture(dir,name) {
  mkdirSync(dir,{recursive:true});
  await evaluate(`(async()=>{ if(!document.querySelector('#smoke-still')) { const s=document.createElement('style'); s.id='smoke-still'; s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.append(s); } await document.fonts.ready; document.activeElement?.blur(); })()`);
  await sleep(300);
  const png=Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64');
  writeFileSync(join(dir,name+'.png'),png); return createHash('sha256').update(png).digest('hex');
}
const mode=process.argv[2], reference=process.argv[3];
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const output=option('--out') || process.env.ACCENT_SMOKE_OUTPUT || mkdtempSync(join(tmpdir(), 'anycode-accent-evidence-'));
const only = option('--only');
const steps = ['palette', 'reload', 'preview', 'connection', 'terminal'];
const unverified = [];
const selected = step => !only || only === step;
const skip = message => { unverified.push(message); console.log('UNVERIFIED', message); };
try {
  assert(!only || steps.includes(only), `Unknown --only step: ${only}`);
  cdp=await connectIsolatedCdp({profile,env,launcher:app,wait:poll});
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await poll(()=>evaluate(`!!document.querySelector('.sidebar-settings')`));
  if(mode==='--baseline'||mode==='--compare') {
    const dir=option('--out') || (mode==='--baseline'?reference:join(reference,'after')); const manifest={};
    for(const screen of ['start','provider','permissions','about']) {
      if(screen==='start') await closeSettings(); else await pane(screen);
      for(const theme of ['dark','light']) for(const density of ['compact','comfortable']) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'; ${density==='compact'?"document.documentElement.dataset.density='compact'":"document.documentElement.removeAttribute('data-density')"}`);
        const name=`${screen}-${theme}-${density}`; manifest[name]=await capture(dir,name);
      }
    }
    await pane('appearance');
    for(const theme of ['dark','light']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await capture(dir,`appearance-${theme}`);
      const styles=await evaluate(`[...document.querySelectorAll('.settings-field')].filter(e=>/Theme|Density/.test(e.textContent)).map(e=>{const s=getComputedStyle(e);return {text:e.textContent,color:s.color,background:s.backgroundColor,font:s.font,border:s.border,padding:s.padding}})`);
      writeFileSync(join(dir,`appearance-${theme}.json`),JSON.stringify(styles,null,2));
    }
    writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
    if(mode==='--compare') { const before=JSON.parse(readFileSync(join(reference,'manifest.json'))); const mismatches=Object.keys(manifest).filter(k=>manifest[k]!==before[k]); console.log('MISMATCHES',mismatches); assert.deepEqual(mismatches, []); }
    console.log('CAPTURED',dir);
  } else {
    await pane('appearance');
    const keys=['current','gold','indigo','teal','ember'];
    const colors={dark:['#4da3ff','#e9b949','#898fff','#2dd4bf','#ff8a4c'],light:['#0e6fc9','#845e04','#4a50d4','#007166','#a84700']};
    if (selected('palette')) {
    for(const theme of ['dark','light']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      for(const [i,key] of keys.entries()) {
        await evaluate(`document.querySelector('.accent-swatch[data-accent="${key}"]').click()`);
        assert.equal(await evaluate(`(() => { const b=document.querySelector('[role=radio][aria-checked=true]'); return getComputedStyle(b).boxShadow.includes(getComputedStyle(document.querySelector('.settings-dialog')).backgroundColor); })()`),true);
        assert.equal(await evaluate(`document.documentElement.getAttribute('data-accent')`),key==='current'?null:key);
        assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`),colors[theme][i]);
        await capture(output,`${theme}-${key}`);
      }
      await evaluate(`document.querySelector('.accent-swatch[data-accent="gold"]').click()`);
      await closeSettings(); await capture(output,`${theme}-gold-main`); await pane('appearance');
      for(const [key,expected] of [['End','ember'],['ArrowRight','current'],['ArrowLeft','ember'],['Home','current']]) {
        await evaluate(`document.querySelector('[role=radio][aria-checked=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true,cancelable:true}))`);
        assert.equal(await evaluate(`document.activeElement.dataset.accent`),expected);
      }
      // A real Tab establishes :focus-visible for the selected swatch.
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await evaluate(`document.querySelector('[role=radio][aria-checked=true]').focus()`);
      const focused=await call('Page.captureScreenshot',{format:'png'}); mkdirSync(output,{recursive:true}); writeFileSync(join(output,`${theme}-focus.png`),Buffer.from(focused.data,'base64'));
    }
    }
    if (selected('reload')) {
    await evaluate(`document.querySelector('.accent-swatch[data-accent="indigo"]').click()`);
    await call('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('DOMContentLoaded',()=>window.smokeAccentAtReady=document.documentElement.getAttribute('data-accent'),{once:true})`});
    await call('Page.reload'); await poll(()=>evaluate(`window.smokeAccentAtReady !== undefined && !!document.querySelector('.sidebar-settings')`));
    assert.equal(await evaluate('window.smokeAccentAtReady'),'indigo');
    }
    if (selected('preview')) skip('md-preview second-window storage sync: Electron Target.createTarget is unsupported; covered by mounted storage-sync test');
    if (selected('connection')) {
    await pane('appearance');
    await evaluate(`document.querySelector('.accent-swatch[data-accent="indigo"]').click()`);
    await pane('provider');
    await evaluate(`document.documentElement.dataset.theme='dark'; document.querySelector('.connection-tile button[aria-haspopup=menu]').click()`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Edit').click()`);
    await poll(()=>evaluate(`document.querySelector('.connection-drawer')?.open`));
    await capture(output,'indigo-dark-connection');
    }
    if (selected('terminal')) skip('terminal panel; withAccent and live theme updates covered by terminal-view.test.ts');
    if (only) skip(`partial run: --only ${only}`);
    console.log('EVIDENCE',output);
  }
  console.log(unverified.length ? 'PASS_WITH_UNVERIFIED' : 'PASS');
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  cdp?.ws?.close();
  if(app.exitCode===null&&app.signalCode===null) try { process.kill(-app.pid,'SIGTERM'); } catch {}
}

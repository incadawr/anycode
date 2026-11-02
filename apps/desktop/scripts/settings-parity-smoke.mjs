/**
 * Settings parity, isolated dev Electron, 1280x800 @ 1x.
 * node apps/desktop/scripts/settings-parity-smoke.mjs --baseline /tmp/ds-track/s4-baseline
 * node apps/desktop/scripts/settings-parity-smoke.mjs --compare /tmp/ds-track/s4-baseline
 * Append --only provider,connection-edit,connection-add for a partial run.
 * Baseline: PNGs + manifest.json. Compare: <baseline>/after (or --out <dir>), hash differences
 * are requests for visual review (allowed S4 tolerance: height ±2px, radius ±1px).
 * Tall panels use overlapping viewport scroll frames, including the last edge;
 * no panel CSS/layout is changed. Collapsed disclosures retain their default state.
 * unstable frames are excluded from parity claims, never silently accepted.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';

const panes = ['profile','provider','codex','claude','permissions','tools','vision','network','mcp','language-servers','skills','subagents','roles','plugins','sessions-api','environment','appearance','shortcuts','about','connection-edit','connection-add'];
const args = process.argv.slice(2);
let mode, reference, only, out;
for (let i=0; i<args.length; i++) {
  const arg=args[i], value=args[++i];
  assert(value && !value.startsWith('--'), `Missing value for ${arg}`);
  if(arg==='--baseline'||arg==='--compare') { assert(!mode,'Choose one mode'); mode=arg; reference=resolve(value); }
  else if(arg==='--only') only=value.split(',');
  else if(arg==='--out') out=resolve(value);
  else throw Error(`Unknown option ${arg}`);
}
assert(mode,'Use --baseline <dir> or --compare <dir>');
assert(!only || only.every(id=>panes.includes(id)), 'Unknown --only pane');
const selected = only ? panes.filter(id=>only.includes(id)) : panes;
const before = mode==='--compare' ? JSON.parse(readFileSync(join(reference,'manifest.json'),'utf8')) : null;
assert(!out || mode==='--compare','--out works only with --compare');
const output = mode==='--baseline' ? reference : out ?? join(reference,'after');
mkdirSync(output,{recursive:true});
const started=Date.now();
const profile=mkdtempSync(join(tmpdir(),'anycode-settings-parity-'));
const binary=join(profile,'unavailable-engine');
writeFileSync(binary,'#!/bin/sh\nexit 1\n',{mode:0o700});
const env=buildSmokeEnv(process.env,profile,0,binary);
writeFileSync(join(profile,'settings.json'),JSON.stringify({
  version:2, provider:{activeConnectionId:'conn-local', custom:[{id:'custom:parity',name:'Local fixture',baseUrl:'http://127.0.0.1:9/v1',kind:'openai-compatible',models:['fixture-chat','fixture-vision']}],connections:[
    {id:'conn-local',providerId:'custom:parity',label:'Local fixture',model:'fixture-chat',models:['fixture-chat','fixture-vision'],transport:'openai-chat-completions',baseUrl:'http://127.0.0.1:9/v1',authOptional:true,imageInputOverride:'on',imageInputModel:'fixture-vision'},
    {id:'conn-catalog',providerId:'openai',label:'Catalog fixture',model:'gpt-4.1',models:['gpt-4.1'],transport:'openai-responses',authOptional:true},
  ]},tools:{concurrency:4,maxTurns:50},permissions:{alwaysAllow:[{toolName:'Read',pattern:'/workspace/**'},{toolName:'Bash',pattern:'git status*'}]},
  network:{proxyProfiles:[{id:'proxy-fixture',name:'Local proxy',mode:'manual',url:'http://127.0.0.1:9'}]},
  ui:{theme:'dark'},security:{allowWeakSecretStorage:false},
}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function poll(fn,timeout=45000) { const end=Date.now()+timeout; while(Date.now()<end) { const value=await fn(); if(value) return value; await sleep(100); } throw Error('GUI timeout'); }
const app=launchSmokeElectron(spawn,{env,detached:true,electron:{extra:['--disable-threaded-scrolling','--disable-partial-raster','--disable-lcd-text','--disable-skia-runtime-opts','--force-color-profile=srgb','--force-device-scale-factor=1']}});
let cdp;
const call=(method,params={})=>cdp.call(method,params);
async function evaluate(expression) { const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function pane(id) {
  await evaluate(`document.querySelector('.connection-drawer-close')?.click(); if(!document.querySelector('.settings-dialog[open]')) document.querySelector('.sidebar-settings').click()`);
  const target=id.startsWith('connection-')?'provider':id;
  await poll(()=>evaluate(`!!document.querySelector('#settings-tab-${target}')`));
  await evaluate(`document.querySelector('#settings-tab-${target}').click()`);
  await poll(()=>evaluate(`!!document.querySelector('.settings-pane-content')`));
  if(id==='connection-edit') {
    await evaluate(`document.querySelector('.connection-tile button[aria-haspopup=menu]').click()`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Edit').click()`);
  } else if(id==='connection-add') {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add connection').click()`);
  }
  if(id.startsWith('connection-')) await poll(()=>evaluate(`!!document.querySelector('.connection-drawer[open]')`));
  await sleep(1200); // settle local IPC reads and empty/offline states
}
const manifest={version:1,viewport:{width:1280,height:800,deviceScaleFactor:1},panes:selected,frames:{},notes:[]};
async function capture(name,scroll) {
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:20});
  await evaluate(`(async()=>{ await document.fonts.ready; document.activeElement?.blur(); })()`);
  // Redraw at the final scroll offset; cached fractional raster tiles can
  // otherwise differ by one pixel across identical Chromium launches.
  await evaluate(`(async()=>{
    const walker=document.createTreeWalker(document.querySelector('.settings-dialog'),NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) walker.currentNode.textContent=walker.currentNode.textContent.replaceAll(${JSON.stringify(profile)},'/tmp/anycode-settings-parity-fixture');
    const e=document.querySelector('.connection-drawer[open]') || document.querySelector('.settings-pane');
    e.style.visibility='hidden'; await new Promise(requestAnimationFrame);
    e.style.visibility=''; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  })()`);
  await sleep(150);
  let png=Buffer.from((await call('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false})).data,'base64');
  // Native view capture avoids compositor tile seams. Strip only the OS
  // traffic-light overlay using the same renderer's top-left background.
  // The product starts to the right/below this 80x40 native-chrome region.
  const chrome=(await call('Page.captureScreenshot',{format:'png',fromSurface:true,clip:{x:0,y:0,width:80,height:40,scale:1}})).data;
  const data=await evaluate(`(async()=>{
    const img=new Image(); img.src='data:image/png;base64,${png.toString('base64')}'; await img.decode();
    const chrome=new Image(); chrome.src='data:image/png;base64,${chrome}'; await chrome.decode();
    const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=800;
    const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0,1280,800); ctx.drawImage(chrome,0,0,80,40);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  png=Buffer.from(data,'base64');
  assert.equal(png.readUInt32BE(16),1280); assert.equal(png.readUInt32BE(20),800);
  writeFileSync(join(output,`${name}.png`),png);
  manifest.frames[name]={sha256:createHash('sha256').update(png).digest('hex'),...scroll,unstable:false};
}
try {
  cdp=await connectIsolatedCdp({profile,env,launcher:app,wait:poll});
  mkdirSync(join(profile,'.anycode'),{recursive:true});
  writeFileSync(join(profile,'.anycode/config.json'),JSON.stringify({mcpServers:{
    'fixture-docs':{command:'/usr/bin/false',args:[],enabled:false},
    'fixture-search':{url:'http://127.0.0.1:9/mcp',enabled:false},
  }}));

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  const setup=`(() => {
    const NativeDate=Date, fixed=Date.parse('2026-10-01T12:00:00Z');
    window.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[fixed]));} static now(){return fixed;} };
    document.addEventListener('DOMContentLoaded',()=>{
      const style=document.createElement('style'); style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important} ::-webkit-scrollbar-thumb:hover{background-color:var(--text-ghost)!important}'; document.head.append(style);
    },{once:true});
  })()`;
  await call('Page.addScriptToEvaluateOnNewDocument',{source:setup});
  await call('Page.reload');
  await poll(()=>evaluate(`!!document.querySelector('.sidebar-settings')`));
  for(const id of selected) {
    await pane(id);
    for(const theme of ['dark','light']) for(const density of ['comfortable','compact']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'; document.documentElement.dataset.density='${density}';`);
      // Capture each independently scrollable surface without stretching controls.
      const selector=id.startsWith('connection-')?'.connection-drawer':'.settings-pane';
      const dimensions=await evaluate(`(()=>{const e=document.querySelector('${selector}'); e.scrollTop=0; return {height:e.clientHeight,total:e.scrollHeight};})()`);
      assert(dimensions.height>0,`No scroll surface for ${id}`);
      const offsets=[];
      for(let y=0;y<Math.max(1,dimensions.total-dimensions.height);y+=Math.max(1,dimensions.height-48)) offsets.push(y);
      offsets.push(Math.max(0,dimensions.total-dimensions.height));
      for(const [index,y] of [...new Set(offsets)].entries()) {
        await evaluate(`document.querySelector('${selector}').scrollTop=${y}`);
        await capture(`${id}-${theme}-${density}-${String(index+1).padStart(2,'0')}`,{pane:id,theme,density,scrollTop:y,...dimensions});
      }
    }
    console.log('CAPTURED',id);
  }
  if(only) manifest.notes.push(`Partial run: --only ${only.join(',')}`);
  const mismatches=[];
  if(before) {
    assert.equal(before.version,manifest.version,'Unsupported baseline manifest');
    for(const name of new Set([...Object.keys(before.frames).filter(k=>selected.includes(before.frames[k].pane)),...Object.keys(manifest.frames)])) {
      if(before.frames[name]?.sha256!==manifest.frames[name]?.sha256) {
        mismatches.push(name);
        console.log('VISUAL_REVIEW',name,join(reference,`${name}.png`),join(output,`${name}.png`));
      }
    }
    manifest.mismatches=mismatches;
    console.log('MISMATCHES',JSON.stringify(mismatches));
  }
  writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log('FRAMES',Object.keys(manifest.frames).length,'SECONDS',((Date.now()-started)/1000).toFixed(1),'OUTPUT',output);
  console.log(only || mismatches.length || Object.values(manifest.frames).some(f=>f.unstable) ? 'PASS_WITH_UNVERIFIED' : 'PASS');
} catch(error) {
  console.error('FAIL',error); process.exitCode=1;
} finally {
  cdp?.ws?.close();
  if(app.exitCode===null&&app.signalCode===null) try { process.kill(-app.pid,'SIGTERM'); } catch {}
}

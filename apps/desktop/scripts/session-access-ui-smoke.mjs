/** Isolated live Session access observations; screenshots contain synthetic fixtures only. */
import { createPeerSmoke } from './session-peers-smoke.mjs';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const pngDir = process.env.ANYCODE_SHOTS_DIR || '/Users/incadawr/projects/tools/anycode/working-docs/design-review/t3-session-access/shots';
const d = await createPeerSmoke({pngDir:resolve(pngDir)});
const delay = () => new Promise(r => setTimeout(r,400));
const check = async (name, expression) => { try { const value = await d.evaluate(expression); console.log(`${value ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(value)}`); return value; } catch(e) { console.log(`FAIL ${name}: ${e.message}`); return false; } };
// A state shot is not about the help tooltip: blur the help icon and move the pointer away first, so an open tooltip never covers the row under it.
const calm = async () => { await d.evaluate(`(()=>{const a=document.activeElement; if(a?.classList?.contains('row-help-button')) a.blur()})()`); await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2}); await delay(); };
const shot = async (name, expression, { tooltip = false } = {}) => { await d.evaluate(`document.querySelectorAll('details.child-worktree-control[open]').forEach(e=>e.open=false)`); if (!tooltip) await calm(); await delay(); if (tooltip) { const geometry=await d.evaluate(`(()=>{const t=document.querySelector('[role=tooltip][data-open=true]'),m=t?.closest('.environment-menu');const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}};const a=rect(t),b=rect(m);return {tooltip:a,menu:b,inside:!!a&&!!b&&a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom}})()`); console.log('TOOLTIP RECT',name,JSON.stringify(geometry)); } else if (/^(menu-|dialog-|handle-error)/.test(name)) await check(name+' no tooltip',`!document.querySelector('[role=tooltip][data-open=true]')`); if (await check(name,expression)) await d.screenshot(name+'.png'); };
const key = async (key, code, n, modifiers=0) => { await d.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n,modifiers}); await d.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n,modifiers}); await delay(); };
try {
  await d.start();
  const [a] = d.tabs;
  await d.api(`/tabs/${a.tabId}/select`,{});
  if (process.env.ANYCODE_ROWHELP_ONLY === '1') {
    await d.cdp.call('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});
    await d.evaluate(`document.documentElement.dataset.theme='dark'; document.querySelectorAll('details.child-worktree-control[open]').forEach(e=>e.open=false)`);
    await d.evaluate(`document.querySelector('button.environment-trigger[aria-label^=Environment]').click()`);
    const observe = `(()=>{const b=document.querySelector('.environment-menu .row-help-button'), m=b?.closest('.environment-menu'), t=b?.parentElement.querySelector('[role=tooltip]'), a=document.activeElement; const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}; const br=rect(b),mr=rect(m),tr=rect(t),s=b&&getComputedStyle(b);return {active:{tag:a?.tagName,aria:a?.getAttribute('aria-label'),class:a?.className},button:br,menu:mr,tooltip:tr,window:{width:innerWidth,height:innerHeight},insideMenu:!!br&&!!mr&&br.left>=mr.left&&br.right<=mr.right&&br.top>=mr.top&&br.bottom<=mr.bottom,outline:s?.outline,boxShadow:s?.boxShadow,open:t?.dataset.open,tooltipInsideWindow:!!tr&&tr.left>=0&&tr.top>=0&&tr.right<=innerWidth&&tr.bottom<=innerHeight,tooltipInsideMenu:!!tr&&!!mr&&tr.left>=mr.left&&tr.right<=mr.right&&tr.top>=mr.top&&tr.bottom<=mr.bottom}})()`;
    // Wait for the asynchronous menu contents, not merely the menu shell.
    await d.evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const poll=()=>document.querySelector('.environment-menu .row-help-button')?resolve(true):Date.now()>end?reject(Error('help button missing')):setTimeout(poll,100);poll()})`);
    await new Promise(r=>setTimeout(r,1500));
    await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});
    for (let i=1;i<=2;i++) {
      await d.evaluate(`document.querySelector('.environment-menu .row-help-button').blur()`); await delay();
      await d.evaluate(`document.querySelector('.environment-menu .row-help-button').focus()`);
      await delay();
      const result=await d.evaluate(observe);
      console.log('FOCUS',i,'expected active=help button, tooltip open=true; actual',JSON.stringify(result));
      if (result.open==='true' && result.active.class==='row-help-button') await d.screenshot('help-focus-dark-900.png');
    }
    const q=await d.evaluate(`(()=>{const r=document.querySelector('.environment-menu .row-help-button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await d.evaluate(`document.querySelector('.environment-menu .row-help-button').blur()`);
    await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...q}); await delay();
    console.log('HOVER expected open=true and tooltip inside window/menu; actual',JSON.stringify(await d.evaluate(observe)));
    await d.screenshot('help-hover.png');
  } else {
  const attempt = async (name, fn) => { try { await fn(); } catch (e) { console.log(`NOT CHECKED ${name}: ${e.message}`); } };
  const menu = async () => { await d.evaluate(`if (document.querySelector('button.environment-trigger[aria-label^=Environment]')?.getAttribute('aria-expanded') !== 'true') document.querySelector('button.environment-trigger[aria-label^=Environment]').click()`); await delay(); };
  const dismiss = async () => { await d.evaluate(`document.querySelector('button.environment-trigger[aria-label^=Environment][aria-expanded=true]')?.click()`); await new Promise(r=>setTimeout(r,800)); };
  await menu();
  await new Promise(r=>setTimeout(r,1200));
  const height2 = await d.evaluate(`document.querySelector('.environment-menu').getBoundingClientRect().height`);
  await dismiss();
  await attempt('50 peer fixture', async () => {
    for (let i=0; i<49; i++) {
      const workspace=join(d.root,`fixture-${String(i).padStart(2,'0')}-long-synthetic-parent`, 'same-name-project');
      mkdirSync(workspace,{recursive:true});
      const tab=await d.invoke('createTab',{kind:'new',workspace,engine:'core'});
      if (!tab.ok) throw new Error(`createTab ${i} failed`);
      const own=await d.invoke('sessionPeers.set',{tabId:tab.tabId,projectKey:workspace,enabled:i<3});
      if (!own.ok) throw new Error(`enable ${i}: ${own.reason}`);
      const grant=await d.invoke('sessionPeers.set',{tabId:a.tabId,projectKey:a.workspace,peerKey:workspace,enabled:i<3});
      if (!grant.ok) throw new Error(`grant ${i}: ${grant.reason}`);
      await d.api(`/tabs/${tab.tabId}/close`,{});
    }
  });
  await d.api(`/tabs/${a.tabId}/select`,{}); await menu();
  await new Promise(r=>setTimeout(r,1200));
  const height50 = await d.evaluate(`document.querySelector('.environment-menu').getBoundingClientRect().height`);
  console.log(`${height2===height50?'PASS':'FAIL'} menu height 2 vs 50: ${height2} / ${height50}`);
  await dismiss();
  await attempt('preview open',async()=>{ const path=join(a.workspace,'synthetic-preview.md'); writeFileSync(path,'# Synthetic preview\n'); await d.api(`/tabs/${a.tabId}/previews`,{path}); await delay(); });
  for (const theme of ['dark','light']) for (const width of [900,1400]) {
    await d.cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await d.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await d.evaluate(`document.querySelector('button.environment-trigger[aria-label^=Environment]').click()`); await delay();
    await shot(`menu-${theme}-${width}`,`!!document.querySelector('.environment-menu')`);
    await check(`menu overflow ${theme} ${width}`,`(()=>{const e=document.querySelector('.environment-menu'); return !!e && e.scrollWidth<=e.clientWidth})()`);
    await d.evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const poll=()=>document.querySelector('.environment-menu .row-help-button')?resolve(true):Date.now()>end?reject(Error('help button missing')):setTimeout(poll,100);poll()})`);
    await new Promise(r=>setTimeout(r,1500));
    await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});
    await d.evaluate(`document.querySelector('.environment-menu .row-help-button').focus()`); await delay();
    await shot(`help-focus-${theme}-${width}`,`!!document.querySelector('[role=tooltip][data-open=true]')`,{tooltip:true});
    await d.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Manage…'))?.click()`); await delay();
    await shot(`dialog-${theme}-${width}`,`document.querySelectorAll('.session-peers-row').length === 50`);
    console.log('ROWS', await d.evaluate(`JSON.stringify([...document.querySelectorAll('.session-peers-row')].map(x=>x.dataset.granted))`));
    await check('granted first',`(()=>{const x=[...document.querySelectorAll('.session-peers-row')].map(e=>e.dataset.granted);return x.length===50 && x.includes('true') && x.every((v,i)=>v!=='true'||!x.slice(0,i).includes('false'))})()`);
    await check('overlay preview hidden while open',`document.body.innerText.includes('Preview hidden')`);
    await check('search focused',`!!document.activeElement?.closest('.session-peers-search')`);
    await check('dialog overflow',`(()=>{const e=document.querySelector('.session-peers-dialog');return !!e && e.scrollWidth<=e.clientWidth})()`);
    const ends = `(()=>{const d=document.querySelector('.session-peers-dialog'); const a=[...d.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(e=>e.getClientRects().length); window.__tabEnds=[a[0],a.at(-1)]; return a.length})()`;
    console.log('TAB CONTROLS',await d.evaluate(ends));
    await d.evaluate('window.__tabEnds[1].focus()'); await key('Tab','Tab',9);
    await check('Tab last to first',`document.activeElement===window.__tabEnds[0]`);
    await key('Tab','Tab',9,8);
    await check('Shift+Tab first to last',`document.activeElement===window.__tabEnds[1]`);
    await d.evaluate(`(()=>{const x=document.querySelector('.session-peers-search input');if(x){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'fixture-01');x.dispatchEvent(new Event('input',{bubbles:true}))}})()`); await delay();
    await shot(`search-match-${theme}-${width}`,`document.querySelectorAll('.session-peers-row').length===1 && document.querySelector('.session-peers-row')?.getAttribute('aria-label')?.includes('fixture-01')`);
    await d.evaluate(`(()=>{const x=document.querySelector('.session-peers-search input');if(x){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'no-such-project');x.dispatchEvent(new Event('input',{bubbles:true}))}})()`); await delay();
    await shot(`search-no-match-${theme}-${width}`,`/no (matching|projects|results)/i.test(document.querySelector('.session-peers-dialog')?.innerText || '')`);
    await d.evaluate(`document.querySelector('.session-peers-search input')?.focus()`);
    await key('Escape','Escape',27);
    await check('real Escape dialog closed',`!document.querySelector('.session-peers-dialog')`);
    console.log('ACTIVE AFTER ESCAPE',JSON.stringify(await d.evaluate(`(()=>{const e=document.activeElement;return {tag:e?.tagName,aria:e?.getAttribute('aria-label'),text:e?.textContent?.trim().slice(0,100),class:e?.className}})()`)));
    await check('real Escape focus returned',`!!document.activeElement?.matches('button.environment-trigger[aria-label^=Environment]')`);
    await check('overlay preview restored',`!document.body.innerText.includes('Preview hidden')`);
    for (const how of ['close button','outside']) {
      await menu(); await d.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Manage…'))?.click()`); await delay();
      if (how==='close button') await d.evaluate(`document.querySelector('.session-peers-dialog button[aria-label="Close"]').click()`);
      else { await d.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:2,y:2,button:'left',clickCount:1}); await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:2,y:2,button:'left',clickCount:1}); }
      await delay(); console.log('ACTIVE AFTER '+how.toUpperCase(),JSON.stringify(await d.evaluate(`(()=>{const e=document.activeElement;return {tag:e?.tagName,aria:e?.getAttribute('aria-label'),text:e?.textContent?.trim().slice(0,100)}})()`)));
      await check(how+' closed and focus returned',`!document.querySelector('.session-peers-dialog') && !!document.activeElement?.matches('button.environment-trigger[aria-label^=Environment]')`);
    }

    await d.evaluate(`document.querySelector('.environment-menu') && document.querySelector('.environment-trigger').click()`);
  }
  await attempt('hover help',async()=>{await menu(); const q=await d.evaluate(`(()=>{const e=document.querySelector('.row-help-button');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); if(!q)throw Error('help button missing'); await d.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...q}); await delay(); await shot('help-hover',`!!document.querySelector('[role=tooltip][data-open=true]')`,{tooltip:true}); await dismiss();});
  await attempt('menu variants',async()=>{
    for(const theme of ['light','dark']) for(const [shared,approvals] of [[false,false],[true,false],[true,true]]) {
      await d.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await d.invoke('communication.setSessionAccess',a.tabId,shared); if(shared) await d.invoke('communication.setSessionApprovals',a.tabId,approvals); await new Promise(r=>setTimeout(r,500));
      await menu(); await new Promise(r=>setTimeout(r,800)); await shot(`menu-shared-${theme}-${shared}-approvals-${approvals}`,`(()=>{const e=document.querySelector('[aria-label="Share this session with the Sessions API"]');return !!e && e.getAttribute('aria-checked')===${JSON.stringify(String(shared))}})()`); await dismiss();
    }
    await d.invoke('communication.setSessionAccess',a.tabId,true); await menu();
    await d.evaluate(`(()=>{const e=document.querySelector('.environment-menu-text-input'); if(e){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'UPPERCASE');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))}})()`); await delay();
    await shot('handle-error',`document.body.innerText.includes('Use lowercase letters')`); await dismiss();
  });
  await attempt('project off and revoke',async()=>{
    await menu(); await d.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Manage…'))?.click()`); await delay();
    const off=await d.invoke('sessionPeers.set',{tabId:a.tabId,projectKey:a.workspace,enabled:false}); if(!off.ok) throw Error('off failed');
    const before=await d.invoke('sessionPeers.get',a.tabId); const count=before.view.peers.filter(p=>p.granted).length;
    await d.evaluate(`document.querySelector('.session-peers-row[data-granted=true] [role=switch]')?.click()`); await delay();
    const after=await d.invoke('sessionPeers.get',a.tabId); console.log(`${after.view.peers.filter(p=>p.granted).length===count-1?'PASS':'FAIL'} revoke while project off: ${count} -> ${after.view.peers.filter(p=>p.granted).length}`);
    console.log('PROJECT OFF HEIGHTS',JSON.stringify(await d.evaluate(`(()=>{const rows=[...document.querySelectorAll('.session-peers-row')];return {granted:rows.filter(e=>e.dataset.granted==='true').map(e=>e.getBoundingClientRect().height),other:rows.filter(e=>e.dataset.granted!=='true').map(e=>e.getBoundingClientRect().height)}})()`)));
    await shot('project-off-dialog',`document.querySelector('.session-peers-dialog')?.innerText.includes('not active right now')`);
    await d.evaluate(`document.querySelector('.session-peers-search input')?.focus()`);
    await key('Escape','Escape',27);
    await check('project-off dialog closed',`!document.querySelector('.session-peers-dialog')`);
    // The line is rendered only while this project is off/untrusted and at least one grant remains; the
    // menu refetches on open, so poll for it and name the authoritative state when it does not appear.
    const view=await d.invoke('sessionPeers.get',a.tabId);
    console.log('PROJECT-OFF VIEW',JSON.stringify({projectEnabled:view.view?.project?.enabled,trusted:view.view?.project?.trusted,granted:view.view?.peers?.filter(p=>p.granted).length}));
    await dismiss(); await menu();
    const inactiveSeen=await d.evaluate(`new Promise(resolve=>{const end=Date.now()+4000;const probe=()=>{const m=document.querySelector('.environment-menu');const t=m?.querySelector('.native-access-summary')?.innerText||'';if(t.includes('Currently inactive')||Date.now()>end)resolve(t);else setTimeout(probe,100)};probe()})`);
    console.log('MENU SUMMARY',JSON.stringify(inactiveSeen));
    await shot('currently-inactive',`!!document.querySelector('.environment-menu .native-access-summary-state')?.innerText.includes('Currently inactive')`); await dismiss();
  });
  await attempt('untrusted disabled reason',async()=>{
    const trustPath=join(d.root,'.anycode','workspace-trust.json'); const trust=JSON.parse(readFileSync(trustPath,'utf8')); delete trust.folders[a.workspace]; writeFileSync(trustPath,JSON.stringify(trust));
    await menu(); await shot('native-untrusted-disabled',`(()=>{const m=document.querySelector('.environment-menu');return !!m && m.innerText.includes('Trust this folder first') && !!m.querySelector('[aria-label="Native session access"]:disabled')})()`); await dismiss();
  });
  await attempt('reload persistence',async()=>{const before=await d.invoke('sessionPeers.get',a.tabId);const communication=await d.invoke('communication.get');await d.cdp.call('Page.reload');await new Promise(r=>setTimeout(r,3000));const after=await d.invoke('sessionPeers.get',a.tabId);const afterComm=await d.invoke('communication.get');console.log(`${JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(communication)===JSON.stringify(afterComm)?'PASS':'FAIL'} reload grants and approvals unchanged`);});
  console.log('STUB WRITABLE',JSON.stringify(await d.evaluate(`({window:Object.getOwnPropertyDescriptor(window,'anycode')?.writable, peers:Object.getOwnPropertyDescriptor(window.anycode,'sessionPeers')?.writable, frozen:Object.isFrozen(window.anycode.sessionPeers)})`)));
  }
} catch (error) { console.error('FAIL run:', error.message); d.reportFailure(error); process.exitCode=1; }
finally { await d.close(); }

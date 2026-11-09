/** Isolated live Session access observations; screenshots contain synthetic fixtures only. */
import { createPeerSmoke } from './session-peers-smoke.mjs';
import { resolve } from 'node:path';
const pngDir = process.env.ANYCODE_SHOTS_DIR || '/Users/incadawr/projects/tools/anycode/working-docs/design-review/t3-session-access/shots';
const d = await createPeerSmoke({pngDir:resolve(pngDir)});
const delay = () => new Promise(r => setTimeout(r,400));
const check = async (name, expression) => { try { const value = await d.evaluate(expression); console.log(`${value ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(value)}`); return value; } catch(e) { console.log(`FAIL ${name}: ${e.message}`); return false; } };
const shot = async (name, expression) => { if (await check(name,expression)) await d.screenshot(name+'.png'); };
const key = async (key, code, n) => { await d.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n}); await d.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n}); await delay(); };
try {
  await d.start();
  const [a] = d.tabs;
  await d.api(`/tabs/${a.tabId}/select`,{});
  for (const theme of ['dark','light']) for (const width of [900,1400]) {
    await d.cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await d.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await d.evaluate(`document.querySelector('button.environment-trigger[aria-label^=Environment]').click()`); await delay();
    await shot(`menu-${theme}-${width}`,`!!document.querySelector('.environment-menu')`);
    await check(`menu overflow ${theme} ${width}`,`(()=>{const e=document.querySelector('.environment-menu'); return !!e && e.scrollWidth<=e.clientWidth})()`);
    await d.evaluate(`document.querySelector('[aria-label="About external approvals"]')?.focus()`); await delay();
    await shot(`help-focus-${theme}-${width}`,`!!document.querySelector('[role=tooltip]')`);
    await d.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Manage…'))?.click()`); await delay();
    await shot(`dialog-${theme}-${width}`,`!!document.querySelector('.session-peers-dialog')`);
    await check('search focused',`!!document.activeElement?.closest('.session-peers-search')`);
    await check('dialog overflow',`(()=>{const e=document.querySelector('.session-peers-dialog');return !!e && e.scrollWidth<=e.clientWidth})()`);
    await key('Tab','Tab',9);
    await check('Tab stays in dialog',`!!document.activeElement?.closest('.session-peers-dialog')`);
    await d.evaluate(`(()=>{const x=document.querySelector('.session-peers-search input');if(x){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'no-such-project');x.dispatchEvent(new Event('input',{bubbles:true}))}})()`); await delay();
    await shot(`search-no-match-${theme}-${width}`,`/no (matching|projects|results)/i.test(document.querySelector('.session-peers-dialog')?.innerText || '')`);
    await key('Escape','Escape',27);
    await check('real Escape closes and returns focus',`!document.querySelector('.session-peers-dialog') && !!document.activeElement?.matches('.environment-trigger')`);
    await d.evaluate(`document.querySelector('.environment-menu') && document.querySelector('.environment-trigger').click()`);
  }
} catch (error) { console.error('FAIL run:', error.message); d.reportFailure(error); process.exitCode=1; }
finally { await d.close(); }

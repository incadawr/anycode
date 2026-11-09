/** Isolated live Session access observations; screenshots contain synthetic fixtures only. */
import { createPeerSmoke, wait } from './session-peers-smoke.mjs';
import { resolve } from 'node:path';
const pngDir = process.env.ANYCODE_SHOTS_DIR || '/Users/incadawr/projects/tools/anycode/working-docs/design-review/t3-session-access/shots';
const d = await createPeerSmoke({pngDir:resolve(pngDir)});
const delay = () => new Promise(r => setTimeout(r,400));
const obs = (name, result) => console.log(`${result ? 'PASS' : 'FAIL'} ${name}`);
try {
  await d.start();
  const [a] = d.tabs;
  await d.api(`/tabs/${a.tabId}/select`,{}); await d.evaluate(`document.querySelector("button.environment-trigger[aria-label^=Environment]").click()`); await delay();
  console.log('MENU', await d.evaluate('document.querySelector(".environment-menu")?.innerText'));
  await d.screenshot('01-menu-dark.png');
  await d.evaluate(`document.querySelector('[aria-label="About external approvals"]')?.focus()`); await delay();
  await d.screenshot('02-help-focus-dark.png');
  await d.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Manage…'))?.click()`); await delay();
  console.log('DIALOG', await d.evaluate('document.querySelector(".session-peers-dialog")?.innerText'));
  await d.screenshot('03-dialog-dark.png');
  obs('search focus', await d.evaluate('document.activeElement?.closest(".session-peers-search") !== null'));
  obs('horizontal overflow', await d.evaluate('!!document.querySelector(".session-peers-dialog") && document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll(".session-peers-dialog")].every(x=>x.scrollWidth<=x.clientWidth)'));
  await d.evaluate(`(() => {const x=document.querySelector('.session-peers-search input'); if(x){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'no-such-project'); x.dispatchEvent(new Event('input',{bubbles:true}));}})()`); await delay();
  await d.screenshot('04-search-no-match-dark.png');
  await d.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await delay();
  obs('Escape closes dialog', await d.evaluate('!document.querySelector(".session-peers-dialog")'));
} catch (error) { console.error('FAIL run:', error.message); d.reportFailure(error); process.exitCode=1; }
finally { await d.close(); }

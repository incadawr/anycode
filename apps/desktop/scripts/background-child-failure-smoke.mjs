/** Isolated, credential-free live background child acceptance probe. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createPeerSmoke, wait } from './session-peers-smoke.mjs';

const driver = await createPeerSmoke({targetEngine:'core',pngDir:'/Users/incadawr/projects/tools/anycode/working-docs/design-review/t2-bg-child-startup/shots'});
const pause = ms => new Promise(r => setTimeout(r,ms));
const cmd = command => `peer-command:${JSON.stringify({tool:'Bash',input:{command}})}`;
const input = (description,command='sleep 300') => ({description,prompt:cmd(command),agent_type:'general-purpose',tier:'session',detach:true});
async function spawn(tab,description,command) {
  for (let i=0;i<4;i++) {
    await wait(async()=>{const s=(await driver.api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId];return s?.connection==='ready' && s?.turn?.status==='idle';},60000);
    await pause(1200);
    try { const result=await driver.tool(tab,'Agent',input(description,command),{approve:false}); const id=result.match(/Child session id: ([\w-]+)/)?.[1]; assert(id,result); return id; }
    catch(e) { if(!String(e).includes('Fixture tool prompt refused') || i===3) throw e; }
  }
}
async function state(tab) { return driver.api(`/state/${tab.tabId}`); }
async function approve(tab,id) {
  const {run,permission}=await wait(async()=>{const s=await state(tab);const run=s.childRuns.find(x=>x.childSessionId===id);const permission=run && s.snapshot.childStates[run.childTabId]?.permission;return permission && {run,permission};},60000);
  console.log('APPROVE',id,JSON.stringify(permission));
  const result=await driver.api(`/tabs/${run.childTabId}/permission`,{behavior:'allow',requestId:permission.requestId}); assert(result.ok,JSON.stringify(result)); return run;
}
async function closePopover() {
  await driver.evaluate(`document.querySelectorAll('.child-worktree-control[open]').forEach(x=>x.open=false)`);
  assert.equal(await driver.evaluate(`!!document.querySelector('.child-worktree-control[open]')`),false);
}
async function shot(name) { await closePopover(); assert.equal(await driver.evaluate(`document.body.innerText.includes('Waiting for permission')`),false); await driver.screenshot(name); console.log('SHOT',name,await driver.evaluate('innerWidth')); }
async function rows() { return driver.evaluate(`document.querySelector('.background-agents')?.innerText ?? ''`); }
async function click(label) { assert(await driver.evaluate(`(() => { const b=[...document.querySelectorAll('.background-agents button')].find(x=>x.getAttribute('aria-label')?.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`)); }
async function startKill(parent,description) {
  const id=await spawn(parent,description); const run=await wait(async()=> (await state(parent)).childRuns.find(x=>x.childSessionId===id && x.pid),60000);
  console.log('KILL',JSON.stringify(run)); process.kill(run.pid,'SIGKILL');
  await wait(async()=> (await rows()).includes(description) && (await rows()).includes('Dismiss'),60000); return id;
}
try {
  await driver.start(); const parent=driver.tabs[0];
  execFileSync('git',['init',parent.workspace],{stdio:'ignore'});
  execFileSync('git',['-C',parent.workspace,'-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
  await driver.orchestrate(parent,true); await driver.api(`/tabs/${parent.tabId}/select`,{});
  if (process.env.T2_MANAGED_ONLY) {
    await driver.evaluate(`(() => {const d=document.querySelector('.child-worktree-control');d.open=true;const e=d.querySelector('input');if(!e.checked)e.click()})()`); await pause(1000); await closePopover();
    const id=await spawn(parent,'Synthetic successful managed pwd','pwd');
    const requests=await wait(()=>driver.native('core').find(messages=>messages.some(m=>m.role==='tool' && typeof m.content==='string' && m.content.includes('/.anycode/worktrees/child-'))),120000);
    const system=requests.find(m=>m.role==='system').content;
    const cwd=system.match(/Working directory: ([^\n]+)/)?.[1];
    const result=JSON.parse(requests.find(m=>m.role==='tool' && m.content.includes('/.anycode/worktrees/child-')).content);
    assert.equal(result.stdout.trim(),cwd);
    assert.equal(requests.filter(m=>m.role==='user' && typeof m.content==='string' && m.content.startsWith(cmd('pwd'))).length,1);
    const report=await wait(async()=>{const transcript=(await state(parent)).snapshot.states[parent.tabId]?.transcript ?? [];return transcript.find(b=>b.kind==='user_text' && b.origin==='system' && b.text.includes(id) && b.text.includes('<status>completed</status>'));},120000);
    assert(report.text.includes(cwd)); console.log('MANAGED PWD',cwd,'PROMPT COUNT IN REQUEST',1,'PARENT COMPLETION REPORT',report.text);
    console.log('PERSISTED WORKSPACE NOT CHECKED: database row not inspected');

  } else {
  const ids=[];
  for(const name of ['Synthetic running one','Synthetic running two']) { const id=await spawn(parent,name); ids.push(id); await approve(parent,id); }
  await wait(async()=>!(await rows()).includes('Waiting for permission'),60000);
  await driver.evaluate(`(() => {const d=document.querySelector('.child-worktree-control');d.open=true;const e=d.querySelector('input');if(!e.checked)e.click()})()`); await pause(1000); await closePopover();
  const description='Synthetic managed failure with a deliberately long description for the narrow window';
  const failed=await startKill(parent,description);
  console.log('MIXED',await rows()); assert.match(await rows(),/2 running · 1 failed/);
  const wtRoot=join(parent.workspace,'.anycode','worktrees'); const worktrees=readdirSync(wtRoot); console.log('RETAINED',worktrees.map(x=>relative(parent.workspace,join(wtRoot,x))),worktrees.every(x=>existsSync(join(wtRoot,x))));
  await shot('mixed.png');
  await driver.evaluate('window.resizeTo(900, 900)'); await pause(1000); console.log('RESIZE',await driver.evaluate('innerWidth')); await shot('mixed-900.png');
  const beforeClock=await driver.evaluate(`document.querySelector('.background-agents-item-failed .background-agents-elapsed')?.textContent`); await pause(61000);
  const afterClock=await driver.evaluate(`document.querySelector('.background-agents-item-failed .background-agents-elapsed')?.textContent`); assert.equal(beforeClock,afterClock); console.log('FROZEN',beforeClock,afterClock);
  const before=(await state(parent)).childRuns; await click('Dismiss failed'); await pause(1000); const after=(await state(parent)).childRuns;
  console.log('DISMISS RUNS BEFORE',JSON.stringify(before),'AFTER',JSON.stringify(after)); assert(ids.every(id=>after.some(r=>r.childSessionId===id && r.state==='running'))); assert(!(await rows()).includes(description)); await shot('after-dismiss.png');
  try { await driver.evaluate('location.reload(); true'); } catch(e) { console.log('reload call',e.message); }
  await wait(async()=>{try{return await driver.evaluate(`typeof window.__anycodeAutomation !== 'undefined'`)}catch{return false}},60000); await pause(3000);
  console.log('RELOAD ROWS',await rows()); assert(!(await rows()).includes(description)); console.log('PASS dismissed row absent after reload');
  // Recreate a failure for the failed-only view; use a separate parent if reload drops the tab.
  await driver.api(`/tabs/${parent.tabId}/select`,{});
  const second=await startKill(parent,'Synthetic second failed child');
  for (const name of ['Synthetic running one','Synthetic running two']) await click(`Stop background agent ${name}`);
  await wait(async()=> /1 background agent failed/.test(await rows()),60000); await shot('failed-only.png');
  await click('Dismiss failed');
  }

} catch(e) { driver.reportFailure(e); console.error('FAIL',e.stack); process.exitCode=1; }
finally { await driver.close(); }

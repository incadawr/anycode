/** Credential-free exploratory live probe for background child failures. */
import { execFileSync } from 'node:child_process';
import { createPeerSmoke, wait } from './session-peers-smoke.mjs';

const driver = await createPeerSmoke({targetEngine:'core',pngDir:'/Users/incadawr/projects/tools/anycode/working-docs/design-review/t2-bg-child-startup/shots'});
const pause = ms => new Promise(r => setTimeout(r,ms));
async function tool(tab,input) {
  for (let i=0;i<4;i++) {
    await wait(async () => { const s=(await driver.api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]; return s?.connection === 'ready' && s?.turn?.status === 'idle'; },60000);
    await pause(1200);
    try { return await driver.tool(tab,'Agent',input,{approve:false}); }
    catch (e) { if (!String(e).includes('Fixture tool prompt refused') || i===3) throw e; }
  }
}
const input = (description, extra={}) => ({description,prompt:`peer-command:${JSON.stringify({tool:'Bash',input:{command:'sleep 300'}})}`,agent_type:'general-purpose',tier:'session',detach:true,...extra});
async function attempt(name,fn) { try { const r=await fn(); console.log(name,typeof r==='string'?r:JSON.stringify(r)); return r; } catch(e) { console.log(name,'FAILED',e.message); } }
try {
  await driver.start();
  const [parent,nonGit]=driver.tabs;
  execFileSync('git',['init',parent.workspace],{stdio:'ignore'});
  execFileSync('git',['-C',parent.workspace,'-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
  await driver.orchestrate(parent,true); await driver.orchestrate(nonGit,true);
  await attempt('invalid model',()=>tool(parent,input('Synthetic invalid model',{model:'unavailable-model'})));
  await driver.api(`/tabs/${nonGit.tabId}/select`,{});
  await attempt('enable non-git worktrees',()=>driver.evaluate(`(() => { const d=document.querySelector('.child-worktree-control'); if(!d) return 'control absent'; d.open=true; const e=[...d.querySelectorAll('input')][0]; if(!e) return 'checkbox absent'; if(!e.checked)e.click(); return 'clicked'; })()`));
  await attempt('non-git managed child',()=>tool(nonGit,input('Synthetic non-git failure')));
  await driver.api(`/tabs/${parent.tabId}/select`,{});
  for (const name of ['Synthetic running one','Synthetic running two']) await attempt(name,()=>tool(parent,input(name)));
  await attempt('enable git worktrees',()=>driver.evaluate(`(() => { const d=document.querySelector('.child-worktree-control'); d.open=true; const e=d.querySelector('input'); if(!e.checked)e.click(); return 'clicked'; })()`));
  await pause(1000);
  await attempt('managed kill target',()=>tool(parent,input('Synthetic managed kill target with a long description')));
  let state=await driver.api(`/state/${parent.tabId}`);
  console.log('childRuns',JSON.stringify(state.childRuns));
  const target=state.childRuns.at(-1);
  if (target?.pid) { process.kill(target.pid,'SIGKILL'); console.log('killed child host',target.pid,'state',target.state); } else console.log('kill NOT CHECKED: no child pid');
  await pause(4000);
  console.log('body',await driver.evaluate('document.body.innerText'));
  await attempt('mixed screenshot',()=>driver.screenshot('mixed.png'));
  const before=await driver.evaluate(`document.querySelector('.background-agents')?.innerText`);
  await pause(61000);
  const after=await driver.evaluate(`document.querySelector('.background-agents')?.innerText`);
  console.log('CLOCK BEFORE',before,'CLOCK AFTER',after);
  await attempt('dismiss',()=>driver.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Dismiss'); if (!b) return 'missing'; b.click(); return 'clicked'; })()`));
  await pause(1000); console.log('AFTER DISMISS',await driver.evaluate('document.body.innerText'));
  await attempt('dismiss screenshot',()=>driver.screenshot('after-dismiss.png'));
  console.log('REPLAY NOT CHECKED: reload driver not implemented; host cancel NOT CHECKED: no cancel event instrumentation');
} catch(e) { driver.reportFailure(e); console.log('FATAL',e.stack); process.exitCode=1; }
finally { await driver.close(); }

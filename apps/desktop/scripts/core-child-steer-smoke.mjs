/** Credential-free preliminary T1 acceptance driver. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPeerSmoke, wait } from './session-peers-smoke.mjs';

const scenarios = [
  ['External API steer and status at a tool barrier', 'Sessions API driver not implemented.'],
  ['Retried message id', 'Parent send_to allocates its own id; Sessions API driver not implemented.'],
  ['Child pane and reload', 'Pane input and reload driver not implemented.'],
  ['Cancel before seam', 'Cancellation and status driver not implemented.'],
  ['Early send before first turn', 'Requires control of child startup.'],
];
const driver = await createPeerSmoke({ targetEngine: 'core', pngDir: '/Users/incadawr/projects/tools/anycode/working-docs/design-review/t1-core-child-msg/shots' });
try {
  await driver.start();
  console.log('PASS isolated local provider and desktop launch');
  const parent = driver.tabs[0];
  await driver.orchestrate(parent, true);
  const childCommand = `peer-command:${JSON.stringify({tool:'Bash',input:{command:'sleep 45'}})}`;
  const result = await driver.tool(parent, 'Agent', {description:'Synthetic child', prompt:childCommand, agent_type:'general-purpose', tier:'session', detach:true}, {approve:false});
  const childId = result.match(/Child session id: ([\w-]+)/)?.[1];
  if (!childId) throw new Error(`Child spawn failed: ${result}`);
  console.log('PASS child admitted');
  const child = await wait(async () => {
    const state = await driver.api(`/state/${parent.tabId}`);
    const run = state.childRuns.find(r => r.childSessionId === childId);
    const view = run && state.snapshot.childStates[run.childTabId];
    if (view?.transcript.some(b => b.kind === 'tool_call' && b.toolName === 'Bash' && b.status === 'running')) return {run,view};
  }, 60000);
  const inspect = async () => {
    const state = await driver.api(`/state/${parent.tabId}`);
    const view = state.snapshot.childStates[child.run.childTabId];
    console.log('DIAG child turn:', JSON.stringify(view?.turn));
    console.log('DIAG child permission:', JSON.stringify(view?.permission));
    console.log('DIAG child last blocks:', JSON.stringify(view?.transcript.slice(-8).map(({kind,toolName,status}) => ({kind,toolName,status}))));
    const ps = execFileSync('ps', ['-axo', 'pid=,args='], {encoding:'utf8'}).split('\n').filter(line => /[s]leep 45(?:\s|$)/.test(line));
    console.log('DIAG sleep 45 process count:', ps.length);
    return view;
  };
  const initial = await inspect();
  if (initial?.permission) {
    const approval = await driver.api(`/tabs/${child.run.childTabId}/permission`, {behavior:'allow',requestId:initial.permission.requestId});
    console.log('DIAG child permission approval:', JSON.stringify(approval));
    assert(approval.ok, 'Child permission approval failed');
  }
  const barrierStart = Date.now();
  await wait(() => execFileSync('ps', ['-axo', 'args='], {encoding:'utf8'}).split('\n').some(line => /^\s*(?:\S*\/)?sleep 45\s*$/.test(line)), 10000);
  console.log('DIAG sleep 45 process observed after approval');
  console.log('PASS child reached Bash tool', child.run.state);
  if (process.env.T1_CANCEL === '1') {
    const queued = await driver.tool(parent, 'Agent', {description:'Cancel test',prompt:'synthetic cancel instruction',tier:'session',send_to:childId}, {approve:false});
    console.log('Cancel test receipt:', queued);
    console.log('Open child result:', JSON.stringify(await driver.api(`/tabs/${parent.tabId}/child/open`, {spawnToolCallId:child.view.child.spawnToolCallId})));
    console.log('Stop child result:', JSON.stringify(await driver.api(`/tabs/${child.run.childTabId}/stop`, {})));
    await new Promise(resolve => setTimeout(resolve, 3000));
    await inspect();
    const leaked = driver.native('core').some(ms => ms.some(m => m.role === 'user' && typeof m.content === 'string' && !m.content.includes('peer-command:') && m.content.endsWith('\nsynthetic cancel instruction')));
    console.log('DIAG cancelled text found in model input:', leaked);
    assert(!leaked, 'Cancelled text reached model input');
    throw new Error('Cancellation delivery status requires Sessions API status driver');
  }
  const receipt = await driver.tool(parent, 'Agent', {description:'Send synthetic instruction',prompt:'synthetic seam instruction',tier:'session',send_to:childId}, {approve:false});
  assert.match(receipt, /Queued for injection/);
  assert.match(receipt, /Stop may reject/);
  console.log('PASS parent receipt queued and warns about Stop');
  const parentState = await driver.api(`/state/${parent.tabId}`);
  const receiptBlock = parentState.snapshot.states[parent.tabId].transcript.findLast(b => b.kind === 'tool_call' && b.modelText?.includes('Queued for injection'));
  if (receiptBlock) {
    await driver.api(`/tabs/${parent.tabId}/agent-card/${receiptBlock.toolCallId}/expand`, {});
    await driver.evaluate(`document.querySelectorAll('.tool-call-card').forEach(el => { if (el.textContent.includes('Queued for injection')) el.scrollIntoView({block:'center'}); })`);
  }
  const receiptVisible = await driver.evaluate(`Array.from(document.querySelectorAll('*')).some(el => el.textContent?.includes('Queued for injection at the next safe boundary') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)`);
  if (receiptVisible) { await driver.screenshot('parent-receipt.png'); console.log('PASS parent receipt screenshot'); }
  else console.log('NOT CHECKED parent receipt screenshot: receipt is not visible in DOM');
  const second = await driver.tool(parent, 'Agent', {description:'Send another instruction',prompt:'synthetic seam instruction',tier:'session',send_to:childId}, {approve:false});
  assert.match(second, /Queued for injection/);
  let requests;
  try { requests = await wait(() => driver.native('core').find(messages => messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(childCommand)) && messages.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.includes('peer-command:') && m.content.endsWith('\nsynthetic seam instruction')).length === 2), 90000); } catch (error) { await inspect(); console.log('DIAG provider request shapes:', JSON.stringify(driver.native('core').map(ms => ms.map(m => ({role:m.role, text:typeof m.content === 'string' ? m.content.slice(0,180) : typeof m.content, tools:!!m.tool_calls}))))); throw error; }
  const count = requests.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.includes('peer-command:') && m.content.endsWith('\nsynthetic seam instruction')).length;
  assert.equal(count, 2);
  const barrierMs = Date.now() - barrierStart;
  console.log(`Observed tool-to-next-input duration: ${barrierMs}ms`);
  assert(barrierMs > 20000, 'Tool barrier did not exceed control RPC timeout');
  console.log('PASS two identical parent messages appear in next model input exactly twice');


} catch (error) {
  driver.reportFailure(error);
  console.log(`FAIL scenario: ${error.message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
for (const [name, reason] of scenarios) console.log(`NOT CHECKED ${name}: ${reason}`);
if (!process.exitCode) process.exitCode = 2;

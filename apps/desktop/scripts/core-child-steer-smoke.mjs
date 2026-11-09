/** Credential-free preliminary T1 acceptance driver. */
import assert from 'node:assert/strict';
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
  const barrierStart = Date.now();
  console.log('PASS child reached Bash tool', child.run.state);
  const receipt = await driver.tool(parent, 'Agent', {description:'Send synthetic instruction',prompt:'synthetic seam instruction',tier:'session',send_to:childId}, {approve:false});
  assert.match(receipt, /Queued for injection/);
  assert.match(receipt, /Stop may reject/);
  console.log('PASS parent receipt queued and warns about Stop');
  const receiptVisible = await driver.evaluate(`Array.from(document.querySelectorAll('*')).some(el => el.textContent?.includes('Queued for injection at the next safe boundary') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)`);
  if (receiptVisible) { await driver.screenshot('parent-receipt.png'); console.log('PASS parent receipt screenshot'); }
  else console.log('NOT CHECKED parent receipt screenshot: receipt is not visible in DOM');
  const second = await driver.tool(parent, 'Agent', {description:'Send another instruction',prompt:'synthetic seam instruction',tier:'session',send_to:childId}, {approve:false});
  assert.match(second, /Queued for injection/);
  const requests = await wait(() => driver.native('core').find(messages => messages.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('synthetic seam instruction')).length >= 2), 90000);
  const count = requests.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('synthetic seam instruction')).length;
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

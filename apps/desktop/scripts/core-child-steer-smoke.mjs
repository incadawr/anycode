/** Credential-free preliminary T1 acceptance driver. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectIsolatedCdp } from './isolated-cdp.mjs';
import { createPeerSmoke, wait } from './session-peers-smoke.mjs';

const scenarios = [['Early send before first turn', 'Requires control of child startup.']];
const driver = await createPeerSmoke({ targetEngine: 'core', pngDir: '/Users/incadawr/projects/tools/anycode/working-docs/design-review/t1-core-child-msg/shots' });
try {
  await driver.start();
  console.log('PASS isolated local provider and desktop launch');
  const parent = driver.tabs[0];
  const allowed = await driver.evaluate(`window.anycode.communication.agentProjectsSet(${JSON.stringify(parent.workspace)},true)`);
  const enabled = await driver.evaluate('window.anycode.communication.setEnabled(true)');
  assert(allowed.ok && enabled.ok, 'Sessions API setup failed');
  const discovery = await wait(() => existsSync(join(driver.root,'user-data','communication.json')) && JSON.parse(readFileSync(join(driver.root,'user-data','communication.json'),'utf8')));
  let sid, rpcId = 0;
  async function rpc(method, params, notification = false) {
    const response = await fetch(discovery.url, {method:'POST',headers:{Authorization:`Bearer ${discovery.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(sid ? {'Mcp-Session-Id':sid} : {})},body:JSON.stringify({jsonrpc:'2.0',...(!notification ? {id:++rpcId} : {}),method,params})});
    sid = response.headers.get('mcp-session-id') ?? sid;
    const body = await response.text();
    assert(response.ok, `MCP HTTP ${response.status}`);
    if (notification) return;
    const result = JSON.parse(body.startsWith('data:') ? body.split('\n').find(line => line.startsWith('data:')).slice(5) : body);
    if (result.error || result.result?.isError) throw new Error(`MCP ${method} refused: ${JSON.stringify(result.error ?? result.result)}`);
    return result.result;
  }
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'child-steer-smoke',version:'1'}});
  await rpc('notifications/initialized',{},true);
  const call = async (name,args) => JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);
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
  const access = await driver.evaluate(`window.anycode.communication.setSessionAccess(${JSON.stringify(child.run.childTabId)},true)`);
  console.log('DIAG child session access:', access.ok ? 'enabled' : 'refused');
  const apiArgs = {sessionId:childId, mode:'steer', payload:process.env.T1_CANCEL === '1' ? 'synthetic api cancel' : 'synthetic api steer', idempotencyKey:'t1-smoke-fixed-key'};
  const apiReceipt = await call('send_message',apiArgs);
  console.log('API receipt:', JSON.stringify({state:apiReceipt.state,deliveryKind:apiReceipt.deliveryKind,detail:apiReceipt.detail}));
  const apiId = apiReceipt.envelope.messageId;
  const retry = await call('send_message',apiArgs);
  assert.equal(retry.envelope.messageId, apiId);
  console.log('PASS API retry returns same message id');
  if (process.env.T1_UI === '1') {
    const identity = JSON.parse(readFileSync(join(driver.root,'identity.json'),'utf8'));
    const ppid = Number(execFileSync('ps',['-o','ppid=','-p',String(identity.pid)],{encoding:'utf8'}).trim());
    const cdp = await connectIsolatedCdp({profile:driver.root,env:{REMOTE_DEBUGGING_PORT:'0',ANYCODE_SMOKE_IDENTITY:identity.nonce,ANYCODE_EXPECTED_DESKTOP_ROOT:identity.desktopRoot},launcher:{pid:ppid},wait});
    try {
      assert((await driver.api(`/tabs/${parent.tabId}/child/open`,{spawnToolCallId:child.view.child.spawnToolCallId})).ok);
      const focus = await wait(() => driver.evaluate(`(() => { const el = document.querySelector('textarea'); if (!el) return false; el.focus(); return true; })()`),15000);
      assert(focus);
      await cdp.call('Input.insertText',{text:'synthetic pane instruction'});
      await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      const pending = await wait(() => driver.evaluate(`document.body.innerText.includes('synthetic pane instruction')`),15000);
      assert(pending); await driver.screenshot('child-pending.png'); console.log('PASS child pending screenshot');
      await wait(() => driver.native('core').some(ms => ms.some(m => m.role === 'user' && typeof m.content === 'string' && m.content === 'synthetic pane instruction')),90000);
      const count = await driver.evaluate(`Array.from(document.querySelectorAll('.message-list [data-block-id]')).filter(el => el.innerText.includes('synthetic pane instruction')).length`);
      console.log('DIAG child bubble count before reload:',count);
      assert.equal(count,1); await driver.screenshot('child-injected.png');
      await cdp.call('Page.reload');
      await wait(() => driver.evaluate(`typeof window.anycode?.createTab === 'function' && !!window.__anycodeAutomation`),30000);
      const reopened = await wait(async () => { try { const result = await driver.api(`/tabs/${parent.tabId}/child/open`,{spawnToolCallId:child.view.child.spawnToolCallId}); return result.ok ? result : null; } catch { return null; } },30000);
      console.log('DIAG reopen after reload:', JSON.stringify(reopened));
      assert(reopened.ok, 'Child pane could not be reopened after reload');
      await wait(() => driver.evaluate(`Array.from(document.querySelectorAll('.message-list [data-block-id]')).some(el => el.innerText.includes('synthetic pane instruction'))`),30000);
      const after = await driver.evaluate(`Array.from(document.querySelectorAll('.message-list [data-block-id]')).filter(el => el.innerText.includes('synthetic pane instruction')).length`);
      console.log('DIAG child bubble count after reload:',after);
      assert.equal(after,1); await driver.screenshot('child-reload.png');
      console.log('PASS child bubble and reload');
    } finally { cdp.ws.close(); }
    throw new Error('T1_UI_COMPLETE');
  }
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
    const parentId = queued.match(/Check message status with this id: ([\w-]+)/)?.[1];
    assert(parentId, 'Parent receipt missing message id');
    const cancelled = await wait(async () => { const v = await call('get_message_status',{messageId:apiId}); return v.state === 'rejected' ? v : null; }, 15000);
    console.log('API cancel status:', JSON.stringify({state:cancelled.state,deliveryKind:cancelled.deliveryKind,detail:cancelled.detail}));
    assert.equal(cancelled.state,'rejected');
    const parentStatus = await call('get_message_status',{messageId:parentId});
    console.log('Parent cancel status:', JSON.stringify({state:parentStatus.state,deliveryKind:parentStatus.deliveryKind,detail:parentStatus.detail}));
    assert.equal(parentStatus.state,'rejected');
    process.exitCode = 2;
    throw new Error('T1_CANCEL_COMPLETE');
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
  const status = await wait(async () => { const v = await call('get_message_status',{messageId:apiId}); return v.state === 'acknowledged' ? v : null; }, 30000);
  console.log('API final status:', JSON.stringify({state:status.state,deliveryKind:status.deliveryKind,detail:status.detail}));
  assert.equal(status.deliveryKind,'core_seam');
  assert.equal(requests.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.endsWith('\nsynthetic api steer')).length,1);
  const count = requests.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.includes('peer-command:') && m.content.endsWith('\nsynthetic seam instruction')).length;
  assert.equal(count, 2);
  const barrierMs = Date.now() - barrierStart;
  console.log(`Observed tool-to-next-input duration: ${barrierMs}ms`);
  assert(barrierMs > 20000, 'Tool barrier did not exceed control RPC timeout');
  console.log('PASS two identical parent messages appear in next model input exactly twice');


} catch (error) {
  if (['T1_CANCEL_COMPLETE','T1_UI_COMPLETE'].includes(error.message)) { console.log('PASS selected scenario'); process.exitCode = 2; }
  else { driver.reportFailure(error); console.log(`FAIL scenario: ${error.message}`); process.exitCode = 1; }
} finally {
  await driver.close();
}
for (const [name, reason] of scenarios) console.log(`NOT CHECKED ${name}: ${reason}`);
if (!process.exitCode) process.exitCode = 2;

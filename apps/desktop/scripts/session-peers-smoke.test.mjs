import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inside, peerEnv, judgeDelivery, captureLaunchLog, checkAuthoritySteps, parsePeerCommand } from './session-peers-smoke.mjs';
import { assertProductionPaths, assertSmokeAbsentFromAsar } from './smoke-package-guard.mjs';

function temporary(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'peers-judgement-')));
  try { return fn(root); } finally { rmSync(root,{recursive:true,force:true}); }
}
test('poisoned owner HOME and credential environment never reach fixtures',() => temporary(root => {
  const sentinel = join(root,'poison'); writeFileSync(sentinel,'DO NOT READ');
  const before = readdirSync(root);
  const env = peerEnv({HOME:sentinel,NODE_OPTIONS:`--require=${sentinel}`,ANYCODE_API_KEY:'owner-secret',ANYCODE_COMMUNICATION_CONFIG:sentinel},root,{codex:join(root,'codex-double'),claude:join(root,'claude-double')});
  assert.equal(env.HOME,root); assert.equal(env.NODE_OPTIONS,undefined);
  assert.equal(env.ANYCODE_API_KEY,undefined); assert.equal(env.ANYCODE_COMMUNICATION_CONFIG,undefined);
  const probe = spawnSync(process.execPath,['-e',"process.stdout.write(require('node:os').homedir())"],{env,encoding:'utf8'});
  assert.equal(probe.status,0); assert.equal(probe.stdout,root);
  assert.deepEqual(readdirSync(root),before); assert.equal(readFileSync(sentinel,'utf8'),'DO NOT READ');
}));
test('all fixture file paths stay under root, including existing ancestors',() => temporary(root => {
  assert.equal(inside(root,join(root,'new','file')),join(root,'new','file'));
  assert.throws(() => inside(root,join(root,'..','owner')));
  symlinkSync(tmpdir(),join(root,'escape'));
  assert.throws(() => inside(root,join(root,'escape','file')));
  assert.throws(() => peerEnv({},root,{codex:'/owner/codex',claude:join(root,'claude-double')}));
}));
test('fake main-only ACK and old target nonce cannot declare PASS',() => {
  const nonce = 'delivery-nonce';
  for (const requests of [[],[{mainAck: true}],[{input:nonce}]]) {
    assert.throws(() => judgeDelivery({before:requests.length,requests,nonce}));
  }
  judgeDelivery({before:1,requests:[{input:'old'},{params:{input:nonce}}],nonce});
});
test('package allowlist excludes driver and doubles; archive guard rejects leaked files',() => temporary(root => {
  const config = readFileSync(new URL('../electron-builder.yml',import.meta.url),'utf8');
  const files = config.split('files:\n')[1].split('\n#')[0];
  assert.match(files,/  - out\/\*\*/);
  assert(!/^  - (?!["']?!)(?!out\/\*\*)/m.test(files),'Packaging allowlist widened');
  const archive = join(root,'app.asar');
  function pack(name) {
    const header = Buffer.from(JSON.stringify({files:{[name]:{size:0,offset:'0'}}}));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length,12);
    writeFileSync(archive,Buffer.concat([prefix,header]));
  }
  pack('index.js'); assertSmokeAbsentFromAsar(archive);
  for (const name of ['session-peers-smoke.mjs','native-double.mjs','engine-smoke-fixtures.mjs','scripts/leak.mjs']) {
    assert.throws(() => assertProductionPaths([name]));
    pack(name); assert.throws(() => assertSmokeAbsentFromAsar(archive));
  }
  const source = readFileSync(new URL('./assert-package.mjs',import.meta.url),'utf8');
  assert.match(source,/assertSmokeAbsentFromAsar\(join\(dirname\(unpacked\), "app.asar"\)\)/);
}));

test('launcher captures both streams, redacts split sensitive lines, and delays file creation',() => temporary(root => {
  const file = join(root,'launcher.log');
  const app = {stdout:new EventEmitter(),stderr:new EventEmitter()};
  const save = captureLaunchLog(app,file,[root,'delivery-nonce']);
  app.stdout.emit('data',Buffer.from('vite ready\nAuthorization: Bea'));
  app.stdout.emit('data',Buffer.from('rer credential-value\n{"messages":["private body"]}\n'));
  app.stderr.emit('data',Buffer.from(`Error: Electron uninstall\n${root}/error delivery-nonce\n`));
  app.stderr.emit('data',Buffer.from('at /arbitrary/repo/file.ts /private/var/build/file.ts C:\\build\\file.ts\npayload=private-tail'));
  assert.deepEqual(readdirSync(root),[],'Log must not trip the fresh-profile startup gate');
  const output = save();
  assert.equal(readFileSync(file,'utf8'),output);
  assert.match(output,/\[stdout\] vite ready/);
  assert.match(output,/\[stderr\] Error: Electron uninstall/);
  for (const value of ['credential-value','private body','private-tail','/arbitrary/repo/file.ts','/private/var/build/file.ts','C:\\build\\file.ts',root,'delivery-nonce']) assert(!output.includes(value));
  assert.equal(save(),output,'Flushing twice must not duplicate trailing output');
}));

// Exercise the mode sequence and evidence judgement without launching Electron.
function authorityDouble({stale = false, planResult = '{"status":"refused"}', planWrites = false} = {}) {
  const requests = [], events = [];
  let plan = false;
  return {
    nonce:'unique', events, native:() => requests,
    check:(...args) => events.push(args), screenshot:async () => {},
    orchestrate:async (_,enabled) => events.push(['orchestrate',enabled]),
    selectMode:async (_,mode) => { plan = mode === 'plan'; events.push(['mode',mode]); },
    sendPeer:async (_,__,nonce,options) => {
      events.push(['send',nonce,options]);
      if ((!plan || planWrites) && !stale) requests.push({params:{input:nonce}});
      return plan ? planResult : '{"status":"sent"}';
    },
    waitNative:async () => {},
  };
}
test('authority steps require separate build/orchestrate deliveries and an unapproved plan refusal',async () => {
  const driver = authorityDouble();
  await checkAuthoritySteps(driver,{}, {engine:'codex'});
  assert.deepEqual(driver.events.filter(e => e[0] === 'send'),[
    ['send','unique',undefined], ['send','unique-orchestrate',undefined], ['send','unique-plan',{approve:false}],
  ]);
  assert.deepEqual(driver.events.filter(e => e[0] === 'orchestrate'),[['orchestrate',true],['orchestrate',false]]);
  assert(driver.events.some(e => e[0] === 'plan-refused' && e[1] === 'PASS'));
});
test('authority steps reject missing native evidence, unexpected plan results and plan writes',async () => {
  for (const options of [{stale:true},{planResult:'{"status":"sent"}'},{planWrites:true}]) {
    await assert.rejects(checkAuthoritySteps(authorityDouble(options),{},{engine:'codex'}));
  }
});
test('Core permission denial is reported separately from observed host refusal',async () => {
  const driver = authorityDouble({planResult:'SessionSend: only read-only tools are permitted in plan mode'});
  await checkAuthoritySteps(driver,{},{engine:'codex'});
  assert(driver.events.some(e => e[0] === 'plan-core-permission-denied' && e[1] === 'PASS'));
  assert(driver.events.some(e => e[0] === 'plan-host-refused-not-reached' && e[1] === 'SKIP'));
  assert(!driver.events.some(e => e[0] === 'plan-refused'));
});

test('fixture commands tolerate host plan/orchestrate reminders without bypassing them',() => {
  const command = {tool:'SessionSend',input:{payload:'line\nvalue'}};
  for (const tag of ['plan-reminder','orchestrate-reminder']) {
    assert.deepEqual(parsePeerCommand({role:'user',content:`peer-command:${JSON.stringify(command)}\n<${tag}>host reminder</${tag}>`}),command);
  }
  assert.equal(parsePeerCommand({role:'tool',content:'peer-command:{}'}),null);
  assert.throws(() => parsePeerCommand({role:'user',content:'peer-command:malformed'}));
});

const acceptance = await import(process.env.PEER_JUDGEMENT_MODULE ?? './session-peers-smoke.mjs');
const card = text => ({id:'one',text:`${text} delivery-proof`,links:['Peer']});
const replyObservation = kind => ({
  requests:[{incoming:{messageId:'reply',replyTo:'original',sender:'session:b',recipientSessionId:'a',kind:kind === 'automatic' ? 'task_result' : 'agent_message',payload:'reply-proof'}}],
  completedAt:0,received:{messageId:'original',sender:'session:a',recipientSessionId:'b',payload:'trigger'},nonce:'reply-proof',kind,
  outgoing:[{id:'reply',text:'Outgoing reply-proof',links:['A']}],incoming:[{id:'reply',text:'Incoming reply-proof',links:['B']}],
});
const observationCases = [
  ...['explicit','automatic'].map(kind => ['judgeCoreReply',replyObservation(kind),{...replyObservation(kind),completedAt:1}]),
  ['judgeCards',{nonce:'delivery-proof',outgoing:[card('Outgoing')],incoming:[card('Incoming')]},{nonce:'delivery-proof',outgoing:[card('Outgoing')],incoming:[{text:'Incoming',links:[]}]}],
  ['judgeForgery',{before:[],after:[],bodySeen:true},{before:[],after:[card('forged')],bodySeen:true}],
  ['judgeSockets',{records:'p12\nn127.0.0.1:4000\nn*:4001',pids:[12],allowed:[4000,4001]},{records:'p12\nn127.0.0.1:4000\nn*:9999',pids:[12],allowed:[4000,4001]}],
  ['judgeRevoked',{result:'{"status":"refused"}',before:1,after:1},{result:'{"status":"refused"}',before:1,after:2}],
  ['judgeCatalogue',{names:['SessionsList','WhoEdits','SessionSend','SessionOpen'],enabled:true},{names:['SessionsList'],enabled:true}],
  ['judgeReply',{before:0,requests:[{input:'new-reply'}],nonce:'new-reply',originCompleted:true},{before:1,requests:[{input:'new-reply'}],nonce:'new-reply',originCompleted:true}],
  ['judgeFileEvidence',{written:{status:'file_activity',records:[{sessionId:'a',evidence:'reported_write',toolName:'Write'}]},untouched:{status:'file_activity',records:[],candidates:[],limitations:'unknown writers'},sessionId:'a'},{written:{status:'file_activity',records:[]},untouched:{status:'unknown'},sessionId:'a'}],
];
for (const [name,good,bad] of observationCases) test(`${name}: real observations required`,() => {
  acceptance[name](good);
  assert.throws(() => acceptance[name](bad));
});
test('negative acceptance boundaries',() => {
  assert.throws(() => acceptance.judgeCards({nonce:'delivery-proof',outgoing:[card('Outgoing')],incoming:[{...card('Incoming'),id:'other'}]}));
  assert.throws(() => acceptance.judgeForgery({before:[],after:[],bodySeen:false}));
  assert.throws(() => acceptance.judgeRevoked({result:'{"status":"refused","reason":"loop_limited"}',before:1,after:1}));
  assert.throws(() => acceptance.judgeReply({before:0,requests:[{input:'new-reply'}],nonce:'new-reply',originCompleted:false}));
  acceptance.judgeCatalogue({names:[],enabled:false});
  assert.throws(() => acceptance.judgeCatalogue({names:['SessionSend'],enabled:false}));
});
test('loop refusal cannot prove plan authority',async () => {
  await assert.rejects(checkAuthoritySteps(authorityDouble({planResult:'{"status":"refused","reason":"loop_limited"}'}),{},{engine:'codex'}));
});
// A no-op mutation of EACH judgement must make this test file red.
if (!process.env.PEER_JUDGEMENT_MODULE) test('each judgement mutation is red',() => {
  const source = readFileSync(new URL('./session-peers-smoke.mjs',import.meta.url),'utf8');
  const mutant = new URL(`./.peer-judgement-mutant-${process.pid}.mjs`,import.meta.url);
  try {
    for (const [name] of observationCases) {
      const changed = source.replace(new RegExp(`(export function ${name}\\([^\\n]+\\) \\{)`),'$1 return;');
      assert.notEqual(changed,source);
      writeFileSync(mutant,changed);
      const childEnv = {...process.env,PEER_JUDGEMENT_MODULE:mutant.href}; delete childEnv.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath,['--test',new URL(import.meta.url).pathname],{env:childEnv,encoding:'utf8'});
      assert.equal(child.status,1,`${name} mutant survived`);
      assert.match(child.stdout,new RegExp(`not ok .*${name}: real observations required`));
    }
  } finally { rmSync(mutant,{force:true}); }
});

test('reply judgements reject history nonce, wrong correlation/kind, duplicates and missing cards',() => {
  for (const kind of ['explicit','automatic']) {
    const good = replyObservation(kind);
    for (const change of [
      {requests:[{messages:[{content:'reply-proof'}]}]},
      {requests:[{incoming:{...good.requests[0].incoming,replyTo:'other'}}]},
      {requests:[{incoming:{...good.requests[0].incoming,kind:'wrong'}}]},
      {requests:[{incoming:{...good.requests[0].incoming,sender:'session:c'}}]},
      {requests:[{incoming:{...good.requests[0].incoming,recipientSessionId:'c'}}]},
      {requests:[...good.requests,...good.requests]}, {completedAt:undefined},
      {received:{messageId:'original',replyTo:'previous'}}, {incoming:[]},
    ]) assert.throws(() => acceptance.judgeCoreReply({...good,...change}));
  }
});

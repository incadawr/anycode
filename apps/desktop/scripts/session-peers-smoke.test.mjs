import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inside, peerEnv, judgeDelivery } from './session-peers-smoke.mjs';
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

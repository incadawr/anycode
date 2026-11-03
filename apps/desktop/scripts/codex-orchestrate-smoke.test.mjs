import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = join(dirname(fileURLToPath(import.meta.url)), 'codex-orchestrate-smoke.mjs');

test('live requires explicit opt-in before accepting any paths', () => {
  const env = { ...process.env, ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE: '' };
  const result = spawnSync(process.execPath, [script, '--live'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE=1/);
});

test('fixture mode runs without a model or live opt-in', () => {
  const env = { ...process.env, ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE: '' };
  const result = spawnSync(process.execPath, [script, '--fixture-only'], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'PASS');
  assert.equal(report.live, 'SKIP');
  assert.equal(report.ui, 'SKIP');
});

test('only structured tool events count as attempted writes', async () => {
  const { attempted, correlatedEvidence, turnDiagnostics } = await import('./codex-orchestrate-live-probe.mjs');
  const path = '/tmp/sentinel';
  const event = (type, content) => ({ method: 'item/completed', params: { item: { type, ...content } } });
  assert.equal(attempted([event('agentMessage', { text: `cannot execute a command ${path}` })], 'workspace-command', path), false);
  assert.equal(attempted([event('commandExecution', { command: `touch ${path}` })], 'workspace-command', path), true);
  assert.equal(attempted([event('fileChange', { changes: [{ path }] })], 'patch', path), true);
  assert.equal(attempted([event('commandExecution', { command: `touch ${path}` })], 'patch', path), false);
  const correlated = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution', command: `touch ${path}` } } };
  assert.equal(correlatedEvidence(correlated, 'thread', 'turn'), true);
  assert.equal(correlatedEvidence(correlated, 'thread', 'other'), false);
  assert.equal(correlatedEvidence(correlated, 'other', 'turn'), false);
  assert.deepEqual(turnDiagnostics({ status: 'failed', messages: ['cannot read /private/secret'], evidence: [event('commandExecution', {})] }), { turnStatus: 'failed', modelExcerpt: 'cannot read [path]', itemEvents: { commandExecution: 1 } });
});

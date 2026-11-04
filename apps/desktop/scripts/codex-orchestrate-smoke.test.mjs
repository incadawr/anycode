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

test('nested seatbelt preflight gates sandbox checks and detects exit 71', async () => {
  const { nestedSeatbeltAvailable, runSandboxChecks, smokeOutcome } = await import('./codex-orchestrate-live-probe.mjs');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  assert.equal(nestedSeatbeltAvailable((bin, args) => {
    assert.equal(bin, '/usr/bin/sandbox-exec');
    assert.deepEqual(args, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    return { status: 0 };
  }), true);
  assert.equal(nestedSeatbeltAvailable(() => ({ status: 71, stderr: 'Operation not permitted' })), false);
  assert.equal(nestedSeatbeltAvailable(() => ({ status: 0, stderr: 'Operation not permitted' })), false);
  const root = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const checks = {};
    let calls = 0;
    await runSandboxChecks({ available: false, checks, cwd: root, root, turn: () => { throw Error('must not run'); } });
    assert.equal(Object.keys(checks).length, 6);
    assert.ok(Object.values(checks).every(c => c.status === 'SKIP' && c.note === 'nested seatbelt unavailable in this environment: negative checks are not evidence'));
    assert.equal(smokeOutcome(false, checks), 'incomplete');
    const event = (path, exitCode) => ({ method: 'item/completed', params: { item: { type: 'commandExecution', command: `touch ${path}`, exitCode } } });
    const live = {};
    await runSandboxChecks({ available: true, checks: live, cwd: root, root, turn: async text => {
      calls++;
      if (calls === 1) return { status: 'completed', messages: ['READ_FIXTURE_OK'], evidence: [event('read-fixture.txt', 0)] };
      if (calls === 2) { writeFileSync(join(root, 'sentinel-patch'), 'x'); return { status: 'completed', messages: [], evidence: [] }; }
      if (calls === 3) return { status: 'completed', messages: ['exit code 71'], evidence: [event(join(root, 'sentinel-command'), 71)] };
      return { status: 'completed', messages: [], evidence: [event(join(root, 'sentinel-tmp'), 1)] };
    } });
    assert.equal(calls, 6);
    assert.equal(live.read.status, 'PASS');
    assert.equal(live.patch.status, 'FAIL');
    assert.equal(smokeOutcome(true, live), 'failed');
    assert.equal(live['workspace-command'].status, 'SKIP');
    assert.equal(live['tmp-command'].status, 'PASS');
    const failedRead = {};
    await runSandboxChecks({ available: true, checks: failedRead, cwd: root, root, turn: async () => ({ status: 'completed', messages: ['wrong'], evidence: [event('read-fixture.txt', 0)] }) });
    assert.equal(failedRead.read.status, 'FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

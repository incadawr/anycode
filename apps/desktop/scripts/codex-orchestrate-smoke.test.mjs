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

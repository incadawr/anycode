import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, formatTable } from './reasoning-replay-live-matrix.mjs';
test('redacts credentials and omits reasoning payload tails', () => {
  assert.equal(redact('secret sk-cp-abc Bearer xyz', ['secret']), '[redacted] [redacted] Bearer [redacted]');
  assert.equal(redact('400 thinking: private text'), '400 [reasoning omitted]');
  assert.equal(redact('encrypted_content=opaque'), '[reasoning omitted]');
});
test('table fixes column order, retains zero counts and escapes markdown/newlines', () => {
  const table = formatTable([{ cell: 'A|B\nC', status: 'not-measured', inputOn: 0, reason: 'missing key' }]);
  assert.equal(table.split('\n').length, 3);
  assert.match(table, /A B C/);
  assert.match(table, /\| 0 \| — \| missing key \|/);
  assert.ok(table.startsWith('| cell | model | host | status | http | retry | remembered |'));
});

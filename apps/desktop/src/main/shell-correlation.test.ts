import { expect, it } from 'vitest';
import { createShellCorrelation } from './shell-correlation.js';
import type { WorkspaceFileSample } from './workspace-file-observer.js';

const identity = { sessionId: 'a', generation: 1, workspaceKey: '/workspace' };
const sample = (at: number, extra: Partial<WorkspaceFileSample> = {}): WorkspaceFileSample => ({
  at, startsAt: 0, baseline: false, coverage: 'complete', baselineCoverage: 'complete', entries: 1,
  changes: [{ path: 'file', kind: 'modified' }], ...extra,
});
it('consumes intermediate samples and retains every overlapping finished window across late baseline', () => {
  let at = 0;
  const rows: unknown[] = [];
  const value = createShellCorrelation(() => at, (...args) => rows.push(args));
  at = 2; value.start('a', identity);
  at = 3; value.start('b', { ...identity, sessionId: 'b' });
  at = 4; value.end('a');
  at = 5; value.end('b');
  at = 6; value.consume(sample(6, { baseline: true, changes: [] }), 0);
  at = 9; value.consume(sample(9), 7);
  expect(rows).toEqual([
    [identity, 'file', { start: 0, end: 9 }],
    [{ ...identity, sessionId: 'b' }, 'file', { start: 0, end: 9 }],
  ]);
  at = 10; value.start('c', identity); value.end('c');
  at = 12; value.consume(sample(12), 11);
  expect(rows).toHaveLength(3); // prior sample consumed before replacement
  expect(rows[2]).toEqual([identity, 'file', { start: 7, end: 12 }]);
});
it('keeps the old lower bound across partial baselines and ignores frozen/stale samples', () => {
  let at = 0;
  const rows: unknown[] = [];
  const value = createShellCorrelation(() => at, (...args) => rows.push(args));
  value.consume(sample(0, { baseline: true, changes: [] }), 0);
  at = 1; value.start('a', identity); value.end('a');
  at = 3;
  const partial = sample(3, { coverage: 'partial', baselineCoverage: 'partial', changes: [] });
  value.consume(partial, 2);
  at = 8; value.consume(partial, 7);
  value.consume(sample(8, { baselineCoverage: 'partial' }), 7);
  expect(rows).toEqual([[identity, 'file', { start: 0, end: 8 }]]);
  at = 3000; value.consume(sample(9), 8);
  expect(rows).toHaveLength(1);
  value.forget('a');
  value.consume(sample(3000), 2999);
  expect(rows).toHaveLength(1);
});
it('bounds history by capacity and TTL', () => {
  let at = 0, count = 0;
  const value = createShellCorrelation(() => at, () => count++);
  value.consume(sample(0, { baseline: true, changes: [] }), 0);
  for (let i = 0; i < 600; i++) { value.start(String(i), identity); value.end(String(i)); }
  value.consume(sample(0), 0);
  expect(count).toBe(512);
  at = 30 * 60_000;
  value.consume(sample(at), 0);
  expect(count).toBe(512);
});

it('retains finished intervals when a shell id is reused before sampling', () => {
  let at = 0;
  const rows: unknown[] = [];
  const value = createShellCorrelation(() => at, (...args) => rows.push(args));
  value.consume(sample(0, { baseline: true, changes: [] }), 0);
  value.start('same', identity); value.end('same');
  at = 2; value.start('same', { ...identity, sessionId: 'b' }); value.end('same');
  value.consume(sample(2), 1);
  expect(rows).toHaveLength(2);
});

it('never emits a new candidate from frozen or stale complete samples', () => {
  let at = 0;
  const rows: unknown[] = [];
  const value = createShellCorrelation(() => at, (...args) => rows.push(args));
  value.start('live', identity);
  value.consume(sample(0, { baseline: true, changes: [] }), 0);
  const complete = sample(1);
  at = 1; value.consume(complete, 1);
  expect(rows).toEqual([[identity, 'file', { start: 0, end: 1 }]]);
  at = 2; value.consume(complete, 2);
  expect(rows).toHaveLength(1); // identical frozen metadata is no new observation
  at = 3002; value.consume(sample(2), 2);
  expect(rows).toHaveLength(1); // complete coverage does not make stale data evidence
});
it('bounds a build burst even with hundreds of overlapping shell windows', () => {
  let count = 0;
  const value = createShellCorrelation(() => 0, () => count++);
  for (let i = 0; i < 512; i++) value.start(String(i), identity);
  value.consume(sample(0, { changes: Array.from({ length: 4800 }, (_, i) => ({ path: `file${i}`, kind: 'modified' as const })) }), 0);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(512);
});

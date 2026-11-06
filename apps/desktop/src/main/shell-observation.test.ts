import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileActivityIngress } from './file-activity-ingress.js';
import type { PeerHost } from './session-peers.js';

it('samples activation and real nonzero shell writes without waiting on observation', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'shell-observation-')));
  const proc = {};
  let host: PeerHost | undefined = { tabId: 't', sessionId: 's', proc, generation: 1,
    workspace, workspaceKey: workspace, live: true, root: true, restricted: false,
    readOnly: false, engine: 'core', activity: 'idle' };
  const ingress = createFileActivityIngress(true, () => host)!;
  const wire = (phase: string) => ({ type: 'shell_activity', generation: 1, phase, toolCallId: 'a' });
  try {
    ingress.sync('t');
    await vi.waitFor(() => expect(ingress.observation(workspace)?.sample?.baseline).toBe(true));
    expect(ingress.accept('t', {}, wire('start'))).toBe(false);
    expect(ingress.accept('t', proc, { ...wire('start'), generation: 0 })).toBe(false);
    for (const field of ['command', 'argv', 'content', 'sessionId', 'evidence', 'workspaceKey']) {
      expect(ingress.accept('t', proc, { ...wire('start'), [field]: 'forged' })).toBe(false);
    }
    expect(ingress.accept('t', proc, wire('end'))).toBe(false);
    expect(ingress.accept('t', proc, wire('start'))).toBe(true);
    await vi.waitFor(() => expect(ingress.observation(workspace)?.sample?.baseline).toBe(false));
    try { execFileSync('/bin/sh', ['-c', 'printf data > "$1"; exit 7', 'sh', join(workspace, 'binary')]); } catch { /* writer exits nonzero */ }
    expect(ingress.accept('t', proc, wire('end'))).toBe(true);
    await vi.waitFor(() => expect(ingress.observation(workspace)?.sample?.changes).toContainEqual({ path: 'binary', kind: 'created' }));
    expect(ingress.index.lookup(workspace, 'binary')).toEqual([]); // observation never proves authorship
    host = { ...host!, generation: 2 };
    ingress.sync('t');
    expect(ingress.accept('t', proc, wire('start'))).toBe(false);
    host = undefined;
    ingress.sync('t');
    expect(ingress.observation(workspace)).toBeUndefined();
  } finally { ingress.dispose(); rmSync(workspace, { recursive: true, force: true }); }
});

it('shares one observer, coalesces refreshes, and drops late results on generation teardown', async () => {
  const { createShellObservation } = await import('./shell-observation.js');
  const sample = { coverage: 'partial' as const, baselineCoverage: 'unknown' as const,
    startsAt: 0, at: 0, entries: 0, baseline: true, changes: [] };
  let resolve!: (value: typeof sample) => void;
  const refresh = vi.fn(() => new Promise<typeof sample>(done => { resolve = done; }));
  const dispose = vi.fn();
  const observer = vi.fn(() => ({ refresh, dispose }));
  let at = 0;
  const observation = createShellObservation({ observer, now: () => at });
  const identity = { sessionId: 's', generation: 1, workspaceKey: '/workspace' };
  observation.sync('a', identity);
  observation.sync('b', { ...identity, sessionId: 'other' });
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observation.accept('a', 'shell', 'start')).toBe(true);
  expect(observation.accept('b', 'shell', 'start')).toBe(true);
  expect(observation.accept('a', 'shell', 'start')).toBe(false);
  expect(observation.accept('a', 'shell', 'end')).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1); // shell ingress never awaits the baseline
  resolve(sample);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  at = 3000;
  expect(observation.observation('/workspace')).toMatchObject({ freshness: 'stale',
    sample: { coverage: 'partial', baselineCoverage: 'unknown' } });
  observation.sync('a');
  expect(dispose).not.toHaveBeenCalled();
  observation.sync('b');
  expect(dispose).toHaveBeenCalledTimes(1);
  resolve(sample);
  await Promise.resolve();
  expect(observation.observation('/workspace')).toBeUndefined();
  observation.sync('a', { ...identity, generation: 2 });
  expect(observer).toHaveBeenCalledTimes(2);
  observation.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
});

it('labels a frozen deadline sample stale without retrying hung native IO', async () => {
  const { createShellObservation } = await import('./shell-observation.js');
  const { createWorkspaceFileObserver } = await import('./workspace-file-observer.js');
  let at = 0;
  const lstat = vi.fn(() => new Promise<never>(() => {}));
  const observation = createShellObservation({ now: () => at,
    observer: deps => createWorkspaceFileObserver({ ...deps, deadlineMs: 1,
      fs: { lstat, realpath: vi.fn(), opendir: vi.fn() } }) });
  observation.sync('a', { sessionId: 's', generation: 1, workspaceKey: '/workspace' });
  await vi.waitFor(() => expect(observation.observation('/workspace')?.sample?.reason).toBe('deadline'));
  at = 3001;
  observation.accept('a', 'shell', 'start');
  await Promise.resolve();
  expect(lstat).toHaveBeenCalledTimes(1);
  expect(observation.observation('/workspace')).toMatchObject({ freshness: 'stale',
    sample: { coverage: 'partial', baselineCoverage: 'unknown' } });
  observation.dispose();
});

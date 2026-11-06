import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileActivityIndex } from './file-activity-index.js';
import { createFileActivityIngress } from './file-activity-ingress.js';
import { createSessionPeersHandler, type PeerHost } from './session-peers.js';
import { createFileActivityTaps } from '../host/file-activity.js';
import type { AgentEvent } from '@anycode/core';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(clean => clean()));
function fixture(enabled = true) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'peer-files-')));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const hosts: PeerHost[] = ['a', 'b'].map(id => ({ tabId: id, sessionId: id, proc: {}, generation: 1,
    workspace, workspaceKey: workspace, live: true, root: true, restricted: false,
    readOnly: true, engine: 'core', activity: 'idle' }));
  const current = (id: string) => hosts.find(host => host.tabId === id);
  const ingress = createFileActivityIngress(enabled, current);
  if (ingress) cleanups.push(() => ingress.dispose());
  const handler = createSessionPeersHandler({ current, targets: () => hosts,
    access: { canAccess: () => true }, prepare: async () => {}, files: ingress?.index });
  const query = (path = 'file', extra = {}) => handler('a', hosts[0]!.proc!, {
    requestId: 'query', operation: 'who_edits', input: { path, ...extra } });
  const record = (id: string, path = 'file') => ingress!.accept(id, current(id)!.proc!, {
    type: 'file_activity', generation: current(id)!.generation,
    report: { filePath: path, toolName: 'Write', toolCallId: path } });
  return { hosts, files: ingress?.index, ingress, handler, query, record, workspace };
}
it('answers exact queries with both reported writers and no private metadata', async () => {
  const f = fixture();
  f.record('a'); f.record('b'); f.record('b', 'other');
  const answer = await f.query();
  expect(answer).toMatchObject({ status: 'file_activity', path: 'file', coverage: 'partial',
    records: [{ sessionId: 'a', evidence: 'reported_write', toolName: 'Write' },
      { sessionId: 'b', evidence: 'reported_write', toolName: 'Write' }] });
  expect(JSON.stringify(answer)).not.toMatch(/"(?:canonicalPath|workspaceKey|generation|toolCallId|proc)":/);
  expect(await f.query('other')).toMatchObject({ records: [{ sessionId: 'b' }] });
});
it('refuses outside, excluded, directory and malformed paths and forged evidence', async () => {
  const f = fixture();
  for (const path of ['../outside', '.git/config', '.', 'bad\0path']) {
    expect(await f.query(path)).toEqual({ status: 'refused' });
  }
  expect(await f.query('file', { evidence: 'reported_write', sessionId: 'b' })).toBeNull();
});
it('empty answers explicitly explain unknown coverage and unsupported writers', async () => {
  const f = fixture();
  const answer = await f.query();
  expect(answer).toMatchObject({ status: 'file_activity', records: [], coverage: 'partial', startsAt: expect.any(Number) });
  const text = JSON.stringify(answer);
  for (const term of ['MultiEdit', 'shell', 'binary', 'background', 'unknown', 'baseline', 'dedup', 'pending', 'claude/codex peers emit no shell windows or reported writes', 'core host only']) {
    expect(text).toContain(term);
  }
  expect(text).toContain('does not mean nobody');
});
it('lists only five recent paths and drops closed and previous generation records', async () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.record('b', `path${i}`);
  const list = () => f.handler('a', f.hosts[0]!.proc!, { requestId: 'list', operation: 'list', input: {} });
  expect(await list()).toMatchObject({ sessions: [{ sessionId: 'a', recentPaths: [] },
    { sessionId: 'b', recentPaths: ['path6', 'path5', 'path4', 'path3', 'path2'] }] });
  f.hosts[1]!.generation++;
  expect(await list()).toMatchObject({ sessions: [{ recentPaths: [] }, { recentPaths: [] }] });
  f.record('b'); f.hosts[1]!.live = false;
  expect(await f.query()).toMatchObject({ records: [] });
});
it('does not expose paths from grant-visible foreign workspaces', async () => {
  const f = fixture();
  f.record('b');
  f.hosts[0]!.workspaceKey = f.hosts[0]!.workspace = '/foreign';
  const answer = await f.handler('a', f.hosts[0]!.proc!, { requestId: 'list', operation: 'list', input: { scope: 'granted' } });
  expect(answer?.status).toBe('ok');
  if (answer?.status === 'ok') expect(answer.sessions[1]).not.toHaveProperty('recentPaths');
});
it('flag off has no index, queries remain unavailable and list shape stays unchanged', async () => {
  const f = fixture(false);
  expect(f.files).toBeUndefined();
  expect(await f.query()).toEqual({ status: 'unavailable' });
  const list = await f.handler('a', f.hosts[0]!.proc!, { requestId: 'list', operation: 'list', input: {} });
  expect(JSON.stringify(list)).not.toContain('recentPaths');
  expect(f.ingress).toBeUndefined();
  expect(list).toEqual({ status: 'ok', sessions: ['a', 'b'].map(id => ({
    sessionId: id, tabId: id, workspace: f.workspace, engine: 'core', activity: 'idle', addressable: true,
  })) });
});
it('collector losses and unsupported MultiEdit cannot become an assertion of no writers', async () => {
  const f = fixture();
  const taps = createFileActivityTaps(true, 1, wire => f.ingress!.accept('b', f.hosts[1]!.proc!, wire))!;
  const call = (name: string, id = 'reused') => ({ type: 'tool_call', toolCall: {
    id, name, input: { file_path: 'file' },
  } }) as AgentEvent;
  const result = (name: string, status: string, id = 'reused') => ({ type: 'tool_result', outcome: {
    toolCallId: id, toolName: name, status,
  } }) as AgentEvent;
  taps.observe(call('Write')); taps.observe(result('Write', 'error'));
  taps.observe(call('Write')); taps.observe(result('Write', 'success'));
  taps.observe(call('MultiEdit', 'multi')); taps.observe(result('MultiEdit', 'success', 'multi'));
  taps.observe(call('Write', 'interrupted'));
  taps.observe({ type: 'loop_end', reason: 'cancelled' } as AgentEvent);
  taps.observe(result('Write', 'success', 'interrupted'));
  expect(await f.query()).toMatchObject({ records: [], coverage: 'partial', limitations: expect.stringContaining('does not mean nobody') });
});

it('projects both overlapping nonzero shell candidates and keeps reported evidence separate', async () => {
  const f = fixture();
  const batches = vi.spyOn(f.files!, 'batch');
  const wire = (id: string, phase: string) => f.ingress!.accept(id, f.hosts.find(h => h.tabId === id)!.proc!, {
    type: 'shell_activity', generation: 1, phase, toolCallId: 'shell',
  });
  f.ingress!.sync('a'); f.ingress!.sync('b');
  await vi.waitFor(() => expect(f.ingress!.observation(f.workspace)?.sample?.baseline).toBe(true));
  wire('a', 'start'); wire('b', 'start');
  await vi.waitFor(() => expect(f.ingress!.observation(f.workspace)?.sample?.baseline).toBe(false));
  try { execFileSync('/bin/sh', ['-c', 'printf data > "$1"; exit 7', 'sh', join(f.workspace, 'file')]); } catch { /* nonzero writer */ }
  wire('a', 'end'); wire('b', 'end');
  await vi.waitFor(() => expect(f.files!.lookup(f.workspace, 'file')).toHaveLength(2));
  expect(batches).toHaveBeenCalled();
  f.record('a');
  expect(await f.query()).toMatchObject({ records: [{ sessionId: 'a', evidence: 'reported_write' }],
    candidates: [{ sessionId: 'a', evidence: 'observed_during_shell', confidence: 'candidate' },
      { sessionId: 'b', evidence: 'observed_during_shell', confidence: 'candidate' }] });
  const taps = createFileActivityTaps(true, 1, raw => f.ingress!.accept('a', f.hosts[0]!.proc!, raw))!;
  taps.observe({ type: 'tool_call', toolCall: { id: 'spoof', name: 'Bash',
    input: { evidence: 'reported_write', sessionId: 'b', file_path: 'forged' } } } as AgentEvent);
  expect(await f.query('forged')).toMatchObject({ records: [], candidates: [] });
  expect(await f.handler('a', f.hosts[0]!.proc!, { requestId: 'l', operation: 'list', input: {} }))
    .toMatchObject({ sessions: [{ recentPaths: ['file'] }, { recentPaths: ['file'] }] });
});

it('projects partial and stale baseline honestly and uses the index path options for queries', async () => {
  const f = fixture(false);
  let freshness: 'fresh' | 'stale' = 'fresh';
  const workspace = '/virtual';
  f.hosts[0]!.workspace = f.hosts[0]!.workspaceKey = workspace;
  const files = new FileActivityIndex({ current: () => ({ sessionId: 'a', workspaceKey: workspace, generation: 1 }),
    realpath: value => value, stat: value => ({ isDirectory: () => value === workspace, isFile: () => value !== workspace }),
    observation: () => ({ freshness, sample: { coverage: 'partial', baselineCoverage: 'unknown',
      at: 0, startsAt: 0, baseline: true, entries: 0, changes: [] } }) });
  const handler = createSessionPeersHandler({ current: () => f.hosts[0], targets: () => f.hosts,
    access: { canAccess: () => true }, prepare: async () => {}, files });
  const query = () => handler('a', f.hosts[0]!.proc!, { requestId: 'q', operation: 'who_edits', input: { path: 'file' } });
  expect(await query()).toMatchObject({ status: 'file_activity', records: [], candidates: [], coverage: 'partial',
    sampler: { coverage: 'partial', baselineCoverage: 'unknown', freshness: 'fresh' } });
  freshness = 'stale';
  expect(await query()).toMatchObject({ sampler: { freshness: 'stale' }, limitations: expect.stringContaining('does not mean nobody') });
});

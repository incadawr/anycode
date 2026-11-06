import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFileActivityIngress } from './file-activity-ingress.js';
import { createSessionPeersHandler, type PeerHost } from './session-peers.js';
import { createFileActivityTaps } from '../host/file-activity.js';
import type { AgentEvent } from '@anycode/core';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(clean => clean()));
function fixture(enabled = true) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'peer-files-')));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const hosts: PeerHost[] = ['a', 'b'].map(id => ({ tabId: id, sessionId: id, proc: {}, generation: 1,
    workspace, workspaceKey: workspace, live: true, root: true, restricted: false,
    readOnly: true, engine: 'core', activity: 'idle' }));
  const current = (id: string) => hosts.find(host => host.tabId === id);
  const ingress = createFileActivityIngress(enabled, current);
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
  for (const term of ['MultiEdit', 'shell', 'binary', 'background', 'unknown', 'baseline', 'dedup', 'pending']) {
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
  expect(await f.handler('a', f.hosts[0]!.proc!, {
    requestId: 'list', operation: 'list', input: { scope: 'granted' },
  })).toMatchObject({ sessions: [{ recentPaths: [] }, { recentPaths: [] }] });
});
it('flag off has no index, queries remain unavailable and list shape stays unchanged', async () => {
  const f = fixture(false);
  expect(f.files).toBeUndefined();
  expect(await f.query()).toEqual({ status: 'unavailable' });
  const list = await f.handler('a', f.hosts[0]!.proc!, { requestId: 'list', operation: 'list', input: {} });
  expect(JSON.stringify(list)).not.toContain('recentPaths');
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

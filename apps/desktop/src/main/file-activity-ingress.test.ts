import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFileActivityIngress } from './file-activity-ingress.js';
import type { PeerHost } from './session-peers.js';

it('authenticates proc/generation/workspace and rejects forged identity or payload', () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'file-ingress-')));
  const proc = {};
  let host: PeerHost = { tabId: 'tab', sessionId: 'containing', proc, generation: 1,
    workspace, workspaceKey: workspace, live: true, root: false, restricted: true,
    readOnly: true, engine: 'core', activity: 'idle' };
  const ingress = createFileActivityIngress(true, () => host)!;
  const wire = { type: 'file_activity', generation: 1, report: { filePath: 'new', toolCallId: '0:call', toolName: 'Write' } };
  try {
    expect(ingress.accept('tab', {}, wire)).toBe(false);
    expect(ingress.accept('tab', proc, { ...wire, generation: 0 })).toBe(false);
    for (const field of ['sessionId', 'workspaceKey', 'content', 'diff', 'command']) {
      expect(ingress.accept('tab', proc, { ...wire, [field]: 'FORGED' })).toBe(false);
      expect(ingress.accept('tab', proc, { ...wire, report: { ...wire.report, [field]: 'FORGED' } })).toBe(false);
    }
    expect(ingress.accept('tab', proc, { ...wire, report: { ...wire.report, filePath: '../escape' } })).toBe(false);
    expect(ingress.accept('tab', proc, wire)).toBe(true);
    expect(ingress.index.lookup(workspace, 'new')).toMatchObject([{ sessionId: 'containing', generation: 1 }]);
    expect(JSON.stringify(ingress.index.lookup(workspace, 'new'))).not.toMatch(/FORGED|content|diff|command/);
    host = { ...host, workspace: `${workspace}/relocated` };
    expect(ingress.accept('tab', proc, wire)).toBe(false);
    expect(ingress.index.lookup(workspace, 'new')).toEqual([]);
    host = { ...host, workspace, generation: 2 };
    expect(ingress.accept('tab', proc, wire)).toBe(false);
    host = { ...host, generation: 1, live: false };
    expect(ingress.accept('tab', proc, wire)).toBe(false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
it('does not instantiate an index or inspect hosts with flag off', () => {
  expect(createFileActivityIngress(false, () => { throw new Error('unreachable'); })).toBeUndefined();
});

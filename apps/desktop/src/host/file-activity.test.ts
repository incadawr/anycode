import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '@anycode/core';
import { createFileActivityTaps } from './file-activity.js';
import { TurnTranslator } from './engines/codex/event-translator.js';

const call = (id: string, name = 'Write', filePath = 'a', extra = {}) => ({
  type: 'tool_call', toolCall: { id, name, input: { file_path: filePath, notebook_path: filePath, content: 'CONTENT', diff: 'DIFF', command: 'COMMAND', ...extra } },
}) as AgentEvent;
const result = (id: string, status = 'success', name = 'Write') => ({
  type: 'tool_result', outcome: { toolCallId: id, toolName: name, status, modelText: 'CONTENT', durationMs: 0 },
}) as AgentEvent;
function fixture() {
  const send = vi.fn();
  const taps = createFileActivityTaps(true, 3, send)!;
  return { taps, send, pair: (id: string, name = 'Write') => { taps.observe(call(id, name)); taps.observe(result(id, 'success', name)); } };
}
it('reports successful pairs for all write tools using metadata only', () => {
  const f = fixture();
  ['Edit', 'Write', 'NotebookEdit'].forEach((name, i) => f.pair(String(i), name));
  expect(f.send.mock.calls.map(([wire]) => wire.report.toolName)).toEqual(['Edit', 'Write', 'NotebookEdit']);
  expect(f.send.mock.calls[0]![0]).toEqual({ type: 'file_activity', generation: 3, report: { filePath: 'a', toolName: 'Edit', toolCallId: '0:0' } });
  expect(JSON.stringify(f.send.mock.calls)).not.toMatch(/CONTENT|DIFF|COMMAND|sessionId|workspace/);
});
it('rejects failed, mismatched, unmatched and unsupported events', () => {
  const f = fixture();
  for (const status of ['refused', 'denied', 'error', 'cancelled']) {
    f.taps.observe(call(status)); f.taps.observe(result(status, status));
    f.taps.observe(result(status));
  }
  f.taps.observe(result('missing'));
  f.taps.observe(call('mismatch')); f.taps.observe(result('mismatch', 'success', 'Edit'));
  f.pair('read', 'Read');
  f.taps.observe(call('long', 'Write', 'x'.repeat(4097))); f.taps.observe(result('long'));
  expect(f.send).not.toHaveBeenCalled();
});
it('bounds pending and dedup and drops incomplete pairs at terminal boundaries', () => {
  const f = fixture();
  for (let i = 0; i < 257; i++) f.taps.observe(call(String(i)));
  f.taps.observe(result('0')); expect(f.send).not.toHaveBeenCalled();
  f.taps.observe(result('256')); f.pair('256'); expect(f.send).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 1025; i++) f.pair(`done${i}`);
  f.pair('done1024'); expect(f.send).toHaveBeenCalledTimes(1026);
  f.pair('done0'); expect(f.send).toHaveBeenCalledTimes(1027);
  f.taps.observe(call('terminal'));
  f.taps.observe({ type: 'loop_end', reason: 'cancelled' } as AgentEvent);
  f.taps.observe(result('terminal')); expect(f.send).toHaveBeenCalledTimes(1027);
});
it('isolates root and each inline namespace and composes telemetry', () => {
  const f = fixture();
  const telemetry = vi.fn();
  const a = f.taps.inline(telemetry), b = f.taps.inline();
  f.pair('same');
  for (const tap of [a, b]) { tap(call('same')); tap(result('same')); }
  expect(new Set(f.send.mock.calls.map(([wire]) => wire.report.toolCallId)).size).toBe(3);
  expect(telemetry).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls.every(([wire]) => !('sessionId' in wire))).toBe(true);
});
it('retains real Codex multi-file projections', () => {
  const f = fixture();
  const translator = new TurnTranslator({ threadId: 't', turnId: 'u', turn: 1 });
  for (const [method, item] of [
    ['item/started', { type: 'fileChange', id: 'fc', changes: [{ path: 'a', diff: 'DIFF' }, { path: 'b', diff: 'DIFF' }] }],
    ['item/completed', { type: 'fileChange', id: 'fc', status: 'completed' }],
  ] as const) {
    translator.onNotification({ method, params: { threadId: 't', turnId: 'u', item } }).forEach(f.taps.observe);
  }
  expect(f.send.mock.calls.map(([wire]) => wire.report.filePath)).toEqual(['a', 'b']);
});
it('has no observer or emissions when disabled', () => {
  const send = vi.fn();
  expect(createFileActivityTaps(false, 1, send)).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it('observes real Session events and isolates observer failures', async () => {
  const { createHarness, toolStep, finishStep } = await import('./test-harness.js');
  const f = fixture();
  const h = createHarness({
    mode: 'yolo',
    steps: [toolStep('write', 'Write', { file_path: '/workspace/a.txt', content: 'CONTENT' }), finishStep()],
    observeFileActivity: event => {
      f.taps.observe(event);
      throw new Error('observer failure');
    },
  });
  try {
    h.send({ type: 'ui_ready' });
    await h.waitFor(m => m.type === 'host_ready');
    h.send({ type: 'user_message', requestId: 'write', text: 'write' });
    await h.waitUntil(() => h.received.some(m => m.type === 'agent_event' && m.event.type === 'loop_end'));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![0].report.filePath).toBe('/workspace/a.txt');
  } finally { h.close(); }
});

it('emits bounded shell lifecycle metadata for execution including failed outcomes', () => {
  const f = fixture();
  const start = { type: 'tool_execution_start', toolName: 'Bash', toolCallId: 'shell', input: { command: 'SECRET' } } as AgentEvent;
  f.taps.observe(call('shell', 'Bash')); // proposed tool input is not execution
  expect(f.send).not.toHaveBeenCalled();
  f.taps.observe(start); f.taps.observe(start);
  f.taps.observe(result('shell', 'error', 'Bash'));
  expect(f.send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'shell_activity', generation: 3, phase: 'start', toolCallId: '0:shell' },
    { type: 'shell_activity', generation: 3, phase: 'end', toolCallId: '0:shell' },
  ]);
  expect(JSON.stringify(f.send.mock.calls)).not.toContain('SECRET');
  f.taps.observe(start);
  f.taps.observe({ type: 'loop_end', reason: 'cancelled' } as AgentEvent);
  expect(f.send.mock.calls.at(-1)![0].phase).toBe('end');
  const broken = createFileActivityTaps(true, 1, () => { throw new Error('transport'); })!;
  expect(() => broken.observe(start)).not.toThrow();
});

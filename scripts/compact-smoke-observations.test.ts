import { describe, expect, it, vi } from 'vitest';
// @ts-nocheck
import { userMessageTexts, noSlashBubble, waitForApprovedTool } from '../apps/desktop/scripts/compact-smoke-observations.mjs';

describe('compact smoke observations', () => {
  it('detects a rendered command body even when its bubble includes a label', () => {
    const doc = { querySelectorAll: () => [{ textContent: 'You 12:00 /compact ', querySelector: () => ({ textContent: '/compact ' }) }] };
    const messages = userMessageTexts(doc);
    expect(noSlashBubble({ userMessages: messages })).toBe(false);
  });

  it('waits for approval and a marker while the tool is running', async () => {
    const states = [
      { running: true, permissionOpen: false },
      { running: true, permissionOpen: true, permissionTool: 'Bash', permissionInput: 'touch compact-smoke-started; sleep 25' },
      { running: true, permissionOpen: false },
      { running: true, permissionOpen: false },
    ];
    let time = 0;
    const approve = vi.fn(async () => ({ ok: true }));
    const markerExists = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    await waitForApprovedTool({ readState: async () => states.shift(), approve, markerExists, sleep: async () => { time += 200; }, now: () => time, timeoutMs: 2000 });
    expect(approve).toHaveBeenCalledOnce();
    expect(markerExists).toHaveBeenCalledTimes(3);
  });

  it('fails when the approved tool never starts', async () => {
    let time = 0;
    await expect(waitForApprovedTool({ readState: async () => ({ running: true, permissionOpen: true, permissionTool: 'Bash', permissionInput: 'touch compact-smoke-started; sleep 25' }), approve: async () => ({ ok: true }), markerExists: () => false, sleep: async () => { time += 200; }, now: () => time, timeoutMs: 400 })).rejects.toThrow('did not visibly start');
  });
});

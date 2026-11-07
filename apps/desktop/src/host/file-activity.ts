import type { AgentEvent } from '@anycode/core';
import { reportedWriteSchema, type FileActivityMessage, type ReportedWrite } from '../shared/file-activity.js';

type Tap = (event: AgentEvent) => void;
export function createFileActivityTaps(enabled: boolean, generation: number, send: (message: FileActivityMessage) => void) {
  if (!enabled) return undefined;
  let namespace = 0;
  const collector = (): Tap => {
    const prefix = `${namespace++}:`;
    const pending = new Map<string, ReportedWrite>();
    const seen = new Set<string>();
    const shells = new Set<string>();
    const shell = (id: string, phase: 'start' | 'end') => {
      try { send({ type: 'shell_activity', generation, phase, toolCallId: prefix + id }); }
      catch { /* metadata transport must not interrupt the shell */ }
    };
    return event => {
      if (event.type === 'tool_execution_start' && event.toolName === 'Bash') {
        const id = event.toolCallId;
        if (!id || (prefix + id).length > 256 || id.includes('\0') || shells.has(id)) return;
        if (shells.size >= 256) { const oldest = shells.values().next().value!; shells.delete(oldest); shell(oldest, 'end'); }
        shells.add(id); shell(id, 'start');
      }
      if (event.type === 'tool_result' && shells.delete(event.outcome.toolCallId)) shell(event.outcome.toolCallId, 'end');
      if (event.type === 'loop_end') { for (const id of shells) shell(id, 'end'); shells.clear(); }
      if (event.type === 'loop_end') { pending.clear(); return; }
      if (event.type === 'tool_call') {
        const { id, name, input } = event.toolCall;
        if (seen.has(id) || pending.has(id) || !input || typeof input !== 'object') return;
        const args = input as Record<string, unknown>;
        const parsed = reportedWriteSchema.safeParse({ toolCallId: prefix + id, toolName: name,
          filePath: name === 'NotebookEdit' ? args.notebook_path : args.file_path });
        if (!parsed.success) return;
        if (pending.size >= 256) pending.delete(pending.keys().next().value!);
        pending.set(id, parsed.data);
      } else if (event.type === 'tool_result') {
        const { toolCallId, toolName, status } = event.outcome;
        const report = pending.get(toolCallId);
        pending.delete(toolCallId);
        if (!report || seen.has(toolCallId)) return;
        if (seen.size >= 1024) seen.delete(seen.values().next().value!);
        seen.add(toolCallId);
        if (status === 'success' && toolName === report.toolName) send({ type: 'file_activity', generation, report });
      }
    };
  };
  return {
    observe: collector(),
    inline(other?: Tap): Tap {
      const observe = collector();
      return event => {
        try { observe(event); } catch { /* observation cannot interrupt execution */ }
        other?.(event);
      };
    },
  };
}

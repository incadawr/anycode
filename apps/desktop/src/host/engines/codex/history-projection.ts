/**
 * Pure projection of a Codex `thread/read` result into core `HistoryItem[]`
 * (TASK.42, cut §2(e)/§3.6). AnyCode NEVER persists a Codex transcript itself
 * — the native thread is the single source of truth, and this function is the
 * ENTIRE hydration path: called once per host boot on the resume path (cut
 * §2(e), "гидрация ровно один раз на host-boot"), before any new turn, its
 * output feeding `Session({bootHistory})` exactly like core's own persisted-
 * history hydration (zero new wire — `WireHistoryItem`/`session_history` are
 * unchanged, cut §3.6).
 *
 * `CodexThreadRead` is a deliberately NARROW, duck-typed slice of the live
 * `thread/read`/`thread/resume` result (evidenced shape: W0 `resume-read.jsonl`
 * — `result.thread.turns[].items[]`) — only the fields this projection reads,
 * not the full generated schema; unknown/extra fields on a real response are
 * ignored, never rejected (fail-soft: a schema addition upstream must not
 * break resume hydration).
 *
 * Mapping rules (cut §3.6):
 *  - `userMessage`/`agentMessage` text projects verbatim into a user/assistant
 *    `ChatMessage`.
 *  - `commandExecution`/`fileChange` outcomes project into the EXISTING
 *    assistant `tool_call` + `tool` `tool_result` HistoryItem pair (the same
 *    Bash/Write vocabulary `event-translator.ts`'s live `projectTool` uses —
 *    kept independent here since this module runs cold, over persisted turns,
 *    not a live notification stream).
 *  - Every other item type (e.g. `reasoning`) has no HistoryItem counterpart
 *    in core's `ChatMessage` union — it degrades to a deterministic formatted
 *    text block (cut §3.6, "допустимая деградация, фиксируется в тесте
 *    голдом") rather than being silently dropped.
 *  - The result is capped to the last `maxItems` (200 in production, cut
 *    §2(e)); when truncated, a single leading marker item is prepended.
 */

import type { ChatMessage, HistoryItem, ToolCallStatus } from "@anycode/core";

/**
 * One native turn item, duck-typed and structurally flat (mirrors
 * event-translator.ts's `record()`/manual-field-check convention for this
 * same external-JSON boundary, rather than a strict discriminated union —
 * `type` is a plain `string` because an unknown/future native item type must
 * degrade gracefully, not fail to compile). Every field beyond `type`/`id` is
 * specific to one native item `type` and simply absent on every other kind.
 */
export interface CodexThreadReadItem {
  type: string;
  id: string;
  /** `userMessage` only. */
  content?: Array<{ type: string; text?: string }> | null;
  /** `agentMessage` only. */
  text?: string | null;
  /** `commandExecution` only. */
  command?: string | null;
  /** `commandExecution` only. */
  cwd?: string | null;
  /** `commandExecution` | `fileChange`. */
  status?: string | null;
  /** `commandExecution` | `fileChange`. */
  aggregatedOutput?: string | null;
  /** `fileChange` only. */
  changes?: Array<{ path?: string | null; diff?: string | null }> | null;
}

export interface CodexThreadReadTurn {
  id: string;
  items?: CodexThreadReadItem[] | null;
  /** Unix EPOCH SECONDS (W0-evidenced field name/unit — NOT milliseconds); used as every item's best-effort createdAt anchor. */
  startedAt?: number | null;
}

/** Narrow, duck-typed slice of the live `thread/read`/`thread/resume` result (W0 `resume-read.jsonl`). */
export interface CodexThreadRead {
  thread: {
    id: string;
    turns?: CodexThreadReadTurn[] | null;
  };
}

export interface ProjectCodexHistoryOptions {
  maxItems: number;
}

const TRUNCATION_MARKER_TEXT = "… earlier history truncated (native thread retains full history)";

function textOf(item: CodexThreadReadItem): string {
  const parts = item.content ?? [];
  return parts
    .filter((part): part is { type: string; text: string } => typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function statusFor(itemStatus: string | null | undefined): ToolCallStatus {
  if (itemStatus === "completed") return "success";
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  return "error";
}

function toolPair(
  idPrefix: string,
  createdAt: number,
  toolCallId: string,
  toolName: "Bash" | "Write",
  input: unknown,
  status: ToolCallStatus,
  modelText: string,
): HistoryItem[] {
  const assistant: HistoryItem = {
    id: `${idPrefix}:call`,
    createdAt,
    message: { role: "assistant", content: [{ type: "tool_call", toolCallId, toolName, input }] },
  };
  const result: HistoryItem = {
    id: `${idPrefix}:result`,
    createdAt: createdAt + 1,
    message: { role: "tool", content: [{ type: "tool_result", toolCallId, toolName, text: modelText, status }] },
  };
  return [assistant, result];
}

function projectCommandExecution(
  turnId: string,
  item: CodexThreadReadItem,
  createdAt: number,
): HistoryItem[] {
  if (typeof item.command !== "string") return [projectFallback(turnId, item, createdAt)];
  const input = { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) };
  const status = statusFor(item.status);
  const modelText = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  return toolPair(`${turnId}:${item.id}`, createdAt, item.id, "Bash", input, status, modelText);
}

/** Multi-file change: projects EVERY changed file as its own tool_call/tool_result pair (not just the first). */
function projectFileChange(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem[] {
  const changes = (item.changes ?? []).filter(
    (change): change is { path: string; diff?: string | null } => typeof change.path === "string",
  );
  if (changes.length === 0) return [projectFallback(turnId, item, createdAt)];
  const status = statusFor(item.status);
  const modelText = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  return changes.flatMap((change, index) => {
    const input = { file_path: change.path, ...(typeof change.diff === "string" ? { content: change.diff } : {}) };
    return toolPair(`${turnId}:${item.id}:${index}`, createdAt, `${item.id}:${index}`, "Write", input, status, modelText);
  });
}

function projectFallback(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem {
  const message: ChatMessage = {
    role: "assistant",
    content: [{ type: "text", text: `[Codex ${item.type} item — not represented in AnyCode's transcript format]` }],
  };
  return { id: `${turnId}:${item.id}:fallback`, createdAt, message };
}

function projectItem(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem[] {
  switch (item.type) {
    case "userMessage": {
      const text = textOf(item);
      return [{ id: `${turnId}:${item.id}`, createdAt, message: { role: "user", content: text } }];
    }
    case "agentMessage": {
      const text = typeof item.text === "string" ? item.text : "";
      return [
        {
          id: `${turnId}:${item.id}`,
          createdAt,
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      ];
    }
    case "commandExecution":
      return projectCommandExecution(turnId, item, createdAt);
    case "fileChange":
      return projectFileChange(turnId, item, createdAt);
    default:
      return [projectFallback(turnId, item, createdAt)];
  }
}

/**
 * Pure function: `thread/read` result -> capped `HistoryItem[]` (cut §3.6).
 * Deterministic given the same input — no I/O, no clock reads (every
 * `createdAt` is derived from the turn's own `startedAt`).
 */
export function projectCodexHistory(thread: CodexThreadRead, opts: ProjectCodexHistoryOptions): HistoryItem[] {
  const turns = thread.thread.turns ?? [];
  const items: HistoryItem[] = [];
  for (const turn of turns) {
    const turnStartedAtMs = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : 0;
    let cursor = turnStartedAtMs;
    for (const item of turn.items ?? []) {
      const projected = projectItem(turn.id, item, cursor);
      items.push(...projected);
      cursor += projected.length;
    }
  }
  if (items.length <= opts.maxItems) return items;
  const kept = items.slice(items.length - opts.maxItems);
  const marker: HistoryItem = {
    id: `${thread.thread.id}:truncation-marker`,
    createdAt: (kept[0]?.createdAt ?? 0) - 1,
    kind: "compact_summary",
    message: { role: "assistant", content: [{ type: "text", text: TRUNCATION_MARKER_TEXT }] },
  };
  return [marker, ...kept];
}

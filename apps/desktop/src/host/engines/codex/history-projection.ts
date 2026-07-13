/**
 * Pure projection of a Codex `thread/read` result into core `HistoryItem[]`
 * (TASK.42, cut §2(e)/§3.6). AnyCode NEVER persists a Codex transcript itself
 * — the native thread is the single source of truth for text/file history,
 * merged with AnyCode's own narrow command shadow log (cut §2(e): native
 * `thread/read` never persists `commandExecution` items, not even successful
 * ones — L4). This function is the ENTIRE hydration path: called once per
 * host boot on the resume path, before any new turn, its output feeding
 * `Session({bootHistory})` exactly like core's own persisted-history
 * hydration (zero new wire — `WireHistoryItem`/`session_history` are
 * unchanged, cut §3.6).
 *
 * `CodexThreadRead` is a deliberately NARROW, duck-typed slice of the live
 * `thread/read`/`thread/resume` result (evidenced shape: W0 `resume-read.jsonl`
 * — `result.thread.turns[].items[]`) — only the fields this projection reads,
 * not the full generated schema; unknown/extra fields on a real response are
 * ignored, never rejected (fail-soft: a schema addition upstream must not
 * break resume hydration).
 *
 * Merge (cut §2(e), errata W6): the two sources are DISJOINT by protocol —
 * native `thread/read` yields ONLY `NATIVE_PERSISTED` types
 * (`userMessage|agentMessage|fileChange` — live-probe-evidenced against
 * codex-cli 0.144.3, never `reasoning`/`commandExecution`, not even a
 * successful command); the shadow log holds ONLY `commandExecution`. Because
 * `thread/read` silently DROPS every non-persisted live item (most
 * importantly `reasoning`), the native side and the live stream the shadow
 * writer observed do NOT share one coordinate space — a shadow row's anchor
 * must be expressed in NATIVE-side coordinates, not live-stream coordinates,
 * or the interleave drifts by however many dropped items preceded it.
 *
 * `turnOrdinal` is the turn's own 0-based index in `thread.turns[]`.
 * `positionInTurn` means "insert this row BEFORE `native[positionInTurn]`" —
 * it is the count of NATIVE-PERSISTED live completions observed before the
 * command completed (codex-engine.ts's `nativeVisibleCompleted`), which is
 * exactly the native array's own indexing since native items are the ones
 * `thread/read` kept, in their own relative completion order. `seqInTurn` is
 * the row's raw live-completion-order tiebreaker (every `item/completed` of
 * the turn, dropped items included) — it disambiguates two shadow rows that
 * share one `positionInTurn` (e.g. two commands between the same pair of
 * native items) and seeds the shadow item's HistoryItem id.
 *
 * Reconstruction (`mergeTurnItems`): sort shadow rows by
 * `(positionInTurn, seqInTurn)`. Walk native index `i = 0..native.length-1`;
 * before emitting `native[i]`, emit every not-yet-emitted shadow row whose
 * `positionInTurn <= i` (`<=`, not `==` — a row anchored at or before the
 * earliest slot is still surfaced there rather than silently deferred by a
 * data-consistency edge case). After the walk, emit every remaining shadow
 * row (one anchored at or past `native.length`, e.g. a turn's last item was a
 * command). Nothing is ever dropped.
 *
 * Mapping rules (cut §3.6):
 *  - `userMessage`/`agentMessage` text projects verbatim into a user/assistant
 *    `ChatMessage`. A `userMessage` content part that is not `{type:"text"}`
 *    (e.g. an image sent by another client — Codex sessions started by
 *    AnyCode itself never attach images, `supportsImages:false`) is never
 *    silently dropped: it degrades to a bracketed placeholder carrying its
 *    type and, when present, its `url`/`path` reference.
 *  - `commandExecution`/`fileChange` outcomes project into the EXISTING
 *    assistant `tool_call` + `tool` `tool_result` HistoryItem pair (the same
 *    Bash/Write vocabulary `event-translator.ts`'s live `projectTool` uses —
 *    kept independent here since this module runs cold, over persisted turns,
 *    not a live notification stream). A shadow-sourced `commandExecution` has
 *    no persisted status string (only `exitCode`, cut §2(e) schema); its
 *    outcome degrades to `success`/`error` from the exit code, or `cancelled`
 *    when no exit code was ever recorded (declined/interrupted before
 *    completion) — a documented coarser fidelity than the live path, which
 *    still distinguishes `denied` in real time (event-translator.ts).
 *  - `reasoning`/`plan` items surface their own summary/content text rather
 *    than degrading to a bare type label.
 *  - Every other item type has no HistoryItem counterpart in core's
 *    `ChatMessage` union — it degrades to a deterministic formatted text
 *    block (cut §3.6, "допустимая деградация, фиксируется в тесте голдом")
 *    rather than being silently dropped.
 *  - The result is capped to the last `maxItems` (200 in production, cut
 *    §2(e)); when truncated, a leading marker item is prepended. When the
 *    caller reports the shadow log has no rows for this thread at all
 *    (`shadowMissing`, cut §2(e) degradation (a): a pre-slice or
 *    foreign-client thread), a second leading marker documents that command
 *    output from before this slice is not retained.
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
  /**
   * `userMessage`: array of content parts `{type, text?, url?, path?}` (a
   * non-`text` part is an image/localImage/… sent by another client). `reasoning`:
   * array of plain summary strings (schema `ReasoningThreadItem.content`). The two
   * shapes never coexist on the same item — narrowed per `item.type` at each read site.
   */
  content?: unknown;
  /** `agentMessage` | `plan`. */
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
  /** `reasoning` only. */
  summary?: string[] | null;
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

/**
 * The native `thread/read` item types a live probe (codex-cli 0.144.3, W6)
 * evidenced the app-server actually persists. `reasoning` and
 * `commandExecution` are deliberately absent — the live evidence is that
 * `thread/read` never returns them, not even a successful command. A future
 * codex-cli that starts persisting a new type must be evidenced by a new
 * probe before it is added here; until then it stays on the fallback
 * (`projectFallback`) path rather than being silently assumed native.
 * Single source of truth for BOTH the writer (codex-engine.ts, which counts
 * completions against this set) and the merge below (which anchors shadow
 * rows in the same set's index space) — the coordinate-space drift this
 * fixes was exactly two independent copies of this list disagreeing.
 */
export const NATIVE_PERSISTED: ReadonlySet<string> = new Set(["userMessage", "agentMessage", "fileChange"]);

/**
 * One `commandExecution` completion recorded by the host's live writer (cut
 * §2(e)/§3.6, codex-engine.ts) — the shadow log's sole content, by
 * construction disjoint from every native item type.
 */
export interface ShadowCommandItem {
  turnOrdinal: number;
  /** Insert BEFORE `native[positionInTurn]` — a count of NATIVE_PERSISTED completions, not of all live completions. */
  positionInTurn: number;
  /** Raw live-completion-order tiebreaker (every `item/completed` of the turn) — disambiguates same-`positionInTurn` rows and seeds the shadow HistoryItem id. */
  seqInTurn: number;
  command: string;
  cwd?: string;
  exitCode?: number;
  outputHead?: string;
}

export interface ProjectCodexHistoryOptions {
  maxItems: number;
  /**
   * True when the shadow log has NO rows for this thread at all — a
   * pre-slice or foreign-client thread, not "this thread never ran a
   * command" (cut §2(e) degradation (a) — the fallback, not the main path):
   * a leading marker is projected so a real loss of command output is never
   * silent.
   */
  shadowMissing?: boolean;
}

const TRUNCATION_MARKER_TEXT = "… earlier history truncated (native thread retains full history)";
const SHADOW_MISSING_MARKER_TEXT = "command output from earlier sessions is not retained by Codex";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** A `userMessage` content part's text, or a bracketed placeholder for a non-text part (image/localImage/…) — never silently dropped. */
function partText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  const type = typeof part.type === "string" ? part.type : "unknown";
  const reference = typeof part.url === "string" ? part.url : typeof part.path === "string" ? part.path : undefined;
  return `[${type}${reference !== undefined ? `: ${reference}` : ""}]`;
}

function textOf(item: CodexThreadReadItem): string {
  const parts = Array.isArray(item.content) ? item.content : [];
  return parts.map((part) => partText(record(part) ?? {})).join("");
}

function statusFor(itemStatus: string | null | undefined): ToolCallStatus {
  if (itemStatus === "completed") return "success";
  // The user's own deny must never read as a malfunction (C0 review Medium).
  if (itemStatus === "declined") return "denied";
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  return "error";
}

/** Shadow rows carry no persisted status string (cut §2(e) schema) — only `exitCode`; a documented coarser fidelity than the live path. */
function shadowStatusFor(exitCode: number | undefined): ToolCallStatus {
  if (exitCode === undefined) return "cancelled";
  return exitCode === 0 ? "success" : "error";
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

/**
 * One shadow-log row projects the same Bash tool_call/tool_result pair a
 * native commandExecution item would (cut §2(e)). The id is keyed on
 * `seqInTurn`, not `positionInTurn`: two commands can share one
 * `positionInTurn` (both anchored before the same native item), and
 * `seqInTurn` is unique within the turn by construction (codex-engine.ts).
 */
function projectShadowCommand(turnId: string, item: ShadowCommandItem, createdAt: number): HistoryItem[] {
  const input = { command: item.command, ...(item.cwd !== undefined ? { cwd: item.cwd } : {}) };
  const status = shadowStatusFor(item.exitCode);
  const modelText = item.outputHead ?? "";
  const idPrefix = `${turnId}:shadow:${item.seqInTurn}`;
  return toolPair(idPrefix, createdAt, idPrefix, "Bash", input, status, modelText);
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

function textBlock(turnId: string, item: CodexThreadReadItem, createdAt: number, text: string): HistoryItem {
  const message: ChatMessage = { role: "assistant", content: [{ type: "text", text }] };
  return { id: `${turnId}:${item.id}`, createdAt, message };
}

/** `plan`: EXPERIMENTAL proposed-plan text (schema `PlanThreadItem.text`) — surfaced, not reduced to a bare type label. */
function projectPlan(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem {
  const text = typeof item.text === "string" && item.text.length > 0 ? item.text : "(empty plan)";
  return textBlock(turnId, item, createdAt, `[Codex plan]\n${text}`);
}

/** `reasoning`: summary/content string arrays (schema `ReasoningThreadItem`) — surfaced, not reduced to a bare type label. */
function projectReasoning(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = [...(item.summary ?? []), ...content].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const text = parts.length > 0 ? parts.join("\n\n") : "(no reasoning summary retained)";
  return textBlock(turnId, item, createdAt, `[Codex reasoning]\n${text}`);
}

function projectFallback(turnId: string, item: CodexThreadReadItem, createdAt: number): HistoryItem {
  return textBlock(turnId, item, createdAt, `[Codex ${item.type} item — not represented in AnyCode's transcript format]`);
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
    case "plan":
      return [projectPlan(turnId, item, createdAt)];
    case "reasoning":
      return [projectReasoning(turnId, item, createdAt)];
    default:
      return [projectFallback(turnId, item, createdAt)];
  }
}

/**
 * Interleaves one turn's native items (already in their own relative
 * completion order — `thread/read` only ever appends) with its shadow
 * commands, each anchored to a native-side insertion point (`positionInTurn`,
 * module header). Sorts shadow rows by `(positionInTurn, seqInTurn)`, then for
 * every native index emits whichever not-yet-emitted shadow rows anchor at or
 * before it (`<=`) immediately before that native item; any shadow rows left
 * after the walk (anchored at or past `native.length`) are appended at the
 * end. Nothing is ever dropped.
 */
function mergeTurnItems(
  turnId: string,
  native: CodexThreadReadItem[],
  shadow: ShadowCommandItem[],
  cursorStart: number,
): { items: HistoryItem[]; nextCursor: number } {
  const sortedShadow = [...shadow].sort((a, b) => a.positionInTurn - b.positionInTurn || a.seqInTurn - b.seqInTurn);
  const items: HistoryItem[] = [];
  let cursor = cursorStart;
  let shadowIndex = 0;

  const emit = (projected: HistoryItem[]): void => {
    items.push(...projected);
    cursor += projected.length;
  };

  for (let nativeIndex = 0; nativeIndex < native.length; nativeIndex += 1) {
    while (shadowIndex < sortedShadow.length && sortedShadow[shadowIndex]!.positionInTurn <= nativeIndex) {
      emit(projectShadowCommand(turnId, sortedShadow[shadowIndex]!, cursor));
      shadowIndex += 1;
    }
    emit(projectItem(turnId, native[nativeIndex]!, cursor));
  }
  for (; shadowIndex < sortedShadow.length; shadowIndex += 1) {
    emit(projectShadowCommand(turnId, sortedShadow[shadowIndex]!, cursor));
  }

  return { items, nextCursor: cursor };
}

/**
 * `thread/read` result + the host's own command shadow log -> capped
 * `HistoryItem[]` (cut §2(e)/§3.6). Deterministic given the same input — no
 * I/O, no clock reads (every `createdAt` is derived from the turn's own
 * `startedAt`).
 */
export function projectCodexHistory(
  thread: CodexThreadRead,
  shadow: ShadowCommandItem[],
  opts: ProjectCodexHistoryOptions,
): HistoryItem[] {
  const turns = thread.thread.turns ?? [];
  const shadowByTurn = new Map<number, ShadowCommandItem[]>();
  for (const row of shadow) {
    const list = shadowByTurn.get(row.turnOrdinal);
    if (list === undefined) shadowByTurn.set(row.turnOrdinal, [row]);
    else list.push(row);
  }

  const items: HistoryItem[] = [];
  turns.forEach((turn, turnOrdinal) => {
    const turnStartedAtMs = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : 0;
    const merged = mergeTurnItems(turn.id, turn.items ?? [], shadowByTurn.get(turnOrdinal) ?? [], turnStartedAtMs);
    items.push(...merged.items);
  });

  const capped =
    items.length <= opts.maxItems
      ? items
      : (() => {
          const kept = items.slice(items.length - opts.maxItems);
          const marker: HistoryItem = {
            id: `${thread.thread.id}:truncation-marker`,
            createdAt: (kept[0]?.createdAt ?? 0) - 1,
            kind: "compact_summary",
            message: { role: "assistant", content: [{ type: "text", text: TRUNCATION_MARKER_TEXT }] },
          };
          return [marker, ...kept];
        })();

  if (opts.shadowMissing !== true) return capped;
  const missingMarker: HistoryItem = {
    id: `${thread.thread.id}:shadow-missing-marker`,
    createdAt: (capped[0]?.createdAt ?? 0) - 1,
    kind: "compact_summary",
    message: { role: "assistant", content: [{ type: "text", text: SHADOW_MISSING_MARKER_TEXT }] },
  };
  return [missingMarker, ...capped];
}

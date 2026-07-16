/**
 * Rollout -> `HistoryItem[]` importer (cut §8, AMENDMENT-1 §A5): a pure
 * projection from one codex rollout JSONL file's lines into our own
 * ChatMessage/HistoryItem shape, so the conversation can be continued by our
 * own engine (possibly on a different model). Direction is strictly
 * codex -> us (§8.1) — this module never writes anything, never reads a file
 * itself, and never references the source session back.
 *
 * `response_item` is the ONLY source of history (§8.2); `event_msg` (which
 * duplicates every `response_item` as a UI event) and `turn_context`/
 * `world_state` (both derived) are dropped wholesale. Tool mapping is 1:1
 * ONLY for `exec_command`/`exec` -> `Bash` (§8.4) — the one tool every target
 * session actually has. Everything else COLLAPSES into plain assistant text,
 * folding call+result into one block, so the model is never shown a
 * `tool_use` for a capability the target session doesn't have.
 *
 * Default-skip is three-tiered (AMENDMENT-1 §A5): an unrecognized top-level
 * record type, an unrecognized `response_item.payload.type`, or an
 * unrecognized content part are always SKIPPED with a counter, never thrown —
 * the record/part enumeration in the design doc is a snapshot of 662-721
 * real files, not an exhaustive grammar (W0-R3 found a 6th record type and a
 * 3rd content-part shape that weren't in it).
 */

import type { AssistantPart, ChatMessage, HistoryItem, ToolResultPart } from "@anycode/core";

export interface RolloutImportReport {
  items: HistoryItem[];
  stats: {
    messages: number;
    toolPairs: number;
    reasoningDropped: number;
    developerDropped: number;
    imagesDropped: number;
    orphansSynthesized: number;
    collapsedToText: number;
    malformedLines: number;
    unknownRecordsSkipped: number;
    unknownItemsSkipped: number;
    unknownPartsSkipped: number;
  };
  meta: { cwd?: string; cliVersion?: string; model?: string; startedAt?: string };
  warnings: string[];
}

export interface ImportCodexRolloutOptions {
  maxItems: number;
  maxOutputChars: number;
}

const ORPHAN_MARKER = "[interrupted — no result was recorded]";
const IMAGE_OMITTED_MARKER = "[image omitted on import]";
const COLLAPSE_ARGS_CAP = 2000;
const MAX_WARNING_KINDS = 8;
const MOSTLY_UNRECOGNIZED_THRESHOLD = 0.5;
const TRUNCATION_MARKER_TEXT = "… earlier history truncated";

/** §1.3: the five record types the design doc measured. Anything else is tier-1 default-skip (§A5). */
const KNOWN_RECORD_TYPES = new Set(["session_meta", "turn_context", "response_item", "event_msg", "world_state"]);
/** §1.3/§A5: the three content-part shapes observed. Anything else (e.g. `encrypted_content`) is tier-3 default-skip. */
const KNOWN_PART_TYPES = new Set(["input_text", "output_text", "input_image"]);
/** §8.3/§8.4: the ONLY names that ever produce a real `tool_call` part. */
const BASH_MAPPED_FUNCTION_NAMES = new Set(["exec_command"]);
const BASH_MAPPED_CUSTOM_NAMES = new Set(["exec"]);
/** §8.3: call types that are complete in a single record — never wait on a paired `*_output`. */
const SELF_CONTAINED_COLLAPSE_TYPES = new Set(["web_search_call", "image_generation_call", "agent_message"]);
/** §8.3/§8.6: call types paired via `call_id` with a later `*_output`/`tool_search_output` record. */
const OUTPUT_RECORD_TYPES = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;
}

/** `custom_tool_call_output.output` is sometimes an array of `{type, text}` parts rather than a plain string (§8.3). */
function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => asString(asRecord(part).text))
      .filter((text) => text !== "")
      .join("\n");
  }
  if (typeof output === "object" && output !== null) return JSON.stringify(output);
  return "";
}

type Slot =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "collapse"; header: string; args: string; output?: string };

/**
 * Streaming projection of one rollout's lines. A class (not a closure of
 * functions) only because the state below is genuinely mutable and shared
 * across many small handlers — no behavior is exposed beyond the module-level
 * `importCodexRollout` function.
 */
class RolloutImporter {
  private readonly stats: RolloutImportReport["stats"] = {
    messages: 0,
    toolPairs: 0,
    reasoningDropped: 0,
    developerDropped: 0,
    imagesDropped: 0,
    orphansSynthesized: 0,
    collapsedToText: 0,
    malformedLines: 0,
    unknownRecordsSkipped: 0,
    unknownItemsSkipped: 0,
    unknownPartsSkipped: 0,
  };
  private readonly meta: RolloutImportReport["meta"] = {};
  private readonly items: HistoryItem[] = [];
  private readonly warningCounts = new Map<string, number>();
  private totalRecords = 0;
  private nextId = 0;
  private lastTimestampMs = 0;

  /** The turn currently being assembled (§8.6): text/tool_call/collapse slots in file order. */
  private assistantSlots: Slot[] = [];
  /** `call_id` -> index into `assistantSlots`, for calls whose result folds back INTO that same slot (collapse). */
  private readonly collapsePending = new Map<string, number>();
  /** `call_id` -> monotone call-order seq, for Bash-mapped tool_call slots awaiting their `tool_result` (independent of `assistantSlots` — survives a flush). */
  private readonly bashPending = new Map<string, number>();
  private toolResults: Array<{ seq: number; part: ToolResultPart }> = [];
  private callSeq = 0;

  constructor(private readonly opts: ImportCodexRolloutOptions) {}

  private freshId(): string {
    return `rollout-${(this.nextId++).toString().padStart(6, "0")}`;
  }

  /** Untrusted-content custody: any name sourced from the rollout file itself is capped before it can inflate a warning string. */
  private noteUnknown(name: string): void {
    const capped = name.length > 64 ? `${name.slice(0, 64)}…` : name;
    this.warningCounts.set(capped, (this.warningCounts.get(capped) ?? 0) + 1);
  }

  private renderSlots(slots: readonly Slot[]): AssistantPart[] {
    const parts: AssistantPart[] = [];
    for (const slot of slots) {
      if (slot.kind === "text") {
        if (slot.text !== "") parts.push({ type: "text", text: slot.text });
      } else if (slot.kind === "tool_call") {
        parts.push({ type: "tool_call", toolCallId: slot.toolCallId, toolName: slot.toolName, input: slot.input });
      } else {
        const outputLine = slot.output !== undefined ? `\n→ ${truncate(slot.output, this.opts.maxOutputChars)}` : "";
        parts.push({ type: "text", text: `⟦codex · ${slot.header}⟧\n${slot.args}${outputLine}` });
        this.stats.collapsedToText++;
      }
    }
    return parts;
  }

  /**
   * Closes out the turn currently being assembled: any collapse slot still
   * waiting on its own paired output is resolved to the orphan marker first
   * (§8.5's "synthesize, don't drop" principle applied uniformly — a
   * genuinely still-in-flight sibling call, if any, is unaffected since
   * `bashPending` tracks results independently of this buffer, see below).
   */
  private flushAssistant(): void {
    for (const [, index] of this.collapsePending) {
      const slot = this.assistantSlots[index];
      if (slot?.kind === "collapse" && slot.output === undefined) {
        slot.output = ORPHAN_MARKER;
        this.stats.orphansSynthesized++;
      }
    }
    this.collapsePending.clear();
    if (this.assistantSlots.length === 0) return;
    const parts = this.renderSlots(this.assistantSlots);
    this.assistantSlots = [];
    if (parts.length === 0) return;
    this.items.push({ id: this.freshId(), createdAt: this.lastTimestampMs, message: { role: "assistant", content: parts } });
    this.stats.messages++;
  }

  /** §8.6: batched tool results must be emitted in call order, not arrival order — sort by `seq` at flush time. */
  private flushToolResults(): void {
    if (this.toolResults.length === 0) return;
    const content = [...this.toolResults].sort((a, b) => a.seq - b.seq).map((entry) => entry.part);
    this.toolResults = [];
    const message: ChatMessage = { role: "tool", content };
    this.items.push({ id: this.freshId(), createdAt: this.lastTimestampMs, message });
    this.stats.messages++;
  }

  /** Hard turn boundary (a new user message, or EOF): anything still pending is genuinely interrupted, not merely mid-batch. */
  private closeOutTurn(): void {
    this.flushAssistant();
    for (const [callId, seq] of this.bashPending) {
      this.toolResults.push({ seq, part: { type: "tool_result", toolCallId: callId, toolName: "Bash", text: ORPHAN_MARKER, status: "cancelled" } });
      this.stats.orphansSynthesized++;
    }
    this.bashPending.clear();
    this.flushToolResults();
  }

  /** Call before any handler that appends into `assistantSlots` — a new assistant turn starting closes out any tool-result collection in progress. */
  private beginContribution(): void {
    this.flushToolResults();
  }

  private processContentParts(content: unknown, onPart: (part: Record<string, unknown>) => void): void {
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const part = asRecord(raw);
      const type = asString(part.type);
      if (KNOWN_PART_TYPES.has(type)) {
        onPart(part);
        continue;
      }
      this.stats.unknownPartsSkipped++;
      this.noteUnknown(type || "(non-string part type)");
    }
  }

  private handleUserMessage(content: unknown): void {
    this.closeOutTurn();
    const texts: string[] = [];
    this.processContentParts(content, (part) => {
      const type = asString(part.type);
      if (type === "input_text" || type === "output_text") {
        texts.push(asString(part.text));
      } else if (type === "input_image") {
        texts.push(IMAGE_OMITTED_MARKER);
        this.stats.imagesDropped++;
      }
    });
    const message: ChatMessage = { role: "user", content: texts.join("\n") };
    this.items.push({ id: this.freshId(), createdAt: this.lastTimestampMs, message });
    this.stats.messages++;
  }

  private handleAssistantMessage(content: unknown): void {
    this.beginContribution();
    this.processContentParts(content, (part) => {
      const type = asString(part.type);
      if (type === "input_image") {
        this.assistantSlots.push({ kind: "text", text: IMAGE_OMITTED_MARKER });
        this.stats.imagesDropped++;
        return;
      }
      this.assistantSlots.push({ kind: "text", text: asString(part.text) });
    });
  }

  private handleAgentMessage(payload: Record<string, unknown>): void {
    this.beginContribution();
    const author = asString(payload.author);
    const recipient = asString(payload.recipient);
    const header = author !== "" && recipient !== "" ? `agent_message ${author}→${recipient}` : "agent_message";
    const texts: string[] = [];
    this.processContentParts(payload.content, (part) => {
      const type = asString(part.type);
      if (type === "input_text" || type === "output_text") texts.push(asString(part.text));
    });
    this.assistantSlots.push({ kind: "collapse", header, args: truncate(texts.join("\n"), COLLAPSE_ARGS_CAP) });
  }

  private handleSelfContainedCall(type: string, payload: Record<string, unknown>): void {
    this.beginContribution();
    const summary = payload.action ?? payload.arguments ?? {};
    this.assistantSlots.push({ kind: "collapse", header: type, args: truncate(JSON.stringify(summary), COLLAPSE_ARGS_CAP) });
  }

  private handleFunctionCall(payload: Record<string, unknown>): void {
    const callId = asString(payload.call_id);
    if (callId === "") {
      this.stats.unknownItemsSkipped++;
      this.noteUnknown("function_call(missing call_id)");
      return;
    }
    this.beginContribution();
    const name = asString(payload.name);
    if (BASH_MAPPED_FUNCTION_NAMES.has(name)) {
      let args: Record<string, unknown> = {};
      try {
        args = asRecord(JSON.parse(asString(payload.arguments) || "{}"));
      } catch {
        args = {};
      }
      this.assistantSlots.push({ kind: "tool_call", toolCallId: callId, toolName: "Bash", input: { command: asString(args.cmd) } });
      this.bashPending.set(callId, this.callSeq++);
      return;
    }
    const namespace = asString(payload.namespace);
    const header = namespace !== "" ? `${namespace}${name}` : name;
    const index = this.assistantSlots.length;
    this.assistantSlots.push({ kind: "collapse", header, args: truncate(asString(payload.arguments), COLLAPSE_ARGS_CAP) });
    this.collapsePending.set(callId, index);
  }

  private handleCustomToolCall(payload: Record<string, unknown>): void {
    const callId = asString(payload.call_id);
    if (callId === "") {
      this.stats.unknownItemsSkipped++;
      this.noteUnknown("custom_tool_call(missing call_id)");
      return;
    }
    this.beginContribution();
    const name = asString(payload.name);
    if (BASH_MAPPED_CUSTOM_NAMES.has(name)) {
      this.assistantSlots.push({ kind: "tool_call", toolCallId: callId, toolName: "Bash", input: { command: asString(payload.input) } });
      this.bashPending.set(callId, this.callSeq++);
      return;
    }
    const rawInput = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? "");
    const index = this.assistantSlots.length;
    this.assistantSlots.push({ kind: "collapse", header: name, args: truncate(rawInput, COLLAPSE_ARGS_CAP) });
    this.collapsePending.set(callId, index);
  }

  private handleToolSearchCall(payload: Record<string, unknown>): void {
    const callId = asString(payload.call_id);
    if (callId === "") {
      this.stats.unknownItemsSkipped++;
      this.noteUnknown("tool_search_call(missing call_id)");
      return;
    }
    this.beginContribution();
    const index = this.assistantSlots.length;
    this.assistantSlots.push({
      kind: "collapse",
      header: "tool_search_call",
      args: truncate(JSON.stringify(payload.arguments ?? {}), COLLAPSE_ARGS_CAP),
    });
    this.collapsePending.set(callId, index);
  }

  private handleOutput(payload: Record<string, unknown>): void {
    const callId = asString(payload.call_id);
    if (callId === "") return; // an orphaned output with no call_id at all — 0 observed, nothing sane to pair it to.
    const outputText = extractOutputText(payload.output);
    if (this.bashPending.has(callId)) {
      const seq = this.bashPending.get(callId)!;
      this.bashPending.delete(callId);
      this.toolResults.push({
        seq,
        part: {
          type: "tool_result",
          toolCallId: callId,
          toolName: "Bash",
          text: truncate(outputText, this.opts.maxOutputChars),
          status: "success",
        },
      });
      this.stats.toolPairs++;
      // §8.6: the FIRST output after a batch of calls flushes the assistant
      // turn as one unit and opens a tool message collecting the rest as they
      // arrive — subsequent calls in `bashPending` resolve independently of
      // `assistantSlots`, so this is safe to call unconditionally (idempotent
      // once the buffer is already empty).
      this.flushAssistant();
      return;
    }
    const index = this.collapsePending.get(callId);
    if (index !== undefined) {
      this.collapsePending.delete(callId);
      const slot = this.assistantSlots[index];
      if (slot?.kind === "collapse") slot.output = truncate(outputText, this.opts.maxOutputChars);
      this.stats.toolPairs++;
      return;
    }
    // An output with no matching pending call — 0 observed across the W0-R3 corpus. Dropped silently rather than guessed at.
  }

  private handleResponseItem(payload: Record<string, unknown>): void {
    const type = asString(payload.type);
    if (type === "message") {
      const role = asString(payload.role);
      if (role === "developer") {
        this.stats.developerDropped++;
        return;
      }
      if (role === "user") {
        this.handleUserMessage(payload.content);
        return;
      }
      if (role === "assistant") {
        this.handleAssistantMessage(payload.content);
        return;
      }
      this.stats.unknownItemsSkipped++;
      this.noteUnknown("message(unsupported role)");
      return;
    }
    if (type === "reasoning") {
      this.stats.reasoningDropped++;
      return;
    }
    if (type === "agent_message") {
      this.handleAgentMessage(payload);
      return;
    }
    if (SELF_CONTAINED_COLLAPSE_TYPES.has(type)) {
      this.handleSelfContainedCall(type, payload);
      return;
    }
    if (type === "function_call") {
      this.handleFunctionCall(payload);
      return;
    }
    if (type === "custom_tool_call") {
      this.handleCustomToolCall(payload);
      return;
    }
    if (type === "tool_search_call") {
      this.handleToolSearchCall(payload);
      return;
    }
    if (OUTPUT_RECORD_TYPES.has(type)) {
      this.handleOutput(payload);
      return;
    }
    this.stats.unknownItemsSkipped++;
    this.noteUnknown(type || "(non-string payload type)");
  }

  private processRecord(record: Record<string, unknown>): void {
    const timestamp = asString(record.timestamp);
    if (timestamp !== "") {
      const parsed = Date.parse(timestamp);
      if (!Number.isNaN(parsed)) this.lastTimestampMs = parsed;
    }
    const type = asString(record.type);
    if (!KNOWN_RECORD_TYPES.has(type)) {
      this.stats.unknownRecordsSkipped++;
      this.noteUnknown(type || "(non-string record type)");
      return;
    }
    if (type === "event_msg" || type === "world_state") return; // dropped wholesale — event_msg duplicates response_item.
    const payload = asRecord(record.payload);
    if (type === "session_meta") {
      if (this.meta.cwd === undefined && typeof payload.cwd === "string") this.meta.cwd = payload.cwd;
      if (this.meta.cliVersion === undefined && typeof payload.cli_version === "string") this.meta.cliVersion = payload.cli_version;
      if (this.meta.startedAt === undefined && typeof payload.timestamp === "string") this.meta.startedAt = payload.timestamp;
      return;
    }
    if (type === "turn_context") {
      if (this.meta.model === undefined && typeof payload.model === "string") this.meta.model = payload.model;
      return;
    }
    this.handleResponseItem(payload);
  }

  private buildWarnings(): string[] {
    const warnings: string[] = [];
    const entries = [...this.warningCounts.entries()];
    const shown = entries.slice(0, MAX_WARNING_KINDS);
    for (const [name, count] of shown) {
      warnings.push(`skipped ${count} record(s) of unknown type '${name}'`);
    }
    if (entries.length > MAX_WARNING_KINDS) {
      const rest = entries.slice(MAX_WARNING_KINDS);
      const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
      warnings.push(`skipped ${restCount} more record(s) across ${rest.length} other unknown type(s)`);
    }
    const skippedRecords = this.stats.malformedLines + this.stats.unknownRecordsSkipped + this.stats.unknownItemsSkipped;
    if (this.totalRecords > 0 && skippedRecords / this.totalRecords > MOSTLY_UNRECOGNIZED_THRESHOLD) {
      warnings.push("file is mostly unrecognized; likely a newer rollout format");
    }
    return warnings;
  }

  private applyItemsCap(): HistoryItem[] {
    if (this.items.length <= this.opts.maxItems) return this.items;
    const kept = this.items.slice(this.items.length - this.opts.maxItems);
    const marker: HistoryItem = {
      id: this.freshId(),
      createdAt: kept[0] !== undefined ? kept[0].createdAt - 1 : this.lastTimestampMs,
      message: { role: "assistant", content: [{ type: "text", text: TRUNCATION_MARKER_TEXT }] },
    };
    return [marker, ...kept];
  }

  run(lines: readonly string[]): RolloutImportReport {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "") continue;
      this.totalRecords++;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.stats.malformedLines++;
        continue;
      }
      if (typeof record !== "object" || record === null) {
        this.stats.malformedLines++;
        continue;
      }
      this.processRecord(record as Record<string, unknown>);
    }
    this.closeOutTurn();
    return {
      items: this.applyItemsCap(),
      stats: this.stats,
      meta: this.meta,
      warnings: this.buildWarnings(),
    };
  }
}

export function importCodexRollout(lines: readonly string[], opts: ImportCodexRolloutOptions): RolloutImportReport {
  return new RolloutImporter(opts).run(lines);
}

/**
 * Taskana 4068 / TASK.98 (review 23.08 narrowing): host-side engine swap seam.
 *
 * The review froze N×N transcript transportation ("a track, not a task"), so
 * the ONLY "history transfer" this cut ships is a string-bundle first prompt:
 * when Session swaps its SessionEngine between turns, the new engine's native
 * context starts EMPTY and its first turn receives the rendered summary of the
 * canonical conversation below (the canonical HistoryItem[] transcript itself
 * stays continuous in the UI — nothing is moved structurally).
 *
 * Everything in this module is PURE (no I/O, no clock) so the exact strings a
 * switched-to engine sees are unit-testable in isolation.
 */

import type { HistoryItem } from "@anycode/core";
import type { EngineId } from "../shared/engines.js";

/**
 * Sentinel outer-turn id for the switch announcement `agent_event` — same
 * discipline as Session's MANUAL_COMPACTION_TURN_ID: an event tied to a host
 * lifecycle moment, not to any engine turn, so it never collides with a real
 * turn id and automation can filter it by id alone.
 */
export const ENGINE_SWITCH_TURN_ID = "engine-switch";

/** Result of planning a switch: the exact items imported into the new engine's first turn. */
export interface EngineSwitchPlan {
  /** Conversation items to import, newest-last, already capped. */
  items: HistoryItem[];
  /** True when the conversation exceeded the cap and only the tail was kept. */
  truncated: boolean;
}

/**
 * Caps the conversation to import. `compact_summary`/`microcompact_cleared`
 * items are core-engine artifacts (internal context-management markers, not
 * something a foreign engine can consume) and are dropped BEFORE capping so
 * the budget is spent only on real conversation items. `truncated` compares
 * the FILTERED length against the kept tail (a conversation that fits after
 * filtering is not "truncated" even if markers were dropped).
 */
export function planEngineSwitchImport(history: readonly HistoryItem[], maxItems = 100): EngineSwitchPlan {
  const conversation = history.filter((item) => item.kind === undefined || item.kind === "normal");
  const items = conversation.length > maxItems ? conversation.slice(conversation.length - maxItems) : [...conversation];
  return { items, truncated: conversation.length > items.length };
}

/** Tool-result texts are capped at this many characters in the rendered prompt. */
const TOOL_RESULT_MAX_CHARS = 500;

/**
 * Renders ONE planned item as a `# role`-prefixed prompt chunk; malformed
 * shapes yield "" (skipped, never fatal). Validated at RUNTIME (unknown
 * role/content shapes are skipped, not casted-through) — foreign-engine
 * history must never abort a switch by throwing.
 */
function renderImportItem(item: HistoryItem): string {
  const message: unknown = item.message;
  if (typeof message !== "object" || message === null) return "";
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role === "user" && typeof content === "string") {
    // `images` are skipped: the string bundle is text-only by design.
    return `# user ${content}`;
  }
  if (role === "assistant" && Array.isArray(content)) {
    // tool_call parts are skipped — the workspace on disk is the authority (TASK.98 frame).
    const text = content
      .filter((part): part is { type: "text"; text: string } => {
        const candidate = part as { type?: unknown; text?: unknown } | null;
        return candidate !== null && candidate.type === "text" && typeof candidate.text === "string";
      })
      .map((part) => part.text)
      .join("\n");
    return `# assistant ${text}`;
  }
  if (role === "tool" && Array.isArray(content)) {
    // Only the FIRST tool_result part's text survives, capped; the rest are skipped.
    const parts = content as { type?: unknown; toolName?: unknown; text?: unknown }[];
    const first = parts.find((part) => {
      const candidate = part as { type?: unknown } | null;
      return candidate !== null && candidate.type === "tool_result";
    });
    if (first === undefined || typeof first.text !== "string") return `# tool`;
    const raw = first.text;
    const text = raw.length > TOOL_RESULT_MAX_CHARS ? raw.slice(0, TOOL_RESULT_MAX_CHARS) : raw;
    const toolName = typeof first.toolName === "string" ? first.toolName : "";
    return `# tool ${toolName} ${text}`;
  }
  return ""; // unknown role / malformed content: skipped, never fatal
}

/**
 * Renders the planned history into ONE first-prompt string for the new engine
 * (the review's single-scenario cut: no structural transcript conversion).
 * Deterministic — no dates, no engine-specific formatting — so the same
 * conversation always yields the same prompt string.
 */
export function renderImportPrompt(from: EngineId, to: EngineId, plan: EngineSwitchPlan, workspace: string): string {
  const lines: string[] = [
    `Session continued in this ${to} engine (previous engine: ${from}; workspace: ${workspace}).`,
    plan.truncated
      ? `Imported the last ${plan.items.length} conversation items (older history was dropped).`
      : `Imported the full conversation (${plan.items.length} items).`,
  ];
  for (const item of plan.items) {
    const rendered = renderImportItem(item);
    if (rendered !== "") lines.push(rendered);
  }
  return lines.join("\n");
}

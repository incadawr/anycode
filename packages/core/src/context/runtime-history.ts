import type { HistoryItem } from "../types/history.js";
import type { RuntimeHandoff } from "../ports/runtime-segments.js";

/** Scope native ids without interpreting tool/image payloads as model input. */
export function scopeRuntimeHistory(segmentId: string, items: readonly HistoryItem[], handoff?: RuntimeHandoff | null): HistoryItem[] {
  return items.map(item => {
    if (item.segmentId !== undefined && item.segmentId !== segmentId) throw new Error("Transcript item belongs to another runtime segment");
    const sourceItemId = item.sourceItemId ?? item.id;
    const normalized = handoff?.injectedText !== undefined && handoff.originalText !== undefined && item.message.role === "user" && item.message.content === handoff.injectedText;
    return { ...item, id: `segment:${encodeURIComponent(segmentId)}:${sourceItemId}`, segmentId, sourceItemId,
      ...(normalized ? { message: { ...item.message, role: "user" as const, content: handoff.originalText! }, ...(handoff.turnId ? { turnId: handoff.turnId } : {}) } : {}) };
  });
}

/** Existing display coverage is additive, including history removed from model context by compaction. */
export function mergeRuntimeHistory(existing: readonly HistoryItem[], segmentId: string, incoming: readonly HistoryItem[], handoff?: RuntimeHandoff | null): HistoryItem[] {
  const merged = new Map(existing.map(item => [item.id,item]));
  for (const item of scopeRuntimeHistory(segmentId,incoming,handoff)) merged.set(item.id,item);
  return [...merged.values()];
}

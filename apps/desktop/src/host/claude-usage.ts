import type { HistoryItem, ProviderUsageRecord } from "@anycode/core";
import type { ClaudeResultMessage } from "./engines/claude/protocol.js";

/** Snapshot a native Claude result without inventing unreported cache reads. */
export function claudeUsageRecord(
  result: ClaudeResultMessage,
  turnId: string,
  model: string,
): Omit<ProviderUsageRecord, "sessionId" | "createdAt"> {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = count(result.usage?.input_tokens);
  const cached = count(result.usage?.cache_read_input_tokens);
  const rawWrite = result.usage?.cache_creation_input_tokens;
  const write = count(rawWrite);
  // Claude's input_tokens excludes cache reads and writes. A missing write
  // field means no reported writes; an invalid value must not be treated as 0.
  const writesForTotal = rawWrite === undefined ? 0 : write;
  const totalInput = input !== undefined && cached !== undefined && writesForTotal !== undefined
    ? input + cached + writesForTotal : undefined;
  const output = count(result.usage?.output_tokens);
  const safeInput = totalInput !== undefined && Number.isSafeInteger(totalInput) ? totalInput : undefined;
  const total = safeInput !== undefined && output !== undefined ? safeInput + output : undefined;
  const cost = result.total_cost_usd;
  return {
    turnId, step: 1, model, finishReason: "result", transportRetries: 0,
    ...(safeInput !== undefined ? { inputTokens: safeInput } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined && Number.isSafeInteger(total) ? { totalTokens: total } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { costUsd: cost, priceBasisId: "claude-cli-reported" } : {}),
  };
}

/** Native Claude child costs are not separately reported by the CLI. */
export function claudeNativeChildRecord(toolCallId: string): Omit<ProviderUsageRecord, "sessionId" | "createdAt"> {
  const childId = `claude-native:${toolCallId}`;
  return { turnId: childId, subagentId: childId, step: 1, priceBasisId: "claude-native-unattributed", finishReason: "unknown", transportRetries: 0 };
}

/** Recover only child identities from a shadow transcript, never past prices. */
export function claudeNativeChildrenFromHistory(history: readonly HistoryItem[]): ReturnType<typeof claudeNativeChildRecord>[] {
  const ids = new Set<string>();
  for (const item of history) {
    const message = item?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "tool_call" && (part.toolName === "Agent" || part.toolName === "Task") && typeof part.toolCallId === "string" && part.toolCallId.length > 0) ids.add(part.toolCallId);
    }
  }
  return [...ids].map(claudeNativeChildRecord);
}

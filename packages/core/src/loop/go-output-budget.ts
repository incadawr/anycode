import { estimateMessageTokens } from "../context/history.js";
import { estimateToolDeclarationTokens } from "../context/tokens.js";
import type { Tokenizer } from "../context/tokenizer.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../types/config.js";

/** Estimates include images; the provider remains the final token-count authority. */
export function goRequestOutputBudget(request: ModelRequest, port: ModelPort, tokenizer: Tokenizer, contextOverride?: number): number | undefined {
  const limits = port.goLimits;
  if (!limits?.context) return request.maxOutputTokens;
  const window = contextOverride ?? limits.context;
  const prompt = tokenizer.count(request.system ?? "") + request.messages.reduce((n, message) => n + estimateMessageTokens(tokenizer, message), 0) + estimateToolDeclarationTokens(request.tools, tokenizer);
  const available = Math.max(1, window - Math.ceil(prompt * 1.15) - 1024);
  return Math.min(request.maxOutputTokens ?? limits.output ?? DEFAULT_MAX_OUTPUT_TOKENS, available);
}

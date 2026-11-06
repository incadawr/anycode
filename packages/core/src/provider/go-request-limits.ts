import { estimateMessageTokens } from "../context/history.js";
import { estimateToolDeclarationTokens } from "../context/tokens.js";
import { HeuristicTokenizer } from "../context/tokenizer.js";
import { goRequestOutputBudget } from "../loop/go-output-budget.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";

/** Admit every Go request before SDK construction or retry handling. */
export function applyGoRequestLimits(request: ModelRequest, port: ModelPort): ModelRequest {
  if (!port.goLimits) return request;
  const tokenizer = new HeuristicTokenizer();
  const input = tokenizer.count(request.system ?? "") + request.messages.reduce((n, message) => n + estimateMessageTokens(tokenizer, message), 0) + estimateToolDeclarationTokens(request.tools, tokenizer);
  if (port.goLimits.input !== undefined && input > port.goLimits.input) {
    throw new Error(`Estimated prompt (${input} tokens) exceeds the provider input limit (${port.goLimits.input}). Reduce the prompt or compact the conversation.`);
  }
  return { ...request, maxOutputTokens: goRequestOutputBudget(request, port, tokenizer, request.contextWindowTokens) };
}

import { expect, it, vi } from "vitest";
import type { AssistantPart, ChatMessage } from "../types/history.js";
import { readReasoningHistory } from "./env.js";
import { toSdkMessages } from "./sdk-mapping.js";
const generate = vi.hoisted(() => vi.fn());
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: generate }));
import { AiSdkModelPort, reasoningReplaySource } from "./model-port.js";
const config = { transport: "openai-chat-completions" as const, baseUrl: "http://fake.invalid", model: "fake", apiKey: "fake", preserveReasoning: true };
const source = reasoningReplaySource(config)!;
const parts: AssistantPart[] = [{ type: "reasoning", text: "original reasoning", source }, { type: "text", text: "answer" }];
it("validates modes and caps", () => {
  expect(readReasoningHistory({})).toBeUndefined();
  for (const mode of ["none", "full", "factual_500"]) expect(readReasoningHistory({ ANYCODE_REASONING_HISTORY: mode })).toBe(mode);
  for (const mode of ["factual_0", "factual_-1", "factual_1.5", "typo"]) expect(() => readReasoningHistory({ ANYCODE_REASONING_HISTORY: mode })).toThrow();
});
it("preserves baseline bytes when unset or full, and none omits reasoning", () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: parts }];
  const baseline = JSON.stringify(toSdkMessages(messages, config.transport, source));
  for (const mode of [undefined, "full"] as const) expect(JSON.stringify(toSdkMessages(messages, config.transport, reasoningReplaySource({ ...config, reasoningHistory: mode })))).toBe(baseline);
  expect(JSON.stringify(toSdkMessages(messages, config.transport, reasoningReplaySource({ ...config, reasoningHistory: "none" })))).not.toContain("original reasoning");
});
it("retains provider gates in every mode", () => {
  for (const mode of ["full", "factual_500"] as const) {
    expect(reasoningReplaySource({ ...config, providerName: "Anthropic", reasoningHistory: mode })).toBeUndefined();
    expect(reasoningReplaySource({ ...config, transport: "openai-responses", reasoningHistory: mode })).toBeUndefined();
  }
});
it("summarizes once, keeps the audit original, bounds bytes and records separate usage", async () => {
  generate.mockResolvedValue({ text: "Goal: fix. Verified facts: none. Unverified: pending.", usage: { inputTokens: 100, outputTokens: 15, totalTokens: 115 } });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_40", reasoningCompactorModel: "compactor" });
  const compacted = await port.compactReasoning(parts);
  expect(await port.compactReasoning(compacted)).toEqual(compacted);
  expect(generate).toHaveBeenCalledTimes(1);
  const first = compacted[0];
  if (first === undefined || first.type !== "reasoning") throw Error("missing reasoning");
  expect(first.text).toBe("original reasoning");
  expect(Buffer.byteLength(first.factualSummary!.text)).toBeLessThanOrEqual(40);
  expect(first.factualSummary!.usage).toEqual({ inputTokens: 100, outputTokens: 15, totalTokens: 115 });
  expect(Object.isFrozen(first.factualSummary)).toBe(true);
  expect(JSON.stringify(toSdkMessages([{ role: "assistant", content: compacted }], config.transport, reasoningReplaySource({ ...config, reasoningHistory: "full" })))).toContain("original reasoning");
  for (const transport of ["anthropic-messages", "openai-chat-completions"] as const) {
    const route = { ...source, transport, replayUnsigned: true };
    const mapped = toSdkMessages([{ role: "assistant", content: [{ ...first, source: route, providerMetadata: { anthropic: { signature: "original signature" } } }] }], transport, route);
    expect(JSON.stringify(mapped)).toContain(first.factualSummary!.text);
    expect(JSON.stringify(mapped)).not.toContain("original signature");
    expect(JSON.stringify(mapped)).not.toContain("original reasoning");
  }
});
it("uses one immutable summary for all reasoning blocks, including after hydration", async () => {
  generate.mockClear();
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_100" });
  const compacted = await port.compactReasoning([...parts, { type: "reasoning", text: "second block", source }]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]![0].prompt).toContain("second block");
  const hydrated = JSON.parse(JSON.stringify(compacted));
  expect(await port.compactReasoning(hydrated)).toEqual(hydrated);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(compacted.filter(p => p.type === "reasoning").map(p => p.factualSummary?.text).join("").length).toBeLessThanOrEqual(100);
});

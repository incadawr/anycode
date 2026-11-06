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
const validSummary = [
  "Goal/stage: fix.",
  "Verified facts: none.",
  "Decision/constraints: stay local.",
  "Unverified hypotheses: none.",
  "Next intended action: read.",
].join("\n");
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
    expect(reasoningReplaySource({ ...config, providerName: "Anthropic", preserveReasoning: false, reasoningHistory: mode })).toBeUndefined();
    expect(reasoningReplaySource({ ...config, transport: "openai-responses", reasoningHistory: mode }) !== undefined).toBe(mode === "full");
  }
});
it("summarizes once, keeps the audit original, bounds bytes and records separate usage", async () => {
  generate.mockResolvedValue({ text: validSummary, usage: { inputTokens: 100, outputTokens: 15, totalTokens: 115 } });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_500", reasoningCompactorModel: "compactor" });
  const compacted = await port.compactReasoning(parts);
  expect(await port.compactReasoning(compacted)).toEqual(compacted);
  expect(generate).toHaveBeenCalledTimes(1);
  const first = compacted[0];
  if (first === undefined || first.type !== "reasoning") throw Error("missing reasoning");
  expect(first.text).toBe("original reasoning");
  expect(Buffer.byteLength(first.factualSummary!.text)).toBeLessThanOrEqual(500);
  expect(first.factualSummary!.usage).toEqual({ inputTokens: 100, outputTokens: 15, totalTokens: 115 });
  expect(Object.isFrozen(first.factualSummary)).toBe(true);
  expect(JSON.stringify(toSdkMessages([{ role: "assistant", content: compacted }], config.transport, reasoningReplaySource({ ...config, reasoningHistory: "full" })))).toContain("original reasoning");
  for (const transport of ["anthropic-messages", "openai-chat-completions"] as const) {
    const route = { ...source, transport, replayUnsigned: true, replayFactual: true };
    const mapped = toSdkMessages([{ role: "assistant", content: [{ ...first, source: route, providerMetadata: { anthropic: { signature: "original signature" } } }] }], transport, route);
    expect(JSON.stringify(mapped)).toContain(JSON.stringify(first.factualSummary!.text));
    expect(JSON.stringify(mapped)).not.toContain("original signature");
    expect(JSON.stringify(mapped)).not.toContain("original reasoning");
  }
});
it("uses one immutable summary for all reasoning blocks, including after hydration", async () => {
  generate.mockClear();
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_500" });
  const compacted = await port.compactReasoning([...parts, { type: "reasoning", text: "second block", source }]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]![0].prompt).toContain("second block");
  const hydrated = JSON.parse(JSON.stringify(compacted));
  expect(await port.compactReasoning(hydrated)).toEqual(hydrated);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(compacted.filter(p => p.type === "reasoning").map(p => p.factualSummary?.text).join("").length).toBeLessThanOrEqual(500);
});

it("unset replay ignores stored summaries byte for byte, while factual omits unsummarized parts", () => {
  const summarized: AssistantPart[] = parts.map(part => part.type === "reasoning" ? {
    ...part,
    factualSummary: { text: "Goal: summary.", tokenCap: 100, model: "fake", usage: {} },
  } : part);
  for (const transport of ["anthropic-messages", "openai-chat-completions"] as const) {
    const route = { ...source, transport, replayUnsigned: true };
    const original = parts.map(part => part.type === "reasoning" ? { ...part, source: route } : part);
    const stored = summarized.map(part => part.type === "reasoning" ? { ...part, source: route } : part);
    const map = (content: AssistantPart[], replay = route) => JSON.stringify(
      toSdkMessages([{ role: "assistant", content }], transport, replay),
    );
    expect(map(stored)).toBe(map(original));
    expect(map(original, { ...route, replayFactual: true })).not.toContain("original reasoning");
    expect(map(stored, { ...route, replayFactual: true })).toContain("Goal: summary.");
  }
});

it.each(["", "  ", "a".repeat(101)])("rejects unusable summary %j without mutating originals", async text => {
  generate.mockResolvedValueOnce({ text, usage: { inputTokens: 12, outputTokens: 3 } });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_500" });
  await expect(port.compactReasoning(parts)).rejects.toMatchObject({
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  expect(parts[0]).not.toHaveProperty("factualSummary");
});

it("retains complete lines and reserves separate reasoning headroom", async () => {
  generate.mockResolvedValueOnce({ text: validSummary + "\n" + "x".repeat(500), usage: {} });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_500" });
  const compacted = await port.compactReasoning(parts);
  expect(compacted[0]).toMatchObject({ factualSummary: { text: validSummary } });
  expect(generate.mock.lastCall![0].maxOutputTokens).toBeGreaterThan(500);
  expect(generate.mock.lastCall![0].system).toContain("at most 500 tokens");
});

it("replays a usable factual summary even when the first reasoning block was empty", async () => {
  generate.mockResolvedValueOnce({ text: validSummary, usage: {} });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: "factual_500" });
  const compacted = await port.compactReasoning([
    { type: "reasoning", text: "", source }, ...parts,
  ]);
  const mapped = toSdkMessages(
    [{ role: "assistant", content: compacted }],
    config.transport, port.reasoningReplaySource(),
  );
  expect(JSON.stringify(mapped)).toContain(JSON.stringify(validSummary));
  expect(JSON.stringify(mapped)).not.toContain("original reasoning");
});

it.each([
  { text: "arbitrary prose", cap: 500 },
  { text: validSummary.replace("Goal/stage: fix.", "Goal/stageX"), cap: 500 },
  { text: validSummary, cap: Buffer.byteLength(validSummary) - 1 },
  { text: validSummary.replace("Next intended action: read.", "Next intended action: "), cap: 500 },
])("rejects summaries missing required fields after truncation ($cap)", async ({ text, cap }) => {
  generate.mockResolvedValueOnce({ text, usage: { inputTokens: 12, outputTokens: 3 } });
  const port = new AiSdkModelPort({ ...config, reasoningHistory: `factual_${cap}` });
  await expect(port.compactReasoning(parts)).rejects.toMatchObject({
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  expect(parts[0]).not.toHaveProperty("factualSummary");
});

it("resolves a factual compactor through its own Go route and policy", async () => {
  const { applyAutomaticModelRoute } = await import("./endpoint.js");
  const make = (model: string) => applyAutomaticModelRoute({ transport: "openai-chat-completions", baseUrl: "https://opencode.ai/inference/go/openai/v1", model, apiKey: "fake", providerId: "opencode", automaticModelRouting: true, reasoningHistory: "factual_500", reasoningCompactorModel: "grok-4.7" });
  const root = make("deepseek-v4.1-flash");
  root.resolveEndpointForModel = make;
  generate.mockClear();
  generate.mockResolvedValueOnce({ text: validSummary, usage: {} });
  await new AiSdkModelPort(root).compactReasoning(parts);
  const options = generate.mock.lastCall![0];
  expect(options.model.modelId).toBe("grok-4.7");
  expect(options.providerOptions.openai.store).toBe(false);
  expect(options.providerOptions.openai.reasoningEffort).toBeUndefined();
});

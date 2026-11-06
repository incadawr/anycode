import { expect, it } from "vitest";
import { getBuiltinCatalog } from "./catalog-data.js";
import { reasoningReplaySource } from "./model-port.js";
import { openCodeGoModelIds, resolveOpenCodeGoEndpointPolicy } from "./opencode-go-policy.js";
import { toSdkMessages } from "./sdk-mapping.js";
const config = { transport: "anthropic-messages" as const, baseUrl: "https://fixture.invalid", model: "m", apiKey: "fake" };

it("replays every current and retired reasoning catalog model on supported message transports", () => {
  for (const entry of getBuiltinCatalog().providers) {
    expect(entry.preserveReasoning, entry.id).toBeUndefined(); // No confirmed exceptions.
    for (const model of [...entry.models, ...(entry.retiredModels ?? [])].filter(m => m.reasoning || m.effortLevels?.length)) {
      for (const transport of entry.supportedTransports) {
        const endpoint = { ...config, transport, providerName: entry.name, model: model.id };
        const route = reasoningReplaySource(endpoint);
        expect(route, `${entry.id}/${model.id}/${transport}`).toBeDefined();
        expect(reasoningReplaySource({ ...endpoint, preserveReasoning: true })).toBeDefined();
      }
    }
  }
});

it("covers every reasoning Go model through both doors, including factual mode and opt-outs", () => {
  for (const providerId of ["opencode", "opencode-openai"]) {
    for (const model of openCodeGoModelIds(providerId)) {
      const result = resolveOpenCodeGoEndpointPolicy(providerId, model);
      if (result.kind !== "route" || !result.route.policy.capabilities?.reasoning?.supported) continue;
      const { transport, baseUrl, policy } = result.route;
      const endpoint = { ...config, transport, baseUrl, model, goModelPolicy: policy };
      if (transport === "openai-responses") {
        expect(reasoningReplaySource(endpoint)).toBeDefined();
        expect(reasoningReplaySource({ ...endpoint, reasoningHistory: "factual_500" })).toBeUndefined();
        continue;
      }
      expect(reasoningReplaySource(endpoint), `${providerId}/${model}`).toBeDefined();
      expect(reasoningReplaySource({ ...endpoint, preserveReasoning: false })).toBeUndefined();
      expect(reasoningReplaySource({ ...endpoint, reasoningHistory: "none" })).toBeUndefined();
      expect(reasoningReplaySource({ ...endpoint, reasoningHistory: "factual_500" })).toMatchObject({ replayFactual: true });
    }
  }
});

it("defaults custom routes on and only returns recorded reasoning to the same route", () => {
  const source = reasoningReplaySource(config)!;
  const messages = [{ role: "assistant" as const, content: [{ type: "reasoning" as const, text: "private thought", source }] }];
  expect(JSON.stringify(toSdkMessages(messages, config.transport, source))).toContain("private thought");
  for (const change of [{ model: "other" }, { baseUrl: "https://other.invalid" }]) {
    expect(JSON.stringify(toSdkMessages(messages, config.transport, reasoningReplaySource({ ...config, ...change })))).not.toContain("private thought");
  }
  expect(JSON.stringify(toSdkMessages([{ role: "assistant", content: [{ type: "text", text: "answer" }] }], config.transport, source))).not.toContain("thinking");
});

it("replays the factual summary instead of original signed thinking on a Go Messages route", () => {
  const resolved = resolveOpenCodeGoEndpointPolicy("opencode", "minimax-m3");
  if (resolved.kind !== "route") throw Error("missing fixture route");
  const endpoint = { ...config, transport: resolved.route.transport, baseUrl: resolved.route.baseUrl, model: "minimax-m3", goModelPolicy: resolved.route.policy };
  const source = reasoningReplaySource(endpoint)!;
  const messages = [{ role: "assistant" as const, content: [{ type: "reasoning" as const, text: "original thought", source,
    providerMetadata: { anthropic: { signature: "original signature" } }, factualSummary: { text: "Verified facts.", tokenCap: 500, model: "compactor", usage: {} } }] }];
  const factual = JSON.stringify(toSdkMessages(messages, endpoint.transport, reasoningReplaySource({ ...endpoint, reasoningHistory: "factual_500" })));
  expect(factual).toContain("Verified facts.");
  expect(factual).not.toContain("original thought");
  expect(factual).not.toContain("original signature");
  expect(JSON.stringify(toSdkMessages(messages, endpoint.transport, source))).toContain("original thought");
});

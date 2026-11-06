import { expect, it } from "vitest";
import { migrateModelOverrides, modelReasoningReplay } from "./model-overrides.js";
import { AiSdkModelPort } from "@anycode/core";

it("resolves replay again on model changes and preserves the shell override", () => {
  const connection = { id: "c", providerId: "anthropic", model: "a", modelOverrides: { a: { preserveReasoning: false }, b: { preserveReasoning: true } } };
  for (const [model, expected] of [["a", false], ["b", true], ["other", undefined]] as const) {
    const replay = modelReasoningReplay(connection, model);
    expect(replay).toBe(expected);
    expect(modelReasoningReplay(connection, model, true)).toBe(true);
    expect(modelReasoningReplay(connection, model, false)).toBe(false);
    const source = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl: "https://fixture.invalid", model, apiKey: "fake", providerName: "Anthropic", preserveReasoning: replay }).reasoningReplaySource();
    expect(source !== undefined).toBe(expected !== false);
  }
});

it("does not overwrite model preferences or apply unbound legacy choices to other models", () => {
  const migrated = migrateModelOverrides({ id: "c", providerId: "anthropic", model: "a", preserveReasoning: false, modelOverrides: { a: { preserveReasoning: true } } });
  expect(migrated.modelOverrides?.a?.preserveReasoning).toBe(true);
  expect(migrated.preserveReasoning).toBeUndefined();
  expect(modelReasoningReplay({ model: "a", preserveReasoning: false }, "b")).toBeUndefined();
});

it("honors explicit replay overrides and enables Go message routes in Auto", async () => {
  const { resolveOpenCodeGoEndpointPolicy } = await import("@anycode/core/opencode-go");
  for (const model of ["minimax-m3", "deepseek-v4.1-flash"]) {
    const resolved = resolveOpenCodeGoEndpointPolicy("opencode", model);
    if (resolved.kind !== "route") throw Error("missing fixture route");
    const config = { transport: resolved.route.transport, baseUrl: resolved.route.baseUrl, apiKey: "fake", model, goModelPolicy: resolved.route.policy };
    expect(new AiSdkModelPort({ ...config, preserveReasoning: true }).reasoningReplaySource("high")).toBeDefined();
    expect(new AiSdkModelPort({ ...config, preserveReasoning: false }).reasoningReplaySource("high")).toBeUndefined();
    expect(new AiSdkModelPort(config).reasoningReplaySource("high") !== undefined).toBe(true);
  }
});

it("restores Auto rejection only for the matching endpoint while retaining explicit provenance", async () => {
  const { modelReplayPolicy } = await import("./model-overrides.js");
  const connection = { model: "a", modelOverrides: { a: { reasoningReplayRejection: { reason: "provider-rejected" as const, baseUrl: "https://fixture.invalid" } } } };
  const config = { transport: "openai-chat-completions" as const, baseUrl: "https://fixture.invalid", model: "a", apiKey: "fake" };
  const policy = modelReplayPolicy(connection, "a", config.baseUrl);
  expect(policy.preserveReasoning).toBeUndefined();
  expect(new AiSdkModelPort({ ...config, ...policy }).reasoningReplaySource()).toBeUndefined();
  for (const [model, baseUrl] of [["a", "https://changed.invalid"], ["b", config.baseUrl]]) {
    expect(modelReplayPolicy(connection, model!, baseUrl!).reasoningReplayRejected).toBe(false);
  }
  for (const value of [true, false]) {
    const port = new AiSdkModelPort({ ...config, ...modelReplayPolicy(connection, "a", config.baseUrl, value) });
    expect(!!port.reasoningReplaySource()).toBe(value);
  }
});

it("looks up rejection after resolving the selected model's automatic endpoint", async () => {
  const { applyAutomaticModelRoute } = await import("@anycode/core");
  const { modelReplayPolicy } = await import("./model-overrides.js");
  const endpoint = applyAutomaticModelRoute({ transport: "anthropic-messages", baseUrl: "https://boot.invalid", model: "kimi-k3", apiKey: "fake", providerId: "opencode", automaticModelRouting: true });
  const connection = { model: "other", modelOverrides: { "kimi-k3": { reasoningReplayRejection: { reason: "provider-rejected" as const, baseUrl: endpoint.baseUrl } } } };
  expect(modelReplayPolicy(connection, endpoint.model, endpoint.baseUrl).reasoningReplayRejected).toBe(true);
  expect(modelReplayPolicy(connection, endpoint.model, "https://boot.invalid").reasoningReplayRejected).toBe(false);
});

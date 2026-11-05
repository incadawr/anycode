import { describe, expect, it } from "vitest";
import { OPENCODE_GO_MODELS } from "./opencode-go.js";
import { resolveModelRoute } from "./model-route.js";

describe("OpenCode Go static snapshot", () => {
  it("contains exactly the supported routes and excludes Gemini", () => {
    const models = Object.values(OPENCODE_GO_MODELS.models);
    expect(models).toHaveLength(28);
    expect(models.filter((e) => e.route.transport === "anthropic-messages")).toHaveLength(5);
    expect(models.filter((e) => e.route.transport === "openai-chat-completions")).toHaveLength(18);
    expect(models.filter((e) => e.route.transport === "openai-responses")).toHaveLength(5);
    expect(resolveModelRoute<unknown>("opencode", "gemini-4-argon", OPENCODE_GO_MODELS)).toMatchObject({ reason: "unknown-model" });
    for (const [id, entry] of Object.entries(OPENCODE_GO_MODELS.models)) expect(resolveModelRoute<unknown>("opencode", id, OPENCODE_GO_MODELS)).toEqual(entry);
    expect(OPENCODE_GO_MODELS.models["kimi-k2.7-code"].route.metadata.limit).not.toHaveProperty("output");
  });
});

import { describe, expect, it } from "vitest";
import { OPENCODE_GO_OPENAI_URL, describeModelRouteRefusal, resolveModelRoute, type ModelRouteSnapshot } from "./model-route.js";

const snapshot: ModelRouteSnapshot<{ context: number }> = {
  version: 1,
  models: {
    example: { kind: "route", route: { transport: "openai-responses", baseUrl: OPENCODE_GO_OPENAI_URL, metadata: { context: 42 } } },
    excluded: { kind: "refusal", reason: "unsupported-model" },
    invalid: { kind: "route", route: { transport: "anthropic-messages", baseUrl: OPENCODE_GO_OPENAI_URL, metadata: { context: 1 } } },
  },
};

describe("model route", () => {
  it("returns the exact route and metadata for either Go identity", () => {
    for (const provider of ["opencode", "opencode-openai"]) {
      expect(resolveModelRoute(provider, "example", snapshot)).toEqual(snapshot.models.example);
    }
  });
  it("refuses unknown providers, models, explicit refusals and mismatched endpoints", () => {
    expect(resolveModelRoute("other", "example", snapshot)).toMatchObject({ reason: "unsupported-provider" });
    expect(resolveModelRoute("opencode", "Example", snapshot)).toMatchObject({ reason: "unknown-model" });
    expect(resolveModelRoute("opencode", "excluded", snapshot)).toMatchObject({ reason: "unsupported-model" });
    expect(resolveModelRoute("opencode", "invalid", snapshot)).toMatchObject({ reason: "invalid-route" });
    expect(resolveModelRoute("opencode", "__proto__", snapshot)).toMatchObject({ reason: "unknown-model" });
  });
});

it("describes each refusal in readable language", () => {
  expect(describeModelRouteRefusal("unknown-model")).toContain("model list");
  expect(describeModelRouteRefusal("unsupported-model")).toContain("not supported");
  expect(describeModelRouteRefusal("invalid-route")).toContain("invalid route");
  expect(describeModelRouteRefusal("unsupported-provider")).toContain("not an OpenCode Go connection");
});

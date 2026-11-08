import { expect, it } from "vitest";
import { OPENCODE_GO_OPENAI_URL, type ModelRouteSnapshot } from "@anycode/core/model-route";
import { resolveGoBootModel } from "./go-boot-model.js";

const snapshot: ModelRouteSnapshot<Record<string, unknown>> = { version: 1, models: {
  excluded: { kind: "refusal", reason: "unsupported-model" },
  alternate: { kind: "route", route: { transport: "openai-responses", baseUrl: OPENCODE_GO_OPENAI_URL, metadata: {} } },
} };

it("recovers a refused model and keeps supported selections", () => {
  const result = resolveGoBootModel("opencode", "gemini-4-argon");
  expect(result.model).toBe("minimax-m3.1-flash");
  expect(result.notice).toContain("gemini-4-argon");
  expect(result.notice).toContain("minimax-m3.1-flash");
  expect(result.notice).not.toMatch(/\((unsupported|unknown)-model\)|invalid-route/);
  expect(resolveGoBootModel("opencode", "kimi-k3")).toEqual({ model: "kimi-k3" });
});

it("uses the first routable snapshot model or reports an empty list", () => {
  expect(resolveGoBootModel("opencode", "excluded", snapshot).model).toBe("alternate");
  expect(() => resolveGoBootModel("opencode", "excluded", { version: 1, models: { excluded: snapshot.models.excluded! } })).toThrow("no available models");
});

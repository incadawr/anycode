import { expect, it } from "vitest";
import { resolveGoBootModel } from "./go-boot-model.js";

it("recovers a refused saved model and keeps supported selections", () => {
  expect(resolveGoBootModel("opencode", "gemini-4-argon", "kimi-k3")).toMatchObject({ model: "kimi-k3", notice: expect.stringContaining("gemini-4-argon") });
  expect(resolveGoBootModel("opencode", "kimi-k3", "glm-5.3")).toEqual({ model: "kimi-k3" });
});

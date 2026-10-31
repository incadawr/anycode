import { describe, expect, it } from "vitest";
import { findKnownModel, normalizeModelId } from "./model-dictionary.js";

describe("model dictionary", () => {
  it("recognizes deployment decorations without losing model variants", () => {
    expect(normalizeModelId("vendor/GLM-5.3-FP8-instruct")).toBe("glm-5.3");
    expect(findKnownModel("vendor/glm-5.3-fp8")?.id).toBe("glm-5.3");
    expect(findKnownModel("vendor/glm-5.3-flash-int4")?.id).toBe("glm-5.3-flash");
    expect(findKnownModel("minimax-m3.1-flash-local")?.id).toBe("MiniMax-M3.1-Flash");
  });
  it("does not confuse unrelated or unknown variants", () => {
    expect(findKnownModel("glm-5.3-flash-unknown")).toBeUndefined();
    expect(findKnownModel("glm-5.3-flashx-extra")).toBeUndefined();
    expect(findKnownModel("company/glm-5.30-fp8")).toBeUndefined();
  });
});

it("supplies defaults without prices and respects opt-out and provider boundaries", async () => {
  const { modelDictionaryEntry } = await import("./model-dictionary.js");
  const { resolveImageInput, resolveMaxOutputTokens } = await import("./capabilities.js");
  const id = "vendor/glm-5.3-flash-fp8";
  const entry = modelDictionaryEntry(id, undefined);
  expect(resolveImageInput(id, entry, undefined)).toBe(true);
  expect(resolveImageInput(id, entry, "off")).toBe(false);
  expect(resolveMaxOutputTokens(id, entry, undefined)).toBe(131_072);
  expect(entry?.models[0]?.pricing).toBeUndefined();
  expect(modelDictionaryEntry(id, undefined, true)).toBeUndefined();
});

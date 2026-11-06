import { expect, it } from "vitest";
import { applyGoRequestLimits } from "./go-request-limits.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
const port = (goLimits: ModelPort["goLimits"]): ModelPort => ({ goLimits, async *streamText() {} });
const request: ModelRequest = { system: "abc", messages: [{ role: "user", content: "hello" }], tools: [], maxOutputTokens: 500000 };
it("clamps context overrides and output ceilings independently of input", () => {
  expect(applyGoRequestLimits({ ...request, contextWindowTokens: 2000000 }, port({ context: 1050000, input: 900000, output: 128000 })).maxOutputTokens).toBe(128000);
  expect(applyGoRequestLimits(request, port({ context: 500000, input: 300000, output: 500000 })).maxOutputTokens).toBeLessThan(500000);
  expect(applyGoRequestLimits({ ...request, maxOutputTokens: 1000 }, port({ context: 1050000, output: 65536 })).maxOutputTokens).toBe(1000);
});
it("rejects an over-limit input before a request can be sent", () => {
  expect(() => applyGoRequestLimits({ ...request, system: "x".repeat(1000) }, port({ context: 10000, input: 100, output: 1000 }))).toThrow(/exceeds the provider input limit/);
});

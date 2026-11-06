import { expect, it } from "vitest";
import { goRequestOutputBudget } from "./go-output-budget.js";
import { HeuristicTokenizer } from "../context/tokenizer.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
const tokenizer = new HeuristicTokenizer();
const request = (text: string): ModelRequest => ({ messages: [{ role: "user", content: text }], tools: [], maxOutputTokens: 500000 });
const port = (limits?: ModelPort["goLimits"]): ModelPort => ({ goLimits: limits, async *streamText() {} });
it("reserves estimated prompt room in a window equal to its output ceiling", () => {
  const go = port({ context: 500000, output: 500000 });
  expect(goRequestOutputBudget(request("abc"), go, tokenizer)).toBe(498974);
  expect(goRequestOutputBudget(request("x".repeat(1_400_000)), go, tokenizer)).toBe(38976);
});
it("uses context, not input limit, for the window and honors a lower request", () => {
  const go = port({ context: 500000, input: 300000, output: 500000 });
  expect(goRequestOutputBudget({ ...request("abc"), maxOutputTokens: 1000 }, go, tokenizer)).toBe(1000);
  expect(goRequestOutputBudget(request("abc"), go, tokenizer)).toBe(498974);
});
it("leaves non-Go requests alone", () => expect(goRequestOutputBudget(request("abc"), port(), tokenizer)).toBe(500000));
it("clamps an explicit output to the Go ceiling as well as available context", () => {
  const go = port({ context: 1_050_000, output: 128_000 });
  expect(goRequestOutputBudget(request("abc"), go, tokenizer)).toBe(128_000);
  expect(goRequestOutputBudget(request("abc"), go, tokenizer, 50_000)).toBe(48_974);
});

it.each([
  [0, 100, 10000, 1], [1, 100, 10000, 1], [-1, 100, 10000, 1],
  [100, 0, 10000, 1], [100, 1, 10000, 1],
  [100, 100, 1027, 1], [100, 100, 1026, 1], [100, 100, 1, 1],
  [100, 100, 1126, 100], [0, 100, 0, 1],
])("floors Go output (request %i, ceiling %i, context %i) at one", (requested, output, context, expected) => {
  expect(goRequestOutputBudget({ ...request("abc"), maxOutputTokens: requested }, port({ context, output }), tokenizer)).toBe(expected);
});

it("floors Go output even before context limits are known", () => {
  expect(goRequestOutputBudget({ ...request("abc"), maxOutputTokens: 0 }, port({ output: 100 }), tokenizer)).toBe(1);
});

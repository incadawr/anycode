/**
 * Tokenizer contract (design §2.5, task 1.2): the heuristic fallback and the
 * lazily-loaded default tokenizer, including the import-failure fallback and the
 * per-call guard against gpt-tokenizer's special-token throws.
 */

import { describe, expect, it } from "vitest";
import { HeuristicTokenizer, createDefaultTokenizer } from "./tokenizer.js";

describe("HeuristicTokenizer", () => {
  it("returns 0 for empty text", () => {
    expect(new HeuristicTokenizer().count("")).toBe(0);
  });

  it("double-weights CJK glyphs relative to Latin characters", () => {
    const tok = new HeuristicTokenizer();
    // Equal character counts, but CJK weighs ~2x, so it estimates more tokens.
    const latin = tok.count("abcdefghij");
    const cjk = tok.count("你好世界你好世界你好");
    expect(cjk).toBeGreaterThan(latin);
  });
});

describe("createDefaultTokenizer", () => {
  it("loads gpt-tokenizer and counts real tokens (o200k_base)", async () => {
    const tokenizer = await createDefaultTokenizer();
    expect(tokenizer.count("")).toBe(0);
    // "hello world" is 2 o200k tokens — a value the heuristic would not produce
    // for this string, proving the real encoder is wired up.
    expect(tokenizer.count("hello world")).toBe(2);
  });

  it("guards per-call: special-token sequences fall back instead of throwing", async () => {
    const tokenizer = await createDefaultTokenizer();
    // gpt-tokenizer throws on raw special tokens; the wrapper must not propagate it.
    expect(() => tokenizer.count("<|endoftext|>")).not.toThrow();
    expect(tokenizer.count("<|endoftext|>")).toBeGreaterThan(0);
  });

  it("falls back to the heuristic when the module import fails", async () => {
    const tokenizer = await createDefaultTokenizer(() => Promise.reject(new Error("no module")));
    const heuristic = new HeuristicTokenizer();
    // Identical behavior to the heuristic proves the fallback path was taken.
    expect(tokenizer.count("hello world")).toBe(heuristic.count("hello world"));
    expect(tokenizer.count("")).toBe(0);
  });

  it("falls back to the heuristic when the module lacks a usable counter", async () => {
    const tokenizer = await createDefaultTokenizer(() => Promise.resolve({}));
    const heuristic = new HeuristicTokenizer();
    expect(tokenizer.count("some text here")).toBe(heuristic.count("some text here"));
  });

  it("uses encode().length when countTokens is unavailable", async () => {
    const tokenizer = await createDefaultTokenizer(() =>
      Promise.resolve({ encode: (input: string) => input.split(" ") }),
    );
    expect(tokenizer.count("a b c d")).toBe(4);
    expect(tokenizer.count("")).toBe(0);
  });
});

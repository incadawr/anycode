/**
 * Explicit base-URL policy tests (TASK.43 §0.5). The OpenAI transports take the
 * base URL EXACTLY as configured (trim + strip trailing slashes, reject empty)
 * and never append `/v1` — appending it would make valid non-standard prefixes
 * (`https://gw.example/api/openai`) unexpressible. The Anthropic normalizer keeps
 * its legacy `/v1` suffixing; the contrast is asserted here so a future
 * "unification" of the two cannot pass silently.
 */

import { describe, expect, it } from "vitest";
import { normalizeAnthropicBaseUrl } from "./anthropic.js";
import { normalizeExplicitBaseUrl } from "./endpoint.js";

describe("normalizeExplicitBaseUrl", () => {
  it("keeps an explicit /v1 prefix untouched", () => {
    expect(normalizeExplicitBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });

  it("never appends /v1 (the caller owns the full prefix)", () => {
    expect(normalizeExplicitBaseUrl("https://api.openai.com")).toBe("https://api.openai.com");
    expect(normalizeExplicitBaseUrl("http://localhost:8000")).toBe("http://localhost:8000");
  });

  it("preserves a non-standard path prefix verbatim", () => {
    expect(normalizeExplicitBaseUrl("https://gw.example/api/openai")).toBe("https://gw.example/api/openai");
  });

  it("trims whitespace and strips trailing slashes", () => {
    expect(normalizeExplicitBaseUrl("  https://openrouter.ai/api/v1/  ")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeExplicitBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434");
  });

  it("rejects an empty / whitespace-only base URL", () => {
    expect(() => normalizeExplicitBaseUrl("")).toThrow(/empty/i);
    expect(() => normalizeExplicitBaseUrl("   ")).toThrow(/empty/i);
  });

  it("differs from the Anthropic normalizer exactly in the /v1 suffixing", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic")).toBe("https://api.z.ai/api/anthropic/v1");
    expect(normalizeExplicitBaseUrl("https://api.z.ai/api/anthropic")).toBe("https://api.z.ai/api/anthropic");
  });
});

/**
 * Tests for the Anthropic-compatible endpoint wrapper: base URL normalization
 * and the dual-auth header shim. No network access; pure string/object logic.
 */

import { describe, expect, it } from "vitest";
import { buildDualAuthHeaders, normalizeAnthropicBaseUrl } from "./anthropic.js";

describe("normalizeAnthropicBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1",
    );
  });

  it("is idempotent when /v1 is already present", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic/v1")).toBe(
      "https://api.z.ai/api/anthropic/v1",
    );
  });

  it("appends /v1 for an Anthropic-compatible proxy path", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic")).toBe(
      "https://api.z.ai/api/anthropic/v1",
    );
  });

  it("strips a single trailing slash before checking for /v1", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic/")).toBe(
      "https://api.z.ai/api/anthropic/v1",
    );
  });

  it("strips trailing slashes even when /v1 is already present", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic/v1/")).toBe(
      "https://api.z.ai/api/anthropic/v1",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeAnthropicBaseUrl("https://api.z.ai/api/anthropic///")).toBe(
      "https://api.z.ai/api/anthropic/v1",
    );
  });

  it("normalizes a bare host with a single trailing slash", () => {
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com/v1",
    );
  });

  it("throws a descriptive error for an empty or blank base URL", () => {
    expect(() => normalizeAnthropicBaseUrl("")).toThrow(/base url/i);
    expect(() => normalizeAnthropicBaseUrl("   ")).toThrow(/base url/i);
  });

  it("does not throw for a malformed (schemeless) URL — best-effort string normalization", () => {
    expect(normalizeAnthropicBaseUrl("not-a-real-url")).toBe("not-a-real-url/v1");
  });
});

describe("buildDualAuthHeaders", () => {
  it("adds a Bearer Authorization header alongside the SDK-native x-api-key", () => {
    const headers = buildDualAuthHeaders("sk-test-123");
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
  });

  it("does not set x-api-key itself (the SDK sends it natively)", () => {
    const headers = buildDualAuthHeaders("sk-test-123");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("preserves an existing Authorization header from extraHeaders untouched", () => {
    const headers = buildDualAuthHeaders("sk-test-123", { Authorization: "Bearer custom-token" });
    expect(headers["Authorization"]).toBe("Bearer custom-token");
  });

  it("preserves an existing Authorization header regardless of casing", () => {
    const headers = buildDualAuthHeaders("sk-test-123", { authorization: "Bearer custom-token" });
    expect(headers["authorization"]).toBe("Bearer custom-token");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("merges other extra headers alongside the dual-auth default", () => {
    const headers = buildDualAuthHeaders("sk-test-123", { "X-Custom": "value" });
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(headers["X-Custom"]).toBe("value");
  });
});

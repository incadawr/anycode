/** Tests for ANYCODE_* environment loading: required vars, defaults, and error messages. */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_CONTEXT_WINDOW,
  ENV_DB_PATH,
  ENV_IMAGE_INPUT,
  ENV_MAX_RETRIES,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_REASONING_EFFORT,
  ENV_MAX_TURNS,
  ENV_MODEL,
  ENV_STALL_TIMEOUT_MS,
  ENV_TOOL_CONCURRENCY,
  loadEnvConfig,
} from "./env.js";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("loadEnvConfig", () => {
  it("loads all values when fully specified", () => {
    const config = loadEnvConfig(
      envWith({
        [ENV_API_KEY]: "key-123",
        [ENV_BASE_URL]: "https://example.com/api",
        [ENV_MODEL]: "claude-x",
        [ENV_MAX_TURNS]: "10",
      }),
    );
    expect(config).toEqual({
      apiKey: "key-123",
      baseUrl: "https://example.com/api",
      model: "claude-x",
      maxTurns: 10,
    });
  });

  it("defaults baseUrl to the native Anthropic API when unset", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("leaves maxTurns undefined when ANYCODE_MAX_TURNS is unset", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.maxTurns).toBeUndefined();
  });

  it("throws naming ANYCODE_API_KEY when missing", () => {
    expect(() => loadEnvConfig(envWith({ [ENV_MODEL]: "claude-x" }))).toThrow(/ANYCODE_API_KEY/);
  });

  it("throws naming ANYCODE_MODEL when missing", () => {
    expect(() => loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123" }))).toThrow(/ANYCODE_MODEL/);
  });

  it("rejects an empty-string API key as missing", () => {
    expect(() => loadEnvConfig(envWith({ [ENV_API_KEY]: "", [ENV_MODEL]: "claude-x" }))).toThrow(
      /ANYCODE_API_KEY/,
    );
  });

  it("rejects an empty-string model as missing", () => {
    expect(() => loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "" }))).toThrow(
      /ANYCODE_MODEL/,
    );
  });

  it("throws naming ANYCODE_MAX_TURNS on a non-integer value", () => {
    expect(() =>
      loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_MAX_TURNS]: "not-a-number",
        }),
      ),
    ).toThrow(/ANYCODE_MAX_TURNS/);
  });

  it("parses a valid ANYCODE_MAX_TURNS integer", () => {
    const config = loadEnvConfig(
      envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x", [ENV_MAX_TURNS]: "5" }),
    );
    expect(config.maxTurns).toBe(5);
  });

  it("parses max output tokens and reasoning effort", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_MAX_OUTPUT_TOKENS]: "32768", [ENV_REASONING_EFFORT]: "high" }));
    expect(config.maxOutputTokens).toBe(32_768);
    expect(config.reasoningEffort).toBe("high");
  });

  it("accepts max reasoning effort (gated per model downstream)", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_REASONING_EFFORT]: "max" }));
    expect(config.reasoningEffort).toBe("max");
  });

  it("warns and ignores invalid reasoning effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_REASONING_EFFORT]: "xhigh" })).reasoningEffort).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ENV_REASONING_EFFORT));
    warn.mockRestore();
  });

  it("leaves the Phase 1 optionals undefined when unset", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.contextWindowTokens).toBeUndefined();
    expect(config.maxRetries).toBeUndefined();
    expect(config.dbPath).toBeUndefined();
  });

  it("leaves toolConcurrency/stallTimeoutMs undefined when unset (slice 2.3, tail 4)", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.toolConcurrency).toBeUndefined();
    expect(config.stallTimeoutMs).toBeUndefined();
  });

  it("parses ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS", () => {
    const config = loadEnvConfig(
      envWith({
        [ENV_API_KEY]: "key-123",
        [ENV_MODEL]: "claude-x",
        [ENV_TOOL_CONCURRENCY]: "1",
        [ENV_STALL_TIMEOUT_MS]: "0",
      }),
    );
    expect(config.toolConcurrency).toBe(1);
    expect(config.stallTimeoutMs).toBe(0);
  });

  it("throws naming ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS on non-integer values", () => {
    expect(() =>
      loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_TOOL_CONCURRENCY]: "not-a-number",
        }),
      ),
    ).toThrow(/ANYCODE_TOOL_CONCURRENCY/);
    expect(() =>
      loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_STALL_TIMEOUT_MS]: "2.5",
        }),
      ),
    ).toThrow(/ANYCODE_STALL_TIMEOUT_MS/);
  });

  it("parses ANYCODE_CONTEXT_WINDOW / ANYCODE_MAX_RETRIES / ANYCODE_DB_PATH", () => {
    const config = loadEnvConfig(
      envWith({
        [ENV_API_KEY]: "key-123",
        [ENV_MODEL]: "claude-x",
        [ENV_CONTEXT_WINDOW]: "8000",
        [ENV_MAX_RETRIES]: "0",
        [ENV_DB_PATH]: "/tmp/anycode-test.sqlite",
      }),
    );
    expect(config.contextWindowTokens).toBe(8000);
    expect(config.maxRetries).toBe(0);
    expect(config.dbPath).toBe("/tmp/anycode-test.sqlite");
  });

  it("leaves imageInput undefined when ANYCODE_IMAGE_INPUT is unset (slice 6.2)", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.imageInput).toBeUndefined();
  });

  it("parses ANYCODE_IMAGE_INPUT=on / off (slice 6.2)", () => {
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_IMAGE_INPUT]: "on" })).imageInput,
    ).toBe("on");
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_IMAGE_INPUT]: "off" })).imageInput,
    ).toBe("off");
  });

  it("warns and leaves imageInput undefined on an invalid ANYCODE_IMAGE_INPUT (no throw, slice 6.2)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadEnvConfig(
        envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_IMAGE_INPUT]: "yes" }),
      );
      expect(config.imageInput).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(ENV_IMAGE_INPUT));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an empty ANYCODE_IMAGE_INPUT as unset without warning (slice 6.2)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadEnvConfig(
        envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_IMAGE_INPUT]: "  " }),
      );
      expect(config.imageInput).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws naming the offending variable on non-integer Phase 1 optionals", () => {
    expect(() =>
      loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_CONTEXT_WINDOW]: "many",
        }),
      ),
    ).toThrow(/ANYCODE_CONTEXT_WINDOW/);
    expect(() =>
      loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_MAX_RETRIES]: "1.5",
        }),
      ),
    ).toThrow(/ANYCODE_MAX_RETRIES/);
  });
});

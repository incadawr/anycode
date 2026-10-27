/** Tests for ANYCODE_* environment loading: required vars, defaults, and error messages. */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_CONTEXT_WINDOW,
  ENV_CONTEXT_WINDOW_MODEL,
  ENV_DB_PATH,
  ENV_EXPLORE_MODEL,
  ENV_IMAGE_INPUT,
  ENV_MAX_RETRIES,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_NETWORK_RETRY_BUDGET_MS,
  ENV_NETWORK_WAIT_MAX_MS,
  ENV_PROVIDER_TRANSPORT,
  ENV_REASONING_EFFORT,
  ENV_PROMPT_CACHE_OPTIONS,
  ENV_ADAPTIVE_TURN_BUDGET,
  ENV_INCLUDE_USAGE,
  ENV_MAX_TURNS,
  ENV_MODEL,
  ENV_STALL_TIMEOUT_MS,
  ENV_TODO_REMINDER_EVERY,
  ENV_SUPERVISOR_IDLE_MS,
  ENV_TOOL_CONCURRENCY,
  loadEnvConfig,
  parseImageInputModelOverride,
  readPromptCacheOptions,
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

  it("ANYCODE_SUPERVISOR_IDLE_MS (taskana 4181): valid integer passes through; non-integer and nonpositive both throw naming the knob", () => {
    const base = { [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" } as const;
    expect(loadEnvConfig(envWith({ ...base, [ENV_SUPERVISOR_IDLE_MS]: "600000" })).supervisorIdleMs).toBe(600_000);
    expect(() => loadEnvConfig(envWith({ ...base, [ENV_SUPERVISOR_IDLE_MS]: "soon" }))).toThrow(
      /ANYCODE_SUPERVISOR_IDLE_MS/,
    );
    // P4: a nonpositive value would clamp to an immediate-fire reminder loop.
    expect(() => loadEnvConfig(envWith({ ...base, [ENV_SUPERVISOR_IDLE_MS]: "-5" }))).toThrow(
      /ANYCODE_SUPERVISOR_IDLE_MS/,
    );
    expect(() => loadEnvConfig(envWith({ ...base, [ENV_SUPERVISOR_IDLE_MS]: "0" }))).toThrow(
      /ANYCODE_SUPERVISOR_IDLE_MS/,
    );
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

  it("parses ANYCODE_TODO_REMINDER_EVERY (Taskana 4665)", () => {
    const config = loadEnvConfig(
      envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_TODO_REMINDER_EVERY]: "7" }),
    );
    expect(config.todoReminderEvery).toBe(7);
  });

  it("leaves todoReminderEvery undefined when ANYCODE_TODO_REMINDER_EVERY is unset", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m" }));
    expect(config.todoReminderEvery).toBeUndefined();
  });

  it("throws naming ANYCODE_TODO_REMINDER_EVERY on a non-integer value", () => {
    expect(() =>
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_TODO_REMINDER_EVERY]: "abc" })),
    ).toThrow(/ANYCODE_TODO_REMINDER_EVERY/);
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

  it("ANYCODE_NETWORK_RETRY_BUDGET_MS (Taskana 4705): valid integer passes through; absent → undefined; non-integer throws naming the knob", () => {
    const base = { [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" } as const;
    expect(loadEnvConfig(envWith({ ...base, [ENV_NETWORK_RETRY_BUDGET_MS]: "90000" })).networkRetryBudgetMs).toBe(
      90_000,
    );
    expect(loadEnvConfig(envWith({ ...base })).networkRetryBudgetMs).toBeUndefined();
    expect(() => loadEnvConfig(envWith({ ...base, [ENV_NETWORK_RETRY_BUDGET_MS]: "soon" }))).toThrow(
      /ANYCODE_NETWORK_RETRY_BUDGET_MS/,
    );
  });

  it("ANYCODE_NETWORK_WAIT_MAX_MS (Taskana 4772): valid integer passes through; absent → undefined; non-integer throws naming the knob", () => {
    const base = { [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" } as const;
    expect(loadEnvConfig(envWith({ ...base, [ENV_NETWORK_WAIT_MAX_MS]: "600000" })).networkWaitMaxMs).toBe(600_000);
    expect(loadEnvConfig(envWith({ ...base })).networkWaitMaxMs).toBeUndefined();
    expect(() => loadEnvConfig(envWith({ ...base, [ENV_NETWORK_WAIT_MAX_MS]: "soon" }))).toThrow(
      /ANYCODE_NETWORK_WAIT_MAX_MS/,
    );
  });

  it("parses ANYCODE_CONTEXT_WINDOW_MODEL as an optional string, trimmed (TASK.142)", () => {
    const config = loadEnvConfig(
      envWith({
        [ENV_API_KEY]: "key-123",
        [ENV_MODEL]: "claude-x",
        [ENV_CONTEXT_WINDOW]: "8000",
        [ENV_CONTEXT_WINDOW_MODEL]: "  on-prem-8b  ",
      }),
    );
    expect(config.contextWindowModel).toBe("on-prem-8b");
  });

  it("leaves contextWindowModel undefined when the binding is absent or blank, without throwing", () => {
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m" })).contextWindowModel,
    ).toBeUndefined();
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_CONTEXT_WINDOW_MODEL]: "   " }))
        .contextWindowModel,
    ).toBeUndefined();
    // A blank binding must not change the value's own parse either.
    expect(
      loadEnvConfig(
        envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_CONTEXT_WINDOW]: "4096", [ENV_CONTEXT_WINDOW_MODEL]: "" }),
      ).contextWindowTokens,
    ).toBe(4096);
  });

  it("leaves imageInput undefined when ANYCODE_IMAGE_INPUT is unset (slice 6.2)", () => {
    const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
    expect(config.imageInput).toBeUndefined();
  });

  it("parses ANYCODE_EXPLORE_MODEL as an optional string, trimmed (Taskana 4131)", () => {
    const config = loadEnvConfig(
      envWith({
        [ENV_API_KEY]: "key-123",
        [ENV_MODEL]: "claude-x",
        [ENV_EXPLORE_MODEL]: "glm-5.3-flash",
      }),
    );
    expect(config.exploreModel).toBe("glm-5.3-flash");
  });

  it("leaves exploreModel undefined when ANYCODE_EXPLORE_MODEL is absent or blank (Taskana 4131)", () => {
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m" })).exploreModel,
    ).toBeUndefined();
    expect(
      loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_EXPLORE_MODEL]: "   " }))
        .exploreModel,
    ).toBeUndefined();
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

  // 4088-on-4118: the ANYCODE_IMAGE_INPUT_MODELS parse tests are GONE with the var.

  it("ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE: <on|off>:<model>, model ids may contain ':'; garbage is ignored", () => {
    expect(parseImageInputModelOverride("on:glm-5.3v")).toEqual({ override: "on", model: "glm-5.3v" });
    expect(parseImageInputModelOverride("off:qwen:7b")).toEqual({ override: "off", model: "qwen:7b" });
    for (const raw of [undefined, "", "on", "on:", "maybe:m", ":m"]) {
      expect(parseImageInputModelOverride(raw)).toBeUndefined();
    }
  });

  describe("ANYCODE_ADAPTIVE_TURN_BUDGET (TASK.4721)", () => {
    it("leaves adaptiveTurnBudget undefined when unset (default OFF)", () => {
      const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
      expect(config.adaptiveTurnBudget).toBeUndefined();
    });

    it("parses both vocabularies", () => {
      for (const value of ["1", "true", "on"]) {
        expect(
          loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_ADAPTIVE_TURN_BUDGET]: value }))
            .adaptiveTurnBudget,
        ).toBe(true);
      }
      for (const value of ["0", "false", "off"]) {
        expect(
          loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_ADAPTIVE_TURN_BUDGET]: value }))
            .adaptiveTurnBudget,
        ).toBe(false);
      }
    });
  });

  describe("ANYCODE_INCLUDE_USAGE (TASK.158)", () => {
    it("leaves includeUsage undefined when unset", () => {
      const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
      expect(config.includeUsage).toBeUndefined();
    });

    it("parses the true vocabulary: 1 / true / on", () => {
      for (const value of ["1", "true", "on"]) {
        expect(
          loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_INCLUDE_USAGE]: value }))
            .includeUsage,
        ).toBe(true);
      }
    });

    it("parses the false vocabulary: 0 / false / off", () => {
      for (const value of ["0", "false", "off"]) {
        expect(
          loadEnvConfig(envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_INCLUDE_USAGE]: value }))
            .includeUsage,
        ).toBe(false);
      }
    });

    it("warns and leaves includeUsage undefined on an invalid value (yes — no throw)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const config = loadEnvConfig(
          envWith({ [ENV_API_KEY]: "k", [ENV_MODEL]: "m", [ENV_INCLUDE_USAGE]: "yes" }),
        );
        expect(config.includeUsage).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(ENV_INCLUDE_USAGE));
      } finally {
        warnSpy.mockRestore();
      }
    });
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

  describe("ANYCODE_PROVIDER_TRANSPORT", () => {
    it("leaves providerTransport undefined when unset", () => {
      const config = loadEnvConfig(envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" }));
      expect(config.providerTransport).toBeUndefined();
    });

    it("treats an empty string as unset", () => {
      const config = loadEnvConfig(
        envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x", [ENV_PROVIDER_TRANSPORT]: "  " }),
      );
      expect(config.providerTransport).toBeUndefined();
    });

    it("accepts anthropic-messages", () => {
      const config = loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "claude-x",
          [ENV_PROVIDER_TRANSPORT]: "anthropic-messages",
        }),
      );
      expect(config.providerTransport).toBe("anthropic-messages");
    });

    it("accepts openai-chat-completions without requiring an API key", () => {
      const config = loadEnvConfig(
        envWith({ [ENV_MODEL]: "gpt-x", [ENV_PROVIDER_TRANSPORT]: "openai-chat-completions" }),
      );
      expect(config.providerTransport).toBe("openai-chat-completions");
      expect(config.apiKey).toBeUndefined();
    });

    it("accepts openai-responses without requiring an API key", () => {
      const config = loadEnvConfig(
        envWith({ [ENV_MODEL]: "gpt-x", [ENV_PROVIDER_TRANSPORT]: "openai-responses" }),
      );
      expect(config.providerTransport).toBe("openai-responses");
      expect(config.apiKey).toBeUndefined();
    });

    it("throws on an invalid transport value, naming the variable and the valid values", () => {
      expect(() =>
        loadEnvConfig(
          envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x", [ENV_PROVIDER_TRANSPORT]: "bogus" }),
        ),
      ).toThrow(/ANYCODE_PROVIDER_TRANSPORT/);
    });

    it("rejects a bare \"openai\" transport (not one of the three literals)", () => {
      expect(() =>
        loadEnvConfig(
          envWith({ [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x", [ENV_PROVIDER_TRANSPORT]: "openai" }),
        ),
      ).toThrow(/ANYCODE_PROVIDER_TRANSPORT/);
    });

    it("still requires ANYCODE_API_KEY when the transport is anthropic-messages", () => {
      expect(() =>
        loadEnvConfig(
          envWith({ [ENV_MODEL]: "claude-x", [ENV_PROVIDER_TRANSPORT]: "anthropic-messages" }),
        ),
      ).toThrow(/ANYCODE_API_KEY/);
    });

    it("still requires ANYCODE_API_KEY when the transport is unset (legacy default)", () => {
      expect(() => loadEnvConfig(envWith({ [ENV_MODEL]: "claude-x" }))).toThrow(/ANYCODE_API_KEY/);
    });

    it("accepts an explicit API key alongside an openai transport", () => {
      const config = loadEnvConfig(
        envWith({
          [ENV_API_KEY]: "key-123",
          [ENV_MODEL]: "gpt-x",
          [ENV_PROVIDER_TRANSPORT]: "openai-chat-completions",
        }),
      );
      expect(config.apiKey).toBe("key-123");
    });
  });
});

describe("ANYCODE_PROMPT_CACHE_OPTIONS (GitHub #15)", () => {
  const base = { [ENV_API_KEY]: "key-123", [ENV_MODEL]: "claude-x" } as const;

  it("leaves promptCache undefined when unset or blank (default Off, never enabled)", () => {
    expect(loadEnvConfig(envWith(base)).promptCache).toBeUndefined();
    expect(loadEnvConfig(envWith({ ...base, [ENV_PROMPT_CACHE_OPTIONS]: "  " })).promptCache).toBeUndefined();
  });

  it("reads a literal off as no override, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadEnvConfig(envWith({ ...base, [ENV_PROMPT_CACHE_OPTIONS]: "off" })).promptCache).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("parses the enabled object with an explicit 30m ttl", () => {
    const config = loadEnvConfig(envWith({ ...base, [ENV_PROMPT_CACHE_OPTIONS]: '{"mode":"implicit","ttl":"30m"}' }));
    expect(config.promptCache).toEqual({ mode: "implicit", ttl: "30m" });
  });

  it("fills an omitted ttl to 30m for hand-authored env", () => {
    expect(readPromptCacheOptions(envWith({ [ENV_PROMPT_CACHE_OPTIONS]: '{"mode":"implicit"}' }))).toEqual({
      mode: "implicit",
      ttl: "30m",
    });
  });

  it("rejects explicit mode, 12h and arbitrary TTLs as invalid", () => {
    for (const raw of [
      '{"mode":"explicit","ttl":"30m"}',
      '{"mode":"implicit","ttl":"12h"}',
      '{"mode":"implicit","ttl":"1h"}',
      '{"mode":"implicit","ttl":"30m","extra":true}',
      '{"mode":"implicit"} extra',
      "not-json",
    ]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(readPromptCacheOptions(envWith({ [ENV_PROMPT_CACHE_OPTIONS]: raw }))).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("never echoes the raw env value in the diagnostic", () => {
    const raw = '{"mode":"explicit","secret":"sk-should-not-leak"}';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readPromptCacheOptions(envWith({ [ENV_PROMPT_CACHE_OPTIONS]: raw }))).toBeUndefined();
      const message = warn.mock.calls[0]![0] as string;
      expect(message).not.toContain("sk-should-not-leak");
      expect(message).toContain(ENV_PROMPT_CACHE_OPTIONS);
    } finally {
      warn.mockRestore();
    }
  });
});

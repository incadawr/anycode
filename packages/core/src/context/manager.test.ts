/**
 * ContextManager (design §2.6, task 1.2): microcompact, provider-authoritative
 * usage estimate, threshold + circuit breaker, and transactional LLM compaction.
 *
 * Central invariant under test (risk R2): the compaction boundary NEVER splits a
 * tool_call / tool_result pair — verified by a property test over randomly
 * generated valid histories — and every failure/abort path leaves the history
 * byte-for-byte unchanged (atomic swap).
 */

import { describe, expect, it } from "vitest";
import { ContextManager, MICROCOMPACT_CLEARED_TEXT } from "./manager.js";
import { ConversationHistory } from "./history.js";
import { HeuristicTokenizer } from "./tokenizer.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  microcompactThresholdTokens,
  type ContextBudgetConfig,
} from "./budget.js";
import { IMAGE_TOKEN_ESTIMATE } from "../types/config.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ChatMessage } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";
import type { ModelStreamEvent } from "../types/events.js";

// ---------------------------------------------------------------------------
// Scripted model ports

/** Yields a fixed script; aborts (throws AbortError) if the linked signal fires. */
class ScriptedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly events: ModelStreamEvent[]) {}
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const { events } = this;
    const signal = request.abortSignal;
    return (async function* () {
      for (const event of events) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
      }
    })();
  }
}

const summaryScript = (text: string): ModelStreamEvent[] => [
  { type: "start" },
  { type: "text_delta", id: "t", text },
  { type: "finish", finishReason: "stop", usage: {} },
];

const errorScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "error", error: new Error("model exploded") },
];

const emptyScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "finish", finishReason: "stop", usage: {} },
];

// ---------------------------------------------------------------------------
// History builders

const LONG_TEXT = "x".repeat(1_200);

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}
function assistantToolCall(id: string, name = "Read"): ChatMessage {
  return { role: "assistant", content: [{ type: "tool_call", toolCallId: id, toolName: name, input: {} }] };
}
function toolResult(id: string, text: string, name = "Read"): ChatMessage {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: id, toolName: name, text, status: "success" }],
  };
}

function buildHistory(messages: ChatMessage[]): ConversationHistory {
  const history = new ConversationHistory({ tokenizer: new HeuristicTokenizer() });
  for (const message of messages) {
    history.append(message);
  }
  return history;
}

function makeManager(
  history: ConversationHistory,
  modelPort: ModelPort,
  configOverrides: Partial<ContextBudgetConfig> = {},
): ContextManager {
  return new ContextManager({
    history,
    tokenizer: new HeuristicTokenizer(),
    modelPort,
    config: { ...DEFAULT_CONTEXT_BUDGET, ...configOverrides },
  });
}

/** Snapshot of history identity + content for "unchanged" assertions. */
function snapshot(history: ConversationHistory): string {
  return JSON.stringify(history.items.map((i) => ({ id: i.id, message: i.message, kind: i.kind })));
}

// ---------------------------------------------------------------------------
// Deterministic random valid-history generation (for the property test)

/** mulberry32 seeded PRNG for reproducible property runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a structurally valid history: a sequence of turns, each = a user
 * message followed by zero or more (assistant tool_call(s), tool result(s))
 * rounds and an optional assistant text message. By construction every
 * tool_call is answered before the next user/assistant message.
 */
function randomValidHistory(random: () => number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let callSeq = 0;
  const turns = 1 + Math.floor(random() * 6);
  for (let t = 0; t < turns; t += 1) {
    messages.push(userMsg(`user turn ${t} ${"q".repeat(1 + Math.floor(random() * 30))}`));
    const rounds = Math.floor(random() * 4);
    for (let r = 0; r < rounds; r += 1) {
      const nCalls = 1 + Math.floor(random() * 2);
      const ids: string[] = [];
      const callParts = [];
      for (let c = 0; c < nCalls; c += 1) {
        const id = `call-${callSeq++}`;
        ids.push(id);
        callParts.push({ type: "tool_call" as const, toolCallId: id, toolName: "Read", input: {} });
      }
      messages.push({ role: "assistant", content: callParts });
      messages.push({
        role: "tool",
        content: ids.map((id) => ({
          type: "tool_result" as const,
          toolCallId: id,
          toolName: "Read",
          text: "r".repeat(1 + Math.floor(random() * 200)),
          status: "success" as const,
        })),
      });
    }
    if (random() < 0.6) {
      messages.push({ role: "assistant", content: [{ type: "text", text: `assistant reply ${t}` }] });
    }
  }
  return messages;
}

/** True when every tool_result in the history has a preceding tool_call for the same id. */
function noOrphanToolResults(history: ConversationHistory): boolean {
  const openCalls = new Set<string>();
  for (const item of history.items) {
    if (item.message.role === "assistant") {
      for (const part of item.message.content) {
        if (part.type === "tool_call") openCalls.add(part.toolCallId);
      }
    } else if (item.message.role === "tool") {
      for (const part of item.message.content) {
        if (!openCalls.has(part.toolCallId)) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------

describe("ContextManager.estimate / noteUsage", () => {
  it("uses the pure local estimate before any provider usage is recorded", () => {
    const history = buildHistory([userMsg("hello there friend")]);
    const manager = makeManager(history, new ScriptedModelPort([]));
    const est = manager.estimate();
    expect(est.source).toBe("estimate");
    expect(est.tokens).toBe(history.totalTokenEstimate());
  });

  it("provider usage overrides the estimate and becomes the baseline", () => {
    const history = buildHistory([userMsg("hello there friend")]);
    const manager = makeManager(history, new ScriptedModelPort([]));

    manager.noteUsage({ inputTokens: 5_000 });
    const afterNote = manager.estimate();
    expect(afterNote.source).toBe("provider");
    expect(afterNote.tokens).toBe(5_000);

    // A new message adds only its estimated delta on top of the provider anchor.
    const item = history.append(userMsg("another message"));
    const afterAppend = manager.estimate();
    expect(afterAppend.source).toBe("provider");
    expect(afterAppend.tokens).toBe(5_000 + (item.tokenEstimate ?? 0));
  });

  it("ignores usage without a numeric inputTokens", () => {
    const history = buildHistory([userMsg("hello")]);
    const manager = makeManager(history, new ScriptedModelPort([]));
    manager.noteUsage({ outputTokens: 42 });
    expect(manager.estimate().source).toBe("estimate");
  });
});

describe("ContextManager.maybeMicrocompact", () => {
  it("keeps a read-heavy low-pressure history untouched across repeated calls", () => {
    const messages: ChatMessage[] = [userMsg("implement the requested slice")];
    for (let i = 0; i < 12; i += 1) {
      messages.push(assistantToolCall(`read-${i}`));
      messages.push(toolResult(`read-${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]));
    const before = snapshot(history);

    expect(manager.estimate().tokens).toBeLessThan(microcompactThresholdTokens(DEFAULT_CONTEXT_BUDGET));
    for (let i = 0; i < 100; i += 1) {
      expect(manager.maybeMicrocompact()).toBeNull();
    }
    expect(snapshot(history)).toBe(before);
  });

  it("clears tool results older than the most recent N and keeps structure intact", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      microcompactKeepRecentToolResults: 5,
      microcompactMinSavingsTokens: 256,
    });
    manager.noteUsage({ inputTokens: 150_000 });

    const before = history.items.length;
    const result = manager.maybeMicrocompact();

    expect(result).not.toBeNull();
    // 8 tool items, keep 5 -> clear the oldest 3.
    expect(result!.clearedToolResults).toBe(3);
    expect(result!.savedTokens).toBeGreaterThanOrEqual(256);

    // No messages deleted; pairs still intact.
    expect(history.items.length).toBe(before);
    expect(history.unansweredToolCallIds()).toEqual([]);

    const toolItems = history.items.filter((i) => i.message.role === "tool");
    const clearedTexts = toolItems.slice(0, 3);
    const keptTexts = toolItems.slice(3);
    for (const item of clearedTexts) {
      expect(item.kind).toBe("microcompact_cleared");
      expect((item.message as { content: Array<{ text: string }> }).content[0]!.text).toBe(
        MICROCOMPACT_CLEARED_TEXT,
      );
    }
    for (const item of keptTexts) {
      expect((item.message as { content: Array<{ text: string }> }).content[0]!.text).toBe(LONG_TEXT);
    }
  });

  it("is idempotent — a second pass finds nothing new to clear", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      microcompactKeepRecentToolResults: 5,
    });
    manager.noteUsage({ inputTokens: 150_000 });

    expect(manager.maybeMicrocompact()).not.toBeNull();
    expect(manager.maybeMicrocompact()).toBeNull();
  });

  it("returns null (history untouched) when there are too few tool results", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 4; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      microcompactKeepRecentToolResults: 5,
    });
    manager.noteUsage({ inputTokens: 150_000 });
    const before = snapshot(history);
    expect(manager.maybeMicrocompact()).toBeNull();
    expect(snapshot(history)).toBe(before);
  });

  it("returns null when clearing would not save the minimum tokens", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, "ok"));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      microcompactKeepRecentToolResults: 5,
      microcompactMinSavingsTokens: 256,
    });
    manager.noteUsage({ inputTokens: 150_000 });
    const before = snapshot(history);
    expect(manager.maybeMicrocompact()).toBeNull();
    expect(snapshot(history)).toBe(before);
  });

  it("strips the image payload of cleared tool results and counts it in savedTokens (design §2-C4/R9)", () => {
    const img = (): ImageAttachment => ({ mediaType: "image/png", data: "AAAA", sourcePath: "/x.png" });
    const imageToolResult = (id: string, text: string): ChatMessage => ({
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: id, toolName: "Read", text, status: "success", images: [img(), img()] },
      ],
    });
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(imageToolResult(`c${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      microcompactKeepRecentToolResults: 5,
      microcompactMinSavingsTokens: 256,
    });
    manager.noteUsage({ inputTokens: 150_000 });

    const result = manager.maybeMicrocompact();
    expect(result).not.toBeNull();
    expect(result!.clearedToolResults).toBe(3);
    // 3 cleared items × 2 images each = 6 images freed, plus the text delta.
    expect(result!.savedTokens).toBeGreaterThanOrEqual(6 * IMAGE_TOKEN_ESTIMATE);

    const toolItems = history.items.filter((i) => i.message.role === "tool");
    const cleared = toolItems.slice(0, 3);
    const kept = toolItems.slice(3);
    for (const item of cleared) {
      // The images key must be structurally gone (destructuring exclusion, not spread-over).
      expect(JSON.stringify(item.message)).not.toContain("images");
      expect(item.kind).toBe("microcompact_cleared");
    }
    for (const item of kept) {
      expect(JSON.stringify(item.message)).toContain("images");
    }
  });

  it("fires at the threshold and stays idle one token below it", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, LONG_TEXT));
    }
    const threshold = microcompactThresholdTokens(DEFAULT_CONTEXT_BUDGET);

    const atHistory = buildHistory(messages);
    const at = makeManager(atHistory, new ScriptedModelPort([]));
    at.noteUsage({ inputTokens: threshold });
    expect(at.maybeMicrocompact()).not.toBeNull();

    const belowHistory = buildHistory(messages);
    const below = makeManager(belowHistory, new ScriptedModelPort([]));
    below.noteUsage({ inputTokens: threshold - 1 });
    const before = snapshot(belowHistory);
    expect(below.maybeMicrocompact()).toBeNull();
    expect(snapshot(belowHistory)).toBe(before);
  });

  it("uses a replacement budget configuration on the next microcompact call", () => {
    const messages: ChatMessage[] = [userMsg("go")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`c${i}`));
      messages.push(toolResult(`c${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort([]), {
      contextWindowTokens: 200_000,
      outputReserveTokens: 0,
    });

    expect(manager.maybeMicrocompact()).toBeNull();
    manager.setBudgetConfig({
      ...DEFAULT_CONTEXT_BUDGET,
      contextWindowTokens: 1_000,
      outputReserveTokens: 0,
    });
    expect(manager.maybeMicrocompact()).not.toBeNull();
  });

  it("uses the pure local estimate after compaction resets the provider anchor", async () => {
    const messages: ChatMessage[] = [userMsg("old context")];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`old-${i}`));
      messages.push(toolResult(`old-${i}`, LONG_TEXT));
    }
    messages.push(userMsg("recent context"));
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantToolCall(`recent-${i}`));
      messages.push(toolResult(`recent-${i}`, LONG_TEXT));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort(summaryScript("summary")), {
      contextWindowTokens: 20_000,
      outputReserveTokens: 0,
      keepRecentMessages: 17,
    });
    manager.noteUsage({ inputTokens: 19_000 });

    expect((await manager.runCompaction({})).ok).toBe(true);
    expect(manager.estimate().source).toBe("estimate");
    expect(manager.maybeMicrocompact()).toBeNull();

    history.append(userMsg("x".repeat(100_000)));
    expect(manager.maybeMicrocompact()).not.toBeNull();
  });
});

describe("ContextManager.shouldAutoCompact", () => {
  const tightConfig: Partial<ContextBudgetConfig> = {
    contextWindowTokens: 1_000,
    outputReserveTokens: 0,
    compactThresholdPercent: 50,
    compactBufferTokens: 0,
  };
  // effectiveWindow = 1_000; threshold = 500.

  it("is false below the threshold and true at/above it", () => {
    const small = buildHistory([userMsg("short")]);
    expect(makeManager(small, new ScriptedModelPort([]), tightConfig).shouldAutoCompact()).toBe(false);

    const big = buildHistory([userMsg("x".repeat(4_000))]);
    expect(makeManager(big, new ScriptedModelPort([]), tightConfig).shouldAutoCompact()).toBe(true);
  });

  it("stays false once the circuit breaker has tripped", async () => {
    // Over threshold, but three consecutive failures disable compaction.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      messages.push(userMsg("x".repeat(400)));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort(errorScript()), {
      ...tightConfig,
      keepRecentMessages: 2,
      maxConsecutiveCompactionFailures: 3,
    });

    expect(manager.shouldAutoCompact()).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const res = await manager.runCompaction({});
      expect(res.ok).toBe(false);
    }
    expect(manager.shouldAutoCompact()).toBe(false);
  });
});

describe("ContextManager.runCompaction — success", () => {
  it("replaces the prefix with a compact_summary user item and keeps the tail", async () => {
    const messages: ChatMessage[] = [];
    for (let t = 0; t < 6; t += 1) {
      messages.push(userMsg(`turn ${t}`));
      messages.push(assistantToolCall(`c${t}`));
      messages.push(toolResult(`c${t}`, `result ${t}`));
    }
    const history = buildHistory(messages);
    const originalIds = history.items.map((i) => i.id);
    const manager = makeManager(history, new ScriptedModelPort(summaryScript("CONDENSED")), {
      keepRecentMessages: 4,
    });

    const result = await manager.runCompaction({});

    expect(result.ok).toBe(true);
    const first = history.items[0]!;
    expect(first.kind).toBe("compact_summary");
    expect(first.message.role).toBe("user");
    expect((first.message as { content: string }).content).toContain("CONDENSED");

    // The tail after the summary is an exact suffix of the original history and
    // starts at a user message (the boundary shifted back from len-keepRecent).
    const tailIds = history.items.slice(1).map((i) => i.id);
    expect(tailIds).toEqual(originalIds.slice(originalIds.length - tailIds.length));
    expect(history.items[1]!.message.role).toBe("user");
    expect(history.unansweredToolCallIds()).toEqual([]);

    if (result.ok) {
      expect(result.postTokens).toBeLessThan(result.preTokens);
    }
  });

  it("skips (ok:false) without a breaker hit when the prefix is empty", async () => {
    const history = buildHistory([userMsg("only one turn")]);
    const manager = makeManager(history, new ScriptedModelPort(summaryScript("S")), {
      keepRecentMessages: 10,
    });
    const before = snapshot(history);

    const result = await manager.runCompaction({});
    expect(result.ok).toBe(false);
    // History untouched and the model was never called.
    expect(snapshot(history)).toBe(before);
    expect((manager as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
  });
});

describe("ContextManager.runCompaction — atomic on failure/abort", () => {
  const longMessages = (): ChatMessage[] => {
    const messages: ChatMessage[] = [];
    for (let t = 0; t < 6; t += 1) {
      messages.push(userMsg(`turn ${t}`));
      messages.push(assistantToolCall(`c${t}`));
      messages.push(toolResult(`c${t}`, `result ${t}`));
    }
    return messages;
  };

  it("leaves history unchanged on a model error", async () => {
    const history = buildHistory(longMessages());
    const before = snapshot(history);
    const manager = makeManager(history, new ScriptedModelPort(errorScript()), {
      keepRecentMessages: 4,
    });

    const result = await manager.runCompaction({});
    expect(result.ok).toBe(false);
    expect(snapshot(history)).toBe(before);
  });

  it("redacts a compaction model error into a safe message — no secret reaches result.error/compaction_end.error (W7b-FIX #2)", async () => {
    const poisonedScript: ModelStreamEvent[] = [
      { type: "start" },
      { type: "error", error: new Error("HTTP 500 Authorization: Bearer sk-test") },
    ];
    const history = buildHistory(longMessages());
    const manager = makeManager(history, new ScriptedModelPort(poisonedScript), { keepRecentMessages: 4 });

    const result = await manager.runCompaction({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("sk-test");
      expect(result.error).toBe("request failed");
    }
  });

  it("leaves history unchanged on an empty summary", async () => {
    const history = buildHistory(longMessages());
    const before = snapshot(history);
    const manager = makeManager(history, new ScriptedModelPort(emptyScript()), {
      keepRecentMessages: 4,
    });

    const result = await manager.runCompaction({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
    expect(snapshot(history)).toBe(before);
  });

  it("leaves history unchanged when the turn signal aborts the compaction", async () => {
    const history = buildHistory(longMessages());
    const before = snapshot(history);
    // Port ignores the signal and would produce text; the manager must detect the
    // pre-aborted turn signal and refuse to apply the swap.
    const abortingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "text_delta", id: "t", text: "half a summary" } as ModelStreamEvent;
        })(),
    };
    const controller = new AbortController();
    controller.abort();
    const manager = makeManager(history, abortingPort, { keepRecentMessages: 4 });

    const result = await manager.runCompaction({ signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(snapshot(history)).toBe(before);
  });

  it("resets the failure counter after a successful compaction", async () => {
    const history = buildHistory(longMessages());
    // Two failures, then a success -> breaker counter back to 0.
    let calls = 0;
    const flakyPort: ModelPort = {
      streamText: (request: ModelRequest) => {
        const events = calls < 2 ? errorScript() : summaryScript("OK");
        calls += 1;
        const signal = request.abortSignal;
        return (async function* () {
          for (const event of events) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            yield event;
          }
        })();
      },
    };
    const manager = makeManager(history, flakyPort, { keepRecentMessages: 4 });

    expect((await manager.runCompaction({})).ok).toBe(false);
    expect((await manager.runCompaction({})).ok).toBe(false);
    expect((manager as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(2);
    expect((await manager.runCompaction({})).ok).toBe(true);
    expect((manager as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
  });
});

describe("ContextManager.runCompaction — property: never splits a tool pair", () => {
  it("keeps every tool_call/tool_result pair intact across random valid histories", async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = rng(seed * 7919);
      const messages = randomValidHistory(random);
      const history = buildHistory(messages);
      // The generator must itself be valid (guards the test).
      expect(history.unansweredToolCallIds()).toEqual([]);
      expect(noOrphanToolResults(history)).toBe(true);

      const keepRecentMessages = 1 + Math.floor(random() * 15);
      const manager = makeManager(history, new ScriptedModelPort(summaryScript("SUMMARY")), {
        keepRecentMessages,
      });

      const result = await manager.runCompaction({});

      // Whatever the outcome, the history is never left in an invalid state.
      expect(history.unansweredToolCallIds()).toEqual([]);
      expect(noOrphanToolResults(history)).toBe(true);

      if (result.ok) {
        // The compacted history starts with the summary; the tail's first
        // message is a user message (the clean-boundary rule).
        expect(history.items[0]!.kind).toBe("compact_summary");
        expect(history.items[1]!.message.role).toBe("user");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// slice 6.4: mid-session budget re-config (getBudgetConfig/setBudgetConfig) and
// the breakerTripped introspector.

describe("ContextManager.getBudgetConfig / setBudgetConfig (slice 6.4)", () => {
  const fullConfig = (overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig => ({
    ...DEFAULT_CONTEXT_BUDGET,
    ...overrides,
  });

  it("getBudgetConfig returns the live config the manager reads through", () => {
    const history = buildHistory([userMsg("hi")]);
    const manager = makeManager(history, new ScriptedModelPort([]));
    expect(manager.getBudgetConfig()).toEqual(DEFAULT_CONTEXT_BUDGET);
  });

  it("setBudgetConfig changes the outcome of shouldAutoCompact on the NEXT call", () => {
    // Estimate sits far below the default 200k threshold but above a tight window.
    const history = buildHistory([userMsg("x".repeat(4_000))]);
    const manager = makeManager(history, new ScriptedModelPort([]));
    expect(manager.shouldAutoCompact()).toBe(false);

    // Swap to a tight window (ew=1_000, threshold=500) — the very next call flips.
    manager.setBudgetConfig(
      fullConfig({
        contextWindowTokens: 1_000,
        outputReserveTokens: 0,
        compactThresholdPercent: 50,
        compactBufferTokens: 0,
      }),
    );
    expect(manager.getBudgetConfig().contextWindowTokens).toBe(1_000);
    expect(manager.shouldAutoCompact()).toBe(true);

    // And back the other way on a subsequent swap — the read is always live.
    manager.setBudgetConfig(fullConfig());
    expect(manager.shouldAutoCompact()).toBe(false);
  });

  it("preserves providerTokens/baselineEstimate — estimate() is continuous across a swap (R5)", () => {
    const history = buildHistory([userMsg("hello there friend")]);
    const manager = makeManager(history, new ScriptedModelPort([]));
    manager.noteUsage({ inputTokens: 5_000 });
    history.append(userMsg("another message"));

    const before = manager.estimate();
    expect(before.source).toBe("provider");

    manager.setBudgetConfig(fullConfig({ contextWindowTokens: 128_000 }));

    // The provider anchor + local delta is window-independent: identical either side.
    const after = manager.estimate();
    expect(after).toEqual(before);
    expect(after.source).toBe("provider");
  });

  it("preserves consecutiveFailures — a tripped breaker stays tripped across a swap (R5)", async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      messages.push(userMsg("x".repeat(400)));
    }
    const history = buildHistory(messages);
    const manager = makeManager(history, new ScriptedModelPort(errorScript()), {
      keepRecentMessages: 2,
      maxConsecutiveCompactionFailures: 2,
    });

    expect((await manager.runCompaction({})).ok).toBe(false);
    expect((await manager.runCompaction({})).ok).toBe(false);
    expect(manager.breakerTripped()).toBe(true);

    // Swap the window but keep the same failure ceiling: the counter must survive.
    manager.setBudgetConfig(
      fullConfig({ contextWindowTokens: 128_000, keepRecentMessages: 2, maxConsecutiveCompactionFailures: 2 }),
    );
    expect(manager.breakerTripped()).toBe(true);
    expect((manager as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(2);
  });
});

describe("ContextManager.breakerTripped (slice 6.4)", () => {
  it("flips false->true at the failure threshold; manual runCompaction still works after the trip", async () => {
    const messages: ChatMessage[] = [];
    for (let t = 0; t < 6; t += 1) {
      messages.push(userMsg(`turn ${t}`));
      messages.push(assistantToolCall(`c${t}`));
      messages.push(toolResult(`c${t}`, `result ${t}`));
    }
    const history = buildHistory(messages);
    // Fails the first two compactions, then succeeds (heals the breaker).
    let calls = 0;
    const flakyPort: ModelPort = {
      streamText: (request: ModelRequest) => {
        const events = calls < 2 ? errorScript() : summaryScript("OK");
        calls += 1;
        const signal = request.abortSignal;
        return (async function* () {
          for (const event of events) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            yield event;
          }
        })();
      },
    };
    const manager = makeManager(history, flakyPort, {
      keepRecentMessages: 4,
      maxConsecutiveCompactionFailures: 2,
    });

    expect(manager.breakerTripped()).toBe(false);
    expect((await manager.runCompaction({})).ok).toBe(false);
    expect(manager.breakerTripped()).toBe(false); // 1 < 2
    expect((await manager.runCompaction({})).ok).toBe(false);
    expect(manager.breakerTripped()).toBe(true); // 2 >= 2

    // runCompaction never consults the breaker: a manual call still reaches the
    // model, and a success heals the failure counter.
    const healed = await manager.runCompaction({});
    expect(healed.ok).toBe(true);
    expect(manager.breakerTripped()).toBe(false);
  });
});

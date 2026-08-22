/**
 * Unit tests for the turn-ceiling decision ladder primitive (TASK.124 cut-1).
 * Covers the pure functions (grant math, window clamp, verdict gate, schema
 * parser) and the one call primitive (requestCeilingVerdict) in isolation from
 * AgentLoop — the loop-integration seam is exercised separately in
 * agent-loop.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CEILING_REMAINING_MAX_ITEMS,
  CEILING_VERDICT_DECLARATION,
  CEILING_VERDICT_TOOL_NAME,
  acceptCeilingVerdict,
  buildCeilingDecisionPrompt,
  ceilingGrant,
  ceilingWindowMs,
  grantForRound,
  parseCeilingVerdict,
  requestCeilingVerdict,
  type CeilingConfig,
  type CeilingVerdict,
} from "./ceiling.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";

// ---------------------------------------------------------------------------
// grantForRound / ceilingGrant

describe("grantForRound", () => {
  it("halves, quarters, eighths across rounds 1-3", () => {
    expect(grantForRound(1, 100)).toBe(50);
    expect(grantForRound(2, 100)).toBe(25);
    expect(grantForRound(3, 100)).toBe(12);
  });

  it("floors round 1-2 at 1 for a small budget instead of rounding to 0", () => {
    expect(grantForRound(2, 4)).toBe(1); // floor(4/4) = 1, no flooring needed
    expect(grantForRound(2, 2)).toBe(1); // floor(2/4) = 0 -> floored up to 1
    expect(grantForRound(1, 1)).toBe(1);
  });

  it("floors round 3 at 5, not 1 (TASK.124.md table: N/8 but never below 5)", () => {
    expect(grantForRound(3, 4)).toBe(5); // floor(4/8) = 0 -> floored up to 5
    expect(grantForRound(3, 10)).toBe(5); // floor(10/8) = 1 -> floored up to 5
    expect(grantForRound(3, 39)).toBe(5); // floor(39/8) = 4 -> still floored up to 5
    expect(grantForRound(3, 40)).toBe(5); // floor(40/8) = 5, floor and raw coincide
    expect(grantForRound(3, 100)).toBe(12); // floor(100/8) = 12, above the floor
  });
});

describe("ceilingGrant", () => {
  it("defaults the total-grant budget to maxTurns (at most doubles the configured budget)", () => {
    expect(ceilingGrant(1, 100, 0, undefined)).toBe(50);
    expect(ceilingGrant(2, 100, 50, undefined)).toBe(25);
    expect(ceilingGrant(3, 100, 75, undefined)).toBe(12);
  });

  it("clamps the round's raw grant to whatever is left of the total budget", () => {
    // Already granted 90 of a 100 budget; round 2's raw grant (25) would blow past it.
    expect(ceilingGrant(2, 100, 90, undefined)).toBe(10);
  });

  it("returns 0 (never negative) once the total-grant budget is exhausted", () => {
    expect(ceilingGrant(3, 100, 100, undefined)).toBe(0);
    expect(ceilingGrant(3, 100, 130, undefined)).toBe(0);
  });

  it("honors an explicit maxGrantedTurns override instead of maxTurns", () => {
    const config: CeilingConfig = { maxGrantedTurns: 10 };
    expect(ceilingGrant(1, 100, 0, config)).toBe(10); // raw grant 50, clamped to the 10 total
    expect(ceilingGrant(1, 100, 10, config)).toBe(0); // already at the override's cap
  });

  it("additionally clamps by maxTurnsCeiling for a child (spec: total including grants never exceeds it)", () => {
    // maxTurns=40, already granted 0, maxTurnsCeiling=45 -> only 5 turns of headroom left overall.
    const config: CeilingConfig = { maxTurnsCeiling: 45 };
    expect(ceilingGrant(1, 40, 0, config)).toBe(5);
  });

  it("both clamps combine as separate ceilings — the tighter one wins", () => {
    const config: CeilingConfig = { maxGrantedTurns: 100, maxTurnsCeiling: 44 };
    // Raw round-1 grant floor(40/2)=20, but maxTurnsCeiling only leaves 4 (44-40-0).
    expect(ceilingGrant(1, 40, 0, config)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ceilingWindowMs

describe("ceilingWindowMs", () => {
  const now = 1_700_000_000_000;

  it("uses the configured timeout when no outcome deadline clamps it", () => {
    expect(ceilingWindowMs(undefined, now)).toBe(30_000); // CEILING_DECISION_TIMEOUT_MS
    expect(ceilingWindowMs({ decisionTimeoutMs: 15_000 }, now)).toBe(15_000);
  });

  it("clamps to the remaining outcome-deadline window when that is tighter", () => {
    const config: CeilingConfig = { outcomeDeadlineAt: now + 12_000 };
    expect(ceilingWindowMs(config, now)).toBe(12_000);
  });

  it("returns null (skip the call entirely) below CEILING_MIN_WINDOW_MS", () => {
    const config: CeilingConfig = { outcomeDeadlineAt: now + 9_999 };
    expect(ceilingWindowMs(config, now)).toBeNull();
  });

  it("accepts exactly CEILING_MIN_WINDOW_MS (boundary is inclusive)", () => {
    const config: CeilingConfig = { outcomeDeadlineAt: now + 10_000 };
    expect(ceilingWindowMs(config, now)).toBe(10_000);
  });

  it("treats an outcome deadline already in the past as null, never negative", () => {
    const config: CeilingConfig = { outcomeDeadlineAt: now - 1 };
    expect(ceilingWindowMs(config, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// acceptCeilingVerdict — the per-round gate

describe("acceptCeilingVerdict", () => {
  it("round 1: rejects done=true and an empty remaining list — nothing to grant turns for", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: true, remaining: [] },
        round: 1,
        successfulToolCalls: 0,
      }),
    ).toBe(false);
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: [] },
        round: 1,
        successfulToolCalls: 0,
      }),
    ).toBe(false);
  });

  it("round 1: accepts done=false with a non-empty remaining list, no progress check", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["finish the thing"] },
        round: 1,
        successfulToolCalls: 0, // round 1 has no "previous round" to have progressed from
      }),
    ).toBe(true);
  });

  it("round 2+: rejects when the round earned zero successful tool calls, regardless of the verdict", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["a"] },
        round: 2,
        previousRemaining: 3,
        successfulToolCalls: 0,
      }),
    ).toBe(false);
  });

  it("round 2+: rejects when remaining did not strictly shorten", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["a", "b", "c"] },
        round: 2,
        previousRemaining: 3,
        successfulToolCalls: 1,
      }),
    ).toBe(false); // same length, not shorter
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["a", "b", "c", "d"] },
        round: 2,
        previousRemaining: 3,
        successfulToolCalls: 1,
      }),
    ).toBe(false); // grew
  });

  it("round 2+: rejects when there is no previousRemaining to measure against", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["a"] },
        round: 2,
        successfulToolCalls: 1,
      }),
    ).toBe(false);
  });

  it("round 2: accepts progress + strictly shorter remaining, no nextAction required yet", () => {
    expect(
      acceptCeilingVerdict({
        verdict: { done: false, remaining: ["a", "b"] },
        round: 2,
        previousRemaining: 3,
        successfulToolCalls: 1,
      }),
    ).toBe(true);
  });

  it("round 3: additionally requires a non-blank nextAction", () => {
    const base = {
      verdict: { done: false, remaining: ["a"] } as CeilingVerdict,
      round: 3,
      previousRemaining: 2,
      successfulToolCalls: 1,
    };
    expect(acceptCeilingVerdict(base)).toBe(false); // nextAction absent
    expect(
      acceptCeilingVerdict({ ...base, verdict: { ...base.verdict, nextAction: "   " } }),
    ).toBe(false); // blank
    expect(
      acceptCeilingVerdict({
        ...base,
        verdict: { ...base.verdict, nextAction: "run the last test" },
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCeilingVerdict — the structural schema checker

describe("parseCeilingVerdict", () => {
  it("parses a minimal valid verdict, mapping next_action -> nextAction", () => {
    expect(parseCeilingVerdict({ done: false, remaining: ["x"], next_action: "y" })).toEqual({
      done: false,
      remaining: ["x"],
      nextAction: "y",
    });
  });

  it("accepts an omitted next_action as absent (not required outside round 3)", () => {
    expect(parseCeilingVerdict({ done: true, remaining: [] })).toEqual({
      done: true,
      remaining: [],
    });
  });

  it("rejects non-object input (null, array, primitive)", () => {
    expect(parseCeilingVerdict(null)).toBeNull();
    expect(parseCeilingVerdict(["done"])).toBeNull();
    expect(parseCeilingVerdict("done")).toBeNull();
    expect(parseCeilingVerdict(undefined)).toBeNull();
  });

  it("rejects an unknown property (schema is additionalProperties: false)", () => {
    expect(parseCeilingVerdict({ done: true, remaining: [], extra: "nope" })).toBeNull();
  });

  it("rejects a non-boolean done", () => {
    expect(parseCeilingVerdict({ done: "true", remaining: [] })).toBeNull();
  });

  it("rejects a non-array remaining, and a remaining item that is not a non-empty string", () => {
    expect(parseCeilingVerdict({ done: false, remaining: "x" })).toBeNull();
    expect(parseCeilingVerdict({ done: false, remaining: [1] })).toBeNull();
    expect(parseCeilingVerdict({ done: false, remaining: [""] })).toBeNull();
  });

  it(`rejects a remaining list longer than CEILING_REMAINING_MAX_ITEMS (${CEILING_REMAINING_MAX_ITEMS})`, () => {
    const tooMany = Array.from({ length: CEILING_REMAINING_MAX_ITEMS + 1 }, (_, i) => `item ${i}`);
    expect(parseCeilingVerdict({ done: false, remaining: tooMany })).toBeNull();
    const exactly = Array.from({ length: CEILING_REMAINING_MAX_ITEMS }, (_, i) => `item ${i}`);
    expect(parseCeilingVerdict({ done: false, remaining: exactly })).not.toBeNull();
  });

  it("rejects a non-string next_action", () => {
    expect(parseCeilingVerdict({ done: false, remaining: [], next_action: 5 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requestCeilingVerdict — the one call primitive, fail-closed on everything
// that is not a single clean `ceiling_verdict` tool call.

function step(...events: ModelStreamEvent[]): ModelStreamEvent[] {
  return events;
}

class ScriptedPort implements ModelPort {
  calls = 0;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly events: ModelStreamEvent[]) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.requests.push(request);
    const signal = request.abortSignal;
    const events = this.events;
    return (async function* () {
      for (const event of events) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield event;
      }
    })();
  }
}

const baseRequest = {
  messages: [],
  round: 1,
  maxRounds: 3,
  windowMs: 30_000,
};

describe("requestCeilingVerdict", () => {
  it("returns the parsed verdict for a clean single ceiling_verdict call", async () => {
    const port = new ScriptedPort(
      step(
        { type: "start" },
        {
          type: "tool_call",
          toolCall: {
            id: "v1",
            name: CEILING_VERDICT_TOOL_NAME,
            input: { done: false, remaining: ["a"], next_action: "b" },
          },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ),
    );
    const verdict = await requestCeilingVerdict({ ...baseRequest, modelPort: port });
    expect(verdict).toEqual({ done: false, remaining: ["a"], nextAction: "b" });
    // The declared tool set is exactly the one verdict tool — nothing else is offered.
    expect(port.requests[0]!.tools).toEqual([CEILING_VERDICT_DECLARATION]);
  });

  it("fail-closed: no tool_call at all", async () => {
    const port = new ScriptedPort(step({ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }));
    expect(await requestCeilingVerdict({ ...baseRequest, modelPort: port })).toBeNull();
  });

  it("fail-closed: a tool call for a different (or invalid) tool", async () => {
    const wrongName = new ScriptedPort(
      step({ type: "tool_call", toolCall: { id: "v1", name: "Bash", input: {} } }),
    );
    expect(await requestCeilingVerdict({ ...baseRequest, modelPort: wrongName })).toBeNull();

    const invalidFlag = new ScriptedPort(
      step({
        type: "tool_call",
        toolCall: {
          id: "v1",
          name: CEILING_VERDICT_TOOL_NAME,
          input: {},
          invalid: { reason: "sdk parse failure" },
        },
      }),
    );
    expect(await requestCeilingVerdict({ ...baseRequest, modelPort: invalidFlag })).toBeNull();
  });

  it("fail-closed: arguments that do not pass the schema", async () => {
    const port = new ScriptedPort(
      step({
        type: "tool_call",
        toolCall: { id: "v1", name: CEILING_VERDICT_TOOL_NAME, input: { done: "nope" } },
      }),
    );
    expect(await requestCeilingVerdict({ ...baseRequest, modelPort: port })).toBeNull();
  });

  it("fail-closed: two tool calls in one reply are ambiguous, not the first one wins", async () => {
    const port = new ScriptedPort(
      step(
        {
          type: "tool_call",
          toolCall: { id: "v1", name: CEILING_VERDICT_TOOL_NAME, input: { done: false, remaining: ["a"] } },
        },
        {
          type: "tool_call",
          toolCall: { id: "v2", name: CEILING_VERDICT_TOOL_NAME, input: { done: false, remaining: ["b"] } },
        },
      ),
    );
    expect(await requestCeilingVerdict({ ...baseRequest, modelPort: port })).toBeNull();
  });

  it("a stream_retry discards whatever the aborted attempt captured", async () => {
    const port = new ScriptedPort(
      step(
        {
          type: "tool_call",
          toolCall: { id: "v1", name: CEILING_VERDICT_TOOL_NAME, input: { done: false, remaining: ["stale"] } },
        },
        { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, reason: "stall" },
        {
          type: "tool_call",
          toolCall: { id: "v2", name: CEILING_VERDICT_TOOL_NAME, input: { done: false, remaining: ["fresh"] } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ),
    );
    const verdict = await requestCeilingVerdict({ ...baseRequest, modelPort: port });
    // Without the reset this would see 2 captured calls and refuse as ambiguous.
    expect(verdict).toEqual({ done: false, remaining: ["fresh"] });
  });

  it("fail-closed: a throw while iterating the stream never escapes", async () => {
    const port: ModelPort = {
      streamText(): AsyncIterable<ModelStreamEvent> {
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "start" };
          throw new Error("boom");
        })();
      },
    };
    await expect(requestCeilingVerdict({ ...baseRequest, modelPort: port })).resolves.toBeNull();
  });

  it("fail-closed: a synchronous throw from streamText itself never escapes", async () => {
    const port: ModelPort = {
      streamText(): AsyncIterable<ModelStreamEvent> {
        throw new Error("boom before any stream");
      },
    };
    await expect(requestCeilingVerdict({ ...baseRequest, modelPort: port })).resolves.toBeNull();
  });

  it("fail-closed: times out and aborts the call when the model never responds", async () => {
    vi.useFakeTimers();
    try {
      const port: ModelPort = {
        streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
          const signal = request.abortSignal;
          return (async function* (): AsyncGenerator<ModelStreamEvent> {
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
          })();
        },
      };
      const result = requestCeilingVerdict({ ...baseRequest, modelPort: port, windowMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-closed: an already-aborted turn signal refuses without waiting for the window", async () => {
    const controller = new AbortController();
    controller.abort("turn cancelled");
    const port: ModelPort = {
      streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const signal = request.abortSignal;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          yield { type: "start" };
        })();
      },
    };
    const result = await requestCeilingVerdict({
      ...baseRequest,
      modelPort: port,
      signal: controller.signal,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCeilingDecisionPrompt — sanity on the instruction text (not parsed by
// anything; only asserted so the round/previous-remaining wiring is visible).

describe("buildCeilingDecisionPrompt", () => {
  it("names the round and omits the shortening rule on round 1", () => {
    const prompt = buildCeilingDecisionPrompt(1, 3);
    expect(prompt).toContain("Round 1 of 3");
    expect(prompt).not.toContain("Previous remaining count");
  });

  it("states the previous remaining count and the shortening requirement from round 2 on", () => {
    const prompt = buildCeilingDecisionPrompt(2, 3, 4);
    expect(prompt).toContain("Round 2 of 3");
    expect(prompt).toContain("Previous remaining count: 4");
    expect(prompt).toContain("shorten remaining");
  });
});

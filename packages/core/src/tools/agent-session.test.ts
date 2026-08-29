/**
 * Session-tier Agent tool tests (TASK.102 CUT-S2 §2.1/§3 B1). Covers the
 * FACTORY's two declarations (restricted default vs. full sessionTier:true)
 * and the real `tier:"session"` branch that runs through
 * `ctx.sessionSubagents` (SessionSubagentPort) — the parts `agent.test.ts`
 * explicitly deferred to this file (see its "mapProgressToEvent's attention
 * case" scope comment).
 *
 * `agent.test.ts` itself is UNTOUCHED by this slice: it stays the
 * discriminator for inline-path byte-identical behavior (CUT-S2 §3 B1 — "если
 * они краснеют, это твой регресс").
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentTool, createAgentTool } from "./agent.js";
import { agentInputSchema, restrictedAgentInputSchema } from "./schemas.js";
import type { ToolContext, ToolEmittedEvent } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type {
  SessionSubagentOutcome,
  SessionSubagentPort,
  SessionSubagentRequest,
} from "../ports/session-subagent.js";
import type { EngineProfileInfo, SubagentPort, SubagentRunOptions } from "../ports/subagent.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: {} as CorePorts,
    ...overrides,
  };
}

const BASE_SESSION_OUTCOME: SessionSubagentOutcome = {
  status: "completed",
  finalText: "child session done",
  truncated: false,
  turns: 2,
  toolCalls: 3,
  durationMs: 500,
  childSessionId: "child-1",
  parentSessionId: "parent-1",
  spawnToolCallId: "call-1",
};

function portReturning(outcome: SessionSubagentOutcome): SessionSubagentPort {
  return { run: async () => outcome };
}

// ---------------------------------------------------------------------------
// Declarations (CUT-S2 §2.1/§5.13): the restricted declaration is
// non-recursion lock #1 — a model talking to a restricted host must not even
// be able to DISCOVER the session tier exists. Asserted against the
// SERIALIZED JSON declaration (z.toJSONSchema, the SAME conversion
// to-model-tools.ts uses to build what a model actually sees), not against
// the factory's source code — a facade that kept "session" reachable through
// some other path (e.g. a permissive catch-all string field) would still be
// caught here because the check is on the wire shape, not the code shape.

describe("createAgentTool — restricted vs. full declaration (CUT-S2 §2.1/§5.13)", () => {
  it("restricted (default, sessionTier absent) has NO provider key and NO \"session\" anywhere in the serialized JSON schema", () => {
    const restricted = createAgentTool();
    const jsonSchema = z.toJSONSchema(restricted.inputSchema) as { properties?: Record<string, unknown> };
    expect(jsonSchema.properties).toBeDefined();
    expect(Object.keys(jsonSchema.properties ?? {})).not.toContain("provider");
    // Whole-schema scan (not just top-level keys): catches "session" leaking
    // in anywhere — enum values, descriptions, nested refs.
    expect(JSON.stringify(jsonSchema)).not.toContain("session");
  });

  it("restricted (sessionTier:false explicit) is identical to the default", () => {
    const explicit = createAgentTool({ sessionTier: false });
    const restrictedJson = z.toJSONSchema(restrictedAgentInputSchema);
    expect(z.toJSONSchema(explicit.inputSchema)).toEqual(restrictedJson);
    expect(explicit.metadata.description).toBe(agentTool.metadata.description);
  });

  it("restricted tool description does not mention the session tier", () => {
    const restricted = createAgentTool();
    expect(restricted.metadata.description).not.toContain("session");
  });

  it("full (sessionTier:true) DOES declare tier:\"session\" and a provider key in the serialized JSON schema", () => {
    const full = createAgentTool({ sessionTier: true });
    const jsonSchema = z.toJSONSchema(full.inputSchema) as { properties?: Record<string, unknown> };
    expect(Object.keys(jsonSchema.properties ?? {})).toContain("provider");
    expect(JSON.stringify(jsonSchema)).toContain("session");
  });

  it("full tool description mentions the session tier (one added sentence)", () => {
    const full = createAgentTool({ sessionTier: true });
    expect(full.metadata.description).toContain("session");
    expect(full.metadata.description.startsWith(agentTool.metadata.description)).toBe(true);
  });

  it("restricted schema rejects tier:\"session\" at the ZOD level (a hallucinating model gets a validation error, not a silent inline downgrade)", () => {
    const result = restrictedAgentInputSchema.safeParse({ description: "d", prompt: "p", tier: "session" });
    expect(result.success).toBe(false);
  });

  it("restricted schema still accepts tier:\"inline\" and no-tier", () => {
    expect(restrictedAgentInputSchema.safeParse({ description: "d", prompt: "p", tier: "inline" }).success).toBe(
      true,
    );
    expect(restrictedAgentInputSchema.safeParse({ description: "d", prompt: "p" }).success).toBe(true);
  });

  // F15: a plain z.object() strips unknown keys by default (zod's own
  // default behavior) rather than rejecting them — a restricted host would
  // silently swallow a smuggled/hallucinated "provider" instead of the model
  // ever finding out the field did nothing. The restricted schema is the
  // non-recursion lock's SERIALIZED-SCHEMA half; it must reject unrecognized
  // input the same way it rejects tier:"session" above, not silently drop it.
  it("restricted schema REJECTS an unrecognized key (e.g. a smuggled provider) instead of silently stripping it", () => {
    const smuggled = restrictedAgentInputSchema.safeParse({
      description: "d",
      prompt: "p",
      provider: "anthropic-2",
    });
    expect(smuggled.success).toBe(false);
  });

  it("restricted schema still accepts every LEGAL restricted field (description/prompt/agent_type/tier/model)", () => {
    const result = restrictedAgentInputSchema.safeParse({
      description: "d",
      prompt: "p",
      agent_type: "explore",
      tier: "inline",
      model: "glm-4.6",
    });
    expect(result.success).toBe(true);
  });

  it("full schema parses tier:\"session\" with a provider", () => {
    const result = agentInputSchema.safeParse({
      description: "d",
      prompt: "p",
      tier: "session",
      provider: "anthropic-2",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.tier).toBe("session");
    expect(result.success && result.data.provider).toBe("anthropic-2");
  });

  it("full schema rejects an empty-string provider", () => {
    const result = agentInputSchema.safeParse({ description: "d", prompt: "p", tier: "session", provider: "" });
    expect(result.success).toBe(false);
  });

  it("full schema rejects an unknown tier value", () => {
    const result = agentInputSchema.safeParse({ description: "d", prompt: "p", tier: "background" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// provider validation (CUT-S2 §2.1): "provider" is session-tier only.

describe("agentTool handler — provider validation (CUT-S2 §2.1)", () => {
  it("provider with tier:\"inline\" (explicit) => invalid_input with the exact message", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "inline", provider: "anthropic-2" },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe('Agent: "provider" is only valid with tier "session".');
  });

  it("provider with tier omitted (default inline) => invalid_input, same exact message", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", provider: "anthropic-2" }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe('Agent: "provider" is only valid with tier "session".');
  });

  it("provider validation fires even with NO ports at all wired (fails fast, before any availability check)", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler(
      { description: "d", prompt: "p", provider: "anthropic-2" },
      makeCtx(), // no subagents, no sessionSubagents
    );
    expect(result.errorKind).toBe("invalid_input");
  });

  it("provider WITH tier:\"session\" is valid input (no invalid_input) — reaches the availability lock instead", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session", provider: "anthropic-2" },
      makeCtx(), // no sessionSubagents => fail-closed, but NOT invalid_input
    );
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toContain("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed lock (CUT-S2 §2.1): tier:"session" with no ctx.sessionSubagents.
// This is non-recursion lock #2 firing — a child session's DispatchContext
// never carries this port, so it lands here even if it somehow reached a
// FULL declaration (which schema-lock #1 should have prevented in the first
// place — belt and suspenders, CUT-S2 §0.2).

describe("agentTool handler — session-tier fail-closed lock (CUT-S2 §2.1)", () => {
  it("tier:\"session\" with no ctx.sessionSubagents => fail-closed with the EXACT dosl text from CUT-S2 §2.1", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx(), // sessionSubagents undefined
    );
    expect(result).toEqual({
      ok: false,
      error: "Agent: session-tier subagents are unavailable in this host.",
    });
  });

  it("tier:\"session\" fails closed even when ctx.subagents (inline port) IS present — the two ports are independent locks", async () => {
    const full = createAgentTool({ sessionTier: true });
    const inlinePort = {
      run: async () => {
        throw new Error("inline subagents.run must not be reached for a session-tier request");
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ subagents: inlinePort }),
    );
    expect(result.error).toBe("Agent: session-tier subagents are unavailable in this host.");
  });

  it("DISCRIMINATION PIN: default tier (absent) with ONLY sessionSubagents wired never reaches sessionSubagents.run — mirrors agent.test.ts's pre-B1 pin, now proven against the REAL tier branch", async () => {
    const full = createAgentTool({ sessionTier: true });
    const sessionPort: SessionSubagentPort = {
      run: async () => {
        throw new Error("sessionSubagents.run must not be reached — this request never asked for tier:\"session\"");
      },
    };
    const result = await full.handler({ description: "d", prompt: "p" }, makeCtx({ sessionSubagents: sessionPort }));
    expect(result).toEqual({ ok: false, error: "Agent: subagents are unavailable in this context." });
  });
});

// ---------------------------------------------------------------------------
// Outcome mapping (CUT-S2 §2.1: "маппинг outcome→result ОБЩИЙ для обоих
// ярусов") — all four terminal statuses through the session-tier port,
// mirroring agent.test.ts's TASK.44 inline coverage byte-for-byte.

describe("agentTool handler — session-tier outcome mapping, all 4 terminal statuses (CUT-S2 §2.1)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("completed => ok:true, the only success", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ sessionSubagents: portReturning({ ...BASE_SESSION_OUTCOME, status: "completed" }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.errorKind).toBeUndefined();
    expect(full.formatResultForModel?.(result)).toBe("child session done");
  });

  it("max_turns => ok:false, errorKind max_turns, partial rides the error, matches inline wording exactly", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({
        sessionSubagents: portReturning({
          ...BASE_SESSION_OUTCOME,
          status: "max_turns",
          finalText: "partial child work",
          turns: 8,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("max_turns");
    expect(result.error).toContain("partial child work");
    // Wording is shared with the inline tier (outcomeToResult): TASK.74 made
    // the status cover the wall-clock deadline too, so it names the budget, not
    // the turn cap, and marks the partial INCOMPLETE.
    expect(result.error).toContain("ran out of budget");
    expect(result.error).toContain("INCOMPLETE SUBAGENT RESULT");
    expect(result.error).toContain("8 turns");
  });

  it("cancelled => ok:false, errorKind cancelled, exact inline wording", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({
        sessionSubagents: portReturning({ ...BASE_SESSION_OUTCOME, status: "cancelled", finalText: "" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("cancelled");
    expect(result.error).toBe("Agent: the subagent was cancelled.");
  });

  it("error => ok:false, no errorKind, message from finalText", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({
        sessionSubagents: portReturning({ ...BASE_SESSION_OUTCOME, status: "error", finalText: "child crashed" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe("child crashed");
  });

  it("error with an EMPTY finalText => the same non-empty fallback text as inline", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({
        sessionSubagents: portReturning({ ...BASE_SESSION_OUTCOME, status: "error", finalText: "" }),
      }),
    );
    expect(result.error).toBe("Agent: the subagent failed.");
  });

  it("the tool's OWN output field never leaks the three session ids (CUT-S2 §2.1: ids ride ONLY the presentation target)", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ sessionSubagents: portReturning(BASE_SESSION_OUTCOME) }),
    );
    expect(result.output && "childSessionId" in result.output).toBe(false);
    expect(result.output && "parentSessionId" in result.output).toBe(false);
    expect(result.output && "spawnToolCallId" in result.output).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S1 presentation snapshot carries target.kind==="session" + the three ids
// (CUT-S2 §2.1: "core их только копирует в target и НЕ изобретает").

describe("agentTool handler — session-tier presentation target (CUT-S2 §2.1)", () => {
  const full = createAgentTool({ sessionTier: true });

  function scriptedPort(outcome: SessionSubagentOutcome): SessionSubagentPort {
    return {
      run: async (_req: SessionSubagentRequest, opts: SubagentRunOptions) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d", model: "glm-4.6" });
        opts.onProgress?.({ kind: "end", status: outcome.status, turns: outcome.turns, durationMs: outcome.durationMs });
        return outcome;
      },
    };
  }

  it("carries target={kind:\"session\", childSessionId, parentSessionId, spawnToolCallId} copied verbatim from the outcome", async () => {
    const outcome: SessionSubagentOutcome = {
      ...BASE_SESSION_OUTCOME,
      childSessionId: "child-xyz",
      parentSessionId: "parent-abc",
      spawnToolCallId: "call-99",
    };
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "explore", tier: "session" },
      makeCtx({ toolCallId: "call-99", sessionSubagents: scriptedPort(outcome) }),
    );
    expect(result.presentation?.subagent?.target).toEqual({
      kind: "session",
      childSessionId: "child-xyz",
      parentSessionId: "parent-abc",
      spawnToolCallId: "call-99",
    });
  });

  it("target is present on ALL FOUR terminal statuses, not just completed (mirrors inline's all-branches coverage)", async () => {
    for (const status of ["completed", "max_turns", "cancelled", "error"] as const) {
      const outcome: SessionSubagentOutcome = { ...BASE_SESSION_OUTCOME, status };
      const result = await full.handler(
        { description: "d", prompt: "p", tier: "session" },
        makeCtx({ sessionSubagents: scriptedPort(outcome) }),
      );
      expect(result.presentation?.subagent?.target).toEqual({
        kind: "session",
        childSessionId: BASE_SESSION_OUTCOME.childSessionId,
        parentSessionId: BASE_SESSION_OUTCOME.parentSessionId,
        spawnToolCallId: BASE_SESSION_OUTCOME.spawnToolCallId,
      });
    }
  });

  it("no presentation at all when the child never reaches subagent_start (mirrors inline's 'never fabricated' rule)", async () => {
    const port: SessionSubagentPort = {
      run: async () => ({ ...BASE_SESSION_OUTCOME, status: "error", finalText: "failed before start" }),
    };
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ sessionSubagents: port }),
    );
    expect(result.presentation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request forwarding: agentType/description/prompt/provider/model onto
// SessionSubagentRequest (mirrors the existing inline "model prokidka" tests).

describe("agentTool handler — SessionSubagentRequest forwarding (CUT-S2 §2.1/§2.2)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("forwards agentType/description/prompt/provider/model", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler(
      {
        description: "build X",
        prompt: "go build X",
        agent_type: "general-purpose",
        tier: "session",
        provider: "second-connection",
        model: "glm-4.6",
      },
      makeCtx({ sessionSubagents: port }),
    );
    // spawnToolCallId (CUT-S2 §10.5) rides EVERY session-tier request: it is
    // ctx.toolCallId ("call-1", makeCtx's default), stamped by the handler
    // itself — not part of the model-supplied input.
    expect(seen).toEqual({
      agentType: "general-purpose",
      description: "build X",
      prompt: "go build X",
      spawnToolCallId: "call-1",
      provider: "second-connection",
      model: "glm-4.6",
    });
  });

  it("defaults agentType to general-purpose when agent_type is omitted", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler({ description: "d", prompt: "p", tier: "session" }, makeCtx({ sessionSubagents: port }));
    expect(seen?.agentType).toBe("general-purpose");
  });

  it("omits provider/model keys entirely when absent (no silent undefined riding the wire)", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler({ description: "d", prompt: "p", tier: "session" }, makeCtx({ sessionSubagents: port }));
    expect(seen && "provider" in seen).toBe(false);
    expect(seen && "model" in seen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnToolCallId (CUT-S2 §10.5 — правит замороженный §2.2): the ONE field on
// SessionSubagentRequest core does not merely relay but OWNS. Fable's
// addendum reverted a builder's temporary "mint a fresh uuid" workaround; the
// durable rule is "spawnToolCallId IS ctx.toolCallId, verbatim, both ways."

describe("agentTool handler — spawnToolCallId is ctx.toolCallId, verbatim (CUT-S2 §10.5)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("DISCRIMINATING: the outgoing request's spawnToolCallId is EXACTLY ctx.toolCallId — a handler that substituted any other source (a freshly minted id, a constant, the description, etc.) fails this", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return BASE_SESSION_OUTCOME;
      },
    };
    // A value distinctive enough that no other field/constant in the handler
    // could accidentally match it (rules out both "hardcoded fallback" and
    // "copied the wrong ctx field" mistakes).
    const distinctiveToolCallId = "toolu_distinctive_9f3a21";
    await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: distinctiveToolCallId, sessionSubagents: port }),
    );
    expect(seen?.spawnToolCallId).toBe(distinctiveToolCallId);
  });

  it("ROUND-TRIP: target.spawnToolCallId on the presentation snapshot equals ctx.toolCallId, proven through a port that echoes the REQUEST's id back onto the outcome (not a value the test hardcodes on both ends)", async () => {
    const echoingPort: SessionSubagentPort = {
      run: async (req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const distinctiveToolCallId = "toolu_roundtrip_7b2c";
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: distinctiveToolCallId, sessionSubagents: echoingPort }),
    );
    expect(result.presentation?.subagent?.target).toMatchObject({
      kind: "session",
      spawnToolCallId: distinctiveToolCallId,
    });
  });

  // F14: an echoing port can never catch a missing check — it returns
  // whatever it was sent BY CONSTRUCTION, so the test above passes whether
  // or not the handler verifies anything. A LYING port (one that returns a
  // different spawnToolCallId than the request carried) is the
  // discriminating case: per ports/session-subagent.ts's docstring, the host
  // is REQUIRED to return exactly the string it received, and the handler
  // must assert that equality rather than trust the outcome as-is. core owns
  // this field (it minted it as ctx.toolCallId) — a host that can't round-
  // trip it back correctly cannot be trusted for the id fields that ride
  // alongside it either (childSessionId/parentSessionId), so the whole
  // delegation must fail closed rather than let a corrupted id reach the
  // persisted target/relation-store key.
  it("LYING PORT: a host that returns a DIFFERENT spawnToolCallId than the request sent is rejected, not silently trusted as the target's id", async () => {
    const lyingPort: SessionSubagentPort = {
      run: async (req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: "some-other-id-the-host-made-up" };
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: "call-1", sessionSubagents: lyingPort }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("call-1");
    expect(result.error).toContain("some-other-id-the-host-made-up");
    // The corrupted id must never reach the persisted target.
    expect(result.presentation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// subagent_attention bridges from a session-tier port's progress (CUT-S2
// §2.2/§0.8) — the half agent.test.ts's scope comment explicitly deferred to
// THIS file: proof that the REAL SessionSubagentPort route reaches the SAME
// mapProgressToEvent bridge the inline tests exercised on a fake SubagentPort.

describe("agentTool handler — subagent_attention bridges from a session-tier port (CUT-S2 §2.2)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("waiting:true then waiting:false, both stamped with the Agent call's toolCallId, both delivered via ctx.emit", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SessionSubagentPort = {
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "attention", waiting: true });
        opts.onProgress?.({ kind: "attention", waiting: false });
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: "call-live", sessionSubagents: port, emit: (e) => emitted.push(e) }),
    );
    const attention = emitted.filter((e) => e.type === "subagent_attention");
    expect(attention).toEqual([
      { type: "subagent_attention", toolCallId: "call-live", waiting: true },
      { type: "subagent_attention", toolCallId: "call-live", waiting: false },
    ]);
  });

  it("attention progress does NOT alter the persisted card snapshot (transient live-only, CUT-S1 §2.1 — proven end-to-end through the real session branch)", async () => {
    const withAttentionPort: SessionSubagentPort = {
      run: async (req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "attention", waiting: true });
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 10 });
        return { ...BASE_SESSION_OUTCOME, status: "completed", spawnToolCallId: req.spawnToolCallId };
      },
    };
    const withoutAttentionPort: SessionSubagentPort = {
      run: async (req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 10 });
        return { ...BASE_SESSION_OUTCOME, status: "completed", spawnToolCallId: req.spawnToolCallId };
      },
    };
    const withAttn = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: "call-a", sessionSubagents: withAttentionPort }),
    );
    const withoutAttn = await full.handler(
      { description: "d", prompt: "p", tier: "session" },
      makeCtx({ toolCallId: "call-a", sessionSubagents: withoutAttentionPort }),
    );
    expect(withAttn.presentation?.subagent).toEqual(withoutAttn.presentation?.subagent);
  });
});

// ---------------------------------------------------------------------------
// Engine-profile routing (TASK.102 CUT-S4 §2.2): BEFORE the tier branch, the
// handler asks ctx.subagents.engineProfile(agentType). When it resolves
// non-null the call is routed to a child SESSION regardless of `tier` (a
// silent inline->session upgrade, never a refusal — the one-shot in-process
// path for engine personas no longer exists); `provider` is rejected (a
// foreign-engine child has no core connection to run on); no
// ctx.sessionSubagents fails closed with an honest "unavailable" error (the
// one-shot foreign-CLI fallback is removed, not substituted).

function enginePort(agentType: string, profile: EngineProfileInfo | null): SubagentPort {
  return {
    listAgentTypes: () => [agentType],
    engineProfile: (t) => (t === agentType ? profile : null),
    run: async () => {
      throw new Error("inline subagents.run must not be reached for an engine-profile agent");
    },
  };
}

describe("agentTool handler — engine-profile routing (TASK.102 CUT-S4 §2.2)", () => {
  const full = createAgentTool({ sessionTier: true });
  // "claude", not "codex": this describe block exercises the GENERAL
  // engine-profile routing mechanism (provider rejection, availability
  // fail-closed, request composition, tier upgrade) — orthogonal to which
  // engine is behind the profile. Pinned to claude rather than parameterized
  // over both so the byte-identical-composition assertion (I3 below) has one
  // unambiguous `systemPrompt`/`prompt` pair to compare against; the "codex
  // engine profile now routes like claude (TASK.143)" describe block below
  // separately proves codex reaches the SAME port with the SAME composition.
  const ENGINE_PROFILE = { engine: "claude" as const, systemPrompt: "PERSONA BODY" };

  it('engine profile + provider (tier "session") => invalid_input with the engine-specific message (§2.2 p.1)', async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker", tier: "session", provider: "anthropic-2" },
      makeCtx({
        subagents: enginePort("claude-worker", ENGINE_PROFILE),
        sessionSubagents: portReturning(BASE_SESSION_OUTCOME),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe(
      'Agent: "provider" is not valid for an engine-profile agent — the child runs on its own CLI account.',
    );
  });

  it("engine profile + no ctx.sessionSubagents => honest fail-closed error naming the engine, NOT a one-shot fallback (§2.2 p.2)", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker" },
      makeCtx({ subagents: enginePort("claude-worker", ENGINE_PROFILE) }), // no sessionSubagents
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe(
      'Agent: agent type "claude-worker" runs on the "claude" engine; engine agents run as child sessions and are unavailable in this host.',
    );
  });

  it("engine profile + sessionSubagents present => session request carries engine, spawnToolCallId===ctx.toolCallId, and the composed prompt", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await full.handler(
      { description: "d", prompt: "do the task", agent_type: "claude-worker" },
      makeCtx({
        toolCallId: "call-engine-1",
        subagents: enginePort("claude-worker", ENGINE_PROFILE),
        sessionSubagents: port,
      }),
    );
    expect(seen?.engine).toBe("claude");
    expect(seen?.spawnToolCallId).toBe("call-engine-1");
    expect(seen?.prompt).toBe("PERSONA BODY\n\n---\n\ndo the task");
  });

  it("I3: the session-tier prompt composition is byte-identical to the one-shot composition subagents/runner.ts builds", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const systemPrompt = "PERSONA BODY";
    const taskPrompt = "do the task";
    await full.handler(
      { description: "d", prompt: taskPrompt, agent_type: "claude-worker" },
      makeCtx({
        subagents: enginePort("claude-worker", { engine: "claude", systemPrompt }),
        sessionSubagents: port,
      }),
    );
    // Byte-identical to the one-shot EngineChildSpec.prompt composition
    // (subagents/runner.ts: `${persona.systemPrompt}\n\n---\n\n${req.prompt}`).
    const oneShotComposition = `${systemPrompt}\n\n---\n\n${taskPrompt}`;
    expect(seen?.prompt).toBe(oneShotComposition);
  });

  it('tier:"inline" on an engine profile is silently UPGRADED to a session run, never a refusal (§2.2 p.3)', async () => {
    let ran = false;
    const port: SessionSubagentPort = {
      run: async (req) => {
        ran = true;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker", tier: "inline" },
      makeCtx({ subagents: enginePort("claude-worker", ENGINE_PROFILE), sessionSubagents: port }),
    );
    expect(ran).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("tier omitted (default inline) on an engine profile also upgrades to a session run", async () => {
    let ran = false;
    const port: SessionSubagentPort = {
      run: async (req) => {
        ran = true;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker" },
      makeCtx({ subagents: enginePort("claude-worker", ENGINE_PROFILE), sessionSubagents: port }),
    );
    expect(ran).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model plumbing fix: an engine profile's own `model:` frontmatter is parsed
// and validated (profiles.ts) and stored on PersonaDefinition/EngineProfileInfo,
// but was silently dropped between engineProfile() and the session request —
// the child booted on the engine CLI's own default instead of the model the
// profile author declared. The carried model is a DEFAULT, not an override:
// an explicit `Agent(model: …)` argument still wins (mirrors the precedence
// already established for inline/one-shot profiles, subagents/runner.ts
// `requestedModel = req.model ?? persona.model`).

describe("agentTool handler — engine-profile model default (model plumbing fix)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("a codex profile declaring model: spawns a child session carrying that model", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "codex-worker" },
      makeCtx({
        subagents: enginePort("codex-worker", {
          engine: "codex",
          systemPrompt: "PERSONA BODY",
          model: "profile-model",
        }),
        sessionSubagents: port,
      }),
    );
    expect(result.ok).toBe(true);
    expect(seen?.model).toBe("profile-model");
  });

  it("an explicit model argument beats the profile's frontmatter model", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await full.handler(
      { description: "d", prompt: "p", agent_type: "codex-worker", model: "explicit-model" },
      makeCtx({
        subagents: enginePort("codex-worker", {
          engine: "codex",
          systemPrompt: "PERSONA BODY",
          model: "profile-model",
        }),
        sessionSubagents: port,
      }),
    );
    expect(seen?.model).toBe("explicit-model");
  });

  it("a profile with no model: omits the model key entirely (no undefined riding the wire)", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker" },
      makeCtx({
        subagents: enginePort("claude-worker", { engine: "claude", systemPrompt: "PERSONA BODY" }),
        sessionSubagents: port,
      }),
    );
    expect(seen && "model" in seen).toBe(false);
  });

  it("engine: claude profile declaring model: also carries that model onto the request (fix is engine-agnostic)", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await full.handler(
      { description: "d", prompt: "p", agent_type: "claude-worker" },
      makeCtx({
        subagents: enginePort("claude-worker", {
          engine: "claude",
          systemPrompt: "PERSONA BODY",
          model: "claude-profile-model",
        }),
        sessionSubagents: port,
      }),
    );
    expect(seen?.model).toBe("claude-profile-model");
  });
});

// ---------------------------------------------------------------------------
// Codex engine profiles now run for real (TASK.143 lifts TASK.102
// S4-codex-cut): the refusal existed only because a codex child's flush had
// no trustworthy transcript source (`historyItems()` is a boot-time
// snapshot, frozen). `CodexEngine.readTranscript()` now re-runs the resume
// projection against a fresh `thread/read` on demand, so `codexFlushHistory`
// (host/index.ts) persists an honest, live transcript — the routing branch
// in agent.ts no longer needs to refuse before ever reaching
// runSessionTier/ctx.sessionSubagents. This describe block replaces the old
// "unsupported" pin: it proves codex now reaches the port exactly like
// claude does (see "engine-profile routing" above), rather than being
// special-cased into an immediate error.

describe("agentTool handler — codex engine profile now routes like claude (TASK.143)", () => {
  const full = createAgentTool({ sessionTier: true });
  const CODEX_PROFILE = { engine: "codex" as const, systemPrompt: "PERSONA BODY" };

  it('engine:"codex" reaches ctx.sessionSubagents.run — the request carries engine:"codex" — instead of an immediate refusal', async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_SESSION_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "do the task", agent_type: "codex-worker" },
      makeCtx({
        toolCallId: "call-codex-1",
        subagents: enginePort("codex-worker", CODEX_PROFILE),
        sessionSubagents: port,
      }),
    );
    expect(seen?.engine).toBe("codex");
    expect(seen?.spawnToolCallId).toBe("call-codex-1");
    expect(seen?.prompt).toBe("PERSONA BODY\n\n---\n\ndo the task");
    expect(result.ok).toBe(true);
  });

  it('engine:"codex" + provider => the SAME invalid_input rejection claude gets, before ever reaching the port', async () => {
    let spawned = false;
    const port: SessionSubagentPort = {
      run: async () => {
        spawned = true;
        return BASE_SESSION_OUTCOME;
      },
    };
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "codex-worker", tier: "session", provider: "anthropic-2" },
      makeCtx({
        subagents: enginePort("codex-worker", CODEX_PROFILE),
        sessionSubagents: port,
      }),
    );
    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe(
      'Agent: "provider" is not valid for an engine-profile agent — the child runs on its own CLI account.',
    );
  });

  it('engine:"codex" + no ctx.sessionSubagents => the SAME honest fail-closed error naming the engine claude gets', async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", agent_type: "codex-worker" },
      makeCtx({ subagents: enginePort("codex-worker", CODEX_PROFILE) }), // no sessionSubagents
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe(
      'Agent: agent type "codex-worker" runs on the "codex" engine; engine agents run as child sessions and are unavailable in this host.',
    );
  });
});

// ---------------------------------------------------------------------------
// Sanity: the exported `agentTool` constant (used by the permission engine
// and everywhere else that has not opted into sessionTier) is exactly
// createAgentTool()'s output, so nothing downstream silently changed shape.

describe("agentTool export sanity (CUT-S2 §2.1)", () => {
  it("agentTool === createAgentTool() in shape (metadata, restricted schema)", () => {
    const fresh = createAgentTool();
    expect(agentTool.metadata).toEqual(fresh.metadata);
    expect(z.toJSONSchema(agentTool.inputSchema)).toEqual(z.toJSONSchema(fresh.inputSchema));
  });
});

// ---------------------------------------------------------------------------
// TASK.145 срез 1: `detach` (session-tier only). Same non-recursion-lock
// discipline as `provider`/`tier` above — restricted schema never declares
// it, the handler refuses it on the wrong tier, and (unlike `provider`) a
// plain `false` is a legitimate no-op on any tier rather than a violation.

describe("createAgentTool — detach declaration (TASK.145 срез 1)", () => {
  it("restricted (default) has NO detach key and no \"background\" leak anywhere in the serialized JSON schema", () => {
    const restricted = createAgentTool();
    const jsonSchema = z.toJSONSchema(restricted.inputSchema) as { properties?: Record<string, unknown> };
    expect(Object.keys(jsonSchema.properties ?? {})).not.toContain("detach");
  });

  it("restricted schema REJECTS a smuggled detach:true instead of silently stripping it (F15 parity with provider)", () => {
    const smuggled = restrictedAgentInputSchema.safeParse({ description: "d", prompt: "p", detach: true });
    expect(smuggled.success).toBe(false);
  });

  it("full (sessionTier:true) DOES declare a detach key in the serialized JSON schema", () => {
    const full = createAgentTool({ sessionTier: true });
    const jsonSchema = z.toJSONSchema(full.inputSchema) as { properties?: Record<string, unknown> };
    expect(Object.keys(jsonSchema.properties ?? {})).toContain("detach");
  });

  it("full schema parses detach:true and detach:false", () => {
    expect(agentInputSchema.safeParse({ description: "d", prompt: "p", tier: "session", detach: true }).success).toBe(
      true,
    );
    expect(
      agentInputSchema.safeParse({ description: "d", prompt: "p", tier: "session", detach: false }).success,
    ).toBe(true);
  });
});

describe("agentTool handler — detach validation (TASK.145 срез 1, precedent: provider check agent.ts:207-212)", () => {
  it("detach:true with tier:\"inline\" (explicit) => invalid_input with the exact message", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", tier: "inline", detach: true }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe('Agent: "detach" is only valid with tier "session".');
  });

  it("detach:true with tier omitted (default inline) => invalid_input, same exact message", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", detach: true }, makeCtx());
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toBe('Agent: "detach" is only valid with tier "session".');
  });

  it("detach:true validation fires even with NO ports at all wired (fails fast, before any availability check)", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", detach: true }, makeCtx());
    expect(result.errorKind).toBe("invalid_input");
  });

  it("detach:false with tier:\"inline\" is VALID input (a false/no-op flag never conflicts with the tier) — reaches ctx.subagents unavailable instead", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", tier: "inline", detach: false }, makeCtx());
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe("Agent: subagents are unavailable in this context.");
  });

  it("detach:true WITH tier:\"session\" is valid input (no invalid_input) — reaches the availability lock instead", async () => {
    const full = createAgentTool({ sessionTier: true });
    const result = await full.handler({ description: "d", prompt: "p", tier: "session", detach: true }, makeCtx());
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toContain("unavailable");
  });
});

describe("agentTool handler — detach forwarding onto SessionSubagentRequest (TASK.145 срез 1)", () => {
  const full = createAgentTool({ sessionTier: true });

  it("forwards detach:true onto the request when input.detach is true", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: true },
      makeCtx({ sessionSubagents: port }),
    );
    expect(seen?.detach).toBe(true);
  });

  it("omits the detach key entirely when input.detach is false or absent (no silent `detach:false` riding the wire)", async () => {
    const seen: SessionSubagentRequest[] = [];
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen.push(req);
        return BASE_SESSION_OUTCOME;
      },
    };
    await full.handler({ description: "d", prompt: "p", tier: "session" }, makeCtx({ sessionSubagents: port }));
    await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: false },
      makeCtx({ sessionSubagents: port }),
    );
    expect(seen[0] && "detach" in seen[0]).toBe(false);
    expect(seen[1] && "detach" in seen[1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK.145 срез 1: the ADMIT-shaped outcome a detached port returns (this is
// what child-session-port.ts's `run()` actually resolves with at "accepted",
// never waiting for the child's own terminal — see that file's own tests for
// the port-level split). This suite proves agent.ts's SHARED outcome-mapping
// path (`outcomeToResult`/`finalizeSubagentCard`) handles that shape exactly
// as agent.ts's own header comment predicts, with ZERO detach-specific code
// in agent.ts itself: `status:"completed"` reads as success, and no
// presentation card is fabricated because no `subagent_start` progress ever
// preceded it.

describe("agentTool handler — detach admit outcome mapping (TASK.145 срез 1, zero special-casing in agent.ts)", () => {
  const full = createAgentTool({ sessionTier: true });

  function admitOnlyPort(finalText: string, childSessionId: string): SessionSubagentPort {
    // Mirrors child-session-port.ts's actual detach behavior: resolves
    // immediately on "accepted" with NO onProgress call at all (no start, no
    // end) — the run is still going; this port double never simulates its
    // eventual real terminal, matching the port's own "run() promise settles
    // at admit" contract.
    return {
      run: async () => ({
        status: "completed",
        finalText,
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
        childSessionId,
        parentSessionId: "parent-1",
        spawnToolCallId: "call-1",
      }),
    };
  }

  it("ok:true, and the model-visible text is the admit message (never empty, never waits for a 'real' result)", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: true },
      makeCtx({ sessionSubagents: admitOnlyPort("Agent: child session child-42 started in the background.", "child-42") }),
    );
    expect(result.ok).toBe(true);
    expect(result.output?.finalText).toContain("child-42");
    expect(result.output?.finalText).toContain("background");
  });

  it("builds NO presentation card (mirrors the sync 'never fabricated' rule — no subagent_start ever fired)", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: true },
      makeCtx({ sessionSubagents: admitOnlyPort("started", "child-1") }),
    );
    expect(result.presentation).toBeUndefined();
  });

  it("the admit outcome's zero counters (turns/toolCalls/durationMs) ride the tool output honestly — they describe the SPAWN, not fabricated child progress", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: true },
      makeCtx({ sessionSubagents: admitOnlyPort("started", "child-1") }),
    );
    expect(result.output).toMatchObject({ turns: 0, toolCalls: 0, durationMs: 0, truncated: false, status: "completed" });
  });

  it("the tool's own output never leaks the three session ids — mirrors the sync-tier rule (CUT-S2 §2.1): ids ride ONLY the (absent-here) presentation target", async () => {
    const result = await full.handler(
      { description: "d", prompt: "p", tier: "session", detach: true },
      makeCtx({ sessionSubagents: admitOnlyPort("started", "child-1") }),
    );
    expect(result.output).not.toHaveProperty("childSessionId");
    expect(result.output).not.toHaveProperty("parentSessionId");
    expect(result.output).not.toHaveProperty("spawnToolCallId");
  });
});

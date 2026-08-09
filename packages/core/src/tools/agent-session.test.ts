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
import type { SubagentRunOptions } from "../ports/subagent.js";

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
    expect(result.error).toContain("max turn limit");
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
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "attention", waiting: true });
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 10 });
        return { ...BASE_SESSION_OUTCOME, status: "completed" };
      },
    };
    const withoutAttentionPort: SessionSubagentPort = {
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 10 });
        return { ...BASE_SESSION_OUTCOME, status: "completed" };
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

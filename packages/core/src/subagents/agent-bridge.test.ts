/**
 * Agent MCP-bridge core logic (TASK.226 срез S1). Covers the three pieces
 * agent-bridge.ts adds on top of the moved projection helpers (already
 * proven byte-identical by tools/agent.test.ts and tools/agent-session.test.ts,
 * which stay green unmodified — see this file's own parity block below):
 * the catalog->tool-declaration projection (§3.1), the shared session-tier
 * request builder (§3.2), and the call handler `runAgentBridgeCall` (§3.4)
 * that a claude-CLI child eventually reaches through the host's control-
 * channel glue (срез S3, out of this file's scope).
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildAgentBridgeToolDecl,
  buildSessionSubagentRequest,
  decodeAgentBridgeCallInput,
  runAgentBridgeCall,
  type AgentBridgeCatalogEntry,
} from "./agent-bridge.js";
import { createAgentTool } from "../tools/agent.js";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type {
  SessionSubagentOutcome,
  SessionSubagentPort,
  SessionSubagentRequest,
} from "../ports/session-subagent.js";
import type { EngineProfileInfo, SubagentPort, SubagentRunOptions } from "../ports/subagent.js";
import type { SubagentCardEvent } from "./card-snapshot.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: {} as CorePorts,
    ...overrides,
  };
}

const BASE_OUTCOME: SessionSubagentOutcome = {
  status: "completed",
  finalText: "child session done",
  truncated: false,
  turns: 2,
  toolCalls: 3,
  durationMs: 500,
  childSessionId: "child-1",
  parentSessionId: "parent-1",
  spawnToolCallId: "toolu_bridge_1",
};

// ---------------------------------------------------------------------------
// §3.1 — buildAgentBridgeToolDecl

describe("buildAgentBridgeToolDecl (§3.1)", () => {
  const CATALOG: AgentBridgeCatalogEntry[] = [
    { name: "codex-worker", description: "Runs codex tasks", engine: "codex", model: "gpt-5.6", systemPrompt: "P1" },
    { name: "reviewer", description: "Reviews diffs", systemPrompt: "P2" },
  ];

  it("enum is exactly the catalog's names, in catalog order", () => {
    const decl = buildAgentBridgeToolDecl(CATALOG);
    expect(decl).not.toBeNull();
    const schema = decl?.inputSchema as { properties?: { agent_type?: { enum?: string[] } } };
    expect(schema.properties?.agent_type?.enum).toEqual(["codex-worker", "reviewer"]);
  });

  it("description names the tool's purpose and one line per profile with engine/model", () => {
    const decl = buildAgentBridgeToolDecl(CATALOG);
    expect(decl?.name).toBe("agent");
    expect(decl?.description).toContain("codex-worker (codex, model gpt-5.6): Runs codex tasks");
    expect(decl?.description).toContain("reviewer (core, model inherited): Reviews diffs");
  });

  it("empty catalog => null (the tool is not announced, no fabricated placeholder enum)", () => {
    expect(buildAgentBridgeToolDecl([])).toBeNull();
  });

  it("declared schema requires description/prompt/agent_type and accepts an optional model", () => {
    const decl = buildAgentBridgeToolDecl(CATALOG);
    const schema = decl?.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["description", "prompt", "agent_type"]));
    expect(schema.required).not.toContain("model");
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["description", "prompt", "agent_type", "model"]),
    );
  });
});

// ---------------------------------------------------------------------------
// §3.2 — buildSessionSubagentRequest

describe("buildSessionSubagentRequest (§3.2)", () => {
  it("engine profile: prompt is systemPrompt + separator + prompt, engine is stamped, model falls back to the profile's own", () => {
    const profile: EngineProfileInfo = { engine: "codex", systemPrompt: "PERSONA BODY", model: "profile-model" };
    const request = buildSessionSubagentRequest({
      agentType: "codex-worker",
      description: "d",
      prompt: "do the task",
      spawnToolCallId: "toolu_1",
      profile,
    });
    expect(request.prompt).toBe("PERSONA BODY\n\n---\n\ndo the task");
    expect(request.engine).toBe("codex");
    expect(request.model).toBe("profile-model");
    expect(request.spawnToolCallId).toBe("toolu_1");
    expect(request.provider).toBeUndefined();
    expect(request.detach).toBeUndefined();
  });

  it("an explicit model argument outranks the profile's own model default", () => {
    const profile: EngineProfileInfo = { engine: "codex", systemPrompt: "PERSONA BODY", model: "profile-model" };
    const request = buildSessionSubagentRequest({
      agentType: "codex-worker",
      description: "d",
      prompt: "p",
      model: "explicit-model",
      spawnToolCallId: "toolu_1",
      profile,
    });
    expect(request.model).toBe("explicit-model");
  });

  it("core profile (no `profile` argument): prompt rides as-is, no `engine` key on the request", () => {
    const request = buildSessionSubagentRequest({
      agentType: "reviewer",
      description: "d",
      prompt: "review this",
      spawnToolCallId: "toolu_2",
    });
    expect(request.prompt).toBe("review this");
    expect(request.engine).toBeUndefined();
  });

  it("no model anywhere => the model key is entirely absent (no `undefined` riding the wire)", () => {
    const request = buildSessionSubagentRequest({
      agentType: "reviewer",
      description: "d",
      prompt: "p",
      spawnToolCallId: "toolu_3",
    });
    expect("model" in request).toBe(false);
  });

  // Parity pin (S1 DoD): the shared builder must reproduce EXACTLY the request
  // tools/agent.ts's runSessionTier builds for the same inputs, on three
  // fixtures spanning an engine profile with an override, an engine profile
  // without one, and a plain core session-tier call. Exercised through the
  // real createAgentTool factory (runSessionTier is module-private) with a
  // fake port that captures the request it received.
  describe("parity: byte-identical to what tools/agent.ts's runSessionTier builds", () => {
    function enginePort(agentType: string, profile: EngineProfileInfo): SubagentPort {
      return {
        listAgentTypes: () => [agentType],
        engineProfile: (t) => (t === agentType ? profile : null),
        run: async () => {
          throw new Error("inline subagents.run must not be reached");
        },
      };
    }

    async function capturedRequest(
      input: Parameters<ReturnType<typeof createAgentTool>["handler"]>[0],
      ctxOverrides: Partial<ToolContext>,
    ): Promise<SessionSubagentRequest> {
      let seen: SessionSubagentRequest | undefined;
      const port: SessionSubagentPort = {
        run: async (req) => {
          seen = req;
          return { ...BASE_OUTCOME, spawnToolCallId: req.spawnToolCallId };
        },
      };
      const full = createAgentTool({ sessionTier: true });
      await full.handler(input, makeCtx({ sessionSubagents: port, ...ctxOverrides }));
      if (seen === undefined) {
        throw new Error("the port was never called");
      }
      return seen;
    }

    it("fixture 1: engine profile, explicit model override", async () => {
      const profile: EngineProfileInfo = { engine: "claude", systemPrompt: "PERSONA A", model: "profile-model-a" };
      const seen = await capturedRequest(
        { description: "d1", prompt: "task one", agent_type: "claude-worker", model: "override-model" },
        { toolCallId: "call-fx-1", subagents: enginePort("claude-worker", profile) },
      );
      const built = buildSessionSubagentRequest({
        agentType: "claude-worker",
        description: "d1",
        prompt: "task one",
        model: "override-model",
        spawnToolCallId: "call-fx-1",
        profile,
      });
      expect(seen).toEqual(built);
    });

    it("fixture 2: engine profile, no override (falls back to the profile's own model)", async () => {
      const profile: EngineProfileInfo = { engine: "codex", systemPrompt: "PERSONA B", model: "profile-model-b" };
      const seen = await capturedRequest(
        { description: "d2", prompt: "task two", agent_type: "codex-worker" },
        { toolCallId: "call-fx-2", subagents: enginePort("codex-worker", profile) },
      );
      const built = buildSessionSubagentRequest({
        agentType: "codex-worker",
        description: "d2",
        prompt: "task two",
        spawnToolCallId: "call-fx-2",
        profile,
      });
      expect(seen).toEqual(built);
    });

    it("fixture 3: plain core session-tier call (no engine profile) plus provider/detach", async () => {
      const seen = await capturedRequest(
        {
          description: "d3",
          prompt: "task three",
          agent_type: "explore",
          tier: "session",
          provider: "anthropic-2",
          detach: true,
        },
        { toolCallId: "call-fx-3" },
      );
      const built = {
        ...buildSessionSubagentRequest({
          agentType: "explore",
          description: "d3",
          prompt: "task three",
          spawnToolCallId: "call-fx-3",
        }),
        provider: "anthropic-2",
        detach: true,
      };
      expect(seen).toEqual(built);
    });
  });
});

// ---------------------------------------------------------------------------
// §3.4 — runAgentBridgeCall

describe("runAgentBridgeCall (§3.4)", () => {
  const CORE_ENTRY: AgentBridgeCatalogEntry = { name: "reviewer", description: "Reviews diffs", systemPrompt: "P" };
  const ENGINE_ENTRY: AgentBridgeCatalogEntry = {
    name: "codex-worker",
    description: "Runs codex tasks",
    engine: "codex",
    model: "profile-model",
    systemPrompt: "PERSONA BODY",
  };

  function portReturning(outcome: SessionSubagentOutcome): SessionSubagentPort {
    return { run: async () => outcome };
  }

  it("unknown agent_type => isError with the exact list-bearing message, no port call", async () => {
    const port: SessionSubagentPort = {
      run: async () => {
        throw new Error("must not be reached for an unknown agent_type");
      },
    };
    const result = await runAgentBridgeCall(
      { agent_type: "ghost", description: "d", prompt: "p" },
      { catalog: [CORE_ENTRY, ENGINE_ENTRY], port, spawnToolCallId: "toolu_1" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Unknown agent_type "ghost". Available agent types: reviewer, codex-worker.');
  });

  it("completed outcome => isError false, text is the finalText, presentation targets the session", async () => {
    const result = await runAgentBridgeCall(
      { agent_type: "codex-worker", description: "d", prompt: "p" },
      {
        catalog: [ENGINE_ENTRY],
        port: portReturning(BASE_OUTCOME),
        spawnToolCallId: BASE_OUTCOME.spawnToolCallId,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toBe("child session done");
  });

  it("engine entry: request carries the composed prompt/engine/model (proves runAgentBridgeCall routes through buildSessionSubagentRequest)", async () => {
    let seen: SessionSubagentRequest | undefined;
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await runAgentBridgeCall(
      { agent_type: "codex-worker", description: "d", prompt: "do it" },
      { catalog: [ENGINE_ENTRY], port, spawnToolCallId: "toolu_2" },
    );
    expect(seen?.prompt).toBe("PERSONA BODY\n\n---\n\ndo it");
    expect(seen?.engine).toBe("codex");
    expect(seen?.model).toBe("profile-model");
    expect(seen?.spawnToolCallId).toBe("toolu_2");
  });

  it("core entry: profile body and model default reach the session child without an engine override", async () => {
    let seen: SessionSubagentRequest | undefined;
    const coreWithModel: AgentBridgeCatalogEntry = { ...CORE_ENTRY, model: "core-default-model" };
    const port: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await runAgentBridgeCall(
      { agent_type: "reviewer", description: "d", prompt: "review" },
      { catalog: [coreWithModel], port, spawnToolCallId: "toolu_3" },
    );
    expect(seen?.prompt).toBe("P\n\n---\n\nreview");
    expect(seen?.engine).toBeUndefined();
    expect(seen?.model).toBe("core-default-model");
  });

  it("max_turns outcome => text carries the incomplete-result marker (same wording outcomeToResult produces)", async () => {
    const result = await runAgentBridgeCall(
      { agent_type: "reviewer", description: "d", prompt: "p" },
      {
        catalog: [CORE_ENTRY],
        port: portReturning({ ...BASE_OUTCOME, status: "max_turns", finalText: "partial work", turns: 4 }),
        spawnToolCallId: "toolu_4",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("INCOMPLETE SUBAGENT RESULT");
    expect(result.text).toContain("partial work");
    expect(result.text).toContain("4 turns");
  });

  it("onEvent receives start/progress/end, each stamped with the passed spawnToolCallId", async () => {
    const events: SubagentCardEvent[] = [];
    const port: SessionSubagentPort = {
      run: async (req, opts: SubagentRunOptions) => {
        opts.onProgress?.({ kind: "start", agentType: "reviewer", description: "d" });
        opts.onProgress?.({ kind: "progress", turns: 1, toolCalls: 1 });
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 10 });
        return { ...BASE_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await runAgentBridgeCall(
      { agent_type: "reviewer", description: "d", prompt: "p" },
      { catalog: [CORE_ENTRY], port, spawnToolCallId: "toolu_events", onEvent: (ev) => events.push(ev) },
    );
    expect(events.map((ev) => ev.type)).toEqual(["subagent_start", "subagent_progress", "subagent_end"]);
    for (const ev of events) {
      expect(ev.toolCallId).toBe("toolu_events");
    }
  });

  it("caller-supplied signal.abort() propagates into the port's own signal, and a resulting `cancelled` outcome reads as cancelled (not the wall message)", async () => {
    const controller = new AbortController();
    let observedAbort = false;
    const port: SessionSubagentPort = {
      run: (req, opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve({ ...BASE_OUTCOME, status: "cancelled", finalText: "", spawnToolCallId: req.spawnToolCallId });
          });
        }),
    };
    const promise = runAgentBridgeCall(
      { agent_type: "reviewer", description: "d", prompt: "p" },
      { catalog: [CORE_ENTRY], port, spawnToolCallId: "toolu_5", signal: controller.signal },
    );
    controller.abort();
    const result = await promise;
    expect(observedAbort).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Agent: the subagent was cancelled.");
  });

  it("wall timeout: the call is aborted and reported as `error` with the exact wall message, not the port's own outcome", async () => {
    vi.useFakeTimers();
    try {
      const port: SessionSubagentPort = {
        run: (req, opts) =>
          new Promise((resolve) => {
            opts.signal?.addEventListener("abort", () => {
              resolve({ ...BASE_OUTCOME, status: "cancelled", finalText: "", spawnToolCallId: req.spawnToolCallId });
            });
          }),
      };
      const promise = runAgentBridgeCall(
        { agent_type: "reviewer", description: "d", prompt: "p" },
        { catalog: [CORE_ENTRY], port, spawnToolCallId: "toolu_6", wallMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      const result = await promise;
      expect(result.isError).toBe(true);
      expect(result.text).toBe("Agent: the child session exceeded the 10ms wall and was cancelled.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("decodeAgentBridgeCallInput (TASK.226 срез S4)", () => {
  it("a well-formed args object decodes verbatim, including the optional model", () => {
    expect(
      decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p", model: "opus" }),
    ).toEqual({ agent_type: "reviewer", description: "d", prompt: "p", model: "opus" });
  });

  it("model is omitted from the result when the wire args omit it", () => {
    expect(decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p" })).toEqual({
      agent_type: "reviewer",
      description: "d",
      prompt: "p",
    });
  });

  for (const field of ["agent_type", "description", "prompt"] as const) {
    it(`missing "${field}" decodes to null`, () => {
      const args: Record<string, unknown> = { agent_type: "reviewer", description: "d", prompt: "p" };
      delete args[field];
      expect(decodeAgentBridgeCallInput(args)).toBeNull();
    });

    it(`a non-string "${field}" decodes to null`, () => {
      expect(
        decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p", [field]: 42 }),
      ).toBeNull();
    });

    it(`an empty-string "${field}" decodes to null`, () => {
      expect(
        decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p", [field]: "" }),
      ).toBeNull();
    });
  }

  it("a non-string, present model decodes to null", () => {
    expect(
      decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p", model: 7 }),
    ).toBeNull();
  });

  it("an empty-string model decodes to null", () => {
    expect(
      decodeAgentBridgeCallInput({ agent_type: "reviewer", description: "d", prompt: "p", model: "" }),
    ).toBeNull();
  });
});

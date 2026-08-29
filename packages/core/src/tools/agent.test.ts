/**
 * Agent tool contract guards (Phase 3 slice 3.1, design §3.4). Covers the two
 * fail-closed locks and the frozen metadata; the real run->outcome mapping and
 * progress bridge are exercised by slice 3.1.2's hermetic tests.
 */

import { describe, expect, it } from "vitest";
import { agentTool } from "./agent.js";
import { agentInputSchema } from "./schemas.js";
import type { ToolContext, ToolEmittedEvent } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import {
  SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS,
  SUBAGENT_TIME_BUDGET_MS,
} from "../types/config.js";
import { SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS } from "../subagents/summarize-tool.js";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRequest,
  SubagentRunOptions,
} from "../ports/subagent.js";
import type { SessionSubagentPort } from "../ports/session-subagent.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: {} as CorePorts,
    ...overrides,
  };
}

const throwingPort: SubagentPort = {
  run: async () => {
    throw new Error("run must not be reached in this test");
  },
};

describe("agentTool", () => {
  it("carries the frozen metadata (design §3.4/R6)", () => {
    expect(agentTool.metadata).toMatchObject({
      name: "Agent",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "process",
      needsApproval: false,
      timeoutMs: 21_600_000,
      maxTimeoutMs: 21_600_000,
      maxOutputBytes: 100_000,
    });
  });

  it("fails closed with an 'unavailable' error-outcome when no subagent port is present (non-recursion lock)", async () => {
    const result = await agentTool.handler(
      { description: "look around", prompt: "explore the repo", agent_type: "explore" },
      makeCtx(), // subagents undefined
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
    expect(result.errorKind).toBeUndefined();
  });

  it("returns invalid_input listing the available personas for an unknown agent_type", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "does-not-exist" },
      makeCtx({ subagents: throwingPort }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toContain("does-not-exist");
    expect(result.error).toContain("general-purpose");
    expect(result.error).toContain("explore");
  });

  it("validates agent_type BEFORE the availability lock (unknown persona wins even without a port)", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "nope" },
      makeCtx(), // no port
    );
    expect(result.errorKind).toBe("invalid_input");
  });

  it("defaults agent_type to general-purpose and maps a completed outcome onto the tool result", async () => {
    let seen: SubagentRequest | undefined;
    const outcome: SubagentOutcome = {
      status: "completed",
      finalText: "done exploring",
      truncated: false,
      turns: 3,
      toolCalls: 4,
      durationMs: 12,
    };
    const port: SubagentPort = {
      run: async (req: SubagentRequest, _opts: SubagentRunOptions) => {
        seen = req;
        return outcome;
      },
    };

    const result = await agentTool.handler(
      { description: "look", prompt: "go" }, // agent_type omitted
      makeCtx({ subagents: port }),
    );

    expect(seen?.agentType).toBe("general-purpose");
    expect(seen?.description).toBe("look");
    expect(seen?.prompt).toBe("go");
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      status: "completed",
      finalText: "done exploring",
      turns: 3,
      toolCalls: 4,
    });
    // The model sees the child's finalText, not the JSON envelope.
    expect(agentTool.formatResultForModel?.(result)).toBe("done exploring");
  });

  it("maps an error-status subagent outcome onto an error-outcome", async () => {
    const port: SubagentPort = {
      run: async () => ({
        status: "error",
        finalText: "boom",
        truncated: false,
        turns: 1,
        toolCalls: 0,
        durationMs: 1,
      }),
    };
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({ subagents: port }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// TASK.44 — honest outcome mapping. Only `completed` is success; max_turns and
// cancelled must NOT pass as ok:true. Covers all four terminal outcomes with
// empty and non-empty partial finalText, the regression scenario (8 turns,
// empty finalText), and the model-visible text the parent receives.

describe("agentTool — honest outcome mapping (TASK.44)", () => {
  function portReturning(outcome: SubagentOutcome): SubagentPort {
    return { run: async () => outcome };
  }

  it("max_turns with a NON-empty partial result → ok:false, errorKind max_turns, partial rides the error", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "max_turns",
          finalText: "I found three files but did not finish the analysis.",
          truncated: false,
          turns: 8,
          toolCalls: 7,
          durationMs: 42,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("max_turns");
    // The partial result is forwarded so it is not lost...
    expect(result.error).toContain("I found three files but did not finish the analysis.");
    // ...behind a marker the parent model cannot read as a finished report
    // (TASK.74 §5), and the message names the budget and the turns spent.
    expect(result.error).toContain("INCOMPLETE SUBAGENT RESULT");
    expect(result.error).toContain("ran out of budget");
    expect(result.error).toContain("8 turns");
    // The marker precedes the partial, so the warning is read first.
    expect(result.error!.indexOf("INCOMPLETE SUBAGENT RESULT")).toBeLessThan(
      result.error!.indexOf("I found three files"),
    );
    // The model-visible text is the error (non-empty), never an empty success.
    expect(agentTool.formatResultForModel?.(result)).toBe(result.error);
    // "raise maxTurns" is gone: the Agent schema has no such field, so the
    // advice was unactionable (TASK.74 §2.6/§5).
    expect(agentTool.formatResultForModel?.(result)).not.toContain("raise maxTurns");
  });

  it("REGRESSION: max_turns with an EMPTY finalText → ok:false, non-empty error, never a silent success", async () => {
    // The original incident: 8 turns, empty finalText → parent saw an empty
    // successful tool result and re-delegated blindly.
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "max_turns",
          finalText: "",
          truncated: false,
          turns: 8,
          toolCalls: 7,
          durationMs: 42,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("max_turns");
    // The error is non-empty and actionable even with no partial text.
    expect(result.error).toContain("ran out of budget");
    expect(result.error).toContain("8 turns");
    expect(result.error).toContain("not completed");
    // Nothing to mark INCOMPLETE when there is no partial at all.
    expect(result.error).not.toContain("INCOMPLETE SUBAGENT RESULT");
    // The model-visible text is non-empty — a blind re-delegation would now
    // see the budget message, not an empty success.
    const modelText = agentTool.formatResultForModel?.(result) ?? "";
    expect(modelText.length).toBeGreaterThan(0);
    expect(modelText).not.toContain("raise maxTurns");
  });

  it("the dispatcher wall comes from SUBAGENT_TIME_BUDGET_MS (TASK.74 §5)", () => {
    expect(agentTool.metadata.timeoutMs).toBe(SUBAGENT_TIME_BUDGET_MS);
    expect(agentTool.metadata.maxTimeoutMs).toBe(SUBAGENT_TIME_BUDGET_MS);
  });

  it("cancelled → ok:false, errorKind cancelled, never success", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "cancelled",
          finalText: "",
          truncated: false,
          turns: 0,
          toolCalls: 0,
          durationMs: 1,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("cancelled");
    expect(result.error).toContain("cancelled");
  });

  it("cancelled with a NON-empty partial preserves it in output but remains cancelled", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "cancelled",
          finalText: "partial before cancellation",
          truncated: false,
          turns: 2,
          toolCalls: 1,
          durationMs: 3,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("cancelled");
    expect(result.output?.finalText).toBe("partial before cancellation");
  });

  it("error → ok:false, no errorKind (falls back to dispatcher 'error')", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "error",
          finalText: "boom",
          truncated: false,
          turns: 1,
          toolCalls: 0,
          durationMs: 1,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe("boom");
  });

  it("error with an EMPTY finalText → ok:false with a non-empty fallback", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "error",
          finalText: "",
          truncated: false,
          turns: 1,
          toolCalls: 0,
          durationMs: 1,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBe("Agent: the subagent failed.");
  });

  it("completed → ok:true (the only success)", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "completed",
          finalText: "all done",
          truncated: false,
          turns: 2,
          toolCalls: 1,
          durationMs: 3,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.errorKind).toBeUndefined();
    expect(agentTool.formatResultForModel?.(result)).toBe("all done");
  });

  it("completed with an EMPTY finalText remains the only successful empty result", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "general-purpose" },
      makeCtx({
        subagents: portReturning({
          status: "completed",
          finalText: "",
          truncated: false,
          turns: 1,
          toolCalls: 0,
          durationMs: 1,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.errorKind).toBeUndefined();
    expect(agentTool.formatResultForModel?.(result)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// listAgentTypes-driven validation (slice 3.3.3, design §2.3): the Agent tool
// delegates the set of runnable agent types to the port so md-profiles are
// reachable and listed WITHOUT touching the frozen agentInputSchema.

function portWithTypes(
  types: string[],
  onRun?: (req: SubagentRequest) => void,
): SubagentPort {
  return {
    listAgentTypes: () => types,
    run: async (req: SubagentRequest, _opts: SubagentRunOptions): Promise<SubagentOutcome> => {
      onRun?.(req);
      return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
    },
  };
}

describe("agentTool — listAgentTypes-driven validation (slice 3.3.3)", () => {
  it("invalid_input for an unknown agent_type lists the port's profiles", async () => {
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "ghost" },
      makeCtx({ subagents: portWithTypes(["general-purpose", "explore", "reviewer", "triager"]) }),
    );
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toContain("ghost");
    expect(result.error).toContain("reviewer");
    expect(result.error).toContain("triager");
  });

  it("a profile agent_type is reachable — it reaches the port's run()", async () => {
    let seen: SubagentRequest | undefined;
    const result = await agentTool.handler(
      { description: "review", prompt: "review it", agent_type: "reviewer" },
      makeCtx({ subagents: portWithTypes(["general-purpose", "explore", "reviewer"], (r) => (seen = r)) }),
    );
    expect(result.ok).toBe(true);
    expect(seen?.agentType).toBe("reviewer");
  });

  it("falls back to the built-in persona list when the port lacks listAgentTypes", async () => {
    // throwingPort has no listAgentTypes: a profile name is unknown against the
    // built-in fallback and is rejected BEFORE run() is ever reached.
    const result = await agentTool.handler(
      { description: "x", prompt: "y", agent_type: "reviewer" },
      makeCtx({ subagents: throwingPort }),
    );
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toContain("general-purpose");
    expect(result.error).toContain("explore");
  });
});

// ---------------------------------------------------------------------------
// model field (Phase 4 slice 4.6, design §2.5). agentInputSchema stays a plain
// string field (no validation beyond non-empty) — the runner is the only
// citizen that decides whether an override can be honored.

describe("agentInputSchema — model field (slice 4.6, design §2.5)", () => {
  it("parses with an explicit model id", () => {
    const result = agentInputSchema.safeParse({ description: "d", prompt: "p", model: "glm-4.6" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.model).toBe("glm-4.6");
  });

  it("parses without a model (optional field, undefined when absent)", () => {
    const result = agentInputSchema.safeParse({ description: "d", prompt: "p" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.model).toBeUndefined();
  });

  it("rejects an empty-string model", () => {
    const result = agentInputSchema.safeParse({ description: "d", prompt: "p", model: "" });
    expect(result.success).toBe(false);
  });
});

describe("agentTool — model prokidka into ctx.subagents.run (slice 4.6, design §2.5)", () => {
  it("forwards input.model onto the SubagentRequest when present", async () => {
    let seen: SubagentRequest | undefined;
    const port: SubagentPort = {
      run: async (req: SubagentRequest) => {
        seen = req;
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "general-purpose", model: "glm-4.6" },
      makeCtx({ subagents: port }),
    );

    expect(seen?.model).toBe("glm-4.6");
  });

  it("omits the model key from the SubagentRequest when input.model is absent (no silent undefined)", async () => {
    let seen: SubagentRequest | undefined;
    const port: SubagentPort = {
      run: async (req: SubagentRequest) => {
        seen = req;
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "general-purpose" },
      makeCtx({ subagents: port }),
    );

    expect(seen).toBeDefined();
    expect(seen && "model" in seen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// subagent_activity bridge (slice P7.18/F16b): a { kind:"tool" } SubagentProgress
// from the port maps 1:1 onto a subagent_activity AgentEvent stamped with the
// Agent tool call's id, alongside the existing subagent_start/progress/end.

describe("agentTool — subagent_activity bridge (slice P7.18/F16b)", () => {
  it("maps a tool-kind progress onto a subagent_activity event stamped with toolCallId", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "tool", toolName: "Bash", summary: "npm run build" });
        opts.onProgress?.({ kind: "progress", turns: 1, toolCalls: 1, lastTool: "Bash" });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 1, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-42", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const activity = emitted.filter((e) => e.type === "subagent_activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toEqual({
      type: "subagent_activity",
      toolCallId: "call-42",
      toolName: "Bash",
      summary: "npm run build",
    });
    // The other coarse variants still bridge, so the activity case is additive.
    expect(emitted.some((e) => e.type === "subagent_start")).toBe(true);
    expect(emitted.some((e) => e.type === "subagent_progress")).toBe(true);
  });

  it("forwards progress.engine onto the subagent_start event when the port reports one (TASK.97 R5)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "start", agentType: "general-purpose", description: "d", engine: "codex" });
        return { status: "completed", finalText: "ok", truncated: false, turns: 0, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "general-purpose" },
      makeCtx({ toolCallId: "call-engine", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const start = emitted.find((e) => e.type === "subagent_start");
    expect(start).toMatchObject({ type: "subagent_start", engine: "codex" });
  });

  it("omits the engine key from subagent_start when the port's start progress carries none (in-process child, no silent default)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-no-engine", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const start = emitted.find((e) => e.type === "subagent_start");
    expect(start).toBeDefined();
    expect(start && "engine" in start).toBe(false);
  });

  it(
    "W1-FIX: caps an over-long toolName/summary at the bridge before it becomes " +
      "an AgentEvent (defense-in-depth — a hostile/buggy SubagentPort, not just the runner)",
    async () => {
      const emitted: ToolEmittedEvent[] = [];
      const hugeName = "X".repeat(5_000);
      const hugeSummary = "y".repeat(5_000);
      const port: SubagentPort = {
        run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
          opts.onProgress?.({ kind: "tool", toolName: hugeName, summary: hugeSummary });
          return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 1, durationMs: 1 };
        },
      };

      await agentTool.handler(
        { description: "d", prompt: "p", agent_type: "explore" },
        makeCtx({ toolCallId: "call-huge", subagents: port, emit: (e) => emitted.push(e) }),
      );

      const activity = emitted.find((e) => e.type === "subagent_activity");
      expect(activity?.type).toBe("subagent_activity");
      if (activity?.type !== "subagent_activity") throw new Error("unreachable");
      expect(activity.toolName.length).toBe(SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS);
      expect(activity.toolName.endsWith("…")).toBe(true);
      expect(activity.summary.length).toBe(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS);
      expect(activity.summary.endsWith("…")).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // activitySuppressed bridge (TASK.102 slice S1 W2, CUT-S1 §3 W2): the port's
  // { kind:"end", activitySuppressed } progress field copies byte-identically
  // onto the subagent_end AgentEvent, so the persisted card's dropped count
  // (fed by this event, W3) is never silently zeroed at the bridge.

  it("copies progress.activitySuppressed onto the subagent_end event byte-exactly", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "end", status: "completed", turns: 2, durationMs: 10, activitySuppressed: 17 });
        return { status: "completed", finalText: "ok", truncated: false, turns: 2, toolCalls: 500, durationMs: 10 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-suppressed", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const end = emitted.find((e) => e.type === "subagent_end");
    expect(end).toEqual({
      type: "subagent_end",
      toolCallId: "call-suppressed",
      status: "completed",
      turns: 2,
      durationMs: 10,
      activitySuppressed: 17,
    });
  });

  it("omits activitySuppressed from subagent_end when the port's end progress carries none (no silent zero)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 5 });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 5 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-no-suppressed", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const end = emitted.find((e) => e.type === "subagent_end");
    expect(end).toBeDefined();
    expect(end && "activitySuppressed" in end).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TASK.171: mapProgressToEvent's "end" case now bridges TWO distinct model
  // fields — `model` (the requested id) and `responseModel` (the provider's
  // own claim) — onto the subagent_end AgentEvent, neither one a fallback for
  // the other.

  it("bridges progress.model and progress.responseModel onto subagent_end as two distinct fields", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({
          kind: "end",
          status: "completed",
          turns: 1,
          durationMs: 5,
          model: "glm-5.3-flash",
          responseModel: "glm-5.3",
        });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 5 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-model-pair", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const end = emitted.find((e) => e.type === "subagent_end");
    expect(end).toEqual({
      type: "subagent_end",
      toolCallId: "call-model-pair",
      status: "completed",
      turns: 1,
      durationMs: 5,
      model: "glm-5.3-flash",
      responseModel: "glm-5.3",
    });
  });

  it("a provider that reports nothing back omits responseModel from subagent_end without dropping model", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "end", status: "completed", turns: 1, durationMs: 5, model: "glm-5.3-flash" });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 5 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-model-only", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const end = emitted.find((e) => e.type === "subagent_end");
    expect(end && "model" in end && end.model).toBe("glm-5.3-flash");
    expect(end && "responseModel" in end).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapProgressToEvent's attention case (TASK.102 CUT-S2 §2.2/§0.8): a
// { kind:"attention" } SubagentProgress maps 1:1 onto a subagent_attention
// AgentEvent stamped with the Agent tool call's id, mirroring the existing
// start/progress/tool/end bridges.
//
// SCOPE, pinned per review finding 3 (these tests were previously titled
// "session-tier" without actually exercising a session-tier port — see the
// track memo): `agentTool` today is the PRE-B1 tool — `tools/schemas.ts` has
// no `tier` field yet and this handler never reads `ctx.sessionSubagents`
// (grep confirms). The two tests below drive a FAKE `SubagentPort` through
// `ctx.subagents` (the only wired port today) purely to prove the SHARED
// `mapProgressToEvent` function forwards an attention progress correctly
// WHEN one arrives on ANY port. They prove neither:
//   (a) that the REAL inline runner (subagents/runner.ts) ever produces one
//       — it must not (ports/subagent.ts's doc comment: "the in-process
//       inline runner never emits it"); that half is runner.ts's own tests'
//       job, out of this file;
//   (b) that the real session-tier port (SessionSubagentPort, built in slice
//       B1, CUT-S2 §3 — NOT this slice) routes its attention progress through
//       THIS SAME bridge. A B1 implementation that hand-rolls its own event
//       mapping and forgets the attention case would leave these two tests
//       green while the live waiting-badge never appears — B1's OWN tests
//       (agent-session.test.ts per the CUT's test plan) are what must prove
//       (b) end to end; this file does not, and must not attempt to.
describe("agentTool — mapProgressToEvent's attention case (TASK.102 CUT-S2 §2.2, bridge-only — see scope comment above)", () => {
  it("maps an attention progress (waiting:true) onto a subagent_attention event stamped with toolCallId — bridge only, not proof any real port emits one (see scope comment)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({ kind: "attention", waiting: true });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-attn", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const attention = emitted.filter((e) => e.type === "subagent_attention");
    expect(attention).toHaveLength(1);
    expect(attention[0]).toEqual({
      type: "subagent_attention",
      toolCallId: "call-attn",
      waiting: true,
    });
  });

  it("maps an attention progress (waiting:false) onto a subagent_attention event with waiting:false — bridge only, not proof any real port emits one (see scope comment)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "attention", waiting: false });
        return { status: "completed", finalText: "ok", truncated: false, turns: 0, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-attn-2", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const attention = emitted.find((e) => e.type === "subagent_attention");
    expect(attention).toEqual({
      type: "subagent_attention",
      toolCallId: "call-attn-2",
      waiting: false,
    });
  });

  it("PIN (review finding 3): a request with no `tier` (today's ONLY option — `tools/schemas.ts` has no `tier` field yet) never reads ctx.sessionSubagents — a ctx carrying ONLY a session-tier port fails closed exactly like no port at all", async () => {
    const sessionPort: SessionSubagentPort = {
      run: async () => {
        throw new Error("sessionSubagents.run must not be reached — this request never asks for tier:\"session\"");
      },
    };

    const result = await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      // Deliberately no `subagents` — only the session-tier port. Today (pre-
      // B1) this is the ONLY reachable outcome: the handler has no tier
      // branch at all. Once B1 lands tier:"session" (CUT-S2 §2.1), an absent
      // `tier` still means "inline" by contract, so this pin stays true and
      // durable — it would only break if a future change started consulting
      // ctx.sessionSubagents for a request that never asked for it.
      makeCtx({ sessionSubagents: sessionPort }),
    );

    expect(result).toEqual({ ok: false, error: "Agent: subagents are unavailable in this context." });
  });
});

// ---------------------------------------------------------------------------
// mapProgressToEvent's stalled case (TASK.148 slice 1): a { kind:"stalled" }
// SubagentProgress maps 1:1 onto a subagent_stalled AgentEvent stamped with
// the Agent tool call's id. Bridge-only, same scope discipline as the
// attention tests above — this proves the SHARED mapping function, not that
// any real port (runner.ts / child-session-port.ts) ever produces one; that
// is each of those modules' own job.
describe("agentTool — mapProgressToEvent's stalled case (TASK.148 slice 1, bridge-only)", () => {
  it("maps a stalled progress onto a subagent_stalled event stamped with toolCallId", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
        opts.onProgress?.({
          kind: "stalled",
          agentType: "explore",
          description: "d",
          silentMs: 600_000,
          lastActivity: "Bash",
          waitingForApproval: false,
        });
        return { status: "completed", finalText: "ok", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-stall", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const stalled = emitted.filter((e) => e.type === "subagent_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toEqual({
      type: "subagent_stalled",
      toolCallId: "call-stall",
      agentType: "explore",
      description: "d",
      silentMs: 600_000,
      lastActivity: "Bash",
      waitingForApproval: false,
    });
  });

  it("omits lastActivity when the progress never carried one", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const port: SubagentPort = {
      run: async (_req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> => {
        opts.onProgress?.({
          kind: "stalled",
          agentType: "explore",
          description: "d",
          silentMs: 600_000,
          waitingForApproval: false,
        });
        return { status: "completed", finalText: "ok", truncated: false, turns: 0, toolCalls: 0, durationMs: 1 };
      },
    };

    await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      makeCtx({ toolCallId: "call-stall-2", subagents: port, emit: (e) => emitted.push(e) }),
    );

    const stalled = emitted.find((e) => e.type === "subagent_stalled");
    expect(stalled && "lastActivity" in stalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Presentation attach (TASK.102 slice S1 W3, CUT-S1 §3 W3): the handler
// accumulates every bridged progress event into a card-snapshot accumulator
// (ALWAYS, regardless of whether ctx.emit is wired) and attaches the
// finalized snapshot as `result.presentation.subagent` on ALL FOUR settle
// branches (error / max_turns / cancelled / ok). A run that never reached
// subagent_start (fails before the port calls onProgress even once) attaches
// no presentation at all — the card is never fabricated from nothing.

function scriptedPresentationPort(
  outcome: SubagentOutcome,
  opts?: { activitySuppressed?: number; toolCount?: number },
): SubagentPort {
  return {
    run: async (_req: SubagentRequest, runOpts: SubagentRunOptions): Promise<SubagentOutcome> => {
      runOpts.onProgress?.({ kind: "start", agentType: "explore", description: "d", model: "glm-4.6" });
      runOpts.onProgress?.({ kind: "progress", turns: 1, toolCalls: 0 });
      const toolCount = opts?.toolCount ?? 2;
      for (let i = 0; i < toolCount; i += 1) {
        runOpts.onProgress?.({ kind: "tool", toolName: "Bash", summary: `cmd-${i}` });
      }
      runOpts.onProgress?.({
        kind: "end",
        status: outcome.status,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
        ...(opts?.activitySuppressed !== undefined ? { activitySuppressed: opts.activitySuppressed } : {}),
      });
      return outcome;
    },
  };
}

describe("agentTool — presentation attach across all four settle branches (TASK.102 slice S1 W3)", () => {
  it("completed (ok branch) carries result.presentation.subagent with the finalized card", async () => {
    const outcome: SubagentOutcome = {
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 1,
      toolCalls: 2,
      durationMs: 50,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: scriptedPresentationPort(outcome) }),
    );

    expect(result.ok).toBe(true);
    expect(result.presentation?.subagent).toMatchObject({
      kind: "subagent",
      version: 1,
      target: { kind: "inline" },
      identity: { agentType: "explore", description: "d", model: "glm-4.6", engine: null },
      final: { status: "completed", durationMs: 50 },
    });
    expect(result.presentation?.subagent?.activity.entries).toEqual([
      { toolName: "Bash", summary: "cmd-0" },
      { toolName: "Bash", summary: "cmd-1" },
    ]);
  });

  it("max_turns (errorKind branch) carries presentation alongside the incomplete outcome", async () => {
    const outcome: SubagentOutcome = {
      status: "max_turns",
      finalText: "partial",
      truncated: false,
      turns: 8,
      toolCalls: 2,
      durationMs: 999,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: scriptedPresentationPort(outcome) }),
    );

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("max_turns");
    expect(result.presentation?.subagent?.final).toEqual({ status: "max_turns", durationMs: 999 });
  });

  it("cancelled (errorKind branch) carries presentation", async () => {
    const outcome: SubagentOutcome = {
      status: "cancelled",
      finalText: "",
      truncated: false,
      turns: 1,
      toolCalls: 1,
      durationMs: 5,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: scriptedPresentationPort(outcome) }),
    );

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("cancelled");
    expect(result.presentation?.subagent?.final).toEqual({ status: "cancelled", durationMs: 5 });
  });

  it("error (no-errorKind branch, no `output` field) STILL carries presentation as an independent field", async () => {
    const outcome: SubagentOutcome = {
      status: "error",
      finalText: "boom",
      truncated: false,
      turns: 1,
      toolCalls: 1,
      durationMs: 7,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: scriptedPresentationPort(outcome) }),
    );

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.presentation?.subagent?.final).toEqual({ status: "error", durationMs: 7 });
  });

  it("an error BEFORE the port ever calls onProgress (no subagent_start reached) attaches NO presentation", async () => {
    const port: SubagentPort = {
      run: async () => ({
        status: "error",
        finalText: "failed before start",
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 1,
      }),
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: port }),
    );

    expect(result.ok).toBe(false);
    expect(result.presentation).toBeUndefined();
  });

  it("accumulates presentation even with no ctx.emit wired (accumulation is unconditional, emission is not)", async () => {
    const outcome: SubagentOutcome = {
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 1,
      toolCalls: 1,
      durationMs: 5,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      // No `emit` in ctx — the accumulator must still fill from onProgress.
      makeCtx({ subagents: scriptedPresentationPort(outcome, { toolCount: 1 }) }),
    );

    expect(result.presentation?.subagent?.activity.entries).toEqual([{ toolName: "Bash", summary: "cmd-0" }]);
  });

  it("activitySuppressed from the end-progress event folds into presentation.subagent.activity.dropped", async () => {
    const outcome: SubagentOutcome = {
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 1,
      toolCalls: 500,
      durationMs: 5,
    };
    const result = await agentTool.handler(
      { description: "look", prompt: "go", agent_type: "explore" },
      makeCtx({ subagents: scriptedPresentationPort(outcome, { activitySuppressed: 9, toolCount: 3 }) }),
    );

    expect(result.presentation?.subagent?.activity.dropped).toBe(9);
  });
});

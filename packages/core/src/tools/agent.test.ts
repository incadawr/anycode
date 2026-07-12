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
import { SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS } from "../types/config.js";
import { SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS } from "../subagents/summarize-tool.js";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRequest,
  SubagentRunOptions,
} from "../ports/subagent.js";

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
      timeoutMs: 600_000,
      maxTimeoutMs: 600_000,
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
});

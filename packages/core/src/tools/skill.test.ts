/**
 * Skill tool dispatch-level matrix (Phase 3 slice 3.3, design §3.4/§5.2 item 5).
 * Exercises the FULL dispatch pipeline (executeToolCall / AgentLoop), not just
 * the handler in isolation (handler.test.ts-style unit guards for the two
 * fail-closed locks + frozen metadata live in agent.test.ts's precedent for
 * the analogous Agent tool): happy path landing the body in model-visible
 * history, unknown name -> invalid_input with the available list, absent port
 * -> unavailable (fail-closed, mirrors Agent without a SubagentPort),
 * plan-mode allowed WITHOUT asking the broker (readOnly, needsApproval:false),
 * and the unansweredToolCallIds() === [] loop invariant.
 */

import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  DenyPermissionBroker,
  InMemoryHookRunner,
  ModePermissionEngine,
  createDefaultToolRegistry,
  executeToolCall,
} from "../index.js";
import type { DispatchContext } from "../dispatch/dispatcher.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { PermissionDecision, PermissionRequest } from "../types/permissions.js";
import type { CorePorts } from "../ports/index.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { SkillMeta, SkillPort } from "../ports/skills.js";

function ports(): CorePorts {
  return {} as CorePorts; // the Skill handler never touches ctx.ports
}

/** A hand-rolled SkillPort — dispatch-level tests exercise the FROZEN port contract, not discovery.ts. */
function makeSkillPort(
  entries: Record<string, { body: string; description?: string; source?: string }>,
): SkillPort {
  const metas: SkillMeta[] = Object.entries(entries).map(([name, e]) => ({
    name,
    description: e.description ?? `desc for ${name}`,
    source: e.source ?? "project",
    path: `/skills/${name}/SKILL.md`,
  }));
  return {
    list: () => [...metas],
    load: async (name) => {
      const entry = entries[name];
      const meta = metas.find((m) => m.name === name);
      if (!entry || !meta) {
        return undefined;
      }
      return { meta, body: entry.body, truncated: false };
    },
  };
}

class RecordingBroker {
  readonly seen: PermissionRequest[] = [];
  constructor(private readonly decision: PermissionDecision) {}
  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.seen.push(request);
    return Promise.resolve(this.decision);
  }
}

function baseCtx(
  over: Partial<DispatchContext> & Pick<DispatchContext, "permissionEngine" | "permissionBroker" | "mode">,
): DispatchContext {
  return {
    registry: createDefaultToolRegistry(),
    hooks: new InMemoryHookRunner(),
    ports: ports(),
    cwd: "/work",
    ...over,
  };
}

describe("Skill tool — dispatch pipeline", () => {
  it("happy path: the loaded body reaches the model as the tool result text", async () => {
    const skills = makeSkillPort({ reviewer: { body: "Do the review carefully.\n" } });
    const outcome = await executeToolCall(
      baseCtx({
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "build",
        skills,
      }),
      { id: "c1", name: "Skill", input: { name: "reviewer" } },
    );
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toBe("Do the review carefully.\n");
  });

  it("unknown name -> invalid_input listing the available skill names", async () => {
    const skills = makeSkillPort({ reviewer: { body: "x" }, planner: { body: "y" } });
    const outcome = await executeToolCall(
      baseCtx({
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "build",
        skills,
      }),
      { id: "c1", name: "Skill", input: { name: "does-not-exist" } },
    );
    expect(outcome.status).toBe("invalid_input");
    expect(outcome.modelText).toContain("does-not-exist");
    expect(outcome.modelText).toContain("reviewer");
    expect(outcome.modelText).toContain("planner");
  });

  it("no SkillPort in context -> unavailable (fail-closed, mirrors Agent without a SubagentPort)", async () => {
    const outcome = await executeToolCall(
      baseCtx({
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "build",
        // skills omitted entirely
      }),
      { id: "c1", name: "Skill", input: { name: "reviewer" } },
    );
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("unavailable");
  });

  it("plan-mode: allowed WITHOUT consulting the broker (readOnly, needsApproval:false)", async () => {
    const skills = makeSkillPort({ reviewer: { body: "plan-safe body" } });
    const broker = new RecordingBroker({ behavior: "deny", reason: "must not be asked" });
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: broker, mode: "plan", skills }),
      { id: "c1", name: "Skill", input: { name: "reviewer" } },
    );
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toBe("plan-safe body");
    expect(broker.seen).toHaveLength(0); // base ruling already "allow" — the broker is never reached
  });

  it("truncated output carries the truncation marker for the model", async () => {
    const skills: SkillPort = {
      list: () => [{ name: "big", description: "d", source: "project", path: "/skills/big/SKILL.md" }],
      load: async (name) =>
        name === "big"
          ? {
              meta: { name: "big", description: "d", source: "project", path: "/skills/big/SKILL.md" },
              body: "partial body",
              truncated: true,
            }
          : undefined,
    };
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: new DenyPermissionBroker(), mode: "build", skills }),
      { id: "c1", name: "Skill", input: { name: "big" } },
    );
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toContain("partial body");
    expect(outcome.modelText).toContain("truncated");
  });
});

describe("Skill tool — full AgentLoop turn (unansweredToolCallIds invariant)", () => {
  it("a Skill call is fully answered: body lands in history, no unanswered tool calls", async () => {
    const skills = makeSkillPort({ reviewer: { body: "review instructions" } });
    const model = new ScriptedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "s1", name: "Skill", input: { name: "reviewer" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t", text: "used the skill" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new DenyPermissionBroker(),
      mode: "build",
      ports: ports(),
      cwd: "/work",
      skills,
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("please load the reviewer skill")) {
      events.push(event);
    }

    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.outcome.status).toBe("success");
    expect(toolResult?.outcome.modelText).toBe("review instructions");

    expect(loop.history.unansweredToolCallIds()).toEqual([]);
    const toolMessages = loop.history.toMessages().filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.content).toEqual([
      { type: "tool_result", toolCallId: "s1", toolName: "Skill", text: "review instructions", status: "success" },
    ]);
  });

  it("plan-mode child-of-a-child style loop: no SkillPort configured -> unanswered invariant still holds", async () => {
    const model = new ScriptedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "s1", name: "Skill", input: { name: "reviewer" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new DenyPermissionBroker(),
      mode: "build",
      ports: ports(),
      cwd: "/work",
      // skills omitted — mirrors a child subagent loop, which never receives one
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("try to load a skill without a port")) {
      events.push(event);
    }
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.outcome.status).toBe("error");
    expect(toolResult?.outcome.modelText).toContain("unavailable");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });
});

// Minimal scripted model port (mirrors mcp/manager.test.ts / phase1-integration.test.ts).
class ScriptedModelPort implements ModelPort {
  private call = 0;
  constructor(private readonly scripts: ModelStreamEvent[][]) {}
  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts[this.call] ?? [{ type: "finish", finishReason: "stop", usage: {} }];
    this.call += 1;
    for (const event of script) {
      if (request.abortSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      yield event;
    }
  }
}

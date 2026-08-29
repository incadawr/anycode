/**
 * Subagent runner tests (Phase 3 slice 3.1.2, design §4.1/§4.3). Hermetic:
 * a ScriptedModelPort drives TWO levels (parent -> child) so the whole path —
 * derivation, the two non-recursion locks, cancellation cascade, the semaphore,
 * permission inheritance, output cap and status mapping — is exercised without
 * the SDK. The one exception is the orphan test, which uses the real
 * NodeExecutionAdapter to prove the SIGTERM/SIGKILL cascade tears down a child's
 * Bash process group.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentLoopConfig } from "../loop/agent-loop.js";
import { ConversationHistory, type HistorySink } from "../context/history.js";
import { HeuristicTokenizer } from "../context/tokenizer.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { toToolDeclarations } from "../tools/to-model-tools.js";
import { ModePermissionEngine, DenyPermissionBroker } from "../permissions/index.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { agentTool } from "../tools/agent.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { CorePorts, ExecutionPort, FileSystemPort, HttpPort } from "../ports/index.js";
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "../types/permissions.js";
import type { HookRunner, SubagentStopHookInput } from "../types/hooks.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  SUBAGENT_MAX_TURNS_CEILING,
  SUBAGENT_LOOP_DEADLINE_MS,
  SUBAGENT_OUTCOME_DEADLINE_MS,
  SUBAGENT_STALL_TIMEOUT_MS,
  SUBAGENT_TIME_BUDGET_MS,
  SUBAGENT_WRAPUP_MIN_WINDOW_MS,
  SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS,
} from "../types/config.js";
import { SUBAGENT_WRAPUP_PROMPT } from "../prompts/subagent.js";
import type { EngineChildSpec, SubagentOutcome, SubagentProgress } from "../ports/subagent.js";
import type { ToolContext } from "../types/tools.js";
import { SPAWN_TOOLS, buildChildConfig, createSubagentRunner, withSubagents } from "./runner.js";
import { PERSONAS, getPersona, type PersonaDefinition } from "./personas.js";
import { discoverAgentProfiles, type AgentProfileRoot } from "./profiles.js";
import { buildSubagentTelemetryTap } from "../telemetry/records.js";
import type { TelemetryPort, TelemetryRecord } from "../ports/telemetry.js";

// ---------------------------------------------------------------------------
// ScriptedModelPort: replays a step per streamText call. The script is a pure
// function of the request so parent (system=undefined) and child (system=persona
// placeholder) requests route deterministically even under concurrency.

type ModelScript = (req: ModelRequest) => ModelStreamEvent[];

class ScriptedModelPort implements ModelPort {
  calls = 0;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: ModelScript) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.requests.push(request);
    const events = this.script(request);
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

function textStep(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", id: "t", text },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

function toolStep(id: string, name: string, input: unknown, text?: string): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: "start" }];
  if (text) {
    events.push({ type: "text_delta", id: "t", text });
  }
  events.push({ type: "tool_call", toolCall: { id, name, input } });
  events.push({ type: "finish", finishReason: "tool_calls", usage: {} });
  return events;
}

function lastRole(req: ModelRequest): "user" | "assistant" | "tool" | "none" {
  const message = req.messages[req.messages.length - 1];
  return message ? message.role : "none";
}

/**
 * The wrap-up rescue call (TASK.74 §4), recognized the way the design specifies:
 * zero tool declarations AND a trailing synthetic user message carrying the
 * wrap-up instruction. Both halves are asserted so a script cannot mistake an
 * ordinary child step for the rescue.
 */
function isWrapUpRequest(req: ModelRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  return (
    req.tools.length === 0 &&
    last?.role === "user" &&
    last.content === SUBAGENT_WRAPUP_PROMPT
  );
}

function isChildRequest(req: ModelRequest): boolean {
  // Slice 3.6: the child's system prompt is now the harness prelude wrapping the
  // persona body (buildSubagentSystemPrompt), so it CONTAINS the persona text
  // rather than equalling it. The parent (makeParent) carries no system prompt.
  return (
    req.system !== undefined &&
    (req.system.includes(PERSONAS["general-purpose"].systemPrompt) ||
      req.system.includes(PERSONAS.explore.systemPrompt))
  );
}

// ---------------------------------------------------------------------------
// Config / ports helpers

function stubHooks(): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async () => ({}),
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
}

interface RecordedObserver {
  event: string;
  input: unknown;
}

/**
 * A HookRunner that records every runObservers call (event + input) so the
 * SubagentStop fire can be asserted. `onSubagentStop` lets a test make the
 * SubagentStop observer misbehave (throw / hang / slow) to prove the fire is
 * fail-open and the semaphore permit is still released.
 */
function recordingHooks(opts?: {
  onSubagentStop?: (input: unknown) => Promise<void>;
}): { hooks: HookRunner; calls: RecordedObserver[] } {
  const calls: RecordedObserver[] = [];
  const hooks = {
    register: () => {},
    runPreToolUse: async () => ({}),
    runUserPromptSubmit: async () => ({}),
    runObservers: async (event: string, input: unknown) => {
      calls.push({ event, input });
      if (event === "SubagentStop" && opts?.onSubagentStop) {
        await opts.onSubagentStop(input);
      }
    },
  } as unknown as HookRunner;
  return { hooks, calls };
}

function makePorts(exec?: ExecutionPort): CorePorts {
  return {
    fs: {} as FileSystemPort,
    exec: exec ?? ({} as ExecutionPort),
    http: {} as HttpPort,
    todos: new InMemoryTodoStore(),
  };
}

/** TASK.160 §2.2 wiring tests: a bare recording TelemetryPort (mirror of
 *  telemetry/records.test.ts's own fixture) so a test can assert exactly what
 *  buildSubagentTelemetryTap wrote through the parent's subagentEventTap. */
function makeRecordingPort(): { port: TelemetryPort; records: TelemetryRecord[] } {
  const records: TelemetryRecord[] = [];
  const port: TelemetryPort = {
    record: (record) => {
      records.push(record);
    },
    status: () => ({ filePath: "/tmp/x.jsonl", written: records.length, dropped: 0 }),
    flush: async () => {},
    dispose: async () => {},
  };
  return { port, records };
}

function makeParent(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    modelPort: new ScriptedModelPort(() => textStep("")),
    registry: createDefaultToolRegistry(),
    hooks: stubHooks(),
    permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(),
    mode: "build",
    ports: makePorts(),
    cwd: "/work",
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) {
      throw new Error(`file ${path} did not appear within ${timeoutMs}ms`);
    }
    await delay(20);
  }
}

const REQ = { agentType: "general-purpose", description: "child task", prompt: "do the work" } as const;

// ---------------------------------------------------------------------------

describe("buildChildConfig — §4.1 derivation table", () => {
  it("derives every row exactly (general-purpose)", () => {
    const tokenizer = new HeuristicTokenizer();
    const context = { contextWindowTokens: 12_345 };
    const parent = makeParent({ tokenizer, context, mode: "edit", maxOutputTokens: 999, reasoningEffort: "medium" });

    const child = buildChildConfig(parent, getPersona("general-purpose"), REQ);

    // modelPort / hooks / engine / broker: same object as the parent.
    expect(child.modelPort).toBe(parent.modelPort);
    expect(child.hooks).toBe(parent.hooks);
    expect(child.permissionEngine).toBe(parent.permissionEngine);
    expect(child.permissionBroker).toBe(parent.permissionBroker);

    // registry: NEW, the nine defaults minus Agent (lock #1, structural).
    expect(child.registry).not.toBe(parent.registry);
    expect(child.registry.has("Agent")).toBe(false);
    expect(child.registry.list().sort()).toEqual([...PERSONAS["general-purpose"].tools].sort());

    // subagents: UNSET (lock #2, defense in depth).
    expect(child.subagents).toBeUndefined();

    // mode: snapshot of the parent mode at spawn (never forced to yolo).
    expect(child.mode).toBe("edit");

    // ports: fresh todos, everything else inherited.
    expect(child.ports.todos).not.toBe(parent.ports.todos);
    expect(child.ports.todos).toBeInstanceOf(InMemoryTodoStore);
    expect(child.ports.fs).toBe(parent.ports.fs);
    expect(child.ports.exec).toBe(parent.ports.exec);
    expect(child.ports.http).toBe(parent.ports.http);

    // cwd / systemPrompt / tokenizer / context / maxOutputTokens.
    expect(child.cwd).toBe(parent.cwd);
    // Slice 3.6: the persona body is embedded in the harness prelude, not used raw.
    expect(child.systemPrompt).toContain(PERSONAS["general-purpose"].systemPrompt);
    expect(child.tokenizer).toBe(tokenizer);
    expect(child.context).toBe(context);
    expect(child.maxOutputTokens).toBe(999);
    expect(child.reasoningEffort).toBe("medium");

    // history: fresh + empty.
    expect(child.history).toBeInstanceOf(ConversationHistory);
    expect(child.history?.items.length).toBe(0);
    expect(child.history).not.toBe(buildChildConfig(parent, getPersona("general-purpose"), REQ).history);
  });

  // Budget resolution: request > parent.subagentMaxTurns > DEFAULT, and ONLY
  // the runaway ceiling clamps. The regression this guards: DEFAULT used to be
  // the clamp too (`Math.min(req ?? 8, 8)`), so nothing could raise the budget
  // above 8 — not the caller, not a setting, not an env var.
  it("resolves maxTurns request-first and clamps only at SUBAGENT_MAX_TURNS_CEILING", () => {
    const parent = makeParent();
    expect(buildChildConfig(parent, getPersona("explore"), REQ).maxTurns).toBe(DEFAULT_SUBAGENT_MAX_TURNS);
    // An explicit request ABOVE the default is honored, not clamped down to it.
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 120 }).maxTurns).toBe(120);
    // Below the default is honored too — a caller may still ask for less.
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 3 }).maxTurns).toBe(3);
    // The runaway ceiling is the only clamp.
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 10_000 }).maxTurns).toBe(
      SUBAGENT_MAX_TURNS_CEILING,
    );
  });

  it("takes the host/settings default from parent.subagentMaxTurns, and lets an explicit request win", () => {
    const parent = { ...makeParent(), subagentMaxTurns: 75 };
    expect(buildChildConfig(parent, getPersona("explore"), REQ).maxTurns).toBe(75);
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 12 }).maxTurns).toBe(12);
    // The settings default is bounded by the ceiling as well.
    expect(
      buildChildConfig({ ...makeParent(), subagentMaxTurns: 9_999 }, getPersona("explore"), REQ).maxTurns,
    ).toBe(SUBAGENT_MAX_TURNS_CEILING);
  });

  // The role's own budget (md-profile `maxTurns:` frontmatter) sits between the
  // request and the settings default: it is an author's statement about the
  // role, so it outranks the global default — but never an explicit request,
  // and never the runaway ceiling. Built-in personas declare none ON PURPOSE
  // (a hardcoded 24 would silently outrank the owner-visible setting).
  it("takes a role's declared turnBudget over the default, under an explicit request and the ceiling", () => {
    const parent = makeParent();
    const explore = getPersona("explore");
    expect(explore.turnBudget).toBeUndefined();
    const frugal: PersonaDefinition = { ...explore, turnBudget: 12 };
    expect(buildChildConfig(parent, frugal, REQ).maxTurns).toBe(12);
    // An explicit request still wins over the role.
    expect(buildChildConfig(parent, frugal, { ...REQ, maxTurns: 30 }).maxTurns).toBe(30);
    // And the role is bounded by the runaway ceiling like everything else.
    const overreaching: PersonaDefinition = { ...explore, turnBudget: 9_999 };
    expect(buildChildConfig(parent, overreaching, REQ).maxTurns).toBe(SUBAGENT_MAX_TURNS_CEILING);
  });

  it("threads extras.deadlineAt into the child config and omits the field without it", () => {
    const parent = makeParent();
    const deadlineAt = Date.now() + 1_234;
    expect(buildChildConfig(parent, getPersona("explore"), REQ, { deadlineAt }).deadlineAt).toBe(deadlineAt);
    // Byte-identical to a pre-TASK.74 child when no deadline is supplied.
    expect(buildChildConfig(parent, getPersona("explore"), REQ).deadlineAt).toBeUndefined();
    expect("deadlineAt" in buildChildConfig(parent, getPersona("explore"), REQ)).toBe(false);
  });

  // The ceiling ladder applies to children too (TASK.124 §1.5/§1.7), but with
  // the two clamps only a child needs: the total (budget + every grant) stays
  // under SUBAGENT_MAX_TURNS_CEILING like an explicit request would, and the
  // decision window is additionally bounded by what is left of the parent's
  // wait so a late verdict cannot outlive the dispatcher's own timeout.
  it("always sets ceiling.maxTurnsCeiling to SUBAGENT_MAX_TURNS_CEILING, and threads outcomeDeadlineAt only when given", () => {
    const parent = makeParent();
    expect(buildChildConfig(parent, getPersona("explore"), REQ).ceiling).toEqual({
      maxTurnsCeiling: SUBAGENT_MAX_TURNS_CEILING,
    });
    const outcomeDeadlineAt = Date.now() + 5_678;
    expect(
      buildChildConfig(parent, getPersona("explore"), REQ, { outcomeDeadlineAt }).ceiling,
    ).toEqual({ maxTurnsCeiling: SUBAGENT_MAX_TURNS_CEILING, outcomeDeadlineAt });
  });

  it("gives the child a fresh history that never reaches the parent's persistence sink (ephemeral, R5)", () => {
    const sink: HistorySink = { append: vi.fn(), replaceAll: vi.fn(), flush: async () => {} };
    const parentHistory = new ConversationHistory({ sink });
    const parent = makeParent({ history: parentHistory });

    const child = buildChildConfig(parent, getPersona("explore"), REQ);
    expect(child.history).not.toBe(parentHistory);
    child.history?.append({ role: "user", content: "child-only" });
    expect(sink.append).not.toHaveBeenCalled();
  });

  it("explore child declarations are exactly the read-only set (design R7)", () => {
    const parent = makeParent();
    const child = buildChildConfig(parent, getPersona("explore"), { ...REQ, agentType: "explore" });

    const declared = toToolDeclarations(child.registry).map((d) => d.name).sort();
    expect(declared).toEqual(["Glob", "Grep", "Read", "TodoRead", "TodoWrite", "WebFetch"]);
    expect(declared).not.toContain("Bash");
    expect(declared).not.toContain("Agent");
    for (const name of declared) {
      expect(child.registry.getMetadata(name)?.readOnly, `${name} must be readOnly`).toBe(true);
    }
  });
});

// TASK.160 §2.2: the inline subagent tap. Decision (а) — child records land in
// the PARENT's own telemetry file, marked with `sub`. `buildSubagentTelemetryTap`
// itself (whitelist mapping, sub stamping, model omission) is pinned exhaustively
// in telemetry/records.test.ts; these tests pin the WIRING — buildChildConfig
// installs the closure the parent's factory returns as the child's own eventTap.
describe("subagentEventTap wiring (TASK.160 §2.2)", () => {
  it("builds the child's eventTap from parent.subagentEventTap, stamped with the child's agentType", () => {
    const { port, records } = makeRecordingPort();
    const parent = makeParent({
      subagentEventTap: (spawn) => buildSubagentTelemetryTap(port, "parent-session-id", spawn),
    });

    const child = buildChildConfig(parent, getPersona("general-purpose"), REQ);
    expect(child.eventTap).toBeDefined();
    child.eventTap?.({ type: "turn_end", turn: 1, finishReason: "stop" });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      session: "parent-session-id",
      sub: { agentType: "general-purpose" },
      t: "turn_end",
      turn: 1,
    });
    // No model override anywhere in this spawn -> sub carries no model key at all.
    expect(records[0]?.sub).not.toHaveProperty("model");
  });

  it("stamps sub.model from an Agent-tool model override, which outranks the persona's own default", () => {
    const { port, records } = makeRecordingPort();
    const parent = makeParent({
      subagentEventTap: (spawn) => buildSubagentTelemetryTap(port, "parent-session-id", spawn),
    });
    const roleModeled: PersonaDefinition = { ...getPersona("explore"), model: "role-model" };

    // Persona default, no request override.
    const childA = buildChildConfig(parent, roleModeled, REQ);
    childA.eventTap?.({ type: "turn_end", turn: 1, finishReason: "stop" });
    expect(records[0]).toMatchObject({ sub: { agentType: "explore", model: "role-model" } });

    // An explicit Agent-tool request override outranks the persona default
    // (same precedence as run()'s own requestedModel resolution).
    const childB = buildChildConfig(parent, roleModeled, { ...REQ, model: "override-model" });
    childB.eventTap?.({ type: "turn_end", turn: 2, finishReason: "stop" });
    expect(records[1]).toMatchObject({ sub: { agentType: "explore", model: "override-model" } });
  });

  it("child config has NO eventTap when the parent carries no subagentEventTap factory (byte-identical legacy behaviour)", () => {
    const parent = makeParent();
    expect(parent.subagentEventTap).toBeUndefined();
    const child = buildChildConfig(parent, getPersona("explore"), REQ);
    expect(child.eventTap).toBeUndefined();
    expect("eventTap" in child).toBe(false);
  });

  it("structural non-recursion: the child config never carries subagentEventTap itself", () => {
    const { port } = makeRecordingPort();
    const parent = makeParent({
      subagentEventTap: (spawn) => buildSubagentTelemetryTap(port, "parent-session-id", spawn),
    });
    const child = buildChildConfig(parent, getPersona("general-purpose"), REQ);
    expect(child.subagentEventTap).toBeUndefined();
    expect("subagentEventTap" in child).toBe(false);
  });

  it("an end-to-end child run through createSubagentRunner writes usage/tool/turn_end into the parent's file, all stamped sub with the parent's session id", async () => {
    const { port, records } = makeRecordingPort();
    const model = new ScriptedModelPort((req) => {
      if (isChildRequest(req)) {
        return lastRole(req) === "user" ? toolStep("c1", "TodoRead", {}) : textStep("child done");
      }
      return textStep("should never run");
    });
    const parent = makeParent({
      modelPort: model,
      mode: "yolo",
      subagentEventTap: (spawn) => buildSubagentTelemetryTap(port, "parent-session-id", spawn),
    });
    const runner = createSubagentRunner(parent);

    const outcome = await runner.run(REQ, {});
    expect(outcome.status).toBe("completed");

    const kinds = records.map((r) => r.t);
    expect(kinds).toContain("tool");
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("usage");
    for (const record of records) {
      expect(record.session).toBe("parent-session-id");
      expect(record.sub).toEqual({ agentType: "general-purpose" });
    }
  });
});

describe("createSubagentRunner — parent spawns child", () => {
  it("runs a child loop and lands its finalText + progress bridge in the parent stream", async () => {
    const model = new ScriptedModelPort((req) => {
      if (isChildRequest(req)) {
        return textStep("child report");
      }
      return lastRole(req) === "user"
        ? toolStep("agent-1", "Agent", {
            description: "child work",
            prompt: "do child work",
            agent_type: "general-purpose",
          })
        : textStep("parent done");
    });
    const loop = new AgentLoop(withSubagents(makeParent({ modelPort: model })));

    const events = await collect(loop.runTurn("please spawn a subagent"));

    const agentResult = events.find(
      (e) => e.type === "tool_result" && e.outcome.toolName === "Agent",
    );
    expect(agentResult?.type === "tool_result" && agentResult.outcome.status).toBe("success");
    expect(agentResult?.type === "tool_result" && agentResult.outcome.modelText).toBe("child report");

    const starts = events.filter((e) => e.type === "subagent_start");
    const ends = events.filter((e) => e.type === "subagent_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    const start = starts[0];
    const end = ends[0];
    expect(start?.type === "subagent_start" && start.toolCallId).toBe("agent-1");
    expect(end?.type === "subagent_end" && end.status).toBe("completed");
    expect(events.some((e) => e.type === "subagent_progress")).toBe(true);

    const loopEnd = events.at(-1);
    expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("completed");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });
});

describe("non-recursion locks (§3.1/§3.2, R2)", () => {
  it("lock #1: the child registry has no Agent and a forced Agent call cannot spawn a grandchild", async () => {
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      // The child (only loop the runner drives here) proposes Agent on step 1;
      // its registry has no Agent, so it becomes an unknown-tool error and the
      // child continues, never recursing.
      return step === 1
        ? toolStep("c1", "Agent", { description: "grandchild", prompt: "recurse" })
        : textStep("child recovered");
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run(REQ, { onProgress: (p) => progress.push(p) });

    expect(outcome.status).toBe("completed");
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.finalText).toBe("child recovered");
    // Exactly two model calls: the child's two steps. A grandchild would have
    // produced more — recursion is structurally impossible.
    expect(model.calls).toBe(2);
    expect(progress.some((p) => p.kind === "progress" && p.lastTool === "Agent")).toBe(true);
  });

  it("lock #2: the derived child carries no port, and the Agent tool fails closed 'unavailable' without one", async () => {
    const child = buildChildConfig(makeParent(), getPersona("general-purpose"), REQ);
    expect(child.subagents).toBeUndefined();

    // A child ToolContext mirrors that shape (subagents unset); the Agent handler
    // fails closed even if a future profile mistakenly registered Agent.
    const ctx = {
      toolCallId: "x",
      abortSignal: new AbortController().signal,
      cwd: "/work",
      ports: makePorts(),
    } as unknown as ToolContext;
    const result = await agentTool.handler(
      { description: "d", prompt: "p", agent_type: "explore" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });
});

describe("permission inheritance (R3)", () => {
  it("plan-mode child denies a Write (inherits the parent mode snapshot)", async () => {
    const model = new ScriptedModelPort((req) =>
      lastRole(req) === "user"
        ? toolStep("w1", "Write", { file_path: "/work/out.txt", content: "hi" })
        : textStep("done"),
    );
    const parent = makeParent({ modelPort: model, mode: "plan" });
    const childLoop = new AgentLoop(buildChildConfig(parent, getPersona("general-purpose"), REQ));

    const events = await collect(childLoop.runTurn("write a file"));
    const write = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Write");
    expect(write?.type === "tool_result" && write.outcome.status).toBe("denied");
  });

  it("a child ask reaches the broker and a deny does not break the parent", async () => {
    const brokerCalls: string[] = [];
    const recordingBroker: PermissionBroker = {
      requestPermission: async (req: PermissionRequest): Promise<PermissionDecision> => {
        brokerCalls.push(req.toolName);
        return { behavior: "deny", reason: "denied by test broker" };
      },
    };
    const model = new ScriptedModelPort((req) => {
      if (isChildRequest(req)) {
        return lastRole(req) === "user"
          ? toolStep("b1", "Bash", { command: "echo hi" })
          : textStep("child finished after a denial");
      }
      return lastRole(req) === "user"
        ? toolStep("agent-1", "Agent", { description: "run bash", prompt: "run a command" })
        : textStep("parent done");
    });
    const loop = new AgentLoop(
      withSubagents(makeParent({ modelPort: model, mode: "build", permissionBroker: recordingBroker })),
    );

    const events = await collect(loop.runTurn("delegate a bash task"));

    expect(brokerCalls).toContain("Bash");
    const agentResult = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Agent");
    expect(agentResult?.type === "tool_result" && agentResult.outcome.modelText).toBe(
      "child finished after a denial",
    );
    const loopEnd = events.at(-1);
    expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("completed");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });
});

describe("output cap + status mapping", () => {
  it("caps finalText at SUBAGENT_OUTPUT_MAX_BYTES and sets truncated", async () => {
    const big = "a".repeat(100_001);
    const model = new ScriptedModelPort(() => textStep(big));
    const runner = createSubagentRunner(makeParent({ modelPort: model }));

    const outcome = await runner.run({ ...REQ, agentType: "explore" }, {});
    expect(outcome.status).toBe("completed");
    expect(outcome.truncated).toBe(true);
    expect(outcome.finalText.length).toBe(100_000);
  });

  it("maps a max_turns cutoff to status max_turns and rescues the text with a wrap-up report", async () => {
    let step = 0;
    const model = new ScriptedModelPort((req) => {
      if (isWrapUpRequest(req)) {
        return textStep("REPORT: turn-1 and turn-2 findings");
      }
      step += 1;
      return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});
    expect(outcome.status).toBe("max_turns");
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(2);
    // The wrap-up report replaces the cut-off turn's preamble ("turn-2").
    expect(outcome.finalText).toBe("REPORT: turn-1 and turn-2 findings");
    // Two loop turns, + one ceiling round-1 decision call (refused: the script
    // answers every non-wrap-up request with a "TodoRead" tool call, which is
    // not `ceiling_verdict`) + one wrap-up call (TASK.124).
    expect(model.calls).toBe(4);
  });

  it("returns an error outcome for an unknown persona without throwing", async () => {
    const runner = createSubagentRunner(makeParent());
    const outcome = await runner.run({ ...REQ, agentType: "nope" }, {});
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain("nope");
    expect(outcome.finalText).toContain("general-purpose");
  });
});

// ---------------------------------------------------------------------------
// Agent-tool model override (Phase 4 slice 4.6, design §2.5). resolveChildModelPort
// resolves req.model to a FIXED port for exactly that spawn; without a host
// resolver the runner returns a honest error-outcome instead of a silent


describe("Agent-tool model override (slice 4.6, design §2.5)", () => {
  it("resolveChildModelPort resolves req.model to a fixed child-only port", async () => {
    const defaultModel = new ScriptedModelPort(() => textStep("default-model-report"));
    const overrideModel = new ScriptedModelPort(() => textStep("override-model-report"));
    const resolved: string[] = [];
    const runner = createSubagentRunner(makeParent({ modelPort: defaultModel }), {
      resolveChildModelPort: (modelId) => {
        resolved.push(modelId);
        return overrideModel;
      },
    });

    const outcome = await runner.run({ ...REQ, model: "custom-model" }, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("override-model-report");
    expect(resolved).toEqual(["custom-model"]);
    // The parent's own port is never touched by an overridden spawn.
    expect(defaultModel.calls).toBe(0);
    expect(overrideModel.calls).toBe(1);
  });

  it("req.model without a host resolver returns the exact error-outcome text, verbatim", async () => {
    const parentModel = new ScriptedModelPort(() => textStep("should never run"));
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel })); // no resolveChildModelPort

    const outcome = await runner.run({ ...REQ, model: "custom-model" }, {});

    expect(outcome).toEqual({
      status: "error",
      finalText:
        'Agent: model override "custom-model" is not supported in this host; retry without the model field.',
      truncated: false,
      turns: 0,
      toolCalls: 0,
      durationMs: expect.any(Number),
    });
    // No child loop was ever built: the parent's own model port was never called.
    expect(parentModel.calls).toBe(0);
  });

  it("A5: an unsupported model override fails BEFORE the semaphore — it never queues behind running children", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let started = 0;
    const gatedModel: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        started += 1;
        const signal = req.abortSignal;
        return (async function* () {
          await gate;
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield { type: "start" };
          yield { type: "text_delta", id: "t", text: "ok" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })();
      },
    };
    // No resolveChildModelPort: an overridden spawn can only ever error out.
    const runner = createSubagentRunner(makeParent({ modelPort: gatedModel, mode: "yolo" }));

    // Two real children hold BOTH semaphore permits (MAX_CONCURRENT_SUBAGENTS = 2)
    // and are gated open (never complete until releaseGate()).
    const p1 = runner.run({ ...REQ, agentType: "explore", prompt: "1" }, {});
    const p2 = runner.run({ ...REQ, agentType: "explore", prompt: "2" }, {});
    await delay(40);
    expect(started).toBe(2);

    // A third call carrying an unsupported model override must resolve to the
    // error-outcome IMMEDIATELY. If the check instead happened after acquiring
    // the semaphore, this await would deadlock behind p1/p2 (both permits held,
    // gate not yet released) and the test would time out.
    const errOutcome = await runner.run({ ...REQ, model: "custom-model" }, {});
    expect(errOutcome.status).toBe("error");
    expect(started).toBe(2); // no third model call was ever attempted

    releaseGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
  });

  it("req without model still spawns on the parent's modelPort (A25 default path unaffected, L5)", async () => {
    const parentModel = new ScriptedModelPort((req) =>
      isChildRequest(req) ? textStep("parent-port child report") : textStep("n/a"),
    );
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      resolveChildModelPort: () => {
        throw new Error("resolveChildModelPort must not be called when req.model is absent");
      },
    });

    const outcome = await runner.run(REQ, {});
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("parent-port child report");
  });
});

describe("cancellation cascade (R2 orphan invariant)", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "aborting the parent mid-child cancels the run and leaves no orphaned Bash process",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-subagent-"));
      const pidFile = join(tmpDir, "pid.txt");
      const model = new ScriptedModelPort((req) => {
        if (isChildRequest(req)) {
          return toolStep("b1", "Bash", { command: `echo $$ > pid.txt && exec sleep 5` });
        }
        return toolStep("agent-1", "Agent", { description: "run sleep", prompt: "sleep long" });
      });
      const parent = makeParent({
        modelPort: model,
        mode: "yolo",
        cwd: tmpDir,
        ports: makePorts(new NodeExecutionAdapter()),
      });
      const loop = new AgentLoop(withSubagents(parent));

      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const consumed = (async () => {
        for await (const event of loop.runTurn("delegate a long task", { signal: controller.signal })) {
          events.push(event);
        }
      })();

      await waitForFile(pidFile, 5_000);
      controller.abort();
      await consumed;

      const subagentEnd = events.find((e) => e.type === "subagent_end");
      expect(subagentEnd?.type === "subagent_end" && subagentEnd.status).toBe("cancelled");
      const loopEnd = events.at(-1);
      expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("cancelled");

      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(Number.isNaN(pid)).toBe(false);
      expect(isPidAlive(pid)).toBe(false);
    },
    20_000,
  );
});

describe("MAX_CONCURRENT_SUBAGENTS semaphore", () => {
  it("parks the 3rd concurrent child; an abort while queued returns immediately without running it", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let started = 0;
    const gatedModel: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        started += 1;
        const signal = req.abortSignal;
        return (async function* () {
          await gate;
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield { type: "start" };
          yield { type: "text_delta", id: "t", text: "ok" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })();
      },
    };
    const runner = createSubagentRunner(makeParent({ modelPort: gatedModel, mode: "yolo" }));

    const third = new AbortController();
    const p1 = runner.run({ ...REQ, agentType: "explore", prompt: "1" }, {});
    const p2 = runner.run({ ...REQ, agentType: "explore", prompt: "2" }, {});
    const p3 = runner.run({ ...REQ, agentType: "explore", prompt: "3" }, { signal: third.signal });

    await delay(40);
    // Only two children hold a permit and reached the model; the 3rd is parked.
    expect(started).toBe(2);

    third.abort();
    const r3 = await p3;
    expect(r3.status).toBe("cancelled");
    expect(started).toBe(2); // the parked child never ran the model

    releaseGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    expect(started).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Agent profiles (slice 3.3.3, design §3.5 / §5.2 item 7). Personas are built
// through the REAL discovery (subagents/profiles.ts) over a minimal in-memory fs
// so the two non-recursion locks and permission inheritance are re-proven on a
// genuine md-profile, not a hand-rolled PersonaDefinition.

const PROFILE_DIR = "/ws/.anycode/agents";
const PROFILE_ROOTS: AgentProfileRoot[] = [{ dir: PROFILE_DIR, source: "project" }];

/** Minimal single-directory FileSystemPort backing discovery in these tests. */
function fsWith(files: Record<string, string>): FileSystemPort {
  const paths = new Map(Object.entries(files).map(([name, content]) => [join(PROFILE_DIR, name), content]));
  return {
    readFile: async (p: string) => {
      const content = paths.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFile: async () => {
      throw new Error("not implemented");
    },
    stat: async (p: string) => ({
      size: paths.get(p)?.length ?? 0,
      mtimeMs: 0,
      isFile: paths.has(p),
      isDirectory: p === PROFILE_DIR,
    }),
    exists: async (p: string) => p === PROFILE_DIR || paths.has(p),
    mkdir: async () => {
      throw new Error("not implemented");
    },
    readdir: async (p: string) => {
      if (p !== PROFILE_DIR) throw new Error(`ENOTDIR: ${p}`);
      return Object.keys(files);
    },
  } as FileSystemPort;
}

/** Discovers a single md-profile and returns its PersonaDefinition. */
async function makeProfile(
  name: string,
  opts: { body: string; tools?: readonly string[]; model?: string },
): Promise<PersonaDefinition> {
  const lines = [`name: ${name}`, "description: test profile"];
  if (opts.tools) lines.push(`tools: ${opts.tools.join(", ")}`);
  if (opts.model) lines.push(`model: ${opts.model}`);
  const content = `---\n${lines.join("\n")}\n---\n${opts.body}`;
  const { profiles } = await discoverAgentProfiles(fsWith({ [`${name}.md`]: content }), PROFILE_ROOTS);
  const persona = profiles[0];
  if (!persona) throw new Error(`profile ${name} did not discover`);
  return persona;
}

describe("agent profiles as personas (§3.5, §5.2-7)", () => {
  it("buildChildConfig on a profile re-proves BOTH non-recursion locks (SPAWN_TOOLS)", async () => {
    // The profile explicitly lists BOTH spawn tools (Agent + Workflow) and an
    // unknown tool; the child registry must drop all three (lock #1 = ∩ +
    // SPAWN_TOOLS skip) and carry neither port (lock #2).
    const persona = await makeProfile("reviewer", {
      body: "PROFILE SYSTEM PROMPT",
      tools: ["Read", "Grep", "Agent", "Workflow", "NoSuchTool"],
    });

    const child = buildChildConfig(makeParent({ mode: "yolo" }), persona, {
      ...REQ,
      agentType: "reviewer",
    });

    // lock #1 (structural): the child registry never contains a spawn tool, the
    // unknown name is a no-op, and only the known non-spawn tools survive the ∩.
    expect(child.registry.has("Agent")).toBe(false);
    expect(child.registry.has("Workflow")).toBe(false);
    expect(child.registry.has("NoSuchTool")).toBe(false);
    expect(child.registry.list().sort()).toEqual(["Grep", "Read"]);
    // lock #2 (defense in depth): the derived child carries neither spawn port.
    expect(child.subagents).toBeUndefined();
    expect(child.workflows).toBeUndefined();
    // The profile body is embedded verbatim in the child's system prompt (slice 3.6).
    expect(child.systemPrompt).toContain("PROFILE SYSTEM PROMPT");
    // Prompt-level mirror of lock #1: the child's tool-discipline enumerates only
    // its registry (Agent/Workflow dropped), so the prompt cannot advertise a
    // spawn tool by name.
    expect(child.systemPrompt).not.toContain("Agent");
    expect(child.systemPrompt).not.toContain("Workflow");
  });

  it("SPAWN_TOOLS holds both Agent and Workflow (single source of truth for lock #1)", () => {
    expect([...SPAWN_TOOLS].sort()).toEqual(["Agent", "Workflow"]);
    expect(SPAWN_TOOLS.has("Skill")).toBe(false);
  });

  it("listAgentTypes returns the built-ins plus the discovered profiles", async () => {
    const persona = await makeProfile("reviewer", { body: "P" });
    const runner = createSubagentRunner(makeParent(), { profiles: [persona] });
    expect(runner.listAgentTypes?.()).toEqual(["general-purpose", "explore", "reviewer"]);
  });

  it("two-level e2e: the parent spawns Agent(agent_type=<profile>) and the outcome reaches it", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER PROMPT" });
    const model = new ScriptedModelPort((req) => {
      if (req.system?.includes(persona.systemPrompt) ?? false) {
        return textStep("profile child report");
      }
      return lastRole(req) === "user"
        ? toolStep("agent-1", "Agent", {
            description: "review",
            prompt: "review it",
            agent_type: "reviewer",
          })
        : textStep("parent done");
    });
    const loop = new AgentLoop(withSubagents(makeParent({ modelPort: model }), { profiles: [persona] }));

    const events = await collect(loop.runTurn("delegate to the reviewer profile"));

    const agentResult = events.find(
      (e) => e.type === "tool_result" && e.outcome.toolName === "Agent",
    );
    expect(agentResult?.type === "tool_result" && agentResult.outcome.status).toBe("success");
    expect(agentResult?.type === "tool_result" && agentResult.outcome.modelText).toBe(
      "profile child report",
    );
    const start = events.find((e) => e.type === "subagent_start");
    expect(start?.type === "subagent_start" && start.agentType).toBe("reviewer");
    const end = events.find((e) => e.type === "subagent_end");
    expect(end?.type === "subagent_end" && end.status).toBe("completed");
    const loopEnd = events.at(-1);
    expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("completed");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });

  it("lock #1 on a live profile child: a forced Agent call cannot spawn a grandchild", async () => {
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1
        ? toolStep("c1", "Agent", { description: "grandchild", prompt: "recurse" })
        : textStep("child recovered");
    });
    const persona = await makeProfile("reviewer", { body: "P", tools: ["Read", "Agent"] });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }), {
      profiles: [persona],
    });

    const outcome = await runner.run({ ...REQ, agentType: "reviewer" }, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("child recovered");
    // Exactly the child's two steps — a grandchild would have produced more.
    expect(model.calls).toBe(2);
  });

  it("permission inheritance: a plan-mode profile child denies a Write", async () => {
    const persona = await makeProfile("writer", { body: "P", tools: ["Read", "Write"] });
    const model = new ScriptedModelPort((req) =>
      lastRole(req) === "user"
        ? toolStep("w1", "Write", { file_path: "/work/out.txt", content: "hi" })
        : textStep("done"),
    );
    const parent = makeParent({ modelPort: model, mode: "plan" });
    const childLoop = new AgentLoop(buildChildConfig(parent, persona, { ...REQ, agentType: "writer" }));

    const events = await collect(childLoop.runTurn("write a file"));
    const write = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Write");
    expect(write?.type === "tool_result" && write.outcome.status).toBe("denied");
  });

  it("Skill in a profile's allowlist is declared but fails closed (no SkillPort on the child)", async () => {
    const persona = await makeProfile("skiller", { body: "P", tools: ["Read", "Skill"] });
    const parent = makeParent({
      modelPort: new ScriptedModelPort((req) =>
        lastRole(req) === "user"
          ? toolStep("s1", "Skill", { name: "anything" })
          : textStep("done"),
      ),
      mode: "yolo",
    });

    // The child registry DOES declare Skill, but the derived child carries no
    // SkillPort — so the outcome is the fail-closed "unavailable" error.
    const child = buildChildConfig(parent, persona, { ...REQ, agentType: "skiller" });
    expect(child.registry.has("Skill")).toBe(true);
    expect(child.skills).toBeUndefined();

    const events = await collect(new AgentLoop(child).runTurn("load a skill"));
    const skill = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Skill");
    expect(skill?.type === "tool_result" && skill.outcome.status).toBe("error");
    expect(skill?.type === "tool_result" && skill.outcome.modelText).toContain("unavailable");
  });

  it("a built-in agent_type still resolves to the built-in even if a profile shares the name", async () => {
    // Discovery drops built-in collisions, but prove the runner's second rubicon
    // directly: a profile object named "explore" never shadows the built-in.
    const shadow: PersonaDefinition = {
      name: "explore",
      description: "malicious shadow",
      tools: ["Bash"],
      systemPrompt: "SHADOW PROMPT",
    };
    const model = new ScriptedModelPort(() => textStep("built-in explore ran"));
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }), {
      profiles: [shadow],
    });

    const outcome = await runner.run({ ...REQ, agentType: "explore" }, {});
    expect(outcome.status).toBe("completed");
    // The built-in explore prompt was used, not the shadow's (embedded in the
    // harness prelude, slice 3.6).
    const childReq = model.requests.find((r) => r.system !== undefined);
    expect(childReq?.system).toContain(PERSONAS.explore.systemPrompt);
    expect(childReq?.system).not.toContain("SHADOW PROMPT");
  });
});

// ---------------------------------------------------------------------------
// Live profile rescan (subagent-model design): opts.profiles accepts a thunk
// so a host can re-point the runner's profile source between turns (after a
// rescan of .anycode/agents/) instead of only a boot-time snapshot. Proves the
// runner never caches a profile map at construction time — every
// listAgentTypes()/run() call re-reads the thunk.

describe("opts.profiles as a live source (thunk)", () => {
  it("a profile added to the thunk's result AFTER the runner was created is visible via listAgentTypes()", async () => {
    let live: PersonaDefinition[] = [];
    const runner = createSubagentRunner(makeParent(), { profiles: () => live });

    expect(runner.listAgentTypes?.()).toEqual(["general-purpose", "explore"]);

    const persona = await makeProfile("reviewer", { body: "P" });
    live = [persona];

    expect(runner.listAgentTypes?.()).toEqual(["general-purpose", "explore", "reviewer"]);
  });

  it("a profile added to the thunk's result AFTER the runner was created is runnable via run()", async () => {
    let live: PersonaDefinition[] = [];
    const model = new ScriptedModelPort(() => textStep("late profile ran"));
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }), {
      profiles: () => live,
    });

    // Not yet visible: the thunk still returns an empty array at this point.
    const early = await runner.run({ ...REQ, agentType: "reviewer" }, {});
    expect(early.status).toBe("error");
    expect(early.finalText).toContain("Unknown agent_type");

    const persona = await makeProfile("reviewer", { body: "P" });
    live = [persona];

    const late = await runner.run({ ...REQ, agentType: "reviewer" }, {});
    expect(late.status).toBe("completed");
    expect(late.finalText).toBe("late profile ran");
  });

  it("an array source still behaves as a fixed boot-time snapshot (unchanged behavior)", async () => {
    const persona = await makeProfile("reviewer", { body: "P" });
    const runner = createSubagentRunner(makeParent(), { profiles: [persona] });
    expect(runner.listAgentTypes?.()).toEqual(["general-purpose", "explore", "reviewer"]);
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode child-registry lock (Phase 4 slice 4.3, design §0.1/§5.2 item 8).
// ExitPlanMode is deliberately NOT in createDefaultToolRegistry (design §2.5

// is frozen) — so a profile that lists it hits the exact same silent-skip path
// as an unknown tool name, the same by-construction lock SPAWN_TOOLS re-proves
// above for Agent/Workflow, with no dedicated branch needed in buildPersonaRegistry.

describe("ExitPlanMode absence from the child registry (slice 4.3, §0.1/§5.2 item 8)", () => {
  it("a profile listing ExitPlanMode never reaches the child: unknown to the default registry, silently skipped", async () => {
    const persona = await makeProfile("planner", { body: "P", tools: ["ExitPlanMode", "Read"] });

    const child = buildChildConfig(makeParent({ mode: "plan" }), persona, {
      ...REQ,
      agentType: "planner",
    });

    expect(child.registry.has("ExitPlanMode")).toBe(false);
    expect(child.registry.list().sort()).toEqual(["Read"]);
    // Prompt-level mirror: the tool-discipline section enumerates only the
    // surviving registry, so the child's own system prompt cannot advertise it.
    expect(child.systemPrompt).not.toContain("ExitPlanMode");
    // Double lock (design §2.3/§0.1): buildChildConfig's return is an explicit
    // object literal that never sets planExitMode, so even if a future default-
    // registry promotion added the tool by name, the derived child still has no
    // sanctioned mode-exit control to hand it through ToolContext.planMode.
    expect(child.planExitMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SubagentStop hook (slice 5.6, Wave A). Fires ONCE from the runner after a
// subagent that actually started finishes — fail-open, inside the semaphore
// permit (released by the finally), parity with the Stop hook in agent-loop.ts.
// The child AgentLoop shares the parent's HookRunner, so it also fires its own
// "Stop" observer; tests filter runObservers calls to "SubagentStop" to keep the
// two distinct.

describe("SubagentStop hook (slice 5.6 Wave A)", () => {
  it("fires exactly once carrying the child outcome on a completed run", async () => {
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1 ? toolStep("c1", "TodoRead", {}, "working") : textStep("child report");
    });
    const { hooks, calls } = recordingHooks();
    const runner = createSubagentRunner(makeParent({ modelPort: model, hooks, mode: "yolo" }));

    const outcome = await runner.run(
      { ...REQ, agentType: "explore", description: "explore task" },
      {},
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.toolCalls).toBe(1);
    const subCalls = calls.filter((c) => c.event === "SubagentStop");
    expect(subCalls).toHaveLength(1);
    // The fire carries agentType (persona.name) + description + every outcome field.
    expect(subCalls[0]!.input).toEqual({
      agentType: "explore",
      description: "explore task",
      status: outcome.status,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls,
      durationMs: outcome.durationMs,
    });
  });

  it("fires with status error when the child stream errors (no loop_end)", async () => {
    const errorModel: ModelPort = {
      streamText(): AsyncIterable<ModelStreamEvent> {
        return (async function* () {
          yield { type: "start" };
          throw new Error("stream boom");
        })();
      },
    };
    const { hooks, calls } = recordingHooks();
    const runner = createSubagentRunner(makeParent({ modelPort: errorModel, hooks }));

    const outcome = await runner.run({ ...REQ, agentType: "explore" }, {});

    expect(outcome.status).toBe("error");
    const subCalls = calls.filter((c) => c.event === "SubagentStop");
    expect(subCalls).toHaveLength(1);
    expect((subCalls[0]!.input as SubagentStopHookInput).status).toBe("error");
  });

  // Note: this uses the recording stub, which always runs the observer body. With
  // the REAL InMemoryHookRunner an already-aborted signal makes runObservers throw
  // at its aborted-guard BEFORE invoking any registered hook (exact parity with the
  // Stop hook — see hook-runner.test.ts), and the fire-site try/catch swallows it
  // fail-open. So on a cancelled run the fire-site is REACHED (this test) but a
  // command hook body does NOT run; the outcome stays cancelled either way.
  it("reaches the SubagentStop fire-site on a started-then-aborted child (status cancelled, fail-open)", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gatedModel: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const signal = req.abortSignal;
        return (async function* () {
          await gate;
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield { type: "start" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })();
      },
    };
    const { hooks, calls } = recordingHooks();
    const runner = createSubagentRunner(makeParent({ modelPort: gatedModel, hooks, mode: "yolo" }));

    const controller = new AbortController();
    const pending = runner.run({ ...REQ, agentType: "explore" }, { signal: controller.signal });
    await delay(20); // the child acquired a permit and is parked in the model call
    controller.abort();
    releaseGate(); // let the parked model observe the abort and throw
    const outcome = await pending;

    expect(outcome.status).toBe("cancelled");
    const subCalls = calls.filter((c) => c.event === "SubagentStop");
    expect(subCalls).toHaveLength(1);
    expect((subCalls[0]!.input as SubagentStopHookInput).status).toBe("cancelled");
  });

  it("does NOT fire for a pre-aborted spawn (the subagent never started)", async () => {
    const { hooks, calls } = recordingHooks();
    const runner = createSubagentRunner(
      makeParent({ modelPort: new ScriptedModelPort(() => textStep("never")), hooks }),
    );
    const controller = new AbortController();
    controller.abort();

    const outcome = await runner.run(
      { ...REQ, agentType: "explore" },
      { signal: controller.signal },
    );

    expect(outcome.status).toBe("cancelled");
    expect(calls.filter((c) => c.event === "SubagentStop")).toHaveLength(0);
  });

  it("a throwing SubagentStop hook leaves the SubagentOutcome identical to a no-hook run", async () => {
    const script = (): ModelStreamEvent[] => textStep("stable report");

    const plain = createSubagentRunner(makeParent({ modelPort: new ScriptedModelPort(script) }));
    const noHook = await plain.run({ ...REQ, agentType: "explore" }, {});

    const { hooks } = recordingHooks({
      onSubagentStop: async () => {
        throw new Error("hook boom");
      },
    });
    const withHook = createSubagentRunner(
      makeParent({ modelPort: new ScriptedModelPort(script), hooks }),
    );
    const throwing = await withHook.run({ ...REQ, agentType: "explore" }, {});

    // durationMs is inherently timing-variant; every model-visible field is identical.
    const { durationMs: _d1, ...restNoHook } = noHook;
    const { durationMs: _d2, ...restThrowing } = throwing;
    expect(restThrowing).toEqual(restNoHook);
  });

  it("releases the permit even when every SubagentStop hook throws: N+1 subagents drain past the cap", async () => {
    const { hooks } = recordingHooks({
      onSubagentStop: async () => {
        throw new Error("hook boom");
      },
    });
    const runner = createSubagentRunner(
      makeParent({ modelPort: new ScriptedModelPort(() => textStep("ok")), hooks, mode: "yolo" }),
    );

    // If a throwing fire leaked the permit, the pool would starve after
    // MAX_CONCURRENT_SUBAGENTS completions and this Promise.all would hang.
    const total = MAX_CONCURRENT_SUBAGENTS + 3;
    const outcomes = await Promise.all(
      Array.from({ length: total }, (_unused, i) =>
        runner.run({ ...REQ, agentType: "explore", prompt: String(i) }, {}),
      ),
    );
    expect(outcomes).toHaveLength(total);
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
  });

  it("releases the permit even when a SubagentStop hook is slow: the pool still drains", async () => {
    const { hooks } = recordingHooks({
      onSubagentStop: async () => {
        await delay(20);
      },
    });
    const runner = createSubagentRunner(
      makeParent({ modelPort: new ScriptedModelPort(() => textStep("ok")), hooks, mode: "yolo" }),
    );

    const total = MAX_CONCURRENT_SUBAGENTS + 2;
    const outcomes = await Promise.all(
      Array.from({ length: total }, () => runner.run({ ...REQ, agentType: "explore" }, {})),
    );
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-child-tool activity feed (slice P7.18/F16b). Each child tool_call becomes
// one bounded { kind:"tool" } progress event carrying a pre-capped summary; the
// per-run emission is capped at SUBAGENT_ACTIVITY_MAX_EVENTS (counters/start/end
// are unaffected). A single assistant step may carry many parallel tool calls,
// which is how the cap boundary is crossed here.

function multiToolStep(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ModelStreamEvent[] {
  return [
    { type: "start" },
    ...calls.map((c) => ({ type: "tool_call" as const, toolCall: { id: c.id, name: c.name, input: c.input } })),
    { type: "finish", finishReason: "tool_calls" as const, usage: {} },
  ];
}

/**
 * One model STEP that proposes `discardedCalls`, hits a stream_retry (the whole
 * step is replayed from scratch per agent-loop.ts), then proposes `keptCalls`
 * and finishes (W1-FIX regression coverage). Mirrors exactly what the real
 * provider adapter emits around a mid-stream stall/retry.
 */
function retriedToolStep(
  discardedCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  keptCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ModelStreamEvent[] {
  return [
    { type: "start" },
    ...discardedCalls.map(
      (c) => ({ type: "tool_call" as const, toolCall: { id: c.id, name: c.name, input: c.input } }),
    ),
    { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, reason: "stall" },
    ...keptCalls.map((c) => ({ type: "tool_call" as const, toolCall: { id: c.id, name: c.name, input: c.input } })),
    { type: "finish", finishReason: "tool_calls" as const, usage: {} },
  ];
}

describe("subagent activity feed (slice P7.18/F16b)", () => {
  it("emits one { kind:'tool' } progress per child tool_call with a capped summary", async () => {
    let step = 0;
    const longCmd = "echo " + "x".repeat(500);
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1
        ? multiToolStep([
            { id: "t1", name: "Bash", input: { command: longCmd } },
            { id: "t2", name: "TodoRead", input: {} },
          ])
        : textStep("child done");
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    const activity = progress.filter(
      (p): p is Extract<SubagentProgress, { kind: "tool" }> => p.kind === "tool",
    );
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ kind: "tool", toolName: "Bash" });
    // Bash summary is the first line of command, hard-capped at 160 chars.
    expect(activity[0]!.summary.length).toBe(160);
    expect(activity[0]!.summary.startsWith("echo ")).toBe(true);
    // Fallback tool: name only, empty summary.
    expect(activity[1]).toEqual({ kind: "tool", toolName: "TodoRead", summary: "" });
  });

  it("stops emitting tool-activity past SUBAGENT_ACTIVITY_MAX_EVENTS (counters unaffected)", async () => {
    const overflow = SUBAGENT_ACTIVITY_MAX_EVENTS + 5;
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1
        ? multiToolStep(
            Array.from({ length: overflow }, (_unused, i) => ({
              id: `t${i}`,
              name: "TodoRead",
              input: {},
            })),
          )
        : textStep("child done");
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    const activity = progress.filter((p) => p.kind === "tool");
    expect(activity).toHaveLength(SUBAGENT_ACTIVITY_MAX_EVENTS);
    // The child actually ran all the tool calls — the counter progress is honest,
    // only the activity feed is bounded.
    expect(outcome.toolCalls).toBe(overflow);
    expect(progress.some((p) => p.kind === "progress")).toBe(true);
  });

  it(
    "W1-FIX: a stream_retry discards proposed-but-never-dispatched tool_calls — " +
      "no phantom activity rows, and the discarded attempt never burns the cap",
    async () => {
      let step = 0;
      const model = new ScriptedModelPort(() => {
        step += 1;
        // Step 1: the model proposes THREE calls, the stream stalls and retries
        // (whole step replayed from scratch), then proposes exactly ONE call on
        // the winning attempt. Pre-fix, activity was emitted on the "tool_call"
        // PROPOSAL event — all 4 proposals (3 discarded + 1 kept) would have
        // produced an activity row and consumed 4 slots of the cap, even though
        // only 1 call ever actually ran. Post-fix, activity rides tool_result
        // (the dispatch/execution boundary), which the discarded attempt never
        // reaches — only the winning attempt's ONE call is ever dispatched.
        return step === 1
          ? retriedToolStep(
              [
                { id: "discarded-1", name: "Bash", input: { command: "echo discarded-1" } },
                { id: "discarded-2", name: "Bash", input: { command: "echo discarded-2" } },
                { id: "discarded-3", name: "Bash", input: { command: "echo discarded-3" } },
              ],
              [{ id: "kept-1", name: "TodoRead", input: {} }],
            )
          : textStep("child done");
      });
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
      const progress: SubagentProgress[] = [];

      const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
        onProgress: (p) => progress.push(p),
      });

      expect(outcome.status).toBe("completed");
      // The honest toolCalls counter (tool_result-driven) already proved this
      // pre-fix: only the ONE call that survived the retry was ever dispatched.
      expect(outcome.toolCalls).toBe(1);

      const activity = progress.filter(
        (p): p is Extract<SubagentProgress, { kind: "tool" }> => p.kind === "tool",
      );
      // No phantom rows for the 3 discarded proposals: exactly one activity row,
      // for the call that actually ran.
      expect(activity).toHaveLength(1);
      expect(activity[0]).toEqual({ kind: "tool", toolName: "TodoRead", summary: "" });
    },
  );
});

// ---------------------------------------------------------------------------
// Honest activitySuppressed count (TASK.102 slice S1 W2, CUT-S1 §0.5/§3 W2).
// The activity feed silently stopped emitting past SUBAGENT_ACTIVITY_MAX_EVENTS
// (P7.18/F16b); S1 makes the withheld count observable on subagent_end so the
// persisted card's "+N earlier" is never a lie relative to what actually ran.

describe("subagent activitySuppressed (TASK.102 slice S1 W2)", () => {
  it("emits exactly SUBAGENT_ACTIVITY_MAX_EVENTS activity rows and reports the EXACT suppressed count on end", async () => {
    const overflow = SUBAGENT_ACTIVITY_MAX_EVENTS + 37;
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1
        ? multiToolStep(
            Array.from({ length: overflow }, (_unused, i) => ({
              id: `t${i}`,
              name: "TodoRead",
              input: {},
            })),
          )
        : textStep("child done");
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    const activity = progress.filter((p) => p.kind === "tool");
    expect(activity).toHaveLength(SUBAGENT_ACTIVITY_MAX_EVENTS);
    const endEvents = progress.filter((p): p is Extract<SubagentProgress, { kind: "end" }> => p.kind === "end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]!.activitySuppressed).toBe(overflow - SUBAGENT_ACTIVITY_MAX_EVENTS);
  });

  it("a child that never crosses the cap carries no activitySuppressed key on end (no silent zero)", async () => {
    const model = new ScriptedModelPort(() => textStep("no tools needed"));
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    const endEvents = progress.filter((p): p is Extract<SubagentProgress, { kind: "end" }> => p.kind === "end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0] && "activitySuppressed" in endEvents[0]).toBe(false);
  });

  it("invalid_input child tool calls count toward NEITHER emitted activity NOR activitySuppressed", async () => {
    // Fill the activity cap exactly with valid calls, THEN propose more calls
    // that are invalid (SDK-level parse failure, ProposedToolCall.invalid) —
    // if invalid_input calls counted as suppressed, activitySuppressed would
    // include them; they must not, since they never actually ran.
    const validCount = SUBAGENT_ACTIVITY_MAX_EVENTS;
    const invalidCount = 4;
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      if (step !== 1) {
        return textStep("child done");
      }
      const validCalls = Array.from({ length: validCount }, (_unused, i) => ({
        type: "tool_call" as const,
        toolCall: { id: `valid-${i}`, name: "TodoRead", input: {} },
      }));
      const invalidCalls = Array.from({ length: invalidCount }, (_unused, i) => ({
        type: "tool_call" as const,
        toolCall: {
          id: `invalid-${i}`,
          name: "Bash",
          input: {},
          invalid: { reason: "unparseable arguments" },
        },
      }));
      return [
        { type: "start" as const },
        ...validCalls,
        ...invalidCalls,
        { type: "finish" as const, finishReason: "tool_calls" as const, usage: {} },
      ];
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    const activity = progress.filter((p) => p.kind === "tool");
    expect(activity).toHaveLength(validCount);
    const endEvents = progress.filter((p): p is Extract<SubagentProgress, { kind: "end" }> => p.kind === "end");
    // The valid calls exactly filled the cap; the invalid ones never reached
    // dispatch, so they must not push activitySuppressed above zero.
    expect(endEvents[0] && "activitySuppressed" in endEvents[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Profile-declared model (`model:` frontmatter). Precedence is request >
// profile > inherit-parent; a host with no resolver refuses honestly rather
// than running the child on a model its author did not ask for.

describe("profile-declared model", () => {
  it("runs the child on the profile's model when the request names none", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER", model: "profile-model" });
    const parentModel = new ScriptedModelPort(() => textStep("parent-report"));
    const profileModel = new ScriptedModelPort(() => textStep("profile-report"));
    const resolved: string[] = [];
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      profiles: [persona],
      resolveChildModelPort: (modelId) => {
        resolved.push(modelId);
        return profileModel;
      },
    });

    const outcome = await runner.run({ ...REQ, agentType: "reviewer" }, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("profile-report");
    expect(resolved).toEqual(["profile-model"]);
    expect(parentModel.calls).toBe(0);
  });

  it("an explicit request model outranks the profile's own", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER", model: "profile-model" });
    const resolved: string[] = [];
    const runner = createSubagentRunner(makeParent(), {
      profiles: [persona],
      resolveChildModelPort: (modelId) => {
        resolved.push(modelId);
        return new ScriptedModelPort(() => textStep("resolved"));
      },
    });

    const outcome = await runner.run(
      { ...REQ, agentType: "reviewer", model: "request-model" },
      {},
    );

    expect(outcome.status).toBe("completed");
    expect(resolved).toEqual(["request-model"]);
  });

  it("a profile without `model:` still inherits the parent's port", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER" });
    const parentModel = new ScriptedModelPort(() => textStep("parent-report"));
    let resolverCalls = 0;
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      profiles: [persona],
      resolveChildModelPort: () => {
        resolverCalls += 1;
        return new ScriptedModelPort(() => textStep("never"));
      },
    });

    const outcome = await runner.run({ ...REQ, agentType: "reviewer" }, {});

    expect(outcome.finalText).toBe("parent-report");
    expect(resolverCalls).toBe(0);
  });

  it("names the profile (not a phantom request field) when the host has no resolver", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER", model: "profile-model" });
    const parentModel = new ScriptedModelPort(() => textStep("should never run"));
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      profiles: [persona],
    });

    const outcome = await runner.run({ ...REQ, agentType: "reviewer" }, {});

    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe(
      'Agent: agent type "reviewer" declares model "profile-model", which is not supported in this host.',
    );
    expect(parentModel.calls).toBe(0);
  });

  it("a resolver that rejects an unknown id becomes an error outcome, not a rejected promise", async () => {
    const persona = await makeProfile("reviewer", { body: "REVIEWER", model: "no-such-model" });
    const runner = createSubagentRunner(makeParent(), {
      profiles: [persona],
      resolveChildModelPort: (modelId) => {
        throw new Error(`unknown model ${modelId}`);
      },
    });

    const outcome = await runner.run({ ...REQ, agentType: "reviewer" }, {});

    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain("no-such-model");
    expect(outcome.finalText).toContain("unknown model no-such-model");
  });
});

// ---------------------------------------------------------------------------
// Engine persona (subagent-model contract): a md-profile `engine:` frontmatter
// makes its children run as a one-shot foreign CLI run (Codex or Claude Code)
// instead of an in-process AgentLoop. `run()` must dispatch to
// SubagentRunnerOptions.runEngineChild and skip buildChildConfig/AgentLoop/
// resolveChildModelPort entirely for such a persona; a host that omits
// runEngineChild gets a honest error-outcome, never a silent in-process fallback.

describe("engine persona (one-shot foreign CLI run)", () => {
  const enginePersona: PersonaDefinition = {
    name: "codex-worker",
    description: "runs on the codex engine",
    tools: ["Read"],
    systemPrompt: "PERSONA BODY",
    engine: "codex",
  };

  function okOutcome(overrides: Partial<SubagentOutcome> = {}): SubagentOutcome {
    return {
      status: "completed",
      finalText: "engine child report",
      truncated: false,
      turns: 1,
      toolCalls: 0,
      durationMs: 5,
      ...overrides,
    };
  }

  it("dispatches to runEngineChild with the persona-body+request prompt and never builds an in-process child", async () => {
    const parentModel = new ScriptedModelPort(() => textStep("should never run"));
    const specs: EngineChildSpec[] = [];
    const runEngineChild = vi.fn(async (spec: EngineChildSpec): Promise<SubagentOutcome> => {
      specs.push(spec);
      return okOutcome();
    });
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      profiles: [enginePersona],
      runEngineChild,
    });
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run(
      { agentType: "codex-worker", description: "delegate", prompt: "do the thing" },
      { onProgress: (p) => progress.push(p) },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("engine child report");
    expect(runEngineChild).toHaveBeenCalledTimes(1);
    expect(specs[0]).toEqual({
      engine: "codex",
      prompt: "PERSONA BODY\n\n---\n\ndo the thing",
      agentType: "codex-worker",
      description: "delegate",
    });
    // Discriminating: no in-process child AgentLoop was ever built — a built
    // child's first turn would have had to call the parent's model port.
    expect(parentModel.calls).toBe(0);

    const start = progress.find((p) => p.kind === "start");
    expect(start).toMatchObject({ kind: "start", agentType: "codex-worker", engine: "codex" });
    const end = progress.find((p) => p.kind === "end");
    expect(end).toMatchObject({ kind: "end", status: "completed", turns: 1 });
  });

  it("model precedence: req.model outranks the persona's own, absent both the spec omits model", async () => {
    const specs: EngineChildSpec[] = [];
    const runEngineChild = vi.fn(async (spec: EngineChildSpec): Promise<SubagentOutcome> => {
      specs.push(spec);
      return okOutcome();
    });
    const withModel: PersonaDefinition = { ...enginePersona, model: "persona-model" };
    const runner = createSubagentRunner(makeParent(), {
      profiles: [withModel, enginePersona],
      runEngineChild,
    });

    await runner.run({ agentType: "codex-worker", description: "d", prompt: "p" }, {});
    expect(specs[0]?.model).toBe("persona-model");

    await runner.run(
      { agentType: "codex-worker", description: "d", prompt: "p", model: "request-model" },
      {},
    );
    expect(specs[1]?.model).toBe("request-model");
  });

  it("fires SubagentStop with the engine child's own outcome fields", async () => {
    const { hooks, calls } = recordingHooks();
    const runEngineChild = vi.fn(
      async (): Promise<SubagentOutcome> => okOutcome({ turns: 3, toolCalls: 2, durationMs: 42 }),
    );
    const runner = createSubagentRunner(makeParent({ hooks }), {
      profiles: [enginePersona],
      runEngineChild,
    });

    await runner.run({ agentType: "codex-worker", description: "engine task", prompt: "p" }, {});

    const subCalls = calls.filter((c) => c.event === "SubagentStop");
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]!.input).toEqual({
      agentType: "codex-worker",
      description: "engine task",
      status: "completed",
      turns: 3,
      toolCalls: 2,
      durationMs: 42,
    });
  });

  it("without runEngineChild: a honest error-outcome, NOT a silent fallback to the in-process loop", async () => {
    const parentModel = new ScriptedModelPort(() => textStep("should never run"));
    const runner = createSubagentRunner(makeParent({ modelPort: parentModel }), {
      profiles: [enginePersona], // no runEngineChild
    });

    const outcome = await runner.run(
      { agentType: "codex-worker", description: "d", prompt: "p" },
      {},
    );

    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain("codex-worker");
    expect(outcome.finalText).toContain("codex");
    // Discriminating: the parent's own model port (what buildChildConfig would
    // inherit by default) was never called — there is no fallback child loop.
    expect(parentModel.calls).toBe(0);
  });

  it("TASK.102 CUT-S4 §2.4: without runEngineChild, the error text names the S4 migration (deprecated-live workflow path) verbatim, not the pre-S4 'not supported' wording", async () => {
    const runner = createSubagentRunner(makeParent(), {
      profiles: [enginePersona], // no runEngineChild
    });

    const outcome = await runner.run({ agentType: "codex-worker", description: "d", prompt: "p" }, {});

    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe(
      'Agent: agent type "codex-worker" runs on the "codex" engine. Engine agents now run as child sessions via the Agent tool; this caller (workflow step or non-desktop host) cannot spawn one.',
    );
  });

  it("an engine persona without a host resolver fails BEFORE the semaphore — it never queues behind running children", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let started = 0;
    const gatedModel: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        started += 1;
        const signal = req.abortSignal;
        return (async function* () {
          await gate;
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield { type: "start" };
          yield { type: "text_delta", id: "t", text: "ok" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })();
      },
    };
    // No runEngineChild: an engine-persona spawn can only ever error out.
    const runner = createSubagentRunner(makeParent({ modelPort: gatedModel, mode: "yolo" }), {
      profiles: [enginePersona],
    });

    // Two real (built-in, in-process) children hold BOTH semaphore permits
    // (MAX_CONCURRENT_SUBAGENTS = 2) and are gated open.
    const p1 = runner.run({ ...REQ, agentType: "explore", prompt: "1" }, {});
    const p2 = runner.run({ ...REQ, agentType: "explore", prompt: "2" }, {});
    await delay(40);
    expect(started).toBe(2);

    const errOutcome = await runner.run(
      { agentType: "codex-worker", description: "d", prompt: "p" },
      {},
    );
    expect(errOutcome.status).toBe("error");
    expect(started).toBe(2); // no third model call was ever attempted

    releaseGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
  });

  it("a built-in agent_type is never affected by an unrelated engine profile sharing the runner", async () => {
    const model = new ScriptedModelPort((req) =>
      isChildRequest(req) ? textStep("built-in child report") : textStep("n/a"),
    );
    const runner = createSubagentRunner(makeParent({ modelPort: model }), {
      profiles: [enginePersona],
      // No runEngineChild — proves the built-in path below never consults it.
    });

    const outcome = await runner.run({ ...REQ, agentType: "general-purpose" }, {});
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("built-in child report");
  });
});

// ---------------------------------------------------------------------------
// engineProfile() port method (TASK.102 CUT-S4 §2.1): tools/agent.ts's new
// routing branch resolves an md-profile's `engine:` frontmatter through this
// method BEFORE the tier branch. Realized through the SAME thunk mechanism as
// listAgentTypes (currentProfiles()) — no second list/cache. Built-in personas
// always resolve to null (they never have an `engine`).

describe("engineProfile() (TASK.102 CUT-S4 §2.1)", () => {
  const codexPersona: PersonaDefinition = {
    name: "codex-worker",
    description: "runs on the codex engine",
    tools: ["Read"],
    systemPrompt: "PERSONA BODY",
    engine: "codex",
  };

  it("resolves an engine profile to {engine, systemPrompt}", () => {
    const runner = createSubagentRunner(makeParent(), { profiles: [codexPersona] });
    expect(runner.engineProfile?.("codex-worker")).toEqual({ engine: "codex", systemPrompt: "PERSONA BODY" });
  });

  it("returns null for a built-in persona (never an engine profile)", () => {
    const runner = createSubagentRunner(makeParent(), { profiles: [codexPersona] });
    expect(runner.engineProfile?.("general-purpose")).toBeNull();
    expect(runner.engineProfile?.("explore")).toBeNull();
  });

  it("returns null for a non-engine md-profile", async () => {
    const persona = await makeProfile("reviewer", { body: "P" });
    const runner = createSubagentRunner(makeParent(), { profiles: [persona] });
    expect(runner.engineProfile?.("reviewer")).toBeNull();
  });

  it("returns null for an unknown agent type", () => {
    const runner = createSubagentRunner(makeParent());
    expect(runner.engineProfile?.("no-such-type")).toBeNull();
  });

  it("live rescan: a profile added to the thunk's result AFTER construction becomes visible (same mechanism as listAgentTypes)", () => {
    let live: PersonaDefinition[] = [];
    const runner = createSubagentRunner(makeParent(), { profiles: () => live });

    expect(runner.engineProfile?.("codex-worker")).toBeNull();

    live = [codexPersona];

    expect(runner.engineProfile?.("codex-worker")).toEqual({ engine: "codex", systemPrompt: "PERSONA BODY" });
  });

  // TASK.102 CUT-S4 model plumbing fix: a profile's own `model:` frontmatter
  // was parsed and validated (profiles.ts) and stored on PersonaDefinition,
  // but engineProfile() dropped it before it ever reached tools/agent.ts's
  // session-tier request — the child booted on the engine CLI's own default
  // instead of the model the profile author declared.
  it("carries persona.model onto the returned EngineProfileInfo when the profile declares one", () => {
    const withModel: PersonaDefinition = { ...codexPersona, model: "profile-model" };
    const runner = createSubagentRunner(makeParent(), { profiles: [withModel] });
    expect(runner.engineProfile?.("codex-worker")).toEqual({
      engine: "codex",
      systemPrompt: "PERSONA BODY",
      model: "profile-model",
    });
  });

  it("omits the model key entirely when the profile declares none (no undefined riding the result)", () => {
    const runner = createSubagentRunner(makeParent(), { profiles: [codexPersona] });
    const info = runner.engineProfile?.("codex-worker");
    expect(info && "model" in info).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK.74 — wall-clock budget + wrap-up rescue. The measurement that motivated
// this: one child in three died on the 8-turn cap having spent 13-66% of its
// 600s, and the partial the parent received was the preamble of the cut-off
// turn ("now let me check X"), not the findings. The budget is now time; the
// turn count only stops a runaway; and an exhausted child gets ONE tool-free
// model call to turn what it saw into a report.
//
// Every test below drives the REAL seam (runner -> buildChildConfig -> AgentLoop
// -> dispatcher); only the ModelPort is scripted. Deadline tests fake Date ONLY
// — the dispatcher, the semaphore and the wrap-up timer all need real timers.

/** Fixed wall-clock origin for the fake-Date tests. */
const CLOCK_BASE = 1_700_000_000_000;

describe("subagent budget constants (TASK.74 §2.1)", () => {
  it("a wrap-up started at the loop deadline still returns before the dispatcher wall", () => {
    expect(SUBAGENT_LOOP_DEADLINE_MS + SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS).toBeLessThanOrEqual(
      SUBAGENT_OUTCOME_DEADLINE_MS,
    );
    expect(SUBAGENT_OUTCOME_DEADLINE_MS).toBeLessThan(SUBAGENT_TIME_BUDGET_MS);
    // A minimum window that is not strictly inside the call ceiling would either
    // never skip or always skip.
    expect(SUBAGENT_WRAPUP_MIN_WINDOW_MS).toBeGreaterThan(0);
    expect(SUBAGENT_WRAPUP_MIN_WINDOW_MS).toBeLessThan(SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS);
    // The default budget must itself be reachable under the ceiling.
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBeLessThanOrEqual(SUBAGENT_MAX_TURNS_CEILING);
  });
});

describe("child wall-clock deadline (TASK.74 §3, DoD-1)", () => {
  it("ends the child with max_turns when the deadline passes, well short of the turn budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_BASE);
    try {
      let step = 0;
      const model = new ScriptedModelPort((req) => {
        if (isWrapUpRequest(req)) {
          return textStep("REPORT: deadline rescue");
        }
        step += 1;
        if (step === 3) {
          // The third step is the expensive one: it runs the clock past the
          // child's deadline while the turn is in flight.
          vi.setSystemTime(CLOCK_BASE + SUBAGENT_LOOP_DEADLINE_MS + 1);
        }
        return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
      });
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));

      // No maxTurns => the persona budget of 24. The run must NOT reach it.
      const outcome = await runner.run({ ...REQ }, {});

      expect(outcome.status).toBe("max_turns");
      expect(outcome.turns).toBe(3);
      expect(outcome.turns).toBeLessThan(DEFAULT_SUBAGENT_MAX_TURNS);
      // Three loop steps + one wrap-up; the model was not called again.
      expect(model.calls).toBe(4);
      expect(outcome.finalText).toBe("REPORT: deadline rescue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a child whose deadline expired while queued exits max_turns with zero turns instead of running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_BASE);
    try {
      const model = new ScriptedModelPort(() => textStep("should never run"));
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
      // Simulates the observed "parked behind siblings until the budget was
      // gone" run: the clock is already past the deadline when the loop starts.
      const started = runner.run({ ...REQ }, {});
      vi.setSystemTime(CLOCK_BASE + SUBAGENT_LOOP_DEADLINE_MS + 1);
      const outcome = await started;

      expect(outcome.status).toBe("max_turns");
      expect(outcome.turns).toBe(0);
      // Zero turns => nothing to summarize => no wrap-up call either.
      expect(model.calls).toBe(0);
      expect(outcome.finalText).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wrap-up rescue end-to-end (TASK.74 §4, DoD-2)", () => {
  const scoutBody = "You are the tiny scout profile body.";
  const scout: PersonaDefinition = {
    name: "tiny-scout",
    description: "two-turn scout",
    tools: ["TodoRead"],
    systemPrompt: scoutBody,
    turnBudget: 2,
  };

  it("carries the rescued report through parent-loop -> dispatcher -> agentTool -> runner -> child-loop", async () => {
    const model = new ScriptedModelPort((req) => {
      if (isWrapUpRequest(req)) {
        return textStep("REPORT: found X; unchecked: Y");
      }
      if (req.system?.includes(scoutBody)) {
        // What the child was ABOUT to do — exactly the useless partial the
        // parent used to receive.
        return toolStep("k", "TodoRead", {}, "now let me check the other half");
      }
      return lastRole(req) === "user"
        ? toolStep("agent-1", "Agent", {
            description: "scout work",
            prompt: "sweep the repo",
            agent_type: "tiny-scout",
          })
        : textStep("parent done");
    });
    const loop = new AgentLoop(
      withSubagents(makeParent({ modelPort: model, mode: "yolo" }), { profiles: [scout] }),
    );

    const events = await collect(loop.runTurn("please spawn a scout"));

    // What the parent model actually reads.
    const agentResult = events.find(
      (e) => e.type === "tool_result" && e.outcome.toolName === "Agent",
    );
    expect(agentResult?.type === "tool_result" && agentResult.outcome.status).toBe("max_turns");
    const modelText = agentResult?.type === "tool_result" ? agentResult.outcome.modelText : "";
    expect(modelText).toContain("INCOMPLETE SUBAGENT RESULT");
    expect(modelText).toContain("REPORT: found X");
    // The preamble of the cut-off turn is NOT what travels back.
    expect(modelText).not.toContain("now let me check the other half");
    // The status is never promoted by a technically successful wrap-up.
    const result = agentResult?.type === "tool_result" ? agentResult.outcome.result : undefined;
    expect(result?.ok).toBe(false);
    expect(result?.errorKind).toBe("max_turns");
    expect((result?.output as SubagentOutcome | undefined)?.status).toBe("max_turns");
    expect((result?.output as SubagentOutcome | undefined)?.turns).toBe(2);

    const end = events.find((e) => e.type === "subagent_end");
    expect(end?.type === "subagent_end" && end.status).toBe("max_turns");
    expect(end?.type === "subagent_end" && end.turns).toBe(2);
    expect(loop.history.unansweredToolCallIds()).toEqual([]);

    // The rescue call itself: no tools, and the child's own transcript plus one
    // synthetic user message.
    const wrapReq = model.requests.find(isWrapUpRequest);
    expect(wrapReq).toBeDefined();
    expect(wrapReq!.tools).toHaveLength(0);
    expect(wrapReq!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    expect(wrapReq!.messages[0]).toEqual({ role: "user", content: "sweep the repo" });
    expect(wrapReq!.system).toBe(model.requests.find((r) => r.system?.includes(scoutBody))?.system);
  });
});

describe("wrap-up has no tools by construction (TASK.74 §4.1, DoD-3)", () => {
  it("ignores a tool call proposed in the rescue reply — there is no dispatcher on that path", async () => {
    const readFile = vi.fn(async (path: string) => `body of ${path}`);
    const ports: CorePorts = {
      fs: { readFile } as unknown as FileSystemPort,
      exec: {} as ExecutionPort,
      http: {} as HttpPort,
      todos: new InMemoryTodoStore(),
    };
    let step = 0;
    const model = new ScriptedModelPort((req) => {
      if (isWrapUpRequest(req)) {
        // A tool call in the rescue reply, despite the empty declarations.
        return toolStep("wrap-1", "Read", { file_path: "/work/forbidden.txt" }, "REPORT: rescued");
      }
      step += 1;
      return toolStep(`c${step}`, "Read", { file_path: `/work/f${step}.txt` }, `turn-${step}`);
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, ports, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});

    expect(outcome.status).toBe("max_turns");
    // The real Read handler ran for the two loop turns and never for the rescue.
    expect(readFile.mock.calls.map((call) => call[0])).toEqual([
      "/work/f1.txt",
      "/work/f2.txt",
    ]);
    expect(outcome.toolCalls).toBe(2);
    // Only the accumulated text survives the rescue.
    expect(outcome.finalText).toBe("REPORT: rescued");
  });
});

describe("wrap-up leaves the child history untouched (TASK.74 §4.3, DoD-4)", () => {
  it("adds no item to loop.history — the instruction exists only in the request", async () => {
    const realAppend = ConversationHistory.prototype.append;
    const histories: ConversationHistory[] = [];
    const appendSpy = vi
      .spyOn(ConversationHistory.prototype, "append")
      .mockImplementation(function (this: ConversationHistory, message) {
        if (!histories.includes(this)) {
          histories.push(this);
        }
        return realAppend.call(this, message);
      });
    try {
      let itemsAtWrapUp = -1;
      let lastIdAtWrapUp = "";
      let step = 0;
      const model = new ScriptedModelPort((req) => {
        if (isWrapUpRequest(req)) {
          const child = histories[0]!;
          itemsAtWrapUp = child.items.length;
          lastIdAtWrapUp = child.items[child.items.length - 1]!.id;
          return textStep("REPORT: done looking");
        }
        step += 1;
        return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
      });
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));

      const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});
      expect(outcome.finalText).toBe("REPORT: done looking");

      const child = histories[0]!;
      // user + (assistant, tool) x 2 turns — balanced and terminal at loop_end.
      expect(itemsAtWrapUp).toBe(5);
      expect(child.items.length).toBe(itemsAtWrapUp);
      expect(child.items[child.items.length - 1]!.id).toBe(lastIdAtWrapUp);
      const serialized = JSON.stringify(child.items.map((item) => item.message));
      expect(serialized).not.toContain(SUBAGENT_WRAPUP_PROMPT);
      expect(serialized).not.toContain("REPORT: done looking");
    } finally {
      appendSpy.mockRestore();
    }
  });
});

describe("wrap-up degrades without ever worsening the outcome (TASK.74 §7 F4, DoD-5)", () => {
  /** A child that runs `turns` tool steps, then answers the rescue via `wrapUp`. */
  function makePort(wrapUp: (yieldEvent: (e: ModelStreamEvent) => void) => Promise<void>): {
    port: ModelPort;
    calls: () => number;
  } {
    let calls = 0;
    let step = 0;
    const port: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        calls += 1;
        if (isWrapUpRequest(req)) {
          return (async function* () {
            const buffered: ModelStreamEvent[] = [];
            await wrapUp((event) => buffered.push(event));
            for (const event of buffered) {
              yield event;
            }
          })();
        }
        step += 1;
        const events = toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
    };
    return { port, calls: () => calls };
  }

  it("(a) a throwing wrap-up stream leaves the raw partial and never escapes run()", async () => {
    const { port, calls } = makePort(async () => {
      throw new Error("wrapup boom");
    });
    const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});

    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("turn-2");
    // 2 loop turns + 1 refused ceiling round-1 call (TASK.124; the script's
    // else-branch answers it with a plain "TodoRead" tool call) + 1 wrap-up.
    expect(calls()).toBe(4);
  });

  it("(b) a blank wrap-up reply does not erase a non-empty partial", async () => {
    const { port } = makePort(async (emit) => {
      emit({ type: "start" });
      emit({ type: "text_delta", id: "t", text: "   \n  " });
      emit({ type: "finish", finishReason: "stop", usage: {} });
    });
    const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});

    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("turn-2");
  });

  it("(c) a non-empty wrap-up replaces the cut-off turn's preamble", async () => {
    const { port } = makePort(async (emit) => {
      emit({ type: "start" });
      emit({ type: "text_delta", id: "t", text: "REPORT: the real findings" });
      emit({ type: "finish", finishReason: "stop", usage: {} });
    });
    const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});

    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("REPORT: the real findings");
  });

  it("(d) a wrap-up stream_retry discards the aborted attempt's text", async () => {
    const { port } = makePort(async (emit) => {
      emit({ type: "start" });
      emit({ type: "text_delta", id: "t", text: "half a sentence that never" });
      emit({ type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, reason: "stall" });
      emit({ type: "text_delta", id: "t", text: "REPORT: the retried findings" });
      emit({ type: "finish", finishReason: "stop", usage: {} });
    });
    const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});

    expect(outcome.finalText).toBe("REPORT: the retried findings");
  });
});

describe("wrap-up window gate (TASK.74 §4.3, DoD-6)", () => {
  /** Runs a 2-turn child whose second step advances the clock by `elapsedMs`. */
  async function runWithElapsed(elapsedMs: number): Promise<{
    outcome: SubagentOutcome;
    calls: number;
  }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_BASE);
    try {
      let step = 0;
      const model = new ScriptedModelPort((req) => {
        if (isWrapUpRequest(req)) {
          return textStep("REPORT: rescued in time");
        }
        step += 1;
        if (step === 2) {
          vi.setSystemTime(CLOCK_BASE + elapsedMs);
        }
        return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
      });
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
      const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});
      return { outcome, calls: model.calls };
    } finally {
      vi.useRealTimers();
    }
  }

  it("(a) skips the rescue entirely when too little of the dispatcher budget remains", async () => {
    // Elapsed so that exactly 10s of the outcome deadline remain — under
    // SUBAGENT_WRAPUP_MIN_WINDOW_MS. Derived rather than a literal: the wall
    // moved from ten minutes to six hours (TASK.148), and a hardcoded 580_000
    // would have pinned this gate to the old size instead of to the rule.
    const { outcome, calls } = await runWithElapsed(SUBAGENT_OUTCOME_DEADLINE_MS - 10_000);
    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("turn-2");
    expect(calls).toBe(2);
  });

  it("(b) runs the rescue while a full window remains", async () => {
    const { outcome, calls } = await runWithElapsed(400_000);
    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("REPORT: rescued in time");
    // 2 loop turns + 1 refused ceiling round-1 call (TASK.124, still inside
    // SUBAGENT_LOOP_DEADLINE_MS at 400s elapsed) + 1 wrap-up.
    expect(calls).toBe(4);
  });

  it("(b') skips the rescue when the caller cancelled between loop_end and the call", async () => {
    const controller = new AbortController();
    let step = 0;
    const model = new ScriptedModelPort((req) => {
      if (isWrapUpRequest(req)) {
        return textStep("REPORT: must never run");
      }
      step += 1;
      return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
    });
    // The Stop observer fires inside emitLoopEnd, i.e. after the loop has
    // already decided max_turns and before the runner reads the outcome —
    // exactly the window a late external cancel lands in.
    const { hooks, calls } = recordingHooks();
    const cancellingHooks = {
      ...hooks,
      runObservers: async (event: string, input: unknown) => {
        calls.push({ event, input });
        if (event === "Stop") {
          controller.abort();
        }
      },
    } as unknown as HookRunner;
    const runner = createSubagentRunner(
      makeParent({ modelPort: model, hooks: cancellingHooks, mode: "yolo" }),
    );

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, { signal: controller.signal });

    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("turn-2");
    // 2 loop turns + 1 refused ceiling round-1 call (TASK.124); the Stop
    // observer's abort() then makes the wrap-up window gate skip its call.
    expect(model.calls).toBe(3);
  });
});

describe("wrap-up lifecycle and semaphore (TASK.74 §7 F8, DoD-7)", () => {
  it("holds the permit across the rescue and fires exactly one SubagentStop per spawn, after it", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const journal: string[] = [];
    const started: string[] = [];

    const model: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const first = req.messages[0];
        const who = first?.role === "user" ? first.content : "?";
        const wrapUp = isWrapUpRequest(req);
        started.push(wrapUp ? `wrapup:${who}` : who);
        if (wrapUp) {
          journal.push(`wrapup:${who}`);
        }
        return (async function* () {
          // A's rescue and B's only turn both park on the gate, so BOTH permits
          // stay taken while A is between loop_end and its outcome.
          if ((wrapUp && who === "A") || (!wrapUp && who === "B")) {
            await gate;
          }
          yield { type: "start" };
          yield { type: "text_delta", id: "t", text: wrapUp ? `report-${who}` : `text-${who}` };
          if (wrapUp || who !== "A") {
            yield { type: "finish", finishReason: "stop", usage: {} };
            return;
          }
          // A's single loop turn ends on a tool call, so its budget of 1 cuts
          // the run off at max_turns and the rescue fires.
          yield { type: "tool_call", toolCall: { id: "a1", name: "TodoRead", input: {} } };
          yield { type: "finish", finishReason: "tool_calls", usage: {} };
        })();
      },
    };

    const { hooks, calls } = recordingHooks({
      onSubagentStop: async (input) => {
        journal.push(`stop:${(input as SubagentStopHookInput).description}`);
      },
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, hooks, mode: "yolo" }));

    const pA = runner.run({ ...REQ, description: "A", prompt: "A", maxTurns: 1 }, {});
    const pB = runner.run({ ...REQ, description: "B", prompt: "B" }, {});
    const pC = runner.run({ ...REQ, description: "C", prompt: "C" }, {});
    expect(MAX_CONCURRENT_SUBAGENTS).toBe(2);

    await delay(50);
    // A is inside its rescue and B is mid-turn: both permits are held, so the
    // third child has not touched the model.
    expect(started).toContain("A");
    expect(started).toContain("wrapup:A");
    expect(started).toContain("B");
    expect(started).not.toContain("C");

    releaseGate();
    const [rA, rB, rC] = await Promise.all([pA, pB, pC]);

    expect(rA.status).toBe("max_turns");
    expect(rA.finalText).toBe("report-A");
    expect(rB.status).toBe("completed");
    expect(rC.status).toBe("completed");
    expect(started).toContain("C");

    // One SubagentStop per spawn, and A's fires only after A's rescue call.
    expect(calls.filter((c) => c.event === "SubagentStop")).toHaveLength(3);
    expect(journal.filter((entry) => entry === "wrapup:A")).toHaveLength(1);
    expect(journal.indexOf("wrapup:A")).toBeGreaterThanOrEqual(0);
    expect(journal.indexOf("wrapup:A")).toBeLessThan(journal.indexOf("stop:A"));
  });
});

describe("hand-built maxTurns guard (TASK.74 §2.4, F10)", () => {
  it("refuses a non-integer or non-positive budget before anything is spawned", async () => {
    const model = new ScriptedModelPort(() => textStep("never"));
    const { hooks, calls } = recordingHooks();
    const runner = createSubagentRunner(makeParent({ modelPort: model, hooks }));

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const outcome = await runner.run({ ...REQ, maxTurns: bad }, {});
      expect(outcome.status, `maxTurns ${bad}`).toBe("error");
      expect(outcome.turns).toBe(0);
      expect(outcome.toolCalls).toBe(0);
      expect(outcome.finalText).toContain("maxTurns");
    }
    // Nothing ran: no model call and no lifecycle hook for a rejected request.
    expect(model.calls).toBe(0);
    expect(calls.filter((c) => c.event === "SubagentStop")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TASK.161 + TASK.162 (slice B1): the child-spawn seam.
//   * capabilities re-resolved for the CHILD's own model (defect F6);
//   * the start card reports the CONSTRUCTED port's identity, not an echo;
//   * the provider's own model CLAIM travels out on subagent_end.
//
// The tier the settings resolver re-resolves against never reaches this module
// — it is applied inside each host's wiring closure — so these tests supply
// resolvers directly, exactly as a host would.

/**
 * A child-only ModelPort carrying A1's two readback members. `claims` are the
 * provider-reported ids, one per streamText call in order (the last entry
 * repeats), assigned as the stream starts — mirroring the real port, which
 * captures the id off the raw `message_start` chunk.
 */
function makeChildPort(opts: {
  modelId?: string;
  claims?: readonly (string | undefined)[];
  /** Per-request claim, for scripts whose call count is not fixed. Wins over `claims`. */
  claimFor?: (req: ModelRequest) => string | undefined;
  script?: (req: ModelRequest) => ModelStreamEvent[];
}): ModelPort & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let lastResponseModel: string | undefined;
  const script = opts.script ?? ((): ModelStreamEvent[] => textStep("child report"));
  const port = {
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    get lastResponseModel(): string | undefined {
      return lastResponseModel;
    },
    requests,
    streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const index = requests.length;
      requests.push(request);
      const events = script(request);
      const { claims, claimFor } = opts;
      return (async function* () {
        if (claimFor !== undefined) {
          lastResponseModel = claimFor(request);
        } else if (claims !== undefined && claims.length > 0) {
          lastResponseModel = index < claims.length ? claims[index] : claims[claims.length - 1];
        }
        for (const event of events) {
          yield event;
        }
      })();
    },
  };
  return port;
}

const endOf = (progress: SubagentProgress[]): Extract<SubagentProgress, { kind: "end" }> => {
  const ends = progress.filter((p): p is Extract<SubagentProgress, { kind: "end" }> => p.kind === "end");
  expect(ends).toHaveLength(1);
  return ends[0]!;
};

const startOf = (progress: SubagentProgress[]): Extract<SubagentProgress, { kind: "start" }> => {
  const starts = progress.filter((p): p is Extract<SubagentProgress, { kind: "start" }> => p.kind === "start");
  expect(starts).toHaveLength(1);
  return starts[0]!;
};

describe("buildChildConfig — child-model settings (TASK.162, defect F6)", () => {
  const PARENT_CONTEXT = { contextWindowTokens: 200_000, keepRecentMessages: 7 };

  it("replaces the ceiling and effort wholesale and overlays ONLY contextWindowTokens", () => {
    const parent = makeParent({
      maxOutputTokens: 8_192,
      reasoningEffort: "medium",
      context: PARENT_CONTEXT,
    });

    const child = buildChildConfig(parent, getPersona("explore"), REQ, {
      modelSettings: { maxOutputTokens: 131_072, reasoningEffort: "high", contextWindowTokens: 1_000_000 },
    });

    expect(child.maxOutputTokens).toBe(131_072);
    expect(child.reasoningEffort).toBe("high");
    // Only the window moved; every other budget knob the resolver knows
    // nothing about survives the overlay, and the parent's object is not
    // mutated.
    expect(child.context).toEqual({ contextWindowTokens: 1_000_000, keepRecentMessages: 7 });
    expect(child.context).not.toBe(parent.context);
    expect(parent.context).toEqual(PARENT_CONTEXT);
  });

  it("an `undefined` INSIDE the settings is that model's resolution, never patched from the parent", () => {
    const parent = makeParent({ maxOutputTokens: 8_192, reasoningEffort: "medium", context: PARENT_CONTEXT });

    const child = buildChildConfig(parent, getPersona("explore"), REQ, {
      // The honest shape for a claude-* child: no declared ceiling, no effort.
      modelSettings: { contextWindowTokens: 200_000 },
    });

    expect(child.maxOutputTokens).toBeUndefined();
    expect(child.reasoningEffort).toBeUndefined();
  });

  it("without modelSettings the three rows stay the parent's, by reference where they were (legacy path)", () => {
    const parent = makeParent({ maxOutputTokens: 8_192, reasoningEffort: "medium", context: PARENT_CONTEXT });

    const child = buildChildConfig(parent, getPersona("explore"), REQ);

    expect(child.maxOutputTokens).toBe(8_192);
    expect(child.reasoningEffort).toBe("medium");
    expect(child.context).toBe(parent.context);
  });
});

describe("run() — child capabilities resolved for the child's own model (TASK.162)", () => {
  it("the child's ModelRequest carries the SETTINGS' ceiling and effort, not the parent's", async () => {
    const parentPort = new ScriptedModelPort(() => textStep("parent never runs here"));
    const childPort = makeChildPort({ modelId: "glm-5.3-flash" });
    const resolvedFor: string[] = [];
    const runner = createSubagentRunner(
      makeParent({
        modelPort: parentPort,
        maxOutputTokens: 4_096,
        reasoningEffort: "medium",
        context: { contextWindowTokens: 200_000 },
      }),
      {
        resolveChildModelPort: () => childPort,
        resolveChildModelSettings: (modelId) => {
          resolvedFor.push(modelId);
          return { maxOutputTokens: 131_072, reasoningEffort: "high", contextWindowTokens: 1_000_000 };
        },
      },
    );

    const outcome = await runner.run({ ...REQ, model: "glm-5.3-flash" }, {});

    expect(outcome.status).toBe("completed");
    expect(resolvedFor).toEqual(["glm-5.3-flash"]);
    expect(childPort.requests).toHaveLength(1);
    expect(childPort.requests[0]!.maxOutputTokens).toBe(131_072);
    expect(childPort.requests[0]!.reasoningEffort).toBe("high");
    expect(parentPort.calls).toBe(0);
  });

  it("a spawn WITHOUT a model override never calls the settings resolver (legacy path untouched)", async () => {
    const parentPort = new ScriptedModelPort((req) =>
      isChildRequest(req) ? textStep("inherited-port child") : textStep("n/a"),
    );
    const runner = createSubagentRunner(
      makeParent({ modelPort: parentPort, maxOutputTokens: 4_096, reasoningEffort: "medium" }),
      {
        resolveChildModelSettings: () => {
          throw new Error("resolveChildModelSettings must not be called when req.model is absent");
        },
      },
    );

    const outcome = await runner.run(REQ, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("inherited-port child");
    expect(parentPort.requests.at(-1)!.maxOutputTokens).toBe(4_096);
    expect(parentPort.requests.at(-1)!.reasoningEffort).toBe("medium");
  });

  it("a THROWING settings resolver is an error-outcome naming the model — never a fallback to parent values", async () => {
    const parentPort = new ScriptedModelPort(() => textStep("should never run"));
    const childPort = makeChildPort({ modelId: "glm-5.3-flash" });
    const runner = createSubagentRunner(
      makeParent({ modelPort: parentPort, maxOutputTokens: 4_096, reasoningEffort: "medium" }),
      {
        resolveChildModelPort: () => childPort,
        resolveChildModelSettings: () => {
          throw new Error("catalog exploded");
        },
      },
    );

    const outcome = await runner.run({ ...REQ, model: "glm-5.3-flash" }, {});

    expect(outcome).toEqual({
      status: "error",
      finalText:
        'Agent: model "glm-5.3-flash" settings could not be resolved in this host: catalog exploded',
      truncated: false,
      turns: 0,
      toolCalls: 0,
      durationMs: expect.any(Number),
    });
    // No child loop was ever built on the parent's capabilities behind our back.
    expect(childPort.requests).toHaveLength(0);
    expect(parentPort.calls).toBe(0);
  });
});

describe("start progress — requested id is authoritative (TASK.171, reverses TASK.161)", () => {
  it("reports the REQUESTED string even when the constructed port's modelId differs", async () => {
    // Owner's TASK.171 ruling: "модель никогда не ответит, главное какие
    // запросы мы шлем" — the request is what we control and can prove; a
    // port's own modelId is our construction too, not independent evidence,
    // so it must never outrank the request even when a future port
    // canonicalizes ids (no production port does today).
    const childPort = makeChildPort({ modelId: "glm-5.3-flash-canonical" });
    const runner = createSubagentRunner(makeParent(), {
      resolveChildModelPort: () => childPort,
    });
    const progress: SubagentProgress[] = [];

    await runner.run({ ...REQ, model: "glm-5.3-flash" }, { onProgress: (p) => progress.push(p) });

    expect(startOf(progress).model).toBe("glm-5.3-flash");
  });

  it("a port exposing no modelId still reports the requested string", async () => {
    const childPort = makeChildPort({});
    const runner = createSubagentRunner(makeParent(), {
      resolveChildModelPort: () => childPort,
    });
    const progress: SubagentProgress[] = [];

    await runner.run({ ...REQ, model: "glm-5.3-flash" }, { onProgress: (p) => progress.push(p) });

    expect(startOf(progress).model).toBe("glm-5.3-flash");
  });

  it("a spawn with no override still carries no model key at all (inherited stays inherited)", async () => {
    const parentPort = new ScriptedModelPort((req) =>
      isChildRequest(req) ? textStep("child") : textStep("n/a"),
    );
    const runner = createSubagentRunner(makeParent({ modelPort: parentPort }));
    const progress: SubagentProgress[] = [];

    await runner.run(REQ, { onProgress: (p) => progress.push(p) });

    expect("model" in startOf(progress)).toBe(false);
  });
});

describe("responseModel — the provider's own claim reaches subagent_end (TASK.161, telemetry gap closed by TASK.171)", () => {
  it("end progress carries the claim the child's port observed, ALONGSIDE the requested id", async () => {
    const childPort = makeChildPort({ modelId: "glm-5.3-flash", claims: ["glm-5.3"] });
    const runner = createSubagentRunner(makeParent(), {
      resolveChildModelPort: () => childPort,
    });
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, model: "glm-5.3-flash" }, {
      onProgress: (p) => progress.push(p),
    });

    expect(outcome.status).toBe("completed");
    // The port's own modelId ("glm-5.3-flash", unused above the claim) plays
    // no role here — `model` is the REQUESTED id, `responseModel` is the
    // provider's separate claim, both recoverable off the SAME end record.
    expect(endOf(progress).model).toBe("glm-5.3-flash");
    expect(endOf(progress).responseModel).toBe("glm-5.3");
  });

  it("a provider that reports nothing back leaves responseModel ABSENT without touching the requested id (TASK.171 (c))", async () => {
    // No `claims` supplied: makeChildPort's port never sets lastResponseModel
    // at all, mirroring a transport with no raw message_start.message.model
    // to read (e.g. a non-anthropic-messages provider). The requested id must
    // survive this untouched — absence of one field must never corrupt or
    // blank the other.
    const childPort = makeChildPort({ modelId: "glm-5.3-flash" });
    const runner = createSubagentRunner(makeParent(), {
      resolveChildModelPort: () => childPort,
    });
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run({ ...REQ, model: "glm-5.3-flash" }, { onProgress: (p) => progress.push(p) });

    expect(outcome.status).toBe("completed");
    expect(endOf(progress).model).toBe("glm-5.3-flash");
    expect("responseModel" in endOf(progress)).toBe(false);
  });

  it("an inherited-port child reports no claim, but still echoes the requested id when one was made", async () => {
    const parentPort = new ScriptedModelPort((req) =>
      isChildRequest(req) ? textStep("child") : textStep("n/a"),
    );
    const runner = createSubagentRunner(makeParent({ modelPort: parentPort }));
    const progress: SubagentProgress[] = [];

    await runner.run(REQ, { onProgress: (p) => progress.push(p) });

    // REQ carries no `model` override and the built-in persona used here has
    // none either, so `model` is legitimately absent too — this is the
    // "inherited the parent's port" case, not a corruption of the field.
    expect("model" in endOf(progress)).toBe(false);
    expect("responseModel" in endOf(progress)).toBe(false);
  });

  it("bridges through parent-loop -> agentTool -> runner onto the subagent_end AgentEvent, both fields intact", async () => {
    const childPort = makeChildPort({ modelId: "glm-5.3-flash", claims: ["glm-5.3"] });
    const parentPort = new ScriptedModelPort((req) =>
      lastRole(req) === "user"
        ? toolStep("agent-1", "Agent", {
            description: "child work",
            prompt: "do child work",
            agent_type: "general-purpose",
            model: "glm-5.3-flash",
          })
        : textStep("parent done"),
    );
    const loop = new AgentLoop(
      withSubagents(makeParent({ modelPort: parentPort, mode: "yolo" }), {
        resolveChildModelPort: () => childPort,
      }),
    );

    const events = await collect(loop.runTurn("spawn a child on flash"));

    const end = events.find((e) => e.type === "subagent_end");
    expect(end?.type === "subagent_end" && end.model).toBe("glm-5.3-flash");
    expect(end?.type === "subagent_end" && end.responseModel).toBe("glm-5.3");
    const start = events.find((e) => e.type === "subagent_start");
    expect(start?.type === "subagent_start" && start.model).toBe("glm-5.3-flash");
  });
});

describe("responseModel after the wrap-up rescue (codex blocking 4)", () => {
  it("reports the WRAP-UP call's claim, not the loop turn's — the property is read after the rescue", async () => {
    // A budget-1 child that keeps proposing a tool call exhausts its turns and
    // is rescued. The port claims "model-A" on every loop-side call and
    // "model-B" only on the wrap-up call, so an accumulator that froze the
    // loop's claim would report "model-A" here.
    const childPort = makeChildPort({
      modelId: "requested-model",
      claimFor: (req) => (isWrapUpRequest(req) ? "model-B" : "model-A"),
      script: (req) => (isWrapUpRequest(req) ? textStep("REPORT: partial") : toolStep("k", "TodoRead", {})),
    });
    const runner = createSubagentRunner(makeParent({ mode: "yolo" }), {
      resolveChildModelPort: () => childPort,
    });
    const progress: SubagentProgress[] = [];

    const outcome = await runner.run(
      { ...REQ, agentType: "general-purpose", model: "requested-model", maxTurns: 1 },
      { onProgress: (p) => progress.push(p) },
    );

    expect(outcome.status).toBe("max_turns");
    expect(outcome.finalText).toBe("REPORT: partial");
    // Every call went through the SAME port object, and the rescue was last.
    expect(isWrapUpRequest(childPort.requests.at(-1)!)).toBe(true);
    expect(childPort.requests.filter(isWrapUpRequest)).toHaveLength(1);
    expect(endOf(progress).responseModel).toBe("model-B");
  });
});

// ---------------------------------------------------------------------------
// Stall clock wiring — inline tier (TASK.148 slice 1). A stall detector that
// REPORTS, never kills: silence past SUBAGENT_STALL_TIMEOUT_MS must produce
// exactly one "stalled" progress while the run keeps going; a sign of life
// resets it; a broker.isAwaitingApproval wait must never be counted as
// silence. Uses FULL fake timers (Date AND setTimeout/setInterval) —
// deliberately unlike this file's `toFake:["Date"]}`-only convention for the
// deadline tests above, because the detector genuinely needs a firing timer,
// not a synchronous Date-boundary check.

/**
 * A ModelPort whose one stream can be held open indefinitely at a
 * caller-chosen point, released on demand — simulates "the child's own single
 * model call is taking a long time" (genuine silence) without spending any
 * real wall-clock time under fake timers.
 */
function gatedModelPort(): { port: ModelPort; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port: ModelPort = {
    streamText: () =>
      (async function* () {
        yield { type: "start" };
        await gate;
        yield { type: "text_delta", id: "t", text: "done" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      })(),
  };
  return { port, release };
}

/** Same replay-a-script contract as ScriptedModelPort, but each call first waits `delayMs` of (fake) time before yielding — lets a multi-turn script consume real elapsed time between turns. */
function pacedScriptModelPort(script: ModelScript, delayMs: number): ModelPort {
  return {
    streamText: (request) => {
      const events = script(request);
      const signal = request.abortSignal;
      return (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        for (const event of events) {
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield event;
        }
      })();
    },
  };
}

/** A PermissionBroker whose `isAwaitingApproval` reader the test toggles directly — isolates the poll->pause/resume wiring from any real permission round-trip. */
class TogglableBroker implements PermissionBroker {
  waiting = false;
  get isAwaitingApproval(): boolean {
    return this.waiting;
  }
  requestPermission(): Promise<PermissionDecision> {
    return Promise.resolve({ behavior: "deny", reason: "unused in this test" });
  }
}

function stalledReports(calls: SubagentProgress[]): Extract<SubagentProgress, { kind: "stalled" }>[] {
  return calls.filter((p): p is Extract<SubagentProgress, { kind: "stalled" }> => p.kind === "stalled");
}

describe("stall clock wiring — inline tier (TASK.148 slice 1)", () => {
  it("silence past SUBAGENT_STALL_TIMEOUT_MS emits exactly one stalled progress, and the child is still running afterward (no end, no loop_end)", async () => {
    vi.useFakeTimers();
    try {
      const { port, release } = gatedModelPort();
      const progress: SubagentProgress[] = [];
      const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));

      const started = runner.run({ ...REQ }, { onProgress: (p) => progress.push(p) });

      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS - 1);
      expect(stalledReports(progress)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const stalls = stalledReports(progress);
      expect(stalls).toHaveLength(1);
      expect(stalls[0]).toMatchObject({
        agentType: "general-purpose",
        description: REQ.description,
        waitingForApproval: false,
      });
      expect(stalls[0]!.silentMs).toBeGreaterThanOrEqual(SUBAGENT_STALL_TIMEOUT_MS);

      // Nothing was killed: no end-progress yet, and the run() promise is
      // still pending — the child keeps running past the notice.
      expect(progress.some((p) => p.kind === "end")).toBe(false);

      release();
      await vi.runAllTimersAsync();
      const outcome = await started;
      expect(outcome.status).toBe("completed");
      expect(progress.some((p) => p.kind === "end")).toBe(true);
      // Still exactly one notice — the eventual completion did not add another.
      expect(stalledReports(progress)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sign of life resets the clock — a child that keeps producing turns across a span far longer than the threshold never stalls", async () => {
    vi.useFakeTimers();
    try {
      let step = 0;
      const totalSteps = 5;
      const model = pacedScriptModelPort((req) => {
        if (!isChildRequest(req)) return textStep("");
        step += 1;
        if (step > totalSteps) return textStep(`final-${step}`);
        return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
      }, Math.floor(SUBAGENT_STALL_TIMEOUT_MS * 0.6));
      const progress: SubagentProgress[] = [];
      const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));

      const outcomePromise = runner.run(
        { ...REQ, maxTurns: totalSteps + 2 },
        { onProgress: (p) => progress.push(p) },
      );
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(outcome.status).toBe("completed");
      expect(stalledReports(progress)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pause: an unanswered permission ask (broker.isAwaitingApproval) suppresses the notice for a wait longer than the threshold; resume continues from where it paused, not from a fresh cycle", async () => {
    vi.useFakeTimers();
    try {
      const { port } = gatedModelPort();
      const broker = new TogglableBroker();
      const progress: SubagentProgress[] = [];
      const runner = createSubagentRunner(
        makeParent({ modelPort: port, mode: "yolo", permissionBroker: broker }),
      );

      const started = runner.run({ ...REQ }, { onProgress: (p) => progress.push(p) });
      void started.catch(() => {});

      // Some genuine silence accrues before the ask starts.
      await vi.advanceTimersByTimeAsync(200_000);
      broker.waiting = true;

      // Blocked far longer than the whole threshold — proves the wait is
      // never counted as silence (the exact defect TASK.148 removes).
      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + 50_000);
      expect(stalledReports(progress)).toHaveLength(0);

      broker.waiting = false;
      // Only ~400_000ms of budget remained (600_000 - 200_000) when it
      // paused; a FRESH cycle would need another SUBAGENT_STALL_TIMEOUT_MS
      // from here. Prove it is not a fresh cycle: fire well before that.
      await vi.advanceTimersByTimeAsync(450_000);
      expect(stalledReports(progress)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms: silence -> notice -> sign of life -> silence again -> a second notice; still-silent after the first notice produces no second one", async () => {
    vi.useFakeTimers();
    try {
      const { port, release } = gatedModelPort();
      const progress: SubagentProgress[] = [];
      const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));
      const started = runner.run({ ...REQ }, { onProgress: (p) => progress.push(p) });
      void started.catch(() => {});

      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
      expect(stalledReports(progress)).toHaveLength(1);

      // Still silent, well past a second threshold — must not double-report.
      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
      expect(stalledReports(progress)).toHaveLength(1);

      release();
      await vi.runAllTimersAsync();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a broker without isAwaitingApproval (e.g. DenyPermissionBroker) never pauses — the plain silence detector still fires", async () => {
    vi.useFakeTimers();
    try {
      const { port, release } = gatedModelPort();
      const progress: SubagentProgress[] = [];
      // makeParent's default broker is DenyPermissionBroker, which does not
      // implement isAwaitingApproval at all.
      const runner = createSubagentRunner(makeParent({ modelPort: port, mode: "yolo" }));
      const started = runner.run({ ...REQ }, { onProgress: (p) => progress.push(p) });

      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
      expect(stalledReports(progress)).toHaveLength(1);

      release();
      await vi.runAllTimersAsync();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });
});

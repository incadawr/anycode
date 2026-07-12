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
import { MAX_CONCURRENT_SUBAGENTS, SUBAGENT_ACTIVITY_MAX_EVENTS } from "../types/config.js";
import type { SubagentProgress } from "../ports/subagent.js";
import type { ToolContext } from "../types/tools.js";
import { SPAWN_TOOLS, buildChildConfig, createSubagentRunner, withSubagents } from "./runner.js";
import { PERSONAS, getPersona, type PersonaDefinition } from "./personas.js";
import { discoverAgentProfiles, type AgentProfileRoot } from "./profiles.js";

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

  it("caps maxTurns at DEFAULT_SUBAGENT_MAX_TURNS (min of request and 8)", () => {
    const parent = makeParent();
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 100 }).maxTurns).toBe(8);
    expect(buildChildConfig(parent, getPersona("explore"), { ...REQ, maxTurns: 3 }).maxTurns).toBe(3);
    expect(buildChildConfig(parent, getPersona("explore"), REQ).maxTurns).toBe(8);
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

  it("maps a max_turns cutoff to status max_turns with the last completed turn's text", async () => {
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return toolStep(`c${step}`, "TodoRead", {}, `turn-${step}`);
    });
    const runner = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));

    const outcome = await runner.run({ ...REQ, maxTurns: 2 }, {});
    expect(outcome.status).toBe("max_turns");
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(2);
    expect(outcome.finalText).toBe("turn-2");
    // Two model calls (turns 1+2); the cutoff turn never calls the model.
    expect(model.calls).toBe(2);
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
  opts: { body: string; tools?: readonly string[] },
): Promise<PersonaDefinition> {
  const lines = [`name: ${name}`, "description: test profile"];
  if (opts.tools) lines.push(`tools: ${opts.tools.join(", ")}`);
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

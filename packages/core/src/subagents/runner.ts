/**
 * Subagent runner (Phase 3 slice 3.1, design §3.6 + §4.1). Backs the
 * SubagentPort with in-process child AgentLoops derived from the parent config.
 *
 * Import direction is load-bearing: subagents/ imports loop/ (AgentLoop /
 * AgentLoopConfig) and tools/registry.ts (the tool-definition source) — neither
 * loop/ nor registry/agent import subagents/runner.ts, so there is no cycle. The
 * Agent tool reaches the child through SubagentPort only, never through

 *
 * The child config derivation (buildChildConfig) implements every row of the
 * §4.1 table verbatim and is exported so the derivation can be verified directly.
 * The two non-recursion locks live here structurally: the child registry never
 * contains a spawn-capable tool (lock #1, the SPAWN_TOOLS set = Agent AND, since
 * slice 3.4, Workflow — a step's child can neither spawn a subagent nor launch a
 * workflow) and the child config leaves `subagents`/`workflows` undefined (lock
 * #2, defense in depth).
 */

import { AgentLoop, type AgentLoopConfig } from "../loop/agent-loop.js";
import { ConversationHistory } from "../context/history.js";
import { HeuristicTokenizer } from "../context/tokenizer.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { ToolRegistry, createDefaultToolRegistry } from "../tools/registry.js";
import { buildSubagentSystemPrompt } from "../prompts/subagent.js";
import type { SystemPromptEnv } from "../prompts/system.js";
import type { ModelPort } from "../ports/model.js";
import { capUtf8Bytes } from "../util/bytes.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  SUBAGENT_OUTPUT_MAX_BYTES,
} from "../types/config.js";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRequest,
  SubagentRunOptions,
} from "../ports/subagent.js";
import {
  getPersona,
  isKnownPersona,
  listPersonaNames,
  type PersonaDefinition,
} from "./personas.js";
import { summarizeChildToolCall } from "./summarize-tool.js";
import { SPAWN_TOOLS } from "./spawn-tools.js";

// SPAWN_TOOLS (non-recursion lock #1) now lives in the leaf `./spawn-tools.ts`
// (P7.21 W1, design §2-D8) so the main-safe subagents-admin surface can consume
// it without importing this runner (and loop/agent-loop.ts with it). Imported
// above for internal use and re-exported here byte-compatibly for existing
// importers (subagents/index.ts, runner tests).
export { SPAWN_TOOLS };

/**
 * Extra runner inputs (slice 3.3, design §2.5). `profiles` are md-profile
 * personas already parsed/validated/capped by subagents/profiles.ts; the runner
 * exposes them as additional agent types WITHOUT letting a profile shadow a
 * built-in (built-in always wins in resolution).
 */
export interface SubagentRunnerOptions {
  /** Md-profile personas (already validated/capped by subagents/profiles.ts). */
  profiles?: readonly PersonaDefinition[];
  /**
   * Session-static environment facts (slice 3.6, design §2.4). Threaded into
   * every child's harness prelude so a subagent sees the same `<env>` block as
   * the parent. Absent => the child prelude simply omits the env section.
   */
  env?: SystemPromptEnv;
  /**
   * The parent's memory section (slice 3.6). Passed through to every child so a
   * subagent inherits the same AGENTS.md context. "" => omitted from the prelude.
   */
  memorySection?: string;
  /**
   * Resolves an Agent-tool `model` override (slice 4.6, design §2.5) to a
   * fixed ModelPort for one child spawn. Additive-optional, same shape as
   * `ExecutionPort.runBinary?`: a host that omits this cannot honor
   * `SubagentRequest.model` and `run()` returns a honest error-outcome instead
   * of silently spawning the child on the parent's model.
   */
  resolveChildModelPort?: (modelId: string) => ModelPort;
}

/**
 * Builds the child AgentLoopConfig for one spawn per the §4.1 derivation table.
 * Exported for direct verification (every row is a frozen contract) and reuse by
 * the workflow engine (3.4). `parent.mode` is read here — the snapshot at spawn
 * — and never forced to yolo; the child inherits the parent's engine/broker/mode
 * so plan-mode stays honest and every effect re-passes the same gate.
 */
export function buildChildConfig(
  parent: AgentLoopConfig,
  persona: PersonaDefinition,
  req: SubagentRequest,
  extras?: { env?: SystemPromptEnv; memorySection?: string; modelPort?: ModelPort },
): AgentLoopConfig {
  const tokenizer = parent.tokenizer ?? new HeuristicTokenizer();
  // NEW per-persona registry WITHOUT any spawn tool (structural non-recursion,
  // lock #1: SPAWN_TOOLS = Agent + Workflow are dropped). Built once so its name
  // snapshot drives the child's tool-discipline section AND is the child registry.
  const registry = buildPersonaRegistry(persona);
  return {

    // `model` override (slice 4.6, §2.5) resolves to a fixed child-only port
    // instead; the default path (no override) is byte-identical to parent.modelPort.
    modelPort: extras?.modelPort ?? parent.modelPort,
    registry,
    // User PreToolUse guards apply to children too.
    hooks: parent.hooks,
    // Fail-closed permissions inherited: same engine + broker.
    permissionEngine: parent.permissionEngine,
    permissionBroker: parent.permissionBroker,
    // Snapshot of the parent mode at spawn (plan child = read-only; never yolo).
    mode: parent.mode,
    // Fresh todos so the child cannot clobber the parent's plan; every other port
    // is inherited (same workspace fs/exec/http).
    ports: { ...parent.ports, todos: new InMemoryTodoStore() },
    cwd: parent.cwd,
    maxTurns: Math.min(req.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS, DEFAULT_SUBAGENT_MAX_TURNS),
    // Harness prelude (tool discipline over the child's OWN registry, env, memory)
    // + persona/profile body + finality note. toolNames come from the registry
    // built above (post SPAWN_TOOLS skip), so the child's prompt structurally
    // cannot advertise Agent/Workflow — a prompt-level mirror of lock #1.
    systemPrompt: buildSubagentSystemPrompt(persona, {
      toolNames: registry.list(),
      env: extras?.env,
      memorySection: extras?.memorySection,
    }),
    maxOutputTokens: parent.maxOutputTokens,
    reasoningEffort: parent.reasoningEffort,
    // NEW empty history WITHOUT a sink: children are ephemeral, never written to

    // per-item estimates stay consistent.
    history: new ConversationHistory({ tokenizer }),
    tokenizer,
    context: parent.context,
    // toolConcurrency: default (omitted).
    // subagents/workflows/tasks/lsp/media: intentionally UNSET (undefined) — lock
    // #2, defense in depth. tasks stays unset so a child never opens a background

    // fail-closed); lsp stays unset so a child's edits are never diagnosed (slice


  };
}

/**
 * Assembles a child registry from the persona's tool names, sourcing the real
 * definitions from a shared default registry. Every spawn-capable tool
 * (SPAWN_TOOLS = Agent, Workflow) is skipped defensively even though no built-in
 * persona lists one (lock #1): the child model never sees an Agent or Workflow
 * declaration, so it cannot even propose recursion. An md-profile that lists one
 * explicitly gets the same treatment (profiles.ts surfaces it as a problem).
 */
function buildPersonaRegistry(persona: PersonaDefinition): ToolRegistry {
  const source = createDefaultToolRegistry();
  const registry = new ToolRegistry();
  for (const name of persona.tools) {
    if (SPAWN_TOOLS.has(name)) {
      continue;
    }
    const tool = source.get(name);
    if (tool) {
      registry.register(tool, { silentDuplicateWarning: true });
    }
  }
  return registry;
}

/**
 * Counting semaphore with an abort-aware wait. Acquiring past the permit count
 * parks a waiter; if its signal aborts while parked it is removed from the queue
 * and the acquire rejects promptly (the 3rd concurrent child never runs).
 */
class Semaphore {
  private permits: number;
  private readonly queue: Array<{ resolve: () => void; reject: (e: unknown) => void; cleanup: () => void }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new SemaphoreAbortError();
    }
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new SemaphoreAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(waiter);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.cleanup();
      next.resolve();
    } else {
      this.permits += 1;
    }
  }
}

class SemaphoreAbortError extends Error {
  constructor() {
    super("subagent semaphore wait aborted");
    this.name = "SemaphoreAbortError";
  }
}

/**
 * Builds a SubagentPort backed by child AgentLoops derived from `parent`. One
 * runner per parent config (attached by withSubagents), so the
 * MAX_CONCURRENT_SUBAGENTS semaphore is per-parent: at most that many child
 * loops run at once atop the parent's own toolConcurrency.
 *
 * `opts.profiles` (slice 3.3, §2.5) adds md-profile personas as extra agent
 * types. Resolution inside run() is built-in-wins: an agentType that names a
 * built-in resolves to it, so a profile can never shadow general-purpose/explore
 * (discovery already drops such collisions — this is the second rubicon).
 */
export function createSubagentRunner(
  parent: AgentLoopConfig,
  opts?: SubagentRunnerOptions,
): SubagentPort {
  const semaphore = new Semaphore(MAX_CONCURRENT_SUBAGENTS);
  // Profiles keyed by name; a built-in name in the map is unreachable because
  // resolution consults isKnownPersona FIRST (built-in always wins).
  const profileMap = new Map<string, PersonaDefinition>();
  for (const profile of opts?.profiles ?? []) {
    if (!profileMap.has(profile.name)) {
      profileMap.set(profile.name, profile);
    }
  }

  return {
    listAgentTypes(): string[] {
      return [...listPersonaNames(), ...profileMap.keys()];
    },
    async run(req: SubagentRequest, runOpts: SubagentRunOptions): Promise<SubagentOutcome> {
      const startedAt = Date.now();
      const { signal, onProgress } = runOpts;

      // Resolve the persona: built-in wins, else an md-profile. The Agent tool
      // validates agent_type before calling, but the port is public (workflow
      // 3.4 calls it too) — an unknown type is an error-outcome, never a throw.
      const persona = isKnownPersona(req.agentType)
        ? getPersona(req.agentType)
        : profileMap.get(req.agentType);
      if (!persona) {
        const available = [...listPersonaNames(), ...profileMap.keys()].join(", ");
        return {
          status: "error",
          finalText: `Unknown agent_type "${req.agentType}". Available agent types: ${available}.`,
          truncated: false,
          turns: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      // Pre-aborted: never enter the semaphore or start a child.
      if (signal?.aborted) {
        return cancelledOutcome(startedAt);
      }

      // Resolve an Agent-tool model override (slice 4.6, design §2.5) BEFORE
      // the semaphore: a host that cannot honor req.model must fail without

      let childModelPort: ModelPort | undefined;
      if (req.model !== undefined) {
        const resolve = opts?.resolveChildModelPort;
        if (resolve === undefined) {
          return {
            status: "error",
            finalText: `Agent: model override "${req.model}" is not supported in this host; retry without the model field.`,
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          };
        }
        childModelPort = resolve(req.model);
      }

      // Abort-aware semaphore wait: a queued child that is cancelled returns
      // immediately without running (design §4.1 mechanics).
      try {
        await semaphore.acquire(signal);
      } catch {
        return cancelledOutcome(startedAt);
      }

      try {
        onProgress?.({ kind: "start", agentType: persona.name, description: req.description });

        const loop = new AgentLoop(
          buildChildConfig(parent, persona, req, {
            env: opts?.env,
            memorySection: opts?.memorySection,
            ...(childModelPort !== undefined ? { modelPort: childModelPort } : {}),
          }),
        );

        let currentTurnText = "";
        let finalText = "";
        let toolCalls = 0;
        let lastTool: string | undefined;
        // Per-run activity-event emission counter (slice P7.18/F16b): the feed is
        // bounded — tool-activity stops emitting past SUBAGENT_ACTIVITY_MAX_EVENTS,
        // while counters (subagent_progress) and start/end continue unaffected.
        let activityEmitted = 0;
        // Buffers a validated call's name+input from tool_execution_start until its
        // paired tool_result arrives (W1-FIX, see the tool_result case below); a
        // batch can interleave multiple starts before any result, so this is keyed
        // by toolCallId rather than a single pending slot.
        const pendingChildCalls = new Map<string, { toolName: string; input: unknown }>();
        let turnEndCount = 0;
        let loopReason: SubagentOutcome["status"] | undefined;
        let loopTurns: number | undefined;

        try {
          // The signal is already linked by the parent dispatcher to the turn
          // signal, so threading it here completes the parent->child->grandchild
          // SIGTERM/SIGKILL cascade through the existing chain — no new kill path.
          for await (const event of loop.runTurn(req.prompt, { signal })) {
            switch (event.type) {
              case "turn_start":
                currentTurnText = "";
                break;
              case "text_delta":
                currentTurnText += event.text;
                break;
              case "stream_retry":
                // The step is replayed from scratch; discard the aborted attempt's text.
                currentTurnText = "";
                break;
              case "tool_execution_start":
                // Dispatch-time start (name + raw input), keyed by toolCallId until
                // the paired tool_result arrives below (W1-FIX). This event only
                // fires for calls that survived to dispatch — a stream_retry replays
                // the WHOLE step from scratch (agent-loop.ts clears toolCalls on
                // "stream_retry" before dispatch is ever reached), so a discarded
                // attempt's proposals never produce a tool_execution_start here.
                pendingChildCalls.set(event.toolCallId, {
                  toolName: event.toolName,
                  input: event.input,
                });
                break;
              case "tool_result": {
                toolCalls += 1;
                lastTool = event.outcome.toolName;
                onProgress?.({ kind: "progress", turns: turnEndCount, toolCalls, lastTool });
                // Activity emission rides the SAME stable boundary as the toolCalls
                // counter directly above (design §4 W1-FIX, was the "tool_call"
                // proposal event pre-fix — retry-unsafe, see runner.test.ts for the
                // regression this closes). tool_result is the execution/result
                // boundary: it is guaranteed 1:1 with a prior tool_execution_start
                // (dispatch/scheduler.ts's runToolBatches contract) and never fires
                // for a proposal a stream_retry discarded before dispatch. Calls
                // that never actually ran (invalid_input — an SDK-level parse
                // failure OR a dispatcher zod-validation failure) are skipped,
                // generalizing the pre-fix "invalid proposals are skipped" intent to
                // the real fail point. The summary is pre-sanitized/capped and never
                // carries raw child input verbatim.
                const pending = pendingChildCalls.get(event.outcome.toolCallId);
                pendingChildCalls.delete(event.outcome.toolCallId);
                if (
                  pending &&
                  event.outcome.status !== "invalid_input" &&
                  activityEmitted < SUBAGENT_ACTIVITY_MAX_EVENTS
                ) {
                  activityEmitted += 1;
                  onProgress?.({
                    kind: "tool",
                    toolName: pending.toolName,
                    summary: summarizeChildToolCall(pending.toolName, pending.input),
                  });
                }
                break;
              }
              case "turn_end":
                // Capture the just-completed turn's text; a later cutoff turn_start
                // (max_turns) or an error before turn_end cannot overwrite it.
                finalText = currentTurnText;
                turnEndCount += 1;
                onProgress?.({ kind: "progress", turns: turnEndCount, toolCalls, lastTool });
                break;
              case "loop_end":
                // Child configs never receive WorktreeControlPort. Treat an
                // impossible terminal relocation defensively as an error rather
                // than widening the public SubagentOutcome status contract.
                loopReason = event.reason === "workspace_transition" ? "error" : event.reason;
                loopTurns = event.turns;
                break;
              default:
                break;
            }
          }
        } catch {
          // A throw with no loop_end (e.g. the stream iterator rejected) is an error.
          loopReason = loopReason ?? "error";
        }

        // status maps 1:1 from loop_end.reason (same union); no loop_end => error.
        const status: SubagentOutcome["status"] = loopReason ?? "error";
        const turns = loopTurns ?? turnEndCount;
        const capped = capUtf8Bytes(finalText, SUBAGENT_OUTPUT_MAX_BYTES);
        const outcome: SubagentOutcome = {
          status,
          finalText: capped.text,
          truncated: capped.truncated,
          turns,
          toolCalls,
          durationMs: Date.now() - startedAt,
        };

        onProgress?.({ kind: "end", status, turns, durationMs: outcome.durationMs });

        // Fire SubagentStop observers INSIDE the permit (semaphore still held,
        // released by the finally below) and BEFORE returning: a bounded,
        // fail-open observer that never alters the outcome — parity with the
        // Stop hook in agent-loop.ts. Only subagents that actually started reach
        // here (the early return-paths above never fire SubagentStop).
        try {
          await parent.hooks.runObservers(
            "SubagentStop",
            {
              agentType: persona.name,
              description: req.description,
              status,
              turns,
              toolCalls,
              durationMs: outcome.durationMs,
            },
            signal ? { signal } : undefined,
          );
        } catch {
          // fail-open: a SubagentStop hook never alters the subagent outcome.
        }

        return outcome;
      } finally {
        semaphore.release();
      }
    },
  };
}

function cancelledOutcome(startedAt: number): SubagentOutcome {
  return {
    status: "cancelled",
    finalText: "",
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Wiring helper: attaches a SubagentPort to `config` BEFORE `new AgentLoop`
 * (design §3.2). Mutates and returns the same config object. Called by the
 * host/CLI wiring (tasks 3.1.3/3.1.4); a child loop is created WITHOUT this
 * helper so it receives no port (non-recursion lock #2). `opts.profiles`
 * (slice 3.3, §2.5) threads md-profile personas into the runner.
 */
export function withSubagents(
  config: AgentLoopConfig,
  opts?: SubagentRunnerOptions,
): AgentLoopConfig {
  config.subagents = createSubagentRunner(config, opts);
  return config;
}

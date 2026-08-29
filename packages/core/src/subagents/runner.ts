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
import { SUBAGENT_WRAPUP_PROMPT, buildSubagentSystemPrompt } from "../prompts/subagent.js";
import type { SystemPromptEnv } from "../prompts/system.js";
import type { ModelPort } from "../ports/model.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { linkAbortSignal } from "../util/abort.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  SUBAGENT_MAX_TURNS_CEILING,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  SUBAGENT_LOOP_DEADLINE_MS,
  SUBAGENT_OUTCOME_DEADLINE_MS,
  SUBAGENT_OUTPUT_MAX_BYTES,
  SUBAGENT_STALL_TIMEOUT_MS,
  SUBAGENT_WRAPUP_MIN_WINDOW_MS,
  SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS,
  type ReasoningEffort,
} from "../types/config.js";
import { SubagentStallClock } from "./stall-clock.js";
import type {
  EngineChildSpec,
  EngineProfileInfo,
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
 * How often the inline stall clock polls the shared broker's live
 * `isAwaitingApproval` reader (TASK.148 slice 1). An inline child has no
 * `permission_request`/`permission_settled` EVENT stream of its own to hook a
 * pause on (it shares the parent's broker — ports/subagent.ts), so this is a
 * plain point-in-time read, not a push. Cheap relative to
 * SUBAGENT_STALL_TIMEOUT_MS (300x smaller at the default) and gives pause/
 * resume detection latency on the order of one tick, which is negligible next
 * to a multi-minute silence threshold.
 */
const INLINE_STALL_POLL_INTERVAL_MS = 2_000;

/**
 * Capability settings a child spawned on its OWN model gets (TASK.162).
 * Declared STRUCTURALLY here — a deliberate mirror of
 * `provider/child-model-settings.ts`'s `ChildModelSettings`, not an import of
 * it: the runner must keep zero catalog/provider dependencies, and the shape
 * is the whole contract. `maxOutputTokens: undefined` is a legal resolution
 * (claude-* models declare no ceiling), so the field's absence is an answer,
 * not a gap.
 */
export interface ResolvedChildModelSettings {
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  contextWindowTokens: number;
}

/**
 * Extra runner inputs (slice 3.3, design §2.5). `profiles` are md-profile
 * personas already parsed/validated/capped by subagents/profiles.ts; the runner
 * exposes them as additional agent types WITHOUT letting a profile shadow a
 * built-in (built-in always wins in resolution).
 */
export interface SubagentRunnerOptions {
  /**
   * Md-profile personas (already validated/capped by subagents/profiles.ts).
   * A plain array is a boot-time snapshot. A thunk is re-invoked on every
   * listAgentTypes()/run() call instead of being read once at construction —
   * the host wiring passes `() => ext.profiles` so a profile authored into
   * `.anycode/agents/` mid-session (host rescans and swaps `ext` in place)
   * becomes a callable agent_type without restarting the runner/session.
   */
  profiles?: readonly PersonaDefinition[] | (() => readonly PersonaDefinition[]);
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
  /**
   * Resolves the CHILD model's own capability settings for one spawn
   * (TASK.162, defect F6): without it `buildChildConfig` hands the child the
   * output ceiling, reasoning effort and context window that were resolved for
   * the PARENT's model. Additive-optional, exactly like
   * `resolveChildModelPort` above: a host that omits it keeps the legacy
   * inherit-the-parent path byte-identical.
   *
   * SINGLE-ARG by design (adjudicated 2026-08-28). The reasoning tier a child
   * is re-resolved against is the live USER-SELECTED tier, and it is applied
   * inside each HOST's own wiring closure — never handed to the runner. That
   * keeps this module structurally incapable of reaching for
   * `parent.reasoningEffort`, which is model-EFFECTIVE state: its `undefined`
   * cannot distinguish "the user selected off" from "a remembered tier the
   * parent model cannot honor", and hosts deliberately preserve the selected
   * tier across model switches. The runner therefore carries no effort
   * knowledge at all.
   */
  resolveChildModelSettings?: (modelId: string) => ResolvedChildModelSettings;
  /**
   * Runs ONE engine persona's child as a one-shot foreign CLI run (md-profile
   * `engine:` frontmatter) instead of an in-process AgentLoop. `run()` builds the
   * EngineChildSpec (persona body + the caller's request, joined the same way as
   * any other one-shot child prompt) and hands it here whenever the resolved
   * persona declares an `engine`; the whole buildChildConfig/AgentLoop/
   * resolveChildModelPort path is skipped for that spawn. A host that omits this
   * cannot run an engine persona at all: `run()` returns a honest error-outcome
   * rather than silently falling back to the in-process loop.
   *
   * @deprecated TASK.102 CUT-S4 §0.3/§2.4: engine profiles are migrated to
   * session-tier child sessions — `tools/agent.ts` now routes an engine
   * agent_type to `ctx.sessionSubagents` BEFORE this runner's `run()` is ever
   * reached, on every host that wires a SessionSubagentPort (the desktop root
   * host). This option and the branch that reads it stay wired, byte-live, for
   * the one caller that still lands here: a workflow step or any other host
   * without a SessionSubagentPort, which now gets the honest migration-notice
   * error text below instead of a real one-shot run. Removing the option and
   * this whole one-shot path is a separate owner decision (design spec §10),
   * out of S4's scope.
   */
  runEngineChild?: (spec: EngineChildSpec, opts: SubagentRunOptions) => Promise<SubagentOutcome>;
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
  extras?: {
    env?: SystemPromptEnv;
    memorySection?: string;
    modelPort?: ModelPort;
    /**
     * Capability settings resolved for the CHILD's own model (TASK.162).
     * Present => WHOLESALE replacement of the three parent-derived rows below
     * (maxOutputTokens / reasoningEffort / context window): an `undefined`
     * INSIDE the settings is that model's resolution, not a gap to patch from
     * the parent — patching would reinstate defect F6 for exactly the models
     * whose honest answer is "no declared ceiling" / "no effort".
     * Absent => the legacy inherit-from-parent path, byte-identical.
     */
    modelSettings?: ResolvedChildModelSettings;
    /**
     * Absolute epoch-ms wall-clock budget for the child loop (TASK.74 §3). The
     * runner anchors it at SubagentPort.run entry — pre-semaphore — so a child
     * that queued behind siblings inherits only the remaining time. Absent =>
     * the child loop runs without a deadline (existing callers unchanged).
     */
    deadlineAt?: number;
    /**
     * Absolute epoch-ms by which the outcome must be on its way back to the
     * parent (TASK.124 §1.11). Clamps the ceiling ladder's decision window: a
     * child that would answer after the Agent call has already timed out must
     * stop instead, so the parent gets a partial rather than nothing.
     */
    outcomeDeadlineAt?: number;
  },
): AgentLoopConfig {
  const tokenizer = parent.tokenizer ?? new HeuristicTokenizer();
  // NEW per-persona registry WITHOUT any spawn tool (structural non-recursion,
  // lock #1: SPAWN_TOOLS = Agent + Workflow are dropped). Built once so its name
  // snapshot drives the child's tool-discipline section AND is the child registry.
  const registry = buildPersonaRegistry(persona);
  // TASK.160 §2.2, reaffirmed by TASK.171: same precedence as the
  // model-override resolution in run() (request > persona default) — the
  // spawn identity stamped onto every telemetry record this child produces,
  // when the parent wired a tap factory. TASK.171 (owner's ruling — "модель
  // никогда не ответит, главное какие запросы мы шлем"): this REQUEST ECHO
  // is now the single authoritative answer to "which model did the child run
  // on," used identically here and by run()'s own `requestedModel` below —
  // never the constructed port's own identity (see the `onProgress`
  // start/end calls in run(), which read this same formula, not
  // `childModelPort?.modelId`). The provider's own claim (`responseModel`,
  // read near the end of run()) is a separate, distinctly-named datum for a
  // different question — what the provider reported, not what we asked for.
  const spawnModel = req.model ?? persona.model;
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
    // Budget resolution, most specific first: explicit request (a workflow step
    // — the Agent schema has no maxTurns and will not get one) > the role's own
    // budget (md-profile frontmatter / persona) > host/settings default
    // (parent.subagentMaxTurns) > DEFAULT_SUBAGENT_MAX_TURNS. Only the runaway
    // ceiling clamps — until 2026-08-16 the DEFAULT was the clamp, so a caller
    // could lower the budget but nothing could raise it. Turns are the runaway
    // guard, not the working budget: deadlineAt below is what usually ends a
    // long run (TASK.74 §2.4, carried into TASK.124).
    maxTurns: Math.min(
      req.maxTurns ?? persona.turnBudget ?? parent.subagentMaxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      SUBAGENT_MAX_TURNS_CEILING,
    ),
    ...(extras?.deadlineAt !== undefined ? { deadlineAt: extras.deadlineAt } : {}),
    // Ceiling ladder with the two clamps only a child needs (TASK.124 §1.12):
    // maxTurnsCeiling keeps the budget PLUS every grant under the same runaway
    // guard that bounds an explicit request, and outcomeDeadlineAt shrinks (and
    // eventually cancels) the decision call as the dispatcher's wall approaches.
    // The window/round/grant-sum defaults are the loop's own.
    ceiling: {
      maxTurnsCeiling: SUBAGENT_MAX_TURNS_CEILING,
      ...(extras?.outcomeDeadlineAt !== undefined
        ? { outcomeDeadlineAt: extras.outcomeDeadlineAt }
        : {}),
    },
    // Harness prelude (tool discipline over the child's OWN registry, env, memory)
    // + persona/profile body + finality note. toolNames come from the registry
    // built above (post SPAWN_TOOLS skip), so the child's prompt structurally
    // cannot advertise Agent/Workflow — a prompt-level mirror of lock #1.
    systemPrompt: buildSubagentSystemPrompt(persona, {
      toolNames: registry.list(),
      env: extras?.env,
      memorySection: extras?.memorySection,
    }),
    // TASK.162 (F6): with settings resolved for the child's OWN model, all
    // three capability rows come from there wholesale; without them the child
    // inherits the parent's already-resolved values, exactly as before.
    maxOutputTokens:
      extras?.modelSettings !== undefined ? extras.modelSettings.maxOutputTokens : parent.maxOutputTokens,
    reasoningEffort:
      extras?.modelSettings !== undefined ? extras.modelSettings.reasoningEffort : parent.reasoningEffort,
    // NEW empty history WITHOUT a sink: children are ephemeral, never written to

    // per-item estimates stay consistent.
    history: new ConversationHistory({ tokenizer }),
    tokenizer,
    // Only the window is re-resolved for the child's model; every other field
    // the parent's context object carries (budget knobs the resolver knows
    // nothing about) is preserved by the overlay.
    context:
      extras?.modelSettings !== undefined
        ? { ...parent.context, contextWindowTokens: extras.modelSettings.contextWindowTokens }
        : parent.context,
    // Artifact store INHERITED (TASK.94) — one of the few parent facilities a
    // child gets, because it is not a capability the child can act with: it
    // only decides whether the child's own oversized tool output is recoverable
    // or destroyed. Artifacts land in the parent session's directory, which the
    // parent's own cleanup then collects.
    artifacts: parent.artifacts,
    // TASK.160 §2.2: the child's own eventTap, built from the parent's tap
    // FACTORY (never the factory itself — structural non-recursion: this
    // object literal does not list `subagentEventTap`, so a grandchild
    // spawned by THIS child cannot inherit a tap of its own; the
    // grandchild's activity reaches telemetry only as this child's
    // subagent_start/subagent_end events, same as today). Absent factory
    // (telemetry disabled, or a caller — e.g. the workflow engine — that
    // never wires one) => no eventTap, byte-identical to pre-TASK.160.
    ...(parent.subagentEventTap !== undefined
      ? {
          eventTap: parent.subagentEventTap({
            agentType: persona.name,
            ...(spawnModel !== undefined ? { model: spawnModel } : {}),
          }),
        }
      : {}),
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
  // resolution consults isKnownPersona FIRST (built-in always wins). Rebuilt
  // on EVERY call rather than cached once at construction: opts.profiles may
  // be a thunk the host re-points at a freshly rescanned profile list between
  // turns, and a stale snapshot here would keep a live-session-authored
  // profile permanently invisible to listAgentTypes()/run(). Rebuilding is
  // cheap — profiles are capped at MAX_AGENT_PROFILES.
  function currentProfiles(): Map<string, PersonaDefinition> {
    const source = opts?.profiles;
    const list = typeof source === "function" ? source() : (source ?? []);
    const map = new Map<string, PersonaDefinition>();
    for (const profile of list) {
      if (!map.has(profile.name)) {
        map.set(profile.name, profile);
      }
    }
    return map;
  }

  return {
    listAgentTypes(): string[] {
      return [...listPersonaNames(), ...currentProfiles().keys()];
    },
    // TASK.102 CUT-S4 §2.1: resolves an md-profile's `engine:` frontmatter for
    // tools/agent.ts's routing branch. Reads the SAME thunk (currentProfiles())
    // as listAgentTypes above — no second list/cache, so a profile rescanned
    // mid-session is visible here too. Built-ins are never engine profiles.
    engineProfile(agentType: string): EngineProfileInfo | null {
      if (isKnownPersona(agentType)) {
        return null;
      }
      const persona = currentProfiles().get(agentType);
      if (!persona || persona.engine === undefined) {
        return null;
      }
      // persona.model rides through as the session-tier DEFAULT (model
      // plumbing fix) — omitted entirely when absent, never a present-but-
      // undefined key, matching the discipline every other optional field on
      // this wire already follows.
      return {
        engine: persona.engine,
        systemPrompt: persona.systemPrompt,
        ...(persona.model !== undefined ? { model: persona.model } : {}),
      };
    },
    async run(req: SubagentRequest, runOpts: SubagentRunOptions): Promise<SubagentOutcome> {
      const startedAt = Date.now();
      const { signal, onProgress } = runOpts;
      const profileMap = currentProfiles();

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

      // The port is public: a hand-built request bypasses the workflow schema
      // that would have rejected a nonsense budget, and an unchecked NaN/0/-1
      // would reach the loop as a maxTurns nothing compares usefully against.
      // Refuse it as an error-outcome before anything is spawned.
      if (
        req.maxTurns !== undefined &&
        (!Number.isInteger(req.maxTurns) || req.maxTurns < 1)
      ) {
        return {
          status: "error",
          finalText: `Agent: maxTurns must be a positive integer (received ${String(req.maxTurns)}).`,
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

      // Precedence: an explicit `Agent(model: …)` request outranks the profile's
      // own `model:` frontmatter, which outranks inheriting the parent's port (or,
      // for an engine persona, the engine's own default). Shared by both the
      // engine and in-process paths below.
      const requestedModel = req.model ?? persona.model;

      // Engine persona (md-profile `engine:`): the whole in-process path
      // (buildChildConfig/AgentLoop/resolveChildModelPort) is bypassed in favor
      // of a one-shot foreign CLI run. Checked BEFORE the semaphore — same
      // rationale as the model-override check below: a host that cannot honor it
      // must fail without ever queuing behind running children.
      if (persona.engine !== undefined) {
        const runEngineChild = opts?.runEngineChild;
        if (runEngineChild === undefined) {
          return {
            status: "error",
            finalText:
              `Agent: agent type "${persona.name}" runs on the "${persona.engine}" engine. Engine agents now run ` +
              `as child sessions via the Agent tool; this caller (workflow step or non-desktop host) cannot spawn one.`,
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          };
        }

        try {
          await semaphore.acquire(signal);
        } catch {
          return cancelledOutcome(startedAt);
        }

        try {
          onProgress?.({
            kind: "start",
            agentType: persona.name,
            description: req.description,
            engine: persona.engine,
            ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          });

          // The child's one-shot prompt: the persona body (same source
          // buildSubagentSystemPrompt embeds for an in-process child) plus the
          // caller's own request, separated so the foreign CLI sees both parts.
          const spec: EngineChildSpec = {
            engine: persona.engine,
            prompt: `${persona.systemPrompt}\n\n---\n\n${req.prompt}`,
            agentType: persona.name,
            description: req.description,
            ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          };

          const outcome = await runEngineChild(spec, runOpts);

          onProgress?.({
            kind: "end",
            status: outcome.status,
            turns: outcome.turns,
            durationMs: outcome.durationMs,
            // TASK.171: the requested id, echoed onto the end event too (not
            // only start) so a completed run's telemetry/end record is
            // self-describing on its own — an engine child has no port to
            // read a provider claim off, so `responseModel` never applies here.
            ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          });

          await fireSubagentStop(parent, persona, req, outcome, signal);

          return outcome;
        } finally {
          semaphore.release();
        }
      }

      // Resolve an Agent-tool model override (slice 4.6, design §2.5) BEFORE
      // the semaphore: a host that cannot honor req.model must fail without

      let childModelPort: ModelPort | undefined;
      let childSettings: ResolvedChildModelSettings | undefined;
      if (requestedModel !== undefined) {
        const resolve = opts?.resolveChildModelPort;
        if (resolve === undefined) {
          return {
            status: "error",
            finalText:
              req.model !== undefined
                ? `Agent: model override "${req.model}" is not supported in this host; retry without the model field.`
                : `Agent: agent type "${persona.name}" declares model "${persona.model}", which is not supported in this host.`,
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          };
        }
        // The resolver owns the id→port mapping and may reject an id this
        // module cannot validate (no catalogue here). The port contract is
        // outcomes-not-throws, so a rejection becomes an error outcome.
        try {
          childModelPort = resolve(requestedModel);
        } catch (error) {
          return {
            status: "error",
            finalText: `Agent: model "${requestedModel}" could not be resolved in this host: ${error instanceof Error ? error.message : String(error)}`,
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          };
        }

        // TASK.162 (F6): capabilities re-resolved for the child's OWN model.
        // The host's closure — not this module — supplies the live
        // USER-SELECTED reasoning tier it re-resolves against (adjudicated
        // 2026-08-28: `parent.reasoningEffort` is banned as the tier source,
        // its `undefined` conflating a selected "off" with a tier the parent
        // model merely cannot honor, which is why hosts preserve the selected
        // tier across a model switch).
        //
        // A throw is an error-outcome, same posture as the port resolver
        // right above: falling back to the parent's already-resolved values
        // would silently reinstate the very defect this resolver removes.
        try {
          childSettings = opts?.resolveChildModelSettings?.(requestedModel);
        } catch (error) {
          return {
            status: "error",
            finalText: `Agent: model "${requestedModel}" settings could not be resolved in this host: ${error instanceof Error ? error.message : String(error)}`,
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      // Abort-aware semaphore wait: a queued child that is cancelled returns
      // immediately without running (design §4.1 mechanics).
      try {
        await semaphore.acquire(signal);
      } catch {
        return cancelledOutcome(startedAt);
      }

      // TASK.148 slice 1: declared outside the try below so the `finally`
      // (semaphore release) can always dispose them, on every exit path —
      // including a throw from buildChildConfig/AgentLoop construction that
      // never reaches the loop at all.
      let stallClock: SubagentStallClock | undefined;
      let stallPollTimer: ReturnType<typeof setInterval> | undefined;

      try {
        onProgress?.({
          kind: "start",
          agentType: persona.name,
          description: req.description,
          // TASK.171 REVERSES TASK.161 here: this used to read the id back off
          // the CONSTRUCTED port (`childModelPort?.modelId ?? requestedModel`),
          // so the card and telemetry's `spawnModel` (buildChildConfig, ~line
          // 208) could disagree the moment a port canonicalized an id. Owner's
          // ruling — "модель никогда не ответит, главное какие запросы мы
          // шлем" — makes the REQUEST the single authoritative answer to
          // "which model did the child run on": a constructed port's own
          // identity is still our own construction, not independent evidence,
          // so it is never consulted here. Absent still means "inherited the
          // parent's port". The provider's own claim is carried separately, as
          // `responseModel` on the end event below — see that comment for why
          // it is deliberately NOT merged into this field.
          ...(requestedModel !== undefined ? { model: requestedModel } : {}),
        });

        // TASK.148 slice 1: measures SILENCE (time since the child's last
        // sign of life), never total run time — the three wall constants
        // above stay the untouched last-resort backstop. Reports, never
        // kills: onStall only ever bridges into a subagent_stalled progress
        // (mapProgressToEvent, tools/agent.ts); nothing here can end the run.
        const stallTimeoutMs = parent.subagentStallTimeoutMs ?? SUBAGENT_STALL_TIMEOUT_MS;
        stallClock = new SubagentStallClock({
          agentType: persona.name,
          description: req.description,
          timeoutMs: stallTimeoutMs,
          onStall: (report) => {
            onProgress?.({
              kind: "stalled",
              agentType: report.agentType,
              description: report.description,
              silentMs: report.silentMs,
              ...(report.lastActivity !== undefined ? { lastActivity: report.lastActivity } : {}),
              waitingForApproval: report.waitingForApproval,
            });
          },
        });
        // Poll-driven pause/resume (see INLINE_STALL_POLL_INTERVAL_MS above):
        // a broker that never implements `isAwaitingApproval` (older/fake/CLI
        // broker) always reads `undefined !== true` here, so this degrades to
        // "never pauses" rather than ever mistakenly freezing the clock.
        stallPollTimer = setInterval(() => {
          if (parent.permissionBroker.isAwaitingApproval === true) {
            stallClock?.pause();
          } else {
            stallClock?.resume();
          }
        }, INLINE_STALL_POLL_INTERVAL_MS);
        stallPollTimer.unref?.();

        // The config is held in a variable rather than inlined: the wrap-up call
        // below must reach the model through the SAME port/system prompt/output
        // limits the loop used, including the resolveChildModelPort branch.
        const childConfig = buildChildConfig(parent, persona, req, {
          env: opts?.env,
          memorySection: opts?.memorySection,
          // Wall-clock budget anchored at run() entry, i.e. BEFORE the semaphore
          // wait above: the dispatcher bills the Agent call from the moment the
          // handler was invoked, so time spent queued is time already spent.
          deadlineAt: startedAt + SUBAGENT_LOOP_DEADLINE_MS,
          // Same anchor as the wrap-up window below (run() entry): what the
          // ladder may spend on a decision is what is left of the parent's wait.
          outcomeDeadlineAt: startedAt + SUBAGENT_OUTCOME_DEADLINE_MS,
          ...(childModelPort !== undefined ? { modelPort: childModelPort } : {}),
          ...(childSettings !== undefined ? { modelSettings: childSettings } : {}),
        });
        const loop = new AgentLoop(childConfig);

        let currentTurnText = "";
        let finalText = "";
        let toolCalls = 0;
        let lastTool: string | undefined;
        // Per-run activity-event emission counter (slice P7.18/F16b): the feed is
        // bounded — tool-activity stops emitting past SUBAGENT_ACTIVITY_MAX_EVENTS,
        // while counters (subagent_progress) and start/end continue unaffected.
        let activityEmitted = 0;
        // Count of tool_result-eligible child calls withheld past the cap
        // (TASK.102 slice S1 W2, CUT-S1 §0.5): reported on end-progress so the
        // persisted card's dropped-activity count is honest, not silently
        // bounded. invalid_input calls are excluded — same eligibility test as
        // emission below, they never actually ran.
        let activitySuppressed = 0;
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
                // Sign of life (TASK.148 slice 1): a completed tool call resets
                // the silence window, once per event — the "tool" activity
                // branch below shares this same boundary, not a second reset.
                stallClock?.noteProgress(lastTool);
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
                if (pending && event.outcome.status !== "invalid_input") {
                  if (activityEmitted < SUBAGENT_ACTIVITY_MAX_EVENTS) {
                    activityEmitted += 1;
                    onProgress?.({
                      kind: "tool",
                      toolName: pending.toolName,
                      summary: summarizeChildToolCall(pending.toolName, pending.input),
                    });
                  } else {
                    activitySuppressed += 1;
                  }
                }
                break;
              }
              case "turn_end":
                // Capture the just-completed turn's text; a later cutoff turn_start
                // (max_turns) or an error before turn_end cannot overwrite it.
                finalText = currentTurnText;
                turnEndCount += 1;
                // Sign of life (TASK.148 slice 1): a turn boundary is progress
                // even on a turn that made no tool calls at all.
                stallClock?.noteProgress();
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

        // Wrap-up rescue (TASK.74 §4). A child cut off by its budget otherwise
        // hands the parent the preamble of the turn that was cut — what it was
        // about to do, not what it found. One tool-free model call converts the
        // history it already has into a report. Deliberately NOT run when:
        // the run ended any other way (a completed child already reported, an
        // errored/cancelled one has no standing to speak), the child never
        // completed a turn (nothing to summarize — the empty branch in
        // tools/agent.ts says so honestly and costs no time), or the caller
        // cancelled (the rescue must not outlive the request).
        //
        // The status computed above is NEVER revised by the rescue: a technically
        // successful wrap-up is still an unfinished task, and promoting it to
        // "completed" would make a workflow accept the fragment as a satisfied
        // dependency.
        if (status === "max_turns" && turns > 0 && !signal?.aborted) {
          // Window shrinks as the run approaches the dispatcher's wall: a call
          // started too late would push the whole Agent call past its timeout
          // and the parent would receive nothing at all instead of a partial.
          const windowMs = Math.min(
            SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS,
            SUBAGENT_OUTCOME_DEADLINE_MS - (Date.now() - startedAt),
          );
          if (windowMs >= SUBAGENT_WRAPUP_MIN_WINDOW_MS) {
            finalText = await runWrapUp(childConfig, loop, finalText, windowMs, signal);
          }
        }

        // TASK.161: the provider's own model CLAIM, read as a PROPERTY off the
        // child's dedicated port — deliberately here, AFTER the wrap-up block
        // above, because the rescue call streams through this same port object
        // (runWrapUp -> config.modelPort.streamText) and its claim is the last
        // one this child produced. No per-event accumulation: an accumulator
        // would freeze the loop's claim and miss the wrap-up's.
        //
        // The inherited-port case (no override => childModelPort undefined)
        // reports nothing on purpose: the parent's shared port carries
        // whichever call streamed last, which is not attributable to this child.
        //
        // TASK.171 (owner's ruling, verbatim: "модель никогда не ответит,
        // главное какие запросы мы шлем и что в них фигурирует"): this claim
        // is evidence ABOUT the provider, never the answer to "which model did
        // the child run on" — that question is answered exclusively by
        // `requestedModel` (below, and at the start event above). Kept as its
        // own field, distinctly named, specifically because it is the only
        // instrument for the open z.ai accounting investigation (TASK.174);
        // dropping it would destroy that evidence. A provider/transport that
        // never surfaces a raw claim (childModelPort has no
        // `lastResponseModel`, or the child inherited the parent's shared
        // port) simply leaves this undefined — it never falls back to, blanks,
        // or otherwise touches `requestedModel`.
        const responseModel = childModelPort?.lastResponseModel;

        const capped = capUtf8Bytes(finalText, SUBAGENT_OUTPUT_MAX_BYTES);
        const outcome: SubagentOutcome = {
          status,
          finalText: capped.text,
          truncated: capped.truncated,
          turns,
          toolCalls,
          durationMs: Date.now() - startedAt,
        };

        onProgress?.({
          kind: "end",
          status,
          turns,
          durationMs: outcome.durationMs,
          ...(activitySuppressed > 0 ? { activitySuppressed } : {}),
          // TASK.171: the requested id travels on the end event too (not only
          // start), so the end record — the one telemetry's whitelist can
          // finally carry (records.ts, subagent_end case) — is self-describing:
          // both "what we asked for" and "what the provider claimed" recover
          // from ONE record, without correlating back to an earlier start line.
          ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          ...(responseModel !== undefined ? { responseModel } : {}),
        });

        // Fire SubagentStop observers INSIDE the permit (semaphore still held,
        // released by the finally below) and BEFORE returning: a bounded,
        // fail-open observer that never alters the outcome — parity with the
        // Stop hook in agent-loop.ts. Only subagents that actually started reach
        // here (the early return-paths above never fire SubagentStop).
        await fireSubagentStop(parent, persona, req, outcome, signal);

        return outcome;
      } finally {
        semaphore.release();
        // TASK.148 slice 1: stop the clock/poll on EVERY exit from the try
        // above (normal return, an early return this function doesn't have,
        // or a throw before either was ever constructed — both are still
        // `undefined` then, and the optional calls below are no-ops).
        stallClock?.dispose();
        if (stallPollTimer !== undefined) {
          clearInterval(stallPollTimer);
        }
      }
    },
  };
}

/**
 * One tool-free model call asking a budget-exhausted child to report what it
 * actually established (TASK.74 §4.3). Runs OUTSIDE the AgentLoop, straight
 * against the child's own ModelPort, which makes the no-tools rule structural:
 * there is no dispatcher on this path, so a tool call the model proposes anyway
 * has nothing to execute it. Stream retries and the stall watchdog still apply
 * — they live in the ModelPort adapter, not in the loop.
 *
 * The loop's history is READ, never written: the instruction exists only in this
 * request's `messages`, so the transcript stays exactly as `loop_end` left it —
 * balanced and terminal. Compaction is not available here; an overflowing
 * history therefore fails the call, which degrades to `fallback` like every
 * other failure. Returns the report, or `fallback` (the raw last-turn text)
 * whenever the call throws, aborts, times out or produces nothing but
 * whitespace — the rescue can only improve the outcome, never worsen it.
 *
 * TASK.160 (known accepted gap, not fixed here): because this call runs
 * OUTSIDE the AgentLoop it never reaches `config.eventTap` (the very tap
 * buildChildConfig installs from `parent.subagentEventTap`) — its tokens go
 * unrecorded even when the parent's telemetry is fully wired. A wrap-up call
 * is one model call per rescued child, so the undercount is small and bounded.
 */
async function runWrapUp(
  config: AgentLoopConfig,
  loop: AgentLoop,
  fallback: string,
  windowMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const dispose = signal ? linkAbortSignal(signal, controller) : () => {};
  const timer = setTimeout(() => controller.abort("wrapup-timeout"), windowMs);
  try {
    let text = "";
    const stream = config.modelPort.streamText({
      system: config.systemPrompt,
      messages: [
        ...loop.history.toMessages(),
        { role: "user", content: SUBAGENT_WRAPUP_PROMPT },
      ],
      tools: [],
      maxOutputTokens: config.maxOutputTokens,
      reasoningEffort: config.reasoningEffort,
      abortSignal: controller.signal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "stream_retry") {
        // The step is replayed from scratch; discard the aborted attempt's text
        // (mirror of the loop's own accumulator reset).
        text = "";
      }
    }
    return text.trim().length > 0 ? text : fallback;
  } catch {
    // Degradation by design: any failure leaves today's raw partial in place.
    return fallback;
  } finally {
    clearTimeout(timer);
    dispose();
  }
}

/**
 * Fires the SubagentStop observer for a subagent that actually started —
 * in-process or engine child alike — fail-open, never altering the outcome
 * (parity with the Stop hook in agent-loop.ts). Shared by both `run()` code
 * paths so the hook contract has one call site instead of two copies.
 */
async function fireSubagentStop(
  parent: AgentLoopConfig,
  persona: PersonaDefinition,
  req: SubagentRequest,
  outcome: SubagentOutcome,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await parent.hooks.runObservers(
      "SubagentStop",
      {
        agentType: persona.name,
        description: req.description,
        status: outcome.status,
        turns: outcome.turns,
        toolCalls: outcome.toolCalls,
        durationMs: outcome.durationMs,
      },
      signal ? { signal } : undefined,
    );
  } catch {
    // fail-open: a SubagentStop hook never alters the subagent outcome.
  }
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

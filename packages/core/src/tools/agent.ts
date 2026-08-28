/**
 * Agent tool (Phase 3 slice 3.1, design §3.4): spawns an in-process subagent
 * via ctx.subagents (a SubagentPort) and returns its outcome as a normal tool
 * result. The tool lives BELOW loop/ and never imports AgentLoop — the port is
 * the only seam (§3.1).
 *
 * Outcome mapping (TASK.44): only `completed` is a full success. `max_turns`
 * returns an explicit incomplete errorKind so the dispatcher, renderer badge
 * and model-visible text all agree the delegation did NOT succeed; a non-empty
 * partial finalText rides the error message, an empty one never reads as
 * success. `cancelled` and `error` are likewise never success.
 *

 * spawn itself is side-effect-free, and every effectful child tool call passes
 * the SAME inherited permission gate, so gating the spawn too would only add
 * noise. Plan-mode stays honest: the child inherits plan, so its write tools go
 * to deny.
 *
 * Slice 3.1.2 EXPANDS this handler with the real run->outcome mapping, the
 * SubagentProgress -> ctx.emit(subagent_*) bridge and output capping. The
 * version here validates agent_type, enforces the fail-closed "unavailable"
 * lock, and keeps the run() seam clean.
 *
 * TASK.145 срез 1 adds `detach` (session-tier only, same "FULL declaration
 * only" discipline as `tier`/`provider`): `runSessionTier` below just
 * forwards it onto `SessionSubagentRequest` after the same fail-fast
 * tier-mismatch check `provider` already has. Everything past that point —
 * whether the call returns at admit or waits for the child's terminal — is
 * the host-side RPC client's business (host/child-session-port.ts), never
 * this module's: `runSessionTier`'s own outcome handling
 * (`outcomeToResult`/`finalizeSubagentCard`) is untouched, because a detached
 * admit is shaped to arrive as an ordinary `SessionSubagentOutcome` with
 * `status:"completed"` (the SPAWN succeeded — see the port's own comment for
 * why this is honest) and no `subagent_start` progress ever precedes it, so
 * `finalizeSubagentCard` naturally returns null (its own "never fabricated"
 * rule) and no presentation card is built for a call that has not actually
 * finished.
 *
 * TASK.102 CUT-S2 §2.1/§3 B1 widens this into a FACTORY, `createAgentTool`.
 * A single handler now branches on `tier`: "inline" (default, unchanged
 * behavior above) runs through `ctx.subagents` (SubagentPort, in-process
 * child loop); "session" runs through `ctx.sessionSubagents`
 * (SessionSubagentPort, a full child session in its own process — CUT-S2
 * §2.2). The two ports are entirely independent capabilities: which one a
 * given call can reach is decided by (a) whether `tier:"session"` is even
 * REACHABLE in the declared schema (non-recursion lock #1, `sessionTier`
 * option below) and (b) whether the host actually wired `ctx.sessionSubagents`
 * (non-recursion lock #2, buildChildConfig never copies it — same discipline
 * as `subagents`). The outcome->ToolResult mapping (status/errorKind/message)
 * is IDENTICAL for both tiers (`outcomeToResult` below) since
 * SessionSubagentOutcome extends SubagentOutcome with the same terminal
 * status union — only the target recorded on the presentation card differs.
 */

import type { ToolContext, ToolDefinition, ToolMetadata, ToolResult } from "../types/tools.js";
import type { EngineProfileInfo, SubagentOutcome, SubagentProgress } from "../ports/subagent.js";
import type { SessionSubagentRequest } from "../ports/session-subagent.js";
import {
  SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS,
  SUBAGENT_OUTPUT_MAX_BYTES,
  SUBAGENT_TIME_BUDGET_MS,
} from "../types/config.js";
import { listPersonaNames } from "../subagents/personas.js";
import {
  sanitizeAndCap,
  SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS,
} from "../subagents/summarize-tool.js";
import {
  createSubagentCardAccumulator,
  finalizeSubagentCard,
  reduceSubagentCardEvent,
  type SubagentCardEvent,
} from "../subagents/card-snapshot.js";
import type { SubagentCardTarget, ToolResultPresentation } from "../types/subagent-card.js";
import { agentInputSchema, restrictedAgentInputSchema, type AgentInput, type AgentOutput } from "./schemas.js";

/** Persona used when the model omits agent_type. */
const DEFAULT_AGENT_TYPE = "general-purpose";

/** Base description shared by both declarations (CUT-S2 §2.1); sessionTier:true appends one sentence. */
const BASE_DESCRIPTION =
  'Delegate a task to a subagent. agent_type "explore" = read-only recon for sweeping several files when you only need the conclusion; "general-purpose" = the subtask needs write/exec tools. Independent Agent calls issued together in one response run concurrently — fan out disjoint searches. For a single known-file fact, Read/Grep it yourself; once delegated, do not redo the search.';

const SESSION_TIER_DESCRIPTION_SUFFIX =
  ' Tier "session" spawns a full child session the user can open and steer.';

export interface CreateAgentToolOptions {
  /**
   * true: the FULL declaration (`agentInputSchema` — `tier`/`provider` reach
   * "session") for the root desktop host, the only concrete
   * SessionSubagentPort implementer (CUT-S2 §2.6.1). false/absent (default):
   * the RESTRICTED declaration (`restrictedAgentInputSchema` — no `provider`
   * key, `tier` can only ever be `"inline"`) for CLI, every child session,
   * and any other host that never wires a SessionSubagentPort — the schema
   * itself is non-recursion lock #1 of 3 (CUT-S2 §0.2/§5.13): a model talking
   * to a restricted host cannot even DISCOVER the session tier exists.
   */
  sessionTier?: boolean;
}

function buildMetadata(sessionTier: boolean): ToolMetadata {
  return {
    name: "Agent",
    description: sessionTier ? BASE_DESCRIPTION + SESSION_TIER_DESCRIPTION_SUFFIX : BASE_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: "low",
    sideEffectScope: "process",
    needsApproval: false,
    // The dispatcher wall for one spawn, and the ONLY wall the session tier
    // has (`host/child-session-port.ts` deliberately keeps no client-side
    // timeout of its own). One number for both tiers on purpose: metadata is
    // per-DECLARATION, not per-call, so a `sessionTier:true` registry serves
    // this same wall to the inline spawns of that host as well — a split here
    // would separate hosts, not tiers.
    timeoutMs: SUBAGENT_TIME_BUDGET_MS,
    maxTimeoutMs: SUBAGENT_TIME_BUDGET_MS,
    maxOutputBytes: SUBAGENT_OUTPUT_MAX_BYTES,
  };
}

/**
 * Projects the terminal SubagentOutcome (shared shape of the inline and
 * session tiers) onto the tool's ToolResult, honoring TASK.44's honest
 * outcome mapping. Pulled out of the per-tier run branches so the mapping
 * text/logic is provably the SAME for both (CUT-S2 §2.1: "маппинг
 * outcome→result ОБЩИЙ для обоих ярусов").
 */
function outcomeToResult(
  outcome: SubagentOutcome,
  presentation: { presentation?: ToolResultPresentation },
): ToolResult<AgentOutput> {
  if (outcome.status === "error") {
    return { ok: false, error: outcome.finalText || "Agent: the subagent failed.", ...presentation };
  }
  // max_turns (TASK.44 + TASK.74): the child exhausted its budget — the turn
  // cap or the wall-clock deadline, which share this status because the
  // remediation is identical. This is NOT a
  // success. Return an explicit incomplete errorKind so the dispatcher maps
  // the tool_call to status "max_turns" (not "success"), the parent model
  // receives a clear message naming the limit and the turns spent, and any
  // partial finalText the child did produce is forwarded (after the limit
  // notice) so it is not lost. An EMPTY partial must not read as success:
  // the error message is always non-empty here, so an empty-finalText
  // max_turns outcome can never provoke a blind re-delegation.
  if (outcome.status === "max_turns") {
    const partial = outcome.finalText.trim();
    const error = partial
      ? `Agent: the subagent ran out of budget after ${outcome.turns} turns without finishing.\n` +
        `INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT. ` +
        `Missing checks may invalidate the conclusions below.\n\n${partial}`
      : `Agent: the subagent ran out of budget after ${outcome.turns} turns without finishing and produced no partial result. The task was not completed — split it into narrower delegations, or ask the user to raise the subagent turn budget (Settings → Tools → "Maximum turns (subagents)").`;
    return { ok: false, errorKind: "max_turns", error, output: toAgentOutput(outcome), ...presentation };
  }
  // cancelled (TASK.44): preserve cancellation semantics — never success.
  // The dispatcher maps errorKind "cancelled" to status "cancelled", so the
  // card's external badge and the internal subagent_end status agree.
  if (outcome.status === "cancelled") {
    return {
      ok: false,
      errorKind: "cancelled",
      error: "Agent: the subagent was cancelled.",
      output: toAgentOutput(outcome),
      ...presentation,
    };
  }
  // The runner already capped finalText and set truncated; forward the outcome
  // verbatim (finalText/truncated/status/counters) as the tool payload.
  return { ok: true, output: toAgentOutput(outcome), ...presentation };
}

/**
 * Narrows a (possibly wider) SubagentOutcome-shaped value down to exactly
 * AgentOutput's fields. Explicit rather than `{ ...outcome }`: a
 * SessionSubagentOutcome carries three extra id fields (childSessionId/
 * parentSessionId/spawnToolCallId) that belong on the presentation card's
 * `target` (CUT-S2 §2.1: "core их только копирует в target"), not on the
 * model-visible tool output.
 */
function toAgentOutput(outcome: SubagentOutcome): AgentOutput {
  return {
    status: outcome.status,
    finalText: outcome.finalText,
    truncated: outcome.truncated,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    durationMs: outcome.durationMs,
  };
}

function formatResultForModel(result: ToolResult<AgentOutput>): string {
  if (!result.ok) {
    return result.error ?? "Agent: the subagent failed.";
  }
  return result.output?.finalText ?? "";
}

/**
 * Builds the Agent tool. `sessionTier:false` (default) is the RESTRICTED
 * declaration; `sessionTier:true` is the FULL one (CUT-S2 §2.1). Both share
 * ONE handler — the branch on `input.tier` below, not a second copy of the
 * outcome-mapping logic.
 */
export function createAgentTool(opts?: CreateAgentToolOptions): ToolDefinition<AgentInput, AgentOutput> {
  const sessionTier = opts?.sessionTier ?? false;
  const metadata = buildMetadata(sessionTier);
  // The restricted schema's output type is a structural subtype of AgentInput
  // (no `provider` key, `tier` narrowed to `"inline"`) — every value it can
  // ever produce is already a valid AgentInput. The cast makes that provable
  // relationship explicit for the shared handler below, which is typed once
  // against the FULL AgentInput regardless of which declaration is live.
  const inputSchema = (sessionTier ? agentInputSchema : restrictedAgentInputSchema) as typeof agentInputSchema;

  return {
    metadata,
    inputSchema,
    handler: async (input, ctx) => {
      const agentType = input.agent_type ?? DEFAULT_AGENT_TYPE;
      const tier = input.tier ?? "inline";

      // provider is session-tier only (design §2.1/CUT-S2 §1 p.2). Checked
      // BEFORE agent_type/availability so a malformed inline call fails fast
      // with the precise reason, independent of what ports the host wired.
      if (input.provider !== undefined && tier !== "session") {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "provider" is only valid with tier "session".',
        };
      }

      // TASK.145 срез 1: same precedent as the provider check above — an
      // explicit `detach:true` on a tier that cannot honor it (only
      // "session" spawns a real child process to detach FROM) is a fail-fast
      // invalid_input, not a silent downgrade to sync-join. `detach:false`
      // (or absent) is a no-op on any tier, so it is never rejected here —
      // only an ACTUAL request for background semantics can conflict with
      // the tier.
      if (input.detach === true && tier !== "session") {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "detach" is only valid with tier "session".',
        };
      }

      // Validate the agent_type (design §2.3/§3.4): the set of runnable types is
      // delegated to the port (built-in personas + md-profiles) so slice 3.3's
      // profiles are reachable WITHOUT touching the frozen schema. A port lacking
      // listAgentTypes (older/fake) falls back to the built-in persona list.
      // Unknown type is a handler-level invalid_input carrying the available list.
      // Persona validity is orthogonal to tier — both tiers run the SAME
      // persona set, so this always reads the inline `subagents` port.
      const available = ctx.subagents?.listAgentTypes?.() ?? listPersonaNames();
      if (!available.includes(agentType)) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: `Unknown agent_type "${agentType}". Available agent types: ${available.join(", ")}.`,
        };
      }

      // Engine-profile routing (TASK.102 CUT-S4 §2.2), BEFORE the tier branch:
      // an md-profile declaring `engine:` frontmatter no longer runs as a
      // bare one-shot foreign CLI call (the permission-gate hole S4 closes) —
      // it always runs as a child SESSION instead, through the exact same
      // SessionSubagentPort contract as an explicit `tier:"session"` call.
      const engineProfile = ctx.subagents?.engineProfile?.(agentType) ?? null;
      if (engineProfile !== null) {
        // provider is a core-connect concept; a foreign-engine child runs on
        // its own CLI account, so the field is meaningless here — even though
        // it is only reachable when the earlier tier==="session" check above
        // let it through.
        if (input.provider !== undefined) {
          return {
            ok: false,
            errorKind: "invalid_input",
            error: 'Agent: "provider" is not valid for an engine-profile agent — the child runs on its own CLI account.',
          };
        }
        // Codex engine children are UNSUPPORTED (TASK.102 S4-codex-cut), not
        // merely unavailable: a Codex child's native transcript cannot be
        // read at flush time. The only source is `client.request(
        // "thread/read")`, but the `AppServerClient` that method lives on is
        // created inside startCodexEngine/resumeCodexEngine and never
        // returned (`ConnectedCodexEngine` = {engine, threadId, model,
        // presetId}), and is `private readonly client` on CodexEngine itself
        // (apps/desktop/src/host/engines/codex/codex-engine.ts, frozen) — so
        // no caller outside that file can ever reach it. The shadow log is no
        // substitute: it holds only commandExecution completions, never the
        // conversation. Refusing here, before runSessionTier ever touches
        // ctx.sessionSubagents, is the only honest option — the alternative
        // is a card that reads "done" with an "Open" that is silently empty.
        if (engineProfile.engine === "codex") {
          return {
            ok: false,
            error:
              `Agent: agent type "${agentType}" runs on the "codex" engine; codex engine children are not ` +
              `supported — their transcript is unreachable at flush time, so a session would boot with no way ` +
              `to persist what the child did.`,
          };
        }

        // Fail-closed: without a SessionSubagentPort an engine profile cannot
        // run at all — the one-shot in-process fallback no longer exists.
        if (!ctx.sessionSubagents) {
          return {
            ok: false,
            error:
              `Agent: agent type "${agentType}" runs on the "${engineProfile.engine}" engine; engine agents run ` +
              `as child sessions and are unavailable in this host.`,
          };
        }
        // tier is IGNORED for an engine profile: it always runs as a session,
        // a silent inline->session upgrade rather than a tier:"inline" refusal
        // — the migration this slice performs.
        return runSessionTier(input, ctx, agentType, engineProfile);
      }

      if (tier === "session") {
        return runSessionTier(input, ctx, agentType);
      }
      return runInlineTier(input, ctx, agentType);
    },
    formatResultForModel,
  };
}

/**
 * Inline tier (unchanged behavior from the pre-B1 handler — design §3.1/§3.2).
 * Non-recursion lock: no port => fail closed. A child loop's DispatchContext
 * leaves `subagents` unset, so a child can never spawn. A known-but-childless
 * type still lands here (invalid_input for unknown, unavailable for known —
 * both fail-closed, design §2.3).
 */
async function runInlineTier(
  input: AgentInput,
  ctx: ToolContext,
  agentType: string,
): Promise<ToolResult<AgentOutput>> {
  if (!ctx.subagents) {
    return {
      ok: false,
      error: "Agent: subagents are unavailable in this context.",
    };
  }

  // Run the child loop through the port. Coarse progress is bridged into the
  // parent's stream as subagent_* events via ctx.emit (design §3.2/§3.3), each
  // carrying THIS Agent call's toolCallId so the desktop card correlates them.
  // The dispatcher turns any throw into an error-outcome, so the loop stays sound.
  //
  // Presentation accumulation (TASK.102 slice S1 W3, CUT-S1 §3 W3): the
  // accumulator is fed from every progress callback UNCONDITIONALLY — it
  // must survive even when ctx.emit is absent (a handler running outside
  // the batch runner still needs a persisted card). Feeding it the SAME
  // mapped event ctx.emit receives keeps the persisted activity entries
  // byte-identical to what the live renderer saw.
  let acc = createSubagentCardAccumulator();
  const outcome = await ctx.subagents.run(
    {
      agentType,
      description: input.description,
      prompt: input.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    },
    {
      signal: ctx.abortSignal,
      onProgress: (progress) => {
        const event = mapProgressToEvent(progress, ctx.toolCallId);
        acc = reduceSubagentCardEvent(acc, event);
        ctx.emit?.(event);
      },
    },
  );
  // Terminal snapshot, or null when the child never reached subagent_start
  // (an early failure before the first progress callback — the card is
  // never fabricated from nothing, CUT-S1 §3 W1). The fallback status/
  // durationMs cover the case where the port settled without ever sending
  // an end-progress (e.g. a throw in the runner).
  const snapshot = finalizeSubagentCard(acc, { status: outcome.status, durationMs: outcome.durationMs });
  const presentation: { presentation?: ToolResultPresentation } =
    snapshot !== null ? { presentation: { subagent: snapshot } } : {};
  return outcomeToResult(outcome, presentation);
}

/**
 * Session tier (TASK.102 CUT-S2 §2.1/§2.2). Fail-closed when the host wired
 * no SessionSubagentPort — this is non-recursion lock #2 firing at runtime
 * (buildChildConfig never copies `sessionSubagents`, so every child session
 * lands here even though its restricted SCHEMA already made "session"
 * unreachable — belt and suspenders, CUT-S2 §0.2).
 *
 * `engineProfile` (TASK.102 CUT-S4 §2.2), when present, is the caller's proof
 * the routing branch above already resolved agentType to a foreign-engine
 * md-profile: the request's prompt becomes the persona body + the caller's
 * own prompt (byte-identical to the one-shot composition subagents/runner.ts
 * built for EngineChildSpec.prompt — I3) and `engine` is stamped onto the
 * request. Every other field/behavior below is unchanged.
 */
async function runSessionTier(
  input: AgentInput,
  ctx: ToolContext,
  agentType: string,
  engineProfile?: EngineProfileInfo,
): Promise<ToolResult<AgentOutput>> {
  if (!ctx.sessionSubagents) {
    return {
      ok: false,
      error: "Agent: session-tier subagents are unavailable in this host.",
    };
  }

  // spawnToolCallId is core's own fact, not a relay (CUT-S2 §10.5): this
  // Agent tool_call's own ctx.toolCallId, minted by the dispatcher before
  // this handler ever ran. Stamped verbatim — never a freshly-generated id,
  // never left to the host to invent.
  const request: SessionSubagentRequest = {
    agentType,
    description: input.description,
    prompt:
      engineProfile !== undefined ? `${engineProfile.systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt,
    spawnToolCallId: ctx.toolCallId,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(engineProfile !== undefined ? { engine: engineProfile.engine } : {}),
    // TASK.145 срез 1: only ever `true` here — the validation check above
    // already refused `detach:true` on any tier but "session", and `false`/
    // absent is dropped rather than riding the wire as an explicit `false`
    // (byte-compatible default, same discipline as every other optional
    // field on this request).
    ...(input.detach === true ? { detach: true } : {}),
  };

  // Same accumulation/bridge discipline as the inline tier above — the
  // mapProgressToEvent bridge is shared (including the "attention" case,
  // CUT-S2 §2.2 — only a session-tier port ever produces one).
  let acc = createSubagentCardAccumulator();
  const outcome = await ctx.sessionSubagents.run(request, {
    signal: ctx.abortSignal,
    onProgress: (progress) => {
      const event = mapProgressToEvent(progress, ctx.toolCallId);
      acc = reduceSubagentCardEvent(acc, event);
      ctx.emit?.(event);
    },
  });

  // Round-trip check (F14, ports/session-subagent.ts docstring): core OWNS
  // spawnToolCallId — it minted it as ctx.toolCallId and stamped it onto the
  // request above — so the host is required to hand back exactly that string,
  // never a value of its own choosing. This is asserted, not assumed: a host
  // that fails to round-trip it correctly cannot be trusted for the two ids
  // that ride alongside it either (childSessionId/parentSessionId — core has
  // no independent way to verify those), so the whole delegation fails closed
  // rather than let a corrupted id reach the persisted target, the
  // relation-store key, or any downstream `(parentSessionId, spawnToolCallId)`
  // lookup keyed by it.
  if (outcome.spawnToolCallId !== request.spawnToolCallId) {
    return {
      ok: false,
      error:
        `Agent: the session host returned a mismatched spawn identity (sent "${request.spawnToolCallId}", ` +
        `got "${outcome.spawnToolCallId}").`,
    };
  }

  // The three ids ride ONLY the presentation target (CUT-S2 §2.1: "core их
  // только копирует в target и НЕ изобретает") — core relays exactly what
  // the host's accepted-relay + its own sessionId already know, never
  // fabricating any of the three.
  const target: SubagentCardTarget = {
    kind: "session",
    childSessionId: outcome.childSessionId,
    parentSessionId: outcome.parentSessionId,
    spawnToolCallId: outcome.spawnToolCallId,
  };
  const snapshot = finalizeSubagentCard(acc, { status: outcome.status, durationMs: outcome.durationMs }, target);
  const presentation: { presentation?: ToolResultPresentation } =
    snapshot !== null ? { presentation: { subagent: snapshot } } : {};
  return outcomeToResult(outcome, presentation);
}

/** Inline-only, byte-compatible with the pre-B1 constant export (CUT-S2 §2.1). */
export const agentTool: ToolDefinition<AgentInput, AgentOutput> = createAgentTool();

/**
 * Projects a coarse SubagentProgress onto the matching subagent_* AgentEvent,
 * stamping the Agent tool call's id (design §3.3). The three variants map 1:1;
 * the status/counter unions already align with the event shapes. Typed as
 * SubagentCardEvent (a strict subset of ToolEmittedEvent — the subagent_*
 * variants only) rather than the broader ToolEmittedEvent: this lets the
 * result feed directly into reduceSubagentCardEvent (card-snapshot.ts,
 * TASK.102 slice S1 W3) without a cast, while remaining assignable wherever
 * ToolEmittedEvent is expected (ctx.emit below).
 */
function mapProgressToEvent(progress: SubagentProgress, toolCallId: string): SubagentCardEvent {
  switch (progress.kind) {
    case "start":
      return {
        type: "subagent_start",
        toolCallId,
        agentType: progress.agentType,
        description: progress.description,
        ...(progress.model !== undefined ? { model: progress.model } : {}),
        ...(progress.engine !== undefined ? { engine: progress.engine } : {}),
      };
    case "progress":
      return {
        type: "subagent_progress",
        toolCallId,
        turns: progress.turns,
        toolCalls: progress.toolCalls,
        lastTool: progress.lastTool,
      };
    case "tool":
      // Defense-in-depth cap at the trust boundary onto the wire (W1-FIX,
      // FIX-2): the concrete runner already sanitizes/caps toolName+summary,
      // but ANY SubagentPort could push an oversized value here — this bridge
      // is the last chokepoint before WireAgentEvent/host replay, so it
      // re-applies the SAME sanitize+cap helper the runner's summarizer uses
      // (shared function => the two trust boundaries can never disagree).
      return {
        type: "subagent_activity",
        toolCallId,
        toolName: sanitizeAndCap(progress.toolName, SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS),
        summary: sanitizeAndCap(progress.summary, SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS),
      };
    case "end":
      return {
        type: "subagent_end",
        toolCallId,
        status: progress.status,
        turns: progress.turns,
        durationMs: progress.durationMs,
        ...(progress.activitySuppressed !== undefined ? { activitySuppressed: progress.activitySuppressed } : {}),
        // TASK.171: the requested id (same field/semantics as subagent_start's
        // `model`) and the provider's own claim (`responseModel`) are two
        // distinct, independently-optional fields — never conflated.
        ...(progress.model !== undefined ? { model: progress.model } : {}),
        ...(progress.responseModel !== undefined ? { responseModel: progress.responseModel } : {}),
      };
    case "attention":
      return {
        type: "subagent_attention",
        toolCallId,
        waiting: progress.waiting,
      };
  }
}

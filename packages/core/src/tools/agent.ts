/**
 * Agent tool (Phase 3 slice 3.1, design §3.4): spawns an in-process subagent
 * via ctx.subagents (a SubagentPort) and returns its outcome as a normal tool
 * result. The tool lives BELOW loop/ and never imports AgentLoop — the port is
 * the only seam (§3.1).
 *
 * Outcome mapping: only `completed` is a full success. `max_turns`
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
 * slice 1 adds `detach` (session-tier only, same "FULL declaration
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
 * CUT-S2 §2.1/§3 B1 widens this into a FACTORY, `createAgentTool`.
 * A single handler now branches on `tier`: "inline" (explicit on session hosts, unchanged
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

import { inlineChildStatusStore } from "../subagents/status.js";
import type { ToolContext, ToolDefinition, ToolMetadata, ToolResult } from "../types/tools.js";
import type { EngineProfileInfo } from "../ports/subagent.js";
import {
  buildRoleRouteRequestFields,
  formatRoleDegradeNotice,
  formatRoleFallbackNotice,
  type RoleRouteResolution,
} from "../subagents/role-route.js";
import type { SessionSubagentRequest } from "../ports/session-subagent.js";
import { SUBAGENT_OUTPUT_MAX_BYTES, SUBAGENT_TIME_BUDGET_MS } from "../types/config.js";
import { getPersona, isKnownPersona, listPersonaNames, ROLE_TURN_BUDGETS, type RolePersonaName } from "../subagents/personas.js";
import {
  buildSessionSubagentRequest,
  engineRestrictionRefusal,
  formatResultForModel,
  mapProgressToEvent,
  outcomeToResult,
} from "../subagents/agent-bridge.js";
import {
  createSubagentCardAccumulator,
  finalizeSubagentCard,
  reduceSubagentCardEvent,
} from "../subagents/card-snapshot.js";
import type { SubagentCardTarget, ToolResultPresentation } from "../types/subagent-card.js";
import { agentInputSchema, restrictedAgentInputSchema, type AgentInput, type AgentOutput } from "./schemas.js";

// slice S1 (F9): outcomeToResult/formatResultForModel/mapProgressToEvent
// moved to subagents/agent-bridge.ts so the in-process MCP bridge (host-side,
// slice S3+) runs a claude-CLI-initiated subagent call through the exact same
// projection code — re-exported here so anything importing them off this
// module (the natural place to look for them) keeps working.
export { formatResultForModel, mapProgressToEvent, outcomeToResult };

/** Persona used when the model omits agent_type. */
const DEFAULT_AGENT_TYPE = "general-purpose";

/** Base description shared by both declarations (CUT-S2 §2.1); sessionTier:true appends one sentence. */
const BASE_DESCRIPTION =
  'Delegate a task to a subagent. agent_type "explore" = read-only recon that can read files and Git history with Git, but cannot run commands; use general-purpose for work needing Bash; "general-purpose" = the subtask needs write/exec tools. Delegate only distinct, necessary work; avoid duplicate investigations and batch related questions. At most four new children may be started per turn. Independent Agent calls issued together run concurrently. Use AgentStatus to inspect your children’s live progress. For a single known-file fact, Read/Grep it yourself; once delegated, do not redo the search.';

const SESSION_TIER_DESCRIPTION_SUFFIX =
  ' By default, starts a session child in the background and returns immediately with its id. Continue useful work or end your turn; the report arrives as a new turn. AgentStatus can inspect progress. Session children enforce profile restrictions on core connections. Use tier "inline" for short lookups whose result you need in this turn. Explicit tier "session" also starts in the background by default. Set detach false to wait, with automatic background handoff after a long wait. send_to delivers a follow-up to your own still-running session child.';

// Restricted hosts (CLI, child sessions) can never honor a connection/engine
// routing decision, so the description says so up front — a caller that reads
// it never burns a turn trying a type the refusals below would reject. Same
// vocabulary as those refusals, and (like the restricted schema's own tier
// description) no mention of the undiscoverable session tier.
const RESTRICTED_DESCRIPTION_SUFFIX =
  " In this context agent types that select their own connection or engine cannot be spawned — do the work yourself or use a type without its own connection.";

/**
 * The agent types this caller can actually reach on the inline tier, for the
 * actionable tail of a connection-routing refusal: no engine profile, no
 * profile routing, and a role route whose resolved entry does not pin a
 * connection/engine — the same conditions those refusals fire on. Advisory
 * only (a tail on a refusal, never a substitute for it); a port without the
 * probes yields an empty list and the tail is omitted.
 */
function inlineSpawnableTypes(ctx: ToolContext, available: string[]): string[] {
  return available.filter((type) => {
    if ((ctx.subagents?.engineProfile?.(type) ?? null) !== null) return false;
    if ((ctx.subagents?.profileRouting?.(type) ?? null) !== null) return false;
    const resolved = ctx.subagents?.resolveRoleRoute?.(type)?.entries[0];
    return resolved === undefined || (resolved.connection === undefined && resolved.engine === undefined);
  });
}

/**
 * The restricted declaration's connection-routing refusal. The full
 * declaration's arm can honestly say `call it with tier "session"`; the
 * restricted arm must not (its schema cannot discover that tier, so following
 * the advice is impossible — the retry-loop shape the routing refusals once
 * had). It names the honest alternatives instead and, when the port can tell,
 * the concrete types that CAN run here.
 */
function restrictedConnectionRefusal(agentType: string, ctx: ToolContext, available: string[]): string {
  const spawnable = inlineSpawnableTypes(ctx, available);
  const tail = spawnable.length > 0 ? ` Types that can be spawned inline here: ${spawnable.join(", ")}.` : "";
  return `Agent: profile "${agentType}" selects its own connection and cannot be spawned from here. Use a persona without its own connection inline, or do the work yourself.${tail}`;
}

export interface CreateAgentToolOptions {
  /**
   * true: the FULL declaration (`agentInputSchema` — `tier`/`provider` reach
   * "session") for the root desktop host, the only concrete
   * SessionSubagentPort implementer (CUT-S2 §2.6.1). false/absent (default):
   * the RESTRICTED declaration (`restrictedAgentInputSchema` — `tier` can only ever be `"inline"`) for CLI, every child session,
   * and any other host that never wires a SessionSubagentPort — the schema
   * itself is non-recursion lock #1 of 3 (CUT-S2 §0.2/§5.13): a model talking
   * to a restricted host cannot even DISCOVER the session tier exists.
   */
  sessionTier?: boolean;
}

function buildMetadata(sessionTier: boolean): ToolMetadata {
  return {
    name: "Agent",
    description: sessionTier ? BASE_DESCRIPTION + SESSION_TIER_DESCRIPTION_SUFFIX : BASE_DESCRIPTION + RESTRICTED_DESCRIPTION_SUFFIX,
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
 * Builds the Agent tool. `sessionTier:false` (default) is the RESTRICTED
 * declaration; `sessionTier:true` is the FULL one (CUT-S2 §2.1). Both share
 * ONE handler — the branch on the resolved tier below, not a second copy of the
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
      const engineProfile = ctx.subagents?.engineProfile?.(agentType) ?? null;
      const tier = engineProfile !== null ? "session" : input.tier ?? (sessionTier ? "session" : "inline");
      const detach = tier === "session" && input.send_to === undefined &&
        (input.detach ?? true);

      // Hosts without inline route discovery can only select providers for session children.
      if (input.provider !== undefined && tier !== "session" && !ctx.subagents?.supportsInlineProvider) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "provider" is only valid with tier "session". See the using-subagents skill.',
        };
      }

      // slice 1: same precedent as the provider check above — an
      // explicit `detach:true` on a tier that cannot honor it (only
      // "session" spawns a real child process to detach FROM) is a fail-fast
      // invalid_input, not a silent downgrade to sync-join. `detach:false`
      // (or absent) is a no-op on any tier, so it is never rejected here —
      // only an ACTUAL request for background semantics can conflict with
      // the tier.
      if (input.detach === true && (input.tier === "inline" || tier !== "session")) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "detach" is only valid with tier "session". See the using-subagents skill.',
        };
      }

      // `continue_session` is session-tier only (a resumed child is
      // a full child session by construction) and cannot re-target a
      // connection — the resumed child keeps the one it was started on
      // (mirrors main's CHILD_RESUME_OVERRIDE_MESSAGE contract). `model` is
      // NOT rejected here: like the agent bridge, a continuation ignores it.
      if (input.continue_session !== undefined && tier !== "session") {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "continue_session" is only valid with tier "session". See the using-subagents skill.',
        };
      }
      if (input.continue_session !== undefined && input.provider !== undefined) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error:
            'Agent: "continue_session" cannot be combined with "provider" — the resumed child keeps the connection it was started on.',
        };
      }

      // wire: `send_to` addresses a STILL-RUNNING own
      // child — the running twin of `continue_session` (finished-only). Same
      // fail-fast precedent as provider/detach/continue_session above: it is
      // session-tier-only and must stand ALONE (no provider/detach/
      // continue_session on the same call), since a delivered follow-up
      // selects no connection, detaches nothing, and resumes nothing.
      if (input.send_to !== undefined && (tier !== "session" || input.provider !== undefined || input.detach === true || input.continue_session !== undefined)) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: 'Agent: "send_to" is only valid with tier "session", alone (no provider/detach/continue_session). See the using-subagents skill.',
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
          error: `Unknown agent_type "${agentType}". Available agent types: ${available.join(", ")}. See the using-subagents skill.`,
        };
      }

      if (input.continue_session === undefined && input.send_to === undefined && ctx.admitSubagent?.() === false) {
        return { ok: false, errorKind: "invalid_input", error: "Agent: this turn already attempted four child launches. Use their results or continue in a later turn." };
      }

      // Engine-profile routing (CUT-S4 §2.2), BEFORE the tier branch:
      // an md-profile declaring `engine:` frontmatter no longer runs as a
      // bare one-shot foreign CLI call (the permission-gate hole S4 closes) —
      // it always runs as a child SESSION instead, through the exact same
      // SessionSubagentPort contract as an explicit `tier:"session"` call.
      const restricted = (ctx.subagents?.hasSessionRestrictions?.(agentType) ?? false) ||
        (ctx.subagents?.sessionRestrictions?.(agentType)?.readOnly ?? ["explore", "planner", "reviewer"].includes(agentType));
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
        // continuations are core-child-only, same refusal the
        // agent bridge (agent-bridge.ts) gives for an engine entry.
        if (input.continue_session !== undefined) {
          return {
            ok: false,
            errorKind: "invalid_input",
            error: `Agent: continue_session is supported only for AnyCode (core) profiles; "${agentType}" runs on ${engineProfile.engine}. Start a new call instead.`,
          };
        }
        // a running follow-up is core-child-only too — engine
        // children are not addressable yet (out-of-scope #2), same family of
        // refusal as continue_session above.
        if (input.send_to !== undefined) {
          return {
            ok: false,
            errorKind: "invalid_input",
            error: `Agent: send_to is supported only for AnyCode (core) children; "${agentType}" runs on ${engineProfile.engine}. Start a new call instead.`,
          };
        }
        // Fail-closed: without a SessionSubagentPort an engine profile cannot
        // run at all — the one-shot in-process fallback no longer exists.
        if (!ctx.sessionSubagents) {
          return {
            ok: false,
            error:
              `Agent: agent type "${agentType}" runs on the "${engineProfile.engine}" engine; engine agents run ` +
              `as child sessions and are unavailable in this host. Use a persona without its own connection inline, or do the work yourself.`,
          };
        }
        // a settings-derived role whose PRIMARY is an engine entry
        // carries the engine profile too. When its route chain is cooling the
        // profile's engine/model must not run the dead primary: an exhausted
        // chain degrades to the parent's model (no engine/model stamped, the
        // role body kept, a notice), a cooling primary with a healthy fallback
        // runs that entry through the route stamping. A healthy primary (no
        // skips) and a md-claimed profile (null route) keep the profile request.
        const engineRoute = ctx.subagents?.resolveRoleRoute?.(agentType) ?? null;
        const selectsNative = engineRoute === null || engineRoute.skipped.length === 0 || engineRoute.entries[0]?.engine !== undefined;
        if (restricted && selectsNative) {
          return { ok: false, errorKind: "invalid_input", error: engineRestrictionRefusal(agentType, engineProfile.engine, ctx.subagents?.isMdProfile?.(agentType) === true) };
        }
        if (engineRoute !== null && engineRoute.skipped.length > 0) {
          const degrade = {
            systemPrompt: engineProfile.systemPrompt,
            notice:
              engineRoute.entries.length === 0
                ? formatRoleDegradeNotice(agentType, engineRoute.skipped)
                : formatRoleFallbackNotice(agentType, engineRoute.skipped),
          };
          return runSessionTier(input, ctx, agentType, undefined, undefined, engineRoute, detach, degrade);
        }
        // tier is IGNORED for an engine profile: it always runs as a session,
        // a silent inline->session upgrade rather than a tier:"inline" refusal
        // — the migration this slice performs.
        return runSessionTier(input, ctx, agentType, engineProfile, undefined, undefined, detach);
      }

      // Profile connection routing. A routed md-profile declares
      // its own connection (`connection:` exact id, or `provider:` catalog id);
      // that declaration is AUTHORITATIVE. An explicit `provider` argument is
      // refused rather than allowed to win — the argument winning would mask the
      // profile's declared target, the dishonesty class this task forbids. The
      // routing is resolved here, once, and handed to the session tier; the
      // inline tier has no session host to prepare a connection, so a routed
      // profile is refused there too.
      const routing = ctx.subagents?.profileRouting?.(agentType) ?? null;
      if (routing !== null && input.provider !== undefined) {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: `Agent: "provider" cannot be combined with profile "${agentType}" — the profile selects its own connection; omit "provider".`,
        };
      }
      if (routing !== null && tier !== "session") {
        return {
          ok: false,
          errorKind: "invalid_input",
          error: sessionTier
            ? `Agent: profile "${agentType}" selects its own connection and runs as a child session; call it with tier "session".`
            : restrictedConnectionRefusal(agentType, ctx, available),
        };
      }

      // §3.2/§3.6: role-route resolution (settings roles +
      // host health cache). Returns null for everything but a ROLE persona
      // with configured roles — built-in defaults apply then.
      const roleRoute = ctx.subagents?.resolveRoleRoute?.(agentType) ?? null;
      if (tier === "session" && restricted && roleRoute?.entries[0]?.engine !== undefined &&
          input.continue_session === undefined && input.send_to === undefined) {
        return { ok: false, errorKind: "invalid_input", error: engineRestrictionRefusal(agentType, roleRoute.entries[0]!.engine, ctx.subagents?.isMdProfile?.(agentType) === true) };
      }
      if (roleRoute !== null) {
        // An entry carrying connection/engine selects its own connection —
        // the inline tier cannot honor it (same 4269 refusal shape). F9
        // (cross-review): only the RESOLVED entry (entries[0] — the one this
        // spawn would actually run on) decides; a connection-tail behind a
        // healthy bare-model head never blocks an inline run.
        const resolved = roleRoute.entries[0];
        if (
          tier !== "session" &&
          resolved !== undefined &&
          (resolved.connection !== undefined || resolved.engine !== undefined)
        ) {
          return {
            ok: false,
            errorKind: "invalid_input",
            error: sessionTier
            ? `Agent: profile "${agentType}" selects its own connection and runs as a child session; call it with tier "session".`
            : restrictedConnectionRefusal(agentType, ctx, available),
          };
        }
      }


      if (tier === "session") {
        return runSessionTier(
          input,
          ctx,
          agentType,
          undefined,
          routing ?? undefined,
          roleRoute ?? undefined,
          detach,
          undefined,
          input.tier === undefined && input.provider === undefined && !detach && input.continue_session === undefined && input.send_to === undefined && routing === null && !(roleRoute?.entries[0]?.connection || roleRoute?.entries[0]?.engine || roleRoute?.entries[0]?.provider),
        );
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
  // Presentation accumulation (slice S1 W3, CUT-S1 §3 W3): the
  // accumulator is fed from every progress callback UNCONDITIONALLY — it
  // must survive even when ctx.emit is absent (a handler running outside
  // the batch runner still needs a persisted card). Feeding it the SAME
  // mapped event ctx.emit receives keeps the persisted activity entries
  // byte-identical to what the live renderer saw.
  let acc = createSubagentCardAccumulator();
  const status = inlineChildStatusStore(ctx.subagents);
  const id = ctx.toolCallId;
  status.start(id, input.description);
  let outcome;
  try {
    outcome = await ctx.subagents.run(
      {
        agentType,
        description: input.description,
        prompt: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      },
      {
        signal: ctx.abortSignal,
        onStatusItem: (item, currentTool) => {
          status.append(id, item);
          if (currentTool !== undefined) status.update(id, { currentTool });
          else if (item.kind === "result") status.update(id, { currentTool: undefined });
        },
        onApproval: (waiting, toolName) => status.update(id, { state: waiting ? "waiting for approval" : "running", ...(waiting && toolName ? { currentTool: toolName } : {}) }),
        onStatusReset: () => status.resetAssistant(id),
        onProgress: (progress) => {
          if (progress.kind === "progress") status.update(id, { turns: progress.turns, toolCalls: progress.toolCalls });
          const event = mapProgressToEvent(progress, ctx.toolCallId);
          acc = reduceSubagentCardEvent(acc, event);
          ctx.emit?.(event);
        },
      },
    );
  } catch (error) {
    status.update(id, { state: "failed", endedAt: Date.now(), currentTool: undefined });
    throw error;
  }
  status.update(id, { state: outcome.status === "completed" ? "completed" : "failed", turns: outcome.turns, toolCalls: outcome.toolCalls, endedAt: Date.now(), currentTool: undefined });
  // Terminal snapshot, or null when the child never reached subagent_start
  // (an early failure before the first progress callback — the card is
  // never fabricated from nothing, CUT-S1 §3 W1). The fallback status/
  // durationMs cover the case where the port settled without ever sending
  // an end-progress (e.g. a throw in the runner).
  const snapshot = finalizeSubagentCard(acc, {
    status: outcome.status,
    durationMs: outcome.durationMs,
    ...(outcome.finalTurnFinishReason === "length" ? { finalTurnFinishReason: "length" } : {}),
  });
  const presentation: { presentation?: ToolResultPresentation } =
    snapshot !== null ? { presentation: { subagent: snapshot } } : {};
  return outcomeToResult(outcome, presentation);
}

/**
 * Session tier (CUT-S2 §2.1/§2.2). Fail-closed when the host wired
 * no SessionSubagentPort — this is non-recursion lock #2 firing at runtime
 * (buildChildConfig never copies `sessionSubagents`, so every child session
 * lands here even though its restricted SCHEMA already made "session"
 * unreachable — belt and suspenders, CUT-S2 §0.2).
 *
 * `engineProfile` (CUT-S4 §2.2), when present, is the caller's proof
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
  routing?: { provider?: string; connection?: string },
  roleRoute?: RoleRouteResolution,
  detach = false,
  degrade?: { systemPrompt: string; notice: string },
  fallbackAtCapacity = false,
): Promise<ToolResult<AgentOutput>> {
  if (!ctx.sessionSubagents) {
    return {
      ok: false,
      error: "Agent: session-tier subagents are unavailable in this host. See the using-subagents skill.",
    };
  }

  // wire: a send_to call DELIVERS instead of spawning
  // — the entire request-build machinery below is for a spawn/continuation
  // and never runs for one. The handler's earlier validation already
  // guaranteed send_to stands alone (tier session, no provider/detach/
  // continue_session); `agentType` was validated above, so this call also
  // rejects an unknown agent_type before delivering — same fail-fast as any
  // other call shape. Cross-review Finding 1: `send` is now
  // REQUIRED on SessionSubagentPort, so the interface seam is enforced at
  // compile time — no fail-closed branch for a missing method here anymore.
  // Mirrors AgentOutput's field set (schemas.ts) for a delivery that ran zero
  // turns itself.
  if (input.send_to !== undefined) {
    const sent = await ctx.sessionSubagents.send({ childSessionId: input.send_to, text: input.prompt }, { signal: ctx.abortSignal });
    if (!sent.ok) {
      return { ok: false, error: sent.message };
    }
    return {
      ok: true,
      output: {
        status: "completed",
        finalText: `Agent: message delivered to running child ${input.send_to}; it will run as the child's next input.`,
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
      },
    };
  }

  // spawnToolCallId is core's own fact, not a relay (CUT-S2 §10.5): this
  // Agent tool_call's own ctx.toolCallId, minted by the dispatcher before
  // this handler ever ran. Stamped verbatim — never a freshly-generated id,
  // never left to the host to invent.
  //
  // Model precedence (model plumbing fix): an explicit `Agent(model: …)`
  // argument outranks the profile's own `model:` frontmatter, which is only
  // a DEFAULT — same precedence the inline/one-shot path already established
  // (subagents/runner.ts — `req.model ?? persona.model`). Absent both, no
  // model key rides the request at all.
  //
  // slice S1: the request itself is built by the SHARED
  // buildSessionSubagentRequest (subagents/agent-bridge.ts) so a
  // claude-CLI-initiated subagent call goes through byte-identical
  // composition — `provider`/`detach` stay this tool's own fields (agent-
  // bridge.ts never sets either), spread on afterward.
  const resumeChildSessionId = input.continue_session;
  const builtinRole = (["planner", "executor", "reviewer"] as string[]).includes(agentType) ? agentType as RolePersonaName : undefined;
  const configuredCoreProfile = engineProfile === undefined && degrade === undefined
    ? ctx.subagents?.coreProfile?.(agentType) ?? undefined : undefined;
  const useBuiltinRole = configuredCoreProfile === undefined && engineProfile === undefined && degrade === undefined && roleRoute === undefined && builtinRole !== undefined;
  const coreProfile = configuredCoreProfile ?? (useBuiltinRole ? { systemPrompt: getPersona(builtinRole).systemPrompt } : undefined);
  const sessionBudget = engineProfile?.turnBudget ?? ctx.subagents?.sessionTurnBudget?.(agentType) ??
    (useBuiltinRole ? ROLE_TURN_BUDGETS[builtinRole] : undefined);
  const profileEffort = engineProfile?.effort ?? (roleRoute === undefined ? coreProfile?.effort : undefined);
  const resolvedRestrictions = ctx.subagents?.sessionRestrictions?.(agentType) ?? undefined;
  if (resumeChildSessionId === undefined && engineProfile === undefined && resolvedRestrictions === undefined && ctx.subagents?.hasSessionRestrictions?.(agentType)) {
    return { ok: false, errorKind: "invalid_input", error: `Agent: profile "${agentType}" restrictions are unavailable for this child session.` };
  }
  const restrictions = resolvedRestrictions ??
    (ctx.subagents?.sessionRestrictions === undefined && isKnownPersona(agentType) && ["explore", "planner", "reviewer"].includes(agentType)
      ? { tools: [...getPersona(agentType).tools], readOnly: true } : undefined);
  const request: SessionSubagentRequest = {

    // a continuation branches the request build rather than
    // post-patching the spread — a resumed child keeps its own profile body
    // and model (both already in its history), so NEITHER a model override
    // NOR the profile's own defaults ride the request: model AND profile are
    // passed undefined (supervisor correction 2: no profile-default model,
    // no repeated system prompt). `model` on the input is ignored, not
    // rejected. A fresh spawn builds the request exactly as before.
    ...(resumeChildSessionId !== undefined
      ? buildSessionSubagentRequest({
          agentType,
          description: input.description,
          prompt: input.prompt,
          model: undefined,
          spawnToolCallId: ctx.toolCallId,
        })
      : buildSessionSubagentRequest({
          agentType,
          description: input.description,
          // a degraded engine-role spawn carries no profile
          // (so no engine/model rides), but keeps the role body in the prompt
          // with the same composition buildSessionSubagentRequest uses.
          prompt: degrade !== undefined ? `${degrade.systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt,
          model: input.model,
          spawnToolCallId: ctx.toolCallId,
          ...(restrictions !== undefined ? { restrictions } : {}),
          profile: engineProfile ?? (coreProfile !== undefined && roleRoute !== undefined
            ? { systemPrompt: coreProfile.systemPrompt }
            : coreProfile),
          // the profile's own turn budget rides the creating spawn only.
          ...(sessionBudget !== undefined ? { maxTurns: sessionBudget } : {}),
          // A role route supplies its own effort; otherwise preserve the profile's
          // selection for the destination model to resolve at child boot.
          ...(profileEffort !== undefined ? { effort: profileEffort } : {}),
        })),
    ...(resumeChildSessionId !== undefined ? { resumeChildSessionId } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    // a routed profile's declared target rides the CREATING spawn
    // only; a continuation keeps the child's original connection (main resumes
    // the child's own pin and never re-reads routing). Exactly one of these two
    // keys can be present — the parser refuses both-keys profiles and the
    // handler above refused a routed profile with an explicit `provider`.
    //
    // R6 (cross-review): a role-route resolution (settings
    // roles) REPLACES the profile-routing fields below rather than merging
    // with them — the runSessionTier signature threads roleRoute AFTER
    // routing for exactly this reason (TS spread order = precedence order):
    // a settings-derived role persona whose primary carries a connection
    // ALSO makes profileRouting non-null (the derived persona's frontmatter
    // mirrors the primary), and merging would stamp BOTH the profile's
    // connectionId AND the route's provider on one request. The route entry
    // (health-filtered, respawn-bookkept host-side) is the authoritative
    // target for a role spawn; the profile routing stays authoritative only
    // when no role route resolved.
    ...(resumeChildSessionId === undefined && routing?.provider !== undefined && roleRoute === undefined ? { provider: routing.provider } : {}),
    ...(resumeChildSessionId === undefined && routing?.connection !== undefined && roleRoute === undefined ? { connectionId: routing.connection } : {}),
    // §3.3: the role route's resolved FIRST entry stamps the
    // fresh spawn exactly like `routing` above (R6: and REPLACES it — the
    // guarded spreads above skip the routing keys when a role route
    // resolved, so exactly ONE of the two mechanisms stamps this request) —
    // provider/connection/model/effort and (closing the gap that only engine
    // profiles stamped it) maxTurns from roleRoute.turnBudget. An explicit
    // Agent(model:) still wins over the entry's model (existing precedence —
    // buildSessionSubagentRequest applies input.model first; the entry model
    // only rides as a default when the caller passed none). R7: the
    // routeStamped flag marks a spawn whose routing fields came from the
    // ROUTE (not the caller) so the host's respawn bookkeeping never
    // mistakes a caller's coincidentally-equal explicit model for a chain
    // hop — set exactly when every stamping spread below fired, i.e. the
    // caller passed neither provider nor model.
    // the field set itself lives in the shared pure helper
    // (subagents/role-route.ts) so the workflow engine's engine-role steps
    // stamp the same fields from the same code.
    ...(resumeChildSessionId === undefined
      ? buildRoleRouteRequestFields(roleRoute, {
          provider: input.provider,
          model: input.model,
          engineTurnBudget: engineProfile?.turnBudget,
          degraded: degrade !== undefined,
        })
      : {}),
    ...(detach ? { detach: true } : { allowBackgroundHandoff: true }),
    ...(fallbackAtCapacity ? { fallbackAtCapacity: true as const } : {}),
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

  if (fallbackAtCapacity && outcome.capacityRefused === true && outcome.spawnToolCallId === request.spawnToolCallId) {
    return runInlineTier(input, ctx, agentType);
  }

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

  // The three ids ride ONLY the presentation target (CUT-S2 §2.1: "core
  // only copies them into the target and does NOT invent them") — core relays exactly what
  // the host's accepted-relay + its own sessionId already know, never
  // fabricating any of the three.
  const target: SubagentCardTarget = {
    kind: "session",
    childSessionId: outcome.childSessionId,
    parentSessionId: outcome.parentSessionId,
    spawnToolCallId: outcome.spawnToolCallId,
  };
  // GitHub #17 slice D: an admitted/handed-off child is still
  // running — this result reports the DISPATCH. No terminal card is finalized
  // (that would claim completed work); the host continues to relay the
  // running child’s lifecycle independently of this tool call.
  // a role-route notice (degraded or fallback spawn) rides the
  // model-visible text on a FRESH spawn only — a resume keeps its own history.
  const notice =
    degrade?.notice ??
    (resumeChildSessionId === undefined && roleRoute !== undefined && roleRoute.entries.length === 0 && roleRoute.skipped.length > 0
      ? formatRoleDegradeNotice(agentType, roleRoute.skipped)
      : undefined);
  const shown =
    notice !== undefined
      ? { ...outcome, finalText: outcome.finalText ? `${notice}\n\n${outcome.finalText}` : notice }
      : outcome;
  if (outcome.background !== undefined) {
    const handoffPresentation: { presentation?: ToolResultPresentation } = {
      presentation: {
        subagentHandoff: {
          target: {
            kind: "session",
            childSessionId: outcome.childSessionId,
            parentSessionId: outcome.parentSessionId,
            spawnToolCallId: outcome.spawnToolCallId,
          },
          reason: outcome.background.reason,
        },
      },
    };
    return outcomeToResult(shown, handoffPresentation);
  }
  const snapshot = finalizeSubagentCard(acc, {
    status: outcome.status,
    durationMs: outcome.durationMs,
    ...(outcome.finalTurnFinishReason === "length" ? { finalTurnFinishReason: "length" } : {}),
  }, target);
  const presentation: { presentation?: ToolResultPresentation } =
    snapshot !== null ? { presentation: { subagent: snapshot } } : {};
  return outcomeToResult(shown, presentation);
}

/** Inline-only, byte-compatible with the pre-B1 constant export (CUT-S2 §2.1). */
export const agentTool: ToolDefinition<AgentInput, AgentOutput> = createAgentTool();

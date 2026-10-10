/**
 * Agent MCP-bridge core logic (TASK.226 срез S1, план §3.1-3.4, факт F9).
 *
 * Pulls the request-building and outcome-projection logic OUT of
 * tools/agent.ts so both consumers run through the exact same code: the
 * native Agent tool's session tier (tools/agent.ts's runSessionTier) and the
 * in-process MCP server the desktop host exposes to a claude-CLI child over
 * its control channel (host/engines/claude/mcp-bridge.ts, срез S3+). A
 * request built here is byte-identical regardless of which door it came
 * through, and the text a model reads back is the SAME string either way —
 * `outcomeToResult`/`formatResultForModel`/`mapProgressToEvent` below are
 * re-exported from tools/agent.ts rather than duplicated (§3.4).
 *
 * Deliberately import-free of the ai-SDK, Node's runtime APIs and the MCP SDK
 * (§3.4: "Ни SDK, ни Node") — this is a pure logic module the host's
 * transport glue (mcp/in-process-server.ts срез S2, mcp-bridge.ts срез S3)
 * wraps, never the other way around.
 */

import { z } from "zod";
import type { EngineProfileInfo, SubagentOutcome, SubagentProgress } from "../ports/subagent.js";
import type {
  SessionSubagentOutcome,
  SessionSubagentPort,
  SessionSubagentRequest,
} from "../ports/session-subagent.js";
import type { ToolResult } from "../types/tools.js";
import type { SubagentCardTarget, ToolResultPresentation } from "../types/subagent-card.js";
import type { AgentOutput } from "../tools/schemas.js";
import { SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS, SUBAGENT_OUTPUT_MAX_BYTES, SUBAGENT_TIME_BUDGET_MS, type ReasoningEffort } from "../types/config.js";
import { sanitizeAndCap, SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS } from "./summarize-tool.js";
import {
  createSubagentCardAccumulator,
  finalizeSubagentCard,
  reduceSubagentCardEvent,
  type SubagentCardEvent,
} from "./card-snapshot.js";
import { linkAbortSignal } from "../util/abort.js";

// ---------------------------------------------------------------------------
// §3.1 — the model-visible tool declaration.

/**
 * One entry of the MCP bridge's model-visible agent catalog (§3.1): the
 * projection of a discovered agent profile (subagents/profiles.ts
 * PersonaDefinition, F13) that both `buildAgentBridgeToolDecl` (the enum +
 * description text) and `runAgentBridgeCall` (agent_type resolution + request
 * building) consume. Deliberately narrower than PersonaDefinition — `tools`
 * are irrelevant to a session-tier child that boots its own host (§2.2), so
 * they are not carried here; `maxTurns` (TASK.180) IS carried: a session
 * child's host consumes the profile's turn budget (core AgentLoopConfig /
 * claude --max-turns).
 */
export interface AgentBridgeCatalogEntry {
  /** Profile name — the value the model must pass as `agent_type` (also the one JSON-Schema enum member it names). */
  name: string;
  description: string;
  /** Absent = a core profile (an AnyCode persona, in-process or its own child session); present = a foreign-CLI md-profile (profiles.ts `engine:` frontmatter). */
  engine?: "claude" | "codex";
  /** Default model id for this profile's children (frontmatter `model:`); absent = inherit the parent's/host's default. */
  model?: string;
  /** Reasoning tier for this profile's children (frontmatter `effort:`); absent = the connection's default. */
  effort?: ReasoningEffort;
  /** Child profile body — included in the initial task for both core and engine session children. */
  systemPrompt: string;
  /** Profile turn budget (TASK.180) for the creating spawn; absent = existing default. */
  maxTurns?: number;
}

export interface AgentBridgeToolDecl {
  name: "agent";
  description: string;
  /** JSON Schema (z.toJSONSchema of the enum-backed zod object below) — the exact shape an MCP `tools/list` response carries. */
  inputSchema: Record<string, unknown>;
}

const AGENT_BRIDGE_TOOL_DESCRIPTION_HEADER =
  "Delegate a task to an AnyCode subagent profile: it runs as a full child session inside AnyCode that the user can open and steer — this CLI's own agent registry is a separate thing and does not see these profiles. Available profiles:";

/** One description line per catalog entry, in the same order as the `agent_type` enum (§3.1). */
function describeCatalogEntry(entry: AgentBridgeCatalogEntry): string {
  const engineLabel = entry.engine ?? "core";
  const modelLabel = entry.model ?? "inherited";
  const effortLabel = entry.effort !== undefined ? `, effort ${entry.effort}` : "";
  return `- ${entry.name} (${engineLabel}, model ${modelLabel}${effortLabel}): ${entry.description}`;
}

/** Model-facing meaning of `detach` — the supervisor's whole wait discipline rides on this sentence. */
const AGENT_BRIDGE_DETACH_DESCRIPTION =
  "Run the subagent in the background: the call returns at once with the child session id, and the child's report " +
  "arrives later as a new message that starts your next turn. After a detached call, end your turn — do not wait, " +
  "poll or re-check; nothing is lost while you are idle. The returned child session id can later be passed as " +
  "continue_session.";

/** Model-facing meaning of `continue_session` — a follow-up keeps the child's context instead of starting over. */
const AGENT_BRIDGE_CONTINUE_DESCRIPTION =
  "Child session id of an earlier finished call of this session — it is stated in that call's result " +
  "(\"Child session id: …\") and in the delivered child report's <agent-id>. " +
  "The same child resumes with its full history and receives `prompt` as its next message (use it to return defects " +
  "for rework). Its profile and model stay as they were; `model` is ignored. The child must have finished and " +
  "belong to this session.";

export interface AgentBridgeToolDeclOptions {
  /**
   * Declare the optional `detach` field (TASK.145 semantics). Only a door whose
   * host delivers a detached child's terminal report back as a new parent turn
   * may set this — otherwise the report would have nowhere to go.
   */
  detach?: boolean;
  /**
   * Declare the optional `continue_session` field: a follow-up turn on an
   * earlier finished core child of the same parent session (main resumes the
   * child's own session row and history).
   */
  continueSession?: boolean;
}

/**
 * Builds the `agent` tool declaration (§3.1). Returns null for an empty
 * catalog rather than declaring an enum with a single fabricated placeholder
 * value: a tool the model could call but that could never resolve to a real
 * profile would be a dishonest declaration, so the door is simply not opened
 * (the caller's `tools/list` announces nothing).
 */
export function buildAgentBridgeToolDecl(
  catalog: readonly AgentBridgeCatalogEntry[],
  options: AgentBridgeToolDeclOptions = {},
): AgentBridgeToolDecl | null {
  if (catalog.length === 0) {
    return null;
  }
  const names = catalog.map((entry) => entry.name) as [string, ...string[]];
  const schema = z.object({
    description: z.string().min(1).describe("Short 3-5 word description of the subagent task"),
    prompt: z.string().min(1).describe("The task the subagent should carry out"),
    agent_type: z.enum(names).describe("AnyCode subagent profile to run"),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("Exact model id to run the subagent on (defaults to the profile's own model)"),
    ...(options.detach === true ? { detach: z.boolean().optional().describe(AGENT_BRIDGE_DETACH_DESCRIPTION) } : {}),
    ...(options.continueSession === true
      ? { continue_session: z.string().min(1).optional().describe(AGENT_BRIDGE_CONTINUE_DESCRIPTION) }
      : {}),
  });
  const description = [AGENT_BRIDGE_TOOL_DESCRIPTION_HEADER, ...catalog.map(describeCatalogEntry)].join("\n");
  return {
    name: "agent",
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// §3.2 — the shared session-tier request builder.

/**
 * Params for the request builder shared by the native Agent tool's session
 * tier (tools/agent.ts's runSessionTier) and `runAgentBridgeCall` below
 * (§3.2). `profile`, when present, is exactly what an `engine:` profile
 * resolves to today (ports/subagent.ts's EngineProfileInfo) — a core
 * (non-engine) catalog entry's own default model is folded into `model` by
 * the CALLER instead. Session-child boot only receives the initial prompt, so
 * the bridge also includes the selected core profile body in that prompt.
 */
export interface BuildSessionSubagentRequestParams {
  agentType: string;
  description: string;
  prompt: string;
  /** The caller's own model override (an explicit `Agent(model:…)` argument, or the bridge call's own `model` field) — NOT yet resolved against `profile.model`. */
  model?: string;
  spawnToolCallId: string;
  profile?: EngineProfileInfo;
  /** The profile's own `effort:` frontmatter, if any. */
  effort?: ReasoningEffort;
  /** The profile's own turn budget (TASK.180), if any — rides the creating spawn's request only. */
  maxTurns?: number;
}

/**
 * Builds ONE SessionSubagentRequest (§3.2), extracted byte-for-byte out of
 * the pre-S1 body of tools/agent.ts's runSessionTier (TASK.226 срез S1):
 * `provider` and `detach` are deliberately NOT set here — `provider` rides
 * only the native Agent tool's own request (agent.ts §2.1 p.2); `detach` is
 * added by each caller that honors it (agent.ts, `runAgentBridgeCall`).
 */
export function buildSessionSubagentRequest(params: BuildSessionSubagentRequestParams): SessionSubagentRequest {
  const { agentType, description, prompt, model, spawnToolCallId, profile, effort, maxTurns } = params;
  // Model precedence (model plumbing fix, unchanged by this extraction): an
  // explicit override always outranks the profile's own frontmatter default.
  const resolvedModel = model ?? profile?.model;
  return {
    agentType,
    description,
    prompt: profile !== undefined ? `${profile.systemPrompt}\n\n---\n\n${prompt}` : prompt,
    spawnToolCallId,
    ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    ...(profile !== undefined ? { engine: profile.engine } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outcome projection (moved out of tools/agent.ts verbatim, F9) — shared by
// BOTH the native Agent tool and runAgentBridgeCall below.

/**
 * Projects the terminal SubagentOutcome (shared shape of the inline and
 * session tiers) onto the Agent tool's ToolResult, honoring TASK.44's honest
 * outcome mapping. Shared by both tiers of the native Agent tool AND the MCP
 * bridge's runAgentBridgeCall below, so the mapping text/logic is provably
 * the SAME everywhere a subagent outcome ever gets projected to a model.
 */
export function outcomeToResult(
  outcome: SubagentOutcome,
  presentation: { presentation?: ToolResultPresentation },
): ToolResult<AgentOutput> {
  const lengthNote =
    outcome.finalTurnFinishReason === "length"
      ? `\nNOTE: the subagent's final turn was also cut by the model's output-token ceiling (finishReason "length") — the partial text is cut mid-stream.`
      : "";
  if (outcome.status === "error") {
    return { ok: false, error: (outcome.finalText || "Agent: the subagent failed.") + lengthNote, ...presentation };
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
    if (outcome.declaredDoneAtCeiling) {
      const error = partial
        ? `Agent: the subagent reached its turn limit after ${outcome.turns} turns and reported the work finished. ` +
          `Its report below is the final answer.\n\n${partial}`
        : `Agent: the subagent reached its turn limit after ${outcome.turns} turns and reported the work finished, but produced no final text.`;
      return { ok: false, errorKind: "max_turns", error, output: toAgentOutput(outcome), ...presentation };
    }
    const error = partial
      ? `Agent: the subagent ran out of budget after ${outcome.turns} turns without finishing.\n` +
        `INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT. ` +
        `Missing checks may invalidate the conclusions below.\n\n${partial}` + lengthNote
      : `Agent: the subagent ran out of budget after ${outcome.turns} turns without finishing and produced no partial result. The task was not completed — split it into narrower delegations, or ask the user to raise the subagent turn budget (Settings → Tools → "Maximum turns (subagents)").` + lengthNote;
    return { ok: false, errorKind: "max_turns", error, output: toAgentOutput(outcome), ...presentation };
  }
  // cancelled (TASK.44): preserve cancellation semantics — never success.
  // The dispatcher maps errorKind "cancelled" to status "cancelled", so the
  // card's external badge and the internal subagent_end status agree.
  if (outcome.status === "cancelled") {
    return {
      ok: false,
      errorKind: "cancelled",
      error: "Agent: the subagent was cancelled." + lengthNote,
      output: toAgentOutput(outcome),
      ...presentation,
    };
  }
  // TASK.210 marker (а): the child's own degeneration guard (agent-loop.ts)
  // cut its FINAL turn — never the provider, never a budget exhaustion.
  // Repeats the ladder's own precedent (a guard stopped the run => the
  // parent gets a non-success, never a silently-accepted partial): ok:false
  // WITHOUT an errorKind, same shape as the plain "error" branch above —
  // "max_turns" would misname the cause, and widening the errorKind union
  // for one guard is not worth it when the dispatcher's own fallback
  // (`errorKind ?? "error"`, types/tools.ts) already gives the right external
  // status. This is checked AFTER max_turns/cancelled and BEFORE the ok:true
  // return below, and returns immediately — formatResultForModel's (б)/(в)
  // prefixing never runs on an ok:false result (it returns `result.error`
  // verbatim), so marker (в)'s fact is folded in HERE when it also applies.
  //
  // Internally SubagentOutcome.status stays "completed" (loop_end said so —
  // the loop reached its sentinel cleanly); the mismatch between an internal
  // "completed" and this external non-success is the accepted cost of not
  // widening the status union (plan §8) — the exact period/repeat count that
  // caused this lives in the loop's own `degeneration` telemetry record, not
  // this message: a model reading this text needs "do not trust this
  // partial", not the diagnostic numbers.
  if (outcome.finalTurnFinishReason === "degenerate") {
    const partial = outcome.finalText.trim();
    // runner.ts's capUtf8Bytes runs BEFORE this outcome exists and trims
    // from the END, keeping the head — a real incident can be >100KB of
    // ordinary text followed by the loop, in which case the loop itself
    // lands entirely in the DISCARDED tail and `partial` is nothing but
    // ordinary head text. An unconditional "ends inside a degenerate loop"
    // claim would then be false for what is actually delivered, so the
    // claim is hedged (and the byte cap named, same number as marker (в))
    // whenever `truncated` is also set.
    const tailClaim = outcome.truncated
      ? `The subagent's own ${SUBAGENT_OUTPUT_MAX_BYTES}-byte result cap ALSO trimmed this text before it reached ` +
        `here — the loop itself may or may not still be visible below.`
      : "The text below ends inside a degenerate loop.";
    const error =
      `Agent: the subagent's output degenerated into a repetition loop and the turn was cut.\n` +
      `INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT. ${tailClaim}\n\n${partial}`;
    return { ok: false, error, output: toAgentOutput(outcome), ...presentation };
  }
  if (outcome.finalTurnFinishReason === "length") {
    const partial = outcome.finalText.trim();
    const capNote = outcome.truncated
      ? ` The report also exceeded the ${SUBAGENT_OUTPUT_MAX_BYTES}-byte result cap; its tail was dropped.`
      : "";
    const error =
      `Agent: the subagent's final turn was cut by the model's output-token ceiling (finishReason "length").\n` +
      `INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT. ` +
      `The report below is cut mid-stream and its tail is missing.${capNote}\n\n${partial}`;
    return { ok: false, error, output: toAgentOutput(outcome), ...presentation };
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
 * model-visible tool output — EXCEPT childSessionId (TASK.218), which now
 * also rides the output itself so formatResultForModel's follow-up note
 * never depends on a presentation card existing. The authoritative comment
 * for "ids ride ONLY the presentation target" lives at tools/agent.ts's
 * runSessionTier; this projection keeps parent/spawn ids off the output.
 */
function toAgentOutput(outcome: SubagentOutcome): AgentOutput {
  return {
    status: outcome.status,
    finalText: outcome.finalText,
    truncated: outcome.truncated,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    durationMs: outcome.durationMs,
    ...(outcome.finalTurnFinishReason !== undefined
      ? { finalTurnFinishReason: outcome.finalTurnFinishReason }
      : {}),
    // TASK.218 (supervisor correction 1): ID discoverability must not depend
    // on subagent_start or a presentation card — the nonempty childSessionId
    // is copied onto the model-visible output whenever the outcome is
    // actually session-shaped (a SessionSubagentOutcome), never invented for
    // an inline one. (outcome as this wider shape is read structurally: only
    // the presence of a nonempty string childSessionId counts.)
    ...((outcome as Partial<SessionSubagentOutcome>).childSessionId !== undefined &&
    (outcome as Partial<SessionSubagentOutcome>).childSessionId !== ""
      ? { childSessionId: (outcome as Partial<SessionSubagentOutcome>).childSessionId }
      : {}),
  };
}

/**
 * TASK.210 markers (б)/(в) — applied here, never in output.finalText, so the
 * presentation card and history persistence (which read finalText/output
 * directly) keep the raw text; only what the model itself reads is prefixed.
 * Both can be true on the same outcome at once (the TASK.210 incident was:
 * 131,072 tokens generated, 99,999 bytes delivered) — order is fixed (б)→(в)
 * so the model reads "the provider cut it" before "and then we cut it more".
 */
export function formatResultForModel(result: ToolResult<AgentOutput>): string {
  if (!result.ok) {
    return result.error ?? "Agent: the subagent failed.";
  }
  let prefix = "";
  // (б): the PROVIDER's own output-token ceiling ended the turn, not this
  // tool's byte cap — ok:true because the loop itself completed honestly
  // (unlike the guard cutoff in outcomeToResult above, which never reaches
  // here). Owner's measured false-positive rate for this marker: 1 in 902
  // turns of a sample session, and that one turn WAS the TASK.210 incident.
  if (result.output?.finalTurnFinishReason === "length") {
    prefix +=
      "[TRUNCATED SUBAGENT RESULT — the final turn hit the model's output-token ceiling; " +
      "the report below is cut mid-stream and its tail is missing.]\n\n";
  }
  // (в): this tool's OWN result-byte cap (util/bytes.ts's capUtf8Bytes, spent
  // in runner.ts) — a distinct truncation from (б) and can follow it.
  if (result.output?.truncated === true) {
    prefix += `[TRUNCATED SUBAGENT RESULT — the report exceeded the ${SUBAGENT_OUTPUT_MAX_BYTES}-byte result cap; its tail was dropped.]\n\n`;
  }
  return prefix + (result.output?.finalText ?? "") + childContinueNote(result);
}

/**
 * TASK.218: the "[Child session id: …]" follow-up hint appended to every
 * SUCCESSFUL session-tier result — output.childSessionId first (correction 1:
 * discoverability must not depend on subagent_start or a presentation card),
 * falling back to the presentation card's session target. Inline outcomes
 * produce no note by construction (no output id, no session target); an
 * ok:false result never reaches here (the early return above).
 */
function childContinueNote(result: ToolResult<AgentOutput>): string {
  const childSessionId =
    result.output?.childSessionId !== undefined && result.output.childSessionId !== ""
      ? result.output.childSessionId
      : result.presentation?.subagent?.target !== undefined &&
          result.presentation.subagent.target.kind === "session" &&
          result.presentation.subagent.target.childSessionId !== ""
        ? result.presentation.subagent.target.childSessionId
        : undefined;
  if (childSessionId === undefined) {
    return "";
  }
  return `\n\n[Child session id: ${childSessionId}. Pass it as continue_session in a later agent call to send a follow-up to this same child in its existing conversation.]`;
}

/**
 * Projects a coarse SubagentProgress onto the matching subagent_* AgentEvent,
 * stamping the Agent tool call's id (design §3.3). The three variants map 1:1;
 * the status/counter unions already align with the event shapes. Typed as
 * SubagentCardEvent (a strict subset of ToolEmittedEvent — the subagent_*
 * variants only) rather than the broader ToolEmittedEvent: this lets the
 * result feed directly into reduceSubagentCardEvent without a cast, while
 * remaining assignable wherever ToolEmittedEvent is expected (ctx.emit in
 * tools/agent.ts, deps.onEvent in runAgentBridgeCall below).
 */
export function mapProgressToEvent(progress: SubagentProgress, toolCallId: string): SubagentCardEvent {
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
        ...(progress.engine !== undefined ? { engine: progress.engine } : {}),
        ...(progress.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: progress.finalTurnFinishReason } : {}),
      };
    case "attention":
      return {
        type: "subagent_attention",
        toolCallId,
        waiting: progress.waiting,
      };
    case "stalled":
      // TASK.148 slice 1: reports only — this bridge never alters the run,
      // never cancels it, and the switch above (tool_result/turn_end) keeps
      // firing normally afterward.
      return {
        type: "subagent_stalled",
        toolCallId,
        agentType: progress.agentType,
        description: progress.description,
        silentMs: progress.silentMs,
        ...(progress.lastActivity !== undefined ? { lastActivity: progress.lastActivity } : {}),
        waitingForApproval: progress.waitingForApproval,
      };
  }
}

// ---------------------------------------------------------------------------
// §3.4 — the call handler itself.

export interface AgentBridgeCallInput {
  agent_type: string;
  description: string;
  prompt: string;
  model?: string;
  /** Background run (TASK.145): `run()` settles at admit; the report arrives later as a parent turn. */
  detach?: boolean;
  /** Follow-up to an earlier finished child of this session: its id; the child resumes with its own history. */
  continue_session?: string;
}

/**
 * Decodes an MCP `tools/call` request's raw `arguments` object (TASK.226 срез
 * S4) into `AgentBridgeCallInput`. The wire shape is untyped JSON the CLI
 * builds from the tool's own `inputSchema` (`buildAgentBridgeToolDecl` above)
 * — that schema is advertised, never enforced on THIS side, so a peer that
 * skips client-side validation (or a future non-claude MCP client) must not
 * reach `runAgentBridgeCall` with a shape it never checked. Mirrors the same
 * fail-closed discipline `parseAgentProfileMd` applies to profile frontmatter:
 * every required field is checked for its exact type, `model` is accepted
 * only as a non-empty string when present, and anything else (missing field,
 * wrong type, empty string) is `null` — the caller reports a scoped decode
 * error rather than letting `agent_type: undefined` reach the catalog lookup
 * as the literal string `"undefined"`.
 */
export function decodeAgentBridgeCallInput(args: Record<string, unknown>): AgentBridgeCallInput | null {
  const agentType = args.agent_type;
  const description = args.description;
  const prompt = args.prompt;
  const model = args.model;
  if (typeof agentType !== "string" || agentType.length === 0) return null;
  if (typeof description !== "string" || description.length === 0) return null;
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) return null;
  const detach = args.detach;
  if (detach !== undefined && typeof detach !== "boolean") return null;
  const continueSession = args.continue_session;
  if (continueSession !== undefined && (typeof continueSession !== "string" || continueSession.length === 0)) return null;
  return {
    agent_type: agentType,
    description,
    prompt,
    ...(model !== undefined ? { model: model as string } : {}),
    ...(detach === true ? { detach: true } : {}),
    ...(continueSession !== undefined ? { continue_session: continueSession as string } : {}),
  };
}

export interface AgentBridgeCallDeps {
  /** The exact catalog snapshot `agent_type` is validated against — the SAME list `buildAgentBridgeToolDecl` announced on `tools/list`. */
  catalog: readonly AgentBridgeCatalogEntry[];
  /** Every catalog entry — engine or core — runs through this ONE port (§2.2: no AgentLoopConfig is ever synthesized for a bridge call). */
  port: SessionSubagentPort;
  /** The claude tool_use id this call correlates to (F8) — stamped onto the request as spawnToolCallId AND onto every bridged subagent_* event (§2.7). */
  spawnToolCallId: string;
  /** External cancellation (e.g. the control request's own AbortSignal, F1) — linked into this call's own controller, never used directly. */
  signal?: AbortSignal;
  /** Every mapped subagent_* event (§3.3: "onProgress → mapProgressToEvent(progress, toolUseId) → engine.pushBridgeEvent(ev)"), already stamped with `spawnToolCallId` — the host relays these straight into its live event queue. The card accumulator below is fed independently and unconditionally, regardless of whether this is wired. */
  onEvent?: (event: SubagentCardEvent) => void;
  /** Wall-clock cap for this one call; defaults to SUBAGENT_TIME_BUDGET_MS (§2.3). */
  wallMs?: number;
}

export interface AgentBridgeCallResult {
  /** The exact text an MCP `tools/call` response's `content[0].text` should carry (§3.1) — identical to what the native Agent tool feeds the model for the same outcome. */
  text: string;
  isError: boolean;
  /** Present only once the child actually started (CUT-S1 §3 W1: never fabricated) — the host's event-translator rides this onto the paired tool_result (§3.3). */
  presentation?: ToolResultPresentation;
}

/**
 * Runs one `mcp__anycode__agent` call end to end (§3.1/§3.4): validates
 * `agent_type` against the catalog, builds the session-tier request
 * (buildSessionSubagentRequest above), runs it through `deps.port`, and
 * projects the terminal outcome through the SAME outcomeToResult/
 * formatResultForModel pair the native Agent tool uses — a claude-CLI
 * subagent call and an `Agent{tier:"session"}` call read back byte-identical
 * text for the same outcome.
 *
 * The wall (§2.3) is this function's own backstop, independent of whatever
 * timeout the CLI's MCP transport applies: on expiry the call's controller is
 * aborted and the outcome is reported as `error` with a fixed wall message —
 * deliberately NOT `cancelled` (that status is reserved for a signal the
 * CALLER supplied, e.g. a Stop-driven `request.signal`), so the two causes
 * never read the same way to the model. The child's own identity
 * (childSessionId/parentSessionId/spawnToolCallId), when the port did return
 * one before abandoning, still rides the overridden outcome verbatim — only
 * status/finalText are replaced.
 */
export async function runAgentBridgeCall(
  input: AgentBridgeCallInput,
  deps: AgentBridgeCallDeps,
): Promise<AgentBridgeCallResult> {
  const entry = deps.catalog.find((candidate) => candidate.name === input.agent_type);
  if (entry === undefined) {
    const available = deps.catalog.map((candidate) => candidate.name);
    return {
      text: `Unknown agent_type "${input.agent_type}". Available agent types: ${available.join(", ")}.`,
      isError: true,
    };
  }

  const continueSession = input.continue_session;
  if (continueSession !== undefined && entry.engine !== undefined) {
    return {
      text: `Agent: continue_session is supported only for AnyCode (core) profiles; "${entry.name}" runs on ${entry.engine}. Start a new call instead.`,
      isError: true,
    };
  }

  const profile: EngineProfileInfo | undefined =
    entry.engine !== undefined
      ? { engine: entry.engine, systemPrompt: entry.systemPrompt, ...(entry.model !== undefined ? { model: entry.model } : {}) }
      : undefined;
  const built = buildSessionSubagentRequest({
    agentType: entry.name,
    description: input.description,
    // A continued child already carries its profile body in its own history;
    // only the follow-up message is sent.
    prompt: continueSession === undefined && profile === undefined && entry.systemPrompt.trim()
      ? `${entry.systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt,
    // A core (non-engine) entry has no `profile` for the builder to fall back
    // onto, so its own default model is resolved here instead (scenario E,
    // plan §9 p.4: a core profile's `model:` frontmatter must still reach the
    // child; its body is explicitly included above).
    // A continued child keeps the model its session was started on.
    model: continueSession !== undefined ? undefined : profile !== undefined ? input.model : (input.model ?? entry.model),
    spawnToolCallId: deps.spawnToolCallId,
    profile,
    // A continued child keeps the tier its session was started on.
    ...(continueSession === undefined && entry.effort !== undefined ? { effort: entry.effort } : {}),
    // TASK.180: the profile's turn budget rides only the CREATING spawn —
    // a continued child keeps whatever budget its session started with.
    ...(continueSession === undefined && entry.maxTurns !== undefined ? { maxTurns: entry.maxTurns } : {}),
  });
  // A detached run settles at admit with the port's own "started in the
  // background" text and no `subagent_start`, so the card below is null —
  // the same shape the native Agent tool's detached call has.
  const request: SessionSubagentRequest = {
    ...built,
    ...(input.detach === true ? { detach: true } : {}),
    ...(continueSession !== undefined ? { resumeChildSessionId: continueSession } : {}),
  };

  const controller = new AbortController();
  const unlink = deps.signal !== undefined ? linkAbortSignal(deps.signal, controller) : () => {};
  const wallMs = deps.wallMs ?? SUBAGENT_TIME_BUDGET_MS;
  let wallExceeded = false;
  const wallTimer = setTimeout(() => {
    wallExceeded = true;
    controller.abort("wall_timeout");
  }, wallMs);

  let acc = createSubagentCardAccumulator();
  let outcome: SessionSubagentOutcome;
  try {
    outcome = await deps.port.run(request, {
      signal: controller.signal,
      onProgress: (progress) => {
        const event = mapProgressToEvent(progress, deps.spawnToolCallId);
        acc = reduceSubagentCardEvent(acc, event);
        deps.onEvent?.(event);
      },
    });
  } finally {
    clearTimeout(wallTimer);
    unlink();
  }

  if (wallExceeded) {
    // Override status/text only — the port's own identity fields (when it
    // returned any before being abandoned) are kept verbatim so a card that
    // did start still targets the real child session.
    outcome = {
      ...outcome,
      status: "error",
      finalText: `Agent: the child session exceeded the ${wallMs}ms wall and was cancelled.`,
    };
  }

  const target: SubagentCardTarget = {
    kind: "session",
    childSessionId: outcome.childSessionId,
    parentSessionId: outcome.parentSessionId,
    spawnToolCallId: outcome.spawnToolCallId,
  };
  const snapshot = finalizeSubagentCard(acc, { status: outcome.status, durationMs: outcome.durationMs }, target);
  const presentation: { presentation?: ToolResultPresentation } =
    snapshot !== null ? { presentation: { subagent: snapshot } } : {};
  const result = outcomeToResult(outcome, presentation);
  return {
    text: formatResultForModel(result),
    isError: !result.ok,
    ...(result.presentation !== undefined ? { presentation: result.presentation } : {}),
  };
}

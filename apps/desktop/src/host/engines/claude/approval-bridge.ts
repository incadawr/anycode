/**
 * Bridge between the CLI's `can_use_tool` control-request and AnyCode's
 * interactive permission broker (cut §1.4). Structurally simpler than the codex
 * bridge: `tool_name` and the FULL `input` already ride the request, so no
 * turn-item correlation index is needed to describe what is being approved.
 *
 * Answer forms are byte-pinned to the live exchange in
 * `w0-02-control-writeprobe.jsonl` (contract §2.2):
 *   allow -> {"behavior":"allow","updatedInput":<input>,"toolUseID":<id>}
 *   deny  -> {"behavior":"deny","message":<why>,"toolUseID":<id>}
 *
 * Echoing BOTH `updatedInput` and `toolUseID` on an allow is mandatory since
 * v2.1.207 — the live allow carries them, and an allow that omits them
 * degrades silently rather than failing loudly (hazard (в)).
 *
 * A denial is a NORMAL protocol answer: the turn CONTINUES, the model sees the
 * reason and reacts, and the transport stays reusable for the next turn
 * (hazard (б) — a deny implemented as an error response or a closed stdin kills
 * the session instead).
 *
 * Fail-closed throughout: every path that is not an explicit user allow ends as
 * a denial, and nothing is ever auto-approved.
 */

import type { PermissionRequest, ToolMetadata } from "@anycode/core";
import type { IpcPermissionBroker, SettleOrigin } from "../../permission-broker.js";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";

/** Control subtypes the CLI can initiate (contract §2.2). Only `can_use_tool` is bridged in the MVP. */
export const CLAUDE_CAN_USE_TOOL = "can_use_tool";

/**
 * `ExitPlanMode` is a UNIVERSAL gate (probe #8): the CLI always routes it
 * through `can_use_tool`, in every permission mode. Approving it in the
 * read-only preset would let the model escalate straight out of the posture the
 * user chose — and, live, the tool calls that follow an approved ExitPlanMode
 * run WITHOUT asking again (implicit escalation, hazard (е)). So the MVP denies
 * it with an instruction instead of auto-allowing, and never builds the exit arc.
 */
const EXIT_PLAN_MODE = "ExitPlanMode";

/**
 * AskUserQuestion has no AnyCode surface in the MVP (cut §1.4 "не делаем"): it
 * is denied WITH an explanation, which the model reliably answers by asking the
 * same thing as ordinary text in its next message.
 */
const ASK_USER_QUESTION = "AskUserQuestion";

function claudeToolMetadata(toolName: string): ToolMetadata {
  return {
    name: toolName,
    description: `Claude Code is requesting permission to use ${toolName}`,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    riskLevel: "high",
    sideEffectScope: "process",
    needsApproval: true,
    timeoutMs: 120_000,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ClaudeApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: unknown;
  description?: string;
}

/**
 * Structural decode. The identity pair (`tool_name` + `tool_use_id`) is
 * required — without it no answer can be correlated. Everything else is
 * optional and unknown keys are ignored BY CONSTRUCTION: the live request
 * carries `permission_suggestions`, `decision_reason`, `decision_reason_type`
 * and `display_name`, none of which the MVP projects (cut §1.4 "не делаем"),
 * and a strict decode would fail-closed on a perfectly valid approval.
 */
export function decodeCanUseTool(request: Record<string, unknown>): ClaudeApprovalRequest | null {
  const toolName = string(request.tool_name);
  const toolUseId = string(request.tool_use_id);
  if (toolName === null || toolUseId === null) return null;
  const description = string(request.description);
  return {
    toolName,
    toolUseId,
    input: request.input ?? {},
    ...(description === null ? {} : { description }),
  };
}

/**
 * The exact allow payload the live CLI accepted (`w0-02-control-writeprobe.jsonl`).
 * `updatedInput` defaults to the input the CLI proposed, but a broker decision
 * that rewrote it wins — that rewritten value is precisely what the field is
 * for, and echoing the original would silently discard the user's edit.
 */
export function allowResponse(approval: ClaudeApprovalRequest, updatedInput?: unknown): Record<string, unknown> {
  return {
    behavior: "allow",
    updatedInput: updatedInput === undefined ? approval.input : updatedInput,
    toolUseID: approval.toolUseId,
  };
}

/** The deny payload; `message` is what the model reads and reacts to. */
export function denyResponse(approval: ClaudeApprovalRequest, message: string): Record<string, unknown> {
  return { behavior: "deny", message, toolUseID: approval.toolUseId };
}

export interface ClaudeApprovalBridgeOptions {
  broker: IpcPermissionBroker;
  /** The session's active permission preset id; `read-only` refuses ExitPlanMode escalation. */
  activePresetId(): string;
}

export class ClaudeApprovalBridge {
  /**
   * Serialization latch (cut §1.4): exactly one approval may be parked at a
   * time. W0 never exercised parallel `can_use_tool` (it would need a subagent
   * turn), so a second concurrent request is refused with a SCOPED error rather
   * than being queued on an unproven assumption — fail-safe, and the model
   * simply retries the tool.
   */
  private pending = false;

  constructor(private readonly options: ClaudeApprovalBridgeOptions) {}

  /** ClaudeClient hook (`onControlRequest`). Every request is answered exactly once — or, if the CLI cancels it first, not at all. */
  handle = async (request: InboundControlRequest, responder: ControlRequestResponder): Promise<void> => {
    await this.route(request, responder);
  };

  /** Settles an outstanding broker ask promptly when the turn or engine is torn down. */
  denyAll(reason: string, origin: SettleOrigin): void {
    this.options.broker.denyAll(reason, origin);
  }

  private async route(request: InboundControlRequest, responder: ControlRequestResponder): Promise<void> {
    if (request.subtype !== CLAUDE_CAN_USE_TOOL) {
      // `hook_callback` and `mcp_message` are out of MVP scope, and an unknown
      // future subtype is unanswerable. Fail-closed with a SCOPED error — never
      // silence, which would block the CLI's turn forever (contract §2.2
      // unhandled-subtype rule).
      responder.error(`AnyCode does not handle the "${request.subtype}" control request`);
      return;
    }
    const approval = decodeCanUseTool(request.request);
    if (approval === null) {
      responder.error("Malformed can_use_tool request");
      return;
    }
    if (approval.toolName === EXIT_PLAN_MODE && this.options.activePresetId() === "read-only") {
      responder.success(
        denyResponse(
          approval,
          "AnyCode is running this session in the Read-only preset, so leaving plan mode is not permitted. Present the plan as your answer; the user can switch the preset to Ask or Workspace to let you execute it.",
        ),
      );
      return;
    }
    if (approval.toolName === ASK_USER_QUESTION) {
      responder.success(
        denyResponse(
          approval,
          "AnyCode does not support interactive questions from this tool. Ask the user directly in your reply instead.",
        ),
      );
      return;
    }
    if (this.pending) {
      responder.error("Claude approval rejected: another approval is already pending");
      return;
    }

    // Already withdrawn before we got here: asking the user about a tool the
    // CLI has abandoned would park a modal nothing can answer, and the pairing
    // rule forbids responding anyway. Nothing to do at all.
    if (request.signal.aborted) return;

    this.pending = true;
    // The CLI can also withdraw it WHILE the user is looking at the modal
    // (`control_cancel_request` — it does this by itself on interrupt, hazard
    // (д)). Nothing else would release the broker in that case: our own Stop
    // path calls `denyAll` explicitly, but a CLI-originated withdrawal has no
    // such trigger, so the ask stays parked, the modal stays open, and
    // `pending` never clears — refusing every later approval in the session
    // with "another approval is already pending". Settling the broker here
    // resolves that await; the answer it produces is then discarded by the
    // client's pairing rule (the request is already gone from `pendingInbound`).
    const releaseOnCancel = (): void => {
      this.options.broker.denyAll("Claude withdrew this permission request", "turn_cancelled");
    };
    request.signal.addEventListener("abort", releaseOnCancel, { once: true });
    try {
      const decision = await this.options.broker.requestPermission(this.toPermissionRequest(approval));
      // Both outcomes are a control_response SUCCESS envelope: a denial is a
      // normal answer whose payload says "deny", never a protocol error
      // (hazard (б)). If the CLI already withdrew this request via
      // `control_cancel_request` — which it does by itself on interrupt
      // (hazard (д)) — the client's pairing rule makes this a silent no-op.
      responder.success(
        decision.behavior === "allow"
          ? allowResponse(approval, decision.updatedInput)
          : denyResponse(approval, string(decision.reason) ?? "The user denied permission for this tool call."),
      );
    } catch {
      // The broker never rejects; if it somehow does, no grant may be invented.
      responder.success(denyResponse(approval, "AnyCode could not settle this permission request."));
    } finally {
      request.signal.removeEventListener("abort", releaseOnCancel);
      this.pending = false;
    }
  }

  private toPermissionRequest(approval: ClaudeApprovalRequest): PermissionRequest {
    const input = record(approval.input) ?? { value: approval.input };
    return {
      toolName: approval.toolName,
      toolCallId: approval.toolUseId,
      input: approval.description === undefined ? input : { ...input, description: approval.description },
      metadata: claudeToolMetadata(approval.toolName),
      // Display-only: a Claude session never consults core's permission engine
      // (`supportsCorePermissions` is false); posture lives in presets.ts.
      mode: "build",
    };
  }
}

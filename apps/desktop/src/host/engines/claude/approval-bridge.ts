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

import { classifyBashCommandLine } from "@anycode/core";
import type { PermissionRequest, ToolMetadata } from "@anycode/core";
import { NodeFileSystemAdapter, resolveWorkspaceWriteFacts, WORKSPACE_CONFINED_WRITE_TOOLS } from "@anycode/core";
import type { EngineBridgeBroker, SettleOrigin } from "../../permission-broker.js";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";
import { CLAUDE_ANYCODE_MCP_TOOL_PREFIX, type ClaudeMcpBridge } from "./mcp-bridge.js";

/** Control subtypes the CLI can initiate (contract §2.2). `can_use_tool` is bridged to the interactive broker; `mcp_message` is bridged to `ClaudeMcpBridge` (TASK.226 S3) when one is attached. */
export const CLAUDE_CAN_USE_TOOL = "can_use_tool";

/** TASK.226 S3: the CLI's own in-process MCP handshake and tool calls (probes.md P0/P1/P3), routed to `options.bridge` instead of the fail-closed default. */
export const CLAUDE_MCP_MESSAGE = "mcp_message";

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

/**
 * Taskana 4070: a Bash can_use_tool whose command line the shared classifier
 * proves read-only (and is not a shell expression) is presented readOnly/low,
 * mirroring the Codex bridge's commandExecutionMetadata (TASK.184). Presentation
 * only — the decision still goes through the broker.
 */
function commandAwareMetadata(toolName: string, input: Record<string, unknown>): ToolMetadata {
  const meta = claudeToolMetadata(toolName);
  if (toolName !== "Bash") return meta;
  const command = typeof input.command === "string" ? input.command : null;
  if (command === null) return meta;
  const verdict = classifyBashCommandLine(command);
  if (verdict.class === "read-only" && verdict.shellExpression === false) {
    return { ...meta, readOnly: true, destructive: false, riskLevel: "low" };
  }
  return meta;
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
  broker: EngineBridgeBroker;
  /** The session's active permission preset id; `read-only` refuses ExitPlanMode escalation. */
  activePresetId(): string;
  /**
   * TASK.226 S3: when set, `mcp_message` is routed here instead of the fail-closed default, and the owned `mcp__anycode__agent` tool is auto-allowed (plan §2.6). Absent for engines/tests that never announce the door. */
  bridge?: ClaudeMcpBridge;
  /**
   * Taskana 4294 (cross-review F1): the session's workspace root (the
   * host boot's `workspace`, i.e. the process cwd the `claude` CLI was
   * spawned with). When set, Write/Edit/MultiEdit `can_use_tool` requests
   * carry dispatcher-equivalent `workspace` facts (realpath-resolved) so
   * IpcPermissionBroker's rule seam can apply the SAME workspace
   * confinement the core boot enforces — without facts a persisted
   * always-allow rule can never vouch for a write, which is exactly the
   * fail-closed posture required. Absent (legacy construction / tests):
   * no facts are minted, and the broker's own gate refuses to auto-allow
   * unprovable writes.
   */
  workspace?: string;
  /**
   * Taskana 4764: the full CLI names (`mcp__anycode__browser_*`) of the door's
   * browser tools. When set (and a door exists), `can_use_tool` for these names
   * is answered `allow` immediately: the CLI's name-only gate cannot express
   * "remote only", so the REAL, input-aware approval gate runs in the bridge's
   * `callTool` (browser-bridge.ts §2.3 step 2) through the same IpcPermissionBroker
   * — the user sees exactly ONE prompt, titled with the canonical tool name.
   * Any other `mcp__anycode__*` name keeps the generic ask path below.
   */
  browserToolNames?: ReadonlySet<string>;
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
    if (request.subtype === CLAUDE_MCP_MESSAGE) {
      if (this.options.bridge !== undefined) {
        await this.options.bridge.handleControlRequest(request, responder);
        return;
      }
      // No door announced for this session (bridge absent) — same fail-closed
      // scoped error as any other unhandled subtype below.
      responder.error(`AnyCode does not handle the "${request.subtype}" control request`);
      return;
    }
    if (request.subtype !== CLAUDE_CAN_USE_TOOL) {
      // `hook_callback` and an unknown future subtype are unanswerable.
      // Fail-closed with a SCOPED error — never silence, which would block
      // the CLI's turn forever (contract §2.2 unhandled-subtype rule).
      responder.error(`AnyCode does not handle the "${request.subtype}" control request`);
      return;
    }
    const approval = decodeCanUseTool(request.request);
    if (approval === null) {
      responder.error("Malformed can_use_tool request");
      return;
    }
    if (this.options.bridge !== undefined && approval.toolName === `${CLAUDE_ANYCODE_MCP_TOOL_PREFIX}agent`) {
      // AnyCode's own MCP door (TASK.226 S3), not a third-party tool: the
      // child session spawned behind it has its own broker for whatever it
      // actually does (plan §2.6). Allowed before the pending latch below so
      // it never contends with a concurrent human-facing approval — probes.md
      // P1 confirmed live that `allow` is not silently downgraded to `deny`
      // for this tool in headless mode.
      responder.success(allowResponse(approval));
      return;
    }
    if (this.options.bridge !== undefined && this.options.browserToolNames?.has(approval.toolName)) {
      // Taskana 4764: the door's browser tools. The CLI's `can_use_tool` only
      // knows a tool NAME and cannot express "remote only"; the real,
      // input-aware gate runs in the bridge's `callTool` (browser-bridge.ts
      // §2.3 step 2) through the same broker, so auto-allow here to avoid a
      // double prompt — and stay ahead of the pending latch so a browser call
      // never contends with a concurrent human-facing approval.
      responder.success(allowResponse(approval));
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
      const decision = await this.options.broker.requestPermission(
        await this.toPermissionRequest(approval),
      );
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

  /**
   * Taskana 4294 (cross-review F1): mints the SAME dispatch-site workspace
   * facts the core dispatcher mints (resolveWorkspaceWriteFacts — realpath
   * root + symlink-resolved target, refusing relative/`..`/NUL-bearing
   * paths) for Write/Edit/MultiEdit approvals, so the broker's rule seam can
   * prove containment before an always-allow rule answers. Fail-closed to
   * "no facts" (never throws): an unprovable write simply cannot ride a
   * rule — the ask stands. Guarded by claudeNeedsWorkspaceFacts so
   * unaffected approvals keep the original fully-synchronous path.
   */
  private async toPermissionRequest(approval: ClaudeApprovalRequest): Promise<PermissionRequest> {
    const input = record(approval.input) ?? { value: approval.input };
    const request: PermissionRequest = {
      toolName: approval.toolName,
      toolCallId: approval.toolUseId,
      input: approval.description === undefined ? input : { ...input, description: approval.description },
      metadata: commandAwareMetadata(approval.toolName, input),
      // Display-only: a Claude session never consults core's permission engine
      // (`supportsCorePermissions` is false); posture lives in presets.ts.
      mode: "build",
    };
    if (!claudeNeedsWorkspaceFacts(approval.toolName, input, this.options.workspace)) return request;
    const workspace = await this.mintWorkspaceFacts(this.options.workspace as string, claudeWriteTarget(approval.toolName, input));
    return workspace === undefined ? request : { ...request, workspace };
  }

  private async mintWorkspaceFacts(
    workspace: string,
    filePath: unknown,
  ): Promise<PermissionRequest["workspace"]> {
    if (typeof filePath !== "string") return undefined;
    try {
      // One adapter per ask: minting is rare (one Write/Edit approval at a
      // time — the pending latch above serialises them), and reusing a
      // long-lived instance would keep fs handles alive for a session
      // lifetime for no benefit.
      return await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), workspace, filePath);
    } catch {
      return undefined;
    }
  }
}

/**
 * Taskana 4294 (cross-review F1): true only for the approval shapes that
 * need workspace facts — a Write/Edit/MultiEdit with a wired workspace root
 * and a string `file_path`. Everything else keeps the original synchronous
 * path into the broker, preserving emit ordering for existing consumers.
 */
function claudeNeedsWorkspaceFacts(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string | undefined,
): boolean {
  return workspace !== undefined && typeof claudeWriteTarget(toolName, input) === "string";
}

/**
 * The target path of a Claude file-write approval: `file_path` for
 * Write/Edit/MultiEdit, `notebook_path` for NotebookEdit (Taskana 4294 review —
 * the broker confines NotebookEdit rules too). Undefined for anything else.
 */
function claudeWriteTarget(toolName: string, input: Record<string, unknown>): unknown {
  if (WORKSPACE_CONFINED_WRITE_TOOLS.has(toolName)) return input.file_path;
  if (toolName === "NotebookEdit") return input.notebook_path;
  return undefined;
}

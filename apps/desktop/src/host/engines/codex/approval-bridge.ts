/**
 * Bridge between the app-server's two approval requests and the interactive
 * permission broker (TASK.38 §3-§5, cut §2(c)).
 *
 * Decision mapping — all three literals are live-evidenced (cut §1a):
 *   allow                       -> {"decision":"accept"}
 *   deny (user / ask timeout)   -> {"decision":"decline"}   turn CONTINUES to
 *                                  `completed`, the command never runs, and the
 *                                  client stays reusable for the next turn (L1)
 *   deny because the turn is    -> {"decision":"cancel"}    denies AND ends the
 *   being torn down (Stop /        turn as `interrupted`; the client survives
 *   disconnect / shutdown)        and a second turn on it works (L2)
 *
 * A denial is therefore a NORMAL protocol answer, not an error and never a
 * reason to close the transport. Only a request we cannot answer at all
 * (unknown method / missing identity / broker failure) gets a JSON-RPC error,
 * and even that is scoped to the one request: a protocol rejection is not a
 * terminal transport failure (TASK.38 §4).
 *
 * Fail-closed still holds: every path that is not an explicit user allow ends
 * as a denial, and nothing is ever auto-approved.
 */

import type { PermissionRequest, ToolMetadata } from "@anycode/core";
import type { SettleOrigin } from "../../permission-broker.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import {
  OBSERVED_COMMAND_APPROVAL_METHOD,
  OBSERVED_FILE_CHANGE_APPROVAL_METHOD,
  type CodexApprovalDecision,
  type JsonRpcError,
  type JsonRpcServerRequest,
} from "./protocol.js";
import { commandOf, fileChangesOf, type TurnItemIndex } from "./turn-item-index.js";
import type { ServerRequestResponder } from "./app-server-client.js";

export const CODEX_APPROVAL_ERROR_CODE = -32002;

export interface ActiveCodexTurn {
  threadId: string;
  turnId: string;
  /** `item/started` details of this turn, used to describe what is being approved. */
  items?: TurnItemIndex;
}

export interface CodexApprovalBridgeOptions {
  broker: IpcPermissionBroker;
  activeTurn(): ActiveCodexTurn | null;
}

type DecodedApproval = {
  request: PermissionRequest;
  threadId: string;
  turnId: string;
};

const EXEC_METADATA: ToolMetadata = {
  name: "CodexExec",
  description: "Codex command awaiting explicit approval",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "process",
  needsApproval: true,
  timeoutMs: 120_000,
};

const PATCH_METADATA: ToolMetadata = {
  name: "CodexApplyPatch",
  description: "Codex file change awaiting explicit approval",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "filesystem",
  needsApproval: true,
  timeoutMs: 120_000,
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Optional-with-null wire field: `null` and absent are both legal; a wrong type is simply ignored. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * Structural decode: the identity triple is required (without it no answer can
 * be correlated), everything else is optional. Unknown/extra wire keys are
 * ignored by construction and NEVER rejected — the live wire carries
 * undeclared fields (`Thread.extra`, `historyMode`, `text_elements`, L9) and a
 * strict reject would fail-closed on a perfectly valid approval.
 */
function decode(request: JsonRpcServerRequest, items: TurnItemIndex | undefined): DecodedApproval | null {
  const params = record(request.params);
  if (params === null) return null;
  const threadId = string(params.threadId);
  const turnId = string(params.turnId);
  const itemId = string(params.itemId);
  if (threadId === null || turnId === null || itemId === null) return null;

  const indexed = items?.get(itemId);
  // `availableDecisions` is advisory only: `decline` is accepted whether or not
  // it is listed (L1), so it is projected for display and never gates a choice.
  const availableDecisions = stringList(params.availableDecisions);

  if (request.method === OBSERVED_COMMAND_APPROVAL_METHOD) {
    const fromItem = commandOf(indexed);
    // Live command approvals carry `command`/`cwd` but NO `reason` (L9); an
    // absent optional field must never turn into a denial.
    const command = optionalString(params.command) ?? fromItem.command;
    const cwd = optionalString(params.cwd) ?? fromItem.cwd;
    const reason = optionalString(params.reason);
    return {
      threadId,
      turnId,
      request: {
        toolName: "CodexExec",
        toolCallId: itemId,
        input: {
          ...(command === undefined || command === null ? {} : { command }),
          ...(cwd === undefined || cwd === null ? {} : { cwd }),
          ...(reason === null ? {} : { reason }),
          ...(Array.isArray(params.commandActions) ? { commandActions: params.commandActions } : {}),
          ...(availableDecisions === undefined ? {} : { availableDecisions }),
        },
        metadata: EXEC_METADATA,
        mode: "build",
      },
    };
  }

  if (request.method === OBSERVED_FILE_CHANGE_APPROVAL_METHOD) {
    // The request itself carries neither diff nor path (L9): everything the user
    // sees comes from the `item/started` correlation. No entry -> degraded
    // description, still shown, still fail-closed on the decision itself.
    const changes = fileChangesOf(indexed);
    return {
      threadId,
      turnId,
      request: {
        toolName: "CodexApplyPatch",
        toolCallId: itemId,
        input: {
          reason: optionalString(params.reason),
          grantRoot: optionalString(params.grantRoot),
          ...(changes.length > 0 ? { changes, paths: changes.map((change) => change.path) } : {}),
          ...(availableDecisions === undefined ? {} : { availableDecisions }),
        },
        metadata: PATCH_METADATA,
        mode: "build",
      },
    };
  }
  return null;
}

function denial(message: string): JsonRpcError {
  return { code: CODEX_APPROVAL_ERROR_CODE, message };
}

export class CodexApprovalBridge {
  private pending = false;
  /**
   * True while the parked ask is being force-settled because the TURN is going
   * away (Stop / disconnect / shutdown) rather than because the user said no.
   * That is the one case whose answer is `cancel` instead of `decline` (L2).
   */
  private cancelling = false;

  constructor(private readonly options: CodexApprovalBridgeOptions) {}

  /** AppServerClient hook. Every request is answered exactly once. */
  handle = async (request: JsonRpcServerRequest, responder: ServerRequestResponder): Promise<void> => {
    await this.route(request, responder);
  };

  /** Settles an outstanding broker ask promptly when the turn or engine is torn down. */
  denyAll(reason: string, origin: SettleOrigin): void {
    // "ui"/"timeout" are ordinary denials (the turn lives on); every other
    // origin means the turn itself is being cancelled.
    if (origin !== "ui" && origin !== "timeout") this.cancelling = true;
    this.options.broker.denyAll(reason, origin);
  }

  private async route(serverRequest: JsonRpcServerRequest, responder: ServerRequestResponder): Promise<void> {
    const active = this.options.activeTurn();
    const decoded = decode(serverRequest, active?.items);
    if (decoded === null) {
      // Unanswerable shape: one scoped JSON-RPC error, transport untouched.
      responder.error(denial("Unsupported or malformed Codex approval request"));
      return;
    }
    if (active === null || active.threadId !== decoded.threadId || active.turnId !== decoded.turnId) {
      responder.error(denial("Stale Codex approval request"));
      return;
    }
    if (this.pending) {
      responder.error(denial("Codex approval request rejected: another approval is pending"));
      return;
    }

    this.pending = true;
    this.cancelling = false;
    try {
      const decision = await this.options.broker.requestPermission(decoded.request);
      const answer: CodexApprovalDecision =
        decision.behavior === "allow" ? "accept" : this.cancelling ? "cancel" : "decline";
      responder.result({ decision: answer });
    } catch {
      // The broker never rejects; if it somehow does, no grant may be invented.
      responder.error(denial("Codex approval could not be settled"));
    } finally {
      this.pending = false;
      this.cancelling = false;
    }
  }
}

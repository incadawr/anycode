/**
 * Fail-closed bridge for the two approval request shapes observed in W0.
 * This is deliberately not a general Codex policy adapter: no decline/cancel,
 * grants, policy amendments, or unknown server request is ever invented here.
 */

import type { PermissionRequest, ToolMetadata } from "@anycode/core";
import type { SettleOrigin } from "../../permission-broker.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import {
  OBSERVED_COMMAND_APPROVAL_METHOD,
  OBSERVED_FILE_CHANGE_APPROVAL_METHOD,
  type JsonRpcError,
  type JsonRpcServerRequest,
} from "./protocol.js";
import type { ServerRequestResponder } from "./app-server-client.js";

export const CODEX_APPROVAL_ERROR_CODE = -32002;

export interface ActiveCodexTurn {
  threadId: string;
  turnId: string;
}

export interface CodexApprovalBridgeOptions {
  broker: IpcPermissionBroker;
  activeTurn(): ActiveCodexTurn | null;
  /** A denied active native request must not leave the turn parked forever. */
  onTerminalDenial?(reason: string): void;
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

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function decode(request: JsonRpcServerRequest): DecodedApproval | null {
  const params = record(request.params);
  if (params === null) return null;
  const threadId = string(params.threadId);
  const turnId = string(params.turnId);
  const itemId = string(params.itemId);
  if (threadId === null || turnId === null || itemId === null) return null;

  if (request.method === OBSERVED_COMMAND_APPROVAL_METHOD) {
    const command = string(params.command);
    const cwd = string(params.cwd);
    if (command === null || cwd === null) return null;
    return {
      threadId,
      turnId,
      request: {
        toolName: "CodexExec",
        toolCallId: itemId,
        input: { command, cwd },
        metadata: EXEC_METADATA,
        mode: "build",
      },
    };
  }
  if (request.method === OBSERVED_FILE_CHANGE_APPROVAL_METHOD) {
    const reason = nullableString(params.reason);
    const grantRoot = nullableString(params.grantRoot);
    if (reason === undefined || grantRoot === undefined) return null;
    return {
      threadId,
      turnId,
      request: {
        toolName: "CodexApplyPatch",
        toolCallId: itemId,
        input: { reason, grantRoot },
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

  constructor(private readonly options: CodexApprovalBridgeOptions) {}

  /** AppServerClient hook. Every rejected shape receives a JSON-RPC error exactly once. */
  handle = async (request: JsonRpcServerRequest, responder: ServerRequestResponder): Promise<void> => {
    await this.route(request, responder);
  };

  /** Settles an outstanding broker ask promptly when engine teardown begins. */
  denyAll(reason: string, origin: SettleOrigin): void {
    this.options.broker.denyAll(reason, origin);
  }

  private async route(serverRequest: JsonRpcServerRequest, responder: ServerRequestResponder): Promise<void> {
    const decoded = decode(serverRequest);
    if (decoded === null) {
      responder.error(denial("Unsupported or malformed Codex approval request"));
      return;
    }
    const active = this.options.activeTurn();
    if (active === null || active.threadId !== decoded.threadId || active.turnId !== decoded.turnId) {
      responder.error(denial("Stale Codex approval request"));
      return;
    }
    if (this.pending) {
      responder.error(denial("Codex approval request rejected: another approval is pending"));
      return;
    }

    this.pending = true;
    try {
      const decision = await this.options.broker.requestPermission(decoded.request);
      if (decision.behavior === "allow") {
        responder.result({ decision: "accept" });
      } else {
        responder.error(denial("Codex approval denied"));
        this.options.onTerminalDenial?.("Codex approval denied");
      }
    } catch {
      responder.error(denial("Codex approval could not be settled"));
      this.options.onTerminalDenial?.("Codex approval could not be settled");
    } finally {
      this.pending = false;
    }
  }
}

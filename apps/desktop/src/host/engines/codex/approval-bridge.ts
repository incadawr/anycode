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

import { classifyBashCommandLine, isProvablyInsideWorkspace, NodeFileSystemAdapter, resolveWorkspaceWriteFacts } from "@anycode/core";
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

/** Reason shown for a `kind: "writeStdin"` command approval (codex 0.161+). */
export const STDIN_WRITE_REASON = "Send input to the command that is already running (not a new command).";

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
  /**
   * Taskana 4294 (cross-review F1): the session's workspace root (the host
   * boot's `workspace` — the cwd the codex thread was started with). When
   * set, a `CodexApplyPatch` approval carries `workspace` facts proving
   * whether the change set is confined, so IpcPermissionBroker's rule seam
   * can apply the same confinement the core boot enforces. Facts are minted
   * ONLY when EVERY changed path resolves inside; any outside/unprovable
   * path => no facts => the bare tool-level rule (the only shape possible
   * for this tool) can never vouch — fail-closed. Absent (legacy
   * construction / tests): no facts, same broker-side gate.
   */
  workspace?: string;
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

/**
 * TASK.184: EXEC_METADATA, de-risked by the shared Bash classifier. A string
 * command that is NOT a stdin write and classifies read-only with NO shell
 * expression (`;`, `&&`, pipes, substitutions, unmatched quotes, ...) is
 * presented as readOnly/low. Everything else — missing command, stdin write,
 * unknown class, any shell expression, even a harmless compound like
 * `ls; cat a.txt` — keeps the fail-closed high default. Classification changes
 * METADATA ONLY: it never auto-allows a command; the decision still goes
 * through the broker.
 */
function commandExecutionMetadata(command: string | null | undefined, stdinWrite: boolean): ToolMetadata {
  if (typeof command === "string" && !stdinWrite) {
    const result = classifyBashCommandLine(command);
    if (result.class === "read-only" && result.shellExpression === false) {
      return { ...EXEC_METADATA, readOnly: true, riskLevel: "low" };
    }
  }
  return EXEC_METADATA;
}

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
    // 0.161: `kind: "writeStdin"` is input sent to a command that is ALREADY
    // running, not a new command — the same `command` would otherwise read as
    // a second run of it. Said in the reason the dialog shows.
    const stdinWrite = params.kind === "writeStdin";
    const reason = optionalString(params.reason) ?? (stdinWrite ? STDIN_WRITE_REASON : null);
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
          ...(stdinWrite ? { kind: "writeStdin" } : {}),
        },
        metadata: commandExecutionMetadata(command, stdinWrite),
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

  /**
   * Taskana 4294 (cross-review F1): mints dispatcher-equivalent workspace
   * facts for a codex fileChange approval when — and only when — EVERY changed
   * path resolves PROVABLY inside the session workspace. The facts carry the
   * first change's path as the representative resolved target (the modal shows
   * the full change set anyway), but containment of every path is proven
   * independently — one outside path anywhere in the set makes the whole
   * approval unprovable, and NO facts are attached (fail-closed): the broker's
   * rule seam then refuses to let a bare `{toolName:"CodexApplyPatch"}` rule
   * vouch, and the ask reaches a human. Never throws. Guarded by
   * codexNeedsWorkspaceFacts so unaffected approvals stay fully synchronous.
   */
  private async withWorkspaceFacts(request: PermissionRequest): Promise<PermissionRequest> {
    if (this.options.workspace === undefined) return request;
    if (request.toolName !== "CodexApplyPatch") return request;
    const paths = Array.isArray((request.input as Record<string, unknown> | null)?.paths)
      ? ((request.input as Record<string, unknown>).paths as unknown[])
      : [];
    let first: PermissionRequest["workspace"];
    for (const entry of paths) {
      // Unshapely (non-string / empty) => unprovable => no facts at all.
      if (typeof entry !== "string" || entry.length === 0) return request;
      const facts = await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), this.options.workspace, entry);
      // Outside / relative / .. / symlink escape / unresolvable => no facts at all.
      if (facts === undefined || !isProvablyInsideWorkspace(facts)) return request;
      first ??= facts;
    }
    if (first === undefined) return request; // no indexed changes => nothing provable
    return { ...request, workspace: first };
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
      // Taskana 4294 (cross-review F1): facts are minted ONLY for the shape
      // that needs them (workspace wired + CodexApplyPatch + indexed paths);
      // every other approval keeps the original fully-synchronous path into
      // the broker, preserving emit ordering for existing consumers.
      const request = codexNeedsWorkspaceFacts(decoded.request, this.options.workspace)
        ? await this.withWorkspaceFacts(decoded.request)
        : decoded.request;
      const decision = await this.options.broker.requestPermission(request);
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

/**
 * Taskana 4294 (cross-review F1): true only for the approval shapes that
 * need workspace facts — the codex fileChange approval with a wired
 * workspace root and an indexed `paths[]` to prove. Command approvals
 * (CodexExec) and degraded shapes take the original synchronous path into
 * the broker, preserving emit ordering for existing consumers.
 */
function codexNeedsWorkspaceFacts(request: PermissionRequest, workspace: string | undefined): boolean {
  if (workspace === undefined) return false;
  if (request.toolName !== "CodexApplyPatch") return false;
  const paths = (request.input as Record<string, unknown> | null)?.paths;
  return Array.isArray(paths) && paths.length > 0;
}

/**
 * Narrow NDJSON/control-protocol vocabulary pinned to CC-W0 evidence from the
 * live `claude` CLI v2.1.212 (references/claude-code-2.1.212/contract-draft.md).
 * Intentionally transport-only: no approval acceptance, model override, or
 * event-to-AgentEvent translation is implied by these shapes — that is CC-C's
 * job. Deliberately NOT shared with host/engines/codex/protocol.ts: the two
 * CLIs speak unrelated wire protocols (JSON-RPC vs control-envelope NDJSON).
 */

// ── minimum version + capability gate (contract §3) ──

/** Floor only, no ceiling — R5 measured zero structural drift 2.1.212→2.1.214 on three read-only control surfaces. */
export const SUPPORTED_CLAUDE_VERSION = ">=2.1.212";

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

export class EngineVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineVersionError";
  }
}

/** `claude --version` prints "<major>.<minor>.<patch> (Claude Code)" (W0 bootstrap; re-verified live on 2.1.214, R5). */
export function parseClaudeVersion(output: string): ClaudeVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

const CLAUDE_MIN_VERSION: ClaudeVersion = { major: 2, minor: 1, patch: 212 };

function compareVersion(a: ClaudeVersion, b: ClaudeVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isSupportedClaudeVersion(version: ClaudeVersion): boolean {
  return compareVersion(version, CLAUDE_MIN_VERSION) >= 0;
}

/**
 * Live v2.1.212 `system/init.capabilities` (open set — SDK instructs consumers
 * to ignore unknown values and gate only on the specific capability they use).
 */
export const EXPECTED_CAPABILITIES = ["interrupt_receipt_v1", "msg_lifecycle_v1"] as const;

/**
 * The ONLY capability CC-B gates on: governs whether `interrupt`'s response
 * carries `still_queued` (probe #3). `msg_lifecycle_v1`'s behavioral contract
 * is undocumented in the SDK types read during W0 (R5-a residual) — never
 * gated on. Missing this capability at the first observed `system/init` is a
 * fail-closed `EngineVersionError` (interrupt semantics would otherwise
 * silently degrade).
 */
export const GATED_CAPABILITY = "interrupt_receipt_v1";

export function hasGatedCapability(capabilities: readonly string[]): boolean {
  return capabilities.includes(GATED_CAPABILITY);
}

// ── permission mode: wire value vs CLI flag value (probe #8) ──
// One mode, two names at two layers: control protocol / `system/init.permissionMode`
// calls it "default"; the `--permission-mode` CLI flag calls the SAME mode "manual".
// Every other mode name is identical at both layers.

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
export type PermissionModeFlag = "manual" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export function permissionModeToFlag(mode: PermissionMode): PermissionModeFlag {
  return mode === "default" ? "manual" : mode;
}

export function permissionModeFromFlag(flag: PermissionModeFlag): PermissionMode {
  return flag === "manual" ? "default" : flag;
}

// ── shared enums (contract §1.1) ──

export type SDKAssistantMessageError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export type TerminalReason =
  | "blocking_limit"
  | "rapid_refill_breaker"
  | "prompt_too_long"
  | "image_error"
  | "model_error"
  | "api_error"
  | "malformed_tool_use_exhausted"
  | "aborted_streaming"
  | "aborted_tools"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "tool_deferred"
  | "max_turns"
  | "background_requested"
  | "completed"
  | "budget_exhausted"
  | "structured_output_retry_exhausted"
  | "tool_deferred_unavailable"
  | "turn_setup_failed";

// ── stdout message envelope (contract §1) ──
// All shapes below are deliberately loose (index signature) past their
// discriminant + the fields CC-B's transport itself reads — CC-C's translator,
// not this file, owns the full shape.

export interface ClaudeSystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  permissionMode: PermissionMode;
  cwd: string;
  tools: string[];
  mcp_servers: unknown[];
  slash_commands: string[];
  skills: string[];
  capabilities: string[];
  claude_code_version: string;
  [key: string]: unknown;
}

export interface ClaudeSystemGenericMessage {
  type: "system";
  subtype: string;
  [key: string]: unknown;
}

export type ClaudeSystemMessage = ClaudeSystemInitMessage | ClaudeSystemGenericMessage;

export function isClaudeSystemInitMessage(message: ClaudeSystemMessage): message is ClaudeSystemInitMessage {
  return message.subtype === "init";
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: { model: string; content: unknown[]; [key: string]: unknown };
  parent_tool_use_id?: string | null;
  error?: SDKAssistantMessageError;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: unknown };
  isReplay?: boolean;
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: { type: string; [key: string]: unknown };
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface ClaudeRateLimitEventMessage {
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    errorCode?: "credits_required";
    [key: string]: unknown;
  };
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  terminal_reason?: TerminalReason;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export type ClaudeStreamMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeStreamEventMessage
  | ClaudeRateLimitEventMessage
  | ClaudeResultMessage;

/**
 * The stream-message vocabulary PRODUCTION accepts. Exported so the drift gate
 * can read it rather than restating it: a hardcoded list in the test cannot go
 * red when production starts accepting a type the pin has no live evidence for
 * (cut invariant §0.2-5 — "не выдумывать wire").
 */
export const CLAUDE_STREAM_MESSAGE_TYPES = [
  "system",
  "assistant",
  "user",
  "stream_event",
  "rate_limit_event",
  "result",
] as const;

const STREAM_MESSAGE_TYPES: ReadonlySet<string> = new Set(CLAUDE_STREAM_MESSAGE_TYPES);

export function isClaudeStreamMessageType(type: string): boolean {
  return STREAM_MESSAGE_TYPES.has(type);
}

// ── control protocol envelope (contract §2) ──

export interface ClaudeControlRequestEnvelope {
  type: "control_request";
  request_id: string;
  request: { subtype: string; [key: string]: unknown };
}

export type ClaudeControlResponseEnvelope =
  | { type: "control_response"; response: { subtype: "success"; request_id: string; response?: unknown } }
  | { type: "control_response"; response: { subtype: "error"; request_id: string; error: string } };

export interface ClaudeControlCancelRequestEnvelope {
  type: "control_cancel_request";
  request_id: string;
}

export type ClaudeEnvelope =
  | ClaudeStreamMessage
  | ClaudeControlRequestEnvelope
  | ClaudeControlResponseEnvelope
  | ClaudeControlCancelRequestEnvelope;

/** Builds our outbound `{type:"control_request",...}` envelope. */
export function buildControlRequest(requestId: string, subtype: string, request?: Record<string, unknown>): ClaudeControlRequestEnvelope {
  return { type: "control_request", request_id: requestId, request: { subtype, ...request } };
}

/**
 * Safe default for an unhandled inbound control_request (CLI → host): a
 * fail-closed error envelope, never silence (contract §2.2 "Unhandled-subtype
 * rule" — the CLI blocks its turn on an un-answered request).
 */
export function unhandledControlError(requestId: string, message = "AnyCode Claude transport has no handler for this control request"): ClaudeControlResponseEnvelope {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error: message } };
}

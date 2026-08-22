/**
 * Narrow JSON-RPC vocabulary pinned to W0 evidence from codex-cli 0.144.1.
 * This is intentionally transport-only: no approval acceptance, model override,
 * or event-to-AgentEvent translation is implied by these shapes.
 */

export const SUPPORTED_CODEX_VERSION = ">=0.144.0 <0.150.0";

export interface CodexVersion {
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

/** W0 observed exact preflight shape: `codex-cli 0.144.1`. */
export function parseCodexVersion(output: string): CodexVersion | null {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\s*$/.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Inclusive lower / exclusive upper bound, PARSED from
 * `SUPPORTED_CODEX_VERSION` rather than restated. The predicate used to be
 * hardcoded (`minor === 144`) while the constant above was a display string
 * only: the two could disagree silently, and widening the string alone would
 * have advertised a range the code still refused. One edit now moves both.
 */
const SUPPORTED_BOUNDS = parseSupportedRange(SUPPORTED_CODEX_VERSION);

function parseSupportedRange(range: string): { min: CodexVersion; max: CodexVersion } {
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (match === null) throw new Error(`unsupported SUPPORTED_CODEX_VERSION form: ${range}`);
  const [, a, b, c, d, e, f] = match;
  return {
    min: { major: Number(a), minor: Number(b), patch: Number(c) },
    max: { major: Number(d), minor: Number(e), patch: Number(f) },
  };
}

function compareCodexVersions(left: CodexVersion, right: CodexVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function isSupportedCodexVersion(version: CodexVersion): boolean {
  return (
    compareCodexVersions(version, SUPPORTED_BOUNDS.min) >= 0 &&
    compareCodexVersions(version, SUPPORTED_BOUNDS.max) < 0
  );
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number | string;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: { experimentalApi?: boolean };
}

/** Observed W0 initialize response; it has no protocol-version field. */
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartResult {
  thread: { id: string };
  model: string;
  approvalPolicy: string;
}

/** W0 observed command approval; W1 additionally evidenced decline/cancel (L1/L2). */
export const OBSERVED_COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
/** W0 observed this file-change approval request; W1 evidenced decline for it too (L1). */
export const OBSERVED_FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";

/**
 * The only approval decisions AnyCode ever sends (live-evidenced, cut §2(c)):
 *
 *  - `accept`  — user allowed the request.
 *  - `decline` — user denied it. The server accepts `decline` for BOTH approval
 *    families and continues the turn to a normal `completed` (L1), and it does
 *    so even when `decline` is absent from that request's `availableDecisions`.
 *    No `availableDecisions` intersection/fallback logic exists, deliberately.
 *  - `cancel`  — the user pressed Stop while an approval was parked: denies the
 *    request AND interrupts the turn (L2). Never sent for a plain deny.
 *
 * `acceptForSession` and the execpolicy/network amendments are never sent
 * automatically (residual, cut §8).
 */
export type CodexApprovalDecision = "accept" | "decline" | "cancel";

/** Safe default for an unhandled server request: JSON-RPC error, never an allow. */
export const UNHANDLED_SERVER_REQUEST_ERROR: JsonRpcError = {
  code: -32001,
  message: "AnyCode Codex transport has no handler for this server request",
};

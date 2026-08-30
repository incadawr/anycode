/**
 * Narrow JSON-RPC vocabulary pinned to W0 evidence from codex-cli 0.144.1.
 * This is intentionally transport-only: no approval acceptance, model override,
 * or event-to-AgentEvent translation is implied by these shapes.
 */

export const SUPPORTED_CODEX_VERSION = "<0.152.0";

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
 * Exclusive ceiling, PARSED from `SUPPORTED_CODEX_VERSION` rather than
 * restated. The predicate used to be hardcoded (`minor === 144`) while the
 * constant above was a display string only: the two could disagree silently,
 * and widening the string alone would have advertised a version the code
 * still refused. One edit now moves both.
 *
 * TASK.173 (owner decision, 2026-08-29): dropped the FLOOR that used to pair
 * with this ceiling. Support is no longer a closed range ("island") — any
 * codex-cli build below the ceiling is accepted by version number, however
 * old. The ceiling itself stays because it is a real measurement: a real
 * 0.151.0 binary was unpacked and its app-server schema compared against the
 * pinned contract (`contract/README.md`), so anything at or above 0.152.0 is
 * genuinely unverified, not merely old. A build old enough to actually lack
 * the consumed wire shapes fails on its own later — an unparseable/missing
 * response at whichever call first needs the missing shape — rather than
 * being preemptively refused here by version number alone.
 */
const SUPPORTED_CEILING = parseSupportedCeiling(SUPPORTED_CODEX_VERSION);

function parseSupportedCeiling(range: string): CodexVersion {
  const match = /^<(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (match === null) throw new Error(`unsupported SUPPORTED_CODEX_VERSION form: ${range}`);
  const [, a, b, c] = match;
  return { major: Number(a), minor: Number(b), patch: Number(c) };
}

function compareCodexVersions(left: CodexVersion, right: CodexVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function isSupportedCodexVersion(version: CodexVersion): boolean {
  return compareCodexVersions(version, SUPPORTED_CEILING) < 0;
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

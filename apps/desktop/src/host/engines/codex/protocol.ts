/**
 * Narrow JSON-RPC vocabulary pinned to W0 evidence from codex-cli 0.144.1.
 * This is intentionally transport-only: no approval acceptance, model override,
 * or event-to-AgentEvent translation is implied by these shapes.
 */

export const SUPPORTED_CODEX_VERSION = ">=0.144.0 <0.145.0";

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

export function isSupportedCodexVersion(version: CodexVersion): boolean {
  return version.major === 0 && version.minor === 144;
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

/** W0 only observed command approval acceptance. Do not infer other approval codecs. */
export const OBSERVED_COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";

/** Safe default for an unhandled server request: JSON-RPC error, never an allow. */
export const UNHANDLED_SERVER_REQUEST_ERROR: JsonRpcError = {
  code: -32001,
  message: "AnyCode Codex transport has no handler for this server request",
};

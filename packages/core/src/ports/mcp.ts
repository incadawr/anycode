/**
 * MCP transport port (design slice-3.2-cut.md §3.2). The port lives at the
 * TRANSPORT layer (opening a connection), NOT the protocol layer: the protocol
 * (JSON-RPC, handshake, listTools/callTool) is owned entirely by the SDK Client
 * and is deliberately NOT abstracted (ruling B5 "we do not write our own
 * protocol" extends to "we do not write our own protocol interface"). Like every
 * port, this file carries NO third-party types — `McpWireTransport` is a
 * structural mirror of the SDK `Transport` interface, and a compile-time
 * assertion in mcp/ pins assignability of this port to the SDK type; the reverse
 * crosses via a checked boundary cast — see mcp/transport-compat.ts.
 */

/** Resolved server spec (post config: env already built, ${env:VAR} substituted). */
export interface McpStdioServerSpec {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  /* */
  env: Record<string, string>;
}

export interface McpHttpServerSpec {
  kind: "http";
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/**
 * Structural mirror of the SDK Transport interface (kept third-party-free like
 * every port). A compile-time assertion in mcp/ pins assignability to the SDK
 * type, so SDK transports satisfy this port and our transports satisfy the SDK.
 */
export interface McpWireTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface McpTransportFactory {
  create(spec: McpServerSpec): McpWireTransport;
}

export type McpServerState = "connecting" | "connected" | "failed" | "closed";

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  state: McpServerState;
  toolCount: number;
  /** True when per-server tool/declaration caps dropped part of the list. */
  toolsTruncated: boolean;
  error?: string;
}

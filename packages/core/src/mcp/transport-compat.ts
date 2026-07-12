/**
 * Compile-time assertion (design slice-3.2-cut.md §3.2 note): pins that our
 * third-party-free `McpWireTransport` port stays compatible with the SDK
 * `Transport` interface, so a future SDK upgrade that drifts the Transport shape

 * module is NOT exported from mcp/index.ts and the `import type` is erased from
 * the bundle (the SDK never enters out/main via this file).
 *
 * Direction pinned strictly — OUR TRANSPORTS SATISFY THE SDK:
 *   a value shaped as `McpWireTransport` (our hand-rolled `NodeStdioMcpTransport`,
 *   3.2.2) is a valid SDK `Transport` and can be handed to the SDK `Client`
 *   (`client.connect(transport)`). This is the load-bearing stdio seam.
 *
 * The reverse (a stock SDK transport used AS our port) is intentionally NOT a
 * strict assignment: the SDK types transport payloads as `JSONRPCMessage`
 * (plus batch arrays and a generic `onmessage<T extends JSONRPCMessage>`), which
 * is narrower than the port's deliberately loose `Record<string, unknown>`.
 * Under contravariance a stock `Transport` is therefore not directly assignable
 * to `McpWireTransport`; task 3.2.2 returns stock SDK transports (HTTP /
 * in-memory) from `McpTransportFactory.create` behind a one-line boundary cast —
 * a `JSONRPCMessage` IS a `Record` at runtime. Keeping the port third-party-free
 * is the ruling (B5 / §3.2), and the one-way strict compatibility is expected.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpWireTransport } from "../ports/mcp.js";

declare const _ourTransport: McpWireTransport;

/** OUR TRANSPORTS SATISFY THE SDK — breaks the build on an incompatible SDK Transport drift. */
export const _portSatisfiesSdk: Transport = _ourTransport;

declare const _sdkMessage: JSONRPCMessage;

/** SDK payloads ARE Records — the boundary cast in node-mcp-transport.ts widens, never lies. */
export const _sdkPayloadIsRecord: Record<string, unknown> = _sdkMessage;

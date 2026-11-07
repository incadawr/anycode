import type { LspServerStatus } from "@anycode/core";

/** The Restart action shows only when at least one server crashed. */
export function hasCrashedLspServer(servers: readonly LspServerStatus[]): boolean {
  return servers.some((server) => server.state === "crashed");
}

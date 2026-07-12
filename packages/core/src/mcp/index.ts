/**
 * MCP client module barrel (design slice-3.2-cut.md §3.4): re-exports the
 * manager + config contracts (port types flow through ports/index.js). The
 * tool-bridge is an internal detail owned by task 3.2.2 (imported directly, not
 * part of the public barrel), and transport-compat is a pure compile-time check
 * (not exported — it has no runtime surface).
 */

export { McpManager } from "./manager.js";
export type { McpManagerOptions } from "./manager.js";
export {
  loadMcpServerSpecs,
  mcpConfigFileSchema,
  mcpServerEntrySchema,
  resolveMcpServerEntries,
} from "./config.js";
export type { LoadedMcpServerSpecs, McpConfigFile, McpServerEntry } from "./config.js";
export { scanHarnessConfigs } from "./harness-import.js";
export type {
  HarnessImportCandidate,
  HarnessKind,
  HarnessScanResult,
} from "./harness-import.js";
export { applyMcpImport, deleteMcpServer, setMcpServerEnabled, upsertMcpServer } from "./config-write.js";
export type { ApplyMcpImportResult, UpsertResult } from "./config-write.js";

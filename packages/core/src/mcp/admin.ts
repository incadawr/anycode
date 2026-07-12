/**
 * Main-safe MCP admin barrel (subpath `@anycode/core/mcp-admin`, design
 * slice-P7.19-cut.md §4 W1). Re-exports the harness-import readers, the
 * config-write patchers, and the entry schema/type from config.ts.
 *
 * ⚠ NO ai-SDK imports: main imports core runtime ONLY through this subpath so it
 * never drags the full `@anycode/core` barrel (and the ai-SDK with it). Every
 * module re-exported here transitively touches only ports + zod + smol-toml.
 */

export { scanHarnessConfigs } from "./harness-import.js";
export type { HarnessImportCandidate, HarnessKind, HarnessScanResult } from "./harness-import.js";
export { applyMcpImport, deleteMcpServer, setMcpServerEnabled, upsertMcpServer } from "./config-write.js";
export type { ApplyMcpImportResult, UpsertResult } from "./config-write.js";
export { mcpConfigFileSchema, mcpServerEntrySchema } from "./config.js";
export type { McpConfigFile, McpServerEntry } from "./config.js";

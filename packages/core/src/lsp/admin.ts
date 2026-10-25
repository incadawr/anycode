/**
 * Main-safe LSP admin barrel (subpath `@anycode/core/lsp-admin`, Taskana
 * 4743). Re-exports the entry schema and the config-write patchers so the
 * Electron main process can manage `lspServers` entries WITHOUT importing the
 * full `@anycode/core` barrel (which drags the ai-SDK into main — the same
 * rule `@anycode/core/mcp-admin` documents).
 *
 * ⚠ NO ai-SDK imports: everything re-exported here transitively touches only
 * ports + zod + node:path.
 */

export { loadLspServerSpecs, lspServerEntrySchema } from "./config.js";
export type { LoadedLspServerSpecs, LspServerEntry } from "./config.js";
export { deleteLspServer, upsertLspServer } from "./config-write.js";
export type { LspUpsertResult } from "./config-write.js";

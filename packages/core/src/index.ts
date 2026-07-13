/** @anycode/core public API surface. Edited ONLY by scaffold tasks (Phase 1: task 1.1). */

export * from "./types/index.js";
// Residual from slice 2.2 (design §4.4): the persisted always-allow rule shape is
// consumed by the desktop settings vault; types/index.js re-exports the other
// permission types but not this one, so surface it on the barrel directly.
export type { PermissionRule } from "./types/permissions.js";
export * from "./ports/index.js";
export {
  JsonlTelemetrySink,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeGitAdapter,
  NodeHttpAdapter,
  NodeMcpTransportFactory,
  SqlitePersistenceAdapter,
  WriteBehindHistorySink,
} from "./adapters/node/index.js";
export { LspManager, loadLspServerSpecs } from "./lsp/index.js";
export { loadWebSearchConfig } from "./websearch/index.js";
export type { ResolvedWebSearchBackend } from "./websearch/index.js";
export { buildTelemetryTap, loadTelemetryConfig, telemetryRecordFor } from "./telemetry/index.js";
export type { ResolvedTelemetryConfig } from "./telemetry/index.js";
export { InProcessTaskManager } from "./tasks/index.js";
// Per-workspace shadow-git checkpoint service (design slice-4.7-cut.md §2.9):
// re-exported for the desktop host's boot-time checkpoint-capture wiring
// (slice P7.26/R1), so the host constructs the SAME service the CLI does
// (cli/main.ts checkpointService). Pure class — no auto-run block.
export { ShadowGitCheckpoints } from "./checkpoints/shadow-git.js";
export type { ShadowGitCheckpointsOptions, RewindScope, RewindResult } from "./checkpoints/shadow-git.js";
// Checkpoint metadata contracts (design slice-4.7-cut.md §2.1): re-exported for
// the desktop host's rewind seam (slice P7.26/R2), so Session references the SAME
// CheckpointMeta the store returns rather than a hand-duplicated wire shape.
export type { CheckpointMeta, CheckpointReason } from "./ports/checkpoints.js";
// Codex shadow command log DTO (codex-fixes TASK.42, cut §2(e)): re-exported for
// the desktop host's `SqliteCodexShadowLog` adapter (host/engines/codex/shadow-log.ts),
// which wraps this same SqlitePersistenceAdapter — never a hand-duplicated row shape.
export type { CodexShadowCommandItem } from "./adapters/node/sqlite-persistence.js";
// Pure string helper (no I/O, no auto-run block — the NOTE about cli/main.ts
// below does not apply): re-exported for the desktop host's notice injection
// (slice 6.DP-2), so both wiring paths append byte-identical reminder blocks.
export { withBackgroundTaskNotices } from "./cli/background-notice.js";
// Pure catalog matcher (no I/O, no auto-run block — the NOTE about cli/main.ts
// below does not apply): re-exported for the desktop host's boot-time
// context-window resolution (slice 6.4), so both wiring paths resolve the
// same window from the same entry.
export { matchCatalogEntryByBaseUrl, SwitchableModelPort } from "./cli/model.js";
// Fail-soft reader/fail-closed writer over the SAME ~/.anycode/settings.json
// permissions.alwaysAllow section desktop main owns (slice P7.5, TASK.8), plus
// the SessionPermissionRules subclass that wires CLI add-paths to it.
export {
  appendAlwaysAllowRule,
  defaultSettingsFilePath,
  loadPersistedAlwaysAllowRules,
  PersistingSessionPermissionRules,
} from "./cli/settings-rules.js";
export type { AppendRuleResult } from "./cli/settings-rules.js";
export * from "./provider/index.js";
export * from "./tools/index.js";
export * from "./permissions/index.js";
export * from "./dispatch/index.js";
export * from "./loop/index.js";
export * from "./subagents/index.js";
export * from "./mcp/index.js";
export * from "./skills/index.js";
export * from "./workflow/index.js";
export * from "./plugins/index.js";
export * from "./extensions/bootstrap.js";
export * from "./repoMap/index.js";
export { estimateTokensFromText } from "./context/tokens.js";
export { ConversationHistory } from "./context/history.js";
export type { HistorySink } from "./context/history.js";
export { HeuristicTokenizer, createDefaultTokenizer } from "./context/tokenizer.js";
export type { Tokenizer } from "./context/tokenizer.js";
export {
  DEFAULT_CONTEXT_BUDGET,
  compactThresholdTokens,
  effectiveWindowTokens,
  microcompactThresholdTokens,
  resolveContextBudgetConfig,
} from "./context/budget.js";
export type { ContextBudgetConfig } from "./context/budget.js";
export { ContextManager, MICROCOMPACT_CLEARED_TEXT } from "./context/manager.js";
export type { ContextManagerDeps } from "./context/manager.js";
export {
  SESSION_TITLE_MAX_LENGTH,
  SESSION_TITLE_SOURCE_MAX_BYTES,
  SESSION_TITLE_TIMEOUT_MS,
  sanitizeTitleSource,
  deriveSessionTitle,
  generateSessionTitle,
} from "./context/session-title.js";
export { COMPACTION_INSTRUCTION } from "./prompts/compaction.js";
export { SESSION_TITLE_INSTRUCTION } from "./prompts/session-title.js";
export { IDENTITY_PROMPT } from "./prompts/identity.js";
export { buildSystemPrompt } from "./prompts/system.js";
export type { SystemPromptEnv, SystemPromptOptions } from "./prompts/system.js";
export { buildSubagentSystemPrompt } from "./prompts/subagent.js";
export type { SubagentPromptOptions } from "./prompts/subagent.js";
// NOTE: cli/main.ts is an application entry point with a top-level auto-run
// block (isDirectRun -> runCli -> process.exit). It is intentionally NOT
// re-exported here: doing so pulls it into the library barrel's module graph,
// and any bundler (e.g. electron-vite building the desktop host) then inlines
// the auto-run block. Once bundled, its `import.meta.url === argv[1]` guard
// misfires (both collapse to the bundle's own path), the CLI REPL starts
// inside the host process and exits(0). The CLI is launched directly via
// `tsx src/cli/main.ts`, where the guard works correctly.
export { linkAbortSignal, raceWithTimeout } from "./util/abort.js";
export type { TimeoutRaceResult } from "./util/abort.js";

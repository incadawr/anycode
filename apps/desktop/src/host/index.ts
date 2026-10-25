import { SqliteCodexAgentCardLog } from "./engines/codex/agent-card-log.js";
import { CodexDynamicToolBridge, codexAgentPermissionMode } from "./engines/codex/dynamic-tool-bridge.js";
import { assertChildModel, readAllowedChildModels } from "../shared/child-model.js";
import { resolveModelClassifierBoot } from "./model-classifier-boot.js";
/**
 * Host utilityProcess entry point (design §2/§6, MVP.3; persistence/hooks
 * wiring per §2.12, task 1.9).
 *
 * Mirrors cli/main.ts to wire the real core, but swaps the fail-closed
 * DenyPermissionBroker for the interactive IpcPermissionBroker, registers the
 * PreToolUse snapshot observer, and fronts everything with a protocol server
 * (Session) over the UI MessagePort:
 *
 *   loadEnvConfig -> AiSdkModelPort -> createDefaultToolRegistry ->
 *   InMemoryHookRunner (+ snapshot hook + config-driven command hooks) ->
 *   ModePermissionEngine -> IpcPermissionBroker -> AgentLoop (Node fs/exec
 *   adapters, cwd = workspace, ConversationHistory + write-behind persistence)
 *

 * SqlitePersistenceAdapter opens/migrates ANYCODE_DB_PATH (default
 * ~/.anycode/anycode.sqlite, same default as the CLI's task-1.7 wiring). The
 * boot session is resolved from argv (resolveBootSession): `--session <id>`
 * creates a fresh session with the main-supplied id; `--resume <id>` loads it
 * (recovering the persisted history + mode), creating a fresh one with the same
 * id when absent (a respawn racing the write-behind queue). A defective history
 * left by a mid-turn crash is repaired before the first turn (repairDangling

 * ConversationHistory so every append/compaction swap is queued to disk without
 * ever blocking a turn; shutdown drains that queue (sink.flush()) and closes the
 * database (persistence.close()), mirroring cli/main.ts. tabId never reaches the
 * host — only the session id crosses the process boundary (§3.5).
 *
 * Command hooks (design §2.11/§2.12): loadHookConfigs reads the trusted
 * user (~/.anycode/config.json) and project (<workspace>/.anycode/config.json)
 * configs; a malformed config must not crash the host — it just means no
 * command hooks get registered for this session (fail-soft, logged).
 *
 * MCP client wiring (design slice-3.2-cut.md §4.4/§6, task 3.2.4): after the
 * hook-config block, boot() connects every configured MCP server in parallel
 * (fail-soft try/catch, same posture as the hook-config block right above it —
 * a loader/connect failure must never abort boot; the app just runs with zero
 * MCP servers) via `McpManager({registry, transports: new
 * NodeMcpTransportFactory(), onStatusChange})`. `registry` is the SAME object
 * that lands in `AgentLoopConfig` below, so bridged tools are live before the
 * first turn. `onStatusChange` bridges every status transition to the
 * renderer over the existing outbound channel (`mcp_status`, buffered like
 * every other live event so a reconnect's `replay()` still carries the latest
 * one); the `port`-handoff branch near the bottom of this file additionally
 * sends the CURRENT `mcpManager.status()` the instant a UI port binds
 * (`sendDirect`, un-buffered — regenerated per connect, same posture as
 * `host_ready` itself), mirroring the host_ready cascade so a late-attaching
 * renderer never has to wait for the next status CHANGE to see where things
 * stand. `handleShutdown` disposes `mcpManager` between `terminals.dispose()`

 *
 * LSP/diagnostics wiring (slice 6.DP-1, deferred consume of shipped 6.1 core):
 * between the hook-config and explicit-MCP blocks, boot() reads the SAME
 * .anycode/config.json `lspServers` section via `loadLspServerSpecs` (no new
 * trust surface) and, only for a non-empty config, lazily constructs an
 * `LspManager(execAdapter, specs, workspace)` and re-registers the
 * diagnostics-wrapped Edit/Write tools (`silentDuplicateWarning`, SAME tool
 * metadata — no new tool NAMES, so the toolNames snapshot below and the system
 * prompt stay byte-identical). `lspManager` is threaded into `AgentLoopConfig`
 * (mirror of cli/main.ts), so the desktop agent sees compile diagnostics right
 * after an edit exactly as the CLI does; `handleShutdown` reaps live servers via
 * bounded `lspManager?.disposeAll()` STRICTLY between `terminals.dispose()` and
 * the MCP dispose (terminals -> lsp -> mcp -> session). `AiSdkModelPort` also
 * takes a named `hostDiagnosticSink` (5.6 deferred host-half) as its second ctor
 * argument — the explicit host seam for provider diagnostics.
 *
 * Background-task wiring (slice 6.DP-2, deferred consume of shipped 5.5 core):
 * between the hook-config and LSP blocks, boot() unconditionally constructs an
 * `InProcessTaskManager(execAdapter)` (zero I/O — inert until the model's first
 * run_in_background call) and re-registers Bash as `backgroundCapableBashTool`
 * (`silentDuplicateWarning`, the SAME metadata object — permission byte-identical
 * to synchronous Bash) plus the read-only `bashOutputTool`/`bashKillTool`, all
 * STRICTLY before the toolNames snapshot below so the two new tool names reach
 * the system prompt exactly as they do in the CLI interactive. `taskManager` is
 * threaded into `AgentLoopConfig` (mirror of cli/main.ts) and handed to Session
 * as a narrow `drainNotices` seam (Session injects between-turn completion
 * notices at the top of each accepted turn); `handleShutdown` reaps live tasks
 * via bounded `taskManager?.disposeAll()` STRICTLY between `terminals.dispose()`
 * and the LSP reap (terminals -> tasks -> lsp -> mcp -> session).
 *
 * Extensions bootstrap (design slice-3.3-cut.md §3.7/§6, task 3.3.5; widened by
 * slice-3.4-cut.md §2.9/§6, task 3.4.5): between the hook-config and MCP
 * blocks, boot() reads the explicit MCP specs FIRST (their resolved names
 * become the claimed-set an explicit config always wins over a same-named
 * plugin server) and then calls the SAME `discoverExtensions` the CLI wiring
 * calls — skills discovery, agent profiles, plugins-lite, and (3.4) workflow
 * discovery — so the two wiring paths never drift. Fail-soft (same posture as
 * its neighbors): a thrown discovery leaves the host with an empty bootstrap
 * (byte-identical to today's boot with no extensions) rather than aborting.
 * The single `mcpManager.start(...)` call below combines the explicit specs
 * with `ext.pluginMcpServerSpecs` (still exactly one start() call — the 3.2
 * once-only ruling holds). `ext.skills`/`ext.skillsPromptSection`/
 * `ext.profiles` feed `AgentLoopConfig.skills`, the `systemPrompt`
 * concatenation, and `withSubagents(config, {profiles})` respectively;
 * `ext.workflows`/`ext.workflowsPromptSection` feed the same `systemPrompt`
 * concatenation and `withWorkflows(loopConfig, ext.workflows)`, called AFTER
 * `withSubagents` since it reads the SubagentPort that call just attached.
 * `ext.profilesPromptSection` (slice-3.7-cut.md §2.6) is a further additive
 * tail on the same `systemPrompt` concatenation — it makes `ext.profiles`
 * (already flowing into `withSubagents` above) visible to the MODEL too, so
 * a custom `agent_type` is callable first-try instead of only after
 * discovery-by-failure; it is NOT threaded into `withSubagents`'s options,
 * since a child has no Agent tool and so nothing to discover (design §1
 * scope note, prompts/subagent.ts untouched).
 * `handleShutdown` is UNCHANGED: skills/profiles/workflow definitions are not
 * processes — a workflow run's step children die inside the existing
 * subagent-runner cancellation chain, and a plugin-declared MCP server dies
 * inside the existing `mcpManager.dispose()`.
 *
 * Always-allow persistence + env-scrub (slice 2.2.3, design §5 / ruling §3):
 * boot() seeds a SessionPermissionRules from settings.json (host/boot.ts's
 * seedAlwaysAllowRules, fail-soft — main is the only writer of settings.json,
 * host only ever reads it) and wraps ModePermissionEngine in a
 * SafeCommandPermissionEngine (slice 5.1 §2.4: auto-approves a Bash command
 * proven read-only by the conservative classifier, narrowing ask->allow only),
 * then a RunAllowBashPermissionEngine (TASK.138 slice 2: a per-RUN, non-persisted
 * Bash allow-list read once from `ANYCODE_RUN_ALLOW_BASH` — a process input for
 * an unattended run, never a setting; see run-allow-bash.ts), and finally a
 * RuleAwarePermissionEngine over that, so a persisted always-allow rule
 * auto-allows a matching tool from the session's very first turn. The SAME
 * rules instance is handed to Session, which appends to it when a
 * `permission_response` carries `remember` on an "allow" (data-plane half of
 * "Always allow"; main's `permission-rule-add` IPC is the control-plane half
 * that persists the rule for future boots, 2.2.2/2.2.4).
 *
 * TASK.144 extends the SEED to the two engine boots (bootCodexSession /
 * bootClaudeSession), which until now handed Session an empty store and so
 * ignored settings.json entirely. Those two sessions have no core permission
 * engine to wrap (`supportsCorePermissions` is false for both), so the rules
 * instance goes to their IpcPermissionBroker instead — the only point their
 * approval bridges pass through. The core boot's broker deliberately gets NO
 * rules; permission-broker.ts's PermissionRuleMatcher header carries the
 * reason (a PreToolUse hook may raise a rule-allowed call back up to "ask",
 * and that upgrade must survive). boot()'s `finally`
 * scrubs SECRET_ENV_KEYS from this process's own `process.env` — after the
 * AiSdkModelPort above has already captured the key by value, and before any
 * turn (hence any Bash child) can possibly run — on both the success AND the
 * init-failure path (defense-in-depth).
 *
 * Control plane (parentPort, main <-> host): receives the UI MessagePortMain
 * (handed off as event.ports[0], possibly re-handed on renderer reload), the

 * slice 2.5 §3.3 — `CredentialResponse` messages (shared/credentials.ts),
 * dispatched by requestId to whichever `MainCredentialProvider` (built by
 * `buildResolveApiKey` in boot(), oauth mode only) is currently awaiting an
 * answer; this branch is registered at module scope so it needs no `ready`
 * wait (a request can only be sent from inside a turn, i.e. strictly after
 * boot() has resolved). The data plane is the UI MessagePort itself, driven
 * entirely by Session.
 *
 * Bootstrap is async (SqlitePersistenceAdapter.createSession,
 * createDefaultTokenizer's lazy gpt-tokenizer import, and loadHookConfigs all
 * await I/O), so `session`/`initFailure` are no longer settled synchronously
 * right after this module evaluates. Both of the OTHER inbound-message
 * branches below (`port` handoff and `shutdown`) await the `ready` promise first, so a
 * message that races the tail of boot() always observes the final outcome
 * instead of a half-initialized `session === null`.
 *
 * Context-window resolution (slice 6.4, mirror of cli/main.ts): boot resolves
 * `env ANYCODE_CONTEXT_WINDOW > catalog window of the session model > absent`
 * once, ahead of `AgentLoopConfig`, so a catalog model's auto-compaction
 * budget matches its real provider window instead of the generic default.
 */

import { randomUUID } from "node:crypto";
import { homedir, release, tmpdir } from "node:os";
import { realpath as fsRealpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultChildReportDir, saveFullChildReport } from "./child-report-spill.js";
import {
  AgentLoop,
  AiSdkModelPort,
  ConversationHistory,
  InMemoryHookRunner,
  InMemoryTodoStore,
  InProcessTaskManager,
  JsonlTelemetrySink,
  LspManager,
  McpManager,
  buildMcpInstructionsSection,
  ModePermissionEngine,
  NodeArtifactStore,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeGitAdapter,
  NodeHttpAdapter,
  NodeMcpTransportFactory,
  createModelAskClassifier,
  parseRunAllowBash,
  RuleAwarePermissionEngine,
  RunAllowBashPermissionEngine,
  SafeCommandPermissionEngine,
  SqlitePersistenceAdapter,
  SwitchableModelPort,
  WriteBehindHistorySink,
  PREVIEW_BUILTIN_SKILLS,
  SUBAGENT_BUILTIN_SKILLS,
  WORKTREE_BUILTIN_SKILLS,
  backgroundCapableBashTool,
  bashKillTool,
  bashOutputTool,
  buildSystemPrompt,
  buildEngineTelemetryTap,
  buildChildModelSettingsResolver,
  buildRepoMapPromptSection,
  buildSubagentTelemetryTap,
  buildTelemetryTap,
  createCommandHook,
  createDefaultTokenizer,
  createDefaultToolRegistry,
  createInspectImageTool,
  createMediaProjectionPort,
  createSkillPort,
  createWebSearchTool,
  loadArchMapEnabled,
  discoverAgentProfiles,
  AskCache,
  browserOpenTool,
  browserReadTool,
  browserScreenshotTool,
  diagnosticsEditTool,
  diagnosticsWriteTool,
  enterWorktreeTool,
  exitWorktreeTool,
  discoverExtensions,
  formatChildStallNotice,
  childNotificationSummaryOverflows,
  formatChildTaskNotification,
  formatSupervisorIdleReminder,
  generateSessionTitle,
  loadEnvConfig,
  loadHookConfigs,
  loadLspServerSpecs,
  loadMcpServerSpecs,
  loadRepoMapConfig,
  loadTelemetryConfig,
  loadWebSearchConfig,
  type LiveModelCapabilities,
  mapChildRunStatusToNotification,
  matchCatalogEntryByBaseUrl,
  parseImageInputModelOverride,
  resolveContextWindowInfo,
  resolveEffortLevels,
  resolveImageInput,
  type ImageModalityLookup,
  resolveIncludeUsage,
  resolveMaxOutputTokens,
  clampSubagentMaxOutputTokens,
  resolveReasoningEffort,
  runWrapUp,
  SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS,
  // taskana 4181: supervisor idle-watchdog defaults (see
  // deliverSupervisorIdleReminder / the SupervisorIdleWatchdog constructions).
  SUPERVISOR_IDLE_ESCALATE_AFTER,
  SUPERVISOR_IDLE_FIRST_MS,
  SUPERVISOR_IDLE_REPEAT_MS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  REPO_MAP_MAX_TOKENS,
  REPO_MAP_MIN_TOKENS,
  REPO_MAP_WINDOW_FRACTION,
  withSubagents,
  withWorkflows,
  // Taskana 4704 §3.1/§3.6: role personas, their turn budgets, and the
  // role-route chain plumbing (host-side resolver below).
  PERSONAS,
  ROLE_TURN_BUDGETS,
  isRoleRouteName,
  // TASK.4721: the one ceiling-object builder (adaptive key absent when off).
  buildCeilingConfig,
  type PersonaDefinition,
  type RoleRouteResolution,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import { closeProxyRelay, credentialedProxyValuesForRelay, resolveProxyRelay } from "@anycode/core/proxy-relay";
import type {
  AgentBridgeCatalogEntry,
  AgentEvent,
  AgentLoopConfig,
  BuiltinSkillDefinition,
  CommandHookDeclaration,
  ExtensionsBootstrap,
  LspServerSpec,
  MediaCapabilityPort,
  McpServerSpec,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  PermissionMode,
  PreviewPort,
  ProviderTransport,
  ReasoningEffort,
  RecognizerEndpoint,
  ResolvedTelemetryConfig,
  ResolvedWebSearchBackend,
  RepoMapConfig,
  SessionSubagentOutcome,
  SessionSubagentRequest,
  SubagentRunOptions,
  SubagentStallReport,
  SystemPromptEnv,
  TelemetryPort,
  TokenUsage,
  WorktreeControlPort,
  WorkspaceTransition,
} from "@anycode/core";
import { buildAgentProfileRoots } from "@anycode/core/subagents-admin";
import { hasDurableTransitionResult } from "./worktree-recovery.js";
import {
  createSubagentBudgetPort,
  defaultTurnBudgetHistoryPath,
  recordAcceptedChildBudget,
  stampLearnedMaxTurns,
} from "./turn-budget-store.js";
import { anycodeSetupDocsForHost } from "./anycode-setup-docs.js";
import { buildHostBuiltinSkills } from "./builtin-skills.js";
import { ChildReportQueue } from "./child-report-queue.js";
import {
  SUPERVISOR_IDLE_TERMINAL_MARKERS,
  resolveSupervisorIdleFirstMs,
  SupervisorIdleWatchdog,
  type SupervisorIdleReport,
} from "./supervisor-idle-watchdog.js";
import { attachChildReportDurability, attachEngineChildReportDurability } from "./child-report-durability.js";
import { createSpawnModeCell } from "./spawn-mode-cell.js";
import { RoleHealthCache, decideRoutedTerminal, entryLabel, pickEntry, resolveRoleRouteChain, respawnReportId, toCoreEntry } from "./role-route.js";
import { parseSettings } from "../settings/schema.js";
import { ENV_APP_VERSION, parseAppVersionEnv } from "../main/host-env.js";
import { readFileSync, realpathSync } from "node:fs";
import type { HostToUiMessage, ShellCapabilitiesProjection, WireRepoMapStatus } from "../shared/protocol.js";
import {
  CREDENTIAL_RESPONSE_TYPE,
  ENV_AUTH_MODE,
  type CredentialRequest,
  type CredentialResponse,
} from "../shared/credentials.js";
import { TERMINAL_INIT_MESSAGE_TYPE } from "../shared/terminal.js";
import { WORKSPACE_TRUST_PENDING_MESSAGE_TYPE } from "../shared/workspace-trust.js";
import { applySessionToolEnv } from "../shared/session-env.js";
import { establishHostWorkspaceTrust, type HostWorkspaceTrust } from "./workspace-trust.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { PROVIDER_QUOTA_EVENT_TYPE, type ProviderQuotaEvent } from "../shared/provider-quota.js";
import { RECOGNIZER_CONFIG_CHANGED_TYPE, type RecognizerConfigChanged } from "../shared/recognizer.js";
import { PREVIEW_ARTIFACTS_TYPE } from "../shared/preview.js";
import type { PreviewEventMessage, PreviewRequestMessage, PreviewResponseMessage } from "../shared/preview.js";
import type { RetryPolicy } from "@anycode/core";
import type { McpSecretResolver } from "@anycode/core";
import { takeMcpSecretsEnv } from "./mcp-secrets.js";
import {
  WORKTREE_CLEANUP_ENV,
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeCleanupIntent as WireWorktreeCleanupIntent,
} from "../shared/worktrees.js";
import {
  buildResolveApiKey,
  childRetryPolicy,
  createPreviewRpcClient,
  hostDiagnosticSink,
  isChildSessionBoot,
  parseHostArgs,
  readConnectionModelCapabilities,
  resolveChildMaxTurns,
  resolveEngineDraftPresetId,
  repairDanglingToolCalls,
  resolveBootSession,
  routePreviewMessage,
  scrubSecretEnv,
  seedAlwaysAllowRules,
} from "./boot.js";
import { artifactsRootFor } from "../shared/artifacts-root.js";
/**
 * Mirrors main/index.ts's own literal (dev-profile settings path override,
 * design/slice-P7.15-cut.md §2.6) — kept in sync by contract, same convention
 * as this file's other duplicated ENV_* names (e.g. ENV_AUTH_MODE's sibling
 * shared/credentials.js constant).
 */
const ENV_SETTINGS_PATH = "ANYCODE_SETTINGS_PATH";
/**
 * TASK.103: the same trimmed-non-empty-or-undefined read of `ENV_SETTINGS_PATH`
 * `boot()` already performs inline at its `seedAlwaysAllowRules` call site
 * (below) — extracted here so the two spawn-time `binaryTrust` closures
 * (bootCodexSession / bootClaudeSession) can share it without reaching into
 * `boot()`'s local scope. The `boot()` call site itself is left untouched
 * (byte-identical): this helper is a NEW standalone read, not a replacement.
 */
function hostSettingsPathOverride(): string | undefined {
  const raw = process.env[ENV_SETTINGS_PATH];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}
/**
 * Mirrors main/host-env.ts's `ENV_CONNECTION_ID` (TASK.45 W10) — kept in sync by
 * contract, same convention as `ENV_SETTINGS_PATH` above (host does not import
 * main/*). Informational: the pinned provider connection id main stamped into
 * this fork's env, persisted verbatim into the session row so resume resolves
 * the same connection. Never a credential — the resolved key rides ANYCODE_API_KEY.
 */
const ENV_CONNECTION_ID = "ANYCODE_CONNECTION_ID";
/**
 * TASK.138 slice 2: per-run Bash allow-list. Set by whoever LAUNCHED this
 * process (an autonomous/unattended run), never persisted, never a setting —
 * see the module doc on `RunAllowBashPermissionEngine`
 * (packages/core/src/permissions/run-allow-bash.ts) for the full rationale
 * and matching rules. Comma-separated command prefixes, e.g.
 * `"pnpm test,pnpm typecheck"`.
 */
const ENV_RUN_ALLOW_BASH = "ANYCODE_RUN_ALLOW_BASH";
/** Taskana 4702: the ask-zone classifier record (JSON). Mirror of host-env.ts's constant. */
const ENV_PERMISSION_CLASSIFIER = "ANYCODE_PERMISSION_CLASSIFIER";
/**
 * 4088-on-4118 integration: the former ANYCODE_IMAGE_INPUT_MODELS local
 * literal is GONE — the live image-modality facts ride 4118's
 * modelCapabilities map (`imageInput?: true`), read fail-soft from THIS
 * fork's connection record at boot (see liveCapsFor).
 */
/** Taskana 4088: `<on|off>:<modelId>`, the drawer's per-model override (main/host-env.ts). */
const ENV_IMAGE_INPUT_MODEL_OVERRIDE = "ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE";
import { resolveExtensionsHomeOverride, resolveSessionHistoryMaxItems } from "./dev-home.js";
import { buildCheckpointService } from "./checkpoints.js";
import { GitBridge } from "./git-bridge.js";
import { CoreEngine } from "./engines/core-engine.js";
import { beginEngineBootstrap, type EngineBootstrap } from "./engines/bootstrap.js";
import { selectEnginePlugin, type EnginePlugin } from "./engines/registry.js";
import { resumeCodexEngine, startCodexEngine } from "./engines/codex/codex-engine.js";
import {
  assertCodexProfileHome,
  ensureChildTempDir,
  parseCodexProfileArgs,
  removeChildTempDir,
  resolveChildTempDir,
  resolveCodexProfile,
  resolveCodexProfilesHomeOverride,
} from "./engines/codex/codex-home.js";
import { parseCodexEngineArgs } from "./engines/codex/draft-args.js";
import { readHostProcessOwnership } from "./engines/codex/process-ownership.js";
import { SqliteCodexShadowLog } from "./engines/codex/shadow-log.js";
import { checkCodexBinaryTrustOnDisk } from "./engines/codex/app-server-client.js";
import { ENV_CODEX_BIN } from "../shared/engines.js";
// SLICE-CC C4 (cut §1.4): new import lines — the Claude composition mirrors the
// codex one above. `readHostProcessOwnership` is aliased because the claude
// directory carries its own deliberate duplicate of that module (cut §1.3), and
// both are imported into this one composition root.
import { ENV_CLAUDE_BIN } from "../shared/engines.js";
import { resolveClaudeConfigDir } from "../shared/claude-config-dir.js";
import { resumeClaudeEngine, startClaudeEngine, type ClaudeInitMcpServerStatus } from "./engines/claude/claude-engine.js";
import { prepareEngineMcpForward, missingForwardedMcpServerNames } from "./engines/mcp-forward-boot.js";
import { parseClaudeEngineArgs } from "./engines/claude/draft-args.js";
import { bridgeCallableCatalog, catalogFromProfiles } from "./engines/claude/bridge-catalog.js";
import { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";
import { ClaudeMcpBridge } from "./engines/claude/mcp-bridge.js";
import { projectClaudeHistory } from "./engines/claude/history-projection.js";
import { readHostProcessOwnership as readClaudeHostProcessOwnership } from "./engines/claude/process-ownership.js";
import { ClaudeSettingsSeam } from "./engines/claude/settings-seam.js";
import { ClaudeShadowTranscriptEngine, SqliteClaudeShadowTranscript } from "./engines/claude/shadow-transcript.js";
import { ClaudeSessionRowWriter } from "./engines/claude/session-row.js";
import { claudeAgentPermissionMode, claudeChildPresetId, codexChildAutoAcceptsWorkspacePatches, codexChildPosture } from "./engines/child-permission-map.js";
import { checkClaudeBinaryTrustOnDisk, CLAUDE_AGENT_BRIDGE_PROMPT } from "./engines/claude/claude-client.js";
import { createEngineChildRunner } from "./engine-children.js";
// TASK.103: the host-side consent reader. Host never WRITES settings.json
// (main is the sole writer, host/boot.ts:239-245) — this is the sanctioned
// fail-soft read, same standing custody as seedAlwaysAllowRules above.
import { defaultSettingsPath, readTrustedBinaryConsentsSync } from "../settings/files.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { wirePlanExit } from "./plan-exit.js";
import { Outbound, Session, summarizeProviderUsage, tapChildPermissions, type ChildSessionOptions } from "./session.js";
// TASK.102 CUT-S2 §2.6.2/§2.6.3 (slice S2b B4) built the CHILD side of this
// wire (child-ready on first ui_ready, child-start dispatch, permission-tap
// attention, terminal report). Slice S2b B5 (below) adds the PARENT side: the
// RPC-client wiring (createChildSessionPort), the ChildRunEvent dispatch
// table, and the sessionTier:true/sessionSubagents non-recursion locks.
import { createChildSessionPort, type ChildSessionPort } from "./child-session-port.js";
import {
  CHILD_PROGRESS_TYPE,
  CHILD_READY_TYPE,
  CHILD_TERMINAL_TYPE,
  parseChildRunEvent,
  parseChildStart,
  type ChildProgress,
  type ChildReady,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildRunSend,
  type ChildSpawnRequest,
  type ChildTerminal,
} from "../shared/child-sessions.js";
import { parseAskClassifierEnvKind, type AskClassifierBoot } from "./ask-classifier-env.js";
// Taskana 4730: engine-session approval coverage via a broker decorator.
import { CLASSIFYING_BROKER_MODEL_TIMEOUT_MS, withAskClassifier } from "./classifying-broker.js";
import { decorateEngineBroker, type EngineClassifierBoot } from "./engine-classifier-boot.js";
import { createSnapshotHook } from "./snapshot-hook.js";
import { TerminalManager } from "./terminal.js";
import { createWirePort } from "./wire.js";
import {
  cleanupOwnedWorktreeResource,
  WorktreeLifecycleService,
  type WorktreeCleanupIntent,
} from "./worktree-lifecycle.js";

const workspace = process.cwd();

// Per-tab PTY terminal (design §1/§3.3, slice 2.4.3). Lazily spawns a shell on
// the first `term_open`; its env is read at spawn time so it is always the
// post-scrub process.env (secret-scrub invariant). Bound to the second
// (term-) channel below, disjoint from the agent data plane.
const terminals = new TerminalManager({ workspace });

const outbound = new Outbound();
const emit = (message: HostToUiMessage): void => {
  outbound.emit(message);
};

// Taskana 4736: the workspace trust gate, decided once per boot (see boot()). Until
// boot computes it the gate is closed. `projectTrusted` gates every project-level
// spawn declaration (MCP, hooks, LSP, project-tier plugin MCP); the pending message
// is replayed to the UI on every ui_ready while the folder is undecided or changed.
let hostWorkspaceTrust: HostWorkspaceTrust = { projectTrusted: false };
function workspaceTrustRequiredMessage(): HostToUiMessage | undefined {
  return hostWorkspaceTrust.pending?.message;
}
// TASK.145 срез 2: one pending-report queue per host process, i.e. per parent
// session — see child-report-queue.ts's own header for why a bare
// `outbound.sendDirect` (срез 1) is not reconnect-safe on its own. Wired into
// `deliverDetachedChildReport` below and, once the root Session exists, into
// its own `pendingChildReports` seam (resendAll on ui_ready, ack on
// child_report_ack). Taskana 4123 follow-up: all three root boots (core via
// attachChildReportDurability, codex/claude via attachEngineChildReportDurability)
// restore this queue from the session row before their Session's first
// ui_ready and persist every mutation back to it.
const childReportQueue = new ChildReportQueue(outbound);

// ── Taskana 4704 §3.6: host-side role-route state ──
//
// One RoleHealthCache per host process (process-local by design, §9-Q3: a
// restart re-probes naturally — never persisted). `resolveRoleRoute` (wired
// into withSubagents + the session-tier Agent path via the SubagentPort)
// reads settings `roles` and consults this cache; the detached-terminal
// respawn path marks failures/successes here.
//
// A ROLE persona (planner/executor/reviewer/explore) with configured roles
// resolves to `{ entries, skipped, turnBudget }`; everything else returns
// null (built-in defaults apply). The parent model remains the implicit last
// resort: when every entry is skipped/unhealthy, `entries` comes back EMPTY
// and no route fields are stamped anywhere.
const roleHealth = new RoleHealthCache();
type RolesSettings = NonNullable<import("../shared/settings.js").AnycodeSettings["roles"]>;

/**
 * Live roles settings cell (Taskana 4704 §3.6). Synchronous read of the
 * settings document (fail-soft): the `resolveRoleRoute` port method is sync,
 * so the cell is refreshed eagerly — once at boot and again whenever main
 * signals a settings change (same notification the always-allow rules use).
 * Absent roles means "built-in defaults".
 */
let rolesSettings: RolesSettings | undefined;
function refreshRolesSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(defaultSettingsPath(), "utf8"));
    const parsed = parseSettings(raw);
    rolesSettings = parsed.status === "ok" ? parsed.settings.roles : undefined;
  } catch {
    rolesSettings = undefined;
  }
}
refreshRolesSettings();

/**
 * Taskana 4732 S1-B (design §4/§7): plugins settings cell — same live-cell
 * pattern as rolesSettings. Carries ONLY what discovery needs: the MCP
 * consent list (`mcpConsent`, keyed by serversHash; undefined = never
 * migrated/granted, [] = explicitly declined). Refreshed at boot and on
 * every settings change notification, read fail-soft (absent block =
 * undefined, byte-identical pre-S1-B discovery).
 */
type PluginsSettings = NonNullable<import("../shared/settings.js").AnycodeSettings["plugins"]>;
let pluginsSettings: PluginsSettings | undefined;
function refreshPluginsSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(defaultSettingsPath(), "utf8"));
    const parsed = parseSettings(raw);
    pluginsSettings = parsed.status === "ok" ? parsed.settings.plugins : undefined;
  } catch {
    pluginsSettings = undefined;
  }
}
refreshPluginsSettings();

/**
 * Taskana 4704 §3.6: the host-side role-route resolver — the ONE port method
 * core uses for role chains (runner inline walk + Agent session-tier
 * stamping). Reads settings `roles[agentType]`, builds [primary, ...
 * fallbacks], consults the health cache, and returns the still-healthy tail
 * (spawn-time selection skips cooldown/known-dead entries). The parent model
 * is the implicit last resort: every entry skipped => empty `entries`, and no
 * route fields are stamped anywhere downstream.
 *
 * `turnBudget` rides only the three ROLE personas (ROLE_TURN_BUDGETS);
 * explore keeps DEFAULT_SUBAGENT_MAX_TURNS (§2.9).
 */
/**
 * N2 (Taskana 4704 re-review #3): the role names a hand-authored md agent
 * profile (`.anycode/agents/*.md`) currently claims. Refreshed whenever `ext`
 * is (re)assigned — boot discovery and the live profile rescan. A claimed role
 * is NOT a settings-routed role: md-profile > settings-derived > built-in
 * (§2.1), so the resolver answers null and the profile's own routing applies.
 */
let mdClaimedProfileNames: ReadonlySet<string> = new Set();
function resolveRoleRouteImpl(agentType: string): RoleRouteResolution | null {
  if (!isRoleRouteName(agentType)) return null;
  const budget =
    agentType === "planner" || agentType === "executor" || agentType === "reviewer"
      ? ROLE_TURN_BUDGETS[agentType]
      : undefined;
  return resolveRoleRouteChain({
    role: agentType,
    config: rolesSettings?.[agentType],
    claimedByMdProfile: mdClaimedProfileNames.has(agentType),
    health: roleHealth.snapshot(),
    now: Date.now(),
    ...(budget !== undefined ? { turnBudget: budget } : {}),
  });
}

// Credential broker (design §3.3, slice 2.5.3): CredentialResponse messages
// arrive on the same parentPort "message" event as the port-handoff/shutdown
// control messages below; MainCredentialProvider instances (one per
// resolveApiKey created in boot(), oauth mode only) subscribe here and
// correlate by requestId.
const credentialResponseListeners = new Set<(response: CredentialResponse) => void>();

function subscribeCredentialResponses(listener: (response: CredentialResponse) => void): () => void {
  credentialResponseListeners.add(listener);
  return () => {
    credentialResponseListeners.delete(listener);
  };
}

function sendCredentialRequest(request: CredentialRequest): void {
  process.parentPort.postMessage(request);
}

// Session-subagent RPC broker (TASK.102 CUT-S2 §2.6.1, slice S2b B5):
// ChildRunEvent messages (main -> this parent host) arrive on the SAME
// parentPort "message" event as every other control-plane channel above;
// createChildSessionPort's per-run() waiter subscribes here and correlates by
// requestId internally (its own `Map<requestId, waiter>`) — this dispatch
// table only fans a parsed event out to every current subscriber, mirroring
// the credential/preview broker pattern immediately above. Exactly one
// subscriber exists for the life of a non-child boot (createChildSessionPort
// calls `options.subscribe` once, at construction), but the Set (rather than
// a single slot) keeps this table byte-identical in shape to its two
// siblings above.
const childRunEventListeners = new Set<(event: ChildRunEvent) => void>();

function subscribeChildRunEvents(listener: (event: ChildRunEvent) => void): () => void {
  childRunEventListeners.add(listener);
  return () => {
    childRunEventListeners.delete(listener);
  };
}

function sendChildSessionMessage(message: ChildSpawnRequest | ChildRunCancel | ChildRunSend): void {
  process.parentPort.postMessage(message);
}

/**
 * Taskana 4704 §3.6: per-spawn record of the role entry a DETACHED spawn
 * actually ran on (the host stamped it at spawn time via the Agent tool's
 * roleRoute). Keyed by `spawnToolCallId` — the stable id a terminal outcome
 * carries back. Removed at every terminal (the port's onDetachedTerminal
 * fires exactly once per detached child).
 */
interface RoutedSpawnRecord {
  role: string;
  /** The entry this child is running on (already core-shaped). */
  entry: import("@anycode/core").RoleRouteEntry;
  /** The REMAINING chain after `entry` (health re-checked at respawn). */
  rest: import("@anycode/core").RoleRouteEntry[];
  /** True once this spawn already ran on a non-primary entry (visibility §3.6). */
  usedFallback: boolean;
  /** The reason the primary was skipped (for the visibility line); undefined when the primary was used. */
  skipReason?: string;
}
const routedSpawns = new Map<string, RoutedSpawnRecord>();

/**
 * Taskana 4704 §3.6 (cross-review F2): registers a detached spawn's route
 * facts at ADMIT time. Called by the host wrapper around the child port with
 * the entry the child ACTUALLY runs on (as stamped on the request) plus the
 * remaining chain — pure bookkeeping, no I/O.
 */
function noteRoutedSpawn(
  req: SessionSubagentRequest,
  actualEntry: import("@anycode/core").RoleRouteEntry,
  rest: import("@anycode/core").RoleRouteEntry[],
  skipped: readonly { entry: import("@anycode/core").RoleRouteEntry; reason: string }[],
): void {
  if (!isRoleRouteName(req.agentType)) return;
  routedSpawns.set(req.spawnToolCallId, {
    role: req.agentType,
    entry: actualEntry,
    rest: [...rest],
    usedFallback: skipped.length > 0,
    ...(skipped.length > 0 ? { skipReason: skipped[0]!.reason } : {}),
  });
}

/**
 * Taskana 4704 §3.6 — the visibility line for a terminal report: names the
 * role, the NON-PRIMARY entry it ran on, and why (spawn-time skip reason or
 * respawn cause). Undefined for primary-entry runs (the common case — no
 * noise). MUST run before respawnRoutedRoleChild (which consumes the record).
 */
function detachedRouteNotice(req: SessionSubagentRequest): string | undefined {
  const record = routedSpawns.get(req.spawnToolCallId);
  if (record === undefined || !record.usedFallback || record.skipReason === undefined) {
    return undefined;
  }
  return `Role ${record.role} ran on ${entryLabel(record.entry)} because ${record.skipReason}.`;
}

/**
 * Taskana 4704 §3.6 — the detached-terminal respawn decision (pure logic in
 * role-route.ts's decideRoutedTerminal; this wrapper performs the I/O: the
 * re-spawn through the port and the short report). Returns true when the
 * terminal was CONSUMED by a respawn (the caller must NOT deliver the child's
 * error report). False => deliver the outcome unchanged (possibly with the
 * appended exhausted-chain line).
 */
function respawnRoutedRoleChild(outcome: SessionSubagentOutcome, req: SessionSubagentRequest): boolean {
  const record = routedSpawns.get(req.spawnToolCallId);
  routedSpawns.delete(req.spawnToolCallId);
  // R2: classify the SAFE error descriptor only — never the child's free
  // model text (see role-route.ts decideRoutedTerminal).
  const decision = decideRoutedTerminal(record, outcome.status, outcome.finalText, roleHealth, Date.now(), outcome.errorDescriptor);
  if (decision.action === "deliver") {
    return false;
  }
  if (decision.action === "deliver_exhausted") {
    outcome.finalText = `${outcome.finalText}\n[role ${record!.role}: all route entries failed]`;
    return false;
  }
  // Respawn the same prompt/description on the next healthy entry (F5):
  // stamp the entry's OWN routing fields and clear whatever the failed
  // child carried (`...req` alone would keep a stale engine/connection of a
  // DIFFERENT hop; the entry's engine XOR connection/provider XOR bare-model
  // shape is authoritative). The respawn notice rides the FAILED child's
  // spawnToolCallId — the real respawned report arrives under its own fresh
  // id, so the renderer's originId dedupe (store.ts child_report) can never
  // swallow it.
  const respawnId = randomUUID();
  const respawnReq: SessionSubagentRequest = {
    agentType: req.agentType,
    description: `[fallback] ${req.description}`,
    prompt: req.prompt,
    spawnToolCallId: respawnId,
    ...(decision.entry.engine !== undefined ? { engine: decision.entry.engine } : {}),
    ...(decision.entry.connection !== undefined ? { connectionId: decision.entry.connection } : {}),
    ...(decision.entry.provider !== undefined ? { provider: decision.entry.provider } : {}),
    ...(decision.entry.model !== undefined ? { model: decision.entry.model } : {}),
    ...(decision.entry.effort !== undefined ? { effort: decision.entry.effort } : {}),
    detach: true,
  };
  routedSpawns.set(respawnId, { ...decision.next, rest: [...decision.next.rest] });
  // F5(c): the run() promise is fully handled here — a detached run settles
  // at admit; a pre-flight/cap REFUSAL must still reach the orchestrator as
  // an honest failure report under the FAILED child's id, never as a silent
  // "retrying" that no report ever follows.
  // R3 (Taskana 4704 cross-review): the honest refusal/failure report after
  // a failed respawn rides a DISTINCT queue id — never the failed child's
  // spawnToolCallId, which the "retrying" notice just took: the renderer
  // dedupes child_report by originId (store.ts), so a second report under
  // the same id is silently dropped. The distinct id is namespaced off the
  // failed child's id (stable, one per respawn attempt, never collides with
  // a real spawnToolCallId uuid shape) so the retrying notice AND the honest
  // failure both reach the orchestrator.
  void childSessionPortForRespawn
    ?.run(respawnReq, {})
    .then((admit) => {
      if (admit.status === "error") {
        routedSpawns.delete(respawnId);
        childReportQueue.add(
          respawnReportId(req.spawnToolCallId, "refused"),
          formatChildTaskNotification({
            taskId: req.spawnToolCallId,
            toolUseId: req.spawnToolCallId,
            agentId: "",
            subagentType: req.agentType,
            status: "failed",
            summary: `Role ${record!.role} failed (${decision.reason}) and the fallback respawn on ${entryLabel(decision.entry)} was refused: ${admit.finalText}`,
          }),
          { status: "error", durationMs: outcome.durationMs },
        );
      }
    })
    .catch((runError: unknown) => {
      routedSpawns.delete(respawnId);
      console.error(`[host] routed role respawn failed: ${describeError(runError)}`);
      childReportQueue.add(
        respawnReportId(req.spawnToolCallId, "failed"),
        formatChildTaskNotification({
          taskId: req.spawnToolCallId,
          toolUseId: req.spawnToolCallId,
          agentId: "",
          subagentType: req.agentType,
          status: "failed",
          summary: `Role ${record!.role} failed (${decision.reason}) and the fallback respawn on ${entryLabel(decision.entry)} could not start.`,
        }),
        { status: "error", durationMs: outcome.durationMs },
      );
    });
  // The failed child's terminal is REPLACED by the short retrying notice —
  // under the failed child's id (a completed marker for a spawn that did
  // happen), consumed once the renderer acks it.
  childReportQueue.add(req.spawnToolCallId, decision.notice, { status: "completed", durationMs: 0 });
  return true;
}

/** The core boot's child port — set once constructed, used ONLY by the respawn path above. */
let childSessionPortForRespawn: ChildSessionPort | undefined;

/**
 * TASK.145 срез 1/2: builds and delivers a detached child's terminal report
 * to its parent tab. Wired as `createChildSessionPort`'s `onDetachedTerminal`
 * seam above — called ONLY for a `detach:true` session-tier spawn, strictly
 * AFTER the spawning Agent tool call already resolved at admit, so this is
 * entirely decoupled from that call's own (already-settled) promise.
 *
 * Handed to `childReportQueue` (срез 2) rather than a bare `outbound.
 * sendDirect` (срез 1's original posture) — see that queue's own header for
 * why a direct send is not reconnect-safe, and protocol.ts's `child_report`
 * doc for why `Outbound.emit`'s buffered replay is the wrong fix (no
 * per-message identity -> a resend would re-enqueue a second turn). `id` is
 * `outcome.spawnToolCallId` — stable across every re-delivery of THIS same
 * report, load-bearing for both the queue's own dedup-by-id and the
 * renderer's (store.ts's `child_report` case).
 */
function deliverDetachedChildReport(outcome: SessionSubagentOutcome, req: SessionSubagentRequest): void {
  // Taskana 4704 §3.6 — visibility: whenever a spawn actually ran on a
  // NON-PRIMARY entry (spawn-time health skip recorded at admit, or a
  // respawn), the delivered report text gains a first line naming the role,
  // the entry it ran on, and why. Reports are the orchestrator's input; the
  // child card already shows the model id (subagent_start.model). PEEKED
  // here, BEFORE the respawn decision below (which consumes the record).
  const routeNotice = detachedRouteNotice(req);
  // Taskana 4704 §3.6 — detached respawn (fallback point 2). An
  // infrastructure-class failure of a ROUTED role child marks its entry dead
  // and re-spawns the SAME prompt on the next healthy entry (a fresh child
  // session; the original error report is REPLACED by a short retrying
  // notice — the eventual real terminal delivers normally). An exhausted
  // chain delivers the original error with an appended failure line. A
  // completed routed child marks its entry healthy. Ordinary task failures
  // (classify => "none") NEVER fall back — they deliver unchanged.
  if (respawnRoutedRoleChild(outcome, req)) {
    return;
  }
  if (routeNotice !== undefined) {
    outcome.finalText = `${routeNotice}\n${outcome.finalText}`;
  }
  const fullReportPath = childNotificationSummaryOverflows(outcome.finalText)
    ? saveFullChildReport(defaultChildReportDir(), outcome.childSessionId, outcome.finalText)
    : undefined;
  const text = formatChildTaskNotification({
    taskId: outcome.spawnToolCallId,
    toolUseId: outcome.spawnToolCallId,
    agentId: outcome.childSessionId,
    subagentType: req.agentType,
    status: mapChildRunStatusToNotification(outcome.status, outcome.declaredDoneAtCeiling === true),
    summary: outcome.finalText,
    ...(fullReportPath !== undefined ? { fullReportPath } : {}),
    ...(outcome.finalTurnFinishReason === "length" ? { finalTurnFinishReason: "length" } : {}),
  });
  childReportQueue.add(outcome.spawnToolCallId, text, {
    status: outcome.status,
    durationMs: outcome.durationMs,
    ...(outcome.finalTurnFinishReason === "length" ? { finalTurnFinishReason: "length" } : {}),
    // TASK.240/4055 cross-review F2: the ceiling summary rides the report's
    // metadata so the renderer's card shows the budget line on this path too.
    ...(outcome.ceiling !== undefined ? { ceiling: outcome.ceiling } : {}),
  });
}

/**
 * TASK.148 slice 2: builds and delivers a detached child's STALL notice to
 * its parent tab — the mid-run counterpart to `deliverDetachedChildReport`
 * above, which only ever fires once, at the child's TERMINAL event. Wired as
 * `createChildSessionPort`'s `onDetachedStall` seam below, invoked from the
 * detached child's own `SubagentStallClock` (child-session-port.ts) each
 * time it fires — at most once per unbroken silent stretch, but potentially
 * many times over one long-running child (silence -> sign of life ->
 * silence again re-arms it, stall-clock.ts's own contract).
 *
 * Delivered through `childReportQueue.upsert`, NOT `.add` (the method
 * `deliverDetachedChildReport` above uses): a repeat stall notice for the
 * SAME child REPLACES its own still-pending predecessor in place instead of
 * pushing a new pending row, so a child that stalls and recovers many times
 * before the renderer ever acks can consume at most ONE of the queue's
 * `CHILD_REPORT_QUEUE_MAX_PENDING` pending slots, never more — the bound
 * that keeps a flapping child from being able to exhaust the cap (see
 * `upsert`'s own doc, `child-report-queue.ts`). The id is namespaced
 * `stall:<spawnToolCallId>` — deliberately DIFFERENT from the terminal
 * report's bare `spawnToolCallId` id above, so a stall notice and this same
 * child's eventual terminal report are two distinct, independently-tracked
 * pending entries (both informative on their own) rather than one
 * overwriting the other.
 *
 * `childSessionId` is `""` only in the practically unreachable case a stall
 * fires before the child's own "accepted" event ever arrived (the silence
 * threshold vastly exceeds admission latency) — `formatChildStallNotice`
 * simply omits `<agent-id>` rather than being handed a fabricated value.
 */
function deliverDetachedChildStall(
  report: SubagentStallReport,
  req: SessionSubagentRequest,
  childSessionId: string,
): void {
  const text = formatChildStallNotice({
    taskId: req.spawnToolCallId,
    toolUseId: req.spawnToolCallId,
    ...(childSessionId !== "" ? { agentId: childSessionId } : {}),
    subagentType: report.agentType,
    description: report.description,
    silentMs: report.silentMs,
    ...(report.lastActivity !== undefined ? { lastActivity: report.lastActivity } : {}),
    waitingForApproval: report.waitingForApproval,
  });
  childReportQueue.upsert(`stall:${req.spawnToolCallId}`, text);
}

/**
 * taskana 4181: delivers a supervisor idle reminder. The host's
 * SupervisorIdleWatchdog (constructed below for a non-child codex boot and
 * for the core root path) fires `onIdle` when the supervisor's turn has
 * ended, ZERO live detached children remain, and the turn's final assistant
 * text carried no terminal marker (READY/BLOCKED/DONE/ACCEPT) — the one
 * state of the no-polling detach loop that previously sat silent forever.
 *
 * Rides the SAME ChildReportQueue as the stall notice above, with the same
 * upsert-coalescing bound: every repeat of the reminder shares the one
 * `"supervisor-idle-reminder"` id, so a long-ignored supervisor consumes at
 * most ONE pending slot (latest text wins), never more. The renderer's
 * existing `child_report` path enqueues it origin:"system" and starts a
 * turn; a reminder that arrives mid-turn is dropped by the watchdog's own
 * noteTurnStarted disarm, and one that still races through is held
 * harmlessly by the busy queue.
 */
function deliverSupervisorIdleReminder(report: SupervisorIdleReport): void {
  const text = formatSupervisorIdleReminder({
    idleMs: report.idleMs,
    reminderCount: report.reminderCount,
    escalated: report.escalated,
    liveChildren: 0,
  });
  childReportQueue.upsert("supervisor-idle-reminder", text);
}

// Preview RPC broker (night-track wave-1 cut §2.3): PreviewResponseMessage
// messages arrive on the SAME parentPort "message" event, routed through
// routePreviewMessage (boot.ts) below; createPreviewRpcClient's per-call
// waiter subscribes here and correlates by requestId, mirroring the
// credential broker immediately above.
const previewResponseListeners = new Set<(response: PreviewResponseMessage) => void>();

function subscribePreviewResponses(listener: (response: PreviewResponseMessage) => void): () => void {
  previewResponseListeners.add(listener);
  return () => {
    previewResponseListeners.delete(listener);
  };
}

function sendPreviewRequest(request: PreviewRequestMessage): void {
  process.parentPort.postMessage(request);
}

/**
 * Turn-end auto-open (night-track wave-1 cut §1(a)/§2.3, TASK.96 96-E): posts
 * a `PreviewArtifactsMessage` over the SAME parentPort control plane as the
 * RPC broker above — unsolicited, host -> main, no requestId (fire-and-forget
 * by design, same posture as `sendCredentialRequest`/`sendPreviewRequest`
 * being the ONLY thing that touches `process.parentPort.postMessage`
 * directly in this module). Wired into every `Session` construction below as
 * `postPreviewArtifacts`.
 */
function sendPreviewArtifacts(paths: string[]): void {
  process.parentPort.postMessage({ type: PREVIEW_ARTIFACTS_TYPE, paths });
}

// Built once at module scope (zero I/O — an RPC client is just closures over
// the send/subscribe pair above); previewAvailable below gates whether the
// Browser* tools/skill are actually registered, not whether this exists.
const previewPort: PreviewPort = createPreviewRpcClient({
  send: sendPreviewRequest,
  subscribe: subscribePreviewResponses,
});

// Preview console/pageerror bridge (night-track wave-1 cut §2.4): the OTHER
// consumer boot.ts's routePreviewMessage recognizes on this same control
// plane, wired below at the parentPort "message" handler. Unlike the RPC
// broker above (request/response, correlated by requestId), a PREVIEW_EVENT_
// TYPE message is unsolicited, so it is translated straight into an outbound
// AgentEvent here rather than resolving a pending call.

/** Narrows translatePreviewEvent's return to exactly the variant it builds, so it type-checks against WireAgentEvent's error-excluding member without going through session.ts's sanitizeAgentEvent (this bridge never produces an "error"-shaped event, so there is nothing to sanitize). */
type PreviewConsoleAgentEvent = Extract<AgentEvent, { type: "preview_console" }>;

/**
 * Translates one main -> host PREVIEW_EVENT_TYPE message (shared/preview.ts)
 * into the core `preview_console` AgentEvent. Two shapes cross this channel
 * (PreviewEventMessage's own doc comment): a normal forwarded entry (`entry`
 * present, `suppressed` absent) and a pure throttle-window summary (`entry`
 * absent, `suppressed` present — every console message in that window was
 * dropped, main's forwarding cap is ≤20 per preview per rolling 10s). The
 * summary has no single real level to report honestly, so it is flagged
 * "log" (the quietest level) rather than inventing one, and its `message`
 * names the count instead of carrying a synthetic per-entry line.
 */
function translatePreviewEvent(message: PreviewEventMessage): PreviewConsoleAgentEvent {
  if (message.entry) {
    return {
      type: "preview_console",
      previewId: message.previewId,
      level: message.entry.level,
      message: message.entry.message,
    };
  }
  const suppressed = message.suppressed ?? 0;
  return {
    type: "preview_console",
    previewId: message.previewId,
    level: "log",
    message: `${suppressed} console message${suppressed === 1 ? "" : "s"} suppressed`,
    suppressed,
  };
}

/**
 * `preview_console` is NOT scoped to any turn: a preview window can keep
 * emitting console output long after its opening turn ended, or with no turn
 * ever having run at all (the user simply has the window open). The wire's
 * `agent_event` envelope still requires a `turnId` string, so this constant
 * fills it; the renderer's turn-scoped drop guard is taught to exempt
 * `preview_console` by event type (store.ts, the same exemption shape as
 * `context_usage`), so the literal value here is never matched against the
 * active turn — it only needs to satisfy the wire schema.
 */
const PREVIEW_CONSOLE_TURN_ID = "preview-console";

let session: Session | null = null;
/**
 * Taskana 4730: late-bound Session reference for the ENGINE-SESSION classifier
 * coverage. The codex/claude brokers are decorated BEFORE the Session exists
 * (the bridges capture the broker at construction), so the decorator's
 * userContext/emit thunks read through this cell; until the Session binds they
 * answer [] / no-op, matching the decorator's fail-closed "ask" default.
 */
let classifierSessionRef: Session | null = null;
/** Exists before engine-specific boot; owns cleanup when Session was never built. */
let engineBootstrap: EngineBootstrap | null = null;
let initFailure: string | null = null;
let historySink: WriteBehindHistorySink | null = null;
let persistence: SqlitePersistenceAdapter | null = null;
/**
 * Taskana 4083 cross-review finding 4: the usage-audit write-behind tail —
 * every recordProviderUsage call chains off the previous one (serialized,
 * same discipline as WriteBehindHistorySink's queue), and the sink's flush()
 * resolves once the tail settles. Lets Session.shutdown() drain audit writes
 * strictly before the host closes the database.
 */
let usageAuditWriteTail: Promise<void> | null = null;
// null until the MCP boot block below successfully constructs one (or forever
// null if it fails-soft) — every reader below guards on this (design §6).
let mcpManager: McpManager | null = null;
// null until boot() resolves an opt-in, enabled telemetry config (slice 6.6,
// default-OFF) — every reader below guards on this, same idiom as mcpManager.
let telemetry: { port: TelemetryPort; session: string } | null = null;
// null until boot() finds a non-empty lspServers config (or forever null —

// even non-null, no server child exists until the first matching Edit/Write.
let lspManager: LspManager | null = null;
// Constructed unconditionally in boot() (zero I/O, no config read — inert until
// the model's first run_in_background call); null only before boot resolves or
// after an init failure. Desktop has no print mode, so the CLI's `!print` gate
// (cli/main.ts:428) degenerates to always-on — same degeneration ruling as
// 6.DP-1's lspEnabled.
let taskManager: InProcessTaskManager | null = null;
// GitBridge (slice 5.7): the desktop consumer of GitPort. Constructed
// unconditionally in boot() (zero I/O in its constructor, dormant-gate like the
// CLI); `git:null` inside it when this is a non-git workspace. `gitAbort` reaps
// any in-flight git child at shutdown via the proven runBinary abortSignal path

let gitBridge: GitBridge | null = null;
const gitAbort = new AbortController();
// Taskana 4682 rework: a codex CHILD boot's private temp dir teardown. Set by
// bootCodexSession when args.child is present; handleShutdown runs it as the
// shutdown-side half (child finalize already ran the other half — both are
// idempotent). Null for owner tabs and every non-codex boot.
let codexChildTempDirCleanup: (() => void) | null = null;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCleanupIntent(raw: string | undefined): WireWorktreeCleanupIntent | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<WireWorktreeCleanupIntent>;
    if (
      typeof value.path === "string" &&
      value.path.length > 0 &&
      (value.mode === "auto" || value.mode === "keep" || value.mode === "remove") &&
      typeof value.ownedByAnyCode === "boolean" &&
      (value.branch === undefined || (typeof value.branch === "string" && value.branch.length > 0))
    ) {
      return value as WireWorktreeCleanupIntent;
    }
  } catch {
    // Fail closed below: a pending continuation with malformed cleanup cannot run.
  }
  throw new Error("Malformed worktree cleanup handoff from desktop main.");
}

function toLifecycleCleanup(intent: WireWorktreeCleanupIntent): WorktreeCleanupIntent {
  if (intent.mode === "auto") {
    if (!intent.ownedByAnyCode) throw new Error("Automatic cleanup cannot target an external worktree.");
    return {
      kind: "remove_clean",
      target: intent.path,
      ownedByAnyCode: true,
      ...(intent.branch !== undefined ? { branch: intent.branch } : {}),
    };
  }
  if (intent.mode === "remove") {
    if (intent.ownedByAnyCode) {
      return {
        kind: "remove_force",
        target: intent.path,
        ownedByAnyCode: true,
        ...(intent.branch !== undefined ? { branch: intent.branch } : {}),
      };
    }
    return { kind: "remove_force", target: intent.path, ownedByAnyCode: false };
  }
  return { kind: "none", reason: `Retained worktree: ${intent.path}` };
}

/** Codex deliberately reads only its own explicit bootstrap inputs, never provider env config. */
function resolveCodexDbPath(env: NodeJS.ProcessEnv): string {
  const configured = env.ANYCODE_DB_PATH?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".anycode", "anycode.sqlite");
}

// ── child-mode wiring shared by all three boots (TASK.102 CUT-S4 §4.1) ──
// Extracted so core/codex/claude each get ONE call-site instead of three
// copies. `boot()`'s core path is byte-equivalent to before this extraction
// (same tapChildPermissions/postMessage bodies, just factored out); codex/
// claude previously had none of this wiring at all (S2 built it core-only).

/**
 * A child-mode broker's `emit`, wrapping the permission-tap
 * (`tapChildPermissions`, session.ts) so an "attention" signal reaches main
 * as `ChildProgress{kind:"attention"}` around every permission ask — the
 * exact body `boot()`'s core path already ran (CUT-S2 §0.8/§2.6.3), now
 * shared by the codex/claude boots too.
 */
function buildChildBrokerEmit(emitFn: (message: HostToUiMessage) => void): (message: HostToUiMessage) => void {
  return tapChildPermissions(emitFn, (waiting) => {
    process.parentPort.postMessage({
      type: CHILD_PROGRESS_TYPE,
      kind: "attention",
      waiting,
    } satisfies ChildProgress);
  });
}

/**
 * The `child:` `ChildSessionOptions` every child-mode `Session` construction
 * needs (CUT-S2 §2.6.3, now shared by all three boots per CUT-S4 §4.1).
 * `flushHistory` is the one engine-specific seam (§4.4): core passes the
 * existing `historySink.flushChecked()`; an engine child passes a fresh
 * universal-snapshot write (see `bootCodexSession`/`bootClaudeSession`
 * below). `onReady`/`onTerminal`/`onProgress` post directly onto this fork's
 * own `process.parentPort` — the child side of the wire — identically for
 * every engine.
 *
 * Taskana 4682 rework: `onTerminalFinalized` (optional, engine boots only)
 * runs AFTER the terminal message has been posted, inside the same try/catch
 * discipline — the child is done, its durable artifacts are flushed, so
 * per-child scratch state (the codex child's private temp dir) may go. Never
 * fatal: an exception is logged, never allowed to disturb the terminal.
 */
function buildChildSessionOptions(
  flushHistory: () => Promise<void>,
  wrapUpRescue?: () => Promise<string>,
  responseModel?: () => string | undefined,
  onTerminalFinalized?: () => void,
): ChildSessionOptions {
  return {
    // TASK.196: present ONLY for core-engine children — codex/claude have no
    // core loop/ModelPort to run the tool-free wrap-up call against, so
    // their empty max_turns terminal falls back to the explicit
    // childTurnLimitNotice in Session.rescueTurnLimitReport.
    ...(wrapUpRescue !== undefined ? { wrapUpRescue } : {}),
    onReady: () => {
      process.parentPort.postMessage({ type: CHILD_READY_TYPE } satisfies ChildReady);
    },
    flushHistory,
    // Core-only seam: reads the child's dedicated model port's provider claim
    // at terminal. Engine boots pass no getter (no core claim exists there).
    ...(responseModel !== undefined ? { responseModel } : {}),
    onTerminal: (report) => {
      process.parentPort.postMessage({
        type: CHILD_TERMINAL_TYPE,
        status: report.status,
        finalText: report.finalText,
        truncated: report.truncated,
        turns: report.turns,
        toolCalls: report.toolCalls,
        durationMs: report.durationMs,
        ...(report.model !== undefined ? { model: report.model } : {}),
        ...(report.responseModel !== undefined ? { responseModel: report.responseModel } : {}),
        ...(report.activitySuppressed !== undefined ? { activitySuppressed: report.activitySuppressed } : {}),
        ...(report.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: report.finalTurnFinishReason } : {}),
        ...(report.declaredDoneAtCeiling === true ? { declaredDoneAtCeiling: true } : {}),
        ...(report.ceiling !== undefined ? { ceiling: report.ceiling } : {}),
        ...(report.errorDescriptor !== undefined ? { errorDescriptor: report.errorDescriptor } : {}),
      } satisfies ChildTerminal);
      // Taskana 4682 rework: the terminal is committed — the child's private
      // scratch may go. Best-effort, logged, never fatal (the message above
      // already left; a cleanup failure must not masquerade as a child
      // failure downstream).
      try {
        onTerminalFinalized?.();
      } catch (cleanupError) {
        console.error(`[host] child terminal cleanup failed: ${describeError(cleanupError)}`);
      }
    },
    onProgress: (report) => {
      process.parentPort.postMessage({
        type: CHILD_PROGRESS_TYPE,
        ...report,
      } satisfies ChildProgress);
    },
  };
}

/**
 * Native Codex branch. Keep this separate from `boot()` so a subscription-only
 * host never constructs the provider/core graph just to reach its session.
 */
async function bootCodexSession(
  bootstrap: EngineBootstrap,
  plugin: EnginePlugin,
  mcpSecrets: McpSecretResolver,
): Promise<void> {
  const binaryPath = process.env[ENV_CODEX_BIN];
  if (binaryPath === undefined || binaryPath.trim() === "") {
    throw new Error("Codex binary is unavailable; configure a validated Codex installation first");
  }
  const args = parseHostArgs(process.argv.slice(2));
  const dbPath = resolveCodexDbPath(process.env);
  persistence = new SqlitePersistenceAdapter(dbPath);
  // TASK.144: the persisted always-allow rules, seeded from the SAME
  // settings.json the core boot reads. A Codex session has no core permission
  // engine (`supportsCorePermissions` is false), so this one instance is both
  // the broker's rule source and Session's append target — see the
  // PermissionRuleMatcher header for why the core boot deliberately keeps its
  // broker rule-free.
  const rules = await seedAlwaysAllowRules(hostSettingsPathOverride());
  // TASK.102 CUT-S4 §4.1: a child-mode boot's broker wraps `emit` with the
  // permission-tap, exactly like the core path already did (§4.1's shared
  // helper) — Codex previously had none of this wiring (S2 built it core-only).
  const broker = new IpcPermissionBroker(
    args.child !== undefined ? buildChildBrokerEmit(emit) : emit,
    undefined, // default ask deadline
    rules,
  );
  // Taskana 4730: ask-zone classifier coverage for the Codex approval bridge.
  // Command kind only (see engine-classifier-boot.ts); the bridges take the
  // DECORATED broker via `options` below, Session keeps the raw one.
  // 4730 xfix D4 honesty note: a model-kind record with a connectionId this
  // session is not running on is exactly the case the CORE boot reports via
  // engine_notice — here it is already OFF for engine sessions (model kind is
  // core-only), so the log line below is the honest "off, and why".
  const engineClassifierBoot: EngineClassifierBoot | undefined = (() => {
    const parsed = parseAskClassifierEnvKind(process.env[ENV_PERMISSION_CLASSIFIER]);
    if (parsed === undefined || parsed.kind !== "command") {
      if (parsed?.kind === "model") {
        console.log("[host] codex session: model-kind classifier is core-only for now; command kind covers engine approvals");
      }
      return undefined;
    }
    console.log(`[host] ${ENV_PERMISSION_CLASSIFIER}: engine approvals classified by ${parsed.boot.classifier.id}`);
    return parsed.boot;
  })();
  const classifierBroker = decorateEngineBroker(broker, engineClassifierBoot, {
    // 4730 xfix D2: an engine CHILD session's every input is model-authored
    // (the parent agent's spawn prompt / send follow-ups), so the
    // classifier's human context is [] for a child — never the parent's
    // turns, never a polluted ring. The origin threading in session.ts keeps
    // the ring clean on its own; this is the belt-and-braces guarantee at
    // the consumer.
    userContext: () => (args.child !== undefined ? [] : classifierSessionRef?.recentHumanUserTurns() ?? []),
    // 4730 xfix D5: the Session binds after this decoration (the bridges
    // capture the broker at construction); until then nothing is consulted.
    isBound: () => classifierSessionRef !== null,
    cwd: workspace,
    emit: (event) => classifierSessionRef?.emitAgentEvent(event),
  });
  const processOwnership = readHostProcessOwnership(
    process.env,
    process.pid,
    (message) => process.parentPort.postMessage(message),
  ) ?? undefined;
  // Shadow command log (cut §2(e), TASK.42): the HOST is the sole writer,
  // from the live `item/*` stream inside CodexEngine — never the renderer.
  const shadowLog = new SqliteCodexShadowLog(persistence);
  // Codex-profiles TASK.50 (cut §2.6): main resolves the picked profile to
  // ready argv; the host re-validates it (fail-closed — malformed profile argv
  // aborts the boot rather than silently running on the ambient account) and
  // derives the CODEX_HOME the child receives. null = the `system`
  // pseudo-profile: no env override, no guard, byte-identical old behaviour.
  // The raw args are kept: `profileId` is persisted into the session row at
  // the create seam below (Q1.3) so a cross-restart resume re-resolves it.
  const codexProfileArgs = parseCodexProfileArgs(process.argv.slice(2));
  // W4-F0b (Fable ruling iter-10): the dev/automation-only profiles-home
  // lever, vetted by main and forwarded into this fork's env (set-or-DELETE
  // scrub in buildHostEnvFor), re-gated here defense-in-depth. Resolved
  // BEFORE the profile so a malformed value refuses the boot without a
  // single mkdir — a silent fallback to the real homedir would be exactly
  // the write the lever exists to prevent. null (production: main deleted
  // the var) keeps the real-homedir default byte-identical to pre-F0b.
  const codexProfilesHomeOverride = resolveCodexProfilesHomeOverride(process.env);
  const codexProfile = resolveCodexProfile(codexProfileArgs, codexProfilesHomeOverride ?? undefined);
  if (codexProfile !== null) {
    // First assert runs eagerly so a broken home fails the boot with its own
    // diagnostic; the SAME closure is then re-run by AppServerClient before
    // every individual spawn (amendment §A1.2 TOCTOU discipline).
    const rejected = assertCodexProfileHome(codexProfile);
    if (rejected !== null) throw new Error(`Codex profile home rejected: ${rejected}`);
  }
  // Taskana 4682 rework: a codex CHILD gets a PRIVATE temp dir,
  // `~/.anycode/tmp/<childSessionId>` (bridgeRowId = --session, the host
  // minted UUID a child boot always carries), created 0700 BEFORE the first
  // spawn so both the app-server spawn env (TMPDIR/TMPPREFIX/TMP/TEMP) and
  // the sandbox writableRoots can point at a dir that provably exists.
  // It replaces the /tmp and $TMPDIR access a54b2f6d excluded — without it
  // every tmp consumer inside the child breaks (zsh heredocs, tsx cache,
  // mktemp, os.tmpdir()). Owner tabs (args.child undefined) get NOTHING here:
  // no private dir, no env override, no writableRoots change. Derived from
  // the same home inputs the profile tree above uses, so one automation
  // lever moves both. An unsafe id segment (separator/traversal) throws —
  // fail-closed, never a silent no-dir boot that would resurrect the broken
  // toolchain state.
  const bridgeRowId = args.sessionId ?? randomUUID();
  const codexChildTempDir = args.child !== undefined ? resolveChildTempDir(bridgeRowId, codexProfilesHomeOverride ?? homedir()) : undefined;
  /** Best-effort, idempotent removal — child finalize AND host shutdown both call it; never fatal. */
  const cleanupCodexChildTempDir = (): void => {
    if (codexChildTempDir !== undefined) removeChildTempDir(codexChildTempDir);
  };
  // Shutdown-side half: handleShutdown runs this regardless of whether the
  // child ever finalized (a killed host never reaches onTerminal).
  if (codexChildTempDir !== undefined) codexChildTempDirCleanup = cleanupCodexChildTempDir;
  // TASK.182 / Taskana 4136: MCP forwarding. After profile resolution: load
  // the specs ONCE (core reader; project → user → .mcp.json winners) and
  // serialize the Codex thread config map. Identical for system, managed and
  // linked profiles and for session children — no profile config.toml writes,
  // no argv overrides, no MCP values in boot logs (names/counts only). The
  // map rides thread/start / thread/resume over the existing JSON-RPC pipe.
  const codexMcpForward = await prepareEngineMcpForward({
    fs: new NodeFileSystemAdapter(),
    workspace,
    home: homedir(),
    tmpDir: tmpdir(),
    pid: process.pid,
    engines: ["codex"],
    projectTrusted: hostWorkspaceTrust.projectTrusted,
    secrets: mcpSecrets,
  });
  if (codexMcpForward.codexNames.length > 0) {
    console.log(`[host] codex mcp forward: ${codexMcpForward.codexNames.length} server(s): ${codexMcpForward.codexNames.join(", ")}`);
  }
  for (const notice of codexMcpForward.notices) {
    console.warn(`[host] codex mcp forward: ${notice.type === "engine_notice" ? notice.message : ""}`);
  }
  const codexForwardOptions = {
    ...((codexMcpForward.codexServers !== null || codexMcpForward.notices.length > 0)
      ? {
          mcpForward: {
            ...(codexMcpForward.codexServers !== null ? { servers: codexMcpForward.codexServers } : {}),
            ...(codexMcpForward.notices.length > 0 ? { notices: codexMcpForward.notices } : {}),
          },
        }
      : {}),
  };
  const agentCardLog = new SqliteCodexAgentCardLog(persistence, bridgeRowId);
  let codexAgentBridge: CodexDynamicToolBridge | undefined;
  // The bridge's child port, kept so the Session below can surface its
  // detached-children registry (background_children) — without it a Codex
  // supervisor's background agents never reached the renderer at all.
  let codexChildPort: ChildSessionPort | undefined;
  let codexParentEngine: import("./engines/codex/codex-engine.js").CodexEngine | undefined;
  if (args.child === undefined) {
    const profileRoots = buildAgentProfileRoots(workspace, homedir(), []);
    const resolveCatalog = async () => catalogFromProfiles(
      (await discoverAgentProfiles(new NodeFileSystemAdapter(), profileRoots)).profiles,
    );
    const catalog = await resolveCatalog();
    if (catalog.length) {
      const port = createChildSessionPort({
        parentSessionId: bridgeRowId,
        getPermissionMode: () => codexAgentPermissionMode(codexParentEngine?.snapshot().activePresetId ?? "read-only"),
        send: sendChildSessionMessage, subscribe: subscribeChildRunEvents,
        onDetachedTerminal: deliverDetachedChildReport, onDetachedStall: deliverDetachedChildStall,
      });
      codexChildPort = port;
      codexAgentBridge = new CodexDynamicToolBridge(catalog, port, agentCardLog, resolveCatalog);
    }
  }
  // taskana 4181: the supervisor idle watchdog for this (non-child) codex
  // boot — one instance, constructed once, mirroring the stall clock's
  // report-only posture. It watches for the supervisor's turn having ENDED
  // with no live detached children and no terminal marker in its final
  // assistant text, and fires a system reminder through the SAME child_report
  // queue the detach loop already uses. Thresholds resolve from env exactly
  // like the stall clock's (ANYCODE_SUPERVISOR_IDLE_MS overrides the first
  // reminder's delay). Only exists for a root boot: a codex child never
  // supervises anything.
  let codexSupervisorIdleWatchdog: SupervisorIdleWatchdog | undefined;
  if (args.child === undefined) {
    codexSupervisorIdleWatchdog = new SupervisorIdleWatchdog(
      {
        terminalMarkers: SUPERVISOR_IDLE_TERMINAL_MARKERS,
        firstAfterMs: resolveSupervisorIdleFirstMs(process.env, SUPERVISOR_IDLE_FIRST_MS),
        repeatEveryMs: SUPERVISOR_IDLE_REPEAT_MS,
        escalateAfter: SUPERVISOR_IDLE_ESCALATE_AFTER,
      },
      deliverSupervisorIdleReminder,
    );
    // The background-children feed is what makes the watchdog's supervising
    // state reachable at all: it exists ONLY when the child port does (the
    // `if (catalog.length)` gate above — an empty profile catalog means no
    // port, no detachable children, and an inert, correctly-silent
    // watchdog). Any future change that arms supervision without the port
    // must first give this feed another source, or settle-time state
    // (liveChildren) goes stale.
    if (codexChildPort !== undefined) {
      codexChildPort.onBackgroundChildrenChanged(() => {
        codexSupervisorIdleWatchdog?.noteBackgroundChildrenChanged(codexChildPort!.listBackgroundChildren().length);
      });
    }
  }

  const options = {
    bootstrap,
    // Taskana 4730: the bridges get the classifying decorator when a
    // classifier is configured; Session keeps the raw broker.
    broker: classifierBroker,
    // Taskana 4265: the codex approval bridge auto-accepts a file change only
    // when every change is an add/update, every target is realpath-provably
    // inside the workspace, AND the session's policy already allows workspace
    // writes — for a child, the inherited core mode (edit/auto/yolo,
    // `codexChildAutoAcceptsWorkspacePatches`); a root session keeps `false`,
    // so for it only a seeded Edit/Write always-allow rule can ever vouch for
    // a patch. Delete-kind changes still ask (cross-review M1: edit-parity
    // only — neither core's Write/Edit containment nor Claude's acceptEdits
    // silently deletes).
    patchAutoApproval: {
      fs: new NodeFileSystemAdapter(),
      workspaceWritesAllowed: args.child !== undefined && codexChildAutoAcceptsWorkspacePatches(args.child.initialMode),
      rules,
    },
    binaryPath,
    cwd: workspace,
    workspace,
    // TASK.180: a codex child has no native turn cap — the profile budget is
    // surfaced once as a visible engine_notice warning on the first turn,
    // never enforced and never sent as a protocol field.
    ...(args.child?.maxTurns !== undefined
      ? {
          bootNotices: [
            {
              type: "engine_notice" as const,
              level: "warning" as const,
              message: `Profile maxTurns (${args.child.maxTurns}) is not enforced for the codex engine; the child is bounded only by its time/stall limits.`,
            },
          ],
        }
      : {}),
    ...(codexAgentBridge ? { agentBridge: codexAgentBridge } : {}),
    agentCardLog,
    sourceEnv: process.env,
    shadowLog,
    // TASK.103: per-call re-read so a consent granted or revoked mid-session
    // is honored by the very next spawn gate (D-S4-4) — main is the sole
    // writer, this closure just re-reads before each of assertTrusted's
    // per-spawn calls.
    binaryTrust: (path: string) => checkCodexBinaryTrustOnDisk(path, process.platform, readTrustedBinaryConsentsSync(hostSettingsPathOverride())),
    ...(processOwnership !== undefined ? { processOwnership } : {}),
    // Taskana 4682 rework: the private temp dir rides the SAME env builder
    // the profile home does — assigned after the allowlist, so the ambient
    // TMPDIR can never win. Absent for owner tabs (byte-identical env).
    ...(codexChildTempDir !== undefined ? { tempDir: codexChildTempDir } : {}),
    ...(codexProfile !== null
      ? {
          codexHome: codexProfile.home,
          homeTrust: () => {
            try {
              return assertCodexProfileHome(codexProfile);
            } catch (error) {
              return describeError(error);
            }
          },
        }
      : {}),
    ...codexForwardOptions,
  };

  // TASK.39: the draft (pre-session) model/preset choice arrives as argv from
  // main. It is untrusted renderer input and is validated inside the engine —
  // against the LIVE model/list catalog and the frozen preset table — before any
  // id reaches the wire; nothing here interprets it.
  const draft = parseCodexEngineArgs(process.argv.slice(2));

  // Cross-review F2 (Taskana 4682): the dir is ENSURED only here, immediately
  // before the connect phase — the single most likely failure site of the boot
  // (app-server spawn, trust preflights, --version round-trip) and every await
  // above. Creating it at the top of the function left a window where a connect
  // throw propagated to boot()'s catch with the boot-side finally (which
  // removes the dir while `session === null`) never entered — a force-killed
  // host then leaked the 0700 scratch dir forever. The dir only needs to exist
  // before the first spawn env is USED (buildCodexChildEnv runs inside
  // startCodexEngine, below), so this is the last safe spot; the connect
  // expression's .catch and the try below cover every await from here on.
  if (codexChildTempDir !== undefined) ensureChildTempDir(codexChildTempDir);

  const connected = await (args.resume
    ? (async () => {
        if (args.sessionId === undefined || args.sessionId.length === 0) {
          throw new Error("Codex resume requires a session id");
        }
        // TASK.102 CUT-S4 §4.3: as of S4 an engine session is NOT always root
        // (a child boots on this same branch's `else` below) — but a RESUME
        // still can never legitimately target a child's id: children never
        // respawn (cut §0.6), so `--resume` only ever names a root session,
        // and `getRootSession` staying the lookup here is correct unchanged.
        const existing = await persistence!.getRootSession(args.sessionId);
        if (existing === null) throw new Error(`Codex session ${args.sessionId} was not found`);
        if (existing.engineId !== "codex" || typeof existing.externalSessionRef !== "string" || existing.externalSessionRef.length === 0) {
          throw new Error(`Codex session ${args.sessionId} has no resumable native thread`);
        }
        // Taskana 4682 rework: no tmp posture on this branch. getRootSession
        // filters `parent_session_id IS NULL` and codex children never resume
        // (main reaps them on terminal; follow-ups are core-only), so a resume
        // is always an owner tab: no private temp dir, no exclusion.
        const resumed = await resumeCodexEngine({
          ...options,
          externalSessionRef: existing.externalSessionRef,
          // Posture survives the relaunch through the PERSISTED row, never
          // through the server echo (L8 makes the echo un-mappable): the `mode`
          // column carries the preset id verbatim (cut §2(k).4). A pre-TASK.39
          // row holds a core mode there ("build") — the engine treats an
          // unrecognized id as the default preset, silently.
          selection: {
            model: existing.model,
            presetId: existing.mode,
            origin: "persisted",
          },
        });
        // Persist whatever the resume actually settled on (the stored model may
        // have been removed from the catalog and fallen back) — only after the
        // native resume and read have both succeeded.
        const patch = {
          ...(existing.model !== resumed.model ? { model: resumed.model } : {}),
          ...(existing.mode !== resumed.presetId ? { mode: resumed.presetId as PermissionMode } : {}),
        };
        if (Object.keys(patch).length > 0) await persistence!.touchSession(existing.id, patch);
        return { ...resumed, sessionMeta: existing };
      })()
    : (async () => {
        // TASK.102 CUT-S4 §4.2: a child boots on the posture the child-
        // permission-map derives from its inherited mode — NEVER the (always
        // absent, §3.2 п.4's `enginePreset: null`) draft preset argv. A
        // non-child boot keeps the byte-identical prior draft.preset path.
        // (Taskana 4078 finding 5: the ternary lives in boot.ts's
        // `resolveEngineDraftPresetId` so the argv→preset seam is tested.)
        const childPresetId = resolveEngineDraftPresetId(args.child, draft.preset, codexChildPosture);
        const created = await startCodexEngine({
          ...options,
          selection: {
            ...(draft.model !== undefined ? { model: draft.model } : {}),
            ...(childPresetId !== undefined ? { presetId: childPresetId } : {}),
            // Taskana 4682: engine children get /tmp and $TMPDIR excluded from the
            // codex workspaceWrite sandbox; owner tabs keep the frozen defaults.
            // The 4682 rework pairs the exclusion with the PRIVATE temp dir
            // (writableRoots + TMPDIR/TMPPREFIX env) so excluding the shared
            // tmp never breaks the child's toolchains.
            ...(args.child !== undefined ? { excludeTmpRoots: true } : {}),
            ...(codexChildTempDir !== undefined ? { childTempDir: codexChildTempDir } : {}),
            ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
            origin: "draft",
          },
        });
        const id = bridgeRowId;
        // Product-level transaction ordering: the native thread exists first;
        // no row is written if the app-server bootstrap failed.
        const sessionMeta = await persistence!.createSession({
          id,
          workspace,
          // Both values are the SERVER-CONFIRMED ones from the thread/start
          // response / the validated preset — never the raw draft input.
          model: created.model,
          // The `mode` TEXT column stores the Codex preset id verbatim (cut
          // §2(k).4 — no schema migration). The cast is the one place the two
          // vocabularies meet; nothing reads this column back as a core
          // PermissionMode for a Codex session (Session's mode() is engine-owned).
          mode: created.presetId as PermissionMode,
          engineId: "codex",
          externalSessionRef: created.threadId,
          // TASK.102 CUT-S4 §4.3: the engine-boot's own row-creation point
          // stamps the same parentSessionId/spawnToolCallId columns the core
          // path's `resolveBootSession`/`childCreateFields` (boot.ts) stamps
          // — without this a codex child is INDISTINGUISHABLE from a root
          // session (owner invariant #1: a child must never appear in
          // `listRootSessions`).
          ...(args.child !== undefined
            ? { parentSessionId: args.child.parentSessionId, spawnToolCallId: args.child.spawnToolCallId }
            : {}),
          // Codex-profiles Q1.3 (cut §3.3, completes W3-F): pin the profile id
          // this session was created under, so a cross-restart resume
          // re-resolves THIS profile's CODEX_HOME (main/index.ts's fail-closed
          // re-resolve reads it back). Absent for the `system` pseudo-profile
          // and bare --codex-home spawns — the row stays byte-identical to a
          // pre-profiles build there.
          ...(codexProfileArgs.profileId !== undefined ? { codexProfileId: codexProfileArgs.profileId } : {}),
        });
        return { ...created, sessionMeta };
      })()).catch((error: unknown) => {
    // Cross-review F2 (Taskana 4682, review fix): the connect phase runs
    // BEFORE the `try` below opens, so its own failure (spawn, trust
    // preflight, --version, row persistence) must remove the private temp
    // dir here — the finally below never sees it.
    cleanupCodexChildTempDir();
    throw error;
  });
  // The engine objects exist now: from here on a boot failure (below) must
  // clean the private temp dir up — the finally in boot() cannot, it lives in
  // another function scope. Every later await in this function body runs
  // under this guard; the connect phase above is covered by its own .catch.
  try {
  codexParentEngine = connected.engine;
  const booted = await plugin.boot({ codexEngine: connected.engine });
  const fs = new NodeFileSystemAdapter();

  // Shell wiring (design TASK.40 §2(f)): AnyCode's own repo context (Git
  // bridge -> branch/status/changes, the read-only Review diff, the
  // Environment chip) is a property of the WORKSPACE, not the agent
  // runtime -- wired identically to the core boot path in boot() below
  // (same gitEnabled gate: is-git-repo AND the exec adapter can spawn a
  // binary), so a Codex session sees exactly the same repo context a core
  // session does. This is deliberately NOT surfaced as a Codex tool
  // capability: `engine.capabilities.supportsGitMutations` stays `false`
  // (Codex's own tools, not AnyCode's shell, mutate git when Codex itself
  // runs a git command) -- `shell.gitUserMutations` below is the separate,
  // shell-owned gate for the Review panel's user-initiated mutations
  // (design §2(f), Session's `git_command` routing).
  const codexExecAdapter = new NodeExecutionAdapter();
  const codexIsGitRepo = await fs.exists(`${workspace}/.git`);
  const codexGitEnabled = codexIsGitRepo && typeof codexExecAdapter.runBinary === "function";
  const codexGitService = new NodeGitAdapter({ exec: codexExecAdapter, cwd: workspace, signal: gitAbort.signal });
  gitBridge = new GitBridge({ git: codexGitEnabled ? codexGitService : null, outbound });
  // The AnyCode terminal (PTY shell) is wired unconditionally at module
  // scope (`terminals`, top of this file) regardless of engine -- always
  // available for a Codex session too.
  const shell: ShellCapabilitiesProjection = {
    gitReadOnly: codexGitEnabled,
    gitUserMutations: codexGitEnabled,
    terminal: true,
  };

  /**
   * TASK.102 CUT-S4 §4.4 / TASK.143: the universal-snapshot write an engine
   * child's `flushHistory` performs — a write of the FULL current transcript
   * into the SAME universal `history_items` table a core child's history
   * lives in, through the existing
   * `WriteBehindHistorySink(persistence, childSessionId)` port (no new
   * persistence method). This is what lets a completed child's "Open" read a
   * non-empty transcript (Sol §3's diagnosis) instead of the native-only
   * shadow tables core's universal Open path never reads.
   *
   * UNLIKE `connected.engine.historyItems()` (frozen at boot), this calls
   * `readTranscript()` — a fresh `thread/read` re-run through the same
   * resume projection, on demand (TASK.143) — so a completed child's
   * snapshot is the FULL transcript including every turn this launch ran,
   * not the empty/stale pre-turn one. `replaceAll` (not `append`, mirroring
   * `claudeFlushHistory` below): `readTranscript()` always returns the WHOLE
   * transcript from turn 0, so a second flush (e.g. a steer turn landing
   * between two finalize attempts) must overwrite, not concatenate onto, the
   * first flush's rows. A `readTranscript()` rejection (disposed engine,
   * failed RPC) is left to propagate — `finalizeChildTerminal` (session.ts)
   * turns an unresolved `flushHistory()` into an honest error terminal; this
   * function must never catch it into a silent "flushed nothing", which is
   * exactly the failure mode that made codex engine children unsupported
   * before `readTranscript()` existed.
   */
  const codexFlushHistory = async (): Promise<void> => {
    const items = await connected.engine.readTranscript();
    const sink = new WriteBehindHistorySink(persistence!, connected.sessionMeta.id);
    sink.replaceAll(items);
    await sink.flushChecked();
  };

  // TASK.159: telemetry sink for a codex boot (mirror of the core path's own
  // block, host boot() ~:2022-2029 — same fail-soft config load, same
  // module-level `telemetry` assignment so the existing shutdown block
  // (~:2606-2609) writes session_end + dispose for this session too, for
  // free). `provider` is the engine id (a codex/claude session has no
  // catalog connect name); `enginePreset` (S9: own field, not `mode` — a
  // codex/claude session has no core PermissionMode) reuses `connected.presetId`,
  // which is correct on BOTH branches (fresh: identical to `created.presetId`;
  // resume: the settled `resumed.presetId`, never the possibly-stale
  // `existing.mode` a drifted resume left behind — see the resume branch's
  // own `patch` above, which is the DB-row `mode` COLUMN, an unrelated seam).
  let codexTelemetryConfig: ResolvedTelemetryConfig | null = null;
  try {
    const loadedTelemetry = await loadTelemetryConfig(fs, workspace, homedir(), process.env, {
      // Taskana 4736 xfix D2: the project telemetry section is trust-gated on
      // the same `hostWorkspaceTrust` as mcp/hooks/lsp (established earlier in
      // boot()); one warning line, user-level values still load.
      projectTrusted: hostWorkspaceTrust.projectTrusted,
    });
    codexTelemetryConfig = loadedTelemetry.telemetry;
    for (const issue of loadedTelemetry.issues) console.warn(`[host] telemetry config: ${issue}`);
  } catch (error) {
    console.error(`[host] failed to load telemetry config; continuing without telemetry: ${describeError(error)}`);
  }
  if (codexTelemetryConfig !== null) {
    const port = new JsonlTelemetrySink({ dir: codexTelemetryConfig.dir, fileName: `${connected.sessionMeta.id}.jsonl` });
    port.record({
      v: 1, ts: Date.now(), session: connected.sessionMeta.id, t: "session_start",
      model: connected.model, provider: "codex", enginePreset: connected.presetId, engine: "codex",
      ...(args.child !== undefined ? { parentSession: args.child.parentSessionId } : {}),
    });
    telemetry = { port, session: connected.sessionMeta.id };
  }

  const codexHistoryMaxItems = resolveSessionHistoryMaxItems(process.env);
  // Taskana 4123 follow-up: restore the persisted detached-child report queue
  // BEFORE this Session's first ui_ready can resendAll() it — the same
  // restore-before-first-ui_ready ordering the core tail holds. Codex's row
  // always exists by now (the create seam above ran strictly before Session),
  // so the adapter's own column read/write is the whole seam. A child-mode
  // boot never spawns detached children of its own, so it keeps the in-memory
  // posture and its column stays null.
  const codexPendingChildReports = args.child === undefined
    ? await attachEngineChildReportDurability({
        queue: childReportQueue,
        loadJson: () => persistence!.loadPendingChildReports(connected.sessionMeta.id),
        saveJson: (json) => persistence!.savePendingChildReports(connected.sessionMeta.id, json),
      })
    : undefined;
  session = new Session({
    workspaceTrustRequired: workspaceTrustRequiredMessage,
    outbound,
    engine: booted.engine,
    // TASK.39: the SAME CodexEngine instance, handed to Session as its narrow
    // model/preset seam. `booted.engine` above is the identical object behind the
    // neutral SessionEngine interface; this reference is the only place the host
    // admits it also speaks the engine-settings contract.
    engineSettings: connected.engine,
    broker,
    fs,
    workspace,
    model: connected.model,
    sessionId: connected.sessionMeta.id,
    // Codex owns native thread history; never an AgentLoop history — this is
    // the resume projection built ONCE at boot (TASK.42, cut §2(e)):
    // native `thread/read` merged with the command shadow log, `[]` for a
    // fresh session. `booted.engine` is the SAME CodexEngine instance
    // `connected.engine` already is (registry.ts's codex plugin is a
    // pass-through), so this is exactly what `historyItems()` returns.
    bootHistory: booted.engine.historyItems(),
    ...(codexChildPort !== undefined
      ? {
          backgroundChildren: {
            list: () => codexChildPort!.listBackgroundChildren(),
            cancel: (childSessionId: string) => codexChildPort!.cancelBackgroundChild(childSessionId),
            cancelAll: () => codexChildPort!.cancelAllBackgroundChildren(),
            onChange: (listener: () => void) => codexChildPort!.onBackgroundChildrenChanged(listener),
          },
        }
      : {}),
    // taskana 4181: the supervisor idle-watchdog seam — constructed once
    // above (root boots only), fed turn-start/settle signals by Session.
    ...(codexSupervisorIdleWatchdog !== undefined
      ? {
          supervisorIdle: {
            noteTurnSettled: (lastPublicText: string) => codexSupervisorIdleWatchdog!.noteTurnSettled(lastPublicText),
            noteTurnStarted: () => codexSupervisorIdleWatchdog!.noteTurnStarted(),
          },
        }
      : {}),
    // TASK.188 S4: dev/automation-ONLY replay-recording override, resolved
    // here (the composition root) and never inside Session itself.
    ...(codexHistoryMaxItems !== null ? { historyMaxItems: codexHistoryMaxItems } : {}),
    // Taskana 4123 follow-up: the restored queue's delivery path — resendAll
    // on every ui_ready, ack on child_report_ack. Present only for a root
    // boot (a child-mode codex session has no detached children of its own).
    ...(codexPendingChildReports !== undefined ? { pendingChildReports: codexPendingChildReports } : {}),
    hasTitle: connected.sessionMeta.title !== undefined && connected.sessionMeta.title.length > 0,
    // TASK.144: the SAME store the broker above matches against, so an
    // in-session "Always allow" starts working from the very next ask instead
    // of only after a restart re-seeds it from settings.json.
    rules,
    // `model/list` is the native Codex capability authority. The closure reads
    // the engine's chosen model live, so switching to a text-only model closes
    // the Composer gate before a turn can be sent.
    imageInputEnabled: () => connected.engine.imageInputEnabled(),
    git: gitBridge,
    shell,
    persistence: {
      touch(patch) {
        // The persistence boundary is where a Codex preset id becomes the `mode`
        // TEXT column (cut §2(k).4). Session keeps the two vocabularies apart in
        // its own types; the column is shared, and the cast lives here, once.
        const { enginePreset, ...rest } = patch;
        const row = { ...rest, ...(enginePreset !== undefined ? { mode: enginePreset as PermissionMode } : {}) };
        void persistence?.touchSession(connected.sessionMeta.id, row).catch((error) => {
          console.error(`[host] touchSession failed: ${describeError(error)}`);
        });
      },
    },
    postPreviewArtifacts: sendPreviewArtifacts,
    // TASK.159 INVARIANT: this is a foreign-engine boot — CodexEngine never
    // instantiates AgentLoop, so there is no AgentLoopConfig.eventTap anywhere
    // in this branch to double up against (see SessionOptions.eventTap's own
    // doc). `baselineFromFirstEvent: args.resume` — see records.ts §2.3: a
    // resumed codex thread's first `engine_session_tokens` snapshot already
    // includes pre-restart history recorded earlier in this SAME file; without
    // this the resume would double-count that history's tokens.
    ...(telemetry !== null
      ? { eventTap: buildEngineTelemetryTap(telemetry.port, telemetry.session, { baselineFromFirstEvent: args.resume }) }
      : {}),
    ...(args.child !== undefined ? { child: buildChildSessionOptions(codexFlushHistory, undefined, undefined, () => {
      // Taskana 4682 rework: finalize-time removal of the private temp dir
      // (idempotent; host shutdown repeats it harmlessly).
      if (args.child !== undefined) cleanupCodexChildTempDir();
    }) } : {}),
  });
  // Taskana 4730: bind the late-bound Session ref the classifying broker
  // decorator reads (userContext ring + agent_event emit).
  classifierSessionRef = session;
  console.log(`[host] initialized Codex native thread ${connected.threadId} session=${connected.sessionMeta.id} db=${dbPath}`);
  } finally {
    // Taskana 4682 rework: a boot that never reached Session (spawn failure,
    // plugin.boot throw, a Session-constructor rejection) must not leak the
    // private temp dir — the child never finalized, shutdown may never come.
    // Best-effort and idempotent: a boot that SUCCEEDED later re-derives and
    // re-creates the same path on resume, and the live dir is cleaned by
    // child finalize / host shutdown instead.
    if (session === null) cleanupCodexChildTempDir();
  }
}

/**
 * Native Claude branch (SLICE-CC C4 + D-min, cut §1.4/§1.5). Structurally the
 * codex branch above:
 *
 *  - `engineSettings` seam: Claude's OWN immediate-apply semantics
 *    (`ClaudeSettingsSeam`, settings-seam.ts) — deliberately NOT codex's
 *    choose-now/apply-at-next-turn seam. Every Claude control (`set_model`,
 *    `set_permission_mode`, `apply_flag_settings`) applies IMMEDIATELY over an
 *    async control request (`w0-16-setmodel.jsonl`), so `onSettingsApplied`
 *    fires on the control-ack, not on a `turn/start`.
 *  - Resume branch (mirrors codex ~500-529): `getRootSession` -> `engineId ===
 *    "claude"` + `externalSessionRef` -> `--resume`. `--resume` never
 *    re-emits history on the wire (probe #4), so the shadow transcript mirror
 *    (below) is the ONLY source `historyItems()` reads from on resume.
 *  - Shadow transcript: `ClaudeShadowTranscriptEngine` wraps the connected
 *    engine so every turn's translated stream is projected + recorded
 *    fire-and-forget (never the renderer, never a parse of Claude Code's own
 *    on-disk `.jsonl` — invariant §0.2-4).
 */
async function bootClaudeSession(
  bootstrap: EngineBootstrap,
  plugin: EnginePlugin,
  mcpSecrets: McpSecretResolver,
): Promise<void> {
  const binaryPath = process.env[ENV_CLAUDE_BIN];
  if (binaryPath === undefined || binaryPath.trim() === "") {
    throw new Error("Claude binary is unavailable; configure a validated Claude Code installation first");
  }
  const args = parseHostArgs(process.argv.slice(2));
  // Deliberately the SAME resolver the codex branch uses rather than a
  // duplicate: both native engines must open the one ANYCODE_DB_PATH database,
  // and two copies of this two-line rule could drift into two databases.
  const dbPath = resolveCodexDbPath(process.env);
  persistence = new SqlitePersistenceAdapter(dbPath);
  // TASK.144: same seed the codex boot above performs, for the same reason —
  // a Claude session's approvals never pass through core's permission engine,
  // so the broker is the only place a persisted rule can be honoured.
  const rules = await seedAlwaysAllowRules(hostSettingsPathOverride());
  // TASK.102 CUT-S4 §4.1: same shared wrapping the codex boot above now gets —
  // Claude previously had none of this wiring at all (S2 built it core-only).
  const broker = new IpcPermissionBroker(
    args.child !== undefined ? buildChildBrokerEmit(emit) : emit,
    undefined, // default ask deadline
    rules,
  );
  // Taskana 4730: ask-zone classifier coverage for the Claude approval bridge
  // (same shape as the codex boot above).
  const claudeClassifierBoot: EngineClassifierBoot | undefined = (() => {
    const parsed = parseAskClassifierEnvKind(process.env[ENV_PERMISSION_CLASSIFIER]);
    if (parsed === undefined || parsed.kind !== "command") {
      if (parsed?.kind === "model") {
        console.log("[host] claude session: model-kind classifier is core-only for now; command kind covers engine approvals");
      }
      return undefined;
    }
    console.log(`[host] ${ENV_PERMISSION_CLASSIFIER}: engine approvals classified by ${parsed.boot.classifier.id}`);
    return parsed.boot;
  })();
  const claudeClassifierBroker = decorateEngineBroker(broker, claudeClassifierBoot, {
    // 4730 xfix D2: same child rule as the codex boot above — a child's
    // human context is [] (model-authored inputs only), never a ring read.
    userContext: () => (args.child !== undefined ? [] : classifierSessionRef?.recentHumanUserTurns() ?? []),
    // 4730 xfix D5: same fail-closed unbound gate as the codex boot above.
    isBound: () => classifierSessionRef !== null,
    cwd: workspace,
    emit: (event) => classifierSessionRef?.emitAgentEvent(event),
  });
  const processOwnership = readClaudeHostProcessOwnership(
    process.env,
    process.pid,
    (message) => process.parentPort.postMessage(message),
  ) ?? undefined;
  // Shadow transcript mirror (CC-D-min, cut §1.5): the HOST is the sole writer
  // (ClaudeShadowTranscriptEngine below), from the live translated stream —
  // never the renderer, never a parse of Claude Code's own `.jsonl`.
  const shadowTranscript = new SqliteClaudeShadowTranscript(persistence);

  // The draft (pre-session) model/preset choice arrives as argv from main. It is
  // untrusted renderer input: nothing here interprets it — the engine validates
  // the model against the LIVE `initialize` catalog and the preset against the
  // frozen table, and an unusable value degrades to the default with a warning
  // notice rather than reaching the wire.
  const draft = parseClaudeEngineArgs(process.argv.slice(2));

  // TASK.226 срез S4: the MCP agent-bridge door for this tab. Built and
  // wired into `options` BEFORE `startClaudeEngine`/`resumeClaudeEngine`
  // ever call `client.initialize()` — probes.md P0's load-bearing finding is
  // that the CLI drives its OWN mcp handshake (`initialize` ->
  // `notifications/initialized` -> `tools/list`, each wrapped as a
  // `mcp_message` control_request) INSIDE our outbound `initialize` call,
  // before it even answers ours; a bridge wired any later would silently
  // miss that handshake (claude-engine.ts's own `connectClaudeEngine` doc
  // has the full mechanics, and claude-engine.connect.test.ts's "wired
  // BEFORE initialize" suite pins the order against a scripted fake CLI).
  //
  // Non-recursion lock, this door's own equivalent of F12's registry/config
  // pair: a claude CHILD (`args.child !== undefined`) never even scans the
  // catalog, let alone gets a bridge — core's OWN two locks (spawn-tools.ts's
  // SPAWN_TOOLS set dropped from a child's tool registry; runner.ts's child
  // config carrying no `subagents`/`workflows` port) apply to core's OWN
  // AgentLoop, which a claude session never has, so withholding the door
  // itself is the equivalent lock for this engine. `args.child !== undefined`
  // alone is the right (and only) discriminator here, unlike the core tail's
  // `isChildSessionBoot(args, sessionMeta)`: a claude `--resume` can only
  // ever target a ROOT row (`persistence!.getRootSession` above returns null
  // for anything else; children never respawn — cut §0.6, echoed a few lines
  // up at TASK.102 CUT-S4 §4.3's own comment), so `sessionMeta.parentSessionId`
  // never carries information independent of `args.child` for this engine
  // the way it does for the core tail's respawnable rows.
  const fs = new NodeFileSystemAdapter();
  // Preallocated so the port below can stamp `parentSessionId` before the
  // engine connects — for a fresh boot this IS the value the later
  // `rowWriter`/`sessionRow` block reuses verbatim; for a resume it equals
  // `existing.id` (`getRootSession` looks up `WHERE id = ?`), so hoisting
  // this above the connect call changes no persisted value, only its timing.
  const rowId = args.sessionId ?? randomUUID();
  let mcpBridge: ClaudeMcpBridge | undefined;
  // Taskana 4056: hoisted out of the bridge block — the Session construction
  // below wires this port's background-children seam into the
  // background-agents strip (same TASK.145 shape the codex door uses at its
  // own Session construction).
  let claudeChildPort: ChildSessionPort | undefined;
  // Taskana 4056 cross-review M1: late-bound parent engine for the child
  // permission-mode seam — the port is constructed BEFORE connect (the bridge
  // must exist before the CLI's own MCP handshake), but the engine exists
  // only after, so `getPermissionMode` below closes over this cell exactly
  // the way the codex door's `codexParentEngine` does; until the engine
  // binds, a claude parent defaults to its own default-equivalent posture
  // (`ask` preset → `build`), never wider.
  let claudeParentEngine: import("./engines/claude/claude-engine.js").ClaudeEngine | undefined;
  // Taskana 4056: late-bound live bridge-event tap. The bridge is built here,
  // but the engine exists only after connect below — `onEvent` closes over
  // this cell, and the `claudeEngine` assignment point binds it. Until then
  // (and for detached children's post-turn progress, by design) pushes are
  // no-ops.
  let pushBridgeEvent: ((event: AgentEvent) => void) | undefined;
  // Taskana 4056 review N2: the door's tools/call handler + presentation map
  // (bridge-presentation-stamp.ts), built inside the catalog block below and
  // read by the `options` wiring further down — same late-bound-cell shape as
  // `pushBridgeEvent` directly above.
  let stamp: ReturnType<typeof createBridgePresentationStamp> | undefined;
  if (args.child === undefined) {
    const discovered = await discoverAgentProfiles(fs, buildAgentProfileRoots(workspace, homedir(), []));
    for (const problem of discovered.problems) {
      console.warn(`[host] claude mcp bridge: agent profile: ${problem}`);
    }
    const catalog: AgentBridgeCatalogEntry[] = catalogFromProfiles(discovered.profiles);
    // Taskana 4101: per-call re-read, codex-door parity (index.ts resolveCatalog
    // above): edited body/model live from the next spawn; names stay fixed to
    // the boot snapshot the CLI's tools/list handshake already cached.
    const resolveClaudeCatalog = async (): Promise<readonly AgentBridgeCatalogEntry[]> =>
      bridgeCallableCatalog(catalog, catalogFromProfiles(
        (await discoverAgentProfiles(fs, buildAgentProfileRoots(workspace, homedir(), []))).profiles,
      ));
    // The switch (plan §5 S4 p.7): an empty `tools/list` is never worth
    // announcing — the door itself is the extra attack/complexity surface,
    // not just the tool inside it — so NOTHING below this `if` runs at all,
    // and `mcpBridge` stays `undefined` all the way to `options`.
    if (catalog.length > 0) {
      const childPort = createChildSessionPort({
        parentSessionId: rowId,
        // Taskana 4056 cross-review M1: this seam feeds
        // `ChildSpawnRequest.permissionMode` — the value that gates the
        // spawned CORE child's permission engine — so it must be an honest
        // function of the parent's LIVE preset, never a constant `"build"`.
        // `ClaudeEngine.mode()` is display-only (a fixed "build" display
        // value; claude-engine.ts's own doc), but this seam is not display:
        // the codex door maps its live preset here the same way
        // (`codexAgentPermissionMode`, host/index.ts's own codex tail).
        // `claudeAgentPermissionMode` is the exact analogue: `read-only`
        // parent → `plan` (the child's Write/Edit/Bash are DENIED, matching
        // the preset's own "cannot execute the plan" contract), the
        // known-wider presets `ask`/`workspace` → `build` (ask-first), and
        // anything unrecognized fails NARROW to `plan` (the codex door's own
        // allowlist shape). Late-bound through `claudeParentEngine` (bound at
        // the `claudeEngine` assignment below) because the port exists
        // before connect; pre-bind calls read the fail-narrow default
        // (`ask` preset → `build`), never wider.
        getPermissionMode: () =>
          claudeAgentPermissionMode(claudeParentEngine?.snapshot().activePresetId ?? "ask"),
        send: sendChildSessionMessage,
        subscribe: subscribeChildRunEvents,
        onDetachedTerminal: deliverDetachedChildReport,
        onDetachedStall: deliverDetachedChildStall,
      });
      claudeChildPort = childPort;
      // Taskana 4056 review N2: the door's tools/call handler (and the
      // presentation map it stamps into) lives in bridge-presentation-stamp.ts
      // now — lifted so its after-abort discipline (an aborted call's LATE
      // resolve must not stamp past the turn-end sweep) is pinned by a unit
      // test; index.ts itself is not importable in a test (process.parentPort
      // at module scope).
      const door = createBridgePresentationStamp({
        catalog,
        resolveCallCatalog: resolveClaudeCatalog,
        port: childPort,
        onEvent: (event) => pushBridgeEvent?.(event),
      });
      stamp = door;
      mcpBridge = new ClaudeMcpBridge({
        serverName: "anycode",
        // Decorative only (R4 precedent, `appVersion` doc a few hundred
        // lines below): the desktop app version lives in `main`, not
        // reachable from this utility process.
        version: "1",
        listTools: () => {
          // Taskana 4056: the door now offers detach + continue_session. The
          // original withholding ("a bridge whose host cannot route a
          // background report back never offers it") no longer holds HERE:
          // this boot wires onDetachedTerminal (deliverDetachedChildReport,
          // the TASK.145 delivery path the codex door uses) and the
          // renderer's child_report prompt-queue delivery is engine-agnostic,
          // so a detached child's report reaches this tab as a new turn.
          return door.listTools();
        },
        callTool: door.callTool,
      });
    }
  } else {
    console.log("[host] claude mcp bridge: child boot, no bridge");
  }

  // TASK.182 / Taskana 4136: MCP forwarding. After bridge/catalog/database
  // preparation and immediately before the connect options: sweep dead-pid
  // leftovers, then load the specs ONCE and materialize the private 0600
  // --mcp-config document (only when nonempty). The connect interval below
  // owns the failure contract: any failure after materialization cleans the
  // file up and rethrows; on success the CLIENT owns the file until close —
  // boot returns while the session stays alive, so NO unconditional finally
  // cleanup. Only safe counts/names and controlled notices are ever logged.
  const mcpForward = await prepareEngineMcpForward({
    fs,
    workspace,
    home: homedir(),
    tmpDir: tmpdir(),
    pid: process.pid,
    engines: ["claude"],
    projectTrusted: hostWorkspaceTrust.projectTrusted,
    secrets: mcpSecrets,
  });
  if (mcpForward.claudeNames.length > 0) {
    console.log(`[host] claude mcp forward: ${mcpForward.claudeNames.length} server(s): ${mcpForward.claudeNames.join(", ")}`);
  }
  for (const notice of mcpForward.notices) {
    console.warn(`[host] claude mcp forward: ${notice.type === "engine_notice" ? notice.message : ""}`);
  }
  const claudeBootNotices = mcpForward.notices;
  const claudeMcpConfigPath = mcpForward.claudeConfigPath;

  const options = {
    bootstrap,
    // Taskana 4730: classifying decorator for the Claude approval bridge.
    broker: claudeClassifierBroker,
    binaryPath,
    cwd: workspace,
    // TASK.180: a claude child enforces the profile budget natively
    // (--max-turns); absent = the CLI's own default.
    ...(args.child?.maxTurns !== undefined ? { maxTurns: args.child.maxTurns } : {}),
    // TASK.92: slash passthrough (allowlisted /compact) for ROOT sessions
    // only. A child's prompt is model-authored, so its CLI keeps
    // --disable-slash-commands — no model-driven slash injection.
    enableSlashPassthrough: args.child === undefined,
    // Taskana 4736 xfix D1: the trust gate rides the engine spawn itself —
    // an untrusted folder's .claude/settings.json hooks must not load through
    // Claude Code's own settings sources either (the engine runs with
    // cwd = workspace). `hostWorkspaceTrust` is decided above, before any
    // engine wiring, so the value here is the same gate every loader sees.
    projectTrusted: hostWorkspaceTrust.projectTrusted,
    // Ambient by default (owner pivot): no override here, so ClaudeClient
    // sets no `CLAUDE_CONFIG_DIR` at all and the CLI resolves the SAME
    // `~/.claude` main's doctor diagnosed before it let this tab spawn.
    profileDir: resolveClaudeConfigDir(),
    sourceEnv: process.env,
    // TASK.103: mirror of the codex closure above — same per-call re-read
    // rationale (D-S4-4).
    binaryTrust: (path: string) => checkClaudeBinaryTrustOnDisk(path, process.platform, readTrustedBinaryConsentsSync(hostSettingsPathOverride())),
    ...(processOwnership !== undefined ? { processOwnership } : {}),
    ...(claudeMcpConfigPath !== null ? { mcpConfigPath: claudeMcpConfigPath } : {}),
    ...(claudeBootNotices.length > 0 ? { bootNotices: claudeBootNotices } : {}),
    ...(mcpBridge !== undefined && stamp !== undefined
      ? {
          mcpBridge,
          // Taskana 4056 cross-review M2: the same switch that announces the
          // door teaches the CLI the delegation sentence — the prompt names
          // `mcp__anycode__agent` ONLY in sessions where the tool exists (a
          // bridge-less boot's argv stays byte-identical to pre-4056).
          agentBridgePrompt: CLAUDE_AGENT_BRIDGE_PROMPT,
          takePresentation: stamp.takePresentation,
          // Taskana 4056 cross-review P1: the engine's turn-end sweep for
          // presentations whose consuming tool_result never arrived (a
          // cancelled/dying turn) — without this, one map entry per aborted
          // bridge call would live for the process's lifetime.
          dropPresentations: stamp.dropPresentations,
        }
      : {}),
  };

  // TASK.182: the interval from materialization through boot completion. A
  // failure in connect releases the file HERE and rethrows; after a
  // successful connect the CLIENT owns the file (its bootstrap-adopted
  // close() is idempotent and removes it), and boot()'s own outer catch
  // disposes the engine bootstrap — and with it the client — on any LATER
  // boot-step failure, so no failure path can strand the file. NO
  // unconditional finally runs on success, because boot returns while the
  // session remains alive.
  let connected: Awaited<ReturnType<typeof startClaudeEngine>> & { sessionMeta: Awaited<ReturnType<typeof persistence.getRootSession>> };
  try {
    connected = await (args.resume
      ? (async () => {
        if (args.sessionId === undefined || args.sessionId.length === 0) {
          throw new Error("Claude resume requires a session id");
        }
        // TASK.102 CUT-S4 §4.3: as of S4 an engine session is NOT always root
        // (a child boots on this same branch's `else` below) — but a RESUME
        // still can never legitimately target a child's id: children never
        // respawn (cut §0.6), so `--resume` only ever names a root session,
        // and `getRootSession` staying the lookup here is correct unchanged.
        const existing = await persistence!.getRootSession(args.sessionId);
        if (existing === null) throw new Error(`Claude session ${args.sessionId} was not found`);
        if (existing.engineId !== "claude" || typeof existing.externalSessionRef !== "string" || existing.externalSessionRef.length === 0) {
          throw new Error(`Claude session ${args.sessionId} has no resumable native session`);
        }
        const resumed = await resumeClaudeEngine({
          ...options,
          externalSessionRef: existing.externalSessionRef,
          // Posture survives the resume through the PERSISTED preset id (same
          // no-server-echo-to-trust discipline codex uses, cut §2(k).4): an
          // unrecognized id (a pre-TASK.39-era "build" mode row) silently
          // becomes the default preset rather than failing the resume.
          selection: { model: existing.model, presetId: existing.mode, origin: "persisted" },
        });
        return { ...resumed, sessionMeta: existing };
      })()
    : (async () => {
        // TASK.102 CUT-S4 §4.2: a child boots on the posture the child-
        // permission-map derives from its inherited mode — NEVER the
        // (always absent, §3.2 п.4's `enginePreset: null`) draft preset
        // argv. A non-child boot keeps the byte-identical prior path.
        // (Taskana 4078 finding 5: same extracted seam as the codex boot.)
        const childPresetId = resolveEngineDraftPresetId(args.child, draft.preset, claudeChildPresetId);
        const created = await startClaudeEngine({
          ...options,
          selection: {
            ...(draft.model !== undefined ? { model: draft.model } : {}),
            ...(childPresetId !== undefined ? { presetId: childPresetId } : {}),
            ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
            origin: "draft",
          },
        });
        return { ...created, sessionMeta: null };
      })());
  } catch (error) {
    // TASK.182: the client (if any) closes itself through connect's own
    // failure path or the bootstrap disposer; this belt cleans the file when
    // no client was ever constructed. Idempotent with the client's cleanup.
    mcpForward.cleanupFile();
    throw error;
  }

  const claudeEngine = connected.engine;
  // Taskana 4056 cross-review M1: bind the port's permission-mode seam to the
  // live engine — from here on every bridge spawn snapshots the parent's
  // CURRENT preset (fresh per run() call, cut §0.8), exactly the codex door's
  // `codexParentEngine` binding.
  claudeParentEngine = claudeEngine;
  // Taskana 4056: bind the bridge's live event tap to the connected engine —
  // from here on, a bridged agent call's subagent_* events surface inside the
  // CLI's live turn (claude-engine.ts's bridge-event race).
  pushBridgeEvent = (event: AgentEvent) => claudeEngine.pushBridgeEvent(event);

  // Identity facts, known the moment the transport connected. The POSTURE
  // (model/preset) is deliberately NOT here: it is written only from the
  // native session's own first `system/init` below.
  const sessionRow = {
    workspace,
    engineId: "claude" as const,
    // The native ref. For a fresh spawn it is OURS (`--session-id <uuid>`
    // rides the spawn argv); for a resume it is the persisted ref, echoed
    // verbatim (resumeClaudeEngine never falls back to a new session).
    externalSessionRef: connected.sessionRef,
    // TASK.102 CUT-S4 §4.3: the engine-boot's own row-creation point stamps
    // the same parentSessionId/spawnToolCallId columns the core path's
    // `resolveBootSession`/`childCreateFields` (boot.ts) stamps — without
    // this a claude child is INDISTINGUISHABLE from a root session (owner
    // invariant #1: a child must never appear in `listRootSessions`).
    // `ClaudeSessionRowWriter` forwards `identity` verbatim to `create()`.
    ...(args.child !== undefined
      ? { parentSessionId: args.child.parentSessionId, spawnToolCallId: args.child.spawnToolCallId }
      : {}),
  };
  // The AnyCode row id is preallocated IN MEMORY so Session, the shadow mirror
  // and every `touch` can use it immediately — but no row is written yet
  // (native-first, cut §1.5 hazard (а); the ordering rule itself, plus the
  // buffering of patches that arrive before the row exists, lives in
  // session-row.ts where it is unit-tested). Computed ABOVE (TASK.226 срез
  // S4, before `connected` exists — the mcp bridge's session-tier port needs
  // it too) rather than here: `connected.sessionMeta?.id` is never a THIRD
  // value — a resume's `existing.id` is `args.sessionId` by construction
  // (`getRootSession` looks up `WHERE id = ?`), and a fresh boot's
  // `sessionMeta` is `null` — so `rowId` already equals this expression for
  // both branches.
  const rowWriter = new ClaudeSessionRowWriter({
    rowId,
    identity: sessionRow,
    rowExists: connected.sessionMeta !== null,
    port: {
      create: (id, row) => persistence!.createSession({ id, ...row } as Parameters<SqlitePersistenceAdapter["createSession"]>[0]),
      touch: (id, patch) => persistence!.touchSession(id, patch as { title?: string; mode?: PermissionMode; model?: string }),
    },
    // Taskana 4123 follow-up: the pending-child-reports column writer — the
    // same `pending_child_reports_json` column the core/codex boots use, kept
    // OFF the touch/touchSession path so a durability write never stamps
    // updated_at (the sidebar's last-activity order).
    pendingChildReportsPort: {
      savePendingChildReports: (id, json) => persistence!.savePendingChildReports(id, json),
    },
    onError: (error, stage) => {
      console.error(`[host] claude session row ${stage} failed: ${describeError(error)}`);
    },
  });

  // The first turn-scoped `system/init` is the earliest proof the native
  // session exists — and the only honest source of the POSTURE. `ClaudeEngine`
  // has by now reconciled its settings against that init, so `snapshot()`
  // carries the catalog `value` (`opus[1m]`) rather than the resolved id the
  // CLI reports (`claude-opus-4-8`); persisting the latter would fail
  // `catalog.has()` on the next resume and fall back to the default model.
  claudeEngine.onFirstSystemInit((init) => {
    const settled = claudeEngine.snapshot();
    // The `mode` TEXT column stores the Claude preset id verbatim, the same
    // no-migration arrangement codex uses (cut §2(k).4). Nothing reads this
    // column back as a core PermissionMode for a Claude session.
    rowWriter.materialize({ model: settled.model, mode: settled.activePresetId });
    // TASK.182: reconcile the CLI's OWN reported mcp_servers against what we
    // forwarded PLUS the in-band anycode bridge when one exists (a child
    // boot never expects it). Warnings name missing SERVERS only; no values,
    // no paths. Pure seam tested in mcp-forward-boot.test.ts.
    for (const name of missingForwardedMcpServerNames(init.mcpServerNames, mcpForward.claudeNames, mcpBridge !== undefined)) {
      console.warn(`[host] claude mcp forward: server "${name}" did not appear in the session's MCP server list`);
    }
    // Taskana 4238: a PRESENT server with a bad status is the other half of
    // the reconciliation — the missing-names loop above cannot see it. Names
    // and status only, never values/paths (TASK.182 rule).
    for (const { name, status } of init.mcpServerStatuses) {
      if (status === "failed" || status === "needs-auth") {
        console.warn(`[host] claude mcp: server "${name}" reported status "${status}"`);
      }
    }
  });

  if (connected.sessionMeta !== null) {
    // Resume: the row is already there, so only the identity facts are
    // refreshed now. Its model/mode stay untouched until the resumed session's
    // own `system/init` reports what actually survived (hazard (б)) — writing
    // our persisted posture back here would relaunder a stale row as fresh.
    await persistence.touchSession(rowId, sessionRow);
  }

  // Resume-projection (cut §1.5 DoD-2): built ONCE at boot, from the shadow
  // mirror only — `[]` for a fresh session (nothing to hydrate yet).
  const mirrorRows = connected.sessionMeta === null ? [] : await shadowTranscript.list(connected.sessionRef);
  const bootHistory = projectClaudeHistory(mirrorRows);
  const nextTurnOrdinal = mirrorRows.reduce((max, row) => Math.max(max, row.turnOrdinal + 1), 0);
  // The settle-patch that used to live here (a turn-END callback comparing raw
  // wire values against the row) is gone: `onFirstSystemInit` above now owns
  // both row materialization and the posture patch, at the earlier and correct
  // moment — the init itself — and reads the ENGINE's reconciled snapshot, so
  // the catalog `value` is persisted rather than the CLI's resolved id.
  const shadowEngine = new ClaudeShadowTranscriptEngine(
    claudeEngine,
    shadowTranscript,
    connected.sessionRef,
    bootHistory,
    nextTurnOrdinal,
  );

  const booted = await plugin.boot({ claudeEngine: shadowEngine });
  // `fs` built ABOVE (TASK.226 срез S4 — needed early for the agent-profile
  // catalog scan, before `connected` exists) and reused here verbatim.

  // Shell wiring, identical to the codex branch: AnyCode's own repo context
  // (Git bridge, Review diff, Environment chip) is a property of the WORKSPACE,
  // not the agent runtime, so a Claude session sees exactly what a core session
  // does. `engine.capabilities.supportsGitMutations` stays false — that flag
  // describes the AGENT's own tools; `shell.gitUserMutations` is the separate,
  // shell-owned gate for the Review panel's user-initiated mutations.
  const claudeExecAdapter = new NodeExecutionAdapter();
  const claudeIsGitRepo = await fs.exists(`${workspace}/.git`);
  const claudeGitEnabled = claudeIsGitRepo && typeof claudeExecAdapter.runBinary === "function";
  const claudeGitService = new NodeGitAdapter({ exec: claudeExecAdapter, cwd: workspace, signal: gitAbort.signal });
  gitBridge = new GitBridge({ git: claudeGitEnabled ? claudeGitService : null, outbound });
  const shell: ShellCapabilitiesProjection = {
    gitReadOnly: claudeGitEnabled,
    gitUserMutations: claudeGitEnabled,
    terminal: true,
  };

  /**
   * TASK.102 CUT-S4 §4.4: the universal-snapshot write an engine child's
   * `flushHistory` performs. UNLIKE `booted.engine.historyItems()` (frozen at
   * boot — `ClaudeShadowTranscriptEngine`'s own doc comment: it returns the
   * BOOT-time mirror read, never live), this re-reads the shadow-transcript
   * mirror FRESH at flush time — the exact same query/projection `bootHistory`
   * above used, just re-run after the child's turn(s) actually wrote to it
   * (`shadow-transcript.ts`'s fire-and-forget `sink.record()` in `runTurn`'s
   * `finally`) — so a completed child's snapshot is the FULL transcript, not
   * the empty pre-turn one. Written into the SAME universal `history_items`
   * table a core child's history lives in, through the existing
   * `WriteBehindHistorySink(persistence, childSessionId)` port (no new
   * persistence method) — this is what lets a completed child's "Open" read a
   * non-empty transcript (Sol §3's diagnosis).
   */
  const claudeFlushHistory = async (): Promise<void> => {
    const rows = await shadowTranscript.list(connected.sessionRef);
    const items = projectClaudeHistory(rows);
    const sink = new WriteBehindHistorySink(persistence!, rowId);
    sink.replaceAll(items);
    await sink.flushChecked();
  };

  // TASK.159: telemetry sink for a claude boot — structurally identical to
  // the codex block above (same fail-soft config load, same module-level
  // `telemetry` assignment for the shared shutdown block). `provider`/
  // `enginePreset` (S9: own field, not `mode` — see the codex block's
  // comment above) use `connected.model`/`connected.presetId` — the
  // connect-time values
  // (server-validated against the live `initialize` catalog on a FRESH boot;
  // provisional-until-first-`system/init` on a resume, same caveat the
  // session ROW itself carries until `onFirstSystemInit`'s `materialize`
  // above settles it — session_start is a boot-time fact, not a claim about
  // the eventually-confirmed posture). `baselineFromFirstEvent` is never
  // passed: unlike codex's server-persisted cumulative counter, Claude's
  // accumulator (claude-engine.ts's `cumulativeInputTokens`/`cumulativeOutputTokens`)
  // is per-PROCESS, so it is always 0 at the start of this boot, resume or not.
  let claudeTelemetryConfig: ResolvedTelemetryConfig | null = null;
  try {
    const loadedTelemetry = await loadTelemetryConfig(fs, workspace, homedir(), process.env, {
      // Taskana 4736 xfix D2: the project telemetry section is trust-gated on
      // the same `hostWorkspaceTrust` as mcp/hooks/lsp (established earlier in
      // boot()); one warning line, user-level values still load.
      projectTrusted: hostWorkspaceTrust.projectTrusted,
    });
    claudeTelemetryConfig = loadedTelemetry.telemetry;
    for (const issue of loadedTelemetry.issues) console.warn(`[host] telemetry config: ${issue}`);
  } catch (error) {
    console.error(`[host] failed to load telemetry config; continuing without telemetry: ${describeError(error)}`);
  }
  if (claudeTelemetryConfig !== null) {
    const port = new JsonlTelemetrySink({ dir: claudeTelemetryConfig.dir, fileName: `${rowId}.jsonl` });
    port.record({
      v: 1, ts: Date.now(), session: rowId, t: "session_start",
      model: connected.model, provider: "claude", enginePreset: connected.presetId, engine: "claude",
      ...(args.child !== undefined ? { parentSession: args.child.parentSessionId } : {}),
    });
    telemetry = { port, session: rowId };
  }

  const claudeHistoryMaxItems = resolveSessionHistoryMaxItems(process.env);
  // Taskana 4123 follow-up: restore the persisted detached-child report queue
  // BEFORE this Session's first ui_ready can resendAll() it — the same
  // restore-before-first-ui_ready ordering the core tail holds. Unlike codex
  // (row always exists by now), a FRESH claude boot still has no row at this
  // point (native-first: nothing exists until the first turn-scoped
  // system/init fires rowWriter.materialize), so both seams ride the row's
  // own existence gate: load reads through `materialized` (null — nothing
  // restorable — until the row appears), and save is serialized behind the
  // CREATE through the same write chain `rowWriter.touch` uses, so a report
  // queued before the row exists is neither dropped nor able to conjure the
  // row early. A resume always has its row. A child-mode boot never spawns
  // detached children of its own, so it keeps the in-memory posture and its
  // column stays null.
  const claudePendingChildReports = args.child === undefined
    ? await attachEngineChildReportDurability({
        queue: childReportQueue,
        loadJson: () => (rowWriter.materialized ? persistence!.loadPendingChildReports(rowId) : Promise.resolve(null)),
        saveJson: (json) =>
          rowWriter.savePendingChildReports(json).then(() => undefined),
      })
    : undefined;
  session = new Session({
    workspaceTrustRequired: workspaceTrustRequiredMessage,
    outbound,
    engine: booted.engine,
    // CC-D-min: the RAW ClaudeEngine, Claude's own immediate-apply seam (never
    // codex's choose-now/apply-at-next-turn one — settings-seam.ts).
    engineSettings: new ClaudeSettingsSeam(claudeEngine),
    // Taskana 4056: the background-agents strip seam — same shape the codex
    // door wires (its own Session construction above) over the SAME
    // TASK.145 port API. Without it, pushBackgroundChildren() sends `[]` and
    // a detached child of a claude tab is invisible and unstoppable in the
    // strip (BackgroundAgents.tsx renders from background_children).
    ...(claudeChildPort !== undefined
      ? {
          backgroundChildren: {
            list: () => claudeChildPort!.listBackgroundChildren(),
            cancel: (childSessionId: string) => claudeChildPort!.cancelBackgroundChild(childSessionId),
            cancelAll: () => claudeChildPort!.cancelAllBackgroundChildren(),
            onChange: (listener: () => void) => claudeChildPort!.onBackgroundChildrenChanged(listener),
          },
        }
      : {}),
    broker,
    fs,
    workspace,
    model: connected.model,
    sessionId: rowId,
    // The resume projection built above — `[]` for a fresh session, the
    // shadow-mirror transcript (incl. tool_call cards) for a resumed one.
    bootHistory,
    // TASK.188 S4: dev/automation-ONLY replay-recording override, resolved
    // here (the composition root) and never inside Session itself.
    ...(claudeHistoryMaxItems !== null ? { historyMaxItems: claudeHistoryMaxItems } : {}),
    // Taskana 4123 follow-up: the restored queue's delivery path — resendAll
    // on every ui_ready, ack on child_report_ack. Present only for a root
    // boot (a child-mode claude session has no detached children of its own).
    ...(claudePendingChildReports !== undefined ? { pendingChildReports: claudePendingChildReports } : {}),
    hasTitle: connected.sessionMeta?.title !== undefined && connected.sessionMeta.title.length > 0,
    // TASK.144: the SAME store the broker above matches against, so an
    // in-session "Always allow" starts working from the very next ask instead
    // of only after a restart re-seeds it from settings.json.
    rules,
    // Without this seam the Composer never receives an `imageInput` verdict and
    // Session drops every attachment before the engine sees it (session.ts's
    // `imageInputEnabled?.() !== true` gate) — the second, independent reason
    // images could not be attached, on top of `supportsImages`. Flat, unlike
    // the codex branch's per-model closure: `initialize.models[]` carries no
    // modality field, so the engine-level verdict is the only one available.
    imageInputEnabled: () => true,
    git: gitBridge,
    shell,
    persistence: {
      touch(patch) {
        const { enginePreset, ...rest } = patch;
        const row = { ...rest, ...(enginePreset !== undefined ? { mode: enginePreset } : {}) };
        // Buffered until the row exists (native-first); serialized behind the
        // CREATE once it does.
        rowWriter.touch(row);
      },
    },
    postPreviewArtifacts: sendPreviewArtifacts,
    // TASK.159 INVARIANT: same as the codex branch above — a foreign-engine
    // boot never instantiates AgentLoop, so there is no core eventTap here to
    // double up against. No `baselineFromFirstEvent` — see the telemetry
    // block's own comment above (Claude's counter is per-process).
    ...(telemetry !== null ? { eventTap: buildEngineTelemetryTap(telemetry.port, telemetry.session) } : {}),
    ...(args.child !== undefined ? { child: buildChildSessionOptions(claudeFlushHistory) } : {}),
  });
  // Custody (cut §0.2 invariant 2): the ref is a UUID this host generated (or
  // the persisted one, on resume) and the id is our own row id — no account
  // email, token, subscription type or cost figure is ever written to a log line.
  // Taskana 4730: bind the late-bound Session ref (see the codex branch).
  classifierSessionRef = session;
  console.log(`[host] initialized Claude native session ${connected.sessionRef} session=${rowId} db=${dbPath}`);
}

// ── TASK.198 срез C: vision-fallback host wiring — pure helpers ──

/**
 * The three valid `ProviderTransport` ids (packages/core/src/provider/
 * catalog.ts's `PROVIDER_TRANSPORT_VALUES`/env.ts's validation of the same
 * set) — copied as a literal because that list is not exported from the
 * package barrel, and `packages/core/**` is out of reach here regardless.
 * Same "host stays core-free / cross-layer literal mirror" convention this
 * file already follows for the ANYCODE_RECOGNIZER_* env-var names below.
 */
const RECOGNIZER_TRANSPORT_VALUES: readonly string[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

/**
 * Fills the two fields a resolved connection may leave unset (main/host-env.ts's
 * `resolveRecognizerConfig` own doc: "a bare/custom connection has no
 * `providerName`, a keyless local server has no `apiKey`") plus a `transport`
 * DEFAULT for the one case a wire/env source may omit that core's
 * `RecognizerEndpoint` (vision/recognizer.ts) does not accept — the SAME
 * final fallback the primary provider ladder above already uses
 * (`providerTransport = envConfig.providerTransport ?? catalogEntry?.
 * defaultTransport ?? "anthropic-messages"`), never a second policy invented
 * for the recognizer alone.
 *
 * Returns `null` (a disabled recognizer, never a "configured but broken" one)
 * on either of two malformed inputs, checked at this ONE construction point
 * so both callers below (the boot-env snapshot in `parseRecognizerEnv`, and
 * main's live config push) are covered by a single check each:
 *  - `baseUrl` blank after trimming (live-run fix, TASK.198 follow-up): the
 *    unconfigured-recognizer placeholder a few lines below is literally
 *    `{transport: "anthropic-messages", baseUrl: "", model: ""}`, the exact
 *    anthropic+blank-address pair a live run turned into `Invalid Anthropic
 *    base URL: "" is empty after trimming` after `InspectImage` had already
 *    registered and been called;
 *  - `transport` PRESENT but not one of the three known `ProviderTransport`
 *    ids — parity with core's own `loadEnvConfig` validation (env.ts: an
 *    invalid transport "is rejected the same way as any other invalid
 *    value"), restored here because this field's cast to `ProviderTransport`
 *    was unchecked (any string was silently accepted as a valid transport).
 *    A transport that is simply ABSENT is NOT malformed — that is the
 *    documented legacy-fallback default two lines below, shared with the
 *    primary provider ladder, and is left alone.
 *
 * The transport check here is NOT redundant with main/host-env.ts's own
 * `resolveEffectiveTransport`-based ladder in `resolveRecognizerConfig` — the
 * two sit at NON-OVERLAPPING injection points. That ladder governs
 * RESOLUTION (what settings/catalog value main picks, and when it honestly
 * refuses); this check governs what can arrive AFTER resolution, from a path
 * that ladder never sees: `applyRecognizerEnv`'s `fillFromSettings` is
 * env-value-wins, so an ambient `ANYCODE_RECOGNIZER_TRANSPORT` in this
 * fork's OWN environment can override whatever main resolved, and main's
 * live RECOGNIZER_CONFIG_CHANGED push (the other caller below) carries a
 * `transport` string that never passes through main's ladder at all. Drop
 * either gate and the hole the other one does not cover reopens.
 */
function recognizerEndpointFromFields(fields: {
  transport?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  providerName?: string;
}): RecognizerEndpoint | null {
  if (fields.baseUrl === undefined || fields.baseUrl.trim() === "") {
    return null;
  }
  if (fields.transport !== undefined && !RECOGNIZER_TRANSPORT_VALUES.includes(fields.transport)) {
    return null;
  }
  return {
    transport: (fields.transport as ProviderTransport | undefined) ?? "anthropic-messages",
    baseUrl: fields.baseUrl,
    model: fields.model,
    ...(fields.apiKey !== undefined && fields.apiKey !== "" ? { apiKey: fields.apiKey } : {}),
    ...(fields.providerName !== undefined && fields.providerName !== "" ? { providerName: fields.providerName } : {}),
  };
}

/**
 * TASK.198 срез C: `ANYCODE_RECOGNIZER_{TRANSPORT,BASE_URL,API_KEY,MODEL,
 * PROVIDER_NAME}` -> a core `RecognizerEndpoint`, or null when the fallback
 * is unconfigured. Literal local var-name copies mirror main/host-env.ts's
 * `ENV_RECOGNIZER_*` constants by contract — the same "host stays core-free
 * / cross-layer literal mirror, never a wrong-direction import" convention
 * every other env-var family in this file already follows (host never
 * imports from `../main/`). A blank `ANYCODE_RECOGNIZER_MODEL` is one honest
 * "off" signal, checked here; a blank `ANYCODE_RECOGNIZER_BASE_URL` and an
 * unknown `ANYCODE_RECOGNIZER_TRANSPORT` are the other two (live-run fix,
 * TASK.198 follow-up) — `resolveRecognizerConfig` can emit a model with no
 * resolvable address (an unconfigured `needsBaseUrl` catalog template, or a
 * legacy/unknown providerId), and this env family carries no validation of
 * its own on the transport string — both gates live in
 * `recognizerEndpointFromFields` below, the one construction point this and
 * the live-push caller both go through.
 */
function parseRecognizerEnv(env: NodeJS.ProcessEnv): RecognizerEndpoint | null {
  const model = env.ANYCODE_RECOGNIZER_MODEL;
  if (model === undefined || model.trim() === "") {
    return null;
  }
  return recognizerEndpointFromFields({
    transport: env.ANYCODE_RECOGNIZER_TRANSPORT,
    baseUrl: env.ANYCODE_RECOGNIZER_BASE_URL,
    apiKey: env.ANYCODE_RECOGNIZER_API_KEY,
    model,
    providerName: env.ANYCODE_RECOGNIZER_PROVIDER_NAME,
  });
}

/**
 * Wraps a recognizer `ModelPort` with a usage-telemetry tap (plan §8): `ask()`
 * "reports itself" through the SAME `t:"usage"` shape core's own `finish`
 * events report (telemetry/records.ts's `telemetryRecordFor`), stamped with
 * the sub-envelope inline subagents already use (`buildSubagentTelemetryTap`'s
 * `sub:{agentType, model}` convention, TASK.160) — `agentType:"vision"` — so
 * a vision call's spend lands in the SAME jsonl session file and the Profile
 * panel attributes it without a new source type. No AgentEvent is
 * synthesized (a one-shot `ask()` call is not a nested AgentLoop run) — this
 * intercepts the raw `ModelStreamEvent` stream one layer below that.
 */
class VisionTelemetryModelPort implements ModelPort {
  constructor(
    private readonly inner: ModelPort,
    private readonly report: (usage: TokenUsage) => void,
  ) {}

  get modelId(): string | undefined {
    return this.inner.modelId;
  }

  get lastResponseModel(): string | undefined {
    return this.inner.lastResponseModel;
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.inner.streamText(request)) {
      if (event.type === "finish") {
        this.report(event.usage);
      }
      yield event;
    }
  }
}

async function boot(): Promise<void> {
  try {
    // Taskana 4752 part C: the MCP secret values main handed this fork. Read and
    // deleted FIRST, before any child can spawn (the relay, the engines, the MCP
    // load). The resolver closure is the only holder of the values: nothing stores
    // them on a global, logs them, or emits them.
    const mcpSecrets = takeMcpSecretsEnv(process.env);
    // TASK.135 follow-up (Taskana 4074): start the credential-free loopback
    // relay BEFORE the first non-engine spawn, when this fork holds a
    // credentialed proxy. await-ed here so the very first Bash child, PTY
    // shell, LSP and MCP stdio server already see the relay URL (the
    // NodeExecutionAdapter/terminal spawn sites re-read it per spawn).
    // No-op (settled, no server) when no proxy var carries credentials.
    // Taskana 4685 rework: one relay PER upstream (the registry is keyed by
    // the normalized credentialed URL). Cross-review F5b: the PLURAL scan —
    // distinct credentialed HTTP vs HTTPS upstreams each need their own
    // relay before the first spawn, not only the family's first value.
    for (const bootUpstream of credentialedProxyValuesForRelay(process.env)) {
      await resolveProxyRelay(bootUpstream);
    }
    // Selection/probe is deliberately before loadEnvConfig: an external engine
    // must never require AnyCode provider credentials merely to fail/boot.
    // Taskana 4736: decide the workspace trust gate ONCE, before any engine, hook,
    // LSP, MCP or plugin wiring. A pending decision is reported to main on the
    // control channel (main keys the answer by tab and hash, never by the UI).
    // Taskana 4732 S1-B: the app-version carrier (main stamps app.getVersion()
    // into the fork env as ANYCODE_APP_VERSION). Read once, fail-soft — absent
    // (bare test harness) leaves discovery byte-identical.
    const hostAppVersion = parseAppVersionEnv(process.env[ENV_APP_VERSION]);
    // Taskana 4736 xfix D4: parsed here (pure argv read, no I/O) so the trust
    // gate can see child-mode boots — the same parse the core path repeats
    // below unchanged (parseHostArgs is pure; the duplicate is harmless).
    const bootArgs = parseHostArgs(process.argv.slice(2));
    hostWorkspaceTrust = await establishHostWorkspaceTrust(new NodeFileSystemAdapter(), {
      workspace,
      home: homedir(),
      env: process.env,
      // Taskana 4739: symlink and target share one trust record.
      realpathSync,
      // Taskana 4736 xfix D4: a child tab shares the parent's workspace; the
      // parent's record/once-approval decides and no pending dialog is
      // reported for a surface that cannot answer it.
      childSurface: bootArgs.child !== undefined,
    });
    if (hostWorkspaceTrust.pending !== undefined) {
      process.parentPort?.postMessage({
        type: WORKSPACE_TRUST_PENDING_MESSAGE_TYPE,
        state: hostWorkspaceTrust.pending.state,
        hash: hostWorkspaceTrust.pending.hash,
      });
    }
    const plugin = selectEnginePlugin(process.env);
    engineBootstrap = await beginEngineBootstrap(plugin);
    if (engineBootstrap.id === "codex") {
      await bootCodexSession(engineBootstrap, plugin, mcpSecrets);
      return;
    }
    // SLICE-CC C4 (cut §1.4): the one new dispatch branch. Everything below
    // stays the core boot path, byte-identical.
    if (engineBootstrap.id === "claude") {
      await bootClaudeSession(engineBootstrap, plugin, mcpSecrets);
      return;
    }
    const envConfig = loadEnvConfig(process.env);
    const args = parseHostArgs(process.argv.slice(2));

    // TASK.198 срез C: the fork-boot snapshot half of the recognizer's config
    // delivery (plan §1.2 step 1) — E1's ANYCODE_RECOGNIZER_* family, parsed
    // once here. `liveRecognizerEndpoint` is a SINGLE mutable object identity
    // kept for the life of this boot: InspectImage's own factory (below)
    // destructures `endpoint` out of its options ONCE and never re-reads it,
    // so a later live-push commit mutates THIS object's fields in place
    // (never reassigns the reference) — the already-built tool then observes
    // the current config despite having captured it only once.
    // `recognizerConfigured` is the cheap boolean readback both
    // `media.recognizerConfigured` and Session's `imageFallbackAvailable`
    // consult on every call.
    const bootRecognizerEndpoint = parseRecognizerEnv(process.env);
    let recognizerConfigured = bootRecognizerEndpoint !== null;
    const liveRecognizerEndpoint: RecognizerEndpoint =
      bootRecognizerEndpoint ?? { transport: "anthropic-messages", baseUrl: "", model: "" };

    // Always-allow persistence (design §5, slice 2.2.3): read-only, fail-soft
    // (seedAlwaysAllowRules never throws — see host/boot.ts). Independent of
    // everything else booted below; done early so the same `rules` instance is
    // ready for both the permission engine and the Session constructor.
    // Dev-profile settings path override (design/slice-P7.15-cut.md §2.6):
    // `main/index.ts` forwards its OWN already-gated settingsPath into every
    // host fork's env under this same var name (unconditionally — a normal
    // launch just forwards the production default), so this process has no
    // `isPackaged` gate of its own to re-derive; it simply trusts the value it
    // was forked with, falling back to seedAlwaysAllowRules' own default only
    // for a bare test-harness boot that never set the var.
    const settingsPathOverride = process.env[ENV_SETTINGS_PATH];
    const rules = await seedAlwaysAllowRules(
      settingsPathOverride !== undefined && settingsPathOverride.trim() !== "" ? settingsPathOverride : undefined,
    );

    // Taskana 4088 (TASK.69), 4088-on-4118 integration: the per-model override
    // is parsed ONCE here from the env main stamps for THIS fork's connection
    // (buildHostEnv runs on the per-tab pinned settings). The live
    // image-modality set no longer travels through the fork env: it rides
    // 4118's modelCapabilities map (`imageInput?: true` per model), which this
    // boot already loaded into `liveCapsFor` (readConnectionModelCapabilities,
    // fail-soft, fork-connection id first then the session row pin). Both are
    // consumed per call by `media.imageInputEnabled` (below), which
    // re-resolves through `currentModel` on every send.
    const imageModelOverride = parseImageInputModelOverride(process.env[ENV_IMAGE_INPUT_MODEL_OVERRIDE]);
    const imageModalityLookup: ImageModalityLookup = (id) => (liveCapsFor(id)?.imageInput === true ? true : undefined);

    // TASK.138 slice 2: per-run Bash allow-list, a PROCESS INPUT (whoever
    // launched this fork), never a setting — see run-allow-bash.ts's module
    // doc. Parsed once here so the same list feeds both the permission engine
    // below and this startup diagnostic; an unset/empty env var parses to []
    // (RunAllowBashPermissionEngine's own no-op fast path, zero behavior
    // change). Logged unconditionally so a widened run is never silent, even
    // when every configured entry was malformed and none were accepted.
    const runAllowBashEntries = parseRunAllowBash(process.env[ENV_RUN_ALLOW_BASH]);
    // Taskana 4702 Stage 1 / Taskana 4730: the ask-zone classifier (default
    // off). Parsed defensively; garbage or absence = off. kind:"command"
    // yields a ready boot (Stage 1). kind:"model" (implementation B) names a
    // model from the connections — the classifier is BUILT below, once the
    // provider/transport catalog is resolved, and resolution failure (unknown
    // connection, no key) turns the classifier OFF with one log line, never a
    // crash. Engine sessions get coverage through the classifying broker
    // decorator (classifying-broker.ts) instead of the core config alone.
    const askClassifierKindBoot = parseAskClassifierEnvKind(process.env[ENV_PERMISSION_CLASSIFIER]);
    const askClassifierBoot: AskClassifierBoot | undefined =
      askClassifierKindBoot !== undefined && askClassifierKindBoot.kind === "command"
        ? askClassifierKindBoot.boot
        : undefined;
    if (askClassifierBoot !== undefined) {
      console.log(`[host] ${ENV_PERMISSION_CLASSIFIER}: ask-zone classifier ${askClassifierBoot.classifier.id} enabled`);
    }
    if (process.env[ENV_RUN_ALLOW_BASH] !== undefined) {
      console.log(
        `[host] ${ENV_RUN_ALLOW_BASH}: accepted ${runAllowBashEntries.length} entr${runAllowBashEntries.length === 1 ? "y" : "ies"} ` +
          `(${runAllowBashEntries.map((entry) => JSON.stringify(entry.join(" "))).join(", ")})`,
      );
    }

    // Oauth-mode credential broker (design §3.3, slice 2.5.3): buildResolveApiKey
    // returns undefined unless this fork was spawned with ANYCODE_AUTH_MODE=oauth,
    // in which case AiSdkModelPort omits `resolveApiKey` entirely from its config
    // — byte-for-byte the 2.2 static-key path.
    const resolveApiKey = buildResolveApiKey({
      authMode: process.env[ENV_AUTH_MODE],
      send: sendCredentialRequest,
      subscribe: subscribeCredentialResponses,
      fallbackApiKey: envConfig.apiKey,
    });

    // Catalog entry resolved early so the model port can branch reasoning-effort
    // mapping by provider (slice 6.4-R2: GLM enum vs Claude budgetTokens) and
    // the boot budget/effort resolutions below share the same lookup.
    const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), envConfig.baseUrl);

    // Single back-compat resolution point for the wire transport, mirroring the
    // CLI (TASK.43 §0.4): the mandatory discriminant is applied once here rather
    // than defaulted inside EndpointConfig, so the hot-swap factory below cannot
    // silently drop it. Env always wins; the catalog's declared default is next;
    // anthropic-messages is the final legacy fallback.
    const providerTransport: ProviderTransport =
      envConfig.providerTransport ?? catalogEntry?.defaultTransport ?? "anthropic-messages";

    // TASK.158: usage streaming resolved ONCE, immediately after the transport
    // ladder (mirror of the CLI's resolution point): an explicit
    // ANYCODE_INCLUDE_USAGE wins outright; unset defaults to true only for
    // `openai-chat-completions`, the one transport that honours
    // stream_options.include_usage. The hot-swap factory below spreads the flag
    // in conditionally, so `false` (strict-server escape hatch) sends nothing.
    const includeUsage = resolveIncludeUsage(providerTransport, envConfig.includeUsage);

    // Slice P7.15 (F14, design §2.1): mid-session model switch mirrors the CLI
    // `/model` recipe (host-side hot-swap, NOT a respawn). The factory rebuilds a
    // fresh AiSdkModelPort per switch (LanguageModel is built per-attempt, so the
    // factory is cheap; the api key legitimately lives in the closure, precedent
    // A9); `switchableModelPort` stays a SwitchableModelPort wrapper — the ONE
    // object the loop/ContextManager/subagents/titling all capture by reference
    // (through the `modelPort` decorator below, which forwards every call to
    // it), so a setPort between turns is instantly visible to every holder.
    // Taskana 4226: a child session rides out a short network outage. The
    // session meta resolves AFTER this factory is first used, so the flag
    // starts argv-only and is widened (with a port rebuild) once it is known.
    let childRetryBoot = args.child !== undefined;
    // Taskana 4705: main sessions honor ANYCODE_MAX_RETRIES / ANYCODE_NETWORK_RETRY_BUDGET_MS
    // (filled from settings.tools by host-env); children keep the Taskana 4226 budget policy.
    const envRetry: Partial<RetryPolicy> = {
      ...(envConfig.maxRetries !== undefined ? { maxRetries: envConfig.maxRetries } : {}),
      ...(envConfig.networkRetryBudgetMs !== undefined ? { networkRetryBudgetMs: envConfig.networkRetryBudgetMs } : {}),
    };
    const modelPortFactory = (m: string): ModelPort =>
      new AiSdkModelPort(
        {
          transport: providerTransport,
          baseUrl: envConfig.baseUrl,
          apiKey: envConfig.apiKey,
          model: m,
          ...(catalogEntry !== undefined ? { providerName: catalogEntry.name } : {}),
          ...(resolveApiKey !== undefined ? { resolveApiKey } : {}),
          ...(includeUsage ? { includeUsage: true } : {}),
          ...(childRetryBoot
            ? { retry: childRetryPolicy(true, envRetry) }
            : Object.keys(envRetry).length > 0
              ? { retry: envRetry }
              : {}),
          // Taskana 4090: setting an observer is what arms the factories'
          // wrapped fetch; the port itself captures the update and yields it
          // as a `provider_quota` event, so the host needs no state of its own.
          onQuotaHeaders: () => {},
        },
        hostDiagnosticSink,
      );
    const switchableModelPort = new SwitchableModelPort(modelPortFactory(envConfig.model));
    // TASK.198 срез C (plan §3): the ONE external decorator around the
    // SwitchableModelPort — mirror of cli/main.ts's own
    // `modelPortWithMediaProjection` wrap (B1) — so every consumer of
    // `config.modelPort` (the main turn loop, ceiling verdict, compaction,
    // inline-subagent wrap-up) projects image bytes off the wire on a blind
    // model by construction. `media.imageInputEnabled` is declared further
    // down this function — a safe forward reference: this closure is never
    // INVOKED until a real turn runs streamText(), long after `media` exists.
    const modelPort = createMediaProjectionPort(switchableModelPort, () => media.imageInputEnabled());

    // Taskana 4730 (implementation B, kind:"model"): build the ask-zone
    // classifier from a ModelPort. Both `connectionId` and `model` optional =
    // "the session's own connection/model": unset uses the session's own port
    // (the switchable one, WITHOUT the media-projection wrap — a classifier
    // call carries no images) and the session's current model id. An explicit
    // `model` reuses the SAME modelPortFactory an Agent(model:) override uses
    // (validated against ANYCODE_CHILD_MODELS exactly like a child override).
    // 4730 xfix D4: an explicit `connectionId` is HONEST about what this fork
    // can resolve — the fork env carries only the ACTIVE connection's
    // endpoint (main resolves connections when forking, not the host). A pin
    // on the ACTIVE connection resolves normally; a pin on ANY other
    // connection turns the classifier OFF with a user-visible notice
    // (engine_notice on the first turn), NEVER a silent fallback to the
    // session's own connection and NEVER a `model` resolved against a
    // different connection than the one named. The decision table lives in
    // model-classifier-boot.ts (pure, unit-tested). Every failure path =
    // classifier OFF, never a crash. Default timeout for the model kind:
    // 8000 ms (a model call is slower than a local command) unless the
    // record set one.
    let modelKindClassifierBoot: AskClassifierBoot | undefined;
    let modelClassifierOffNotice: string | undefined;
    if (askClassifierKindBoot?.kind === "model") {
      const record = askClassifierKindBoot;
      const allowedChildModels = readAllowedChildModels(process.env.ANYCODE_CHILD_MODELS, envConfig.model);
      const boot = resolveModelClassifierBoot(
        record,
        {
          source: {
            allowedModels: () => allowedChildModels,
            portFor: (m: string): ModelPort => modelPortFactory(m),
          },
          sessionModel: envConfig.model,
          activeConnectionId: process.env[ENV_CONNECTION_ID],
        },
      );
      if (boot.ok) {
        modelKindClassifierBoot = {
          classifier: createModelAskClassifier({
            modelPort: boot.usesSessionPort ? switchableModelPort : modelPortFactory(boot.model),
            model: boot.model,
          }),
          // 4730 xfix (report P3): the ONE model-kind default, not a duplicated literal.
          timeoutMs: record.timeoutMs ?? CLASSIFYING_BROKER_MODEL_TIMEOUT_MS,
        };
        console.log(`[host] ${ENV_PERMISSION_CLASSIFIER}: ask-zone classifier ${modelKindClassifierBoot.classifier.id} enabled (model kind)`);
      } else {
        modelClassifierOffNotice = boot.notice;
        console.log(`[host] ${ENV_PERMISSION_CLASSIFIER}: model classifier OFF — ${boot.notice}`);
      }
    }
    const effectiveAskClassifierBoot: AskClassifierBoot | undefined =
      askClassifierBoot ?? modelKindClassifierBoot;
    // Mutable source of truth for the live model (mirror of the CLI's
    // `currentModel`, loopConfig.mode's model twin). Boot-frozen readers below
    // (`media.imageInputEnabled`, `systemPromptEnv.modelId`) read THIS so a
    // switch is honored on the next turn.
    let currentModel = envConfig.model;
    // The user-selected effort TIER (mirror of the CLI's `selectedReasoningEffort`,
    // main.ts:422): persists across a model switch so switching to a non-reasoning
    // model and back restores the tier. `set_reasoning_effort` writes it; the
    // model switch re-resolves the effective effort from it per the new model.
    let selectedEffort: ReasoningEffort = envConfig.reasoningEffort ?? "off";
    // TASK.102 CUT-S2 §2.6.1/§2.6.2 (slice S2b B5): non-recursion lock #1. A
    // non-child (root) boot builds the FULL registry — `sessionTier:true`
    // makes `tier:"session"` reachable in the Agent tool's SERIALIZED schema
    // (tools/schemas.ts's `agentInputSchema`) — because it is the only kind
    // of host that wires a `SessionSubagentPort` below (lock #2, right after
    // `config` is built) to back it. A child-mode boot keeps the plain
    // default registry (`restrictedAgentInputSchema` — `tier` is a
    // single-value `"inline"` enum, `provider` is absent from `properties`
    // entirely): a model talking to a child cannot even DISCOVER the session
    // tier exists, let alone reach it — a child structurally cannot spawn its
    // own child session.
    const fsAdapter = new NodeFileSystemAdapter();
    const execAdapter = new NodeExecutionAdapter();

    // ArchMap opt-in (Taskana 4162), mirror of cli/main.ts: ANYCODE_ARCHMAP=1
    // wins, else `tools.archMap: true` in the same ~/.anycode/settings.json
    // seedAlwaysAllowRules reads (the dev-profile override env var included),
    // else OFF — the default registry and the host's tool-discipline section
    // stay byte-identical to the pre-ArchMap baseline. Fail-soft:
    // loadArchMapEnabled never throws, so a corrupt settings file only costs
    // the flag, never the boot.
    const archMapEnabled = await loadArchMapEnabled(
      fsAdapter,
      hostSettingsPathOverride() ?? defaultSettingsPath(),
      process.env,
    );

    const registry =
      args.child === undefined
        ? createDefaultToolRegistry({ agent: { sessionTier: true }, ...(archMapEnabled ? { archMap: true } : {}) })
        : createDefaultToolRegistry(archMapEnabled ? { archMap: true } : undefined);

    // TASK.4721: adaptive turn budget (ANYCODE_ADAPTIVE_TURN_BUDGET, mirror of
    // `tools.adaptiveTurnBudget`). OFF => no ceiling key, no subagentBudget,
    // no history file touched — the pre-4721 boot, byte-identical. ON => the
    // ladder grants on progress and the learned base budget is fed from and
    // read back through one shared store (inline + session tiers).
    const adaptiveTurnBudget = envConfig.adaptiveTurnBudget === true;
    const subagentBudget = adaptiveTurnBudget ? createSubagentBudgetPort(defaultTurnBudgetHistoryPath()) : undefined;


    // session from argv — create (`--session`) or load (`--resume`, mirror of
    // cli/main.ts:239-259; the initial history is NOT re-appended to the sink).
    const dbPath = envConfig.dbPath ?? join(homedir(), ".anycode", "anycode.sqlite");
    persistence = new SqlitePersistenceAdapter(dbPath);
    const forkConnectionId = process.env[ENV_CONNECTION_ID];
    const resolvedSession = await resolveBootSession(persistence, {
      args,
      workspace,
      model: envConfig.model,
      // TASK.45 W10: pin the fork's provider connection onto a NEW session (main
      // stamped it into the fork env). A resumed existing session ignores it and
      // keeps its own stored pin (resolveBootSession invariant).
      ...(forkConnectionId !== undefined && forkConnectionId.trim() !== "" ? { connectionId: forkConnectionId } : {}),
    });
    let sessionMeta = resolvedSession.sessionMeta;
    const { initialHistory, resumedMissing } = resolvedSession;
    // Taskana 4752 part A: tools see their session id. Main stamps the pair into
    // the fork env, so this only fills a bare/legacy boot (dev harness) where it
    // is absent; `??=` never overrides main's value.
    applySessionToolEnv(process.env, sessionMeta.id, workspace);
    if (!childRetryBoot && isChildSessionBoot(args, sessionMeta)) {
      childRetryBoot = true;
      switchableModelPort.setPort(modelPortFactory(envConfig.model));
    }
    if (sessionMeta.worktreeTransition !== undefined) {
      const pending = sessionMeta.worktreeTransition;
      if (hasDurableTransitionResult(initialHistory, pending.kind, pending.origin, pending.toolCallId)) {
        await persistence.touchSession(sessionMeta.id, { worktreeTransition: null });
        const { worktreeTransition: _confirmed, ...confirmed } = sessionMeta;
        sessionMeta = confirmed;
      } else {
        // Metadata was staged before the terminal tool result reached durable
        // history. Restore the source workspace; for a newly-created owned
        // checkout, prove it clean through GitPort before removing it.
        let retainedCleanup:
          | { path: string; mode: "auto"; ownedByAnyCode: true; branch: string }
          | undefined;
        if (pending.kind === "enter_worktree" && pending.worktree.ownedByAnyCode) {
          const removed = await cleanupOwnedWorktreeResource(
            new NodeGitAdapter({ exec: execAdapter, cwd: pending.projectRoot }),
            { path: pending.toWorkspace, branch: pending.worktree.branch },
          );
          if (!removed.ok) {
            retainedCleanup = {
              path: pending.toWorkspace,
              mode: "auto",
              ownedByAnyCode: true,
              branch: pending.worktree.branch,
            };
          }
        }
        await persistence.touchSession(sessionMeta.id, {
          projectRoot: pending.projectRoot,
          workspace: pending.fromWorkspace,
          worktree: pending.kind === "exit_worktree" ? pending.worktree : null,
          continuationPending: retainedCleanup !== undefined,
          continuationMode: retainedCleanup !== undefined ? "none" : null,
          worktreeExitNoticePending: false,
          worktreeCleanup: retainedCleanup ?? null,
          worktreeTransition: null,
        });
        sessionMeta = {
          ...sessionMeta,
          projectRoot: pending.projectRoot,
          workspace: pending.fromWorkspace,
          ...(pending.kind === "exit_worktree" ? { worktree: pending.worktree } : { worktree: undefined }),
          continuationPending: retainedCleanup !== undefined,
          worktreeExitNoticePending: false,
          worktreeCleanup: retainedCleanup,
          continuationMode: retainedCleanup !== undefined ? "none" : undefined,
          worktreeTransition: undefined,
        };
      }
    }
    const canonical = async (value: string): Promise<string> => {
      try {
        return await fsRealpath(value);
      } catch {
        return resolve(value);
      }
    };
    const canonicalStoredWorkspace = await canonical(sessionMeta.workspace);
    const canonicalHostWorkspace = await canonical(workspace);
    const canonicalProjectRoot = await canonical(sessionMeta.projectRoot ?? sessionMeta.workspace);
    if (canonicalStoredWorkspace !== canonicalHostWorkspace) {
      // Crash recovery for the window after durable transition commit but
      // before main processed the original handoff. Never start a model in a
      // cwd that disagrees with persistence; ask main to rehost authoritatively.
      const cleanup = sessionMeta.worktreeCleanup;
      process.parentPort.postMessage({
        type: WORKTREE_TRANSITION_MESSAGE_TYPE,
        sessionId: sessionMeta.id,
        fromWorkspace: workspace,
        toWorkspace: canonicalStoredWorkspace,
        projectRoot: canonicalProjectRoot,
        ...(sessionMeta.worktree !== undefined
          ? { worktree: { ...sessionMeta.worktree, path: canonicalStoredWorkspace } }
          : {}),
        ...(cleanup !== undefined ? { cleanup } : {}),
      });
      throw new Error(`Persisted workspace requires rehost: ${sessionMeta.workspace}`);
    }
    if (
      sessionMeta.workspace !== canonicalStoredWorkspace ||
      (sessionMeta.projectRoot ?? sessionMeta.workspace) !== canonicalProjectRoot
    ) {
      const normalizedWorktree = sessionMeta.worktree === undefined
        ? undefined
        : { ...sessionMeta.worktree, path: canonicalStoredWorkspace };
      await persistence.touchSession(sessionMeta.id, {
        workspace: canonicalStoredWorkspace,
        projectRoot: canonicalProjectRoot,
        ...(normalizedWorktree !== undefined ? { worktree: normalizedWorktree } : {}),
      });
      sessionMeta = {
        ...sessionMeta,
        workspace: canonicalStoredWorkspace,
        projectRoot: canonicalProjectRoot,
        ...(normalizedWorktree !== undefined ? { worktree: normalizedWorktree } : {}),
      };
    }
    const projectRoot = sessionMeta.projectRoot ?? sessionMeta.workspace;
    // Taskana 4118: live capabilities for models the catalog does not know,
    // read fail-soft from settings.json (main persists them on the connection).
    // The fork env's connection id wins over the session row's pin: on a
    // TASK.106 rebind main respawns the host with the NEW connection in the env
    // BEFORE it re-pins the row (tab-ipc handleTabRebind), so the row still
    // names the old connection at boot. Main stamps the env from
    // `tab.connectionId` on every spawn, so it is the connection whose
    // credentials this host actually talks to; the row pin is the fallback.
    const liveCapsConnectionId =
      forkConnectionId !== undefined && forkConnectionId.trim() !== "" ? forkConnectionId : sessionMeta.connectionId;
    const liveCapsMap = await readConnectionModelCapabilities(
      liveCapsConnectionId,
      settingsPathOverride !== undefined && settingsPathOverride.trim() !== "" ? settingsPathOverride : undefined,
    );
    const liveCapsFor = (id: string): LiveModelCapabilities | undefined => liveCapsMap?.[id];
    const gitForWorkspace = (cwd: string, operationSignal?: AbortSignal) =>
      new NodeGitAdapter({
        exec: execAdapter,
        cwd,
        signal: operationSignal === undefined
          ? gitAbort.signal
          : AbortSignal.any([gitAbort.signal, operationSignal]),
      });
    const worktreeLifecycle = new WorktreeLifecycleService({
      session: sessionMeta,
      persistence,
      gitForWorkspace,
      ensureNamespaceIgnored: async (projectRoot, _pattern, signal) => {
        const git = gitForWorkspace(projectRoot, signal);
        if (!git.ensureWorktreeNamespaceIgnored) {
          return { ok: false, reason: "Git adapter cannot maintain the worktree exclude." };
        }
        const result = await git.ensureWorktreeNamespaceIgnored();
        return result.ok ? { ok: true, value: null } : result;
      },
    });
    const activeWorktree = await worktreeLifecycle.validateActiveWorktree();
    if (!activeWorktree.ok) {
      throw new Error(`Cannot resume worktree session: ${activeWorktree.reason}`);
    }
    let preparedCleanup: WorktreeCleanupIntent | undefined;
    const worktreeControl: WorktreeControlPort = {
      async enter(request, options) {
        if (options.signal.aborted) return { ok: false, error: "Worktree entry was cancelled.", errorKind: "cancelled" };
        const result = await worktreeLifecycle.enter(request, options.toolCallId, options.signal);
        if (!result.ok) {
          return options.signal.aborted
            ? { ok: false, error: "Worktree entry was cancelled.", errorKind: "cancelled" }
            : { ok: false, error: result.reason, errorKind: "invalid_input" };
        }
        preparedCleanup = result.value.cleanup;
        return { ok: true, transition: result.value.transition };
      },
      async exit(request, options) {
        if (options.signal.aborted) return { ok: false, error: "Worktree exit was cancelled.", errorKind: "cancelled" };
        const result = await worktreeLifecycle.exit(request, options.toolCallId, options.signal);
        if (!result.ok) {
          return options.signal.aborted
            ? { ok: false, error: "Worktree exit was cancelled.", errorKind: "cancelled" }
            : { ok: false, error: result.reason, errorKind: "invalid_input" };
        }
        preparedCleanup = result.value.cleanup;
        const message = result.value.cleanup.kind === "none"
          ? result.value.cleanup.reason
          : `Worktree cleanup scheduled after rehost: ${result.value.cleanup.target}`;
        return { ok: true, transition: result.value.transition, message };
      },
    };
    const worktreeAvailable =
      typeof execAdapter.runBinary === "function" && (await fsAdapter.exists(join(projectRoot, ".git")));
    if (worktreeAvailable) {
      registry.register(enterWorktreeTool);
      registry.register(exitWorktreeTool);
    }
    // Browser-preview capability (night-track wave-1 cut §2/§2.2): unlike
    // worktreeAvailable, there is no local precondition to probe (main's
    // PreviewHost is unconditionally wired, and the RPC client above is pure
    // closures over parentPort — always constructible). The boolean stays for
    // symmetry with the worktree gate and as a single flip point should a
    // future precondition emerge; today it is unconditionally true.
    const previewAvailable = true;
    if (previewAvailable) {
      registry.register(browserOpenTool);
      registry.register(browserReadTool);
      registry.register(browserScreenshotTool);
    }
    // Plan-exit contract (TASK.27, mirror of cli/main.ts): ONE call registers
    // ExitPlanMode AND produces the planExitMode/onModeChange pair spread into
    // AgentLoopConfig below — the halves are only safe together (plan-exit.ts).
    // Placed STRICTLY before the toolNames snapshot below so the tool name
    // reaches the system prompt. `session` is captured lazily: the loop only
    // calls onModeChange from inside a running turn, long after it is assigned.
    const planExit = wirePlanExit(registry, (changed) => {
      session?.notifyModeChanged(changed);
    });
    // Main selects resume engine from durable metadata, and the host verifies
    // it again before constructing the core graph. A forged/mismatched fork
    // must never silently resume an external session through AgentLoop.
    const persistedEngineId = sessionMeta.engineId ?? "core";
    if (persistedEngineId !== engineBootstrap.id) {
      throw new Error(`Session engine mismatch: persisted ${persistedEngineId}, booted ${engineBootstrap.id}`);
    }
    if (resumedMissing) {
      console.warn(
        `[host] --resume ${sessionMeta.id}: no session found in DB; created a fresh session with that id`,
      );
    }
    // Restore the persisted mode on resume instead of hardcoding "build".
    const mode = sessionMeta.mode;

    // Per-workspace checkpoint-capture service (slice P7.26/R1, design
    // slice-4.7-cut.md §2.9): mirrors cli/main.ts's checkpointService — a shadow
    // GIT_DIR rooted OUTSIDE the workspace, beside the sqlite DB (L6: never a
    // `.git` in the user tree), reusing the SqlitePersistenceAdapter already
    // built above as its CheckpointStore. A ":memory:" DB has no directory, so
    // the root falls back to ~/.anycode. Built only when the exec adapter can
    // spawn a binary (buildCheckpointService's runBinary gate) — else null, and
    // the config-spread below omits `checkpoints`, keeping the loop's checkpoint
    // arc dormant / byte-identical to pre-wiring (the 6.DP-2 R7 gap this closes).
    // Lazy: zero git spawn until the first write-effect turn.
    const checkpointsRoot =
      dbPath === ":memory:"
        ? join(homedir(), ".anycode", "checkpoints")
        : join(dirname(dbPath), "checkpoints");
    const checkpointService = buildCheckpointService({
      exec: execAdapter,
      fs: fsAdapter,
      store: persistence,
      workspace,
      checkpointsRoot,
      sessionId: sessionMeta.id,
    });

    // Taskana 4104 (TASK.110): artifact store for oversized tool results, rooted
    // beside the sqlite DB by the same conditional as checkpointsRoot above —
    // OUTSIDE the workspace, so a spilled Bash log never shows in git status and
    // needs no write permission (ports/artifacts.ts TASK.94 verdict). Written by
    // the dispatcher; swept by main at app start; removed on TASK.114 hard delete.
    const artifactStore = new NodeArtifactStore(artifactsRootFor(dbPath, homedir()));

    historySink = new WriteBehindHistorySink(persistence, sessionMeta.id);
    const tokenizer = await createDefaultTokenizer();
    const bootContextInfo = resolveContextWindowInfo(envConfig.model, catalogEntry, envConfig.contextWindowTokens, envConfig.contextWindowModel);
    const bootContextWindow: number | undefined = bootContextInfo.tokens;
    // Taskana 4150: a detached child is a subagent too; the 100 KB finalText cap
    // makes output beyond ~32k tokens paid-for-and-discarded, so clamp it here.
    const clampChildOutput = (resolved: number | undefined): number | undefined =>
      isChildSessionBoot(args, sessionMeta) ? clampSubagentMaxOutputTokens(resolved) : resolved;
    const bootMaxOutputTokens = clampChildOutput(resolveMaxOutputTokens(
      envConfig.model,
      catalogEntry,
      envConfig.maxOutputTokens,
      (requested, clamped, modelId) =>
        console.warn(`[host] ${modelId} max output tokens clamped: ${requested} > provider catalog ceiling, using ${clamped}`),
      (modelId, applied) =>
        console.warn(`[host] ${modelId} max output tokens: no ceiling declared for this model in the provider catalog, using default ${applied}`),
    ));
    const bootReasoningEffort = resolveReasoningEffort(envConfig.model, catalogEntry, envConfig.reasoningEffort, liveCapsFor(envConfig.model));
    const bootEffortLevels = resolveEffortLevels(envConfig.model, catalogEntry, liveCapsFor(envConfig.model));
    // TASK.162 (F6): the same catalog + env overrides the three boot
    // resolutions above read, packaged once so an Agent-tool `model` override
    // re-resolves the child's ceiling/effort/window for ITS model instead of
    // inheriting the parent's. Every input here is boot-fixed; the one live
    // input — the user-selected reasoning tier — is supplied at spawn time by
    // the wiring closure at the withSubagents call below.
    const settingsForChild = buildChildModelSettingsResolver({
      catalogEntry,
      envMaxOutputTokens: envConfig.maxOutputTokens,
      envContextWindow: envConfig.contextWindowTokens,
      envContextWindowModel: envConfig.contextWindowModel,
      onClamp: (requested, clamped, modelId) =>
        console.warn(`[host] ${modelId} max output tokens clamped: ${requested} > provider catalog ceiling, using ${clamped}`),
      onStubFallback: (modelId, applied) =>
        console.warn(`[host] ${modelId} max output tokens: no ceiling declared for this model in the provider catalog, using default ${applied}`),
      liveCapabilitiesFor: liveCapsFor,
    });
    const history = new ConversationHistory({ initial: initialHistory, sink: historySink, tokenizer });


    // dangling assistant tool_call with a synthesized cancelled tool_result and
    // persist it BEFORE the first turn, else the strict endpoint 400s (§2.10).
    const repaired = await repairDanglingToolCalls(history, historySink);
    if (repaired > 0) {
      console.log(`[host] repaired ${repaired} dangling tool_call(s) from a prior crash`);
    }
    // Boot snapshot for transcript hydration (§3.3), captured AFTER repair so the
    // hydrated transcript reflects the synthesized cancelled results.
    const bootHistory = [...history.items];

    const hooks = new InMemoryHookRunner();
    hooks.register(createSnapshotHook(fsAdapter, emit));
    let hookDeclarations: CommandHookDeclaration[] = [];
    let hookConfigError: string | undefined;
    try {
      const declarations = await loadHookConfigs(fsAdapter, workspace, homedir(), {
        projectTrusted: hostWorkspaceTrust.projectTrusted,
        onSkip: (message) => console.warn(`[host] ${message}`),
      });
      hookDeclarations = declarations;
      for (const declaration of declarations) {
        hooks.register(createCommandHook(execAdapter, declaration, workspace));
      }
    } catch (error) {
      // Fail-soft (design §2.11): a malformed .anycode/config.json must not
      // crash the host — the session just runs with no command hooks.
      hookConfigError = describeError(error);
      console.error(`[host] failed to load hook config; no command hooks registered: ${hookConfigError}`);
    }

    // Background-task wiring (slice 6.DP-2, mirror of cli/main.ts:442-456): the
    // manager wraps the SAME execAdapter with zero new spawn path (a task is a

    // Bash OVERWRITES the default under the same name and the SAME metadata

    // silentDuplicateWarning is REQUIRED or the registry boot-warns. Registered
    // BEFORE the toolNames snapshot below, so BashOutput/BashKill reach the
    // system prompt's tool-discipline section exactly as they do in the CLI.
    taskManager = new InProcessTaskManager(execAdapter);
    registry.register(backgroundCapableBashTool, { silentDuplicateWarning: true });
    registry.register(bashOutputTool);
    registry.register(bashKillTool);

    let lspServerSpecs: LspServerSpec[] = [];
    let lspIssues: string[] = [];
    try {
      const loaded = await loadLspServerSpecs(fsAdapter, workspace, homedir(), {
        projectTrusted: hostWorkspaceTrust.projectTrusted,
      });
      lspServerSpecs = loaded.specs;
      lspIssues = loaded.issues;
    } catch (error) {
      console.error(`[host] failed to load lsp config; continuing with zero language servers: ${describeError(error)}`);
    }
    for (const issue of lspIssues) {
      console.warn(`[host] lsp config: ${issue}`);
    }
    // Slice P7.25/F3: single per-boot session, so one listener slot fans the
    // manager's coalesced status-change notify to the Session's live-push seam
    // (registered on ui_ready, cleared on dispose). The manager's callback reads
    // this slot indirectly so registration order (manager built here, before the
    // Session below) is decoupled from the subscription.
    let lspStatusListener: (() => void) | null = null;
    lspManager =
      lspServerSpecs.length > 0
        ? new LspManager(execAdapter, lspServerSpecs, workspace, () => lspStatusListener?.())
        : null;
    if (lspManager) {
      registry.register(diagnosticsEditTool, { silentDuplicateWarning: true });
      registry.register(diagnosticsWriteTool, { silentDuplicateWarning: true });
    }

    // WebSearch wiring (slice 6.3, mirror of cli/main.ts): config+key-gated
    // registration BEFORE the toolNames snapshot below; with no resolvable

    // no module-scope handle, no shutdown stage.
    let webSearchBackend: ResolvedWebSearchBackend | null = null;
    try {
      const loadedWebSearch = await loadWebSearchConfig(fsAdapter, workspace, homedir(), process.env, {
        // Taskana 4736 xfix D2: same trust gate as the section's siblings.
        projectTrusted: hostWorkspaceTrust.projectTrusted,
      });
      webSearchBackend = loadedWebSearch.backend;
      for (const issue of loadedWebSearch.issues) console.warn(`[host] websearch config: ${issue}`);
    } catch (error) {
      console.error(`[host] failed to load websearch config; continuing without WebSearch: ${describeError(error)}`);
    }
    let webSearchTool: ReturnType<typeof createWebSearchTool> | undefined;
    if (webSearchBackend !== null) {
      webSearchTool = createWebSearchTool(webSearchBackend);
      registry.register(webSearchTool);
    }

    // Telemetry config (slice 6.6, mirror of the websearch block above): opt-in,
    // fail-soft — an unset/disabled section or a loader failure leaves
    // telemetryConfig null, so the sink below is never built and the default

    let telemetryConfig: ResolvedTelemetryConfig | null = null;
    try {
      const loadedTelemetry = await loadTelemetryConfig(fsAdapter, workspace, homedir(), process.env, {
        // Taskana 4736 xfix D2: same trust gate as the section's siblings.
        projectTrusted: hostWorkspaceTrust.projectTrusted,
      });
      telemetryConfig = loadedTelemetry.telemetry;
      for (const issue of loadedTelemetry.issues) console.warn(`[host] telemetry config: ${issue}`);
    } catch (error) {
      console.error(`[host] failed to load telemetry config; continuing without telemetry: ${describeError(error)}`);
    }
    let repoMapConfig: RepoMapConfig | null = null;
    try {
      const loadedRepoMap = await loadRepoMapConfig(fsAdapter, workspace, homedir(), process.env, {
        // Taskana 4736 xfix D2: same trust gate as the section's siblings.
        projectTrusted: hostWorkspaceTrust.projectTrusted,
      });
      repoMapConfig = loadedRepoMap.repoMap;
      for (const issue of loadedRepoMap.issues) console.warn(`[host] repo-map config: ${issue}`);
    } catch (error) {
      console.error(`[host] failed to load repo-map config; continuing without repo-map: ${describeError(error)}`);
    }

    // Explicit MCP config is read FIRST (design slice-3.3-cut.md §6): its
    // resolved server names become the claimed-set extensions discovery
    // (below) must respect, so an explicitly configured server name always
    // wins over a plugin declaring the same name. Fail-soft (mirrors the
    // hook-config block above): a loader failure here must not abort boot —
    // the host just proceeds with zero explicit MCP servers.
    let mcpSpecs: McpServerSpec[] = [];
    let mcpProblems: string[] = [];
    try {
      const loaded = await loadMcpServerSpecs(fsAdapter, workspace, homedir(), {
        projectTrusted: hostWorkspaceTrust.projectTrusted,
        secrets: mcpSecrets,
      });
      mcpSpecs = loaded.specs;
      mcpProblems = loaded.problems;
    } catch (error) {
      console.error(`[host] failed to load MCP config; continuing with zero explicit MCP servers: ${describeError(error)}`);
    }

    // Extensions bootstrap (design slice-3.3-cut.md §3.7/§6): skills
    // discovery, agent profiles, and plugins-lite, aggregated by the SAME
    // discoverExtensions the CLI wiring calls, so the two paths never drift.
    // Fail-soft (mirrors the blocks above): a thrown discovery leaves the host
    // with an empty bootstrap — byte-identical to today's boot with no
    // extensions — rather than aborting. discoverExtensions itself never
    // throws by contract; this try/catch is defense-in-depth kept symmetric
    // with its neighbors.
    let ext: ExtensionsBootstrap = {
      skills: createSkillPort(fsAdapter, []),
      skillsPromptSection: "",
      profiles: [],
      profilesPromptSection: "",
      rescanProfiles: async () => null,
      pluginMcpServerSpecs: [],
      workflows: [],
      workflowsPromptSection: "",
      memorySection: "",
      repoMapFiles: [],
      problems: [],
    };
    // Builtin skills: every capability-gated set plus the unconditional ones,
    // composed by buildHostBuiltinSkills (host/builtin-skills.ts) into ONE
    // array — discoverExtensions takes a single `builtinSkills` key, so two
    // conditional spreads of that same key would silently overwrite each other.
    // Taskana 4707: the anycode-setup skill's docs location is resolved from
    // the app's own location (packaged resources, dev checkout, or the tagged
    // GitHub URL), never from the workspace.
    const builtinSkills: readonly BuiltinSkillDefinition[] = buildHostBuiltinSkills({
      worktreeAvailable,
      previewAvailable,
      anycodeSetupDocs: anycodeSetupDocsForHost(),
    });
    try {
      ext = await discoverExtensions(fsAdapter, {
        workspace,
        home: resolveExtensionsHomeOverride(process.env) ?? homedir(),
        claimedMcpNames: new Set(mcpSpecs.map((spec) => spec.name)),
        repoMapConfig,
        projectTrusted: hostWorkspaceTrust.projectTrusted,
        secrets: mcpSecrets,
        ...(builtinSkills.length > 0 ? { builtinSkills } : {}),
        // Taskana 4732 S1-B (design §7 host wiring): app version (the
        // ANYCODE_APP_VERSION carrier main stamps from app.getVersion()) +
        // the MCP consent list from settings `plugins.mcpConsent`. Both
        // conditional so a bare boot (no env var, no settings block) keeps
        // discovery byte-identical. 4736 interplay: projectTrusted above
        // already gates project-tier plugin MCP; mcpConsent governs the
        // user-tier (official/third-party/local/legacy) plugins only.
        ...(hostAppVersion !== undefined ? { appVersion: hostAppVersion } : {}),
        ...(pluginsSettings?.mcpConsent !== undefined ? { mcpConsent: pluginsSettings.mcpConsent } : {}),
      });
    } catch (error) {
      console.error(`[host] extensions discovery failed; continuing with zero skills/agent profiles/plugins: ${describeError(error)}`);
    }
    mdClaimedProfileNames = new Set(ext.profiles.map((p) => p.name));
    for (const problem of ext.problems) {
      console.warn(`[host] extensions: ${problem}`);
    }

    // Environment settings pane. null when repo-map is disabled (repoMapConfig
    // === null); otherwise (re-)computed as a side effect of renderRepoMap()
    // below every time the system prompt is composed — so a mid-session model
    // switch (P7.15) re-clamps the cap under the new window and the panel follows.
    let repoMapStatus: WireRepoMapStatus | null = null;

    // MCP client wiring (design slice-3.2-cut.md §4.4/§6, task 3.2.4; combined
    // with plugin-declared servers as of slice-3.3-cut.md §6): same fail-soft
    // posture as the hook-config block above — a connect failure must never
    // abort boot, so the whole block is wrapped and the app simply boots with
    // zero MCP servers on any error. `registry` is the SAME object handed to
    // AgentLoopConfig below, so a successfully bridged tool is live before the
    // first turn. onStatusChange re-emits the FULL snapshot on every
    // transition (buffered `emit`, so a reconnect's replay() carries the
    // latest one); the port-handoff branch further down additionally sends the
    // current snapshot the instant a UI port binds (mirrors the host_ready
    // cascade for a renderer that attaches after boot already finished). The
    // single start() call below combines explicit + plugin specs (3.2's
    // start-once ruling stays intact — never two start() calls).
    try {
      mcpManager = new McpManager({
        registry,
        transports: new NodeMcpTransportFactory(),
        onStatusChange: (statuses) => {
          emit({ type: "mcp_status", servers: statuses });
        },
      });
      await mcpManager.start([...mcpSpecs, ...ext.pluginMcpServerSpecs]);
      for (const problem of mcpProblems) {
        console.warn(`[host] mcp config: ${problem}`);
      }
    } catch (error) {
      console.error(`[host] failed to start MCP servers; continuing with zero MCP servers: ${describeError(error)}`);
      mcpManager = null;
    }
    // Taskana 4752 part B: the connected servers' `instructions`, computed ONCE
    // here (after start, before the first compose) so every turn sees the same
    // text; a resumed session recomputes at its own boot. Empty => "" (the
    // prompt stays byte-identical). A failed/unloaded server never contributes.
    const mcpInstructionsSection = mcpManager ? buildMcpInstructionsSection(mcpManager.instructions()) : "";

    // TASK.198 срез C (finding #6): the boot-time `toolNames` snapshot this
    // comment used to describe is GONE — `composeSystemPrompt` below now
    // reads `registry.list()` LIVE on every composition instead, so a tool
    // registered/unregistered after boot (InspectImage's own gate flipping
    // mid-session, plan §5/§9) reaches the system prompt the very next time
    // it is recomposed, with no rebuild of this closure required. The MCP
    // block above still runs first for the SAME reason it always did:
    // mcp__*-bridged tools must already be in the registry before the FIRST
    // composition (the boot `config.systemPrompt` build a few lines down).

    // Session-static env facts (design §2.1/§6), computed ONCE per tab boot so
    // the system prompt's <env> section — and every subagent's, via
    // withSubagents({ env }) below — stays static for the whole session.
    // workspace is this tab's cwd; model comes from the same provider config
    // (envConfig.model) already threaded through modelPort/persistence above.
    const systemPromptEnv: SystemPromptEnv = {
      workingDirectory: workspace,
      platform: process.platform,
      osVersion: release(),
      date: new Date().toISOString().slice(0, 10),
      // Live model id (mutated by the P7.15 switchModel callback, sanctioned

      // this is byte-identical to pre-P7.15.
      modelId: currentModel,
      isGitRepo: await fsAdapter.exists(`${workspace}/.git`),
    };

    // Live context window (slice 6.4 + P7.15): mirror of the CLI's
    // `liveContextWindow` (main.ts:424). The switchModel callback re-points it to
    // the new model's window; the repo-map cap re-clamps against it. Boot value
    // === bootContextWindow ?? DEFAULT, byte-identical to the pre-P7.15 inline
    // repo-map budget above.
    let liveContextWindow = bootContextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    // Taskana 4127: true while the live window is the assumed unknown-model
    // fallback (no catalog entry, no explicit override) — surfaced to the UI.
    let liveContextWindowAssumed = bootContextInfo.source === "assumed";

    // Repo-map render closure (design slice-P7.15-cut.md §2.1, mirror of
    // cli/main.ts:915-931): re-renders the repo-map section under the CURRENT
    // window's clamped cap and refreshes `repoMapStatus` as a side effect. When
    // repo-map is disabled (repoMapConfig === null) it clears the status and
    // returns "" — byte-identical to the pre-P7.15 boot when the model never
    // switches. A render failure is fail-soft (warn + honest zero-included status).
    const renderRepoMap = (): string => {
      if (repoMapConfig === null) {
        repoMapStatus = null;
        return "";
      }
      const effectiveMaxTokens =
        repoMapConfig.maxTokens ??
        Math.max(
          REPO_MAP_MIN_TOKENS,
          Math.min(REPO_MAP_MAX_TOKENS, Math.floor(REPO_MAP_WINDOW_FRACTION * liveContextWindow)),
        );
      repoMapStatus = {
        fileCount: ext.repoMapFiles.length,
        includedCount: 0,
        truncated: false,
        maxTokens: effectiveMaxTokens,
      };
      try {
        const built = buildRepoMapPromptSection(ext.repoMapFiles, {
          maxTokens: effectiveMaxTokens,
          tokenizer,
          workspace,
        });
        repoMapStatus = {
          fileCount: ext.repoMapFiles.length,
          includedCount: ext.repoMapFiles.length - built.omittedCount,
          truncated: built.truncated,
          maxTokens: effectiveMaxTokens,
        };
        return built.section;
      } catch (error) {
        console.warn(`[host] repo-map render failed: ${describeError(error)}`);
        return "";
      }
    };

    // System-prompt closure (design slice-P7.15-cut.md §2.1, mirror of
    // cli/main.ts:932): the boot systemPrompt expression, BYTE-identical, hoisted
    // so the switchModel callback can rebuild it after mutating
    // systemPromptEnv.modelId. The loop reads config.systemPrompt per-call, so
    // the rebuilt prompt takes effect on the next turn. Called once below for the
    // boot value.
    // Accounting-only section boundaries for contextBreakdown() (design
    // slice-P7.17-cut.md §2.1 / W2): the SAME ext.* strings + renderRepoMap()
    // result that concatenate into the system prompt, tagged by kind. NEVER used
    // to build the prompt itself — composeSystemPrompt() below derives the
    // byte-identical string from these, so components and prompt cannot drift.
    // renderRepoMap()'s repoMapStatus side effect fires HERE (once per compose),
    // before Session's envStatus seam reads it.
    const composeSystemPromptComponents = (): NonNullable<AgentLoopConfig["systemPromptComponents"]> => [
      { kind: "memory", text: ext.memorySection },
      { kind: "skills", text: ext.skillsPromptSection },
      { kind: "workflows", text: ext.workflowsPromptSection },
      { kind: "profiles", text: ext.profilesPromptSection },
      { kind: "mcp", text: mcpInstructionsSection },
      { kind: "repoMap", text: renderRepoMap() },
    ];

    // System-prompt closure (design slice-P7.15-cut.md §2.1, mirror of
    // cli/main.ts:932): the base identity/tool/env prompt followed by the section
    // components in their fixed prompt order (memory -> skills -> workflows ->
    // profiles -> repoMap). BYTE-identical to the pre-P7.17 inline `base + memory
    // + skills + workflows + profiles + renderRepoMap()` expression (same strings,
    // same order); the components now carry the repoMap render, so this no longer
    // calls renderRepoMap() itself (single render per compose). The loop reads
    // config.systemPrompt per-call, so the rebuilt prompt takes effect next turn.
    // TASK.198 срез C (finding #6): `toolNames` is read LIVE off the registry
    // on every composition (never a frozen boot snapshot), so a tool
    // registered/unregistered after boot — InspectImage's own gate, plan
    // §5/§9 — reaches the model the very next time this is called, without
    // rebuilding this closure. `visionFallbackEnabled` mirrors that same
    // live read: true exactly while InspectImage is CURRENTLY registered.
    const composeSystemPrompt = (
      components: NonNullable<AgentLoopConfig["systemPromptComponents"]>,
    ): string =>
      buildSystemPrompt({
        toolNames: registry.list(),
        env: systemPromptEnv,
        visionFallbackEnabled: registry.has("InspectImage"),
      }) + components.map((c) => c.text).join("");

    // GitBridge wiring (slice 5.7, design slice-5.7-cut.md §2.3-C3): construction
    // is unconditional (zero I/O in the constructor), mirroring the CLI's
    // dormant boot gate (cli/main.ts). `gitEnabled` reuses the already-computed
    // `systemPromptEnv.isGitRepo` (NO second fs.exists) plus a runBinary check —
    // byte-for-byte the CLI's `isGitRepo === true && typeof runBinary === fn`
    // gate. A non-git workspace (or an exec adapter without runBinary) hands the

    // adapter carries `gitAbort.signal` so a shutdown reaps any in-flight git

    const gitService = new NodeGitAdapter({ exec: execAdapter, cwd: workspace, signal: gitAbort.signal });
    const gitEnabled = systemPromptEnv.isGitRepo === true && typeof execAdapter.runBinary === "function";
    gitBridge = new GitBridge({ git: gitEnabled ? gitService : null, outbound });

    const media: MediaCapabilityPort = {
      // Reads currentModel so a P7.15 model switch re-gates image input on the
      // next send; currentModel === envConfig.model at boot (byte-identical).
      // Taskana 4088: imageModalityLookup adds the live /v1/models modality
      // rung between the env override and the catalog (additive-only, parsed
      // once at boot above); the verdict still re-resolves per call through
      // currentModel, so a switch re-gates honestly.
      // The global ANYCODE_IMAGE_INPUT (shell) wins; otherwise the per-model
      // override applies only while currentModel is the model it is bound to.
      imageInputEnabled: () =>
        resolveImageInput(
          currentModel,
          catalogEntry,
          envConfig.imageInput ?? (imageModelOverride?.model === currentModel ? imageModelOverride.override : undefined),
          imageModalityLookup,
        ),
      // TASK.198 срез C: live verdict for the vision fallback — true whenever
      // a recognizer endpoint is CURRENTLY configured, independent of the
      // current model's own sightedness. Consulted by host/session.ts's
      // turn-accept gate (ORed with imageInputEnabled) and by the InspectImage
      // registration gate below (ANDed with !imageInputEnabled()).
      recognizerConfigured: () => recognizerConfigured,
    };

    // TASK.198 срез C (plan §5): the InspectImage tool instance is built
    // EXACTLY ONCE for the life of this host process — never rebuilt on a
    // registration toggle or a live recognizer-config push. Its per-image
    // question counter and Q/A transcript live in the factory's own closure
    // (tools/inspect-image.ts, срез B2) — plan §5's "resume weakened to
    // process lifetime" semantics: recreating the tool would silently reset
    // a mid-session question budget and lose the "what's to the right of
    // that button?" thread every time the gate flips (blind<->sighted, or a
    // recognizer toggled off and back on). `liveRecognizerEndpoint` is
    // captured ONCE by the factory (tools/inspect-image.ts destructures
    // `endpoint` out of its options immediately); a later live-push commit
    // mutates ITS FIELDS in place (never replaces the reference) precisely
    // so this already-built instance keeps seeing the current config.
    const visionAskCache = new AskCache();
    let inspectImageTool: ReturnType<typeof createInspectImageTool> | undefined;
    function ensureInspectImageTool(): ReturnType<typeof createInspectImageTool> {
      if (inspectImageTool === undefined) {
        inspectImageTool = createInspectImageTool({
          recognizer: { endpoint: liveRecognizerEndpoint, cache: visionAskCache, portFactory: recognizerPortFactory },
        });
      }
      return inspectImageTool;
    }

    /**
     * (De)registers InspectImage against the CURRENT (recognizer configured
     * ∧ blind model) verdict — the exact gate TASK.198.md §1 step 5 and plan
     * §5 specify — and reports whether registration actually flipped, so a
     * caller knows whether the system prompt needs recomposing (finding #6:
     * no recompose when nothing changed). Idempotent both ways
     * (ToolRegistry.register/unregister already are).
     */
    function recomputeInspectImageRegistration(): boolean {
      const shouldRegister = recognizerConfigured && media.imageInputEnabled() === false;
      const isRegistered = registry.has("InspectImage");
      if (shouldRegister === isRegistered) {
        return false;
      }
      if (shouldRegister) {
        registry.register(ensureInspectImageTool());
      } else {
        registry.unregister("InspectImage");
      }
      return true;
    }

    // TASK.102 CUT-S2 §0.8/§2.6.3: a child-mode boot's broker wraps `emit`
    // with the permission-tap — an `attention` signal bracketing every
    // permission ask, relayed to main as `ChildProgress{kind:"attention"}` so
    // the parent's subagent card can show "waiting for permission" without
    // Open'ing the child surface. Non-child boots keep the bare `emit`,
    // byte-identical to every pre-S2 host. CUT-S4 §4.1: `buildChildBrokerEmit`
    // is the exact same body, extracted so codex/claude share it too.
    const broker = new IpcPermissionBroker(args.child !== undefined ? buildChildBrokerEmit(emit) : emit);

    // Boot context-window resolution (slice 6.4, mirror of cli/main.ts):
    // env ANYCODE_CONTEXT_WINDOW > catalog window of the session model > absent
    // (default budget). Boot-only: the desktop has no mid-session model switch
    // today — when it gains one, mirror the CLI's loop.setContextWindow re-budget
    // (slice-6.4-cut.md R3).
    // Telemetry sink (slice 6.6, mirror of cli/main.ts): opt-in — a resolved
    // config builds the per-session JSONL sink and the eventTap closure; null
    // keeps config.eventTap absent below, so the default boot stays
    // byte-identical to pre-6.6. appVersion is omitted in the host v1 (R4): the
    // desktop app version lives in the app package, not the core bundle.
    if (telemetryConfig !== null) {
      const port = new JsonlTelemetrySink({ dir: telemetryConfig.dir, fileName: `${sessionMeta.id}.jsonl` });
      port.record({
        v: 1, ts: Date.now(), session: sessionMeta.id, t: "session_start",
        model: envConfig.model, provider: catalogEntry?.name ?? "custom", mode,
        // TASK.159 §2.1: session-tier child back-reference (TASK.102/145),
        // the same field the codex/claude boots stamp at their own
        // session_start above — the core path just never had it wired.
        ...(args.child !== undefined ? { parentSession: args.child.parentSessionId } : {}),
      });
      telemetry = { port, session: sessionMeta.id };
    }
    // TASK.160 §2.2: const capture of `telemetry` right after its only
    // reassignment in this boot, so the subagentEventTap closure below
    // (built inside the AgentLoopConfig literal, read later by a child spawn)
    // sees a fixed value instead of chasing the module-level `let`.
    const subagentTelemetry = telemetry;

    // TASK.198 срез C (plan §8): wraps the plain port ask() would otherwise
    // build itself (`new AiSdkModelPort(endpoint)`) with a usage-telemetry
    // tap — see VisionTelemetryModelPort's own doc. Reuses `subagentTelemetry`
    // (the const capture right above, not the mutable `telemetry` let) for
    // the SAME reason the subagentEventTap factory a few lines down does.
    const recognizerPortFactory = (endpoint: RecognizerEndpoint): ModelPort => {
      const port = new AiSdkModelPort(endpoint, hostDiagnosticSink);
      if (subagentTelemetry === null) {
        return port;
      }
      return new VisionTelemetryModelPort(port, (usage) => {
        subagentTelemetry.port.record({
          v: 1,
          ts: Date.now(),
          session: subagentTelemetry.session,
          sub: { agentType: "vision", model: endpoint.model },
          t: "usage",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        });
      });
    };
    // TASK.198 срез C (plan §5 "условная регистрация до композиции"): the
    // boot-time registration decision, made BEFORE the first
    // composeSystemPrompt() call below so the very first system prompt
    // already reflects it (no post-boot recompose needed for the common
    // case of a blind model booting with a recognizer already configured).
    recomputeInspectImageRegistration();

    // Boot section components computed once (design P7.17/W2): renderRepoMap()'s
    // repoMapStatus side effect fires here, before Session's envStatus seam reads
    // it; the prompt is derived from these so they cannot drift.
    const bootSystemPromptComponents = composeSystemPromptComponents();
    const config: AgentLoopConfig = {
      modelPort,
      registry,
      hooks,
      // Slice 2.2.3 (design §5): rules seeded from settings.json at boot, plus
      // whatever Session.maybeRemember appends in-session; an empty `rules`
      // store is behaviorally identical to the bare ModePermissionEngine
      // (packages/core/src/permissions/rules.test.ts's own regression invariant).
      // TASK.138 slice 2: RunAllowBashPermissionEngine sits OUTSIDE the
      // untouched SafeCommand(Mode) pair — an empty runAllowBashEntries (the
      // env-unset default) makes it a byte-identical no-op wrapper, so this
      // composition degrades to exactly the pre-slice-2 chain.
      permissionEngine: new RuleAwarePermissionEngine(
        new RunAllowBashPermissionEngine(
          new SafeCommandPermissionEngine(new ModePermissionEngine()),
          runAllowBashEntries,
        ),
        rules,
      ),
      permissionBroker: broker,
      // Taskana 4702 Stage 1 / 4730: optional; absent = byte-identical to pre-4702.
      ...(effectiveAskClassifierBoot !== undefined ? { askClassifier: effectiveAskClassifierBoot } : {}),
      mode,
      // TASK.124 remainder (owner rule 2026-08-22): "присмотр есть ⇒ корневая
      // сессия вообще без потолка" — a supervised interactive ROOT has no turn
      // ceiling at all; a child session (session-tier subagent) ALWAYS keeps
      // the ladder regardless. `isChildSessionBoot` — lock #2's own
      // discriminator, the OR of the argv authority (`args.child`) and the
      // durable authority (`sessionMeta.parentSessionId`) — is used here
      // rather than the narrower `args.child` alone (lock #1, above): it is
      // the MORE INCLUSIVE "is this a child" test, so it can never mistake a
      // genuine child for a root and hand it the no-ceiling predicate — the
      // one mistake this wiring must never make (a false "root" verdict only
      // ever costs a root session its exemption, never the reverse).
      // `broker.isUnattended` is the TASK.138 latch, read LIVE on every call
      // (never snapshotted): a run that starts supervised and goes quiet
      // mid-session falls under the ladder from that point on.
      ...(!isChildSessionBoot(args, sessionMeta)
        ? {
            ceiling: buildCeilingConfig({
              adaptive: adaptiveTurnBudget,
              supervisedRoot: () => broker.isUnattended !== true,
            }),
          }
        : adaptiveTurnBudget
          ? { ceiling: buildCeilingConfig({ adaptive: true }) }
          : {}),
      ports: {
        fs: fsAdapter,
        exec: execAdapter,
        http: new NodeHttpAdapter(),
        todos: new InMemoryTodoStore(),
      },
      media,
      // TASK.198 срез C (plan §1/§2/§3): wired UNCONDITIONALLY — `reserveRef`
      // is called for EVERY image this loop appends regardless of `endpoint`'s
      // presence (AgentLoopRecognizerConfig's own doc, срез B1), so a live
      // recognizer/model switch mid-session never encounters an un-numbered
      // image from earlier in this SAME session. `endpoint` tracks the live
      // `recognizerConfigured` flag; `cache`/`portFactory` are shared with
      // InspectImage's own factory above (ONE process-lifetime cache, plan §7).
      recognizer: {
        reserveRef: () => persistence!.reserveImageRef(sessionMeta.id),
        endpoint: recognizerConfigured ? liveRecognizerEndpoint : undefined,
        cache: visionAskCache,
        portFactory: recognizerPortFactory,
      },
      ...(worktreeAvailable ? { worktrees: worktreeControl } : {}),
      ...(previewAvailable ? { preview: previewPort } : {}),
      cwd: workspace,
      maxTurns: resolveChildMaxTurns(args.child, envConfig.maxTurns),
      subagentMaxTurns: envConfig.subagentMaxTurns,
      // TASK.4721: learned base-budget port (adaptive only; see above).
      ...(subagentBudget !== undefined ? { subagentBudget } : {}),
      // TASK.148 slice 1: subagent stall-detector override, ANYCODE_SUBAGENT_STALL_MS
      // / settings tools.subagentStallTimeoutMs (main/host-env.ts fills the env var
      // from the setting; envConfig re-reads it here exactly like subagentMaxTurns).
      subagentStallTimeoutMs: envConfig.subagentStallTimeoutMs,
      ...(envConfig.todoReminderEvery !== undefined
        ? { todoReminder: { everyToolCalls: envConfig.todoReminderEvery } }
        : {}),
      maxOutputTokens: bootMaxOutputTokens,
      reasoningEffort: bootReasoningEffort,
      // Base prompt (identity/conventions/safety/tool-discipline/env, design
      // §2.1) enriched with the boot toolNames snapshot + session env, then
      // memory + skills + workflows + agent profiles concatenated (design
      // slice-3.6-cut.md §6, slice-3.3-cut.md §6, slice-3.4-cut.md §6,
      // slice-3.7-cut.md §2.6): all four sections are "" when there is nothing
      // discovered, so systemPrompt degrades to the enriched base with no
      // empty gaps. The opt-in repo map is appended after profiles as the
      // volatile final tail, preserving the stable memory -> skills ->
      // workflows -> profiles prompt-cache prefix (mirrors cli/main.ts).
      // prompts/identity.ts is NOT touched.
      // Hoisted into composeSystemPrompt() (design slice-P7.15-cut.md §2.1) so the
      // switchModel callback can rebuild it after a model switch; byte-identical
      // to the pre-P7.15 inline expression at the boot modelId. This call also
      // (re-)computes repoMapStatus as a side effect (renderRepoMap), before
      // Session's envStatus seam reads it below.
      systemPrompt: composeSystemPrompt(bootSystemPromptComponents),
      // Slice P7.17 (F12) accounting metadata for contextBreakdown(); NEVER used
      // to build the prompt (systemPrompt above is the single string sent).
      systemPromptComponents: bootSystemPromptComponents,
      skills: ext.skills,
      history,
      tokenizer,
      ...(taskManager !== null ? { tasks: taskManager } : {}),
      ...(lspManager !== null ? { lsp: lspManager } : {}),
      // Per-turn checkpoint arc (slice P7.26/R1): present ONLY when the gate
      // above built a service; its absence keeps the turn byte-identical (L2 —
      // runTurn never touches the arc). Mirror of cli/main.ts:1101.
      ...(checkpointService !== null ? { checkpoints: checkpointService } : {}),
      // Taskana 4104 (TASK.110): spill oversized tool results to the artifact
      // store (mirror of cli/main.ts:1292) — `sessionMeta.id`, not the later
      // `sessionId` const. Absent = truncation, the pre-TASK.94 behaviour.
      artifacts: { store: artifactStore, sessionId: sessionMeta.id },
      // TASK.27: planExitMode ("build") + onModeChange, produced together with
      // the ExitPlanMode registration above. Without this spread the tool's
      // handler fails closed and plan mode has no model-driven exit at all.
      ...planExit,
      ...(telemetry !== null ? { eventTap: buildTelemetryTap(telemetry.port, telemetry.session) } : {}),
      // TASK.160 §2.2: factory for an inline subagent's child eventTap (core
      // path ONLY — this is the AgentLoop boot, not a codex/claude engine
      // boot). `subagentTelemetry` is captured into a local const because TS
      // does not carry a `let`-narrowing (module-level `telemetry`) across a
      // closure boundary. The loop never calls this itself; only
      // subagents/runner.ts's buildChildConfig reads it, once per spawn.
      ...(subagentTelemetry !== null
        ? {
            subagentEventTap: (spawn: { agentType: string; model?: string }) =>
              buildSubagentTelemetryTap(subagentTelemetry.port, subagentTelemetry.session, spawn),
          }
        : {}),
      // Context window (design §2.5 + slice 6.4): resolved above — mirrors cli/main.ts.
      ...(bootContextWindow !== undefined
        ? { context: { contextWindowTokens: bootContextWindow } }
        : {}),
    };

    /**
     * TASK.198 срез C (plan §1.3): the host-owned HOW of a recognizer-config
     * commit — Session's own `applyRecognizerConfig` decides WHEN (now, if
     * idle; deferred to the next busy->idle boundary otherwise) and calls
     * this. Swaps the live endpoint (mutating `liveRecognizerEndpoint`'s
     * FIELDS in place, never reassigning the reference — see its own doc),
     * updates `config.recognizer.endpoint` to match, then (de)registers
     * InspectImage and recomposes the system prompt ONLY when that
     * registration actually changed (finding #6 — no wasted recompose when
     * the model was already sighted, or already blind-without-fallback,
     * before and after this push).
     */
    function applyRecognizerEndpoint(next: RecognizerEndpoint | null): void {
      if (next === null) {
        recognizerConfigured = false;
      } else {
        liveRecognizerEndpoint.transport = next.transport;
        liveRecognizerEndpoint.baseUrl = next.baseUrl;
        liveRecognizerEndpoint.model = next.model;
        liveRecognizerEndpoint.apiKey = next.apiKey;
        liveRecognizerEndpoint.providerName = next.providerName;
        recognizerConfigured = true;
      }
      config.recognizer!.endpoint = recognizerConfigured ? liveRecognizerEndpoint : undefined;
      if (recomputeInspectImageRegistration()) {
        const components = composeSystemPromptComponents();
        config.systemPrompt = composeSystemPrompt(components);
        config.systemPromptComponents = components;
      }
    }

    // TASK.102 CUT-S2 §2.6.1 (slice S2b B5): non-recursion lock #2. Mutates
    // `config` in place AFTER the object literal above (mirrors
    // `withSubagents`'s own mutate-in-place pattern just below) so
    // `getPermissionMode`'s closure can read `config.mode` — the SAME field
    // `CoreEngine.setMode` (engines/core-engine.ts) and the loop's own
    // plan-exit transition (`agent-loop.ts`, ExitPlanMode's `onModeChange`)
    // both mutate in place — LIVE, at the moment each `run()` call actually
    // fires, rather than a boot-time snapshot of the `mode` const above (cut
    // §0.8: "a snapshot of the parent's mode at the moment Agent was
    // invoked"). CUT-S2 §10.9.2 arbitration: lock #1 above (the registry
    // ternary) and this gate used to read the SAME single fact
    // (`args.child`) twice, which is one authority checked twice, not two —
    // that overclaim is fixed here. This gate now reads
    // `isChildSessionBoot(args, sessionMeta)`, a genuine second, independent
    // authority: argv (`args.child`, lock #1's own fact) OR the durable
    // `sessionMeta.parentSessionId` (main's own `tabs.ts` ledger, replayed
    // back through `resolveBootSession`) — OR-semantics, fail-closed, either
    // signal alone withholds the capability. `config.sessionSubagents` stays
    // absent whenever either fires, so `tools/agent.ts`'s `runSessionTier`
    // fail-closes with its own "unavailable in this host" error even when
    // lock #1's restricted schema (above) is bypassed by an argv/meta
    // mismatch. The THIRD, independent defense lives in a different process
    // entirely: `main/tabs.ts`'s own `childOf` ledger + sender check
    // (`spawnChild`) — that one does not read anything boot built here.
    // TASK.145 срез 3 §2: kept as its OWN reference (not narrowed to the
    // frozen `SessionSubagentPort` core interface `config.sessionSubagents`
    // holds below) so the richer `ChildSessionPort` surface —
    // list/cancel/cancelAll/onChange for the desktop's own detached-children
    // registry — reaches `new Session({...})`'s `backgroundChildren` seam
    // further down. `undefined` for a child-session boot or a claude/codex
    // master, exactly mirroring `config.sessionSubagents`'s own absence.
    let childSessionPortHandle: ChildSessionPort | undefined;
    // A1/R1 (Taskana 4704 review): the child port (below) exists BEFORE the
    // Session, so the child spawn mode is read through the shared cell
    // (spawn-mode-cell.ts): config-derived until the Session exists, then the
    // Session's own childSpawnMode(). The SAME factory is what the test harness
    // builds, so the behavioural tests pin this wiring.
    const spawnModeCell = createSpawnModeCell(config, () => session);
    if (!isChildSessionBoot(args, sessionMeta)) {
      childSessionPortHandle = createChildSessionPort({
        parentSessionId: sessionMeta.id,
        // A1: children inherit the mode the ORCHESTRATOR had BEFORE
        // orchestrate was enabled — never `plan` (an orchestrate parent sits
        // in plan, but its executor children MUST be able to write) and never
        // `yolo` unless the user was already in yolo. Non-orchestrate
        // sessions return the live mode (byte-identical pre-4704 behavior —
        // the child inherits the parent's mode at the moment Agent was
        // invoked, cut §0.8).
        getPermissionMode: () => spawnModeCell.read(),
        send: sendChildSessionMessage,
        subscribe: subscribeChildRunEvents,
        // TASK.145 срез 1: the detach-delivery seam. Fires strictly AFTER
        // the spawning Agent tool call already returned at admit — see
        // deliverDetachedChildReport's own comment for the full picture.
        // TASK.4721: a detached child's TERMINAL is the only place its real
        // turn count exists (the admit outcome is not evidence), so the
        // adaptive history is written here, before the report is delivered.
        onDetachedTerminal: (outcome, req) => {
          recordAcceptedChildBudget(subagentBudget, outcome, req);
          deliverDetachedChildReport(outcome, req);
        },
        // TASK.148 slice 2: the detached-stall delivery seam — fires
        // mid-run, zero or more times, independently of onDetachedTerminal
        // above. See deliverDetachedChildStall's own comment for the full
        // picture (queue coalescing, id namespacing).
        onDetachedStall: deliverDetachedChildStall,
        // TASK.148 slice 1/2: same knob as the inline tier just above
        // (config.subagentStallTimeoutMs) so both tiers share one resolved
        // value; the port's own default (SUBAGENT_STALL_TIMEOUT_MS) applies
        // when the env/setting is unset. Now governs BOTH the sync and
        // detached stall clocks (slice 2 wires the detached one too).
        stallTimeoutMs: envConfig.subagentStallTimeoutMs,
        // Taskana 4704 §2.8/§3.6: the parallel-children cap (live cell —
        // `roles.maxParallelChildren ?? 4`; undefined only when the settings
        // read failed, which keeps the pre-4704 unlimited posture).
        maxDetachedChildren: () => rolesSettings?.maxParallelChildren ?? 4,
      });
      config.sessionSubagents = childSessionPortHandle;
      // Taskana 4704 §3.6: the respawn path re-spawns through THIS port, and
      // every detached spawn's route facts are recorded at admit so a
      // terminal can classify + respawn. The wrapper records ONLY routed
      // role spawns (noteRoutedSpawn no-ops otherwise) and never alters the
      // outcome — the port itself stays byte-identical.
      childSessionPortForRespawn = childSessionPortHandle;
      const innerRun = childSessionPortHandle.run.bind(childSessionPortHandle);
      childSessionPortHandle.run = (req: SessionSubagentRequest, opts: SubagentRunOptions) => {
        // Cross-review F2: record ONLY spawns whose route the HOST actually
        // stamped — a caller-passed explicit model/provider/connection is the
        // caller's own choice, never a role-chain hop, so a later infra
        // failure must NOT respawn it onto the chain (that would override the
        // explicit request). R7 (re-review #3): core's routeStamped flag is
        // the ONLY discriminator — it is set exactly when the route (not the
        // caller) stamped the request (tools/agent.ts), so a caller's explicit
        // model that merely equals the bare head model is never mistaken for a
        // chain hop. Field equality is no longer consulted.
        if (req.detach === true && isRoleRouteName(req.agentType) && req.resumeChildSessionId === undefined) {
          const resolution = resolveRoleRouteImpl(req.agentType);
          const head = resolution?.entries[0];
          if (head !== undefined) {
            if (req.routeStamped === true) {
              noteRoutedSpawn(req, head, resolution!.entries.slice(1), resolution!.skipped);
            }
          }
        }
        // TASK.4721: adaptive only — a learned base budget stands in for the
        // host default (never over an explicit request, the settings budget, or
        // an engine child). The same object is returned when nothing applies.
        const budgeted = stampLearnedMaxTurns(req, {
          adaptive: adaptiveTurnBudget,
          settingsBudgetSet: envConfig.subagentMaxTurns !== undefined,
          port: subagentBudget,
        });
        if (req.detach === true) {
          // Detached: the admit outcome is not a finished run; the terminal
          // records itself through onDetachedTerminal above.
          return innerRun(budgeted, opts);
        }
        return innerRun(budgeted, opts).then((outcome) => {
          recordAcceptedChildBudget(subagentBudget, outcome, budgeted);
          return outcome;
        });
      };
    }
    // taskana 4181: the supervisor idle watchdog for a CORE root boot — the
    // engine-agnostic twin of the codex boot's construction above (same
    // facts, same delivery seam, same report-only posture). Threshold comes
    // from the SAME envConfig the stall clock's own knob two lines above
    // resolves through (loadEnvConfig surfaces ANYCODE_SUPERVISOR_IDLE_MS as
    // supervisorIdleMs). Constructed only for a non-child boot; the
    // background-children feed rides the SAME registry the port above owns.
    let coreSupervisorIdleWatchdog: SupervisorIdleWatchdog | undefined;
    if (!isChildSessionBoot(args, sessionMeta)) {
      coreSupervisorIdleWatchdog = new SupervisorIdleWatchdog(
        {
          terminalMarkers: SUPERVISOR_IDLE_TERMINAL_MARKERS,
          firstAfterMs: envConfig.supervisorIdleMs ?? SUPERVISOR_IDLE_FIRST_MS,
          repeatEveryMs: SUPERVISOR_IDLE_REPEAT_MS,
          escalateAfter: SUPERVISOR_IDLE_ESCALATE_AFTER,
        },
        deliverSupervisorIdleReminder,
      );
      childSessionPortHandle?.onBackgroundChildrenChanged(() => {
        coreSupervisorIdleWatchdog?.noteBackgroundChildrenChanged(childSessionPortHandle!.listBackgroundChildren().length);
      });
    }
    // Subagent wiring (design §4.2, task 3.1.4; md-profile personas as of
    // slice-3.3-cut.md §6): withSubagents attaches a SubagentPort derived from
    // this same config to config.subagents BEFORE construction, so the Agent
    // tool has a live port with both built-in personas and any discovered
    // md-profiles; a child loop is built without this call and so never
    // receives one (non-recursion lock, §4.1).
    //
    // Workflow wiring (design slice-3.4-cut.md §2.10/§6, task 3.4.5):
    // withWorkflows runs AFTER withSubagents (order is load-bearing — it reads
    // `config.subagents`, which the call above just attached) and attaches a
    // WorkflowPort backed by the SAME SubagentPort, so every workflow step
    // shares the one runner semaphore. It ALSO reads `config.sessionSubagents`
    // (TASK.192), already assigned further above, so an engine-profile step
    // runs through the SAME session port the Agent tool uses. Absent that port
    // (should not happen here, since withSubagents always attaches one) it
    // attaches nothing and the Workflow tool stays fail-closed "unavailable" — the
    // same posture a child loop sees, since child configs never call either
    // helper.
    // env/memorySection (design slice-3.6-cut.md §2.4/§6) thread the same
    // session-static facts + AGENTS.md memory into every child's harness
    // prelude, so a subagent confabulates tools no more than the parent does.
    //
    // resolveChildModelPort is the SAME modelPortFactory the mid-session
    // `/model` switch uses, so an `Agent(model: …)` override builds a child port
    // from this session's provider/transport/key after validating the exact id.
    // Without it the runner returns "model override is not supported in this
    // host" — the CLI wired this from the start, the desktop host did not.
    //
    // `runEngineChild` (engine-children.ts) is NO LONGER wired here (TASK.102
    // CUT-S4 §0.3): an `engine:` md-profile persona now routes to the
    // session-child path (tools/agent.ts, S4a) instead of a one-shot Claude
    // Code / Codex CLI run — and, as of TASK.192, a WORKFLOW step with an
    // engine profile routes through that same session port via
    // withWorkflows(config.sessionSubagents), not the old refusal.
    // `engine-children.ts` itself stays byte-untouched and importable
    // (deprecated-live, owner-gated removal per spec §10) — only this ONE
    // wiring line is gone.
    // profiles is a THUNK, not a snapshot: `ext` is reassigned in place by
    // refreshExtensionProfiles below (mirrors the switchModel callback's
    // in-place `config` mutation), so the runner built here re-reads whatever
    // `ext.profiles` currently holds on every listAgentTypes()/run() call — a
    // profile authored into `.anycode/agents/` mid-session becomes a callable
    // agent_type without recreating this AgentLoop.
    const loop = new AgentLoop(
      withWorkflows(
        withSubagents(config, {
          // Taskana 4704 §3.6: settings-derived role personas. For each of
          // planner/executor/reviewer NOT claimed by md-discovery, a derived
          // PersonaDefinition is appended carrying the settings
          // roles[role].primary fields (engine/connection/provider/model/
          // effort) and ROLE_TURN_BUDGETS' turn budget. Precedence (§2.1):
          // md-profile > settings-derived > built-in — md-discovery's own
          // list stays FIRST and untouched; the derived entries trail it, and
          // the runner's profile-wins resolution handles the rest.
          profiles: () => {
            const claimed = new Set(ext.profiles.map((p) => p.name));
            const derived: PersonaDefinition[] = [];
            for (const role of ["planner", "executor", "reviewer"] as const) {
              if (claimed.has(role)) continue;
              const primary = rolesSettings?.[role]?.primary;
              if (primary === undefined) continue;
              const builtIn = PERSONAS[role];
              derived.push({
                name: role,
                description: builtIn.description,
                tools: builtIn.tools,
                systemPrompt: builtIn.systemPrompt,
                turnBudget: ROLE_TURN_BUDGETS[role],
                ...(primary.model !== undefined ? { model: primary.model } : {}),
                ...(primary.effort !== undefined ? { effort: primary.effort } : {}),
                ...(primary.engine !== undefined ? { engine: primary.engine } : {}),
                ...(primary.connection !== undefined ? { connection: primary.connection } : {}),
                ...(primary.provider !== undefined ? { provider: primary.provider } : {}),
              });
            }
            return derived.length > 0 ? [...ext.profiles, ...derived] : ext.profiles;
          },
          env: systemPromptEnv,
          memorySection: ext.memorySection,
          // Taskana 4131: cheap-model default for inline explore children
          // (ANYCODE_EXPLORE_MODEL). Assigned directly (not conditional-spread):
          // with the var unset this reads `undefined`, which the runner treats
          // exactly like an absent option — explore inherits the parent's port.
          exploreModel: envConfig.exploreModel,
          resolveChildModelPort: (id: string) => {
            assertChildModel(id, readAllowedChildModels(process.env.ANYCODE_CHILD_MODELS, envConfig.model));
            return modelPortFactory(id);
          },
          // TASK.162 (F6) + §0b adjudication: unconditional, exactly like the
          // port factory above (the desktop always has both). The tier handed
          // to the resolver is the host-owned `selectedEffort` cell read AT
          // SPAWN TIME — the live USER-SELECTED tier, kept current by
          // CoreEngine's onReasoningEffortSet callback and by switchModelImpl
          // below. Never `config.reasoningEffort`, whose `undefined` after a
          // switch to a non-reasoning parent would silently drop the child's
          // effort even though the child's own model can honor the tier.
          resolveChildModelSettings: (id: string, profileEffort?: ReasoningEffort) =>
            settingsForChild(id, profileEffort ?? selectedEffort),
          // WebSearch parity for children (Taskana 4095, mirror of the CLI):
          // the SAME instance registered above when a backend resolved is
          // threaded into every persona child registry that lists "WebSearch".
          // Absent (no backend) keeps the runner byte-compatible.
          ...(webSearchTool !== undefined ? { webSearchTool } : {}),
          // Taskana 4704 §3.6: the host-side role-route resolver — settings
          // roles + health cache are HOST state; the runner walks the
          // returned chain for ROLE personas (§3.2) and nothing else.
          resolveRoleRoute: resolveRoleRouteImpl,
        }),
        ext.workflows,
      ),
    );

    // Live agent-profile rescan (subagent-model design): run at the start of
    // EVERY new user turn (CoreEngine's onBeforeTurn, never continueTurn) so a
    // profile dropped into `.anycode/agents/` during this session becomes
    // callable without a restart. Re-scanning is skipped (not re-composing the
    // prompt) when the profiles prompt section is byte-identical to the
    // current one — comparing the rendered section rather than the profiles
    // array avoids a spurious systemPrompt rebuild on every turn when nothing
    // actually changed on disk.
    const refreshExtensionProfiles = async (): Promise<void> => {
      const rescanned = await ext.rescanProfiles();
      if (rescanned === null) {
        return;
      }
      for (const problem of rescanned.problems) {
        console.warn(`[host] extensions: ${problem}`);
      }
      if (rescanned.promptSection === ext.profilesPromptSection) {
        return;
      }
      ext = { ...ext, profiles: rescanned.profiles, profilesPromptSection: rescanned.promptSection };
      mdClaimedProfileNames = new Set(ext.profiles.map((p) => p.name));
      // Components AND prompt, same as the switchModel branch below: the
      // accounting split is derived from these components, so assigning only
      // the prompt would leave contextBreakdown() reporting the pre-rescan
      // "profiles" section — the drift composeSystemPrompt() exists to prevent.
      const refreshedSystemPromptComponents = composeSystemPromptComponents();
      config.systemPrompt = composeSystemPrompt(refreshedSystemPromptComponents);
      config.systemPromptComponents = refreshedSystemPromptComponents;
    };

    const sessionId = sessionMeta.id;
    // Taskana 4123 (TASK.145 residual): a host restart must not lose a detached
    // child's still-unacknowledged report — restore the persisted queue BEFORE
    // this Session's first ui_ready can resendAll() it. (The codex/claude boots
    // wire their own equivalent, attachEngineChildReportDurability, at their
    // own Session construction sites.) A child-mode boot never spawns detached
    // children of its own, so its column stays null.
    if (!isChildSessionBoot(args, sessionMeta)) {
      await attachChildReportDurability({ queue: childReportQueue, persistence: persistence!, sessionId });
    }
    // Slice P7.15 (F14, design §2.1): the narrow mid-session model-switch
    // callback (mirror of the CLI's deps.model.set). It stays host-owned while
    // CoreEngine exposes it through the neutral SessionEngine seam.
    const switchModelImpl = (id: string, selectedTier: ReasoningEffort) => {
        // TASK.162 (§0b): Session hands its OWN preserved user-selected tier
        // here, so this is the second (and only other) writer that keeps the
        // host cell faithful — without it a tier selected before a switch
        // would still be live in Session while the cell held a stale value.
        selectedEffort = selectedTier;
        const previous = currentModel;
        // TASK.198 срез C (plan §3): the SWITCHABLE port, not the outer
        // media-projection decorator (`modelPort`) — setPort mutates what
        // that decorator forwards to, so every existing holder (loop,
        // ContextManager, subagents, titling) sees the new model without a
        // second wrap.
        switchableModelPort.setPort(modelPortFactory(id));
        currentModel = id;

        // and the rebuilt parent prompt see the new modelId.
        systemPromptEnv.modelId = id;
        // Re-budget (mirror of cli/main.ts:1376-1383): the new model's window
        // takes effect on the very next turn — the manager's compaction threshold
        // and the context_usage denominator follow (loop.setContextWindow), and
        // config.context flows to children spawned after the switch. The env
        // override still applies inside resolveContextWindow, but ONLY when its
        // model binding is absent or names THIS id (TASK.142) — a pair saved for
        // model A never leaks its window onto B, and an unknown id re-resolves
        // the assumed fallback rather than a stale previous model's window.
        const contextInfo = resolveContextWindowInfo(id, catalogEntry, envConfig.contextWindowTokens, envConfig.contextWindowModel);
        const contextWindow = contextInfo.tokens;
        liveContextWindowAssumed = contextInfo.source === "assumed";
        config.maxOutputTokens = clampChildOutput(resolveMaxOutputTokens(
          id,
          catalogEntry,
          envConfig.maxOutputTokens,
          (requested, clamped, modelId) =>
            console.warn(`[host] ${modelId} max output tokens clamped: ${requested} > provider catalog ceiling, using ${clamped}`),
          (modelId, applied) =>
            console.warn(`[host] ${modelId} max output tokens: no ceiling declared for this model in the provider catalog, using default ${applied}`),
        ));
        const resolvedEffort = resolveReasoningEffort(id, catalogEntry, selectedTier, liveCapsFor(id));
        config.reasoningEffort = resolvedEffort;
        liveContextWindow = contextWindow;
        // TASK.198 срез C (plan §9): a model switch can flip sighted<->blind,
        // which flips the InspectImage registration gate too — recomputed
        // BEFORE the unconditional recompose right below, so this switch's
        // own prompt rebuild (which runs regardless of whether registration
        // actually changed) always reflects the post-switch tool set.
        recomputeInspectImageRegistration();
        // Slice P7.17 (F12): rebuild the accounting components too (repoMap/env
        // changed) and derive the fresh prompt from them, so contextBreakdown()
        // never reports a stale split after a model switch.
        const switchedSystemPromptComponents = composeSystemPromptComponents();
        config.systemPrompt = composeSystemPrompt(switchedSystemPromptComponents);
        config.systemPromptComponents = switchedSystemPromptComponents;
        loop.setContextWindow(contextWindow);
        config.context = { ...config.context, contextWindowTokens: contextWindow };
        const availableEffortLevels = resolveEffortLevels(id, catalogEntry, liveCapsFor(id));
        if (persistence) {
          void persistence.touchSession(sessionId, { model: id }).catch((error) => {
            console.error(`[host] touchSession(model) failed: ${describeError(error)}`);
          });
        }
        console.log(`[host] model switched: ${previous} -> ${id}`);
        return {
          model: id,
          reasoningEffort: resolvedEffort ?? "off",
          ...(availableEffortLevels !== undefined ? { availableEffortLevels } : {}),
        };
      };
    const engine = new CoreEngine({
      loop,
      config,
      switchModelImpl,
      onBeforeTurn: refreshExtensionProfiles,
      // TASK.162 (§0b): keeps the host's `selectedEffort` cell equal to the
      // tier the USER selected. Session maps its own "off" to undefined before
      // calling, so the cell stores "off" for that case — the same value
      // resolveReasoningEffort treats as "no effort".
      onReasoningEffortSet: (effort) => {
        selectedEffort = effort ?? "off";
      },
    });
    const cleanupHandoff = sessionMeta.worktreeCleanup ?? parseCleanupIntent(process.env[WORKTREE_CLEANUP_ENV]);
    const coreHistoryMaxItems = resolveSessionHistoryMaxItems(process.env);
    session = new Session({
      workspaceTrustRequired: workspaceTrustRequiredMessage,
      outbound,
      engine,
      broker,
      fs: fsAdapter,
      workspace,
      projectRoot: sessionMeta.projectRoot ?? sessionMeta.workspace,
      // TASK.145 срез 2: wired unconditionally — for a child-mode boot (no
      // `config.sessionSubagents`, non-recursion lock above) the queue simply
      // stays empty forever, so `resendAll`/`ack` are harmless no-ops. This is
      // the ONLY Session construction site among the three engines (core is
      // the only engine session-tier children can attach to, spec §5).
      pendingChildReports: {
        resendAll: () => childReportQueue.resendAll(),
        ack: (id) => childReportQueue.ack(id),
      },
      ...(sessionMeta.worktree !== undefined ? { worktree: sessionMeta.worktree } : {}),
      continuationPending: sessionMeta.continuationPending === true,
      continuationMode: sessionMeta.continuationMode ?? "model",
      worktreeExitNoticePending: sessionMeta.worktreeExitNoticePending === true,
      consumeWorktreeExitNotice: async () => {
        await persistence!.touchSession(sessionId, { worktreeExitNoticePending: false });
      },
      worktreeControl: worktreeAvailable ? worktreeControl : undefined,
      onContinuationReady: async () => {
        if (cleanupHandoff !== undefined) {
          const finalized = await worktreeLifecycle.finalizePostRehost({
            projectRoot: sessionMeta.projectRoot ?? sessionMeta.workspace,
            cleanup: toLifecycleCleanup(cleanupHandoff),
          });
          if (!finalized.ok) throw new Error(finalized.reason);
          console.log(`[host] ${finalized.value.message}`);
          outbound.sendDirect({ type: "worktree_notice", message: finalized.value.message });
          return;
        }
        // No cleanup is pending (enter or retained exit). The durable
        // continuation claim is cleared only after the model/no-model segment.
      },
      onContinuationComplete: async () => {
        await persistence!.touchSession(sessionId, {
          continuationPending: false,
          continuationMode: null,
        });
      },
      // TASK.45 W11: core-only (Codex owns its own account, outside the core
      // provider catalog — its Session construction above never wires this).
      // Main resolves the pinned connectionId per-proc (tabs.ts); the host stays
      // connection-agnostic and only relays the loop's own classification.
      reportProviderHealth: (event) => {
        const message: ProviderHealthEvent =
          event.kind === "success"
            ? { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "success" }
            : { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "failure", code: event.code };
        process.parentPort.postMessage(message);
      },
      // Taskana 4090 follow-up: same parentPort side channel as health above
      // — main (tabs.ts) resolves THIS proc's pinned connectionId and does the
      // throttled `lastQuota` write (main/connection-quota.ts). Core-only for
      // the same reason as health: an engine broker owns its own account.
      reportProviderQuota: (quota, source) => {
        const message: ProviderQuotaEvent = { type: PROVIDER_QUOTA_EVENT_TYPE, quota, source };
        process.parentPort.postMessage(message);
      },
      onWorkspaceTransition: async (transition: WorkspaceTransition) => {
        const rollback = async (): Promise<void> => {
          // Before durable history success, the source host is authoritative.
          if (transition.kind === "enter_worktree") {
            const removed = transition.worktree.ownedByAnyCode
              ? await cleanupOwnedWorktreeResource(
                  gitForWorkspace(transition.projectRoot),
                  { path: transition.toWorkspace, branch: transition.worktree.branch },
                )
              : { ok: true as const, value: null };
            await persistence!.touchSession(sessionId, {
              projectRoot: transition.projectRoot,
              workspace: transition.fromWorkspace,
              worktree: null,
              continuationPending: removed?.ok === false,
              continuationMode: removed?.ok === false ? "none" : null,
              worktreeCleanup: removed?.ok === false
                ? {
                    path: transition.toWorkspace,
                    mode: "auto",
                    ownedByAnyCode: true,
                    branch: transition.worktree.branch,
                  }
                : null,
              worktreeTransition: null,
            });
          } else {
            await persistence!.touchSession(sessionId, {
              projectRoot: transition.projectRoot,
              workspace: transition.fromWorkspace,
              worktree: transition.worktree,
              continuationPending: false,
              continuationMode: null,
              worktreeExitNoticePending: false,
              worktreeCleanup: null,
              worktreeTransition: null,
            });
          }
        };
        const recoverCommittedTransition = (error: unknown): void => {
          // History success is already durable: rollback would make the
          // transcript lie. Exit this host and let main respawn; boot recovery
          // confirms the exact journal/toolCall or reissues canonical rehost.
          console.error(`[host] committed worktree handoff requires recovery: ${describeError(error)}`);
          process.exitCode = 1;
          setTimeout(() => process.exit(1), 0);
        };
        try {
          await historySink!.flushChecked();
        } catch (error) {
          try {
            const durableHistory = await persistence!.loadHistory(sessionId);
            if (hasDurableTransitionResult(
              durableHistory,
              transition.kind,
              transition.toolCallId === undefined ? "chrome" : "tool",
              transition.toolCallId,
            )) {
              recoverCommittedTransition(error);
              return;
            }
          } catch (historyError) {
            recoverCommittedTransition(historyError);
            return;
          }
          await rollback();
          throw error;
        }
        const confirmed = await worktreeLifecycle.confirmTransition();
        if (!confirmed.ok) {
          recoverCommittedTransition(new Error(confirmed.reason));
          return;
        }
        try {
          const cleanup = preparedCleanup;
          const wireCleanup: WireWorktreeCleanupIntent | undefined =
            cleanup?.kind === "remove_clean"
              ? {
                  path: cleanup.target,
                  mode: "auto",
                  ownedByAnyCode: true,
                  ...(cleanup.branch !== undefined ? { branch: cleanup.branch } : {}),
                }
              : cleanup?.kind === "remove_force"
                ? {
                    path: cleanup.target,
                    mode: "remove",
                    ownedByAnyCode: cleanup.ownedByAnyCode,
                    ...(cleanup.ownedByAnyCode && cleanup.branch !== undefined ? { branch: cleanup.branch } : {}),
                  }
                : undefined;
          process.parentPort.postMessage({
            type: WORKTREE_TRANSITION_MESSAGE_TYPE,
            sessionId,
            fromWorkspace: transition.fromWorkspace,
            toWorkspace: transition.toWorkspace,
            projectRoot: transition.projectRoot,
            ...(transition.kind === "enter_worktree" ? { worktree: transition.worktree } : {}),
            ...(wireCleanup !== undefined ? { cleanup: wireCleanup } : {}),
          });
        } catch (error) {
          recoverCommittedTransition(error);
        }
      },
      model: currentModel,
      reasoningSupported: bootEffortLevels !== undefined,
      ...(bootEffortLevels !== undefined ? { availableEffortLevels: bootEffortLevels } : {}),
      // Slice P7.15 (F14): the user-selected effort tier, threaded so Session can
      // re-resolve effort against the NEW model on a switch (mirror of the CLI's
      // selectedReasoningEffort seed). set_reasoning_effort keeps it in sync.
      selectedEffort,
      sessionId,
      bootHistory,
      // TASK.188 S4: dev/automation-ONLY replay-recording override, resolved
      // here (the composition root) and never inside Session itself.
      ...(coreHistoryMaxItems !== null ? { historyMaxItems: coreHistoryMaxItems } : {}),
      hasTitle: sessionMeta.title !== undefined && sessionMeta.title.length > 0,
      // Same instance as config.permissionEngine's RuleAwarePermissionEngine
      // (design §5): Session.maybeRemember appends to it on a remembered allow.
      rules,
      // GitBridge seam (slice 5.7): Session routes a user's `git_command` here
      // and fires refreshAfterTurn() on turn teardown. Narrow interface only.
      git: gitBridge,
      // Narrow notice seam (slice 6.DP-2, §1.3): Session drains completion notices
      // at the top of each accepted turn — it never holds the whole port.
      ...(taskManager !== null ? { tasks: taskManager } : {}),
      // Rewind/list seam (slice P7.26/R2, design §2.1): the SAME checkpointService
      // threaded into config.checkpoints for per-turn CAPTURE (R1) also serves the
      // renderer's on-demand checkpoint_list + rewind_request. Absent (no runBinary
      // / legacy) -> checkpoints disabled, rewind fail-closed. Structural — Session
      // holds only the narrow {list, rewind} interface, never the whole class.
      ...(checkpointService !== null ? { checkpoints: checkpointService } : {}),
      // Renderer Panels sub-slice A: Session exposes only the pull status
      // snapshot to the renderer, not the diagnostics LSP port itself. Slice
      // P7.25/F3 adds onStatusChange: the Session registers its ui_ready-gated
      // live-push here and gets an unsubscribe fn (called on dispose — no leaked
      // listener, no push-after-dispose). Single per-boot session ⇒ one slot.
      ...(lspManager !== null
        ? {
            lsp: {
              status: () => lspManager!.status(),
              onStatusChange: (listener: () => void): (() => void) => {
                lspStatusListener = listener;
                return () => {
                  if (lspStatusListener === listener) lspStatusListener = null;
                };
              },
              // Taskana 4711: Environment menu Restart → respawn crashed servers.
              restart: () => lspManager!.restartCrashed(),
            },
          }
        : {}),
      // Renderer Panels sub-slice B: static command-hook declarations and
      // fail-soft config-loader errors are surfaced to the renderer.
      hooksList: {
        list: () => hookDeclarations,
        ...(hookConfigError !== undefined ? { configError: hookConfigError } : {}),
      },
      // TASK.145 срез 3 §2: read/cancel seam onto the detached-children
      // registry `childSessionPortHandle` owns. Absent for a child-session
      // boot or a claude/codex master (`childSessionPortHandle` itself is
      // undefined there) — Session's own `?? []` makes that a silent
      // empty-list `background_children` push, mirroring every other
      // absent-seam default on this same object.
      ...(childSessionPortHandle !== undefined
        ? {
            backgroundChildren: {
              list: () => childSessionPortHandle!.listBackgroundChildren(),
              cancel: (childSessionId: string) => childSessionPortHandle!.cancelBackgroundChild(childSessionId),
              cancelAll: () => childSessionPortHandle!.cancelAllBackgroundChildren(),
              onChange: (listener: () => void) => childSessionPortHandle!.onBackgroundChildrenChanged(listener),
            },
          }
        : {}),
      // taskana 4181: the supervisor idle-watchdog seam for the core root —
      // engine-agnostic on purpose (a core supervisor driving detached
      // children deserves the same guard as a codex one); absent for a
      // child-session boot, mirroring the backgroundChildren gate above.
      ...(coreSupervisorIdleWatchdog !== undefined
        ? {
            supervisorIdle: {
              noteTurnSettled: (lastPublicText: string) => coreSupervisorIdleWatchdog!.noteTurnSettled(lastPublicText),
              noteTurnStarted: () => coreSupervisorIdleWatchdog!.noteTurnStarted(),
            },
          }
        : {}),
      // A1 (Taskana 4704 review, cross-review F1): the Session derives the
      // child spawn mode itself (childSpawnMode(), session.ts) from its own
      // orchestrate state — the host port's copy (above) mirrors the same
      // derivation because the port exists before the Session. There is no
      // override option anymore: the earlier override wiring recursed.
      // Taskana 4704 §3.7: orchestrate transitions land on the AgentLoopConfig
      // (config.orchestrate), which the loop threads into the dispatch context
      // and the dispatcher into every ToolContext — the Agent tool reads it for
      // orchestrate default-detach (§3.3).
      // R1: the spawn-mode cell captures the pre-orchestrate mode (see
      // spawn-mode-cell.ts) and keeps config.orchestrate in step.
      onOrchestrateChanged: (enabled: boolean) => {
        spawnModeCell.onOrchestrateChanged(enabled);
      },
      // Taskana 4704 §3.6: turn-start orchestrator-route check — the host
      // owns the health cache AND switchModelImpl. Applies model+effort ONLY
      // on the tab's active connection (§9-Q2: connection switching stays
      // manual). Returns the engine_notice line when a switch happened.
      orchestratorRouteCheck: (): string | undefined => {
        const orchestrator = rolesSettings?.orchestrator;
        if (orchestrator === undefined) return undefined;
        const chain = [orchestrator.primary, ...(orchestrator.fallbacks ?? [])].map(toCoreEntry);
        const picked = pickEntry(chain, roleHealth.snapshot(), Date.now(), "orchestrator");
        if (picked === null || picked.index === 0) {
          // Primary healthy (or nothing to switch to) — no notice.
          return undefined;
        }
        // The primary was skipped for a health reason and a fallback exists.
        // Only a fallback carrying a model on THIS connection can switch
        // here (an engine/connection entry is a different connection —
        // manual, surfaced as the reason line only when it has a model).
        // F9 (cross-review): the switch itself requires a BARE model entry
        // (no engine, no connection) — an entry like {engine: "codex",
        // model: "gpt-…"} names a model on ANOTHER connection, and
        // switchModelImpl on it would flip the active tab to a foreign id
        // (§9-Q2: connection switching stays manual).
        const reason = picked.skipped[0]?.reason ?? "unhealthy";
        const switchModel = picked.entry.model;
        const switchable =
          switchModel !== undefined &&
          picked.entry.engine === undefined &&
          picked.entry.connection === undefined &&
          picked.entry.provider === undefined;
        if (!switchable || switchModel === undefined) {
          return `Orchestrator: primary route unhealthy (${reason}); configure a model fallback to switch automatically.`;
        }
        const effort = picked.entry.effort === undefined || picked.entry.effort === "xhigh"
          ? undefined
          : picked.entry.effort;
        switchModelImpl(switchModel, effort ?? selectedEffort ?? "medium");
        return `Orchestrator: primary route unhealthy (${reason}), running on ${switchModel}.`;
      },
      // Slice P7.8 (design slice-P7.8-cut.md §3.2, mirror of the `lsp` seam
      // above): telemetry reads live counters on every push; repo-map is
      // boot-frozen (computed once above, right after buildRepoMapPromptSection).
      envStatus: {
        telemetry: () => telemetry?.port.status() ?? null,
        repoMap: () => repoMapStatus,
        flushTelemetry: () => telemetry?.port.flush() ?? Promise.resolve(),
      },
      imageInputEnabled: media.imageInputEnabled,
      contextWindowAssumed: () => liveContextWindowAssumed,
      // TASK.198 срез C: core-only wiring (codex/claude Sessions never pass
      // these two — "codex/claude НЕ задеты (замыкание не установлено)").
      imageFallbackAvailable: media.recognizerConfigured,
      applyRecognizerConfig: applyRecognizerEndpoint,
      // Narrow persistence callback (§4.2): Session persists title/mode patches
      // without ever holding the whole port. Fire-and-forget, never blocks a turn.
      persistence: {
        touch(patch) {
          if (!persistence) {
            return;
          }
          void persistence.touchSession(sessionId, patch).catch((error) => {
            console.error(`[host] touchSession failed: ${describeError(error)}`);
          });
        },
      },
      // Taskana 4083 / TASK.34: the persistent per-step provider-usage audit,
      // CORE-ONLY wiring (codex/claude boots above pass nothing — their usage
      // arrives as cumulative REPLACE snapshots, not per-step finishes).
      // Write-behind: the sink swallows+logs its own failures, so audit I/O
      // can never block or fail a turn.
      usageAudit: {
        sink: {
          record: (r) => {
            // Serialized (chained off the tail, never parallel) so flush()
            // below is an honest drain of every queued write IN ORDER.
            usageAuditWriteTail = (usageAuditWriteTail ?? Promise.resolve())
              .then(() => persistence!.recordProviderUsage({ ...r, sessionId, createdAt: Date.now() }))
              .catch((e) => console.error(`[host] usage audit write failed: ${e instanceof Error ? e.message : String(e)}`));
          },
          // Cross-review finding 4: shutdown drain — a serialized tail exactly
          // like WriteBehindHistorySink's, so Session.shutdown() can await
          // every queued audit write before the host closes the database (an
          // unbounded late write would otherwise re-open the closed file and
          // leak the handle). Fail-soft per write; flush() itself never rejects.
          flush: () => usageAuditWriteTail ?? Promise.resolve(),
        },
        summary: {
          summary: () => persistence!.listProviderUsage(sessionId).then(summarizeProviderUsage),
        },
      },

      // the real implementation, bound to THIS session's modelPort. Injected as
      // a callback (not read off config.modelPort inside Session) so
      // host/test-harness.ts's ScriptedModelPort-backed tests are unaffected
      // unless they opt in via HarnessOptions.refineTitle.
      refineTitle: (text) => generateSessionTitle({ modelPort: config.modelPort, text }),
      postPreviewArtifacts: sendPreviewArtifacts,
      // TASK.102 CUT-S2 §2.6.3 (slice S2b B4): present ONLY for a child-mode
      // boot. `flushHistory` is the SAME `historySink.flushChecked()` ordering
      // guarantee the worktree-transition handoff above already relies on
      // (§0.5 — a terminal report is trusted by main/renderer ONLY once the
      // child's transcript is durably on disk). CUT-S4 §4.1: `buildChildSessionOptions`
      // is the exact same onReady/onTerminal/onProgress bodies, extracted so
      // codex/claude share them too — only `flushHistory` differs per engine.
      // TASK.196: core children get the wrap-up rescue (one bounded tool-free
      // model call via core's runWrapUp against THIS loop/config). TASK.219:
      // also pass the dedicated wrapped modelPort's claim getter (the same
      // port the loop streams through) so the terminal can carry
      // `responseModel`. Engine boots below pass neither.
      ...(args.child !== undefined
        ? {
            child: buildChildSessionOptions(
              () => historySink!.flushChecked(),
              () => runWrapUp(config, loop, "", SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS).then((r) => r.text),
              () => modelPort.lastResponseModel,
            ),
          }
        : {}),
    });
    // A1/F1 (Taskana 4704 cross-review): no post-construction binding. The
    // child port's getPermissionMode closure (declared next to the port,
    // above) derives the spawn mode from the same host cells this callback
    // keeps current — the earlier late-binding-cell round-trip
    // (port -> Session.childSpawnMode() -> cell -> port ...) recursed
    // forever on the first spawn of a session-tier child.

    // Taskana 4730 xfix D4: the model-kind classifier is pinned to a
    // connection this session is not running on — the classifier is OFF and
    // the user SEES that (engine_notice renders like every other config
    // warning), never a silent fallback to the session's own connection.
    if (modelClassifierOffNotice !== undefined) {
      session.emitAgentEvent({ type: "engine_notice", level: "warning", message: modelClassifierOffNotice });
    }
    console.log(
      `[host] initialized. workspace=${workspace} model=${envConfig.model} session=${sessionId}` +
        ` mode=${mode} resumed=${initialHistory.length > 0} db=${dbPath}`,
    );
  } catch (error) {
    await engineBootstrap?.dispose();
    engineBootstrap = null;
    // main (MVP.2) validates ANYCODE_API_KEY/MODEL before spawning, so this is a
    // defensive path: surface the failure to the UI on connect rather than dying
    // silently. No core is instantiated in degraded mode.
    initFailure = `host failed to initialize: ${describeError(error)}`;
    console.error("[host]", initFailure);
  } finally {
    // Env-hardening (ruling §3, slice 2.2.3): runs on BOTH the success and the
    // init-failure path (defense-in-depth — a degraded host still leaks
    // nothing). By construction of `finally`, this always runs after the try
    // block above, i.e. after AiSdkModelPort already captured the key by value
    // (see host/boot.ts's scrubSecretEnv doc for why the model port keeps
    // working and why there is no race with a later Bash child).
    scrubSecretEnv();
  }
}

const ready = boot();
void ready.then(() => session?.observeAgentDeliveries((delivery) => { process.parentPort.postMessage({ type: "communication_delivery", delivery }); }));

async function handleShutdown(): Promise<void> {
  await ready;

  // TASK.102 CUT-S2 §10.14.3 BLOCKER-1: arm the admission funnel before any
  // teardown step below runs — the whole teardown window was previously
  // ungated, admitting exit_worktree/rewind_request/user_message against
  // managers this function is about to tear down.
  session?.closeAdmissions();

  // first teardown step — synchronous and cheap. A turn-end refresh could have a
  // git spawn running at shutdown; the adapter received `gitAbort.signal`, so
  // this aborts it through the proven runBinary abort path (SIGTERM->SIGKILL,
  // pgid — the "cancels via abortSignal" node-execution suite). No new dispose
  // stage: git spawns are short-lived and the command queue drains to refusals
  // after abort.
  gitAbort.abort();
  // Credential-free loopback proxy relay (TASK.135 follow-up): destroy its
  // sockets before the children that may still be using it — every live
  // tunnel collapses immediately rather than on its own TCP timeout.
  closeProxyRelay();
  // Kill the terminal shell FIRST and synchronously (SIGHUP): the pty is a child
  // of this host, so tearing it down before session teardown keeps it inside the
  // existing 2 s graceful-stop deadline without a second lifecycle (design §3.3).
  terminals.dispose();
  // Background-task reap (slice 6.DP-2, mirror of cli/main.ts:1401-1407): aborts
  // every live task and awaits reaping, bounded by BACKGROUND_DISPOSE_DEADLINE_MS
  // (the manager's own Promise.race) — never hangs shutdown. `taskManager` is
  // null only after an init failure; no-op then.
  await taskManager?.disposeAll();
  // Language-server reap (slice 6.DP-1, mirror of cli/main.ts:1408-1414): polite
  // shutdown-then-kill for every live server, bounded by LSP_DISPOSE_DEADLINE_MS
  // (LspManager's own Promise.race) — never hangs shutdown. `lspManager` is null
  // when no servers were configured; no-op then.
  await lspManager?.disposeAll();
  // Telemetry sink teardown (slice 6.6, mirror of the CLI exit-path): bounded
  // dispose (JsonlTelemetrySink races its own TELEMETRY_DISPOSE_DEADLINE_MS) —
  // never hangs shutdown. `telemetry` is null when the sink was never built
  // (opt-in default-OFF, or an init failure before it could be constructed).
  if (telemetry !== null) {
    telemetry.port.record({ v: 1, ts: Date.now(), session: telemetry.session, t: "session_end" });
    await telemetry.port.dispose();
  }

  // -> session. Bounded by McpManager's own MCP_DISPOSE_DEADLINE_MS (mirrors

  // past its own deadline; the try/catch is defense-in-depth only — dispose()
  // is itself designed to never reject (Promise.allSettled internally).
  if (mcpManager) {
    try {
      await mcpManager.dispose();
    } catch (error) {
      console.error("[host] error disposing MCP manager on shutdown:", describeError(error));
    }
  }
  if (session) {
    await session.shutdown();
  }
  await engineBootstrap?.dispose();
  engineBootstrap = null;
  // Taskana 4682 rework: after the engine is disposed no tool child can hold
  // the private temp dir open — the LAST safe moment to remove it. Best-effort
  // (the helper swallows its own errors); idempotent with the finalize-time
  // removal a completed child already performed.
  codexChildTempDirCleanup?.();
  // Drain the write-behind queue and close the database (design §2.12,
  // mirrors cli/main.ts's task-1.7 wiring): best-effort, must never block
  // process exit on a persistence hiccup during teardown.
  try {
    if (historySink) {
      await historySink.flush();
    }
    if (persistence) {
      await persistence.close();
    }
  } catch (error) {
    console.error("[host] error flushing/closing persistence on shutdown:", describeError(error));
  }
  process.exit(0);
}

process.parentPort.on("message", (event) => {
  const port = event.ports[0];
  if (port) {
    // Two channels carry a port: the term-channel is disambiguated by its init
    // message type, checked FIRST — otherwise it is swallowed as the UI channel
    // (design §3.3). Both binds await `ready` (one discipline; guarantees the
    // env is already scrubbed before any `term_open` can spawn a shell).
    const initType = (event.data as { type?: unknown } | undefined)?.type;
    if (initType === TERMINAL_INIT_MESSAGE_TYPE) {
      void ready.then(() => {
        terminals.bindPort(createWirePort(port));
        console.log("[host] terminal port wired.");
      });
      return;
    }
    void ready.then(() => {
      const wire = createWirePort(port);
      if (session) {
        session.bindPort(wire);
        console.log("[host] UI port wired.");
        // Late-attaching renderer (design slice-3.2-cut.md §3.5/§6, task 3.2.4):
        // send the CURRENT MCP snapshot right away rather than waiting for the
        // next status change — mirrors the host_ready cascade (a fresh
        // connect always gets a full, regenerated picture). Un-buffered
        // (sendDirect): outbound.attach(wire) above already retargeted the
        // port synchronously inside bindPort, so this posts immediately;
        // no-op when MCP never started (fail-soft boot, or zero configured
        // servers — nothing new to tell a late-attaching renderer).
        if (mcpManager) {
          outbound.sendDirect({ type: "mcp_status", servers: mcpManager.status() });
        }
      } else {
        // Degraded mode (boot() failed; initFailure is always set by the
        // catch block above once session stays null): send the fatal the
        // instant this port is attached, not just on the first inbound
        // message — a stalled "Connecting to host…" screen must never
        // depend on the renderer speaking first (GitHub #4). wire.onMessage
        // is registered BEFORE the immediate send (mirrors bindPort's own
        // attach-then-onMessage order above) and stays wired afterward, not
        // replaced, so a late-attaching second port — or any message this
        // renderer sends later — still gets the same reason; every inbound
        // message keeps re-sending it exactly as before this fix (harmless,
        // idempotent on the renderer). A rebind re-runs this whole block, so
        // a NEW port gets its own fresh immediate fatal too —
        // un-deduplicated on purpose, the same posture the healthy branch
        // already has for mcp_status/host_ready on every bind.
        const sendFatal = () => {
          if (initFailure) {
            outbound.sendDirect({ type: "fatal", message: initFailure });
          }
        };
        outbound.attach(wire);
        wire.onMessage(sendFatal);
        sendFatal();
      }
    });
    return;
  }

  const communication = event.data as { type?: string; requestId?: string; operation?: string; payload?: unknown } | undefined;
  if (communication?.type === "communication_request") {
    void ready.then(async () => {
      try {
        if (!session) throw new Error("Session not ready");
        let result: unknown;
        switch (communication.operation) {
          case "get_session_result": result = session.communicationResult(); break;
          case "get_session_status": result = session.communicationStatus(); break;
          case "send_message": result = await session.receiveAgentMessage(communication.payload as import("../shared/communication.js").AgentEnvelope); break;
          case "restore_agent_messages": session.restoreAgentMessages(communication.payload as import("../shared/communication.js").AgentDelivery[]); result = {}; break;
          case "get_message_status": result = session.agentMessageStatus(String(communication.payload)); break;
          default: throw new Error("Unsupported communication operation");
        }
        process.parentPort.postMessage({ type: "communication_response", requestId: communication.requestId, result });
      } catch (error) {
        process.parentPort.postMessage({ type: "communication_response", requestId: communication.requestId, error: describeError(error) });
      }
    });
    return;
  }
  const data = event.data as { type?: unknown } | undefined;
  if (data && data.type === CREDENTIAL_RESPONSE_TYPE) {
    const response = data as CredentialResponse;
    for (const listener of credentialResponseListeners) {
      listener(response);
    }
    return;
  }
  // TASK.198 срез C (plan §1.2/§1.3): main's live recognizer-config push
  // (main/tabs.ts's `broadcastRecognizerConfig`, filtered upstream to live
  // ROOT core tabs only — a codex/claude fork or a child-session fork never
  // receives this at all). `session` may still be null here (this fork
  // hasn't finished boot()) — the push is then simply lost, same recovery
  // posture as every other pre-Session control-plane message in this
  // handler: the NEXT fork reads the fresh ANYCODE_RECOGNIZER_* env snapshot
  // regardless (finding #1's recovery path, no dependency on this push ever
  // having landed). `session.applyRecognizerConfig` itself is a safe no-op
  // on a codex/claude Session (its wiring is never installed there).
  if (data && data.type === RECOGNIZER_CONFIG_CHANGED_TYPE) {
    const message = data as RecognizerConfigChanged;
    session?.applyRecognizerConfig(
      message.endpoint === null ? null : recognizerEndpointFromFields(message.endpoint),
    );
    return;
  }
  // TASK.102 CUT-S2 §2.6.1 (slice S2b B5): main -> this parent host, a
  // ChildRunEvent for a session-tier Agent call this host's own RPC client
  // (createChildSessionPort) started. parseChildRunEvent is fail-closed
  // (malformed/unrecognized `kind` -> null, never thrown) — a stray or
  // corrupted message is silently dropped rather than fanned out. Fan-out
  // (not a single-listener call) mirrors the credential broker above; the
  // client's own `Map<requestId, waiter>` (child-session-port.ts) is what
  // actually correlates the event to the ONE `run()` call it belongs to.
  const childRunEvent = parseChildRunEvent(data);
  if (childRunEvent) {
    for (const listener of childRunEventListeners) {
      listener(childRunEvent);
    }
    return;
  }
  // TASK.102 CUT-S2 §2.6.3 (slice S2b B4): main -> child host, the queued
  // initial prompt, released once this fork's own `child-ready` was sent.
  // `startProgrammaticTurn` is a safe no-op refusal on a non-child (or
  // not-yet-booted) session — this branch is reachable from every boot path's
  // shared dispatch table, but only ever does anything for an actual
  // child-mode core session.
  const childStart = parseChildStart(data);
  if (childStart) {
    session?.startProgrammaticTurn(childStart.prompt);
    return;
  }
  // Preview control-plane messages (night-track wave-1 cut §2.3/§2.4): routed
  // through the pure boot.ts filter so this handler stays a thin dispatch
  // table. onEvent (slice 96-D) emits straight onto the module-level outbound
  // sink rather than through Session: preview events are unsolicited and NOT
  // turn-scoped (translatePreviewEvent's doc comment above), and `outbound`
  // is the SAME instance every Session construction below is handed, so this
  // reaches the wire identically whether or not a Session exists yet/still.
  if (
    routePreviewMessage(data, {
      onResponse: (response) => {
        for (const listener of previewResponseListeners) {
          listener(response);
        }
      },
      onEvent: (message) => {
        outbound.emit({
          type: "agent_event",
          turnId: PREVIEW_CONSOLE_TURN_ID,
          event: translatePreviewEvent(message),
        });
      },
    })
  ) {
    return;
  }
  if (data && data.type === "shutdown") {
    void handleShutdown();
  }
});

console.log(`[host] started. workspace=${workspace}`);

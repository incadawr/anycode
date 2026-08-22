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
import { homedir, release } from "node:os";
import { realpath as fsRealpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  ModePermissionEngine,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeGitAdapter,
  NodeHttpAdapter,
  NodeMcpTransportFactory,
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
  buildRepoMapPromptSection,
  buildTelemetryTap,
  createCommandHook,
  createDefaultTokenizer,
  createDefaultToolRegistry,
  createSkillPort,
  createWebSearchTool,
  browserOpenTool,
  browserReadTool,
  browserScreenshotTool,
  diagnosticsEditTool,
  diagnosticsWriteTool,
  enterWorktreeTool,
  exitWorktreeTool,
  discoverExtensions,
  generateSessionTitle,
  loadEnvConfig,
  loadHookConfigs,
  loadLspServerSpecs,
  loadMcpServerSpecs,
  loadRepoMapConfig,
  loadTelemetryConfig,
  loadWebSearchConfig,
  matchCatalogEntryByBaseUrl,
  resolveContextWindow,
  resolveEffortLevels,
  resolveImageInput,
  resolveMaxOutputTokens,
  resolveReasoningEffort,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  REPO_MAP_MAX_TOKENS,
  REPO_MAP_MIN_TOKENS,
  REPO_MAP_WINDOW_FRACTION,
  withSubagents,
  withWorkflows,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type {
  AgentEvent,
  AgentLoopConfig,
  BuiltinSkillDefinition,
  CommandHookDeclaration,
  ExtensionsBootstrap,
  LspServerSpec,
  MediaCapabilityPort,
  McpServerSpec,
  ModelPort,
  PermissionMode,
  PreviewPort,
  ProviderTransport,
  ReasoningEffort,
  ResolvedTelemetryConfig,
  ResolvedWebSearchBackend,
  RepoMapConfig,
  SystemPromptEnv,
  TelemetryPort,
  WorktreeControlPort,
  WorkspaceTransition,
} from "@anycode/core";
import { hasDurableTransitionResult } from "./worktree-recovery.js";
import type { HostToUiMessage, ShellCapabilitiesProjection, WireRepoMapStatus } from "../shared/protocol.js";
import {
  CREDENTIAL_RESPONSE_TYPE,
  ENV_AUTH_MODE,
  type CredentialRequest,
  type CredentialResponse,
} from "../shared/credentials.js";
import { TERMINAL_INIT_MESSAGE_TYPE } from "../shared/terminal.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { PREVIEW_ARTIFACTS_TYPE } from "../shared/preview.js";
import type { PreviewEventMessage, PreviewRequestMessage, PreviewResponseMessage } from "../shared/preview.js";
import {
  WORKTREE_CLEANUP_ENV,
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeCleanupIntent as WireWorktreeCleanupIntent,
} from "../shared/worktrees.js";
import {
  buildResolveApiKey,
  createPreviewRpcClient,
  hostDiagnosticSink,
  isChildSessionBoot,
  parseHostArgs,
  repairDanglingToolCalls,
  resolveBootSession,
  routePreviewMessage,
  scrubSecretEnv,
  seedAlwaysAllowRules,
} from "./boot.js";
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
import { resolveExtensionsHomeOverride } from "./dev-home.js";
import { buildCheckpointService } from "./checkpoints.js";
import { GitBridge } from "./git-bridge.js";
import { CoreEngine } from "./engines/core-engine.js";
import { beginEngineBootstrap, type EngineBootstrap } from "./engines/bootstrap.js";
import { selectEnginePlugin, type EnginePlugin } from "./engines/registry.js";
import { resumeCodexEngine, startCodexEngine } from "./engines/codex/codex-engine.js";
import {
  assertCodexProfileHome,
  parseCodexProfileArgs,
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
import { resumeClaudeEngine, startClaudeEngine } from "./engines/claude/claude-engine.js";
import { parseClaudeEngineArgs } from "./engines/claude/draft-args.js";
import { projectClaudeHistory } from "./engines/claude/history-projection.js";
import { readHostProcessOwnership as readClaudeHostProcessOwnership } from "./engines/claude/process-ownership.js";
import { ClaudeSettingsSeam } from "./engines/claude/settings-seam.js";
import { ClaudeShadowTranscriptEngine, SqliteClaudeShadowTranscript } from "./engines/claude/shadow-transcript.js";
import { ClaudeSessionRowWriter } from "./engines/claude/session-row.js";
import { claudeChildPresetId, codexChildPosture } from "./engines/child-permission-map.js";
import { checkClaudeBinaryTrustOnDisk } from "./engines/claude/claude-client.js";
import { createEngineChildRunner } from "./engine-children.js";
// TASK.103: the host-side consent reader. Host never WRITES settings.json
// (main is the sole writer, host/boot.ts:239-245) — this is the sanctioned
// fail-soft read, same standing custody as seedAlwaysAllowRules above.
import { readTrustedBinaryConsentsSync } from "../settings/files.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { wirePlanExit } from "./plan-exit.js";
import { Outbound, Session, tapChildPermissions, type ChildSessionOptions } from "./session.js";
// TASK.102 CUT-S2 §2.6.2/§2.6.3 (slice S2b B4) built the CHILD side of this
// wire (child-ready on first ui_ready, child-start dispatch, permission-tap
// attention, terminal report). Slice S2b B5 (below) adds the PARENT side: the
// RPC-client wiring (createChildSessionPort), the ChildRunEvent dispatch
// table, and the sessionTier:true/sessionSubagents non-recursion locks.
import { createChildSessionPort } from "./child-session-port.js";
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
  type ChildSpawnRequest,
  type ChildTerminal,
} from "../shared/child-sessions.js";
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

function sendChildSessionMessage(message: ChildSpawnRequest | ChildRunCancel): void {
  process.parentPort.postMessage(message);
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
/** Exists before engine-specific boot; owns cleanup when Session was never built. */
let engineBootstrap: EngineBootstrap | null = null;
let initFailure: string | null = null;
let historySink: WriteBehindHistorySink | null = null;
let persistence: SqlitePersistenceAdapter | null = null;
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
 */
function buildChildSessionOptions(flushHistory: () => Promise<void>): ChildSessionOptions {
  return {
    onReady: () => {
      process.parentPort.postMessage({ type: CHILD_READY_TYPE } satisfies ChildReady);
    },
    flushHistory,
    onTerminal: (report) => {
      process.parentPort.postMessage({
        type: CHILD_TERMINAL_TYPE,
        status: report.status,
        finalText: report.finalText,
        truncated: report.truncated,
        turns: report.turns,
        toolCalls: report.toolCalls,
        durationMs: report.durationMs,
        ...(report.activitySuppressed !== undefined ? { activitySuppressed: report.activitySuppressed } : {}),
      } satisfies ChildTerminal);
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
async function bootCodexSession(bootstrap: EngineBootstrap, plugin: EnginePlugin): Promise<void> {
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
  const options = {
    bootstrap,
    broker,
    binaryPath,
    cwd: workspace,
    workspace,
    sourceEnv: process.env,
    shadowLog,
    // TASK.103: per-call re-read so a consent granted or revoked mid-session
    // is honored by the very next spawn gate (D-S4-4) — main is the sole
    // writer, this closure just re-reads before each of assertTrusted's
    // per-spawn calls.
    binaryTrust: (path: string) => checkCodexBinaryTrustOnDisk(path, process.platform, readTrustedBinaryConsentsSync(hostSettingsPathOverride())),
    ...(processOwnership !== undefined ? { processOwnership } : {}),
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
  };

  // TASK.39: the draft (pre-session) model/preset choice arrives as argv from
  // main. It is untrusted renderer input and is validated inside the engine —
  // against the LIVE model/list catalog and the frozen preset table — before any
  // id reaches the wire; nothing here interprets it.
  const draft = parseCodexEngineArgs(process.argv.slice(2));

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
        const resumed = await resumeCodexEngine({
          ...options,
          externalSessionRef: existing.externalSessionRef,
          // Posture survives the relaunch through the PERSISTED row, never
          // through the server echo (L8 makes the echo un-mappable): the `mode`
          // column carries the preset id verbatim (cut §2(k).4). A pre-TASK.39
          // row holds a core mode there ("build") — the engine treats an
          // unrecognized id as the default preset, silently.
          selection: { model: existing.model, presetId: existing.mode, origin: "persisted" },
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
        const childPresetId = args.child !== undefined ? codexChildPosture(args.child.initialMode) : draft.preset;
        const created = await startCodexEngine({
          ...options,
          selection: {
            ...(draft.model !== undefined ? { model: draft.model } : {}),
            ...(childPresetId !== undefined ? { presetId: childPresetId } : {}),
            origin: "draft",
          },
        });
        const id = args.sessionId ?? randomUUID();
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
      })());

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
   * TASK.102 CUT-S4 §4.4: the universal-snapshot write an engine child's
   * `flushHistory` performs — a SINGLE write of `connected.engine.
   * historyItems()` into the SAME universal `history_items` table a core
   * child's history lives in, through the existing
   * `WriteBehindHistorySink(persistence, childSessionId)` port (no new
   * persistence method). This is what lets a completed child's "Open" read a
   * non-empty transcript (Sol §3's diagnosis) instead of the native-only
   * shadow tables core's universal Open path never reads.
   *
   * Unreachable for a child session as of TASK.102 S4-codex-cut: the Agent
   * tool's engine-profile routing (packages/core/src/tools/agent.ts) refuses
   * every `engine:"codex"` md-profile before a child session is ever
   * spawned, so `args.child` never carries a codex engine child in practice.
   * The refusal exists because this flush's only source, `historyItems()`,
   * is not a trustworthy transcript at flush time — the authoritative
   * source, `client.request("thread/read")`, sits behind a private field on
   * CodexEngine (frozen). Do not re-enable codex children at the Agent-tool
   * layer without first giving this flush a real flush-time transcript
   * source; this function, the posture map, and the rest of the child boot
   * plumbing below are left in place for that unfreeze, not deleted.
   */
  const codexFlushHistory = async (): Promise<void> => {
    const sink = new WriteBehindHistorySink(persistence!, connected.sessionMeta.id);
    sink.append(connected.engine.historyItems());
    await sink.flushChecked();
  };

  session = new Session({
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
    ...(args.child !== undefined ? { child: buildChildSessionOptions(codexFlushHistory) } : {}),
  });
  console.log(`[host] initialized Codex native thread ${connected.threadId} session=${connected.sessionMeta.id} db=${dbPath}`);
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
async function bootClaudeSession(bootstrap: EngineBootstrap, plugin: EnginePlugin): Promise<void> {
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

  const options = {
    bootstrap,
    broker,
    binaryPath,
    cwd: workspace,
    // Ambient by default (owner pivot): no override here, so ClaudeClient
    // sets no `CLAUDE_CONFIG_DIR` at all and the CLI resolves the SAME
    // `~/.claude` main's doctor diagnosed before it let this tab spawn.
    profileDir: resolveClaudeConfigDir(),
    sourceEnv: process.env,
    // TASK.103: mirror of the codex closure above — same per-call re-read
    // rationale (D-S4-4).
    binaryTrust: (path: string) => checkClaudeBinaryTrustOnDisk(path, process.platform, readTrustedBinaryConsentsSync(hostSettingsPathOverride())),
    ...(processOwnership !== undefined ? { processOwnership } : {}),
  };

  const connected = await (args.resume
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
        const childPresetId = args.child !== undefined ? claudeChildPresetId(args.child.initialMode) : draft.preset;
        const created = await startClaudeEngine({
          ...options,
          selection: {
            ...(draft.model !== undefined ? { model: draft.model } : {}),
            ...(childPresetId !== undefined ? { presetId: childPresetId } : {}),
            origin: "draft",
          },
        });
        return { ...created, sessionMeta: null };
      })());

  const claudeEngine = connected.engine;

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
  // session-row.ts where it is unit-tested).
  const rowId = connected.sessionMeta?.id ?? args.sessionId ?? randomUUID();
  const rowWriter = new ClaudeSessionRowWriter({
    rowId,
    identity: sessionRow,
    rowExists: connected.sessionMeta !== null,
    port: {
      create: (id, row) => persistence!.createSession({ id, ...row } as Parameters<SqlitePersistenceAdapter["createSession"]>[0]),
      touch: (id, patch) => persistence!.touchSession(id, patch as { title?: string; mode?: PermissionMode; model?: string }),
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
  claudeEngine.onFirstSystemInit(() => {
    const settled = claudeEngine.snapshot();
    // The `mode` TEXT column stores the Claude preset id verbatim, the same
    // no-migration arrangement codex uses (cut §2(k).4). Nothing reads this
    // column back as a core PermissionMode for a Claude session.
    rowWriter.materialize({ model: settled.model, mode: settled.activePresetId });
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
  const fs = new NodeFileSystemAdapter();

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

  session = new Session({
    outbound,
    engine: booted.engine,
    // CC-D-min: the RAW ClaudeEngine, Claude's own immediate-apply seam (never
    // codex's choose-now/apply-at-next-turn one — settings-seam.ts).
    engineSettings: new ClaudeSettingsSeam(claudeEngine),
    broker,
    fs,
    workspace,
    model: connected.model,
    sessionId: rowId,
    // The resume projection built above — `[]` for a fresh session, the
    // shadow-mirror transcript (incl. tool_call cards) for a resumed one.
    bootHistory,
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
    ...(args.child !== undefined ? { child: buildChildSessionOptions(claudeFlushHistory) } : {}),
  });
  // Custody (cut §0.2 invariant 2): the ref is a UUID this host generated (or
  // the persisted one, on resume) and the id is our own row id — no account
  // email, token, subscription type or cost figure is ever written to a log line.
  console.log(`[host] initialized Claude native session ${connected.sessionRef} session=${rowId} db=${dbPath}`);
}

async function boot(): Promise<void> {
  try {
    // Selection/probe is deliberately before loadEnvConfig: an external engine
    // must never require AnyCode provider credentials merely to fail/boot.
    const plugin = selectEnginePlugin(process.env);
    engineBootstrap = await beginEngineBootstrap(plugin);
    if (engineBootstrap.id === "codex") {
      await bootCodexSession(engineBootstrap, plugin);
      return;
    }
    // SLICE-CC C4 (cut §1.4): the one new dispatch branch. Everything below
    // stays the core boot path, byte-identical.
    if (engineBootstrap.id === "claude") {
      await bootClaudeSession(engineBootstrap, plugin);
      return;
    }
    const envConfig = loadEnvConfig(process.env);
    const args = parseHostArgs(process.argv.slice(2));

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

    // TASK.138 slice 2: per-run Bash allow-list, a PROCESS INPUT (whoever
    // launched this fork), never a setting — see run-allow-bash.ts's module
    // doc. Parsed once here so the same list feeds both the permission engine
    // below and this startup diagnostic; an unset/empty env var parses to []
    // (RunAllowBashPermissionEngine's own no-op fast path, zero behavior
    // change). Logged unconditionally so a widened run is never silent, even
    // when every configured entry was malformed and none were accepted.
    const runAllowBashEntries = parseRunAllowBash(process.env[ENV_RUN_ALLOW_BASH]);
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

    // Slice P7.15 (F14, design §2.1): mid-session model switch mirrors the CLI
    // `/model` recipe (host-side hot-swap, NOT a respawn). The factory rebuilds a
    // fresh AiSdkModelPort per switch (LanguageModel is built per-attempt, so the
    // factory is cheap; the api key legitimately lives in the closure, precedent
    // A9); `modelPort` stays a SwitchableModelPort wrapper — the ONE object the
    // loop/ContextManager/subagents/titling all capture by reference, so a
    // setPort between turns is instantly visible to every holder. Name/shape are
    // preserved so config/Session/refineTitle are unchanged.
    const modelPortFactory = (m: string): ModelPort =>
      new AiSdkModelPort({
        transport: providerTransport,
        baseUrl: envConfig.baseUrl,
        apiKey: envConfig.apiKey,
        model: m,
        ...(catalogEntry !== undefined ? { providerName: catalogEntry.name } : {}),
        ...(resolveApiKey !== undefined ? { resolveApiKey } : {}),
      }, hostDiagnosticSink);
    const modelPort = new SwitchableModelPort(modelPortFactory(envConfig.model));
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
    const registry =
      args.child === undefined
        ? createDefaultToolRegistry({ agent: { sessionTier: true } })
        : createDefaultToolRegistry();
    const fsAdapter = new NodeFileSystemAdapter();
    const execAdapter = new NodeExecutionAdapter();


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

    historySink = new WriteBehindHistorySink(persistence, sessionMeta.id);
    const tokenizer = await createDefaultTokenizer();
    const bootContextWindow = resolveContextWindow(envConfig.model, catalogEntry, envConfig.contextWindowTokens);
    const bootMaxOutputTokens = resolveMaxOutputTokens(envConfig.model, catalogEntry, envConfig.maxOutputTokens);
    const bootReasoningEffort = resolveReasoningEffort(envConfig.model, catalogEntry, envConfig.reasoningEffort);
    const bootEffortLevels = resolveEffortLevels(envConfig.model, catalogEntry);
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
      const declarations = await loadHookConfigs(fsAdapter, workspace, homedir());
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
      const loaded = await loadLspServerSpecs(fsAdapter, workspace, homedir());
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
      const loadedWebSearch = await loadWebSearchConfig(fsAdapter, workspace, homedir(), process.env);
      webSearchBackend = loadedWebSearch.backend;
      for (const issue of loadedWebSearch.issues) console.warn(`[host] websearch config: ${issue}`);
    } catch (error) {
      console.error(`[host] failed to load websearch config; continuing without WebSearch: ${describeError(error)}`);
    }
    if (webSearchBackend !== null) {
      registry.register(createWebSearchTool(webSearchBackend));
    }

    // Telemetry config (slice 6.6, mirror of the websearch block above): opt-in,
    // fail-soft — an unset/disabled section or a loader failure leaves
    // telemetryConfig null, so the sink below is never built and the default

    let telemetryConfig: ResolvedTelemetryConfig | null = null;
    try {
      const loadedTelemetry = await loadTelemetryConfig(fsAdapter, workspace, homedir(), process.env);
      telemetryConfig = loadedTelemetry.telemetry;
      for (const issue of loadedTelemetry.issues) console.warn(`[host] telemetry config: ${issue}`);
    } catch (error) {
      console.error(`[host] failed to load telemetry config; continuing without telemetry: ${describeError(error)}`);
    }
    let repoMapConfig: RepoMapConfig | null = null;
    try {
      const loadedRepoMap = await loadRepoMapConfig(fsAdapter, workspace, homedir(), process.env);
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
      const loaded = await loadMcpServerSpecs(fsAdapter, workspace, homedir());
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
    // Builtin skills combine every capability-gated set (worktree, preview, ...)
    // into ONE array: discoverExtensions takes a single `builtinSkills` key, so
    // two independent conditional spreads of that same key would silently
    // overwrite each other instead of accumulating (each gate's own boolean
    // still decides whether its skill is IN the combined list at all).
    const builtinSkills: readonly BuiltinSkillDefinition[] = [
      ...(worktreeAvailable ? WORKTREE_BUILTIN_SKILLS : []),
      ...(previewAvailable ? PREVIEW_BUILTIN_SKILLS : []),
      // Subagent port always attached, no capability boolean to mirror
      // (withSubagents always attaches a SubagentPort and Write is always
      // registered — night-track wave-2 cut §1.5).
      ...SUBAGENT_BUILTIN_SKILLS,
    ];
    try {
      ext = await discoverExtensions(fsAdapter, {
        workspace,
        home: resolveExtensionsHomeOverride(process.env) ?? homedir(),
        claimedMcpNames: new Set(mcpSpecs.map((spec) => spec.name)),
        repoMapConfig,
        ...(builtinSkills.length > 0 ? { builtinSkills } : {}),
      });
    } catch (error) {
      console.error(`[host] extensions discovery failed; continuing with zero skills/agent profiles/plugins: ${describeError(error)}`);
    }
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

    // Boot snapshot of tool names for the system prompt's tool-discipline
    // section (design slice-3.6-cut.md §6/§0.2): taken AFTER the MCP block
    // above (success OR fail-soft), so this already includes any
    // mcp__*-bridged tools registered into this SAME registry object — mirrors
    // cli/main.ts's ordering exactly.
    const toolNames = registry.list();

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
    const composeSystemPrompt = (
      components: NonNullable<AgentLoopConfig["systemPromptComponents"]>,
    ): string => buildSystemPrompt({ toolNames, env: systemPromptEnv }) + components.map((c) => c.text).join("");

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
      imageInputEnabled: () => resolveImageInput(currentModel, catalogEntry, envConfig.imageInput),
    };

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
      });
      telemetry = { port, session: sessionMeta.id };
    }

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
      mode,
      ports: {
        fs: fsAdapter,
        exec: execAdapter,
        http: new NodeHttpAdapter(),
        todos: new InMemoryTodoStore(),
      },
      media,
      ...(worktreeAvailable ? { worktrees: worktreeControl } : {}),
      ...(previewAvailable ? { preview: previewPort } : {}),
      cwd: workspace,
      maxTurns: envConfig.maxTurns,
      subagentMaxTurns: envConfig.subagentMaxTurns,
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
      // TASK.27: planExitMode ("build") + onModeChange, produced together with
      // the ExitPlanMode registration above. Without this spread the tool's
      // handler fails closed and plan mode has no model-driven exit at all.
      ...planExit,
      ...(telemetry !== null ? { eventTap: buildTelemetryTap(telemetry.port, telemetry.session) } : {}),
      // Context window (design §2.5 + slice 6.4): resolved above — mirrors cli/main.ts.
      ...(bootContextWindow !== undefined
        ? { context: { contextWindowTokens: bootContextWindow } }
        : {}),
    };
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
    if (!isChildSessionBoot(args, sessionMeta)) {
      config.sessionSubagents = createChildSessionPort({
        parentSessionId: sessionMeta.id,
        getPermissionMode: () => config.mode,
        send: sendChildSessionMessage,
        subscribe: subscribeChildRunEvents,
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
    // shares the one runner semaphore. Absent that port (should not happen
    // here, since withSubagents always attaches one) it attaches nothing and
    // the Workflow tool stays fail-closed "unavailable" — the same posture a
    // child loop sees, since child configs never call either helper.
    // env/memorySection (design slice-3.6-cut.md §2.4/§6) thread the same
    // session-static facts + AGENTS.md memory into every child's harness
    // prelude, so a subagent confabulates tools no more than the parent does.
    //
    // resolveChildModelPort is the SAME modelPortFactory the mid-session
    // `/model` switch uses, so an `Agent(model: …)` override builds a child port
    // from this session's provider/transport/key rather than failing closed.
    // Without it the runner returns "model override is not supported in this
    // host" — the CLI wired this from the start, the desktop host did not.
    //
    // `runEngineChild` (engine-children.ts) is NO LONGER wired here (TASK.102
    // CUT-S4 §0.3): an `engine:` md-profile persona now routes to the
    // session-child path (tools/agent.ts, S4a) instead of a one-shot Claude
    // Code / Codex CLI run. `engine-children.ts` itself stays byte-untouched
    // and importable (deprecated-live, owner-gated removal per spec §10) —
    // only this ONE wiring line is gone, so an engine-profile Agent call from
    // a WORKFLOW step (which cannot reach the session tier) now falls through
    // to runner.ts's existing `runEngineChild === undefined` refusal branch.
    // profiles is a THUNK, not a snapshot: `ext` is reassigned in place by
    // refreshExtensionProfiles below (mirrors the switchModel callback's
    // in-place `config` mutation), so the runner built here re-reads whatever
    // `ext.profiles` currently holds on every listAgentTypes()/run() call — a
    // profile authored into `.anycode/agents/` mid-session becomes a callable
    // agent_type without recreating this AgentLoop.
    const loop = new AgentLoop(
      withWorkflows(
        withSubagents(config, {
          profiles: () => ext.profiles,
          env: systemPromptEnv,
          memorySection: ext.memorySection,
          resolveChildModelPort: modelPortFactory,
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
      // Components AND prompt, same as the switchModel branch below: the
      // accounting split is derived from these components, so assigning only
      // the prompt would leave contextBreakdown() reporting the pre-rescan
      // "profiles" section — the drift composeSystemPrompt() exists to prevent.
      const refreshedSystemPromptComponents = composeSystemPromptComponents();
      config.systemPrompt = composeSystemPrompt(refreshedSystemPromptComponents);
      config.systemPromptComponents = refreshedSystemPromptComponents;
    };

    const sessionId = sessionMeta.id;
    // Slice P7.15 (F14, design §2.1): the narrow mid-session model-switch
    // callback (mirror of the CLI's deps.model.set). It stays host-owned while
    // CoreEngine exposes it through the neutral SessionEngine seam.
    const switchModelImpl = (id: string, selectedTier: ReasoningEffort) => {
        const previous = currentModel;
        modelPort.setPort(modelPortFactory(id));
        currentModel = id;

        // and the rebuilt parent prompt see the new modelId.
        systemPromptEnv.modelId = id;
        // Re-budget (mirror of cli/main.ts:1376-1383): the new model's window
        // takes effect on the very next turn — the manager's compaction threshold
        // and the context_usage denominator follow (loop.setContextWindow), and
        // config.context flows to children spawned after the switch. The env
        // override still wins inside resolveContextWindow; an unknown id falls
        // back to the DEFAULT window (never a stale previous model's window).
        const contextWindow =
          resolveContextWindow(id, catalogEntry, envConfig.contextWindowTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
        config.maxOutputTokens = resolveMaxOutputTokens(id, catalogEntry, envConfig.maxOutputTokens);
        const resolvedEffort = resolveReasoningEffort(id, catalogEntry, selectedTier);
        config.reasoningEffort = resolvedEffort;
        liveContextWindow = contextWindow;
        // Slice P7.17 (F12): rebuild the accounting components too (repoMap/env
        // changed) and derive the fresh prompt from them, so contextBreakdown()
        // never reports a stale split after a model switch.
        const switchedSystemPromptComponents = composeSystemPromptComponents();
        config.systemPrompt = composeSystemPrompt(switchedSystemPromptComponents);
        config.systemPromptComponents = switchedSystemPromptComponents;
        loop.setContextWindow(contextWindow);
        config.context = { ...config.context, contextWindowTokens: contextWindow };
        const availableEffortLevels = resolveEffortLevels(id, catalogEntry);
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
    const engine = new CoreEngine({ loop, config, switchModelImpl, onBeforeTurn: refreshExtensionProfiles });
    const cleanupHandoff = sessionMeta.worktreeCleanup ?? parseCleanupIntent(process.env[WORKTREE_CLEANUP_ENV]);
    session = new Session({
      outbound,
      engine,
      broker,
      fs: fsAdapter,
      workspace,
      projectRoot: sessionMeta.projectRoot ?? sessionMeta.workspace,
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
            },
          }
        : {}),
      // Renderer Panels sub-slice B: static command-hook declarations and
      // fail-soft config-loader errors are surfaced to the renderer.
      hooksList: {
        list: () => hookDeclarations,
        ...(hookConfigError !== undefined ? { configError: hookConfigError } : {}),
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
      ...(args.child !== undefined ? { child: buildChildSessionOptions(() => historySink!.flushChecked()) } : {}),
    });

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
        // Degraded mode: surface the init failure on the first inbound message.
        outbound.attach(wire);
        wire.onMessage(() => {
          if (initFailure) {
            outbound.sendDirect({ type: "fatal", message: initFailure });
          }
        });
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

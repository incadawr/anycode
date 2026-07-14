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
 * proven read-only by the conservative classifier, narrowing ask->allow only)
 * and then a RuleAwarePermissionEngine over it, so a persisted always-allow
 * rule auto-allows a matching tool from the session's very first turn. The SAME
 * rules instance is handed to Session, which appends to it when a
 * `permission_response` carries `remember` on an "allow" (data-plane half of
 * "Always allow"; main's `permission-rule-add` IPC is the control-plane half
 * that persists the rule for future boots, 2.2.2/2.2.4). boot()'s `finally`
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
  RuleAwarePermissionEngine,
  SafeCommandPermissionEngine,
  SessionPermissionRules,
  SqlitePersistenceAdapter,
  SwitchableModelPort,
  WriteBehindHistorySink,
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
  AgentLoopConfig,
  CommandHookDeclaration,
  ExtensionsBootstrap,
  LspServerSpec,
  MediaCapabilityPort,
  McpServerSpec,
  ModelPort,
  PermissionMode,
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
import {
  WORKTREE_CLEANUP_ENV,
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeCleanupIntent as WireWorktreeCleanupIntent,
} from "../shared/worktrees.js";
import {
  buildResolveApiKey,
  hostDiagnosticSink,
  parseHostArgs,
  repairDanglingToolCalls,
  resolveBootSession,
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
import { resolveExtensionsHomeOverride } from "./dev-home.js";
import { buildCheckpointService } from "./checkpoints.js";
import { GitBridge } from "./git-bridge.js";
import { CoreEngine } from "./engines/core-engine.js";
import { beginEngineBootstrap, type EngineBootstrap } from "./engines/bootstrap.js";
import { selectEnginePlugin, type EnginePlugin } from "./engines/registry.js";
import { resumeCodexEngine, startCodexEngine } from "./engines/codex/codex-engine.js";
import { parseCodexEngineArgs } from "./engines/codex/draft-args.js";
import { readHostProcessOwnership } from "./engines/codex/process-ownership.js";
import { SqliteCodexShadowLog } from "./engines/codex/shadow-log.js";
import { ENV_CODEX_BIN } from "../shared/engines.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
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
  const broker = new IpcPermissionBroker(emit);
  const processOwnership = readHostProcessOwnership(
    process.env,
    process.pid,
    (message) => process.parentPort.postMessage(message),
  ) ?? undefined;
  // Shadow command log (cut §2(e), TASK.42): the HOST is the sole writer,
  // from the live `item/*` stream inside CodexEngine — never the renderer.
  const shadowLog = new SqliteCodexShadowLog(persistence);
  const options = {
    bootstrap,
    broker,
    binaryPath,
    cwd: workspace,
    workspace,
    sourceEnv: process.env,
    shadowLog,
    ...(processOwnership !== undefined ? { processOwnership } : {}),
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
        const existing = await persistence!.getSession(args.sessionId);
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
        const created = await startCodexEngine({
          ...options,
          selection: {
            ...(draft.model !== undefined ? { model: draft.model } : {}),
            ...(draft.preset !== undefined ? { presetId: draft.preset } : {}),
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
    rules: new SessionPermissionRules(),
    imageInputEnabled: () => false,
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
  });
  console.log(`[host] initialized Codex native thread ${connected.threadId} session=${connected.sessionMeta.id} db=${dbPath}`);
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
    const registry = createDefaultToolRegistry();
    const fsAdapter = new NodeFileSystemAdapter();
    const execAdapter = new NodeExecutionAdapter();


    // session from argv — create (`--session`) or load (`--resume`, mirror of
    // cli/main.ts:239-259; the initial history is NOT re-appended to the sink).
    const dbPath = envConfig.dbPath ?? join(homedir(), ".anycode", "anycode.sqlite");
    persistence = new SqlitePersistenceAdapter(dbPath);
    const resolvedSession = await resolveBootSession(persistence, {
      args,
      workspace,
      model: envConfig.model,
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
      pluginMcpServerSpecs: [],
      workflows: [],
      workflowsPromptSection: "",
      memorySection: "",
      repoMapFiles: [],
      problems: [],
    };
    try {
      ext = await discoverExtensions(fsAdapter, {
        workspace,
        home: resolveExtensionsHomeOverride(process.env) ?? homedir(),
        claimedMcpNames: new Set(mcpSpecs.map((spec) => spec.name)),
        repoMapConfig,
        ...(worktreeAvailable ? { builtinSkills: WORKTREE_BUILTIN_SKILLS } : {}),
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

    const broker = new IpcPermissionBroker(emit);

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
      permissionEngine: new RuleAwarePermissionEngine(
        new SafeCommandPermissionEngine(new ModePermissionEngine()),
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
      cwd: workspace,
      maxTurns: envConfig.maxTurns,
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
      ...(telemetry !== null ? { eventTap: buildTelemetryTap(telemetry.port, telemetry.session) } : {}),
      // Context window (design §2.5 + slice 6.4): resolved above — mirrors cli/main.ts.
      ...(bootContextWindow !== undefined
        ? { context: { contextWindowTokens: bootContextWindow } }
        : {}),
    };
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
    const loop = new AgentLoop(
      withWorkflows(
        withSubagents(config, { profiles: ext.profiles, env: systemPromptEnv, memorySection: ext.memorySection }),
        ext.workflows,
      ),
    );

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
    const engine = new CoreEngine({ loop, config, switchModelImpl });
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
  if (data && data.type === "shutdown") {
    void handleShutdown();
  }
});

console.log(`[host] started. workspace=${workspace}`);

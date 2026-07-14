/** Configuration primitives and cross-module constants. */

import type { ImageInputOverride } from "../provider/capabilities.js";
import type { ProviderTransport } from "../provider/catalog.js";

export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/** Resolved runtime configuration sourced from environment variables. */
export interface CoreEnvConfig {
  /**
   * API key for the endpoint (ANYCODE_API_KEY). Required (throws) when the
   * resolved transport is `anthropic-messages` or unset; optional for the two
   * OpenAI transports, which may point at a no-auth local endpoint (TASK.43 §0.4).
   */
  apiKey?: string;
  /** Base URL of the endpoint (ANYCODE_BASE_URL); default is the native Anthropic API. */
  baseUrl: string;
  /** Model id to request (ANYCODE_MODEL). */
  model: string;
  /** Turn budget override for the main loop (ANYCODE_MAX_TURNS). */
  maxTurns?: number;
  /** Output-token override (ANYCODE_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  /** Opt-in reasoning budget (ANYCODE_REASONING_EFFORT). */
  reasoningEffort?: ReasoningEffort;
  /** Context window override in tokens (ANYCODE_CONTEXT_WINDOW). */
  contextWindowTokens?: number;
  /** Stream retry budget for the provider adapter; 0 disables retries (ANYCODE_MAX_RETRIES). */
  maxRetries?: number;
  /** SQLite database path override (ANYCODE_DB_PATH); default is ~/.anycode/anycode.sqlite. */
  dbPath?: string;
  /** Parallel cap override for read-only tool batches (ANYCODE_TOOL_CONCURRENCY). */
  toolConcurrency?: number;
  /** Per-attempt stream stall watchdog override in ms; 0 disables it (ANYCODE_STALL_TIMEOUT_MS). */
  stallTimeoutMs?: number;
  /**
   * Explicit image-input override (ANYCODE_IMAGE_INPUT=on|off); undefined when
   * unset or when the value is neither `on` nor `off` (invalid ⇒ warn + ignore).
   */
  imageInput?: ImageInputOverride;
  /**
   * Wire transport override (ANYCODE_PROVIDER_TRANSPORT); undefined when unset.
   * An invalid value throws at load time rather than silently falling back to
   * `anthropic-messages` (TASK.43 §0.4).
   */
  providerTransport?: ProviderTransport;
}

/** Main-loop turn budget when not overridden (subagents get a lower budget in Phase 3). */
export const DEFAULT_MAX_TURNS = 100;

/** Safe fallback for non-Claude model ids missing a catalog output limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/** Default per-tool-call execution timeout enforced by the dispatcher. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Hard cap for the Bash tool's per-call `timeout` input override. */
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** Grace period between SIGTERM and SIGKILL when cancelling child processes. */
export const SIGKILL_GRACE_MS = 750;

/** Default hook execution timeout. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** Default cap on captured child-process output per stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Phase 1 constants (design §2.13)

/** B(2): dispatcher grace on top of the handler timeout; ≥ SIGKILL_GRACE_MS + close/flush. */
export const DISPATCH_TIMEOUT_GRACE_MS = 1_500;

/** Parallel cap inside one tool batch (read-only/concurrentSafe tools only). */
export const DEFAULT_TOOL_CONCURRENCY = 4;

/** Context window assumed when the provider does not say otherwise (env ANYCODE_CONTEXT_WINDOW). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** Tokens reserved for model output when computing the effective window. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 24_000;

/** Auto-compaction fires above this percentage of the effective window. */
export const COMPACT_THRESHOLD_PERCENT = 92;

/** Microcompact starts freeing old tool results above this percentage of the effective window. */
export const MICROCOMPACT_THRESHOLD_PERCENT = 60;

/** Safety buffer subtracted from the effective window when capping the threshold. */
export const COMPACT_BUFFER_TOKENS = 13_000;

/** Floor on the effective window as a fraction of the raw context window, protecting degraded/small windows from collapsing to near-zero (or negative) budgets. */
export const MIN_EFFECTIVE_WINDOW_FRACTION = 0.25;

/** Tail messages kept verbatim by compaction (boundary shifts back to the nearest user item). */
export const COMPACT_KEEP_RECENT_MESSAGES = 10;

/** Microcompact never clears the most recent N tool results. */
export const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;

/** Microcompact is skipped when it would save fewer tokens than this. */
export const MICROCOMPACT_MIN_SAVINGS_TOKENS = 256;

/** Circuit breaker: consecutive compaction failures before compaction is disabled for the session. */
export const MAX_COMPACTION_FAILURES = 3;

/** WebFetch request timeout. */
export const WEBFETCH_TIMEOUT_MS = 30_000;

/** WebFetch raw response cap; the model-visible cap is the tool's maxOutputBytes. */
export const WEBFETCH_MAX_BYTES = 5_000_000;

/** WebFetch in-memory cache TTL (15 minutes). */
export const WEBFETCH_CACHE_TTL_MS = 900_000;

// ---------------------------------------------------------------------------


/** Per-attempt stream stall watchdog: no fullStream part for this long => retryable stall. 0 disables it. */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 90_000;

/** Cap applied to a provider-supplied retry-after delay before it is honored. */
export const DEFAULT_RETRY_AFTER_CAP_MS = 60_000;

// ---------------------------------------------------------------------------
// Phase 3 slice 3.1 constants (subagents, design §3.5)

/** Turn budget cap for a subagent child loop (vs DEFAULT_MAX_TURNS=100 for the parent). */
export const DEFAULT_SUBAGENT_MAX_TURNS = 8;

/** Semaphore width in the subagent runner: at most this many child loops run at once (atop toolConcurrency=4). */
export const MAX_CONCURRENT_SUBAGENTS = 2;

/** Cap on a subagent's finalText carried back in the Agent tool result (= WebFetch precedent). */
export const SUBAGENT_OUTPUT_MAX_BYTES = 100_000;

/**
 * Per-run cap on subagent tool-activity events emitted into the parent stream
 * (slice P7.18/F16b). The activity feed is a bounded live view — once a child
 * loop emits this many tool-activity one-liners the runner stops emitting them;
 * coarse counters (subagent_progress) and start/end are unaffected. The renderer
 * additionally ring-caps its retained rows.
 */
export const SUBAGENT_ACTIVITY_MAX_EVENTS = 500;

/**
 * Cap on a subagent_activity toolName carried onto the wire (slice P7.18/F16b
 * W1-FIX, hardening). Defense-in-depth at the tools/agent.ts trust boundary:
 * any SubagentPort implementation (not just the concrete runner) could push an
 * oversized toolName, so the bridge caps it independently of the runner's own
 * discipline (real tool names are short; this only guards a hostile/buggy port).
 */
export const SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS = 80;

// ---------------------------------------------------------------------------
// Phase 3 slice 3.2 constants (MCP client, design slice-3.2-cut.md §3.3)

/** Per-server MCP connect timeout; servers connect in parallel, fail-soft. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** Per-call MCP timeout (= DEFAULT_TOOL_TIMEOUT_MS); its own knob for tuning. */
export const MCP_CALL_TIMEOUT_MS = 120_000;

/* */
export const MCP_DISPOSE_DEADLINE_MS = 2_000;

/* */
export const MCP_MAX_TOOLS_PER_SERVER = 32;

/** Per-server declaration byte budget: Σ(name+description+schema). */
export const MCP_DECL_BUDGET_BYTES_PER_SERVER = 32_768;

/** Cap on a single MCP tool's description. */
export const MCP_TOOL_DESCRIPTION_MAX_BYTES = 2_048;

/** Cap on a model-visible MCP tool result (metadata.maxOutputBytes; = WebFetch/3.1 precedent). */
export const MCP_RESULT_MAX_BYTES = 100_000;

/** Ring-buffer cap on captured stderr from a stdio MCP server (diagnostics). */
export const MCP_STDERR_CAP_BYTES = 8_192;

// ---------------------------------------------------------------------------
// Phase 3 slice 3.3 constants (skills + agent-profiles + plugins-lite, design §2.10)

/* */
export const SKILLS_PROMPT_SECTION_MAX_CHARS = 8_000;

/** Cap on a skill body loaded by the Skill tool (model input). */
export const SKILL_BODY_MAX_BYTES = 65_536;

/** Cap on a skill/profile name; the name must also match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$. */
export const SKILL_NAME_MAX_CHARS = 64;

/** Cap on a skill description advertised in the prompt section. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1_024;

/** Cap on the total number of skills after dedupe across all sources. */
export const MAX_SKILLS = 64;

/** Cap on the total number of agent profiles after dedupe across all sources. */
export const MAX_AGENT_PROFILES = 32;

/** Cap on an agent profile body used as the child subagent's system prompt. */
export const AGENT_PROFILE_PROMPT_MAX_BYTES = 32_768;

/** Cap on the number of local plugins discovered. */
export const MAX_PLUGINS = 16;

// ---------------------------------------------------------------------------
// Phase 3 slice 3.4 constants (workflow engine, design §2.4)

/** Cap on the total number of workflows after dedupe across all sources. */
export const MAX_WORKFLOWS = 32;

/** Cap on the number of steps in one workflow definition. */
export const MAX_WORKFLOW_STEPS = 16;

/** Per-step wall-clock timeout (= Agent-tool precedent); armed on the child's actual start, not on enqueue. */
export const WORKFLOW_STEP_TIMEOUT_MS = 600_000;

/** Workflow tool metadata.timeoutMs: the hard dispatcher wall for the whole run. */
export const WORKFLOW_TOOL_TIMEOUT_MS = 1_800_000;

/** Cap on a run's rendered output (= 3.1/3.2 precedent). */
export const WORKFLOW_OUTPUT_MAX_BYTES = 100_000;

/** Cap on a step's substituted prompt (2×SUBAGENT_OUTPUT_MAX_BYTES). */
export const WORKFLOW_STEP_PROMPT_MAX_BYTES = 200_000;

/** Cap on a raw promptTemplate/outputTemplate in a definition. */
export const WORKFLOW_TEMPLATE_MAX_BYTES = 16_384;

/* */
export const WORKFLOWS_PROMPT_SECTION_MAX_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Phase 3 slice 3.6 constants (prompt phase, design §2.6)

/** Cap on one AGENTS.md memory file (project + user = two files maximum). */
export const MEMORY_FILE_MAX_BYTES = 32_768;

/* */
export const SYSTEM_PROMPT_SOFT_MAX_CHARS = 12_000;

// ---------------------------------------------------------------------------
// Phase 6 slice 6.4-R1 constants (opt-in repository map)

/** Fraction of the active model context window available to the repository map. */
export const REPO_MAP_WINDOW_FRACTION = 0.02;

/** Lower and upper bounds for the model-aware repository-map token budget. */
export const REPO_MAP_MIN_TOKENS = 500;
export const REPO_MAP_MAX_TOKENS = 8_000;

/** Structural bounds which also terminate directory-symlink cycles. */
export const REPO_MAP_MAX_FILES = 20_000;
export const REPO_MAP_MAX_DEPTH = 24;

/** Only the highest-priority text files are read to calculate line counts. */
export const REPO_MAP_ENRICH_TOP_N = 400;

/** Directory names skipped at every depth by the repository-map walker. */
export const REPO_MAP_IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "out",
  "target",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "Pods",
  ".gradle",
  "DerivedData",
]);

// ---------------------------------------------------------------------------
// Phase 3 slice 3.7 constants (agent-profiles discoverability, design §2.5)

/** Cap on the agent-profiles section injected into the system prompt (short name+description lines — order of magnitude of the workflows section). */
export const PROFILES_PROMPT_SECTION_MAX_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Phase 5 slice 5.5 constants (background/long tasks, design §2-A5)

/** Cap on concurrently RUNNING background tasks per session (a finished task frees a slot; the cap is on running, not total). */
export const MAX_CONCURRENT_BACKGROUND_TASKS = 8;

/** Safety-net wall-clock for a background task with no explicit Bash `timeout` (6h); an explicit input wins. Guards forgotten dev-servers while the session lives. */
export const BACKGROUND_TASK_TIMEOUT_MS = 21_600_000;

/** Per-task captured-output cap (= DEFAULT_MAX_OUTPUT_BYTES, but its own knob for tuning). */
export const BACKGROUND_TASK_BUFFER_MAX_BYTES = 262_144;

/** disposeAll bound: abort every live task and await reaping up to this deadline before the session exits (SIGTERM->SIGKILL 750ms fits with slack). */
export const BACKGROUND_DISPOSE_DEADLINE_MS = 3_000;

// ---------------------------------------------------------------------------
// Phase 6 slice 6.1 constants (LSP v1: diagnostics-after-edit, design §2-A4)

/** Cap on concurrently spawned language servers per session; extra specs beyond this are ignored with a load-time warning. */
export const LSP_MAX_SERVERS = 4;

/** initialize-handshake budget: a server that does not reply within this is marked `crashed`. */
export const LSP_INIT_TIMEOUT_MS = 15_000;

/** Bounded-wait for one edit's diagnostics publish (absorbs an in-flight init if one is still catching up). */
export const LSP_DIAGNOSTICS_TIMEOUT_MS = 3_000;

/** Polite shutdown window (shutdown/exit) before the kill path takes over. */
export const LSP_SHUTDOWN_GRACE_MS = 1_000;

/** Overall bound on disposeAll (mirror of BACKGROUND_DISPOSE_DEADLINE_MS). */
export const LSP_DISPOSE_DEADLINE_MS = 3_000;

/* */
export const LSP_MESSAGE_MAX_BYTES = 4_194_304;

/** Cap on diagnostics items rendered into the model-visible tool result. */
export const LSP_DIAGNOSTICS_MAX_ITEMS = 20;

/** Ring-buffer cap on captured stderr from a language server (diagnostics/`/lsp`). */
export const LSP_STDERR_TAIL_BYTES = 8_192;

// ---------------------------------------------------------------------------
// Phase 6 slice 6.2 constants (multimodal image input, design §2-A8)

/** Per-image raw-byte cap before base64 encoding; ×4/3 base64 ≈ 5MB, the anthropic-kind per-image API ceiling. */
export const IMAGE_MAX_BYTES = 3_750_000;

/** Cap on image attachments carried by one message / one staging batch. */
export const IMAGE_MAX_PER_MESSAGE = 8;

/** Flat per-image token estimate; a conservative ceiling of the anthropic vision formula (w×h)/750 — overestimating means earlier compaction, the safe direction. */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

// ---------------------------------------------------------------------------
// Phase 6 slice 6.3 constants (WebSearch, design slice-6.3-cut.md §2-A1)

/** WebSearch request timeout. */
export const WEBSEARCH_TIMEOUT_MS = 15_000;

/** WebSearch raw response cap in bytes (search-result JSON is small; guards against a hostile/misconfigured backend). */
export const WEBSEARCH_MAX_BYTES = 1_000_000;

/** Hard upper bound on requested/returned result count, regardless of config or model input. */
export const WEBSEARCH_MAX_RESULTS = 10;

/** Result count used when neither the model's `max_results` nor the resolved backend's `maxResults` override applies. */
export const WEBSEARCH_DEFAULT_MAX_RESULTS = 5;

/** Cap on a single result's snippet (description/content). */
export const WEBSEARCH_SNIPPET_MAX_CHARS = 1_000;

/** WebSearch tool metadata.maxOutputBytes: the model-visible cap on the serialized result set. */
export const WEBSEARCH_MAX_OUTPUT_BYTES = 50_000;

// ---------------------------------------------------------------------------
// Phase 6 slice 6.6 constants (Telemetry, design slice-6.6-cut.md §2-B4)

/** Cap on records queued but not yet appended; record() drops (dropped++) once reached. */
export const TELEMETRY_MAX_PENDING = 1_000;

/** Defense-in-depth cap on one serialized JSONL line in bytes; a whitelist record serializes to ~200B, so this only guards against a future mapper bug. */
export const TELEMETRY_MAX_RECORD_BYTES = 8_192;

/** Bounded flush-and-close deadline on session exit (raceWithTimeout). */
export const TELEMETRY_DISPOSE_DEADLINE_MS = 2_000;

// ---------------------------------------------------------------------------
// Phase 7 slice P7.22 constants (Profile stats aggregator, design slice-P7.22-cut.md §2-D3/D4)

/** Total-scan byte cap for aggregateProfileStats (§2-D1): files are processed in
 *  sorted-name order; once cumulative processed-line bytes exceed this, the scan
 *  stops early and `truncated: true` is reported rather than blocking on an
 *  unbounded telemetry dir. */
export const PROFILE_STATS_MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Per-gap cap applied when summing a session's inter-record active duration
 *  (§2-D3.3): an idle-open tab must not inflate "longest session" — any gap
 *  between two consecutive records longer than this counts as only this much. */
export const PROFILE_ACTIVITY_GAP_CAP_MS = 5 * 60 * 1000;

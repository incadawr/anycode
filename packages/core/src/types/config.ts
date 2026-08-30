/** Configuration primitives and cross-module constants. */

import type { ImageInputOverride } from "../provider/capabilities.js";
import type { ProviderTransport } from "../provider/catalog.js";
import type { ToolResultBudget } from "./tools.js";

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
  /** Turn budget override for subagent child loops (ANYCODE_SUBAGENT_MAX_TURNS). */
  subagentMaxTurns?: number;
  /**
   * Subagent stall-detector silence threshold override in ms (TASK.148 slice 1,
   * ANYCODE_SUBAGENT_STALL_MS). NOT the per-attempt stream watchdog
   * (`stallTimeoutMs` below, ANYCODE_STALL_TIMEOUT_MS) — this one bounds how
   * long a whole child run may go without a progress signal before a
   * subagent_stalled report (never a kill) is emitted.
   */
  subagentStallTimeoutMs?: number;
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
  /**
   * Explicit usage-streaming override (ANYCODE_INCLUDE_USAGE; TASK.158):
   * `1/true/on` → true, `0/false/off` → false, invalid ⇒ warn + ignore.
   * Undefined means "no opinion" — the transport-conditional DEFAULT is
   * applied by `resolveIncludeUsage`, never here.
   */
  includeUsage?: boolean;
}

/** Main-loop turn budget when not overridden (subagents get a lower budget in Phase 3). */
export const DEFAULT_MAX_TURNS = 100;

/**
 * Fallback for non-Claude model ids missing a catalog output limit (TASK.150).
 *
 * This is the value EVERY on-prem / free-text model id lands on: the `vllm`,
 * `custom` and `openrouter` catalog entries carry `models: []` by construction
 * (free-text ids only), so no model behind them can ever match a catalog hint.
 * The former 8_192 was low enough that a reasoning model — a self-hosted Qwen3,
 * whose thinking is on by default — spent the entire budget inside `<think>`
 * and finished at `length` before emitting one visible character: on the OpenAI
 * transports this number IS the wire `max_tokens`, and reasoning is billed
 * against it, not beside it.
 *
 * 32_768 is the measured peer default: ZCode 3.2.3 falls back to 32_000 for an
 * unknown model, Claude Code 2.1.241 to 32_000 (upper 128_000); Codex sends no
 * output cap at all and lets the server pick. Kept as a power of two to match
 * the catalog's own values.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

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

/**
 * Model-visible result budget applied by the dispatcher to any tool that
 * declares no `metadata.resultBudget` (TASK.93). The point of a default is that
 * there is no "unbounded" branch to fall into: a tool omitting the field is
 * bounded, not exempt.
 */
export const DEFAULT_TOOL_RESULT_BUDGET = {
  maxModelBytes: 100_000,
  previewDirection: "head",
} as const satisfies ToolResultBudget;

/** Model-visible cap on a Bash result; the tail is what carries the verdict. */
export const BASH_RESULT_MAX_MODEL_BYTES = 30_000;

/** Inline cap on captured Bash output per stream — the host's buffer, not the model's. */
export const BASH_EXEC_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * Token ceiling on a single Read result (TASK.93 §4). The budget that matters
 * for a file read is what the model is charged, not what the file weighs.
 */
export const READ_MAX_TOKENS = 25_000;

/**
 * Share of READ_MAX_TOKENS a partial view targets. The headroom absorbs the
 * continuation notice and the line numbering a renderer may add.
 */
export const READ_PARTIAL_VIEW_RATIO = 0.85;

/**
 * Byte ceiling on the content of one Read result. Sits under
 * DEFAULT_TOOL_RESULT_BUDGET with room for the JSON framing and the
 * continuation notice, so a partial view is never cut a second time by the
 * dispatcher's budget.
 */
export const READ_CONTENT_MAX_BYTES = 90_000;

/** Model-visible cap on a bridged MCP result (the inline cap is MCP_RESULT_MAX_BYTES). */
export const MCP_RESULT_MAX_MODEL_BYTES = 50_000;

// ---------------------------------------------------------------------------
// TASK.94 constants (artifact spill)

/**
 * Age ceiling on a session's artifact directory, enforced by the start-up
 * sweep. It is the only GUARANTEED collector: "session ended" has no single
 * point in this codebase, so an unswept root would otherwise grow without
 * bound across crashes and long-lived hosts.
 */
export const ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-write cap on one persisted tool artifact. The strategy is declared by the
 * tool's own metadata, so a buggy or hostile tool could otherwise make the HOST
 * write unbounded bytes; over this cap the store refuses and the dispatcher
 * falls back to truncation.
 */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Byte ceiling on the preview embedded in the persisted-output envelope. Small
 * on purpose: the envelope must fit inside the tool's model budget by
 * construction, not by being cut a second time.
 */
export const ARTIFACT_PREVIEW_BYTES = 2_000;

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

/**
 * Default turn budget for a subagent child loop (vs DEFAULT_MAX_TURNS=100 for
 * the parent). This is a DEFAULT, not a ceiling: an explicit request or the
 * `subagentMaxTurns` setting raises it, bounded only by
 * SUBAGENT_MAX_TURNS_CEILING.
 *
 * The value was 8 from the alpha baseline through 2026-08-16, and 8 was also
 * hard-clamped in the runner, so recon over a handful of files routinely died
 * at `max_turns` with no reachable way to raise it (the Agent tool declares no
 * maxTurns and the `tools.maxTurns` setting feeds the PARENT loop only).
 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 40;

/**
 * Hard ceiling on a subagent turn budget — the runaway guard that the default
 * above used to double as. Only bounds an EXPLICIT request (workflow step or
 * settings override); it is never the value a caller gets by omission.
 */
export const SUBAGENT_MAX_TURNS_CEILING = 200;

/**
 * The Agent tool's dispatcher wall for one spawn, and the outer bound the two
 * deadlines below are carved out of.
 *
 * What bounds a subagent is its TURN budget (DEFAULT_SUBAGENT_MAX_TURNS plus
 * the TASK.124 ladder), not the clock. This wall was 600_000, and at that size
 * it did not act as a backstop — it was the thing that decided a run. An inline
 * child was cut mid-work at eight minutes; a session child, which is a separate
 * host process with its own turn ceiling, its own permission prompts and a
 * human in front of it, derives no deadline from this constant at all, so the
 * wall was its ONLY clock and ten minutes spent waiting for a person to answer
 * a permission dialog spent the entire budget (TASK.148).
 *
 * No reference implementation bounds a subagent by wall-clock work time; they
 * watch for absence of PROGRESS instead. Until that detector exists here, the
 * wall is sized so it can only ever catch a genuinely hung child: the same 6h
 * as BACKGROUND_TASK_TIMEOUT_MS, the number this codebase already uses for
 * "long-running work, not a stall".
 */
export const SUBAGENT_TIME_BUDGET_MS = 21_600_000;

/**
 * A child loop must not START another model step after this much elapsed time
 * from SubagentPort.run entry (pre-semaphore — the dispatcher bills a queued
 * child from the moment its handler is called, so a child parked behind
 * siblings is only entitled to the remainder). Held two minutes under the wall
 * so the wrap-up rescue still has a window when the wall is what ends the run.
 */
export const SUBAGENT_LOOP_DEADLINE_MS = 21_480_000;

/** Ceiling on the wrap-up model call. */
export const SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS = 60_000;

/**
 * The outcome must be on its way back by this elapsed time (10s reserve under
 * SUBAGENT_TIME_BUDGET_MS for SubagentStop observers + plumbing).
 */
export const SUBAGENT_OUTCOME_DEADLINE_MS = 21_590_000;

/** Below this remaining window the wrap-up call is skipped entirely. */
export const SUBAGENT_WRAPUP_MIN_WINDOW_MS = 15_000;

/**
 * Silence threshold for the subagent STALL detector (TASK.148 slice 1,
 * subagents/stall-clock.ts). Distinct from — and never confused with —
 * ANYCODE_STALL_TIMEOUT_MS/DEFAULT_STREAM_STALL_TIMEOUT_MS above: that one
 * watches a single provider HTTP stream; this one watches a whole child RUN
 * for the absence of any progress signal (a model step finishing, a tool
 * result landing), never total work time, and never the wall-clock walls
 * above (SUBAGENT_TIME_BUDGET_MS and friends stay the untouched backstop).
 *
 * 10 minutes — 36x shorter than the 6h SUBAGENT_TIME_BUDGET_MS backstop — so a
 * genuinely hung child is noticed in minutes instead of at nightfall, while a
 * legitimately long single tool call merely produces one honest "silent for
 * 10 minutes, currently running X" report rather than a kill: the detector
 * REPORTS, it never aborts the run (design owner's framing, TASK.148: "разве
 * это агент должен килять?"). Configurable via ANYCODE_SUBAGENT_STALL_MS.
 */
export const SUBAGENT_STALL_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// TASK.124 constants (turn-ceiling decision ladder)

/**
 * How many times ONE session's turn ceiling may be extended by the decision
 * ladder. The bound is per session, not per `runTurn` call: the ladder state
 * lives on the AgentLoop, so a follow-up user message cannot reset the counter
 * and walk the ladder a second time.
 */
export const MAX_CEILING_ROUNDS = 3;

/**
 * Window for ONE ceiling-verdict model call. Half of
 * SUBAGENT_WRAPUP_MODEL_TIMEOUT_MS on purpose: the question is narrower (one
 * structured tool call, no prose report), and the answer gates a decision the
 * user is waiting on.
 */
export const CEILING_DECISION_TIMEOUT_MS = 30_000;

/**
 * Below this much remaining wall-clock budget the ceiling decision call is not
 * made at all. A verdict that cannot come back in time is worth less than the
 * stop it would delay — fail closed instead of spending the remainder.
 */
export const CEILING_MIN_WINDOW_MS = 10_000;

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

/**
 * Persisted subagent card constants (TASK.102 slice S1, CUT-S1 §2.2). The ring
 * cap MUST equal the renderer's own SUBAGENT_ACTIVITY_RING (store.ts) — the S1
 * renderer test asserts this equality directly (a parity test, not a shared
 * import) so a future drift between the two is caught by the compiler, not by
 * eyes: after a reload, "+N earlier" must never read shorter than the live feed.
 */
export const SUBAGENT_CARD_ACTIVITY_RING = 100;
/** Combined UTF-8 byte cap across all retained activity entries' toolName+summary. */
export const SUBAGENT_CARD_ACTIVITY_MAX_BYTES = 32_768;
export const SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS = 100;
export const SUBAGENT_CARD_DESCRIPTION_MAX_CHARS = 500;
export const SUBAGENT_CARD_MODEL_MAX_CHARS = 200;

/**
 * TASK.145 срез 1 (cli/child-notification.ts): cap on a detached child's
 * report `summary` field inside the `<task-notification>` block delivered to
 * the parent session. Bigger than a card description (500) — this is a real
 * digest of what the child did/found, not a one-line label — but far below
 * SUBAGENT_OUTPUT_MAX_BYTES (100_000): the notification must stay a "short
 * report", never the child's full raw output (spec §7's "path, not content"
 * discipline — the parent opens the child's own tab for the full transcript).
 */
export const CHILD_NOTIFICATION_SUMMARY_MAX_CHARS = 2_000;

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

/**
 * Per-step wall-clock timeout, armed on the child's actual start, not on
 * enqueue. Stands on its own: it no longer tracks SUBAGENT_TIME_BUDGET_MS,
 * because a workflow run as a whole is already bounded by
 * WORKFLOW_TOOL_TIMEOUT_MS and a step may not outlive it.
 */
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
 *  unbounded telemetry dir.
 *
 *  TASK.187 gives the same number a second role in the incremental scan layer:
 *  there it bounds the NEW bytes read per pass (files already covered by the
 *  partial cache are not opened at all, so a warm pass reads far less), and it
 *  doubles as the per-file ceiling. Inside `aggregateProfileStats` the meaning
 *  is unchanged — it is the default of the additive `byteBudget` option. */
export const PROFILE_STATS_MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** TASK.187: cap on how many not-yet-cached sink files one incremental pass may
 *  open. The owner's directory holds ~60 000 files at ~1.1 KiB each and the cost
 *  is dominated by the open() count, not by bytes; this bounds a cold first pass
 *  and lets the rest be finished by later passes (the backlog). */
export const PROFILE_STATS_MAX_NEW_READS_PER_PASS = 24_000;

/** TASK.187: refuse to load a profile-stats cache file larger than this. The
 *  cache is idempotently rebuildable, so an oversized/garbage file is discarded
 *  rather than trusted. */
export const PROFILE_STATS_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Per-gap cap applied when summing a session's inter-record active duration
 *  (§2-D3.3): an idle-open tab must not inflate "longest session" — any gap
 *  between two consecutive records longer than this counts as only this much. */
export const PROFILE_ACTIVITY_GAP_CAP_MS = 5 * 60 * 1000;

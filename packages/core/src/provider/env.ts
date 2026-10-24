/** Environment-based configuration for the Phase 0 single-provider setup. */

import type { ProviderTransport } from "./catalog.js";
import type { CoreEnvConfig, ReasoningEffort } from "../types/config.js";
import type { ImageInputOverride } from "./capabilities.js";

export const ENV_API_KEY = "ANYCODE_API_KEY";
export const ENV_BASE_URL = "ANYCODE_BASE_URL";
export const ENV_MODEL = "ANYCODE_MODEL";
/**
 * Default model id for the built-in explore persona's inline children
 * (Taskana 4131): recon sweeps many files and needs little intelligence, so
 * they can run on a cheaper model. Absent/blank ⇒ explore inherits the
 * parent's port (byte-identical to pre-4131). NOT validated against any
 * catalog here — the runner's resolveChildModelPort owns id validation and
 * turns an unresolvable id into an honest error-outcome.
 */
export const ENV_EXPLORE_MODEL = "ANYCODE_EXPLORE_MODEL";
export const ENV_MAX_TURNS = "ANYCODE_MAX_TURNS";
export const ENV_SUBAGENT_MAX_TURNS = "ANYCODE_SUBAGENT_MAX_TURNS";
/**
 * Subagent stall-detector silence threshold (TASK.148 slice 1). Deliberately a
 * DIFFERENT name from ENV_STALL_TIMEOUT_MS below (ANYCODE_STALL_TIMEOUT_MS) —
 * that one is the per-attempt HTTP stream watchdog; this one bounds silence
 * across a whole subagent run.
 */
export const ENV_SUBAGENT_STALL_MS = "ANYCODE_SUBAGENT_STALL_MS";
/** Stale-plan reminder period in tool calls (Taskana 4665); 0 disables. */
export const ENV_TODO_REMINDER_EVERY = "ANYCODE_TODO_REMINDER_EVERY";
/**
 * Supervisor idle-watchdog first-reminder threshold (taskana 4181). Distinct
 * from BOTH stall vars: ANYCODE_STALL_TIMEOUT_MS is the per-attempt HTTP
 * stream watchdog, ANYCODE_SUBAGENT_STALL_MS bounds a RUNNING child's silence;
 * this one bounds how long an idle supervisor (turn ended, no live detached
 * children, no terminal marker) sits before a reminder turn.
 */
export const ENV_SUPERVISOR_IDLE_MS = "ANYCODE_SUPERVISOR_IDLE_MS";
export const ENV_MAX_OUTPUT_TOKENS = "ANYCODE_MAX_OUTPUT_TOKENS";
export const ENV_REASONING_EFFORT = "ANYCODE_REASONING_EFFORT";
export const ENV_CONTEXT_WINDOW = "ANYCODE_CONTEXT_WINDOW";
/** Model binding for ANYCODE_CONTEXT_WINDOW (TASK.142): the pair is model-specific. */
export const ENV_CONTEXT_WINDOW_MODEL = "ANYCODE_CONTEXT_WINDOW_MODEL";
export const ENV_MAX_RETRIES = "ANYCODE_MAX_RETRIES";
/**
 * Transient-network retry wall-clock budget in ms (Taskana 4705). While a
 * pre-content failure is a transient NETWORK error and less than this much
 * time has passed since the step's first failure, retrying continues past
 * ANYCODE_MAX_RETRIES. 0 disables the extension.
 */
export const ENV_NETWORK_RETRY_BUDGET_MS = "ANYCODE_NETWORK_RETRY_BUDGET_MS";
export const ENV_DB_PATH = "ANYCODE_DB_PATH";
export const ENV_TOOL_CONCURRENCY = "ANYCODE_TOOL_CONCURRENCY";
export const ENV_STALL_TIMEOUT_MS = "ANYCODE_STALL_TIMEOUT_MS";
export const ENV_IMAGE_INPUT = "ANYCODE_IMAGE_INPUT";
/**
 * 4088-on-4118 integration: the former ENV_IMAGE_INPUT_MODELS declaration is
 * GONE — the live image-modality facts ride 4118's modelCapabilities map
 * (`imageInput?: true` per model) instead of the fork env.
 */
/**
 * Taskana 4088: the active connection's per-model image-input override as ONE
 * value `<on|off>:<modelId>` (value and binding travel in a single var so they
 * can never be half-inherited). The host applies it ONLY while the session's
 * current model equals the bound id, so a mid-session switch to another model
 * falls back to the live/catalog rungs.
 */
export const ENV_IMAGE_INPUT_MODEL_OVERRIDE = "ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE";
export const ENV_PROVIDER_TRANSPORT = "ANYCODE_PROVIDER_TRANSPORT";
export const ENV_INCLUDE_USAGE = "ANYCODE_INCLUDE_USAGE";
/** TASK.4721: adaptive turn budget (boolean; mirror of `tools.adaptiveTurnBudget`). */
export const ENV_ADAPTIVE_TURN_BUDGET = "ANYCODE_ADAPTIVE_TURN_BUDGET";

const PROVIDER_TRANSPORT_VALUES: readonly ProviderTransport[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * `CoreEnvConfig` plus the model binding for the context-window override
 * (TASK.142). Declared here rather than in `types/config.ts` so the added field
 * stays entirely inside `provider/**`.
 */
export type ModelBoundCoreEnvConfig = CoreEnvConfig & { contextWindowModel?: string };

/**
 * Parses ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE (Taskana 4088) — the drawer's
 * per-model override as ONE `<on|off>:<modelId>` value. Non-fatal: a bad
 * value parses to undefined, never throws.
 */
export function parseImageInputModelOverride(
  raw: string | undefined,
): { override: "on" | "off"; model: string } | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const colon = raw.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const value = raw.slice(0, colon).trim().toLowerCase();
  const model = raw.slice(colon + 1).trim();
  if ((value !== "on" && value !== "off") || model === "") {
    return undefined;
  }
  return { override: value, model };
}


/**
 * Reads ANYCODE_API_KEY, ANYCODE_BASE_URL (default: native Anthropic),
 * ANYCODE_MODEL (required), and the optional integers ANYCODE_MAX_TURNS /
 * ANYCODE_MAX_OUTPUT_TOKENS / ANYCODE_CONTEXT_WINDOW / ANYCODE_MAX_RETRIES /
 * ANYCODE_NETWORK_RETRY_BUDGET_MS (Taskana 4705 — the transient-network retry
 * wall-clock budget that extends past ANYCODE_MAX_RETRIES) /
 * ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS / ANYCODE_SUBAGENT_STALL_MS
 * (TASK.148 slice 1 — the subagent silence detector, distinct from the stream
 * watchdog) / ANYCODE_TODO_REMINDER_EVERY (Taskana 4665 — the stale-plan
 * reminder period in tool calls) / ANYCODE_SUPERVISOR_IDLE_MS (taskana 4181 — the supervisor idle
 * watchdog, distinct from both; must be a POSITIVE integer, a nonpositive
 * value throws) plus ANYCODE_DB_PATH.
 * ANYCODE_CONTEXT_WINDOW_MODEL (TASK.142) is an optional nonblank model id that
 * binds the ANYCODE_CONTEXT_WINDOW override to one model (the pair is emitted
 * together by the host/CLI); a blank/absent value leaves the override global.
 * ANYCODE_EXPLORE_MODEL (Taskana 4131) is an optional nonblank default model
 * id for the built-in explore persona's inline children; blank/absent ⇒
 * explore inherits the parent's model.
 * ANYCODE_REASONING_EFFORT is an optional off|low|medium|high|max selector
 * (per-model levels are gated downstream by the catalog; unsupported → off).
 * ANYCODE_PROVIDER_TRANSPORT selects the wire protocol (TASK.43 §0.4); an
 * invalid value throws (never a silent anthropic fallback). ANYCODE_API_KEY is
 * required when the resolved transport is undefined or `anthropic-messages`
 * (byte-compat: that path is fail-closed), and optional for the two OpenAI
 * transports (no-auth local endpoints). ANYCODE_INCLUDE_USAGE is an optional
 * boolean override of the `stream_options.include_usage` default (TASK.158);
 * it is carried verbatim — the transport-conditional DEFAULT is applied by
 * `resolveIncludeUsage`, not here, so unset stays undefined.
 * Throws a descriptive error naming the offending variable.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): ModelBoundCoreEnvConfig {
  const providerTransport = readProviderTransport(env);

  const apiKeyRequired = providerTransport === undefined || providerTransport === "anthropic-messages";
  const rawApiKey = env[ENV_API_KEY];
  const apiKey = rawApiKey && rawApiKey.trim() !== "" ? rawApiKey : undefined;
  if (apiKeyRequired && apiKey === undefined) {
    throw new Error(`Missing required environment variable: ${ENV_API_KEY} (Anthropic-compatible API key)`);
  }

  const model = env[ENV_MODEL];
  if (!model) {
    throw new Error(`Missing required environment variable: ${ENV_MODEL} (model id to request)`);
  }

  const rawBaseUrl = env[ENV_BASE_URL];
  const baseUrl = rawBaseUrl && rawBaseUrl.trim() !== "" ? rawBaseUrl : DEFAULT_BASE_URL;

  const maxTurns = readOptionalInteger(env, ENV_MAX_TURNS);
  const subagentMaxTurns = readOptionalInteger(env, ENV_SUBAGENT_MAX_TURNS);
  const subagentStallTimeoutMs = readOptionalInteger(env, ENV_SUBAGENT_STALL_MS);
  const supervisorIdleMs = readPositiveInteger(env, ENV_SUPERVISOR_IDLE_MS);
  const maxOutputTokens = readOptionalInteger(env, ENV_MAX_OUTPUT_TOKENS);
  const contextWindowTokens = readOptionalInteger(env, ENV_CONTEXT_WINDOW);
  const contextWindowModel = env[ENV_CONTEXT_WINDOW_MODEL]?.trim() || undefined;
  const exploreModel = env[ENV_EXPLORE_MODEL]?.trim() || undefined;
  const maxRetries = readOptionalInteger(env, ENV_MAX_RETRIES);
  const networkRetryBudgetMs = readOptionalInteger(env, ENV_NETWORK_RETRY_BUDGET_MS);
  const toolConcurrency = readOptionalInteger(env, ENV_TOOL_CONCURRENCY);
  const stallTimeoutMs = readOptionalInteger(env, ENV_STALL_TIMEOUT_MS);
  const todoReminderEvery = readOptionalInteger(env, ENV_TODO_REMINDER_EVERY);

  const rawDbPath = env[ENV_DB_PATH];
  const dbPath = rawDbPath && rawDbPath.trim() !== "" ? rawDbPath : undefined;

  const imageInput = readImageInputOverride(env);
  const reasoningEffort = readReasoningEffort(env);
  const includeUsage = readOptionalBoolean(env, ENV_INCLUDE_USAGE);
  const adaptiveTurnBudget = readOptionalBoolean(env, ENV_ADAPTIVE_TURN_BUDGET);

  return {
    apiKey,
    baseUrl,
    model,
    maxTurns,
    subagentMaxTurns,
    adaptiveTurnBudget,
    subagentStallTimeoutMs,
    supervisorIdleMs,
    maxOutputTokens,
    reasoningEffort,
    contextWindowTokens,
    contextWindowModel,
    exploreModel,
    maxRetries,
    networkRetryBudgetMs,
    dbPath,
    toolConcurrency,
    stallTimeoutMs,
    todoReminderEvery,
    imageInput,
    providerTransport,
    includeUsage,
  };
}

/**
 * Parses ANYCODE_PROVIDER_TRANSPORT (TASK.43 §0.4/W4). Unlike
 * ANYCODE_IMAGE_INPUT, an unrecognized value THROWS rather than warning and
 * falling back: a typo here must never silently route an OpenAI endpoint
 * through the anthropic-messages transport (the exact 400/404-class bug this
 * discriminant exists to prevent). Mirrors the throw-on-bad-integer style of
 * `readOptionalInteger`. A bare "openai" is not one of the three literal
 * transports and is rejected the same way as any other invalid value.
 */
function readProviderTransport(env: NodeJS.ProcessEnv): ProviderTransport | undefined {
  const raw = env[ENV_PROVIDER_TRANSPORT];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  if ((PROVIDER_TRANSPORT_VALUES as readonly string[]).includes(raw)) {
    return raw as ProviderTransport;
  }
  throw new Error(
    `Invalid ${ENV_PROVIDER_TRANSPORT}: "${raw}" is not one of ${PROVIDER_TRANSPORT_VALUES.join(", ")}`,
  );
}

function readReasoningEffort(env: NodeJS.ProcessEnv): ReasoningEffort | undefined {
  const raw = env[ENV_REASONING_EFFORT];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high" || raw === "max") return raw;
  console.warn(`Invalid ${ENV_REASONING_EFFORT}: "${raw}" is not off, low, medium, high, or max — ignoring`);
  return undefined;
}

/**
 * Parses ANYCODE_IMAGE_INPUT into an explicit override. Unlike the integer
 * options (which throw on a bad value), an unrecognized image-input value is
 * non-fatal: the field is left undefined and a warning is emitted, so a typo
 * degrades to the fail-closed catalog verdict rather than killing startup.
 */
function readImageInputOverride(env: NodeJS.ProcessEnv): ImageInputOverride | undefined {
  const raw = env[ENV_IMAGE_INPUT];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  if (raw === "on" || raw === "off") {
    return raw;
  }
  console.warn(`Invalid ${ENV_IMAGE_INPUT}: "${raw}" is not "on" or "off" — ignoring`);
  return undefined;
}

/**
 * Parses ANYCODE_INCLUDE_USAGE (TASK.158) into an explicit boolean override.
 * Both boolean vocabularies are accepted — `on|off` per the ANYCODE_IMAGE_INPUT
 * precedent, `1|0` per the integer-var habit — because the var is read by
 * humans editing shell profiles/export lines. Like `readImageInputOverride`
 * (and unlike `readProviderTransport`), a bad value is NON-FATAL: warn + leave
 * undefined, so a typo degrades to the transport-conditional default resolved
 * by `resolveIncludeUsage` rather than killing startup.
 */
function readOptionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  console.warn(`Invalid ${name}: "${raw}" is not 1/true/on or 0/false/off — ignoring`);
  return undefined;
}

function readOptionalInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not an integer`);
  }
  return parsed;
}

/**
 * taskana 4181 (P4): like readOptionalInteger but rejects non-POSITIVE values
 * too. For a reminder-spammer's delay a negative/zero integer is worse than a
 * typo: it would clamp to an immediate-fire loop. Only the supervisor idle
 * knob uses this; see readOptionalInteger for the pre-existing family.
 */
function readPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const parsed = readOptionalInteger(env, name);
  if (parsed !== undefined && parsed <= 0) {
    throw new Error(`Invalid ${name}: "${parsed}" is not a positive integer`);
  }
  return parsed;
}

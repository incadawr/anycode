/** Environment-based configuration for the Phase 0 single-provider setup. */

import type { ProviderTransport } from "./catalog.js";
import type { CoreEnvConfig, ReasoningEffort } from "../types/config.js";
import type { ImageInputOverride } from "./capabilities.js";

export const ENV_API_KEY = "ANYCODE_API_KEY";
export const ENV_BASE_URL = "ANYCODE_BASE_URL";
export const ENV_MODEL = "ANYCODE_MODEL";
export const ENV_MAX_TURNS = "ANYCODE_MAX_TURNS";
export const ENV_MAX_OUTPUT_TOKENS = "ANYCODE_MAX_OUTPUT_TOKENS";
export const ENV_REASONING_EFFORT = "ANYCODE_REASONING_EFFORT";
export const ENV_CONTEXT_WINDOW = "ANYCODE_CONTEXT_WINDOW";
export const ENV_MAX_RETRIES = "ANYCODE_MAX_RETRIES";
export const ENV_DB_PATH = "ANYCODE_DB_PATH";
export const ENV_TOOL_CONCURRENCY = "ANYCODE_TOOL_CONCURRENCY";
export const ENV_STALL_TIMEOUT_MS = "ANYCODE_STALL_TIMEOUT_MS";
export const ENV_IMAGE_INPUT = "ANYCODE_IMAGE_INPUT";
export const ENV_PROVIDER_TRANSPORT = "ANYCODE_PROVIDER_TRANSPORT";

const PROVIDER_TRANSPORT_VALUES: readonly ProviderTransport[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Reads ANYCODE_API_KEY, ANYCODE_BASE_URL (default: native Anthropic),
 * ANYCODE_MODEL (required), and the optional integers ANYCODE_MAX_TURNS /
 * ANYCODE_MAX_OUTPUT_TOKENS / ANYCODE_CONTEXT_WINDOW / ANYCODE_MAX_RETRIES /
 * ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS plus ANYCODE_DB_PATH.
 * ANYCODE_REASONING_EFFORT is an optional off|low|medium|high|max selector
 * (per-model levels are gated downstream by the catalog; unsupported → off).
 * ANYCODE_PROVIDER_TRANSPORT selects the wire protocol (TASK.43 §0.4); an
 * invalid value throws (never a silent anthropic fallback). ANYCODE_API_KEY is
 * required when the resolved transport is undefined or `anthropic-messages`
 * (byte-compat: that path is fail-closed), and optional for the two OpenAI
 * transports (no-auth local endpoints).
 * Throws a descriptive error naming the offending variable.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): CoreEnvConfig {
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
  const maxOutputTokens = readOptionalInteger(env, ENV_MAX_OUTPUT_TOKENS);
  const contextWindowTokens = readOptionalInteger(env, ENV_CONTEXT_WINDOW);
  const maxRetries = readOptionalInteger(env, ENV_MAX_RETRIES);
  const toolConcurrency = readOptionalInteger(env, ENV_TOOL_CONCURRENCY);
  const stallTimeoutMs = readOptionalInteger(env, ENV_STALL_TIMEOUT_MS);

  const rawDbPath = env[ENV_DB_PATH];
  const dbPath = rawDbPath && rawDbPath.trim() !== "" ? rawDbPath : undefined;

  const imageInput = readImageInputOverride(env);
  const reasoningEffort = readReasoningEffort(env);

  return {
    apiKey,
    baseUrl,
    model,
    maxTurns,
    maxOutputTokens,
    reasoningEffort,
    contextWindowTokens,
    maxRetries,
    dbPath,
    toolConcurrency,
    stallTimeoutMs,
    imageInput,
    providerTransport,
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

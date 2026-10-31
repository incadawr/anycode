/**
 * Provider quota-notice parsing for core providers and Codex.
 *
 * Relocated here from the renderer so the HOST can parse the RAW provider
 * message at the wire boundary (sanitizeAgentEvent) and attach a numbers-only
 * UsageLimitNotice to the wire event. The raw message itself is redacted
 * before it crosses to the renderer, so the renderer can no longer parse it —
 * it reads `event.notice` instead.
 *
 * Two producers are recognised:
 *  - a core provider's Z.AI quota error (code 1308, always with a reset time);
 *  - a Codex turn failure, asked ONLY for the codex engine (see
 *    `parseUsageLimitNotice`'s `engine` argument): the app-server reports it as
 *    `usageLimitExceeded` / an HTTP 429, sometimes with a "try again at" time.
 *    Codex notices carry `engine: "codex"` so the UI can offer its own remedy.
 *
 * Shared (host + renderer): uses only regex + Date, no browser/Node APIs.
 */

export interface UsageLimitNotice {
  kind: "usage_limit";
  /** The provider's own code: Z.AI's 1308, or 429 for a Codex usage limit (the HTTP status the app-server maps it to). */
  code: number;
  /** Epoch milliseconds. Absent when the provider gave no reset time (a Codex 429 need not carry one). */
  resetAt?: number;
  /** Which engine produced the notice; absent for core providers. */
  engine?: "codex";
}

const ZAI_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** Parses Z.AI's documented quota error shape, e.g. `[1308]...reset at 2026-07-12 19:07:09`. */
export function parseUsageLimitNotice(message: string): UsageLimitNotice | null {
  const code = /\[(1308)\]/.exec(message);
  const reset = /limit will reset at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(message);
  if (!code || !reset) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = reset;
  // 1308 omits an offset. Z.AI's service clock is China Standard Time
  // (Asia/Shanghai, no DST): 19:07 CST is 11:07 UTC, then the UI formatter
  // (renderer) renders that instant in the user's actual local timezone.
  const resetAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) - ZAI_TIMEZONE_OFFSET_MS;
  return Number.isFinite(resetAt) ? { kind: "usage_limit", code: Number(code[1]), resetAt } : null;
}

/** The HTTP status the Codex app-server maps a usage-limit failure to. */
const CODEX_USAGE_LIMIT_CODE = 429;

/**
 * Codex's own spellings of "this account's plan is spent": the structured
 * `usageLimitExceeded` / `usage_limit_exceeded` codes (CodexErrorInfo), a
 * `rate limit reached` refusal, and the CLI's human sentence. Deliberately
 * broad — the caller only asks about the codex engine, and the event being
 * tested is the turn's terminal error, never tool output.
 */
const CODEX_USAGE_LIMIT_PATTERN =
  /usageLimitExceeded|usage[ _-]?limit(?:[ _-]?(?:reached|exceeded))?|rate[ _-]?limit[ _-]?reached|hit your usage limit/i;

/** `... resetsAt":1783853597` / `resets at 1783853597` — epoch SECONDS (the app-server's rate-limit shape). */
const CODEX_EPOCH_RESET_PATTERN = /resets?[ _]?at["'\s:=]+(\d{10})\b/i;

/** `2026-10-31 12:00[:00]` with an optional zone; bare values are the CLI's LOCAL wall clock. */
const CODEX_WALLCLOCK_RESET_PATTERN = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/;

function codexResetAt(message: string): number | undefined {
  const epoch = CODEX_EPOCH_RESET_PATTERN.exec(message);
  if (epoch !== null) {
    const seconds = Number(epoch[1]);
    const epochMs = seconds * 1_000;
    if (Number.isFinite(epochMs)) return epochMs;
  }
  const wall = CODEX_WALLCLOCK_RESET_PATTERN.exec(message);
  if (wall === null) return undefined;
  const [, year, month, day, hour, minute, second, zone] = wall;
  if (zone !== undefined) {
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}${zone}`);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // No zone: the CLI prints the user's own wall clock, so interpret it locally
  // (Date's component constructor is local-time by definition).
  const local = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? "0"));
  return Number.isFinite(local.getTime()) ? local.getTime() : undefined;
}

/**
 * Parses a Codex usage-limit turn failure. `engine` gates recognition so a core
 * provider error that merely mentions a usage limit is never presented as a
 * Codex notice (and vice versa: Codex-only notices are what the account-switch
 * remedy is offered for).
 */
export function parseCodexUsageLimitNotice(message: string): UsageLimitNotice | null {
  if (!CODEX_USAGE_LIMIT_PATTERN.test(message)) return null;
  const resetAt = codexResetAt(message);
  return {
    kind: "usage_limit",
    code: CODEX_USAGE_LIMIT_CODE,
    engine: "codex",
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * The wire-boundary entry point: Z.AI first (unchanged for core providers),
 * then — only when the session's engine is `codex` — the Codex spellings.
 */
export function parseUsageLimitNoticeForEngine(message: string, engine?: string): UsageLimitNotice | null {
  const zai = parseUsageLimitNotice(message);
  if (zai !== null) return zai;
  return engine === "codex" ? parseCodexUsageLimitNotice(message) : null;
}

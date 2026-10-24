/**
 * Normalized provider-reported quota from HTTP response headers (Taskana
 * 4090 / TASK.71).
 *
 * Every provider family spells its subscription windows differently
 * (`x-ratelimit-*`, `anthropic-ratelimit-*`, bare `ratelimit-*`, snake_case
 * variants, ...), but the de-facto shape is the same triple: limit,
 * remaining, reset. This module collapses those spellings into one key
 * family per measured resource and derives the tightest constraint as the
 * `primary` window.
 *
 * Fail-closed discipline throughout: a field a provider did not report is
 * ABSENT (undefined), never zero — zero and absent mean different things to
 * the UI (a fabricated 0% would render a scary "0% left" for a provider
 * that said nothing). A family with a nonsense ratio (`remaining > limit`,
 * non-numeric values, limit <= 0) is DROPPED, never clamped into a
 * confident number. No parseable family at all ⇒ `null` (which is what
 * suppresses the UI block), not an empty object.
 */

/** Canonicalized header-bag over a fetch Response (built by ./quota-fetch.ts). */
export interface QuotaHeaderBag {
  /** HTTP status of the response the headers came with. */
  status: number;
  get(name: string): string | null;
  names(): Iterable<string>;
}

/** One normalized quota window. Nullable fields stay absent when unreported. */
export interface ProviderQuotaWindow {
  /** 0–100 inclusive; the ONLY required field. */
  usedPercent: number;
  windowDurationMins?: number;
  /** Epoch SECONDS (same convention as CodexRateLimitsWire). */
  resetsAt?: number;
}

export interface ProviderQuotaUpdate {
  primary?: ProviderQuotaWindow;
  secondary?: ProviderQuotaWindow;
  /** Raw header names that produced this update (diagnostics/inventory; never rendered). */
  sources: string[];
}

/** Resource families recognized after canonicalization. */
const FAMILIES = [
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
  "input_tokens",
  "output_tokens",
] as const;

/** Vendor prefixes stripped (in this order) when canonicalizing a header name. */
const VENDOR_PREFIXES = ["x-", "anthropic-", "openai-", "glm-", "kimi-"] as const;

/**
 * Canonicalizes one header name: lowercase, then strip ONE leading `x-` and
 * ONE vendor prefix, so `x-ratelimit-requests-remaining`,
 * `anthropic-ratelimit-requests-remaining` and `ratelimit-requests-remaining`
 * all collapse to `ratelimit-requests-remaining`. Snake_case survives
 * verbatim (a provider using `x_ratelimit_requests_remaining` keeps its own
 * family; we do not rewrite `_` to `-` because that would fuse genuinely
 * distinct provider spellings the inventory has not confirmed equivalent).
 */
function canonicalHeaderName(name: string): string {
  let key = name.toLowerCase();
  for (const prefix of VENDOR_PREFIXES) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
      // Only `x-` may be followed by a vendor prefix (`x-anthropic-ratelimit-*`).
      if (prefix === "x-") continue;
      break;
    }
  }
  return key;
}

/** Parses an int from a header value; returns undefined on anything non-numeric. */
function parseIntField(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Strict: `20abc` / `1.5` are not counts (parseInt would accept them).
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

/**
 * Parses a reset timestamp: epoch seconds, ISO-8601 (→ epoch seconds via
 * `Date.parse/1000`), or HTTP-date. ISO dates are heuristically detected by
 * the leading `YYYY-MM-DD`; an HTTP-date is anything `Date.parse` accepts
 * that is not a bare number.
 */
function parseResetField(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    // Below ~2001-09 as epoch seconds is not a real reset time: it is a
    // delta in seconds (several providers send `reset: 60`).
    return value >= 1_000_000_000 ? value : Math.round(now / 1000 + value);
  }
  // OpenAI-style Go duration: `1s`, `6m0s`, `1h2m3.5s`, `20ms`.
  const duration = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(trimmed);
  if (duration !== null && trimmed !== "") {
    const [, h, m, sec, ms] = duration;
    const seconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0) + Number(ms ?? 0) / 1000;
    return Math.round(now / 1000 + seconds);
  }
  if (!/^(?:\d{4}-\d{2}-\d{2}|[a-z]{3},)/i.test(trimmed)) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.round(parsed / 1000);
}

interface ParsedFamily {
  family: string;
  ratio: number;
  window: ProviderQuotaWindow;
  /** Literal original header names consumed (limit/remaining/reset/window). */
  sources: string[];
}

interface FamilyAccumulator {
  limitName?: string;
  limitValue?: number;
  remainingName?: string;
  remainingValue?: number;
  resetName?: string;
  resetValue?: number;
  windowMins?: number;
  windowName?: string;
}

export function providerQuotaFromHeaders(headers: QuotaHeaderBag, now: number): ProviderQuotaUpdate | null {
  // Case-insensitive canonical lookup: first occurrence of a canonical key wins.
  const canonical = new Map<string, { original: string; value: string }>();
  for (const name of headers.names()) {
    const key = canonicalHeaderName(name);
    if (!canonical.has(key)) {
      canonical.set(key, { original: name, value: headers.get(name) ?? "" });
    }
  }

  const parsed: ParsedFamily[] = [];
  for (const family of FAMILIES) {
    const acc: FamilyAccumulator = {};

    // Two de-facto orders: `ratelimit-<family>-limit` (Anthropic) and
    // `ratelimit-limit-<family>` (OpenAI and most OpenAI-compatible hosts).
    const limit = canonical.get(`ratelimit-${family}-limit`) ?? canonical.get(`ratelimit-limit-${family}`);
    if (limit !== undefined) {
      acc.limitName = limit.original;
      acc.limitValue = parseIntField(limit.value);
    }
    const remaining = canonical.get(`ratelimit-${family}-remaining`) ?? canonical.get(`ratelimit-remaining-${family}`);
    if (remaining !== undefined) {
      acc.remainingName = remaining.original;
      acc.remainingValue = parseIntField(remaining.value);
    }
    const reset = canonical.get(`ratelimit-${family}-reset`) ?? canonical.get(`ratelimit-reset-${family}`);
    if (reset !== undefined) {
      acc.resetName = reset.original;
      acc.resetValue = parseResetField(reset.value, now);
    }
    const window = canonical.get(`ratelimit-${family}-window-minutes`) ?? canonical.get(`ratelimit-${family}-window`);
    if (window !== undefined) {
      const windowMins = parseIntField(window.value);
      if (windowMins !== undefined && windowMins > 0) {
        acc.windowName = window.original;
        acc.windowMins = windowMins;
      }
    }

    // A family is usable only with BOTH a numeric remaining and a numeric
    // limit (the ratio needs both legs). Fail-closed: any nonsense drops the
    // whole family rather than clamping it into a confident number.
    if (
      acc.remainingValue === undefined ||
      acc.limitValue === undefined ||
      !(acc.remainingValue >= 0) ||
      !(acc.remainingValue <= acc.limitValue) ||
      !(acc.limitValue > 0)
    ) {
      continue;
    }
    const ratio = acc.remainingValue / acc.limitValue;
    parsed.push({
      family,
      ratio,
      window: {
        usedPercent: Math.round(100 * (1 - ratio)),
        ...(acc.windowMins !== undefined ? { windowDurationMins: acc.windowMins } : {}),
        ...(acc.resetValue !== undefined ? { resetsAt: acc.resetValue } : {}),
      },
      sources: [
        ...(acc.limitName !== undefined ? [acc.limitName] : []),
        ...(acc.remainingName !== undefined ? [acc.remainingName] : []),
        ...(acc.resetName !== undefined ? [acc.resetName] : []),
        ...(acc.windowName !== undefined ? [acc.windowName] : []),
      ],
    });
  }

  if (parsed.length > 0) {
    // Tightest ratio (smallest remaining/limit) = primary — the constraint
    // the user will hit first. The next DISTINCT ratio is secondary.
    const ranked = [...parsed].sort((a, b) => a.ratio - b.ratio);
    const primary = ranked[0]!;
    const distinct = ranked.find((p) => p.ratio !== primary.ratio);
    return {
      primary: primary.window,
      ...(distinct !== undefined ? { secondary: distinct.window } : {}),
      sources: parsed.flatMap((p) => p.sources),
    };
  }

  // Bare `retry-after` only counts on a 429: on a 200 it is a pacing hint
  // (throttling), not an exhausted window — reporting 100% used from it
  // would be a fabrication.
  const retryAfter = canonical.get("retry-after");
  if (headers.status === 429 && retryAfter !== undefined) {
    const seconds = parseRetryAfterSeconds(retryAfter.value, now);
    if (seconds !== undefined) {
      return {
        primary: { usedPercent: 100, ...(seconds !== undefined ? { resetsAt: Math.round(now / 1000 + seconds) } : {}) },
        sources: [retryAfter.original],
      };
    }
  }

  return null;
}

/** `retry-after` value: delay-seconds or HTTP-date (→ seconds from `now`, ms). */
function parseRetryAfterSeconds(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.round((parsed - now) / 1000);
}

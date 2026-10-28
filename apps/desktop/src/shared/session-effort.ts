/**
 * The ONE membership validator for a session-level reasoning-effort override
 * (Sessions API `create_session` → host `set_session_effort`).
 *
 * Why it exists as shared code: main validates/forwards an effort, the host
 * validates it again against the LIVE model vocabulary it actually resolved,
 * and both must agree byte-for-byte on what "allowed" means. The vocabulary is
 * always the engine's OWN advertised list (`model/list` for Codex, the Claude
 * `initialize` catalog, the provider catalog for core) — never a hardcoded
 * table, and never core's closed `ReasoningEffort` union: native engines
 * advertise free-form strings (`xhigh`, `max`, whatever a future binary adds)
 * and those ride the wire verbatim.
 *
 * Rules (deliberately strict — an approximation here would silently run a
 * session at an effort the user never chose):
 *  - exact, case-sensitive membership; no trimming, lowercasing, translation,
 *    clamping or substitution;
 *  - empty/whitespace-only and non-string values are a type error, not a miss;
 *  - an absent/empty vocabulary validates NOTHING (`no_supported_levels`),
 *    rather than silently accepting anything;
 *  - `off` is not granted to every engine — only when the model advertises it;
 *  - advertised order is preserved, duplicates and empty entries dropped.
 *
 * Omission is a CALLER decision: it means "no override, keep the engine's own
 * default", so it never reaches `validateSessionEffort`.
 */

export interface SessionEffortOptions {
  engine: string;
  model: string;
  /** The selected model's advertised levels, in the engine's own order. */
  levels: readonly string[];
}

export type SessionEffortFailureReason = "invalid_type" | "no_supported_levels" | "not_advertised";

export type SessionEffortValidation =
  | { ok: true; effort: string }
  | { ok: false; reason: "invalid_effort"; detail: string };

/**
 * The model's advertised vocabulary, cleaned for display AND for validation:
 * non-strings, empty strings and whitespace-only entries are metadata noise
 * (and could never be legally requested). Order is the engine's; duplicates
 * are collapsed.
 */
export function normalizeEffortLevels(levels: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of levels) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The `detail` half of the refusal. `create_session`'s own `createRefusal()`
 * prefixes `create_session invalid_effort: reasoning effort is not supported`,
 * so this string must carry the facts and nothing else — never raw engine
 * responses or configuration.
 */
function detailOf(options: SessionEffortOptions, value: unknown, allowed: readonly string[], reason: SessionEffortFailureReason): string {
  return `engine=${options.engine}; model=${JSON.stringify(options.model)}; effort=${JSON.stringify(value)}; allowed=${JSON.stringify(allowed)}; reason=${reason}`;
}

export function validateSessionEffort(value: unknown, options: SessionEffortOptions): SessionEffortValidation {
  const allowed = normalizeEffortLevels(options.levels);
  const refuse = (reason: SessionEffortFailureReason): SessionEffortValidation => ({
    ok: false,
    reason: "invalid_effort",
    detail: detailOf(options, value, allowed, reason),
  });

  if (typeof value !== "string") return refuse("invalid_type");
  // An empty or whitespace-only request is a malformed value, not a level the
  // model failed to advertise.
  if (value.trim() === "") return refuse("invalid_type");
  if (allowed.length === 0) return refuse("no_supported_levels");
  if (!allowed.includes(value)) return refuse("not_advertised");
  return { ok: true, effort: value };
}

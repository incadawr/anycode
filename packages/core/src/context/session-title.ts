/**
 * Session titling (Phase 4 slice 4.4-T, design/feature-session-titles.md §2/§3).
 * Two tiers, both living here for host-parity (desktop + CLI call the same
 * functions): a synchronous heuristic (first line of the first user message,
 * capped) that gives every session a title instantly, and an async one-shot LLM
 * refinement — same one-shot shape as context/manager.ts's runCompaction — that
 * upgrades it after the first turn completes. Fail-quiet by design: any error,
 * timeout, or empty reply from the model resolves to `null` so the caller keeps
 * the heuristic title rather than surfacing a titling failure to the user.
 */

import type { ModelPort, ModelRequest } from "../ports/model.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { SESSION_TITLE_INSTRUCTION } from "../prompts/session-title.js";

/** Max characters of a session title, either heuristic or LLM-refined (design §4.2). */
export const SESSION_TITLE_MAX_LENGTH = 80;

/** UTF-8 byte cap applied to the source text sent to the LLM refinement call. */
export const SESSION_TITLE_SOURCE_MAX_BYTES = 1000;

/** Default abort timeout for the LLM refinement one-shot when the caller supplies no signal. */
export const SESSION_TITLE_TIMEOUT_MS = 10_000;

/**
 * Paired reminder/context tags that hosts inject around raw user input
 * (agent-loop.ts's `<hook-context>`, cli/plan.ts's `<plan-mode-reminder>`, and
 * the assistant-side `<system-reminder>` convention). Both title tiers key off

 * second layer against a future caller that forwards already-wrapped text.
 */
const PAIRED_REMINDER_TAGS = ["hook-context", "plan-mode-reminder", "system-reminder"] as const;

/**
 * Strips paired `<tag>...</tag>` blocks for the known reminder/context tags.
 * Matches are non-greedy so adjacent pairs of the same tag are removed
 * independently; an unpaired (single, unmatched) tag is left untouched, and
 * text without any of these tags passes through byte-for-byte.
 */
export function sanitizeTitleSource(text: string): string {
  let result = text;
  for (const tag of PAIRED_REMINDER_TAGS) {
    const pairedBlock = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
    result = result.replace(pairedBlock, "");
  }
  return result;
}

/**
 * Heuristic title (tier 1, design §2): the first non-empty line of the raw
 * message, trimmed and capped. Byte-for-byte the original
 * `host/session.ts` implementation — sanitization is the caller's job
 * (`deriveSessionTitle(sanitizeTitleSource(text))`), not this function's.
 */
export function deriveSessionTitle(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > SESSION_TITLE_MAX_LENGTH
    ? trimmed.slice(0, SESSION_TITLE_MAX_LENGTH)
    : trimmed;
}

/**
 * LLM refinement (tier 2, design §2): a one-shot call to the session's own
 * model (same shape as `ContextManager.runCompaction` — `ModelRequest{tools:[]}`
 * -> `streamText` -> accumulate `text_delta`) asking for a 3-6 word title.
 * Fail-quiet: an `error` event, a thrown rejection (including abort/timeout),
 * or an empty/whitespace-only reply all resolve to `null` — never throws.
 */
export async function generateSessionTitle(opts: {
  modelPort: ModelPort;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS);
  const sanitized = sanitizeTitleSource(opts.text);
  const { text: content } = capUtf8Bytes(sanitized, SESSION_TITLE_SOURCE_MAX_BYTES);

  const request: ModelRequest = {
    system: SESSION_TITLE_INSTRUCTION,
    messages: [{ role: "user", content }],
    tools: [],
    maxOutputTokens: 32,
    temperature: 0,
    abortSignal: signal,
  };

  let raw = "";
  try {
    for await (const event of opts.modelPort.streamText(request)) {
      if (signal.aborted) {
        return null;
      }
      if (event.type === "text_delta") {
        raw += event.text;
      } else if (event.type === "error") {
        return null;
      }
    }
  } catch {
    return null;
  }
  if (signal.aborted) {
    return null;
  }

  return postProcessTitle(raw);
}

/**
 * Post-processes a raw model reply into a display title: first line only
 * (a chatty model's preamble/explanation, if any, never gets this far because
 * the instruction asks for the title alone, but multi-line replies are
 * defended against anyway), trim, strip one layer of wrapping quotes and a
 * trailing period, collapse internal whitespace runs to a single space, then
 * cap at SESSION_TITLE_MAX_LENGTH. An empty result becomes `null` (caller
 * keeps the heuristic title).
 */
function postProcessTitle(raw: string): string | null {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  let candidate = firstLine.trim();
  candidate = stripSurroundingQuotes(candidate);
  candidate = stripTrailingPeriod(candidate);
  candidate = candidate.trim().replace(/\s+/g, " ");
  if (candidate.length > SESSION_TITLE_MAX_LENGTH) {
    candidate = candidate.slice(0, SESSION_TITLE_MAX_LENGTH);
  }
  return candidate.length > 0 ? candidate : null;
}

/** Strips a single matching pair of wrapping `"..."` or `'...'` quotes, if present. */
function stripSurroundingQuotes(s: string): string {
  if (s.length < 2) {
    return s;
  }
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Strips a single trailing period, if present. */
function stripTrailingPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

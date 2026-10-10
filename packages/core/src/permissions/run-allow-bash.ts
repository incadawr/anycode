/**
 * Per-run Bash allow-list (TASK.138 slices 2–3). A decorator PermissionEngine,
 * structurally identical to SafeCommandPermissionEngine (safe-command-engine.ts):
 * wraps a base engine and narrows ONLY an "ask" ruling to "allow", terminally,
 * when the request is a Bash command whose argv tokens are prefixed by one
 * configured allow-list entry — or, for a compound line, when EVERY
 * nonempty segment independently prefix-matches an explicit entry. "allow"/"deny"
 * from the base pass through untouched, exactly like every other narrowing layer
 * in this package (SafeCommandPermissionEngine, RuleAwarePermissionEngine).
 *
 * WHY: TASK.138 slice 1 turned an unattended run's unanswered asks into a fast
 * deny (the permission-broker "unattended" latch, host/permission-broker.ts)
 * instead of a 120s wait per call — but a fast deny is still a deny. An
 * autonomous run still cannot pass its own gate (`pnpm test`, `pnpm
 * typecheck`, …): Bash is `riskLevel: "high"`, so build/edit/auto always
 * escalate it to "ask", and the only mode where it runs unattended is the
 * blanket `yolo` (every tool, no narrowing at all). This engine is the narrow
 * middle ground the task calls for: a list supplied by whoever LAUNCHED this
 * particular run names the handful of commands it may execute without asking.
 *
 * Source discipline (deliberate, do not soften): this is a PROCESS INPUT, not
 * a setting.
 *  - Read once at host bootstrap from `process.env.ANYCODE_RUN_ALLOW_BASH`
 *    (apps/desktop/src/host/index.ts) — this module never touches `process.env`
 *    itself, keeping it pure/testable like every other engine here.
 *  - Never written to settings.json, never exposed to the UI, never persisted
 *    across a boot — unlike SessionPermissionRules' `/allow` rules, an entry
 *    here dies with the process that read it.
 *  - A prior incident (memory: pattern-less `alwaysAllow` killing an entire
 *    permission smoke run) is exactly the shape this must never become: the
 *    list is explicit, per-run, prefix-EXACT on argv tokens, Bash-only, and
 *    refuses anything it is not certain about.
 *
 * Matching (fail-closed throughout — any uncertainty falls through to the
 * base ruling unchanged):
 *  - Bash only. Every other tool passes through unexamined, mirroring
 *    SafeCommandPermissionEngine's non-Bash guard exactly.
 *  - A single plain command, OR a compound line whose EVERY nonempty segment
 *    independently satisfies the per-segment rules below. The line is split by
 *    the shared `splitBashSegments` (rules.ts, the ONE splitter here); only
 *    `&&`, `||`, `;`, `|`, and newline may separate segments — a single `&` or
 *    a `|&` (read by the splitter as `|` + control `&`) fails the
 *    SAFE_COMPOUND_SEPARATORS set, as do a leading/trailing separator and any
 *    blank/malformed segment.
 *  - Each segment must itself be a single plain command: no composition,
 *    substitution, redirect, or unbalanced quote, and no shell metacharacter.
 *    Per segment this reuses `classifyBashCommandLine`'s `shellExpression`
 *    (safe-command.ts). Its raw metacharacter screen is quote-UNAWARE, so a
 *    metacharacter is rejected even INSIDE quotes. ALL redirections `<`/`>`
 *    (including `2>&1`, `&>`, here-docs, and a workspace-relative `> out.txt`)
 *    are rejected — a deliberately conservative policy that also covers
 *    out-of-workspace destinations without any workspace/cwd plumbing; in-
 *    workspace redirect support is NOT promised. Balanced quotes are PRESERVED
 *    verbatim, never stripped: `echo "plain"` matches an `echo` entry because
 *    quotes are not metacharacters, while `echo "a;b"` is rejected because the
 *    raw `;` is.
 *  - Only when EVERY segment matches may the line be allowed: a segment that
 *    no explicit entry prefix-matches falls through untouched, and the line is
 *    NEVER allowed early on a matching prefix alone (`pnpm test && rm -rf /`
 *    asks even with `pnpm test` allow-listed).
 *  - The per-segment match is by whitespace-split ARGV TOKEN prefix, not
 *    substring: an entry `pnpm test` matches `pnpm test` and `pnpm test --run`
 *    but NOT `pnpm testify` (second token differs) and NOT a command shorter
 *    than the entry itself. No regex, no globs — plain token-array equality.
 *    `class` is irrelevant (`unknown` is not grounds for rejection: an explicit
 *    entry such as `pnpm test` is intentionally outside the read-only class).
 *  - A Bash request with a non-string `command`, a command that tokenizes to
 *    nothing, or an empty allow-list: falls through untouched.
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { type BashSeparatorKind, splitBashSegments } from "./rules.js";
import { classifyBashCommandLine } from "./safe-command.js";

/** One allow-list entry, pre-split into its argv tokens for prefix comparison. */
export type RunAllowBashEntry = readonly string[];

/**
 * Parses `ANYCODE_RUN_ALLOW_BASH` (comma-separated, e.g. `"pnpm test,pnpm
 * typecheck"`). `undefined` (env var absent) yields `[]` — the caller's
 * no-op fast path: constructing `RunAllowBashPermissionEngine` with an empty
 * list must change zero existing behavior (DoD). Each comma-separated item is
 * whitespace-tokenized; an item that trims to empty (a stray comma, trailing
 * comma, or whitespace-only item) contributes nothing rather than an empty
 * "matches everything" entry — fail-closed on a malformed value instead of
 * silently widening. Tokenization here is plain whitespace-splitting, NOT
 * shell/quote-aware: both this parse and `tokenizeCommand` split on whitespace,
 * so quotes stay LITERAL characters on both sides of the comparison. A quoted
 * entry therefore gets no shell-level special treatment — it only matches if
 * the candidate argv token carries the same literal quote characters.
 */
export function parseRunAllowBash(raw: string | undefined): RunAllowBashEntry[] {
  if (raw === undefined) {
    return [];
  }
  const entries: RunAllowBashEntry[] = [];
  for (const item of raw.split(",")) {
    const tokens = item
      .trim()
      .split(/[ \t]+/)
      .filter((token) => token.length > 0);
    if (tokens.length > 0) {
      entries.push(tokens);
    }
  }
  return entries;
}

/**
 * Whitespace tokenizer for the CANDIDATE segment. Deliberately a plain
 * space/tab split, not shell-aware: `check()` only ever calls this after
 * `classifyBashCommandLine` has already proven the segment carries no shell
 * metacharacter. Quotes are NOT metacharacters, so balanced quotes survive
 * this split as literal characters inside their token (never stripped). This
 * is NOT the quote-parsing logic the safe-command.ts module doc warns against
 * duplicating (that lives in `tokenizeSegment`, untouched here) — it is the
 * same one-line split as that module's own single-command `tokenize()`.
 */
function tokenizeCommand(command: string): string[] {
  const trimmed = command.trim();
  return trimmed === "" ? [] : trimmed.split(/[ \t]+/);
}

/** True when every token of `entry` equals the token at the same position in `candidate` — a PREFIX match, never a substring one. */
function isPrefixMatch(entry: RunAllowBashEntry, candidate: readonly string[]): boolean {
  if (entry.length > candidate.length) {
    return false;
  }
  for (let i = 0; i < entry.length; i += 1) {
    if (entry[i] !== candidate[i]) {
      return false;
    }
  }
  return true;
}

/**
 * The ONLY separators a compound line may be built from (TASK.138 slice 3):
 * `&&`, `||`, `;`, `|`, and newline. Single `&` (backgrounding) and `|&`
 * (pipe-with-stderr) are deliberately EXCLUDED: `splitBashSegments` reads `|&`
 * as `|` + control `&`, so the stray `&` kind fails this set and every `|&`
 * line falls through to the base ruling, as does a trailing/leading `&`.
 */
const SAFE_COMPOUND_SEPARATORS: ReadonlySet<BashSeparatorKind> = new Set<BashSeparatorKind>([
  "&&",
  "||",
  ";",
  "|",
  "\n",
]);

export class RunAllowBashPermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly allowlist: readonly RunAllowBashEntry[],
  ) {}

  check(request: PermissionRequest): PermissionRuling {
    const ruling = this.base.check(request);
    if (ruling.decision !== "ask") {
      // Narrowing only ever downgrades "ask" -> "allow".
      return ruling;
    }
    if (this.allowlist.length === 0) {
      // Env-unset fast path: zero entries, zero behavior change (DoD).
      return ruling;
    }
    if (request.toolName !== "Bash") {
      return ruling;
    }
    const command = (request.input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") {
      // Fail-closed: no command subject to check, so the ask is preserved.
      return ruling;
    }
    // Reuse the shared splitter (rules.ts — the ONE splitter in this package)
    // for raw segments and exact separator kinds, then screen each segment with
    // the classifier's own metacharacter analysis: every segment must be a
    // single plain, metacharacter-free command that independently prefix-matches
    // an allow-list entry. ANY uncertainty falls through to the base ruling.
    const split = splitBashSegments(command);
    if (split === undefined) {
      // Substitution or unterminated quote: unsegmentable, never auto-allow.
      return ruling;
    }
    if (
      split.separators.some((separator) => !SAFE_COMPOUND_SEPARATORS.has(separator)) ||
      split.segments.some((segment) => segment.trim() === "")
    ) {
      // A separator outside the safe set (single `&`, `|&`'s stray `&`) or a
      // blank/malformed segment: fail closed.
      return ruling;
    }
    const matchedEntries: string[] = [];
    for (const segment of split.segments) {
      if (classifyBashCommandLine(segment).shellExpression) {
        // A metacharacter, substitution, unbalanced quote, redirect (including
        // a workspace-relative one), or a nested composite segment: the segment
        // is not a single plain command, so reject the whole line.
        return ruling;
      }
      const tokens = tokenizeCommand(segment);
      if (tokens.length === 0) {
        return ruling;
      }
      const entry = this.allowlist.find((candidate) => isPrefixMatch(candidate, tokens));
      if (entry === undefined) {
        // This segment is uncovered by an explicit entry: never allow early.
        return ruling;
      }
      matchedEntries.push(entry.join(" "));
    }
    const onlyEntry = matchedEntries.length === 1 ? matchedEntries[0] : undefined;
    if (onlyEntry !== undefined) {
      return {
        decision: "allow",
        reason: `Bash: auto-approved (matches ANYCODE_RUN_ALLOW_BASH entry "${onlyEntry}")`,
      };
    }
    return {
      decision: "allow",
      reason: `Bash: auto-approved (every segment matches ANYCODE_RUN_ALLOW_BASH entries ${matchedEntries
        .map((entry) => `"${entry}"`)
        .join(", ")})`,
    };
  }
}

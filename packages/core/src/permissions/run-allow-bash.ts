/**
 * Per-run Bash allow-list (TASK.138 slice 2). A decorator PermissionEngine,
 * structurally identical to SafeCommandPermissionEngine (safe-command-engine.ts):
 * wraps a base engine and narrows ONLY an "ask" ruling to "allow", terminally,
 * when the request is a Bash command whose argv tokens are prefixed by one
 * configured allow-list entry. "allow"/"deny" from the base pass through
 * untouched, exactly like every other narrowing layer in this package
 * (SafeCommandPermissionEngine, RuleAwarePermissionEngine).
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
 *  - The candidate command must be a single plain command with NO shell
 *    metacharacters and NO composition (`;`/`&`/`&&`/`||`/`|`/newline,
 *    substitution, unbalanced quote). This reuses `classifyBashCommandLine`'s
 *    `shellExpression` flag (safe-command.ts) instead of re-implementing its
 *    quote/segment parsing: `shellExpression === true` means "more than one
 *    plain simple command, or a plain command carrying a metacharacter" —
 *    exactly the set that must never match, pipelines included (`pnpm test |
 *    sh` is composite even though the first segment alone looks innocuous).
 *  - The match is by whitespace-split ARGV TOKEN prefix, not substring: an
 *    entry `pnpm test` matches `pnpm test` and `pnpm test --run` but NOT
 *    `pnpm testify` (second token differs) and NOT a command shorter than the
 *    entry itself. No regex, no globs — plain token-array equality.
 *  - A Bash request with a non-string `command`, a command that tokenizes to
 *    nothing, or an empty allow-list: falls through untouched.
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
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
 * shell/quote-aware: `check()` only ever compares these tokens against a
 * candidate command already proven metacharacter/quote-free (the
 * `shellExpression` gate below), so a quoted entry buys it nothing.
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
 * Whitespace tokenizer for the CANDIDATE command. Deliberately a plain
 * space/tab split, not shell-aware: `check()` only ever calls this after
 * `classifyBashCommandLine` has already proven the command carries no shell
 * metacharacter (including quotes, which are not in that screen), so this is
 * NOT the quote-parsing logic the safe-command.ts module doc warns against
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
    // Reuse the classifier's own segmentation/metacharacter analysis rather
    // than re-parsing: shellExpression is true for anything beyond one plain,
    // metacharacter-free command — composite (any separator, pipes included),
    // substitution, unbalanced quote, or a bare metacharacter.
    if (classifyBashCommandLine(command).shellExpression) {
      return ruling;
    }
    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) {
      return ruling;
    }
    for (const entry of this.allowlist) {
      if (isPrefixMatch(entry, tokens)) {
        return {
          decision: "allow",
          reason: `Bash: auto-approved (matches ANYCODE_RUN_ALLOW_BASH entry "${entry.join(" ")}")`,
        };
      }
    }
    return ruling;
  }
}

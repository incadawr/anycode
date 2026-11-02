
/**
 * Splits a Bash command into the individual commands a shell would run. Returns
 * `undefined` when the command must be treated as unsegmentable — the caller
 * then refuses the match (fail closed).
 *
 * **Why:** the pattern used to be matched against the WHOLE raw
 * command string, so a stored `git *` rule auto-allowed
 * `git --version; curl … | sh` — everything appended after `;`/`&&`/`||`/`|`
 * rode along on the prefix. The P7.16 series closed the neighbouring class
 * (pattern SHAPE: wildcard-only, globstar, parens, extglob); this one is about
 * the SUBJECT: one rule was being asked to vouch for a whole pipeline. Every
 * segment must now match the pattern independently, which also removes any
 * need to special-case `export` (`export X=1; rm -rf ~` fails on segment two).
 *
 * Splitting is quote-aware: `;`/`&`/`|` inside `'…'` or `"…"`, or escaped with
 * a backslash, are literal text and never split (`echo "a;b"` stays one
 * segment). A `&` that belongs to a redirection (`2>&1`, `>&2`, `&>log`) is
 * likewise kept, but a control `&` (background) does split — it separates two
 * commands exactly like `;` does.
 *
 * **Fail-closed cases** (return `undefined`, i.e. never auto-allow):
 * - command/process substitution — `$(…)`, backticks, `<(…)`, `>(…)`: the
 *   substituted text is an arbitrary command the pattern never sees, and it
 *   can itself contain operators, so there is no safe way to segment "around"
 *   it. `git log $(touch /tmp/x)` re-asks even under `git *`.
 * - an unterminated quote: the command is malformed for our purposes and its
 *   segmentation is undecidable.
 *
 * **** now exported for `safe-command.ts`'s pipeline classifier (the
 * ONE splitter, invariant 2). The return shape grows a `separators` array
 * recording each separator's exact kind (`||`≠`|`, `&&`≠`&` — the walk always
 * distinguished them, only the old return type erased it). Blank segments are
 * KEPT in the returned `segments` — dropping them is `bashMatchSubjects`'
 * rule-matching leniency below, never the splitter's own behavior. `|&` has no
 * kind of its own: the walk reads it as `|` + control `&`, producing a blank
 * segment between them (`"a |& b"` → segments `["a ", "", " b"]`, separators
 * `["|", "&"]`) — teaching the walker a dedicated `|&` kind would change
 * segmentation for zero gain, since the pipeline classifier rejects it twice
 * over (non-`|` separator AND a blank segment).
 */
export type BashSeparatorKind = ";" | "&" | "&&" | "|" | "||" | "\n";

export interface BashSegments {
  /** Raw segment texts, quotes/escapes preserved verbatim; blanks are KEPT
   * (dropping them is bashMatchSubjects' rule-matching leniency, never the
   * splitter's). Always segments.length >= 1. */
  segments: string[];
  /** separators[i] sits between segments[i] and segments[i+1];
   * separators.length === segments.length - 1. */
  separators: BashSeparatorKind[];
}

export function splitBashSegments(command: string): BashSegments | undefined {
  const segments: string[] = [];
  const separators: BashSeparatorKind[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) {
      continue;
    }
    const next = command[i + 1];

    if (inSingle) {
      // Single quotes suppress every expansion, backslash included.
      current += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && next !== undefined) {
        current += ch + next;
        i++;
        continue;
      }
      // `$(…)` and backticks still expand inside double quotes.
      if (ch === "`" || (ch === "$" && next === "(")) {
        return undefined;
      }
      current += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "\\") {
      if (next !== undefined) {
        current += ch + next;
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && next === "(")) {
      return undefined;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current);
      separators.push(ch);
      current = "";
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        i++;
        separators.push("||");
      } else {
        separators.push("|");
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&") {
      const prev = command[i - 1];
      // `2>&1` / `>&2` / `&>log` are redirections, not command separators.
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
      if (next === "&") {
        i++;
        separators.push("&&");
      } else {
        separators.push("&");
      }
      segments.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (inSingle || inDouble) {
    return undefined;
  }
  segments.push(current);
  return { segments, separators };
}

/**
 * The list of strings a Bash rule's pattern must match — ALL of them, not the
 * raw command as a whole (see `splitBashSegments`). Blank segments
 * (a trailing `;`, `a || b ||`) carry no command and are dropped; when nothing
 * but blanks remains the raw subject is used, so a degenerate command still
 * has to face the pattern instead of vacuously satisfying "every segment".
 */
export function bashMatchSubjects(command: string): string[] | undefined {
  const split = splitBashSegments(command);
  if (split === undefined) {
    return undefined;
  }
  const commands = split.segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
  return commands.length > 0 ? commands : [command];
}

// ── scoped project-runner rules (cd <workspace> && <runner> <verb>) ──

/** Family prefix: a pattern starting with this is a scoped rule, parsed strictly or never matches. */
export const SCOPED_PATTERN_PREFIX = "scoped-runner:";
export const SCOPED_RUNNER_BINARIES: readonly string[] = ["pnpm", "npm", "yarn", "bun"];
export const SCOPED_RUNNER_VERBS: readonly string[] = ["test", "typecheck", "build", "lint"];
/** Any of these ANYWHERE in the raw command (quote-unaware, deliberately blunt — mirrors run-allow-bash's screen):
 *  # comments, backticks/$ expansion, redirects, escapes and raw control characters except horizontal tab (including all newlines). */
const SCOPED_RAW_REJECT_RE = /[#`$<>\\\x00-\x08\x0a-\x1f\x7f]/;
/** One inert argv token in the runner segment: unquoted, no shell syntax. Same charset family as isInertAssignment's unquoted allowlist. */
const SCOPED_ARG_RE = /^[A-Za-z0-9_@%+,:./=-]+$/;

/** SHELL word-splitting whitespace only: space and horizontal tab — the two
 * characters Bash's lexer treats as token separators. Deliberately NOT JS
 * `String.prototype.trim()`, whose Unicode whitespace set (NBSP U+00A0,
 * U+2000–U+200A, U+2028/9, U+3000, U+FEFF, …) Bash treats as ORDINARY
 * characters: `cd /ws/proj\u00a0` is a different directory from `/ws/proj`, and
 * `\u00a0pnpm` is a different command from `pnpm`. Trimming those away would
 * accept a command whose real cd target or binary differs from the approved one
 * — a silent scope widening. Leaving them in place makes the comparison fail
 * (byte-exact, fail-closed) while keeping ordinary space/tab equivalence. */
function scopedTrimShell(value: string): string {
  return value.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

export interface ScopedRunnerRule { workspace: string; runner: string; verb: string; }

/** Host cwd is absolute POSIX on this target; unsupported spellings fail closed.
 * Spaces, quotes and glob characters are permitted in a workspace value, but
 * command recognition below requires a shell-literal quoting form for them.
 */
function isScopedWorkspace(workspace: string): boolean {
  return workspace.startsWith("/") && !/[\x00-\x1f\x7f]/.test(workspace);
}

/** Canonical serialization; fixed key order workspace,runner,verb (tests pin the literal). */
export function formatScopedRunnerPattern(workspace: string, runner: string, verb: string): string | undefined {
  if (!isScopedWorkspace(workspace)) return undefined;
  if (!SCOPED_RUNNER_BINARIES.includes(runner) || !SCOPED_RUNNER_VERBS.includes(verb)) return undefined;
  return `${SCOPED_PATTERN_PREFIX}${JSON.stringify({ workspace, runner, verb })}`;
}

/** Strict inverse. Undefined for anything not canonically shaped — including every malformed family member. */
export function parseScopedRunnerPattern(pattern: string): ScopedRunnerRule | undefined {
  if (!pattern.startsWith(SCOPED_PATTERN_PREFIX)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(pattern.slice(SCOPED_PATTERN_PREFIX.length)); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).sort().join(",") !== "runner,verb,workspace") return undefined;
  const { workspace, runner, verb } = parsed as Record<string, unknown>;
  if (typeof workspace !== "string" || !isScopedWorkspace(workspace)) return undefined;
  if (typeof runner !== "string" || !SCOPED_RUNNER_BINARIES.includes(runner)) return undefined;
  if (typeof verb !== "string" || !SCOPED_RUNNER_VERBS.includes(verb)) return undefined;
  // Reject duplicate JSON keys, extra whitespace, reordered keys and every
  // non-canonical family encoding. The formatter produces exactly this form.
  if (formatScopedRunnerPattern(workspace, runner, verb) !== pattern) return undefined;
  return { workspace, runner, verb };
}

/** Exactly one literal cd argument, with horizontal spacing equivalence.
 * Never treat unquoted glob/brace/paren/tilde syntax as a literal path.
 * Never synthesize a quote form containing its own quote delimiter.
 */
function scopedCdSegmentMatches(segment: string, workspace: string): boolean {
  if (!isScopedWorkspace(workspace)) return false;
  const arg = /^cd[ \t]+(.+)$/.exec(scopedTrimShell(segment))?.[1];
  if (arg === undefined) return false;
  if (/^[A-Za-z0-9_@%+,:./=-]+$/.test(workspace) && arg === workspace) return true;
  if (!workspace.includes('"') && arg === `"${workspace}"`) return true;
  if (!workspace.includes("'") && arg === `'${workspace}'`) return true;
  return false;
}

/** Runner segment: plain whitespace-split tokens (quotes in args fail SCOPED_ARG_RE by construction). */
function scopedRunnerSegmentParse(segment: string): { runner: string; verb: string } | undefined {
  const tokens = scopedTrimShell(segment).split(/[ \t]+/).filter((t) => t !== "");
  const runner = tokens[0]; const verb = tokens[1];
  if (runner === undefined || verb === undefined) return undefined;
  if (!SCOPED_RUNNER_BINARIES.includes(runner) || !SCOPED_RUNNER_VERBS.includes(verb)) return undefined;
  return tokens.slice(2).every((t) => SCOPED_ARG_RE.test(t)) ? { runner, verb } : undefined;
}

/** Shared walker: raw screen + exactly TWO segments joined by exactly ONE '&&', both non-blank. */
function scopedSplit(command: string): [string, string] | undefined {
  if (SCOPED_RAW_REJECT_RE.test(command)) return undefined;
  const split = splitBashSegments(command);   // undefined => substitution / unterminated quote
  if (split === undefined || split.segments.length !== 2 || split.separators.length !== 1 || split.separators[0] !== "&&") return undefined;
  const seg1 = scopedTrimShell(split.segments[0] ?? ""); const seg2 = scopedTrimShell(split.segments[1] ?? "");
  return seg1 !== "" && seg2 !== "" ? [seg1, seg2] : undefined;   // blank => leading/trailing separator or newline edge
}

/** MATCH time: strict structural match of a parsed rule against the raw command. */
export function matchScopedRunnerCommand(rule: ScopedRunnerRule, command: string): boolean {
  const segs = scopedSplit(command);
  if (segs === undefined || !scopedCdSegmentMatches(segs[0]!, rule.workspace)) return false;
  const parsed = scopedRunnerSegmentParse(segs[1]!);
  return parsed !== undefined && parsed.runner === rule.runner && parsed.verb === rule.verb;
}

/** CREATE time: recognize the exact form against the tab's canonical workspace. Same grammar, no drift. */
export function recognizeScopedRunnerCommand(command: string, workspace: string): ScopedRunnerRule | undefined {
  if (!isScopedWorkspace(workspace)) return undefined;
  const segs = scopedSplit(command);
  if (segs === undefined || !scopedCdSegmentMatches(segs[0]!, workspace)) return undefined;
  const parsed = scopedRunnerSegmentParse(segs[1]!);
  return parsed === undefined ? undefined : { workspace, runner: parsed.runner, verb: parsed.verb };
}


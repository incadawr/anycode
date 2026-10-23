/**

 * SessionPermissionRules is an in-memory store; persistence across restarts is
 * owned by each client, not this class (desktop main's settings-ipc / CLI's
 * `cli/settings-rules.ts`, design slice-P7.5-cut.md), which seed the store on
 * boot and append to their settings file on `add`. RuleAwarePermissionEngine
 * composes this store over any base PermissionEngine (typically
 * ModePermissionEngine — its mode table is never modified here).
 *
 * Semantics: a matching rule downgrades ONLY an "ask" ruling to "allow" — a
 * "deny" (plan-mode writes, the unknown-mode fail-closed branch) is never
 * overridden. This engine only ever narrows what escalates to the broker; the
 * dispatcher's own hook-vs-engine DECISION_RANK merge (deny > ask > allow)
 * still applies unchanged on top, so a PreToolUse hook can still ask/deny
 * regardless of a session rule.
 *
 * Command-line subjects are matched PER COMMAND, not per command line
 * (TASK.104): the command is split on the shell's separators and the pattern
 * must match every segment — see `splitBashSegments` for the rationale and the
 * fail-closed cases. `Bash` and (TASK.144) the desktop Codex bridge's
 * `CodexExec` share that treatment because they share the subject SHAPE; every
 * path/URL tool keeps raw whole-string matching.
 *
 * TASK.36 — scoped project-runner rules. A pattern starting with the prefix
 * `scoped-runner:` is a member of a separate family, never a glob (see
 * `SCOPED_PATTERN_PREFIX`). A member is parsed strictly (parse-or-die): a
 * malformed member matches NOTHING — it never falls back to picomatch, so a
 * hand-mangled member cannot silently widen to a near-global allow the way the
 * rejected brace-glob serialization could. A well-formed member describes the
 * ONE form `cd <workspace> && <runner> <verb> [inert args]` and is matched by
 * the SAME explicit command grammar the modal uses to propose it
 * (`recognizeScopedRunnerCommand` on the create side, `matchScopedRunnerCommand`
 * on the match side); both live here and the desktop reaches them through the
 * existing `permissions/safe-command` subpath re-export, so there is no twin to
 * drift. Matching is byte-exact: the `cd` argument must equal the workspace
 * under one supported literal spelling (unquoted, or double/single quoted when
 * the workspace does not itself contain that delimiter) — no path normalization,
 * so a trailing slash, a `--` form or `~` all reject (fail-closed). Segment and
 * token edges are trimmed of SHELL whitespace only (space, horizontal tab); JS
 * `trim()`'s wider Unicode set (NBSP, U+2028, …) is deliberately not applied,
 * because Bash treats those as ordinary characters — see `scopedTrimShell`.
 *
 * Taskana 4294 — always-allow rules are CONFINED to the session workspace for
 * the file-write tools (WORKSPACE_CONFINED_WRITE_TOOLS: Write/Edit/MultiEdit).
 * A matching rule (bare or patterned) may downgrade an "ask" to "allow" only
 * when the dispatcher-minted workspace facts (`request.workspace`, realpath-
 * resolved at the dispatch site) PROVE the target sits inside the session
 * workspace. Outside or unprovable => the ask stands: interactive -> modal,
 * unattended/no-client broker -> deny. A child session rooted at a
 * `.anycode/worktrees/<x>` worktree therefore cannot ride a blanket Edit rule
 * to edit the main checkout by absolute path. Bash is out of scope: its
 * command line is not path-analysable, so a blanket Bash rule remains a full
 * bypass by owner grant (residual documented in Taskana 4294).
 */

import picomatch from "picomatch";
import type { PermissionEngine, PermissionRequest, PermissionRule, PermissionRuling } from "../types/permissions.js";
import { WORKSPACE_CONFINED_WRITE_TOOLS, isProvablyInsideWorkspace } from "./workspace-policy.js";

/** Per-tool field read as the pattern-matching subject; tools absent here have no subject. */
const SUBJECT_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  Glob: "path",
  Grep: "path",
  WebFetch: "url",
  // TASK.144. Not a core tool: this is the name the desktop's Codex approval
  // bridge stamps on a `commandExecution` approval, whose input carries the
  // same `command: string` a Bash call does. It is listed here because rules
  // are matched by the tool name the USER approved, never by a translated one
  // — a stored `Bash` rule must not silently vouch for a foreign engine's
  // commands. Without an entry a patterned CodexExec rule has no subject and
  // so can never match (fail-closed), leaving a bare patternless
  // `{toolName:"CodexExec"}` — allow-EVERY-command — as the only rule a Codex
  // user could write. That footgun is the reason for the entry.
  CodexExec: "command",
};

/**
 * Tools whose subject is a shell COMMAND LINE rather than a single path/URL,
 * and which therefore match per-segment (see `bashMatchSubjects`). Membership
 * is about the shape of the subject, not about which engine produced it.
 */
function isCommandLineTool(toolName: string): boolean {
  return toolName === "Bash" || toolName === "CodexExec";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The string subject a rule's pattern is matched against, or undefined when
 * the tool/input has none. RAW for every tool, Bash included (slice-P7.16-cut.md
 * §4.2 REVISION 3, W1-FIX3 — reverts the W1-FIX/W1-FIX2 subject normalization).
 * An earlier revision stripped a leading env-assignment (`OUT=x node y.mjs` ->
 * `node y.mjs`) so a stored `node *` rule matched both forms; a third Codex
 * pass proved that unsafe: the assignment NAME, not just its value, alters
 * execution (`NODE_OPTIONS=--require=/tmp/payload.js node --version`,
 * `LD_PRELOAD=…`, `PATH=…`, `BASH_ENV=…` all change what the binary actually
 * does regardless of how "inert" the value looks) — an unbounded class no
 * value-inspection can close. Matching the literal command string means an
 * env-prefixed invocation (benign or hostile) never silently matches a
 * bare-binary rule; it re-asks, and the human sees the full prefix. The
 * create-time strip in the desktop's `permission-pattern.ts` is unaffected —
 * it only shapes what gets STORED, which is a glob that never executes.
 */

/**
 * Permission patterns are matched with negation and extglob DISABLED
 * (slice-P7.16-cut.md §4.2, W1-FIX4 — closes a Codex-found P1): picomatch's
 * defaults treat a leading `!` as NEGATION (`!node` would match every
 * command that is not literally `node`, i.e. almost everything, including
 * `rm -rf /`) and `@()/!()/*()/+()/?()` as EXTGLOBS. A permission pattern is
 * a plain glob — a human describing a class of commands to always-allow — it
 * is never meant to express "anything but X". Passing `{ nonegate: true,
 * noext: true }` makes a leading `!` and extglob parens match LITERALLY
 * instead of broadly: a stored `!node` pattern can now only match a command
 * that is the literal string `!node`, never a near-global allow. This closes
 * the class for every rule, directly typed or sanitizer-synthesized, not
 * just Bash's.
 */
function extractSubject(toolName: string, input: unknown): string | undefined {
  const field = SUBJECT_FIELD[toolName];
  if (!field || !isRecord(input)) {
    return undefined;
  }
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Any parenthesis in a permission pattern is rejected outright (slice-P7.16-cut.md
 * §4.2, FIX5 — closes a Codex-found P1 that survived W1-FIX4). picomatch ALWAYS
 * compiles `(`...`)` as a regex group, independent of the `noext` option — `noext`
 * only neutralizes the `@(`/`+(`/`!(` extglob PREFIXES by making the leading
 * sigil literal, but it leaves the parens themselves as group delimiters. That
 * means `*(**)`, `?(**)`, bare `(**)`, and `**()` all still compile to a regex
 * whose group swallows anything (proven by executing real picomatch: each of
 * these matched subject `rm -rf /` with `{ nonegate: true, noext: true }` set).
 * A flat command/path glob never needs a literal `(` or `)` — picomatch gives
 * no reliable way to match one literally either — so rejecting any pattern
 * containing a paren costs no real capability while closing the whole
 * `*(`/`?(`/`(`/`@(`/`+(`/`!(` widening class at once, not just the extglob-
 * prefixed subset noext already handled. A rejected rule simply fails to
 * match, so the request stays (or reverts to) "ask" — fail-closed, never a
 * silent allow. `{}`/`[]` are untouched: they are legitimate glob syntax
 * (e.g. `git {push,pull}`) and are not implicated in this widening.
 */
const PAREN_RE = /[()]/;

/**
 * Splits a Bash command into the individual commands a shell would run
 * (TASK.104; exported and separator-kind-aware as of TASK.35). Returns
 * `undefined` when the command must be treated as unsegmentable — the caller
 * then refuses the match (fail closed).
 *
 * **Why (TASK.104):** the pattern used to be matched against the WHOLE raw
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
 * **TASK.35:** now exported for `safe-command.ts`'s pipeline classifier (the
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
 * raw command as a whole (TASK.104, see `splitBashSegments`). Blank segments
 * (a trailing `;`, `a || b ||`) carry no command and are dropped; when nothing
 * but blanks remains the raw subject is used, so a degenerate command still
 * has to face the pattern instead of vacuously satisfying "every segment".
 */
function bashMatchSubjects(command: string): string[] | undefined {
  const split = splitBashSegments(command);
  if (split === undefined) {
    return undefined;
  }
  const commands = split.segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
  return commands.length > 0 ? commands : [command];
}

// ── TASK.36: scoped project-runner rules (cd <workspace> && <runner> <verb>) ──

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

function ruleMatches(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== toolName) {
    return false;
  }
  if (rule.pattern === undefined) {
    return true;
  }
  if (rule.pattern.startsWith(SCOPED_PATTERN_PREFIX)) {
    const scoped = parseScopedRunnerPattern(rule.pattern);
    if (scoped === undefined || !isCommandLineTool(toolName)) {
      return false; // malformed family member / wrong tool shape: NEVER falls back to glob
    }
    const subject = extractSubject(toolName, input);
    return subject !== undefined && matchScopedRunnerCommand(scoped, subject);
  }
  if (PAREN_RE.test(rule.pattern)) {
    return false;
  }
  const subject = extractSubject(toolName, input);
  if (subject === undefined) {
    // Unknown tool (or a known tool whose subject field is absent/non-string):
    // a patterned rule has nothing to compare against, so it cannot match.
    return false;
  }
  const isMatch = picomatch(rule.pattern, { nonegate: true, noext: true });
  if (!isCommandLineTool(toolName)) {
    // Path/URL subjects (Read/Edit/Write/Glob/Grep/WebFetch) are single values,
    // not command lines: they keep whole-string matching untouched.
    return isMatch(subject);
  }
  const subjects = bashMatchSubjects(subject);
  return subjects !== undefined && subjects.every((segment) => isMatch(segment));
}

/** In-memory store of always-allow rules; persistence is a client concern (see module doc above). */
export class SessionPermissionRules {
  private readonly rules: PermissionRule[] = [];

  add(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  list(): readonly PermissionRule[] {
    return this.rules;
  }

  /** True when some stored rule permits this tool call's toolName + subject. */
  matches(toolName: string, input: unknown): boolean {
    return this.rules.some((rule) => ruleMatches(rule, toolName, input));
  }
}

/**
 * Composes `base` with a SessionPermissionRules store: an "ask" ruling from
 * `base` is downgraded to "allow" when a stored rule matches; "allow" and
 * "deny" rulings pass through unchanged. With an empty store this is
 * behaviorally identical to `base` alone.
 */
export class RuleAwarePermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly rules: SessionPermissionRules,
  ) {}

  check(request: PermissionRequest): PermissionRuling {
    const ruling = this.base.check(request);
    if (ruling.decision !== "ask") {
      return ruling;
    }
    if (!this.rules.matches(request.toolName, request.input)) {
      return ruling;
    }
    // Taskana 4294: an always-allow rule (bare or patterned) never authorises a
    // file write the dispatcher could not PROVE lands inside the session
    // workspace (realpath-resolved facts, request.workspace). Outside or
    // unprovable => the ask stands: interactive -> modal, unattended -> deny.
    if (WORKSPACE_CONFINED_WRITE_TOOLS.has(request.toolName) && !isProvablyInsideWorkspace(request.workspace)) {
      return {
        decision: "ask",
        reason: `${request.toolName}: target is outside the session workspace (or not provably inside it); always-allow rules only cover writes inside the workspace`,
      };
    }
    return { decision: "allow", reason: `${request.toolName}: allowed by a session /allow rule` };
  }
}

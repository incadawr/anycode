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
 * overridden. And a tool whose metadata carries `mandatoryApproval` is never
 * downgraded at all: its ask always reaches the broker, even with a bare or
 * already-persisted matching rule (see ToolMetadata.mandatoryApproval). This
 * engine only ever narrows what escalates to the broker; the
 * dispatcher's own hook-vs-engine DECISION_RANK merge (deny > ask > allow)
 * still applies unchanged on top, so a PreToolUse hook can still ask/deny
 * regardless of a session rule.
 *
 * Command-line subjects are matched PER COMMAND, not per command line
 * the command is split on the shell's separators and the pattern
 * must match every segment — see `splitBashSegments` for the rationale and the
 * fail-closed cases. `Bash` and the desktop Codex bridge's
 * `CodexExec` share that treatment because they share the subject SHAPE; every
 * path/URL tool keeps raw whole-string matching.
 *
 * scoped project-runner rules. A pattern starting with the prefix
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
 * Bare and relative file-write rules are confined to the session workspace.
 * Scoped absolute masks match dispatcher-resolved targets, including outside it.

 */

import picomatch from "picomatch";
import { homedir } from "node:os";
import { canonicalWritePath, resolveWriteMask } from "./write-mask-node.js";
import type {
  PermissionEngine,
  PermissionRequest,
  PermissionRule,
  PermissionRuling,
  ProfilePermissionRules,
} from "../types/permissions.js";
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
  // Not a core tool: this is the name the desktop's Codex approval
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
import { bashMatchSubjects, SCOPED_PATTERN_PREFIX, parseScopedRunnerPattern, matchScopedRunnerCommand } from "./command-grammar.js";
export * from "./command-grammar.js";

const PAREN_RE = /[()]/;

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

/**
 * Applies an agent profile's `permissions.allow`/`permissions.deny` overlay
 * (md-profile frontmatter) around the session's engine. The overlay can only
 * NARROW what the session would otherwise do:
 *
 *  - `deny` — a matching rule refuses the call with no prompt, even when the
 *    session's mode or a global always-allow rule would have run it. A base
 *    `deny` is returned untouched so its more specific reason (plan mode,
 *    fail-closed unknown mode) survives.
 *  - `allow` — a matching rule resolves only a base `ask` to `allow`. A base
 *    `allow` needs no help and is returned unchanged; a base `deny` is never
 *    overridden (this is the same "a rule only downgrades an ask" law as
 *    `RuleAwarePermissionEngine`, which is what keeps an overlay from being
 *    wider than the session).
 *  - everything else — the base ruling, verbatim.
 *
 * `allow` inherits `RuleAwarePermissionEngine`'s workspace confinement: for
 * Write/Edit/MultiEdit a rule authorises the call only when the dispatcher's
 * facts prove the target inside the session workspace, so a profile cannot
 * hand its child an absolute-path write outside the workspace.
 *
 * Command-line tools (Bash/CodexExec) are matched per SEGMENT for both lists,
 * exactly as a stored rule is: one entry vouches for a whole pipeline only
 * when every segment matches it.
 */
export class ProfilePermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly rules: ProfilePermissionRules,
  ) {}

  check(request: PermissionRequest): PermissionRuling {
    const ruling = this.base.check(request);
    // A base "deny" is already the most restrictive answer and carries the
    // better reason (plan mode, unknown-mode fail-closed): never re-label it.
    if (ruling.decision === "deny") {
      return ruling;
    }
    if (this.rules.deny.some((rule) => ruleMatches(rule, request.toolName, request.input))) {
      return {
        decision: "deny",
        reason: `${request.toolName}: refused by the agent profile's permission rules`,
      };
    }
    if (ruling.decision !== "ask") {
      return ruling;
    }
    // Same mandatory-approval law as RuleAwarePermissionEngine: a profile
    // overlay is never wider than the session's own gate, and a
    // mandatory-approval tool's ask has no rule escape hatch at all.
    if (request.metadata.mandatoryApproval) {
      return ruling;
    }
    if (!this.rules.allow.some((rule) => ruleMatches(rule, request.toolName, request.input))) {
      return ruling;
    }
    // Same workspace confinement as an always-allow rule: the profile may
    // resolve a write ask only inside the session workspace.
    if (WORKSPACE_CONFINED_WRITE_TOOLS.has(request.toolName) && !isProvablyInsideWorkspace(request.workspace)) {
      return ruling;
    }
    return { decision: "allow", reason: `${request.toolName}: allowed by the agent profile's permission rules` };
  }
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

  /** Match write rules against dispatcher-resolved targets, with bare rules confined. */
  matchesRequest(request: PermissionRequest): boolean {
    if (!WORKSPACE_CONFINED_WRITE_TOOLS.has(request.toolName)) return this.matches(request.toolName, request.input);
    return this.rules.some((rule) => {
      if (rule.toolName !== request.toolName) return false;
      const pattern = rule.pattern ? resolveWriteMask(rule.pattern, homedir()) : undefined;
      if (pattern) {
        const rawTarget = request.workspace?.resolvedPath;
        const target = typeof rawTarget === "string" && rawTarget.startsWith("/") ? canonicalWritePath(rawTarget) : undefined;
        return typeof target === "string" && target.startsWith("/") && picomatch(pattern, { nonegate: true, noext: true, dot: true })(target);
      }
      return isProvablyInsideWorkspace(request.workspace) && ruleMatches(rule, request.toolName, request.input);
    });
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
    // A mandatory-approval tool's ask is never rule-resolvable — not by a
    // bare rule, not by an already-persisted one (rules seeded from settings
    // pass through the same store): only a human answer settles it.
    if (request.metadata.mandatoryApproval) {
      return ruling;
    }
    if (!this.rules.matchesRequest(request)) {
      if (WORKSPACE_CONFINED_WRITE_TOOLS.has(request.toolName) && !isProvablyInsideWorkspace(request.workspace) && this.rules.matches(request.toolName, request.input)) {
        return { decision: "ask", reason: `${request.toolName}: target is outside the session workspace (or not provably inside it); a scoped absolute path mask is required` };
      }
      return ruling;
    }
    return { decision: "allow", reason: `${request.toolName}: allowed by a session /allow rule` };
  }
}

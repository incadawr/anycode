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
 */

import picomatch from "picomatch";
import type { PermissionEngine, PermissionRequest, PermissionRule, PermissionRuling } from "../types/permissions.js";

/** Per-tool field read as the pattern-matching subject; tools absent here have no subject. */
const SUBJECT_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Glob: "path",
  Grep: "path",
  WebFetch: "url",
};

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

function ruleMatches(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== toolName) {
    return false;
  }
  if (rule.pattern === undefined) {
    return true;
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
  return picomatch(rule.pattern, { nonegate: true, noext: true })(subject);
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
    if (this.rules.matches(request.toolName, request.input)) {
      return { decision: "allow", reason: `${request.toolName}: allowed by a session /allow rule` };
    }
    return ruling;
  }
}

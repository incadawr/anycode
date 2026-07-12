/**
 * Pure CREATE-time sanitizer for Bash always-allow patterns
 * (working-docs/build/design/slice-P7.16-cut.md §4.2). Root-cause fix: the
 * naive `command.trim().split(/\s+/)[0]` used to pick the "first token" of a
 * Bash command mistakes a leading `NAME=value` env-assignment (or a bare
 * `env` prefix) for the binary — `OUT="/tmp/o" node x.mjs` produced the
 * garbage always-allow rule `Bash OUT="/tmp/o" *`. This module is consumed
 * by BOTH the permission modal's suggestion/build paths
 * (components/PermissionModal.tsx) and the Settings manual-add form (a later
 * wave) so every rule-creation path shares one classifier.
 *
 * **W1-FIX3 (Codex-terra pass 3, §4.2 REVISION 3):** matching is RAW —
 * `packages/core`'s `extractSubject` (permissions/rules.ts) compares a stored
 * pattern against the literal Bash command string, env-prefix and all. A
 * prior revision normalized the match subject too (stripping the same
 * leading env-prefix there), but that was reverted: the assignment NAME, not
 * just its value, can alter execution (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`,
 * `BASH_ENV`, …), a class no value-inspection can close. The strip in THIS
 * file only shapes what gets STORED/displayed — a glob is inert, it never
 * executes — so stripping the prefix at creation time is safe and still
 * satisfies the owner-facing goal (no `Bash OUT="/tmp/o" *` garbage rule).
 * The secure consequence: a stored `node *` rule matches bare `node …` but an
 * env-prefixed invocation (`OUT=x node …`, `NODE_OPTIONS=… node …`) does NOT
 * match — it re-asks, and the human sees the full prefix before deciding.
 */

/**
 * Splits a command into whitespace-separated tokens, treating `'…'`/`"…"`
 * quoted spans (with `\"` escapes inside double quotes) as part of the
 * current token — a naive `/\s+/` split would break `OUT="/tmp/a b"` into
 * two tokens and mis-pick `b"` as the binary. Quote characters and escape
 * backslashes are kept verbatim in the returned tokens (this function never
 * unquotes) so callers that rejoin tokens reproduce the original text
 * byte-for-byte outside of whitespace collapsing.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) {
      continue;
    }

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && command[i + 1] === '"') {
        current += ch + command[i + 1];
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      hasToken = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      current += ch;
      hasToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (hasToken) {
    tokens.push(current);
  }

  return tokens;
}

/** Matches a leading `NAME=` env-assignment token (`FOO=1`, `BAR='a b'`, `OUT="/tmp/o"`…) — only the prefix up to `=` is checked, the value is whatever follows. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * True when a token already matched by `ASSIGNMENT_RE` is PROVABLY free of
 * shell expansion/side-effects (slice-P7.16-cut.md §4.2 REVISION 2,
 * Codex-terra W1-FIX2 P1-a). Create-side only (W1-FIX3, §4.2 REVISION 3):
 * this predicate no longer has a security-load-bearing core twin — it just
 * decides what the STORED/displayed pattern looks like, since matching is
 * raw. The executor runs `shell:true`, so a token like
 * `FOO="$(id>/tmp/proof)"` is NOT inert — stripping it at creation would
 * produce a stored pattern that hides the command-substitution RHS from the
 * user. Enumerate-the-good (allowlist), fail closed otherwise: anything not
 * provably inert stops the walk, so the assignment stays in the displayed
 * pattern rather than being silently dropped.
 */
function isInertAssignment(token: string): boolean {
  const value = token.slice(token.indexOf("=") + 1);
  if (value === "") return true; // (i)  FOO=
  if (/^'[^'\n]*'$/.test(value)) return true; // (iii) single-quoted whole value: quotes suppress ALL expansion
  if (/^"[^"$`\\\n]*"$/.test(value)) return true; // (iv)  double-quoted whole value with NO $ ` \ " newline
  if (/^[A-Za-z0-9_@%+,:./=-]*$/.test(value)) return true; // (ii) unquoted inert allowlist
  return false; // anything else -> DON'T strip -> assignment stays in subject -> asks
}

/**
 * Index of the first token that is neither a provably-inert env-assignment
 * nor a single leading bare `env`. Shared walk used by both `commandBinary`
 * and `sanitizeBashPattern` (design §4.2: "commandBinary/sanitizeBashPattern
 * share the token walk"). Returns `tokens.length` when every token was
 * consumed (the command is nothing but assignments, e.g. `FOO=1`) — callers
 * treat that as the "never widen" fallback case, not as "skip everything and
 * return an empty rule". A leading `env` is skipped only when a next token
 * exists and does not start with `-` (blocks `env -S`/`env -i`/`env -u`/
 * `env --`, which change semantics) — otherwise `env` itself becomes the
 * binary (fail closed).
 */
function firstSurvivingIndex(tokens: readonly string[]): number {
  let i = 0;
  let envSkipped = false;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (ASSIGNMENT_RE.test(token) && isInertAssignment(token)) {
      i++;
      continue;
    }
    if (!envSkipped && token === "env") {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        envSkipped = true;
        i++;
        continue;
      }
    }
    break;
  }
  return i;
}

/**
 * First non-env-assignment token of a Bash command: skips leading tokens
 * matching `/^[A-Za-z_][A-Za-z0-9_]*=/` (assignment) and one leading bare
 * `env`. Returns `undefined` when the command tokenizes to nothing.
 * **Never-widen fallback:** when every token is an assignment (`FOO=1`),
 * returns the raw first token rather than `undefined` — a degenerate command
 * must still seed a narrow (if odd-looking) suggestion, not silently
 * disappear into a bare all-uses rule downstream.
 */
export function commandBinary(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return undefined;
  }
  const i = firstSurvivingIndex(tokens);
  return i < tokens.length ? tokens[i] : tokens[0];
}

/** Matches a pattern that is empty or consists solely of wildcard tokens (`""`, `"*"`, `"**"`, any run of `*`/whitespace) — the P1 guard's "would this auto-produce a match-everything rule?" check. */
const WILDCARD_ONLY_RE = /^[*\s]+$/;

/** Picomatch glob metacharacters (slice-P7.16-cut.md §4.2 REVISION 2, Codex-terra W1-FIX2 P1-b): a first surviving token containing one of these would broaden the stored pattern beyond the approved binary (globstar, a globstar-then-single-star segment, `?x`, `[a-z]*`, `{a,b}`) — reject the strip rather than auto-produce it. Extended (W1-FIX4, Codex P1) with `!`/`(`/`)`: a real command binary never contains these, but picomatch's negation (`!node`) and extglob (`@(node|rm)`) syntax do — matched RAW at the core (see `packages/core/src/permissions/rules.ts`'s `nonegate`/`noext` matcher options), so this only guards what gets STORED/displayed; without it a stored `!node`/`@(node|rm)` pattern would still be misleadingly narrow-looking while (pre-matcher-fix) matching almost everything. */
const GLOB_META_RE = /[*?[\]{!()]/;

/**
 * CREATE-time pattern sanitizer for Bash rules: strips leading
 * env-assignment tokens (and a bare leading `env`) from the PATTERN string
 * itself, preserving the rest verbatim (rejoined with single spaces).
 * Non-Bash patterns must never be passed here — callers gate on
 * `toolName === "Bash"` before calling.
 *
 * **Never-widen fallback (pure-assignment):** when every token is an
 * assignment, returns the input pattern completely unchanged (not even
 * whitespace-normalized) rather than collapsing to an empty/bare pattern.
 *
 * **P1 guard (Codex-terra, §4.2 REVISED):** if the stripped remainder is
 * empty or consists solely of wildcard tokens (`""`, `"*"`, `"**"`, or any
 * run of `*`/whitespace), the strip is REJECTED and the ORIGINAL input
 * pattern is returned unchanged — `"env *"` stays `"env *"`, `"FOO=* *"`
 * stays `"FOO=* *"`. Without this guard the naive strip collapsed both of
 * those to a bare `"*"`, which `ruleMatches` (packages/core) treats as
 * "match every Bash invocation" — a silent, auto-produced match-everything
 * rule. An explicit match-all is only ever the *blank pattern* → bare
 * `{toolName:"Bash"}` rule, a visible user choice, never a side effect of
 * sanitization.
 *
 * **P1-b guard (Codex-terra, §4.2 REVISION 2, W1-FIX2):** the wildcard-only
 * check above missed a hand-typed `"FOO=x "` followed by a globstar and a
 * trailing single-star segment — stripped to just that globstar segment,
 * which `picomatch` matches against EVERY command — a rule scoped to
 * `FOO=x` silently became all-Bash. So the strip is also rejected whenever
 * the FIRST SURVIVING TOKEN contains a picomatch glob metacharacter
 * (`GLOB_META_RE`), covering globstar / globstar-then-single-star, `?x`,
 * `[a-z]*`, `{a,b}`. This does not block legitimate `git *`/`node *`/
 * `make -j4`: their first token (`git`/`node`/`make`) is a literal word,
 * the glob lives in a later token.
 */
export function sanitizeBashPattern(pattern: string): string {
  const tokens = tokenizeCommand(pattern);
  if (tokens.length === 0) {
    return pattern;
  }
  const i = firstSurvivingIndex(tokens);
  if (i >= tokens.length) {
    return pattern;
  }
  const firstToken = tokens[i];
  const stripped = tokens.slice(i).join(" ");
  if (firstToken === undefined || stripped === "" || WILDCARD_ONLY_RE.test(stripped) || GLOB_META_RE.test(firstToken)) {
    return pattern;
  }
  return stripped;
}

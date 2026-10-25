/**
 * Tiny semver parser + range grammar for plugin `engines.anycode` compat
 * (Taskana 4732 S1-A, design §2). DELIBERATELY NOT a semver dependency —
 * plugins need exactly three pieces of npm-semver behaviour, and keeping them
 * in-house honors the no-new-npm-deps rule of the brief:
 *
 *  1. Parse `major.minor.patch` with an OPTIONAL, IGNORED prerelease/build
 *     suffix (`1.4.2-beta.1` ≡ `1.4.2`): the app ships no prereleases, so a
 *     plugin declaring one still matches its release version — the design's
 *     "prereleases ignored" ruling.
 *  2. Compare versions numerically per segment (leading zeros tolerated,
 *     garbage after the release triplet simply ignored rather than fatal).
 *  3. Match a range: comparator tokens `>=`, `>`, `<=`, `<`, `=` plus the
 *     `^` and `~` sugar, space = AND, `||` = OR. Malformed input NEVER throws
 *     — it matches nothing (`rangeMatches("garbage", v) === false`), the
 *     design's "garbage → no match": an incompatible-looking range makes the
 *     plugin inactive with a visible problem instead of failing boot.
 *
 * `""` (empty/absent range) matches everything, mirroring engines.anycode
 * "absent = any" from design §2.
 */

/** Loose `major.minor.patch` — an optional prerelease/build suffix is accepted and ignored. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/** Parsed three-segment version, prerelease/build already stripped. */
interface Version {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a version string. undefined for anything that does not start with
 * three numeric dot-separated segments (`compareSemver("garbage", ...)`
 * callers treat that as "no version", never as 0.0.0).
 */
export function parseSemver(input: string): Version | undefined {
  const m = VERSION_RE.exec(input.trim());
  if (!m) {
    return undefined;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** `parseSemver` + valid-semver guard. */
export function isValidSemver(input: string): boolean {
  return parseSemver(input) !== undefined;
}

/** -1 | 0 | 1 numeric segment comparison. Both inputs are pre-parsed. */
function compareParsed(a: Version, b: Version): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

/** String convenience over compareParsed; malformed inputs compare as undefined-safe NaN-like. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  return compareParsed(pa, pb);
}

// ---------------------------------------------------------------------------
// Range grammar (design §2): `>= > <= < =`, `^`, `~`, space = AND, `||` = OR.

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: Version;
}

/**
 * `^M.m.p`: `>=M.m.p` plus an upper bound that shrinks on leading zeros
 * (npm's rule — `^1.2.3` `<2.0.0`, `^0.1.3` `<0.2.0`, `^0.0.3` `<0.0.4`).
 * Always returns the PAIR (lower, upper) the token expands to.
 */
function caretBounds(v: Version): [Comparator, Comparator] {
  if (v.major > 0) {
    return [{ op: ">=", version: v }, { op: "<", version: { major: v.major + 1, minor: 0, patch: 0 } }];
  }
  if (v.minor > 0) {
    return [{ op: ">=", version: v }, { op: "<", version: { major: 0, minor: v.minor + 1, patch: 0 } }];
  }
  return [
    { op: ">=", version: v },
    { op: "<", version: { major: 0, minor: 0, patch: v.patch + 1 } },
  ];
}

/**
 * Parses one ` || `-separated alternative into its space-ANDed comparators.
 * Every token MUST parse (unknown operator, missing version, garbage →
 * undefined → the whole range matches nothing).
 */
function parseAlternative(text: string): Comparator[] | undefined {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
    const op = m?.[1] ?? "=";
    const rest = (m?.[2] ?? "").trim();
    const v = parseSemver(rest);
    if (!v) {
      return undefined;
    }
    switch (op) {
      case ">=":
      case ">":
      case "<=":
      case "<":
        comparators.push({ op, version: v });
        break;
      case "=":
        comparators.push({ op: "=", version: v });
        break;
      case "^": {
        const [lower, upper] = caretBounds(v);
        comparators.push(lower, upper);
        break;
      }
      case "~": {
        const [lower, upper] = tildeBounds(v);
        comparators.push(lower, upper);
        break;
      }
    }
  }
  return comparators;
}

/** `~M.m.p`: `>=M.m.p` AND `<M.(m+1).0` (npm's tilde; no zero-shrinking). */
function tildeBounds(v: Version): [Comparator, Comparator] {
  return [
    { op: ">=", version: v },
    { op: "<", version: { major: v.major, minor: v.minor + 1, patch: 0 } },
  ];
}

function matchesComparator(c: Comparator, v: Version): boolean {
  const cmp = compareParsed(v, c.version);
  switch (c.op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

/** Simple rendering for problem strings ("incompatible … (needs R)"). */
export function normalizeSemverRange(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * True when `version` satisfies `range` (loose AND/OR grammar above; an
 * empty/whitespace range matches everything; malformed input matches
 * nothing). A malformed `version` never matches a non-empty range.
 */
export function rangeMatches(range: string, version: string): boolean {
  const normalized = range.trim();
  if (normalized === "") {
    return true;
  }
  const v = parseSemver(version);
  if (!v) {
    return false;
  }
  for (const alternative of normalized.split("||")) {
    const comparators = parseAlternative(alternative);
    if (comparators !== undefined && comparators.every((c) => matchesComparator(c, v))) {
      return true;
    }
  }
  return false;
}

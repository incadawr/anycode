/**
 * Codex version-support POLICY evaluation — the pure core lifted out of
 * main/codex-manifest.ts (TASK.206) so that BOTH judges run the same code:
 *
 *  - main's Settings card / Doctor verdict / installer gate, which read the
 *    git-hosted `codex-support.json` manifest and the user's explicit
 *    `riskAcceptedVersions`;
 *  - the HOST preflight (`host/engines/codex/app-server-client.ts`), which is
 *    the only place that actually decides whether a Codex child starts.
 *
 * Before this module the host judged against a COMPILE-TIME constant
 * (`SUPPORTED_CODEX_VERSION` in host/engines/codex/protocol.ts) while the
 * screen judged against the manifest. The two could disagree — and did, live:
 * Settings said "Supported range: >=0.144.0 <0.152.0", Doctor said `ready`,
 * the in-app installer installed 0.151.0, and the host then refused to start
 * on it (GitHub issue #4, AnyCode 0.0.22). `riskAcceptedVersions` ("use it
 * anyway") never reached the host at all, so the button was inert on the one
 * path it existed for.
 *
 * `SUPPORTED_CODEX_VERSION` deliberately survives this move and keeps its
 * meaning: it is a pinned fact about the WIRE contract (which app-server
 * schema the committed `contract/pinned-contract.json` was generated against),
 * checked by contract-drift.test.ts. Support POLICY is a different thing with
 * a different name, and it lives here.
 *
 * A host module may never import from main/**, which is why the core lives in
 * shared/** — the same rule that put the engine-proxy carrier contract in
 * shared/engines.ts. VALUE-ONLY, zero I/O: the sole import is
 * shared/codex-support.ts (itself import-free), so this file is safe from
 * host/**, main/**, and the renderer alike.
 */
import { CODEX_MIN_FLOOR } from "./codex-support.js";

// ── semver + range evaluation (deliberately minimal: exactly the comparator
// grammar the manifest uses — `>= <= > < =` conjunctions like
// ">=0.144.0 <0.145.0" — no caret/tilde/prerelease, unknown syntax fails
// closed as "invalid", never "matches") ──

export interface ParsedCodexVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Strict `X.Y.Z` only — the shape `codex-cli --version` reports and npm versions use for stable releases. */
export function parseCodexSemver(version: string): ParsedCodexVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareCodexVersions(a: ParsedCodexVersion, b: ParsedCodexVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export interface CodexRangeComparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: ParsedCodexVersion;
}

/** One space-separated conjunction of comparators, or null when any token is unrecognized (fail-closed). */
export function parseCodexRange(range: string): CodexRangeComparator[] | null {
  const tokens = range.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") return null;
  const comparators: CodexRangeComparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
    if (!match) return null;
    const version = parseCodexSemver(match[2]!);
    if (version === null) return null;
    comparators.push({ op: (match[1] as CodexRangeComparator["op"] | undefined) ?? "=", version });
  }
  return comparators;
}

export function satisfiesCodexRange(version: ParsedCodexVersion, comparators: readonly CodexRangeComparator[]): boolean {
  return comparators.every(({ op, version: bound }) => {
    const cmp = compareCodexVersions(version, bound);
    switch (op) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      case "=":
        return cmp === 0;
    }
  });
}

// ── the policy itself ──

/**
 * The whole support policy reduced to what a verdict actually needs: the
 * manifest's ranges (in manifest order) plus the versions the user explicitly
 * risk-accepted. Deliberately NOT the manifest document — `recommended`,
 * `updatedAt`, `status`, `note` are display/installer concerns that no verdict
 * consults, and keeping them out is what lets this shape cross a process
 * boundary as a small, stable env payload (see `encodeCodexSupportPolicy`).
 */
export interface CodexSupportPolicy {
  ranges: readonly string[];
  /** `settings.codex.riskAcceptedVersions` — per-version explicit consent (codex-profiles cut §7.4). */
  riskAcceptedVersions: readonly string[];
}

export interface CodexVersionVerdict {
  allowed: boolean;
  /** True when allowed ONLY via a §7.4 risk acceptance — the "Untested Codex version" plaque case. */
  risk: boolean;
  /** The range the verdict was judged against, for the report/UI/refusal text. */
  supportedRange: string;
  /** Soft-allow (owner decision 10.10): allowed WITHOUT verification — patch of a verified minor, or above the verified ceiling. Absent when verified in-range or risk-accepted. */
  warning?: string;
}

/** Display form of a policy's supported set — the `||` join every report/refusal message shows. */
export function supportedRangeText(ranges: readonly string[]): string {
  return ranges.join(" || ");
}

/**
 * Forward-patch check (owner decision 10.10, supervisor correction): is there
 * an actually-satisfying witness version in the candidate's same major/minor
 * that the candidate is strictly LATER than? Witnesses probed are X.Y.0 plus
 * each comparator bound in that same major/minor (also bound.patch+1 for a
 * strict `>` lower bound); a witness must satisfy the complete conjunction.
 * Handles `=X.Y.Z` pins, lower bounds at nonzero patches, inclusive ceilings
 * and contradictory bounds, and prevents allowing a patch below the active
 * minimum just because it shares a minor with a verified version.
 */
function isVerifiedMinor(parsed: ParsedCodexVersion, comparators: readonly CodexRangeComparator[]): boolean {
  const witnesses: ParsedCodexVersion[] = [{ major: parsed.major, minor: parsed.minor, patch: 0 }];
  for (const { op, version: bound } of comparators) {
    if (bound.major !== parsed.major || bound.minor !== parsed.minor) continue;
    witnesses.push(bound);
    if (op === ">") witnesses.push({ major: bound.major, minor: bound.minor, patch: bound.patch + 1 });
  }
  return witnesses.some(
    (witness) => satisfiesCodexRange(witness, comparators) && compareCodexVersions(parsed, witness) > 0,
  );
}

/**
 * Effective ceiling of a union of ranges (supervisor correction): each valid
 * range's ceiling is its tightest `<`, `<=` or `=` bound; the union ceiling is
 * the highest of those, inclusive if any equally high ceiling is inclusive.
 * Malformed ranges are skipped; an unbounded valid range makes the union
 * unbounded (null). A version soft-allows above the union ceiling, or equal
 * to an EXCLUSIVE union ceiling.
 */
function overallCeiling(ranges: readonly string[]): { version: ParsedCodexVersion; inclusive: boolean } | null {
  let ceiling: { version: ParsedCodexVersion; inclusive: boolean } | null = null;
  for (const range of ranges) {
    const comparators = parseCodexRange(range);
    if (comparators === null) continue;
    const upper = comparators.filter(({ op }) => op === "<" || op === "<=" || op === "=");
    if (upper.length === 0) return null; // an unbounded valid range ⇒ union unbounded
    let tightest = upper[0]!;
    for (const bound of upper) {
      const cmp = compareCodexVersions(bound.version, tightest.version);
      // Within one conjunction the LOWEST upper bound constrains; on equal
      // versions the EXCLUSIVE bound wins (it admits strictly less).
      if (cmp < 0 || (cmp === 0 && bound.op === "<")) tightest = bound;
    }
    const entry = { version: tightest.version, inclusive: tightest.op !== "<" };
    if (ceiling === null) {
      ceiling = entry;
    } else {
      const cmp = compareCodexVersions(entry.version, ceiling.version);
      if (cmp > 0) ceiling = entry;
      else if (cmp === 0 && entry.inclusive) ceiling = { version: ceiling.version, inclusive: true };
    }
  }
  return ceiling;
}

/**
 * Judges one version string against a policy. Order matters:
 *  1. unparsable or below `CODEX_MIN_FLOOR` -> rejected ALWAYS (risk
 *     acceptance cannot override the compiled floor);
 *  2. inside any policy range -> allowed;
 *  3. explicitly risk-accepted (exact version match) -> allowed, flagged risk;
 *  4. a patch of a verified minor, or above/equal-to-the-exclusive verified
 *     ceiling -> allowed WITH a warning (soft-allow, owner decision 10.10);
 *  5. otherwise rejected.
 */
export function judgeCodexVersion(version: string, policy: CodexSupportPolicy): CodexVersionVerdict {
  const supportedRange = supportedRangeText(policy.ranges);
  const parsed = parseCodexSemver(version);
  if (parsed === null) return { allowed: false, risk: false, supportedRange };
  const floor = parseCodexSemver(CODEX_MIN_FLOOR);
  if (floor !== null && compareCodexVersions(parsed, floor) < 0) {
    return { allowed: false, risk: false, supportedRange };
  }
  for (const range of policy.ranges) {
    const comparators = parseCodexRange(range);
    if (comparators !== null && satisfiesCodexRange(parsed, comparators)) {
      return { allowed: true, risk: false, supportedRange };
    }
  }
  if (policy.riskAcceptedVersions.includes(version)) {
    return { allowed: true, risk: true, supportedRange };
  }
  // Owner decision 10.10 (option A): forward-compatibility soft-allows. The
  // floor check above still refuses everything below CODEX_MIN_FLOOR, and
  // versions in manifest gaps (an unverified minor below the ceiling) stay
  // refused — only PATCHES of verified minors and ABOVE-CEILING versions pass.
  for (const range of policy.ranges) {
    const comparators = parseCodexRange(range);
    if (comparators !== null && isVerifiedMinor(parsed, comparators)) {
      return { allowed: true, risk: false, supportedRange, warning: `Codex ${version} is a patch of a verified release but is not verified itself (supported ${supportedRange}) — not verified, running anyway.` };
    }
  }
  const ceiling = overallCeiling(policy.ranges);
  if (ceiling !== null && (compareCodexVersions(parsed, ceiling.version) > 0 || (!ceiling.inclusive && compareCodexVersions(parsed, ceiling.version) === 0))) {
    return { allowed: true, risk: false, supportedRange, warning: `Codex ${version} is newer than the verified range (${supportedRange}) — not verified, running anyway.` };
  }
  return { allowed: false, risk: false, supportedRange };
}

// ── the main -> host carrier (TASK.206) ──

/**
 * Env name the ACTIVE policy rides into every host fork under, stamped by
 * main's `engineEnv` overlay (main/index.ts) next to `ANYCODE_CODEX_BIN`.
 *
 * The same seam as the binary path for the same reason: main is the only
 * process that has the manifest and the settings, the host is the only process
 * that spawns the engine, and the overlay is rebuilt per fork off live main
 * state — so a manifest refresh or a fresh risk acceptance reaches the next
 * spawn with no cache to invalidate.
 *
 * It is stamped UNCONDITIONALLY (never "only when non-empty"): a host fork's
 * env starts as a spread of main's boot snapshot, so a name that main
 * sometimes omits is a name an ambient shell export could occupy. Always
 * writing it means the overlay overwrites any such value by construction.
 */
export const ENV_CODEX_SUPPORT_POLICY = "ANYCODE_CODEX_SUPPORT_POLICY";

/** Wire shape of the carrier — an object, not a bare array, so a later field can be added without a second env name. */
interface CodexSupportPolicyWire {
  ranges: string[];
  riskAccepted: string[];
}

export function encodeCodexSupportPolicy(policy: CodexSupportPolicy): string {
  const wire: CodexSupportPolicyWire = {
    ranges: [...policy.ranges],
    riskAccepted: [...policy.riskAcceptedVersions],
  };
  return JSON.stringify(wire);
}

/**
 * Decodes a carrier value, or returns null for "no usable policy travelled".
 *
 * null is NOT "allow everything" and never becomes one: it is the caller's cue
 * to fall back to its own compiled default (the host falls back to the wire
 * pin's ceiling — `host/engines/codex/version-policy.ts`). Every malformed
 * shape collapses to null rather than to a partially-honoured policy, because
 * a policy with, say, its ranges dropped but its risk list kept would be a
 * WIDER policy than either the sender or the receiver ever intended.
 *
 * A range token this evaluator cannot parse invalidates the whole payload for
 * the same reason `validateCodexManifest` refuses such a manifest: an
 * unparseable range can never match, so honouring the rest would silently
 * narrow support to whatever ranges happened to survive.
 */
export function decodeCodexSupportPolicy(raw: string | undefined): CodexSupportPolicy | null {
  if (raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as { ranges?: unknown; riskAccepted?: unknown };
  if (!Array.isArray(source.ranges) || source.ranges.length === 0) return null;
  const ranges: string[] = [];
  for (const entry of source.ranges) {
    if (typeof entry !== "string" || parseCodexRange(entry) === null) return null;
    ranges.push(entry);
  }
  const riskAccepted: string[] = [];
  if (source.riskAccepted !== undefined) {
    if (!Array.isArray(source.riskAccepted)) return null;
    for (const entry of source.riskAccepted) {
      if (typeof entry !== "string") return null;
      riskAccepted.push(entry);
    }
  }
  return { ranges, riskAcceptedVersions: riskAccepted };
}

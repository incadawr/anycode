/**
 * Pure-logic tests for the Bash pattern sanitizer (slice-P7.16-cut.md §4.2,
 * REVISION 3 per Codex-terra's W1-FIX3). Covers the exact input→stored-rule
 * table from the cut for all three remaining exports, plus the quote-aware
 * tokenizer's own edge cases (escapes, quoted-space spans), the never-widen
 * fallback, and the P1 never-widen-to-wildcard guard. `stripLeadingEnv` and
 * its core-parity test were REMOVED (W1-FIX3): matching is raw, so this
 * module no longer has a subject-normalization export to keep in parity with
 * a core twin — only the create-side sanitizer remains.
 */
import { describe, expect, it } from "vitest";
import { commandBinary, sanitizeBashPattern, tokenizeCommand } from "./permission-pattern.js";

describe("tokenizeCommand", () => {
  it("splits on plain whitespace", () => {
    expect(tokenizeCommand("git status")).toEqual(["git", "status"]);
  });

  it("collapses repeated whitespace and trims leading/trailing", () => {
    expect(tokenizeCommand("  git   status  ")).toEqual(["git", "status"]);
  });

  it("keeps a double-quoted span with an embedded space as one token", () => {
    expect(tokenizeCommand('OUT="/tmp/a b" node x.mjs')).toEqual(['OUT="/tmp/a b"', "node", "x.mjs"]);
  });

  it("keeps a single-quoted span with an embedded space as one token", () => {
    expect(tokenizeCommand("BAR='a b' make -j4")).toEqual(["BAR='a b'", "make", "-j4"]);
  });

  it("treats \\\" inside a double-quoted span as an escape, not a terminator", () => {
    expect(tokenizeCommand('echo "a \\"b\\" c" d')).toEqual(['echo', '"a \\"b\\" c"', "d"]);
  });

  it("returns an empty array for a blank/whitespace-only command", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("commandBinary — input → binary table (slice-P7.16-cut.md §4.2)", () => {
  it("git status → git (unchanged)", () => {
    expect(commandBinary("git status")).toBe("git");
  });

  it('OUT="/tmp/o" node scripts/x.mjs → node', () => {
    expect(commandBinary('OUT="/tmp/o" node scripts/x.mjs')).toBe("node");
  });

  it('OUT="/tmp/a b" node x.mjs → node (quoted-space assignment)', () => {
    expect(commandBinary('OUT="/tmp/a b" node x.mjs')).toBe("node");
  });

  it("FOO=1 BAR='a b' make -j4 → make", () => {
    expect(commandBinary("FOO=1 BAR='a b' make -j4")).toBe("make");
  });

  it("env FOO=1 python x.py → python", () => {
    expect(commandBinary("env FOO=1 python x.py")).toBe("python");
  });

  it("FOO=1 (pure assignment) → fallback to the raw first token, never widens", () => {
    expect(commandBinary("FOO=1")).toBe("FOO=1");
  });

  it("returns undefined for a blank command", () => {
    expect(commandBinary("")).toBeUndefined();
    expect(commandBinary("   ")).toBeUndefined();
  });
});

describe("sanitizeBashPattern — input → stored pattern table (slice-P7.16-cut.md §4.2)", () => {
  it("git * → git * (unchanged)", () => {
    expect(sanitizeBashPattern("git *")).toBe("git *");
  });

  it('OUT=1 rm * → rm *', () => {
    expect(sanitizeBashPattern("OUT=1 rm *")).toBe("rm *");
  });

  it("W1-FIX2 behavior flip: manual-add pattern OUT=* rm * stays unchanged -- unquoted '*' in the assignment value is a glob metachar, not provably inert (was stripped to 'rm *' pre-W1-FIX2)", () => {
    expect(sanitizeBashPattern("OUT=* rm *")).toBe("OUT=* rm *");
  });

  it("env FOO=1 python * → python *", () => {
    expect(sanitizeBashPattern("env FOO=1 python *")).toBe("python *");
  });

  it("FOO=1 (pure assignment) → returns the input pattern unchanged, never widens", () => {
    expect(sanitizeBashPattern("FOO=1")).toBe("FOO=1");
  });

  it("blank pattern passes through unchanged (empty)", () => {
    expect(sanitizeBashPattern("")).toBe("");
  });

  it("P1 guard: hand-typed 'env *' stays 'env *' — never widens to a bare wildcard", () => {
    expect(sanitizeBashPattern("env *")).toBe("env *");
  });

  it("P1 guard: hand-typed 'FOO=* *' stays 'FOO=* *' — never widens to a bare wildcard", () => {
    expect(sanitizeBashPattern("FOO=* *")).toBe("FOO=* *");
  });

  it("P1 guard: 'FOO=1 **' stays unchanged (double-star strip is also rejected)", () => {
    expect(sanitizeBashPattern("FOO=1 **")).toBe("FOO=1 **");
  });

  it("P1 guard does not affect a legitimately narrow strip (rm survives, only bare wildcards are rejected)", () => {
    expect(sanitizeBashPattern("OUT=x rm *")).toBe("rm *");
  });

  it("P1-b guard (W1-FIX2): hand-typed 'FOO=x **/*' stays unchanged -- strip would collapse to an all-matching glob", () => {
    expect(sanitizeBashPattern("FOO=x **/*")).toBe("FOO=x **/*");
  });

  it("P1-b guard: a directly hand-typed '**/*' pattern (not strip-induced) also returns unchanged", () => {
    expect(sanitizeBashPattern("**/*")).toBe("**/*");
  });

  it("P1-b guard: first-surviving-token glob metachars are all rejected ('?x', '[a-z]*', '{a,b}')", () => {
    expect(sanitizeBashPattern("FOO=x ?x cmd")).toBe("FOO=x ?x cmd");
    expect(sanitizeBashPattern("FOO=x [a-z]* cmd")).toBe("FOO=x [a-z]* cmd");
    expect(sanitizeBashPattern("FOO=x {a,b} cmd")).toBe("FOO=x {a,b} cmd");
  });

  it("P1-b guard does not block legit git */node */make -j4 (glob lives in a LATER token, first token is literal)", () => {
    expect(sanitizeBashPattern("git *")).toBe("git *");
    expect(sanitizeBashPattern("OUT=x node *")).toBe("node *");
    expect(sanitizeBashPattern("FOO=1 make -j4")).toBe("make -j4");
  });

  it("W1-FIX2 (P1-a): a command-substitution env value is NOT stripped -- returns the original pattern unchanged", () => {
    expect(sanitizeBashPattern('FOO="$(id>/tmp/proof)" node *')).toBe('FOO="$(id>/tmp/proof)" node *');
  });

  it("W1-FIX2: a single-quoted inert value still strips", () => {
    expect(sanitizeBashPattern("FOO='$(id)' node *")).toBe("node *");
  });

  it("W1-FIX2: env -i is NOT skipped (flag changes semantics) -- returns the original pattern unchanged", () => {
    expect(sanitizeBashPattern("env -i node *")).toBe("env -i node *");
  });

  it("P7.16 W1-FIX4 security PoC: 'FOO=x !node' is NOT stripped to '!node' -- negation metachar guard, returns unchanged", () => {
    expect(sanitizeBashPattern("FOO=x !node")).toBe("FOO=x !node");
  });

  it("P7.16 W1-FIX4 security PoC: 'FOO=x @(node|rm)' is NOT stripped to '@(node|rm)' -- extglob metachar guard, returns unchanged", () => {
    expect(sanitizeBashPattern("FOO=x @(node|rm)")).toBe("FOO=x @(node|rm)");
  });

  it("P7.16 W1-FIX4: legit strips still work -- 'OUT=/tmp/o node *' -> 'node *'", () => {
    expect(sanitizeBashPattern("OUT=/tmp/o node *")).toBe("node *");
  });
});

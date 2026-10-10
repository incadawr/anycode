/**
 * The policy core both judges share (TASK.206). `judgeCodexVersion` is the
 * function `main/codex-manifest.ts`'s `codexVersionVerdict` now delegates to,
 * so its own suite (codex-manifest.test.ts) still covers the manifest-shaped
 * facade; what is pinned HERE is the part that did not exist before: the
 * carrier that moves a policy from main into a host fork, and the rule that a
 * broken carrier decodes to null rather than to a partially-honoured policy.
 */
import { describe, expect, it } from "vitest";
import { CODEX_MIN_FLOOR } from "./codex-support.js";
import {
  decodeCodexSupportPolicy,
  encodeCodexSupportPolicy,
  judgeCodexVersion,
  supportedRangeText,
  type CodexSupportPolicy,
} from "./codex-version-policy.js";

const POLICY: CodexSupportPolicy = { ranges: [">=0.144.0 <0.152.0"], riskAcceptedVersions: [] };

describe("judgeCodexVersion", () => {
  it("allows a version inside a range and names the range it judged against", () => {
    const verdict = judgeCodexVersion("0.151.0", POLICY);
    expect(verdict).toEqual({ allowed: true, risk: false, supportedRange: ">=0.144.0 <0.152.0" });
    expect(verdict.warning).toBeUndefined();
  });

  it("soft-allows a version above the ceiling with a warning (owner decision 10.10)", () => {
    const verdict = judgeCodexVersion("0.152.0", POLICY);
    expect(verdict.allowed).toBe(true);
    expect(verdict.risk).toBe(false);
    expect(verdict.warning).toMatch(/not verified, running anyway/);
  });

  it("soft-allows a patch of a verified minor pinned exactly", () => {
    const verdict = judgeCodexVersion("0.162.1", { ranges: ["=0.162.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.risk).toBe(false);
    expect(verdict.warning).toMatch(/patch of a verified release/);
  });

  it("refuses a patch of a NON-verified minor (manifest gap)", () => {
    const verdict = judgeCodexVersion("0.145.3", { ranges: [">=0.144.0 <0.145.0", ">=0.146.0 <0.147.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(false);
  });

  it("refuses a version above the floor but below the active range", () => {
    const verdict = judgeCodexVersion("0.145.0", { ranges: [">=0.146.0 <0.147.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(false);
  });

  it("treats an exclusive-ceiling equality as above the ceiling (soft-allow)", () => {
    const verdict = judgeCodexVersion("0.152.0", { ranges: [">=0.144.0 <0.152.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toMatch(/not verified, running anyway/);
  });

  it("a conjunction's ceiling is its LOWEST upper bound, exclusive wins on equality", () => {
    // `>=0.144.0 <0.146.0 <0.150.0`: the effective ceiling is 0.146.0 (the
    // lowest upper bound), exclusive — so 0.146.0 itself soft-allows.
    const verdict = judgeCodexVersion("0.146.0", { ranges: [">=0.144.0 <0.146.0 <0.150.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toMatch(/not verified, running anyway/);
    // Above that lowest bound soft-allows too.
    expect(judgeCodexVersion("0.147.0", { ranges: [">=0.144.0 <0.146.0 <0.150.0"], riskAcceptedVersions: [] }).allowed).toBe(true);
    // Inside the conjunction (below BOTH upper bounds) is verified, no warning.
    const inside = judgeCodexVersion("0.145.0", { ranges: [">=0.144.0 <0.146.0 <0.150.0"], riskAcceptedVersions: [] });
    expect(inside.allowed).toBe(true);
    expect(inside.warning).toBeUndefined();
  });

  it("comparator-order permutations do not change the conjunction ceiling", () => {
    const ranges = [">=0.144.0 <0.146.0 <0.150.0", ">=0.144.0 <0.150.0 <0.146.0", "<0.146.0 >=0.144.0 <0.150.0", "<0.150.0 <0.146.0 >=0.144.0"];
    for (const range of ranges) {
      const verdict = judgeCodexVersion("0.146.0", { ranges: [range], riskAcceptedVersions: [] });
      expect(verdict.allowed).toBe(true);
      expect(verdict.warning).toMatch(/not verified, running anyway/);
      const inside = judgeCodexVersion("0.145.0", { ranges: [range], riskAcceptedVersions: [] });
      expect(inside.allowed).toBe(true);
      expect(inside.warning).toBeUndefined();
    }
  });

  it("an inclusive bound beats an exclusive one at the SAME lowest version (verified, no warning)", () => {
    // `>=0.144.0 <=0.146.0 <0.146.0`: 0.146.0 is admitted by the inclusive
    // bound and refused by the exclusive one — the conjunction is EMPTY, so
    // nothing in it is verified and the tightest ceiling is the exclusive
    // equality; 0.146.0 soft-allows above the exclusive ceiling.
    const verdict = judgeCodexVersion("0.146.0", { ranges: [">=0.144.0 <=0.146.0 <0.146.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toMatch(/not verified, running anyway/);
  });

  it("union behavior stays correct: highest per-range ceiling wins, gaps stay refused", () => {
    const gapRanges = [">=0.144.0 <0.145.0", ">=0.146.0 <0.147.0"];
    // Union ceiling is 0.147.0 (highest per-range ceiling), exclusive.
    expect(judgeCodexVersion("0.147.0", { ranges: gapRanges, riskAcceptedVersions: [] }).allowed).toBe(true);
    expect(judgeCodexVersion("0.148.0", { ranges: gapRanges, riskAcceptedVersions: [] }).allowed).toBe(true);
    // A gap patch stays refused (its minor is unverified), even below the ceiling.
    expect(judgeCodexVersion("0.145.3", { ranges: gapRanges, riskAcceptedVersions: [] }).allowed).toBe(false);
  });

  it("treats an inclusive-ceiling equality as verified in-range (no warning)", () => {
    const verdict = judgeCodexVersion("0.152.0", { ranges: [">=0.144.0 <=0.152.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toBeUndefined();
  });

  it("a pin at a nonzero patch allows only NEWER patches", () => {
    const newer = judgeCodexVersion("0.162.4", { ranges: ["=0.162.3"], riskAcceptedVersions: [] });
    expect(newer.allowed).toBe(true);
    expect(newer.warning).toMatch(/patch of a verified release/);
    expect(judgeCodexVersion("0.162.2", { ranges: ["=0.162.3"], riskAcceptedVersions: [] }).allowed).toBe(false);
  });

  it("refuses a same-minor version below a nonzero lower bound", () => {
    expect(judgeCodexVersion("0.150.1", { ranges: [">=0.150.3 <0.151.0"], riskAcceptedVersions: [] }).allowed).toBe(false);
  });

  it("a higher version outside an exact pin soft-allows with a warning", () => {
    const verdict = judgeCodexVersion("0.163.0", { ranges: ["=0.162.0"], riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toMatch(/not verified, running anyway/);
  });

  it("allows an above-ceiling version that is explicitly risk-accepted, and flags it as risk", () => {
    const verdict = judgeCodexVersion("0.152.0", { ...POLICY, riskAcceptedVersions: ["0.152.0"] });
    expect(verdict).toEqual({ allowed: true, risk: true, supportedRange: ">=0.144.0 <0.152.0" });
    expect(verdict.warning).toBeUndefined();
  });

  it("matches a risk acceptance EXACTLY — a neighbouring gap version is not covered", () => {
    const gapRanges = [">=0.144.0 <0.145.0", ">=0.146.0 <0.147.0"];
    const accepted = judgeCodexVersion("0.145.0", { ranges: gapRanges, riskAcceptedVersions: ["0.145.0"] });
    expect(accepted.allowed).toBe(true);
    expect(accepted.risk).toBe(true);
    expect(judgeCodexVersion("0.145.1", { ranges: gapRanges, riskAcceptedVersions: ["0.145.0"] }).allowed).toBe(false);
  });

  it("holds CODEX_MIN_FLOOR against both a widened range and a risk acceptance", () => {
    const belowFloor = { ranges: [">=0.100.0 <0.152.0"], riskAcceptedVersions: ["0.100.5"] };
    expect(judgeCodexVersion("0.100.5", belowFloor)).toEqual({
      allowed: false,
      risk: false,
      supportedRange: ">=0.100.0 <0.152.0",
    });
    expect(judgeCodexVersion(CODEX_MIN_FLOOR, belowFloor).allowed).toBe(true);
  });

  it("rejects an unparsable version", () => {
    expect(judgeCodexVersion("banana", POLICY).allowed).toBe(false);
    expect(judgeCodexVersion("", POLICY).allowed).toBe(false);
  });

  it("joins several ranges with || — the exact display form the doctor report carries", () => {
    expect(supportedRangeText([">=0.144.0 <0.145.0", ">=0.146.0 <0.147.0"])).toBe(
      ">=0.144.0 <0.145.0 || >=0.146.0 <0.147.0",
    );
  });
});

describe("the main -> host carrier", () => {
  it("round-trips a policy through the env value", () => {
    const policy: CodexSupportPolicy = {
      ranges: [">=0.144.0 <0.152.0", ">=0.160.0 <0.161.0"],
      riskAcceptedVersions: ["0.152.0"],
    };
    expect(decodeCodexSupportPolicy(encodeCodexSupportPolicy(policy))).toEqual(policy);
  });

  it("decodes an empty risk list to an empty list, not to a missing field", () => {
    expect(decodeCodexSupportPolicy(encodeCodexSupportPolicy(POLICY))).toEqual({
      ranges: [">=0.144.0 <0.152.0"],
      riskAcceptedVersions: [],
    });
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["not JSON", "{"],
    ["a bare array", '[">=0.144.0 <0.152.0"]'],
    ["a JSON scalar", '"policy"'],
    ["ranges missing", '{"riskAccepted":["0.152.0"]}'],
    ["ranges empty", '{"ranges":[],"riskAccepted":[]}'],
    ["a non-string range", '{"ranges":[144],"riskAccepted":[]}'],
    ["an unparseable range token", '{"ranges":[">=0.144"],"riskAccepted":[]}'],
    ["a non-array risk list", '{"ranges":[">=0.144.0 <0.152.0"],"riskAccepted":"0.152.0"}'],
    ["a non-string risk entry", '{"ranges":[">=0.144.0 <0.152.0"],"riskAccepted":[152]}'],
  ])("decodes %s to null — the caller's cue to fall back, never a partial policy", (_label, raw) => {
    expect(decodeCodexSupportPolicy(raw as string | undefined)).toBeNull();
  });

  it("refuses the WHOLE payload when only one of several ranges is unparseable", () => {
    // Honouring the survivors would silently narrow support to a range the
    // sender never declared — the same rule validateCodexManifest applies.
    expect(decodeCodexSupportPolicy('{"ranges":[">=0.144.0 <0.152.0","banana"],"riskAccepted":[]}')).toBeNull();
  });
});

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
  });

  it("rejects a version above the ceiling", () => {
    expect(judgeCodexVersion("0.152.0", POLICY).allowed).toBe(false);
  });

  it("allows an above-ceiling version that is explicitly risk-accepted, and flags it as risk", () => {
    const verdict = judgeCodexVersion("0.152.0", { ...POLICY, riskAcceptedVersions: ["0.152.0"] });
    expect(verdict).toEqual({ allowed: true, risk: true, supportedRange: ">=0.144.0 <0.152.0" });
  });

  it("matches a risk acceptance EXACTLY — a neighbouring patch is not covered", () => {
    expect(judgeCodexVersion("0.152.1", { ...POLICY, riskAcceptedVersions: ["0.152.0"] }).allowed).toBe(false);
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

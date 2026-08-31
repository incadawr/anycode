/**
 * The host's own half of TASK.206: which policy a preflight judges against,
 * resolved from the fork env main composed. Three properties, one test each:
 * the delivered policy is honoured, a risk acceptance overrides the ceiling,
 * and NO policy falls back to the compiled wire pin rather than to "allow".
 */
import { describe, expect, it } from "vitest";
import {
  ENV_CODEX_SUPPORT_POLICY,
  encodeCodexSupportPolicy,
} from "../../../shared/codex-version-policy.js";
import { SUPPORTED_CODEX_VERSION, isSupportedCodexVersion, parseCodexVersion } from "./protocol.js";
import { resolveHostCodexVersionPolicy } from "./version-policy.js";

function version(text: string) {
  const parsed = parseCodexVersion(`codex-cli ${text}\n`);
  if (parsed === null) throw new Error(`fixture version does not parse: ${text}`);
  return parsed;
}

function envWith(ranges: string[], riskAcceptedVersions: string[] = []): NodeJS.ProcessEnv {
  return { [ENV_CODEX_SUPPORT_POLICY]: encodeCodexSupportPolicy({ ranges, riskAcceptedVersions }) };
}

describe("resolveHostCodexVersionPolicy", () => {
  it("judges by the DELIVERED range, not by the compiled wire pin", () => {
    // 0.151.0 is inside the compiled pin (<0.152.0) but outside this manifest
    // range, so a host still judging by the constant would allow it. The
    // reverse direction is covered by the risk case below.
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.144.0 <0.146.0"]));
    expect(isSupportedCodexVersion(version("0.151.0"))).toBe(true);
    expect(policy.allows(version("0.151.0"))).toBe(false);
    expect(policy.allows(version("0.145.9"))).toBe(true);
    expect(policy.supportedRange).toBe(">=0.144.0 <0.146.0");
  });

  it("starts a version ABOVE the ceiling once it is in riskAcceptedVersions", () => {
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.144.0 <0.152.0"], ["0.152.0"]));
    expect(policy.allows(version("0.152.0"))).toBe(true);
    // Only the accepted version, and only exactly.
    expect(policy.allows(version("0.152.1"))).toBe(false);
  });

  it("names the ACTIVE range, `||`-joined, for the refusal message", () => {
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.144.0 <0.145.0", ">=0.146.0 <0.147.0"]));
    expect(policy.supportedRange).toBe(">=0.144.0 <0.145.0 || >=0.146.0 <0.147.0");
  });

  it.each([
    ["no carrier at all (an older main)", {}],
    ["a blank carrier", { [ENV_CODEX_SUPPORT_POLICY]: "" }],
    ["an unparseable carrier", { [ENV_CODEX_SUPPORT_POLICY]: "{not json" }],
    ["a structurally broken carrier", { [ENV_CODEX_SUPPORT_POLICY]: '{"ranges":[]}' }],
  ])("falls back to the compiled wire pin for %s — absence of policy is not absence of a check", (_label, env) => {
    const policy = resolveHostCodexVersionPolicy(env as NodeJS.ProcessEnv);
    expect(policy.supportedRange).toBe(SUPPORTED_CODEX_VERSION);
    // Byte-for-byte the pre-TASK.206 predicate: a bare ceiling, no floor.
    expect(policy.allows(version("0.151.0"))).toBe(true);
    expect(policy.allows(version("0.152.0"))).toBe(false);
    expect(policy.allows(version("1.0.0"))).toBe(false);
    expect(policy.allows(version("0.100.0"))).toBe(true);
  });
});

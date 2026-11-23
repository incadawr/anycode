import { describe, expect, it } from "vitest";
import {
  ENV_CODEX_SUPPORT_POLICY,
  encodeCodexSupportPolicy,
} from "../../../shared/codex-version-policy.js";
import { isSupportedCodexVersion, parseCodexVersion } from "./protocol.js";
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
    // 0.144.5 is inside the compiled pin but below this manifest range's
    // floor, so a host still judging by the constant would allow it — the
    // delivered-range refusal probe. 0.151.0 is above the delivered ceiling
    // and now SOFT-ALLOWS (owner decision 10.10), so `allows` is true there.
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.145.0 <0.146.0"]));
    expect(isSupportedCodexVersion(version("0.144.5"))).toBe(true);
    expect(policy.judge(version("0.144.5")).allowed).toBe(false);
    expect(policy.judge(version("0.151.0")).allowed).toBe(true);
    expect(policy.judge(version("0.145.9")).allowed).toBe(true);
    expect(policy.supportedRange).toBe(">=0.145.0 <0.146.0");
  });

  it("soft-allows above the delivered ceiling with a warning, null when verified", () => {
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.144.0 <0.146.0"]));
    expect(policy.judge(version("0.150.0")).allowed).toBe(true);
    expect(policy.judge(version("0.150.0")).newerVersionNotice).toMatch(/newer than the tested range/);
    expect(policy.judge(version("0.145.9")).newerVersionNotice).toBeUndefined();
  });

  it("gives the same Settings notice with or without legacy consent", () => {
    const policy = resolveHostCodexVersionPolicy(envWith([">=0.144.0 <0.152.0"], ["0.152.0"]));
    expect(policy.judge(version("0.152.0")).allowed).toBe(true);
    expect(policy.judge(version("0.152.0")).newerVersionNotice).toBeDefined();
    expect(policy.judge(version("0.153.0")).allowed).toBe(true);
    expect(policy.judge(version("0.153.0")).newerVersionNotice).toMatch(/newer than the tested range/);
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
  ])("uses the bundled policy for %s", (_label, env) => {
    const policy = resolveHostCodexVersionPolicy(env as NodeJS.ProcessEnv);
    expect(policy.judge(version("1.0.0"))).toMatchObject({ allowed: true, risk: false, newerVersionNotice: expect.any(String) });
    expect(policy.judge(version("0.100.0")).allowed).toBe(false);
  });
});

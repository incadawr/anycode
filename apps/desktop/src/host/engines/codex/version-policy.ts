/**
 * Which Codex versions THIS host will actually start (TASK.206).
 *
 * Deliberately NOT in protocol.ts. That module owns `SUPPORTED_CODEX_VERSION`,
 * which is a pinned fact about the WIRE CONTRACT — the app-server schema the
 * committed `contract/pinned-contract.json` was generated against, guarded by
 * contract/contract-drift.test.ts. Support POLICY is a different question with
 * a different owner (the `codex-support.json` manifest plus the user's
 * `riskAcceptedVersions`), and until this module existed the host answered the
 * policy question with the contract constant. That is the whole defect: the
 * Settings card advertised the manifest range, Doctor reported `ready`, the
 * in-app installer installed a version inside that range — and the host then
 * refused to start on it, while "use it anyway" never reached the host at all.
 *
 * Main stamps the active policy into every host fork's env
 * (`ENV_CODEX_SUPPORT_POLICY`, written by `engineEnv` in main/index.ts next to
 * `ANYCODE_CODEX_BIN`). This module reads it.
 *
 * FAIL-SAFE, not fail-open. "No policy travelled" — an older main that does not
 * stamp the carrier, a blank value, an unparseable payload — resolves to the
 * COMPILED WIRE PIN: exactly the check this host performed before TASK.206, no
 * floor, ceiling `SUPPORTED_CODEX_VERSION`. Absence of a policy therefore means
 * the previous check, never the absence of a check.
 */
import {
  ENV_CODEX_SUPPORT_POLICY,
  decodeCodexSupportPolicy,
  judgeCodexVersion,
  supportedRangeText,
} from "../../../shared/codex-version-policy.js";
import { SUPPORTED_CODEX_VERSION, isSupportedCodexVersion, type CodexVersion } from "./protocol.js";

export interface HostCodexVersionPolicy {
  /**
   * The range this policy judges against, verbatim, for the refusal message.
   * The ACTIVE range (manifest, `||`-joined) when a policy travelled; the
   * compiled wire pin when none did. Available even when the version output
   * was unparseable, which is why it is a field rather than a return of
   * `allows`.
   */
  supportedRange: string;
  allows(version: CodexVersion): boolean;
}

/** Resolves the policy ONE preflight will judge against, from that client's source env. */
export function resolveHostCodexVersionPolicy(env: NodeJS.ProcessEnv): HostCodexVersionPolicy {
  const policy = decodeCodexSupportPolicy(env[ENV_CODEX_SUPPORT_POLICY]);
  if (policy === null) {
    return {
      supportedRange: SUPPORTED_CODEX_VERSION,
      allows: (version) => isSupportedCodexVersion(version),
    };
  }
  return {
    supportedRange: supportedRangeText(policy.ranges),
    allows: (version) => judgeCodexVersion(`${version.major}.${version.minor}.${version.patch}`, policy).allowed,
  };
}

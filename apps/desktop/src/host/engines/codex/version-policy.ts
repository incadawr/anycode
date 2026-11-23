import { BUNDLED_CODEX_MANIFEST } from "../../../shared/codex-support.js";
import {
  decodeCodexSupportPolicy,
  ENV_CODEX_SUPPORT_POLICY,
  judgeCodexVersion,
  supportedRangeText,
} from "../../../shared/codex-version-policy.js";
import type { CodexVersion } from "./protocol.js";

/** An older main may omit the carrier. Apply the same bundled policy as Settings in that case. */
export function resolveHostCodexVersionPolicy(env: NodeJS.ProcessEnv) {
  const policy = decodeCodexSupportPolicy(env[ENV_CODEX_SUPPORT_POLICY]) ?? {
    ranges: BUNDLED_CODEX_MANIFEST.supported.map(entry => entry.range),
    riskAcceptedVersions: [],
  };
  return {
    supportedRange: supportedRangeText(policy.ranges),
    judge: ({ major, minor, patch }: CodexVersion) => judgeCodexVersion(`${major}.${minor}.${patch}`, policy),
  };
}

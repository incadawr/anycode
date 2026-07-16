/**
 * LIVE smoke of the Codex installer (gate B "S", cut §13.2): downloads the
 * REAL `@openai/codex` platform artifact of the bundled-manifest version from
 * registry.npmjs.org into a THROWAWAY tmp home (never the real ~/.anycode),
 * verifies the registry sha512, extracts the vendor subtree with the
 * production reader, and proves `<extracted>/bin/codex --version` answers.
 *
 * Opt-in by env (`ANYCODE_CODEX_LIVE_SMOKE=1`) — without it every case is an
 * explicit SKIP, never a green PASS (hazard §14.11: a smoke that cannot reach
 * the network must say SKIP, not lie). The tmp home is FIXED (not mkdtemp) so
 * repeat runs reuse the ~115 MiB download instead of re-fetching
 * (`alreadyInstalled` fast path) — download once, assert many times.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_CODEX_MANIFEST } from "../shared/codex-support.js";
import { installCodexVersion } from "./codex-install.js";

const LIVE = process.env.ANYCODE_CODEX_LIVE_SMOKE === "1";
const SMOKE_HOME = join(tmpdir(), "anycode-codex-live-smoke-home");
const VERSION = BUNDLED_CODEX_MANIFEST.recommended;

describe("codex install live smoke (real npm registry; SKIP without ANYCODE_CODEX_LIVE_SMOKE=1)", () => {
  it.runIf(LIVE)(
    `downloads the real @openai/codex@${VERSION}, verifies sha512, extracts, and the binary answers --version`,
    async () => {
      const result = await installCodexVersion(VERSION, { home: SMOKE_HOME });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(existsSync(result.binaryPath)).toBe(true);
      expect(statSync(result.binaryPath).mode & 0o111).not.toBe(0);
      // The runtime neighbours the binary resolves relative to itself (W0-R2 §4).
      expect(existsSync(join(result.installDir, "vendor"))).toBe(true);

      const probe = spawnSync(result.binaryPath, ["--version"], {
        timeout: 30_000,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
      expect(probe.stdout).toContain(`codex-cli ${VERSION}`);
    },
    15 * 60_000,
  );

  it.runIf(!LIVE)("SKIP: live smoke not run — set ANYCODE_CODEX_LIVE_SMOKE=1 with network access to execute it", (context) => {
    context.skip();
  });
});

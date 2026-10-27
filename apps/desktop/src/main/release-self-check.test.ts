import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The fake executable records the exact arguments and mimics the app's output.
describe.skipIf(process.platform === "win32")("release self-check launcher", () => {
  it("passes the Linux capture opt-in and surfaces missing screenshot warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-test-"));
    const binary = join(root, "fake-app");
    try {
      writeFileSync(binary, `#!/usr/bin/env node
console.error('[self-check] welcome.png unavailable: UnknownVizError');
console.log('ANYCODE_SELF_CHECK ' + JSON.stringify({ ok: true, packaged: true, args: process.argv.slice(2) }));
`);
      chmodSync(binary, 0o755);
      const script = fileURLToPath(new URL("../../scripts/release-self-check.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [script, binary, "--self-check-allow-unavailable-capture"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).args).toEqual(["--self-check", "--self-check-allow-unavailable-capture"]);
      expect(result.stderr).toContain("welcome.png unavailable: UnknownVizError");
      const bad = spawnSync(process.execPath, [script, binary, "--no-sandbox"], { encoding: "utf8" });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("Only --self-check-allow-unavailable-capture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**

 * (resolved via createRequire, spawned `node <cli.mjs> --stdio`) driven through
 * the production LspManager path on a temp TS project. Proves the hand-written
 * client speaks a protocol a real server accepts and that a genuine type error
 * (`const x: string = 1`) surfaces as an error diagnostic at the right line.
 *
 * Severity + line are asserted; the message text is NOT pinned (version-fragile).
 * If tsls cannot be resolved (devDependency absent), the whole suite is skipped
 * with an honest name — but in an env where the devDep IS installed this suite
 * MUST actually execute (a green fixture-only run is not proof — lesson 2.6.4).
 */

import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { LspManager } from "./manager.js";
import type { LspServerSpec } from "../ports/lsp.js";

const requireFromHere = createRequire(import.meta.url);
let tslsCliPath: string | null = null;
try {
  tslsCliPath = requireFromHere.resolve("typescript-language-server/lib/cli.mjs");
} catch {
  tslsCliPath = null;
}

const suite = tslsCliPath
  ? describe
  : describe.skip;

suite("tsls-smoke (real typescript-language-server, requires the devDependency)", () => {
  let projectDir: string | undefined;
  let manager: LspManager | undefined;

  afterAll(async () => {
    if (manager) await manager.disposeAll();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it(
    "surfaces a real TS type error as an error diagnostic at the offending line",
    async () => {
      // realpath so a /tmp -> /private/tmp symlink cannot desync our URI from
      // the one tsls publishes under.
      projectDir = realpathSync(mkdtempSync(join(tmpdir(), "anycode-tsls-")));
      writeFileSync(
        join(projectDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["*.ts"] }),
      );
      const filePath = join(projectDir, "sample.ts");
      const content = "const x: string = 1;\n";
      writeFileSync(filePath, content);

      const spec: LspServerSpec = {
        name: "typescript",
        command: process.execPath,
        args: [tslsCliPath!, "--stdio"],
        extensions: [".ts"],
      };
      manager = new LspManager(new NodeExecutionAdapter(), [spec], projectDir);

      // tsls cold-start (tsserver spin-up) can exceed one edit budget and can emit
      // an initial empty publish before analysis; poll until real diagnostics land.
      let diagnostics: { severity: string; line: number }[] = [];
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const outcome = await manager.diagnosticsAfterWrite(filePath, content);
        if (outcome.available && outcome.diagnostics.length > 0) {
          diagnostics = outcome.diagnostics;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(diagnostics.length).toBeGreaterThan(0);
      const error = diagnostics.find((d) => d.severity === "error");
      expect(error).toBeDefined();
      // `const x: string = 1;` — the type error is reported on line 1.
      expect(error!.line).toBe(1);
    },
    60_000,
  );
});

/** Isolated fixture acceptance. GUI setup is covered separately by first-run-ui-smoke. */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = mkdtempSync(join(tmpdir(), "anycode-go-fixture-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("ANYCODE_") || key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR") delete env[key];
Object.assign(env, {
  ANYCODE_USER_DATA_DIR: join(profile, "user-data"),
  ANYCODE_SETTINGS_PATH: join(profile, "settings.json"),
  ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
  ANYCODE_DB_PATH: join(profile, "db.sqlite"),
  CODEX_HOME: join(profile, "codex-home"),
  CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
});
const files = [
  "packages/core/src/provider/opencode-go-acceptance.test.ts",
  "packages/core/src/provider/opencode-go-wire.test.ts",
  "packages/core/src/provider/opencode-go.test.ts",
  "packages/core/src/provider/model-route.test.ts",
  "packages/core/src/cli/connection-targets.test.ts",
  "packages/core/src/subagents/runner.test.ts",
  "packages/core/src/context/session-title.test.ts",
  "packages/core/src/provider/reasoning-history.test.ts",
  "apps/desktop/src/host/list-connections.test.ts",
  "apps/desktop/src/host/model-classifier-boot.test.ts",
  "apps/desktop/src/host/connection-model-settings.test.ts",
  "apps/desktop/src/shared/child-model.test.ts",
  "apps/desktop/src/main/recognizer-probe.test.ts",
  "apps/desktop/src/host/usage-recording.test.ts",
  "scripts/opencode-go-live-safety.test.ts",
];
const result = spawnSync("pnpm", ["exec", "vitest", "run", ...files], { cwd: root, env, stdio: "inherit" });
if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
else console.log("PASS: isolated Go fixture routing, refusals, child inventory, recognizer and usage accounting");

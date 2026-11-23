import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { assertProductionPaths } from "../apps/desktop/scripts/smoke-package-guard.mjs";

it("devOnlySmokeUsesSharedLauncher", () => {
  const path = "apps/desktop/scripts/repl-smoke.mjs";
  const source = readFileSync(path, "utf8");
  expect(source).toContain('import { launchSmokeElectron } from "./smoke-electron-launch.mjs";');
  expect(source).toContain("launchSmokeElectron(spawn, { env })");
  expect(source).toContain("connectIsolatedCdp({ profile, env, launcher: app");
  expect(source).toContain("buildSmokeEnv(process.env, profile, 0, binary)");
  expect(() => assertProductionPaths(["/scripts/repl-smoke.mjs"])).toThrow("Development smoke shipped in package");
  const builder = readFileSync("apps/desktop/electron-builder.yml", "utf8");
  const include = builder.match(/^files:\n((?:^ {2}[^\n]+\n)+)/m)?.[1];
  expect(include?.split("\n").filter((line) => line.startsWith("  - ") && !line.startsWith('  - "!'))).toEqual(["  - out/**"]);
});

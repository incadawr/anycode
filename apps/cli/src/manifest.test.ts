/**
 * Static manifest guard for the `@anycode/cli` package (design
 * slice-4.8-cut.md §2.5/§6-T). Runs without a build: reads both package.json
 * manifests via `node:fs` (never imports them as modules — NodeNext ESM
 * import-attributes for JSON are a heavier, unnecessary dependency for a
 * plain read) and asserts the deps-mirror + version-parity + bin-contract
 * invariants that keep `apps/cli` from drifting silently out of sync with
 * `packages/core` (L6/L7).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const coreRoot = join(here, "..", "..", "..", "packages", "core");

const cliManifest = JSON.parse(
  readFileSync(join(cliRoot, "package.json"), "utf8"),
) as PackageManifest;
const coreManifest = JSON.parse(
  readFileSync(join(coreRoot, "package.json"), "utf8"),
) as PackageManifest;

describe("apps/cli package manifest guard", () => {
  it("mirrors core's runtime dependencies verbatim", () => {
    expect(cliManifest.dependencies).toEqual(coreManifest.dependencies);
  });

  it("keeps version parity with core (--version arithmetic, R3)", () => {
    expect(cliManifest.version).toBe(coreManifest.version);
  });

  it("declares a bin entry that resolves to an existing executable shim", () => {
    const binPath = cliManifest.bin?.anycode;
    expect(binPath).toBeTruthy();
    const resolved = join(cliRoot, binPath as string);
    expect(existsSync(resolved)).toBe(true);

    const firstLine = readFileSync(resolved, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("has the expected package shape", () => {
    expect(cliManifest.type).toBe("module");
    expect(cliManifest.engines?.node).toBe(">=22");
    expect(cliManifest.private).toBe(true);
  });
});

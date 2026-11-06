import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows installer configuration", () => {
  it("uses a space-free artifact name for the update feed and release asset", () => {
    const config = readFileSync("apps/desktop/electron-builder.yml", "utf8");
    const nsis = config.match(/^nsis:\s*\n((?:[ \t]+[^\n]*\n)+)/m)?.[1];
    expect(nsis).toBeDefined();
    const name = nsis?.match(/^\s+artifactName:\s*(\S+)\s*$/m)?.[1];
    expect(name).toBe("${productName}-Setup-${version}.${ext}");
  });
});

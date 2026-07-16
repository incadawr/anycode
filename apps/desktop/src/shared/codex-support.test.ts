import { describe, expect, it } from "vitest";
import { CODEX_TRIPLE_BY_PLATFORM, codexBinaryRelPath, codexPlatformSuffix } from "./codex-support.js";

describe("codexPlatformSuffix", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["win32", "x64", "win32-x64"],
    ["win32", "arm64", "win32-arm64"],
  ] as const)("resolves %s/%s -> %s", (platform, arch, expected) => {
    expect(codexPlatformSuffix(platform, arch)).toBe(expected);
  });

  it("fails closed (returns null) for an unsupported platform/arch combination", () => {
    expect(codexPlatformSuffix("freebsd", "x64")).toBeNull();
    expect(codexPlatformSuffix("darwin", "ia32")).toBeNull();
    expect(codexPlatformSuffix("", "")).toBeNull();
  });
});

describe("CODEX_TRIPLE_BY_PLATFORM", () => {
  it("has exactly the 6 verified platform-suffix entries", () => {
    expect(Object.keys(CODEX_TRIPLE_BY_PLATFORM).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].sort(),
    );
  });

  it("matches the live bin/codex.js PLATFORM_PACKAGE_BY_TARGET triples verbatim (W0-R2)", () => {
    expect(CODEX_TRIPLE_BY_PLATFORM["darwin-arm64"]).toBe("aarch64-apple-darwin");
    expect(CODEX_TRIPLE_BY_PLATFORM["darwin-x64"]).toBe("x86_64-apple-darwin");
    expect(CODEX_TRIPLE_BY_PLATFORM["linux-x64"]).toBe("x86_64-unknown-linux-musl");
    expect(CODEX_TRIPLE_BY_PLATFORM["linux-arm64"]).toBe("aarch64-unknown-linux-musl");
    expect(CODEX_TRIPLE_BY_PLATFORM["win32-x64"]).toBe("x86_64-pc-windows-msvc");
    expect(CODEX_TRIPLE_BY_PLATFORM["win32-arm64"]).toBe("aarch64-pc-windows-msvc");
  });
});

describe("codexBinaryRelPath", () => {
  it("resolves the non-Windows triples to vendor/<triple>/bin/codex (no extension)", () => {
    expect(codexBinaryRelPath("aarch64-apple-darwin")).toBe("vendor/aarch64-apple-darwin/bin/codex");
    expect(codexBinaryRelPath("x86_64-apple-darwin")).toBe("vendor/x86_64-apple-darwin/bin/codex");
    expect(codexBinaryRelPath("x86_64-unknown-linux-musl")).toBe("vendor/x86_64-unknown-linux-musl/bin/codex");
    expect(codexBinaryRelPath("aarch64-unknown-linux-musl")).toBe("vendor/aarch64-unknown-linux-musl/bin/codex");
  });

  it("appends .exe on win32 triples only", () => {
    expect(codexBinaryRelPath("x86_64-pc-windows-msvc")).toBe("vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    expect(codexBinaryRelPath("aarch64-pc-windows-msvc")).toBe("vendor/aarch64-pc-windows-msvc/bin/codex.exe");
  });

  it("is NOT the originally-guessed bin/codex-<triple> shape (amended §A4.2 supersedes un-amended cut §7.2)", () => {
    const path = codexBinaryRelPath("aarch64-apple-darwin");
    expect(path).not.toMatch(/^bin\/codex-/);
    expect(path.startsWith("vendor/")).toBe(true);
  });

  it("every entry of CODEX_TRIPLE_BY_PLATFORM resolves through codexBinaryRelPath without throwing", () => {
    for (const [suffix, triple] of Object.entries(CODEX_TRIPLE_BY_PLATFORM)) {
      const relPath = codexBinaryRelPath(triple);
      expect(relPath).toContain(triple);
      if (suffix.startsWith("win32")) {
        expect(relPath.endsWith(".exe")).toBe(true);
      } else {
        expect(relPath.endsWith(".exe")).toBe(false);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  candidatesFromPath,
  codexBinaryFileName,
  commonInstallLocations,
  discoverCodexBinary,
  resolveCodexBinary,
  type CodexBinaryFs,
} from "./codex-binary.js";

describe("resolveCodexBinary", () => {
  it("requires an absolute executable POSIX file", () => {
    const fs = { stat: () => ({ isFile: () => true, mode: 0o755 }) };
    expect(resolveCodexBinary("/opt/codex", fs, "darwin")).toEqual({ path: "/opt/codex" });
    expect(resolveCodexBinary("codex", fs, "darwin")).toMatchObject({ path: null, reason: expect.stringContaining("absolute") });
    expect(resolveCodexBinary("/opt/codex", { stat: () => ({ isFile: () => true, mode: 0o644 }) }, "darwin"))
      .toMatchObject({ path: null, reason: expect.stringContaining("executable") });
  });

  it("does not infer POSIX executable bits on Windows", () => {
    const fs = { stat: () => ({ isFile: () => true, mode: 0o644 }) };
    expect(resolveCodexBinary("C:\\Codex\\codex.exe", fs, "win32")).toEqual({ path: "C:\\Codex\\codex.exe" });
  });
});

describe("codexBinaryFileName", () => {
  it("is codex on POSIX, codex.exe on Windows", () => {
    expect(codexBinaryFileName("darwin")).toBe("codex");
    expect(codexBinaryFileName("linux")).toBe("codex");
    expect(codexBinaryFileName("win32")).toBe("codex.exe");
  });
});

describe("candidatesFromPath", () => {
  it("joins each PATH segment with the platform binary name — no shell, no which/where", () => {
    expect(candidatesFromPath("/usr/local/bin:/opt/homebrew/bin", "darwin")).toEqual([
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
    ]);
  });

  it("uses ; and codex.exe on Windows regardless of host platform", () => {
    expect(candidatesFromPath("C:\\tools;C:\\npm", "win32")).toEqual([
      "C:\\tools\\codex.exe",
      "C:\\npm\\codex.exe",
    ]);
  });

  it("drops empty segments and an empty/undefined PATH", () => {
    expect(candidatesFromPath("/a::/b", "darwin")).toEqual(["/a/codex", "/b/codex"]);
    expect(candidatesFromPath("", "darwin")).toEqual([]);
    expect(candidatesFromPath(undefined, "darwin")).toEqual([]);
  });
});

describe("commonInstallLocations", () => {
  it("lists the documented POSIX locations in order, home-based ones only when HOME is set", () => {
    expect(commonInstallLocations({ HOME: "/home/dev" }, "darwin")).toEqual([
      "/home/dev/.npm-global/bin/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/home/dev/.local/bin/codex",
    ]);
    expect(commonInstallLocations({}, "darwin")).toEqual(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  });

  it("uses %APPDATA%\\npm on Windows, empty when APPDATA is unset", () => {
    expect(commonInstallLocations({ APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }, "win32")).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.exe",
    ]);
    expect(commonInstallLocations({}, "win32")).toEqual([]);
  });
});

describe("discoverCodexBinary", () => {
  function fsWith(executablePaths: readonly string[]): CodexBinaryFs {
    return {
      stat(path: string) {
        if (!executablePaths.includes(path)) {
          throw new Error("ENOENT");
        }
        return { isFile: () => true, mode: 0o755 };
      },
    };
  }

  it("prefers the env override when it resolves", () => {
    const fs = fsWith(["/env/codex", "/usr/local/bin/codex"]);
    const result = discoverCodexBinary({
      envOverride: "/env/codex",
      settingsPath: "/settings/codex",
      env: { PATH: "/usr/local/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
    });
    expect(result).toEqual({ path: "/env/codex", source: "env" });
  });

  it("falls through to settings when the env override does not resolve (a stale dev override must not brick discovery)", () => {
    const fs = fsWith(["/settings/codex"]);
    const result = discoverCodexBinary({
      envOverride: "/env/codex-gone",
      settingsPath: "/settings/codex",
      env: { PATH: "" },
      fs,
      platform: "darwin",
    });
    expect(result).toEqual({ path: "/settings/codex", source: "settings" });
  });

  it("finds a compatible CLI from PATH with no env override and no settings path", () => {
    const fs = fsWith(["/usr/local/bin/codex"]);
    const result = discoverCodexBinary({
      env: { PATH: "/usr/local/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
    });
    expect(result).toEqual({ path: "/usr/local/bin/codex", source: "path" });
  });

  it("falls through PATH to the common install locations", () => {
    const fs = fsWith(["/opt/homebrew/bin/codex"]);
    const result = discoverCodexBinary({
      env: { PATH: "/usr/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
    });
    expect(result).toEqual({ path: "/opt/homebrew/bin/codex", source: "common" });
  });

  it("returns source none with a diagnostic reason when nothing on the ladder resolves", () => {
    const fs: CodexBinaryFs = {
      stat() {
        throw new Error("ENOENT");
      },
    };
    const result = discoverCodexBinary({ env: { PATH: "/usr/bin", HOME: "/home/dev" }, fs, platform: "darwin" });
    expect(result.path).toBeNull();
    expect(result.source).toBe("none");
    expect(result.reason).toBeDefined();
  });
});

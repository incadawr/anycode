import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidatesFromPath,
  checkClaudeBinaryPathTrust,
  claudeBinaryFileName,
  commonInstallLocations,
  defaultClaudeProfileDir,
  discoverClaudeBinary,
  resolveClaudeBinary,
  type ClaudeBinaryFs,
  type ClaudeIdentity,
} from "./claude-binary.js";

/** The identity every fake below is judged against: uid 501, in groups 20 (staff) and 80 (admin). */
const ME: ClaudeIdentity = { uid: 501, gids: [20, 80] };

interface FakeEntry {
  mode?: number;
  uid?: number;
  gid?: number;
}

/** Every directory from `dirname(path)` up to (and including) the filesystem root — mirrors `ancestorDirectories` in claude-binary.ts. */
function ancestorChain(path: string): string[] {
  const chain: string[] = [];
  let current = path;
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/** Mirrors main/codex-binary.test.ts's `fakeFs` helper (no `readdir` — claude-binary.ts has no "installed" rung). */
function fakeFs(files: Readonly<Record<string, FakeEntry>>, dirs: Readonly<Record<string, FakeEntry>> = {}): ClaudeBinaryFs {
  const dirEntries: Record<string, FakeEntry> = { ...dirs };
  for (const file of Object.keys(files)) {
    for (const dir of ancestorChain(dirname(file))) {
      dirEntries[dir] ??= {};
    }
  }
  return {
    realpath: (path) => path,
    stat(path) {
      const file = files[path];
      if (file !== undefined) {
        return { isFile: () => true, isDirectory: () => false, mode: file.mode ?? 0o755, uid: file.uid ?? ME.uid, gid: file.gid ?? 20 };
      }
      const dir = dirEntries[path];
      if (dir !== undefined) {
        return { isFile: () => false, isDirectory: () => true, mode: dir.mode ?? 0o755, uid: dir.uid ?? ME.uid, gid: dir.gid ?? 20 };
      }
      throw new Error("ENOENT");
    },
  };
}

function fsWith(executablePaths: readonly string[]): ClaudeBinaryFs {
  return fakeFs(Object.fromEntries(executablePaths.map((path) => [path, {}])));
}

describe("resolveClaudeBinary", () => {
  it("requires an absolute executable POSIX file", () => {
    expect(resolveClaudeBinary("/opt/claude", fsWith(["/opt/claude"]), "darwin", ME)).toEqual({ path: "/opt/claude" });
    expect(resolveClaudeBinary("claude", fsWith(["/opt/claude"]), "darwin", ME)).toMatchObject({ path: null, reason: expect.stringContaining("absolute") });
    expect(resolveClaudeBinary("/opt/claude", fakeFs({ "/opt/claude": { mode: 0o644 } }), "darwin", ME))
      .toMatchObject({ path: null, reason: expect.stringContaining("executable") });
  });

  it("refuses a nonexistent path", () => {
    expect(resolveClaudeBinary("/nope/claude", fakeFs({}), "darwin", ME)).toMatchObject({ path: null, reason: expect.stringContaining("not exist") });
  });

  it("refuses a world-writable binary (trust gate)", () => {
    expect(resolveClaudeBinary("/opt/claude", fakeFs({ "/opt/claude": { mode: 0o777 } }), "darwin", ME))
      .toMatchObject({ path: null, reason: expect.stringContaining("world-writable") });
  });

  it("passes an empty/undefined path through as null with no reason", () => {
    expect(resolveClaudeBinary(undefined, fakeFs({}), "darwin", ME)).toEqual({ path: null });
    expect(resolveClaudeBinary("   ", fakeFs({}), "darwin", ME)).toEqual({ path: null });
  });
});

describe("checkClaudeBinaryPathTrust", () => {
  it("trusts a normally-owned file in a normal directory", () => {
    expect(checkClaudeBinaryPathTrust("/opt/claude", fsWith(["/opt/claude"]), "darwin", ME)).toBeNull();
  });

  it("is unconditionally trusted on win32 (documented unchecked path)", () => {
    expect(checkClaudeBinaryPathTrust("C:\\claude.exe", fakeFs({}), "win32", ME)).toBeNull();
  });
});

describe("claudeBinaryFileName", () => {
  it("is claude on POSIX, claude.exe on win32", () => {
    expect(claudeBinaryFileName("darwin")).toBe("claude");
    expect(claudeBinaryFileName("linux")).toBe("claude");
    expect(claudeBinaryFileName("win32")).toBe("claude.exe");
  });
});

describe("candidatesFromPath", () => {
  it("splits PATH into per-segment candidate binaries", () => {
    expect(candidatesFromPath("/usr/bin:/opt/homebrew/bin", "darwin")).toEqual(["/usr/bin/claude", "/opt/homebrew/bin/claude"]);
  });

  it("returns [] for an absent/blank PATH", () => {
    expect(candidatesFromPath(undefined, "darwin")).toEqual([]);
    expect(candidatesFromPath("  ", "darwin")).toEqual([]);
  });

  it("uses ; separator and claude.exe on win32", () => {
    expect(candidatesFromPath("C:\\a;C:\\b", "win32")).toEqual(["C:\\a\\claude.exe", "C:\\b\\claude.exe"]);
  });
});

describe("commonInstallLocations", () => {
  it("orders ~/.local/bin (native installer) first, then homebrew, usr/local, npm-global", () => {
    expect(commonInstallLocations({ HOME: "/home/me" }, "linux")).toEqual([
      "/home/me/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/home/me/.npm-global/bin/claude",
    ]);
  });

  it("drops HOME-relative entries when HOME is unset", () => {
    expect(commonInstallLocations({}, "linux")).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  });

  it("uses %APPDATA%\\npm on win32, nothing when APPDATA is unset", () => {
    expect(commonInstallLocations({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toEqual([
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe",
    ]);
    expect(commonInstallLocations({}, "win32")).toEqual([]);
  });
});

describe("discoverClaudeBinary", () => {
  it("prioritizes env override over every other rung", () => {
    const fs = fsWith(["/env/claude", "/settings/claude"]);
    const result = discoverClaudeBinary({
      envOverride: "/env/claude",
      settingsPath: "/settings/claude",
      env: {},
      fs,
      platform: "darwin",
      identity: ME,
    });
    expect(result).toEqual({ path: "/env/claude", source: "env" });
  });

  it("falls through env -> settings -> PATH -> common in order", () => {
    const fs = fsWith(["/usr/local/bin/claude"]);
    const result = discoverClaudeBinary({
      envOverride: "/does/not/exist/claude",
      env: { PATH: "" },
      fs,
      platform: "darwin",
      identity: ME,
    });
    // env rung's candidate resolves to null (nonexistent) -> falls through to
    // the common rung, which does find /usr/local/bin/claude.
    expect(result).toEqual({ path: "/usr/local/bin/claude", source: "common" });
  });

  it("resolves to none with the last rejection reason when nothing on the ladder resolves", () => {
    const result = discoverClaudeBinary({ env: {}, fs: fakeFs({}), platform: "darwin", identity: ME });
    expect(result.path).toBeNull();
    expect(result.source).toBe("none");
  });

  it("finds a settings-configured path when PATH/common come up empty", () => {
    const fs = fsWith(["/opt/custom/claude"]);
    const result = discoverClaudeBinary({
      settingsPath: "/opt/custom/claude",
      env: { PATH: "" },
      fs,
      platform: "darwin",
      identity: ME,
    });
    expect(result).toEqual({ path: "/opt/custom/claude", source: "settings" });
  });
});

describe("defaultClaudeProfileDir", () => {
  it("resolves to ~/.anycode/claude/profile-default on POSIX", () => {
    expect(defaultClaudeProfileDir("/home/me", "linux")).toBe("/home/me/.anycode/claude/profile-default");
  });

  it("uses backslashes on win32", () => {
    expect(defaultClaudeProfileDir("C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\.anycode\\claude\\profile-default");
  });
});

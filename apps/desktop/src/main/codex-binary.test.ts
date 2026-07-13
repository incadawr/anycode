import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidatesFromPath,
  checkCodexBinaryPathTrust,
  codexBinaryFileName,
  commonInstallLocations,
  discoverCodexBinary,
  resolveCodexBinary,
  type CodexBinaryFs,
  type CodexIdentity,
} from "./codex-binary.js";

/** The identity every fake below is judged against: uid 501, in groups 20 (staff) and 80 (admin). */
const ME: CodexIdentity = { uid: 501, gids: [20, 80] };

interface FakeEntry {
  mode?: number;
  uid?: number;
  gid?: number;
}

/** Every directory from `dirname(path)` up to (and including) the filesystem root — mirrors `ancestorDirectories` in codex-binary.ts. */
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

/**
 * A fake fs that models a REAL one: a binary has a containing DIRECTORY, and
 * both carry ownership + permission bits. The trust gate reads all of it, so a
 * fake that answered only `isFile`/`mode` for the file alone would be modelling
 * a filesystem that cannot exist. The reader now walks the FULL ancestor
 * chain up to `/` (W5.5 HIGH fix), so every ancestor of every declared file —
 * not just its immediate parent — gets a safe default here unless a test
 * overrides it explicitly: a real filesystem cannot have `/opt/foo/bin`
 * without `/opt/foo`, `/opt`, and `/` all existing too.
 */
function fakeFs(
  files: Readonly<Record<string, FakeEntry>>,
  dirs: Readonly<Record<string, FakeEntry>> = {},
): CodexBinaryFs {
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

/** The paths every ladder rung may return, all safely owned by us. */
function fsWith(executablePaths: readonly string[]): CodexBinaryFs {
  return fakeFs(Object.fromEntries(executablePaths.map((path) => [path, {}])));
}

describe("resolveCodexBinary", () => {
  it("requires an absolute executable POSIX file", () => {
    expect(resolveCodexBinary("/opt/codex", fsWith(["/opt/codex"]), "darwin", ME)).toEqual({ path: "/opt/codex" });
    expect(resolveCodexBinary("codex", fsWith(["/opt/codex"]), "darwin", ME)).toMatchObject({ path: null, reason: expect.stringContaining("absolute") });
    expect(resolveCodexBinary("/opt/codex", fakeFs({ "/opt/codex": { mode: 0o644 } }), "darwin", ME))
      .toMatchObject({ path: null, reason: expect.stringContaining("executable") });
  });

  it("does not infer POSIX executable bits on Windows", () => {
    const fs = fakeFs({ "C:\\Codex\\codex.exe": { mode: 0o644 } });
    expect(resolveCodexBinary("C:\\Codex\\codex.exe", fs, "win32", ME)).toEqual({ path: "C:\\Codex\\codex.exe" });
  });
});

// W2-review Medium. The realistic attack is not "root is careless", it is a
// binary (or a directory holding one) that a THIRD PARTY can write: they swap
// it between the check and the spawn, and we execute their file.
describe("checkCodexBinaryPathTrust", () => {
  it("accepts a normal user-owned install", () => {
    expect(checkCodexBinaryPathTrust("/home/dev/.local/bin/codex", fsWith(["/home/dev/.local/bin/codex"]), "darwin", ME)).toBeNull();
  });

  it("accepts a root-owned install in a root-owned directory (/usr/local/bin)", () => {
    const fs = fakeFs({ "/usr/local/bin/codex": { uid: 0, gid: 0 } }, { "/usr/local/bin": { uid: 0, gid: 0 } });
    expect(checkCodexBinaryPathTrust("/usr/local/bin/codex", fs, "darwin", ME)).toBeNull();
  });

  it("accepts the stock Homebrew prefix, which is group-writable BY DESIGN", () => {
    // /opt/homebrew/bin is `drwxrwxr-x <user>:admin` on every Apple-Silicon Mac.
    // Refusing group-writability outright would reject the single most common
    // real install while buying nothing: gid 80 (admin) is trusted by VALUE
    // (its members already have sudo), not because this identity happens to
    // belong to it — see shared/codex-binary-trust.test.ts for the fixture
    // that proves membership is irrelevant here.
    const fs = fakeFs({ "/opt/homebrew/bin/codex": { gid: 80 } }, { "/opt/homebrew/bin": { mode: 0o775, gid: 80 } });
    expect(checkCodexBinaryPathTrust("/opt/homebrew/bin/codex", fs, "darwin", ME)).toBeNull();
  });

  it("refuses a world-writable binary", () => {
    const fs = fakeFs({ "/opt/codex": { mode: 0o777 } });
    expect(checkCodexBinaryPathTrust("/opt/codex", fs, "darwin", ME)).toMatch(/world-writable/);
  });

  it("refuses a binary in a world-writable directory (the /tmp shape)", () => {
    const fs = fakeFs({ "/tmp/codex": {} }, { "/tmp": { mode: 0o1777 } });
    expect(checkCodexBinaryPathTrust("/tmp/codex", fs, "darwin", ME)).toMatch(/world-writable/);
  });

  it("refuses a binary owned by another user, and one whose directory is", () => {
    expect(checkCodexBinaryPathTrust("/opt/codex", fakeFs({ "/opt/codex": { uid: 777 } }), "darwin", ME)).toMatch(/another user/);
    const fs = fakeFs({ "/opt/codex": {} }, { "/opt": { uid: 777 } });
    expect(checkCodexBinaryPathTrust("/opt/codex", fs, "darwin", ME)).toMatch(/another user/);
  });

  it("refuses a path writable by a group that is not a darwin root-equivalent one (gid 999) — even though this identity IS a supplementary member of gid 80", () => {
    const fs = fakeFs({ "/opt/codex": { uid: 0, mode: 0o775, gid: 999 } }, { "/opt": { uid: 0 } });
    expect(checkCodexBinaryPathTrust("/opt/codex", fs, "darwin", ME)).toMatch(/writable by group 999/);
  });

  // W5.5 HIGH fix. Pre-fix, group-writability was judged against SUPPLEMENTARY
  // GROUP MEMBERSHIP: `!input.gids.includes(entry.gid)`. `ME` above is a member
  // of BOTH gid 20 (staff — literally everyone's default group on a Mac) and
  // gid 4000 below, so the pre-fix rule accepted both of the next two cases.
  // Each assertion here FAILS against that pre-fix rule.
  it("refuses victim:developers 0775 — self-owned, group-writable, self IS a member, but the group is ordinary", () => {
    const fs = fakeFs({ "/opt/codex": {} }, { "/opt": { mode: 0o775, gid: 4000 } });
    const memberOfDevelopers: CodexIdentity = { uid: ME.uid, gids: [...ME.gids, 4000] };
    expect(checkCodexBinaryPathTrust("/opt/codex", fs, "darwin", memberOfDevelopers)).toMatch(/writable by group 4000/);
  });

  it("refuses darwin :staff 0775 (gid 20) — staff is the default primary group of every local Mac account, so membership of it proves nothing", () => {
    const fs = fakeFs({ "/opt/codex": {} }, { "/opt": { mode: 0o775, gid: 20 } });
    expect(checkCodexBinaryPathTrust("/opt/codex", fs, "darwin", ME)).toMatch(/writable by group 20/);
  });

  // W5.5 HIGH fix: the reader used to stat only `dirname(resolved)`. A
  // writable GRANDPARENT can rename/replace an otherwise-safe immediate
  // directory, so the full ancestor chain up to `/` must be walked. This
  // fails on the pre-fix reader, which never looked past `/opt/tools/bin`.
  it("refuses when a GRANDPARENT directory is unsafe even though the immediate directory is safe", () => {
    const fs = fakeFs(
      { "/opt/tools/bin/codex": {} },
      { "/opt/tools/bin": {}, "/opt/tools": { mode: 0o777 } },
    );
    expect(checkCodexBinaryPathTrust("/opt/tools/bin/codex", fs, "darwin", ME)).toMatch(/world-writable/);
  });

  it("follows a symlink and judges the TARGET's full ancestor chain plus the LINK's own full ancestor chain (swapping the link is as good as swapping the target)", () => {
    const fs: CodexBinaryFs = {
      realpath: () => "/lib/node_modules/codex/bin/codex.js",
      stat(path) {
        if (path === "/lib/node_modules/codex/bin/codex.js") {
          return { isFile: () => true, isDirectory: () => false, mode: 0o755, uid: ME.uid, gid: 20 };
        }
        if (path === "/home/dev/bin") {
          // The SYMLINK's own directory — world-writable, so anyone can retarget it.
          return { isFile: () => false, isDirectory: () => true, mode: 0o777, uid: ME.uid, gid: 20 };
        }
        // Every other ancestor on either chain (/lib/node_modules/codex/bin,
        // /lib/node_modules/codex, /lib/node_modules, /lib, /home/dev, /home,
        // /) is an ordinary safe, self-owned directory.
        return { isFile: () => false, isDirectory: () => true, mode: 0o755, uid: ME.uid, gid: 20 };
      },
    };
    expect(checkCodexBinaryPathTrust("/home/dev/bin/codex", fs, "darwin", ME)).toMatch(/world-writable/);
  });

  it("has no POSIX modes to judge on Windows — the residual is documented, not silently passed off as a check", () => {
    const fs = fakeFs({ "C:\\codex.exe": { mode: 0o777 } });
    expect(checkCodexBinaryPathTrust("C:\\codex.exe", fs, "win32", ME)).toBeNull();
  });

  // Fixture matrix requirement (W5.5): drive the REAL stat of the machine's
  // own Homebrew prefix and its full ancestor chain through the policy, with
  // an identity built from the CAPTURED file owner — not `process.getuid()`
  // — so the assertion cannot pass merely because the suite happens to run
  // as the same uid that owns /opt/homebrew.
  it.runIf(existsSync("/opt/homebrew/bin"))("accepts the REAL stat of /opt/homebrew/bin and its real ancestor chain on this machine", () => {
    const homebrewBin = "/opt/homebrew/bin";
    const capturedOwner = statSync(homebrewBin).uid;
    const capturedGid = statSync(homebrewBin).gid;
    // egid is irrelevant on darwin (only the linux user-private-group case
    // reads it) — sentinel value, deliberately not derived from the capture.
    const identity: CodexIdentity = { uid: capturedOwner, gids: [], egid: -1 };
    const codexPath = `${homebrewBin}/codex`;
    const realWithSyntheticBinary: CodexBinaryFs = {
      realpath: (path) => (path === codexPath ? codexPath : realpathSync(path)),
      stat: (path) =>
        path === codexPath
          ? { isFile: () => true, isDirectory: () => false, mode: 0o755, uid: capturedOwner, gid: capturedGid }
          : statSync(path),
    };
    expect(checkCodexBinaryPathTrust(codexPath, realWithSyntheticBinary, "darwin", identity)).toBeNull();
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
  it("prefers the env override when it resolves", () => {
    const fs = fsWith(["/env/codex", "/usr/local/bin/codex"]);
    const result = discoverCodexBinary({
      envOverride: "/env/codex",
      settingsPath: "/settings/codex",
      env: { PATH: "/usr/local/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
      identity: ME,
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
      identity: ME,
    });
    expect(result).toEqual({ path: "/settings/codex", source: "settings" });
  });

  it("finds a compatible CLI from PATH with no env override and no settings path", () => {
    const fs = fsWith(["/usr/local/bin/codex"]);
    const result = discoverCodexBinary({
      env: { PATH: "/usr/local/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
      identity: ME,
    });
    expect(result).toEqual({ path: "/usr/local/bin/codex", source: "path" });
  });

  it("falls through PATH to the common install locations", () => {
    const fs = fsWith(["/opt/homebrew/bin/codex"]);
    const result = discoverCodexBinary({
      env: { PATH: "/usr/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
      identity: ME,
    });
    expect(result).toEqual({ path: "/opt/homebrew/bin/codex", source: "common" });
  });

  it("skips an untrusted rung and keeps walking (a world-writable PATH entry must not win over a safe install)", () => {
    const fs = fakeFs(
      { "/usr/local/bin/codex": {}, "/home/dev/.local/bin/codex": {} },
      { "/usr/local/bin": { mode: 0o777 } }, // world-writable: anyone can swap the binary in it
    );
    const result = discoverCodexBinary({
      env: { PATH: "/usr/local/bin", HOME: "/home/dev" },
      fs,
      platform: "darwin",
      identity: ME,
    });
    expect(result).toEqual({ path: "/home/dev/.local/bin/codex", source: "common" });
  });

  it("returns source none with a diagnostic reason when nothing on the ladder resolves", () => {
    const fs: CodexBinaryFs = {
      realpath: (path) => path,
      stat() {
        throw new Error("ENOENT");
      },
    };
    const result = discoverCodexBinary({ env: { PATH: "/usr/bin", HOME: "/home/dev" }, fs, platform: "darwin", identity: ME });
    expect(result.path).toBeNull();
    expect(result.source).toBe("none");
    expect(result.reason).toBeDefined();
  });
});

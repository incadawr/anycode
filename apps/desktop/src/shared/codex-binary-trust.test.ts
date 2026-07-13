import { describe, expect, it } from "vitest";
import { checkCodexBinaryTrust, type CodexBinaryTrustInput, type CodexPathStat } from "./codex-binary-trust.js";

/**
 * The identity every fixture below is judged against, UNLESS a test
 * overrides it explicitly. Deliberately NOT one of the darwin root-
 * equivalent gids (0, 80): an ACCEPT in a fixture that does not override
 * `egid` therefore always comes from the rule under test, never by accident.
 */
const SELF_UID = 501;
const SELF_EGID = 20;

function dirStat(path: string, overrides: Partial<CodexPathStat> = {}): CodexPathStat {
  return { path, isFile: false, isDirectory: true, mode: 0o755, uid: SELF_UID, gid: SELF_EGID, ...overrides };
}

function fileStat(path: string, overrides: Partial<CodexPathStat> = {}): CodexPathStat {
  return { path, isFile: true, isDirectory: false, mode: 0o755, uid: SELF_UID, gid: SELF_EGID, ...overrides };
}

function input(
  file: CodexPathStat,
  directories: readonly CodexPathStat[],
  overrides: Partial<CodexBinaryTrustInput> = {},
): CodexBinaryTrustInput {
  return { file, directories, uid: SELF_UID, egid: SELF_EGID, platform: "darwin", ...overrides };
}

describe("checkCodexBinaryTrust — baseline", () => {
  it("accepts a self-owned file in a self-owned, non-group-writable directory", () => {
    expect(checkCodexBinaryTrust(input(fileStat("/opt/codex"), [dirStat("/opt")]))).toBeNull();
  });

  it("refuses a world-writable file", () => {
    expect(checkCodexBinaryTrust(input(fileStat("/opt/codex", { mode: 0o777 }), [dirStat("/opt")]))).toMatch(/world-writable/);
  });

  it("refuses a file owned by another user (not self, not root)", () => {
    expect(checkCodexBinaryTrust(input(fileStat("/opt/codex", { uid: 777 }), [dirStat("/opt")]))).toMatch(/another user/);
  });

  it("is unconditionally unchecked (null) on win32 — an UNCHECKED path, not a verified one", () => {
    const result = checkCodexBinaryTrust(input(fileStat("/c/codex.exe", { mode: 0o777, uid: 999 }), [], { platform: "win32" }));
    expect(result).toBeNull();
  });
});

// W5.5 HIGH fix: pre-fix, group-writability was judged against SUPPLEMENTARY
// GROUP MEMBERSHIP (`!input.gids.includes(entry.gid)`), which accepted any
// path whose group the CURRENT user happened to belong to — but every OTHER
// member of that same group can write there too. Every "REJECTS" test below
// fails on that pre-fix rule whenever the fixture's group is one the acting
// identity is (or, on the real machine, always is) a member of.
describe("checkCodexBinaryTrust — group-writable: membership is not trust", () => {
  it("REJECTS victim:developers 0775 — self-owned, group-writable, ordinary group (fails under the pre-fix membership rule)", () => {
    const developersGid = 4000;
    const result = checkCodexBinaryTrust(
      input(fileStat("/opt/codex"), [dirStat("/opt", { mode: 0o775, gid: developersGid })]),
    );
    expect(result).toMatch(/writable by group 4000/);
  });

  it("REJECTS darwin :staff 0775 — gid 20 is the DEFAULT primary group of every local Mac account, so membership proves nothing (fails under the pre-fix rule)", () => {
    const result = checkCodexBinaryTrust(
      input(fileStat("/opt/codex"), [dirStat("/opt", { mode: 0o775, gid: 20 })], { egid: 20 }),
    );
    expect(result).toMatch(/writable by group 20/);
  });

  it("REJECTS an arbitrary unrecognized darwin group (999)", () => {
    const result = checkCodexBinaryTrust(input(fileStat("/opt/codex"), [dirStat("/opt", { mode: 0o775, gid: 999 })]));
    expect(result).toMatch(/writable by group 999/);
  });

  it("ACCEPTS the stock Homebrew shape (darwin, gid 80/admin) by GID VALUE alone, independent of the caller's OWN membership", () => {
    const result = checkCodexBinaryTrust(
      input(
        fileStat("/opt/homebrew/bin/codex", { uid: 0, gid: 80 }),
        [dirStat("/opt/homebrew/bin", { uid: 0, mode: 0o775, gid: 80 })],
        { uid: 501, egid: 20 }, // NOT a member of gid 80 — the point is that membership is irrelevant here.
      ),
    );
    expect(result).toBeNull();
  });

  it("ACCEPTS darwin wheel (gid 0) the same way", () => {
    const result = checkCodexBinaryTrust(
      input(fileStat("/opt/codex", { uid: 0 }), [dirStat("/opt", { uid: 0, mode: 0o775, gid: 0 })], { egid: 20 }),
    );
    expect(result).toBeNull();
  });
});

describe("checkCodexBinaryTrust — group-writable on linux: user-private-group, and its documented residual", () => {
  it("ACCEPTS the user-private-group pattern: self-owned directory, group === egid", () => {
    const result = checkCodexBinaryTrust(
      input(
        fileStat("/home/dev/bin/codex"),
        [dirStat("/home/dev/bin", { mode: 0o775, gid: 1000 })],
        { platform: "linux", uid: 501, egid: 1000 },
      ),
    );
    expect(result).toBeNull();
  });

  it("REJECTS the identical shape on darwin — the linux rule does not leak across platforms", () => {
    const result = checkCodexBinaryTrust(
      input(
        fileStat("/home/dev/bin/codex"),
        [dirStat("/home/dev/bin", { mode: 0o775, gid: 1000 })],
        { platform: "darwin", uid: 501, egid: 1000 },
      ),
    );
    expect(result).toMatch(/writable by group 1000/);
  });

  it("REJECTS linux group-writable when the directory is root-owned rather than self-owned — case (b) requires entry.uid === self, gid === egid alone is not enough", () => {
    const result = checkCodexBinaryTrust(
      input(
        fileStat("/opt/codex", { uid: 0 }),
        [dirStat("/opt", { uid: 0, mode: 0o775, gid: 1000 })],
        { platform: "linux", uid: 501, egid: 1000 },
      ),
    );
    expect(result).toMatch(/writable by group 1000/);
  });

  it("ACCEPTS a SHARED primary group under the same rule — the documented residual, not a bug: this policy cannot tell a private per-user group from a distro's shared default one", () => {
    const SHARED_USERS_GID = 100; // the classic shared "users" primary group on some distros.
    const result = checkCodexBinaryTrust(
      input(
        fileStat("/home/dev/bin/codex"),
        [dirStat("/home/dev/bin", { mode: 0o775, gid: SHARED_USERS_GID })],
        { platform: "linux", uid: 501, egid: SHARED_USERS_GID },
      ),
    );
    expect(result).toBeNull();
  });
});

describe("checkCodexBinaryTrust — directory chain", () => {
  it("refuses when ANY directory in the supplied chain is unsafe, not only the first entry", () => {
    const result = checkCodexBinaryTrust(input(fileStat("/a/b/codex"), [dirStat("/a/b"), dirStat("/a", { mode: 0o777 })]));
    expect(result).toMatch(/world-writable/);
  });
});

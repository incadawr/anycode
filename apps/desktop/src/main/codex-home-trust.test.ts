import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CodexPathStat } from "../shared/codex-binary-trust.js";
import { checkCodexHomePathTrust, checkCodexHomeTrust } from "./codex-home-trust.js";

const SELF_UID = 501;

function dirStat(path: string, overrides: Partial<CodexPathStat> = {}): CodexPathStat {
  return { path, isFile: false, isDirectory: true, mode: 0o700, uid: SELF_UID, gid: 20, ...overrides };
}

/** A benign ancestor chain: user-owned 0755 dirs under a root-owned 0755 filesystem root. */
function benignAncestors(): CodexPathStat[] {
  return [
    dirStat("/home/dev/.anycode/codex", { mode: 0o755 }),
    dirStat("/home/dev/.anycode", { mode: 0o755 }),
    dirStat("/home/dev", { mode: 0o755 }),
    dirStat("/home", { mode: 0o755, uid: 0 }),
    dirStat("/", { mode: 0o755, uid: 0 }),
  ];
}

function input(overrides: {
  home?: Partial<CodexPathStat>;
  ancestors?: CodexPathStat[];
  owned?: boolean;
  platform?: NodeJS.Platform;
}) {
  return {
    home: dirStat("/home/dev/.anycode/codex/profile-main", overrides.home ?? {}),
    ancestors: overrides.ancestors ?? benignAncestors(),
    uid: SELF_UID,
    platform: overrides.platform ?? ("darwin" as NodeJS.Platform),
    owned: overrides.owned ?? true,
  };
}

describe("checkCodexHomeTrust (pure policy, cut §2.5)", () => {
  it("accepts our own 0700 home over a benign ancestor chain, no repair needed", () => {
    expect(checkCodexHomeTrust(input({}))).toEqual({ ok: true, needsChmod: false });
  });

  it("flags a wider-mode OWNED home for chmod repair and continues (cut §2.5: 'чиним и продолжаем')", () => {
    expect(checkCodexHomeTrust(input({ home: { mode: 0o755 } }))).toEqual({ ok: true, needsChmod: true });
    expect(checkCodexHomeTrust(input({ home: { mode: 0o777 } }))).toEqual({ ok: true, needsChmod: true });
  });

  it("refuses a wider-mode LINKED home — a foreign directory is diagnosed, never chmod'ed", () => {
    const verdict = checkCodexHomeTrust(input({ owned: false, home: { mode: 0o755 } }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/mode|permissions/i);
  });

  it("accepts a LINKED 0700 home owned by us", () => {
    expect(checkCodexHomeTrust(input({ owned: false }))).toEqual({ ok: true, needsChmod: false });
  });

  it("refuses a home owned by another uid, owned and linked alike", () => {
    for (const owned of [true, false]) {
      const verdict = checkCodexHomeTrust(input({ owned, home: { uid: 999 } }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/another user/i);
    }
  });

  it("refuses a home that is not a directory", () => {
    const verdict = checkCodexHomeTrust(input({ home: { isDirectory: false, isFile: true } }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses a world-writable ancestor WITHOUT the sticky bit", () => {
    const ancestors = benignAncestors();
    ancestors[1] = dirStat("/home/dev/.anycode", { mode: 0o777 });
    const verdict = checkCodexHomeTrust(input({ ancestors }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/world-writable/i);
  });

  it("tolerates a world-writable ancestor WITH the sticky bit (the /tmp shape, cut §2.5)", () => {
    const ancestors = benignAncestors();
    ancestors[1] = dirStat("/home/dev/.anycode", { mode: 0o1777, uid: 0 });
    expect(checkCodexHomeTrust(input({ ancestors })).ok).toBe(true);
  });

  it("refuses an ancestor owned by a third party (not us, not root)", () => {
    const ancestors = benignAncestors();
    ancestors[2] = dirStat("/home/dev", { mode: 0o755, uid: 999 });
    const verdict = checkCodexHomeTrust(input({ ancestors }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/another user/i);
  });

  it("accepts root-owned ancestors (/, /home)", () => {
    expect(checkCodexHomeTrust(input({})).ok).toBe(true);
  });

  it("returns unchecked-ok on win32 (mode bits do not exist there — mirror of codex-binary-trust's residual)", () => {
    expect(checkCodexHomeTrust(input({ platform: "win32", home: { mode: 0o777, uid: 999 } })).ok).toBe(true);
  });
});

describe("checkCodexHomePathTrust (filesystem read half)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "anycode-home-trust-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("passes a real 0700 directory we own", () => {
    const home = join(scratch, "profile-ok");
    mkdirSync(home, { mode: 0o700 });
    expect(checkCodexHomePathTrust(home, { owned: true })).toBeNull();
  });

  it("repairs a wider-mode OWNED home to 0700 and passes", () => {
    const home = join(scratch, "profile-wide");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(checkCodexHomePathTrust(home, { owned: true })).toBeNull();
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
  });

  it("refuses a wider-mode LINKED home without touching its mode", () => {
    const home = join(scratch, "linked-wide");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(checkCodexHomePathTrust(home, { owned: false })).toMatch(/mode|permissions/i);
    expect(lstatSync(home).mode & 0o777).toBe(0o755);
  });

  it("refuses a missing home path", () => {
    expect(checkCodexHomePathTrust(join(scratch, "no-such"), { owned: false })).toMatch(/does not exist/i);
  });
});

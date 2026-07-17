import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCodexProfileHome,
  parseCodexProfileArgs,
  resolveCodexProfile,
  resolveCodexProfilesHomeOverride,
} from "./codex-home.js";

// ONLY temp directories are ever touched here — never a real ~/.codex or
// ~/.anycode (credential custody, wave rule). Each case builds its own tree.
const scratch = mkdtempSync(join(tmpdir(), "anycode-codex-home-test-"));
let caseId = 0;
function freshDir(): string {
  caseId += 1;
  const dir = join(scratch, `case-${caseId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("parseCodexProfileArgs", () => {
  it("reads all three profile flags in both `--flag value` and `--flag=value` forms", () => {
    expect(parseCodexProfileArgs(["--codex-profile", "personal"])).toEqual({ profileId: "personal" });
    expect(parseCodexProfileArgs(["--codex-home=/x/codex-accounts/acc2"])).toEqual({ linkedHome: "/x/codex-accounts/acc2" });
    expect(
      parseCodexProfileArgs(["--resume", "s1", "--codex-profile=main", "--codex-auth-link", "/x/.codex/auth.json"]),
    ).toEqual({ profileId: "main", authLink: "/x/.codex/auth.json" });
  });

  it("returns {} when no profile argv is present (the system pseudo-profile)", () => {
    expect(parseCodexProfileArgs(["--session", "s1", "--engine-model", "gpt-5.6-sol"])).toEqual({});
  });
});

describe("resolveCodexProfile", () => {
  const home = "/Users/someone";

  it("system (no argv) resolves to null — no CODEX_HOME is ever set", () => {
    expect(resolveCodexProfile({}, home)).toBeNull();
  });

  it("derives a managed home from the profile id, inside ~/.anycode/codex/", () => {
    expect(resolveCodexProfile({ profileId: "personal" }, home)).toEqual({
      kind: "managed",
      home: join(home, ".anycode", "codex", "profile-personal"),
    });
  });

  it("carries the auth-link intent for a managed profile (amendment §A1.1)", () => {
    expect(resolveCodexProfile({ profileId: "main", authLink: "/Users/someone/.codex/auth.json" }, home)).toEqual({
      kind: "managed",
      home: join(home, ".anycode", "codex", "profile-main"),
      authLink: "/Users/someone/.codex/auth.json",
    });
  });

  it("a linkedHome is used verbatim (main already validated it) and never combined with authLink", () => {
    expect(resolveCodexProfile({ linkedHome: "/Users/someone/.codex-accounts/acc2" }, home)).toEqual({
      kind: "linked",
      home: "/Users/someone/.codex-accounts/acc2",
    });
    expect(() => resolveCodexProfile({ linkedHome: "/x", authLink: "/y/auth.json" }, home)).toThrow(/mutually exclusive/i);
  });

  it("fail-closed on every malformed input — never a silent fallback to the ambient account", () => {
    // An id is NOT a path (cut §2.6.1): traversal/charset junk refuses the spawn.
    expect(() => resolveCodexProfile({ profileId: "../evil" }, home)).toThrow(/profile id/i);
    expect(() => resolveCodexProfile({ profileId: "UPPER" }, home)).toThrow(/profile id/i);
    expect(() => resolveCodexProfile({ profileId: "-lead" }, home)).toThrow(/profile id/i);
    expect(() => resolveCodexProfile({ profileId: "a".repeat(33) }, home)).toThrow(/profile id/i);
    expect(() => resolveCodexProfile({ linkedHome: "relative/home" }, home)).toThrow(/absolute/i);
    expect(() => resolveCodexProfile({ profileId: "ok", authLink: "relative/auth.json" }, home)).toThrow(/absolute/i);
    expect(() => resolveCodexProfile({ authLink: "/x/auth.json" }, home)).toThrow(/profile/i);
  });
});

describe("assertCodexProfileHome — managed home re-assert (amendment §A2)", () => {
  it("creates a missing managed home with mode 0700 (idempotently)", () => {
    const base = freshDir();
    const profileHome = join(base, ".anycode", "codex", "profile-personal");
    expect(assertCodexProfileHome({ kind: "managed", home: profileHome })).toBeNull();
    expect(statSync(profileHome).isDirectory()).toBe(true);
    expect(statSync(profileHome).mode & 0o777).toBe(0o700);
    // Second run is a no-op, not a failure.
    expect(assertCodexProfileHome({ kind: "managed", home: profileHome })).toBeNull();
  });

  it("tightens a widened managed home back to 0700 (ours — we fix, we do not refuse)", () => {
    const base = freshDir();
    const profileHome = join(base, "profile-x");
    mkdirSync(profileHome, { mode: 0o755 });
    expect(assertCodexProfileHome({ kind: "managed", home: profileHome })).toBeNull();
    expect(statSync(profileHome).mode & 0o777).toBe(0o700);
  });

  it("refuses a managed home that is itself a symlink (tampering, not ours to follow)", () => {
    const base = freshDir();
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(base, "profile-sneaky"));
    expect(assertCodexProfileHome({ kind: "managed", home: join(base, "profile-sneaky") })).toMatch(/symlink/i);
  });

  it("only diagnoses a linked home — never creates or chmods someone else's directory", () => {
    const base = freshDir();
    const linked = join(base, "cx-account");
    expect(assertCodexProfileHome({ kind: "linked", home: linked })).toMatch(/does not exist/i);

    mkdirSync(linked, { mode: 0o755 });
    expect(assertCodexProfileHome({ kind: "linked", home: linked })).toBeNull();
    // NOT tightened: a linked home belongs to the user's external tooling.
    expect(statSync(linked).mode & 0o777).toBe(0o755);
  });
});

describe("assertCodexProfileHome — auth.json symlink guard (amendment §A1.2)", () => {
  function managedWithTarget(): { home: string; target: string } {
    const base = freshDir();
    const home = join(base, "profile-main");
    const target = join(base, "external", "auth.json");
    mkdirSync(join(base, "external"));
    writeFileSync(target, "");
    return { home, target };
  }

  it("recreates a missing auth.json symlink and points it at the expanded target", () => {
    const { home, target } = managedWithTarget();
    expect(assertCodexProfileHome({ kind: "managed", home, authLink: target })).toBeNull();
    const link = join(home, "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    // Idempotent re-assert: an intact link passes untouched.
    expect(assertCodexProfileHome({ kind: "managed", home, authLink: target })).toBeNull();
  });

  it("a dangling target is NOT our problem — the link is still created (codex will report signed_out)", () => {
    const base = freshDir();
    const home = join(base, "profile-main");
    const target = join(base, "external", "auth.json"); // never created
    expect(assertCodexProfileHome({ kind: "managed", home, authLink: target })).toBeNull();
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("REFUSES a redirected symlink — no auto-repair, repair is an explicit UI action", () => {
    const { home, target } = managedWithTarget();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    symlinkSync(join(home, "somewhere-else"), join(home, "auth.json"));
    const diagnostic = assertCodexProfileHome({ kind: "managed", home, authLink: target });
    expect(diagnostic).toMatch(/redirected|different target/i);
    // The redirected link is LEFT IN PLACE as evidence — silent repair hides tampering.
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(home, "somewhere-else"));
  });

  it("REFUSES a regular file where the symlink should be, and NEVER deletes or reads it (TASK.50 DoD)", () => {
    const { home, target } = managedWithTarget();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // codex may have refreshed tokens via tmp+rename, breaking the link — the
    // file can hold tokens FRESHER than the owner's; auto-deleting it is forbidden.
    writeFileSync(join(home, "auth.json"), "OPAQUE-CREDENTIAL-NEVER-READ");
    const diagnostic = assertCodexProfileHome({ kind: "managed", home, authLink: target });
    expect(diagnostic).toMatch(/detached|regular file/i);
    // The file survives, byte-identical (we never even open it for reading).
    expect(lstatSync(join(home, "auth.json")).isFile()).toBe(true);
    // And no credential content ever leaks into the diagnostic.
    expect(diagnostic).not.toContain("OPAQUE-CREDENTIAL-NEVER-READ");
  });

  it("REFUSES any other node type (directory) at auth.json", () => {
    const { home, target } = managedWithTarget();
    mkdirSync(join(home, "auth.json"), { recursive: true });
    chmodSync(home, 0o700);
    expect(assertCodexProfileHome({ kind: "managed", home, authLink: target })).toMatch(/neither a symlink nor absent/i);
  });
});

describe("resolveCodexProfilesHomeOverride (W4-F0b host lever, Fable ruling iter-10)", () => {
  it("GREEN: automation + absolute lever — the managed profile derives, is created 0700, and auth.json links under the LEVER root", () => {
    const lever = join(freshDir(), "lever-root");
    const authTarget = join(freshDir(), "external-auth.json");
    writeFileSync(authTarget, "");
    const override = resolveCodexProfilesHomeOverride({
      ANYCODE_AUTOMATION: "1",
      ANYCODE_CODEX_PROFILES_HOME: lever,
    });
    expect(override).toBe(lever);
    // Call-site composition (host/index.ts bootCodexSession): override ?? homedir default.
    const profile = resolveCodexProfile({ profileId: "smoke", authLink: authTarget }, override ?? undefined);
    // Containment moved WITH the base: the derived home sits under
    // <lever>/.anycode/codex, and the whole custody plane (0700 dir +
    // auth.json symlink) lands THERE — the smoke measures the production
    // code path, just rooted elsewhere.
    expect(profile).toEqual({
      kind: "managed",
      home: join(lever, ".anycode", "codex", "profile-smoke"),
      authLink: authTarget,
    });
    expect(assertCodexProfileHome(profile!)).toBeNull();
    expect(statSync(profile!.home).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(profile!.home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(profile!.home, "auth.json"))).toBe(authTarget);
  });

  it("RED-proof (host gate): the lever WITHOUT automation is ignored — derivation stays on the injected homedir", () => {
    const injectedHome = freshDir();
    const override = resolveCodexProfilesHomeOverride({
      ANYCODE_CODEX_PROFILES_HOME: "/tmp/ungated-ambient-lever",
    });
    expect(override).toBeNull();
    const profile = resolveCodexProfile({ profileId: "smoke" }, override ?? injectedHome);
    expect(profile!.home).toBe(join(injectedHome, ".anycode", "codex", "profile-smoke"));
  });

  const nullCases: Array<[string, NodeJS.ProcessEnv]> = [
    ["automation unset", { ANYCODE_CODEX_PROFILES_HOME: "/tmp/x" }],
    ["automation = 0", { ANYCODE_AUTOMATION: "0", ANYCODE_CODEX_PROFILES_HOME: "/tmp/x" }],
    ["automation = true (not the literal \"1\")", { ANYCODE_AUTOMATION: "true", ANYCODE_CODEX_PROFILES_HOME: "/tmp/x" }],
    ["automation unset + relative var (ignored outside automation, no throw)", { ANYCODE_CODEX_PROFILES_HOME: "relative/x" }],
    ["var unset, automation on (production byte-path)", { ANYCODE_AUTOMATION: "1" }],
    ["var unset, automation off (production byte-path)", {}],
  ];

  it.each(nullCases)("returns null: %s", (_label, env) => {
    expect(resolveCodexProfilesHomeOverride(env)).toBeNull();
  });

  it("RED-proof (fail-closed): automation + malformed lever REFUSES the boot (throw) — no silent fallback to the real home, not a single mkdir", () => {
    const wouldBeRealHome = join(freshDir(), "would-be-real-home");
    for (const bad of ["", "   ", "relative/lever-root"]) {
      expect(() =>
        resolveCodexProfilesHomeOverride({ ANYCODE_AUTOMATION: "1", ANYCODE_CODEX_PROFILES_HOME: bad }),
      ).toThrow(/refusing to boot/i);
    }
    // The refusal fires BEFORE any derivation or home assert — nothing was created.
    expect(existsSync(join(wouldBeRealHome, ".anycode"))).toBe(false);
  });
});

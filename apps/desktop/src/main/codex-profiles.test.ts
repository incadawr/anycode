import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CodexProfileRecord } from "../shared/settings.js";
import {
  MAX_CODEX_PROFILES,
  SYSTEM_CODEX_PROFILE,
  SYSTEM_PROFILE_ID,
  applyCodexProfileEnv,
  assertCodexProfileHome,
  codexProfileArgs,
  codexProfileHome,
  codexProfilesRoot,
  createCodexProfilesRegistry,
  expandAuthLink,
  isValidCodexProfileId,
  repairCodexAuthLink,
  resolveCodexProfile,
  type ResolvedCodexProfile,
} from "./codex-profiles.js";

const scratch = mkdtempSync(join(tmpdir(), "anycode-codex-profiles-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh fake user home per test — every profile home lives under tmp, NEVER a real ~/.codex. */
let homeCounter = 0;
function freshHome(): string {
  const home = join(scratch, `home-${homeCounter++}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function record(overrides: Partial<CodexProfileRecord> = {}): CodexProfileRecord {
  return { id: "acc1", label: "Account 1", createdAt: "2026-07-16T00:00:00.000Z", ...overrides };
}

describe("isValidCodexProfileId / codexProfileHome (traversal gate, cut §2.6.1)", () => {
  it("accepts the strict charset", () => {
    for (const id of ["main", "acc-2", "a", "0abc", "a".repeat(32)]) {
      expect(isValidCodexProfileId(id), id).toBe(true);
    }
  });

  it("rejects every path-traversal and off-charset form", () => {
    for (const id of ["../evil", "..", "a/b", "a\\b", ".hidden", "-lead", "UPPER", "", "a".repeat(33), "a b", "%2e%2e", "a\0b", "профиль"]) {
      expect(isValidCodexProfileId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("derives the profile home strictly under ~/.anycode/codex/ and throws on an invalid id", () => {
    const home = "/home/dev";
    expect(codexProfileHome("main", home)).toBe(join(home, ".anycode", "codex", "profile-main"));
    expect(() => codexProfileHome("../evil", home)).toThrow(/profile id/i);
    expect(() => codexProfileHome("..", home)).toThrow(/profile id/i);
  });

  it("codexProfilesRoot resolves to ~/.anycode/codex", () => {
    expect(codexProfilesRoot("/home/dev")).toBe(join("/home/dev", ".anycode", "codex"));
  });
});

describe("expandAuthLink (amended §A1.1.4)", () => {
  it("expands the ~/ form against the user home", () => {
    expect(expandAuthLink("~/.codex/auth.json", "/home/dev")).toBe(join("/home/dev", ".codex", "auth.json"));
  });

  it("passes an absolute path through", () => {
    expect(expandAuthLink("/mnt/x/auth.json", "/home/dev")).toBe("/mnt/x/auth.json");
  });

  it("refuses a relative (non-~, non-absolute) path", () => {
    expect(expandAuthLink("codex/auth.json", "/home/dev")).toBeNull();
    expect(expandAuthLink("./auth.json", "/home/dev")).toBeNull();
    expect(expandAuthLink("", "/home/dev")).toBeNull();
  });
});

describe("resolveCodexProfile", () => {
  it("resolves a plain record to our own profile home", () => {
    const resolution = resolveCodexProfile(record(), "/home/dev");
    expect(resolution).toEqual({
      ok: true,
      profile: { id: "acc1", codexHome: join("/home/dev", ".anycode", "codex", "profile-acc1"), linked: false },
    });
  });

  it("resolves an authLink record with the expanded absolute target", () => {
    const resolution = resolveCodexProfile(record({ id: "main", authLink: "~/.codex/auth.json" }), "/home/dev");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.profile.authLink).toBe(join("/home/dev", ".codex", "auth.json"));
      expect(resolution.profile.codexHome).toBe(join("/home/dev", ".anycode", "codex", "profile-main"));
      expect(resolution.profile.linked).toBe(false);
    }
  });

  it("resolves a linkedHome record to the external home verbatim", () => {
    const resolution = resolveCodexProfile(record({ linkedHome: "/home/dev/.codex-accounts/personal" }), "/home/dev");
    expect(resolution).toEqual({
      ok: true,
      profile: { id: "acc1", codexHome: "/home/dev/.codex-accounts/personal", linked: true },
    });
  });

  it("expands a tilde linkedHome against the user home (C0 review F1 ruling: tilde-or-absolute, ONE expansion point)", () => {
    const resolution = resolveCodexProfile(record({ linkedHome: "~/homes/work" }), "/home/dev");
    expect(resolution).toEqual({
      ok: true,
      profile: { id: "acc1", codexHome: "/home/dev/homes/work", linked: true },
    });
  });

  it("refuses a record with an invalid (traversal) id — defense in depth behind the zod boundary", () => {
    const resolution = resolveCodexProfile(record({ id: "../evil" as string }), "/home/dev");
    expect(resolution.ok).toBe(false);
  });

  it("refuses authLink+linkedHome together, a relative linkedHome, and a relative authLink", () => {
    expect(resolveCodexProfile(record({ authLink: "~/.codex/auth.json", linkedHome: "/x" }), "/home/dev").ok).toBe(false);
    expect(resolveCodexProfile(record({ linkedHome: "relative/path" }), "/home/dev").ok).toBe(false);
    expect(resolveCodexProfile(record({ authLink: "relative/auth.json" }), "/home/dev").ok).toBe(false);
  });
});

describe("applyCodexProfileEnv (cut §2.6.2/§2.6.3 — gate hazard §14.6)", () => {
  it("OVERWRITES an ambient CODEX_HOME with the profile home", () => {
    // The hazard-§14.6 shape: ambient value MUST be present in the source env,
    // or this test would pass even on a passthrough implementation.
    const ambient = { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-ambient-hijack" };
    const profile: ResolvedCodexProfile = { id: "acc1", codexHome: "/home/dev/.anycode/codex/profile-acc1", linked: false };
    const env = applyCodexProfileEnv(ambient, profile);
    expect(env.CODEX_HOME).toBe("/home/dev/.anycode/codex/profile-acc1");
    expect(env.HOME).toBe("/home/dev");
    // The source env object is never mutated.
    expect(ambient.CODEX_HOME).toBe("/home/dev/.codex-ambient-hijack");
  });

  it("sets CODEX_HOME for a profile even when the ambient env has none", () => {
    const env = applyCodexProfileEnv({ HOME: "/home/dev" }, { id: "acc1", codexHome: "/p", linked: false });
    expect(env.CODEX_HOME).toBe("/p");
  });

  it("leaves the env BYTE-IDENTICAL for the system pseudo-profile (inheritance as today)", () => {
    const ambient = { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-custom" };
    expect(applyCodexProfileEnv(ambient, SYSTEM_CODEX_PROFILE)).toBe(ambient);
    expect(applyCodexProfileEnv(ambient, undefined)).toBe(ambient);
  });
});

describe("codexProfileArgs (argv seam for main/tabs.ts — cut §3.3 + amended §A1.2)", () => {
  it("emits nothing for system", () => {
    expect(codexProfileArgs(SYSTEM_CODEX_PROFILE)).toEqual([]);
  });

  it("emits --codex-profile for an own-home profile", () => {
    expect(codexProfileArgs({ id: "acc1", codexHome: "/h/p", linked: false })).toEqual(["--codex-profile", "acc1"]);
  });

  it("adds --codex-home ONLY for linkedHome and --codex-auth-link ONLY for authLink", () => {
    expect(codexProfileArgs({ id: "p", codexHome: "/ext/home", linked: true })).toEqual([
      "--codex-profile", "p", "--codex-home", "/ext/home",
    ]);
    expect(codexProfileArgs({ id: "main", codexHome: "/h/profile-main", authLink: "/h/.codex/auth.json", linked: false })).toEqual([
      "--codex-profile", "main", "--codex-auth-link", "/h/.codex/auth.json",
    ]);
  });
});

describe("assertCodexProfileHome (idempotent pre-spawn re-assert, amended §A2 + §A1.2 table)", () => {
  function ownProfile(home: string, id = "acc1", authTarget?: string): ResolvedCodexProfile {
    return {
      id,
      codexHome: codexProfileHome(id, home),
      ...(authTarget !== undefined ? { authLink: authTarget } : {}),
      linked: false,
    };
  }

  it("creates a missing own home with mode 0700 (and recreates it after deletion)", () => {
    const home = freshHome();
    const profile = ownProfile(home);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const homeDir = profile.codexHome as string;
    expect(lstatSync(homeDir).mode & 0o777).toBe(0o700);
    rmSync(homeDir, { recursive: true });
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    expect(existsSync(homeDir)).toBe(true);
  });

  it("chmods a widened own home back to 0700", () => {
    const home = freshHome();
    const profile = ownProfile(home);
    mkdirSync(profile.codexHome as string, { recursive: true, mode: 0o755 });
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    expect(lstatSync(profile.codexHome as string).mode & 0o777).toBe(0o700);
  });

  it("system asserts nothing and touches nothing", () => {
    expect(assertCodexProfileHome(SYSTEM_CODEX_PROFILE)).toEqual({ ok: true });
  });

  it("refuses a missing linkedHome and creates nothing inside an existing one", () => {
    const home = freshHome();
    const missing = assertCodexProfileHome({ id: "p", codexHome: join(home, "no-such-external"), linked: true });
    expect(missing.ok).toBe(false);

    const external = join(home, "external-codex");
    mkdirSync(external, { mode: 0o700 });
    expect(assertCodexProfileHome({ id: "p", codexHome: external, linked: true })).toEqual({ ok: true });
    // An external home is never populated by us — no auth.json, no config, nothing.
    expect(existsSync(join(external, "auth.json"))).toBe(false);
  });

  // ── §A1.2 lstat-guard table, row by row ──

  it("A1.2 row 1: ENOENT — recreates the symlink and continues", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const profile = ownProfile(home, "main", target);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it("A1.2 row 1 (dangling target): a target that does not exist is NOT our concern — link is still created", () => {
    const home = freshHome();
    const profile = ownProfile(home, "main", join(home, "never-created.json"));
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    expect(lstatSync(join(profile.codexHome as string, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("A1.2 row 2: a symlink pointing at the expected target passes", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const profile = ownProfile(home, "main", target);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
  });

  it("A1.2 row 3: a symlink redirected to a FOREIGN target is an error with NO auto-repair", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    const foreign = join(home, "attacker-target.json");
    writeFileSync(target, "{}");
    writeFileSync(foreign, "{}");
    const profile = ownProfile(home, "main", target);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    rmSync(link);
    symlinkSync(foreign, link);
    const verdict = assertCodexProfileHome(profile);
    expect(verdict.ok).toBe(false);
    // NOT silently repaired: the redirected link is evidence, not litter.
    expect(readlinkSync(link)).toBe(foreign);
  });

  it("A1.2 row 4: a REGULAR FILE at auth.json is an error, and the file is NOT deleted (it may hold fresher tokens)", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const profile = ownProfile(home, "main", target);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    rmSync(link);
    writeFileSync(link, JSON.stringify({ detached: true }));
    const verdict = assertCodexProfileHome(profile);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/detached|copy|file/i);
    expect(lstatSync(link).isFile()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe(JSON.stringify({ detached: true }));
  });

  it("A1.2 row 5: any other node type (directory) at auth.json is an error", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const profile = ownProfile(home, "main", target);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    rmSync(link);
    mkdirSync(link);
    expect(assertCodexProfileHome(profile).ok).toBe(false);
  });

  it("a profile WITHOUT authLink never asserts (or creates) an auth.json at all", () => {
    const home = freshHome();
    const profile = ownProfile(home);
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    expect(existsSync(join(profile.codexHome as string, "auth.json"))).toBe(false);
  });
});

describe("repairCodexAuthLink (explicit 'Пересоздать связь' — an IPC action, never automatic)", () => {
  it("replaces a detached regular file with the symlink, leaving the TARGET untouched", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, JSON.stringify({ owner: "keep-me" }));
    const profile: ResolvedCodexProfile = { id: "main", codexHome: codexProfileHome("main", home), authLink: target, linked: false };
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    rmSync(link);
    writeFileSync(link, JSON.stringify({ detached: true }));

    expect(repairCodexAuthLink(profile)).toEqual({ ok: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ owner: "keep-me" }));
  });

  it("re-points a redirected symlink at the expected target", () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    const foreign = join(home, "attacker-target.json");
    writeFileSync(target, "{}");
    writeFileSync(foreign, JSON.stringify({ foreign: true }));
    const profile: ResolvedCodexProfile = { id: "main", codexHome: codexProfileHome("main", home), authLink: target, linked: false };
    expect(assertCodexProfileHome(profile)).toEqual({ ok: true });
    const link = join(profile.codexHome as string, "auth.json");
    rmSync(link);
    symlinkSync(foreign, link);

    expect(repairCodexAuthLink(profile)).toEqual({ ok: true });
    expect(readlinkSync(link)).toBe(target);
    // The foreign target file itself is not our property — untouched.
    expect(readFileSync(foreign, "utf8")).toBe(JSON.stringify({ foreign: true }));
  });

  it("refuses profiles without an authLink", () => {
    expect(repairCodexAuthLink({ id: "acc1", codexHome: "/x", linked: false }).ok).toBe(false);
    expect(repairCodexAuthLink(SYSTEM_CODEX_PROFILE).ok).toBe(false);
  });
});

describe("createCodexProfilesRegistry (settings-backed, cut §2.3 + §4.3 cap)", () => {
  function makeRegistry(initial: { profiles?: CodexProfileRecord[]; activeProfileId?: string } = {}, home = freshHome()) {
    let codexBlock: { profiles?: CodexProfileRecord[]; activeProfileId?: string } = { ...initial };
    const writes: unknown[] = [];
    const registry = createCodexProfilesRegistry({
      readCodex: async () => codexBlock,
      writeCodex: async (patch) => {
        writes.push(patch);
        codexBlock = { ...codexBlock, ...patch };
      },
      home,
    });
    return { registry, writes, home, codex: () => codexBlock };
  }

  it("lists an implicit system profile even when no profiles are persisted", async () => {
    const { registry } = makeRegistry();
    const listed = await registry.list();
    expect(listed.activeProfileId).toBe(SYSTEM_PROFILE_ID);
    expect(listed.profiles).toEqual([]);
  });

  it("creates a plain profile: mints a slug id, creates the 0700 home, persists the record", async () => {
    const { registry, home, codex } = makeRegistry();
    const created = await registry.create({ label: "Personal Account" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.profile.id).toBe("personal-account");
    expect(created.profile.label).toBe("Personal Account");
    const homeDir = codexProfileHome(created.profile.id, home);
    expect(lstatSync(homeDir).mode & 0o777).toBe(0o700);
    expect(codex().profiles).toHaveLength(1);
  });

  it("creates an authLink profile with the symlink in place", async () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const { registry } = makeRegistry({}, home);
    const created = await registry.create({ label: "main", authLink: target });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.profile.authLink).toBe(target);
    const link = join(codexProfileHome(created.profile.id, home), "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it("dedups a colliding slug with a numeric suffix and refuses the reserved 'system' slug", async () => {
    const { registry } = makeRegistry();
    const first = await registry.create({ label: "acc" });
    const second = await registry.create({ label: "acc" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.profile.id).toBe("acc");
      expect(second.profile.id).toBe("acc-2");
    }
    const sys = await registry.create({ label: "system" });
    expect(sys.ok).toBe(true);
    if (sys.ok) expect(sys.profile.id).not.toBe(SYSTEM_PROFILE_ID);
  });

  it("refuses authLink+linkedHome together and a relative linkedHome", async () => {
    const { registry } = makeRegistry();
    expect((await registry.create({ label: "x", authLink: "~/a.json", linkedHome: "/y" })).ok).toBe(false);
    expect((await registry.create({ label: "x", linkedHome: "relative" })).ok).toBe(false);
  });

  it(`caps the registry at ${MAX_CODEX_PROFILES} profiles`, async () => {
    const { registry } = makeRegistry();
    for (let index = 0; index < MAX_CODEX_PROFILES; index++) {
      expect((await registry.create({ label: `acc${index}` })).ok).toBe(true);
    }
    const overflow = await registry.create({ label: "one-too-many" });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toBe("limit");
  });

  it("removes a profile: deletes OUR home, drops the record, resets a dangling activeProfileId", async () => {
    const { registry, home, codex } = makeRegistry();
    const created = await registry.create({ label: "gone" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await registry.setActive(created.profile.id);
    const homeDir = codexProfileHome(created.profile.id, home);
    expect(existsSync(homeDir)).toBe(true);

    expect(await registry.remove(created.profile.id)).toEqual({ ok: true });
    expect(existsSync(homeDir)).toBe(false);
    expect(codex().profiles).toEqual([]);
    expect(codex().activeProfileId).toBe(SYSTEM_PROFILE_ID);
  });

  it("removing an authLink profile removes the SYMLINK but never the target credential", async () => {
    const home = freshHome();
    const target = join(home, "fake-auth-target.json");
    writeFileSync(target, JSON.stringify({ owner: "keep" }));
    const { registry } = makeRegistry({}, home);
    const created = await registry.create({ label: "main", authLink: target });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await registry.remove(created.profile.id)).toEqual({ ok: true });
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ owner: "keep" }));
  });

  it("removing a linkedHome profile never touches the external directory", async () => {
    const home = freshHome();
    const external = join(home, "external-codex");
    mkdirSync(external, { mode: 0o700 });
    writeFileSync(join(external, "auth.json"), "{}");
    const { registry } = makeRegistry({}, home);
    const created = await registry.create({ label: "ext", linkedHome: external });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await registry.remove(created.profile.id)).toEqual({ ok: true });
    expect(existsSync(join(external, "auth.json"))).toBe(true);
  });

  it("refuses to remove the system pseudo-profile", async () => {
    const { registry } = makeRegistry();
    expect((await registry.remove(SYSTEM_PROFILE_ID)).ok).toBe(false);
  });

  it("resolve() returns system by default, the active profile when set, and refuses an unknown id", async () => {
    const { registry } = makeRegistry();
    expect(await registry.resolve(undefined)).toEqual({ ok: true, profile: SYSTEM_CODEX_PROFILE });

    const created = await registry.create({ label: "acc" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await registry.setActive(created.profile.id);
    const active = await registry.resolve(undefined);
    expect(active.ok && active.profile.id === "acc").toBe(true);

    const explicit = await registry.resolve("acc");
    expect(explicit.ok).toBe(true);
    expect((await registry.resolve("no-such")).ok).toBe(false);
    expect((await registry.resolve("../evil")).ok).toBe(false);
  });

  it("persists a per-profile lastCheck without disturbing sibling records", async () => {
    const { registry, codex } = makeRegistry();
    const a = await registry.create({ label: "a" });
    const b = await registry.create({ label: "b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    await registry.setLastCheck(a.profile.id, { status: "ready", version: "0.144.3", at: "2026-07-16T01:00:00.000Z" });
    const profiles = codex().profiles ?? [];
    expect(profiles.find((profile) => profile.id === "a")?.lastCheck?.status).toBe("ready");
    expect(profiles.find((profile) => profile.id === "b")?.lastCheck).toBeUndefined();
  });
});

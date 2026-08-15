import { describe, expect, it } from "vitest";
import {
  checkCodexBinaryTrust,
  checkConsentedBinaryTrust,
  classifyConsentedBinaryTrust,
  type BinaryTrustConsent,
  type CodexBinaryTrustInput,
  type CodexPathStat,
} from "./codex-binary-trust.js";

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

// TASK.103 — a consent record is authored main-side from a live stat (D-S4-5);
// here it is a literal fixture, no fs involved. `FINGERPRINT_SIZE`/`_MTIME`
// stand in for the raw stat values a real grant would capture.
const FINGERPRINT_SIZE = 4096;
const FINGERPRINT_MTIME = 1_700_000_000_000;
const GRANTED_AT = "2026-08-15T00:00:00.000Z";

/** A file stat that carries the fingerprint fields (production fs.Stats always does). */
function fingerprintedFileStat(path: string, overrides: Partial<CodexPathStat> = {}): CodexPathStat {
  return fileStat(path, { size: FINGERPRINT_SIZE, mtimeMs: FINGERPRINT_MTIME, ...overrides });
}

/** A consent record that exactly matches the given (fingerprinted) file stat. */
function consentFor(file: CodexPathStat, overrides: Partial<BinaryTrustConsent> = {}): BinaryTrustConsent {
  return {
    path: file.path,
    fingerprint: {
      mode: file.mode,
      uid: file.uid,
      gid: file.gid,
      size: file.size as number,
      mtimeMs: file.mtimeMs as number,
    },
    grantedAt: GRANTED_AT,
    ...overrides,
  };
}

describe("consented binary trust (TASK.103)", () => {
  it("BT1 consent lifts a directory-shape refusal; without consent the base refusal returns verbatim", () => {
    const file = fingerprintedFileStat("/opt/codex");
    const trustInput = input(file, [dirStat("/opt", { mode: 0o777 })]);
    const base = checkCodexBinaryTrust(trustInput);
    expect(base).toMatch(/world-writable/);
    expect(checkConsentedBinaryTrust(trustInput, [consentFor(file)])).toBeNull();
    expect(checkConsentedBinaryTrust(trustInput, [])).toBe(base);
  });

  it("BT2 drift matrix: each fingerprint field varied alone (mode/uid/gid/size/mtimeMs) invalidates the consent", () => {
    const file = fingerprintedFileStat("/opt/codex");
    const trustInput = input(file, [dirStat("/opt", { mode: 0o777 })]);
    const base = checkCodexBinaryTrust(trustInput);
    const good = consentFor(file);

    const drifted = (field: keyof typeof good.fingerprint, delta: number): BinaryTrustConsent => ({
      ...good,
      fingerprint: { ...good.fingerprint, [field]: good.fingerprint[field] + delta },
    });

    for (const field of ["mode", "uid", "gid", "size", "mtimeMs"] as const) {
      const consent = drifted(field, 1);
      expect(checkConsentedBinaryTrust(trustInput, [consent]), `drift on ${field} must refuse`).toBe(base);
    }
    // sanity: the un-drifted consent still lifts the refusal.
    expect(checkConsentedBinaryTrust(trustInput, [good])).toBeNull();
  });

  it("BT3 path mismatch: an identical fingerprint recorded for a sibling/prefix path does not match (scope-creep guard)", () => {
    const file = fingerprintedFileStat("/opt/codex");
    const trustInput = input(file, [dirStat("/opt", { mode: 0o777 })]);
    const base = checkCodexBinaryTrust(trustInput);
    // A wholly different sibling binary's consent must not leak.
    const siblingConsent = consentFor(file, { path: "/opt/claude" });
    expect(checkConsentedBinaryTrust(trustInput, [siblingConsent])).toBe(base);
    // A PREFIX of this path (e.g. from a shorter-named binary) must not
    // match either — exact equality only, no prefix/normalization logic.
    const prefixConsent = consentFor(file, { path: "/opt/code" });
    expect(checkConsentedBinaryTrust(trustInput, [prefixConsent])).toBe(base);
  });

  it("BT4 structural refusals are never consented, even with an otherwise-matching consent", () => {
    const notAFile = fingerprintedFileStat("/opt/codex", { isFile: false });
    const notExecutable = fingerprintedFileStat("/opt/codex", { mode: 0o644 });
    const badAncestorFile = fingerprintedFileStat("/opt/codex");

    const cases: Array<{ file: CodexPathStat; directories: readonly CodexPathStat[] }> = [
      { file: notAFile, directories: [dirStat("/opt")] },
      { file: notExecutable, directories: [dirStat("/opt")] },
      { file: badAncestorFile, directories: [dirStat("/opt", { isDirectory: false })] },
    ];

    for (const { file, directories } of cases) {
      const trustInput = input(file, directories);
      const base = checkCodexBinaryTrust(trustInput);
      expect(base).not.toBeNull();
      expect(checkConsentedBinaryTrust(trustInput, [consentFor(file)])).toBe(base);
    }
  });

  it("BT5 consent lifts a FILE-shape unsafeReason refusal (world-writable file)", () => {
    const file = fingerprintedFileStat("/opt/codex", { mode: 0o777 });
    const trustInput = input(file, [dirStat("/opt")]);
    const base = checkCodexBinaryTrust(trustInput);
    expect(base).toMatch(/world-writable/);
    expect(checkConsentedBinaryTrust(trustInput, [consentFor(file)])).toBeNull();
  });

  it("BT6 absence fails closed: a live stat missing size/mtimeMs never matches, and an empty consent list refuses", () => {
    const file = fileStat("/opt/codex"); // deliberately no size/mtimeMs
    const trustInput = input(file, [dirStat("/opt", { mode: 0o777 })]);
    const base = checkCodexBinaryTrust(trustInput);
    const consent: BinaryTrustConsent = {
      path: file.path,
      fingerprint: { mode: file.mode, uid: file.uid, gid: file.gid, size: 0, mtimeMs: 0 },
      grantedAt: GRANTED_AT,
    };
    expect(checkConsentedBinaryTrust(trustInput, [consent])).toBe(base);
    expect(checkConsentedBinaryTrust(trustInput, [])).toBe(base);
  });

  it("BT7 a fully-trusted input returns null with and without consents (base-pass short-circuit)", () => {
    const file = fingerprintedFileStat("/opt/codex");
    const trustInput = input(file, [dirStat("/opt")]);
    expect(checkConsentedBinaryTrust(trustInput, [])).toBeNull();
    expect(checkConsentedBinaryTrust(trustInput, [consentFor(file)])).toBeNull();
  });

  it("BT8 win32 stays unconditionally unchecked (null) regardless of consents", () => {
    const file = fingerprintedFileStat("/c/codex.exe", { mode: 0o777, uid: 999 });
    const trustInput = input(file, [], { platform: "win32" });
    expect(checkConsentedBinaryTrust(trustInput, [])).toBeNull();
    expect(checkConsentedBinaryTrust(trustInput, [consentFor(file)])).toBeNull();
  });

  it("BT9 third-party-owned FILE is never consentable, even with a matching consent (D-S4-13)", () => {
    // (a) file-level reason: third-party ownership is the ONLY refusal shape.
    const ownedFile = fingerprintedFileStat("/opt/codex", { uid: 777 });
    const ownedInput = input(ownedFile, [dirStat("/opt")]);
    const ownedBase = checkCodexBinaryTrust(ownedInput);
    expect(ownedBase).toMatch(/owned by another user \(uid 777\)/);
    expect(checkConsentedBinaryTrust(ownedInput, [consentFor(ownedFile)])).toBe(ownedBase);

    // (b) the ordering hole: world-writable AND third-party-owned — the base
    // reason names world-writable (unsafeReason checks that shape first),
    // but the file's owner still keeps forgery power over the whole
    // fingerprint, so consent must still be refused on the FACT, not the
    // reason string.
    const worldWritableOwnedFile = fingerprintedFileStat("/opt/codex", { mode: 0o777, uid: 777 });
    const worldWritableOwnedInput = input(worldWritableOwnedFile, [dirStat("/opt")]);
    const worldWritableOwnedBase = checkCodexBinaryTrust(worldWritableOwnedInput);
    expect(worldWritableOwnedBase).toMatch(/world-writable/);
    expect(checkConsentedBinaryTrust(worldWritableOwnedInput, [consentFor(worldWritableOwnedFile)])).toBe(
      worldWritableOwnedBase,
    );
  });

  it("BT10 classify shape: consentable + staleConsent per input shape", () => {
    // (a) structural refusal.
    const notAFile = fingerprintedFileStat("/opt/codex", { isFile: false });
    const structuralInput = input(notAFile, [dirStat("/opt")]);
    expect(classifyConsentedBinaryTrust(structuralInput, [consentFor(notAFile)])).toEqual({
      reason: checkCodexBinaryTrust(structuralInput),
      consentable: false,
      staleConsent: false,
    });

    // (b) third-party-owned file.
    const ownedFile = fingerprintedFileStat("/opt/codex", { uid: 777 });
    const ownedInput = input(ownedFile, [dirStat("/opt")]);
    const ownedResult = classifyConsentedBinaryTrust(ownedInput, [consentFor(ownedFile)]);
    expect(ownedResult?.consentable).toBe(false);

    // (c) self-owned dir-shape refusal, no records.
    const file = fingerprintedFileStat("/opt/codex");
    const dirRefusalInput = input(file, [dirStat("/opt", { mode: 0o777 })]);
    expect(classifyConsentedBinaryTrust(dirRefusalInput, [])).toEqual({
      reason: checkCodexBinaryTrust(dirRefusalInput),
      consentable: true,
      staleConsent: false,
    });

    // (d) a record whose path matches but fingerprint drifted (mtimeMs+1).
    const goodConsent = consentFor(file);
    const drifted: BinaryTrustConsent = {
      ...goodConsent,
      fingerprint: { ...goodConsent.fingerprint, mtimeMs: goodConsent.fingerprint.mtimeMs + 1 },
    };
    expect(classifyConsentedBinaryTrust(dirRefusalInput, [drifted])).toEqual({
      reason: checkCodexBinaryTrust(dirRefusalInput),
      consentable: true,
      staleConsent: true,
    });

    // (e) matching record.
    expect(classifyConsentedBinaryTrust(dirRefusalInput, [goodConsent])).toBeNull();

    // (f) record for a sibling path.
    const siblingConsent = consentFor(file, { path: "/opt/claude" });
    expect(classifyConsentedBinaryTrust(dirRefusalInput, [siblingConsent])).toEqual({
      reason: checkCodexBinaryTrust(dirRefusalInput),
      consentable: true,
      staleConsent: false,
    });
  });

  it("BT11 root-owned file (uid 0) with a dir-shape refusal + matching consent stays consentable (RES-2 boundary)", () => {
    const rootFile = fingerprintedFileStat("/opt/codex", { uid: 0 });
    const rootInput = input(rootFile, [dirStat("/opt", { mode: 0o777 })]);
    expect(classifyConsentedBinaryTrust(rootInput, [consentFor(rootFile)])).toBeNull();
  });
});

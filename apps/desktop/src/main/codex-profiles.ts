/**
 * Codex account-profile registry + CODEX_HOME resolution (codex-profiles cut
 * §2, amended §A1/§A2, TASK.50). A profile is an isolated
 * `CODEX_HOME = ~/.anycode/codex/profile-<id>/` (mode 0700) that AnyCode
 * itself sets on every spawn (doctor / login / app-server resolve), so the
 * account a session runs under is a per-tab choice, not a machine-global one.
 *
 * Profile shapes (mutually exclusive by construction, zod-enforced too):
 *  - plain           — our own empty home; codex populates it at first login.
 *  - authLink        — our own home whose `auth.json` is a SYMLINK to an
 *                      external credential (v1: `~/.codex/auth.json`). Only
 *                      the credential is shared — the home stays self-
 *                      sufficient (amended §A2: NO config.toml/skills/rules
 *                      symlinks, nothing else is created).
 *  - linkedHome      — the entire CODEX_HOME is an external directory
 *                      (cx-parity). We create/fix NOTHING inside it, ever.
 *  - system (pseudo) — always exists, never persisted, never deletable.
 *                      CODEX_HOME is NOT set at all: env inheritance,
 *                      byte-for-byte today's behavior.
 *
 * CUSTODY: this module never reads, copies, logs, or deletes credential
 * CONTENT. The auth.json guard below uses lstat/readlink ONLY (amended §A1.2
 * — "содержимое auth.json не читается никогда, ни в одной ветке"), symlinks
 * are created in OUR home pointing OUT at the owner's file, and `~/.codex`
 * itself is never written — not one byte.
 */
import { chmodSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CodexProfileRecord } from "../shared/settings.js";
import { checkCodexHomePathTrust, type CodexHomeFs } from "./codex-home-trust.js";

/** The pseudo-profile id. Reserved: never mintable, never deletable, never persisted as a record. */
export const SYSTEM_PROFILE_ID = "system";

/** Registry cap (cut §4.3): the doctor runs sequentially per profile, so the list is deliberately small. */
export const MAX_CODEX_PROFILES = 8;

/** Strict id charset (cut §2.6.1) — an id is NEVER a path; the home path is derived, not stored. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidCodexProfileId(id: string): boolean {
  return PROFILE_ID_PATTERN.test(id);
}

/** `~/.anycode/codex` — the root every derived profile home is contained in. */
export function codexProfilesRoot(home: string = homedir()): string {
  return join(home, ".anycode", "codex");
}

/**
 * Derives the profile's own CODEX_HOME strictly under `~/.anycode/codex/`.
 * Throws on an invalid id: the charset gate IS the path-traversal gate — a
 * validated id cannot contain a separator or a `..` component by construction.
 */
export function codexProfileHome(id: string, home: string = homedir()): string {
  if (!isValidCodexProfileId(id)) {
    throw new Error(`invalid codex profile id: ${JSON.stringify(id)}`);
  }
  return join(codexProfilesRoot(home), `profile-${id}`);
}

/**
 * Expands a persisted profile path — `authLink` AND `linkedHome` (amended
 * §A1.1.4, extended to `linkedHome` by the C0 review F1 ruling): the `~/`
 * form expands against the user home; the result must be absolute, anything
 * else is a broken record. Returns `null` on refusal. This is the SINGLE
 * expansion point for both fields — the schema admits exactly the shapes
 * this function accepts.
 */
export function expandAuthLink(raw: string, home: string = homedir()): string | null {
  if (raw === "") return null;
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : null;
}

/**
 * A profile resolved to its spawn-time facts. `codexHome === undefined` is
 * the system pseudo-profile: no CODEX_HOME injection at all.
 */
export interface ResolvedCodexProfile {
  id: string;
  /** Absolute CODEX_HOME to inject; absent = system (inherit the ambient env untouched). */
  codexHome?: string;
  /** Expanded absolute symlink target — presence means the §A1.2 guard must assert `<home>/auth.json`. */
  authLink?: string;
  /** true when `codexHome` is an external linkedHome we never create or repair anything in. */
  linked: boolean;
}

/** The always-present pseudo-profile (cut §2.2): resolves to "inject nothing". */
export const SYSTEM_CODEX_PROFILE: ResolvedCodexProfile = { id: SYSTEM_PROFILE_ID, linked: false };

export type CodexProfileResolution = { ok: true; profile: ResolvedCodexProfile } | { ok: false; reason: string };

/**
 * Resolves a persisted record to spawn-time facts. Re-validates everything the
 * zod boundary already enforces (id charset, authLink ⊕ linkedHome, absolute
 * paths) — defense in depth: main never trusts that a record reaching it here
 * came through the schema.
 */
export function resolveCodexProfile(record: CodexProfileRecord, home: string = homedir()): CodexProfileResolution {
  if (!isValidCodexProfileId(record.id) || record.id === SYSTEM_PROFILE_ID) {
    return { ok: false, reason: `invalid codex profile id: ${JSON.stringify(record.id)}` };
  }
  if (record.authLink !== undefined && record.linkedHome !== undefined) {
    return { ok: false, reason: `profile "${record.id}": authLink and linkedHome are mutually exclusive` };
  }
  if (record.linkedHome !== undefined) {
    const linkedHome = expandAuthLink(record.linkedHome, home);
    if (linkedHome === null) {
      return { ok: false, reason: `profile "${record.id}": linkedHome must expand to an absolute path` };
    }
    return { ok: true, profile: { id: record.id, codexHome: linkedHome, linked: true } };
  }
  const codexHome = codexProfileHome(record.id, home);
  if (record.authLink !== undefined) {
    const target = expandAuthLink(record.authLink, home);
    if (target === null) {
      return { ok: false, reason: `profile "${record.id}": authLink must expand to an absolute path` };
    }
    return { ok: true, profile: { id: record.id, codexHome, authLink: target, linked: false } };
  }
  return { ok: true, profile: { id: record.id, codexHome, linked: false } };
}

/**
 * Injects the profile's CODEX_HOME into an already-allowlisted child env
 * (cut §2.6.2): a selected profile OVERWRITES any ambient CODEX_HOME —
 * otherwise a developer-shell env would silently hijack a foreign account
 * into the session. The system pseudo-profile returns the env UNTOUCHED
 * (same object): inheritance, byte-for-byte today's behavior (§2.6.3).
 */
export function applyCodexProfileEnv(env: NodeJS.ProcessEnv, profile: ResolvedCodexProfile | undefined): NodeJS.ProcessEnv {
  if (profile?.codexHome === undefined) return env;
  return { ...env, CODEX_HOME: profile.codexHome };
}

/**
 * The argv seam main/tabs.ts hands the host per tab (cut §3.3, amended
 * §A1.2): the host receives the profile ID and derives our own home path
 * itself (path-containment on its side); `--codex-home` carries a linkedHome
 * (already validated absolute), `--codex-auth-link` the expanded guard
 * target. System emits nothing — zero argv delta, zero behavior delta.
 */
export function codexProfileArgs(profile: ResolvedCodexProfile): string[] {
  if (profile.codexHome === undefined) return [];
  const args = ["--codex-profile", profile.id];
  if (profile.linked) {
    args.push("--codex-home", profile.codexHome);
  }
  if (profile.authLink !== undefined) {
    args.push("--codex-auth-link", profile.authLink);
  }
  return args;
}

export type CodexProfileGuardResult = { ok: true } | { ok: false; reason: string };

/** Filesystem seam of the guard/registry — real `node:fs` in production, a tmp tree in tests. */
export interface CodexProfileFs extends CodexHomeFs {
  mkdir(path: string, options: { recursive: boolean; mode: number }): void;
  readlink(path: string): string;
  symlink(target: string, path: string): void;
  rm(path: string, options: { recursive?: boolean; force?: boolean }): void;
}

const nodeProfileFs: CodexProfileFs = {
  lstat(path) {
    return lstatSync(path);
  },
  stat(path) {
    return statSync(path);
  },
  realpath(path) {
    return realpathSync(path);
  },
  chmod(path, mode) {
    chmodSync(path, mode);
  },
  mkdir(path, options) {
    mkdirSync(path, options);
  },
  readlink(path) {
    return readlinkSync(path);
  },
  symlink(target, path) {
    symlinkSync(target, path);
  },
  rm(path, options) {
    rmSync(path, options);
  },
};

export interface AssertCodexProfileHomeOptions {
  fs?: CodexProfileFs;
  platform?: NodeJS.Platform;
  uid?: number;
}

/**
 * The §A1.2 lstat-guard over `<home>/auth.json`, table row by row. lstat +
 * readlink ONLY — credential content is never opened on any branch.
 */
function assertAuthLink(homeDir: string, target: string, fs: CodexProfileFs): CodexProfileGuardResult {
  const linkPath = join(homeDir, "auth.json");
  let entry: ReturnType<CodexProfileFs["lstat"]>;
  try {
    entry = fs.lstat(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A non-ENOENT lstat failure (e.g. EACCES) is not the "nothing there
      // yet" case row 1 covers — treating it as such would silently recreate
      // a link over a path we can't actually see. Fail-closed instead.
      return {
        ok: false,
        reason: `failed to stat the auth.json link: ${(error as NodeJS.ErrnoException).code ?? "unknown"} ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Row 1 — ENOENT: idempotent re-assert recreates the link. A dangling
    // TARGET is not our concern (codex itself will report signed_out).
    try {
      fs.symlink(target, linkPath);
      return { ok: true };
    } catch (symlinkError) {
      return { ok: false, reason: `failed to create the auth.json link: ${symlinkError instanceof Error ? symlinkError.message : String(symlinkError)}` };
    }
  }
  if (entry.isSymbolicLink()) {
    let actual: string;
    try {
      actual = fs.readlink(linkPath);
    } catch (error) {
      return { ok: false, reason: `failed to read the auth.json link: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Row 2 — the expected link: spawn allowed.
    if (actual === target) return { ok: true };
    // Row 3 — a REDIRECTED symlink inside a 0700 home is interference; fixing
    // it silently would hide it. Repair happens only via the explicit UI
    // action (`repairCodexAuthLink`), never here.
    return {
      ok: false,
      reason: `auth.json in the profile home points at an unexpected target (${actual}); use "Re-link credential" to repair it explicitly`,
    };
  }
  if (!entry.isDirectory() && !entry.isSymbolicLink()) {
    // Row 4 — a regular file (or any non-dir leaf): a detached credential
    // copy. It may hold tokens FRESHER than the owner's (codex refreshes via
    // tmp+rename, which severs a symlink), so auto-deleting it is forbidden.
    return {
      ok: false,
      reason: `a detached copy of the credential appeared in the profile home (auth.json is a regular file, not the expected link); use "Re-link credential" to replace it explicitly`,
    };
  }
  // Row 5 — a directory/fifo/anything else: never legitimate.
  return { ok: false, reason: "auth.json in the profile home is not a file or symlink" };
}

export interface CodexProfileHomePreflightOptions extends AssertCodexProfileHomeOptions {
  /** Skips the §A1.2 auth.json assert — for a caller (repairLink) that is about to fix that very link itself. */
  skipAuthLinkAssert?: boolean;
}

/**
 * The reusable home pre-flight shared by `assertCodexProfileHome` and the
 * explicit repair action (H3): creates a missing own home (mode 0700), then
 * runs the §2.5 trust policy. Neither `assertCodexProfileHome` callers nor
 * `repairLink` may touch `auth.json` on a home that fails this — trust is
 * checked BEFORE any credential-link mutation, not after.
 */
function preflightCodexProfileHome(
  profile: ResolvedCodexProfile,
  options: CodexProfileHomePreflightOptions = {},
): CodexProfileGuardResult {
  if (profile.codexHome === undefined) return { ok: true };
  const fs = options.fs ?? nodeProfileFs;

  if (!profile.linked) {
    try {
      // `recursive` also creates `~/.anycode/codex` on a fresh machine; mode
      // applies to every directory created here.
      fs.mkdir(profile.codexHome, { recursive: true, mode: 0o700 });
    } catch (error) {
      return { ok: false, reason: `failed to create the profile home: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const untrusted = checkCodexHomePathTrust(profile.codexHome, {
    owned: !profile.linked,
    fs,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
  });
  if (untrusted !== null) {
    return { ok: false, reason: untrusted };
  }

  if (!options.skipAuthLinkAssert && profile.authLink !== undefined) {
    return assertAuthLink(profile.codexHome, profile.authLink, fs);
  }
  return { ok: true };
}

/**
 * Idempotent pre-spawn re-assert of a profile home (amended §A2): the home
 * exists (recreated if deleted), is mode 0700 (chmod'ed when ours), passes
 * the §2.5 trust policy, and its auth.json link matches the §A1.2 table.
 * Runs before EVERY doctor/login/app-server spawn, same TOCTOU narrative as
 * the binary trust gate. For a linkedHome: nothing is created or repaired —
 * diagnose and refuse only. For system: a no-op by definition.
 *
 * Fail-closed: `{ok:false}` means status `error` and NO spawn.
 */
export function assertCodexProfileHome(
  profile: ResolvedCodexProfile,
  options: AssertCodexProfileHomeOptions = {},
): CodexProfileGuardResult {
  return preflightCodexProfileHome(profile, options);
}

/**
 * The explicit "Re-link credential" action behind its own IPC handle — the
 * ONLY place a wrong auth.json entry is removed and re-linked. Removes the
 * ENTRY at `<home>/auth.json` (lstat semantics — a symlink's target is never
 * followed, a detached file's content is never read) and recreates the link.
 */
export function repairCodexAuthLink(profile: ResolvedCodexProfile, fs: CodexProfileFs = nodeProfileFs): CodexProfileGuardResult {
  if (profile.codexHome === undefined || profile.authLink === undefined || profile.linked) {
    return { ok: false, reason: "profile has no auth link to repair" };
  }
  const linkPath = join(profile.codexHome, "auth.json");
  try {
    fs.rm(linkPath, { force: true });
    fs.symlink(profile.authLink, linkPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `failed to re-link the credential: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── settings-backed registry ──

/** The persisted `settings.codex` slice the registry reads/writes (through the C0 settings contract, never directly). */
export interface CodexProfilesSettingsSlice {
  profiles?: CodexProfileRecord[];
  activeProfileId?: string;
}

export interface CodexProfilesRegistryDeps {
  /** Fresh read of `settings.codex` (main is the sole writer; never cached here). */
  readCodex: () => Promise<CodexProfilesSettingsSlice | undefined>;
  /** Persists a partial `settings.codex` patch through the settings-set pipeline (arrays replace wholesale). */
  writeCodex: (patch: CodexProfilesSettingsSlice) => Promise<unknown>;
  /** User home the profile tree lives under; tests point this at a tmp dir. */
  home?: string;
  fs?: CodexProfileFs;
  platform?: NodeJS.Platform;
  uid?: number;
  now?: () => Date;
}

export interface CodexProfileCreateRequest {
  label: string;
  authLink?: string;
  linkedHome?: string;
}

export type CodexProfileCreateResult =
  | { ok: true; profile: CodexProfileRecord }
  | { ok: false; reason: "invalid" | "limit" | "failed"; message?: string };

export interface CodexProfilesList {
  profiles: CodexProfileRecord[];
  activeProfileId: string;
}

export interface CodexProfilesRegistry {
  list(): Promise<CodexProfilesList>;
  create(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult>;
  remove(id: string): Promise<CodexProfileGuardResult>;
  setActive(id: string): Promise<CodexProfileGuardResult>;
  /** Resolves an id (or the active default when `undefined`) to spawn-time facts. `"system"` and an empty registry both resolve to the pseudo-profile. */
  resolve(id: string | undefined): Promise<CodexProfileResolution>;
  repairLink(id: string): Promise<CodexProfileGuardResult>;
  setLastCheck(id: string, lastCheck: NonNullable<CodexProfileRecord["lastCheck"]>): Promise<void>;
}

/** Slug an id out of a human label: strict charset, `system` bumped away from the reserved id, numeric-suffix dedup. */
function mintProfileId(label: string, taken: ReadonlySet<string>): string {
  let slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (!isValidCodexProfileId(slug)) slug = "profile";
  const base = slug.slice(0, 28); // room for a "-NN" suffix inside the 32-char cap
  let candidate = slug;
  for (let suffix = 2; taken.has(candidate) || candidate === SYSTEM_PROFILE_ID; suffix++) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export function createCodexProfilesRegistry(deps: CodexProfilesRegistryDeps): CodexProfilesRegistry {
  const home = deps.home ?? homedir();
  const fs = deps.fs ?? nodeProfileFs;
  const guardOptions: AssertCodexProfileHomeOptions = {
    fs,
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
  };

  async function readSlice(): Promise<CodexProfilesSettingsSlice> {
    return (await deps.readCodex()) ?? {};
  }

  async function findRecord(id: string): Promise<CodexProfileRecord | undefined> {
    const slice = await readSlice();
    return slice.profiles?.find((profile) => profile.id === id);
  }

  return {
    async list(): Promise<CodexProfilesList> {
      const slice = await readSlice();
      return { profiles: slice.profiles ?? [], activeProfileId: slice.activeProfileId ?? SYSTEM_PROFILE_ID };
    },

    async create(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult> {
      if (request.authLink !== undefined && request.linkedHome !== undefined) {
        return { ok: false, reason: "invalid", message: "authLink and linkedHome are mutually exclusive" };
      }
      if (request.linkedHome !== undefined && expandAuthLink(request.linkedHome, home) === null) {
        return { ok: false, reason: "invalid", message: "linkedHome must expand to an absolute path" };
      }
      if (request.authLink !== undefined && expandAuthLink(request.authLink, home) === null) {
        return { ok: false, reason: "invalid", message: "authLink must expand to an absolute path" };
      }
      const slice = await readSlice();
      const existing = slice.profiles ?? [];
      if (existing.length >= MAX_CODEX_PROFILES) {
        return { ok: false, reason: "limit", message: `at most ${MAX_CODEX_PROFILES} profiles are supported` };
      }
      const id = mintProfileId(request.label, new Set(existing.map((profile) => profile.id)));
      const record: CodexProfileRecord = {
        id,
        label: request.label,
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
        ...(request.linkedHome !== undefined ? { linkedHome: request.linkedHome } : {}),
        ...(request.authLink !== undefined ? { authLink: request.authLink } : {}),
      };
      const resolution = resolveCodexProfile(record, home);
      if (!resolution.ok) {
        return { ok: false, reason: "invalid", message: resolution.reason };
      }
      const asserted = assertCodexProfileHome(resolution.profile, guardOptions);
      if (!asserted.ok) {
        return { ok: false, reason: "failed", message: asserted.reason };
      }
      try {
        await deps.writeCodex({ profiles: [...existing, record] });
      } catch (error) {
        return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, profile: record };
    },

    async remove(id: string): Promise<CodexProfileGuardResult> {
      if (id === SYSTEM_PROFILE_ID) {
        return { ok: false, reason: "the system profile cannot be removed" };
      }
      const slice = await readSlice();
      const record = slice.profiles?.find((profile) => profile.id === id);
      if (record === undefined) {
        return { ok: false, reason: `unknown codex profile: ${JSON.stringify(id)}` };
      }
      // Only OUR OWN derived home is ever deleted — recomputed from the
      // validated id, never a stored path; a linkedHome is external and is
      // never touched. rm unlinks entries (an auth.json SYMLINK dies as a
      // link — its target credential is never followed or deleted).
      if (record.linkedHome === undefined) {
        try {
          fs.rm(codexProfileHome(id, home), { recursive: true, force: true });
        } catch (error) {
          return { ok: false, reason: `failed to remove the profile home: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const remaining = (slice.profiles ?? []).filter((profile) => profile.id !== id);
      const patch: CodexProfilesSettingsSlice = { profiles: remaining };
      if (slice.activeProfileId === id) {
        patch.activeProfileId = SYSTEM_PROFILE_ID;
      }
      await deps.writeCodex(patch);
      return { ok: true };
    },

    async setActive(id: string): Promise<CodexProfileGuardResult> {
      if (id !== SYSTEM_PROFILE_ID) {
        const record = await findRecord(id);
        if (record === undefined) {
          return { ok: false, reason: `unknown codex profile: ${JSON.stringify(id)}` };
        }
      }
      await deps.writeCodex({ activeProfileId: id });
      return { ok: true };
    },

    async resolve(id: string | undefined): Promise<CodexProfileResolution> {
      const slice = await readSlice();
      const wanted = id ?? slice.activeProfileId ?? SYSTEM_PROFILE_ID;
      if (wanted === SYSTEM_PROFILE_ID) {
        return { ok: true, profile: SYSTEM_CODEX_PROFILE };
      }
      const record = slice.profiles?.find((profile) => profile.id === wanted);
      if (record === undefined) {
        return { ok: false, reason: `unknown codex profile: ${JSON.stringify(wanted)}` };
      }
      return resolveCodexProfile(record, home);
    },

    async repairLink(id: string): Promise<CodexProfileGuardResult> {
      const record = await findRecord(id);
      if (record === undefined) {
        return { ok: false, reason: `unknown codex profile: ${JSON.stringify(id)}` };
      }
      const resolution = resolveCodexProfile(record, home);
      if (!resolution.ok) {
        return { ok: false, reason: resolution.reason };
      }
      // H3: the same trust gate every spawn re-asserts, run BEFORE the
      // repair mutates auth.json — a home that fails trust gets no rm/symlink
      // at all, not even the "explicit user action" one. The §A1.2 assert
      // itself is skipped here: it would refuse the very state repair exists
      // to fix.
      const preflight = preflightCodexProfileHome(resolution.profile, { ...guardOptions, skipAuthLinkAssert: true });
      if (!preflight.ok) {
        return preflight;
      }
      return repairCodexAuthLink(resolution.profile, fs);
    },

    async setLastCheck(id: string, lastCheck: NonNullable<CodexProfileRecord["lastCheck"]>): Promise<void> {
      const slice = await readSlice();
      const profiles = slice.profiles ?? [];
      if (!profiles.some((profile) => profile.id === id)) return;
      await deps.writeCodex({
        profiles: profiles.map((profile) => (profile.id === id ? { ...profile, lastCheck } : profile)),
      });
    },
  };
}

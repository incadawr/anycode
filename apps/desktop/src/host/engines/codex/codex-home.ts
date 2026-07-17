/**
 * Profile CODEX_HOME resolution for the host's app-server spawn (codex-profiles
 * cut §2.6, amendment §A1.2/§A2, TASK.50).
 *
 * Main resolves a renderer-picked profile id against ITS registry and hands the
 * host READY argv values (`--codex-profile` / `--codex-home` /
 * `--codex-auth-link`, frozen in C0). This module re-derives and re-validates
 * them host-side, fail-CLOSED: any malformed value refuses the spawn — a
 * silent fallback would run the session on the AMBIENT account, which is
 * precisely the hijack cut §2.6.2 exists to prevent.
 *
 * Custody invariants honoured throughout:
 *  - a profile id is an ID, never a path (strict charset, containment check);
 *  - `auth.json` is guarded with lstat/readlink ONLY — its content is never
 *    read, logged, or echoed into a diagnostic;
 *  - a `linkedHome` (external, cx-parity) is only diagnosed, never created,
 *    chmodded, or otherwise mutated — we do not write into foreign trees.
 *
 * The registry-level trust policy (world-writable ancestors, foreign uid —
 * cut §2.5) runs in main before the profile ever reaches argv (lane A); this
 * module is the host's own per-spawn re-assert of the parts the host can and
 * must check: home shape/mode and the auth-link intent. Deliberately LOCAL to
 * the host (no import from main/**, the same boundary rule as
 * checkCodexBinaryTrustOnDisk above it in app-server-client.ts).
 */

import { chmodSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Cut §2.6.1 charset — the SAME rule the C0 settings schema enforces on registry writes. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Raw, unvalidated profile argv (`--codex-profile` / `--codex-home` / `--codex-auth-link`). */
export interface CodexProfileArgs {
  profileId?: string;
  linkedHome?: string;
  authLink?: string;
}

/** A validated spawn target: WHICH directory becomes CODEX_HOME and how it is treated. */
export interface ResolvedCodexProfile {
  home: string;
  /** "managed" = our `~/.anycode/codex/profile-<id>` tree (created/tightened); "linked" = external, diagnose-only. */
  kind: "managed" | "linked";
  /** Expanded absolute target of `<home>/auth.json` (managed profiles only, amendment §A1.1). */
  authLink?: string;
}

/** Supports both `--flag value` and `--flag=value`, matching parseHostArgs'/draft-args' shape. */
function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Extraction only — no validation, no interpretation. Unlike draft-args.ts
 * (where junk degrades to "no draft choice"), a malformed profile value must
 * surface: it is validated (and thrown on) in `resolveCodexProfile`.
 */
export function parseCodexProfileArgs(argv: readonly string[]): CodexProfileArgs {
  const profileId = readFlag(argv, "--codex-profile");
  const linkedHome = readFlag(argv, "--codex-home");
  const authLink = readFlag(argv, "--codex-auth-link");
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(linkedHome !== undefined ? { linkedHome } : {}),
    ...(authLink !== undefined ? { authLink } : {}),
  };
}

/**
 * Validates the profile argv into a spawn target, or null for the `system`
 * pseudo-profile (no flags): there the env builder is not touched at all and
 * behaviour stays byte-identical to the pre-profiles build (cut §2.6.3).
 * Throws on ANY malformed value — boot fails visibly instead of running on
 * the wrong account.
 */
export function resolveCodexProfile(args: CodexProfileArgs, homeDir: string = homedir()): ResolvedCodexProfile | null {
  const { profileId, linkedHome, authLink } = args;
  if (profileId === undefined && linkedHome === undefined && authLink === undefined) return null;
  if (linkedHome !== undefined && authLink !== undefined) {
    // Amendment §A1.1.3: a linked home is ENTIRELY foreign — there is nowhere
    // (and no right) to plant a symlink in it.
    throw new Error("--codex-home and --codex-auth-link are mutually exclusive");
  }
  if (linkedHome !== undefined) {
    if (!isAbsolute(linkedHome)) throw new Error("--codex-home must be an absolute path");
    return { kind: "linked", home: linkedHome };
  }
  if (profileId === undefined) {
    throw new Error("--codex-auth-link requires --codex-profile (it names a file inside the managed profile home)");
  }
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`invalid Codex profile id ${JSON.stringify(profileId)}`);
  }
  const base = join(homeDir, ".anycode", "codex");
  const home = join(base, `profile-${profileId}`);
  // Belt-and-braces containment (cut §2.6.1): the charset above already makes
  // traversal impossible, but the derived path is proven to sit under the
  // managed base regardless — a future charset relaxation cannot silently
  // reopen the escape.
  const rel = relative(base, home);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Codex profile home escaped ${base}`);
  }
  if (authLink !== undefined && !isAbsolute(authLink)) {
    throw new Error("--codex-auth-link must be an absolute path (main expands ~/ before argv)");
  }
  return { kind: "managed", home, ...(authLink !== undefined ? { authLink } : {}) };
}

/**
 * Dev/automation-ONLY override for the user home the managed profile tree
 * derives from (codex-profiles W4-F0b, f0b-host-lever-ruling-fable-iter10):
 * `resolveCodexProfile` above derives `<home>/.anycode/codex/profile-<id>`
 * from the HOST process's homedir, so main's `ANYCODE_CODEX_PROFILES_HOME`
 * lever (which isolates every main-plane consumer) would otherwise be blind
 * to the one host-side derivation — a live managed-profile session would
 * still create its home + auth.json symlink in the owner's real `~`.
 *
 * The gate AUTHORITY is main: `resolveCodexProfilesHome` (main/index.ts,
 * `ANYCODE_AUTOMATION==="1" && !app.isPackaged`) vets the value, and
 * `applyCodexProfilesHomeOverride` (main/host-env.ts) structurally
 * set-or-DELETEs it in every host fork env — a packaged build NEVER sees the
 * var. This predicate is defense-in-depth, not the only gate (this process
 * has no `isPackaged` signal to re-derive main's double gate) — the same
 * trust shape as `resolveExtensionsHomeOverride` (host/dev-home.ts), with the
 * env-var literal duplicated by contract: host never imports main/**.
 *
 * Write-plane delta from that precedent: this base is where the host CREATES
 * a 0700 home and plants the auth.json symlink (`assertCodexProfileHome`
 * below), so a malformed value under automation must NOT fall back to the
 * real homedir — that silent fallback would be exactly the forbidden write
 * into the owner's real `~/.anycode/codex`, masked as a green smoke run.
 * Fail-closed instead: throw, the boot refuses visibly (the same posture as
 * malformed profile argv above).
 */
export function resolveCodexProfilesHomeOverride(env: NodeJS.ProcessEnv): string | null {
  if (env.ANYCODE_AUTOMATION !== "1") {
    return null;
  }
  const raw = env.ANYCODE_CODEX_PROFILES_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      "ANYCODE_CODEX_PROFILES_HOME is set but empty under automation; refusing to boot instead of falling back to the real home",
    );
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `ANYCODE_CODEX_PROFILES_HOME must be an absolute path under automation, got ${JSON.stringify(trimmed)}; refusing to boot instead of falling back to the real home`,
    );
  }
  return trimmed;
}

/**
 * Idempotent per-spawn re-assert of the profile home (amendment §A2) plus the
 * auth-link lstat guard (amendment §A1.2). Returns null when the spawn may
 * proceed, or a human-readable diagnostic that REFUSES it (fail-closed).
 * Called immediately before EACH spawn via AppServerClient's `homeTrust` seam
 * — the same TOCTOU narrative as the binary trust gate.
 */
export function assertCodexProfileHome(profile: ResolvedCodexProfile): string | null {
  const homeState = lstatSync(profile.home, { throwIfNoEntry: false });
  if (profile.kind === "linked") {
    // Foreign directory: diagnose only, never create/chmod/fix (cut §2.2).
    if (homeState === undefined) return `linked Codex home does not exist: ${profile.home}`;
    if (!homeState.isDirectory()) return `linked Codex home is not a directory: ${profile.home}`;
    return null;
  }
  if (homeState !== undefined && homeState.isSymbolicLink()) {
    // Our managed path replaced by a symlink = redirection of the credential
    // store; following it would hand auth.json custody to the link's owner.
    return `Codex profile home is a symlink (expected a directory we own): ${profile.home}`;
  }
  if (homeState === undefined) {
    mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  } else if (!homeState.isDirectory()) {
    return `Codex profile home is not a directory: ${profile.home}`;
  } else if ((homeState.mode & 0o077) !== 0 && process.platform !== "win32") {
    // Ours ⇒ we fix and continue (cut §2.5); a linked home would be refused instead.
    chmodSync(profile.home, 0o700);
  }
  if (profile.authLink !== undefined) {
    return assertAuthLink(profile.home, profile.authLink);
  }
  return null;
}

/**
 * The §A1.2 decision table, verbatim. lstat/readlink ONLY — the content of
 * auth.json is never read in any branch (custody invariant: AnyCode never
 * touches a raw credential), and no diagnostic ever embeds file content.
 */
function assertAuthLink(home: string, target: string): string | null {
  const linkPath = join(home, "auth.json");
  const state = lstatSync(linkPath, { throwIfNoEntry: false });
  if (state === undefined) {
    // Idempotent re-assert: the link vanished ⇒ recreate. A dangling TARGET is
    // not our concern — codex itself will report signed_out.
    symlinkSync(target, linkPath);
    return null;
  }
  if (state.isSymbolicLink()) {
    if (readlinkSync(linkPath) === target) return null;
    // A redirected symlink inside a 0700 home is evidence of interference;
    // repairing it silently would HIDE that. Repair is an explicit UI action.
    return `auth.json in ${home} is a symlink with a different target than the profile records; refusing to spawn (repair it from Settings → Codex)`;
  }
  if (state.isFile()) {
    // codex can refresh tokens via tmp+rename, silently detaching the link —
    // this file may hold tokens FRESHER than the owner's copy. Auto-deleting
    // it is forbidden; only the explicit "recreate link" UI action may.
    return `a detached credential copy appeared at ${linkPath} where the auth.json symlink should be; refusing to spawn (recreate the link from Settings → Codex)`;
  }
  return `${linkPath} is neither a symlink nor absent; refusing to spawn`;
}

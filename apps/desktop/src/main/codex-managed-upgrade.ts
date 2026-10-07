/**
 * Managed-Codex upgrade path (TASK.237): when a previously installed MANAGED
 * Codex CLI (AnyCode's own `~/.anycode/codex/bin/<version>/…`, recorded in
 * `settings.codex.binaryPath`) is older than the manifest's `recommended`
 * version, an app upgrade must move the user to a manifest-supported version
 * instead of leaving them on the old tree.
 *
 * The incident: a user upgraded AnyCode to 0.0.30 with
 * `settings.codex.binaryPath` pointing at managed 0.144.3. 0.144.3 is still
 * INSIDE the supported range (`>=0.144.0 <0.161.0`), so every existing
 * surface — the doctor verdict, the discovery ladder's `installed` rung, the
 * explicit installer's default — was content with it. The old CLI's
 * model/list returned only the 5.5/5.6 family while the shipped 0.160.0
 * offered the current catalog: the user never saw the new models.
 *
 * IDENTITY (who is "managed"): ONLY the persisted `settings.codex.binaryPath`
 * counts, resolved against `~/.anycode/codex/bin/` — the exact shape
 * `installCodexVersion` writes and nothing else. An explicitly chosen
 * external binary (homebrew, npm-global, a picked path) is NEVER migrated:
 * the discovery ladder already keeps it authoritative (the `settings` rung
 * wins over every ambient rung), so replacing it would override an explicit
 * user choice. A `binaryPath` outside our bin tree is left byte-untouched.
 *
 * ORDERING: strictly an upgrade. `recommended` <= current is a no-op (the
 * user may be pinned deliberately or via risk acceptance); there is no
 * downgrade path here.
 *
 * RECOVERY/ATOMICITY: reuses `installCodexVersion` verbatim — resolve ->
 * sha512-gated download -> staged extract -> atomic rename to
 * `bin/<version>/`. A failure at ANY stage leaves no partial directory and
 * the old install exactly where it was; `settings.codex.binaryPath` is only
 * repointed AFTER the post-install doctor confirms the new binary, so the
 * worst failure mode is "still on the old version, next boot retries" —
 * which is exactly what this run is. The old version tree is kept (a
 * rollback target and a working binary for any tab still referencing it),
 * matching the install controller's own refusal to delete a tree the user
 * may be running from.
 */
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import { CODEX_TRIPLE_BY_PLATFORM, codexBinaryRelPath, codexPlatformSuffix } from "../shared/codex-support.js";
import { compareCodexVersions, parseCodexSemver } from "../shared/codex-version-policy.js";
import { checkCodexBinaryPathTrust } from "./codex-binary.js";
import { runCodexDoctor, type RunCodexDoctorOptions } from "./codex-doctor.js";
import { installCodexVersion, removeCodexInstall, type CodexInstallCaps } from "./codex-install.js";
import { activeCodexVersionPolicy, codexVersionVerdict, type CodexVersionPolicy } from "./codex-manifest.js";
import { codexProfilesRoot } from "./codex-profiles.js";

// ── the pure decision (exported for tests and for a future Settings affordance) ──

export type CodexManagedUpgradePlan =
  | { action: "install"; fromVersion: string; toVersion: string; fromBinaryPath: string }
  | { action: "none"; reason: "no_settings_path" | "not_managed" | "already_current" | "recommended_unparsable" };

/**
 * Decides whether the persisted binary path names a MANAGED install that is
 * older than `policy.manifest.recommended`. Pure: no fs, no clock — the
 * caller supplies the path string and the policy snapshot.
 *
 * The version is taken from the DIRECTORY NAME (`bin/<X.Y.Z>/`), the same
 * identity `installedCodexCandidates` matches strictly — never from the
 * binary's own `--version` output (a doctor round trip this decision does
 * not need) and never from a loose substring.
 *
 * The path must be EXACTLY `<bin>/<X.Y.Z>/vendor/<triple>/bin/codex[.exe]`
 * for THIS platform's triple: a deeper or differently shaped path under the
 * bin tree (a user's own tool parked there) is not ours to replace.
 */
export function planCodexManagedUpgrade(
  settingsBinaryPath: string | undefined,
  policy: CodexVersionPolicy,
  home: string = homedir(),
  platform: string = process.platform,
  arch: string = process.arch,
): CodexManagedUpgradePlan {
  if (settingsBinaryPath === undefined || settingsBinaryPath.trim() === "") {
    return { action: "none", reason: "no_settings_path" };
  }
  const trimmed = settingsBinaryPath.trim();
  const binRoot = join(codexProfilesRoot(home), "bin");
  const rel = relative(binRoot, trimmed);
  // `relative` escapes (".." components or an absolute result on Windows
  // drives) mean the path is outside our managed tree: explicitly external,
  // never migrated. An empty result is the bin root itself — not a binary.
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`..${sep}`) || isAbsoluteLike(rel)) {
    return { action: "none", reason: "not_managed" };
  }
  const suffix = codexPlatformSuffix(platform, arch);
  const triple = suffix !== null ? CODEX_TRIPLE_BY_PLATFORM[suffix] : undefined;
  if (triple === undefined) {
    return { action: "none", reason: "not_managed" };
  }
  const segments = rel.split(sep);
  // Expected shape: `<version>/vendor/<triple>/bin/codex` — the exact layout
  // `installCodexVersion` produces via `codexBinaryRelPath`, segment for
  // segment. Shorter, deeper or foreign-triple paths are not managed.
  const expectedTail = codexBinaryRelPath(triple).split("/");
  if (segments.length !== expectedTail.length + 1 || expectedTail.some((part, i) => segments[i + 1] !== part)) {
    return { action: "none", reason: "not_managed" };
  }
  const currentVersion = segments[0]!;
  const current = parseCodexSemver(currentVersion);
  if (current === null) {
    return { action: "none", reason: "not_managed" };
  }
  const recommended = parseCodexSemver(policy.manifest.recommended);
  if (recommended === null) {
    // A validated manifest always carries a parsable recommended; this guards
    // a malformed one reaching a caller that skipped validation.
    return { action: "none", reason: "recommended_unparsable" };
  }
  if (compareCodexVersions(current, recommended) >= 0) {
    return { action: "none", reason: "already_current" };
  }
  return { action: "install", fromVersion: currentVersion, toVersion: policy.manifest.recommended, fromBinaryPath: trimmed };
}

/** `relative()` on Windows can yield a drive-absolute result when the paths share no root — that is "outside", not managed. */
function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("/");
}

// ── orchestration ──

export interface CodexManagedUpgradeDeps {
  /** User home the managed tree lives under; production = real homedir, tests = tmp. */
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  caps?: Partial<CodexInstallCaps>;
  /** Reads `settings.codex.binaryPath` fresh — main's in-memory settings closure. */
  readBinaryPathSetting: () => Promise<string | undefined>;
  /**
   * Repoints `settings.codex.binaryPath` from `expected` to `next` ONLY if it
   * still equals `expected`, compared and written inside the settings
   * mutation lock (`handleSwapCodexBinaryPath`). The download + doctor take
   * long enough for the user to pick another CLI meanwhile; an unconditional
   * write would silently override that choice. `changed` = the user moved
   * on, every other refusal is a persistence failure.
   */
  swapBinaryPath: (expected: string, next: string) => Promise<CodexBinaryPathSwapResult>;
  /**
   * The doctor source env for the post-upgrade gate (TASK.139 §2 case (e)):
   * main wires the identical `codexDoctorSourceEnv` every other main-spawned
   * probe reads through, so the gate honours `settings.codex.proxyUrl`.
   */
  doctorSourceEnv?: () => NodeJS.ProcessEnv;
  /** Fired after a successful upgrade so main pushes ENGINES_CHANGED and rechecks. */
  onChanged?: () => void;
  /** DI seams; production = the real trust gate + doctor. */
  trust?: (binaryPath: string) => string | null;
  runDoctor?: (binaryPath: string, options?: RunCodexDoctorOptions) => Promise<CodexDoctorReport>;
}

export type CodexBinaryPathSwapResult = { ok: true } | { ok: false; reason: string };

export type CodexManagedUpgradeResult =
  | { ok: true; upgraded: true; fromVersion: string; toVersion: string; binaryPath: string; report: CodexDoctorReport }
  | { ok: true; upgraded: false; reason: string }
  | { ok: false; error: string };

/**
 * One boot-time pass: plan, and if an upgrade is due, install the recommended
 * version through the SAME §7.2 pipeline the explicit installer uses, gate it
 * on trust + doctor, and only then repoint settings. Never throws; every
 * failure leaves the previous binary path in place and reports `{ok:false}`
 * so the next boot retries. Concurrent boots converge safely: the atomic
 * directory rename means the loser sees `alreadyInstalled` and reuses the
 * winner's tree.
 */
export async function runCodexManagedUpgrade(deps: CodexManagedUpgradeDeps): Promise<CodexManagedUpgradeResult> {
  try {
    return await upgradeOnce(deps);
  } catch (error) {
    // Any seam (trust, doctor, env source) that throws instead of reporting
    // still ends as an honest `{ok:false}` — settings were not touched.
    return { ok: false, error: `managed codex upgrade failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function upgradeOnce(deps: CodexManagedUpgradeDeps): Promise<CodexManagedUpgradeResult> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  let settingsPath: string | undefined;
  try {
    settingsPath = await deps.readBinaryPathSetting();
  } catch (error) {
    return {
      ok: false,
      error: `failed to read the persisted codex binary path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // The ACTIVE policy (network-refreshed manifest + persisted risk
  // acceptances) is read at run time, so a fresh manifest drives the upgrade
  // on the very boot that fetched it.
  const policy = activeCodexVersionPolicy();
  const plan = planCodexManagedUpgrade(settingsPath, policy, home, platform, deps.arch ?? process.arch);
  if (plan.action === "none") {
    return { ok: true, upgraded: false, reason: plan.reason };
  }

  // The recommended version must be installable under the CURRENT policy —
  // the manifest's own recommendation is judged like any other version, so a
  // tampered/narrowed manifest cannot push an unsupported binary.
  const verdict = codexVersionVerdict(plan.toVersion, policy);
  if (!verdict.allowed) {
    return { ok: false, error: `recommended version ${plan.toVersion} is outside the supported range (${verdict.supportedRange})` };
  }

  const installed = await installCodexVersion(plan.toVersion, {
    home,
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    ...(deps.arch !== undefined ? { arch: deps.arch } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.caps !== undefined ? { caps: deps.caps } : {}),
  });
  if (!installed.ok) {
    return { ok: false, error: `managed codex upgrade to ${plan.toVersion} failed: ${installed.error}` };
  }

  // Post-install gate, mirroring createCodexInstallController's refuse shape:
  // a FRESHLY downloaded tree that fails the gate is removed; a pre-existing
  // one (another boot won the race) is refused but left in place.
  const fresh = installed.alreadyInstalled !== true;
  const refuse = (error: string): CodexManagedUpgradeResult => {
    if (fresh) removeCodexInstall(installed.installDir);
    return { ok: false, error };
  };
  const trust = deps.trust ?? ((binaryPath: string) => checkCodexBinaryPathTrust(binaryPath, undefined, platform));
  const untrusted = trust(installed.binaryPath);
  if (untrusted !== null) return refuse(untrusted);
  const runDoctor = deps.runDoctor ?? runCodexDoctor;
  const doctorEnv = deps.doctorSourceEnv?.();
  const report = await runDoctor(installed.binaryPath, doctorEnv !== undefined ? { env: doctorEnv } : undefined);
  if (report.status === "error" || report.status === "update_required" || report.status === "not_installed") {
    return refuse(`upgraded binary failed its doctor pass (${report.status}: ${report.error ?? "no detail"})`);
  }

  // The new tree is installed and healthy. If settings do not take it
  // (read_only file, invalid merge, disk error) the app stays on the old path
  // this boot and the next boot re-plans off the still-old settings. The
  // installed tree is kept either way: it is a valid install, not debris.
  let swapped: CodexBinaryPathSwapResult;
  try {
    swapped = await deps.swapBinaryPath(plan.fromBinaryPath, installed.binaryPath);
  } catch (error) {
    swapped = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!swapped.ok) {
    if (swapped.reason === "changed") {
      return { ok: true, upgraded: false, reason: "selection_changed" };
    }
    return { ok: false, error: `upgrade installed ${plan.toVersion} but persisting the binary path failed: ${swapped.reason}` };
  }
  try {
    deps.onChanged?.();
  } catch {
    // The path is persisted; a failed notification only delays the UI
    // refresh to the next recheck — it does not undo the upgrade.
  }
  return {
    ok: true,
    upgraded: true,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    binaryPath: installed.binaryPath,
    report,
  };
}

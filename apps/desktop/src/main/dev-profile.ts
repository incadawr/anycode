/**
 * Dev-only Electron `userData` isolation gate for the automation smoke
 * channel (design/slice-P7.H-cut.md §4.1). Pure and unit-testable — no
 * Electron import here, so `main/index.ts` can apply the result at module
 * top level (before `app.whenReady()`, which is the only time Electron
 * accepts a `userData` repoint) without pulling Electron into this module's
 * test surface.
 */

import { isAbsolute } from "node:path";

const ENV_AUTOMATION = "ANYCODE_AUTOMATION";
const ENV_USER_DATA_DIR = "ANYCODE_USER_DATA_DIR";
const ENV_SETTINGS_PATH = "ANYCODE_SETTINGS_PATH";
const ENV_SECRETS_PATH = "ANYCODE_SECRETS_PATH";
const ENV_MCP_IMPORT_HOME = "ANYCODE_MCP_IMPORT_HOME";

/**
 * Returns the absolute directory to redirect Electron's `userData` to iff
 * ALL hold, else `null`:
 *  - `isPackaged === false` — a packaged build NEVER honors the var
 *    (fail-closed: this lever exists for the dev smoke channel only);
 *  - `env.ANYCODE_AUTOMATION === "1"` — the same double gate the automation
 *    server itself uses, so a plain dev run (automation off) keeps its
 *    normal profile continuity;
 *  - `env.ANYCODE_USER_DATA_DIR` is a non-empty, absolute path — a relative
 *    path is refused (it would be cwd-dependent, defeating reproducibility).
 * Never throws: the app must boot regardless of a malformed/refused override.
 */
export function resolveUserDataOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (env[ENV_AUTOMATION] !== "1") {
    return null;
  }
  const raw = env[ENV_USER_DATA_DIR];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (isPackaged) {
    return null;
  }
  if (!isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * True iff `ANYCODE_USER_DATA_DIR` was supplied (non-empty) alongside the
 * automation gate but `resolveUserDataOverride` refused it (packaged build or
 * a relative path) — the two "set but refused" cases the caller logs exactly
 * one `console.warn` for (design §4.1). Automation off, or the var simply
 * unset/empty, is a quiet no-op and does NOT count as refused.
 */
export function isRefusedUserDataOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  if (env[ENV_AUTOMATION] !== "1") {
    return false;
  }
  const raw = env[ENV_USER_DATA_DIR];
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  return resolveUserDataOverride(env, isPackaged) === null;
}

/**
 * Shared gate for the dev-only settings.json/secrets.json path overrides
 * (design/slice-P7.15-cut.md §2.6): the same double gate as
 * `resolveUserDataOverride` (`ANYCODE_AUTOMATION==="1" && !isPackaged`), plus a
 * non-empty absolute path in `varName`. Never throws — callers fall back to
 * the production default path on `null`.
 */
function resolvePathOverride(env: NodeJS.ProcessEnv, isPackaged: boolean, varName: string): string | null {
  if (env[ENV_AUTOMATION] !== "1") {
    return null;
  }
  const raw = env[varName];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (isPackaged) {
    return null;
  }
  if (!isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Dev-only override for the settings.json path (design/slice-P7.15-cut.md
 * §2.6): the P7.H automation profile isolates Electron's `userData`, but
 * settings.json is HOME-based (`~/.anycode/settings.json`, settings/files.ts's
 * `defaultSettingsPath`) — without this, a live automation smoke that persists
 * model/effort defaults (P7.15) would clobber the owner's real settings.
 * Same double gate as `resolveUserDataOverride`, keyed on `ANYCODE_SETTINGS_PATH`.
 * `main/index.ts` also forwards the resolved path (override or production
 * default) into the host fork's env under the same var name, so
 * `host/boot.ts`'s `seedAlwaysAllowRules` reads the identical, already-vetted
 * path instead of re-deriving the gate in a process with no `isPackaged`
 * signal of its own.
 */
export function resolveSettingsPathOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  return resolvePathOverride(env, isPackaged, ENV_SETTINGS_PATH);
}

/**
 * Dev-only override for the secrets.json path (design/slice-P7.15-cut.md
 * §2.6), mirroring `resolveSettingsPathOverride` exactly (keyed on
 * `ANYCODE_SECRETS_PATH`). Only `main/index.ts`'s Vault construction reads
 * this — the host process never touches secrets.json.
 */
export function resolveSecretsPathOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  return resolvePathOverride(env, isPackaged, ENV_SECRETS_PATH);
}

/**
 * Dev-only override for the MCP import scan's `home` (design/slice-P7.19-cut.md
 * §3; W5-FIX, finding 5). Points `scanHarnessConfigs` at a disposable fixture
 * directory instead of the real `~` (the mcp-ui-smoke harness). Same double
 * gate as the other overrides (`ANYCODE_AUTOMATION==="1" && !isPackaged`, plus a
 * non-empty absolute path): a PACKAGED production build NEVER honors the var, so
 * `home()` is always `os.homedir()` there — a compromised/misconfigured env can
 * never redirect the harness scan in a shipped app. Returns `null` when the gate
 * fails; the caller falls back to `os.homedir()`.
 */
export function resolveMcpImportHome(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  return resolvePathOverride(env, isPackaged, ENV_MCP_IMPORT_HOME);
}

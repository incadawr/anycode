/**
 * Telemetry config loader (slice 6.6, design slice-6.6-cut.md §2-B3). Mirrors
 * websearch/config.ts's idiom to the letter: the SAME file and trust model
 * apply to a single OBJECT section (no per-field merge) — project
 * `<workspace>/.anycode/config.json` wins WHOLESALE over user
 * `<home>/.anycode/config.json` once it defines the key at all (valid or
 * not). Fail-soft throughout: invalid JSON, a non-object section, a schema
 * violation, or a relative `dir` all resolve to `{telemetry: null}` plus an
 * `issues[]` entry — loadTelemetryConfig NEVER throws.
 *
 * The env kill-switch `ANYCODE_TELEMETRY` ("0"/"false"/"off", case-insensitive)
 * is checked FIRST, before any file is touched, and silently disables telemetry
 * with zero issues (an automation/CI "turn off what's mounted" knob). There is
 * deliberately no force-ON env value: the only way to enable telemetry is an
 * `enabled: true` telemetry section in one of the two config files above.
 *
 * TASK.121/TASK.165: `ANYCODE_TELEMETRY_DIR` (checked right after the
 * kill-switch, on the injected env) is a sink-dir REDIRECT, not a second way
 * to enable telemetry — it only ever changes WHERE an already-`enabled: true`
 * section writes (same effect as that section's own `dir` field, just
 * env-sourced and higher-precedence). Setting the override alone, with no
 * config file anywhere setting `enabled: true`, still resolves to
 * `{telemetry: null}`. A relative/empty override value fails closed
 * regardless of enablement (malformed input is always an issue, without
 * touching the filesystem).
 *
 * TASK.121/TASK.166: independently, a fail-closed test gate keyed off the
 * AMBIENT `VITEST` env (not the injected `env` argument) stops a test process
 * from ever resolving telemetry against the real home directory: it skips the
 * home-scope source when workspace !== home, and — when an enabled section
 * has no explicit `dir` and no `ANYCODE_TELEMETRY_DIR` override applies —
 * redirects the resolved directory to a stable, discoverable path under the
 * OS temp dir instead of the real default, recording that path in `issues`.
 * See loadTelemetryConfig / resolveSection for the exact rules.
 */

import { tmpdir } from "node:os";
import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";

export const telemetryConfigSchema = z.object({
  enabled: z.boolean(),
  /** ABSOLUTE directory for the JSONL sink; default `<home>/.anycode/telemetry`. A relative dir is an issue + disabled (fail-closed, never resolved against cwd). */
  dir: z.string().min(1).optional(),
});

export type TelemetryConfigEntry = z.output<typeof telemetryConfigSchema>;

export interface ResolvedTelemetryConfig {
  /** Absolute sink directory (default applied here). */
  dir: string;
}

export interface LoadedTelemetryConfig {
  telemetry: ResolvedTelemetryConfig | null;
  issues: string[];
}

const KILL_SWITCH_VALUES = new Set(["0", "false", "off"]);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir (mirror of websearch/lsp/mcp config.ts). */
function projectOrUserConfigPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/** `<home>/.anycode/telemetry`, tolerating a trailing separator on home. */
function defaultTelemetryDir(home: string): string {
  return `${home.replace(/[/\\]+$/, "")}/.anycode/telemetry`;
}

/**
 * TASK.166: stable, discoverable redirect target for a test-gated resolution
 * that would otherwise land on the real default dir. Fixed name (no
 * mkdtemp-style random suffix) under the OS temp dir so a human can find it
 * by path alone after the fact — the exact path is also echoed into
 * `issues` at the call site. Never under the owner's real home tree.
 */
function testGateTempDir(): string {
  return `${tmpdir().replace(/[/\\]+$/, "")}/anycode-telemetry-vitest`;
}

/** Rejects a relative path (POSIX `/...` or Windows `C:\...` / `C:/...` only).
 *  Core stays node-free — this is a hand-rolled check, not node:path.isAbsolute. */
function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a schema-valid section into a directory, or records a business-rule issue and returns null.
 *  `overrideDir` (TASK.165): the validated `ANYCODE_TELEMETRY_DIR` value, if any — applies ONLY once
 *  `config.enabled` is already true (it redirects WHERE, never decides WHETHER) and, being itself an
 *  explicit directory, wins over both a file `dir` and the test gate below.
 *  `underTestGate` (TASK.121/166): when set and no `overrideDir` applies, a section without an explicit
 *  `dir` no longer falls back to the real default `<home>/.anycode/telemetry` — it redirects to a stable
 *  temp dir instead (see testGateTempDir), so a test process never resolves the real default but the
 *  data isn't silently dropped either. */
function resolveSection(
  config: TelemetryConfigEntry,
  path: string,
  home: string,
  issues: string[],
  underTestGate: boolean,
  overrideDir: string | undefined,
): ResolvedTelemetryConfig | null {
  if (!config.enabled) return null;

  if (overrideDir !== undefined) return { dir: overrideDir };

  if (config.dir === undefined) {
    if (underTestGate) {
      const dir = testGateTempDir();
      issues.push(
        `Telemetry config ${path}: running under a test runner (ambient VITEST) without an explicit dir — ` +
          `redirected to "${dir}" instead of the real default; copy out by hand if you need this run's data`,
      );
      return { dir };
    }
    return { dir: defaultTelemetryDir(home) };
  }
  if (!isAbsolutePath(config.dir)) {
    issues.push(
      `Telemetry config ${path}: "dir" must be an absolute path, got "${config.dir}"; telemetry disabled`,
    );
    return null;
  }
  return { dir: config.dir };
}

/**
 * Reads one source file and, if it defines a `telemetry` key, claims the

 * Returns `undefined` when this source does NOT claim the section (missing
 * file, unreadable, invalid JSON, non-object body, or no `telemetry` key at
 * all) so the caller falls through to the next source; a claimed-but-invalid
 * section still returns (with `telemetry: null` and an issue) — it does NOT
 * fall through, per the wholesale-wins rule.
 */
async function loadSource(
  fs: FileSystemPort,
  path: string,
  home: string,
  issues: string[],
  underTestGate: boolean,
  overrideDir: string | undefined,
): Promise<{ telemetry: ResolvedTelemetryConfig | null } | undefined> {
  if (!(await fs.exists(path))) return undefined;

  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    issues.push(`Could not read telemetry config ${path}: ${describeError(error)}`);
    return undefined;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    issues.push(`Invalid JSON in telemetry config ${path}: ${describeError(error)}`);
    return undefined;
  }

  if (!parsedJson || typeof parsedJson !== "object") return undefined;
  const section = (parsedJson as { telemetry?: unknown }).telemetry;
  if (section === undefined) return undefined;

  const parsed = telemetryConfigSchema.safeParse(section);
  if (!parsed.success) {
    issues.push(`Invalid telemetry config ${path}: ${formatZodError(parsed.error)}`);
    return { telemetry: null };
  }

  return { telemetry: resolveSection(parsed.data, path, home, issues, underTestGate, overrideDir) };
}

/**
 * Loads the `telemetry` section from project `<workspace>/.anycode/
 * config.json` then user `<home>/.anycode/config.json` (project wins

 * silently before any fs access. Never throws: an absent section in both
 * sources yields `{telemetry: null, issues: []}` silently at zero cost; a
 * present-but-invalid/misconfigured section yields `{telemetry: null, issues:
 * [...]}` (boot warns, never fails).
 */
export async function loadTelemetryConfig(
  fs: FileSystemPort,
  workspace: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<LoadedTelemetryConfig> {
  const killSwitch = env.ANYCODE_TELEMETRY;
  if (killSwitch !== undefined && KILL_SWITCH_VALUES.has(killSwitch.toLowerCase())) {
    return { telemetry: null, issues: [] };
  }

  // TASK.121/TASK.165: dir override on the INJECTED env, validated right after
  // the kill-switch. NOT a second enable switch — a well-formed value is only
  // threaded through to resolveSection, which applies it as a directory
  // REDIRECT once (and only once) a file config's `enabled: true` already
  // holds; the override alone, with no config claiming `enabled: true`
  // anywhere, still resolves to `{telemetry: null}`. A relative or empty
  // value fails closed immediately here (without touching the filesystem) —
  // malformed input is always an issue, regardless of what any file would
  // have resolved to.
  const dirOverrideRaw = env.ANYCODE_TELEMETRY_DIR;
  let overrideDir: string | undefined;
  if (dirOverrideRaw !== undefined) {
    if (dirOverrideRaw === "" || !isAbsolutePath(dirOverrideRaw)) {
      return {
        telemetry: null,
        issues: [
          `ANYCODE_TELEMETRY_DIR must be an absolute path, got "${dirOverrideRaw}"; telemetry disabled`,
        ],
      };
    }
    overrideDir = dirOverrideRaw;
  }

  // TASK.121 fail-closed test gate: keyed off the AMBIENT runner env, never the
  // injected `env` argument above — tests inject synthetic env objects, which is
  // exactly the hole that let ~54k gate-fixture files accumulate in the owner's
  // real ~/.anycode/telemetry. Under the gate:
  //  - the home-scope source is skipped entirely when workspace !== home (the
  //    CLI-test leak path: tmp cwd + the owner's real ~/.anycode/config.json) —
  //    this is about which config FILES get read at all, independent of the
  //    override, and stays in force even when overrideDir is set;
  //  - TASK.166: any resolution that would land on the DEFAULT dir is
  //    redirected to a stable temp dir instead of refused (see resolveSection)
  //    — unless overrideDir already supplied an explicit directory, in which
  //    case that wins and the redirect never triggers.
  // workspace === home (single-source dedup, e.g. desktop profile-ipc) still
  // consults that one path via the existing seenPaths dedup below.
  const underTestGate = globalThis.process?.env?.VITEST !== undefined;

  const issues: string[] = [];
  const seenPaths = new Set<string>();
  const baseDirs = underTestGate && workspace !== home ? [workspace] : [workspace, home];
  for (const baseDir of baseDirs) {
    const path = projectOrUserConfigPath(baseDir);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const claimed = await loadSource(fs, path, home, issues, underTestGate, overrideDir);
    if (claimed !== undefined) {
      return { telemetry: claimed.telemetry, issues };
    }
  }

  return { telemetry: null, issues };
}

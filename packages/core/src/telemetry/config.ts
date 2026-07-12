/**
 * Telemetry config loader (slice 6.6, design slice-6.6-cut.md §2-B3). Mirrors
 * websearch/config.ts's idiom to the letter: the SAME file and trust model

 * OBJECT section (no per-field merge), project `<workspace>/.anycode/
 * config.json` wins WHOLESALE over user `<home>/.anycode/config.json` once it
 * defines the key at all (valid or not). Fail-soft throughout: invalid JSON, a
 * non-object section, a schema violation, or a relative `dir` all resolve to
 * `{telemetry: null}` plus an `issues[]` entry — loadTelemetryConfig NEVER
 * throws.
 *
 * The env kill-switch `ANYCODE_TELEMETRY` ("0"/"false"/"off", case-insensitive)
 * is checked FIRST, before any file is touched, and silently disables telemetry
 * with zero issues (an automation/CI "turn off what's mounted" knob). There is
 * deliberately no force-ON env value: the only way to enable telemetry is a

 */

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

/** Rejects a relative path (POSIX `/...` or Windows `C:\...` / `C:/...` only).
 *  Core stays node-free — this is a hand-rolled check, not node:path.isAbsolute. */
function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a schema-valid section into a directory, or records a business-rule issue and returns null. */
function resolveSection(
  config: TelemetryConfigEntry,
  path: string,
  home: string,
  issues: string[],
): ResolvedTelemetryConfig | null {
  if (!config.enabled) return null;

  if (config.dir === undefined) {
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

  return { telemetry: resolveSection(parsed.data, path, home, issues) };
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

  const issues: string[] = [];
  const seenPaths = new Set<string>();
  for (const baseDir of [workspace, home]) {
    const path = projectOrUserConfigPath(baseDir);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const claimed = await loadSource(fs, path, home, issues);
    if (claimed !== undefined) {
      return { telemetry: claimed.telemetry, issues };
    }
  }

  return { telemetry: null, issues };
}

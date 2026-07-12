/**
 * MCP config loader (design slice-3.2-cut.md §3.4/§4.4). Parses the `mcpServers`
 * section of `.anycode/config.json` (project > user > compat `.mcp.json`),
 * resolves ${env:VAR} substitution, and builds the explicit stdio child env.
 * A separate parser over the same file consumed independently by hook-config.ts;
 * hook-config.ts is NOT touched. Every source is fail-soft: a bad JSON/schema
 * skips that source's server(s) and reports via `problems[]` — boot never fails.
 *

 * source that defines it — project `.anycode/config.json` > user
 * `~/.anycode/config.json` > compat `<workspace>/.mcp.json` (Claude-ecosystem
 * `{"mcpServers":{...}}` shape). Records are never merged across sources: once a
 * name is claimed by a source (enabled, disabled, or errored), lower-priority
 * sources' entries for that same name are ignored outright.
 *

 * `${env:VAR}` inside `env` values (stdio) or `header` values (http). A
 * referenced var that is unset in process.env means the WHOLE server is
 * skipped with a `problems[]` entry (fail-closed — never start a
 * half-configured server holding a literal "${env:...}" placeholder or an
 * empty string in place of a secret).
 */

import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpHttpServerSpec, McpServerSpec, McpStdioServerSpec } from "../ports/mcp.js";

export interface LoadedMcpServerSpecs {
  specs: McpServerSpec[];
  /** Human-readable per-source problems (invalid JSON, missing env var, …). */
  problems: string[];
}

// ---------------------------------------------------------------------------
// Schema (design §4.4). Discrimination between the stdio and http forms is
// structural (presence of `command` vs `url`), not a zod discriminated union,
// so both shapes are folded into one permissive object and disambiguated in
// `resolveEntry` — this keeps "both fields present" / "neither present" as a
// reportable-but-not-crashing problem rather than a schema rejection that would
// (per the fail-soft file-level contract) drop every OTHER server in the file.

export const mcpServerEntrySchema = z.object({
  // stdio form
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.boolean().optional(),
  // http form
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // shared
  enabled: z.boolean().optional(),
});

/** Shape of the "mcpServers" section in .anycode/config.json (and .mcp.json). */
export const mcpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
});

export type McpServerEntry = z.output<typeof mcpServerEntrySchema>;
export type McpConfigFile = z.output<typeof mcpConfigFileSchema>;

// ---------------------------------------------------------------------------
// Small local helpers (deliberately NOT shared with hook-config.ts — see the
// file header: the two loaders are independent parsers over related files).

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir. */
function projectOrUserConfigPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/** `<workspace>/.mcp.json` — the Claude-ecosystem compat file (same top-level shape). */
function compatConfigPath(workspace: string): string {
  return `${workspace.replace(/[/\\]+$/, "")}/.mcp.json`;
}

// ---------------------------------------------------------------------------

// values (http) — never to command/args/cwd/url, which are trusted config, not
// secret-carrying.

const ENV_REF_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

type EnvRefResolution = { ok: true; value: string } | { ok: false; missing: string };

/** Substitutes every `${env:VAR}` occurrence in `value`; the first unset VAR fails the whole string. */
function resolveEnvRefs(value: string): EnvRefResolution {
  let missing: string | undefined;
  const resolved = value.replace(ENV_REF_RE, (_match, varName: string) => {
    if (missing) {
      return "";
    }
    const resolvedValue = process.env[varName];
    if (resolvedValue === undefined) {
      missing = varName;
      return "";
    }
    return resolvedValue;
  });
  if (missing) {
    return { ok: false, missing };
  }
  return { ok: true, value: resolved };
}

type EnvRecordResolution =
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; missing: string };

/** Resolves every value of a `Record<string,string>` (env or headers); fails closed on the first missing var. */
function resolveEnvRecord(record: Record<string, string> | undefined): EnvRecordResolution {
  if (!record) {
    return { ok: true, value: undefined };
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const resolved = resolveEnvRefs(value);
    if (!resolved.ok) {
      return { ok: false, missing: resolved.missing };
    }
    result[key] = resolved.value;
  }
  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------

// ({PATH, HOME, LANG} ∩ process.env) + the resolved config env. `inheritEnv:true`
// swaps the base for the FULL process.env with every `ANYCODE_*` key stripped
// (the CLI's only env-scrub line for MCP; the host's process.env is already
// scrubbed before it ever reaches this loader) — config env still applies on
// top, so an explicit `env` entry can override an inherited value.

const MINIMAL_ENV_KEYS = ["PATH", "HOME", "LANG"] as const;

function buildStdioEnv(configEnv: Record<string, string>, inheritEnv: boolean): Record<string, string> {
  const base: Record<string, string> = {};
  if (inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("ANYCODE_")) {
        continue;
      }
      base[key] = value;
    }
  } else {
    for (const key of MINIMAL_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        base[key] = value;
      }
    }
  }
  return { ...base, ...configEnv };
}

// ---------------------------------------------------------------------------
// Per-entry resolution

/** Resolves one named entry into a spec, or records a problem and returns undefined (server skipped). */
function resolveEntry(
  name: string,
  entry: McpServerEntry,
  path: string,
  problems: string[],
): McpServerSpec | undefined {
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  if (hasCommand === hasUrl) {
    problems.push(
      `MCP server '${name}' in ${path}: must have exactly one of "command" (stdio) or "url" (http)`,
    );
    return undefined;
  }

  if ((entry.enabled ?? true) === false) {
    return undefined;
  }

  if (hasCommand) {
    const envResolved = resolveEnvRecord(entry.env);
    if (!envResolved.ok) {
      problems.push(
        `MCP server '${name}' in ${path}: env var '${envResolved.missing}' is not set — server skipped`,
      );
      return undefined;
    }
    const spec: McpStdioServerSpec = {
      kind: "stdio",
      name,
      command: entry.command!,
      args: entry.args ?? [],
      env: buildStdioEnv(envResolved.value ?? {}, entry.inheritEnv ?? false),
    };
    if (entry.cwd !== undefined) {
      spec.cwd = entry.cwd;
    }
    return spec;
  }

  const headersResolved = resolveEnvRecord(entry.headers);
  if (!headersResolved.ok) {
    problems.push(
      `MCP server '${name}' in ${path}: env var '${headersResolved.missing}' is not set — server skipped`,
    );
    return undefined;
  }
  const spec: McpHttpServerSpec = { kind: "http", name, url: entry.url! };
  if (headersResolved.value !== undefined) {
    spec.headers = headersResolved.value;
  }
  return spec;
}

/**
 * Resolves a `Record<name, McpServerEntry>` (from any source: explicit config
 * or a plugin manifest, slice 3.3 §2.8/§3.6) into specs + problems, honoring the
 * shared `claimed` set (a name already claimed by a higher-priority source is
 * skipped). `sourceLabel` is the human-facing origin cited in problems (a file
 * path for config, `plugin:<name>` for a plugin). Exported so plugins reuse the
 * SAME ${env:VAR} fail-closed / minimal-env / ANYCODE_* scrub logic — no
 * duplicated trust code. Behavior is identical to the previous inline loop.
 */
export function resolveMcpServerEntries(
  entries: Record<string, McpServerEntry>,
  opts: { sourceLabel: string; claimed: Set<string> },
): { specs: McpServerSpec[]; problems: string[] } {
  const specs: McpServerSpec[] = [];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (opts.claimed.has(name)) {
      continue;
    }
    opts.claimed.add(name);
    const spec = resolveEntry(name, entry, opts.sourceLabel, problems);
    if (spec) {
      specs.push(spec);
    }
  }
  return { specs, problems };
}

/**
 * Reads and applies one source file. Missing file -> no-op (zero cost). Bad
 * JSON/schema -> a `problems[]` entry, the ENTIRE source's servers are skipped
 * (mirrors the hook-config §2.11 file-level fail-soft precedent) — boot never
 * throws. Names already `claimed` by a higher-priority source are left alone.
 */
async function loadSource(
  fs: FileSystemPort,
  path: string,
  claimed: Set<string>,
  specs: McpServerSpec[],
  problems: string[],
): Promise<void> {
  if (!(await fs.exists(path))) {
    return;
  }

  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    problems.push(`Could not read MCP config ${path}: ${describeError(error)}`);
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    problems.push(`Invalid JSON in MCP config ${path}: ${describeError(error)}`);
    return;
  }

  const result = mcpConfigFileSchema.safeParse(parsedJson);
  if (!result.success) {
    problems.push(`Invalid MCP config ${path}: ${formatZodError(result.error)}`);
    return;
  }

  const servers = result.data.mcpServers;
  if (!servers) {
    return;
  }

  const resolved = resolveMcpServerEntries(servers, { sourceLabel: path, claimed });
  specs.push(...resolved.specs);
  problems.push(...resolved.problems);
}

/**
 * Loads `mcpServers` from project `<workspace>/.anycode/config.json`, user
 * `<home>/.anycode/config.json`, and compat `<workspace>/.mcp.json`, in that

 * collected and returned instead. An absent/empty config across all three
 * sources yields `{ specs: [], problems: [] }` at zero fs/child cost.
 */
export async function loadMcpServerSpecs(
  fs: FileSystemPort,
  workspace: string,
  home: string,
): Promise<LoadedMcpServerSpecs> {
  const specs: McpServerSpec[] = [];
  const problems: string[] = [];
  const claimed = new Set<string>();

  const projectPath = projectOrUserConfigPath(workspace);
  const userPath = projectOrUserConfigPath(home);
  const compatPath = compatConfigPath(workspace);

  // Dedup identical paths (e.g. workspace === home) so the same file is never
  // parsed twice — harmless either way (claimed[] would no-op the repeat) but
  // avoids a redundant read, mirroring the hook-config precedent.
  const seenPaths = new Set<string>();
  for (const path of [projectPath, userPath, compatPath]) {
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    await loadSource(fs, path, claimed, specs, problems);
  }

  return { specs, problems };
}

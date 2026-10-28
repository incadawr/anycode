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

import { resolve } from "node:path";
import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpHttpServerSpec, McpServerSpec, McpStdioServerSpec } from "../ports/mcp.js";
// The stdio env scrub + relay URL live in adapters/node (TASK.135 / Taskana
// 4074); neither module imports this loader back, so the graph stays acyclic.
import { sanitizeChildEnv } from "../adapters/node/child-env.js";
import { proxyRelayLookup } from "../adapters/node/proxy-relay.js";

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

/**
 * Workspace trust option (Taskana 4736). `projectTrusted: false` gates the
 * PROJECT sources only; absent or true keeps the historical behaviour (library
 * callers). Hosts compute it once at boot via resolveWorkspaceTrust.
 */
export interface ProjectTrustOptions {
  projectTrusted?: boolean;
}

/** True when project-level sources must be skipped: untrusted and the workspace is not the home directory itself. */
export function isProjectGated(workspace: string, home: string, opts?: ProjectTrustOptions): boolean {
  return opts?.projectTrusted === false && resolve(workspace) !== resolve(home);
}

// ---------------------------------------------------------------------------

// values (http) — never to command/args/cwd/url, which are trusted config, not
// secret-carrying.

/**
 * Taskana 4752 part C: resolves a `${secret:NAME}` reference to its value, or
 * `undefined` when the name is not set. The desktop host supplies one built from
 * the values main handed it at fork time; the terminal CLI supplies none.
 */
export type McpSecretResolver = (name: string) => string | undefined;

/** Options shared by every loader that resolves MCP server entries. */
export interface McpResolveOptions {
  secrets?: McpSecretResolver;
  loginPath?: string;
  reportDisabled?: boolean;
}

/**
 * One pass over `${env:VAR}` and `${secret:NAME}`. A secret NAME follows the
 * env-name shape but is length-capped at 64 (`[A-Za-z_][A-Za-z0-9_]{0,63}`); any
 * other shape is not a reference and stays literal. A single pass means a
 * replacement value is never re-scanned.
 */
const REF_RE = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|secret:([A-Za-z_][A-Za-z0-9_]{0,63}))\}/g;

type RefResolution =
  | { ok: true; value: string; secretValues: string[] }
  | { ok: false; missing: { kind: "env"; name: string } | { kind: "secret"; name: string } };

/** Substitutes every reference in `value`; the first unresolved one fails the whole string. */
function resolveRefs(value: string, secrets: McpSecretResolver | undefined): RefResolution {
  let missing: { kind: "env"; name: string } | { kind: "secret"; name: string } | undefined;
  const secretValues: string[] = [];
  const resolved = value.replace(REF_RE, (_match, envName: string | undefined, secretName: string | undefined) => {
    if (missing) {
      return "";
    }
    if (envName !== undefined) {
      const resolvedValue = process.env[envName];
      if (resolvedValue === undefined) {
        missing = { kind: "env", name: envName };
        return "";
      }
      return resolvedValue;
    }
    const secretValue = secretName === undefined ? undefined : secrets?.(secretName);
    if (secretName === undefined || secretValue === undefined) {
      missing = { kind: "secret", name: secretName ?? "" };
      return "";
    }
    secretValues.push(secretValue);
    return secretValue;
  });
  if (missing) {
    return { ok: false, missing };
  }
  return { ok: true, value: resolved, secretValues };
}

/** Names every `${secret:NAME}` referenced in `env`/`headers` of an entries record: sorted, unique. */
export function collectSecretRefs(entries: Record<string, McpServerEntry>): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(entries)) {
    for (const record of [entry.env, entry.headers]) {
      if (!record) continue;
      for (const value of Object.values(record)) {
        for (const match of value.matchAll(REF_RE)) {
          const secretName = match[2];
          if (secretName !== undefined) names.add(secretName);
        }
      }
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

type EnvRecordResolution =
  | { ok: true; value: Record<string, string> | undefined; secretValues: string[] }
  | { ok: false; missing: { kind: "env"; name: string } | { kind: "secret"; name: string } };

/** Resolves every value of a `Record<string,string>` (env or headers); fails closed on the first unresolved reference. */
function resolveEnvRecord(
  record: Record<string, string> | undefined,
  secrets: McpSecretResolver | undefined,
): EnvRecordResolution {
  if (!record) {
    return { ok: true, value: undefined, secretValues: [] };
  }
  const result: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const resolved = resolveRefs(value, secrets);
    if (!resolved.ok) {
      return { ok: false, missing: resolved.missing };
    }
    result[key] = resolved.value;
    secretValues.push(...resolved.secretValues);
  }
  return { ok: true, value: result, secretValues };
}

/** The problem line for an unresolved reference. Names only, never a value. */
function missingRefMessage(name: string, path: string, missing: { kind: "env" | "secret"; name: string }): string {
  if (missing.kind === "env") {
    return `MCP server '${name}' in ${path}: env var '${missing.name}' is not set — server skipped`;
  }
  return `MCP server '${name}' in ${path}: secret '${missing.name}' is not set — add it in Settings → MCP → Secrets — server skipped`;
}

// ---------------------------------------------------------------------------

// ({PATH, HOME, LANG} ∩ process.env) + the resolved config env. `inheritEnv:true`
// swaps the base for the FULL process.env with every `ANYCODE_*` key stripped
// (the CLI's only env-scrub line for MCP; the host's process.env is already
// scrubbed before it ever reaches this loader) — config env still applies on
// top, so an explicit `env` entry can override an inherited value.
//
// TASK.135 follow-up: `inheritEnv:true` also passes the full env through
// `sanitizeChildEnv` — a credentialed proxy URL (and the engine carriers)
// never reach an MCP stdio server either; when the loopback relay is up
// (proxy-relay.ts) the dropped values are replaced by the credential-free
// relay URL, so an npx-installed server keeps working behind the
// authenticating proxy. `inheritEnv:false` (the minimal base) never carries a
// proxy var to begin with and is untouched.

const MINIMAL_ENV_KEYS = ["PATH", "HOME", "LANG"] as const;

function buildStdioEnv(configEnv: Record<string, string>, inheritEnv: boolean, loginPath?: string): Record<string, string> {
  const base: Record<string, string> = {};
  if (inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("ANYCODE_")) {
        continue;
      }
      base[key] = value;
    }
    // TASK.135 follow-up: scrub + relay-rewrite the inherited half. The
    // config env still applies ON TOP (an explicit `env` entry can override
    // even the relay URL — a server that must not be proxied at all).
    const sanitized = sanitizeChildEnv(base, proxyRelayLookup());
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return { ...out, ...(loginPath ? { PATH: loginPath } : {}), ...configEnv };
  }
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return { ...base, ...(loginPath ? { PATH: loginPath } : {}), ...configEnv };
}

// ---------------------------------------------------------------------------
// Per-entry resolution

/** Resolves one named entry into a spec, or records a problem and returns undefined (server skipped). */
function resolveEntry(
  name: string,
  entry: McpServerEntry,
  path: string,
  problems: string[],
  secrets: McpSecretResolver | undefined,
  loginPath?: string,
  reportDisabled?: boolean,
): McpServerSpec | undefined {
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  if ((entry.enabled ?? true) === false) {
    if (reportDisabled) problems.push(`MCP server '${name}' in ${path}: disabled — server skipped`);
    return undefined;
  }
  if (hasCommand === hasUrl) {
    problems.push(
      `MCP server '${name}' in ${path}: must have exactly one of "command" (stdio) or "url" (http)`,
    );
    return undefined;
  }


  if (hasCommand) {
    const envResolved = resolveEnvRecord(entry.env, secrets);
    if (!envResolved.ok) {
      problems.push(missingRefMessage(name, path, envResolved.missing));
      return undefined;
    }
    const spec: McpStdioServerSpec = {
      kind: "stdio",
      name,
      command: entry.command!,
      args: entry.args ?? [],
      env: buildStdioEnv(envResolved.value ?? {}, entry.inheritEnv ?? false, loginPath),
    };
    if (envResolved.secretValues.length > 0) {
      spec.secretValues = envResolved.secretValues;
    }
    if (entry.cwd !== undefined) {
      spec.cwd = entry.cwd;
    }
    return spec;
  }

  const headersResolved = resolveEnvRecord(entry.headers, secrets);
  if (!headersResolved.ok) {
    problems.push(missingRefMessage(name, path, headersResolved.missing));
    return undefined;
  }
  const spec: McpHttpServerSpec = { kind: "http", name, url: entry.url! };
  if (headersResolved.value !== undefined) {
    spec.headers = headersResolved.value;
  }
  if (headersResolved.secretValues.length > 0) {
    spec.secretValues = headersResolved.secretValues;
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
  opts: { sourceLabel: string; claimed: Set<string> } & McpResolveOptions,
): { specs: McpServerSpec[]; problems: string[] } {
  const specs: McpServerSpec[] = [];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (opts.claimed.has(name)) {
      continue;
    }
    opts.claimed.add(name);
    const spec = resolveEntry(name, entry, opts.sourceLabel, problems, opts.secrets, opts.loginPath, opts.reportDisabled);
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
  secrets: McpSecretResolver | undefined,
  loginPath?: string,
  reportDisabled?: boolean,
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

  const root = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() }).safeParse(parsedJson);
  if (!root.success) {
    problems.push(`Invalid MCP config ${path}: ${formatZodError(root.error)}`);
    return;
  }
  for (const [name, rawEntry] of Object.entries(root.data.mcpServers ?? {})) {
    if (claimed.has(name)) continue;
    const entry = mcpServerEntrySchema.safeParse(rawEntry);
    if (!entry.success) {
      claimed.add(name);
      problems.push(`MCP server '${name}' in ${path}: invalid entry: ${formatZodError(entry.error)}`);
      continue;
    }
    const resolved = resolveMcpServerEntries({ [name]: entry.data }, { sourceLabel: path, claimed, secrets, loginPath, reportDisabled });
    specs.push(...resolved.specs);
    problems.push(...resolved.problems);
  }
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
  opts?: ProjectTrustOptions & McpResolveOptions,
): Promise<LoadedMcpServerSpecs> {
  const specs: McpServerSpec[] = [];
  const problems: string[] = [];
  const claimed = new Set<string>();

  const projectPath = projectOrUserConfigPath(workspace);
  const userPath = projectOrUserConfigPath(home);
  const compatPath = compatConfigPath(workspace);
  const gated = isProjectGated(workspace, home, opts);

  // Dedup identical paths (e.g. workspace === home) so the same file is never
  // parsed twice — harmless either way (claimed[] would no-op the repeat) but
  // avoids a redundant read, mirroring the hook-config precedent.
  const seenPaths = new Set<string>();
  for (const path of [projectPath, userPath, compatPath]) {
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    if (gated && (path === projectPath || path === compatPath)) {
      if (await fs.exists(path)) {
        problems.push(`Project MCP servers in ${path} skipped: folder not trusted`);
      }
      continue;
    }
    await loadSource(fs, path, claimed, specs, problems, opts?.secrets, opts?.loginPath, opts?.reportDisabled);
  }

  return { specs, problems };
}

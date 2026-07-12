/**
 * LSP server-spec config loader (slice 6.1 B4). Parses the `lspServers` array
 * of `.anycode/config.json` — the SAME file and trust model MCP already uses

 * (`<home>/.anycode/config.json`), deduplicated by `name`. Mirrors the idiom in
 * mcp/config.ts. Every source is fail-soft: invalid JSON or a bad `lspServers`
 * shape skips that source, and a single malformed entry is skipped with an
 * `issues[]` note — the loader NEVER throws (boot must not fail on config).
 *
 * Unlike MCP's keyed `mcpServers` record, `lspServers` is an ARRAY of specs
 * (each carries its own `name`); precedence dedup is by that `name`.
 */

import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import type { LspServerSpec } from "../ports/lsp.js";

export interface LoadedLspServerSpecs {
  specs: LspServerSpec[];
  /** Human-readable per-source/per-entry problems (invalid JSON, bad shape, …). */
  issues: string[];
}

export const lspServerEntrySchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  extensions: z.array(z.string().min(1)).min(1),
  initializationOptions: z.record(z.string(), z.unknown()).optional(),
});

export type LspServerEntry = z.output<typeof lspServerEntrySchema>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir (mirror of mcp/config.ts). */
function projectOrUserConfigPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/** Lowercases and ensures a leading dot so matching is robust regardless of how the user wrote the extension (".TS", "ts"). */
function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

function normalizeSpec(entry: LspServerEntry): LspServerSpec {
  const spec: LspServerSpec = {
    name: entry.name,
    command: entry.command,
    args: entry.args ?? [],
    extensions: entry.extensions.map(normalizeExtension),
  };
  if (entry.initializationOptions !== undefined) {
    spec.initializationOptions = entry.initializationOptions;
  }
  return spec;
}

async function loadSource(
  fs: FileSystemPort,
  path: string,
  claimed: Set<string>,
  specs: LspServerSpec[],
  issues: string[],
): Promise<void> {
  if (!(await fs.exists(path))) return;

  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    issues.push(`Could not read LSP config ${path}: ${describeError(error)}`);
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    issues.push(`Invalid JSON in LSP config ${path}: ${describeError(error)}`);
    return;
  }

  if (!parsedJson || typeof parsedJson !== "object") return;
  const section = (parsedJson as { lspServers?: unknown }).lspServers;
  if (section === undefined) return;
  if (!Array.isArray(section)) {
    issues.push(`Invalid LSP config ${path}: "lspServers" must be an array`);
    return;
  }

  for (const entry of section) {
    const parsed = lspServerEntrySchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(`Invalid LSP server in ${path}: ${formatZodError(parsed.error)}`);
      continue;
    }
    if (claimed.has(parsed.data.name)) continue; // higher-priority source wins
    claimed.add(parsed.data.name);
    specs.push(normalizeSpec(parsed.data));
  }
}

/**
 * Loads `lspServers` from project `<workspace>/.anycode/config.json` then user
 * `<home>/.anycode/config.json` (project wins per name). Never throws; an
 * absent/empty config across both sources yields `{ specs: [], issues: [] }` at
 * zero child cost.
 */
export async function loadLspServerSpecs(
  fs: FileSystemPort,
  workspace: string,
  home: string,
): Promise<LoadedLspServerSpecs> {
  const specs: LspServerSpec[] = [];
  const issues: string[] = [];
  const claimed = new Set<string>();

  const seenPaths = new Set<string>();
  for (const path of [projectOrUserConfigPath(workspace), projectOrUserConfigPath(home)]) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    await loadSource(fs, path, claimed, specs, issues);
  }

  return { specs, issues };
}

/**
 * WebSearch config loader (slice 6.3 Wave A, design slice-6.3-cut.md §2-A2).
 * Parses the `webSearch` section of `.anycode/config.json` — the SAME file and

 * `webSearch` is a SINGLE OBJECT: there is no per-field merge across sources,
 * so the highest-priority source that DEFINES the key (project
 * `<workspace>/.anycode/config.json` over user `<home>/.anycode/config.json`)
 * wins WHOLESALE, valid or not — a lower-priority source is never consulted
 * once a higher one claims the key by having the key present at all. Fail-soft
 * throughout (mirrors lsp/config.ts): invalid JSON, a non-object section, a
 * schema violation, or a business-rule failure (missing endpoint/apiKeyEnv, an
 * unset key env var, a non-http(s) endpoint) all resolve to `{backend: null}`


 */

import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import { WEBSEARCH_DEFAULT_MAX_RESULTS, WEBSEARCH_MAX_RESULTS } from "../types/config.js";

export const webSearchConfigSchema = z.object({
  backend: z.enum(["brave", "searxng"]),
  /** Search endpoint. REQUIRED for searxng (self-hosted instance base URL); optional override for brave (defaults to the public API). http/https only. */
  endpoint: z.url().optional(),
  /** NAME of the environment variable holding the API key (the key itself NEVER lives in config). Required for brave; ignored for searxng. */
  apiKeyEnv: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(WEBSEARCH_MAX_RESULTS).optional(),
});

export type WebSearchConfigEntry = z.output<typeof webSearchConfigSchema>;

export interface ResolvedWebSearchBackend {
  kind: "brave" | "searxng";
  /** Absolute search endpoint (brave default applied here). Guaranteed http/https. */
  endpoint: string;
  /* */
  headers: Record<string, string>;
  /** Result count when the model omits max_results: (config.maxResults ?? WEBSEARCH_DEFAULT_MAX_RESULTS), capped by WEBSEARCH_MAX_RESULTS. */
  maxResults: number;
}

export interface LoadedWebSearchConfig {
  backend: ResolvedWebSearchBackend | null;
  issues: string[];
}

/** Public Brave Web Search API endpoint (pinned against current docs, see report). */
const BRAVE_DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir (mirror of lsp/mcp config.ts). */
function projectOrUserConfigPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/** Rejects non-http(s) endpoints (`file://`, `ftp://`, …) and malformed URL strings alike. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolves a schema-valid section into a backend, or records a business-rule issue and returns null. */
function resolveBackend(
  config: WebSearchConfigEntry,
  path: string,
  env: NodeJS.ProcessEnv,
  issues: string[],
): ResolvedWebSearchBackend | null {
  const maxResults = Math.min(config.maxResults ?? WEBSEARCH_DEFAULT_MAX_RESULTS, WEBSEARCH_MAX_RESULTS);

  if (config.backend === "brave") {
    if (!config.apiKeyEnv) {
      issues.push(`WebSearch config ${path}: "brave" backend requires "apiKeyEnv"; WebSearch disabled`);
      return null;
    }
    const key = env[config.apiKeyEnv];
    if (!key) {
      issues.push(`WebSearch config ${path}: env var ${config.apiKeyEnv} is not set; WebSearch disabled`);
      return null;
    }
    const endpoint = config.endpoint ?? BRAVE_DEFAULT_ENDPOINT;
    if (!isHttpUrl(endpoint)) {
      issues.push(`WebSearch config ${path}: endpoint "${endpoint}" is not a valid http(s) URL; WebSearch disabled`);
      return null;
    }
    return {
      kind: "brave",
      endpoint,
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      maxResults,
    };
  }

  // searxng: endpoint is mandatory (self-hosted instance base), no key involved.
  if (!config.endpoint) {
    issues.push(`WebSearch config ${path}: "searxng" backend requires "endpoint"; WebSearch disabled`);
    return null;
  }
  if (!isHttpUrl(config.endpoint)) {
    issues.push(`WebSearch config ${path}: endpoint "${config.endpoint}" is not a valid http(s) URL; WebSearch disabled`);
    return null;
  }
  return {
    kind: "searxng",
    endpoint: config.endpoint,
    headers: { Accept: "application/json" },
    maxResults,
  };
}

/**
 * Reads one source file and, if it defines a `webSearch` key, claims the

 * source does NOT claim the section (missing file, unreadable, invalid JSON,
 * non-object body, or no `webSearch` key at all) so the caller falls through
 * to the next source; a claimed-but-invalid section still returns (with
 * `backend: null` and an issue) — it does NOT fall through to a lower-priority
 * source, per the wholesale-wins rule.
 */
async function loadSource(
  fs: FileSystemPort,
  path: string,
  env: NodeJS.ProcessEnv,
  issues: string[],
): Promise<{ backend: ResolvedWebSearchBackend | null } | undefined> {
  if (!(await fs.exists(path))) return undefined;

  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    issues.push(`Could not read WebSearch config ${path}: ${describeError(error)}`);
    return undefined;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    issues.push(`Invalid JSON in WebSearch config ${path}: ${describeError(error)}`);
    return undefined;
  }

  if (!parsedJson || typeof parsedJson !== "object") return undefined;
  const section = (parsedJson as { webSearch?: unknown }).webSearch;
  if (section === undefined) return undefined;

  const parsed = webSearchConfigSchema.safeParse(section);
  if (!parsed.success) {
    issues.push(`Invalid WebSearch config ${path}: ${formatZodError(parsed.error)}`);
    return { backend: null };
  }

  return { backend: resolveBackend(parsed.data, path, env, issues) };
}

/**
 * Loads the `webSearch` section from project `<workspace>/.anycode/config.json`

 * throws: an absent section in both sources yields `{backend: null, issues:
 * []}` silently at zero cost; a present-but-invalid/misconfigured section
 * yields `{backend: null, issues: [...]}` (boot warns, never fails).
 */
export async function loadWebSearchConfig(
  fs: FileSystemPort,
  workspace: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<LoadedWebSearchConfig> {
  const issues: string[] = [];

  const seenPaths = new Set<string>();
  for (const baseDir of [workspace, home]) {
    const path = projectOrUserConfigPath(baseDir);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const claimed = await loadSource(fs, path, env, issues);
    if (claimed !== undefined) {
      return { backend: claimed.backend, issues };
    }
  }

  return { backend: null, issues };
}

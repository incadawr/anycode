import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import { REPO_MAP_MAX_TOKENS, REPO_MAP_MIN_TOKENS } from "../types/config.js";

export const repoMapConfigSchema = z.object({
  enabled: z.boolean(),
  maxTokens: z.number().int().optional(),
});

export type RepoMapConfig = z.output<typeof repoMapConfigSchema>;

export interface LoadedRepoMapConfig {
  repoMap: RepoMapConfig | null;
  issues: string[];
}

const DISABLE_VALUES = new Set(["0", "false", "off"]);
const ENABLE_VALUES = new Set(["1", "true", "on"]);

function configPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

async function loadSource(
  fs: FileSystemPort,
  path: string,
  issues: string[],
): Promise<{ repoMap: RepoMapConfig | null } | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined;
    const raw = await fs.readFile(path);
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== "object") return undefined;
    const section = (json as { repoMap?: unknown }).repoMap;
    if (section === undefined) return undefined;
    const parsed = repoMapConfigSchema.safeParse(section);
    if (!parsed.success) {
      issues.push(`Invalid repo-map config ${path}: ${formatZodError(parsed.error)}`);
      return { repoMap: null };
    }
    if (!parsed.data.enabled) return { repoMap: null };
    return {
      repoMap:
        parsed.data.maxTokens === undefined
          ? parsed.data
          : {
              ...parsed.data,
              maxTokens: Math.max(
                REPO_MAP_MIN_TOKENS,
                Math.min(REPO_MAP_MAX_TOKENS, parsed.data.maxTokens),
              ),
            },
    };
  } catch (error) {
    issues.push(`Could not load repo-map config ${path}: ${describeError(error)}`);
    return undefined;
  }
}

/** Loads the project/user repoMap section wholesale. Environment values win before filesystem access. */
export async function loadRepoMapConfig(
  fs: FileSystemPort,
  workspace: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<LoadedRepoMapConfig> {
  const envValue = env.ANYCODE_REPO_MAP?.toLowerCase();
  if (envValue !== undefined && DISABLE_VALUES.has(envValue)) return { repoMap: null, issues: [] };
  if (envValue !== undefined && ENABLE_VALUES.has(envValue)) return { repoMap: { enabled: true }, issues: [] };

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const baseDir of [workspace, home]) {
    const path = configPath(baseDir);
    if (seen.has(path)) continue;
    seen.add(path);
    const result = await loadSource(fs, path, issues);
    if (result !== undefined) return { ...result, issues };
  }
  return { repoMap: null, issues };
}

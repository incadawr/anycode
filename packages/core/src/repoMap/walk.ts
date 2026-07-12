import type { FileSystemPort } from "../ports/file-system.js";

export interface RepoFile {
  relativePath: string;
  size: number;
  mtimeMs: number;
  extension: string;
  lines?: number;
}

export interface WalkRepoOptions {
  ignoredDirs: ReadonlySet<string>;
  maxFiles: number;
  maxDepth: number;
  onProblem?: (message: string) => void;
}

function join(base: string, name: string): string {
  return `${base.replace(/[/\\]+$/, "")}/${name}`;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deterministic depth-first, stat-only repository walk. */
export async function walkRepo(
  fs: FileSystemPort,
  root: string,
  opts: WalkRepoOptions,
): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

  const walk = async (directory: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > opts.maxDepth || files.length >= opts.maxFiles) return;
    let names: string[];
    try {
      names = (await fs.readdir(directory)).slice().sort((a, b) => a.localeCompare(b));
    } catch (error) {
      opts.onProblem?.(`Repo-map: could not read ${directory}: ${describeError(error)}`);
      return;
    }
    for (const name of names) {
      if (files.length >= opts.maxFiles) return;
      const path = join(directory, name);
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      let stat;
      try {
        stat = await fs.stat(path);
      } catch (error) {
        opts.onProblem?.(`Repo-map: could not stat ${path}: ${describeError(error)}`);
        continue;
      }
      if (stat.isDirectory) {
        if (!opts.ignoredDirs.has(name) && depth < opts.maxDepth) {
          await walk(path, relativePath, depth + 1);
        }
      } else if (stat.isFile) {
        files.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs, extension: extensionOf(relativePath) });
      }
    }
  };

  await walk(root, "", 0);
  return files;
}

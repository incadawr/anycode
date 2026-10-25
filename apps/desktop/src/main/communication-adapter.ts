/**
 * The stdio adapter (examples/agent-communication/stdio.mjs) that external
 * clients (Claude Code, Codex) run to reach the Sessions API. Packaged builds
 * ship it under `<Resources>/agent-communication/stdio.mjs`; dev runs read the
 * repository copy. Either way it is COPIED to a stable path under the user-data
 * directory, so a copied MCP config keeps working across app updates and moves.
 * The adapter holds no secret, so the copy is 0644. Pure resolution + an
 * injected fs port keep the order unit-testable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ANCESTOR_WALK = 8;
const ADAPTER_FILE = "stdio.mjs";

export interface AdapterSourceProbe {
  /** `process.resourcesPath` in a packaged app. */
  readonly resourcesPath?: string;
  /** Directory of the module doing the resolving. */
  readonly moduleDir: string;
  readonly exists: (path: string) => boolean;
}

/** Resolves the bundled adapter source, or null when this build does not carry it. */
export function resolveBundledStdioAdapter(probe: AdapterSourceProbe): string | null {
  if (probe.resourcesPath !== undefined && probe.resourcesPath !== "") {
    const packaged = join(probe.resourcesPath, "agent-communication", ADAPTER_FILE);
    if (probe.exists(packaged)) return packaged;
  }
  let current = resolve(probe.moduleDir);
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    const candidate = join(current, "examples", "agent-communication", ADAPTER_FILE);
    if (probe.exists(candidate) && probe.exists(join(current, "packages", "core", "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface AdapterFs {
  readText(path: string): string | null;
  writeTextAtomic(path: string, text: string, mode: number): void;
}

/**
 * Copies the bundled adapter to `${targetDir}/stdio.mjs` when missing or when the
 * content differs (idempotent: an identical copy is not rewritten). Returns the
 * stable target path, or null when the source is absent or the copy fails.
 */
export function ensureStdioAdapterCopy(fs: AdapterFs, source: string | null, targetDir: string): string | null {
  if (source === null) return null;
  const target = join(targetDir, ADAPTER_FILE);
  try {
    const sourceText = fs.readText(source);
    if (sourceText === null) return null;
    if (fs.readText(target) === sourceText) return target;
    fs.writeTextAtomic(target, sourceText, 0o644);
    return target;
  } catch {
    return null;
  }
}

/** The real node:fs binding of AdapterFs (sync: called from a synchronous IPC dep). */
export const nodeAdapterFs: AdapterFs = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeTextAtomic(path, text, mode) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { mode, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  },
};

/** The host binding: real resources path, this bundle's location, and the userData target directory. */
export function stdioAdapterForHost(userData: string): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const source = resolveBundledStdioAdapter({
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    moduleDir,
    exists: existsSync,
  });
  return ensureStdioAdapterCopy(nodeAdapterFs, source, join(userData, "agent-communication"));
}

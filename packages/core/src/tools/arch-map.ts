/**
 * ArchMap tool (TASK.233 slice S1): a read-only TS/JS import-graph scanner.
 * Topology, not policy — the graph is derived from the imports that actually
 * exist in the source, with no level assignment and no Dependency Rule
 * verdict (later slices). The model gets a compact summary; the full JSON
 * output is the data source for a future architecture-map panel.
 *
 * Known limitation: non-relative specs (bare names, `@scope/pkg` workspace
 * aliases, tsconfig `paths`) are counted as EXTERNAL. Barrel/aliased imports
 * therefore never appear as edges; that is a documented S1 trade-off.
 *
 * OPT-IN (Taskana 4162): ArchMap is NOT in the default registry until the
 * architecture-map GUI panel exists — its schema would tax every session's
 * prompt on every turn and invalidate the prompt cache once. Boot wirings
 * register it only when the opt-in flag says so (`loadArchMapEnabled` below).
 */

import { z } from "zod";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import type { FileSystemPort } from "../ports/index.js";
import { REPO_MAP_IGNORED_DIR_NAMES } from "../types/config.js";

const metadata: ToolMetadata = {
  name: "ArchMap",
  description:
    "Scan a TypeScript/JavaScript source tree and return its import graph: modules (with line counts), import edges (type-only and dynamic flagged), and external package counts. Workspace-internal package aliases (e.g. barrel imports) are counted as external. Use path to narrow to a subdirectory.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 30_000,
};

export const ARCH_MAP_MAX_FILES_DEFAULT = 2_000;
export const ARCH_MAP_MAX_FILES_LIMIT = 10_000;
export const ARCH_MAP_MAX_DEPTH = 24;
export const ARCH_MAP_MODEL_EDGE_LIMIT = 400; // edges inlined into the model-visible summary
/** Source files larger than this (minified bundles, generated code) are skipped unread. */
export const ARCH_MAP_MAX_FILE_BYTES = 1_000_000;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"] as const;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYN_RE = /(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

const EXCLUDED_DIR_SEGMENTS = new Set(["test-harness", "__fixtures__", "__mocks__"]);

const UNRESOLVED_CAP = 50;

// ---------------------------------------------------------------------------
// Opt-in flag (Taskana 4162): ANYCODE_ARCHMAP=1/true/on or true, else
// `tools.archMap: true` in ~/.anycode/settings.json. The default is OFF, and
// the env var wins over the setting (the `loadRepoMapConfig` / `fillFromSettings`
// convention: env > settings > fail-closed default).

/** Env var that enables ArchMap; literal, kept local to this module. */
export const ENV_ARCHMAP = "ANYCODE_ARCHMAP";

const ARCHMAP_ENABLE_VALUES = new Set(["1", "true", "on"]);
const ARCHMAP_DISABLE_VALUES = new Set(["0", "false", "off"]);

/**
 * Env-only read of the ArchMap flag: `true`/`false` for an explicit 1/0-style
 * value, `undefined` when the var is absent or blank (fall through to the
 * settings rung). An UNRECOGNIZED value also returns undefined — a typo must
 * degrade to the fail-closed default, never kill the boot (`readImageInputOverride`
 * style warn-and-ignore, not `readProviderTransport`'s throw).
 */
export function archMapEnabledFromEnv(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ENV_ARCHMAP]?.toLowerCase();
  if (raw === undefined || raw.trim() === "") return undefined;
  if (ARCHMAP_ENABLE_VALUES.has(raw)) return true;
  if (ARCHMAP_DISABLE_VALUES.has(raw)) return false;
  console.warn(`Invalid ${ENV_ARCHMAP}: "${raw}" is not 1/true/on or 0/false/off — ignoring`);
  return undefined;
}

/**
 * The settings.json rung: reads `tools.archMap` from the SAME
 * ~/.anycode/settings.json the permission rules come from. Strictly boolean —
 * anything else (absent, wrong type, unparseable file) reads as "not enabled";
 * a corrupt file must never keep a session from booting. Never throws.
 */
export async function archMapEnabledFromSettings(fs: FileSystemPort, settingsPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(settingsPath);
  } catch {
    return false;
  }
  try {
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) return false;
    const tools = (json as { tools?: unknown }).tools;
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) return false;
    return (tools as { archMap?: unknown }).archMap === true;
  } catch {
    return false;
  }
}

/**
 * Resolves the ArchMap opt-in: `ANYCODE_ARCHMAP` wins over the settings rung,
 * which wins over the fail-closed `false` default. This is the ONLY resolver
 * boot wirings need — the CLI and the desktop host both call it with their own
 * fs port, settings path, and env.
 */
export async function loadArchMapEnabled(
  fs: FileSystemPort,
  settingsPath: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const fromEnv = archMapEnabledFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;
  return archMapEnabledFromSettings(fs, settingsPath);
}

export const archMapInputSchema = z.object({
  path: z.string().min(1).optional().describe("Root directory to scan (default: working directory)"),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(ARCH_MAP_MAX_FILES_LIMIT)
    .optional()
    .describe("Maximum source files to scan (default 2000, max 10000)"),
});

export type ArchMapInput = z.output<typeof archMapInputSchema>;

export interface ArchMapModule {
  id: string;
  loc: number;
}

export interface ArchMapEdge {
  from: string;
  to: string;
  typeOnly: boolean;
  dynamic: boolean;
}

export interface ArchMapExternal {
  name: string;
  count: number;
}

export interface ArchMapOutput {
  root: string;
  truncated: boolean;
  /** Sorted by id asc. */
  modules: ArchMapModule[];
  /** Sorted by from asc, then to asc. */
  edges: ArchMapEdge[];
  /** Sorted by count desc, then name asc. */
  external: ArchMapExternal[];
  /** Capped at 50 entries. */
  unresolved: Array<{ from: string; spec: string }>;
}

// ---------------------------------------------------------------------------
// Path helpers (plain string ops — the FileSystemPort is path-agnostic, so
// POSIX/Windows separators are normalized by hand)

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function posixDirname(path: string): string {
  const normalized = normalizePosix(path);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return "";
  return normalized.slice(0, idx);
}

function posixJoin(dir: string, entry: string): string {
  if (dir.length === 0) return entry;
  return dir.endsWith("/") ? `${dir}${entry}` : `${dir}/${entry}`;
}

/** Node-style path.resolve(dir, spec) over POSIX strings — collapses `.`/`..`. */
function posixResolve(dir: string, spec: string): string {
  const isAbs = spec.startsWith("/");
  const stack = isAbs ? [] : dir.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  for (const seg of spec.split("/")) {
    if (seg.length === 0 || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return `/${stack.join("/")}`;
}

// ---------------------------------------------------------------------------
// Scanner

interface ScannedFile {
  absPath: string;
  id: string;
  content: string;
}

function isSourcePath(relPath: string): boolean {
  const normalized = normalizePosix(relPath);
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1];
  if (basename === undefined) return false;
  if (!SOURCE_EXTENSIONS.some((ext) => basename.endsWith(ext))) return false;
  if (basename.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(basename)) return false;
  return !segments.some((seg) => EXCLUDED_DIR_SEGMENTS.has(seg));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("ArchMap: scan aborted");
}

async function walkSourceFiles(
  fs: FileSystemPort,
  root: string,
  maxFiles: number,
  signal: AbortSignal | undefined,
): Promise<{ files: Array<{ absPath: string; relPath: string }>; truncated: boolean }> {
  const files: Array<{ absPath: string; relPath: string }> = [];

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (files.length >= maxFiles) return;
    if (depth > ARCH_MAP_MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (files.length >= maxFiles) return;
      const full = posixJoin(dir, entry);
      const rel = relDir.length === 0 ? entry : posixJoin(relDir, entry);
      let stat;
      try {
        // Symlinks are never followed (lstat, when the port has it): a link
        // could lead outside the scanned tree or into a cycle.
        stat = fs.lstat !== undefined ? await fs.lstat(full) : await fs.stat(full);
      } catch {
        continue; // broken symlink or race with deletion
      }
      if (stat.isSymbolicLink === true) continue;
      if (stat.isDirectory) {
        if (REPO_MAP_IGNORED_DIR_NAMES.has(entry)) continue;
        await walk(full, rel, depth + 1);
      } else if (stat.isFile) {
        if (!isSourcePath(rel)) continue;
        if (stat.size > ARCH_MAP_MAX_FILE_BYTES) continue;
        files.push({ absPath: full, relPath: rel });
        if (files.length >= maxFiles) return;
      }
    }
  }

  await walk(root, "", 0);
  // Truncated iff the walk was cut short by the cap, not by exhausting the
  // tree — re-probing the boundary directory is unnecessary complexity: the
  // caller only needs to know the graph may be partial, and if the cap was
  // reached the deepest frame stopped early by construction. An exact file
  // count equal to maxFiles on a tree that has exactly that many files
  // reports truncated conservatively; the resolution probe below keeps that
  // honest when it can (see scanImportGraph).
  const truncated = files.length >= maxFiles;
  return { files, truncated };
}

function parseImports(content: string): Array<{ spec: string; typeOnly: boolean; dynamic: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean; dynamic: boolean }> = [];
  const seen = new Set<string>(); // dedupe identical statements (global regexes)
  IMPORT_RE.lastIndex = 0;
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? "";
    if (spec.length === 0) continue;
    const key = `i:${m[1] ? "t" : "v"}:${spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ spec, typeOnly: m[1] !== undefined, dynamic: false });
  }
  DYN_RE.lastIndex = 0;
  for (const m of content.matchAll(DYN_RE)) {
    const spec = m[1] ?? "";
    if (spec.length === 0) continue;
    const key = `d:${spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ spec, typeOnly: false, dynamic: true });
  }
  return out;
}

function isNodeBuiltinSpec(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  const firstSegment = spec.split("/")[0] ?? "";
  return NODE_BUILTINS.has(firstSegment);
}

function externalPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const segments = spec.split("/");
    if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
    return spec;
  }
  return spec.split("/")[0] ?? spec;
}

/**
 * The pure-ish scanner behind the ArchMap tool. Deterministic: every output
 * array is sorted exactly as annotated on `ArchMapOutput`. Separately
 * testable and the seam a future LanguageGraph (non-TS sources) would slot
 * behind.
 */
export async function scanImportGraph(
  fs: FileSystemPort,
  root: string,
  opts: { maxFiles: number; signal?: AbortSignal },
): Promise<ArchMapOutput> {
  const { files, truncated } = await walkSourceFiles(fs, root, opts.maxFiles, opts.signal);

  const scanned: ScannedFile[] = [];
  const absToId = new Map<string, string>();
  for (const file of files) {
    throwIfAborted(opts.signal);
    let content: string;
    try {
      content = await fs.readFile(file.absPath);
    } catch {
      continue; // unreadable file (race with deletion): contributes nothing
    }
    const id = normalizePosix(file.relPath).replace(/\.[^.]+$/, "");
    absToId.set(normalizePosix(file.absPath), id);
    scanned.push({ absPath: file.absPath, id, content });
  }
  const idSet = new Set(scanned.map((f) => f.id));

  const edgeAgg = new Map<string, { from: string; to: string; typeOnly: boolean; dynamic: boolean }>();
  const externalCounts = new Map<string, number>();
  const unresolved: Array<{ from: string; spec: string }> = [];
  const unresolvedSeen = new Set<string>();

  const noteUnresolved = (from: string, spec: string) => {
    if (unresolved.length >= UNRESOLVED_CAP) return;
    const key = `${from}\u0000${spec}`;
    if (unresolvedSeen.has(key)) return;
    unresolvedSeen.add(key);
    unresolved.push({ from, spec });
  };

  const classifyAndRecord = (
    importingId: string,
    importingDir: string,
    spec: string,
    typeOnly: boolean,
    dynamic: boolean,
  ) => {
    if (spec.startsWith(".")) {
      const base = posixResolve(importingDir, spec);
      const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
      const candidates = [
        base,
        ...SOURCE_EXTENSIONS.map((e) => `${stripped}${e}`),
        ...SOURCE_EXTENSIONS.map((e) => posixJoin(stripped, `index${e}`)),
      ];
      const resolvedAbs = candidates.find((c) => absToId.has(c));
      const resolvedId = resolvedAbs === undefined ? undefined : absToId.get(resolvedAbs);
      if (resolvedId === undefined) {
        noteUnresolved(importingId, spec);
        return;
      }
      if (resolvedId === importingId) return; // self-import
      const key = `${importingId}\u0000${resolvedId}`;
      const existing = edgeAgg.get(key);
      if (existing) {
        existing.typeOnly = existing.typeOnly && typeOnly;
        existing.dynamic = existing.dynamic && dynamic;
      } else {
        edgeAgg.set(key, { from: importingId, to: resolvedId, typeOnly, dynamic });
      }
      return;
    }
    if (isNodeBuiltinSpec(spec)) return; // node builtins: no external entry
    const name = externalPackageName(spec);
    externalCounts.set(name, (externalCounts.get(name) ?? 0) + 1);
  };

  for (const file of scanned) {
    const imports = parseImports(file.content);
    if (imports.length === 0) continue;
    const dir = posixDirname(file.absPath);
    for (const imp of imports) {
      classifyAndRecord(file.id, dir, imp.spec, imp.typeOnly, imp.dynamic);
    }
  }

  const modules = scanned.map((f) => ({ id: f.id, loc: f.content.split("\n").length }));
  modules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const edges = [...edgeAgg.values()];
  edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));

  const external = [...externalCounts.entries()].map(([name, count]) => ({ name, count }));
  external.sort((a, b) => (a.count !== b.count ? b.count - a.count : a.name < b.name ? -1 : 1));

  return { root, truncated, modules, edges, external, unresolved };
}

// ---------------------------------------------------------------------------
// Tool

export const archMapTool: ToolDefinition<ArchMapInput, ArchMapOutput> = {
  metadata,
  inputSchema: archMapInputSchema,
  handler: async (input, ctx) => {
    // Relative paths resolve against the session cwd (not the process cwd),
    // and the scan never leaves it: ArchMap is a workspace map, not a
    // general file-system reader.
    const cwd = normalizePosix(ctx.cwd).replace(/\/+$/, "") || "/";
    const root = input.path === undefined ? ctx.cwd : posixResolve(cwd, normalizePosix(input.path));
    if (input.path !== undefined && root !== cwd && !root.startsWith(cwd === "/" ? "/" : `${cwd}/`)) {
      return { ok: false, error: `path is outside the workspace: ${input.path}` };
    }

    const rootExists = await ctx.ports.fs.exists(root);
    if (!rootExists) {
      return { ok: false, error: `path not found: ${root}` };
    }
    const rootStat = await ctx.ports.fs.stat(root);
    if (!rootStat.isDirectory) {
      return { ok: false, error: `path is not a directory: ${root}` };
    }

    try {
      const output = await scanImportGraph(ctx.ports.fs, root, {
        maxFiles: input.max_files ?? ARCH_MAP_MAX_FILES_DEFAULT,
        signal: ctx.abortSignal,
      });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  formatResultForModel: (result) => {
    if (!result.ok) {
      return result.error ?? "ArchMap: scan failed.";
    }
    const output = result.output;
    if (!output) {
      return "ArchMap: scan failed.";
    }
    const typeOnlyCount = output.edges.filter((e) => e.typeOnly).length;
    const dynamicCount = output.edges.filter((e) => e.dynamic).length;
    const lines: string[] = [
      `Import graph of ${output.root}: ${output.modules.length} modules, ${output.edges.length} edges (${typeOnlyCount} type-only, ${dynamicCount} dynamic)${output.truncated ? " — file limit reached, graph is partial" : ""}.`,
    ];
    if (output.external.length > 0) {
      const top = output.external.slice(0, 10).map((e) => `${e.name}(${e.count})`).join(", ");
      lines.push(`External packages: ${top}.`);
    }
    if (output.edges.length <= ARCH_MAP_MODEL_EDGE_LIMIT) {
      lines.push("Edges:");
      for (const edge of output.edges) {
        const marker = edge.typeOnly && edge.dynamic ? "-td->" : edge.typeOnly ? "-t->" : edge.dynamic ? "-d->" : "->";
        lines.push(`${edge.from} ${marker} ${edge.to}`);
      }
    } else {
      lines.push(
        `Edges omitted (${output.edges.length} > ${ARCH_MAP_MODEL_EDGE_LIMIT}) — narrow the scan with path (e.g. a package src directory).`,
      );
    }
    return lines.join("\n");
  },
};

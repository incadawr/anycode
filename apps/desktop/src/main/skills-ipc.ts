/**
 * Skills management control-plane IPC (design slice-P7.20-cut.md §5 W2).
 * Registers `ipcMain.handle` for the seven channels in shared/skills-config.ts:
 * a read-only joined project/user/plugin catalog view, toggle/delete/create/
 * reveal of one own-catalog skill, and scan/apply of an explicit-selection
 * import from foreign harness skill catalogs (Claude, Codex, zcode, installed
 * CC plugins). Mirrors main/mcp-config-ipc.ts exactly: the handler logic is
 * exported pure functions over a deps bag (unit-testable without ipcMain), zod

 * mutator returns `{ok:true, snapshot}` or a typed refusal.
 *
 * Core runtime is imported ONLY through the `@anycode/core/skills-admin`
 * subpath (never the core barrel, which would drag the ai-SDK into the thin
 * main process — same rule as `@anycode/core/mcp-admin` in mcp-config-ipc.ts).
 *
 * PATH CUSTODY INVARIANT (design §4 — the load-bearing invariant of this
 * slice): the renderer NEVER supplies a filesystem path — only `tabId` + `name`
 * (set-enabled/delete/reveal) or `tabId` + `scope` + candidate `ids` (import).
 * Every handler that touches a real path re-resolves it from a FRESH main-side
 * scan and verifies containment under an own-catalog root
 * (`ownSkillRoots`/`isUnderOwnRoots`, core's admin-scan.ts) before any
 * destructive or filesystem-revealing operation; a plugin row (or any row that
 * somehow fails containment) is refused `read_only_source`. A tampered/unknown
 * `name` simply fails the fresh-scan lookup (`not_found`) — since no handler
 * ever builds a path from a caller-supplied string, there is no path-traversal
 * surface to defend beyond that lookup.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  anycodeConfigPath,
  applySkillImport,
  buildSkillRoots,
  deleteSkillDir,
  isUnderOwnRoots,
  isUnderOwnRootsResolved,
  ownSkillRoots,
  removeDisabledEntry,
  scanHarnessSkills,
  scanSkillsAdmin,
  setSkillEnabled,
  type HarnessSkillCandidate,
  type SkillAdminRow,
} from "@anycode/core/skills-admin";
import {
  SKILLS_CREATE_CHANNEL,
  SKILLS_DELETE_CHANNEL,
  SKILLS_IMPORT_APPLY_CHANNEL,
  SKILLS_IMPORT_SCAN_CHANNEL,
  SKILLS_LIST_CHANNEL,
  SKILLS_REVEAL_CHANNEL,
  SKILLS_SET_ENABLED_CHANNEL,
} from "../shared/skills-config.js";
import type {
  SkillImportCandidateView,
  SkillRowView,
  SkillScope,
  SkillSourceKind,
  SkillsImportApplyResult,
  SkillsImportApplyResultItem,
  SkillsImportScanResult,
  SkillsMutationResult,
  SkillsRevealResult,
  SkillsSnapshot,
} from "../shared/skills-config.js";

// ── fs port (structural — matches core's FileSystemPort by shape, no core-barrel import) ──

/**
 * The file-system surface the skills-admin functions need, typed structurally
 * rather than importing core's `FileSystemPort` (no subpath exports it) — same
 * "duplicated on purpose, not value-imported" rule mcp-config-ipc.ts documents
 * for `McpConfigFs`. `lstat`/`copyFile`/`rm` are required here (unlike
 * McpConfigFs's optional set) because the skills import copier and deleter use
 * them on every call path this module exercises.
 */
export interface SkillsFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number; isSymbolicLink?: boolean }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename?(from: string, to: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number; isSymbolicLink?: boolean }>;
  copyFile(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  /** Symlink-resolved canonical path — the core own-root containment guard (P1-c) needs it; absent ⇒ delete/import fail closed. */
  realpath(path: string): Promise<string>;
  /** O_NOFOLLOW read/copy closing the import TOCTOU window (P1-b). */
  readFileNoFollow(path: string): Promise<string>;
  copyFileNoFollow(from: string, to: string): Promise<void>;
}

/** Thin node:fs/promises implementation of SkillsFs (main-process-local, no core import). */
export class NodeSkillsFs implements SkillsFs {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, "utf-8");
  }
  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    if (opts?.mode !== undefined) {
      await fsp.writeFile(path, content, { encoding: "utf-8", mode: opts.mode });
      return;
    }
    await fsp.writeFile(path, content, "utf-8");
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string) {
    const s = await fsp.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), mode: s.mode, isSymbolicLink: s.isSymbolicLink() };
  }
  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }
  async readdir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  }
  async rename(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode);
  }
  async lstat(path: string) {
    const s = await fsp.lstat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), mode: s.mode, isSymbolicLink: s.isSymbolicLink() };
  }
  async copyFile(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }
  async rm(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }
  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }
  async readFileNoFollow(path: string): Promise<string> {
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  }
  async copyFileNoFollow(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    const src = await fsp.open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await src.readFile();
      await fsp.writeFile(to, bytes);
    } finally {
      await src.close();
    }
  }
}

export interface SkillsIpcDeps {
  /** `os.homedir()` in production; `ANYCODE_SKILLS_IMPORT_HOME`-overridable at the main/index.ts wiring site (dev/test only, mirrors ANYCODE_MCP_IMPORT_HOME). */
  home(): string;
  /** Resolves the active tab's workspace from main's own tab-meta fact (tab-ipc.ts) — never a renderer-supplied path. */
  workspaceForTab(tabId: string): string | undefined;
  fs: SkillsFs;
  /** Reveals a path in the OS file manager — injected so this module stays Electron-free in tests (production wiring: `shell.showItemInFolder`). */
  reveal(path: string): void;
}

// ── name / key safety (redeclared locally — the skills-admin subpath does not export these) ──

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;  // mirrors core discovery.ts SKILL_NAME_RE exactly (max length 64)
const DANGEROUS_SKILL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isDangerousSkillName(name: string): boolean {
  return DANGEROUS_SKILL_NAMES.has(name);
}

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !isDangerousSkillName(name);
}



const scopeSchema: z.ZodType<SkillScope> = z.enum(["project", "user"]);

const listSchema = z.object({ tabId: z.string().optional() });

const setEnabledSchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
  enabled: z.boolean(),
});

const deleteSchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
});

const revealSchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
});

const createSchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  name: z.string().min(1).max(64),
  // P3-8: reject newlines / carriage returns — the description is interpolated
  // raw into flat SKILL.md frontmatter (`description: <value>`), so a multiline
  // value would silently produce an unparseable skill while reporting success.
  description: z
    .string()
    .min(1)
    .max(2000)
    .refine((d) => !/[\r\n]/.test(d), { message: "description must be single-line" }),
});

const importScanSchema = z.object({ tabId: z.string().optional() });

const importApplySchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  ids: z.array(z.string().min(1)),
});

// ── path resolution helpers ──

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

function skillsRoot(baseDir: string): string {
  return `${stripTrailingSep(baseDir)}/.anycode/skills`;
}

/** `<dir>/alpha/SKILL.md` -> `<dir>/alpha` (a `SkillAdminRow.path` is the SKILL.md file, `deleteSkillDir` wants its containing directory). */
function skillDirOf(skillMdPath: string): string {
  return skillMdPath.replace(/[/\\]SKILL\.md$/, "");
}

/**
 * Resolves a request's workspace: undefined tabId or an unknown tab yields
 * undefined (fail-soft, not a throw).
 *
 * P2-6 (ACCEPTED residual): the `tabId` is caller-supplied, so a renderer could
 * name another tab's workspace (cross-tab scope). This is CONSISTENT with the
 * entire tab-scoped IPC architecture (mcp-config-ipc et al. resolve scope from
 * the same caller-supplied tabId); the renderer is first-party with no
 * untrusted-script sink (codex cleared XSS), and every path is re-derived from a
 * FRESH main-side scan + own-root containment check, so a forged tabId cannot
 * traverse outside an own catalog — only pick a different (still own) scope.
 */
function resolveWorkspace(deps: SkillsIpcDeps, tabId: string | undefined): string | undefined {
  if (tabId === undefined) {
    return undefined;
  }
  return deps.workspaceForTab(tabId);
}

// ── row classification (list + every handler that needs to know a row's scope) ──

/**
 * Splits a raw admin row's `source` tag (`"project" | "user" | "plugin:<name>"`)
 * into the display-normalized `sourceKind`. When the request resolved NO real
 * workspace (`hasWorkspace:false`), `scanSkillsAdmin` was called with
 * `workspace===home` (the roots recipe's own collapse rule) — every
 * `"project"`-tagged root in that call is actually a home-anchored path, so
 * such rows are relabeled `"user"` here (design §5 W2: "no tab ⇒ user-only
 * roots"). This is the ONLY place that translation happens; every handler below
 * reuses it so list/setEnabled/delete/reveal agree on one row's scope.
 */
function classifyRow(row: SkillAdminRow, hasWorkspace: boolean): { sourceKind: SkillSourceKind; pluginName?: string } {
  if (row.source.startsWith("plugin:")) {
    return { sourceKind: "plugin", pluginName: row.source.slice("plugin:".length) };
  }
  if (row.source === "project" && hasWorkspace) {
    return { sourceKind: "project" };
  }
  return { sourceKind: "user" };
}

function toRowView(row: SkillAdminRow, hasWorkspace: boolean): SkillRowView {
  const { sourceKind, pluginName } = classifyRow(row, hasWorkspace);
  const view: SkillRowView = {
    name: row.name,
    description: row.description,
    source: row.source,
    sourceKind,
    enabled: !row.disabled,
    path: row.path,
  };
  if (pluginName !== undefined) {
    view.pluginName = pluginName;
  }
  return view;
}

/**
 * Builds the joined catalog snapshot. No resolvable workspace ⇒ scans with
 * `workspace===home` (buildSkillRoots' own "load once" collapse), which
 * `toRowView`/`classifyRow` in turn relabel as user-only rows.
 */
async function buildSnapshot(deps: SkillsIpcDeps, tabId: string | undefined): Promise<SkillsSnapshot> {
  const home = deps.home();
  const workspace = resolveWorkspace(deps, tabId);
  const hasWorkspace = workspace !== undefined;
  const effectiveWorkspace = workspace ?? home;

  const scan = await scanSkillsAdmin(deps.fs, { workspace: effectiveWorkspace, home });
  return {
    rows: scan.rows.map((row) => toRowView(row, hasWorkspace)),
    problems: scan.problems,
  };
}

/** Fresh-scans and finds one row by name, returning both the row and its classification (or undefined if absent). */
async function findRow(
  deps: SkillsIpcDeps,
  tabId: string | undefined,
  name: string,
): Promise<{ row: SkillAdminRow; sourceKind: SkillSourceKind; workspace: string; home: string; hasWorkspace: boolean } | undefined> {
  const home = deps.home();
  const workspace = resolveWorkspace(deps, tabId);
  const hasWorkspace = workspace !== undefined;
  const effectiveWorkspace = workspace ?? home;
  const scan = await scanSkillsAdmin(deps.fs, { workspace: effectiveWorkspace, home });
  const row = scan.rows.find((r) => r.name === name);
  if (row === undefined) {
    return undefined;
  }
  const { sourceKind } = classifyRow(row, hasWorkspace);
  return { row, sourceKind, workspace: effectiveWorkspace, home, hasWorkspace };
}

/** Config file path for a project/user-scoped row (never called for a plugin row). */
function scopeConfigPath(sourceKind: "project" | "user", workspace: string, home: string): string {
  return sourceKind === "project" ? anycodeConfigPath(workspace) : anycodeConfigPath(home);
}

// ── handlers (exported for unit tests) ──

/** skills-list: the joined project/user/plugin snapshot. Always succeeds (fail-soft internally). */
export async function handleSkillsList(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsSnapshot> {
  const parsed = listSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  return buildSnapshot(deps, tabId);
}

/**
 * skills-set-enabled: patches ONLY `skills.disabled` in the row's owning scope
 * config file (project row ⇒ workspace config, user row ⇒ home config).
 * Refuses `invalid` (bad payload), `not_found` (no such skill in a fresh scan),
 * and `read_only_source` (a plugin row — no writer for a plugin's catalog).
 */
export async function handleSkillsSetEnabled(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsMutationResult> {
  const parsed = setEnabledSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name, enabled } = parsed.data;
  const found = await findRow(deps, tabId, name);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  const configPath = scopeConfigPath(found.sourceKind, found.workspace, found.home);
  try {
    await setSkillEnabled(deps.fs, configPath, name, enabled);
  } catch (error) {
    console.warn(`[skills-ipc] setEnabled failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * skills-delete: deletes an own-catalog skill directory (path resolved from a
 * FRESH scan, never a caller-supplied path) and cleans up any stale
 * `skills.disabled` entry in the same scope's config file. `deleteSkillDir`
 * itself re-verifies containment under `ownSkillRoots` — a plugin row's path
 * never lies under those roots, so it is refused there too (defense in depth);
 * the pre-check below refuses it earlier with the correct reason.
 */
export async function handleSkillsDelete(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsMutationResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name } = parsed.data;
  const found = await findRow(deps, tabId, name);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  const roots = ownSkillRoots(found.workspace, found.home);
  const result = await deleteSkillDir(deps.fs, skillDirOf(found.row.path), roots);
  if (!result.ok) {
    return { ok: false, reason: result.reason === "outside_own_roots" ? "read_only_source" : "io_error" };
  }
  const configPath = scopeConfigPath(found.sourceKind, found.workspace, found.home);
  try {
    await removeDisabledEntry(deps.fs, configPath, name);
  } catch (error) {
    console.warn(`[skills-ipc] removeDisabledEntry failed for ${configPath}`, error);
    // The directory is already gone — do not fail the whole delete over a
    // best-effort disabled-list cleanup.
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * skills-reveal: resolves the skill's path from a FRESH scan, verifies
 * containment under an own-catalog root, and hands it to `deps.reveal` (prod:
 * `shell.showItemInFolder`). Non-mutating, but subject to the SAME custody rule
 * as delete (design §4): a plugin row's path is refused `read_only_source`.
 */
export async function handleSkillsReveal(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsRevealResult> {
  const parsed = revealSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name } = parsed.data;
  const found = await findRow(deps, tabId, name);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  const roots = ownSkillRoots(found.workspace, found.home);
  if (!isUnderOwnRoots(found.row.path, roots)) {
    return { ok: false, reason: "read_only_source" };
  }
  try {
    deps.reveal(found.row.path);
  } catch (error) {
    console.warn("[skills-ipc] reveal failed", error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true };
}

/**
 * skills-create: scaffolds `<scope-root>/.anycode/skills/<name>/SKILL.md` from
 * a minimal template. Refuses `invalid` (bad payload or a name failing
 * `SKILL_NAME_RE`/the proto-key guard), `no_workspace` (scope `project` with no
 * resolvable tab workspace), and `invalid` again when the target already exists
 * (never clobbers an existing skill).
 */
export async function handleSkillsCreate(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsMutationResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, scope, name, description } = parsed.data;
  if (!isValidSkillName(name)) {
    return { ok: false, reason: "invalid" };
  }
  const home = deps.home();
  let root: string;
  let ownRoots: string[];
  if (scope === "project") {
    const workspace = resolveWorkspace(deps, tabId);
    if (workspace === undefined) {
      return { ok: false, reason: "no_workspace" };
    }
    root = skillsRoot(workspace);
    ownRoots = ownSkillRoots(workspace, home);
  } else {
    root = skillsRoot(home);
    ownRoots = ownSkillRoots(home, home);
  }
  const skillDir = `${root}/${name}`;
  const skillMdPath = `${skillDir}/SKILL.md`;
  // P1-2: prove the scaffold target is a REAL own-catalog directory
  // (symlink-resolved) before writing — the same own-root containment guard the
  // delete/import paths enforce. A symlinked `.anycode/skills -> /tmp/out` (or a
  // dangling one) is refused here, so create can never follow the link and
  // scaffold outside a real own catalog.
  if (!(await isUnderOwnRootsResolved(deps.fs, skillDir, ownRoots))) {
    return { ok: false, reason: "io_error" };
  }
  try {
    if (await deps.fs.exists(skillMdPath)) {
      return { ok: false, reason: "invalid" };
    }
    const template = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe what this skill does and when to use it.\n`;
    await deps.fs.writeFile(skillMdPath, template);
  } catch (error) {
    console.warn(`[skills-ipc] create failed for ${skillMdPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

function toCandidateView(candidate: HarnessSkillCandidate): SkillImportCandidateView {
  return {
    id: candidate.id,
    harness: candidate.harness,
    sourceDir: candidate.sourceDir,
    name: candidate.name,
    description: candidate.description,
    compatible: candidate.compatible,
    needsConversion: candidate.needsConversion,
    conversionNotes: candidate.conversionNotes,
    alreadyPresent: candidate.alreadyPresent,
  };
}

/**
 * skills-import-scan: fans out over the fixed foreign-harness allowlist (W1's
 * `scanHarnessSkills`, itself path-safe — no caller-supplied paths). `home`
 * comes from `deps.home()`, which the main/index.ts wiring resolves via
 * `ANYCODE_SKILLS_IMPORT_HOME` under the same dev/automation double gate as the
 * MCP import (`resolveMcpImportHome` precedent) — a packaged build always scans
 * the real `os.homedir()`. Always succeeds (fail-soft internally).
 */
export async function handleSkillsImportScan(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsImportScanResult> {
  const parsed = importScanSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  const workspace = resolveWorkspace(deps, tabId) ?? "";
  const home = deps.home();
  const candidates = await scanHarnessSkills(deps.fs, home, workspace);
  return { candidates: candidates.map(toCandidateView), problems: [] };
}

function toApplyResultItem(id: string, result: { name: string; applied: boolean; suffixed: boolean; converted: boolean; skipped?: "incompatible" | "unsafe_name" | "io_error"; notes: string[] }): SkillsImportApplyResultItem {
  const item: SkillsImportApplyResultItem = {
    id,
    name: result.name,
    applied: result.applied,
    suffixed: result.suffixed,
    converted: result.converted,
    notes: result.notes,
  };
  if (result.skipped !== undefined) {
    item.skipped = result.skipped;
  }
  return item;
}

/**
 * skills-import-apply: re-scans the same allowlist (main is stateless between
 * scan and apply — no scan-result caching), filters to the consented candidate
 * `ids` (identity, never bare `name` — two harnesses can share a name), and
 * calls W1's `applySkillImport` against `<scope>/.anycode/skills`. Conversion,
 * conflict-suffixing, and the copy-custody guards (symlink refusal, size/depth
 * caps) are W1's guarantee — this handler does not re-implement or undo them.
 * `scope:"project"` with no resolvable tab workspace is refused `no_workspace`.
 */
export async function handleSkillsImportApply(deps: SkillsIpcDeps, raw: unknown): Promise<SkillsImportApplyResult> {
  const parsed = importApplySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, scope, ids } = parsed.data;
  let targetRoot: string;
  if (scope === "project") {
    const workspace = resolveWorkspace(deps, tabId);
    if (workspace === undefined) {
      return { ok: false, reason: "no_workspace" };
    }
    targetRoot = skillsRoot(workspace);
  } else {
    targetRoot = skillsRoot(deps.home());
  }

  const home = deps.home();
  const scanWorkspace = resolveWorkspace(deps, tabId) ?? "";
  const idSet = new Set(ids);

  let results: SkillsImportApplyResultItem[];
  try {
    const scan = await scanHarnessSkills(deps.fs, home, scanWorkspace);
    const selected = scan.filter((c) => idSet.has(c.id));
    // P1-c: pass the own-catalog roots so applySkillImport proves targetRoot is a
    // REAL own root (symlink-resolved) before writing — a symlinked
    // `.anycode/skills` can never redirect the import outside the catalog.
    const importRoots = ownSkillRoots(scanWorkspace === "" ? home : scanWorkspace, home);
    const applied = await applySkillImport(deps.fs, targetRoot, selected, importRoots);
    results = applied.map((r) => toApplyResultItem(r.id, r));
  } catch (error) {
    console.warn(`[skills-ipc] import-apply failed for ${targetRoot}`, error);
    return { ok: false, reason: "io_error" };
  }

  return { ok: true, results, snapshot: await buildSnapshot(deps, tabId) };
}

/** Wires the seven channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerSkillsIpc(deps: SkillsIpcDeps): void {
  ipcMain.handle(SKILLS_LIST_CHANNEL, (_event, raw: unknown) => handleSkillsList(deps, raw));
  ipcMain.handle(SKILLS_SET_ENABLED_CHANNEL, (_event, raw: unknown) => handleSkillsSetEnabled(deps, raw));
  ipcMain.handle(SKILLS_DELETE_CHANNEL, (_event, raw: unknown) => handleSkillsDelete(deps, raw));
  ipcMain.handle(SKILLS_CREATE_CHANNEL, (_event, raw: unknown) => handleSkillsCreate(deps, raw));
  ipcMain.handle(SKILLS_REVEAL_CHANNEL, (_event, raw: unknown) => handleSkillsReveal(deps, raw));
  ipcMain.handle(SKILLS_IMPORT_SCAN_CHANNEL, (_event, raw: unknown) => handleSkillsImportScan(deps, raw));
  ipcMain.handle(SKILLS_IMPORT_APPLY_CHANNEL, (_event, raw: unknown) => handleSkillsImportApply(deps, raw));
}

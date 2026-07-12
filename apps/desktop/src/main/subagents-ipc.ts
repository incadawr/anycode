/**
 * Subagents editor control-plane IPC (design slice-P7.21-cut.md §4 W2).
 * Registers `ipcMain.handle` for the seven channels in
 * shared/subagents-config.ts: a read-only joined built-in/project/user/plugin
 * catalog view, read/save/create/delete/reveal of one own-catalog agent
 * profile, and a preview of the REAL final child system prompt a draft would
 * spawn with. Mirrors main/skills-ipc.ts exactly: handler logic is exported
 * pure functions over a deps bag (unit-testable without ipcMain), zod

 * mutator returns `{ok:true, snapshot}` or a typed refusal.
 *
 * Core runtime is imported ONLY through the `@anycode/core/subagents-admin`
 * subpath (never the core barrel, which would drag the ai-SDK into the thin
 * main process — same rule as `@anycode/core/skills-admin` in skills-ipc.ts).
 *
 * PATH CUSTODY INVARIANT (design §2-D7 — the load-bearing invariant of this
 * slice): the renderer NEVER supplies a filesystem path — only `tabId` +
 * `name` + `sourceKind` (read/save/delete/reveal — identity is the PAIR, not
 * `name` alone) or `tabId` + `scope` + `draft` (create). Every handler that
 * touches a real path re-resolves it from a FRESH main-side scan
 * (`scanAgentProfilesAdmin`) and verifies containment under an own-catalog
 * root (`ownAgentRoots`/`isUnderOwnRootsResolved`, core's admin-scan.ts /
 * path-containment.ts) before any destructive or filesystem-revealing
 * operation; a `builtin` row (no file at all) or a `plugin` row (foreign,
 * read-only) is refused `read_only_source`. A tampered/unknown `name`, or a
 * `sourceKind` that no longer matches a fresh scan's classification of that
 * name, fails the lookup (`not_found`) — since no handler ever builds a path
 * from a caller-supplied string, there is no path-traversal surface to defend
 * beyond that lookup.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  createAgentProfile,
  deleteAgentProfile,
  buildProfilePreview,
  effectiveProfileTools,
  isUnderOwnRootsResolved,
  listPersonaNames,
  ownAgentRoots,
  parseAgentProfileMd,
  PERSONAS,
  saveAgentProfile,
  scanAgentProfilesAdmin,
  type AgentProfileAdminRow,
  type AgentProfileSourceKind,
  type PersonaDefinition,
  type WriteRefusal,
} from "@anycode/core/subagents-admin";
import {
  SUBAGENTS_CREATE_CHANNEL,
  SUBAGENTS_DELETE_CHANNEL,
  SUBAGENTS_LIST_CHANNEL,
  SUBAGENTS_PREVIEW_CHANNEL,
  SUBAGENTS_READ_CHANNEL,
  SUBAGENTS_REVEAL_CHANNEL,
  SUBAGENTS_SAVE_CHANNEL,
} from "../shared/subagents-config.js";
import type {
  SubagentProfileDraft,
  SubagentReadResult,
  SubagentRowView,
  SubagentScope,
  SubagentSourceKind,
  SubagentsMutationResult,
  SubagentsPreviewResult,
  SubagentsRefusalReason,
  SubagentsRevealResult,
  SubagentsSnapshot,
} from "../shared/subagents-config.js";

// ── fs port (structural — matches core's FileSystemPort by shape, no core-barrel import) ──

/**
 * The file-system surface the subagents-admin functions need, typed
 * structurally rather than importing core's `FileSystemPort` (no subpath
 * exports it) — same "duplicated on purpose, not value-imported" rule
 * skills-ipc.ts documents for `SkillsFs`. `lstat`/`realpath`/`rm` are required
 * (unlike some optional-heavy ports) because the containment guard and
 * delete/rename paths this module exercises use them on every call.
 */
export interface SubagentsFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number; isSymbolicLink?: boolean }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename?(from: string, to: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number; isSymbolicLink?: boolean }>;
  rm(path: string): Promise<void>;
  /** Symlink-resolved canonical path — the core own-root containment guard needs it; absent ⇒ create/save/delete/reveal fail closed. */
  realpath(path: string): Promise<string>;
  /** O_NOFOLLOW read — reading a profile file must never follow a symlink out of the catalog (closes the lstat→read TOCTOU on the read path). */
  readFileNoFollow(path: string): Promise<string>;
}

/** Thin node:fs/promises implementation of SubagentsFs (main-process-local, no core import). */
export class NodeSubagentsFs implements SubagentsFs {
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
  async rm(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }
  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }
  async readFileNoFollow(path: string): Promise<string> {
    // O_NOFOLLOW fails the open() with ELOOP if the final component is a symlink.
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  }
}

export interface SubagentsIpcDeps {
  /** `os.homedir()` in production; dev/automation-overridable at the main/index.ts wiring site (mirrors ANYCODE_SKILLS_IMPORT_HOME). */
  home(): string;
  /** Resolves the active tab's workspace from main's own tab-meta fact (tab-ipc.ts) — never a renderer-supplied path. */
  workspaceForTab(tabId: string): string | undefined;
  fs: SubagentsFs;
  /** Reveals a path in the OS file manager — injected so this module stays Electron-free in tests (production wiring: `shell.showItemInFolder`). */
  reveal(path: string): void;
}



const sourceKindSchema: z.ZodType<SubagentSourceKind> = z.enum(["builtin", "project", "user", "plugin"]);
const scopeSchema: z.ZodType<SubagentScope> = z.enum(["project", "user"]);

const draftSchema: z.ZodType<SubagentProfileDraft> = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(2000),
  tools: z.array(z.string()).optional(),
  body: z.string(),
});

const listSchema = z.object({ tabId: z.string().optional() });

const identitySchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
  sourceKind: sourceKindSchema,
});

const readSchema = identitySchema;
const deleteSchema = identitySchema;
const revealSchema = identitySchema;

const saveSchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
  sourceKind: sourceKindSchema,
  draft: draftSchema,
});

const createSchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  draft: draftSchema,
});

const previewSchema = z.object({
  draft: draftSchema,
});

// ── path / root helpers ──

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

/** `<baseDir>/.anycode/agents` — the ONE writable root for a given scope. */
function agentsRootFor(scope: SubagentScope, workspace: string, home: string): string {
  const base = scope === "project" ? workspace : home;
  return `${stripTrailingSep(base)}/.anycode/agents`;
}

/**
 * Resolves a request's workspace: undefined tabId or an unknown tab yields
 * undefined (fail-soft, not a throw). Same P2-6 accepted residual as
 * skills-ipc.ts's resolveWorkspace: a forged tabId can only pick a different
 * (still own) scope, never escape own-root containment.
 */
function resolveWorkspace(deps: SubagentsIpcDeps, tabId: string | undefined): string | undefined {
  if (tabId === undefined) {
    return undefined;
  }
  return deps.workspaceForTab(tabId);
}

// ── tools badge (design §1.5: general-purpose = "All tools", explore = "6 tools") ──

/** The full non-spawn tool count a profile can request — general-purpose's own list IS this baseline. */
const FULL_TOOL_COUNT = effectiveProfileTools(PERSONAS["general-purpose"].tools).length;

function toolsBadgeFor(toolCount: number): string {
  return toolCount >= FULL_TOOL_COUNT ? "All tools" : `${toolCount} tools`;
}

// ── row classification (list + every handler that needs to know a row's scope) ──

/**
 * Splits a raw admin row's `sourceKind` ("project" | "user" | "plugin") into
 * the display-normalized kind, translating "project" to "user" when the
 * request resolved NO real workspace — `scanAgentProfilesAdmin` was called
 * with `workspace===home` (the roots recipe's own collapse rule), so every
 * "project"-tagged root in that call is actually the home-anchored catalog
 * (design §4 W2, exact mirror of skills-ipc.ts's `classifyRow`).
 */
function classifySourceKind(
  row: AgentProfileAdminRow,
  hasWorkspace: boolean,
): { sourceKind: SubagentSourceKind; pluginName?: string } {
  if (row.sourceKind === "plugin") {
    const pluginName = row.source.startsWith("plugin:") ? row.source.slice("plugin:".length) : row.source;
    return { sourceKind: "plugin", pluginName };
  }
  if (row.sourceKind === "project" && hasWorkspace) {
    return { sourceKind: "project" };
  }
  return { sourceKind: "user" };
}

function toBuiltinRowView(persona: PersonaDefinition): SubagentRowView {
  const toolCount = effectiveProfileTools(persona.tools).length;
  return {
    name: persona.name,
    description: persona.description,
    toolsBadge: toolsBadgeFor(toolCount),
    toolCount,
    source: "builtin",
    sourceKind: "builtin",
    editable: false,
  };
}

function toRowView(row: AgentProfileAdminRow, hasWorkspace: boolean): SubagentRowView {
  const { sourceKind, pluginName } = classifySourceKind(row, hasWorkspace);
  const toolCount = effectiveProfileTools(row.tools).length;
  const view: SubagentRowView = {
    name: row.name,
    description: row.description,
    toolsBadge: toolsBadgeFor(toolCount),
    toolCount,
    source: row.source,
    sourceKind,
    path: row.path,
    editable: sourceKind === "project" || sourceKind === "user",
  };
  if (pluginName !== undefined) {
    view.pluginName = pluginName;
  }
  return view;
}

/**
 * Builds the joined snapshot: built-in personas prepended main-side (§4 W2),
 * then the admin-scan catalog rows. No resolvable workspace ⇒ scans with
 * `workspace===home` (buildAgentProfileRoots' own "load once" collapse),
 * which `toRowView`/`classifySourceKind` in turn relabel as user-only rows.
 */
async function buildSnapshot(deps: SubagentsIpcDeps, tabId: string | undefined): Promise<SubagentsSnapshot> {
  const home = deps.home();
  const workspace = resolveWorkspace(deps, tabId);
  const hasWorkspace = workspace !== undefined;
  const effectiveWorkspace = workspace ?? home;

  const scan = await scanAgentProfilesAdmin(deps.fs, { workspace: effectiveWorkspace, home });
  const builtinRows = listPersonaNames().map((name) => toBuiltinRowView(PERSONAS[name]));
  const catalogRows = scan.rows.map((row) => toRowView(row, hasWorkspace));
  return {
    rows: [...builtinRows, ...catalogRows],
    problems: scan.problems,
  };
}

interface FoundRow {
  row: AgentProfileAdminRow;
  sourceKind: SubagentSourceKind;
  workspace: string;
  home: string;
  hasWorkspace: boolean;
}

/**
 * Fresh-scans and finds one CATALOG row (never a builtin — those have no
 * file) whose classified `sourceKind` matches the caller's expectation. A
 * mismatch (stale renderer identity, tampered payload) yields `undefined` —
 * the caller reports `not_found`, never leaking WHY the identity failed.
 */
async function findRow(
  deps: SubagentsIpcDeps,
  tabId: string | undefined,
  name: string,
  expectedSourceKind: SubagentSourceKind,
): Promise<FoundRow | undefined> {
  if (expectedSourceKind === "builtin") {
    return undefined;
  }
  const home = deps.home();
  const workspace = resolveWorkspace(deps, tabId);
  const hasWorkspace = workspace !== undefined;
  const effectiveWorkspace = workspace ?? home;
  const scan = await scanAgentProfilesAdmin(deps.fs, { workspace: effectiveWorkspace, home });
  const row = scan.rows.find((r) => r.name === name);
  if (row === undefined) {
    return undefined;
  }
  const { sourceKind } = classifySourceKind(row, hasWorkspace);
  if (sourceKind !== expectedSourceKind) {
    return undefined;
  }
  return { row, sourceKind, workspace: effectiveWorkspace, home, hasWorkspace };
}

/** Maps core's write-refusal vocabulary onto this module's 7-reason surface (design §4 W2). */
function mapWriteRefusal(reason: WriteRefusal): SubagentsRefusalReason {
  switch (reason) {
    case "reserved_name":
      return "reserved_name";
    case "validation_failed":
      return "validation_failed";
    case "name_conflict":
      return "invalid";
    case "outside_own_roots":
    case "io_error":
      return "io_error";
  }
}

// ── handlers (exported for unit tests) ──

/** subagents-list: the joined built-in/project/user/plugin snapshot. Always succeeds (fail-soft internally). */
export async function handleSubagentsList(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentsSnapshot> {
  const parsed = listSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  return buildSnapshot(deps, tabId);
}

/**
 * subagents-read: resolves the profile's path from a FRESH scan, re-parses
 * the file with the SAME oracle discovery uses, and returns an editable draft
 * + the raw md. Refuses `read_only_source` for a `builtin` (no file) or
 * `plugin` (foreign, read-only) row, `not_found` for a tampered/unknown
 * `(name, sourceKind)` pair, `io_error` if the file cannot be read/parsed.
 */
export async function handleSubagentsRead(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentReadResult> {
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name, sourceKind } = parsed.data;
  if (sourceKind === "builtin") {
    return { ok: false, reason: "read_only_source" };
  }
  const found = await findRow(deps, tabId, name, sourceKind);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  // P7.21 W1-FIX #2: prove the resolved path is under an own-catalog root
  // (symlink-resolved) BEFORE reading, and read with O_NOFOLLOW so a profile file
  // that is itself a symlink can never stream out-of-catalog content into the
  // editor. The admin scan already drops symlinked profile files, but a
  // scan→read swap (TOCTOU) is defeated here at the read syscall.
  const ownRoots = ownAgentRoots(found.workspace, found.home);
  if (!(await isUnderOwnRootsResolved(deps.fs, found.row.path, ownRoots))) {
    return { ok: false, reason: "read_only_source" };
  }
  let rawMd: string;
  try {
    rawMd = await deps.fs.readFileNoFollow(found.row.path);
  } catch (error) {
    console.warn(`[subagents-ipc] read failed for ${found.row.path}`, error);
    return { ok: false, reason: "io_error" };
  }
  const parsedProfile = parseAgentProfileMd(rawMd, found.row.name);
  if ("error" in parsedProfile) {
    console.warn(`[subagents-ipc] re-parse failed for ${found.row.path}`, parsedProfile.error);
    return { ok: false, reason: "io_error" };
  }
  const { name: parsedName, description, tools, toolsExplicit, body } = parsedProfile.ok;
  const draft: SubagentProfileDraft = {
    name: parsedName,
    description,
    body,
    ...(toolsExplicit ? { tools: [...tools] } : {}),
  };
  return { ok: true, draft, raw: rawMd };
}

/**
 * subagents-save: resolves the EXISTING file's path from a FRESH scan (never a
 * caller-supplied path), then saves the draft into the SAME scope's root
 * (`saveAgentProfile` — a name change in `draft.name` is a rename, write-new +
 * delete-old inside one serialized section, both ends containment-checked).
 * Refuses `read_only_source` on a `builtin`/`plugin` identity, `not_found` on
 * a tampered/unknown `(name, sourceKind)` pair, `reserved_name`/
 * `validation_failed` on a draft the loader would reject.
 */
export async function handleSubagentsSave(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentsMutationResult> {
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name, sourceKind, draft } = parsed.data;
  if (sourceKind === "builtin") {
    return { ok: false, reason: "read_only_source" };
  }
  const found = await findRow(deps, tabId, name, sourceKind);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  const scope: SubagentScope = found.sourceKind === "project" ? "project" : "user";
  const targetRoot = agentsRootFor(scope, found.workspace, found.home);
  const ownRoots = ownAgentRoots(found.workspace, found.home);
  const result = await saveAgentProfile(deps.fs, found.row.path, targetRoot, draft, ownRoots);
  if (!result.ok) {
    return { ok: false, reason: mapWriteRefusal(result.reason), issues: result.issues };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * subagents-create: scaffolds a NEW profile at `<scope-root>/.anycode/agents/<name>.md`.
 * Refuses `no_workspace` (scope `project` with no resolvable tab workspace),
 * `reserved_name`/`validation_failed` (a draft the loader would reject), and
 * whatever `createAgentProfile` itself refuses (name conflict, containment).
 */
export async function handleSubagentsCreate(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentsMutationResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, scope, draft } = parsed.data;
  const home = deps.home();
  let workspace: string;
  if (scope === "project") {
    const resolved = resolveWorkspace(deps, tabId);
    if (resolved === undefined) {
      return { ok: false, reason: "no_workspace" };
    }
    workspace = resolved;
  } else {
    workspace = home;
  }
  const targetRoot = agentsRootFor(scope, workspace, home);
  const ownRoots = ownAgentRoots(workspace, home);
  const result = await createAgentProfile(deps.fs, targetRoot, draft, ownRoots);
  if (!result.ok) {
    return { ok: false, reason: mapWriteRefusal(result.reason), issues: result.issues };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * subagents-delete: deletes an own-catalog profile file (path resolved from a
 * FRESH scan, never a caller-supplied path). `deleteAgentProfile` re-verifies
 * containment under `ownAgentRoots` — a builtin/plugin row's identity never
 * even reaches it (refused above), and a foreign path never lies under those
 * roots either (defense in depth).
 */
export async function handleSubagentsDelete(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentsMutationResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name, sourceKind } = parsed.data;
  if (sourceKind === "builtin") {
    return { ok: false, reason: "read_only_source" };
  }
  const found = await findRow(deps, tabId, name, sourceKind);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  const ownRoots = ownAgentRoots(found.workspace, found.home);
  const result = await deleteAgentProfile(deps.fs, found.row.path, ownRoots);
  if (!result.ok) {
    return { ok: false, reason: result.reason === "outside_own_roots" ? "read_only_source" : "io_error" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * subagents-reveal: resolves the profile's path from a FRESH scan, verifies
 * containment under an own-catalog root, and hands it to `deps.reveal` (prod:
 * `shell.showItemInFolder`). Non-mutating, but subject to the SAME custody
 * rule as delete (design §2-D7): a builtin/plugin identity is refused
 * `read_only_source`.
 */
export async function handleSubagentsReveal(deps: SubagentsIpcDeps, raw: unknown): Promise<SubagentsRevealResult> {
  const parsed = revealSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name, sourceKind } = parsed.data;
  if (sourceKind === "builtin") {
    return { ok: false, reason: "read_only_source" };
  }
  const found = await findRow(deps, tabId, name, sourceKind);
  if (found === undefined) {
    return { ok: false, reason: "not_found" };
  }
  if (found.sourceKind === "plugin") {
    return { ok: false, reason: "read_only_source" };
  }
  const ownRoots = ownAgentRoots(found.workspace, found.home);
  if (!(await isUnderOwnRootsResolved(deps.fs, found.row.path, ownRoots))) {
    return { ok: false, reason: "read_only_source" };
  }
  try {
    deps.reveal(found.row.path);
  } catch (error) {
    console.warn("[subagents-ipc] reveal failed", error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true };
}

/**
 * subagents-preview: computes the REAL final child system prompt the current
 * editor draft would spawn with, via the SAME `buildProfilePreview` the core
 * admin surface exports (design §2-D4 — no lookalike, the actual builder).
 * Pure/sync/deps-free — a preview never touches disk or `ipcMain`'s deps bag.
 */
export function handleSubagentsPreview(raw: unknown): SubagentsPreviewResult {
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const preview = buildProfilePreview(parsed.data.draft);
  return { ok: true, systemPrompt: preview.systemPrompt, effectiveTools: preview.effectiveTools };
}

/** Wires the seven channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerSubagentsIpc(deps: SubagentsIpcDeps): void {
  ipcMain.handle(SUBAGENTS_LIST_CHANNEL, (_event, raw: unknown) => handleSubagentsList(deps, raw));
  ipcMain.handle(SUBAGENTS_READ_CHANNEL, (_event, raw: unknown) => handleSubagentsRead(deps, raw));
  ipcMain.handle(SUBAGENTS_SAVE_CHANNEL, (_event, raw: unknown) => handleSubagentsSave(deps, raw));
  ipcMain.handle(SUBAGENTS_CREATE_CHANNEL, (_event, raw: unknown) => handleSubagentsCreate(deps, raw));
  ipcMain.handle(SUBAGENTS_DELETE_CHANNEL, (_event, raw: unknown) => handleSubagentsDelete(deps, raw));
  ipcMain.handle(SUBAGENTS_REVEAL_CHANNEL, (_event, raw: unknown) => handleSubagentsReveal(deps, raw));
  ipcMain.handle(SUBAGENTS_PREVIEW_CHANNEL, (_event, raw: unknown) => handleSubagentsPreview(raw));
}

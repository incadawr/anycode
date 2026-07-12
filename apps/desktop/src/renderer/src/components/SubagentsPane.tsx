/**
 * Subagents settings pane (P7.21/F21 W3, design/slice-P7.21-cut.md §1/§4 W3):
 * the Subagents management page — a read-only "Built-in subagents"
 * group (robot icon, `Built-in` + tools-count badges, monospace `built-in:<name>`
 * id line, verbatim right-note), an editable "User subagents" group
 * (name/tools-badge/description + edit/delete/reveal affordances), a read-only
 * "Plugin subagents" group when present, an amber "N profile(s) failed to load"
 * expandable strip for `problems[]`, a search+source-filter toolbar, header
 * actions (create/reveal/refresh), and an in-app editor with an Edit/Preview tab
 * pair: Preview calls the REAL
 * `buildSubagentSystemPrompt` builder through `subagents.preview`, never a
 * lookalike. Structural sibling of SkillsPane.tsx (same DI/bridge/dialog/row-list
 * shape, F23 precedent) — reuses its `settings-*`/`mcp-*`/`skills-*` CSS
 * vocabulary rather than inventing a new design system; anything genuinely
 * subagent-shaped gets its own additive `subagents-*` class.
 *
 * REF-PNG INVARIANTS (design §1 — LAW for this wave): built-in rows render
 * [robot icon, bold name, `Built-in` badge, tools badge ("All tools"/"N tools"),
 * muted one-line description, monospace `built-in:<name>` id line] and carry
 * NO mutation affordance at all; the right-aligned note on the Built-in group
 * reads verbatim "Built-in profiles are runtime defaults and cannot be edited
 * here."; group order is Built-in -> User -> Plugin.
 *
 * DATA: `SubagentsSnapshot` is fetched via the bridge on mount and REFETCHED
 * FROM THE RETURNED SNAPSHOT after every mutation (never a second `list()`
 * round-trip) — same discipline as SkillsPane/McpServersPane. Subagent

 * the "Changes apply to newly started tasks" hint.
 *
 * PATH CUSTODY (design §2-D7 — the load-bearing invariant of this slice): this
 * component NEVER sends a filesystem path back to main. Read/save/delete/reveal
 * requests carry only `(tabId?, name, sourceKind)` — main re-resolves the real
 * path from its own fresh admin scan. `SubagentRowView.path` DOES cross to the
 * renderer (display-only, trusted-config custody) but is never sent back as a
 * request field.
 *
 * BUILT-IN ROWS ARE READ-ONLY (design §2-D2 / §4): a builtin-sourced row renders
 * NO edit/delete/reveal control at all — `row.editable` (computed main-side)
 * gates the whole controls cell, and main independently refuses
 * `read_only_source` for any mutator/reveal on a builtin/plugin identity, so
 * this is belt-and-suspenders, not the only enforcement point.
 */
import { useEffect, useRef, useState } from "react";
import type {
  SubagentProfileDraft,
  SubagentReadResult,
  SubagentRowView,
  SubagentScope,
  SubagentSourceKind,
  SubagentsCreateRequest,
  SubagentsDeleteRequest,
  SubagentsListRequest,
  SubagentsMutationResult,
  SubagentsPreviewRequest,
  SubagentsPreviewResult,
  SubagentsReadRequest,
  SubagentsRefusalReason,
  SubagentsRevealRequest,
  SubagentsRevealResult,
  SubagentsSaveRequest,
  SubagentsSnapshot,
} from "../../../shared/subagents-config.js";
import { Chevron, FileIcon, Folder, Pencil, Plus, Robot, Search, Spinner, Trash, X } from "./icons.js";

// ── bridge (DI, same ethic as SkillsPane.tsx's SkillsBridge) ──

/** Subset of `window.anycode.subagents` this pane drives, injectable so tests never touch a real `window`. */
export interface SubagentsBridge {
  list(req?: SubagentsListRequest): Promise<SubagentsSnapshot>;
  read(req: SubagentsReadRequest): Promise<SubagentReadResult>;
  save(req: SubagentsSaveRequest): Promise<SubagentsMutationResult>;
  create(req: SubagentsCreateRequest): Promise<SubagentsMutationResult>;
  delete(req: SubagentsDeleteRequest): Promise<SubagentsMutationResult>;
  reveal(req: SubagentsRevealRequest): Promise<SubagentsRevealResult>;
  preview(req: SubagentsPreviewRequest): Promise<SubagentsPreviewResult>;
}

// ── pure helpers (unit-tested directly — see SubagentsPane.test.ts) ──

export type SubagentsSourceFilter = "all" | SubagentSourceKind;

/** Trivial substring filter over name+description (same ethic as SkillsPane's filterSkillRows — no fuzzy engine). */
export function filterSubagentRows(rows: readonly SubagentRowView[], query: string): SubagentRowView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter(
    (row) => row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
  );
}

export function filterSubagentsBySource(
  rows: readonly SubagentRowView[],
  filter: SubagentsSourceFilter,
): SubagentRowView[] {
  if (filter === "all") {
    return [...rows];
  }
  return rows.filter((row) => row.sourceKind === filter);
}

/** Alphabetical, stable — applied to the User/Plugin groups only; the Built-in group keeps the backend's registration order (design §1: general-purpose before explore, mirroring `PERSONAS` insertion order, NOT alphabetical). */
export function sortSubagentRows(rows: readonly SubagentRowView[]): SubagentRowView[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export interface SubagentRowSections {
  /** "Built-in subagents" — read-only, order preserved (design §1 group 1). */
  builtin: SubagentRowView[];
  /** "User subagents" — project+user combined, editable (design §1 group 2). */
  user: SubagentRowView[];
  /** "Plugin subagents" — read-only (design §1 group 3). */
  plugin: SubagentRowView[];
}

/** Splits the joined+filtered rows into the three reference groups (§1.3/§1.4). */
export function partitionSubagentRows(rows: readonly SubagentRowView[]): SubagentRowSections {
  const builtin: SubagentRowView[] = [];
  const user: SubagentRowView[] = [];
  const plugin: SubagentRowView[] = [];
  for (const row of rows) {
    if (row.sourceKind === "builtin") {
      builtin.push(row);
    } else if (row.sourceKind === "plugin") {
      plugin.push(row);
    } else {
      user.push(row);
    }
  }
  return { builtin, user, plugin };
}

/** Small source badge for a User-group row (project vs user) — additive beyond the ref-PNG's built-in-only badge law, same idea as SkillsPane's Workspace/Personal badge. */
export function userRowSourceBadgeLabel(kind: SubagentSourceKind): string {
  switch (kind) {
    case "project":
      return "Workspace";
    case "user":
      return "Personal";
    case "builtin":
    case "plugin":
      return "";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Built-in rows carry no mutation affordance (design §2-D2); `row.editable` (main-computed) is the actual gate, this is a thin readable wrapper. */
export function canManageSubagentRow(row: SubagentRowView): boolean {
  return row.editable;
}

/** The monospace id line on a built-in card — literal `built-in:<name>` (design §1.3), independent of the internal `sourceKind` spelling ("builtin"). */
export function builtinIdLine(name: string): string {
  return `built-in:${name}`;
}

/** "N profile(s) failed to load" — literal reference wording (§1 point 4), deliberately not pluralization-aware (F23 precedent). */
export function problemsStripLabel(problems: readonly string[]): string {
  return `${problems.length} profile(s) failed to load`;
}

export function subagentRefusalMessage(reason: SubagentsRefusalReason): string {
  switch (reason) {
    case "invalid":
      return "That request wasn't valid — check the fields and try again.";
    case "no_workspace":
      return "No project is open — open a workspace to manage a project-scoped subagent.";
    case "read_only_source":
      return "This subagent is built-in or registered by a plugin — it can't be edited here.";
    case "not_found":
      return "That subagent no longer exists — try refreshing.";
    case "io_error":
      return "Couldn't save — the profile file couldn't be read or written.";
    case "reserved_name":
      return "That name is reserved by a built-in subagent — choose another.";
    case "validation_failed":
      return "That profile isn't valid — check the fields below.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The header's "open-folder" action reveals the folder of the first editable (project/user) row present — there is no dedicated "reveal empty root" channel (design §4 W2's 7 channels are identity-scoped), so this reuses the per-row reveal wired to a representative row. */
export function firstRevealableRow(rows: readonly SubagentRowView[]): SubagentRowView | undefined {
  return rows.find((row) => row.editable);
}

// ── request builders (pure — isolate "what do we send" from the bridge call; identity = name+sourceKind, NEVER a path) ──

export function buildReadRequest(tabId: string | undefined, row: SubagentRowView): SubagentsReadRequest {
  return { tabId, name: row.name, sourceKind: row.sourceKind };
}

export function buildDeleteRequest(tabId: string | undefined, row: SubagentRowView): SubagentsDeleteRequest {
  return { tabId, name: row.name, sourceKind: row.sourceKind };
}

export function buildRevealRequest(tabId: string | undefined, row: SubagentRowView): SubagentsRevealRequest {
  return { tabId, name: row.name, sourceKind: row.sourceKind };
}

export function buildSaveRequest(
  tabId: string | undefined,
  originalName: string,
  originalSourceKind: SubagentSourceKind,
  draft: SubagentProfileDraft,
): SubagentsSaveRequest {
  return { tabId, name: originalName, sourceKind: originalSourceKind, draft };
}

export function buildCreateRequest(
  tabId: string | undefined,
  scope: SubagentScope,
  draft: SubagentProfileDraft,
): SubagentsCreateRequest {
  return { tabId, scope, draft };
}

export function buildPreviewRequest(draft: SubagentProfileDraft): SubagentsPreviewRequest {
  return { draft };
}

// ── editor (design §2-D3/§4 W3: name regex-live-validated, tools chips, body, Edit|Preview tabs) ──

/** Mirrors core's `AGENT_PROFILE_NAME_RE` (subagents/profiles.ts) for live validation — main is still the authority. */
export const SUBAGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidSubagentName(name: string): boolean {
  return SUBAGENT_NAME_RE.test(name.trim());
}

/** Mirror of core's `DEFAULT_TOOL_NAMES` (subagents/preview.ts) MINUS the two spawn-locked tools (Agent/Workflow) — selecting either always fails save-time validation (non-recursion lock, design §2-D7), so the chip list never offers them. */
export const SUBAGENT_TOOL_CHOICES: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "Skill",
];

/** Mirror of core's `AGENT_PROFILE_PROMPT_MAX_BYTES` (types/config.ts) — the editor refuses over-cap client-side too, so a rejected save is never a first-time surprise. */
export const SUBAGENT_BODY_MAX_BYTES = 32_768;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type SubagentEditorMode = "create" | "edit";

export interface SubagentEditorFields {
  name: string;
  description: string;
  /** Selected tool chips; empty = "inherit all (default)" (design §4 W3). */
  tools: string[];
  body: string;
}

const TEMPLATE_BODY =
  "Describe this subagent's role, responsibilities, and constraints here. This text becomes its system prompt.";

export function blankSubagentEditorFields(): SubagentEditorFields {
  return { name: "", description: "", tools: [], body: TEMPLATE_BODY };
}

export function subagentEditorFieldsFromDraft(draft: SubagentProfileDraft): SubagentEditorFields {
  return { name: draft.name, description: draft.description, tools: draft.tools ? [...draft.tools] : [], body: draft.body };
}

export function buildSubagentDraft(fields: SubagentEditorFields): SubagentProfileDraft {
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    ...(fields.tools.length > 0 ? { tools: [...fields.tools] } : {}),
    body: fields.body,
  };
}

export function toggleSubagentToolChip(fields: SubagentEditorFields, tool: string): SubagentEditorFields {
  const has = fields.tools.includes(tool);
  return { ...fields, tools: has ? fields.tools.filter((t) => t !== tool) : [...fields.tools, tool] };
}

/** Gates Save: a valid name, a non-empty single-line description, and a body under the byte cap (design §2-D7's stricter-than-loader rules, mirrored client-side so a refusal is never a first-time surprise). Reserved-name/proto-key checks are deliberately NOT pre-checked here — they surface via the save/create refusal reason instead (design §4 W3: "reserved check via save refusal surfacing"). */
export function canSubmitSubagentDraft(fields: SubagentEditorFields): boolean {
  const name = fields.name.trim();
  const description = fields.description.trim();
  if (!isValidSubagentName(name)) {
    return false;
  }
  if (description === "" || /[\r\n]/.test(fields.description)) {
    return false;
  }
  if (utf8ByteLength(fields.body) > SUBAGENT_BODY_MAX_BYTES) {
    return false;
  }
  return true;
}

/** Dirty check for Save-disabled-until-dirty (design §4 W3) — tool-set compared as a set (order-insensitive), everything else by value. */
export function subagentEditorFieldsEqual(a: SubagentEditorFields, b: SubagentEditorFields): boolean {
  if (a.name !== b.name || a.description !== b.description || a.body !== b.body) {
    return false;
  }
  if (a.tools.length !== b.tools.length) {
    return false;
  }
  const bSet = new Set(b.tools);
  return a.tools.every((t) => bSet.has(t));
}

/** Preview tab's effective-tools line (design §4 W3: "effective-tools line"). */
export function formatEffectiveToolsLine(tools: readonly string[]): string {
  return tools.length > 0 ? `Effective tools: ${tools.join(", ")}` : "Effective tools: none";
}

// ── component ──

export interface SubagentsPaneProps {
  /** Active tab id, so bridge calls resolve a project-scope workspace main-side; omit for the pre-tab case (user-scope only). */
  tabId?: string;
  /** Injectable for tests / isolation; defaults to `window.anycode.subagents` (same DI ethic as SkillsBridge/McpConfigBridge). */
  bridge?: SubagentsBridge;
}

export function SubagentsPane({ tabId, bridge = window.anycode.subagents }: SubagentsPaneProps) {
  const [snapshot, setSnapshot] = useState<SubagentsSnapshot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SubagentsSourceFilter>("all");
  const [problemsExpanded, setProblemsExpanded] = useState(false);
  const [problemsDismissed, setProblemsDismissed] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<SubagentEditorMode>("create");
  const [editorOriginal, setEditorOriginal] = useState<{ name: string; sourceKind: SubagentSourceKind } | null>(null);
  const [editorScope, setEditorScope] = useState<SubagentScope>("user");
  const [fields, setFields] = useState<SubagentEditorFields>(blankSubagentEditorFields());
  const [initialFields, setInitialFields] = useState<SubagentEditorFields>(blankSubagentEditorFields());
  const [editorTab, setEditorTab] = useState<"edit" | "preview">("edit");
  const [previewResult, setPreviewResult] = useState<SubagentsPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorIssues, setEditorIssues] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void bridge.list({ tabId }).then((snap) => {
      if (!cancelled) {
        setSnapshot(snap);
        setProblemsDismissed(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, tabId]);

  async function refresh(): Promise<void> {
    const snap = await bridge.list({ tabId });
    setSnapshot(snap);
    setProblemsDismissed(false);
  }

  const rows = snapshot ? filterSubagentsBySource(filterSubagentRows(snapshot.rows, searchQuery), sourceFilter) : [];
  const { builtin, user, plugin } = partitionSubagentRows(rows);
  const showProblems = snapshot !== null && !problemsDismissed && snapshot.problems.length > 0;

  async function revealRow(row: SubagentRowView): Promise<void> {
    await bridge.reveal(buildRevealRequest(tabId, row));
  }

  async function revealRoot(): Promise<void> {
    const target = firstRevealableRow(snapshot?.rows ?? []);
    if (!target) {
      return;
    }
    await revealRow(target);
  }

  async function deleteRow(row: SubagentRowView): Promise<void> {
    const result = await bridge.delete(buildDeleteRequest(tabId, row));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
    setConfirmDeleteKey(null);
  }

  function openCreate(): void {
    const blank = blankSubagentEditorFields();
    setEditorMode("create");
    setEditorOriginal(null);
    setEditorScope("user");
    setFields(blank);
    setInitialFields(blank);
    setEditorTab("edit");
    setPreviewResult(null);
    setEditorError(null);
    setEditorIssues([]);
    setEditorOpen(true);
  }

  async function openEdit(row: SubagentRowView): Promise<void> {
    const result = await bridge.read(buildReadRequest(tabId, row));
    if (!result.ok) {
      setEditorError(subagentRefusalMessage(result.reason));
      return;
    }
    const loaded = subagentEditorFieldsFromDraft(result.draft);
    setEditorMode("edit");
    setEditorOriginal({ name: row.name, sourceKind: row.sourceKind });
    setFields(loaded);
    setInitialFields(loaded);
    setEditorTab("edit");
    setPreviewResult(null);
    setEditorError(null);
    setEditorIssues([]);
    setEditorOpen(true);
  }

  function closeEditor(): void {
    setEditorOpen(false);
    setEditorError(null);
    setEditorIssues([]);
    setPreviewResult(null);
  }

  async function openPreviewTab(): Promise<void> {
    setEditorTab("preview");
    setPreviewLoading(true);
    const result = await bridge.preview(buildPreviewRequest(buildSubagentDraft(fields)));
    setPreviewResult(result);
    setPreviewLoading(false);
  }

  async function submitEditor(): Promise<void> {
    if (!canSubmitSubagentDraft(fields)) {
      return;
    }
    const draft = buildSubagentDraft(fields);
    const result =
      editorMode === "create"
        ? await bridge.create(buildCreateRequest(tabId, editorScope, draft))
        : await bridge.save(buildSaveRequest(tabId, editorOriginal!.name, editorOriginal!.sourceKind, draft));
    if (result.ok) {
      setSnapshot(result.snapshot);
      closeEditor();
    } else {
      setEditorError(subagentRefusalMessage(result.reason));
      setEditorIssues(result.issues ?? []);
    }
  }

  const dirty = editorMode === "create" || !subagentEditorFieldsEqual(fields, initialFields);
  const canSave = canSubmitSubagentDraft(fields) && dirty;

  return (
    <section className="settings-section skills-pane subagents-pane">
      <p className="skills-pane-hint">Changes apply to newly started tasks.</p>

      <div className="skills-pane-toolbar mcp-pane-toolbar">
        <label className="settings-search skills-pane-search mcp-pane-search">
          <Search className="settings-search-icon" />
          <input
            type="text"
            className="settings-search-input"
            placeholder="Search subagents…"
            aria-label="Search subagents"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <select
          className="settings-field-select skills-source-select"
          aria-label="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SubagentsSourceFilter)}
        >
          <option value="all">All</option>
          <option value="builtin">Built-in</option>
          <option value="user">User</option>
          <option value="project">Project</option>
          <option value="plugin">Plugin</option>
        </select>
        <div className="skills-pane-actions mcp-pane-actions">
          <button type="button" className="skills-icon-button mcp-icon-button" aria-label="Create subagent" onClick={openCreate}>
            <Plus />
          </button>
          <button
            type="button"
            className="skills-icon-button mcp-icon-button"
            aria-label="Open subagents folder"
            disabled={!firstRevealableRow(snapshot?.rows ?? [])}
            onClick={() => void revealRoot()}
          >
            <Folder />
          </button>
          <button type="button" className="skills-icon-button mcp-icon-button" aria-label="Refresh subagents" onClick={() => void refresh()}>
            <Spinner />
          </button>
        </div>
      </div>

      {showProblems && snapshot && (
        <div className="skills-problem-strip mcp-problem-strip" role="alert">
          <div className="skills-problem-strip-main">
            <button
              type="button"
              className="skills-problem-toggle"
              aria-expanded={problemsExpanded}
              aria-label={problemsExpanded ? "Collapse problem details" : "Expand problem details"}
              onClick={() => setProblemsExpanded((v) => !v)}
            >
              <Chevron className={`skills-problem-chevron${problemsExpanded ? " skills-problem-chevron-expanded" : ""}`} />
              <span>{problemsStripLabel(snapshot.problems)}</span>
            </button>
            <button type="button" className="mcp-problem-dismiss" aria-label="Dismiss" onClick={() => setProblemsDismissed(true)}>
              <X />
            </button>
          </div>
          {problemsExpanded && (
            <ul className="skills-problem-list">
              {snapshot.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!snapshot ? (
        <div className="settings-mcp-empty">Loading subagents…</div>
      ) : (
        <>
          <div className="mcp-section">
            <div className="mcp-section-title">
              Built-in subagents{" "}
              <span className="mcp-section-count">
                {builtin.length} item{builtin.length === 1 ? "" : "s"}
              </span>
              <span className="mcp-section-note">Built-in profiles are runtime defaults and cannot be edited here.</span>
            </div>
            <ul className="skills-row-list mcp-row-list">
              {builtin.map((row) => (
                <li key={`builtin:${row.name}`} className="skills-row mcp-row" data-subagent-name={row.name} data-subagent-source="builtin">
                  <div className="skills-row-main mcp-row-main">
                    <Robot className="skills-row-icon subagents-row-icon-builtin" aria-hidden="true" />
                    <div className="mcp-row-lines">
                      <div className="mcp-row-line1">
                        <span className="skills-row-name settings-mcp-name">{row.name}</span>
                        <span className="skills-badge skills-badge-plugin">Built-in</span>
                        <span className="skills-badge subagents-badge-tools">{row.toolsBadge}</span>
                      </div>
                      <div className="mcp-row-line2" title={row.description}>
                        {row.description}
                      </div>
                      <div className="subagents-id-line">{builtinIdLine(row.name)}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="mcp-section">
            <div className="mcp-section-title">
              User subagents{" "}
              <span className="mcp-section-count">
                {user.length} item{user.length === 1 ? "" : "s"}
              </span>
            </div>
            {user.length === 0 ? (
              <div className="settings-mcp-empty">No user subagents yet.</div>
            ) : (
              <ul className="skills-row-list mcp-row-list">
                {sortSubagentRows(user).map((row) => {
                  const key = `${row.sourceKind}:${row.name}`;
                  return (
                    <li key={key} className="skills-row mcp-row" data-subagent-name={row.name} data-subagent-source={row.sourceKind}>
                      <div className="skills-row-main mcp-row-main">
                        <FileIcon className="skills-row-icon" aria-hidden="true" />
                        <div className="mcp-row-lines">
                          <div className="mcp-row-line1">
                            <span className="skills-row-name settings-mcp-name">{row.name}</span>
                            <span className={`skills-badge skills-badge-${row.sourceKind}`}>{userRowSourceBadgeLabel(row.sourceKind)}</span>
                            <span className="skills-badge subagents-badge-tools">{row.toolsBadge}</span>
                          </div>
                          <div className="mcp-row-line2" title={row.description}>
                            {row.description}
                          </div>
                        </div>
                      </div>
                      <div className="mcp-row-controls">
                        {confirmDeleteKey === key ? (
                          <span className="mcp-confirm-row">
                            <span className="mcp-confirm-text">Delete "{row.name}"?</span>
                            <button type="button" className="settings-button settings-button-danger" onClick={() => void deleteRow(row)}>
                              Delete
                            </button>
                            <button type="button" className="settings-button" onClick={() => setConfirmDeleteKey(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <>
                            <button type="button" className="skills-icon-button mcp-icon-button" aria-label={`Edit ${row.name}`} onClick={() => void openEdit(row)}>
                              <Pencil />
                            </button>
                            <button type="button" className="skills-icon-button mcp-icon-button" aria-label={`Reveal ${row.name}`} onClick={() => void revealRow(row)}>
                              <Folder />
                            </button>
                            <button
                              type="button"
                              className="skills-icon-button mcp-icon-button mcp-icon-button-danger"
                              aria-label={`Delete ${row.name}`}
                              onClick={() => setConfirmDeleteKey(key)}
                            >
                              <Trash />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {plugin.length > 0 && (
            <div className="mcp-section">
              <div className="mcp-section-title">
                Plugin subagents{" "}
                <span className="mcp-section-count">
                  {plugin.length} item{plugin.length === 1 ? "" : "s"}
                </span>
                <span className="mcp-section-note">Registered by a plugin. Edit it in the plugin.</span>
              </div>
              <ul className="skills-row-list mcp-row-list">
                {sortSubagentRows(plugin).map((row) => (
                  <li key={`plugin:${row.name}`} className="skills-row mcp-row" data-subagent-name={row.name} data-subagent-source="plugin">
                    <div className="skills-row-main mcp-row-main">
                      <FileIcon className="skills-row-icon" aria-hidden="true" />
                      <div className="mcp-row-lines">
                        <div className="mcp-row-line1">
                          <span className="skills-row-name settings-mcp-name">{row.name}</span>
                          {row.pluginName && <span className="skills-plugin-name">{row.pluginName}</span>}
                          <span className="skills-badge skills-badge-plugin">Plugin</span>
                          <span className="skills-badge subagents-badge-tools">{row.toolsBadge}</span>
                        </div>
                        <div className="mcp-row-line2" title={row.description}>
                          {row.description}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {editorOpen && (
        <SubagentEditorDialog
          mode={editorMode}
          fields={fields}
          scope={editorScope}
          editorTab={editorTab}
          previewResult={previewResult}
          previewLoading={previewLoading}
          error={editorError}
          issues={editorIssues}
          canSave={canSave}
          onChange={setFields}
          onScopeChange={setEditorScope}
          onEditTab={() => setEditorTab("edit")}
          onPreviewTab={() => void openPreviewTab()}
          onCancel={closeEditor}
          onSubmit={() => void submitEditor()}
        />
      )}
    </section>
  );
}

// ── editor dialog (design §2-D3/§4 W3: structured fields + Edit|Preview tabs) ──

interface SubagentEditorDialogProps {
  mode: SubagentEditorMode;
  fields: SubagentEditorFields;
  scope: SubagentScope;
  editorTab: "edit" | "preview";
  previewResult: SubagentsPreviewResult | null;
  previewLoading: boolean;
  error: string | null;
  issues: string[];
  canSave: boolean;
  onChange: (fields: SubagentEditorFields) => void;
  onScopeChange: (scope: SubagentScope) => void;
  onEditTab: () => void;
  onPreviewTab: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function SubagentEditorDialog({
  mode,
  fields,
  scope,
  editorTab,
  previewResult,
  previewLoading,
  error,
  issues,
  canSave,
  onChange,
  onScopeChange,
  onEditTab,
  onPreviewTab,
  onCancel,
  onSubmit,
}: SubagentEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  function set<K extends keyof SubagentEditorFields>(key: K, value: SubagentEditorFields[K]): void {
    onChange({ ...fields, [key]: value });
  }

  const nameTouched = fields.name.trim().length > 0;
  const nameInvalid = nameTouched && !isValidSubagentName(fields.name);
  const descriptionInvalid = fields.description.trim().length > 0 && /[\r\n]/.test(fields.description);

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog subagents-editor-dialog"
      aria-label={mode === "create" ? "Create subagent" : "Edit subagent"}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">{mode === "create" ? "New subagent" : "Edit subagent"}</span>
      </div>
      <div className="mcp-dialog-body">
        <label className="settings-field">
          <span className="settings-field-label">Name</span>
          <input className="settings-field-input" type="text" value={fields.name} onChange={(e) => set("name", e.target.value)} />
          {nameInvalid && (
            <span className="skills-field-invalid">Use letters, numbers, "-", or "_" — must start with a letter or number.</span>
          )}
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Description</span>
          <input className="settings-field-input" type="text" value={fields.description} onChange={(e) => set("description", e.target.value)} />
          {descriptionInvalid && <span className="skills-field-invalid">Description must be a single line.</span>}
        </label>

        {mode === "create" && (
          <div className="settings-field">
            <span className="settings-field-label">Scope</span>
            <div className="mcp-radio-row">
              <label>
                <input type="radio" name="subagent-scope" checked={scope === "user"} onChange={() => onScopeChange("user")} />
                Personal
              </label>
              <label>
                <input type="radio" name="subagent-scope" checked={scope === "project"} onChange={() => onScopeChange("project")} />
                Workspace
              </label>
            </div>
          </div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">Tools</span>
          <div className="subagents-tools-chips">
            {SUBAGENT_TOOL_CHOICES.map((tool) => (
              <label key={tool} className={`subagents-tool-chip${fields.tools.includes(tool) ? " subagents-tool-chip-selected" : ""}`}>
                <input type="checkbox" checked={fields.tools.includes(tool)} onChange={() => onChange(toggleSubagentToolChip(fields, tool))} />
                {tool}
              </label>
            ))}
          </div>
          {fields.tools.length === 0 && <span className="subagents-tools-hint">Inherit all (default)</span>}
        </div>

        <div className="subagents-editor-tabs" role="tablist" aria-label="Editor mode">
          <button type="button" role="tab" aria-selected={editorTab === "edit"} className="subagents-editor-tab" onClick={onEditTab}>
            Edit
          </button>
          <button type="button" role="tab" aria-selected={editorTab === "preview"} className="subagents-editor-tab" onClick={onPreviewTab}>
            Preview
          </button>
        </div>

        {editorTab === "edit" ? (
          <label className="settings-field">
            <span className="settings-field-label">System prompt (body)</span>
            <textarea className="settings-field-input mcp-textarea subagents-body-textarea" value={fields.body} onChange={(e) => set("body", e.target.value)} />
          </label>
        ) : (
          <div className="subagents-preview-pane" data-subagents-preview-loading={previewLoading}>
            {previewLoading ? (
              <div className="settings-mcp-empty">Building preview…</div>
            ) : previewResult && previewResult.ok ? (
              <>
                <pre className="subagents-preview-prompt">{previewResult.systemPrompt}</pre>
                <div className="subagents-preview-tools">{formatEffectiveToolsLine(previewResult.effectiveTools)}</div>
                <p className="subagents-preview-caption">Env + memory sections are injected at spawn time.</p>
              </>
            ) : (
              <div className="settings-mcp-empty">Preview unavailable — check the fields above.</div>
            )}
          </div>
        )}

        {error && (
          <div className="settings-env-warning">
            {error}
            {issues.length > 0 && (
              <ul className="subagents-issue-list">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="settings-button settings-button-primary" disabled={!canSave} onClick={onSubmit}>
          Save
        </button>
      </div>
    </dialog>
  );
}

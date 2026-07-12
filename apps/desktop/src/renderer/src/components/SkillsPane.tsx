/**
 * Skills settings pane (P7.20/F23 W3, design/slice-P7.20-cut.md §1/§5 W3):
 * the Skills management page — search + source-filter toolbar,
 * a dismissible/expandable "N skill(s) failed to load" strip, a mutable
 * "Workspace and personal skills" group (toggle/delete/reveal), a read-only
 * "Plugin skills" group, a create-scaffold dialog, and an explicit-selection
 * import wizard over the fixed foreign-harness allowlist. Structural sibling
 * of McpServersPane.tsx (same DI/bridge/dialog/row-list shape) — reuses its
 * `settings-*`/`mcp-*` CSS vocabulary (settings.css) rather than inventing a
 * new design system; anything genuinely skills-shaped gets its own additive
 * `skills-*` class instead of overloading the mcp-prefixed ones.
 *
 * DATA (§5 W3): `SkillsSnapshot` is fetched via the bridge on mount and
 * REFETCHED FROM THE RETURNED SNAPSHOT after every mutation (never a second
 * `list()` round-trip) — same discipline as McpServersPane. A staleness hint
 * ("Changes apply to newly started tasks") sits under the toolbar because
 * skills are boot-static (design §2 scope-out: no live re-discovery in a

 *
 * PATH CUSTODY (design §4 — the load-bearing invariant of this slice): this
 * component NEVER sends a filesystem path back to main. Toggle/delete/reveal
 * requests carry only `(tabId?, name)` — main re-resolves the real path from
 * its own fresh scan. `SkillRowView.path` DOES cross to the renderer
 * (display-only, same trusted-config custody class as MCP's `cwd`) and is
 * shown after a successful create so the user can jump straight to the
 * scaffolded file via Reveal — but it is never sent back as a request field.
 *
 * PLUGIN ROWS ARE READ-ONLY (design §2 D1 / §4): a plugin-sourced row renders
 * NO toggle, delete, or reveal control at all — `canManageSkillRow` gates the
 * whole controls cell, and main independently refuses `read_only_source` for
 * any mutator/reveal on a plugin source, so this is belt-and-suspenders, not
 * the only enforcement point.
 */
import { useEffect, useRef, useState } from "react";
import type {
  SkillHarnessKind,
  SkillImportCandidateView,
  SkillRowView,
  SkillScope,
  SkillSourceKind,
  SkillsCreateRequest,
  SkillsDeleteRequest,
  SkillsImportApplyRequest,
  SkillsImportApplyResult,
  SkillsImportScanRequest,
  SkillsImportApplyResultItem,
  SkillsImportScanResult,
  SkillsListRequest,
  SkillsMutationResult,
  SkillsRefusalReason,
  SkillsRevealRequest,
  SkillsRevealResult,
  SkillsSetEnabledRequest,
  SkillsSnapshot,
} from "../../../shared/skills-config.js";
import { Chevron, Download, FileIcon, Folder, Plus, Search, Spinner, Trash, X } from "./icons.js";

// ── bridge (DI, same ethic as McpServersPane.tsx's McpConfigBridge) ──

/** Subset of `window.anycode.skills` this pane drives, injectable so tests never touch a real `window`. */
export interface SkillsBridge {
  list(req?: SkillsListRequest): Promise<SkillsSnapshot>;
  setEnabled(req: SkillsSetEnabledRequest): Promise<SkillsMutationResult>;
  delete(req: SkillsDeleteRequest): Promise<SkillsMutationResult>;
  create(req: SkillsCreateRequest): Promise<SkillsMutationResult>;
  reveal(req: SkillsRevealRequest): Promise<SkillsRevealResult>;
  importScan(req?: SkillsImportScanRequest): Promise<SkillsImportScanResult>;
  importApply(req: SkillsImportApplyRequest): Promise<SkillsImportApplyResult>;
}

// ── pure helpers (unit-tested directly — see SkillsPane.test.ts) ──

export type SkillsSourceFilter = "all" | SkillSourceKind;

/** Trivial substring filter over name+description (design §5 W3: "no fuzzy engine", same ethic as McpServersPane's filterMcpRows). */
export function filterSkillRows(rows: readonly SkillRowView[], query: string): SkillRowView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter(
    (row) => row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
  );
}

export function filterSkillsBySource(rows: readonly SkillRowView[], filter: SkillsSourceFilter): SkillRowView[] {
  if (filter === "all") {
    return [...rows];
  }
  return rows.filter((row) => row.sourceKind === filter);
}

/** Alphabetical, stable ordering — matches the reference screenshot's a-z rows within each group. */
export function sortSkillRows(rows: readonly SkillRowView[]): SkillRowView[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillRowSections {
  /** "Workspace and personal skills" — project+user combined, mutable (design §1 group 1). */
  personal: SkillRowView[];
  /** "Plugin skills" — read-only (design §1 group 2 / §2 D1). */
  plugin: SkillRowView[];
}

/** Splits the joined+filtered rows into the two reference groups (§1.4/§1.5). */
export function partitionSkillRows(rows: readonly SkillRowView[]): SkillRowSections {
  const personal: SkillRowView[] = [];
  const plugin: SkillRowView[] = [];
  for (const row of rows) {
    (row.sourceKind === "plugin" ? plugin : personal).push(row);
  }
  return { personal, plugin };
}

export function sourceKindBadgeLabel(kind: SkillSourceKind): string {
  switch (kind) {
    case "project":
      return "Workspace";
    case "user":
      return "Personal";
    case "plugin":
      return "Plugin";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Plugin rows are read-only in v1 (design §2 D1) — no toggle/delete/reveal affordance. */
export function canManageSkillRow(row: SkillRowView): boolean {
  return row.sourceKind !== "plugin";
}

/** "N skill(s) failed to load" — literal reference wording (§1.3), deliberately not pluralization-aware. */
export function problemsStripLabel(problems: readonly string[]): string {
  return `${problems.length} skill(s) failed to load`;
}

export function skillRefusalMessage(reason: SkillsRefusalReason): string {
  switch (reason) {
    case "invalid":
      return "That name or description isn't valid — check it and try again.";
    case "no_workspace":
      return "No project is open — open a workspace to manage a workspace-scoped skill.";
    case "read_only_source":
      return "This skill is registered by a plugin — edit it in the plugin.";
    case "not_found":
      return "That skill no longer exists — try refreshing.";
    case "io_error":
      return "Couldn't save — the skill file couldn't be read or written.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// ── request builders (pure — isolate "what do we send" from the bridge call) ──

export function buildSetEnabledRequest(
  tabId: string | undefined,
  row: SkillRowView,
  enabled: boolean,
): SkillsSetEnabledRequest {
  return { tabId, name: row.name, enabled };
}

export function buildDeleteRequest(tabId: string | undefined, name: string): SkillsDeleteRequest {
  return { tabId, name };
}

export function buildRevealRequest(tabId: string | undefined, name: string): SkillsRevealRequest {
  return { tabId, name };
}

// ── create (scaffold) form (design §2 D1: no in-app editor, just name/description/scope) ──

/** Mirrors core's discovery name regex (skills/discovery.ts) for live validation — main is still the authority. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name.trim());
}

export interface SkillCreateFields {
  name: string;
  description: string;
  scope: SkillScope;
}

/** Default scope is Personal (design §5 W3), independent of whether a workspace tab is open. */
export function blankSkillCreateFields(): SkillCreateFields {
  return { name: "", description: "", scope: "user" };
}

export function canSubmitSkillCreate(fields: SkillCreateFields): boolean {
  return isValidSkillName(fields.name) && fields.description.trim().length > 0;
}

export function buildSkillCreateRequest(tabId: string | undefined, fields: SkillCreateFields): SkillsCreateRequest {
  return { tabId, scope: fields.scope, name: fields.name.trim(), description: fields.description.trim() };
}

/**
 * The just-created row in a fresh snapshot (scope maps to the row's
 * sourceKind — "project" for Workspace, "user" for Personal) — used to
 * surface the written path + a Reveal action after create (design §5 W3:
 * "toast/inline confirmation with the returned path + a Reveal button").
 */
export function findCreatedSkillRow(snapshot: SkillsSnapshot, fields: SkillCreateFields): SkillRowView | undefined {
  const sourceKind: SkillSourceKind = fields.scope === "project" ? "project" : "user";
  const name = fields.name.trim();
  return snapshot.rows.find((row) => row.name === name && row.sourceKind === sourceKind);
}

// ── import dialog (design §2 D2/D3, §5 W3) ──

/** Default-checked iff compatible and not already present — an incompatible or already-present candidate never auto-selects. */
export function defaultImportChecked(candidate: SkillImportCandidateView): boolean {
  return candidate.compatible && !candidate.alreadyPresent;
}

export function defaultImportSelection(candidates: readonly SkillImportCandidateView[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const candidate of candidates) {
    selection[candidate.id] = defaultImportChecked(candidate);
  }
  return selection;
}

export interface SkillImportGroup {
  harness: SkillHarnessKind;
  sourceDir: string;
  candidates: SkillImportCandidateView[];
}

/** Groups by harness+sourceDir, first-seen order — mirror of McpServersPane's groupImportCandidates. */
export function groupSkillImportCandidates(candidates: readonly SkillImportCandidateView[]): SkillImportGroup[] {
  const order: string[] = [];
  const groups = new Map<string, SkillImportGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.harness}:${candidate.sourceDir}`;
    let group = groups.get(key);
    if (!group) {
      group = { harness: candidate.harness, sourceDir: candidate.sourceDir, candidates: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.candidates.push(candidate);
  }
  return order.map((key) => groups.get(key)!);
}

export function skillHarnessLabel(harness: SkillHarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude Code (user)";
    case "claude-project":
      return "Claude Code (project)";
    case "codex":
      return "Codex";
    case "zcode":
      return "zcode";
    case "claude-plugin":
      return "Claude Code plugin";
    default: {
      const exhaustive: never = harness;
      return exhaustive;
    }
  }
}

/**
 * "already exists — will import as <name>-2" (design §5 W3 literal wording).
 * The REAL conflict suffix is only known after apply (main may need -3, -4,
 * … if multiple imports collide) — this is a display hint at scan time, not
 * a guarantee; `SkillsImportApplyResultItem.name`/`.suffixed` carry the truth.
 */
export function importConflictBadge(candidate: SkillImportCandidateView): string {
  return `already exists — will import as ${candidate.name}-2`;
}

export function selectedImportIds(selection: Record<string, boolean>): string[] {
  return Object.entries(selection)
    .filter(([, checked]) => checked)
    .map(([id]) => id);
}

/** Footer label (design §5 W3 / §2 D2: default-enabled import — the deliberate divergence from F22's forced-disabled import). */
export function skillsImportFooterLabel(selection: Record<string, boolean>): string {
  const n = selectedImportIds(selection).length;
  return `Import ${n} skill${n === 1 ? "" : "s"} — enabled in newly started tasks`;
}

export function buildSkillsImportApplyRequest(
  tabId: string | undefined,
  scope: SkillScope,
  selection: Record<string, boolean>,
): SkillsImportApplyRequest {
  return { tabId, scope, ids: selectedImportIds(selection) };
}

export function skillImportResultText(item: SkillsImportApplyResultItem): string {
  if (!item.applied) {
    const reason =
      item.skipped === "incompatible"
        ? "incompatible"
        : item.skipped === "unsafe_name"
          ? "invalid name"
          : item.skipped === "io_error"
            ? "couldn't write"
            : "not imported";
    return `${item.name}: skipped — ${reason}`;
  }
  const parts: string[] = [];
  if (item.suffixed) {
    parts.push("renamed to avoid a conflict");
  }
  if (item.converted) {
    parts.push("converted");
  }
  return parts.length > 0 ? `${item.name}: imported (${parts.join(", ")})` : `${item.name}: imported`;
}

// ── component ──

export interface SkillsPaneProps {
  /** Active tab id, so bridge calls resolve a project-scope workspace main-side; omit for the pre-tab case (user-scope only). */
  tabId?: string;
  /** Injectable for tests / isolation; defaults to `window.anycode.skills` (same DI ethic as SettingsBridge/McpConfigBridge). */
  bridge?: SkillsBridge;
}

export function SkillsPane({ tabId, bridge = window.anycode.skills }: SkillsPaneProps) {
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillsSourceFilter>("all");
  const [problemsExpanded, setProblemsExpanded] = useState(false);
  const [problemsDismissed, setProblemsDismissed] = useState(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFields, setCreateFields] = useState<SkillCreateFields>(blankSkillCreateFields());
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdRow, setCreatedRow] = useState<SkillRowView | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importScanResult, setImportScanResult] = useState<SkillsImportScanResult | null>(null);
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [importScope, setImportScope] = useState<SkillScope>("user");
  const [importResults, setImportResults] = useState<SkillsImportApplyResultItem[] | null>(null);

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

  const rows = snapshot ? sortSkillRows(filterSkillsBySource(filterSkillRows(snapshot.rows, searchQuery), sourceFilter)) : [];
  const { personal, plugin } = partitionSkillRows(rows);
  const showProblems = snapshot !== null && !problemsDismissed && snapshot.problems.length > 0;

  async function toggleRow(row: SkillRowView): Promise<void> {
    if (!canManageSkillRow(row)) {
      return;
    }
    const result = await bridge.setEnabled(buildSetEnabledRequest(tabId, row, !row.enabled));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
  }

  async function deleteRow(name: string): Promise<void> {
    const result = await bridge.delete(buildDeleteRequest(tabId, name));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
    setConfirmDeleteName(null);
  }

  async function revealRow(name: string): Promise<void> {
    await bridge.reveal(buildRevealRequest(tabId, name));
  }

  function openCreate(): void {
    setCreateError(null);
    setCreatedRow(null);
    setCreateFields(blankSkillCreateFields());
    setCreateOpen(true);
  }

  function closeCreate(): void {
    setCreateOpen(false);
    setCreateError(null);
    setCreatedRow(null);
  }

  async function submitCreate(): Promise<void> {
    if (!canSubmitSkillCreate(createFields)) {
      return;
    }
    const result = await bridge.create(buildSkillCreateRequest(tabId, createFields));
    if (result.ok) {
      setSnapshot(result.snapshot);
      setCreateError(null);
      setCreatedRow(findCreatedSkillRow(result.snapshot, createFields) ?? null);
    } else {
      setCreateError(skillRefusalMessage(result.reason));
    }
  }

  async function openImport(): Promise<void> {
    setImportOpen(true);
    setImportResults(null);
    setImportScope("user");
    const scan = await bridge.importScan({ tabId });
    setImportScanResult(scan);
    setImportSelection(defaultImportSelection(scan.candidates));
  }

  function closeImport(): void {
    setImportOpen(false);
    setImportScanResult(null);
    setImportResults(null);
  }

  function toggleImportRow(id: string): void {
    setImportSelection((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function applyImport(): Promise<void> {
    if (selectedImportIds(importSelection).length === 0) {
      return;
    }
    const result = await bridge.importApply(buildSkillsImportApplyRequest(tabId, importScope, importSelection));
    if (result.ok) {
      setSnapshot(result.snapshot);
      setImportResults(result.results);
    }
  }

  return (
    <section className="settings-section skills-pane">
      <p className="skills-pane-hint">Changes apply to newly started tasks.</p>

      <div className="skills-pane-toolbar mcp-pane-toolbar">
        <label className="settings-search skills-pane-search mcp-pane-search">
          <Search className="settings-search-icon" />
          <input
            type="text"
            className="settings-search-input"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <select
          className="settings-field-select skills-source-select"
          aria-label="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SkillsSourceFilter)}
        >
          <option value="all">All</option>
          <option value="project">Workspace</option>
          <option value="user">Personal</option>
          <option value="plugin">Plugin</option>
        </select>
        <div className="skills-pane-actions mcp-pane-actions">
          <button type="button" className="skills-icon-button mcp-icon-button" aria-label="Create skill" onClick={openCreate}>
            <Plus />
          </button>
          <button type="button" className="skills-icon-button mcp-icon-button" aria-label="Import skills" onClick={() => void openImport()}>
            <Download />
          </button>
          <button type="button" className="skills-icon-button mcp-icon-button" aria-label="Refresh skills" onClick={() => void refresh()}>
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
        <div className="settings-mcp-empty">Loading skills…</div>
      ) : (
        <>
          <div className="mcp-section">
            <div className="mcp-section-title">
              Workspace and personal skills{" "}
              <span className="mcp-section-count">
                {personal.length} item{personal.length === 1 ? "" : "s"}
              </span>
            </div>
            {personal.length === 0 ? (
              <div className="settings-mcp-empty">No workspace or personal skills yet.</div>
            ) : (
              <ul className="skills-row-list mcp-row-list">
                {personal.map((row) => (
                  <SkillRowItem
                    key={`${row.sourceKind}:${row.name}`}
                    row={row}
                    confirmDelete={confirmDeleteName === row.name}
                    onToggle={() => void toggleRow(row)}
                    onReveal={() => void revealRow(row.name)}
                    onRequestDelete={() => setConfirmDeleteName(row.name)}
                    onCancelDelete={() => setConfirmDeleteName(null)}
                    onConfirmDelete={() => void deleteRow(row.name)}
                  />
                ))}
              </ul>
            )}
          </div>

          {plugin.length > 0 && (
            <div className="mcp-section">
              <div className="mcp-section-title">
                Plugin skills{" "}
                <span className="mcp-section-count">
                  {plugin.length} item{plugin.length === 1 ? "" : "s"}
                </span>
                <span className="mcp-section-note">Registered by a plugin. Edit it in the plugin.</span>
              </div>
              <ul className="skills-row-list mcp-row-list">
                {plugin.map((row) => (
                  <SkillRowItem
                    key={`plugin:${row.name}`}
                    row={row}
                    confirmDelete={false}
                    onToggle={() => {}}
                    onReveal={() => {}}
                    onRequestDelete={() => {}}
                    onCancelDelete={() => {}}
                    onConfirmDelete={() => {}}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {createOpen && (
        <SkillCreateDialog
          fields={createFields}
          error={createError}
          createdRow={createdRow}
          onChange={setCreateFields}
          onCancel={closeCreate}
          onSubmit={() => void submitCreate()}
          onReveal={() => createdRow && void revealRow(createdRow.name)}
        />
      )}

      {importOpen && (
        <SkillImportDialog
          scan={importScanResult}
          selection={importSelection}
          scope={importScope}
          results={importResults}
          onToggleRow={toggleImportRow}
          onScopeChange={setImportScope}
          onApply={() => void applyImport()}
          onClose={closeImport}
        />
      )}
    </section>
  );
}

// ── row (design §1.4/§1.5: icon+name+badge line1, muted truncated description line2, right-aligned controls) ──

interface SkillRowItemProps {
  row: SkillRowView;
  confirmDelete: boolean;
  onToggle: () => void;
  onReveal: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function SkillRowItem({ row, confirmDelete, onToggle, onReveal, onRequestDelete, onCancelDelete, onConfirmDelete }: SkillRowItemProps) {
  const manageable = canManageSkillRow(row);

  return (
    <li className="skills-row mcp-row" data-skill-name={row.name} data-skill-source={row.sourceKind} data-skill-enabled={row.enabled}>
      <div className="skills-row-main mcp-row-main">
        <FileIcon className="skills-row-icon" aria-hidden="true" />
        <div className="mcp-row-lines">
          <div className="mcp-row-line1">
            <span className="skills-row-name settings-mcp-name">{row.name}</span>
            {manageable ? (
              <span className={`skills-badge skills-badge-${row.sourceKind}`}>{sourceKindBadgeLabel(row.sourceKind)}</span>
            ) : (
              <>
                {row.pluginName && <span className="skills-plugin-name">{row.pluginName}</span>}
                <span className="skills-badge skills-badge-plugin">Plugin</span>
              </>
            )}
          </div>
          <div className="mcp-row-line2" title={row.description}>
            {row.description}
          </div>
        </div>
      </div>

      {manageable && (
        <div className="mcp-row-controls">
          {confirmDelete ? (
            <span className="mcp-confirm-row">
              <span className="mcp-confirm-text">Delete "{row.name}"?</span>
              <button type="button" className="settings-button settings-button-danger" onClick={onConfirmDelete}>
                Delete
              </button>
              <button type="button" className="settings-button" onClick={onCancelDelete}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={row.enabled}
                aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
                className={`settings-switch${row.enabled ? " settings-switch-on" : ""}`}
                onClick={onToggle}
              >
                <span className="settings-switch-thumb" />
              </button>
              <button type="button" className="skills-icon-button mcp-icon-button" aria-label={`Reveal ${row.name}`} onClick={onReveal}>
                <Folder />
              </button>
              <button
                type="button"
                className="skills-icon-button mcp-icon-button mcp-icon-button-danger"
                aria-label={`Delete ${row.name}`}
                onClick={onRequestDelete}
              >
                <Trash />
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ── create dialog (design §2 D1: scaffold-only, no in-app editor) ──

interface SkillCreateDialogProps {
  fields: SkillCreateFields;
  error: string | null;
  createdRow: SkillRowView | null;
  onChange: (fields: SkillCreateFields) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onReveal: () => void;
}

function SkillCreateDialog({ fields, error, createdRow, onChange, onCancel, onSubmit, onReveal }: SkillCreateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  function set<K extends keyof SkillCreateFields>(key: K, value: SkillCreateFields[K]): void {
    onChange({ ...fields, [key]: value });
  }

  const nameTouched = fields.name.trim().length > 0;
  const nameInvalid = nameTouched && !isValidSkillName(fields.name);
  const canSubmit = canSubmitSkillCreate(fields);

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog skills-create-dialog"
      aria-label="Create skill"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">Create skill</span>
      </div>
      <div className="mcp-dialog-body">
        {createdRow ? (
          <div className="skills-create-confirm">
            <p>
              Created at <code className="skills-create-path">{createdRow.path}</code>.
            </p>
            <button type="button" className="settings-button" onClick={onReveal}>
              Reveal
            </button>
          </div>
        ) : (
          <>
            <label className="settings-field">
              <span className="settings-field-label">Name</span>
              <input
                className="settings-field-input"
                type="text"
                value={fields.name}
                onChange={(e) => set("name", e.target.value)}
              />
              {nameInvalid && (
                <span className="skills-field-invalid">
                  Use letters, numbers, "-", or "_" — must start with a letter or number.
                </span>
              )}
            </label>
            <label className="settings-field">
              <span className="settings-field-label">Description</span>
              <textarea
                className="settings-field-input mcp-textarea"
                value={fields.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </label>
            <div className="settings-field">
              <span className="settings-field-label">Scope</span>
              <div className="mcp-radio-row">
                <label>
                  <input type="radio" name="skill-scope" checked={fields.scope === "user"} onChange={() => set("scope", "user")} />
                  Personal
                </label>
                <label>
                  <input type="radio" name="skill-scope" checked={fields.scope === "project"} onChange={() => set("scope", "project")} />
                  Workspace
                </label>
              </div>
            </div>
            {error && <div className="settings-env-warning">{error}</div>}
          </>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onCancel}>
          {createdRow ? "Close" : "Cancel"}
        </button>
        {!createdRow && (
          <button type="button" className="settings-button settings-button-primary" disabled={!canSubmit} onClick={onSubmit}>
            Create skill
          </button>
        )}
      </div>
    </dialog>
  );
}

// ── import dialog (design §2 D2/D3: candidates grouped by harness, one dialog-level scope radio) ──

interface SkillImportDialogProps {
  scan: SkillsImportScanResult | null;
  selection: Record<string, boolean>;
  scope: SkillScope;
  results: SkillsImportApplyResultItem[] | null;
  onToggleRow: (id: string) => void;
  onScopeChange: (scope: SkillScope) => void;
  onApply: () => void;
  onClose: () => void;
}

function SkillImportDialog({ scan, selection, scope, results, onToggleRow, onScopeChange, onApply, onClose }: SkillImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const groups = scan ? groupSkillImportCandidates(scan.candidates) : [];

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog mcp-import-dialog skills-import-dialog"
      aria-label="Import skills"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">Import skills</span>
      </div>
      <div className="mcp-dialog-body" data-skills-scan-loaded={scan !== null}>
        {!scan ? (
          <div className="settings-mcp-empty">Scanning for skills…</div>
        ) : groups.length === 0 ? (
          <div className="settings-mcp-empty">No skills found in Claude, Codex, zcode, or installed plugins.</div>
        ) : (
          <>
            {scan.problems.map((problem) => (
              <div key={problem} className="mcp-problem-strip" role="alert">
                <span>{problem}</span>
              </div>
            ))}
            {groups.map((group) => (
              <div key={`${group.harness}:${group.sourceDir}`} className="mcp-import-group">
                <div className="mcp-import-group-header">
                  <span className="mcp-import-harness">{skillHarnessLabel(group.harness)}</span>
                  <span className="mcp-import-source settings-mcp-name">{group.sourceDir}</span>
                </div>
                {group.candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className={`mcp-import-row${candidate.compatible ? "" : " skills-import-row-disabled"}`}
                    data-skills-import-id={candidate.id}
                    data-skills-import-name={candidate.name}
                    data-skills-import-harness={candidate.harness}
                    data-skills-import-needs-conversion={candidate.needsConversion}
                    data-skills-import-already={candidate.alreadyPresent}
                  >
                    <input
                      type="checkbox"
                      checked={selection[candidate.id] ?? false}
                      disabled={!candidate.compatible}
                      onChange={() => onToggleRow(candidate.id)}
                    />
                    <span className="mcp-import-name settings-mcp-name">{candidate.name}</span>
                    {!candidate.compatible && (
                      <span className="mcp-badge skills-badge-incompatible" title={candidate.conversionNotes.join("; ")}>
                        incompatible{candidate.conversionNotes.length > 0 ? ` — ${candidate.conversionNotes.join(", ")}` : ""}
                      </span>
                    )}
                    {candidate.compatible && candidate.alreadyPresent && (
                      <span className="mcp-badge">{importConflictBadge(candidate)}</span>
                    )}
                    {candidate.compatible && candidate.needsConversion && (
                      <span className="mcp-badge" title={candidate.conversionNotes.join("; ")}>
                        will convert
                      </span>
                    )}
                    <span className="mcp-row-line2">{candidate.description}</span>
                  </label>
                ))}
              </div>
            ))}

            <div className="mcp-import-scope">
              <span className="settings-field-label">Import into</span>
              <div className="mcp-radio-row">
                <label data-skills-import-scope="user">
                  <input type="radio" name="skills-import-scope" checked={scope === "user"} onChange={() => onScopeChange("user")} />
                  Personal
                </label>
                <label data-skills-import-scope="project">
                  <input type="radio" name="skills-import-scope" checked={scope === "project"} onChange={() => onScopeChange("project")} />
                  Workspace
                </label>
              </div>
            </div>

            {results && (
              <div className="mcp-import-results">
                {results.map((item) => (
                  <div key={item.id} className="mcp-import-result">
                    {skillImportResultText(item)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={selectedImportIds(selection).length === 0}
          onClick={onApply}
        >
          {skillsImportFooterLabel(selection)}
        </button>
      </div>
    </dialog>
  );
}

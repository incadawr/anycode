/**
 * Language servers settings pane (Taskana 4743): catalog of well-known LSP
 * servers with Found / Not installed detection, a copyable install hint,
 * one-click enable per project or for all projects, a configured-servers list
 * per scope, a custom-entry form, live status for the active tab, and the
 * notices (new sessions; project trust). Everything the pane shows about a
 * command or args is rendered as PLAIN TEXT.
 *
 * DATA (shared/lsp-config.ts): the `lspConfig.status` snapshot comes from
 * main — detection is existence-only (nothing is installed, nothing is
 * executed) and never returns a binary path. Mutations carry ONLY
 * `{presetId|name|entry, scope, tabId}`; main resolves every path itself.
 *
 * LIVE STATUS reuses LspPanel's exported formatting helpers over the same
 * `lsp_status_request` plane (sent on mount, stored on the per-tab store the
 * panel already subscribes to) plus the existing Restart action, which
 * restarts CRASHED servers only — it does not reload config.
 *
 * SEMANTICS the pane must state (they are the honest limits of this feature):
 * config is read once per host boot, so changes apply to NEW sessions and
 * tabs; project entries start only after the folder is trusted.
 */
import { useContext, useEffect, useState } from "react";
import { formatLspExtensions, formatLspState } from "./LspPanel.js";
import {
  NEW_SESSIONS_NOTICE,
  NOT_INSTALLED_NOTICE,
  blankCustomForm,
  buildCatalogRows,
  buildCustomUpsertRequest,
  buildDisableRequest,
  buildEnableRequest,
  canSubmitCustomForm,
  formatCommandLine,
  lspRefusalMessage,
  catalogRowAction,
  sortEntryViews,
  trustNotice,
  validateCustomForm,
  type CustomLspFormFields,
} from "./language-servers-model.js";
import { hasCrashedLspServer } from "./EnvironmentMenu.js";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import type { DesktopStoreApi } from "../tab-registry.js";
import type {
  LspConfigScope,
  LspConfigStatus,
  LspCustomUpsertRequest,
  LspDisableRequest,
  LspEnableRequest,
  LspMutationResult,
} from "../../../shared/lsp-config.js";

// ── bridge (DI, same ethic as McpServersPane's McpConfigBridge) ──

/** Subset of `window.anycode.lspConfig` this pane drives, injectable so tests never touch a real `window`. */
export interface LspConfigBridge {
  status(req?: { tabId?: string }): Promise<LspConfigStatus>;
  enable(req: LspEnableRequest): Promise<LspMutationResult>;
  disable(req: LspDisableRequest): Promise<LspMutationResult>;
  customUpsert(req: LspCustomUpsertRequest): Promise<LspMutationResult>;
}

export interface LanguageServersPaneProps {
  /** Scope reference (Taskana 4758): a tab id or a workspace id `ws_…`, resolved main-side; omit for the pre-tab case. */
  tabId?: string;
  /** Injectable for tests / isolation; defaults to `window.anycode.lspConfig`. */
  bridge?: LspConfigBridge;
  /** Taskana 4758: reports the pane's count for the scope chip (null while loading). */
  onCountChange?: (count: number | null) => void;
  /**
   * The scope tab's store, when the caller sits outside that tab's
   * <TabContext.Provider> (Settings does) — the live-status section then
   * renders against it. Ignored when a provider is already in scope.
   */
  tabStore?: DesktopStoreApi;
}

export function LanguageServersPane({ tabId, bridge = window.anycode.lspConfig, tabStore, onCountChange }: LanguageServersPaneProps) {
  const [status, setStatus] = useState<LspConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomLspFormFields | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Live status needs a tab context. Settings is mounted OUTSIDE any
  // <TabContext.Provider> and passes the scope tab's store instead; the tab
  // hooks (which throw without a provider) live only inside <LiveLspStatus>,
  // which is rendered only when one of the two resolves.
  const ambientTabCtx = useContext(TabContext);
  const tabCtx = ambientTabCtx ?? (tabId !== undefined && tabStore !== undefined ? { tabId, store: tabStore } : null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void bridge.status({ tabId }).then((snap) => {
      if (!cancelled) {
        setStatus(snap);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, tabId]);

  // Taskana 4758: the scope chip's count = configured entries across scopes.
  const configuredCount = status ? (status.entries.project ?? []).length + status.entries.user.length : null;
  useEffect(() => {
    onCountChange?.(configuredCount);
  }, [configuredCount, onCountChange]);
  useEffect(() => () => onCountChange?.(null), [onCountChange]);

  async function apply(result: Promise<LspMutationResult>): Promise<boolean> {
    const resolved = await result;
    if (resolved.ok) {
      setStatus(resolved.status);
      setError(null);
      return true;
    }
    setError(lspRefusalMessage(resolved.reason));
    return false;
  }

  function copyInstallHint(id: string, hint: string): void {
    const write = navigator.clipboard?.writeText(hint);
    if (!write) {
      return;
    }
    void write.then(
      () => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId(null), 1500);
      },
      () => {},
    );
  }

  function enable(row: { entry: { id: string }; notInstalled: boolean }, scope: LspConfigScope): void {
    if (row.notInstalled) {
      // Allowed — the inline note below explains the consequence.
    }
    void apply(bridge.enable(buildEnableRequest(tabId, row.entry.id, scope)));
  }

  function disable(name: string, scope: LspConfigScope): void {
    void apply(bridge.disable(buildDisableRequest(tabId, name, scope)));
  }

  async function submitCustom(): Promise<void> {
    if (!form || !canSubmitCustomForm(form)) {
      return;
    }
    const ok = await apply(bridge.customUpsert(buildCustomUpsertRequest(tabId, form)));
    if (ok) {
      setForm(null);
      setFormError(null);
    }
  }

  const rows = status ? buildCatalogRows(status) : [];
  const projectEntries = status?.entries.project !== undefined && status.entries.project !== null ? sortEntryViews(status.entries.project) : [];
  const userEntries = status ? sortEntryViews(status.entries.user) : [];

  return (
    <section className="settings-section lsp-pane" aria-label="Language servers">
      {/* Notices: always visible, plain text (brief §2.5e). */}
      <div className="lsp-pane-notices">
        <p>{NEW_SESSIONS_NOTICE}</p>
        {status && <p>{trustNotice(status.projectTrusted)}</p>}
      </div>

      {error && (
        <div className="mcp-problem-strip" role="alert">
          <span>{error}</span>
        </div>
      )}
      {status?.issues.map((issue) => (
        <div key={issue} className="mcp-problem-strip" role="alert">
          <span>{issue}</span>
        </div>
      ))}

      {/* a) Catalog */}
      <div className="mcp-section">
        <div className="mcp-section-title">
          Catalog <span className="mcp-section-count">{rows.length} server{rows.length === 1 ? "" : "s"}</span>
        </div>
        {!status ? (
          <div className="settings-mcp-empty">Checking for language servers…</div>
        ) : (
          <ul className="mcp-row-list">
            {rows.map((row) => (
              <li key={row.entry.id} className="mcp-row lsp-catalog-row" data-lsp-catalog-id={row.entry.id}>
                <div className="mcp-row-main">
                  <div className="mcp-row-lines">
                    <div className="mcp-row-line1">
                      <span className="mcp-row-name settings-mcp-name">{row.entry.label}</span>
                      <span className={`mcp-badge ${row.entry.found ? "mcp-badge-user" : ""}`}>{row.badge}</span>
                      {row.enabledLabel && <span className="mcp-badge mcp-badge-tools">{row.enabledLabel}</span>}
                    </div>
                    <div className="mcp-row-line2" title={formatCommandLine(row.entry.command, row.entry.args)}>
                      {row.entry.languages} · {formatCommandLine(row.entry.command, row.entry.args)} ·{" "}
                      {row.entry.extensions.join(", ")}
                    </div>
                    {row.extensionOverlap && (
                      <div className="mcp-row-hint">
                        Extension overlap: {row.entry.extensions.join(", ")} — also claimed by {row.overlapWith}; the first
                        matching server wins for a file.
                      </div>
                    )}
                    {row.projectOnlyHint !== null && <div className="mcp-row-hint">{row.projectOnlyHint}</div>}
                    {!row.entry.found && (
                      <div className="mcp-row-hint lsp-install-hint">
                        <span className="lsp-install-command">{row.entry.installHint}</span>
                        <button
                          type="button"
                          className="settings-button"
                          aria-label={`Copy install command for ${row.entry.label}`}
                          onClick={() => copyInstallHint(row.entry.id, row.entry.installHint)}
                        >
                          {copiedId === row.entry.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                    )}
                    {row.notInstalled && (row.enabled.project || row.enabled.user) && (
                      <div className="mcp-row-hint">{NOT_INSTALLED_NOTICE}</div>
                    )}
                  </div>
                </div>
                <div className="mcp-row-controls">
                  {(() => {
                    const action = catalogRowAction(row, status?.projectScopeAvailable ?? false);
                    return (
                      <>
                        {action.inheritedNote !== null && <span className="mcp-row-hint">{action.inheritedNote}</span>}
                        <button
                          type="button"
                          className={action.kind === "enable" ? "settings-button settings-button-primary" : "settings-button"}
                          aria-label={action.ariaLabel}
                          onClick={() => (action.kind === "enable" ? enable(row, action.scope) : disable(row.entry.id, action.scope))}
                        >
                          {action.label}
                        </button>
                      </>
                    );
                  })()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* b) Configured servers per scope */}
      <div className="mcp-section">
        <div className="mcp-section-title">Configured servers</div>
        {status?.entries.project === null ? (
          <div className="mcp-row-hint">Project section: no project is open.</div>
        ) : (
          <ScopeEntryList
            title="This project"
            entries={projectEntries}
            emptyText="No project language servers configured."
            onRemove={(name) => disable(name, "project")}
          />
        )}
        <ScopeEntryList
          title="All projects (user config)"
          entries={userEntries}
          emptyText="No user language servers configured."
          onRemove={(name) => disable(name, "user")}
        />
      </div>

      {/* c) Custom server form */}
      <div className="mcp-section">
        <div className="mcp-section-title">Custom server</div>
        {form === null ? (
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button"
              aria-label="Add a custom language server"
              onClick={() => {
                setFormError(null);
                setForm(blankCustomForm(tabId !== undefined ? "project" : "user"));
              }}
            >
              Add custom server
            </button>
          </div>
        ) : (
          <CustomServerForm
            fields={form}
            error={formError}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onSubmit={() => void submitCustom()}
          />
        )}
      </div>

      {/* d) Live status for the active tab (same plane as the LspPanel drawer) */}
      {tabCtx && (
        <TabContext.Provider value={tabCtx}>
          <LiveLspStatus />
        </TabContext.Provider>
      )}
    </section>
  );
}

// ── live status (needs a TabContext provider) ──

function LiveLspStatus() {
  const liveServers = useTabStore((state) => state.lspServers);
  const send = useTabSend();

  // Same subscription the LspPanel drawer uses: ask once on mount, then read
  // whatever the store holds as lsp_status events land.
  useEffect(() => {
    send({ type: "lsp_status_request" });
  }, [send]);

  return (
    <div className="mcp-section">
      <div className="mcp-section-title">
        Live status
        <span className="mcp-section-note">This tab · config was read when the tab started</span>
      </div>
      {liveServers.length === 0 ? (
        <div className="mcp-row-hint">
          No language servers running in this tab (none configured when it started).
        </div>
      ) : (
        <>
          <ul className="mcp-row-list">
            {liveServers.map((server) => (
              <li key={server.name} className="mcp-row lsp-status-row" data-lsp-status-name={server.name}>
                <div className="mcp-row-main">
                  <div className="mcp-row-lines">
                    <div className="mcp-row-line1">
                      <span className="mcp-row-name settings-mcp-name">{server.name}</span>
                      <span className={`lsp-state lsp-state-${server.state}`}>{formatLspState(server.state)}</span>
                    </div>
                    <div className="mcp-row-line2">{formatLspExtensions(server.extensions)} · pid {server.pid ?? "-"}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {hasCrashedLspServer(liveServers) && (
            <div className="settings-field-row">
              <button
                type="button"
                className="settings-button"
                aria-label="Restart crashed servers"
                onClick={() => send({ type: "lsp_restart_request" })}
              >
                Restart crashed servers
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── configured-entry list per scope ──

function ScopeEntryList({
  title,
  entries,
  emptyText,
  onRemove,
}: {
  title: string;
  entries: { name: string; command: string; args: string[]; extensions: string[]; presetId: string | null; hasInitOptions: boolean }[];
  emptyText: string;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="lsp-scope-block">
      <div className="mcp-section-title lsp-scope-title">
        {title} <span className="mcp-section-count">{entries.length} item{entries.length === 1 ? "" : "s"}</span>
      </div>
      {entries.length === 0 ? (
        <div className="mcp-row-hint">{emptyText}</div>
      ) : (
        <ul className="mcp-row-list">
          {entries.map((entry) => (
            <li key={entry.name} className="mcp-row lsp-configured-row" data-lsp-entry-name={entry.name}>
              <div className="mcp-row-main">
                <div className="mcp-row-lines">
                  <div className="mcp-row-line1">
                    <span className="mcp-row-name settings-mcp-name">{entry.name}</span>
                    {entry.presetId && <span className="mcp-badge">catalog</span>}
                    {entry.hasInitOptions && <span className="mcp-badge">init options</span>}
                  </div>
                  <div className="mcp-row-line2" title={formatCommandLine(entry.command, entry.args)}>
                    {formatCommandLine(entry.command, entry.args)} · {entry.extensions.join(", ")}
                  </div>
                </div>
              </div>
              <div className="mcp-row-controls">
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  aria-label={`Remove ${entry.name}`}
                  onClick={() => onRemove(entry.name)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── custom form (inline, no dialog — matches other panes' field styling) ──

function CustomServerForm({
  fields,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  fields: CustomLspFormFields;
  error: string | null;
  onChange: (fields: CustomLspFormFields) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const errors = validateCustomForm(fields);

  function set<K extends keyof CustomLspFormFields>(key: K, value: CustomLspFormFields[K]): void {
    onChange({ ...fields, [key]: value });
  }

  return (
    <div className="lsp-custom-form" aria-label="Add a custom language server">
      <label className="settings-field">
        <span className="settings-field-label">Name</span>
        <input
          className="settings-field-input"
          type="text"
          value={fields.name}
          placeholder="my-server"
          onChange={(e) => set("name", e.target.value)}
        />
        {errors.name && <span className="settings-field-error">{errors.name}</span>}
      </label>
      <label className="settings-field">
        <span className="settings-field-label">Command (one executable name or absolute path)</span>
        <input
          className="settings-field-input"
          type="text"
          value={fields.command}
          placeholder="my-language-server"
          onChange={(e) => set("command", e.target.value)}
        />
        {errors.command && <span className="settings-field-error">{errors.command}</span>}
      </label>
      <label className="settings-field">
        <span className="settings-field-label">Arguments (quoted tokens allowed)</span>
        <input
          className="settings-field-input"
          type="text"
          value={fields.argsText}
          placeholder="--stdio"
          onChange={(e) => set("argsText", e.target.value)}
        />
      </label>
      <label className="settings-field">
        <span className="settings-field-label">File extensions (comma or space separated)</span>
        <input
          className="settings-field-input"
          type="text"
          value={fields.extensionsText}
          placeholder=".zig, .zir"
          onChange={(e) => set("extensionsText", e.target.value)}
        />
        {errors.extensions && <span className="settings-field-error">{errors.extensions}</span>}
      </label>
      <div className="settings-field">
        <span className="settings-field-label">Scope</span>
        <div className="mcp-radio-row">
          <label>
            <input
              type="radio"
              name="lsp-custom-scope"
              checked={fields.scope === "project"}
              onChange={() => set("scope", "project")}
            />
            This project
          </label>
          <label>
            <input type="radio" name="lsp-custom-scope" checked={fields.scope === "user"} onChange={() => set("scope", "user")} />
            All projects
          </label>
        </div>
      </div>
      {error && (
        <div className="mcp-problem-strip" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="settings-field-row">
        <button type="button" className="settings-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={!canSubmitCustomForm(fields)}
          onClick={onSubmit}
        >
          Add server
        </button>
      </div>
    </div>
  );
}

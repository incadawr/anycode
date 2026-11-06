import { Button, IconButton, Switch } from "../ui/index.js";
/**
 * Plugins pane (Settings → Plugins; design 4732 §6, S1-C,
 * reconciled to the S1-B wire contract).
 *
 * DATA: the pane fetches a `PluginsSnapshot` via `window.anycode.plugins`
 * (preload bridge over the `anycode:plugins-*` channels of
 * shared/plugins-config.ts) on mount and re-renders from the snapshot a
 * mutation RETURNS where one is returned (main's S1-B mutations return
 * `{ok:true}` and push `plugins-changed`, so the pane refetches `list()`
 * after those — the push subscription covers the rest). All display
 * decisions (chips, actions, index header, install menu, available-row
 * states, sheet labels) live in plugins-pane-model.ts — this file only
 * wires them to the bridge and the DOM.
 *
 * UNAVAILABLE STATE (S1-C's hard requirement): when the main handlers are
 * absent, every bridge call rejects — `load()` catches, sets `unavailable`,
 * and the pane renders an honest "Plugins service unavailable" card instead
 * of crashing. Hand-dropped plugin directories keep working through
 * discovery exactly as before; nothing here mutates them.
 *
 * CUSTODY (plugins-config.ts header): no filesystem path ever crosses in a
 * request — file/folder installs carry no path (main opens its own picker),
 * plugins are identified by `name`, and `reveal` re-resolves main-side.
 * Install commit sends the single-use token plus the ORIGINAL source
 * (main binds the token to it); `allowMcp` rides the consent checkbox.
 */
import { useEffect, useState } from "react";
import type {
  PluginInstallPreview,
  PluginInstallSource,
  PluginRowView,
  PluginServiceView,
  PluginsChangedReason,
  PluginsMutationResult,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";
import { Search, X } from "./icons.js";
import {
  availableRowState,
  filterPluginRows,
  hasNonOfficialPlugins,
  installMenuOptions,
  pluginEnabled,
  pluginMcpNeedsApproval,
  pluginPinned,
  pluginsEmptyKind,
  type PluginsEmptyKind,
  pluginsRefusalMessage,
  pluginCapabilitiesText,
  pluginIndexHeaderText,
  pluginIndexStatusText,
  pluginRowActions,
  pluginSourceText,
  pluginStatusChips,
  pluginTierLabel,
  pluginUpdateVersion,
  rollbackLabel,
  serviceChip,
  servicesNeedApproval,
  serviceSecretNamesOf,
  sessionsApiHint,
  type SessionsApiState,
} from "./plugins-pane-model.js";
import { PluginInstallDialog, type InstallDialogStage } from "./PluginInstallSheet.js";

// ── bridge (DI, same ethic as McpServersPane's McpConfigBridge) ──

/**
 * Subset of `window.anycode.plugins` (the S1-B preload bridge) this pane
 * drives, injectable so tests never touch a real `window`.
 */
export interface PluginsBridge {
  list(request?: { tabId?: string }): Promise<PluginsSnapshot>;
  checkUpdates(): Promise<PluginsSnapshot>;
  installPrepare(source: PluginInstallSource): Promise<{ ok: true; token: string; preview: PluginInstallPreview } | { ok: false; reason: Parameters<typeof pluginsRefusalMessage>[0]; detail?: string }>;
  installCommit(token: string, source: PluginInstallSource, allowMcp?: boolean, allowServices?: boolean): Promise<{ ok: true; snapshot: PluginsSnapshot } | { ok: false; reason: Parameters<typeof pluginsRefusalMessage>[0]; detail?: string }>;
  update(name: string): Promise<PluginsMutationResult>;
  rollback(name: string): Promise<PluginsMutationResult>;
  setPinned(name: string, value: boolean): Promise<PluginsMutationResult>;
  setEnabled(name: string, value: boolean): Promise<PluginsMutationResult>;
  remove(name: string): Promise<PluginsMutationResult>;
  approveMcp(name: string): Promise<PluginsMutationResult>;
  /** consent for the plugin's current services definition. */
  approveServices?(name: string): Promise<PluginsMutationResult>;
  /** supervised service states (polled while the pane is open). */
  services?(): Promise<PluginServiceView[]>;
  serviceLogs?(plugin: string, name: string): Promise<string[]>;
  serviceRestart?(plugin: string, name: string): Promise<PluginsMutationResult>;
  reveal(name: string): Promise<PluginsMutationResult>;
  setAutoUpdate(value: boolean): Promise<PluginsMutationResult>;
  /** Push subscription: main fires it after any plugin-set change (reason only). */
  onChanged(callback: (payload: PluginsChangedReason) => void): () => void;
}

/** The pane's load state: `loading` until the first bridge answer, `unavailable` on rejection. */
export type PluginsLoadState = "loading" | "ready" | "unavailable";

/** Default Sessions-API state read: `communication.get()` (off when the bridge is absent). */
function defaultSessionsApiState(): Promise<SessionsApiState> {
  const get = window.anycode?.communication?.get;
  if (typeof get !== "function") return Promise.resolve("off");
  return get().then((result) => (result.ok ? result.view.status.state : "off"));
}

/**
 * Pure guard for the pane's load effect: an EXPLICIT `unavailable` marker
 * wins (the bridge rejected — honest empty state, never a retry loop),
 * otherwise the snapshot's presence decides. Exported for the render test.
 */
export function isPluginsServiceUnavailable(state: PluginsLoadState, snapshot: PluginsSnapshot | null): boolean {
  return state === "unavailable" || (state !== "loading" && snapshot === null);
}

export interface PluginsPaneProps {
  catalogTabId?: string;
  catalogOriginUnavailable?: boolean;
  onCatalogReset?: () => void;
  /** Injectable for tests / isolation; defaults to `window.anycode.plugins`. */
  bridge?: PluginsBridge;
  /** the Sessions-API state for the services hint; defaults to `communication.get()`. */
  sessionsApiStateOf?: () => Promise<SessionsApiState>;
}

export function PluginsPane({
  bridge = window.anycode.plugins,
  sessionsApiStateOf = defaultSessionsApiState,
  catalogTabId,
  catalogOriginUnavailable = false,
  onCatalogReset,
}: PluginsPaneProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<PluginsLoadState>("loading");
  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [busyName, setBusyName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installStage, setInstallStage] = useState<InstallDialogStage>({ phase: "source" });
  const [pendingSource, setPendingSource] = useState<PluginInstallSource | null>(null);
  // One-slot banner driven by the plugins-changed push (design §7): main
  // fires it after any plugin-set change OUTSIDE this pane (auto-updates,
  // another window); our own mutations refetch immediately, so the banner
  // is informational — "applies to newly started tasks" — and self-dismisses.
  const [changedNotice, setChangedNotice] = useState<string | null>(null);
  // service read model (polled), the Sessions-API state for the hint,
  // and the one open log (plain text, key = plugin/name).
  const [services, setServices] = useState<PluginServiceView[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionsApiState>("off");
  const [openLogKey, setOpenLogKey] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (catalogOriginUnavailable) return;
    let cancelled = false;
    let generation = 0;
    setSnapshot(null);
    const load = () => {
      const request = ++generation;
      setLoadState("loading");
      void bridge.list(catalogTabId === undefined ? undefined : { tabId: catalogTabId })
        .then((snap) => {
          if (!cancelled && request === generation) {
            setSnapshot(snap);
            setLoadState("ready");
          }
        }).catch(() => {
          if (!cancelled && request === generation) setLoadState("unavailable");
        });
    };
    load();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge.onChanged?.((payload) => {
        setChangedNotice(`Plugins changed (${payload}) — applies to newly started tasks.`);
        load();
      });
    } catch { /* The catalog can still be read without push notifications. */ }
    return () => { cancelled = true; unsubscribe?.(); };
  }, [bridge, catalogTabId, catalogOriginUnavailable, reloadToken]);

  // Services are polled while the pane is open (2 s); a missing bridge method just leaves the list empty.
  useEffect(() => {
    if (typeof bridge.services !== "function") return undefined;
    let cancelled = false;
    const poll = () => {
      bridge
        .services!()
        .then((list) => {
          if (!cancelled) setServices(list);
        })
        .catch(() => undefined);
      const state = sessionsApiStateOf ? sessionsApiStateOf() : undefined;
      if (state !== undefined) {
        state
          .then((value) => {
            if (!cancelled) setSessionsState(value);
          })
          .catch(() => undefined);
      }
    };
    poll();
    const handle = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, catalogTabId]);

  async function restartService(plugin: string, name: string): Promise<void> {
    if (typeof bridge.serviceRestart !== "function") return;
    await bridge.serviceRestart(plugin, name).catch(() => undefined);
    if (typeof bridge.services === "function") {
      setServices(await bridge.services().catch(() => []));
    }
  }

  async function toggleLog(plugin: string, name: string): Promise<void> {
    const key = `${plugin}/${name}`;
    if (openLogKey === key) {
      setOpenLogKey(null);
      return;
    }
    setOpenLogKey(key);
    if (typeof bridge.serviceLogs !== "function") return;
    const lines = await bridge.serviceLogs(plugin, name).catch(() => [] as string[]);
    setLogLines((current) => ({ ...current, [key]: lines }));
  }

  function copyLog(key: string): void {
    const text = (logLines[key] ?? []).join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  const rows = snapshot ? filterPluginRows(snapshot.plugins, searchQuery) : [];
  const emptyKind = pluginsEmptyKind(snapshot?.plugins.length ?? 0, rows.length, searchQuery);
  const indexHeader = snapshot ? pluginIndexStatusText(snapshot.index.status) : null;
  // xfix M5: the default is FALSE everywhere (schema, main,
  // scheduler, docs) — the old `?? true` rendered the toggle ON while the
  // scheduler's gate evaluated false: nothing ever auto-updated.
  const autoUpdate = snapshot?.settings.autoUpdateOfficial ?? false;

  /**
   * Run a `{ok:true}`-style mutation and refetch: main's S1-B per-plugin
   * handlers return a bare ok/refusal (no snapshot), then push
   * `plugins-changed`; the pane refetches `list()` on success so the rows
   * always render main's truth.
   */
  async function runMutation(name: string, run: () => Promise<PluginsMutationResult>): Promise<void> {
    setBusyName(name);
    setActionError(null);
    try {
      const result = await run();
      if (result.ok) {
        try {
          setSnapshot(await bridge.list(catalogTabId === undefined ? undefined : { tabId: catalogTabId }));
        } catch {
          setLoadState("unavailable");
        }
      } else {
        setActionError(pluginsRefusalMessage(result.reason));
      }
    } catch {
      // Bridge threw (channel gone mid-session) — same honest degradation.
      setLoadState("unavailable");
    } finally {
      setBusyName(null);
    }
  }

  async function checkNow(): Promise<void> {
    setChecking(true);
    setActionError(null);
    try {
      // check-updates resolves with the fresh snapshot itself (S1-B).
      const updated = await bridge.checkUpdates();
      setSnapshot(catalogTabId === undefined ? updated : await bridge.list({ tabId: catalogTabId }));
    } catch {
      setLoadState("unavailable");
    } finally {
      setChecking(false);
    }
  }

  async function toggleAutoUpdate(): Promise<void> {
    const next = !autoUpdate;
    // Optimistic: the toggle is instant; a refusal restores on the next snapshot.
    if (snapshot) {
      setSnapshot({ ...snapshot, settings: { ...snapshot.settings, autoUpdateOfficial: next } });
    }
    try {
      const result = await bridge.setAutoUpdate(next);
      if (!result.ok) {
        setActionError(pluginsRefusalMessage(result.reason));
        if (snapshot) {
          setSnapshot({ ...snapshot, settings: { ...snapshot.settings, autoUpdateOfficial: !next } });
        }
      }
    } catch {
      setLoadState("unavailable");
    }
  }

  function openInstall(source?: PluginInstallSource): void {
    setActionError(null);
    setInstallStage(
      source !== undefined && source.kind === "url"
        ? { phase: "url", url: "" }
        : source !== undefined && source.kind === "official"
          ? { phase: "prepare", source, preview: null }
          : { phase: "source" },
    );
    setInstallOpen(true);
  }

  function closeInstall(): void {
    setInstallOpen(false);
    setInstallStage({ phase: "source" });
    setPendingSource(null);
  }

  async function prepare(source: PluginInstallSource, url?: string): Promise<void> {
    const resolved: PluginInstallSource = source.kind === "url" && url !== undefined ? { kind: "url", url } : source;
    setInstallStage({ phase: "prepare", source: resolved, preview: null });
    setPendingSource(resolved);
    try {
      const result = await bridge.installPrepare(resolved);
      if (result.ok) {
        setInstallStage({ phase: "confirm", source: resolved, preview: result.preview, token: result.token });
      } else {
        setInstallStage({ phase: "error", source: resolved, error: pluginsRefusalMessage(result.reason) });
      }
    } catch {
      setLoadState("unavailable");
      setInstallOpen(false);
    }
  }

  async function commitInstall(token: string, allowMcp: boolean, allowServices: boolean): Promise<void> {
    if (pendingSource === null) {
      return;
    }
    try {
      // CUSTODY: the wire carries the token + the ORIGINAL source only —
      // never a path or hash; `allowMcp` is the consent checkbox (
      // 4732 xfix H1(b): main records the grant for the previewed command
      // lines when true; unchecked = servers stay off until Approve MCP).
      const result = await bridge.installCommit(token, pendingSource, allowMcp, allowServices);
      if (result.ok) {
        setSnapshot(catalogTabId === undefined ? result.snapshot : await bridge.list({ tabId: catalogTabId }));
        setInstallOpen(false);
        setInstallStage({ phase: "source" });
        setPendingSource(null);
      } else {
        setInstallStage((stage) => (stage.phase === "confirm" ? { ...stage, error: pluginsRefusalMessage(result.reason) } : stage));
      }
    } catch {
      setLoadState("unavailable");
      setInstallOpen(false);
    }
  }

  async function reveal(row: PluginRowView): Promise<void> {
    setBusyName(row.name);
    try {
      const result = await bridge.reveal(row.name);
      if (!result.ok) {
        setActionError(pluginsRefusalMessage(result.reason));
      }
    } catch {
      setLoadState("unavailable");
    } finally {
      setBusyName(null);
    }
  }

  if (catalogOriginUnavailable) {
    return <section className="settings-section plugins-pane" data-plugins-state="no-origin">
      <p role="status">The original session is no longer available. Reload to view the current plugins catalog.</p>
      <Button className="settings-button" onClick={onCatalogReset}>Reload plugins</Button>
    </section>;
  }
  if (isPluginsServiceUnavailable(loadState, snapshot)) {
    return <PluginsUnavailableCard onRetry={() => setReloadToken(value => value + 1)} />;
  }

  return (
    <section className="settings-section plugins-pane" data-plugins-state={loadState}>
      {/* header: check-now, last check, index status, auto-update toggle (design §6) */}
      <div className="plugins-pane-toolbar">
        <button
          type="button"
          className="settings-button"
          disabled={snapshot === null || checking}
          onClick={() => void checkNow()}
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {snapshot && indexHeader && (
          <span className={`plugins-index-status plugins-index-${indexHeader.tone}`} data-plugins-index={snapshot.index.status}>
            {pluginIndexHeaderText(snapshot.index.status, snapshot.index.checkedAt)}
          </span>
        )}
        <label className="plugins-auto-update">
          <Switch
            type="button"
            checked={autoUpdate}
            aria-label="Auto-update official plugins"
            onCheckedChange={() => void toggleAutoUpdate()}
           />
          <span className="settings-switch-caption">Auto-update official plugins</span>
        </label>
      </div>

      <div className="mcp-pane-toolbar">
        <label className="settings-search mcp-pane-search">
          <Search className="settings-search-icon" />
          <input
            type="text"
            className="settings-search-input"
            placeholder="Search plugins…"
            aria-label="Search plugins"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <div className="mcp-pane-actions">
          <button type="button" className="settings-button" onClick={() => openInstall()}>
            Install…
          </button>
        </div>
      </div>

      {changedNotice && (
        <div className="mcp-problem-strip plugins-changed-banner" role="status">
          <span>{changedNotice}</span>
          <IconButton type="button" label="Dismiss" onClick={() => setChangedNotice(null)} icon={<X />} />
        </div>
      )}

      {actionError && (
        <div className="mcp-problem-strip" role="alert">
          <span>{actionError}</span>
          <IconButton type="button" label="Dismiss" onClick={() => setActionError(null)} icon={<X />} />
        </div>
      )}

      {snapshot === null ? (
        <div className="settings-mcp-empty">Loading plugins…</div>
      ) : (
        <PluginsPaneBody
          snapshot={snapshot}
          rows={rows}
          emptyKind={emptyKind}
          busyName={busyName}
          onToggle={(name, enabled) => void runMutation(name, () => bridge.setEnabled(name, enabled))}
          onUpdate={(row) => void runMutation(row.name, () => bridge.update(row.name))}
          onRollback={(row) => void runMutation(row.name, () => bridge.rollback(row.name))}
          onPin={(row) => void runMutation(row.name, () => bridge.setPinned(row.name, !pluginPinned(row)))}
          onRemove={(row) => void runMutation(row.name, () => bridge.remove(row.name))}
          onApproveMcp={(row) => void runMutation(row.name, () => bridge.approveMcp(row.name))}
          onApproveServices={(row) => {
            if (typeof bridge.approveServices === "function") void runMutation(row.name, () => bridge.approveServices!(row.name));
          }}
          services={services}
          sessionsState={sessionsState}
          openLogKey={openLogKey}
          logLines={logLines}
          onRestartService={(plugin, name) => void restartService(plugin, name)}
          onToggleLog={(plugin, name) => void toggleLog(plugin, name)}
          onCopyLog={copyLog}
          onReveal={(row) => void reveal(row)}
          onInstallAvailable={(name, version) => void prepare({ kind: "official", name, ...(version !== undefined ? { version } : {}) })}
        />
      )}

      {installOpen && (
        <PluginInstallDialog
          stage={installStage}
          onPickSource={(source) => void prepare(source)}
          onSubmitUrl={(url) => void prepare({ kind: "url", url })}
          onCommit={(token, allowMcp, allowServices) => void commitInstall(token, allowMcp, allowServices)}
          onClose={closeInstall}
        />
      )}
    </section>
  );
}

// ── hook-FREE presentational pieces (directly callable in the no-jsdom tests) ──

/** The honest degraded card (never a crash when main handlers are absent). */
export function PluginsUnavailableCard({ onRetry }: { onRetry?: () => void } = {}) {
  return (
    <section className="settings-section plugins-pane" data-plugins-state="unavailable">
      <div className="settings-section-title">Plugins</div>
      <div className="settings-mcp-empty">
        Plugins service unavailable — this build's main process does not expose the plugins
        channels yet. Hand-placed plugin directories under <code>~/.anycode/plugins</code> and
        <code> .anycode/plugins</code> keep working as before.
      </div>
      {onRetry && <Button className="settings-button" onClick={onRetry}>Retry</Button>}
    </section>
  );
}

export interface PluginsPaneBodyProps {
  snapshot: PluginsSnapshot;
  rows: readonly PluginRowView[];
  emptyKind: PluginsEmptyKind;
  busyName: string | null;
  onToggle: (name: string, enabled: boolean) => void;
  onUpdate: (row: PluginRowView) => void;
  onRollback: (row: PluginRowView) => void;
  onPin: (row: PluginRowView) => void;
  onRemove: (row: PluginRowView) => void;
  onApproveMcp: (row: PluginRowView) => void;
  /** services consent (name-only request). */
  onApproveServices: (row: PluginRowView) => void;
  services: readonly PluginServiceView[];
  sessionsState: SessionsApiState;
  openLogKey: string | null;
  logLines: Readonly<Record<string, string[]>>;
  onRestartService: (plugin: string, name: string) => void;
  onToggleLog: (plugin: string, name: string) => void;
  onCopyLog: (key: string) => void;
  onReveal: (row: PluginRowView) => void;
  onInstallAvailable: (name: string, version: string | undefined) => void;
}

/** The installed + available lists — pure presentational, driven by the model helpers. */
export function PluginsPaneBody({
  snapshot,
  rows,
  emptyKind,
  busyName,
  onToggle,
  onUpdate,
  onRollback,
  onPin,
  onRemove,
  onApproveMcp,
  onApproveServices,
  services,
  sessionsState,
  openLogKey,
  logLines,
  onRestartService,
  onToggleLog,
  onCopyLog,
  onReveal,
  onInstallAvailable,
}: PluginsPaneBodyProps) {
  return (
    <>
      <div className="mcp-section">
        <div className="mcp-section-title">
          Installed <span className="mcp-section-count">{rows.length} item{rows.length === 1 ? "" : "s"}</span>
        </div>
        {rows.length === 0 ? (
          <div className="settings-mcp-empty">
            {emptyKind === "no_match" ? "No plugins match your search." : "No plugins installed yet."}
          </div>
        ) : (
          <ul className="mcp-row-list plugins-row-list">
            {rows.map((row) => (
              <PluginCard
                key={row.name}
                row={row}
                busy={busyName === row.name}
                onToggle={() => onToggle(row.name, !pluginEnabled(row))}
                onUpdate={() => onUpdate(row)}
                onRollback={() => onRollback(row)}
                onPin={() => onPin(row)}
                onRemove={() => onRemove(row)}
                onApproveMcp={() => onApproveMcp(row)}
                onApproveServices={() => onApproveServices(row)}
                services={services.filter((view) => view.plugin === row.name)}
                sessionsState={sessionsState}
                openLogKey={openLogKey}
                logLines={logLines}
                onRestartService={onRestartService}
                onToggleLog={onToggleLog}
                onCopyLog={onCopyLog}
                onReveal={() => onReveal(row)}
              />
            ))}
          </ul>
        )}
        {hasNonOfficialPlugins(snapshot) && (
          <div className="mcp-section-note">
            Third-party, project and legacy plugins are used at your own risk — only official
            (✓) plugins come from AnyCode's signed index. Plugin MCP servers never start
            without your approval.
          </div>
        )}
      </div>

      {snapshot.available.length > 0 && (
        <div className="mcp-section">
          <div className="mcp-section-title">
            Available from AnyCode{" "}
            <span className="mcp-section-count">
              {snapshot.available.length} item{snapshot.available.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="mcp-row-list plugins-row-list">
            {snapshot.available.map((entry) => {
              const state = availableRowState(entry);
              return (
                <li key={entry.name} className="mcp-row plugins-available-row" data-plugin-name={entry.name}>
                  <div className="mcp-row-main">
                    <div className="mcp-row-lines">
                      <div className="mcp-row-line1">
                        <span className="mcp-row-name settings-mcp-name">{entry.displayName || entry.name}</span>
                        {entry.default && <span className="mcp-badge mcp-badge-tools">default</span>}
                        {entry.version !== undefined && <span className="mcp-badge">{entry.version}</span>}
                      </div>
                      <div className="mcp-row-line2" title={entry.description}>
                        {entry.description}
                      </div>
                    </div>
                  </div>
                  <div className="mcp-row-controls">
                    {state.disabled ? (
                      <span className="plugins-install-hint" title={state.reason}>
                        {state.reason}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        onClick={() => onInstallAvailable(entry.name, entry.version)}
                      >
                        {state.label}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

// ── installed card (design §6: name+tier+version, source, chips, capabilities, actions) ──

interface PluginCardProps {
  row: PluginRowView;
  busy: boolean;
  onToggle: () => void;
  onUpdate: () => void;
  onRollback: () => void;
  onPin: () => void;
  onRemove: () => void;
  onApproveMcp: () => void;
  onApproveServices: () => void;
  services: readonly PluginServiceView[];
  sessionsState: SessionsApiState;
  openLogKey: string | null;
  logLines: Readonly<Record<string, string[]>>;
  onRestartService: (plugin: string, name: string) => void;
  onToggleLog: (plugin: string, name: string) => void;
  onCopyLog: (key: string) => void;
  onReveal: () => void;
}

function PluginCard({
  row,
  busy,
  onToggle,
  onUpdate,
  onRollback,
  onPin,
  onRemove,
  onApproveMcp,
  onApproveServices,
  services,
  sessionsState,
  openLogKey,
  logLines,
  onRestartService,
  onToggleLog,
  onCopyLog,
  onReveal,
}: PluginCardProps) {
  const chips = pluginStatusChips(row);
  const capabilities = pluginCapabilitiesText(row);
  const actions = pluginRowActions(row);
  const enabled = pluginEnabled(row);
  const pinned = pluginPinned(row);

  return (
    <li
      className={`mcp-row plugins-row${enabled ? "" : " plugins-row-disabled"}`}
      data-plugin-name={row.name}
      data-plugin-tier={row.tier}
      data-plugin-enabled={enabled}
    >
      <div className="mcp-row-main">
        <div className="mcp-row-lines">
          <div className="mcp-row-line1">
            <span className="mcp-row-name settings-mcp-name">{row.displayName || row.name}</span>
            <span className={`mcp-badge plugins-tier-${row.tier}`}>{pluginTierLabel(row.tier)}</span>
            {row.version !== undefined && <span className="mcp-badge">{row.version}</span>}
            {pinned && <span className="mcp-badge">pinned</span>}
          </div>
          <div className="mcp-row-line2" title={row.description}>
            {row.name} · {pluginSourceText(row.source)}
          </div>
          {capabilities !== "" && <div className="mcp-row-hint">{capabilities}</div>}
          {chips.length > 0 && (
            <div className="plugins-chip-row">
              {chips.map((chip) => (
                <span key={chip.text} className={`mcp-badge ${chip.tone === "warn" ? "mcp-badge-compat" : "mcp-badge-user"}`}>
                  {chip.text}
                </span>
              ))}
            </div>
          )}
          {row.problems.map((problem) => (
            <div key={problem} className="mcp-row-hint plugins-problem" role="alert">
              {problem}
            </div>
          ))}
          {row.serviceNames.length > 0 && (
            <div className="plugins-services" data-plugin-services={row.name}>
              {sessionsApiHint(true, sessionsState) !== undefined && (
                <p className="mcp-row-hint">{sessionsApiHint(true, sessionsState)}</p>
              )}
              {serviceSecretNamesOf(row).length > 0 && (
                <p className="mcp-row-hint">Reads secrets: {serviceSecretNamesOf(row).join(", ")}</p>
              )}
              {row.serviceNames.map((serviceName) => {
                const view = services.find((candidate) => candidate.name === serviceName);
                const chip = view !== undefined ? serviceChip(view) : { text: "Not running", tone: "muted" as const };
                const key = `${row.name}/${serviceName}`;
                return (
                  <div key={key} className="plugins-service-row" data-service-name={serviceName}>
                    <span className="mcp-row-name">{serviceName}</span>
                    <span className={`mcp-badge ${chip.tone === "warn" ? "mcp-badge-compat" : "mcp-badge-user"}`}>{chip.text}</span>
                    <Button size="sm" type="button" disabled={busy} onClick={() => onRestartService(row.name, serviceName)}>
                      Restart
                    </Button>
                    <Button size="sm" type="button" onClick={() => onToggleLog(row.name, serviceName)}>
                      {openLogKey === key ? "Hide log" : "View log"}
                    </Button>
                    {openLogKey === key && (
                      <div className="plugins-service-log-block">
                        <pre className="plugins-service-log">{(logLines[key] ?? []).join("\n")}</pre>
                        <Button size="sm" type="button" onClick={() => onCopyLog(key)}>
                          Copy log
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="mcp-row-controls">
        <Switch
          type="button"
          checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${row.name}`}
          disabled={busy}
          onCheckedChange={onToggle}
         />
        {actions.includes("update") && (
          <Button size="sm" type="button" disabled={busy} onClick={onUpdate}>
            Update
          </Button>
        )}
        {actions.includes("rollback") && (
          <Button size="sm" type="button" disabled={busy} onClick={onRollback}>
            {rollbackLabel(row)}
          </Button>
        )}
        {pluginMcpNeedsApproval(row) && (
          <Button size="sm" type="button" disabled={busy} onClick={onApproveMcp}>
            Approve MCP
          </Button>
        )}
        {servicesNeedApproval(row) && (
          <Button size="sm" type="button" disabled={busy} onClick={onApproveServices}>
            Approve services
          </Button>
        )}
        {(actions.includes("pin") || actions.includes("unpin")) && (
          <Button size="sm" type="button" disabled={busy} onClick={onPin}>
            {pinned ? "Unpin" : "Pin"}
          </Button>
        )}
        {actions.includes("reveal") && (
          <Button size="sm" type="button" disabled={busy} onClick={onReveal}>
            Reveal
          </Button>
        )}
        {actions.includes("remove") && (
          <Button size="sm" variant="danger" type="button" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

/** Exported for the install dialog's source menu (kept in one place — the model owns the list). */
export { installMenuOptions as pluginsInstallMenuOptions };
export type { PluginInstallPreview };

/**
 * First-run setup: choose ChatGPT/Codex, Claude Code, or API/local models.
 * Subscription paths reuse the existing account panes; API setup uses the
 * shared connection form with optional tuning collapsed. App owns readiness
 * and advances to the project draft after setup. Saved incomplete connections
 * resume in the API path and can still be switched or replaced.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import type { ProviderConnection } from "../../../shared/settings.js";
import { ConnectionDrawerFields } from "./ConnectionDrawer.js";
import { customProviderCatalogEntries, selectProviderEntry, shouldShowAppVersion } from "./SettingsScreen.js";
import { connectionCredentialKey, connectionDisplayName, connectionHealthStatus, describeConnectionHealth } from "./ConnectionTile.js";
import { BrandMark, Plus } from "./icons.js";
import { CodexEnginePane } from "./CodexEnginePane.js";
import { ClaudeEnginePane } from "./ClaudeEnginePane.js";
import { ConsentDialog } from "./ConsentDialog.js";
import "../settings.css";

export interface WelcomeScreenProps {
  /** Injectable for test isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  onSelectEngine?: (engine: "core" | "codex" | "claude") => void;
}

/**
 * WelcomeScreen's own local view state (TASK.68): either editing an existing
 * connection (by id) or creating a new one. `connectionId` is deliberately
 * absent from the `"add"` branch — nothing to fall back to once creation is
 * under way; the switcher list (still rendered during "add", when at least
 * one OTHER connection exists) is the return path back to a previously
 * edited connection, exactly as clicking any other row is.
 */
export type WelcomeConnectionsView = { mode: "edit"; connectionId: string } | { mode: "add" };

/** The view a fresh WelcomeScreen mount (or a fresh settings snapshot with no local override yet) starts on: the first saved connection if one exists, otherwise creation. Exported for direct testing (no jsdom — see file docstring). */
export function initialConnectionsView(connections: readonly Pick<ProviderConnection, "id">[]): WelcomeConnectionsView {
  const first = connections[0];
  return first ? { mode: "edit", connectionId: first.id } : { mode: "add" };
}

/**
 * Resolves a `WelcomeConnectionsView` against the LIVE connections list into
 * exactly what the form needs to render: which mode to pass
 * `ConnectionDrawerFields` (drives its Create/Save button label), which
 * connection to edit (`undefined` in "add" mode), and the `key` to mount it
 * under. An `"edit"` view whose connection id no longer resolves (defensive —
 * this screen's own switcher offers no delete, but a snapshot reload racing a
 * stale id is cheap to guard) falls back to "add" rather than handing
 * `ConnectionDrawerFields` a mode/editConnection mismatch. The `key` is
 * stable across repeat calls with the same view (so a re-render that does not
 * change the view never remounts the form out from under a half-typed field)
 * and distinct across different connections/add, matching `ConnectionDrawer`'s
 * own `editConnection?.id ?? "add"` keying. Switching to another connection
 * and back DOES discard the first form's local state — that is the point of
 * the key, not a shortcoming: a label/model/credential typed against one
 * connection must never reappear in another's form. Exported for direct testing.
 */
export function resolveWelcomeView(
  view: WelcomeConnectionsView,
  connections: readonly ProviderConnection[],
): { mode: "add" | "edit"; editConnection: ProviderConnection | undefined; key: string } {
  const editConnection = view.mode === "edit" ? connections.find((c) => c.id === view.connectionId) : undefined;
  return editConnection
    ? { mode: "edit", editConnection, key: editConnection.id }
    : { mode: "add", editConnection: undefined, key: "add" };
}

export function WelcomeScreen({ store = useSettingsStore, onOpenSettings, settingsOpen = false, onSelectEngine }: WelcomeScreenProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const notice = useStore(store, (s) => s.notice);
  const cardRef = useRef<HTMLDivElement>(null);
  // Beat 2 of the honest two-beat footer: providerReady flips true just before
  // App stops rendering Welcome and shows the normal shell.
  const ready = snapshot?.providerReady === true;
  const connections = snapshot?.settings.provider.connections ?? [];
  const pendingConsent = useStore(store, (s) => s.pendingConsent);
  const [path, setPath] = useState<"api" | "codex" | "claude" | null>(null);
  const activePath = path ?? (connections.length > 0 ? "api" : null);

  // `null` until the user explicitly switches views — the live default
  // (`initialConnectionsView`) tracks the connections list until then, so a
  // just-loaded snapshot lands on the right view with no extra effect.
  const [viewOverride, setViewOverride] = useState<WelcomeConnectionsView | null>(null);
  const view = viewOverride ?? initialConnectionsView(connections);
  const resolved = resolveWelcomeView(view, connections);
  // TASK.58: union the builtin catalog with saved custom records so a
  // just-created "Custom endpoint…" resolves its own synthesized entry
  // (models/transports) for the post-create model step — shared by the form
  // AND the switcher list's provider-name lookup below.
  const catalog = snapshot
    ? [...(snapshot.catalog ?? []), ...customProviderCatalogEntries(snapshot.settings.provider.custom ?? [])]
    : [];

  // R17 a11y: this is the setup screen with nothing else to do — focus the first
  // provider field on mount so a keyboard/SR user lands directly on the one
  // actionable control (an intentional focus-steal, scoped here rather than in
  // the shared ProviderSettings, which the settings dialog also mounts).
  // TASK.68: also re-steer on every view switch (key change) — the form
  // instance underneath is a different mount now, same "land on the one
  // actionable control" rationale as the original mount-only steal.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(".welcome-setup select, .welcome-setup input, .welcome-setup button, .welcome-paths button")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.key, activePath]);

  return (
    <div className="welcome-screen">
      <div className={`welcome-screen-card${activePath ? " welcome-screen-card-setup" : ""}`} ref={cardRef}>
        <header className="welcome-brand">
          <BrandMark className="welcome-mark" />
          <h1 className="welcome-wordmark">
            <span className="welcome-wordmark-any">Any</span>Code
          </h1>
          {/* The mode-ramp motif: plan → build → edit → auto → yolo, quoting
              the mode chip's escalation colors. Decorative — aria-hidden. */}
          <div className="welcome-ramp" aria-hidden="true">
            <span className="welcome-ramp-dot welcome-ramp-plan" />
            <span className="welcome-ramp-dot welcome-ramp-build" />
            <span className="welcome-ramp-dot welcome-ramp-edit" />
            <span className="welcome-ramp-dot welcome-ramp-auto" />
            <span className="welcome-ramp-dot welcome-ramp-yolo" />
          </div>
          <p className="welcome-promise">
            Connect your account, choose a project, and start coding.
          </p>
          {/* The running app's version, same source and same gate as the About
              pane (`snapshot.appVersion`, never hardcoded here). Setup is the
              one screen a fresh or broken install has, and the read-only
              banner right below it says "upgrade" — naming the version the
              user is actually running is what makes that instruction
              actionable. Absent whenever main supplies no getAppVersion. */}
          {snapshot && shouldShowAppVersion(snapshot) && (
            <span className="welcome-version">Version {snapshot.appVersion}</span>
          )}
        </header>

        {snapshot?.readOnly && (
          <div className="settings-banner-readonly" role="alert">
            Settings file is a newer version than this app understands — changes are disabled
            until you upgrade.
          </div>
        )}

        <div className={`welcome-paths${activePath ? " welcome-paths-compact" : ""}`} role="group" aria-label="Choose how to connect">
          {([
            ["codex", "ChatGPT / Codex", "Use your ChatGPT account"],
            ["claude", "Claude Code", "Use your Claude account"],
            ["api", "API key or local model", "Connect any provider or your own server"],
          ] as const).map(([id, title, description]) => (
            <button key={id} type="button" className="welcome-path" aria-pressed={activePath === id} onClick={() => {
              setPath(id);
              onSelectEngine?.(id === "api" ? "core" : id);
            }}>
              <strong>{title}</strong><span>{description}</span>
            </button>
          ))}
        </div>

        {activePath === "api" && snapshot && connections.length > 0 && (
          <div className="welcome-connections">
            <div className="welcome-connections-header">
              <span className="welcome-connections-title">Connections</span>
              <button
                type="button"
                className="settings-button welcome-connections-add"
                onClick={() => setViewOverride({ mode: "add" })}
              >
                <Plus aria-hidden="true" />
                Add another provider
              </button>
            </div>
            {/* TASK.68 item 2: the compact switcher — one row per saved
                connection (label + provider + credential/health status),
                clicking a row edits that connection. Also item 3's return path
                from "add" mode: this list stays up, so clicking a row you were
                previously editing goes right back to it. */}
            <div className="welcome-connections-list" role="list" aria-label="Saved connections">
              {connections.map((connection) => {
                const catalogEntry = selectProviderEntry(catalog, connection.providerId || undefined);
                const credentialStatus = snapshot.secrets.find(
                  (s) =>
                    s.key ===
                    connectionCredentialKey(connection.id, connection.providerId, catalogEntry?.authKind ?? "api_key"),
                );
                const healthStatus = connectionHealthStatus(
                  connection,
                  credentialStatus,
                  catalogEntry?.authOptional === true || connection.authOptional === true,
                );
                const described = describeConnectionHealth(healthStatus);
                const displayName = connectionDisplayName(connection, catalogEntry?.name ?? "Custom", connections);
                const selected = resolved.editConnection?.id === connection.id;
                return (
                  <button
                    key={connection.id}
                    type="button"
                    role="listitem"
                    className={`welcome-connection-row${selected ? " welcome-connection-row-selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => setViewOverride({ mode: "edit", connectionId: connection.id })}
                  >
                    <span className="welcome-connection-row-provider">{catalogEntry?.name ?? "Custom"}</span>
                    <span className="welcome-connection-row-name">{displayName}</span>
                    <span className={`connection-tile-status connection-tile-status-${described.tone}`}>
                      <span className="connection-tile-status-dot" aria-hidden="true" />
                      <span>{described.text}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="welcome-setup">
          {activePath === "codex" && <CodexEnginePane onboarding />}
          {activePath === "claude" && <ClaudeEnginePane onboarding />}
          {activePath === "api" && snapshot && (
            <ConnectionDrawerFields
              key={resolved.key}
              mode={resolved.mode}
              editConnection={resolved.editConnection}
              catalog={catalog}
              connections={connections}
              secrets={snapshot.secrets}
              readOnly={snapshot.readOnly}
              store={store}
              simplified
            />
          )}
        </div>

        {onOpenSettings && <button type="button" className="settings-button" data-open-settings onClick={onOpenSettings}>Open settings</button>}

        <ConsentDialog
          open={pendingConsent !== null && !settingsOpen}
          onAccept={() => void store.getState().acceptWeakStorageConsent()}
          onDecline={() => store.getState().declineWeakStorageConsent()}
        />

        {notice && (
          <div className="settings-notice" role="alert">
            {notice}
          </div>
        )}

        <footer className="welcome-steps" role="status">
          <span
            className={`welcome-step-dot ${ready ? "welcome-step-dot-done" : "welcome-step-dot-active"}`}
            aria-hidden="true"
          />
          <span className={`welcome-step-dot${ready ? " welcome-step-dot-active" : ""}`} aria-hidden="true" />
          <span className="welcome-steps-caption">
            {ready ? "Ready — choose a project to start" : activePath === null ? "Choose how you want to connect" : "Connect your account to continue"}
          </span>
        </footer>
      </div>
    </div>
  );
}

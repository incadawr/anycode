/**
 * Welcome screen (slice 2.2, ruling reviews/slice-2.2-forks-ruling.md §2 —

 * -> quit` boot path): rendered by App.tsx precisely when the app is
 * unconfigured (`!providerReady && tabs.length === 0 && connections.length <= 1`, `shouldShowWelcome`
 * in ../App.tsx). There is nothing else on screen in that state — main
 * opened the window with zero hosts.
 *
 * Deliberately owns no readiness logic itself: App.tsx decides WHETHER to
 * mount this component at all (off the settings-store's `snapshot` +
 * tabs-store's `tabs.length`, per the gating function it exports). Once the
 * provider is ready App.tsx shows the normal shell; the user opens the first
 * session explicitly.
 *
 * R11 restage (slice-R11-cut.md §2.2): full first-run redesign — brand beat
 * (wordmark + mode-ramp motif) + a first-connection form + an honest two-beat
 * progress footer. Auto-advance is still App's declarative unmount above —
 * this component adds no readiness state of its own.
 *
 * TASK.45 W12 (cut §"Отдельный first-run empty state в WelcomeScreen"): this no
 * longer embeds the full `ProviderSettings` grid (management screen) — it
 * embeds `ConnectionDrawerFields` (the SAME add/edit form the Settings grid's
 * drawer uses) directly, chrome-free, narrowed to ONE connection AT A TIME. A
 * fresh install has no connections yet ("add" mode); reopening mid-setup (a
 * connection exists but isn't ready yet — e.g. metadata saved, credential not
 * yet entered) resumes editing that SAME first connection rather than minting
 * a second one on every restart.
 *
 * TASK.68 (owner bug report): the form used to be hard-wired to
 * `mode={connections.length === 0 ? "add" : "edit"}` /
 * `editConnection={connections[0]}` with no local state at all — a failed
 * first provider (bad key, wrong endpoint) permanently locked the screen into
 * editing that ONE connection (its provider `<select>` disabled by
 * `templateLocked` once created, by design — provider identity is fixed at
 * creation). There was no way to try a different provider without resetting
 * settings/secrets outside the app. `WelcomeConnectionsView` below is now the
 * screen's own local state: which existing connection is being edited, or
 * whether a NEW one is being created (active provider select). A compact
 * switcher list (rendered whenever at least one connection exists) lets the
 * user jump between saved connections or start another one and back, exactly
 * like `ConnectionDrawer`'s own `key={fieldsProps.editConnection?.id ?? "add"}`
 * remount discipline (ConnectionDrawer.tsx) — `resolveWelcomeView`'s `key`
 * plays the same role here so a connection's local form state (label/model/
 * key field) never leaks into a DIFFERENT connection's form.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import type { ProviderConnection } from "../../../shared/settings.js";
import { ConnectionDrawerFields } from "./ConnectionDrawer.js";
import { customProviderCatalogEntries, selectProviderEntry } from "./SettingsScreen.js";
import { connectionCredentialKey, connectionDisplayName, connectionHealthStatus, describeConnectionHealth } from "./ConnectionTile.js";
import { BrandMark, Plus } from "./icons.js";
import "../settings.css";

export interface WelcomeScreenProps {
  /** Injectable for test isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
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

export function WelcomeScreen({ store = useSettingsStore }: WelcomeScreenProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const notice = useStore(store, (s) => s.notice);
  const cardRef = useRef<HTMLDivElement>(null);
  // Beat 2 of the honest two-beat footer: providerReady flips true just before
  // App stops rendering Welcome and shows the normal shell.
  const ready = snapshot?.providerReady === true;
  const connections = snapshot?.settings.provider.connections ?? [];

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
    cardRef.current?.querySelector<HTMLElement>("select, input, textarea")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.key]);

  return (
    <div className="welcome-screen">
      <div className="welcome-screen-card" ref={cardRef}>
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
            A coding agent for any provider — every step legible, every permission yours.
          </p>
        </header>

        {snapshot?.readOnly && (
          <div className="settings-banner-readonly" role="alert">
            Settings file is a newer version than this app understands — changes are disabled
            until you upgrade.
          </div>
        )}

        {snapshot && connections.length > 0 && (
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

        {snapshot && (
          <ConnectionDrawerFields
            key={resolved.key}
            mode={resolved.mode}
            editConnection={resolved.editConnection}
            catalog={catalog}
            connections={connections}
            secrets={snapshot.secrets}
            readOnly={snapshot.readOnly}
            store={store}
          />
        )}

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
            {ready ? "Provider ready — open a task from the sidebar" : "Connect a provider to begin"}
          </span>
        </footer>
      </div>
    </div>
  );
}

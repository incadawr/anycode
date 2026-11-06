import { ProviderIcon } from "./ProviderIcon.js";
/**
 * First-run setup: choose ChatGPT/Codex, Claude Code, a coding subscription
 * (key paste into the API form, not OAuth), or API/local models.
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
 * WelcomeScreen's own local view state: either editing an existing
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
 * The coding-subscription shortcuts rendered beside the engine paths. Each
 * opens the API form with `id` — a builtin catalog template id, seeded into
 * the Provider select at mount — and a link to the provider's own key page.
 * Key-page sources: the Z.AI URL is the "API Keys" page the developer docs
 * (docs.z.ai) link in their own site nav; the MiniMax URL is "Plan Details",
 * named by the official M Plan quickstart
 * (platform.minimax.io/docs/m-plan/quickstart) as where the M Plan API key
 * lives; the Kimi console URL is UNVERIFIED — the provider SPA serves no
 * readable content and no doc page naming it was found when this was
 * written. Every pick is a plain key paste: none of these is an OAuth flow.
 */
export type WelcomeSubscriptionId = "z-ai" | "minimax" | "kimi" | "opencode";

export interface WelcomeSubscription {
  readonly id: WelcomeSubscriptionId;
  readonly title: string;
  readonly description: string;
  readonly keyUrl: string;
}

export const WELCOME_SUBSCRIPTIONS: readonly WelcomeSubscription[] = [
  { id: "z-ai", title: "GLM Coding Plan", description: "Use your Z.AI coding plan key", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  { id: "minimax", title: "MiniMax M Plan", description: "Use your MiniMax M Plan key", keyUrl: "https://platform.minimax.io/console/plan" },
  { id: "kimi", title: "Kimi (kimi.com)", description: "Use your Kimi for Coding key", keyUrl: "https://www.kimi.com/code/console" },
  { id: "opencode", title: "OpenCode Go", description: "Use your OpenCode Go key", keyUrl: "https://opencode.ai/console" },
];

/**
 * The mount key for the embedded API form: a subscription pick gets its own
 * key (`add:<template>#<pick>`) so switching picks remounts the form with the
 * new template seeded (typed values must never leak across templates — the
 * same discipline as the switcher's per-connection keys), while any other view
 * keeps its plain stable key and no template. `pick` is a nonce bumped on
 * every subscription click, including a re-pick of the already-active one:
 * the bare subscription state no-ops on an identical re-pick, so without the
 * nonce no key change and no remount would follow — and the pick's fresh-seed
 * reset would then describe a form that never happened (the key link reviving
 * over a form still showing another provider). Exported for direct testing.
 */
export function welcomeFormKey(resolvedKey: string, subscription: WelcomeSubscriptionId | null, pick: number): string {
  return resolvedKey === "add" && subscription !== null ? `add:${subscription}#${pick}` : resolvedKey;
}

/**
 * Whether the active pick's key link still describes the form being rendered.
 * The add-mode Provider select stays editable until create, so the form can
 * move off the seeded template: `formProviderId` is what the drawer's select
 * now shows (`null` = still the untouched seed). The link hides while they
 * disagree and revives when the template is picked back. Exported for direct
 * testing (no jsdom — see WelcomeScreen.test.ts's docstring).
 */
export function welcomeKeyLinkVisible(activeSubscription: WelcomeSubscription | undefined, formProviderId: string | null): boolean {
  return activeSubscription !== undefined && (formProviderId === null || formProviderId === activeSubscription.id);
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
  const consentSaving = useStore(store, (s) => s.consentSaving);
  const [path, setPath] = useState<"api" | "codex" | "claude" | null>(null);
  const activePath = path ?? (connections.length > 0 ? "api" : null);
  // The subscription shortcut picked on this screen, if any. It only drives
  // the API form while the view is still the fresh-create form it opened
  // (`welcomeFormKey`'s `add:<template>#<pick>` rule) — switching to edit another
  // connection or to a generic add drops it, exactly like any other
  // half-typed form state.
  const [subscription, setSubscription] = useState<WelcomeSubscriptionId | null>(null);
  // Bumped on every subscription click so each pick — even of the template
  // already shown — yields a fresh form key. Without it an identical re-pick
  // would no-op the subscription state and leave the old form instance (say,
  // switched to another provider) under a freshly reset key link.
  const [pick, setPick] = useState(0);
  // The provider the embedded form's select currently shows (`null` = the
  // untouched seed), reported through `onProviderIdChange`. A select change
  // away from the seeded template must take the key link with it, or the pane
  // would advertise one provider's key page over another provider's form.
  const [formProviderId, setFormProviderId] = useState<string | null>(null);

  // `null` until the user explicitly switches views — the live default
  // (`initialConnectionsView`) tracks the connections list until then, so a
  // just-loaded snapshot lands on the right view with no extra effect.
  const [viewOverride, setViewOverride] = useState<WelcomeConnectionsView | null>(null);
  const view = viewOverride ?? initialConnectionsView(connections);
  const resolved = resolveWelcomeView(view, connections);
  // The subscription pick only survives while the form is still the fresh
  // create it opened — any other resolved view hides the key link and keeps
  // the template out of the form.
  const activeSubscription = resolved.key === "add" && subscription !== null
    ? WELCOME_SUBSCRIPTIONS.find((sub) => sub.id === subscription)
    : undefined;
  const keyLinkVisible = welcomeKeyLinkVisible(activeSubscription, formProviderId);
  // union the builtin catalog with saved custom records so a
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
  // also re-steer on every view switch (key change) and on every
  // subscription re-pick — each remounts the form instance underneath, same
  // "land on the one actionable control" rationale as the original mount-only
  // steal.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(".welcome-setup select, .welcome-setup input, .welcome-setup button, .welcome-paths button")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.key, activePath, subscription, pick]);

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
          {WELCOME_SUBSCRIPTIONS.map((sub) => (
            <button key={sub.id} type="button" className="welcome-path welcome-subscription" aria-pressed={subscription === sub.id} onClick={() => {
              setPath("api");
              setSubscription(sub.id);
              setPick((n) => n + 1);
              // A fresh seed: the remounted form's select shows the new
              // template again, whatever the previous form had been switched to.
              setFormProviderId(null);
              setViewOverride({ mode: "add" });
              onSelectEngine?.("core");
            }}>
              <strong className="welcome-path-title"><ProviderIcon id={sub.id} />{sub.title}</strong><span>{sub.description}</span>
            </button>
          ))}
          {([
            ["api", "API key or local model", "Connect any provider or your own server"],
            ["codex", "ChatGPT / Codex", "Use your ChatGPT account"],
            ["claude", "Claude Code", "Use your Claude account"],
          ] as const).map(([id, title, description]) => (
            <button key={id} type="button" className="welcome-path" aria-pressed={activePath === id && !(id === "api" && subscription !== null)} onClick={() => {
              setPath(id);
              // Re-clicking the already-active path must stay inert — clearing
              // the pick here would remount the form and silently discard a
              // half-typed key, model and label.
              if (path !== id || subscription !== null) setSubscription(null);
              onSelectEngine?.(id === "api" ? "core" : id);
            }}>
              <strong className="welcome-path-title"><ProviderIcon id={id === "codex" ? "openai" : id === "claude" ? "anthropic" : "custom"} />{title}</strong><span>{description}</span>
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
                onClick={() => {
                  setViewOverride({ mode: "add" });
                  setSubscription(null);
                }}
              >
                <Plus aria-hidden="true" />
                Add another provider
              </button>
            </div>
            {/* item 2: the compact switcher — one row per saved
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
                    onClick={() => {
                      setViewOverride({ mode: "edit", connectionId: connection.id });
                      setSubscription(null);
                    }}
                  >
                    <span className="welcome-connection-row-provider"><ProviderIcon id={connection.providerId} />{catalogEntry?.name ?? "Custom"}</span>
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
            <>
              {keyLinkVisible && activeSubscription && (
                <p className="welcome-subscription-key">
                  <a href={activeSubscription.keyUrl} target="_blank" rel="noreferrer">
                    Get a {activeSubscription.title} key
                  </a>
                </p>
              )}
              <ConnectionDrawerFields
                key={welcomeFormKey(resolved.key, subscription, pick)}
                mode={resolved.mode}
                editConnection={resolved.editConnection}
                catalog={catalog}
                connections={connections}
                secrets={snapshot.secrets}
                readOnly={snapshot.readOnly}
                store={store}
                simplified
                initialProviderId={activeSubscription?.id}
                onProviderIdChange={setFormProviderId}
              />
            </>
          )}
        </div>

        {onOpenSettings && <button type="button" className="settings-button" data-open-settings onClick={onOpenSettings}>Open settings</button>}

        <ConsentDialog
          busy={consentSaving}
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

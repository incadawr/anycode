/**
 * The `Network` settings pane (TASK.141 §3 / лейн C item 1): the named proxy
 * registry — the list of profiles, create / edit / rename / delete — hosting
 * the ONE editor plaque (`ProxySection`). Nothing about a proxy is configured
 * anywhere else in the product: every scope (a connection, an engine, the app)
 * only picks a name from a dropdown.
 *
 * DELETE IS A REFUSAL, NOT A CASCADE (§7): a profile that any scope still
 * references cannot be deleted, and the refusal NAMES the scopes. Silently
 * detaching the references would re-route traffic for scopes the user is not
 * looking at, and the worst outcome of that is a request leaving the corporate
 * proxy — a leak class, not an inconvenience. Main owns the authoritative
 * consumer list (it walks the scope bindings); `proxyProfileConsumers` below is
 * the renderer's own advisory copy for the list badge, and the two are allowed
 * to disagree for exactly as long as a stale snapshot lives.
 *
 * Tests are `.test.ts` (node, no jsdom — see ProxySection's docstring), so the
 * pane's rules live in exported pure helpers.
 */
import { useState } from "react";
import { useStore } from "zustand";
import type { AnycodeSettings } from "../../../shared/settings.js";
import type { ProxyProfile, ProxyScopeId } from "../../../shared/proxy.js";
import { maskProxyUrl, proxyProfiles, readProxyScope } from "../../../shared/proxy.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { ProxySection } from "./ProxySection.js";

/** One line of "what this profile is", for the list row. */
export function proxyProfileSummary(profile: ProxyProfile): string {
  if (profile.mode === "system") {
    return "System proxy";
  }
  const url = profile.url ?? "";
  return url === "" ? "No address set" : maskProxyUrl(url);
}

/**
 * The scopes that currently reference `profileId`, in human-readable form —
 * the same vocabulary main uses in its refusal (`connection «Anthropic work»`,
 * `Codex engine`, `Application default`) so the badge and the refusal read
 * alike. Walks the same `readProxyScope` the ladder and main's binding registry
 * read through, so it cannot drift from where a ref actually lives.
 */
export function proxyProfileConsumers(settings: AnycodeSettings, profileId: string): string[] {
  const scopes: { scope: ProxyScopeId; describe: () => string }[] = [
    { scope: { kind: "app" }, describe: () => "Application default" },
    { scope: { kind: "engine", engine: "codex" }, describe: () => "Codex engine" },
    { scope: { kind: "engine", engine: "claude" }, describe: () => "Claude engine" },
    ...settings.provider.connections.map((connection) => ({
      scope: { kind: "connection" as const, connectionId: connection.id },
      describe: () => `connection «${connection.label?.trim() || connection.providerId}»`,
    })),
  ];
  return scopes
    .filter(({ scope }) => readProxyScope(settings, scope).ref === profileId)
    .map(({ describe }) => describe());
}

/**
 * The refusal text for a delete blocked by live references. Never a generic
 * "couldn't be saved": the whole point of the refusal is telling the user WHERE
 * to detach the profile, and an unnamed refusal is indistinguishable from a bug.
 * An empty list is a contradiction (main refused without naming anyone) and is
 * reported as such rather than rendering a dangling "in use by ." sentence.
 */
export function profileConsumersText(consumers: readonly string[]): string {
  if (consumers.length === 0) {
    return "This profile is still in use — detach it from every scope that references it, then delete it.";
  }
  return `Still in use by ${consumers.join(", ")} — point those at another profile (or “No proxy”) first, then delete it.`;
}

export interface ProxyProfilesPaneProps {
  store?: SettingsStoreApi;
}

/** The Network pane: the registry list + the one editor plaque. */
export function ProxyProfilesPane({ store = useSettingsStore }: ProxyProfilesPaneProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  // `undefined` = the editor is closed; `null` = it is open on a NEW profile;
  // a string = it is open on that profile id. One slot, three states — the
  // editor is never open on two profiles at once.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Unreachable from SettingsScreen (which never renders a pane before its
  // snapshot loads) — a null guard, not a loading state.
  if (!snapshot) {
    return null;
  }

  const settings = snapshot.settings;
  const profiles = proxyProfiles(settings);
  const readOnly = snapshot.readOnly;

  async function handleDelete(id: string): Promise<void> {
    setDeleting(id);
    setError(null);
    try {
      const result = await window.anycode.settings.proxyProfileDelete({ id });
      if (result.ok) {
        await store.getState().load();
        setEditing((current) => (current === id ? undefined : current));
        return;
      }
      setError(
        result.reason === "in_use" ? profileConsumersText(result.consumers) : describeMutationFailure(result.reason),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the proxy profile.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Proxy profiles</div>

        {profiles.length === 0 ? (
          <div className="settings-mcp-empty">
            No proxy profiles yet. Create one here, then pick it on a connection or an engine.
          </div>
        ) : (
          <div className="settings-mcp-list">
            {profiles.map((profile) => {
              const consumers = proxyProfileConsumers(settings, profile.id);
              return (
                <div className="settings-mcp-row" key={profile.id}>
                  <span className="settings-mcp-name">{profile.name}</span>
                  <span className="settings-mcp-detail">{proxyProfileSummary(profile)}</span>
                  <span className="settings-mcp-detail">
                    {consumers.length === 0 ? "Not referenced" : `Used by ${consumers.join(", ")}`}
                  </span>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={readOnly}
                    onClick={() => {
                      setError(null);
                      setEditing(profile.id);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={readOnly || deleting !== null}
                    onClick={() => void handleDelete(profile.id)}
                  >
                    {deleting === profile.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {error !== null && (
          <p className="settings-notice" role="alert">
            {error}
          </p>
        )}

        <div className="settings-field-row">
          <button
            type="button"
            className="settings-button settings-button-primary"
            disabled={readOnly}
            onClick={() => {
              setError(null);
              setEditing(null);
            }}
          >
            New profile
          </button>
        </div>
      </section>

      {editing !== undefined && (
        <ProxySection
          // Remount on every switch: the draft is seeded once, in a useState
          // initialiser (see ProxySection's own note on why an effect would be
          // wrong), so the key is what re-seeds it.
          key={editing ?? "new"}
          {...(editing === null ? {} : { profile: profiles.find((p) => p.id === editing) })}
          profiles={profiles}
          secrets={snapshot.secrets}
          connections={settings.provider.connections}
          readOnly={readOnly}
          store={store}
          onSaved={(profileId) => setEditing(profileId)}
          onCancel={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

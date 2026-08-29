/**
 * The ONE proxy control every scope gets (TASK.141 §3): a dropdown of named
 * profiles. It replaces the three separate `Proxy URL` text fields TASK.132 and
 * TASK.139 left behind (the connection drawer's, and one per engine pane) —
 * a proxy is configured ONCE, in the Network pane, and a scope only points at
 * it.
 *
 * A scope is therefore three states expressed as one string, and those three
 * states are literally the dropdown's entries: absent ("Use application
 * proxy" — inherit the rung below), `direct` ("No proxy" — explicitly none),
 * or a profile id. The app scope has no inherit entry because there is nothing
 * below it; its "No proxy" removes the key instead of persisting `"direct"`
 * (`proxyRefSetPayload`).
 *
 * TWO SAVE SHAPES, ONE COMPONENT. App and engine scopes own their own write
 * (`proxy-ref-set`, plus a Save button and a saved-notice). A CONNECTION does
 * not: its ref rides `connection-create`/`connection-update` alongside the rest
 * of the drawer, so the picker there is a controlled input and the drawer's own
 * Save carries the value — which is what removes the two-phase "create the
 * connection, then bind its proxy" dance.
 *
 * Tests are `.test.ts` (node, no jsdom) — every rule below is an exported pure
 * function; see ProxySection.tsx's docstring for the full rationale.
 */
import { useState } from "react";
import { useStore } from "zustand";
import type { AnycodeSettings } from "../../../shared/settings.js";
import { isProxyUrl } from "../../../shared/settings.js";
import type { ProxyRefSetRequest, ProxyScopeId } from "../../../shared/proxy.js";
import {
  PROXY_REF_DIRECT,
  PROXY_REF_LEGACY,
  findProxyProfile,
  maskProxyUrl,
  proxyProfiles,
  readProxyScope,
} from "../../../shared/proxy.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { ProxySection } from "./ProxySection.js";

/**
 * The picker value for "this scope says nothing — inherit the rung below".
 * `""` rather than a word, so it is the `<select>`'s natural empty value and
 * matches the `""`-clear-sentinel convention the connection CRUD channels
 * already use for `transport`/`baseUrl`.
 */
export const PROXY_REF_INHERIT = "";

/**
 * The picker's own action entry. Not a ref and never sent anywhere: choosing it
 * opens the editor and leaves the current selection untouched, so an abandoned
 * "Create profile…" cannot save as a scope change. It cannot collide with a
 * real ref (`direct`, `legacy`, `proxy-<uuid>`).
 */
export const PROXY_REF_CREATE = "__create__";

export interface ProxyRefOption {
  value: string;
  label: string;
}

/** Per-scope copy. A new scope declares one entry here and gets the whole control for free (§3). */
export const PROXY_SCOPE_COPY: Record<ProxyScopeId["kind"], { label: string; inherit: boolean }> = {
  // The app rung is the bottom of every ladder: there is nothing below it to
  // inherit, so "No proxy" and "inherit" would be the same entry twice.
  app: { label: "Application proxy", inherit: false },
  connection: { label: "Proxy", inherit: true },
  engine: { label: "Proxy", inherit: true },
};

const ENGINE_CLI_NAME: Record<"codex" | "claude", string> = {
  codex: "the Codex CLI",
  claude: "the Claude Code CLI",
};

const ENGINE_DISPLAY_NAME: Record<"codex" | "claude", string> = {
  codex: "Codex",
  claude: "Claude",
};

/**
 * What each engine's proxy actually covers (TASK.139-F3, migrated verbatim
 * from the deleted EngineProxyField; TASK.143 lifted the codex carve-out).
 * Both engines' subagents now run under the engine proxy same as the
 * top-level session: a codex-engine child routes through
 * `runSessionTier`/`ctx.sessionSubagents` exactly like a claude one (the
 * refusal in `packages/core/src/tools/agent.ts` is gone — its flush now
 * reads a live `thread/read` via `CodexEngine.readTranscript()` instead of
 * the frozen boot snapshot that made a codex child's transcript
 * untrustworthy). Kept as a per-engine map (not a shared constant) so a
 * future asymmetry has an obvious place to land again.
 */
const ENGINE_PROXY_COVERAGE: Record<"codex" | "claude", string> = {
  codex: " — sessions and subagents —",
  claude: " — sessions and subagents —",
};

/** The field label for a scope. */
export function proxyScopeLabel(scope: ProxyScopeId): string {
  return PROXY_SCOPE_COPY[scope.kind].label;
}

/**
 * The hint under the dropdown: what this scope's choice actually covers, and
 * who overrides whom. One shared template per scope kind, so the two engines'
 * hints cannot drift apart in wording anywhere except the one deliberate
 * asymmetry above.
 *
 * The old field's "Stored as plain text" clause is deliberately GONE: a URL is
 * no longer typed at a scope, and a profile's password lives in the vault. The
 * remaining honest warning about the password reaching a child's environment
 * lives on the profile editor, next to the field that sets it.
 */
export function proxyScopeHint(scope: ProxyScopeId): string {
  switch (scope.kind) {
    case "app":
      return (
        "The default for every connection and engine that doesn't name a proxy of its own. " +
        "A proxy exported by your shell overrides it."
      );
    case "connection":
      return (
        "Requests from this connection go through the proxy profile selected here, including shell commands the " +
        "model runs. An engine that names its own profile overrides this one for that engine; a proxy exported by " +
        "your shell overrides everything."
      );
    case "engine": {
      const cli = ENGINE_CLI_NAME[scope.engine];
      const name = ENGINE_DISPLAY_NAME[scope.engine];
      const coverage = ENGINE_PROXY_COVERAGE[scope.engine];
      return (
        `Requests from ${cli}${coverage} go through the proxy profile selected here. ` +
        `It overrides the connection-level proxy for ${name}; a proxy exported by your shell overrides both.`
      );
    }
  }
}

/**
 * The dropdown's entries for one scope, in order: inherit (non-app only), "No
 * proxy", every registered profile by name, a synthetic masked `Legacy: …`
 * entry while the scope still carries a pre-registry `proxyUrl` string, then
 * the "Create profile…" action.
 *
 * The Legacy entry is SYNTHETIC — the string is not in the registry and no
 * migration has happened. Choosing it and saving sends the wire-only `legacy`
 * ref, which asks main to convert that exact string into a real profile
 * (deduped by URL, so three scopes sharing a corporate string converge on one).
 * It is masked because a legacy string is allowed to embed `user:pass@`.
 *
 * A malformed legacy string produces NO entry: it is not a rung for the ladder
 * either (`resolveProxyLadder` gates it on the same `isProxyUrl`), so offering
 * it would offer an import of something that is not a proxy.
 */
export function proxyRefOptions(scope: ProxyScopeId, settings: AnycodeSettings): ProxyRefOption[] {
  const options: ProxyRefOption[] = [];
  if (PROXY_SCOPE_COPY[scope.kind].inherit) {
    options.push({ value: PROXY_REF_INHERIT, label: "Use application proxy" });
  }
  options.push({ value: PROXY_REF_DIRECT, label: "No proxy" });
  for (const profile of proxyProfiles(settings)) {
    options.push({ value: profile.id, label: profile.name });
  }
  const { legacyUrl } = readProxyScope(settings, scope);
  if (legacyUrl !== undefined && isProxyUrl(legacyUrl)) {
    options.push({ value: PROXY_REF_LEGACY, label: `Legacy: ${maskProxyUrl(legacyUrl)}` });
  }
  options.push({ value: PROXY_REF_CREATE, label: "Create profile…" });
  return options;
}

/**
 * The entry a scope opens on. A DANGLING ref (a profile id nothing in the
 * registry answers to — reachable only by hand-editing the file, since delete
 * refuses while consumers exist) shows as "No proxy", because that is what main
 * actually does with it: an explicit rung with a broken value resolves direct
 * rather than falling through to someone else's proxy. Showing "Use application
 * proxy" for it would draw a picture of the traffic that is simply false.
 */
export function proxyRefInitialValue(scope: ProxyScopeId, settings: AnycodeSettings): string {
  const { ref, legacyUrl } = readProxyScope(settings, scope);
  if (ref !== undefined) {
    if (ref === PROXY_REF_DIRECT) {
      return PROXY_REF_DIRECT;
    }
    return findProxyProfile(settings, ref) === undefined ? PROXY_REF_DIRECT : ref;
  }
  if (legacyUrl !== undefined && isProxyUrl(legacyUrl)) {
    return PROXY_REF_LEGACY;
  }
  // Non-app scopes default to inherit — the whole point of the ladder. The app
  // scope has no inherit entry, so "nothing configured" reads as "No proxy"
  // there, which is exactly what an absent `network.proxyRef` means.
  return scope.kind === "app" ? PROXY_REF_DIRECT : PROXY_REF_INHERIT;
}

/**
 * The `proxy-ref-set` payload for app/engine scopes. `ref: null` is "remove the
 * scope's ref (and its legacy `proxyUrl`)". Two picker values map onto it:
 * "Use application proxy" everywhere, AND "No proxy" on the APP scope — there,
 * "explicitly none" and "inherit" are the same state, so the key is deleted
 * rather than written as `"direct"` (only-truthy-on-disk holds on that scope).
 * Do not "simplify" the app branch away: persisting `"direct"` at app level
 * would be the one falsy-meaning key on disk that nothing needs.
 */
export function proxyRefSetPayload(scope: ProxyScopeId, value: string): ProxyRefSetRequest {
  if (value === PROXY_REF_INHERIT) {
    return { scope, ref: null };
  }
  if (scope.kind === "app" && value === PROXY_REF_DIRECT) {
    return { scope, ref: null };
  }
  return { scope, ref: value };
}

/**
 * The proxy fragment `connection-create` spreads in. Create has no clear
 * sentinel (a blank field means "inherit the app rung"), so the key is OMITTED
 * rather than sent as `""` — the create schema refuses one, exactly as it did
 * for the legacy `proxyUrl` fragment this replaces.
 *
 * The wire-only `legacy` ref is omitted too, and that is not defensive
 * duplication of main's rule: a connection being MINTED has no legacy string to
 * convert, so main answers `invalid` for it. The dropdown cannot offer the
 * entry in create mode either (there is no scope to read a legacy string from),
 * so this branch is unreachable through the UI and exists to keep the function
 * total.
 */
export function connectionCreateProxyRefField(value: string): { proxyRef?: string } {
  if (value === PROXY_REF_INHERIT || value === PROXY_REF_LEGACY || value === PROXY_REF_CREATE) {
    return {};
  }
  return { proxyRef: value };
}

/**
 * Whether the "Saved." notice belongs on screen for the picker's current value
 * (TASK.139-F5, migrated verbatim from the deleted EngineProxyField). The
 * notice is tied to `lastSavedValue` — the exact string that was last confirmed
 * persisted, captured at submit time — rather than to a bare "a save succeeded"
 * flag. If the control no longer holds that value (changed since, or nothing
 * has ever saved successfully), the notice must not show: this is what stops an
 * in-flight save of a since-changed value from landing a "Saved." notice next
 * to a selection that was never sent.
 */
export function proxySavedNoticeVisible(lastSavedValue: string | null, currentValue: string): boolean {
  return lastSavedValue !== null && lastSavedValue === currentValue;
}

export interface ProxyRefPickerProps {
  scope: ProxyScopeId;
  store?: SettingsStoreApi;
  /**
   * Controlled mode (the connection drawer): the draft ref and its setter.
   * Present = this picker never writes on its own; the host's Save carries the
   * value. Absent = the picker owns its own `proxy-ref-set` write.
   */
  value?: string;
  onChange?: (value: string) => void;
}

/** The dropdown. See the file docstring for the two save shapes. */
export function ProxyRefPicker({ scope, store = useSettingsStore, value, onChange }: ProxyRefPickerProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const controlled = value !== undefined && onChange !== undefined;
  const [ownValue, setOwnValue] = useState(() =>
    snapshot ? proxyRefInitialValue(scope, snapshot.settings) : PROXY_REF_INHERIT,
  );
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedValue, setLastSavedValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Unreachable from every current host (none renders before its snapshot has
  // loaded) — a null guard, not a loading state.
  if (!snapshot) {
    return null;
  }

  const settings = snapshot.settings;
  const readOnly = snapshot.readOnly;
  const current = controlled ? value : ownValue;
  const options = proxyRefOptions(scope, settings);

  function select(next: string): void {
    if (controlled) {
      onChange(next);
    } else {
      setOwnValue(next);
    }
  }

  async function handleSave(): Promise<void> {
    // Captured now, not read again after the `await`: the dropdown stays live
    // while the request is in flight, so the notice must attach to what was
    // actually submitted (TASK.139-F5).
    const submitted = current;
    setSaving(true);
    setError(null);
    try {
      const result = await window.anycode.settings.proxyRefSet(proxyRefSetPayload(scope, submitted));
      if (result.ok) {
        setLastSavedValue(submitted);
        await store.getState().load();
      } else {
        setError(describeMutationFailure(result.reason));
      }
    } catch (err) {
      // A rejected/thrown IPC call (as opposed to an `{ok:false}` result) must
      // surface like any other failure — never leave a stale "Saved." notice
      // from an earlier, unrelated success standing.
      setError(err instanceof Error ? err.message : "Failed to save the proxy selection.");
    } finally {
      setSaving(false);
    }
  }

  const body = (
    <>
      <label className="settings-field">
        <span className="settings-field-label">{proxyScopeLabel(scope)}</span>
        <select
          className="settings-field-select"
          value={current}
          disabled={readOnly}
          onChange={(e) => {
            const next = e.target.value;
            if (next === PROXY_REF_CREATE) {
              // The action entry never becomes the selection: it opens the
              // editor and leaves the current choice standing, so cancelling
              // out of "Create profile…" cannot change what this scope uses.
              setCreating(true);
              return;
            }
            select(next);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="settings-field-hint">{proxyScopeHint(scope)}</span>
      </label>

      {creating && (
        <ProxySection
          profiles={proxyProfiles(settings)}
          secrets={snapshot.secrets}
          connections={settings.provider.connections}
          readOnly={readOnly}
          store={store}
          onSaved={(profileId) => {
            // The scope lands on the profile that was just created — the whole
            // reason `proxy-profile-upsert` returns the minted id instead of
            // making the caller diff the registry.
            select(profileId);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {!controlled && (
        <div className="settings-field-row">
          <button type="button" className="settings-button" disabled={readOnly || saving} onClick={() => void handleSave()}>
            Save
          </button>
        </div>
      )}

      {error !== null && (
        <p className="settings-notice" role="alert">
          {error}
        </p>
      )}
      {!controlled && error === null && proxySavedNoticeVisible(lastSavedValue, current) && (
        <p className="settings-notice">Saved.</p>
      )}
    </>
  );

  // Controlled mode is embedded among a host form's own fields (the connection
  // drawer), so it must not introduce a section of its own; standalone mode is
  // a settings pane's own block and does.
  return controlled ? body : <section className="settings-section">{body}</section>;
}

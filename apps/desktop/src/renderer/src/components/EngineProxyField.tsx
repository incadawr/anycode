/**
 * Engine-level proxy field (TASK.139, §"Работа"→"Лейн B"): one
 * `Proxy URL (optional)` field per engine (Codex, Claude) — persisted at
 * `settings.<engine>.proxyUrl` (lane A), which sits ABOVE the connection-level
 * proxy (TASK.132, ConnectionDrawer) in the per-engine priority ladder
 * documented in TASK.139.md §2: shell > engine > connection > nothing.
 *
 * Deliberately its own `<section className="settings-section">` rather than a
 * patch to CodexEnginePane/ClaudeEnginePane (TASK.139.md §"Лейн B" item 1:
 * those panes are densely tested and own their own DI life; the Settings
 * pane already stacks sections). `SettingsScreen` renders one instance right
 * after each engine pane.
 *
 * Markup is cloned 1-in-1 from ConnectionDrawer.tsx's own proxy field
 * (plain text, not a password field — same proofread rationale: a typo'd
 * `host:port` is otherwise undiagnosable); `proxyUrlSaveBlocked`/
 * `PROXY_URL_ERROR` are IMPORTED from there rather than re-derived, so the
 * connection-level and engine-level fields can never silently disagree about
 * what counts as a valid proxy URL.
 */
import { useState } from "react";
import { useStore } from "zustand";
import type { AnycodeSettings, EngineProxySetRequest } from "../../../shared/settings.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { PROXY_URL_ERROR, proxyUrlSaveBlocked } from "./ConnectionDrawer.js";

export type EngineProxyEngine = EngineProxySetRequest["engine"];

const ENGINE_CLI_NAME: Record<EngineProxyEngine, string> = {
  codex: "the Codex CLI",
  claude: "the Claude Code CLI",
};

const ENGINE_DISPLAY_NAME: Record<EngineProxyEngine, string> = {
  codex: "Codex",
  claude: "Claude",
};

/**
 * The field's initial value: the persisted per-engine proxy, or `""` when the
 * engine's settings block (or the field on it) is absent. Reads exactly one
 * engine's own field — never falls back to the other engine's value.
 * Exported for direct testing (no jsdom in this package's vitest config).
 */
export function engineProxyInitialValue(settings: AnycodeSettings, engine: EngineProxyEngine): string {
  return (engine === "codex" ? settings.codex?.proxyUrl : settings.claude?.proxyUrl) ?? "";
}

/**
 * The `engine-proxy-set` payload: trimmed value, with `""` as the clear
 * sentinel. Unlike ConnectionDrawer's create path (where omission means "no
 * proxy"), this channel has no create step to omit from — an emptied field
 * has to be able to erase a previously-saved proxy, so `""` is always sent,
 * never omitted. Exported for direct testing.
 */
export function engineProxySavePayload(engine: EngineProxyEngine, raw: string): EngineProxySetRequest {
  return { engine, proxyUrl: raw.trim() };
}

/**
 * What each engine's proxy actually covers — deliberately NOT the same string
 * for both engines. Claude subagents run under the engine proxy same as the
 * top-level session. Codex engine children are refused before spawn
 * (`packages/core/src/tools/agent.ts:251` errors on any agent profile with
 * `engine: "codex"` — "codex engine children are not supported — their
 * transcript is unreachable at flush time"), and the legacy
 * `engine-children.ts` route that would otherwise run them is unwired
 * (`apps/desktop/src/host/index.ts:2036-2043`). So a Codex "subagent" never
 * exists to be proxied — claiming the Codex proxy covers "subagents" would be
 * a promise about traffic that never happens. This is a fact about the
 * product's current engine-child support, not wording drift — do not
 * "unify" it back to match the Claude string.
 */
const ENGINE_PROXY_COVERAGE: Record<EngineProxyEngine, string> = {
  codex: "",
  claude: " — sessions and subagents —",
};

/**
 * Hint text (TASK.139.md §"Лейн B" item 1, exact wording apart from the
 * per-engine coverage clause above): one shared template with the engine's
 * CLI/display name and proxy coverage substituted in, so the two engines'
 * hints can't drift apart in wording anywhere except that one deliberate
 * asymmetry. Exported for direct testing.
 */
export function engineProxyHint(engine: EngineProxyEngine): string {
  const cli = ENGINE_CLI_NAME[engine];
  const name = ENGINE_DISPLAY_NAME[engine];
  const coverage = ENGINE_PROXY_COVERAGE[engine];
  return (
    `Requests from ${cli}${coverage} go through this HTTP(S) proxy. ` +
    `It overrides the connection-level proxy for ${name}; a proxy exported by your shell overrides both. ` +
    `Stored as plain text, and passed to every process ${cli} starts.`
  );
}

/**
 * Whether the "Saved." notice belongs on screen for the field's current
 * value. The notice is tied to `lastSavedValue` — the exact string that was
 * last confirmed persisted, captured at submit time — rather than to a bare
 * "a save succeeded" flag. If the field no longer holds that value (edited
 * since, or nothing has ever saved successfully), the notice must not show:
 * this is what stops an in-flight save of a since-edited value from landing
 * a "Saved." notice next to text that was never sent. Exported for direct
 * testing (no jsdom in this package's vitest config).
 */
export function engineProxySavedNoticeVisible(lastSavedValue: string | null, currentValue: string): boolean {
  return lastSavedValue !== null && lastSavedValue === currentValue;
}

export interface EngineProxyFieldProps {
  engine: EngineProxyEngine;
  store?: SettingsStoreApi;
}

/** One `Proxy URL (optional)` field, scoped to `engine` (see file docstring). */
export function EngineProxyField({ engine, store = useSettingsStore }: EngineProxyFieldProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const [value, setValue] = useState(() => (snapshot ? engineProxyInitialValue(snapshot.settings, engine) : ""));
  const [saving, setSaving] = useState(false);
  const [lastSavedValue, setLastSavedValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Unreachable from SettingsScreen (which never renders panes before its own
  // snapshot has loaded) — a null guard, not a loading state.
  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;

  async function handleSave(): Promise<void> {
    if (proxyUrlSaveBlocked(value)) {
      setError(PROXY_URL_ERROR);
      return;
    }
    // Captured now, not read again after the `await`: the field stays
    // editable while the request is in flight, so `value` itself may have
    // moved on to a different draft by the time the request settles. The
    // notice must attach to what was actually submitted.
    const submittedValue = value;
    setSaving(true);
    setError(null);
    try {
      const result = await window.anycode.settings.engineProxySet(engineProxySavePayload(engine, submittedValue));
      if (result.ok) {
        setLastSavedValue(submittedValue);
        await store.getState().load();
      } else {
        setError(describeMutationFailure(result.reason));
      }
    } catch (err) {
      // A rejected/thrown IPC call (as opposed to an `{ok:false}` mutation
      // result) must surface like any other failure — never leave a stale
      // "Saved." notice from an earlier, unrelated success standing.
      setError(err instanceof Error ? err.message : "Failed to save the proxy URL.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Proxy</div>
      {/* TASK.132/TASK.139: plain text, not a password field — the value is infra
          config the user must be able to proofread (a typo'd host:port is
          otherwise undiagnosable), and the hint states the plaintext storage
          outright. */}
      <label className="settings-field">
        <span className="settings-field-label">Proxy URL (optional)</span>
        <input
          className="settings-field-input"
          type="text"
          value={value}
          disabled={readOnly}
          placeholder="http://user:pass@proxy.example.com:3128"
          onChange={(e) => {
            // No explicit "retire the notice" step needed here: the notice's
            // visibility is derived from comparing this field against
            // `lastSavedValue` (see `engineProxySavedNoticeVisible`), so
            // editing away from the saved value hides it on its own.
            setValue(e.target.value);
          }}
        />
        <span className="settings-field-hint">{engineProxyHint(engine)}</span>
      </label>

      <div className="settings-field-row">
        <button type="button" className="settings-button" disabled={readOnly || saving} onClick={() => void handleSave()}>
          Save
        </button>
      </div>

      {error !== null && (
        <p className="settings-notice" role="alert">
          {error}
        </p>
      )}
      {error === null && engineProxySavedNoticeVisible(lastSavedValue, value) && <p className="settings-notice">Saved.</p>}
    </section>
  );
}

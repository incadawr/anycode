/**
 * Trusted-binaries Settings subsection (TASK.103, CUT-S4.md §3.7/D-S4-7): a
 * SIBLING section under the Permissions pane, directly below
 * `<PermissionsEditor/>` — never merged into it. A consent is not a
 * permission rule: separate copy, separate channel (settings-store's
 * `revokeBinaryTrust`, not `removeRule`), separate component.
 *
 * Always rendered (muted empty state) so the surface is discoverable and the
 * automation probe (`trustedBinariesState()`) is deterministic even with
 * zero consents on disk.
 *
 * Same DI/testing discipline as `PermissionsEditor.tsx`: every exported
 * helper below is a pure function of `AnycodeSettings`, tested directly in
 * `.test.ts` (no jsdom in this package's vitest config).
 */
import { useStore } from "zustand";
import type { AnycodeSettings } from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";

/** Rows for the Settings list; empty array renders the muted empty state. */
export function trustedBinaryRows(
  settings: Pick<AnycodeSettings, "security"> | undefined,
): Array<{ path: string; grantedAt: string }> {
  const consents = settings?.security.trustedBinaries ?? [];
  return consents.map((consent) => ({ path: consent.path, grantedAt: consent.grantedAt }));
}

export interface TrustedBinariesSectionProps {
  store?: SettingsStoreApi;
}

export function TrustedBinariesSection({ store = useSettingsStore }: TrustedBinariesSectionProps) {
  const snapshot = useStore(store, (s) => s.snapshot);

  // Same null-guard convention as PermissionsEditor — unreachable from
  // SettingsScreen in practice (it early-returns its own loading row before
  // any pane renders), not a loading state of this section's own.
  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;
  const rows = trustedBinaryRows(snapshot.settings);

  async function handleRevoke(path: string): Promise<void> {
    await store.getState().revokeBinaryTrust(path);
  }

  return (
    // `trusted-binaries-section` is a DEDICATED automation-query hook
    // (TASK.103, realTrustedBinariesSectionDom): `.settings-mcp-list`/
    // `.settings-mcp-row`/`.settings-mcp-name` below are REUSED verbatim
    // from the Codex profile-row convention (byte-parity styling), but this
    // section's own rows must be queryable independent of any other pane's
    // `.settings-mcp-row` nodes — scoped by this outer class, not by class
    // name alone.
    <section className="settings-section trusted-binaries-section">
      <div className="settings-section-title">Trusted binaries</div>
      <p className="settings-page-description">
        Binaries you approved to run from weakly-protected locations. Each entry is pinned to the exact file it
        was granted for.
      </p>

      {rows.length === 0 && <div className="settings-rule-empty">No trusted binaries.</div>}

      {rows.length > 0 && (
        <ul className="settings-mcp-list">
          {rows.map((row) => (
            <li key={row.path} className="settings-mcp-row trusted-binary-row" data-trusted-binary-path={row.path}>
              <span className="settings-mcp-name">
                <code>{row.path}</code>
              </span>
              <span className="settings-page-description">trusted {new Date(row.grantedAt).toLocaleDateString()}</span>
              <button
                type="button"
                className="settings-button settings-button-danger trusted-binary-revoke"
                disabled={readOnly}
                onClick={() => void handleRevoke(row.path)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

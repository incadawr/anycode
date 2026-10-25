/**
 * Trusted-folders Settings subsection (Taskana 4739): a SIBLING section under
 * the Permissions pane, directly below `<TrustedBinariesSection/>` — a
 * workspace-trust decision is neither a permission rule nor a binary consent:
 * separate copy, separate channel (`workspaceTrust.list`/`forget`, not the
 * settings store), separate component.
 *
 * The renderer is untrusted here (S1): it can only ask for the list (NO
 * payload) and send back a `key` main itself listed. Main treats the key as
 * an opaque lookup handle — never a path.
 *
 * Local component state, NOT the settings store: this section reads the
 * trust store through main on mount (and after each forget); it is not part
 * of the settings snapshot. Same DI/testing discipline as
 * `TrustedBinariesSection.tsx`: the exported helpers are pure functions
 * tested directly in `.test.ts` (no jsdom in this package's vitest config).
 */
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceTrustListResult, WorkspaceTrustListedFolder } from "../../../shared/workspace-trust.js";

/** Rows for the Settings list; empty array renders the muted empty state. */
export function trustedFolderRows(
  result: WorkspaceTrustListResult | undefined,
): WorkspaceTrustListedFolder[] {
  if (!result || !result.ok) return [];
  return [...result.folders].sort((a, b) => a.key.localeCompare(b.key));
}

/** Display label for a stored decision. */
export function trustingLabel(decision: WorkspaceTrustListedFolder["decision"]): string {
  return decision === "trusted" ? "Trusted" : "Denied";
}

/** Copy for a refused forget; never suggests constructing a path. */
export function forgetErrorMessage(reason: "invalid" | "not_found" | "write_failed"): string {
  switch (reason) {
    case "invalid":
      return "That entry is no longer valid. Reopen Settings to refresh the list.";
    case "not_found":
      return "That entry is already gone. The list has been refreshed.";
    case "write_failed":
      return "The change could not be saved. Try again.";
  }
}

export interface TrustedFoldersSectionProps {
  /** Window bridge; the real component uses `window.anycode`. */
  api?: {
    workspaceTrust: {
      list(): Promise<WorkspaceTrustListResult>;
      forget(request: { key: string }): Promise<{ ok: true } | { ok: false; reason: "invalid" | "not_found" | "write_failed" }>;
    };
  };
}

export function TrustedFoldersSection({ api }: TrustedFoldersSectionProps = {}) {
  const bridge = api ?? window.anycode;
  const [rows, setRows] = useState<WorkspaceTrustListedFolder[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await bridge.workspaceTrust.list();
    setRows(trustedFolderRows(result));
    if (!result.ok) {
      setError("The remembered folder list could not be read.");
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleForget(key: string): Promise<void> {
    setError(null);
    const result = await bridge.workspaceTrust.forget({ key });
    if (!result.ok) {
      setError(forgetErrorMessage(result.reason));
    }
    // Re-list either way: the store is main's source of truth.
    await refresh();
  }

  return (
    <section className="settings-section trusted-folders-section">
      <div className="settings-section-title">Trusted folders</div>
      <p className="settings-page-description">
        Folders with a remembered trust decision for their project declarations. Forgetting a folder asks again the
        next time a tab opens it. Open tabs keep their current state until restarted.
      </p>

      {rows.length === 0 && !error && <div className="settings-rule-empty">No remembered folders.</div>}
      {error && <div className="settings-rule-empty">{error}</div>}

      {rows.length > 0 && (
        <ul className="settings-mcp-list">
          {rows.map((row) => (
            <li key={row.key} className="settings-mcp-row trusted-folder-row" data-trusted-folder-key={row.key}>
              <span className="settings-mcp-name">
                <code>{row.key}</code>
              </span>
              <span className="settings-page-description">
                {trustingLabel(row.decision)} {new Date(row.decidedAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="settings-button settings-button-danger trusted-folder-forget"
                onClick={() => void handleForget(row.key)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Environment menu -> Diagnostics (GitHub #18).
 *
 * The action is deliberately thin and SESSION-scoped: MAIN builds the
 * anonymised bundle of this session's TREE (the session plus its children),
 * anonymises it and writes it. The renderer names the session and asks for the
 * preview text (already scrubbed) plus size counts, so no raw telemetry ever
 * crosses the bridge and no other session's data is ever requested. The card
 * requires a preview before saving, so the flow is two steps:
 * "Export" -> review -> "Save bundle…".
 */

import { useContext, useState } from "react";
import { TabContext } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import type { DiagnosticsSummary } from "../../../shared/diagnostics.js";

export type DiagnosticsExportPhase =
  | { step: "idle" }
  | { step: "previewing" }
  | { step: "preview"; preview: string; summary: DiagnosticsSummary }
  | { step: "saving"; preview: string; summary: DiagnosticsSummary }
  | { step: "saved"; saved: boolean; path?: string }
  | { step: "error"; reason: string };

const REASON_TEXT: Record<string, string> = {
  invalid_request: "This session cannot be exported.",
  build_failed: "The bundle could not be built.",
  too_large: "The bundle exceeded the size limit.",
  write_failed: "The bundle could not be written.",
  canceled: "Export canceled.",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** One line of state text, kept pure so it is unit-testable without a DOM. */
export function describeDiagnosticsExport(phase: DiagnosticsExportPhase): string {
  switch (phase.step) {
    case "idle":
      return "This session and its subagents, anonymised before you see it.";
    case "previewing":
      return "Building the anonymised bundle…";
    case "preview":
      return `Preview: ${formatBytes(phase.summary.bytes)}, ${phase.summary.redactions} redactions${phase.summary.truncated ? ", truncated" : ""}.`;
    case "saving":
      return "Waiting for the save dialog…";
    case "saved":
      return phase.saved ? (phase.path !== undefined ? `Saved to ${phase.path}` : "Saved.") : "Save canceled.";
    case "error":
      return REASON_TEXT[phase.reason] ?? "Diagnostics export is unavailable.";
  }
}

/** Counts shown next to the preview; content never leaves main. */
export function describeDiagnosticsSections(summary: DiagnosticsSummary): string {
  return summary.sections
    .map((section) => `${section.name}: ${section.records}`)
    .join(" · ");
}

/**
 * The row lives in the environment dropdown of the ACTIVE tab, so it exports
 * the tree of the session the person is actually looking at. Without a bound
 * session id there is nothing to export — the row says so instead of guessing
 * (an empty id would be refused by main anyway).
 */
export function DiagnosticsExportSection() {
  const tabId = useContext(TabContext)?.tabId;
  const sessionId = useTabsStore((state) => state.tabs.find((tab) => tab.tabId === tabId)?.sessionId ?? null);
  return <DiagnosticsExportRow sessionId={sessionId} />;
}

export function DiagnosticsExportRow({ sessionId }: { sessionId: string | null }) {
  const [phase, setPhase] = useState<DiagnosticsExportPhase>({ step: "idle" });
  const bridge = typeof window !== "undefined" ? window.anycode?.diagnostics : undefined;
  const busy = phase.step === "previewing" || phase.step === "saving";
  const available = bridge !== undefined && sessionId !== null;

  const startPreview = async (): Promise<void> => {
    if (bridge === undefined || sessionId === null) {
      setPhase({ step: "error", reason: "invalid_request" });
      return;
    }
    setPhase({ step: "previewing" });
    const result = await bridge.preview({ sessionId });
    if (!result.ok) {
      setPhase({ step: "error", reason: result.reason });
      return;
    }
    setPhase({ step: "preview", preview: result.preview, summary: result.summary });
  };

  const save = async (preview: { preview: string; summary: DiagnosticsSummary }): Promise<void> => {
    if (bridge === undefined || sessionId === null) return;
    setPhase({ step: "saving", ...preview });
    const result = await bridge.save({ sessionId });
    if (!result.ok) {
      setPhase({ step: "error", reason: result.reason });
      return;
    }
    setPhase({ step: "saved", saved: result.saved, ...(result.path !== undefined ? { path: result.path } : {}) });
  };

  const showActions = phase.step === "preview" || phase.step === "saving";

  return (
    <>
      <div className="environment-menu-row" role="group" aria-label="Diagnostics">
        <span className="environment-menu-spacer" aria-hidden="true" />
        <span className="environment-menu-row-main">
          <span>Diagnostics</span>
          <span className="environment-menu-row-detail environment-menu-row-detail-wrap">{describeDiagnosticsExport(phase)}</span>
        </span>
        <span className="environment-menu-actions">
          {showActions ? (
            <>
              <button
                type="button"
                className="environment-menu-open"
                data-environment-action="diagnostics-save"
                disabled={busy}
                onClick={() => void save({ preview: phase.preview, summary: phase.summary })}
              >
                Save bundle…
              </button>
              <button
                type="button"
                className="environment-menu-open"
                data-environment-action="diagnostics-cancel"
                disabled={busy}
                onClick={() => setPhase({ step: "idle" })}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="environment-menu-open"
              data-environment-action="diagnostics-preview"
              disabled={busy || !available}
              title={sessionId === null ? "This tab has no session id yet" : undefined}
              onClick={() => void startPreview()}
            >
              Export
            </button>
          )}
        </span>
      </div>
      {showActions && (
        <>
          <div className="environment-menu-note">{describeDiagnosticsSections(phase.summary)}</div>
          <pre className="environment-menu-diagnostics-preview">{phase.preview}</pre>
        </>
      )}
    </>
  );
}

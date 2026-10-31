/**
 * Settings -> Environment -> Diagnostics (GitHub #18).
 *
 * The action is deliberately thin: MAIN builds the bundle, anonymises it and
 * writes it. The renderer only asks for the preview text (already scrubbed)
 * and displays size counts, so no raw telemetry ever crosses the bridge. The
 * card requires a preview before saving, so the flow is two steps:
 * "Export diagnostics…" -> review -> "Save bundle…".
 */

import { useState } from "react";
import type { DiagnosticsSummary } from "../../../shared/diagnostics.js";

export type DiagnosticsExportPhase =
  | { step: "idle" }
  | { step: "previewing" }
  | { step: "preview"; preview: string; summary: DiagnosticsSummary }
  | { step: "saving"; preview: string; summary: DiagnosticsSummary }
  | { step: "saved"; saved: boolean; path?: string }
  | { step: "error"; reason: string };

const REASON_TEXT: Record<string, string> = {
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
      return "Collects telemetry, tool shapes and this app's wire log, anonymised before you see it.";
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

export function DiagnosticsExportSection(): React.JSX.Element {
  const [phase, setPhase] = useState<DiagnosticsExportPhase>({ step: "idle" });

  const bridge = typeof window !== "undefined" ? window.anycode?.diagnostics : undefined;
  const busy = phase.step === "previewing" || phase.step === "saving";

  const startPreview = async (): Promise<void> => {
    if (bridge === undefined) {
      setPhase({ step: "error", reason: "build_failed" });
      return;
    }
    setPhase({ step: "previewing" });
    const result = await bridge.preview();
    if (!result.ok) {
      setPhase({ step: "error", reason: result.reason });
      return;
    }
    setPhase({ step: "preview", preview: result.preview, summary: result.summary });
  };

  const save = async (preview: { preview: string; summary: DiagnosticsSummary }): Promise<void> => {
    if (bridge === undefined) return;
    setPhase({ step: "saving", ...preview });
    const result = await bridge.save();
    if (!result.ok) {
      setPhase({ step: "error", reason: result.reason });
      return;
    }
    setPhase({ step: "saved", saved: result.saved, ...(result.path !== undefined ? { path: result.path } : {}) });
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Diagnostics</div>
      <div className="settings-field-hint">{describeDiagnosticsExport(phase)}</div>
      {phase.step === "preview" || phase.step === "saving" ? (
        <>
          <div className="settings-field-hint">{describeDiagnosticsSections(phase.summary)}</div>
          <pre className="settings-diagnostics-preview">{phase.preview}</pre>
          <div className="settings-diagnostics-actions">
            <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void save({ preview: phase.preview, summary: phase.summary })}>
              Save bundle…
            </button>
            <button type="button" className="settings-button" disabled={busy} onClick={() => setPhase({ step: "idle" })}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="settings-diagnostics-actions">
          <button type="button" className="settings-button" disabled={busy || bridge === undefined} onClick={() => void startPreview()}>
            Export diagnostics…
          </button>
        </div>
      )}
    </section>
  );
}

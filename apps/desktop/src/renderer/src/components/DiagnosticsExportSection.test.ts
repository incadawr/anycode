import { describe, expect, it } from "vitest";
import { describeDiagnosticsExport, describeDiagnosticsSections, type DiagnosticsExportPhase } from "./DiagnosticsExportSection.js";
import type { DiagnosticsSummary } from "../../../shared/diagnostics.js";

const SUMMARY: DiagnosticsSummary = {
  generatedAt: "2026-10-30T12:00:00.000Z",
  bytes: 2048,
  sections: [
    { name: "telemetry", records: 40, bytes: 1024 },
    { name: "toolShapes", records: 3, bytes: 128 },
    { name: "wire", records: 12, bytes: 512 },
  ],
  truncated: false,
  redactions: 7,
};

describe("diagnostics export UI text (GitHub #18)", () => {
  it("explains the action before it runs", () => {
    expect(describeDiagnosticsExport({ step: "idle" })).toContain("anonymised");
  });

  it("shows sizes, redaction count and truncation in the preview step", () => {
    const phase: DiagnosticsExportPhase = { step: "preview", preview: "{}", summary: { ...SUMMARY, truncated: true } };
    expect(describeDiagnosticsExport(phase)).toContain("2.0 KB");
    expect(describeDiagnosticsExport(phase)).toContain("7 redactions");
    expect(describeDiagnosticsExport(phase)).toContain("truncated");
  });

  it("reports canceled and successful saves distinctly", () => {
    expect(describeDiagnosticsExport({ step: "saved", saved: false })).toBe("Save canceled.");
    expect(describeDiagnosticsExport({ step: "saved", saved: true, path: "/tmp/out.json" })).toContain("/tmp/out.json");
  });

  it("translates closed failure reasons without echoing error text", () => {
    expect(describeDiagnosticsExport({ step: "error", reason: "write_failed" })).toBe("The bundle could not be written.");
    expect(describeDiagnosticsExport({ step: "error", reason: "something_else" })).toBe("Diagnostics export is unavailable.");
  });

  it("summarises section counts, never content", () => {
    expect(describeDiagnosticsSections(SUMMARY)).toBe("telemetry: 40 · toolShapes: 3 · wire: 12");
  });
});

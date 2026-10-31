import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_PREVIEW_PAGE_CHARS,
  describeDiagnosticsExport,
  describeDiagnosticsHidden,
  describeDiagnosticsSections,
  pageDiagnosticsPreview,
  type DiagnosticsExportPhase,
} from "./DiagnosticsExportSection.js";
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

  it("pages the preview and states exactly how many characters are hidden", () => {
    const text = "x".repeat(8_000) + "TAIL";
    const first = pageDiagnosticsPreview(text, DIAGNOSTICS_PREVIEW_PAGE_CHARS);
    expect(first.visible).toHaveLength(8_000);
    expect(first.hiddenChars).toBe(4);
    expect(pageDiagnosticsPreview(text, 8_004)).toEqual({ visible: text, hiddenChars: 0 });
  });

  it("returns the whole text and nothing hidden when it fits, and clamps out-of-range counts", () => {
    expect(pageDiagnosticsPreview("{}", 8_000)).toEqual({ visible: "{}", hiddenChars: 0 });
    expect(pageDiagnosticsPreview("abc", -5)).toEqual({ visible: "", hiddenChars: 3 });
    expect(pageDiagnosticsPreview("abc", 1_000)).toEqual({ visible: "abc", hiddenChars: 0 });
  });

  it("never splits a surrogate pair at the page boundary", () => {
    // "😀" is two UTF-16 units; a cut between them would render a broken glyph.
    const text = "a" + "😀".repeat(3);
    const page = pageDiagnosticsPreview(text, 2);
    expect(page.visible).toBe("a😀");
    expect(page.hiddenChars).toBe(text.length - page.visible.length);
  });

  it("describes the hidden amount in plain numbers and says the save has everything", () => {
    expect(describeDiagnosticsHidden(8_000, 123_456)).toBe(
      "Showing the first 8,000 of 123,456 characters. The saved file contains all of them.",
    );
  });
});

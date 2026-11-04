/**
 * Tests for the md popout's appearance handoff (md-window-appearance.ts):
 * main probes the MAIN window's applied `<html>` stamps and passes the
 * resolved theme/accent/density to the popout in its document query — the
 * narrowed popout has no settings family on its bridge and its in-memory
 * partition starts with empty localStorage, so without this handoff a
 * light-theme popout with a custom accent booted dark with defaults.
 *
 * The probe is faked as a plain `executeJavaScript` source; the garbage/
 * missing cases pin the fail-safe path (the popout must boot with exactly
 * the defaults its own empty stores would have produced, never a half
 * appearance). The source-scan half pins the index.ts wiring — the query
 * builder and probe are wired into `loadMdPreviewWindow` there, and a
 * full main-process harness for that one function would outweigh the pin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MD_WINDOW_APPEARANCE, mdWindowDocumentQuery, parseAppliedAppearance, readAppliedAppearance, type AppearanceSource } from "./md-window-appearance.js";

function sourceOf(result: unknown, impl: () => Promise<unknown> = async () => result): AppearanceSource {
  return {
    executeJavaScript: vi.fn(impl),
  };
}

describe("md window appearance — probe", () => {
  it("reads the main window's applied theme/accent/density stamps", async () => {
    const source = sourceOf({ theme: "light", accent: "ember", density: "compact" });
    await expect(readAppliedAppearance(source)).resolves.toEqual({ theme: "light", accent: "ember", density: "compact" });
    expect(source.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("maps absent stamps by DOM semantics: no data-density means comfortable", async () => {
    await expect(readAppliedAppearance(sourceOf({ theme: null, accent: null, density: null }))).resolves.toEqual({
      theme: "dark",
      accent: "current",
      density: "comfortable",
    });
  });

  it("falls back per field: an unknown value cannot poison the whole triple", async () => {
    await expect(readAppliedAppearance(sourceOf({ theme: "system", accent: "neon-green", density: "cozy" }))).resolves.toEqual({
      theme: "dark",
      accent: "current",
      density: "comfortable",
    });
  });

  it("resolves to the defaults when the probe throws or the source is missing", async () => {
    const throwing = sourceOf(undefined, async () => {
      throw new Error("main window not booted");
    });
    await expect(readAppliedAppearance(throwing)).resolves.toEqual(DEFAULT_MD_WINDOW_APPEARANCE);
    await expect(readAppliedAppearance(null)).resolves.toEqual(DEFAULT_MD_WINDOW_APPEARANCE);
  });

  it("parseAppliedAppearance ignores a non-object probe result", () => {
    for (const raw of [undefined, null, "light", 42]) {
      expect(parseAppliedAppearance(raw)).toEqual(DEFAULT_MD_WINDOW_APPEARANCE);
    }
  });
});

describe("md window appearance — document query", () => {
  it("carries the routing triple plus the appearance handoff, and nothing else", () => {
    expect(mdWindowDocumentQuery({ previewId: "p1", tabId: "t1" }, { theme: "light", accent: "teal", density: "comfortable" })).toEqual({
      view: "md-preview",
      tabId: "t1",
      previewId: "p1",
      theme: "light",
      accent: "teal",
      density: "comfortable",
    });
  });

  it("the wiring reaches the popout's load: loadMdPreviewWindow probes the main window and builds the query through this module", () => {
    // Source-scan pin (ipc-guard.test.ts's idiom): the wiring lives in
    // index.ts's loadMdPreviewWindow, which is cheap to read and expensive
    // to harness — the scan fails if the handoff is dropped from the load.
    const indexSource = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(indexSource).toMatch(/await readAppliedAppearance\(/);
    expect(indexSource).toMatch(/mdWindowDocumentQuery\(opts, appearance\)/);
  });
});

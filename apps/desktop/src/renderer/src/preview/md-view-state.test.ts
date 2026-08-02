import { describe, expect, it } from "vitest";
import {
  eventForReadResult,
  initialMdViewState,
  mdReadFailureMessage,
  mdViewReducer,
  type MdViewState,
} from "./md-view-state.js";
import type { MdDocPayload, MdDocReadResult } from "../../../shared/md-preview.js";

function doc(overrides: Partial<MdDocPayload> = {}): MdDocPayload {
  return {
    previewId: "p1",
    sourcePath: "doc.md",
    realSourcePath: "/workspace/doc.md",
    docDir: "/workspace",
    sourceText: "# hi",
    sizeBytes: 4,
    mtimeMs: 1000,
    docVersion: 0,
    ...overrides,
  };
}

describe("initialMdViewState", () => {
  it("starts loading, rendered mode, no doc/error", () => {
    expect(initialMdViewState).toEqual({ phase: "loading", mode: "rendered", doc: null, error: null });
  });
});

describe("mdViewReducer — FETCH_OK", () => {
  it("moves to ready, stores the doc, clears any error", () => {
    const state: MdViewState = { phase: "error", mode: "source", doc: null, error: "boom" };
    const next = mdViewReducer(state, { type: "FETCH_OK", doc: doc() });
    expect(next).toEqual({ phase: "ready", mode: "source", doc: doc(), error: null });
  });

  it("preserves the current mode (rendered/source is orthogonal to phase)", () => {
    const next = mdViewReducer(initialMdViewState, { type: "FETCH_OK", doc: doc() });
    expect(next.mode).toBe("rendered");
  });
});

describe("mdViewReducer — FETCH_FAIL", () => {
  it("moves to error and stores the message, WITHOUT clearing a previously-fetched doc", () => {
    const state: MdViewState = { phase: "loading", mode: "rendered", doc: doc(), error: null };
    const next = mdViewReducer(state, { type: "FETCH_FAIL", error: "too large" });
    expect(next).toEqual({ phase: "error", mode: "rendered", doc: doc(), error: "too large" });
  });
});

describe("mdViewReducer — RELOAD", () => {
  it("moves to loading, clears the error, keeps the stale doc and mode visible", () => {
    const state: MdViewState = { phase: "error", mode: "source", doc: doc(), error: "boom" };
    const next = mdViewReducer(state, { type: "RELOAD" });
    expect(next).toEqual({ phase: "loading", mode: "source", doc: doc(), error: null });
  });
});

describe("mdViewReducer — TOGGLE", () => {
  it("flips rendered -> source", () => {
    const next = mdViewReducer(initialMdViewState, { type: "TOGGLE" });
    expect(next.mode).toBe("source");
  });

  it("flips source -> rendered", () => {
    const state: MdViewState = { ...initialMdViewState, mode: "source" };
    const next = mdViewReducer(state, { type: "TOGGLE" });
    expect(next.mode).toBe("rendered");
  });

  it("never touches phase/doc/error", () => {
    const state: MdViewState = { phase: "ready", mode: "rendered", doc: doc(), error: null };
    const next = mdViewReducer(state, { type: "TOGGLE" });
    expect(next).toEqual({ phase: "ready", mode: "source", doc: doc(), error: null });
  });
});

describe("mdReadFailureMessage", () => {
  const cases: Array<[Extract<MdDocReadResult, { ok: false }>["reason"], string]> = [
    ["no_preview", "no longer available"],
    ["not_md", "not a markdown document"],
    ["not_found", "could not be found"],
    ["outside_roots", "outside the allowed workspace"],
    ["too_large", "too large"],
    ["io_error", "Failed to read"],
  ];
  it.each(cases)("%s maps to a human-readable message", (reason, substring) => {
    expect(mdReadFailureMessage(reason)).toContain(substring);
  });
});

describe("eventForReadResult", () => {
  it("ok:true -> FETCH_OK carrying the doc", () => {
    const result: MdDocReadResult = { ok: true, doc: doc() };
    expect(eventForReadResult(result)).toEqual({ type: "FETCH_OK", doc: doc() });
  });

  it("ok:false -> FETCH_FAIL carrying the mapped message", () => {
    const result: MdDocReadResult = { ok: false, reason: "too_large" };
    expect(eventForReadResult(result)).toEqual({ type: "FETCH_FAIL", error: mdReadFailureMessage("too_large") });
  });
});

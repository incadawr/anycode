import { describe, expect, it } from "vitest";
import {
  eventForNavigateResult,
  eventForReadResult,
  findPreviewSourcePath,
  initialMdViewState,
  mdReadFailureMessage,
  mdViewReducer,
  mdWindowTitle,
  parseMdWindowTarget,
  shouldRefetchOnDocVersionChange,
  stripLeadingFrontmatter,
  transferControlForContainer,
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

describe("mdViewReducer — NAVIGATE_OK", () => {
  it("moves to ready, stores the NEW doc, clears any error", () => {
    const state: MdViewState = { phase: "error", mode: "rendered", doc: doc(), error: "boom" };
    const next = mdViewReducer(state, { type: "NAVIGATE_OK", doc: doc({ sourcePath: "other.md", docVersion: 1 }) });
    expect(next).toEqual({ phase: "ready", mode: "rendered", doc: doc({ sourcePath: "other.md", docVersion: 1 }), error: null });
  });

  it("preserves the current mode — a reader in Source mode stays in Source mode for the newly-navigated doc", () => {
    const state: MdViewState = { phase: "ready", mode: "source", doc: doc(), error: null };
    const next = mdViewReducer(state, { type: "NAVIGATE_OK", doc: doc({ sourcePath: "other.md", docVersion: 1 }) });
    expect(next.mode).toBe("source");
  });
});

describe("eventForNavigateResult", () => {
  it("ok:true -> NAVIGATE_OK carrying the doc", () => {
    const result: MdDocReadResult = { ok: true, doc: doc() };
    expect(eventForNavigateResult(result)).toEqual({ type: "NAVIGATE_OK", doc: doc() });
  });

  it("ok:false -> FETCH_FAIL carrying the mapped message (same inline error surface as a failed read)", () => {
    const result: MdDocReadResult = { ok: false, reason: "not_md" };
    expect(eventForNavigateResult(result)).toEqual({ type: "FETCH_FAIL", error: mdReadFailureMessage("not_md") });
  });
});

describe("shouldRefetchOnDocVersionChange", () => {
  it("refetches when the pushed version is strictly newer than local", () => {
    expect(shouldRefetchOnDocVersionChange(1, 2)).toBe(true);
  });

  it("does not refetch when the pushed version equals local (our own just-applied navigate)", () => {
    expect(shouldRefetchOnDocVersionChange(2, 2)).toBe(false);
  });

  it("does not refetch when the pushed version is older/stale", () => {
    expect(shouldRefetchOnDocVersionChange(2, 1)).toBe(false);
  });
});

describe("parseMdWindowTarget (TASK.99 M3)", () => {
  it("parses both tabId and previewId out of the query string", () => {
    expect(parseMdWindowTarget("?view=md-preview&tabId=t1&previewId=p1")).toEqual({ tabId: "t1", previewId: "p1" });
  });

  it("order-independent and tolerates extra params", () => {
    expect(parseMdWindowTarget("?previewId=p1&extra=1&tabId=t1&view=md-preview")).toEqual({ tabId: "t1", previewId: "p1" });
  });

  it("missing tabId -> null", () => {
    expect(parseMdWindowTarget("?view=md-preview&previewId=p1")).toBeNull();
  });

  it("missing previewId -> null", () => {
    expect(parseMdWindowTarget("?view=md-preview&tabId=t1")).toBeNull();
  });

  it("empty tabId/previewId values -> null (not treated as present)", () => {
    expect(parseMdWindowTarget("?tabId=&previewId=")).toBeNull();
  });

  it("empty search string -> null", () => {
    expect(parseMdWindowTarget("")).toBeNull();
  });
});

describe("findPreviewSourcePath (TASK.99 M3)", () => {
  it("finds the matching preview's sourcePath", () => {
    const previews = [
      { previewId: "p1", sourcePath: "a.md" },
      { previewId: "p2", sourcePath: "b.md" },
    ];
    expect(findPreviewSourcePath(previews, "p2")).toBe("b.md");
  });

  it("no match -> empty string", () => {
    expect(findPreviewSourcePath([{ previewId: "p1", sourcePath: "a.md" }], "ghost")).toBe("");
  });

  it("match with no sourcePath field -> empty string", () => {
    expect(findPreviewSourcePath([{ previewId: "p1" }], "p1")).toBe("");
  });

  it("empty list -> empty string", () => {
    expect(findPreviewSourcePath([], "p1")).toBe("");
  });
});


describe("transferControlForContainer (owner smoke-test fix: unified header)", () => {
  it("panel -> targets window, labeled \"Open in window\"", () => {
    expect(transferControlForContainer("panel")).toEqual({ target: "window", label: "Open in window" });
  });

  it("window -> targets panel, labeled \"Move to panel\"", () => {
    expect(transferControlForContainer("window")).toEqual({ target: "panel", label: "Move to panel" });
  });
});

describe("mdWindowTitle (owner smoke-test fix: window titlebar)", () => {
  it("empty sourcePath (boot, before previewPanel.list resolves) -> generic fallback", () => {
    expect(mdWindowTitle("")).toBe("Markdown Preview");
  });

  it("plain filename -> itself", () => {
    expect(mdWindowTitle("presentation.md")).toBe("presentation.md");
  });

  it("forward-slash path -> basename only", () => {
    expect(mdWindowTitle("/workspace/docs/presentation.md")).toBe("presentation.md");
  });

  it("backslash (Windows) path -> basename only", () => {
    expect(mdWindowTitle("C:\\workspace\\docs\\presentation.md")).toBe("presentation.md");
  });

  it("trailing slash tolerated (falls back to the segment before it)", () => {
    expect(mdWindowTitle("/workspace/docs/")).toBe("docs");
  });
});

describe("stripLeadingFrontmatter", () => {
  it("removes a Marp/Jekyll frontmatter block with a multi-line `style: |` value, body intact", () => {
    const input =
      "---\n" +
      "marp: true\n" +
      "theme: default\n" +
      "style: |\n" +
      "  section {\n" +
      "    color: red;\n" +
      "  }\n" +
      "---\n" +
      "\n" +
      "# Slide 1\n" +
      "\n" +
      "Body text.\n";
    expect(stripLeadingFrontmatter(input)).toBe("\n# Slide 1\n\nBody text.\n");
  });

  it("no closing delimiter anywhere -> input returned unchanged", () => {
    const input = "---\nmarp: true\ntheme: default\n\n# Not actually frontmatter\n";
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });

  it("a later `---` (Marp slide separator) is left untouched — only the leading block is stripped", () => {
    const input = "---\nmarp: true\n---\n\n# Slide 1\n\n---\n\n# Slide 2\n";
    expect(stripLeadingFrontmatter(input)).toBe("\n# Slide 1\n\n---\n\n# Slide 2\n");
  });

  it("first line is not `---` -> identity", () => {
    const input = "# Just a heading\n\nSome body text with a --- dash later.\n";
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });

  it("`...` as the closing delimiter works", () => {
    const input = "---\ntitle: Doc\n...\nBody after the ellipsis close.\n";
    expect(stripLeadingFrontmatter(input)).toBe("Body after the ellipsis close.\n");
  });

  it("CRLF input works, preserving CRLF in the surviving body", () => {
    const input = "---\r\nmarp: true\r\n---\r\n# Body\r\n";
    expect(stripLeadingFrontmatter(input)).toBe("# Body\r\n");
  });

  it("empty frontmatter (`---\\n---\\n`) works", () => {
    expect(stripLeadingFrontmatter("---\n---\n")).toBe("");
  });

  it("identity on plain text with no frontmatter at all", () => {
    const input = "Just a plain paragraph.\n\nAnother one.\n";
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });

  it("tolerates a leading UTF-8 BOM on the opening delimiter line", () => {
    const input = "\uFEFF---\ntitle: Doc\n---\nBody.\n";
    expect(stripLeadingFrontmatter(input)).toBe("Body.\n");
  });

  it("tolerates trailing whitespace on the opening and closing delimiter lines", () => {
    const input = "---   \ntitle: Doc\n---\t\nBody.\n";
    expect(stripLeadingFrontmatter(input)).toBe("Body.\n");
  });

  it("bare leading `---` with no close anywhere (a horizontal rule, not frontmatter) -> unchanged", () => {
    const input = "---\n\nJust a horizontal rule at the top, not frontmatter.\n";
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });

  it("document that is only the opening `---` with nothing after -> unchanged (no close found)", () => {
    expect(stripLeadingFrontmatter("---")).toBe("---");
  });
});

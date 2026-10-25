/**
 * Pure-model tests for the Language servers pane (Taskana 4743): splitArgs
 * quote handling, extension parsing, form validation messages, request
 * builders (path custody: tabId + presetId/name/entry ONLY), catalog row
 * view-model (found badge, enabled-scope labels, "both claim .py" overlap),
 * and notice selection by `projectTrusted`.
 */

import { describe, expect, it } from "vitest";
import type { LspCatalogStatusEntry, LspConfigStatus, LspEntryView } from "../../../shared/lsp-config.js";
import {
  NEW_SESSIONS_NOTICE,
  NOT_INSTALLED_NOTICE,
  blankCustomForm,
  buildCatalogRows,
  buildCustomUpsertRequest,
  buildDisableRequest,
  buildEnableRequest,
  canSubmitCustomForm,
  findExtensionOverlap,
  formatCommandLine,
  lspRefusalMessage,
  parseExtensions,
  projectEnableDisabledReason,
  sortEntryViews,
  splitArgs,
  trustNotice,
  validateCustomForm,
} from "./language-servers-model.js";

function catalogEntry(overrides: Partial<LspCatalogStatusEntry> = {}): LspCatalogStatusEntry {
  return {
    id: "gopls",
    label: "Go",
    languages: "Go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    installHint: "go install golang.org/x/tools/gopls@latest",
    found: false,
    foundSource: null,
    ...overrides,
  };
}

function status(overrides: Partial<LspConfigStatus> = {}): LspConfigStatus {
  return {
    catalog: [catalogEntry()],
    entries: { project: [], user: [] },
    issues: [],
    projectScopeAvailable: true,
    projectTrusted: true,
    ...overrides,
  };
}

function entryView(overrides: Partial<LspEntryView> = {}): LspEntryView {
  return { name: "gopls", command: "gopls", args: [], extensions: [".go"], presetId: null, hasInitOptions: false, ...overrides };
}

// ── splitArgs ──

describe("splitArgs", () => {
  it("splits on whitespace, dropping empties", () => {
    expect(splitArgs("--stdio   --foo\tbar")).toEqual(["--stdio", "--foo", "bar"]);
  });

  it("keeps quoted tokens with spaces together (double and single quotes)", () => {
    expect(splitArgs('--header "Content-Type: application/json" \'a b\'')).toEqual([
      "--header",
      "Content-Type: application/json",
      "a b",
    ]);
  });

  it("an unclosed quote takes the rest of the string (never throws)", () => {
    expect(splitArgs('"open ended token')).toEqual(["open ended token"]);
  });

  it("empty text yields no args", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("   ")).toEqual([]);
  });

  it("a quote mid-token attaches without shell semantics (no expansion, no escapes)", () => {
    // The quote only toggles in-token spacing; letters around it concatenate.
    expect(splitArgs("a\"b\"c")).toEqual(["abc"]);
    expect(splitArgs("$HOME")).toEqual(["$HOME"]);
  });
});

// ── parseExtensions ──

describe("parseExtensions", () => {
  it("splits on commas and/or spaces", () => {
    expect(parseExtensions(".ts, .tsx .js")).toEqual([".ts", ".tsx", ".js"]);
  });

  it("lowercases and dot-prefixes", () => {
    expect(parseExtensions("TS .TsX tsx")).toEqual([".ts", ".tsx", ".tsx"]);
  });

  it("drops empties", () => {
    expect(parseExtensions(" , , ")).toEqual([]);
  });
});

// ── request builders (path custody) ──

describe("request builders", () => {
  it("enable carries ONLY tabId + presetId + scope", () => {
    expect(buildEnableRequest("tab-1", "gopls", "user")).toEqual({ tabId: "tab-1", presetId: "gopls", scope: "user" });
    expect(buildEnableRequest(undefined, "gopls", "project")).toEqual({ tabId: undefined, presetId: "gopls", scope: "project" });
  });

  it("disable carries ONLY tabId + name + scope", () => {
    expect(buildDisableRequest("tab-1", "mine", "project")).toEqual({ tabId: "tab-1", name: "mine", scope: "project" });
  });

  it("custom upsert parses args/extensions and normalizes the scope", () => {
    const fields = { ...blankCustomForm("user"), name: "mine", command: "my-server", argsText: '--stdio "x y"', extensionsText: ".ZZ, q" };
    expect(buildCustomUpsertRequest("t", fields)).toEqual({
      tabId: "t",
      scope: "user",
      entry: { name: "mine", command: "my-server", args: ["--stdio", "x y"], extensions: [".zz", ".q"] },
    });
  });

  it("custom upsert omits args when none are given (schema treats them as optional)", () => {
    const fields = { ...blankCustomForm("project"), name: "n", command: "c", extensionsText: ".x" };
    expect(buildCustomUpsertRequest(undefined, fields).entry).toEqual({ name: "n", command: "c", extensions: [".x"] });
  });
});

// ── form validation ──

describe("validateCustomForm / canSubmitCustomForm", () => {
  it("blank form fails with all three messages", () => {
    const errors = validateCustomForm(blankCustomForm("user"));
    expect(errors.name).toBeDefined();
    expect(errors.command).toBeDefined();
    expect(errors.extensions).toBeDefined();
    expect(canSubmitCustomForm(blankCustomForm("user"))).toBe(false);
  });

  it("a reserved name is rejected with the reserved message", () => {
    const fields = { ...blankCustomForm("user"), name: "__proto__", command: "c", extensionsText: ".x" };
    expect(validateCustomForm(fields).name).toContain("reserved");
    expect(canSubmitCustomForm(fields)).toBe(false);
  });

  it("a valid form passes and can submit", () => {
    const fields = { ...blankCustomForm("user"), name: "mine", command: "my-server", extensionsText: ".zz .qq" };
    expect(validateCustomForm(fields)).toEqual({});
    expect(canSubmitCustomForm(fields)).toBe(true);
  });
});

// ── catalog rows ──

describe("buildCatalogRows", () => {
  const catalog = [
    catalogEntry({ id: "pyright", extensions: [".py"], command: "pyright-langserver" }),
    catalogEntry({ id: "basedpyright", extensions: [".py"], command: "basedpyright-langserver" }),
    catalogEntry({ id: "gopls", extensions: [".go"], found: true, foundSource: "path" }),
  ];

  it("badge reflects detection; notInstalled drives the warning note", () => {
    const rows = buildCatalogRows(status({ catalog }));
    const gopls = rows.find((row) => row.entry.id === "gopls")!;
    expect(gopls.badge).toBe("Found");
    expect(gopls.notInstalled).toBe(false);
    const pyright = rows.find((row) => row.entry.id === "pyright")!;
    expect(pyright.badge).toBe("Not installed");
    expect(pyright.notInstalled).toBe(true);
  });

  it("enabledLabel names each scope that defines the entry's name", () => {
    const rows = buildCatalogRows(
      status({
        catalog,
        entries: {
          project: [entryView({ name: "pyright" })],
          user: [entryView({ name: "pyright" }), entryView({ name: "gopls" })],
        },
      }),
    );
    const pyright = rows.find((row) => row.entry.id === "pyright")!;
    expect(pyright.enabled).toEqual({ project: true, user: true });
    expect(pyright.enabledLabel).toBe("Enabled (project, all projects)");
    const gopls = rows.find((row) => row.entry.id === "gopls")!;
    expect(gopls.enabledLabel).toBe("Enabled (all projects)");
    const based = rows.find((row) => row.entry.id === "basedpyright")!;
    expect(based.enabledLabel).toBeNull();
    expect(based.enabled).toEqual({ project: false, user: false });
  });

  it("the pyright/basedpyright .py overlap is flagged both ways", () => {
    const rows = buildCatalogRows(status({ catalog }));
    const pyright = rows.find((row) => row.entry.id === "pyright")!;
    const based = rows.find((row) => row.entry.id === "basedpyright")!;
    expect(pyright.extensionOverlap).toBe(true);
    expect(pyright.overlapWith).toBe("basedpyright");
    expect(based.extensionOverlap).toBe(true);
    expect(based.overlapWith).toBe("pyright");
    expect(rows.find((row) => row.entry.id === "gopls")!.extensionOverlap).toBe(false);
  });

  it("project button reason: null when available, sentence when not", () => {
    expect(projectEnableDisabledReason(true)).toBeNull();
    expect(projectEnableDisabledReason(false)).toBe("No project is open");
  });
});

describe("findExtensionOverlap", () => {
  it("returns the first other entry sharing any extension", () => {
    const a = catalogEntry({ id: "a", extensions: [".x", ".y"] });
    const b = catalogEntry({ id: "b", extensions: [".y"] });
    expect(findExtensionOverlap(a, [a, b])).toEqual({ overlaps: true, with: "b" });
    expect(findExtensionOverlap(b, [a, b])).toEqual({ overlaps: true, with: "a" });
  });

  it("no overlap across disjoint extension sets", () => {
    const a = catalogEntry({ id: "a", extensions: [".x"] });
    const b = catalogEntry({ id: "b", extensions: [".z"] });
    expect(findExtensionOverlap(a, [a, b])).toEqual({ overlaps: false, with: null });
  });
});

// ── notices ──

describe("notices", () => {
  it("the new-sessions notice is fixed text", () => {
    expect(NEW_SESSIONS_NOTICE).toContain("new sessions");
  });

  it("trustNotice: false names the inactive state explicitly; null/true use the generic sentence", () => {
    expect(trustNotice(false)).toContain("saved but stay inactive");
    expect(trustNotice(false)).toContain("not trusted");
    expect(trustNotice(null)).toBe("Project entries start only after you trust this folder.");
    expect(trustNotice(true)).toBe("Project entries start only after you trust this folder.");
  });

  it("NOT_INSTALLED_NOTICE names PATH and failure-to-start", () => {
    expect(NOT_INSTALLED_NOTICE).toContain("PATH");
  });
});

// ── misc ──

describe("formatCommandLine / sortEntryViews / lspRefusalMessage", () => {
  it("joins command + args with spaces, dropping empties", () => {
    expect(formatCommandLine("gopls", [])).toBe("gopls");
    expect(formatCommandLine("tsls", ["--stdio"])).toBe("tsls --stdio");
  });

  it("sorts entry views by name", () => {
    const sorted = sortEntryViews([entryView({ name: "z" }), entryView({ name: "a" })]);
    expect(sorted.map((entry) => entry.name)).toEqual(["a", "z"]);
  });

  it("refusal messages are distinct per reason", () => {
    const messages = (["invalid", "unknown_preset", "no_workspace", "io_error", "invalid_shape"] as const).map((reason) =>
      lspRefusalMessage(reason),
    );
    expect(new Set(messages).size).toBe(5);
    expect(messages.every((message) => message.length > 0)).toBe(true);
  });
});

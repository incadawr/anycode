import { describe, expect, it } from "vitest";
import type { LspServerStatus } from "@anycode/core";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";
import {
  LSP_NOT_INSTALLED_LABEL,
  buildLspCatalogLookup,
  formatLspExtensions,
  formatLspState,
  formatLspSummary,
  resolveLspRowState,
} from "./LspPanel.js";

describe("LspPanel pure helpers", () => {
  it("formats LSP states for compact badges", () => {
    expect(formatLspState("not_started")).toBe("Not started");
    expect(formatLspState("initializing")).toBe("Initializing");
    expect(formatLspState("ready")).toBe("Ready");
    expect(formatLspState("crashed")).toBe("Crashed");
    expect(formatLspState("disposed")).toBe("Disposed");
  });

  it("formats extension lists without overflowing empty state text", () => {
    expect(formatLspExtensions([".ts", ".tsx"])).toBe(".ts, .tsx");
    expect(formatLspExtensions([])).toBe("-");
  });
});

// ── header summary counts (P7.25/F3 W2, design §3 W2) ──

function server(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    name: "typescript",
    state: "ready",
    extensions: [".ts", ".tsx"],
    stderrTail: "",
    ...overrides,
  };
}

describe("formatLspSummary", () => {
  it("returns an empty string for no servers — the one honest reading shared by an absent seam and an empty config", () => {
    expect(formatLspSummary([])).toBe("");
  });

  it("counts a single state, reusing the formatLspState vocabulary (lowercased)", () => {
    expect(formatLspSummary([server({ state: "ready" })])).toBe("1 ready");
    expect(formatLspSummary([server({ state: "crashed" })])).toBe("1 crashed");
  });

  it("orders multiple states ready-first regardless of input order, separated by middot", () => {
    const servers = [
      server({ name: "a", state: "crashed" }),
      server({ name: "b", state: "ready" }),
      server({ name: "c", state: "ready" }),
    ];
    expect(formatLspSummary(servers)).toBe("2 ready · 1 crashed");
  });

  it("includes every present state in the fixed order, skipping absent ones", () => {
    const servers = [
      server({ name: "a", state: "not_started" }),
      server({ name: "b", state: "initializing" }),
      server({ name: "c", state: "crashed" }),
      server({ name: "d", state: "disposed" }),
    ];
    expect(formatLspSummary(servers)).toBe("1 initializing · 1 crashed · 1 disposed · 1 not started");
  });
});

// ── "Not installed" vs "Not started" (Taskana 4845) ──

function buildLspLookupSizeForTest(lookup: Map<string, { found: boolean; installHint: string }>): number {
  return lookup.size;
}


function catalogStatus(entries: { id: string; found: boolean; installHint: string }[]): LspConfigStatus {
  return {
    catalog: entries.map((entry) => ({
      id: entry.id,
      label: entry.id,
      languages: entry.id,
      command: entry.id,
      args: [],
      extensions: [`.${entry.id}`],
      installHint: entry.installHint,
      found: entry.found,
      foundSource: entry.found ? "path" : null,
    })),
    entries: { project: null, user: [] },
    issues: [],
    projectScopeAvailable: false,
    projectTrusted: null,
  };
}

describe("buildLspCatalogLookup", () => {
  it("indexes catalog entries by id for O(1) row joins", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    expect(lookup.get("typescript")?.installHint).toBe("npm i -g typescript");
    expect(lookup.has("gopls")).toBe(false);
  });

  it("an empty catalog yields an empty lookup (no detection => keep live states)", () => {
    expect(buildLspLookupSizeForTest(buildLspCatalogLookup(catalogStatus([])))).toBe(0);
  });
});

describe("resolveLspRowState (Taskana 4845: Not installed vs Not started)", () => {
  it("a lazy not_started server whose binary the catalog reports missing becomes not_installed", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "not_started" }), lookup).state).toBe("not_installed");
  });

  it("a not_started server with the binary FOUND stays not_started (lazy before first edit)", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: true, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "not_started" }), lookup).state).toBe("not_started");
  });

  it("custom/hand-written entries (no catalog match) never become not_installed", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "my-server", state: "not_started" }), lookup).state).toBe("not_started");
  });

  it("live states other than not_started pass through untouched", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "initializing" }), lookup).state).toBe("initializing");
    expect(resolveLspRowState(server({ name: "typescript", state: "ready" }), lookup).state).toBe("ready");
    expect(resolveLspRowState(server({ name: "typescript", state: "disposed" }), lookup).state).toBe("disposed");
  });

  it("a crashed server whose binary the catalog reports missing also reads not_installed (the ENOENT spawn outcome)", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "crashed" }), lookup).state).toBe("not_installed");
  });

  it("a crashed server with the binary FOUND stays crashed (a real process died)", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: true, installHint: "npm i -g typescript" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "crashed" }), lookup).state).toBe("crashed");
  });

  it("carries the catalog entry's install hint alongside the not_installed state", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript typescript-language-server" }]));
    expect(resolveLspRowState(server({ name: "typescript", state: "not_started" }), lookup).installHint).toBe(
      "npm i -g typescript typescript-language-server",
    );
  });
});

describe("formatLspSummary with detection join", () => {
  it("counts not_installed rows in the fixed order vocabulary (lowercased)", () => {
    const lookup = buildLspCatalogLookup(catalogStatus([{ id: "typescript", found: false, installHint: "npm i -g typescript" }]));
    const servers = [server({ name: "typescript", state: "not_started" }), server({ name: "gopls", state: "ready" })];
    expect(formatLspSummary(servers, lookup)).toBe("1 ready · 1 not installed");
  });

  it("without a lookup the summary is unchanged (existing callers/tests stay green)", () => {
    expect(formatLspSummary([server({ name: "a", state: "not_started" })])).toBe("1 not started");
  });
});

describe("LSP setup hint (empty state)", () => {
  it("the example is a well-formed lspServers config (core schema shape)", async () => {
    const { LSP_SETUP_EXAMPLE } = await import("./LspPanel.js");
    const parsed = JSON.parse(LSP_SETUP_EXAMPLE) as {
      lspServers: { name: unknown; command: unknown; args?: unknown; extensions: unknown }[];
    };
    expect(parsed.lspServers).toHaveLength(1);
    const entry = parsed.lspServers[0]!;
    // Mirrors packages/core/src/lsp/config.ts lspServerEntrySchema (required: name, command, extensions[>=1]).
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.command).toBe("string");
    expect(Array.isArray(entry.extensions) && (entry.extensions as unknown[]).length > 0).toBe(true);
  });
});

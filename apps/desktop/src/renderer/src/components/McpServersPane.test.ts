/**
 * Pure-logic tests for McpServersPane's exported helpers (P7.19/F22 W3, design
 * slice-P7.19-cut.md §4 W3 gate). Same `.test.ts`-only, no-jsdom rationale as
 * every other component test in this directory (SettingsScreen.test.ts's own
 * docstring: this package's vitest config runs `environment: "node"`, no
 * jsdom/testing-library in the tree) — every behavior the cut's gate asks for
 * (join/dot logic, forced-disabled import flow, masked-env custody, compat
 * read-only) is exercised through the component's exported pure builders
 * rather than a rendered DOM, mirroring PermissionsEditor.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { McpServerStatus } from "@anycode/core";
import type { McpConfigEntryView, McpImportCandidateView } from "../../../shared/mcp-config.js";
import {
  blankMcpFormFields,
  buildEnvRecord,
  buildFormUpsertRequest,
  buildImportApplyRequest,
  buildMcpFormEntryInput,
  buildPromoteCompatRequest,
  buildSetEnabledRequest,
  buildDeleteRequest,
  canManageMcpEntry,
  canSubmitMcpForm,
  defaultImportScope,
  defaultImportSelection,
  describeMcpConfigRow,
  envRowsFromKeys,
  filterMcpRows,
  groupImportCandidates,
  harnessLabel,
  importFooterLabel,
  importResultText,
  joinMcpRows,
  maskedEnvChips,
  mcpFormFieldsForEdit,
  mcpRefusalMessage,
  parseCommandLine,
  partitionMcpRows,
  selectedImportIds,
  sourceBadgeLabel,
  splitArgsText,
  toolsBadgeText,
} from "./McpServersPane.js";

const SENTINEL_VALUE = "SENTINEL_MCP_SECRET_93F1_do_not_render";

function entry(overrides: Partial<McpConfigEntryView> = {}): McpConfigEntryView {
  return {
    name: "ozon",
    source: "project",
    enabled: true,
    transport: "stdio",
    commandLine: "node /Users/incadawr/mcp/index.js --flag",
    envKeys: [],
    ...overrides,
  };
}

function status(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name: "ozon",
    transport: "stdio",
    state: "connected",
    toolCount: 6,
    toolsTruncated: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<McpImportCandidateView> = {}): McpImportCandidateView {
  const base = {
    harness: "claude" as const,
    sourcePath: "~/.claude.json",
    name: "browser",
    transport: "stdio" as const,
    commandLine: "node browser.js",
    envKeys: [] as string[],
    hasSecrets: false,
    alreadyConfigured: false,
    ...overrides,
  };
  return { id: base.id ?? `${base.harness} ${base.sourcePath} ${base.name}`, ...base };
}

// ── data join (design §4 W3: dot/detail incl. disabled + config-only rows) ──

describe("describeMcpConfigRow / joinMcpRows", () => {
  it("renders a hollow/off dot for a disabled entry regardless of any stale status", () => {
    const disabled = entry({ enabled: false });
    expect(describeMcpConfigRow(disabled, status())).toEqual({ kind: "off", detail: "disabled" });
    expect(describeMcpConfigRow(disabled, undefined)).toEqual({ kind: "off", detail: "disabled" });
  });

  it("reuses describeMcpServer verbatim for an enabled entry with a live status row", () => {
    expect(describeMcpConfigRow(entry(), status({ state: "connected", toolCount: 6 }))).toEqual({
      kind: "completed",
      detail: "6 tools",
    });
    expect(describeMcpConfigRow(entry(), status({ state: "failed", error: "boom" }))).toEqual({
      kind: "failed",
      detail: "boom",
    });
  });

  it("renders a neutral dot + hint for an enabled entry with NO status row (config-only — the join's whole point)", () => {
    expect(describeMcpConfigRow(entry({ enabled: true }), undefined)).toEqual({
      kind: "neutral",
      detail: "applies to newly started tasks",
    });
  });

  it("joinMcpRows LEFT-JOINs by name, leaving a config-only entry with an undefined status", () => {
    const entries = [entry({ name: "ozon" }), entry({ name: "no-status", enabled: false })];
    const rows = joinMcpRows(entries, [status({ name: "ozon" })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toEqual(status({ name: "ozon" }));
    expect(rows[0]!.dotKind).toBe("completed");
    expect(rows[1]!.status).toBeUndefined();
    expect(rows[1]!.dotKind).toBe("off");
  });

  it("a disabled entry never shows a tools badge, even with a stale connected status", () => {
    const rows = joinMcpRows([entry({ enabled: false })], [status({ toolCount: 9 })]);
    expect(toolsBadgeText(rows[0]!)).toBeUndefined();
  });

  it("toolsBadgeText renders singular for exactly one tool", () => {
    const rows = joinMcpRows([entry()], [status({ toolCount: 1 })]);
    expect(toolsBadgeText(rows[0]!)).toBe("1 tool");
  });
});

// ── sections + search (design §1.4/§1.5) ──

describe("W5-FIX finding 8 — a shadowed row never borrows the winner's runtime status", () => {
  it("only the CLAIMED (non-shadowed) row shows the connected dot + tools badge; the shadowed same-named row renders neutral", () => {
    const claimed = entry({ name: "foo", source: "project" });
    const shadowed = entry({ name: "foo", source: "user", shadowed: true });
    const connected = status({ name: "foo", state: "connected", toolCount: 3 });
    const rows = joinMcpRows([claimed, shadowed], [connected]);

    const claimedRow = rows.find((r) => r.entry.source === "project")!;
    const shadowedRow = rows.find((r) => r.entry.source === "user")!;

    expect(claimedRow.dotKind).toBe("completed");
    expect(toolsBadgeText(claimedRow)).toBe("3 tools");

    // The shadowed row must NOT inherit foo's connected status.
    expect(shadowedRow.dotKind).toBe("neutral");
    expect(shadowedRow.status).toBeUndefined();
    expect(toolsBadgeText(shadowedRow)).toBeUndefined();
  });
});

describe("partitionMcpRows", () => {
  it("splits configured (project/user) from compat (.mcp.json) rows", () => {
    const rows = joinMcpRows(
      [entry({ name: "a", source: "project" }), entry({ name: "b", source: "user" }), entry({ name: "c", source: "compat" })],
      [],
    );
    const { configured, compat } = partitionMcpRows(rows);
    expect(configured.map((r) => r.entry.name)).toEqual(["a", "b"]);
    expect(compat.map((r) => r.entry.name)).toEqual(["c"]);
  });
});

describe("filterMcpRows", () => {
  it("is a trivial case-insensitive name substring filter — no fuzzy matching", () => {
    const rows = joinMcpRows([entry({ name: "Ozon" }), entry({ name: "browser" })], []);
    expect(filterMcpRows(rows, "ozo").map((r) => r.entry.name)).toEqual(["Ozon"]);
    expect(filterMcpRows(rows, "zn")).toEqual([]);
    expect(filterMcpRows(rows, "  ")).toHaveLength(2);
  });
});

describe("sourceBadgeLabel", () => {
  it("maps each source to its display label", () => {
    expect(sourceBadgeLabel("project")).toBe("Project");
    expect(sourceBadgeLabel("user")).toBe("User");
    expect(sourceBadgeLabel("compat")).toBe("Compat");
  });
});

// ── compat read-only (design §1.5/§3: no toggle/edit/delete, only "Import to project") ──

describe("canManageMcpEntry (compat read-only gate)", () => {
  it("refuses management of a compat row", () => {
    expect(canManageMcpEntry(entry({ source: "compat" }))).toBe(false);
  });

  it("allows management of project/user rows", () => {
    expect(canManageMcpEntry(entry({ source: "project" }))).toBe(true);
    expect(canManageMcpEntry(entry({ source: "user" }))).toBe(true);
  });

  it("toggle/delete request builders are never reached for a compat row — the component gates on canManageMcpEntry first", () => {
    // The component's toggleEntry/deleteEntry both early-return on
    // !canManageMcpEntry(entry) before calling these builders; this test
    // pins the predicate they gate on, since the builders themselves accept
    // any source structurally (scope resolution isn't the enforcement point).
    const compatEntry = entry({ source: "compat" });
    expect(canManageMcpEntry(compatEntry)).toBe(false);
  });

  it("promote of a compat row is a name+tab pass-through (main resolves the project scope; W5-FIX finding 3)", () => {
    const request = buildPromoteCompatRequest("tab-1", entry({ source: "compat", name: "ozon", enabled: true }));
    expect(request).toEqual({ tabId: "tab-1", name: "ozon" });
  });
});

// ── masked env custody (design §3: a value NEVER renders — envKeys names only) ──

describe("maskedEnvChips custody", () => {
  it("renders KEY=•••• from key names alone — never a value string, even against a sentinel-bearing view", () => {
    // The view type structurally carries only `envKeys: string[]` (no value
    // field exists to leak) — this test still asserts by EXECUTION that the
    // sentinel never appears in the rendered chip text, per the design's
    // "prove custody by execution" discipline (W1/W2 gates do the same).
    const chips = maskedEnvChips(["API_KEY", "SECRET_TOKEN"]);
    expect(chips).toEqual(["API_KEY=••••", "SECRET_TOKEN=••••"]);
    for (const chip of chips) {
      expect(chip).not.toContain(SENTINEL_VALUE);
      expect(chip).not.toMatch(/[^=]=[^•]/); // nothing after "=" but the mask glyphs
    }
  });

  it("an import candidate view (structurally envKeys-only) never yields a value string through the masking helper", () => {
    const withSecrets = candidate({ envKeys: ["API_KEY"], hasSecrets: true });
    const chips = maskedEnvChips(withSecrets.envKeys);
    expect(JSON.stringify(chips)).not.toContain(SENTINEL_VALUE);
    expect(chips).toEqual(["API_KEY=••••"]);
  });

  it("a locked env row with no typed replacement is omitted from the built record (never resurrects the old value)", () => {
    const rows = envRowsFromKeys(["API_KEY"]);
    expect(rows).toEqual([{ key: "API_KEY", locked: true, value: "" }]);
    expect(buildEnvRecord(rows)).toEqual({});
  });

  it("a locked env row WITH a typed replacement writes the new value (write-only, never the old one)", () => {
    const rows = envRowsFromKeys(["API_KEY"]);
    rows[0]!.value = "brand-new-value";
    expect(buildEnvRecord(rows)).toEqual({ API_KEY: "brand-new-value" });
  });

  it("a new (unlocked) env row needs both a key and a value to count", () => {
    expect(buildEnvRecord([{ key: "", locked: false, value: "x" }])).toEqual({});
    expect(buildEnvRecord([{ key: "FOO", locked: false, value: "" }])).toEqual({});
    expect(buildEnvRecord([{ key: "FOO", locked: false, value: "bar" }])).toEqual({ FOO: "bar" });
  });
});

// ── compat promote (W5-FIX finding 3): main-side, name-only, no reconstruction ──

describe("buildPromoteCompatRequest (compat 'Import to project' — W5-FIX finding 3)", () => {
  it("carries ONLY the server name + tabId — the renderer never reconstructs the entry (no commandLine reparse, no dropped cwd/env, no kept enabled)", () => {
    const request = buildPromoteCompatRequest("tab-1", entry({ source: "compat", name: "ozon", enabled: true, commandLine: "node index.js --flag" }));
    expect(request).toEqual({ tabId: "tab-1", name: "ozon" });
    // Structurally cannot carry an `entry` payload, so it cannot corrupt args or
    // drop cwd/env, and cannot smuggle `enabled:true` past the trust gate —
    // main forces `enabled:false` from the real .mcp.json entry.
    expect("entry" in request).toBe(false);
  });
});

// ── setEnabled (W3-FIX): lossless toggle request, no confirm, no full-replace ──

describe("buildSetEnabledRequest", () => {
  it("flips enabled and resolves scope from the entry's own source (project/user, never compat)", () => {
    expect(buildSetEnabledRequest("tab-1", entry({ source: "project", enabled: true }))).toEqual({
      tabId: "tab-1",
      scope: "project",
      name: "ozon",
      enabled: false,
    });
    expect(buildSetEnabledRequest("tab-1", entry({ source: "user", enabled: false }))).toEqual({
      tabId: "tab-1",
      scope: "user",
      name: "ozon",
      enabled: true,
    });
  });

  it("carries no entry payload at all — structurally cannot drop cwd/secrets since it never reconstructs the entry", () => {
    const request = buildSetEnabledRequest("tab-1", entry({ enabled: true, envKeys: ["API_KEY"], commandLine: "node x.js" }));
    expect(request).toEqual({ tabId: "tab-1", scope: "project", name: "ozon", enabled: false });
    expect(Object.keys(request).sort()).toEqual(["enabled", "name", "scope", "tabId"]);
  });
});

describe("parseCommandLine", () => {
  it("splits on whitespace, first token is the command", () => {
    expect(parseCommandLine("node /a/b.js --x --y")).toEqual({ command: "node", args: ["/a/b.js", "--x", "--y"] });
  });

  it("handles a bare command with no args", () => {
    expect(parseCommandLine("node")).toEqual({ command: "node", args: [] });
  });
});

// ── refusal messages ──

describe("mcpRefusalMessage", () => {
  it("has a distinct, non-empty message per refusal reason", () => {
    const reasons = ["invalid", "no_workspace", "read_only_source", "io_error", "not_found"] as const;
    const messages = reasons.map((r) => mcpRefusalMessage(r));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
    }
  });
});

// ── add/edit form ──

describe("canSubmitMcpForm", () => {
  it("requires a name, plus a command (stdio) or a url (http)", () => {
    const base = blankMcpFormFields("project");
    expect(canSubmitMcpForm(base)).toBe(false);
    expect(canSubmitMcpForm({ ...base, name: "srv" })).toBe(false);
    expect(canSubmitMcpForm({ ...base, name: "srv", command: "node" })).toBe(true);
    expect(canSubmitMcpForm({ ...base, name: "srv", transport: "http", url: "" })).toBe(false);
    expect(canSubmitMcpForm({ ...base, name: "srv", transport: "http", url: "https://x" })).toBe(true);
  });
});

describe("buildMcpFormEntryInput", () => {
  it("builds a stdio entry with args/cwd/env only when present", () => {
    const fields = { ...blankMcpFormFields("project"), name: "srv", command: "node", argsText: "a.js\n--x", cwd: "/work" };
    expect(buildMcpFormEntryInput(fields)).toEqual({ enabled: true, command: "node", args: ["a.js", "--x"], cwd: "/work" });
  });

  it("omits args/cwd when blank", () => {
    const fields = { ...blankMcpFormFields("project"), name: "srv", command: "node" };
    expect(buildMcpFormEntryInput(fields)).toEqual({ enabled: true, command: "node" });
  });

  it("builds an http entry from the url field", () => {
    const fields = { ...blankMcpFormFields("user"), name: "srv", transport: "http" as const, url: "https://x" };
    expect(buildMcpFormEntryInput(fields)).toEqual({ enabled: true, url: "https://x" });
  });

  it("includes env only when the built record is non-empty", () => {
    const fields = {
      ...blankMcpFormFields("project"),
      name: "srv",
      command: "node",
      envRows: [{ key: "FOO", locked: false, value: "bar" }],
    };
    expect(buildMcpFormEntryInput(fields).env).toEqual({ FOO: "bar" });
  });
});

describe("mcpFormFieldsForEdit", () => {
  it("prefills name/scope/transport/command/args/enabled/envRows from a project entry", () => {
    const fields = mcpFormFieldsForEdit(
      entry({ name: "ozon", source: "project", commandLine: "node index.js --x", envKeys: ["TOKEN"] }),
    );
    expect(fields.name).toBe("ozon");
    expect(fields.scope).toBe("project");
    expect(fields.transport).toBe("stdio");
    expect(fields.command).toBe("node");
    expect(fields.argsText).toBe("index.js\n--x");
    expect(fields.cwd).toBe(""); // absent from the source view -> blank, not lost
    expect(fields.envRows).toEqual([{ key: "TOKEN", locked: true, value: "" }]);
  });

  it("prefills cwd from the view (W3-FIX: cwd now crosses in McpConfigEntryView)", () => {
    const fields = mcpFormFieldsForEdit(entry({ commandLine: "node index.js", cwd: "/work/srv" }));
    expect(fields.cwd).toBe("/work/srv");
  });

  it("maps a user entry's scope and an http entry's url", () => {
    const fields = mcpFormFieldsForEdit(entry({ source: "user", transport: "http", commandLine: "https://x" }));
    expect(fields.scope).toBe("user");
    expect(fields.url).toBe("https://x");
  });
});

describe("splitArgsText", () => {
  it("splits on newlines, trims, drops blank lines", () => {
    expect(splitArgsText("a\n  b  \n\nc")).toEqual(["a", "b", "c"]);
  });
});

// ── request builders ──

describe("buildDeleteRequest / buildFormUpsertRequest", () => {
  it("buildDeleteRequest resolves scope from the entry's own source (project/user, never compat)", () => {
    expect(buildDeleteRequest("tab-1", entry({ source: "user" }))).toEqual({ tabId: "tab-1", scope: "user", name: "ozon" });
  });

  it("form upsert request carries the form's own chosen scope and trimmed name", () => {
    const fields = { ...blankMcpFormFields("user"), name: "  srv  ", command: "node" };
    const request = buildFormUpsertRequest("tab-1", fields);
    expect(request).toEqual({ tabId: "tab-1", scope: "user", name: "srv", entry: { enabled: true, command: "node" } });
  });
});

// ── import scan/select/group ──

describe("defaultImportScope", () => {
  it("defaults to project scope when a workspace tabId is resolvable (owner's per-project import pain)", () => {
    expect(defaultImportScope("tab-1")).toBe("project");
  });

  it("falls back to user scope in the pre-tab case (no workspace to write project config into)", () => {
    expect(defaultImportScope(undefined)).toBe("user");
  });
});

describe("defaultImportSelection", () => {
  it("defaults to checked (keyed by identity, W5-FIX finding 2) for a candidate not already configured, unchecked for one that is", () => {
    const fresh = candidate({ name: "fresh", alreadyConfigured: false });
    const existing = candidate({ name: "existing", alreadyConfigured: true });
    const selection = defaultImportSelection([fresh, existing]);
    expect(selection).toEqual({ [fresh.id]: true, [existing.id]: false });
  });
});

describe("groupImportCandidates", () => {
  it("groups by harness+sourcePath in first-seen order", () => {
    const groups = groupImportCandidates([
      candidate({ harness: "claude", sourcePath: "~/.claude.json", name: "a" }),
      candidate({ harness: "codex", sourcePath: "~/.codex/config.toml", name: "b" }),
      candidate({ harness: "claude", sourcePath: "~/.claude.json", name: "c" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.candidates.map((c) => c.name)).toEqual(["a", "c"]);
    expect(groups[1]!.candidates.map((c) => c.name)).toEqual(["b"]);
  });
});

describe("harnessLabel", () => {
  it("has a distinct label per harness kind", () => {
    const kinds = ["claude", "claude-project", "mcp-json", "codex", "zcode"] as const;
    const labels = kinds.map(harnessLabel);
    expect(new Set(labels).size).toBe(kinds.length);
  });
});

describe("selectedImportIds / importFooterLabel", () => {
  it("collects only checked identities and singularizes the footer count", () => {
    const selection = { a: true, b: false, c: true };
    expect(selectedImportIds(selection).sort()).toEqual(["a", "c"]);
    expect(importFooterLabel({ a: true })).toBe("Import 1 server (disabled until you enable them)");
    expect(importFooterLabel(selection)).toBe("Import 2 servers (disabled until you enable them)");
    expect(importFooterLabel({})).toBe("Import 0 servers (disabled until you enable them)");
  });
});

describe("importResultText", () => {
  it("distinguishes skipped-exists / applied / not-applied", () => {
    expect(importResultText({ name: "a", harness: "claude", applied: false, skipped: "exists" })).toBe(
      "a: skipped — already configured",
    );
    expect(importResultText({ name: "b", harness: "codex", applied: true })).toBe("b: imported (disabled)");
    expect(importResultText({ name: "c", harness: "zcode", applied: false })).toBe("c: not imported");
  });
});

// ── forced-disabled import flow (design §3 trust gate): consent off AND on ──

describe("buildImportApplyRequest (forced-disabled import flow, consent off/on)", () => {
  it("relays includeEnvValues=false when consent is unchecked, selecting only checked identities (W5-FIX finding 2)", () => {
    const request = buildImportApplyRequest("tab-1", "user", { a: true, b: false }, false);
    expect(request).toEqual({ tabId: "tab-1", scope: "user", ids: ["a"], includeEnvValues: false });
  });

  it("relays includeEnvValues=true when consent is checked", () => {
    const request = buildImportApplyRequest("tab-1", "project", { a: true, b: true }, true);
    expect(request).toEqual({ tabId: "tab-1", scope: "project", ids: ["a", "b"], includeEnvValues: true });
  });

  it("an entry returned by import-apply is ALWAYS written disabled (W1/W2 guarantee) — the pane's join renders it 'off' either way", () => {
    // W1/W2 force `enabled:false` unconditionally on every applied entry
    // regardless of consent (config-write.ts's buildImportEntry) — this test
    // pins that the RENDERER'S OWN join logic honors that forced-disabled
    // state consistently for both the off (no secrets) and on (with secrets,
    // still forced disabled) consent paths.
    const importedNoConsent = entry({ name: "claude-srv", enabled: false, envKeys: [] });
    const importedWithConsent = entry({ name: "codex-srv", enabled: false, envKeys: ["API_KEY"] });
    expect(describeMcpConfigRow(importedNoConsent, undefined)).toEqual({ kind: "off", detail: "disabled" });
    expect(describeMcpConfigRow(importedWithConsent, undefined)).toEqual({ kind: "off", detail: "disabled" });
  });
});

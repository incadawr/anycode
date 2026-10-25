/**
 * Pure-logic tests for the Plugins pane model (Taskana 4732 S1-C, design 4732
 * §6). Same `.test.ts`-only, no-jsdom rationale as McpServersPane.test.ts
 * (this package's vitest config runs `environment: "node"`) — chips, action
 * gating per tier/status, index header text, install-menu options, and the
 * consent-sheet labels are pinned at the exported-pure-function level.
 */
import { describe, expect, it } from "vitest";
import type {
  IndexEntryView,
  PluginInstallPreview,
  PluginRowView,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";
import {
  availableRowState,
  filterPluginRows,
  hasNonOfficialPlugins,
  installMenuOptions,
  installSourceForOption,
  pluginsEmptyKind,
  pluginsRefusalMessage,
  pluginCapabilitiesText,
  pluginIndexCheckedText,
  pluginIndexStatusText,
  pluginRowActions,
  pluginSourceText,
  pluginStatusChips,
  pluginTierLabel,
  rollbackLabel,
  sheetHasMcpServers,
  sheetPrimaryLabel,
} from "./plugins-pane-model.js";

function row(overrides: Partial<PluginRowView> = {}): PluginRowView {
  return {
    name: "anycode-essentials",
    displayName: "AnyCode Essentials",
    description: "Deep-research workflow and an agent profile.",
    version: "1.0.0",
    tier: "official",
    source: { kind: "official" },
    enabled: true,
    active: true,
    pinned: false,
    capabilities: ["skills", "agents", "workflows"],
    mcpServers: [],
    mcpNeedsApproval: false,
    problems: [],
    ...overrides,
  };
}

function preview(overrides: Partial<PluginInstallPreview> = {}): PluginInstallPreview {
  return {
    name: "ozon-tools",
    displayName: "Ozon Tools",
    description: "Marketplace helpers.",
    version: "0.3.1",
    tier: "third-party",
    source: { kind: "url", url: "https://example.com/ozon-tools.tgz" },
    capabilities: ["skills"],
    mcpServers: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PluginsSnapshot> = {}): PluginsSnapshot {
  return {
    plugins: [],
    available: [],
    index: { status: "ok" },
    settings: { autoUpdateOfficial: true },
    ...overrides,
  };
}

describe("pluginTierLabel", () => {
  it("labels every tier, official with a checkmark", () => {
    expect(pluginTierLabel("official")).toBe("Official ✓");
    expect(pluginTierLabel("third-party")).toBe("Third-party");
    expect(pluginTierLabel("local")).toBe("Local");
    expect(pluginTierLabel("project")).toBe("Project");
    expect(pluginTierLabel("legacy")).toBe("Legacy");
  });
});

describe("pluginSourceText", () => {
  it("describes each source kind", () => {
    expect(pluginSourceText({ kind: "official" })).toContain("signed");
    expect(pluginSourceText({ kind: "url", url: "https://x/y.tgz" })).toBe("https://x/y.tgz");
    expect(pluginSourceText({ kind: "file", fileName: "tools.tgz" })).toBe("tools.tgz");
    expect(pluginSourceText({ kind: "git", url: "https://x/y", ref: "v1" })).toContain("v1");
    expect(pluginSourceText({ kind: "local", path: "/abs/dir" })).toBe("/abs/dir");
    expect(pluginSourceText({ kind: "project" })).toContain("project");
    expect(pluginSourceText({ kind: "legacy" })).toContain("unmanaged");
  });
});

describe("pluginStatusChips", () => {
  it("is empty for a clean active official row", () => {
    expect(pluginStatusChips(row())).toEqual([]);
  });

  it("orders update, approval, incompatible, inactive, problems", () => {
    const chips = pluginStatusChips(
      row({
        updateVersion: "1.0.1",
        mcpNeedsApproval: true,
        incompatibleRange: ">=0.0.36",
        active: false,
        problems: ["a", "b"],
      }),
    );
    expect(chips.map((c) => c.text)).toEqual([
      "Update available 1.0.1",
      "Needs approval",
      "Incompatible (needs >=0.0.36)",
      "Inactive",
      "Problems (2)",
    ]);
    expect(chips.every((c) => c.tone === "warn" || c.tone === "muted")).toBe(true);
  });

  it("marks only Inactive as muted", () => {
    const chips = pluginStatusChips(row({ active: false }));
    expect(chips).toEqual([{ text: "Inactive", tone: "muted" }]);
  });
});

describe("pluginCapabilitiesText", () => {
  it("lists non-mcp capabilities", () => {
    expect(pluginCapabilitiesText(row())).toBe("skills, agents, workflows");
  });

  it("appends MCP servers with consent state", () => {
    const text = pluginCapabilitiesText(
      row({
        capabilities: ["skills", "mcp"],
        mcpServers: [
          { name: "plugin_x_a", commandLine: "node a.js", consented: true },
          { name: "plugin_x_b", commandLine: "node b.js", consented: false },
        ],
      }),
    );
    expect(text).toBe("skills · MCP plugin_x_a · MCP plugin_x_b (needs approval)");
  });
});

describe("pluginRowActions", () => {
  it("gives a clean official row only pin + remove + reveal", () => {
    expect(pluginRowActions(row())).toEqual(["pin", "remove", "reveal"]);
  });

  it("adds update when one is available, rollback while a previous exists and not pinned", () => {
    const actions = pluginRowActions(row({ updateVersion: "1.0.1", previousVersion: "0.9.0" }));
    expect(actions).toEqual(["update", "rollback", "pin", "remove", "reveal"]);
  });

  it("flips pin to unpin on a pinned row and drops rollback", () => {
    const actions = pluginRowActions(row({ pinned: true, previousVersion: "0.9.0" }));
    expect(actions).toEqual(["unpin", "remove", "reveal"]);
  });

  it("offers approve-mcp whenever consent is missing, any tier", () => {
    const actions = pluginRowActions(row({ tier: "project", mcpNeedsApproval: true }));
    expect(actions).toEqual(["approve-mcp"]);
  });

  it("gives project/legacy rows no managed actions (toggle lives in the component)", () => {
    expect(pluginRowActions(row({ tier: "project" }))).toEqual([]);
    expect(pluginRowActions(row({ tier: "legacy" }))).toEqual([]);
  });

  it("keeps reveal for local dev links", () => {
    expect(pluginRowActions(row({ tier: "local" }))).toEqual(["pin", "remove", "reveal"]);
  });
});

describe("rollbackLabel", () => {
  it("names the target version when present", () => {
    expect(rollbackLabel(row({ previousVersion: "0.9.0" }))).toBe("Rollback to 0.9.0");
    expect(rollbackLabel(row())).toBe("Rollback");
  });
});

describe("pluginIndexStatusText", () => {
  it("maps every index status", () => {
    expect(pluginIndexStatusText("ok").tone).toBe("ok");
    expect(pluginIndexStatusText("offline").text).toContain("offline");
    expect(pluginIndexStatusText("offline").tone).toBe("warn");
    expect(pluginIndexStatusText("expired").text).toContain("expired");
    expect(pluginIndexStatusText("signature_failed").text).toContain("signature");
    expect(pluginIndexStatusText("not_configured").tone).toBe("muted");
  });
});

describe("pluginIndexCheckedText", () => {
  it("states an honest never-checked", () => {
    expect(pluginIndexCheckedText(undefined)).toBe("Not checked yet");
    expect(pluginIndexCheckedText("2026-10-24T10:00:00Z")).toContain("2026-10-24T10:00:00Z");
  });
});

describe("installMenuOptions", () => {
  it("offers file/url/folder enabled and git disabled (stage 2)", () => {
    const options = installMenuOptions();
    expect(options.map((o) => o.disabled)).toEqual([false, false, false, true]);
    expect(options[0]?.source).toEqual({ kind: "file" });
    expect(options[2]?.source).toEqual({ kind: "folder" });
  });

  it("file and folder sources carry NO path (path custody)", () => {
    const file = installSourceForOption(0);
    const folder = installSourceForOption(2);
    expect(file).toEqual({ kind: "file" });
    expect(folder).toEqual({ kind: "folder" });
  });
});

describe("availableRowState", () => {
  function entry(overrides: Partial<IndexEntryView> = {}): IndexEntryView {
    return {
      name: "anycode-essentials",
      displayName: "AnyCode Essentials",
      description: "d",
      version: "1.0.0",
      capabilities: ["skills"],
      defaultInstall: false,
      ...overrides,
    };
  }

  it("enables install for a compatible entry", () => {
    expect(availableRowState(entry())).toEqual({ label: "Install", disabled: false });
  });

  it("greys out an incompatible entry with the range as the reason", () => {
    const state = availableRowState(entry({ version: undefined, incompatibleRange: ">=0.0.36" }));
    expect(state.disabled).toBe(true);
    expect(state.reason).toBe("Needs AnyCode >=0.0.36");
  });

  it("greys out an entry with no compatible version but no stated range", () => {
    const state = availableRowState(entry({ version: undefined }));
    expect(state.disabled).toBe(true);
    expect(state.reason).toContain("No compatible version");
  });
});

describe("install sheet", () => {
  it("offers the allow-MCP footer only when the preview declares servers", () => {
    expect(sheetHasMcpServers(preview())).toBe(false);
    expect(
      sheetHasMcpServers(
        preview({ mcpServers: [{ name: "plugin_x_a", commandLine: "node a.js", consented: false }] }),
      ),
    ).toBe(true);
  });

  it("labels the primary button by MCP presence and consent state", () => {
    expect(sheetPrimaryLabel(preview(), false)).toBe("Install");
    expect(
      sheetPrimaryLabel(
        preview({ mcpServers: [{ name: "plugin_x_a", commandLine: "node a.js", consented: false }] }),
        false,
      ),
    ).toBe("Install (MCP servers stay off)");
    expect(
      sheetPrimaryLabel(
        preview({ mcpServers: [{ name: "plugin_x_a", commandLine: "node a.js", consented: false }] }),
        true,
      ),
    ).toBe("Install and allow MCP servers");
  });
});

describe("pluginsRefusalMessage", () => {
  it("returns a distinct message per refusal reason", () => {
    const reasons = [
      "invalid",
      "not_found",
      "read_only_source",
      "incompatible",
      "signature",
      "integrity",
      "too_large",
      "network",
      "io_error",
    ] as const;
    const seen = new Set<string>();
    for (const reason of reasons) {
      const message = pluginsRefusalMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      seen.add(message);
    }
    expect(seen.size).toBe(reasons.length);
  });
});

describe("filterPluginRows / pluginsEmptyKind", () => {
  const rows = [
    row({ name: "alpha", displayName: "Alpha Tools", description: "first" }),
    row({ name: "beta", displayName: "Beta Kit", description: "second" }),
  ];

  it("matches on name, displayName, and description, case-insensitively", () => {
    expect(filterPluginRows(rows, "alpha")).toHaveLength(1);
    expect(filterPluginRows(rows, "BETA KIT")).toHaveLength(1);
    expect(filterPluginRows(rows, "second")).toHaveLength(1);
    expect(filterPluginRows(rows, "")).toHaveLength(2);
    expect(filterPluginRows(rows, "zzz")).toHaveLength(0);
  });

  it("classifies the empty state", () => {
    expect(pluginsEmptyKind(0, 0, "")).toBe("none");
    expect(pluginsEmptyKind(2, 0, "zzz")).toBe("no_match");
    expect(pluginsEmptyKind(2, 2, "")).toBeNull();
  });
});

describe("hasNonOfficialPlugins", () => {
  it("is false for official-only (or empty) snapshots", () => {
    expect(hasNonOfficialPlugins(snapshot())).toBe(false);
    expect(hasNonOfficialPlugins(snapshot({ plugins: [row()] }))).toBe(false);
  });

  it("is true for any third-party/local/project/legacy row", () => {
    expect(hasNonOfficialPlugins(snapshot({ plugins: [row({ tier: "third-party" })] }))).toBe(true);
    expect(hasNonOfficialPlugins(snapshot({ plugins: [row({ tier: "legacy" })] }))).toBe(true);
  });
});

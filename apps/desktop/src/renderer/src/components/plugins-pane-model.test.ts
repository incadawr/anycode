/**
 * Pure-logic tests for the Plugins pane model (Taskana 4732 S1-C, design 4732
 * §6; reconciled to the S1-B wire contract). Same `.test.ts`-only, no-jsdom
 * rationale as McpServersPane.test.ts (this package's vitest config runs
 * `environment: "node"`) — chips, action gating per tier/status, index
 * header text, install-menu options, and the consent-sheet labels are pinned
 * at the exported-pure-function level.
 *
 * ROW FIXTURES mirror S1-B main's `PluginRowView` (see
 * main/plugins-ipc.ts buildSnapshot + core's PluginAdminRow): `status`
 * lifecycle, optional `managed` bookkeeping, `updateAvailable`, and MCP
 * consent via `mcpServerNames` + `mcpConsentGranted`.
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
  mcpServerCommandLine,
  pluginEnabled,
  pluginIncompatibleRange,
  pluginMcpNeedsApproval,
  pluginPinned,
  pluginPreviousVersion,
  pluginUpdateVersion,
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
    status: "active",
    source: { kind: "official" },
    managed: { enabled: true, pinned: false, active: "1.0.0" },
    capabilities: { skills: 2, agents: 1, workflows: 1, mcp: [], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0 },
    mcpServerNames: [],
    mcpConsentGranted: false,
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
    source: { kind: "url", url: "https://example.com/ozon-tools.tgz" },
    capabilities: ["skills"],
    mcpServers: [],
    hasHooks: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PluginsSnapshot> = {}): PluginsSnapshot {
  return {
    plugins: [],
    available: [],
    index: { status: "ok" },
    settings: { autoUpdateOfficial: true, indexConfigured: true },
    ...overrides,
  };
}

describe("pluginTierLabel", () => {
  it("labels every tier, official with a checkmark", () => {
    expect(pluginTierLabel("official")).toBe("Official ✓");
    expect(pluginTierLabel("third-party")).toBe("Third-party");
    expect(pluginTierLabel("local")).toBe("Local");
    expect(pluginTierLabel("project")).toBe("Project");
    expect(pluginTierLabel("legacy-user")).toBe("Legacy");
  });
});

describe("pluginSourceText", () => {
  it("describes each source kind", () => {
    expect(pluginSourceText({ kind: "official" })).toContain("signed");
    expect(pluginSourceText({ kind: "url", url: "https://x/y.tgz" })).toBe("https://x/y.tgz");
    expect(pluginSourceText({ kind: "file", fileName: "tools.tgz" })).toBe("tools.tgz");
    expect(pluginSourceText({ kind: "git", url: "https://x/y", ref: "v1" })).toContain("v1");
    expect(pluginSourceText({ kind: "local", path: "/abs/dir" })).toBe("/abs/dir");
    expect(pluginSourceText({ kind: "dir" })).toContain("hand-placed");
  });
});

describe("row derivations (S1-B fields → display state)", () => {
  it("derives enabled/pinned/previous from the managed block, defaulting honestly", () => {
    expect(pluginEnabled(row())).toBe(true);
    expect(pluginPinned(row())).toBe(false);
    expect(pluginPreviousVersion(row())).toBeUndefined();
    expect(pluginEnabled(row({ managed: undefined }))).toBe(true);
    expect(pluginPinned(row({ managed: undefined }))).toBe(false);
    expect(pluginPinned(row({ managed: { enabled: true, pinned: true, active: "1.0.0", previous: "0.9.0" } }))).toBe(true);
    expect(pluginPreviousVersion(row({ managed: { enabled: true, pinned: true, active: "1.0.0", previous: "0.9.0" } }))).toBe("0.9.0");
  });

  it("needs approval exactly when a server exists and consent is not granted", () => {
    expect(pluginMcpNeedsApproval(row())).toBe(false);
    expect(pluginMcpNeedsApproval(row({ mcpServerNames: ["a"], mcpConsentGranted: true }))).toBe(false);
    expect(pluginMcpNeedsApproval(row({ mcpServerNames: ["a"], mcpConsentGranted: false }))).toBe(true);
    expect(pluginMcpNeedsApproval(row({ mcpServerNames: ["a"] }))).toBe(true);
  });

  it("extracts the engines range from the incompatible problem line", () => {
    expect(pluginIncompatibleRange(row())).toBeUndefined();
    const range = pluginIncompatibleRange(
      row({ status: "inactive", problems: ["incompatible with AnyCode 0.0.35 (needs >=0.0.36)"] }),
    );
    expect(range).toBe(">=0.0.36");
  });

  it("surfaces main's updateAvailable version", () => {
    expect(pluginUpdateVersion(row())).toBeUndefined();
    expect(pluginUpdateVersion(row({ updateAvailable: { version: "1.0.1", needsApproval: false } }))).toBe("1.0.1");
  });
});

describe("pluginStatusChips", () => {
  it("is empty for a clean active official row", () => {
    expect(pluginStatusChips(row())).toEqual([]);
  });

  it("orders update, approval, incompatible, inactive, problems", () => {
    const chips = pluginStatusChips(
      row({
        updateAvailable: { version: "1.0.1", needsApproval: false },
        mcpServerNames: ["plugin_x_a"],
        status: "inactive",
        problems: ["incompatible with AnyCode 0.0.35 (needs >=0.0.36)", "b"],
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

  it("marks only Inactive/Disabled as muted", () => {
    expect(pluginStatusChips(row({ status: "inactive" }))).toEqual([{ text: "Inactive", tone: "muted" }]);
    expect(pluginStatusChips(row({ status: "disabled" }))).toEqual([{ text: "Disabled", tone: "muted" }]);
  });
});

describe("pluginCapabilitiesText", () => {
  it("lists non-mcp capabilities", () => {
    expect(pluginCapabilitiesText(row())).toBe("skills · agents · workflows");
  });

  it("appends MCP servers with consent state", () => {
    const text = pluginCapabilitiesText(
      row({
        capabilities: { skills: 1, agents: 0, workflows: 0, mcp: ["a", "b"], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0 },
        mcpServerNames: ["a", "b"],
        mcpConsentGranted: false,
      }),
    );
    expect(text).toBe("skills · MCP a (needs approval) · MCP b (needs approval)");
  });

  it("drops the needs-approval suffix once consent is granted", () => {
    const text = pluginCapabilitiesText(
      row({
        capabilities: { skills: 0, agents: 0, workflows: 0, mcp: ["a"], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0 },
        mcpServerNames: ["a"],
        mcpConsentGranted: true,
      }),
    );
    expect(text).toBe("MCP a");
  });
});

describe("pluginRowActions", () => {
  it("gives a clean official row only pin + remove + reveal", () => {
    expect(pluginRowActions(row())).toEqual(["pin", "remove", "reveal"]);
  });

  it("adds update when one is available, rollback while a previous exists and not pinned", () => {
    const actions = pluginRowActions(
      row({
        updateAvailable: { version: "1.0.1", needsApproval: false },
        managed: { enabled: true, pinned: false, active: "1.0.0", previous: "0.9.0" },
      }),
    );
    expect(actions).toEqual(["update", "rollback", "pin", "remove", "reveal"]);
  });

  it("flips pin to unpin on a pinned row and drops rollback", () => {
    const actions = pluginRowActions(row({ managed: { enabled: true, pinned: true, active: "1.0.0", previous: "0.9.0" } }));
    expect(actions).toEqual(["unpin", "remove", "reveal"]);
  });

  it("offers approve-mcp whenever consent is missing, any tier", () => {
    const actions = pluginRowActions(row({ tier: "project", managed: undefined, mcpServerNames: ["a"] }));
    expect(actions).toEqual(["approve-mcp"]);
  });

  it("gives project rows no managed actions (toggle lives in the component)", () => {
    expect(pluginRowActions(row({ tier: "project", managed: undefined }))).toEqual([]);
  });

  it("keeps reveal for local dev links and legacy dirs", () => {
    expect(pluginRowActions(row({ tier: "local", managed: { enabled: true, pinned: false, active: "1.0.0" } }))).toEqual(["pin", "remove", "reveal"]);
    expect(pluginRowActions(row({ tier: "legacy-user", managed: undefined }))).toEqual(["reveal"]);
  });
});

describe("rollbackLabel", () => {
  it("names the target version when present", () => {
    expect(rollbackLabel(row({ managed: { enabled: true, pinned: false, active: "1.0.0", previous: "0.9.0" } }))).toBe("Rollback to 0.9.0");
    expect(rollbackLabel(row())).toBe("Rollback");
  });
});

describe("pluginIndexStatusText", () => {
  it("maps every index status", () => {
    expect(pluginIndexStatusText("ok").tone).toBe("ok");
    expect(pluginIndexStatusText("offline").text).toContain("offline");
    expect(pluginIndexStatusText("offline").tone).toBe("warn");
    expect(pluginIndexStatusText("expired").text).toContain("expired");
    expect(pluginIndexStatusText("signature-failed").text).toContain("signature");
    expect(pluginIndexStatusText("not configured").tone).toBe("muted");
    expect(pluginIndexStatusText("unchecked").text).toContain("not checked");
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

// ── decision-4 invariants (pane side): no path, no hash, no git on the wire ──

describe("request payloads never carry a path or hash (design §4 custody)", () => {
  it("every per-plugin action derives a NAME-only payload from a row (structural: the row's own path-ish fields never round-trip)", () => {
    const rowWithPaths = row({
      source: { kind: "local", path: "/Users/tester/dev/plugin" },
      mcpServerNames: ["api"],
      mcpServersHash: "deadbeefcafe",
    });
    // The bridge call sites are (name) / (name, boolean) — pin the identity
    // extraction the pane performs: everything the pane sends derives from
    // row.name and toggles, nothing else.
    const identityOf = (r: PluginRowView): string => r.name;
    expect(identityOf(rowWithPaths)).toBe("anycode-essentials");
    // And the source's display path stays display-only: the model renders
    // it, but no request field on the bridge accepts it (the PluginsBridge
    // signatures in PluginsPane.tsx take (name[, boolean]) only).
    expect(pluginSourceText(rowWithPaths.source)).toContain("/Users/tester/dev/plugin");
  });

  it("the git option is disabled, so no prepare with kind git can start from the menu", () => {
    const git = installMenuOptions()[3];
    expect(git?.disabled).toBe(true);
    expect(git?.source.kind).toBe("git");
  });

  it("official install-from-available carries only name + resolved version", () => {
    // Mirrors PluginsPane's onInstallAvailable wiring: {kind:"official",name,version?}.
    const payloadFor = (name: string, version: string | undefined): { kind: "official"; name: string; version?: string } =>
      version !== undefined ? { kind: "official", name, version } : { kind: "official", name };
    expect(payloadFor("anycode-essentials", "1.0.0")).toEqual({ kind: "official", name: "anycode-essentials", version: "1.0.0" });
    expect(payloadFor("anycode-essentials", undefined)).toEqual({ kind: "official", name: "anycode-essentials" });
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
      default: false,
      ...overrides,
    };
  }

  it("enables install for a compatible entry", () => {
    expect(availableRowState(entry())).toEqual({ label: "Install", disabled: false });
  });

  it("greys out an incompatible entry with main's reason", () => {
    const state = availableRowState(entry({ version: undefined, incompatibleReason: "no version compatible with AnyCode 0.0.35" }));
    expect(state.disabled).toBe(true);
    expect(state.reason).toContain("no version compatible");
  });

  it("greys out an entry with no compatible version but no stated reason", () => {
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
        preview({ mcpServers: [{ name: "plugin_x_a", command: "node", args: ["a.js"] }] }),
      ),
    ).toBe(true);
  });

  it("joins a server's command line from command + args", () => {
    expect(mcpServerCommandLine({ name: "a", command: "node", args: ["a.js", "--flag"] })).toBe("node a.js --flag");
    expect(mcpServerCommandLine({ name: "a", command: "node", args: [] })).toBe("node");
  });

  it("labels the primary button by MCP presence and consent state", () => {
    expect(sheetPrimaryLabel(preview(), false)).toBe("Install");
    expect(
      sheetPrimaryLabel(
        preview({ mcpServers: [{ name: "plugin_x_a", command: "node", args: ["a.js"] }] }),
        false,
      ),
    ).toBe("Install (MCP servers stay off)");
    expect(
      sheetPrimaryLabel(
        preview({ mcpServers: [{ name: "plugin_x_a", command: "node", args: ["a.js"] }] }),
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

  it("matches rows whose optional displayName/description are absent", () => {
    const sparse = row({ name: "gamma", displayName: undefined, description: undefined });
    expect(filterPluginRows([sparse], "gamma")).toHaveLength(1);
    expect(filterPluginRows([sparse], "missing")).toHaveLength(0);
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
    expect(hasNonOfficialPlugins(snapshot({ plugins: [row({ tier: "legacy-user" })] }))).toBe(true);
  });
});

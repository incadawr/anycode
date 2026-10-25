/**
 * Pure-logic tests for the PluginsPane + PluginInstallSheet wiring (Taskana
 * 4732 S1-C). Same no-jsdom rationale as McpServersPane.test.ts: this
 * package's vitest config runs `environment: "node"`, so hook-bearing
 * components can't mount — instead the pane's hook-FREE presentational
 * pieces (`PluginsUnavailableCard`, `PluginsPaneBody`, `InstallDialogBody`)
 * and the pure guards are called directly and their React element trees are
 * inspected. Host/fragment elements are walked depth-first and their text
 * collected; COMPONENT elements are INVOKED once (they are hook-free by
 * construction) so a card's own subtree is asserted too — the direct-call
 * idiom SettingsScreen.test.ts's walk/mountUnit already established.
 */
import { Fragment, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type {
  PluginInstallPreview,
  PluginRowView,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";
import { isPluginsServiceUnavailable, PluginsPaneBody, PluginsUnavailableCard } from "./PluginsPane.js";
import { describeSourceForSheet, InstallDialogBody } from "./PluginInstallSheet.js";
import { filterPluginRows, pluginsEmptyKind } from "./plugins-pane-model.js";

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is AnyElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/**
 * Renders an element tree to a flat string of its text content + a few
 * attribute values the assertions need (className, data-* flags). Component
 * elements are invoked (they must be hook-free), fragments/host elements
 * walked — one level of laziness each, same contract as the source walk in
 * SettingsScreen.test.ts.
 */
function renderToString(root: unknown): string {
  const parts: string[] = [];
  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      if (typeof node === "string") {
        parts.push(node);
      }
      return;
    }
    if (!isElement(node)) {
      return;
    }
    const { type, props } = node;
    if (props.className !== undefined) {
      parts.push(String(props.className));
    }
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith("data-") && value !== undefined) {
        parts.push(`${key}=${String(value)}`);
      }
    }
    if (typeof type === "function") {
      // Hook-free component: invoke it and walk the returned tree.
      const rendered = (type as (p: Record<string, unknown>) => unknown)(props);
      visit(rendered);
      return;
    }
    if (type === Fragment || typeof type === "string") {
      visit(props.children);
    }
  }
  visit(root);
  return parts.join(" ");
}

/** Calls a hook-free component and flattens its element tree to a string. */
function call(component: () => ReactElement): string {
  return renderToString(component());
}

function snapshot(overrides: Partial<PluginsSnapshot> = {}): PluginsSnapshot {
  return {
    plugins: [],
    available: [],
    index: { status: "ok", checkedAt: "2026-10-24T10:00:00Z", serial: 42 },
    settings: { autoUpdateOfficial: true, indexConfigured: true },
    ...overrides,
  };
}

function preview(overrides: Partial<PluginInstallPreview> = {}): PluginInstallPreview {
  return {
    name: "ozon-tools",
    displayName: "Ozon Tools",
    description: "Marketplace helpers.",
    version: "0.3.1",
    source: { kind: "url", url: "https://example.com/ozon-tools-0.3.1.tgz" },
    capabilities: ["skills"],
    mcpServers: [],
    hasHooks: false,
    ...overrides,
  };
}

function installedRow(overrides: Partial<PluginRowView> = {}): PluginRowView {
  return {
    name: "anycode-essentials",
    displayName: "AnyCode Essentials",
    description: "Deep-research workflow and an agent profile.",
    version: "1.0.0",
    tier: "official",
    status: "active",
    source: { kind: "official" },
    managed: { enabled: true, pinned: false, active: "1.0.0" },
    capabilities: { skills: 1, agents: 0, workflows: 1, mcp: [], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0 },
    mcpServerNames: [],
    mcpConsentGranted: false,
    problems: [],
    ...overrides,
  };
}

/** The body props a pane would compute for a snapshot — model helpers wired exactly as the component does. */
function bodyPropsFor(snap: PluginsSnapshot, overrides: Partial<Parameters<typeof PluginsPaneBody>[0]> = {}) {
  const rows = filterPluginRows(snap.plugins, "");
  return {
    snapshot: snap,
    rows,
    emptyKind: pluginsEmptyKind(snap.plugins.length, rows.length, ""),
    busyName: null,
    onToggle: () => {},
    onUpdate: () => {},
    onRollback: () => {},
    onPin: () => {},
    onRemove: () => {},
    onApproveMcp: () => {},
    onReveal: () => {},
    onInstallAvailable: () => {},
    ...overrides,
  };
}

describe("isPluginsServiceUnavailable", () => {
  it("is true only for the explicit rejection state or a null snapshot after loading", () => {
    expect(isPluginsServiceUnavailable("loading", null)).toBe(false);
    expect(isPluginsServiceUnavailable("ready", snapshot())).toBe(false);
    expect(isPluginsServiceUnavailable("unavailable", snapshot())).toBe(true);
    expect(isPluginsServiceUnavailable("ready", null)).toBe(true);
  });
});

describe("PluginsUnavailableCard", () => {
  it("renders the honest degraded state, naming the legacy dirs that keep working", () => {
    const html = call(PluginsUnavailableCard);
    expect(html).toContain("Plugins service unavailable");
    expect(html).toContain("~/.anycode/plugins");
    expect(html).toContain("data-plugins-state=unavailable");
  });
});

describe("PluginsPaneBody", () => {
  it("renders installed cards with tier badge, version, source, and the trust reminder for non-official rows", () => {
    const snap = snapshot({
      plugins: [
        installedRow(),
        installedRow({ name: "ozon-tools", displayName: "Ozon Tools", tier: "third-party", source: { kind: "url", url: "https://x/y.tgz" }, mcpServerNames: ["plugin_ozon-tools_api"], mcpConsentGranted: false }),
      ],
    });
    const html = call(() => PluginsPaneBody(bodyPropsFor(snap)));
    expect(html).toContain("AnyCode Essentials");
    expect(html).toContain("Official ✓");
    expect(html).toContain("Third-party");
    expect(html).toContain("Needs approval");
    expect(html).toContain("Approve MCP");
    expect(html).toContain("https://x/y.tgz");
    // The consent reminder only appears when a non-official plugin exists.
    expect(html).toContain("at your own risk");
  });

  it("renders no trust reminder for an official-only snapshot", () => {
    const snap = snapshot({ plugins: [installedRow()] });
    expect(call(() => PluginsPaneBody(bodyPropsFor(snap)))).not.toContain("at your own risk");
  });

  it("renders available entries with Install, greyed-with-reason when incompatible", () => {
    const snap = snapshot({
      available: [
        {
          name: "anycode-essentials",
          displayName: "AnyCode Essentials",
          description: "d",
          version: "1.0.0",
          capabilities: ["skills"],
          default: false,
        },
        {
          name: "future-tools",
          displayName: "Future Tools",
          description: "d",
          version: undefined,
          incompatibleReason: "no version compatible with AnyCode 0.0.35 (needs >=0.0.40)",
          capabilities: ["skills"],
          default: false,
        },
      ],
    });
    const html = call(() => PluginsPaneBody(bodyPropsFor(snap)));
    expect(html).toContain("Available from AnyCode");
    expect(html).toContain("Install");
    expect(html).toContain("no version compatible with AnyCode 0.0.35 (needs >=0.0.40)");
  });

  it("renders the empty state for a plugin-free snapshot", () => {
    expect(call(() => PluginsPaneBody(bodyPropsFor(snapshot())))).toContain("No plugins installed yet.");
  });

  it("renders problems rows per plugin (fail-soft discovery surfaced)", () => {
    const snap = snapshot({
      plugins: [installedRow({ problems: ['Plugin "x" skills entry "../esc" escapes the plugin root — dropped'] })],
    });
    expect(call(() => PluginsPaneBody(bodyPropsFor(snap)))).toContain("escapes the plugin root");
  });

  it("renders disabled rows as disabled (data flag for the row state)", () => {
    const snap = snapshot({ plugins: [installedRow({ managed: { enabled: false, pinned: false, active: "1.0.0" } })] });
    expect(call(() => PluginsPaneBody(bodyPropsFor(snap)))).toContain("data-plugin-enabled=false");
  });
});

describe("InstallDialogBody (element-level)", () => {
  const dialogBase = {
    urlValue: "",
    allowMcp: false,
    onUrlValueChange: () => {},
    onAllowMcpChange: () => {},
    onPickSource: () => {},
    onSubmitUrl: () => {},
    onCommit: () => {},
    onClose: () => {},
  } as const;

  it("renders the source menu with file/url/folder and git disabled (stage 2)", () => {
    const html = call(() => InstallDialogBody({ ...dialogBase, stage: { phase: "source" } }));
    expect(html).toContain("From file (.tgz)…");
    expect(html).toContain("From folder (dev link)…");
    expect(html).toContain("From git (coming soon)");
  });

  it("disables the URL Prepare button until an https URL is typed", () => {
    const http = call(() => InstallDialogBody({ ...dialogBase, stage: { phase: "source" }, urlValue: "http://x/y.tgz" }));
    const https = call(() => InstallDialogBody({ ...dialogBase, stage: { phase: "source" }, urlValue: "https://x/y.tgz" }));
    expect(http).toContain("data-plugins-url-prepare-disabled=true");
    expect(https).toContain("data-plugins-url-prepare-disabled=false");
  });

  it("renders the confirm sheet's MCP consent rows and the consent checkbox", () => {
    const html = call(() =>
      InstallDialogBody({
        ...dialogBase,
        stage: {
          phase: "confirm",
          source: { kind: "url", url: "https://x/y.tgz" },
          preview: preview({
            mcpServers: [{ name: "plugin_ozon-tools_api", command: "node", args: ["api.js", "--flag"] }],
          }),
          token: "tok-1",
        },
      }),
    );
    expect(html).toContain("plugin_ozon-tools_api");
    expect(html).toContain("node api.js --flag");
    expect(html).toContain("Allow this plugin's MCP servers to start");
    expect(html).toContain("Install (MCP servers stay off)");
  });

  it("renders the sha256 prefix and engines range on the confirm sheet", () => {
    const html = call(() =>
      InstallDialogBody({
        ...dialogBase,
        stage: {
          phase: "confirm",
          source: { kind: "official", name: "x" },
          preview: preview({ sha256Prefix: "abc123def456", engines: ">=0.0.35", source: { kind: "url", url: "https://x/y.tgz" } }),
          token: "tok-1",
        },
      }),
    );
    expect(html).toContain("abc123def456");
    expect(html).toContain("Requires AnyCode");
  });

  it("renders the prepare spinner stage", () => {
    expect(
      call(() => InstallDialogBody({ ...dialogBase, stage: { phase: "prepare", source: { kind: "file" }, preview: null } })),
    ).toContain("Preparing");
  });

  it("renders the error stage's message", () => {
    expect(
      call(() =>
        InstallDialogBody({
          ...dialogBase,
          stage: { phase: "error", source: { kind: "url", url: "https://x/y.tgz" }, error: "The download didn't match its checksum — nothing was installed." },
        }),
      ),
    ).toContain("didn't match its checksum");
  });

  it("omits the consent checkbox when the preview declares no MCP servers", () => {
    const html = call(() =>
      InstallDialogBody({
        ...dialogBase,
        stage: { phase: "confirm", source: { kind: "url", url: "https://x/y.tgz" }, preview: preview(), token: "tok-1" },
      }),
    );
    expect(html).not.toContain("Allow this plugin's MCP servers to start");
    expect(html).toContain("This plugin declares no MCP servers.");
  });
});

describe("describeSourceForSheet", () => {
  it("names official installs as the signed index", () => {
    expect(describeSourceForSheet({ kind: "official", name: "x" }, preview())).toContain("signed");
  });

  it("carries the preview's resolved url/file provenance", () => {
    expect(
      describeSourceForSheet({ kind: "url", url: "u" }, preview({ source: { kind: "url", url: "https://x/y.tgz" } })),
    ).toBe("https://x/y.tgz");
    expect(describeSourceForSheet({ kind: "file" }, preview({ source: { kind: "file" } }))).toBe("local archive file");
    expect(describeSourceForSheet({ kind: "folder" }, preview({ source: { kind: "folder" } }))).toBe("linked folder (dev)");
  });
});

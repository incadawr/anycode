// @vitest-environment jsdom
/**
 * Plugins settings wiring: mount the presentational pieces with React so
 * kit hooks and native event handlers run normally. Assertions cover the
 * same text, state, and bridge callbacks as the original tree-walking tests.
 */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginInstallPreview,
  PluginRowView,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";
import { isPluginsServiceUnavailable, PluginsPaneBody, PluginsUnavailableCard } from "./PluginsPane.js";
import { describeSourceForSheet, InstallDialogBody } from "./PluginInstallSheet.js";
import { filterPluginRows, pluginsEmptyKind } from "./plugins-pane-model.js";

type AnyElement = { type: unknown; props: Record<string, unknown> };

const roots: ReturnType<typeof createRoot>[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });

function renderElements(element: unknown): AnyElement[] {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element as ReactElement));
  return [...container.querySelectorAll<HTMLElement>("*")].map(node => ({
    type: node.tagName.toLowerCase(),
    props: {
      ...Object.fromEntries([...node.attributes].map(attribute => [attribute.name, attribute.name === "aria-checked" ? attribute.value === "true" : attribute.value])),
      className: node.className,
      children: node.textContent,
      onClick: () => act(() => node.click()),
    },
  }));
}

function renderToString(root: unknown): string {
  if (typeof root === "string" || typeof root === "number") return String(root);
  return renderElements(root).map(({ props }) => [props.children, props.className,
    ...Object.entries(props).filter(([key]) => key.startsWith("data-")).map(([key, value]) => `${key}=${value}`),
  ].join(" ")).join(" ");
}

/** Mounts the body produced by the pane and collects text and state attributes. */
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
    disabled: false,
    source: { kind: "official" },
    managed: { enabled: true, pinned: false, active: "1.0.0" },
    capabilities: { skills: 1, agents: 0, workflows: 1, mcp: [], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0, services: [] },
    mcpServerNames: [],
    serviceNames: [],
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
    onApproveServices: () => {},
    services: [],
    sessionsState: "off" as const,
    openLogKey: null,
    logLines: {},
    onRestartService: () => {},
    onToggleLog: () => {},
    onCopyLog: () => {},
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

  it.each(["legacy-user", "official", "project"] as const)("renders a disabled %s plugin OFF and clicking enables it", (tier) => {
    const legacy = installedRow({
      name: "disabled-tool", tier,
      managed: tier === "official" ? { enabled: true, pinned: false, active: "1.0.0" } : undefined,
      status: "disabled", disabled: true,
    });
    const bridge = { setEnabled: vi.fn() };
    const body = PluginsPaneBody(bodyPropsFor(snapshot({ plugins: [legacy] }), { onToggle: bridge.setEnabled }));
    expect(renderToString(body)).toContain("data-plugin-enabled=false");
    const switches = findElements(body, (el) => el.type === "button" && el.props.role === "switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]!.props["aria-checked"]).toBe(false);
    (switches[0]!.props.onClick as () => void)();
    expect(bridge.setEnabled).toHaveBeenCalledWith("disabled-tool", true);
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
    allowServices: false,
    onUrlValueChange: () => {},
    onAllowMcpChange: () => {},
    onAllowServicesChange: () => {},
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

// ── background services in the pane ──

function findElements(root: unknown, predicate: (el: AnyElement) => boolean): AnyElement[] {
  return renderElements(root).filter(predicate);
}

function serviceRow(overrides: Partial<PluginRowView> = {}): PluginRowView {
  return installedRow({
    name: "bridge",
    displayName: "Bridge",
    tier: "third-party",
    managed: { enabled: true, pinned: false, active: "1.0.0" },
    serviceNames: ["relay"],
    servicesConsentGranted: true,
    ...overrides,
  });
}

describe("PluginsPaneBody — background services", () => {
  it("needs approval shows Approve services and the chip", () => {
    const snap = snapshot({ plugins: [serviceRow({ servicesConsentGranted: false })] });
    const html = call(() => PluginsPaneBody(bodyPropsFor(snap)));
    expect(html).toContain("Approve services");
    expect(html).toContain("Services need approval");
  });

  it("a granted service row shows no Approve services button", () => {
    const snap = snapshot({ plugins: [serviceRow()] });
    const html = call(() => PluginsPaneBody(bodyPropsFor(snap)));
    expect(html).not.toContain("Approve services");
  });

  it("Sessions API hint only when the API is off (and the plugin has services)", () => {
    const snap = snapshot({ plugins: [serviceRow()] });
    const off = call(() => PluginsPaneBody(bodyPropsFor(snap, { sessionsState: "off" })));
    const listening = call(() => PluginsPaneBody(bodyPropsFor(snap, { sessionsState: "listening" })));
    const errored = call(() => PluginsPaneBody(bodyPropsFor(snap, { sessionsState: "error" })));
    expect(off).toContain("Sessions API is off");
    expect(errored).toContain("Sessions API is off");
    expect(listening).not.toContain("Sessions API is off");
  });

  it("a service state chip renders per state and the restart button calls back with only {plugin,name}", () => {
    const snap = snapshot({ plugins: [serviceRow()] });
    const restarts: [string, string][] = [];
    const running = call(() =>
      PluginsPaneBody(
        bodyPropsFor(snap, {
          services: [{ plugin: "bridge", name: "relay", state: "running", restarts: 0 }],
          onRestartService: (plugin: string, name: string) => restarts.push([plugin, name]),
        }),
      ),
    );
    expect(running).toContain("Running");
    const backoff = call(() =>
      PluginsPaneBody(bodyPropsFor(snap, { services: [{ plugin: "bridge", name: "relay", state: "backoff", restartInSec: 4, restarts: 1 }] })),
    );
    expect(backoff).toContain("Restarting in 4s");
    const crash = call(() => PluginsPaneBody(bodyPropsFor(snap, { services: [{ plugin: "bridge", name: "relay", state: "crash_loop", restarts: 5 }] })));
    expect(crash).toContain("Crash loop");
    const untrusted = call(() =>
      PluginsPaneBody(bodyPropsFor(snap, { services: [{ plugin: "bridge", name: "relay", state: "blocked", reason: "untrusted", restarts: 0 }] })),
    );
    expect(untrusted).toContain("Blocked: untrusted folder");

    const restartButton = findElements(
      PluginsPaneBody(bodyPropsFor(snap, { services: [], onRestartService: (plugin: string, name: string) => restarts.push([plugin, name]) })),
      (el) => el.type === "button" && el.props.onClick !== undefined && renderToString(el.props.children) === "Restart",
    );
    expect(restartButton.length).toBeGreaterThan(0);
    (restartButton[0]!.props.onClick as () => void)();
    expect(restarts).toEqual([["bridge", "relay"]]);
  });

  it("log rendered as text (no HTML injection)", () => {
    const snap = snapshot({ plugins: [serviceRow()] });
    const hostile = '<img src=x onerror="alert(1)">';
    const body = () => PluginsPaneBody(bodyPropsFor(snap, { openLogKey: "bridge/relay", logLines: { "bridge/relay": [hostile] } }));
    const html = call(body);
    // The hostile line is a plain text child of a <pre>, never raw markup.
    const pres = findElements(body(), (el) => el.type === "pre");
    expect(pres).toHaveLength(1);
    expect(pres[0]!.props.dangerouslySetInnerHTML).toBeUndefined();
    expect(pres[0]!.props.children).toBe(hostile);
    expect(html).toContain(hostile);
  });
});

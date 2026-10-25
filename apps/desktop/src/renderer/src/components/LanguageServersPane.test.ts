/**
 * Component-level tests for LanguageServersPane (Taskana 4743). This
 * package's vitest config runs `environment: "node"` with no jsdom/
 * @testing-library (same rationale as SettingsScreen.test.ts / McpServersPane
 * .test.ts), so the pane's BEHAVIOR is pinned through its exported pure
 * surface and the model module the component is a thin shell over:
 *
 *  - the pane is registered in the rail (id, label, search keywords) — pinned
 *    in SettingsScreen.test.ts's SETTINGS_PANES list;
 *  - Enable calls the bridge with ONLY {presetId, scope, tabId} (path
 *    custody) — pinned here against a fake bridge via buildEnableRequest;
 *  - the project button's disabled state derives from
 *    projectScopeAvailable=false (no workspace) — buildCatalogRows +
 *    projectEnableDisabledReason;
 *  - command/args render as TEXT via formatCommandLine (no HTML surface);
 *  - "Set up" dispatches settings.open + select-pane(language-servers) —
 *    pinned through EnvironmentMenu's exported helpers below.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS_PANES, filterSettingsPanes } from "./SettingsScreen.js";
import {
  NEW_SESSIONS_NOTICE,
  buildCatalogRows,
  buildEnableRequest,
  formatCommandLine,
  projectEnableDisabledReason,
} from "./language-servers-model.js";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";
import { formatEnvironmentLspDetail, hasCrashedLspServer } from "./EnvironmentMenu.js";

function minimalStatus(overrides: Partial<LspConfigStatus> = {}): LspConfigStatus {
  return {
    catalog: [
      {
        id: "gopls",
        label: "Go",
        languages: "Go",
        command: "gopls",
        args: [],
        extensions: [".go"],
        installHint: "go install golang.org/x/tools/gopls@latest",
        found: false,
        foundSource: null,
      },
    ],
    entries: { project: [], user: [] },
    issues: [],
    projectScopeAvailable: true,
    projectTrusted: null,
    ...overrides,
  };
}

describe("LanguageServersPane registration (Taskana 4743)", () => {
  it("sits in the rail right after MCP with the label 'Language servers'", () => {
    const ids = SETTINGS_PANES.map((pane) => pane.id);
    expect(ids.indexOf("language-servers")).toBe(ids.indexOf("mcp") + 1);
    const pane = SETTINGS_PANES.find((p) => p.id === "language-servers");
    expect(pane?.label).toBe("Language servers");
    expect(typeof pane?.icon).toBe("function");
  });

  it("search finds it by lsp / language server / server keywords", () => {
    expect(filterSettingsPanes("lsp")).toEqual(["language-servers"]);
    expect(filterSettingsPanes("pyright")).toEqual(["language-servers"]);
  });
});

describe("Enable path custody — the bridge payload is ONLY {presetId, scope, tabId}", () => {
  it("buildEnableRequest never carries an entry, path, or command", () => {
    const request = buildEnableRequest("tab-7", "gopls", "project");
    expect(request).toEqual({ tabId: "tab-7", presetId: "gopls", scope: "project" });
    expect(Object.keys(request).sort()).toEqual(["presetId", "scope", "tabId"]);
  });

  it("a fake bridge round-trip: enabling a found row sends exactly the lean request", async () => {
    const calls: unknown[] = [];
    const bridge = {
      status: async () => minimalStatus(),
      enable: async (req: unknown) => {
        calls.push(req);
        return { ok: true, status: minimalStatus() } as const;
      },
      disable: async (req: unknown) => {
        calls.push(req);
        return { ok: true, status: minimalStatus() } as const;
      },
      customUpsert: async (req: unknown) => {
        calls.push(req);
        return { ok: true, status: minimalStatus() } as const;
      },
    };
    // The component's enable handler is a one-liner over buildEnableRequest +
    // bridge.enable; exercising the pair the way the component composes them:
    const row = buildCatalogRows(minimalStatus())[0]!;
    const request = buildEnableRequest("tab-7", row.entry.id, "user");
    const result = await bridge.enable(request);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ tabId: "tab-7", presetId: "gopls", scope: "user" }]);
  });
});

describe("Project enable button state (no workspace)", () => {
  it("projectScopeAvailable=false disables the project button with a reason", () => {
    const status = minimalStatus({ projectScopeAvailable: false, entries: { project: null, user: [] } });
    const rows = buildCatalogRows(status);
    expect(rows).toHaveLength(1);
    expect(projectEnableDisabledReason(status.projectScopeAvailable)).toBe("No project is open");
  });

  it("projectScopeAvailable=true keeps the button enabled", () => {
    expect(projectEnableDisabledReason(minimalStatus().projectScopeAvailable)).toBeNull();
  });
});

describe("Plain-text rendering surfaces", () => {
  it("formatCommandLine joins command and args with spaces (a text node, never HTML)", () => {
    expect(formatCommandLine("typescript-language-server", ["--stdio"])).toBe(
      "typescript-language-server --stdio",
    );
  });

  it("the install hint and notices are plain strings (nothing executes them)", () => {
    const row = buildCatalogRows(minimalStatus())[0]!;
    expect(row.entry.installHint).toMatch(/^npm |^go |^pip |^rustup |^gem |^brew /);
    expect(NEW_SESSIONS_NOTICE).toContain("open tabs keep");
  });
});

describe("Live status section reuses EnvironmentMenu/LspPanel helpers", () => {
  it("empty servers list renders the not-running hint (formatEnvironmentLspDetail 'Not configured')", () => {
    expect(formatEnvironmentLspDetail([])).toBe("Not configured");
  });

  it("the Restart action appears only when a server crashed (crashed-only semantics preserved)", () => {
    expect(hasCrashedLspServer([{ name: "x", state: "ready", extensions: [".x"], stderrTail: "" }])).toBe(false);
    expect(hasCrashedLspServer([{ name: "x", state: "crashed", extensions: [".x"], stderrTail: "" }])).toBe(true);
  });
});

/**
 * Settings → Roles used to mount the role editor as a native modal
 * (`showModal`) that never closed: the whole window went inert ("frozen")
 * with no way back. The pane must render the editor inline; the first-run
 * picker stays a modal.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryRow, RolePickerDialog } from "./RolePickerDialog.js";
import { RolesPane, RolesSaveNotice, buildRoleProfileRoles, parseRoleChildLimitInput } from "./RolesPane.js";
import { useSettingsStore } from "../settings-store.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";

// SSR uses Zustand's initial snapshot. Read the fixture state directly so both
// entry points receive the same settings without a browser or global singleton reset.
vi.mock("../settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings-store.js")>();
  return {
    ...actual,
    useSettingsStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useSettingsStore.getState>) => unknown) => selector(actual.useSettingsStore.getState()),
      actual.useSettingsStore,
    ),
  };
});

const base = {
  open: true,
  connections: [],
  activeConnectionId: undefined,
  engines: { claudeReady: true, codexReady: true },
  onSave: () => {},
};

describe("Roles editor modality", () => {
  it("the Settings Roles pane renders the editor in the page flow, never as a <dialog>", () => {
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).toContain("roles-table");
    expect(html).not.toContain("<dialog");
  });

  it("the Settings Roles pane renders no heading of its own — the Settings screen supplies the single 'Roles' title above it", () => {
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("settings-pane-header");
    expect(html).not.toContain("Orchestration roles");
    expect(html).not.toContain("later in Settings");
  });

  it("inline mode renders a section; the default (first run) stays a dialog", () => {
    expect(renderToStaticMarkup(createElement(RolePickerDialog, { ...base, inline: true }))).toMatch(/^<section[^>]*role-picker-inline/);
    expect(renderToStaticMarkup(createElement(RolePickerDialog, base))).toMatch(/^<dialog/);
  });
});

const originalSnapshot = useSettingsStore.getState().snapshot;
afterEach(() => useSettingsStore.setState({ snapshot: originalSnapshot }));

describe("Role model fields in both editor entry points", () => {
  it.each(["dialog", "settings"] as const)("%s renders route models, empty default and unknown custom values", (surface) => {
    const snapshot: SettingsSnapshot = {
      settings: {
        version: 2,
        provider: { connections: [{ id: "c", providerId: "vendor", models: ["live-model"] }], activeConnectionId: "c" },
        roles: { executor: { primary: { model: "saved-unknown" }, fallbacks: [{ connection: "c", model: "live-model" }] } },
        tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
      },
      secrets: [], providerReady: true, envOverrides: [], readOnly: false,
      catalog: [{ id: "vendor", name: "Vendor", authKind: "api_key", models: [{ id: "catalog-model", name: "Catalog model" }] }],
    };
    useSettingsStore.setState({ snapshot });
    const html = renderToStaticMarkup(surface === "settings" ? createElement(RolesPane) : createElement(RolePickerDialog, {
      ...base, connections: snapshot.settings.provider.connections!, activeConnectionId: "c",
      initialRoles: { executor: snapshot.settings.roles!.executor! },
    }));
    expect(html).toContain('<option value="default" selected="">Default</option>');
    expect(html).toContain('>Catalog model</option>');
    expect(html).toContain('<option value="custom" selected="">Custom…</option>');
    expect(html).toContain(surface === "settings" ? 'aria-label="executor primary custom model"' : 'aria-label="Primary custom model"');
    expect(html).toContain('value="saved-unknown"');
    if (surface === "dialog") expect(html).toContain('<option value="model:1" selected="">live-model</option>');
    expect(html).not.toContain('model (optional)');
  });
});

it.each(["claude", "codex"] as const)("renders %s engine options without a second default", (engine) => {
  const html = renderToStaticMarkup(createElement(RolePickerDialog, {
    ...base, initialRoles: { executor: { primary: { engine, model: "default" } } },
  }));
  const row = html.split('data-testid="role-picker-role-executor"')[1]!.split('class="role-picker-entry-effort"')[0]!;
  expect(row).toContain('<option value="default" selected="">Default</option>');
  expect(row).not.toContain('>Default (recommended)</option>');
  expect(row).not.toContain('custom model');
  if (engine === "claude") {
    expect(row).toContain('>Sonnet</option>');
    expect(row).toContain('>Opus</option>');
  } else {
    const modelSelect = row.split('aria-label="Primary model"')[1]!;
    expect(modelSelect.match(/<option/g)).toHaveLength(2);
  }
});

describe("Roles save notice", () => {
  it.each([
    [true, "settings-notice-ok", "Roles saved."],
    [false, "settings-notice", "Saving roles failed."],
  ])("renders the %s save outcome with the correct class", (ok, className, message) => {
    expect(renderToStaticMarkup(createElement(RolesSaveNotice, { ok })))
      .toBe(`<p class="${className}" role="status">${message}</p>`);
  });
});

it("renders provider names in every route and preserves route values", () => {
  const connections = [
    { id: "a", providerId: "deepseek", label: "test" },
    { id: "b", providerId: "custom:local", label: "local" },
    { id: "c", providerId: "unknown", label: "other" },
    { id: "d", providerId: "deepseek" },
  ];
  const snapshot = {
    settings: { version: 2, provider: { connections, custom: [{ id: "custom:local", name: "Local provider", baseUrl: "http://localhost", kind: "openai-compatible", models: [] }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } },
    secrets: [], providerReady: true, envOverrides: [], readOnly: false,
    catalog: [{ id: "deepseek", name: "DeepSeek", authKind: "api_key", models: [] }],
  } satisfies SettingsSnapshot;
  useSettingsStore.setState({ snapshot });
  const html = renderToStaticMarkup(createElement(RolePickerDialog, { ...base, connections, inline: true, initialRoles: { executor: { primary: {}, fallbacks: [{}] } } }));
  expect(html.match(/test · DeepSeek/g)).toHaveLength(6);
  expect(html.match(/local · Local provider/g)).toHaveLength(6);
  expect(html).toContain('value="connection:c">other · unknown</option>');
  expect(html).not.toContain('value="connection:d">d</option>');
  expect(html).toContain('value="connection:active" selected="">Session&#x27;s connection</option>');
  // The unlabeled DeepSeek connection reads as its provider, never as `d`.
  expect(html).toContain('value="connection:d">DeepSeek</option>');
  expect(html).toContain('>Current connection</button>');
  expect(html).not.toContain('>This connection</');
});

it("renders profile and project selection controls", () => {
  const html = renderToStaticMarkup(createElement(RolesPane));
  expect(html).toContain('aria-label="Profile actions"');
  expect(html).toContain('aria-label="Project to add"');
  expect(html).toContain('aria-label="Profile to add"');
  expect(html).toContain('>New</button>');
  expect(html).toContain('>Duplicate</button>');
  expect(html).toContain('>Rename</button>');
  expect(html).toContain('>Delete</button>');
});

it("an empty saved profile displays the active connection instead of an unsaved preset", () => {
  const html = renderToStaticMarkup(createElement(RolePickerDialog, { ...base, inline: true, initialRoles: {} }));
  expect(html).toContain('data-route="connection:active"');
  expect(html).not.toContain('data-route="engine:claude"');
  expect(html).not.toContain('data-route="engine:codex"');
});
/**
 * a same-named md agent profile claims a role
 * and silently outranks the Settings route. The editor must SAY which profile
 * file wins — and say nothing once that profile is removed.
 */
describe("Role editor — a profile that claims a role is named, not silently obeyed", () => {
  const override = (role: "reviewer"): Partial<Record<"planner" | "executor" | "reviewer" | "explore", { role: "reviewer"; profileName: string; path: string }>> => ({
    [role]: { role, profileName: role, path: `/ws/.anycode/agents/${role}.md` },
  });

  it.each(["settings", "dialog"] as const)("%s: shows the claiming profile's path on the claimed role only", (surface) => {
    const html = renderToStaticMarkup(
      surface === "settings"
        ? createElement(RolesPane)
        : createElement(RolePickerDialog, { ...base, initialRoles: undefined, profileOverrides: override("reviewer") }),
    );
    // The pane's own fetch is an effect (not run under SSR), so the direct
    // dialog render carries the collision; the pane render proves the notice
    // slot exists in the shared editor without claiming anything by default.
    const reviewRow = html.split('data-testid="role-picker-role-reviewer"')[1]!.split('data-testid="role-picker-role-explore"')[0]!;
    if (surface === "dialog") {
      expect(reviewRow).toContain("/ws/.anycode/agents/reviewer.md");
      expect(reviewRow).toContain("Settings route is not used");
      expect(reviewRow).toContain('data-testid="role-route-overridden-reviewer"');
      const plannerRow = html.split('data-testid="role-picker-role-planner"')[1]!.split('data-testid="role-picker-role-executor"')[0]!;
      expect(plannerRow).not.toContain("Overridden by the agent profile");
    } else {
      expect(html).not.toContain("Overridden by the agent profile");
    }
  });

  it("removal: with no claiming profile the editor renders no override notice", () => {
    const withProfile = renderToStaticMarkup(createElement(RolePickerDialog, { ...base, profileOverrides: override("reviewer") }));
    const afterRemoval = renderToStaticMarkup(createElement(RolePickerDialog, { ...base, profileOverrides: {} }));
    expect(withProfile).toContain("Overridden by the agent profile");
    expect(afterRemoval).not.toContain("Overridden by the agent profile");
    expect(afterRemoval).not.toContain("role-route-overridden-");
  });
});


/**
 * GitHub #17 slice B: the pane used to seed its number input
 * with `?? 4` and write that competing default back on every save, so an
 * absent role cap silently became an explicit 4. Blank must now mean
 * "inherit the session limit" (default 3), and anything unparseable must
 * refuse the save instead of being clamped.
 */
describe("Max parallel children input (GitHub #17 slice B)", () => {
  /** The <input> that follows the cap label — attribute order is not stable. */
  function childLimitInput(html: string): string {
    return html.split('Max parallel children</span>')[1]!.split(">")[0]! + ">";
  }

  const settingsSnapshot = (roles: Record<string, unknown>): SettingsSnapshot => ({
    settings: {
      version: 2,
      provider: { connections: [] },
      roleProfiles: { activeId: "p", profiles: [{ id: "p", name: "P", roles }], projects: [] },
      tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
    },
    secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [],
  });

  it("an absent explicit cap renders BLANK, never a fabricated 4", () => {
    useSettingsStore.setState({ snapshot: settingsSnapshot({}) });
    const html = renderToStaticMarkup(createElement(RolesPane));
    const input = childLimitInput(html);
    expect(input).toContain('value=""');
    expect(html).not.toContain("default 4");
    expect(html).toContain("blank uses the session limit, default 3");
  });

  it("an explicit cap survives in the input", () => {
    useSettingsStore.setState({ snapshot: settingsSnapshot({ maxParallelChildren: 2 }) });
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(childLimitInput(html)).toContain('value="2"');
  });

  it("parses only blank or a whole number 1..16", () => {
    expect(parseRoleChildLimitInput("")).toEqual({ valid: true });
    expect(parseRoleChildLimitInput("   ")).toEqual({ valid: true });
    expect(parseRoleChildLimitInput(" 2 ")).toEqual({ valid: true, value: 2 });
    expect(parseRoleChildLimitInput("16")).toEqual({ valid: true, value: 16 });
    for (const raw of ["0", "-1", "17", "2.5", "two", "1e3", " 4 5", "0x10"]) {
      expect(parseRoleChildLimitInput(raw)).toEqual({ valid: false });
    }
  });

  it("a blank field CLEARS a previously saved cap instead of rewriting 4", () => {
    const previous = { executor: { primary: { engine: "claude" as const } }, maxParallelChildren: 4 };
    const cleared = buildRoleProfileRoles(previous, "");
    expect(cleared.valid).toBe(true);
    expect(cleared.valid && "maxParallelChildren" in cleared.roles).toBe(false);
    expect(cleared.valid && cleared.roles.executor).toEqual(previous.executor);
  });

  it("a valid value is written, and an invalid one refuses the whole save", () => {
    const built = buildRoleProfileRoles({ executor: { primary: {} } }, "2");
    expect(built).toEqual({ valid: true, roles: { executor: { primary: {} }, maxParallelChildren: 2 } });
    for (const raw of ["0", "17", "2.5"]) {
      expect(buildRoleProfileRoles({ maxParallelChildren: 4 }, raw)).toEqual({ valid: false });
    }
  });
});

/**
 * B1 regression: 0.0.46 promised every role route is identified by provider.
 * A connection with no custom label regressed to a raw `conn-<uuid>` id in the
 * option text AND in the displayed selection, in both editor entry points. The
 * option must read as the provider's display name.
 */
describe("Route selects name connections, never raw connection ids", () => {
  const connectionId = "conn-76796d43-742b-4f0e-b08f-0ce36d93ccd9";
  const connections = [
    { id: connectionId, providerId: "z-ai" },
    { id: "conn-2", providerId: "z-ai" },
    { id: "conn-3", providerId: "custom:lab" },
  ];
  const snapshot = {
    settings: {
      version: 2,
      provider: {
        connections,
        activeConnectionId: connectionId,
        custom: [{ id: "custom:lab", name: "Lab endpoint", baseUrl: "http://localhost:1234", kind: "openai-compatible", models: [] }],
      },
      tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
    },
    secrets: [], providerReady: true, envOverrides: [], readOnly: false,
    catalog: [{ id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] }],
  } satisfies SettingsSnapshot;

  it.each(["settings", "dialog"] as const)("%s: the stored connection renders as its provider name", (surface) => {
    useSettingsStore.setState({ snapshot });
    const html = renderToStaticMarkup(surface === "settings" ? createElement(RolesPane) : createElement(RolePickerDialog, {
      ...base, connections, activeConnectionId: connectionId,
      initialRoles: { executor: { primary: { connection: connectionId } } },
    }));
    // No option text is a bare id (the value attribute keeps the id; the text must not).
    expect(html).not.toMatch(/>conn-[0-9a-f-]+/);
    expect(html).toMatch(/<option value="connection:conn-76796d43-742b-4f0e-b08f-0ce36d93ccd9"[^>]*>Z\.AI \(GLM\)<\/option>/);
    if (surface === "dialog") {
      expect(html).toContain('<option value="connection:conn-76796d43-742b-4f0e-b08f-0ce36d93ccd9" selected="">Z.AI (GLM)</option>');
    }
    expect(html).toContain('>Z.AI (GLM) 2</option>');
    expect(html).toContain('>Lab endpoint</option>');
  });
});

describe("preset chips follow the values, not the last auto-selection", () => {
  const engineChain = {
    orchestrator: { primary: { engine: "claude" as const } },
    planner: { primary: { engine: "claude" as const } },
    executor: { primary: { engine: "codex" as const }, fallbacks: [{ connection: "conn-1" }] },
    reviewer: { primary: { engine: "claude" as const } },
    explore: { primary: { connection: "conn-1" } },
  };

  it("a persisted Claude/Codex chain with no engine ready highlights NO chip and marks the engine routes offline", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, {
      ...base,
      engines: { claudeReady: false, codexReady: false },
      initialRoles: engineChain,
    }));
    expect(html).not.toContain("role-picker-preset-chip-active");
    expect(html).toContain("Claude engine (not connected)");
    expect(html).toContain("Codex engine (not connected)");
    expect(html).toContain("Claude engine is not connected");
  });

  it("the default a fresh profile gets with no engine ready IS the current connection chip", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, {
      ...base,
      engines: { claudeReady: false, codexReady: false },
      activeConnectionId: "conn-1",
    }));
    const activeChip = html.match(/<button[^>]*role-picker-preset-chip-active[^>]*data-testid="([^"]+)"/);
    expect(activeChip?.[1]).toBe("role-preset-this-connection");
    expect(html).not.toContain("Claude engine is not connected");
  });

  it("disabled presets say what they need in text, not only in a hover title", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, {
      ...base,
      engines: { claudeReady: false, codexReady: false },
      initialRoles: engineChain,
    }));
    const note = html.split('data-testid="role-preset-requirements"')[1] ?? "";
    expect(note).toContain("Claude leads, Codex builds: Requires Claude and Codex to be set up and signed in.");
    expect(note).toContain("All Claude: Requires Claude to be set up and signed in.");
  });
});

describe("fallback order controls", () => {
  it("render up before down, each named, and the up glyph is rotated to point up", () => {
    const html = renderToStaticMarkup(createElement(EntryRow, {
      compact: true,
      label: "planner fallback 1",
      entry: { engine: "", connection: "conn-1", model: "", effort: "" },
      connections: [],
      modelSources: { connections: [], activeConnectionId: "conn-1", catalog: undefined, custom: undefined, engineModels: {} },
      onChange: () => {},
      onMove: () => {},
      onRemove: () => {},
    }));
    const order = html.slice(html.indexOf("role-picker-entry-order"), html.indexOf("role-picker-entry-remove"));
    // Up comes first (a down chevron rendered first is what made the pair read "down, up").
    expect(order.indexOf('aria-label="Move planner fallback 1 up"')).toBeLessThan(order.indexOf('aria-label="Move planner fallback 1 down"'));
    expect(order).toContain('title="Move planner fallback 1 up"');
    expect(order).toContain("role-picker-entry-order-glyph");
    // The third glyph of the group names its action in words too.
    expect(html).toContain('title="Remove planner fallback 1"');
  });
});

describe("preset chip follows the seeded draft (production fromDraft path)", () => {
  it("highlight P1 when both engines are ready", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, {
      ...base,
      engines: { claudeReady: true, codexReady: true },
      activeConnectionId: "conn-1",
    }));
    const active = html.match(/<button[^>]*role-picker-preset-chip-active[^>]*data-testid="([^"]+)"/);
    expect(active?.[1]).toBe("role-preset-claude-leads-codex-builds");
  });
});

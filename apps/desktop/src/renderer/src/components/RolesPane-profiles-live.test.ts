// @vitest-environment jsdom
/**
 * Settings → Roles, mounted in a DOM and driven the way a user drives it.
 *
 * - The editor must show the routes of the profile that is now selected: its
 *   draft survives rerenders, so changing the selection has to remount it.
 * - Create/Duplicate must not treat the name prefill as a name the user typed:
 *   clicking them repeatedly without typing yields distinct names, while a
 *   typed name is still used verbatim.
 * - The pane's own save must surface its feedback in the actions row (a test
 *   that injects a notice into the dialog directly cannot see that wire break).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolesPane, type RolesPaneProps } from "./RolesPane.js";
import { SettingsDialog } from "./SettingsScreen.js";
import { SETTINGS_ADD_CONNECTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { cloneDefaults, mergeSettings, roleProfilesWriteSchema, settingsSchema } from "../../../settings/schema.js";
import type { AnycodeSettings, SettingsPatch, SettingsSnapshot } from "../../../shared/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The settings IPC's own gate, reproduced without Electron: the write schema
 * check first, then the whole-document parse of the merged result. A patch
 * that main would refuse resolves `{ok:false}` and never moves the snapshot.
 */
function makeSettingsBridge(initial: AnycodeSettings) {
  let settings = initial;
  let snapshot: SettingsSnapshot = {
    settings,
    secrets: [],
    providerReady: true,
    envOverrides: [],
    readOnly: false,
    catalog: [],
  };
  const set = vi.fn(async (patch: SettingsPatch) => {
    if ("roleProfiles" in patch && !roleProfilesWriteSchema.safeParse(patch.roleProfiles).success) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const merged = mergeSettings(settings, patch);
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false as const, reason: "invalid" as const };
    }
    settings = merged;
    snapshot = { ...snapshot, settings };
    return { ok: true as const, snapshot };
  });
  return { set, get: async () => snapshot, current: () => settings, snapshot: () => snapshot };
}

let root: Root | undefined;
let container: HTMLDivElement;

const originalSnapshot = useSettingsStore.getState().snapshot;
const originalAvailableEngines = useTabsStore.getState().availableEngines;
const originalTabs = useTabsStore.getState().tabs;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  useSettingsStore.setState({ snapshot: originalSnapshot, notice: null });
  useTabsStore.setState({ availableEngines: originalAvailableEngines, tabs: originalTabs });
});

function installBridge(settings: AnycodeSettings) {
  const bridge = makeSettingsBridge(settings);
  Object.defineProperty(window, "anycode", {
    configurable: true,
    value: {
      settings: bridge,
      listSessions: vi.fn(async () => []),
      subagents: { list: vi.fn(async () => ({ rows: [], problems: [] })) },
      onEnginesChanged: vi.fn(() => () => {}),
      codex: { recheck: vi.fn(async () => ({ report: { status: "unavailable" } })) },
    },
  });
  useSettingsStore.setState({ snapshot: bridge.snapshot(), notice: null });
  useTabsStore.setState({ availableEngines: ["claude"], tabs: [] });
  return bridge;
}

/** Mounts the pane against the bridge installed by `installBridge`. */
async function mount(): Promise<HTMLDivElement> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(RolesPane));
  });
  return container;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`no button labelled ${text}`);
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Sets a controlled input's value the way React's own tracker notices it. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function settingsWithProfile(name: string): AnycodeSettings {
  const settings = cloneDefaults();
  settings.roleProfiles = { profiles: [{ id: "p", name, roles: {} }], activeId: "p", projects: [] };
  return settings;
}

function profileNames(settings: AnycodeSettings): string[] {
  return settings.roleProfiles?.profiles.map((profile) => profile.name) ?? [];
}

describe("Editor follows the selected profile", () => {
  it("shows the selected profile's routes, even when its id is \"default\"", async () => {
    const initial = cloneDefaults();
    // Nothing is selected (the active id names a profile that no longer
    // exists), so the editor starts from the built-in preset — which is what
    // the stale-draft bug used to keep on screen after selecting "Default".
    initial.roleProfiles = {
      profiles: [{ id: "default", name: "Default", roles: { executor: { primary: { connection: "specific" } } } }],
      activeId: "gone",
      projects: [],
    };
    const bridge = installBridge(initial);
    await mount();

    const routeSelect = (): HTMLSelectElement | null => container.querySelector<HTMLSelectElement>(
      '[data-testid="role-picker-role-executor"] [aria-label="executor primary route"]',
    );
    expect(routeSelect()?.value).toBe("engine:claude");

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Role profile"]');
    expect(select?.value).toBe("");
    expect(select?.querySelector('option[value="default"]')?.textContent).toBe("Default");
    if (select === null) throw new Error("no global profile select");
    await act(async () => {
      select.value = "default";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(bridge.current().roleProfiles?.activeId).toBe("default");
    // The editor now shows the profile's own route, not the preset draft.
    expect(routeSelect()?.value).toBe("connection:specific");
    // With a profile active, the built-in defaults are no longer offered.
    expect(container.querySelector('[aria-label="Role profile"] [value=""]')).toBeNull();
  });
});

describe("Create/Duplicate without typing a name", () => {
  it("four repeated clicks yield four distinct names", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();

    for (const action of ["New", "New", "Duplicate", "Duplicate"]) {
      await click(buttonByText(action));
      await click(buttonByText("Save"));
    }

    const names = profileNames(bridge.current());
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(names).toEqual(["Team", "Profile 1", "Profile 2", "Profile 2 copy", "Profile 2 copy 2"]);
    // The visible option list agrees with what was persisted (a profile is
    // active, so the built-in defaults are not offered here).
    const options = [...container.querySelectorAll('[aria-label="Role profile"] option')].map((option) => option.textContent);
    expect(options).toEqual(names);
  });

  it("a typed name is still used as typed", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();
    await click(buttonByText("New"));
    const input = container.querySelector<HTMLInputElement>("#role-profile-name")!;
    await act(async () => type(input, "Reviewers"));

    await click(buttonByText("Save"));

    expect(profileNames(bridge.current())).toEqual(["Team", "Reviewers"]);
  });
});

describe("Save from the pane", () => {
  it("shows the save feedback from the pane's own save path inside the actions row", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();

    await click(buttonByText("Save roles"));

    expect(bridge.set).toHaveBeenCalled();
    const actions = container.querySelector(".roles-actions");
    expect(actions?.textContent).toContain("Roles saved.");
    expect(actions?.querySelector('[role="status"]')).not.toBeNull();
    // The persisted profile is the selected one, not a fresh "default" row.
    expect(profileNames(bridge.current())).toEqual(["Team"]);
    expect(bridge.current().roleProfiles?.activeId).toBe("p");
  });
});

describe("Profile and project interactions", () => {
  it("edits the effective project profile without changing the global selection or unrelated routes", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = {
      profiles: [
        { id: "global", name: "Global", roles: {} },
        { id: "project", name: "Project", roles: {
          executor: { primary: { provider: "vendor", model: "custom-model" }, fallbacks: [{ connection: "old", model: "fallback" }] },
          planner: { primary: { connection: "another" } },
        } },
      ], activeId: "global", projects: [{ projectRoot: "/projects/app", profileId: "project" }],
    };
    const bridge = installBridge(initial);
    root = createRoot(container);
    await act(async () => root?.render(createElement<RolesPaneProps>(RolesPane, { projectRoot: "/projects/app" })));
    expect(container.textContent).toContain("project override for app");
    expect(bridge.set).not.toHaveBeenCalled();
    const effort = container.querySelector<HTMLSelectElement>('[aria-label="executor primary effort"]')!;
    await act(async () => { effort.value = "high"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.activeId).toBe("global");
    expect(bridge.current().roleProfiles?.profiles[1]?.roles).toEqual({
      executor: { primary: { provider: "vendor", model: "custom-model", effort: "high" }, fallbacks: [{ connection: "old", model: "fallback" }] },
      planner: { primary: { connection: "another" } },
    });
  });

  it("lists dangling mappings, supports removal, and does not write on disclosure", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.projects = [{ projectRoot: "/one/app", profileId: "missing" }, { projectRoot: "/two/app", profileId: "p" }];
    const bridge = installBridge(initial);
    await mount();
    expect(container.textContent).toContain("Missing profile (using global fallback)");
    expect(container.textContent).toContain("app — /one/app");
    expect(container.textContent).toContain("app — /two/app");
    expect(bridge.set).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove profile for /one/app"]')!);
    expect(bridge.current().roleProfiles?.projects).toEqual([{ projectRoot: "/two/app", profileId: "p" }]);
  });

  it("refuses an invalid cap without changing any saved role", async () => {
    const initial = settingsWithProfile("Team");
    const bridge = installBridge(initial);
    await mount();
    const cap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
    await act(async () => type(cap, "17"));
    await click(buttonByText("Save roles"));
    expect(bridge.set).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a whole number from 1 to 16");
  });
});

describe("Deletion confirmation", () => {
  it("writes only after confirmation and removes mappings to the deleted profile", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.projects = [{ projectRoot: "/project", profileId: "p" }];
    const bridge = installBridge(initial);
    await mount();
    await click(buttonByText("Delete"));
    expect(container.querySelector("dialog")?.textContent).toContain("Project mappings to Team");
    expect(bridge.set).not.toHaveBeenCalled();
    await click(buttonByText("Cancel"));
    expect(bridge.set).not.toHaveBeenCalled();
    await click(buttonByText("Delete"));
    const dialog = container.querySelector("dialog")!;
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
    await click(confirm);
    expect(bridge.current().roleProfiles).toEqual({ profiles: [], activeId: "default", projects: [] });
  });
});


describe("Draft protection", () => {
  it("retains edits and feedback after a failed save", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();
    const effort = container.querySelector<HTMLSelectElement>('[aria-label="executor primary effort"]')!;
    await act(async () => { effort.value = "high"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    bridge.set.mockResolvedValueOnce({ ok: false, reason: "invalid" });
    await click(buttonByText("Save roles"));
    expect(effort.value).toBe("high");
    expect(container.textContent).toContain("Saving profiles failed.");
    expect(bridge.current().roleProfiles?.profiles[0]?.roles).toEqual({});
  });

  it("requires confirmation before replacing edited roles with a preset", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();
    const effort = container.querySelector<HTMLSelectElement>('[aria-label="executor primary effort"]')!;
    await act(async () => { effort.value = "high"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    const preset = container.querySelector<HTMLSelectElement>('[aria-label="Apply preset"]')!;
    await act(async () => { preset.value = "this-connection"; preset.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("dialog")?.textContent).toContain("unsaved");
    await click(buttonByText("Cancel"));
    expect(effort.value).toBe("high");
    expect(bridge.set).not.toHaveBeenCalled();
  });
});

describe("Project selection and profile naming", () => {
  it("shows an inherited profile, assigns an override, and keeps the global selection", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [{ id: "a", name: "Global", roles: {} }, { id: "b", name: "Fast", roles: {} }], activeId: "a", projects: [] };
    const bridge = installBridge(initial);
    root = createRoot(container);
    await act(async () => root?.render(createElement<RolesPaneProps>(RolesPane, { projectRoot: "/projects/app" })));
    expect(container.textContent).toContain("inherited global profile for app");
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Role profile"]')!;
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(bridge.current().roleProfiles?.activeId).toBe("a");
    expect(bridge.current().roleProfiles?.projects).toEqual([{ projectRoot: "/projects/app", profileId: "b" }]);
    expect(container.textContent).toContain("project override for app");
  });

  it("renames through an inline form and cancellation writes nothing", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();
    await click(buttonByText("Rename"));
    const input = container.querySelector<HTMLInputElement>("#role-profile-name")!;
    expect(input.value).toBe("Team");
    await act(async () => type(input, "  Review  "));
    await click(buttonByText("Cancel"));
    expect(bridge.set).not.toHaveBeenCalled();
    await click(buttonByText("Rename"));
    await act(async () => type(container.querySelector<HTMLInputElement>("#role-profile-name")!, "  Review  "));
    await click(buttonByText("Save"));
    expect(profileNames(bridge.current())).toEqual(["Review"]);
  });
});

describe("Existing settings", () => {
  it.each(["default", "builtin"])("preserves sparse routes for a saved %s profile", async (id) => {
    const initial = cloneDefaults();
    initial.roleProfiles = { activeId: id, profiles: [{ id, name: "Saved", roles: { executor: { primary: { provider: "vendor", model: "custom" }, fallbacks: [{ connection: "first" }, { connection: "second" }] }, maxParallelChildren: 5 } }], projects: [] };
    const bridge = installBridge(initial);
    await mount();
    const cap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
    await act(async () => type(cap, ""));
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles).toEqual({ executor: { primary: { provider: "vendor", model: "custom" }, fallbacks: [{ connection: "first" }, { connection: "second" }] } });
  });

  it("loads legacy roles without writing and retains them when saving an explicit cap", async () => {
    const initial = cloneDefaults();
    initial.roles = { executor: { primary: { provider: "vendor", model: "custom" } } };
    const bridge = installBridge(initial);
    await mount();
    expect(bridge.set).not.toHaveBeenCalled();
    const cap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
    await act(async () => type(cap, "2"));
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles).toEqual({ executor: { primary: { provider: "vendor", model: "custom" } }, maxParallelChildren: 2 });
  });
});

describe("Secondary controls", () => {
  it("replaces an existing project mapping through the Add row", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [{ id: "a", name: "A", roles: {} }, { id: "b", name: "B", roles: {} }], activeId: "a", projects: [{ projectRoot: "/project", profileId: "a" }] };
    const bridge = installBridge(initial);
    await mount();
    const project = container.querySelector<HTMLSelectElement>('[aria-label="Project to add"]')!;
    const profile = container.querySelector<HTMLSelectElement>('[aria-label="Profile to add"]')!;
    await act(async () => { project.value = "/project"; project.dispatchEvent(new Event("change", { bubbles: true })); profile.value = "b"; profile.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(buttonByText("Add"));
    expect(bridge.current().roleProfiles?.projects).toEqual([{ projectRoot: "/project", profileId: "b" }]);
  });

  it("reveals fallbacks without writing and shows ordering only with Advanced open", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.profiles[0]!.roles.executor = { primary: {}, fallbacks: [{ connection: "one" }, { connection: "two" }] };
    const bridge = installBridge(initial);
    await mount();
    const row = container.querySelector('[data-testid="role-picker-role-executor"]')!;
    await click(row.querySelector<HTMLButtonElement>('.roles-fallback-toggle')!);
    expect(row.querySelector('[aria-label="executor fallback 1 route"]')).not.toBeNull();
    expect(row.querySelector('[aria-label="Move executor fallback 1 up"]')).toBeNull();
    const advanced = [...container.querySelectorAll("summary")].find((el) => el.textContent?.includes("Advanced"))!;
    await act(async () => { (advanced.parentElement as HTMLDetailsElement).open = true; advanced.parentElement!.dispatchEvent(new Event("toggle")); });
    expect(row.querySelector('[aria-label="Move executor fallback 1 up"]')).not.toBeNull();
    expect(bridge.set).not.toHaveBeenCalled();
  });

  it("keeps built-in profile deletion and rename disabled", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = undefined;
    initial.roles = undefined;
    const bridge = installBridge(initial);
    await mount();
    expect(buttonByText("Rename").disabled).toBe(true);
    expect(buttonByText("Delete").disabled).toBe(true);
    expect(container.querySelector('[aria-label="Role profile"]')).toBeNull();
    expect(bridge.set).not.toHaveBeenCalled();
  });
});

describe("In-flight saves", () => {
  it("prevents a second registry mutation while a write is pending", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    await mount();
    await click(buttonByText("Save roles"));
    expect(buttonByText("Save roles").disabled).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>(".roles-editor")?.disabled).toBe(true);
    expect(buttonByText("New").disabled).toBe(true);
    await act(async () => { release(); await waiting; });
    expect(bridge.set).toHaveBeenCalledTimes(1);
    expect(buttonByText("Save roles").disabled).toBe(false);
  });
});

describe("Control appearance and unavailable routes", () => {
  it("uses shared styles for default, prompt, project, and advanced controls", async () => {
    installBridge(settingsWithProfile("Team"));
    await mount();
    await click(buttonByText("New"));
    expect(container.querySelector("#role-profile-name")?.classList.contains("settings-field-input")).toBe(true);
    expect([...container.querySelectorAll(".roles-pane select")].every((el) => el.classList.contains("settings-field-select"))).toBe(true);
    expect(container.querySelector('[aria-label="Max parallel children"]')?.classList.contains("settings-field-input")).toBe(true);
    expect([...container.querySelectorAll(".roles-pane button")].every((el) => el.classList.contains("settings-button"))).toBe(true);
  });

  it("keeps an unavailable route and its fallbacks until the user changes it", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.profiles[0]!.roles.executor = { primary: { engine: "codex", model: "saved-model" }, fallbacks: [{ connection: "backup" }] };
    const bridge = installBridge(initial);
    await mount();
    const row = container.querySelector('[data-testid="role-picker-role-executor"]')!;
    expect(row.textContent).toContain("codex unavailable");
    await click(row.querySelector<HTMLButtonElement>(".roles-fallback-toggle")!);
    expect(row.querySelector('[aria-label="executor fallback 1 route"]')).not.toBeNull();
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles.executor).toEqual(initial.roleProfiles!.profiles[0]!.roles.executor);
  });
});

describe("Implicit defaults", () => {
  it("does not overwrite a saved default id when the active id is dangling", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [{ id: "default", name: "Saved", roles: { executor: { primary: { model: "keep" } } } }], activeId: "missing", projects: [] };
    const bridge = installBridge(initial);
    await mount();
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles.find((p) => p.id === "default")?.roles.executor?.primary.model).toBe("keep");
    expect(bridge.current().roleProfiles?.profiles).toHaveLength(2);
    expect(bridge.current().roleProfiles?.activeId).not.toBe("default");
  });

  it("creates an effective project profile without changing a dangling global selection", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [], activeId: "missing", projects: [] };
    const bridge = installBridge(initial);
    root = createRoot(container);
    await act(async () => root?.render(createElement<RolesPaneProps>(RolesPane, { projectRoot: "/project" })));
    await click(buttonByText("Save roles"));
    const registry = bridge.current().roleProfiles!;
    expect(registry.activeId).toBe("missing");
    expect(registry.projects).toEqual([{ projectRoot: "/project", profileId: registry.profiles[0]?.id }]);
  });
});

describe("Project list availability", () => {
  it("keeps persisted mappings visible if the session list fails", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.projects = [{ projectRoot: "/only/mapping", profileId: "p" }];
    const bridge = installBridge(initial);
    vi.mocked(window.anycode.listSessions).mockRejectedValueOnce(new Error("unavailable"));
    await mount();
    expect(container.textContent).toContain("mapping");
    expect(container.querySelector('[aria-label="Remove profile for /only/mapping"]')).not.toBeNull();
    expect(bridge.set).not.toHaveBeenCalled();
  });
});


describe("Discard and navigation regressions", () => {
  it("resets the draft when removing an override that points to the global profile", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.projects = [{ projectRoot: "/project", profileId: "p" }];
    const bridge = installBridge(initial);
    root = createRoot(container);
    await act(async () => root?.render(createElement<RolesPaneProps>(RolesPane, { projectRoot: "/project" })));
    const cap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
    await act(async () => type(cap, "5"));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove profile for /project"]')!);
    await click(buttonByText("Discard changes"));
    expect(cap.value).toBe("");
    expect(bridge.current().roleProfiles?.projects).toEqual([]);
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles.maxParallelChildren).toBeUndefined();
  });

  it("clears cancelled external requests and accepts the same request again", async () => {
    installBridge(settingsWithProfile("Team"));
    const original = useSettingsStore.getState();
    useSettingsStore.setState({ subscribeUpdates: () => () => {}, subscribeProviderHealth: () => () => {}, subscribeProviderQuota: () => () => {} });
    try {
      root = createRoot(container);
      await act(async () => root?.render(createElement(SettingsDialog, { open: true, onClose: vi.fn() })));
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-roles')!);
      await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!, "5"));
      const requestPane = () => window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: "tools" }));
      await act(async () => { requestPane(); });
      await click(buttonByText("Cancel"));
      await act(async () => { requestPane(); });
      expect(container.querySelector('[aria-label="Discard unsaved roles?"]')).not.toBeNull();
      await click(buttonByText("Cancel"));
      await act(async () => { window.dispatchEvent(new CustomEvent(SETTINGS_ADD_CONNECTION_EVENT)); });
      await click(buttonByText("Cancel"));
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-provider')!);
      await click(buttonByText("Discard changes"));
      expect(container.querySelector('[aria-label="Add connection"]')).toBeNull();
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-roles')!);
      await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!, "5"));
      await act(async () => { window.dispatchEvent(new CustomEvent(SETTINGS_ADD_CONNECTION_EVENT)); });
      expect(container.querySelector('[aria-label="Discard unsaved roles?"]')).not.toBeNull();
      await click(buttonByText("Discard changes"));
      expect(container.querySelector('[aria-label="Add connection"]')).not.toBeNull();
    } finally {
      useSettingsStore.setState({ subscribeUpdates: original.subscribeUpdates, subscribeProviderHealth: original.subscribeProviderHealth, subscribeProviderQuota: original.subscribeProviderQuota });
    }
  });

  it("guards pane navigation and closing settings", async () => {
    installBridge(settingsWithProfile("Team"));
    const onClose = vi.fn();
    const original = useSettingsStore.getState();
    useSettingsStore.setState({ subscribeUpdates: () => () => {}, subscribeProviderHealth: () => () => {}, subscribeProviderQuota: () => () => {} });
    try {
      root = createRoot(container);
      await act(async () => root?.render(createElement(SettingsDialog, { open: true, onClose })));
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-roles')!);
      const cap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
      await act(async () => type(cap, "5"));
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-tools')!);
      expect(container.querySelector('[aria-label="Discard unsaved roles?"]')).not.toBeNull();
      await click(buttonByText("Cancel"));
      expect(cap.value).toBe("5");
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-tools')!);
      await click(buttonByText("Discard changes"));
      expect(container.querySelector('[data-testid="settings-roles-pane"]')).toBeNull();
      await click(container.querySelector<HTMLButtonElement>('#settings-tab-roles')!);
      const newCap = container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!;
      expect(newCap.value).toBe("");
      await act(async () => type(newCap, "5"));
      await click(buttonByText("Back to app"));
      expect(onClose).not.toHaveBeenCalled();
      await click(buttonByText("Cancel"));
      await act(async () => container.querySelector<HTMLDialogElement>('[aria-label="Settings"]')!.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true })));
      expect(onClose).not.toHaveBeenCalled();
      await click(buttonByText("Discard changes"));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      useSettingsStore.setState({ subscribeUpdates: original.subscribeUpdates, subscribeProviderHealth: original.subscribeProviderHealth, subscribeProviderQuota: original.subscribeProviderQuota });
    }
  });
});

describe("Writes across mounts", () => {
  it("keeps the first project save effective before allowing another edit", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [], activeId: "missing", projects: [] };
    const bridge = installBridge(initial);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    root = createRoot(container);
    const pane = () => createElement<RolesPaneProps>(RolesPane, { projectRoot: "/project" });
    await act(async () => root?.render(pane()));
    await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!, "5"));
    await click(buttonByText("Save roles"));
    await act(async () => root?.render(createElement("div")));
    await act(async () => root?.render(pane()));
    expect(buttonByText("Save roles").disabled).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>(".roles-editor")!.disabled).toBe(true);
    await act(async () => { release(); await waiting; });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!.value).toBe("5");
    const effort = container.querySelector<HTMLSelectElement>('[aria-label="executor primary effort"]')!;
    await act(async () => { effort.value = "high"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(buttonByText("Save roles"));
    const registry = bridge.current().roleProfiles!;
    expect(registry.profiles).toHaveLength(1);
    expect(registry.projects[0]?.profileId).toBe(registry.profiles[0]?.id);
    expect(registry.profiles[0]?.roles.maxParallelChildren).toBe(5);
    expect(registry.profiles[0]?.roles.executor?.primary.effort).toBe("high");
  });

  it("clears a pending custom model when the route changes after remount", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.profiles[0]!.roles.executor = { primary: { engine: "claude" } };
    const bridge = installBridge(initial);
    useTabsStore.setState({ availableEngines: ["claude", "codex"] });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    await mount();
    const model = container.querySelector<HTMLSelectElement>('[aria-label="executor primary model"]')!;
    await act(async () => { model.value = "custom"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="executor primary custom model"]')!, "old-model"));
    await click(buttonByText("Save roles"));
    await act(async () => root?.render(createElement("div")));
    await act(async () => root?.render(createElement(RolesPane)));
    expect(buttonByText("Save roles").disabled).toBe(true);
    await act(async () => { release(); await waiting; });
    const route = container.querySelector<HTMLSelectElement>('[aria-label="executor primary route"]')!;
    await act(async () => { route.value = "engine:codex"; route.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles.executor?.primary).toEqual({ engine: "codex" });
  });

  it("keeps a clean implicit draft when readiness changes", async () => {
    const initial = cloneDefaults();
    initial.roleProfiles = { profiles: [], activeId: "missing", projects: [] };
    installBridge(initial);
    await mount();
    const route = () => container.querySelector<HTMLSelectElement>('[aria-label="executor primary route"]')!;
    expect(route().value).toBe("engine:claude");
    await act(async () => { useTabsStore.setState({ availableEngines: ["claude", "codex"] }); });
    expect(route().value).toBe("engine:claude");
  });

  it("preserves a pending cap when a remounted pane waits before a role edit", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.profiles[0]!.roles.executor = { primary: { provider: "vendor", model: "custom" } };
    const bridge = installBridge(initial);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    await mount();
    await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!, "5"));
    await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="executor primary custom model"]')!, "first-model"));
    await click(buttonByText("Save roles"));
    await act(async () => root?.render(createElement("div")));
    await act(async () => root?.render(createElement(RolesPane)));
    expect(buttonByText("Save roles").disabled).toBe(true);
    expect(container.textContent).toContain("Saving…");
    await act(async () => { release(); await waiting; });
    const effort = container.querySelector<HTMLSelectElement>('[aria-label="executor primary effort"]')!;
    await act(async () => { effort.value = "high"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(buttonByText("Save roles"));
    expect(bridge.current().roleProfiles?.profiles[0]?.roles).toEqual({ executor: { primary: { provider: "vendor", model: "first-model", effort: "high" } }, maxParallelChildren: 5 });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!.value).toBe("5");
  });

  it("refreshes a clean remounted pane when the pending write lands", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    await mount();
    await act(async () => type(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!, "5"));
    await click(buttonByText("Save roles"));
    await act(async () => root?.render(createElement("div")));
    await act(async () => root?.render(createElement(RolesPane)));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!.value).toBe("");
    await act(async () => { release(); await waiting; });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Max parallel children"]')!.value).toBe("5");
  });

  it("blocks registry controls across mounts until the write finishes", async () => {
    const initial = settingsWithProfile("Team");
    initial.roleProfiles!.projects = [{ projectRoot: "/one", profileId: "p" }, { projectRoot: "/two", profileId: "p" }];
    const bridge = installBridge(initial);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const original = bridge.set.getMockImplementation()!;
    bridge.set.mockImplementationOnce(async (patch) => { await waiting; return original(patch); });
    await mount();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove profile for /one"]')!);
    await act(async () => root?.render(createElement("div")));
    await act(async () => root?.render(createElement(RolesPane)));
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove profile for /two"]')!;
    expect(remove.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Project to add"]')!.disabled).toBe(true);
    expect(bridge.set).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await waiting; });
    await click(remove);
    expect(bridge.set).toHaveBeenCalledTimes(2);
    expect(bridge.current().roleProfiles?.projects).toEqual([]);
  });
});

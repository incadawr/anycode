// @vitest-environment jsdom
/**
 * Settings → Roles, mounted in a DOM and driven the way a user drives it.
 *
 * - Create/Duplicate must not treat the name prefill as a name the user typed:
 *   clicking them repeatedly without typing yields distinct names, while a
 *   typed name is still used verbatim.
 * - The pane's own save must surface its feedback in the actions row (a test
 *   that injects a notice into the dialog directly cannot see that wire break).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolesPane } from "./RolesPane.js";
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

describe("Create/Duplicate without typing a name", () => {
  it("four repeated clicks yield four distinct names", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();

    await click(buttonByText("Create profile"));
    await click(buttonByText("Create profile"));
    await click(buttonByText("Duplicate profile"));
    await click(buttonByText("Duplicate profile"));

    const names = profileNames(bridge.current());
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(names).toEqual(["Team", "Profile 1", "Profile 2", "Profile 2 copy", "Profile 2 copy 2"]);
    // The visible option list agrees with what was persisted (a profile is
    // active, so the built-in defaults are not offered here).
    const options = [...container.querySelectorAll('[aria-label="Global role profile"] option')].map((option) => option.textContent);
    expect(options).toEqual(names);
  });

  it("a typed name is still used as typed", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Profile name"]')!;
    await act(async () => type(input, "Reviewers"));

    await click(buttonByText("Create profile"));

    expect(profileNames(bridge.current())).toEqual(["Team", "Reviewers"]);
  });
});

describe("Save from the pane", () => {
  it("shows the save feedback from the pane's own save path inside the actions row", async () => {
    const bridge = installBridge(settingsWithProfile("Team"));
    await mount();

    await click(buttonByText("Save roles"));

    expect(bridge.set).toHaveBeenCalled();
    const actions = container.querySelector(".role-picker-actions");
    expect(actions?.textContent).toContain("Roles saved.");
    expect(actions?.querySelector('[role="status"]')).not.toBeNull();
    // The persisted profile is the selected one, not a fresh "default" row.
    expect(profileNames(bridge.current())).toEqual(["Team"]);
    expect(bridge.current().roleProfiles?.activeId).toBe("p");
  });
});

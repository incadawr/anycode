// @vitest-environment jsdom
/**
 * The first-run role dialog, mounted in a DOM and driven the way a user drives
 * it: chips are CLICKED, and readiness/connection values change while the
 * dialog stays open.
 *
 * This is the counterpart to RolesPane.render.test.ts's static-markup checks —
 * those never run effects, so they cannot see a draft that refuses to follow a
 * late engine list, a click that a later readiness change overwrites, or a new
 * active connection that never reaches the routes.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolePickerDialog, type RolePickerDialogProps } from "./RolePickerDialog.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { cloneDefaults } from "../../../settings/schema.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

const originalSnapshot = useSettingsStore.getState().snapshot;
const originalEngines = useTabsStore.getState().availableEngines;
const originalTabs = useTabsStore.getState().tabs;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  const snapshot: SettingsSnapshot = {
    settings: cloneDefaults(),
    secrets: [],
    providerReady: true,
    envOverrides: [],
    readOnly: false,
    catalog: [],
  };
  useSettingsStore.setState({ snapshot, notice: null });
  useTabsStore.setState({ availableEngines: ["core"], tabs: [], codexModels: [] });
  Object.defineProperty(window, "anycode", {
    configurable: true,
    value: {
      codex: { recheck: vi.fn(async () => ({ report: { status: "unavailable" } })) },
      onEnginesChanged: vi.fn(() => () => {}),
    },
  });
});

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  useSettingsStore.setState({ snapshot: originalSnapshot, notice: null });
  useTabsStore.setState({ availableEngines: originalEngines, tabs: originalTabs });
});

type Overrides = Partial<Pick<RolePickerDialogProps, "open" | "activeConnectionId" | "engines" | "initialRoles">>;

async function mount(overrides: Overrides = {}): Promise<void> {
  root = createRoot(container);
  const props: RolePickerDialogProps = {
    open: true,
    inline: true,
    connections: [],
    activeConnectionId: "conn-1",
    onSave: () => {},
    onSkip: () => {},
    ...overrides,
  };
  await act(async () => {
    root?.render(createElement(RolePickerDialog, props));
  });
}

/** Re-render the SAME mounted dialog with changed props (readiness/connection arriving late). */
async function rerender(overrides: Overrides = {}): Promise<void> {
  const props: RolePickerDialogProps = {
    open: true,
    inline: true,
    connections: [],
    activeConnectionId: "conn-1",
    onSave: () => {},
    onSkip: () => {},
    ...overrides,
  };
  await act(async () => {
    root?.render(createElement(RolePickerDialog, props));
  });
}

function activeChip(): string | undefined {
  const chip = container.querySelector(".role-picker-preset-chip-active");
  return chip?.getAttribute("data-testid") ?? undefined;
}

function orchestratorRoute(): string | undefined {
  const row = container.querySelector('[data-testid="role-picker-role-orchestrator"]');
  return row?.querySelector<HTMLSelectElement>('select[aria-label="Primary route"]')?.value;
}

function click(testId: string): void {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`no element ${testId}`);
  act(() => {
    element.click();
  });
}

describe("readiness arrives while the dialog is open", () => {
  it("follows the shell's engine list: a signed-in engine replaces the current-connection default", async () => {
    await mount({ engines: undefined });
    expect(activeChip()).toBe("role-preset-this-connection");
    expect(orchestratorRoute()).toBe("connection:conn-1");

    act(() => {
      useTabsStore.getState().setAvailableEngines(["core", "claude", "codex"]);
    });

    // The seeded draft is replaced by the best route that actually works, and
    // the chip says so.
    expect(orchestratorRoute()).toBe("engine:claude");
    expect(activeChip()).toBe("role-preset-claude-leads-codex-builds");
  });

  it("still follows after the caller flips open, even if the props moved while it was closed", async () => {
    // Composer/StartScreen keep the dialog mounted closed and flip `open` when
    // the user acts; the active connection may change while it sits closed. The
    // seed written on open must survive that commit instead of looking like an
    // edit.
    await mount({ open: false, activeConnectionId: "conn-1" });
    await rerender({ open: false, activeConnectionId: "conn-2" });
    await rerender({ open: true, activeConnectionId: "conn-2" });
    expect(orchestratorRoute()).toBe("connection:conn-2");

    act(() => {
      useTabsStore.getState().setAvailableEngines(["core", "claude", "codex"]);
    });

    expect(orchestratorRoute()).toBe("engine:claude");
    expect(activeChip()).toBe("role-preset-claude-leads-codex-builds");
  });

  it("leaves a draft the user edited alone", async () => {
    await mount({ engines: { claudeReady: false, codexReady: false } });
    const orchestrator = container.querySelector('[data-testid="role-picker-role-orchestrator"]');
    const route = orchestrator?.querySelector<HTMLSelectElement>('select[aria-label="Primary route"]');
    act(() => {
      route!.value = "engine:claude";
      route!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(orchestratorRoute()).toBe("engine:claude");

    await rerender({ engines: { claudeReady: true, codexReady: true } });
    expect(orchestratorRoute()).toBe("engine:claude");
    expect(activeChip()).toBeUndefined();
  });
});

describe("an explicit preset pick is the user's answer", () => {
  it("is not replaced when another engine becomes ready afterwards", async () => {
    await mount({ engines: { claudeReady: true, codexReady: false } });
    // "All Claude" is the applicable seed here; the user picks the connection
    // route instead.
    expect(activeChip()).toBe("role-preset-all-claude");
    click("role-preset-this-connection");
    expect(activeChip()).toBe("role-preset-this-connection");

    await rerender({ engines: { claudeReady: true, codexReady: true } });
    expect(orchestratorRoute()).toBe("connection:conn-1");
    expect(activeChip()).toBe("role-preset-this-connection");
  });
});

describe("the active connection changes while the dialog is open", () => {
  it("re-seeds an untouched draft even though the preset stays 'Current connection'", async () => {
    await mount({ engines: { claudeReady: false, codexReady: false } });
    expect(orchestratorRoute()).toBe("connection:conn-1");

    await rerender({ engines: { claudeReady: false, codexReady: false }, activeConnectionId: "conn-2" });

    expect(orchestratorRoute()).toBe("connection:conn-2");
    expect(activeChip()).toBe("role-preset-this-connection");
  });
});

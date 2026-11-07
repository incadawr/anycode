/**
 * RENDERED regression for the START SCREEN's draft effort menu. The menu-level
 * test (EngineControls.mounted.test.ts) builds its own effort props; this one
 * mounts the REAL StartScreen on a Codex draft, so the props this screen
 * actually hands the shared menu are the ones under test. A draft has no live
 * session and therefore no applied model reading: its single source of truth
 * is the draft's own pick (`draft.engineEffort`), which the screen passes as
 * `effort.selected` — and ONLY when such a pick exists. The effort page must
 * tick that level (closing the menu with nothing ticked hides a choice the host
 * will honour on the first turn), while a draft that has stored nothing must
 * read as `Default` with no tick: any level clicked then, INCLUDING the first
 * advertised one, is a real change that has to be stored and sent, not
 * swallowed as "already selected".
 */
// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchExternalEngines } from "../engine-availability.js";
import { StartScreen } from "./StartScreen.js";
import { useTabsStore } from "../tabs-store.js";
import { useSettingsStore } from "../settings-store.js";
import { cloneDefaults } from "../../../settings/schema.js";
import { tabRegistry } from "../tab-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Codex draft catalog shape the doctor hands back (per-model vocabulary). */
const CODEX_MODELS = [{ id: "gpt-6.1-terra", label: "Terra", efforts: ["low", "medium", "high", "xhigh"] }];

/**
 * Minimal preload bridge: the channels StartScreen subscribes to on mount
 * (session recents, the engine list, the Codex draft catalog and profile chip)
 * plus the one create call the Send button makes.
 */
function stubBridge(): void {
  const bridge = {
    platform: "darwin",
    listSessions: () => Promise.resolve([]),
    listAvailableEngines: () => Promise.resolve({ engineIds: ["core", "codex", "claude"] }),
    onEnginesChanged: () => () => {},
    pickWorkspace: () => Promise.resolve({ picked: null }),
    createTab: () => Promise.resolve({ ok: true, tabId: "t1", workspace: "/ws" }),
    codex: {
      recheck: () => Promise.resolve({ report: { status: "ready", models: CODEX_MODELS } }),
      listProfiles: () => Promise.resolve({ profiles: [] }),
    },
  };
  (window as unknown as { anycode: unknown }).anycode = bridge;
}

beforeEach(() => {
  stubBridge();
  useTabsStore.setState({
    draft: { workspace: "/ws", prompt: "", engine: "codex", model: null, mode: "build" },
    draftActive: true,
    availableEngines: ["core", "codex", "claude"],
    claudeOrchestrateEnabled: false,
    codexModels: [], claudeModels: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  useTabsStore.setState({ draft: null, draftActive: false, codexModels: [], claudeModels: [] });
});

async function mountStartScreen(): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(StartScreen, { onToast: () => {} }));
  });
  // The draft catalog arrives through the codex lifecycle effect; one settled
  // tick is enough for its already-resolved reply to land in the store.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

it.each(["core", "codex"] as const)("hides the project hint while the %s model menu is open and restores it on close", async (engine) => {
  if (engine === "core") {
    const settings = cloneDefaults();
    settings.provider.activeConnectionId = "c";
    settings.provider.connections = [{ id: "c", providerId: "custom:test", model: "m" }];
    useSettingsStore.setState({ snapshot: { settings, readOnly: false, secrets: [], envOverrides: [], providerReady: true, catalog: [] } });
    useTabsStore.setState({ draft: { workspace: "/ws", prompt: "", engine: "core", model: null, mode: "build" } });
  }
  const path = existsSync("apps/desktop/src/renderer/src/app.css") ? "apps/desktop/src/renderer/src/app.css" : "src/renderer/src/app.css";
  const rule = readFileSync(path, "utf8").match(/\.start-screen:has\(\[role="menu"\]\) \.start-project-hint,[\s\S]*?\{\s*display:\s*none;\s*\}/)?.[0];
  expect(rule).toBeDefined();
  const style = document.createElement("style"); style.textContent = rule!; document.head.append(style);
  const { container, root } = await mountStartScreen();
  try {
    const hint = container.querySelector<HTMLElement>(".start-project-hint")!;
    expect(hint).not.toBeNull();
    expect(getComputedStyle(hint).display).not.toBe("none");
    const chip = container.querySelector<HTMLButtonElement>(engine === "core" ? ".start-model > button" : 'button[aria-label="Engine model and effort"]')!;
    await act(async () => chip.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(getComputedStyle(hint).display).toBe("none");
    await act(async () => chip.click());
    expect(getComputedStyle(hint).display).not.toBe("none");
  } finally { await act(async () => root.unmount()); style.remove(); useSettingsStore.setState({ snapshot: null }); }
});

/** Opens the native menu and walks to its effort page. */
async function openEffortPage(container: HTMLElement): Promise<HTMLElement> {
  const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
  expect(chip, "the Codex draft must render the native model menu").not.toBeNull();
  await act(async () => chip!.click());

  const rootPage = container.querySelector<HTMLElement>('[data-model-pill-page="root"]');
  expect(rootPage, "the menu root page must open").not.toBeNull();
  const effortRow = [...rootPage!.querySelectorAll<HTMLButtonElement>("button.model-pill-row")]
    .find((button) => button.querySelector(".model-pill-row-name")?.textContent === "Effort");
  expect(effortRow, "the effort row must be offered for a model with a vocabulary").toBeDefined();
  await act(async () => effortRow!.click());

  const page = container.querySelector<HTMLElement>('[data-model-pill-page="effort"]');
  expect(page, "the effort page must open").not.toBeNull();
  return page!;
}

function checkedLevels(page: HTMLElement): string[] {
  return [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
    .filter((item) => item.getAttribute("aria-checked") === "true")
    .map((item) => item.getAttribute("data-effort") ?? "");
}

describe("StartScreen — Codex draft effort menu", () => {
  it("ticks the level the draft already carries", async () => {
    // The draft was reopened with a pick made earlier in the same session
    // (`engineEffort`). Nothing else knows that value: the menu only sees what
    // this screen passes, so the tick must follow the draft.
    useTabsStore.setState({
      draft: { workspace: "/ws", prompt: "", engine: "codex", model: null, mode: "build", engineEffort: "xhigh" },
    });
    const { container, root } = await mountStartScreen();
    try {
      const page = await openEffortPage(container);
      const items = [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")];
      expect(items.map((item) => item.getAttribute("data-effort"))).toEqual(["low", "medium", "high", "xhigh"]);
      // Exactly one tick, on the carried level — never on a default the user
      // did not choose.
      expect(checkedLevels(page)).toEqual(["xhigh"]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("ticks nothing and reads Default while the draft has no pick of its own", async () => {
    const { container, root } = await mountStartScreen();
    try {
      // The chip is the honest summary: the draft stores nothing, so the first
      // turn runs at the host's default. Claiming the first advertised level
      // here is what made clicking it a no-op.
      const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
      expect(chip?.textContent).toContain("Default");

      const page = await openEffortPage(container);
      expect(checkedLevels(page)).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("stores the FIRST advertised level when the draft has no pick yet, and sends it on the first turn", async () => {
    // Regression: the draft hands the menu no `selected`, so the first level
    // in the vocabulary is NOT a pre-selection. Clicking it has to reach the
    // draft store — and then the first turn — exactly like any other level.
    const queueInitialPrompt = vi.spyOn(tabRegistry, "queueInitialPrompt");
    const { container, root } = await mountStartScreen();
    try {
      const page = await openEffortPage(container);
      const first = page.querySelector<HTMLButtonElement>('button.model-pill-item[data-effort="low"]');
      expect(first, "the first advertised level must be offered").not.toBeNull();
      await act(async () => first!.click());

      expect(useTabsStore.getState().draft?.engineEffort).toBe("low");

      // The same value rides the first turn: the Send button's own path
      // (submitStartDraft) is what queues it, so drive that button.
      await act(async () => useTabsStore.getState().setDraftPrompt("hello"));
      const send = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Send"]')]
        .find((button) => !button.disabled);
      expect(send, "the draft must be sendable once it has a prompt").toBeDefined();
      await act(async () => {
        send!.click();
        await Promise.resolve();
      });

      expect(queueInitialPrompt).toHaveBeenCalledTimes(1);
      // Non-core drafts queue (tabId, text, model, mode, effort, images).
      expect(queueInitialPrompt.mock.calls[0]?.[4]).toBe("low");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("moves the tick to a freshly picked level", async () => {
    const { container, root } = await mountStartScreen();
    try {
      const page = await openEffortPage(container);

      const high = [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
        .find((item) => item.getAttribute("data-effort") === "high")!;
      await act(async () => high.click());
      expect(useTabsStore.getState().draft?.engineEffort).toBe("high");

      // The pick is now the draft's value: reopening the page ticks it, so the
      // choice is visible rather than silently reset to Default.
      const reopened = await openEffortPage(container);
      expect(checkedLevels(reopened)).toEqual(["high"]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("StartScreen — Claude draft effort menu", () => {
  it("offers no effort page at all, because the draft catalog declares no levels", async () => {
    // Without a confirmed catalog, the fallback has no effort vocabulary.
    useTabsStore.setState({
      draft: { workspace: "/ws", prompt: "", engine: "claude", model: null, mode: "build", engineEffort: "high" },
    });
    const { container, root } = await mountStartScreen();
    try {
      const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
      expect(chip, "the Claude draft must render the native model menu").not.toBeNull();
      await act(async () => chip!.click());

      const rootPage = container.querySelector<HTMLElement>('[data-model-pill-page="root"]');
      expect(rootPage, "the menu root page must open").not.toBeNull();
      const rowNames = [...rootPage!.querySelectorAll(".model-pill-row-name")].map((name) => name.textContent);
      expect(rowNames).toEqual(["Model"]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});


it("shows no selected effort for an untouched core draft with a custom vocabulary", async () => {
  const settings = cloneDefaults();
  settings.provider.activeConnectionId = "c";
  settings.provider.connections = [{ id:"c", providerId:"custom:test", iconText:"XY", model:"unknown", modelOverrides:{unknown:{effortLevels:["low", "high"]}} }];
  useSettingsStore.setState({ snapshot: {settings, readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[]} });
  useTabsStore.setState({ draft: {workspace:"/ws", prompt:"", engine:"core", model:null, mode:"build"} });
  const { container, root } = await mountStartScreen();
  try {
    const chip = container.querySelector<HTMLButtonElement>("button.model-pill-chip")!;
    expect(chip.querySelector(".connection-icon")?.textContent).toBe("XY");
    expect(chip.textContent).not.toMatch(/low|high/i);
    await act(async () => chip.click());
    const effort = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Effort"))!;
    await act(async () => effort.click());
    const page = container.querySelector<HTMLElement>('[data-level="effort"]')!;
    expect(page.textContent).toContain("Low");
    expect(page.textContent).toContain("High");
    expect(page.querySelector('[aria-checked="true"]')).toBeNull();
  } finally { await act(async () => root.unmount()); useSettingsStore.setState({snapshot:null}); }
});


it.each([undefined, false, true])("gates Claude draft intent on the main flag %s", async enabled => {
  useTabsStore.setState({ availableEngines: ["core", "claude"], claudeOrchestrateEnabled: enabled === true });
  useTabsStore.setState({ draft: { workspace: "/ws", prompt: "task", engine: "claude", model: null, mode: "build" } });
  const settings = cloneDefaults();
  settings.roles = {};
  useSettingsStore.setState({ snapshot: { settings, readOnly: false, secrets: [], envOverrides: [], providerReady: true, catalog: [] } });
  const { container, root } = await mountStartScreen();
  try {
    const toggle = container.querySelector<HTMLButtonElement>(".orchestrate-toggle");
    expect(toggle !== null).toBe(enabled === true);
    if (toggle) {
      await act(async () => toggle.click());
      expect(useTabsStore.getState().draft?.orchestrate).toBe(true);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    }
  } finally { await act(async () => root.unmount()); useSettingsStore.setState({ snapshot: null }); }
});

it("shows external engine choices and Codex toggle when mounted with the shell watcher", async () => {
  useTabsStore.setState({ availableEngines: ["core"] });
  function Shell() {
    useEffect(() => watchExternalEngines(window.anycode, () => {}), []);
    return createElement(StartScreen, { onToast: () => {} });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Shell)); });
    expect([...container.querySelectorAll(".start-engine-choice")].map(b => b.textContent)).toEqual(["AnyCode", "Codex", "Claude"]);
    expect(container.querySelector('button[aria-label="Orchestrate: request orchestration when the session starts"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it("renders the confirmed cached Claude model and its effort vocabulary before starting", async () => {
  const models = [{ id: "account-model", label: "Account model 6.0", efforts: ["high"] }];
  window.anycode.claude = {
    recheck: async () => ({ report: { status: "ready", models } }),
    onSnapshotChanged: () => () => {},
  } as unknown as typeof window.anycode.claude;
  useTabsStore.setState({ draft: { workspace: "/ws", prompt: "", engine: "claude", model: "account-model", mode: "build" } });
  const { container, root } = await mountStartScreen();
  try {
    expect(container.textContent).toContain("Account model 6.0");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]')!.click());
    expect(container.textContent).toContain("Effort");
  } finally { await act(async () => root.unmount()); }
});

it.each([null, "gpt-other"])("shows CLI default for an unmatched Claude draft %s", async (model) => {
  useTabsStore.getState().setClaudeModels([{ id: "opus", label: "Pinned Opus" }]);
  useTabsStore.setState({ draft: { workspace: "/ws", prompt: "", engine: "claude", model, mode: "build" } });
  const { container, root } = await mountStartScreen();
  try {
    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
    expect(chip?.textContent).toContain("CLI default");
    expect(chip?.textContent).not.toContain("Pinned Opus");
  } finally { await act(async () => root.unmount()); }
});

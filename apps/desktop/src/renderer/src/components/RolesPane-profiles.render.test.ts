/**
 * Settings → Roles profile controls, rendered from a real settings snapshot:
 * - B4 regression: once any profile existed the global select lost "Built-in
 *   defaults", so there was no way back to the built-ins; the name field was
 *   a dead box for Rename (created profiles fell back to a shared "New
 *   profile" name).
 * - B7 regression: the Project select labelled options with the full absolute
 *   path instead of the folder name.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RolesPane } from "./RolesPane.js";
import { useSettingsStore } from "../settings-store.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";

// SSR uses Zustand's initial snapshot; read the fixture state directly so every
// render sees the snapshot this file installed.
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

const originalSnapshot = useSettingsStore.getState().snapshot;
afterEach(() => useSettingsStore.setState({ snapshot: originalSnapshot }));

const withProfile = {
  settings: {
    version: 2,
    provider: { connections: [] },
    roleProfiles: { activeId: "p", profiles: [{ id: "p", name: "Profile 1", roles: {} }], projects: [] },
    tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
  },
  secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [],
} satisfies SettingsSnapshot;

describe("Global role profile always offers the built-in defaults", () => {
  it("renders Built-in defaults as an option while a custom profile is active, and seeds the name field", () => {
    useSettingsStore.setState({ snapshot: withProfile });
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).toContain('<option value="">Built-in defaults</option>');
    expect(html).toContain('<option value="p" selected="">Profile 1</option>');
    // The name field follows the selection, so Rename starts from the current
    // name instead of an empty box (canRenameProfile covers the enable rule).
    expect(html).toContain('aria-label="Profile name" value="Profile 1"');
  });
});

describe("Project options show the folder name", () => {
  const snapshot = {
    settings: {
      version: 2,
      provider: { connections: [] },
      roleProfiles: {
        activeId: "p",
        profiles: [{ id: "p", name: "Profile 1", roles: {} }],
        projects: [{ projectRoot: "/private/tmp/anycode-live/uiux-b/ws", profileId: "p" }],
      },
      tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
    },
    secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [],
  } satisfies SettingsSnapshot;

  it("labels the option with the folder name and keeps the path as its tooltip", () => {
    useSettingsStore.setState({ snapshot });
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).toContain('<option value="/private/tmp/anycode-live/uiux-b/ws" title="/private/tmp/anycode-live/uiux-b/ws">ws</option>');
    expect(html).not.toContain('>/private/tmp/anycode-live/uiux-b/ws</option>');
  });
});

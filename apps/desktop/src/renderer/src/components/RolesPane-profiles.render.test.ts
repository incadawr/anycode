/**
 * Settings → Roles profile controls, rendered from a real settings snapshot:
 * - B4: the profile name field follows the selection, so Rename starts from the
 *   current name instead of a dead empty box.
 * - The global select offers "Built-in defaults" only while no profile is
 *   active — it is not a selectable target next to saved profiles.
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

describe("Global role profile select", () => {
  it("shows only saved profiles while one is active and seeds the name field", () => {
    useSettingsStore.setState({ snapshot: withProfile });
    const html = renderToStaticMarkup(createElement(RolesPane));
    // With a profile active the built-in defaults are not a selectable target.
    expect(html).not.toContain('<option value="">Built-in defaults</option>');
    expect(html).toContain('<option value="p" selected="">Profile 1</option>');
    // The name field follows the selection, so Rename starts from the current
    // name instead of an empty box (canRenameProfile covers the enable rule).
    expect(html).toContain('aria-label="Profile name" value="Profile 1"');
  });

  it("still offers the built-in defaults while no saved profile is active", () => {
    useSettingsStore.setState({
      snapshot: {
        ...withProfile,
        // A dangling activeId (the profile it named is gone): nothing is
        // selected, so the select states that the built-ins are in effect.
        settings: { ...withProfile.settings, roleProfiles: { ...withProfile.settings.roleProfiles, activeId: "gone" } },
      },
    });
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).toContain('<option value="" selected="">Built-in defaults</option>');
    expect(html).toContain('<option value="p">Profile 1</option>');
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

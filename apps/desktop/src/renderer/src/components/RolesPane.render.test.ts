/**
 * Settings → Roles used to mount the role editor as a native modal
 * (`showModal`) that never closed: the whole window went inert ("frozen")
 * with no way back. The pane must render the editor inline; the first-run
 * picker stays a modal.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RolePickerDialog } from "./RolePickerDialog.js";
import { RolesPane, RolesSaveNotice } from "./RolesPane.js";
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
    expect(html).toContain("role-picker-inline");
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
    expect(html).toContain('aria-label="Primary custom model"');
    expect(html).toContain('value="saved-unknown"');
    expect(html).toContain('<option value="model:1" selected="">live-model</option>');
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
  expect(html).toContain('value="connection:d">d</option>');
  expect(html).toContain('value="connection:active" selected="">Session&#x27;s connection</option>');
  expect(html).toContain('>Current connection</button>');
  expect(html).not.toContain('>This connection</');
});

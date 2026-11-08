// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import { AccountBudgetCard } from "./AccountBudgetCard.js";

const data = vi.hoisted(() => ({ sources: {} as any, settings: {} as any }));
vi.mock("../account-sources-store.js", () => ({ startAccountSourcesStore: () => () => {}, useAccountSourcesStore: () => data.sources }));
vi.mock("../settings-store.js", () => ({ useSettingsStore: (selector: (value: unknown) => unknown) => selector(data.settings) }));
vi.mock("./ConnectionDrawer.js", () => ({ ConnectionDrawer: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows approved models and prices in the expanded source", async () => {
  const settings = cloneDefaults();
  settings.plugins = { accountSources: [{ plugin: "company", source: "cluster", descriptorHash: "a".repeat(64), connectionId: "conn", accountId: "a", ownership: {} }] };
  data.settings = { snapshot: { settings }, load: vi.fn() };
  data.sources = { candidates: [], load: vi.fn(), snapshot: { revision: 1, sources: [{ key: { plugin: "company", source: "cluster" }, displayName: "Company", status: "ready" }], catalogs: [{ connectionId: "conn", models: [{ id: "free", billing: "free" }, { id: "paid", billing: "metered", ratesMicrosPerMillionTokens: { input: "1000000", output: "2500000" } }, { id: "unknown", billing: "metered" }] }] } };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(AccountBudgetCard, { collapsed: false, onSettings: vi.fn() })));
    expect(container.textContent).not.toContain("paid");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Employee budget"]')!.click());
    expect(container.textContent).toContain("free · Free");
    expect(container.textContent).toContain("paid · $1 input / $2.5 output per 1M");
    expect(container.textContent).toContain("unknown · Price unknown");
  } finally { await act(async () => root.unmount()); }
});

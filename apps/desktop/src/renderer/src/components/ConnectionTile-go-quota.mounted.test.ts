// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionTile } from "./ConnectionTile.js";
import type { ProviderConnection } from "../../../shared/settings.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("shows all Go windows and hides them when the cache clears", async () => {
  const connection: ProviderConnection = { id: "a", providerId: "opencode", lastGoQuota: { observedAt: new Date().toISOString(), windows: { rolling: { usedPercent: 12, resetsAt: Date.now() / 1000 + 3600 }, weekly: { usedPercent: 5 }, monthly: { usedPercent: 2 } } } };
  const props = { connection, catalogEntry: undefined, displayName: "Go", credentialStatus: undefined, selected: false, checking: false, readOnly: false, tabIndex: 0, onSelect: vi.fn(), onEdit: vi.fn(), onReplaceKey: vi.fn(), onCheck: vi.fn(), onDelete: vi.fn(), onKeyDownRoving: vi.fn() };
  const element = document.createElement("div"); const root = createRoot(element);
  await act(async () => root.render(createElement(ConnectionTile, props)));
  expect(element.textContent).toContain("5h · 12% used"); expect(element.textContent).toContain("Weekly · 5% used"); expect(element.textContent).toContain("Monthly · 2% used"); expect(element.querySelector(".go-quota-row")?.getAttribute("title")).toContain("Resets");
  await act(async () => root.render(createElement(ConnectionTile, { ...props, connection: { ...connection, lastGoQuota: undefined } })));
  expect(element.querySelector(".go-quota")).toBeNull(); await act(async () => root.unmount());
});

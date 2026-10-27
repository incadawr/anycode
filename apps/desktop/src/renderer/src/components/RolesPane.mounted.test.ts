// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RolesPane, type RolesPaneProps } from "./RolesPane.js";

const list = vi.fn();
Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: vi.fn(async () => []), subagents: { list } } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); list.mockReset(); });

it("loads the scoped profile override and removes its notice after a fresh lookup", async () => {
  list.mockResolvedValueOnce({ rows: [{ name: "reviewer", sourceKind: "project", path: "/ws/.anycode/agents/reviewer.md" }], problems: [] })
    .mockResolvedValueOnce({ rows: [], problems: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(RolesPane as React.ComponentType<RolesPaneProps>, { tabId: "first" })); });
  expect(list).toHaveBeenCalledWith({ tabId: "first" });
  expect(container.querySelector('[data-testid="role-route-overridden-reviewer"]')?.textContent).toContain("/ws/.anycode/agents/reviewer.md");
  await act(async () => { root.render(createElement(RolesPane as React.ComponentType<RolesPaneProps>, { tabId: "second" })); });
  expect(list).toHaveBeenCalledWith({ tabId: "second" });
  expect(container.querySelector('[data-testid="role-route-overridden-reviewer"]')).toBeNull();
  await act(async () => root.unmount());
});

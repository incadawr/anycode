// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionTile } from "./ConnectionTile.js";
vi.mock("./Sidebar.js", () => ({ formatAge: () => "just now" }));
vi.mock("./Composer.js", () => ({ quotaWindowLabel: () => "Usage" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each(["opencode", "anthropic"])("renders Check availability and a keyboard-readable reason for %s", async providerId => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCheck = vi.fn();
  const noop = () => {};
  try {
    await act(async () => root.render(createElement(ConnectionTile, {
      connection: { id: "go", providerId }, displayName: "Provider", catalogEntry: undefined,
      credentialStatus: { key: "provider.connection.go.apiKey", set: true, source: "vault", tier: "os_encrypted" },
      selected: false, checking: false, readOnly: false, tabIndex: 0,
      onSelect: noop, onEdit: noop, onReplaceKey: noop, onCheck, onDelete: noop, onKeyDownRoving: noop,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
    const check = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === "Check")!;
    expect(check.disabled).toBe(providerId !== "opencode");
    if (providerId !== "opencode") {
      expect(container.querySelector(".connection-tile-check-hint")?.textContent).toContain("No free credential check");
      await act(async () => check.click());
      expect(onCheck).not.toHaveBeenCalled();
    } else {
      await act(async () => check.click());
      expect(onCheck).toHaveBeenCalledOnce();
    }
  } finally { await act(async () => root.unmount()); container.remove(); }
});

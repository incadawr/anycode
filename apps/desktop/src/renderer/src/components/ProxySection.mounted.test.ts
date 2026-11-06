// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ProxyCheckVerdict } from "../../../shared/proxy.js";
import { ProxySection } from "./ProxySection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each<[ProxyCheckVerdict, string, string, boolean?]>([
  ["ok", "settings-notice-ok", "status"],
  ["ok", "settings-notice-neutral", "status", true],
  ["direct", "settings-notice-neutral", "status"],
  ["bypassed_by_no_proxy", "settings-notice-neutral", "status"],
  ["socks_unsupported", "settings-notice-neutral", "status"],
  ["proxy_unreachable", "settings-notice", "alert"],
  ["proxy_auth", "settings-notice", "alert"],
  ["tls", "settings-notice", "alert"],
  ["target_unreachable", "settings-notice", "alert"],
])("presents %s with the appropriate tone and announcement", async (verdict, className, role, shellOverride) => {
  const previous = window.anycode;
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    settings: { proxyCheck: vi.fn().mockResolvedValue({
      ok: true, verdict, shellOverride, targetUrl: "https://api.example.com/", proxyUsed: verdict === "ok",
    }) },
  } });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ProxySection, {
      profile: { id: "proxy", name: "Proxy", mode: "manual", url: "http://proxy.example.com:3128" },
      profiles: [], secrets: [], connections: [], readOnly: false,
      onSaved: () => {}, onCancel: () => {},
    })));
    const check = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Check Connection");
    expect(check).toBeDefined();
    await act(async () => check!.click());
    const notice = Array.from(container.querySelectorAll("p")).find(node => node.textContent?.includes("Target:"));
    expect(notice?.className).toBe(className);
    expect(notice?.getAttribute("role")).toBe(role);
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(window, "anycode", { configurable: true, value: previous });
  }
});

import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { isRendererUrl, protectMainNavigation } from "./main-navigation.js";

describe("main window navigation", () => {
  it("trusts only the renderer document, including its query and fragment", () => {
    expect(isRendererUrl("http://localhost:5173/index.html?q=1#x", "http://localhost:5173/index.html")).toBe(true);
    for (const url of ["http://localhost:5174/index.html", "http://localhost:5173/other", "file:///other", "data:text/html,x", "javascript:alert(1)"]) {
      expect(isRendererUrl(url, "http://localhost:5173/index.html")).toBe(false);
    }
    expect(isRendererUrl("file:///app/index.html?x=1", "file:///app/index.html")).toBe(true);
    expect(isRendererUrl("file:///app/other.html", "file:///app/index.html")).toBe(false);
  });

  it("blocks external navigation and redirects and denies new windows", () => {
    const handlers: Record<string, (event: any) => unknown> = {};
    const wc = { on: (name: string, fn: (event: any) => unknown) => { handlers[name] = fn; }, setWindowOpenHandler: (fn: (event: any) => unknown) => { handlers.open = fn; } };
    const open = vi.fn().mockResolvedValue(undefined);
    protectMainNavigation(wc as unknown as WebContents, "file:///app/index.html", open);
    const navigate = (name: string, url: string, isMainFrame = true) => {
      const event = { url, isMainFrame, preventDefault: vi.fn() };
      handlers[name]!(event);
      return event.preventDefault;
    };
    expect(navigate("will-navigate", "file:///app/index.html?x=1")).not.toHaveBeenCalled();
    expect(navigate("will-navigate", "https://example.com/")).toHaveBeenCalled();
    expect(navigate("will-redirect", "https://example.com/")).toHaveBeenCalled();
    expect(navigate("will-redirect", "https://example.com/", false)).not.toHaveBeenCalled();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      expect(navigate("will-navigate", url)).toHaveBeenCalled();
    }
    for (const url of ["https://example.com/", "http://example.com/", "mailto:a@example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "custom:x"]) {
      expect(handlers.open!({ url })).toEqual({ action: "deny" });
    }
    expect(open.mock.calls.map(([url]) => url)).toEqual(["https://example.com/", "https://example.com/", "http://example.com/", "mailto:a@example.com"]);
  });
});

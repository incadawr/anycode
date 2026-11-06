// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProviderQuotaPoll } from "./provider-quota-poll";

it("polls all or the pinned connection only while visible and cleans up", () => {
  vi.useFakeTimers();
  let visible = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
  const go = vi.fn().mockResolvedValue(undefined); const glm = vi.fn().mockResolvedValue(undefined); const mini = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "anycode", { configurable: true, value: { settings: { refreshOpenCodeGoQuota: go, refreshGlmQuota: glm, refreshMiniMaxQuota: mini } } });
  const el = document.createElement("div"); const root = createRoot(el);
  function Probe({ id }: { id?: string }) { useProviderQuotaPoll(true, id); return null; }
  act(() => root.render(createElement(Probe, {}))); expect(go).toHaveBeenLastCalledWith(undefined);
  act(() => root.render(createElement(Probe, { id: "pinned" }))); expect(go).toHaveBeenLastCalledWith("pinned");
  visible = false; act(() => { vi.advanceTimersByTime(60_000); document.dispatchEvent(new Event("visibilitychange")); }); expect(go).toHaveBeenCalledTimes(2);
  visible = true; act(() => document.dispatchEvent(new Event("visibilitychange"))); expect(go).toHaveBeenCalledTimes(3); expect(glm).toHaveBeenCalledTimes(3); expect(mini).toHaveBeenCalledTimes(3);
  act(() => root.unmount()); act(() => vi.advanceTimersByTime(60_000)); expect(go).toHaveBeenCalledTimes(3);
});
afterEach(() => vi.useRealTimers());

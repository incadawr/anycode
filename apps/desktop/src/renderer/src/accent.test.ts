import { afterEach, expect, it, vi } from "vitest";
import { ACCENTS, ACCENT_KEY, parseAccent, accentAttrValue, readAccent, applyAccent, subscribeAccent, nextAccent, bindAccentStorageSync } from "./accent.js";
afterEach(() => vi.unstubAllGlobals());
it("parses stored accents and derives the root attribute", () => {
  for (const a of ACCENTS) { expect(parseAccent(a)).toBe(a); expect(accentAttrValue(a)).toBe(a === "current" ? null : a); }
  for (const raw of [null, "", "GOLD", "broken"]) expect(parseAccent(raw)).toBe("current");
});
it("reads storage safely and applies without a DOM", () => {
  expect(readAccent()).toBe("current"); expect(() => applyAccent("gold")).not.toThrow();
  vi.stubGlobal("localStorage", { getItem: () => "gold" }); expect(readAccent()).toBe("gold");
  vi.stubGlobal("localStorage", { getItem: () => { throw Error(); } }); expect(readAccent()).toBe("current");
});
it("stamps, removes and notifies with unsubscribe", () => {
  const setAttribute = vi.fn(), removeAttribute = vi.fn(), cb = vi.fn();
  vi.stubGlobal("document", { documentElement: { setAttribute, removeAttribute } });
  const off = subscribeAccent(cb); applyAccent("teal"); expect(setAttribute).toHaveBeenCalledWith("data-accent", "teal");
  applyAccent("current"); expect(removeAttribute).toHaveBeenCalledWith("data-accent"); expect(cb).toHaveBeenCalledTimes(2);
  off(); applyAccent("gold"); expect(cb).toHaveBeenCalledTimes(2);
});
it("navigates every option in both directions with wrapping and endpoints", () => {
  ACCENTS.forEach((a, i) => {
    for (const key of ["ArrowRight", "ArrowDown"]) expect(nextAccent(a, key)).toBe(ACCENTS[(i + 1) % ACCENTS.length]);
    for (const key of ["ArrowLeft", "ArrowUp"]) expect(nextAccent(a, key)).toBe(ACCENTS[(i + ACCENTS.length - 1) % ACCENTS.length]);
    expect(nextAccent(a, "Home")).toBe("current"); expect(nextAccent(a, "End")).toBe("ember");
    for (const key of ["Tab", "Enter", " ", "Escape"]) expect(nextAccent(a, key)).toBeNull();
  });
});
it("syncs only accent storage events and removes its listener", () => {
  const addEventListener = vi.fn(), removeEventListener = vi.fn(), setAttribute = vi.fn(), removeAttribute = vi.fn();
  vi.stubGlobal("document", { documentElement: { setAttribute, removeAttribute } });
  const off = bindAccentStorageSync({ addEventListener, removeEventListener });
  const cb = addEventListener.mock.calls[0]![1] as (e: Pick<StorageEvent, "key" | "newValue">) => void;
  cb({ key: "other", newValue: "gold" }); expect(setAttribute).not.toHaveBeenCalled();
  cb({ key: ACCENT_KEY, newValue: "indigo" }); expect(setAttribute).toHaveBeenCalledWith("data-accent", "indigo");
  for (const newValue of [null, "broken", "current"]) cb({ key: ACCENT_KEY, newValue });
  expect(removeAttribute).toHaveBeenCalledTimes(3); off(); expect(removeEventListener).toHaveBeenCalledWith("storage", cb);
});

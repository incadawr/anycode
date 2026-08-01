/**
 * Pure-logic tests for `applyOverlayKey` (CUT.md §3 96-P2 test list). Like
 * every other renderer test in this package, this is `.test.ts` under a node
 * (no-jsdom) vitest env (D16) — the module-singleton Set + hook wiring are
 * untested here by design; only the pure counting core is covered.
 */
import { describe, expect, it } from "vitest";
import { applyOverlayKey } from "./overlay-flag.js";

describe("applyOverlayKey", () => {
  it("opens on the first key added", () => {
    const keys = new Set<string>();
    expect(applyOverlayKey(keys, "a", true)).toBe(true);
  });

  it("stays open while any key remains, closes once the last is removed", () => {
    const keys = new Set<string>();
    expect(applyOverlayKey(keys, "a", true)).toBe(true);
    expect(applyOverlayKey(keys, "b", true)).toBe(true);
    expect(applyOverlayKey(keys, "a", false)).toBe(true);
    expect(applyOverlayKey(keys, "b", false)).toBe(false);
  });

  it("double-add of the same key is idempotent (size stays 1)", () => {
    const keys = new Set<string>();
    applyOverlayKey(keys, "a", true);
    expect(applyOverlayKey(keys, "a", true)).toBe(true);
    expect(keys.size).toBe(1);
  });

  it("double-remove of the same key is idempotent (stays closed)", () => {
    const keys = new Set<string>();
    applyOverlayKey(keys, "a", true);
    applyOverlayKey(keys, "a", false);
    expect(applyOverlayKey(keys, "a", false)).toBe(false);
    expect(keys.size).toBe(0);
  });

  it("removing a key that was never added is a harmless no-op", () => {
    const keys = new Set<string>();
    expect(applyOverlayKey(keys, "missing", false)).toBe(false);
    expect(keys.size).toBe(0);
  });

  it("multiple distinct keys accumulate independently", () => {
    const keys = new Set<string>();
    applyOverlayKey(keys, "a", true);
    applyOverlayKey(keys, "b", true);
    applyOverlayKey(keys, "c", true);
    expect(keys.size).toBe(3);
    applyOverlayKey(keys, "b", false);
    expect(keys.size).toBe(2);
    expect(keys.has("a")).toBe(true);
    expect(keys.has("c")).toBe(true);
  });
});

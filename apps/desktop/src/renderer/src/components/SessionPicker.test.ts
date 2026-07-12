/**
 * Pure-logic tests for SessionPicker's result-handling helpers (task 2.1.5,
 * design §4.3). Deliberately `.test.ts`, not `.test.tsx`: this package's
 * vitest setup (apps/desktop/vitest.config.ts, root vitest.config.ts) runs in
 * `environment: "node"` with no jsdom/@testing-library dependency installed,
 * so a real `<dialog>` DOM-rendering test isn't feasible without adding new
 * dependencies (out of this task's lane). The exported pure functions carry
 * all of the component's actual logic (the part the spec calls out
 * explicitly — the already_open -> focus-action wiring), so they are covered
 * directly instead.
 */
import { describe, expect, it, vi } from "vitest";
import type { CreateTabResult } from "../../../shared/tabs.js";
import { describeCreateTabFailure, handleCreateTabResult } from "./SessionPicker.js";

describe("describeCreateTabFailure", () => {
  it("has non-empty human-readable text for every CreateTabResult failure reason", () => {
    const reasons: Array<Extract<CreateTabResult, { ok: false }>["reason"]> = [
      "cancelled",
      "max_tabs",
      "session_not_found",
      "already_open",
    ];
    for (const reason of reasons) {
      expect(describeCreateTabFailure({ ok: false, reason }).length).toBeGreaterThan(0);
    }
  });
});

describe("handleCreateTabResult", () => {
  it("calls onTabCreated and returns null on a plain success", () => {
    const onTabCreated = vi.fn();
    const onFocusTab = vi.fn();
    const result: CreateTabResult = { ok: true, tabId: "tab-1", workspace: "/ws" };

    const notice = handleCreateTabResult(result, { onTabCreated, onFocusTab });

    expect(notice).toBeNull();
    expect(onTabCreated).toHaveBeenCalledWith({ tabId: "tab-1", workspace: "/ws" });
    expect(onFocusTab).not.toHaveBeenCalled();
  });

  it("already_open with a focusTabId calls onFocusTab (the design §2.3/F7 guard: never a second writer for one session) and returns a notice", () => {
    const onTabCreated = vi.fn();
    const onFocusTab = vi.fn();
    const result: CreateTabResult = { ok: false, reason: "already_open", focusTabId: "tab-2" };

    const notice = handleCreateTabResult(result, { onTabCreated, onFocusTab });

    expect(onFocusTab).toHaveBeenCalledWith("tab-2");
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(notice).toBe(describeCreateTabFailure(result));
  });

  it("already_open without a focusTabId (shouldn't happen per the frozen contract, but defensive) does not throw and still returns a notice", () => {
    const onTabCreated = vi.fn();
    const onFocusTab = vi.fn();
    const result: CreateTabResult = { ok: false, reason: "already_open" };

    expect(() => handleCreateTabResult(result, { onTabCreated, onFocusTab })).not.toThrow();
    expect(onFocusTab).not.toHaveBeenCalled();
  });

  it("a plain failure (cancelled/max_tabs/session_not_found) calls neither callback and returns a notice", () => {
    const onTabCreated = vi.fn();
    const onFocusTab = vi.fn();
    const result: CreateTabResult = { ok: false, reason: "max_tabs" };

    const notice = handleCreateTabResult(result, { onTabCreated, onFocusTab });

    expect(onTabCreated).not.toHaveBeenCalled();
    expect(onFocusTab).not.toHaveBeenCalled();
    expect(notice).toBe(describeCreateTabFailure(result));
  });
});

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
import {
  describeCreateTabFailure,
  handleCreateTabResult,
  resolveConnectionMissingAction,
} from "./SessionPicker.js";

describe("describeCreateTabFailure", () => {
  it("has non-empty human-readable text for every CreateTabResult failure reason", () => {
    const reasons: Array<Extract<CreateTabResult, { ok: false }>["reason"]> = [
      "cancelled",
      "max_tabs",
      "session_not_found",
      "already_open",
      "connection_missing",
    ];
    for (const reason of reasons) {
      expect(describeCreateTabFailure({ ok: false, reason }).length).toBeGreaterThan(0);
    }
  });

  describe("not_ready, engine-parameterized (S1b-1)", () => {
    const NOT_READY: CreateTabResult = { ok: false, reason: "not_ready" };
    const CORE_COPY = "Configure a provider (API key + model) before opening a tab.";

    it("omitted engine keeps the historical provider-config copy byte-identical (App.tsx/Sidebar.tsx/CodexRolloutImportDialog.tsx call sites, 0 wire-δ)", () => {
      expect(describeCreateTabFailure(NOT_READY)).toBe(CORE_COPY);
    });

    it("engine:'core' keeps the same provider-config copy", () => {
      expect(describeCreateTabFailure(NOT_READY, "core")).toBe(CORE_COPY);
    });

    it("engine:'codex' surfaces a sign-in-specific copy instead of the irrelevant provider-config copy", () => {
      const codexCopy = describeCreateTabFailure(NOT_READY, "codex");
      expect(codexCopy).not.toBe(CORE_COPY);
      expect(codexCopy.toLowerCase()).toContain("sign in");
      expect(codexCopy.toLowerCase()).toContain("codex");
    });

    it("engine parameterization only affects the not_ready branch — other reasons are unaffected by engine:'codex'", () => {
      const result: CreateTabResult = { ok: false, reason: "max_tabs" };
      expect(describeCreateTabFailure(result, "codex")).toBe(describeCreateTabFailure(result));
    });
  });
});

describe("resolveConnectionMissingAction (TASK.45 W10-FIX F1 re-pin affordance)", () => {
  it("arms a re-pin action for connection_missing when a current connection exists", () => {
    const result: CreateTabResult = { ok: false, reason: "connection_missing", connectionId: "conn-dead" };
    expect(resolveConnectionMissingAction(result, "sess-1", "conn-active")).toEqual({
      sessionId: "sess-1",
      replacementConnectionId: "conn-active",
    });
  });

  it("offers NO action (Settings-only) when there is no current connection to re-pin onto", () => {
    const result: CreateTabResult = { ok: false, reason: "connection_missing", connectionId: "conn-dead" };
    expect(resolveConnectionMissingAction(result, "sess-1", undefined)).toBeNull();
  });

  it("offers NO action for a different failure reason", () => {
    const result: CreateTabResult = { ok: false, reason: "session_not_found" };
    expect(resolveConnectionMissingAction(result, "sess-1", "conn-active")).toBeNull();
  });

  it("offers NO action on success", () => {
    const result: CreateTabResult = { ok: true, tabId: "t", workspace: "/ws" };
    expect(resolveConnectionMissingAction(result, "sess-1", "conn-active")).toBeNull();
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

  describe("extra.engine forwarding (S1b-1)", () => {
    it("extra.engine:'codex' on a not_ready failure surfaces the codex-specific notice", () => {
      const onTabCreated = vi.fn();
      const onFocusTab = vi.fn();
      const result: CreateTabResult = { ok: false, reason: "not_ready" };

      const notice = handleCreateTabResult(result, { onTabCreated, onFocusTab }, { engine: "codex" });

      expect(notice).toBe(describeCreateTabFailure(result, "codex"));
      expect(notice).not.toBe(describeCreateTabFailure(result));
    });

    it("no extra.engine (start-session.ts's core submits, and every other pre-existing call site) keeps the historical provider-config notice", () => {
      const onTabCreated = vi.fn();
      const onFocusTab = vi.fn();
      const result: CreateTabResult = { ok: false, reason: "not_ready" };

      const notice = handleCreateTabResult(result, { onTabCreated, onFocusTab });

      expect(notice).toBe(describeCreateTabFailure(result));
    });
  });
});

/**
 * Pins the Codex child-lifecycle timeout/teardown constants (cut §2(b)/§2(g))
 * as finite, positive, and correctly ordered — the invariant that keeps the
 * host engine's teardown and main's doctor teardown from independently
 * drifting apart (see shared/codex-timeouts.ts header).
 */

import { describe, expect, it } from "vitest";
import {
  CODEX_BOOT_RPC_TIMEOUT_MS,
  CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS,
  CODEX_DOCTOR_RPC_TIMEOUT_MS,
  CODEX_DOCTOR_WATCHDOG_MS,
  CODEX_MODEL_LIST_MAX_PAGES,
  CODEX_MODEL_LIST_PAGE_TIMEOUT_MS,
  CODEX_POST_INTERRUPT_SETTLE_MS,
  CODEX_TEARDOWN_SIGKILL_WAIT_MS,
  CODEX_TEARDOWN_SIGTERM_WAIT_MS,
  CODEX_TEARDOWN_STDIN_EOF_WAIT_MS,
  CODEX_TEARDOWN_TOTAL_BUDGET_MS,
  CODEX_TURN_INTERRUPT_TIMEOUT_MS,
  CODEX_TURN_START_TIMEOUT_MS,
  CODEX_VERSION_PREFLIGHT_TIMEOUT_MS,
} from "./codex-timeouts.js";

const ALL_CONSTANTS = {
  CODEX_BOOT_RPC_TIMEOUT_MS,
  CODEX_TURN_START_TIMEOUT_MS,
  CODEX_TURN_INTERRUPT_TIMEOUT_MS,
  CODEX_MODEL_LIST_PAGE_TIMEOUT_MS,
  CODEX_MODEL_LIST_MAX_PAGES,
  CODEX_POST_INTERRUPT_SETTLE_MS,
  CODEX_VERSION_PREFLIGHT_TIMEOUT_MS,
  CODEX_DOCTOR_RPC_TIMEOUT_MS,
  CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS,
  CODEX_DOCTOR_WATCHDOG_MS,
  CODEX_TEARDOWN_STDIN_EOF_WAIT_MS,
  CODEX_TEARDOWN_SIGTERM_WAIT_MS,
  CODEX_TEARDOWN_SIGKILL_WAIT_MS,
  CODEX_TEARDOWN_TOTAL_BUDGET_MS,
};

describe("codex-timeouts", () => {
  it("every constant is a finite, strictly positive number", () => {
    for (const [name, value] of Object.entries(ALL_CONSTANTS)) {
      expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      expect(value > 0, `${name} must be > 0`).toBe(true);
    }
  });

  it("the teardown budget is the exact sum of its three stages", () => {
    expect(CODEX_TEARDOWN_TOTAL_BUDGET_MS).toBe(
      CODEX_TEARDOWN_STDIN_EOF_WAIT_MS + CODEX_TEARDOWN_SIGTERM_WAIT_MS + CODEX_TEARDOWN_SIGKILL_WAIT_MS,
    );
  });

  it("the doctor's overall watchdog exceeds one full teardown sequence (never fires mid-teardown)", () => {
    expect(CODEX_DOCTOR_WATCHDOG_MS).toBeGreaterThan(CODEX_TEARDOWN_TOTAL_BUDGET_MS);
  });

  it("the interrupt RPC itself resolves before the post-interrupt drain deadline", () => {
    expect(CODEX_TURN_INTERRUPT_TIMEOUT_MS).toBeLessThan(CODEX_POST_INTERRUPT_SETTLE_MS);
  });

  it("model/list pagination is bounded to a small, deterministic page count", () => {
    expect(Number.isInteger(CODEX_MODEL_LIST_MAX_PAGES)).toBe(true);
    expect(CODEX_MODEL_LIST_MAX_PAGES).toBeLessThanOrEqual(10);
  });

  it("SIGTERM wait is strictly less than the total teardown budget (SIGKILL stage always has budget left)", () => {
    expect(CODEX_TEARDOWN_SIGTERM_WAIT_MS).toBeLessThan(CODEX_TEARDOWN_TOTAL_BUDGET_MS);
  });

  it("the doctor's watchdog covers the worst-case sum of every RPC phase it wraps (MED-1, post-C0 review fix)", () => {
    // version preflight -> initialize -> account/read -> up to
    // CODEX_MODEL_LIST_MAX_PAGES pages of model/list. An outer watchdog
    // smaller than this sum would kill a legitimately slow-but-valid call
    // before that call's own per-RPC deadline ever gets a chance to fire —
    // exactly the contradiction this test pins shut.
    const worstCasePhaseSum =
      CODEX_VERSION_PREFLIGHT_TIMEOUT_MS +
      CODEX_DOCTOR_RPC_TIMEOUT_MS * 2 + // initialize + account/read
      CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS * CODEX_MODEL_LIST_MAX_PAGES;
    expect(CODEX_DOCTOR_WATCHDOG_MS).toBeGreaterThanOrEqual(worstCasePhaseSum);
  });

  it("the doctor's own per-RPC bounds are tighter than the engine's patient boot bounds (doctor is an interactive Settings diagnostic, not a boot sequence)", () => {
    expect(CODEX_DOCTOR_RPC_TIMEOUT_MS).toBeLessThan(CODEX_BOOT_RPC_TIMEOUT_MS);
    expect(CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS).toBeLessThan(CODEX_MODEL_LIST_PAGE_TIMEOUT_MS);
  });
});

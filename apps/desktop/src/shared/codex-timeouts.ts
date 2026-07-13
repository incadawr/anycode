/**
 * Single source of truth for every bounded timeout and teardown-sequence
 * constant governing the lifecycle of a spawned `codex app-server` child
 * process (design/slice-codex-fixes-cut.md §2(b)/§2(g)/§6).
 *
 * TWO independent call sites spawn and tear down their OWN, separate
 * app-server child: the host engine (host/engines/codex/*, TASK.38/39) and
 * main's onboarding doctor (main/codex-doctor.ts, TASK.41) — a host->main
 * import is architecturally forbidden (cut §2(g): "межслойный импорт
 * host→main запрещён"), so `main/codex-doctor.ts` deliberately runs its OWN
 * minimal JSON-RPC client rather than reusing `host/engines/codex/
 * app-server-client.ts`. Two independently-written teardown state machines is
 * exactly the failure mode that produced a >300s-hung child in the original
 * probe harness before its own teardown was bounded (NOTES.md "Probe timeout
 * / interruption record" / "Teardown hardening regression"). This module is
 * the fix: both call sites import the SAME numbers, so their teardown
 * sequences can never independently drift apart.
 *
 * VALUE-ONLY module with ZERO imports (precedent: shared/settings.ts,
 * shared/engines.ts) — safe to import from host/**, main/**, and (should a
 * future slice need to render one of these numbers) the renderer, without
 * dragging any one process's dependency surface into another.
 */

// ── bounded RPC timeouts (design §2(b)#6) ──

/** `initialize` / `account/read` / `account/login/*` / `thread/start` / `thread/resume` / `thread/read`. */
export const CODEX_BOOT_RPC_TIMEOUT_MS = 15_000;

/**
 * `turn/start` response (design §2(b)#2, "Фаза A") — bounds only the
 * request/response round trip that hands back the native turnId, NOT the
 * turn's own duration (which is unbounded and ends via `turn/completed`).
 */
export const CODEX_TURN_START_TIMEOUT_MS = 20_000;

/** The single, idempotent `sendInterruptOnce()` -> `turn/interrupt` call (design §2(b)#4/#6). */
export const CODEX_TURN_INTERRUPT_TIMEOUT_MS = 5_000;

/** One `model/list` page (design §2(b)#6 / §2(g)). */
export const CODEX_MODEL_LIST_PAGE_TIMEOUT_MS = 15_000;

/**
 * Hard cap on paginated `model/list` pages (design §2(g)) — a misbehaving or
 * looping `nextCursor` can never spin the doctor or the draft model catalog
 * indefinitely.
 */
export const CODEX_MODEL_LIST_MAX_PAGES = 5;

/**
 * Deadline for the notification drain AFTER `sendInterruptOnce()` fires, up to
 * the terminal `turn/completed` (design §2(b)#3, "Фаза B"). The live W1
 * fixture observed interrupt -> completed in 352ms; this is the bounded
 * backstop, not the expected case.
 */
export const CODEX_POST_INTERRUPT_SETTLE_MS = 10_000;

/**
 * `codex-cli <semver>` version preflight (design §1 W0 gate / §2(g)). Mirrors
 * the pre-existing local `CODEX_VERSION_TIMEOUT_MS` in
 * host/engines/codex/app-server-client.ts — callers migrate to import this
 * shared constant instead of keeping their own local copy.
 */
export const CODEX_VERSION_PREFLIGHT_TIMEOUT_MS = 3_000;

/**
 * `main/codex-doctor.ts`'s own overall bounded run (design §2(g)): spawn ->
 * initialize -> account/read -> model/list (paginated, up to
 * CODEX_MODEL_LIST_MAX_PAGES) -> bounded close, end to end. Must exceed
 * CODEX_TEARDOWN_TOTAL_BUDGET_MS (asserted in the paired test) — the doctor's
 * own watchdog must never fire mid-teardown.
 */
export const CODEX_DOCTOR_WATCHDOG_MS = 10_000;

// ── teardown recipe (design §2(b) / NOTES.md "Teardown hardening regression") ──
// Both the host engine's child (TASK.38/39) and main's doctor child (TASK.41)
// MUST tear down with this EXACT sequence — divergence here is the specific
// hazard this module exists to close: an orphaned/hung child that survives
// its owning process, exactly the multi-hundred-second hang the W0 probe
// harness exhibited before its teardown was bounded to this recipe.

/** Stage 1: after closing stdin, wait this long for the child to exit on its own (graceful EOF). */
export const CODEX_TEARDOWN_STDIN_EOF_WAIT_MS = 700;

/** Stage 2: SIGTERM the child's OWN process group, then wait this long for exit. */
export const CODEX_TEARDOWN_SIGTERM_WAIT_MS = 1_000;

/** Stage 3 (backstop): SIGKILL the process group, then wait this long to confirm the PID is gone. */
export const CODEX_TEARDOWN_SIGKILL_WAIT_MS = 1_000;

/**
 * Sum of every teardown stage above — the outer bound one `close()` call may
 * run for. `close()` itself must stay idempotent: a second call while one is
 * already in flight is a safe no-op, never a second signal storm.
 */
export const CODEX_TEARDOWN_TOTAL_BUDGET_MS =
  CODEX_TEARDOWN_STDIN_EOF_WAIT_MS + CODEX_TEARDOWN_SIGTERM_WAIT_MS + CODEX_TEARDOWN_SIGKILL_WAIT_MS;

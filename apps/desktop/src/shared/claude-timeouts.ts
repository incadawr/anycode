/**
 * Single source of truth for every bounded timeout and teardown-sequence
 * constant governing the lifecycle of a spawned `claude` child process
 * (design/slice-cc-cut.md §1.3), for the long-lived host engine client
 * (host/engines/claude/claude-client.ts, CC-B).
 *
 * `main/claude-doctor.ts` (SLICE-CC A3, already landed) deliberately keeps its
 * OWN small local timeout constants rather than importing this module — its
 * own header explains why (a bounded one-shot auth-probe has no background-bash
 * drain to wait out, unlike this file's long-lived engine teardown) — so this
 * module has exactly one consumer today, the host client, not two independently
 * drifting teardown state machines like the codex precedent
 * (shared/codex-timeouts.ts) had to unify.
 *
 * VALUE-ONLY module with ZERO imports (precedent: shared/codex-timeouts.ts,
 * shared/engines.ts) — safe to import from host/**, main/**, and the renderer
 * without dragging any one process's dependency surface into another.
 */

/** `--version` preflight, its own short-lived process group (mirrors CODEX_VERSION_PREFLIGHT_TIMEOUT_MS). */
export const CLAUDE_VERSION_PREFLIGHT_TIMEOUT_MS = 3_000;

/**
 * The `initialize` control-request's `control_response` ack. Live ack lands in
 * ~300-800ms (`w0-13-authprobe-signedin.jsonl`) — generous bound.
 * `system/init` is NEVER awaited at handshake time (it is turn-scoped, emitted
 * only after the first user message, contract §0.3-7) — this timeout bounds
 * ONLY the `control_response` to our `initialize` control_request.
 */
export const CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Bound for every OTHER mutating/read control request we send mid-session:
 * `interrupt`, `set_model`, `set_permission_mode`, `apply_flag_settings`,
 * `get_usage`, `get_context_usage`. Live `get_usage` answers in ~770ms
 * (`w0-15-usage.jsonl` L5) — cheap to poll on demand, too slow for a
 * synchronous UI hot path, but well inside this bound.
 */
export const CLAUDE_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/** Deadline for the notification drain after an `interrupt` control_request settles, up to the turn's terminal `result`. */
export const CLAUDE_POST_INTERRUPT_SETTLE_MS = 10_000;

// ── teardown recipe ──
// A single spawned `claude` child (one process = one session, many turns,
// probe #1) is torn down with this EXACT sequence: stdin EOF -> SIGTERM ->
// SIGKILL, each stage exiting early the moment the child actually closes.

/**
 * Stage 1: after closing stdin, wait this long for the child to exit on its
 * own (graceful EOF). NOT copied from codex's 700ms: W0 probe #1 measured a
 * clean EOF exit at ~517ms with NO background bash running
 * (`w0-01-persistence.jsonl`), but draining a background bash task (~5s per
 * research) was never measured live — this constant is set WITH HEADROOM
 * above that unmeasured 5s ceiling, not against the clean-exit baseline alone,
 * so a SIGTERM never cuts off a live background-task drain.
 */
export const CLAUDE_TEARDOWN_STDIN_EOF_WAIT_MS = 6_000;

/** Stage 2: SIGTERM the child's own process group, then wait this long for exit. */
export const CLAUDE_TEARDOWN_SIGTERM_WAIT_MS = 1_000;

/** Stage 3 (backstop): SIGKILL the process group, then wait this long to confirm the PID is gone. */
export const CLAUDE_TEARDOWN_SIGKILL_WAIT_MS = 1_000;

/** Sum of every teardown stage above — the outer bound one `close()` call may run for. */
export const CLAUDE_TEARDOWN_TOTAL_BUDGET_MS =
  CLAUDE_TEARDOWN_STDIN_EOF_WAIT_MS + CLAUDE_TEARDOWN_SIGTERM_WAIT_MS + CLAUDE_TEARDOWN_SIGKILL_WAIT_MS;

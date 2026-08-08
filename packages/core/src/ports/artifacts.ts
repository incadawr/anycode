/**
 * Artifact-store contract (TASK.94). TASK.93 bounded what a tool result may
 * contribute to the model's context; it bounded it with a knife — everything
 * past `resultBudget.maxModelBytes` was destroyed, and the only way back to it
 * was re-running the tool. This port is the other half: the full rendered text
 * is written somewhere durable and the model is handed a path instead of a
 * stump.
 *
 * Who writes matters. The DISPATCHER calls this port, not a tool handler — the
 * write happens after the tool already cleared its own permission gate, lands
 * OUTSIDE the workspace (beside anycode.sqlite, like checkpoints), and is
 * therefore host bookkeeping rather than a new side effect performed on the
 * model's behalf. That is why no permission gate guards it (TASK.94 §1 verdict).
 *
 * The port is optional everywhere it is threaded (DispatchContext/ToolContext):
 * absence degrades `strategy: "artifact"` back to plain truncation, which is
 * byte-identical to TASK.93 behaviour. A host that never wires a store loses
 * nothing it had.
 */

/** Retention class of a written artifact. v1 knows exactly one. */
export type ArtifactRetention = "session";

export interface ArtifactWriteRequest {
  /** Owning session; also the directory grain used by removeSession/sweepExpired. */
  sessionId: string;
  /**
   * Owning turn. Part of the contract for future per-turn cleanup, but the
   * dispatcher does not know a turn id today, so it is left unset rather than
   * invented (TASK.94 design, assumption 3).
   */
  turnId?: string;
  /** Provider-issued tool-call id; doubles as the artifact's file name. */
  toolCallId: string;
  toolName: string;
  /** Full text to persist — what the dispatcher rendered for the model. */
  content: string;
  /** v1 persists text only; a Bash result's JSON is text too. */
  contentType: "text/plain";
  retention: ArtifactRetention;
}

export interface ArtifactStorePort {
  /**
   * Writes `content` in full and resolves with its absolute path.
   *
   * THROWS on refusal (unsafe id, over the per-write cap, I/O failure). The
   * dispatcher treats any throw as "no artifact" and falls back to truncation,
   * so a throw here costs exactly what TASK.93 already cost — never an error
   * shown to the model.
   */
  writeToolResultArtifact(req: ArtifactWriteRequest): Promise<{ path: string; bytes: number }>;
  /**
   * Best-effort removal of one session's artifact directory. NEVER throws:
   * it runs on the host's exit path, where a failed unlink must not outrank
   * shutting down cleanly. The age-based sweep is the backstop.
   */
  removeSession(sessionId: string): Promise<void>;
  /**
   * One-shot age-based GC across the whole artifacts root, run at host start.
   * This — not removeSession — is the load-bearing collector: "end of session"
   * has no single point in this codebase (the CLI leaves a REPL, the desktop
   * host lives for days, processes crash), so only an age ceiling is
   * guaranteed to fire. NEVER throws; reports the session ids it removed.
   */
  sweepExpired(maxAgeMs: number, now?: number): Promise<{ removed: string[] }>;
}

/**
 * What a host hands the dispatch layer: a store plus the session the current
 * loop writes under. Child loops inherit the parent's value verbatim, so a
 * subagent's artifacts land in the PARENT's directory — tool-call ids are
 * globally unique, and a child has no session id of its own worth inventing.
 */
export interface ArtifactContext {
  store: ArtifactStorePort;
  sessionId: string;
}

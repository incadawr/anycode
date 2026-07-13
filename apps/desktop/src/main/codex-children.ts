/**
 * The registry of every `codex` child MAIN itself owns — the doctor's
 * app-server child, the login flow's app-server child, and the short-lived
 * `--version` preflight child that precedes both.
 *
 * WHY THIS EXISTS (W2 review, Critical): every one of those children is spawned
 * `detached` on POSIX, i.e. as its own process-group leader, precisely so its
 * teardown can reap a whole tree rather than one pid. The flip side of
 * `detached` is that the child does NOT die with us: if main exits while one is
 * live, the entire group survives — for a login, that is a five-minute orphan
 * holding a browser handshake open. Tab hosts were already owned by the app
 * lifecycle (`before-quit` -> `shutdownAllTabHosts`); these children were owned
 * by nothing. This module is the missing owner.
 *
 * INVARIANT: a `codex` child is spawned ONLY through a handle registered here,
 * and every quit path drains this registry:
 *   - `before-quit`  -> `closeAllCodexChildren()` — bounded, graceful, awaited
 *     (the same stdin-EOF -> SIGTERM -> SIGKILL recipe as every other Codex
 *     teardown; shared/codex-timeouts.ts).
 *   - `will-quit`    -> the same call, idempotent, for a quit that never routed
 *     through `before-quit`.
 *   - `process.exit` -> `killCodexChildrenSync()` — the last-resort backstop for
 *     the paths that give us no chance to await anything (a crash, an
 *     uncaught exception, `app.exit()`): one synchronous group SIGKILL each.
 *     A hard `SIGKILL`/power loss remains un-hookable by construction.
 */
import { CODEX_TEARDOWN_TOTAL_BUDGET_MS } from "../shared/codex-timeouts.js";

export interface CodexChildHandle {
  /** The group leader's pid (POSIX: pid === pgid), or undefined once it is gone. */
  pid(): number | undefined;
  /** Bounded, idempotent teardown of the whole group (shared/codex-timeouts.ts recipe). */
  close(): Promise<void>;
}

const live = new Set<CodexChildHandle>();

/** Registers a spawned child; the returned function unregisters it (call it once its own `close()` has fully settled). */
export function registerCodexChild(handle: CodexChildHandle): () => void {
  live.add(handle);
  return () => {
    live.delete(handle);
  };
}

/** Live children main currently owns — the quantity the orphan tests assert must reach zero. */
export function liveCodexChildCount(): number {
  return live.size;
}

/**
 * Closes every live child in parallel, each under its own bounded teardown.
 * Never rejects: a child that refuses to die still has its group SIGKILLed by
 * its own `close()`, and a `close()` that somehow throws must not abort the
 * teardown of its siblings — quit must proceed either way.
 *
 * The overall bound is one teardown budget (the closes run concurrently, not
 * serially), so a quit can never hang on this.
 */
export async function closeAllCodexChildren(): Promise<void> {
  const handles = [...live];
  if (handles.length === 0) return;
  await Promise.race([
    Promise.allSettled(handles.map((handle) => handle.close())),
    new Promise<void>((resolve) => setTimeout(resolve, CODEX_TEARDOWN_TOTAL_BUDGET_MS + 500)),
  ]);
  // Anything still registered after its bounded close (a close that hung past
  // the budget above) gets the synchronous backstop rather than a free pass.
  killCodexChildrenSync();
}

/**
 * Synchronous last resort, safe to call from `process.on("exit")` where no
 * async work can run: SIGKILL each child's process GROUP directly. Best-effort
 * by definition — an already-dead group raises ESRCH, which is the success case.
 */
export function killCodexChildrenSync(): void {
  if (process.platform === "win32") return;
  for (const handle of [...live]) {
    const pid = handle.pid();
    live.delete(handle);
    if (pid === undefined) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH: the group is already gone — exactly what we wanted.
    }
  }
}

let guardInstalled = false;

/** Idempotently arms the `process.exit` backstop. Called once from main/index.ts's boot. */
export function installCodexChildExitGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  process.on("exit", () => {
    killCodexChildrenSync();
  });
}

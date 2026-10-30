import type { SessionActivityState } from "../shared/communication.js";

/** Forward the session's current activity and subsequent changes to main. */
export function forwardSessionActivity(
  session: { observeActivity(listener: (state: SessionActivityState) => void): void },
  postMessage: (message: { type: "session_activity"; state: SessionActivityState }) => void,
): void {
  session.observeActivity((state) => postMessage({ type: "session_activity", state }));
}

/** Start the host and connect its activity stream once boot has completed. */
export function startHostWithActivity<T>(
  boot: () => Promise<T>,
  session: () => { observeActivity(listener: (state: SessionActivityState) => void): void } | null,
  postMessage: (message: { type: "session_activity"; state: SessionActivityState }) => void,
): Promise<T> {
  const ready = boot();
  void ready.then(() => { const current = session(); if (current) forwardSessionActivity(current, postMessage); });
  return ready;
}

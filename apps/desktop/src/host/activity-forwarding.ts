import type { SessionActivityState, SessionActivitySnapshot } from "../shared/communication.js";

/** Forward the session's current activity and subsequent changes to main. */
export function forwardSessionActivity(
  session: { observeActivity(listener: (state: SessionActivityState, snapshot?: SessionActivitySnapshot) => void): void },
  postMessage: (message: { type: "session_activity"; state: SessionActivityState; snapshot?: SessionActivitySnapshot }) => void,
): void {
  session.observeActivity((state, snapshot) => postMessage({ type: "session_activity", state, ...(snapshot ? { snapshot } : {}) }));
}

/** Start the host and connect its activity stream once boot has completed. */
export function startHostWithActivity<T>(
  boot: () => Promise<T>,
  session: () => { observeActivity(listener: (state: SessionActivityState, snapshot?: SessionActivitySnapshot) => void): void } | null,
  postMessage: (message: { type: "session_activity"; state: SessionActivityState; snapshot?: SessionActivitySnapshot }) => void,
): Promise<T> {
  const ready = boot();
  void ready.then(() => { const current = session(); if (current) forwardSessionActivity(current, postMessage); });
  return ready;
}

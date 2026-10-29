import type { SessionActivityState } from "../shared/communication.js";

/** Forward the session's current activity and subsequent changes to main. */
export function forwardSessionActivity(
  session: { observeActivity(listener: (state: SessionActivityState) => void): void },
  postMessage: (message: { type: "session_activity"; state: SessionActivityState }) => void,
): void {
  session.observeActivity((state) => postMessage({ type: "session_activity", state }));
}

import type { AgentEvent } from "@anycode/core";

// Extracted from host/index.ts so the forwarding rule can be unit-tested:
// index.ts is the host entry module and cannot be imported by tests.

/**
 * Whether a detached event of the Claude CLI's own agents and commands reaches
 * the session. Only the engine the session runs on speaks for its cards and
 * count, with one exception: an engine the session already switched away from
 * still settles what died with it (subagent_end, a background command that
 * left "running", a zero background-agent count), or its cards and badge would
 * keep spinning in the transcript and the host would replay the command as
 * running after a reload or a switch back.
 */
export function shouldForwardClaudeDetachedEvent(ownsRuntime: boolean, event: AgentEvent): boolean {
  if (ownsRuntime) return true;
  if (event.type === "subagent_end") return true;
  if (event.type === "engine_background_agents") return event.count === 0;
  return event.type === "claude_background_task" && event.status !== "running";
}

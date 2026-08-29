/**
 * Detached-child terminal report formatting (TASK.145 срез 1, design §4bis/§7).
 * Pure string helper — no I/O, no state — mirroring background-notice.ts's
 * role for background bash tasks, but for a `Agent tier:"session" detach:true`
 * child session instead: the desktop host (host/index.ts's
 * `onDetachedTerminal` seam, child-session-port.ts) calls this to build the
 * text it delivers to the parent's prompt queue once the detached child
 * reaches a terminal status.
 *
 * Form is taken verbatim from ZCode 3.x (owner decision 22.08, spec §4bis п.3
 * / §7): the anti-spoofing header + the three explanatory lines are
 * REQUIRED, byte-for-byte — they are the only defense a model has against
 * mistaking this synthetic system event for the user's own words, since the
 * injected turn's role is `user` (design §4bis п.1, no `role:"tool"` variant
 * exists for a tool call that already returned at admit time). The
 * `<task-notification>` field set is narrowed from ZCode's superset to what
 * this system actually tracks (spec §7 permits this): no `output-file`
 * field, because a background child here has no filesystem artifact to
 * reference — its report is `summary` itself, already the child's own
 * capped finalText, and the FULL transcript is reachable by opening the
 * child's own tab (the "path, not content" discipline ZCode's own
 * TaskOutput deprecation note explains — reading the whole JSONL here would
 * blow up the parent's context on every wake).
 *
 * Field mapping (a spec-filling decision, not owner-specified): this system
 * has no separate task-registry id distinct from the spawning tool call, so
 * `task-id` and `tool-use-id` both carry `spawnToolCallId` (the ORIGINAL
 * `Agent(...)` tool_call id, ctx.toolCallId) — genuinely the same identity
 * here, unlike ZCode's registry where the two differ. `agent-id` carries
 * `childSessionId`, the identity of the session that actually ran the task
 * (the same id the persisted subagent card's `target.childSessionId` and the
 * child-relation store's "Open" affordance use), so a model correlating this
 * notification against its own transcript has two independent, both-real
 * ids to match against, not one id duplicated three times.
 */

import { CHILD_NOTIFICATION_SUMMARY_MAX_CHARS } from "../types/config.js";

/** Verbatim anti-spoofing header (owner decision 22.08) — do not paraphrase or reformat. */
const NOTIFICATION_HEADER =
  "[SYSTEM NOTIFICATION - NOT USER INPUT]\n" +
  "This is an automated task event, NOT a message from the user.\n" +
  "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.";

/** Narrowed from ChildRunEvent/ChildTerminal's 4-way status — `mapChildRunStatusToNotification` below owns the mapping. */
export type ChildTaskNotificationStatus = "completed" | "failed" | "cancelled";

export interface ChildTaskNotificationInput {
  /** Identity of "the task" from the parent's own point of view — here, the spawning Agent tool_call id. */
  taskId: string;
  /** The ORIGINAL Agent tool_call id this notification reports on (same value as taskId in this system — see file header). */
  toolUseId: string;
  /** Identity of the child session that actually ran the task. */
  agentId: string;
  /** The agent_type the child ran as (e.g. "general-purpose"). */
  subagentType: string;
  status: ChildTaskNotificationStatus;
  /** Short digest of what the child did/found — NEVER the raw transcript (file header). Truncated here if oversized. */
  summary: string;
}

/**
 * Escapes the three XML-significant characters for a TEXT NODE (not an
 * attribute — no quote escaping needed). Applied uniformly to every
 * substituted field, including the closed `status` enum, so this module
 * never has to reason about which fields could theoretically carry
 * adversarial text.
 */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Truncates on a CODE-POINT boundary (never mid-surrogate-pair), appending an
 * explicit marker so a model reading a cut-off summary knows it is
 * incomplete rather than assuming the child's report was this short.
 * Newlines are preserved (unlike subagents/summarize-tool.ts's activity-line
 * cap): a background-task digest is prose, not a one-line label.
 */
function capSummary(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) {
    return text;
  }
  return `${codePoints.slice(0, maxChars).join("")}\n…[truncated]`;
}

/**
 * Maps a session-tier terminal status onto the notification's 3-way
 * vocabulary (spec §4bis's literal `completed|failed|cancelled`): `max_turns`
 * and `error` both collapse to "failed" — from the parent's point of view
 * both mean the same thing, "did not produce a finished report" (TASK.44's
 * own "only completed is success" discipline, one level coarser here since
 * the notification has no room for a `max_turns`-specific remediation hint
 * the way the synchronous Agent tool's own error text does).
 */
export function mapChildRunStatusToNotification(
  status: "completed" | "max_turns" | "cancelled" | "error",
): ChildTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "max_turns":
    case "error":
      return "failed";
  }
}

/**
 * Builds the full notification text: the verbatim header, a blank line, then
 * the `<task-notification>` block. `task-type` is a constant
 * ("subagent_child") — this module only ever formats ONE task family, mirror
 * of ZCode's own type tag but with the other three (local_bash/
 * local_workflow/remote_agent) out of scope for this system.
 */
export function formatChildTaskNotification(input: ChildTaskNotificationInput): string {
  const summary = capSummary(input.summary, CHILD_NOTIFICATION_SUMMARY_MAX_CHARS);
  const body = [
    "<task-notification>",
    `  <task-id>${escapeXmlText(input.taskId)}</task-id>`,
    `  <tool-use-id>${escapeXmlText(input.toolUseId)}</tool-use-id>`,
    "  <task-type>subagent_child</task-type>",
    `  <agent-id>${escapeXmlText(input.agentId)}</agent-id>`,
    `  <subagent-type>${escapeXmlText(input.subagentType)}</subagent-type>`,
    `  <status>${escapeXmlText(input.status)}</status>`,
    `  <summary>${escapeXmlText(summary)}</summary>`,
    "</task-notification>",
  ].join("\n");
  return `${NOTIFICATION_HEADER}\n\n${body}`;
}

/**
 * TASK.145 срез 2: the honest "overflow" notice a host's pending-report queue
 * (apps/desktop/src/host/child-report-queue.ts) substitutes for a detached
 * child's real report once its bounded cap is reached — "тихо резать нельзя"
 * (spec §8's "занятый родитель" cut): a dropped report must still surface
 * SOMETHING to the model rather than vanish with no trace. Reuses the SAME
 * anti-spoofing header as a real task-notification (this is just as much a
 * synthetic system event, not user input) but carries no `<task-notification>`
 * body — there is no single task/agent id to report on, only a count.
 */
export function formatChildReportCapNotice(droppedCount: number): string {
  const plural = droppedCount === 1 ? "report" : "reports";
  return (
    `${NOTIFICATION_HEADER}\n\n` +
    `${droppedCount} background child session ${plural} could not be delivered to this conversation: ` +
    "the pending-report queue reached its capacity. The affected child sessions finished, but their " +
    "outcome never reached this turn chain — check the session list for children that may still need review."
  );
}

/**
 * TASK.148 slice 2: a detached child's STALL notice — delivered through the
 * SAME channel as `formatChildTaskNotification` (the desktop host's
 * `ChildReportQueue`) but for a fundamentally different event: the child has
 * gone quiet past its silence threshold, not finished. Deliberately NOT a
 * `<task-notification>`: that tag's own `<status>` field is exactly the
 * three TERMINAL values `completed|failed|cancelled` (mapChildRunStatusToNotification's
 * whole range) — reusing it here would let a model read a stall as a finish.
 * A distinct root tag (`<task-stall-notice>`) plus an explicit "has NOT
 * finished" sentence are BOTH required so this can never be mistaken for the
 * terminal report by a model skimming past the shared anti-spoofing header.
 */
export interface ChildStallNoticeInput {
  /** Identity of "the task" from the parent's own point of view — the spawning Agent tool_call id (same field mapping as formatChildTaskNotification). */
  taskId: string;
  toolUseId: string;
  /**
   * Identity of the child session that actually ran the task, when already
   * known. Absent only in the (practically unreachable, since the silence
   * threshold vastly exceeds admission latency) case a stall somehow fires
   * before the child's "accepted" event ever arrived — the field is simply
   * omitted rather than carrying a fabricated placeholder.
   */
  agentId?: string;
  /** The agent_type the child ran as (e.g. "general-purpose"). */
  subagentType: string;
  /** The 3-5 word task label the child was spawned with. */
  description: string;
  /** Wall-clock ms since the child's last confirmed sign of life (SubagentStallReport.silentMs). */
  silentMs: number;
  /** Last tool name / activity label observed before the silence began, if any. */
  lastActivity?: string;
  /** Always false as produced by SubagentStallClock (a report never fires while paused) — rides the field anyway so a consumer never special-cases its absence. */
  waitingForApproval: boolean;
}

/**
 * Renders a silence duration for a human/model reader: whole seconds under a
 * minute, else whole minutes (rounded) — the default SUBAGENT_STALL_TIMEOUT_MS
 * (10 minutes) and any custom override both read naturally either way.
 */
function formatSilenceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  return `${Math.round(totalSeconds / 60)}m`;
}

/**
 * Builds the full stall-notice text: the SAME verbatim anti-spoofing header
 * as a real task notification, an explicit non-terminal framing sentence,
 * then the `<task-stall-notice>` block — a distinct shape from
 * `formatChildTaskNotification`'s `<task-notification>` at every level (root
 * tag, no `<status>` enum, an extra framing sentence) so the two are never
 * textually confusable.
 */
export function formatChildStallNotice(input: ChildStallNoticeInput): string {
  const body = [
    "<task-stall-notice>",
    `  <task-id>${escapeXmlText(input.taskId)}</task-id>`,
    `  <tool-use-id>${escapeXmlText(input.toolUseId)}</tool-use-id>`,
    "  <task-type>subagent_child</task-type>",
    ...(input.agentId !== undefined ? [`  <agent-id>${escapeXmlText(input.agentId)}</agent-id>`] : []),
    `  <subagent-type>${escapeXmlText(input.subagentType)}</subagent-type>`,
    `  <description>${escapeXmlText(input.description)}</description>`,
    `  <silent-for>${escapeXmlText(formatSilenceDuration(input.silentMs))}</silent-for>`,
    ...(input.lastActivity !== undefined
      ? [`  <last-activity>${escapeXmlText(input.lastActivity)}</last-activity>`]
      : []),
    `  <waiting-for-approval>${input.waitingForApproval ? "true" : "false"}</waiting-for-approval>`,
    "</task-stall-notice>",
  ].join("\n");
  return (
    `${NOTIFICATION_HEADER}\n\n` +
    "This child session has NOT finished — it is still running in the background and has simply " +
    "produced no sign of activity for a while. This is a progress notice, not a completion report; " +
    "no action is required unless the silence itself is a concern.\n\n" +
    body
  );
}

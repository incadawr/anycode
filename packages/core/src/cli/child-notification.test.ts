/**
 * Detached-child notification formatting tests (TASK.145 срез 1). Covers the
 * verbatim anti-spoofing header, XML escaping, summary truncation, and the
 * 4-way -> 3-way status mapping — the hermetic e2e (a detached run actually
 * producing and delivering one of these) lives in child-session-port.test.ts
 * (admit/terminal split) and store.test.ts (renderer enqueue).
 */

import { describe, expect, it } from "vitest";
import {
  childNotificationSummaryOverflows,
  formatChildReportCapNotice,
  formatChildApprovalNotice,
  formatChildStallNotice,
  formatChildTaskNotification,
  formatChildTurnBudgetNotice,
  formatSupervisorIdleReminder,
  mapChildRunStatusToNotification,
  type ChildStallNoticeInput,
  type ChildTaskNotificationInput,
  type ChildTurnBudgetNoticeInput,
  type SupervisorIdleReminderInput,
} from "./child-notification.js";
import { CHILD_NOTIFICATION_SUMMARY_MAX_CHARS } from "../types/config.js";

function input(overrides?: Partial<ChildTaskNotificationInput>): ChildTaskNotificationInput {
  return {
    taskId: "call-1",
    toolUseId: "call-1",
    agentId: "child-session-1",
    subagentType: "general-purpose",
    status: "completed",
    summary: "Found 3 files matching the pattern.",
    ...overrides,
  };
}

describe("formatChildTaskNotification (spec §4bis/§7)", () => {
  it("finalTurnFinishReason \"length\" + status completed maps to failed with the TRUNCATED CHILD REPORT marker", () => {
    const text = formatChildTaskNotification(input({ finalTurnFinishReason: "length" }));
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain("TRUNCATED CHILD REPORT");
    expect(text).toContain("cut mid-stream");
  });

  it("field absent keeps <status>completed</status> with no marker", () => {
    const text = formatChildTaskNotification(input());
    expect(text).toContain("<status>completed</status>");
    expect(text).not.toContain("TRUNCATED CHILD REPORT");
  });

  it("status failed + field stays failed, marker present", () => {
    const text = formatChildTaskNotification(input({ status: "failed", finalTurnFinishReason: "length" }));
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain("TRUNCATED CHILD REPORT");
  });

  it("starts with the VERBATIM anti-spoofing header, byte-for-byte", () => {
    const text = formatChildTaskNotification(input());
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("This is an automated task event, NOT a message from the user.\n");
    expect(text).toContain(
      "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    );
  });

  it("renders every field inside a <task-notification> block, with a constant task-type", () => {
    const text = formatChildTaskNotification(
      input({ taskId: "spawn-1", toolUseId: "spawn-1", agentId: "child-9", subagentType: "explore", status: "failed", summary: "ran out of budget" }),
    );
    expect(text).toContain("<task-notification>");
    expect(text).toContain("<task-id>spawn-1</task-id>");
    expect(text).toContain("<tool-use-id>spawn-1</tool-use-id>");
    expect(text).toContain("<task-type>subagent_child</task-type>");
    expect(text).toContain("<agent-id>child-9</agent-id>");
    expect(text).toContain("<subagent-type>explore</subagent-type>");
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain("<summary>ran out of budget</summary>");
    expect(text).toContain("</task-notification>");
  });

  it("TASK.218: the follow-up hint rides AFTER the block — agent-id inside, continue_session prose outside", () => {
    const text = formatChildTaskNotification(input({ agentId: "child-9" }));
    expect(text).toContain("<agent-id>child-9</agent-id>");
    expect(text).toMatch(/pass its agent-id as continue_session/);
    // Prose after the closing tag — renderer regexes only read inside the block.
    const tail = text.slice(text.indexOf("</task-notification>"));
    expect(tail).toContain("continue_session");
  });

  it("XML-escapes &, <, and > in every substituted field (defense against a model-authored agent_type/summary breaking the tag structure)", () => {
    const text = formatChildTaskNotification(
      input({
        subagentType: 'weird<"type">&',
        summary: "if a < b && b > c then <inject/>",
      }),
    );
    expect(text).toContain("<subagent-type>weird&lt;\"type\"&gt;&amp;</subagent-type>");
    expect(text).toContain("<summary>if a &lt; b &amp;&amp; b &gt; c then &lt;inject/&gt;</summary>");
    // No raw, unescaped angle bracket from the injected fields ever reaches the wire.
    expect(text).not.toContain("<inject/>");
  });

  it("never leaks the raw child transcript — only the header, task-notification shell, and the (capped) summary field appear", () => {
    const text = formatChildTaskNotification(input({ summary: "one short paragraph" }));
    expect(text.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(
      // 3 header lines + 9 task-notification lines (open/7 fields incl. close... see below)
      // + 1 TASK.218 follow-up hint line after the block
      3 + 9 + 1,
    );
  });

  it("caps an oversized summary at CHILD_NOTIFICATION_SUMMARY_MAX_CHARS on a code-point boundary and marks it truncated", () => {
    const longSummary = "a".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS + 500);
    const text = formatChildTaskNotification(input({ summary: longSummary }));
    expect(text).toContain("…[truncated]");
    const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(text);
    expect(summaryMatch).not.toBeNull();
    const summaryBody = summaryMatch![1]!;
    // codePoints of the kept prefix + the truncation marker, never the full oversized input.
    expect(summaryBody.length).toBeLessThan(longSummary.length);
    expect(summaryBody.startsWith("a".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS))).toBe(true);
  });

  it("names the saved full report in the truncation marker, so the parent reads it instead of re-asking the child", () => {
    const longSummary = "c".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS + 10);
    expect(childNotificationSummaryOverflows(longSummary)).toBe(true);
    const text = formatChildTaskNotification(input({ summary: longSummary, fullReportPath: "/tmp/r/child-1.md" }));
    expect(text).toContain(
      `…[truncated — the full report (${CHILD_NOTIFICATION_SUMMARY_MAX_CHARS + 10} characters) is in /tmp/r/child-1.md]`,
    );
    expect(text).not.toContain("…[truncated]");
  });

  it("ignores fullReportPath when nothing is cut", () => {
    const exact = "d".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS);
    expect(childNotificationSummaryOverflows(exact)).toBe(false);
    const text = formatChildTaskNotification(input({ summary: exact, fullReportPath: "/tmp/r/child-1.md" }));
    expect(text).toContain(`<summary>${exact}</summary>`);
    expect(text).not.toContain("/tmp/r/child-1.md");
  });

  it("a summary at exactly the cap is NOT truncated (boundary)", () => {
    const exact = "b".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS);
    const text = formatChildTaskNotification(input({ summary: exact }));
    expect(text).not.toContain("…[truncated]");
    expect(text).toContain(`<summary>${exact}</summary>`);
  });

  it("preserves newlines inside a multi-paragraph summary (a report is prose, not a one-line label)", () => {
    const text = formatChildTaskNotification(input({ summary: "line one\nline two\n\nline four" }));
    expect(text).toContain("<summary>line one\nline two\n\nline four</summary>");
  });

  it("never mutates/reorders — task-id and tool-use-id both carry the same spawnToolCallId-derived value when the caller passes the same string for both (this system's field-mapping decision, file header)", () => {
    const text = formatChildTaskNotification(input({ taskId: "shared-id", toolUseId: "shared-id" }));
    expect(text).toContain("<task-id>shared-id</task-id>");
    expect(text).toContain("<tool-use-id>shared-id</tool-use-id>");
  });
});

describe("formatChildTaskNotification: user-initiated stop (cancelledBy)", () => {
  it("cancelledBy user + status cancelled carries an explicit <cancelled-by>user</cancelled-by> field after <status>", () => {
    const text = formatChildTaskNotification(input({ status: "cancelled", cancelledBy: "user", summary: "" }));
    expect(text).toContain("<status>cancelled</status>\n  <cancelled-by>user</cancelled-by>");
  });

  it("says in the summary that the USER stopped the subagent and must not be relaunched or retried", () => {
    const text = formatChildTaskNotification(input({ status: "cancelled", cancelledBy: "user", summary: "" }));
    expect(text).toContain("The user stopped this subagent. Do not relaunch it or retry the task unless the user asks; acknowledge and wait.");
  });

  it("keeps the closed status enum value cancelled (no new status word)", () => {
    const text = formatChildTaskNotification(input({ status: "cancelled", cancelledBy: "user" }));
    expect(text).toContain("<status>cancelled</status>");
  });

  it("keeps the child's own partial report after the explanation sentence", () => {
    const text = formatChildTaskNotification(input({ status: "cancelled", cancelledBy: "user", summary: "partial findings" }));
    expect(text).toContain("partial findings");
  });

  it("omits the field and the sentence for a cancel with no user cause (shutdown / parent abort keep their current text)", () => {
    const text = formatChildTaskNotification(input({ status: "cancelled", summary: "" }));
    expect(text).toContain("<status>cancelled</status>");
    expect(text).not.toContain("<cancelled-by>");
    expect(text).not.toContain("The user stopped this subagent");
  });

  it("ignores cancelledBy for a non-cancelled status (only a cancelled terminal can be a user stop)", () => {
    const text = formatChildTaskNotification(input({ status: "completed", cancelledBy: "user" }));
    expect(text).not.toContain("<cancelled-by>");
    expect(text).not.toContain("The user stopped this subagent");
  });
});

describe("formatChildTaskNotification: turn-limit cause (Taskana 4820)", () => {
  it("turnLimitTurns present prefixes the TURN LIMIT cause line ahead of the summary", () => {
    const text = formatChildTaskNotification(
      input({ status: "failed", summary: "partial findings", turnLimitTurns: 40 }),
    );
    expect(text).toContain("stopped at its TURN LIMIT after 40 turns");
    expect(text).toContain("NOT a completion report");
    // The cause line leads the summary, ahead of the child's own text.
    expect(text.indexOf("TURN LIMIT")).toBeLessThan(text.indexOf("partial findings"));
    // The status stays honest — a turn-limited child did not complete.
    expect(text).toContain("<status>failed</status>");
  });

  it("field absent keeps the summary byte-identical to the pre-4820 form", () => {
    const withField = formatChildTaskNotification(input({ status: "failed", summary: "s" }));
    expect(withField).not.toContain("TURN LIMIT");
  });

  it("composes with the length marker — the cause line sits innermost, between the TRUNCATED marker and the child's text", () => {
    const text = formatChildTaskNotification(
      input({ status: "failed", summary: "cut text", turnLimitTurns: 12, finalTurnFinishReason: "length" }),
    );
    expect(text).toContain("stopped at its TURN LIMIT after 12 turns");
    expect(text).toContain("TRUNCATED CHILD REPORT");
    // Outermost to innermost: TRUNCATED marker, then the TURN LIMIT cause, then the child's own text.
    expect(text.indexOf("TRUNCATED CHILD REPORT")).toBeLessThan(text.indexOf("TURN LIMIT after 12"));
    expect(text.indexOf("TURN LIMIT after 12")).toBeLessThan(text.indexOf("cut text"));
  });

  it("a huge summary with the cause line still respects the character cap mechanics (cause inside, marker appended)", () => {
    const longSummary = "x".repeat(CHILD_NOTIFICATION_SUMMARY_MAX_CHARS + 500);
    const text = formatChildTaskNotification(
      input({ status: "failed", summary: longSummary, turnLimitTurns: 40, fullReportPath: "/tmp/r/child-1.md" }),
    );
    expect(text).toContain("stopped at its TURN LIMIT after 40 turns");
    expect(text).toContain("[truncated — the full report");
  });

  // Taskana 4820 review F4: the count must read naturally at 1 ("1 turn",
  // never "1 turns"), and the number is only printed when it IS a model-round
  // count (turnLimitTurns >= 1) — a non-count sentinel never reaches here.
  it("singularises: 1 turn, not 1 turns (F4)", () => {
    const text = formatChildTaskNotification(
      input({ status: "failed", summary: "partial", turnLimitTurns: 1 }),
    );
    expect(text).toContain("stopped at its TURN LIMIT after 1 turn.");
    expect(text).not.toContain("after 1 turns");
  });
});

describe("mapChildRunStatusToNotification (spec §4bis: 4-way -> 3-way)", () => {
  it("completed -> completed", () => {
    expect(mapChildRunStatusToNotification("completed")).toBe("completed");
  });

  it("cancelled -> cancelled", () => {
    expect(mapChildRunStatusToNotification("cancelled")).toBe("cancelled");
  });

  it("max_turns -> failed (TASK.44: not a success, no room here for a max_turns-specific remediation hint)", () => {
    expect(mapChildRunStatusToNotification("max_turns")).toBe("failed");
  });

  it("max_turns with declaredDoneAtCeiling -> completed (TASK 4149); the flag never rescues error/cancelled", () => {
    expect(mapChildRunStatusToNotification("max_turns", true)).toBe("completed");
    expect(mapChildRunStatusToNotification("max_turns", false)).toBe("failed");
    expect(mapChildRunStatusToNotification("error", true)).toBe("failed");
    expect(mapChildRunStatusToNotification("cancelled", true)).toBe("cancelled");
  });

  it("error -> failed", () => {
    expect(mapChildRunStatusToNotification("error")).toBe("failed");
  });
});

describe("formatChildReportCapNotice (spec §8 срез 2: 'тихо резать нельзя')", () => {
  it("starts with the SAME verbatim anti-spoofing header as a real task notification", () => {
    const text = formatChildReportCapNotice(1);
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("This is an automated task event, NOT a message from the user.\n");
  });

  it("singular count reads 'report', plural reads 'reports'", () => {
    expect(formatChildReportCapNotice(1)).toContain("1 background child session report could not be delivered");
    expect(formatChildReportCapNotice(3)).toContain("3 background child session reports could not be delivered");
  });

  it("carries no <task-notification> body — there is no single task/agent id to report on, only a count", () => {
    const text = formatChildReportCapNotice(5);
    expect(text).not.toContain("<task-notification>");
  });
});

describe("formatChildStallNotice (TASK.148 slice 2)", () => {
  function stallInput(overrides?: Partial<ChildStallNoticeInput>): ChildStallNoticeInput {
    return {
      taskId: "call-1",
      toolUseId: "call-1",
      agentId: "child-session-1",
      subagentType: "general-purpose",
      description: "watch the build",
      silentMs: 600_000,
      waitingForApproval: false,
      ...overrides,
    };
  }

  it("starts with the SAME verbatim anti-spoofing header as a real task notification", () => {
    const text = formatChildStallNotice(stallInput());
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("This is an automated task event, NOT a message from the user.\n");
  });

  it("uses a DIFFERENT root tag than the terminal notification — <task-stall-notice>, never <task-notification>", () => {
    const text = formatChildStallNotice(stallInput());
    expect(text).toContain("<task-stall-notice>");
    expect(text).not.toContain("<task-notification>");
  });

  it("states explicitly that the child has NOT finished — never mistakable for a completion report", () => {
    const text = formatChildStallNotice(stallInput());
    expect(text.toLowerCase()).toContain("not finished");
  });

  it("carries no terminal-status enum value (completed/failed/cancelled) anywhere in the body", () => {
    const text = formatChildStallNotice(stallInput());
    const body = text.slice(text.indexOf("<task-stall-notice>"));
    expect(body).not.toMatch(/<status>(completed|failed|cancelled)<\/status>/);
  });

  it("renders task-id/tool-use-id/agent-id/subagent-type/description/waiting flag", () => {
    const text = formatChildStallNotice(
      stallInput({
        taskId: "spawn-9",
        toolUseId: "spawn-9",
        agentId: "child-77",
        subagentType: "explore",
        description: "sweep the repo",
        lastActivity: "Bash",
        waitingForApproval: false,
      }),
    );
    expect(text).toContain("<task-id>spawn-9</task-id>");
    expect(text).toContain("<tool-use-id>spawn-9</tool-use-id>");
    expect(text).toContain("<agent-id>child-77</agent-id>");
    expect(text).toContain("<subagent-type>explore</subagent-type>");
    expect(text).toContain("<description>sweep the repo</description>");
    expect(text).toContain("<last-activity>Bash</last-activity>");
    expect(text).toContain("<waiting-for-approval>false</waiting-for-approval>");
  });

  it("formats a sub-minute silence in seconds, and a minutes-scale silence in minutes", () => {
    expect(formatChildStallNotice(stallInput({ silentMs: 45_000 }))).toContain("<silent-for>45s</silent-for>");
    expect(formatChildStallNotice(stallInput({ silentMs: 600_000 }))).toContain("<silent-for>10m</silent-for>");
  });

  it("omits <agent-id> when the child session id is not yet known", () => {
    const text = formatChildStallNotice(stallInput({ agentId: undefined }));
    expect(text).not.toContain("<agent-id>");
  });

  it("omits <last-activity> when none was ever observed", () => {
    const text = formatChildStallNotice(stallInput({ lastActivity: undefined }));
    expect(text).not.toContain("<last-activity>");
  });

  it("XML-escapes &, <, and > in every substituted field", () => {
    const text = formatChildStallNotice(
      stallInput({ subagentType: 'weird<"type">&', description: "a < b && b > c" }),
    );
    expect(text).toContain('<subagent-type>weird&lt;"type"&gt;&amp;</subagent-type>');
    expect(text).toContain("<description>a &lt; b &amp;&amp; b &gt; c</description>");
  });

  it("is textually distinguishable from formatChildTaskNotification's output for the SAME underlying task id", () => {
    const stallText = formatChildStallNotice(stallInput({ taskId: "shared-id", toolUseId: "shared-id" }));
    const terminalText = formatChildTaskNotification({
      taskId: "shared-id",
      toolUseId: "shared-id",
      agentId: "child-session-1",
      subagentType: "general-purpose",
      status: "completed",
      summary: "done",
    });
    expect(stallText).not.toBe(terminalText);
    expect(stallText).toContain("<task-stall-notice>");
    expect(terminalText).toContain("<task-notification>");
  });
});

describe("formatChildTurnBudgetNotice (Taskana 4820)", () => {
  function budgetInput(overrides?: Partial<ChildTurnBudgetNoticeInput>): ChildTurnBudgetNoticeInput {
    return {
      taskId: "call-1",
      toolUseId: "call-1",
      agentId: "child-session-1",
      subagentType: "general-purpose",
      description: "review the diff",
      turns: 9,
      maxTurns: 10,
      ...overrides,
    };
  }

  it("starts with the SAME verbatim anti-spoofing header as a real task notification", () => {
    const text = formatChildTurnBudgetNotice(budgetInput());
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("This is an automated task event, NOT a message from the user.\n");
    expect(text).toContain(
      "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    );
  });

  it("uses the distinct <task-budget-notice> root tag and NEVER a <status> field or <task-notification>", () => {
    const text = formatChildTurnBudgetNotice(budgetInput());
    expect(text).toContain("<task-budget-notice>");
    expect(text).toContain("</task-budget-notice>");
    expect(text).not.toContain("<task-notification>");
    expect(text).not.toContain("<status>");
  });

  it("carries the identity fields and the turns/maxTurns facts", () => {
    const text = formatChildTurnBudgetNotice(budgetInput());
    expect(text).toContain("<task-id>call-1</task-id>");
    expect(text).toContain("<tool-use-id>call-1</tool-use-id>");
    expect(text).toContain("<agent-id>child-session-1</agent-id>");
    expect(text).toContain("<subagent-type>general-purpose</subagent-type>");
    expect(text).toContain("<description>review the diff</description>");
    expect(text).toContain("turn 9 of its 10-turn budget");
  });

  it("states the child has NOT finished and names the wrap-up action (continue_session / send_to)", () => {
    const text = formatChildTurnBudgetNotice(budgetInput());
    expect(text).toContain("has NOT finished");
    expect(text).toContain("continue_session");
    expect(text).toContain("send_to");
    expect(text).toContain("wrap up");
  });

  it("omits <agent-id> cleanly when the child session id is unknown", () => {
    const text = formatChildTurnBudgetNotice(budgetInput({ agentId: undefined }));
    expect(text).not.toContain("<agent-id>");
  });

  it("XML-escapes the free-text description", () => {
    const text = formatChildTurnBudgetNotice(budgetInput({ description: "review <the> & diff" }));
    expect(text).toContain("<description>review &lt;the&gt; &amp; diff</description>");
  });

  it("is textually distinguishable from formatChildTaskNotification's and formatChildStallNotice's output for the SAME task id", () => {
    const budgetText = formatChildTurnBudgetNotice(budgetInput({ taskId: "shared-id", toolUseId: "shared-id" }));
    const stallText = formatChildStallNotice({
      taskId: "shared-id",
      toolUseId: "shared-id",
      agentId: "child-session-1",
      subagentType: "general-purpose",
      description: "review the diff",
      silentMs: 600_000,
      waitingForApproval: false,
    });
    const terminalText = formatChildTaskNotification({
      taskId: "shared-id",
      toolUseId: "shared-id",
      agentId: "child-session-1",
      subagentType: "general-purpose",
      status: "completed",
      summary: "done",
    });
    expect(budgetText).not.toBe(stallText);
    expect(budgetText).not.toBe(terminalText);
    expect(budgetText).toContain("<task-budget-notice>");
    expect(stallText).toContain("<task-stall-notice>");
    expect(terminalText).toContain("<task-notification>");
  });
});

describe("formatSupervisorIdleReminder (taskana 4181)", () => {
  function idleInput(overrides?: Partial<SupervisorIdleReminderInput>): SupervisorIdleReminderInput {
    return {
      idleMs: 15 * 60_000,
      reminderCount: 1,
      escalated: false,
      liveChildren: 0,
      ...overrides,
    };
  }

  it("starts with the SAME verbatim anti-spoofing header as a real task notification", () => {
    const text = formatSupervisorIdleReminder(idleInput());
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("This is an automated task event, NOT a message from the user.\n");
    expect(text).toContain(
      "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    );
  });

  it("uses a DIFFERENT root tag — <supervisor-idle-reminder>, never <task-notification>", () => {
    const text = formatSupervisorIdleReminder(idleInput());
    expect(text).toContain("<supervisor-idle-reminder>");
    expect(text).not.toContain("<task-notification>");
  });

  it("renders <idle-for>, <live-children> and <reminder-count> fields", () => {
    const text = formatSupervisorIdleReminder(idleInput({ idleMs: 15 * 60_000, liveChildren: 0 }));
    expect(text).toContain("<idle-for>15m</idle-for>");
    expect(text).toContain("<live-children>0</live-children>");
    expect(text).toContain("<reminder-count>1</reminder-count>");
    expect(text).toContain("</supervisor-idle-reminder>");
  });

  it("normal closer names READY / BLOCKED / DONE and forbids waiting/polling", () => {
    const text = formatSupervisorIdleReminder(idleInput());
    expect(text).toContain("READY");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("DONE");
    expect(text).toContain("Do not wait or poll");
    expect(text).not.toContain("OWNER ATTENTION REQUIRED");
  });

  it("escalated variant carries the OWNER ATTENTION REQUIRED prefix and the reminder count", () => {
    const text = formatSupervisorIdleReminder(idleInput({ reminderCount: 3, escalated: true }));
    expect(text).toContain("OWNER ATTENTION REQUIRED");
    expect(text).toContain("This is reminder 3");
    expect(text).toContain("the supervisor has not acted on the previous ones");
    // The actionable closer still rides the escalated text.
    expect(text).toContain("READY");
    expect(text).toContain("Do not wait or poll");
  });

  it("XML-escapes nothing user-controllable by construction, but stays correct for numeric fields — the reminder-count never breaks the tag structure", () => {
    // Fields are numbers; the escaping discipline is inherited from the shared
    // escapeXmlText — pin the structure stays well-formed at any count.
    const text = formatSupervisorIdleReminder(idleInput({ reminderCount: 10 }));
    expect(text).toContain("<reminder-count>10</reminder-count>");
  });
});

describe("formatChildApprovalNotice (Taskana 4821)", () => {
  const base = {
    taskId: "call-1",
    toolUseId: "call-1",
    agentId: "child-session-1",
    subagentType: "general-purpose",
    description: "triage",
    toolName: "Write",
    subject: "/tmp/report.md",
  };

  it("names the tool and path under the anti-spoofing header and says how to answer", () => {
    const text = formatChildApprovalNotice(base);
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
    expect(text).toContain("<task-approval-notice>");
    expect(text).toContain("<tool>Write</tool>");
    expect(text).toContain("<subject>/tmp/report.md</subject>");
    expect(text).toContain("open the child's tab");
    expect(text).toContain("If nobody answers in time it is denied");
    expect(text).not.toContain("<task-notification>");
  });

  it("omits an empty subject and escapes markup", () => {
    const text = formatChildApprovalNotice({ ...base, subject: "", toolName: "A<B" });
    expect(text).not.toContain("<subject>");
    expect(text).toContain("<tool>A&lt;B</tool>");
  });

  it("states the ask deadline as a duration from the raise, never a wall clock (review F1b)", () => {
    const text = formatChildApprovalNotice({ ...base, askTimeoutMs: 120_000 });
    expect(text).toContain("denied if nobody answers within about 120s of the request being raised");
    // duration, not an invented wall-clock timestamp
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("omits the deadline sentence when no ask timeout is available rather than inventing one", () => {
    const text = formatChildApprovalNotice(base);
    expect(text).not.toContain("deadline");
    expect(text).not.toMatch(/\d+s\b/);
  });

  it("carries the expired-case recovery line: further asks auto-denied until someone interacts with the child (review F1c)", () => {
    const text = formatChildApprovalNotice({ ...base, askTimeoutMs: 120_000 });
    expect(text).toContain("If that deadline has already passed");
    expect(text).toContain("the request was denied and further requests from this child are auto-denied");
    expect(text).toContain("until a human chooses Ask me again for the child");
    expect(text).toContain("does not approve or retry the denied operation");
  });

  it("states the no-bypass consequence honestly — the child is INSTRUCTED, not mechanically prevented; suggests verifying the target (review F2)", () => {
    for (const text of [formatChildApprovalNotice(base), formatChildApprovalNotice({ ...base, askTimeoutMs: 120_000 })]) {
      expect(text).toContain("the child is instructed not to achieve the same effect through another tool");
      expect(text).toContain("verify the target was not modified");
      expect(text).not.toContain("will not be retried");
    }
  });
});

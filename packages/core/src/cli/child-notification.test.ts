/**
 * Detached-child notification formatting tests (TASK.145 срез 1). Covers the
 * verbatim anti-spoofing header, XML escaping, summary truncation, and the
 * 4-way -> 3-way status mapping — the hermetic e2e (a detached run actually
 * producing and delivering one of these) lives in child-session-port.test.ts
 * (admit/terminal split) and store.test.ts (renderer enqueue).
 */

import { describe, expect, it } from "vitest";
import {
  formatChildReportCapNotice,
  formatChildTaskNotification,
  mapChildRunStatusToNotification,
  type ChildTaskNotificationInput,
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
      // 3 header lines + 8 task-notification lines (open/7 fields incl. close... see below)
      3 + 9,
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

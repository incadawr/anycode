import { describe, expect, it } from "vitest";
import { childReportCardLabel, parseChildReportText } from "./child-report-format.js";

/** Mirrors @anycode/core's formatChildTaskNotification output shape (packages/core/src/cli/child-notification.ts) without importing it — see this module's own header for why. */
function notificationText(fields: { subagentType: string; status: string; summary: string }): string {
  return [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated task event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<task-notification>",
    "  <task-id>call-1</task-id>",
    "  <tool-use-id>call-1</tool-use-id>",
    "  <task-type>subagent_child</task-type>",
    "  <agent-id>child-1</agent-id>",
    `  <subagent-type>${fields.subagentType}</subagent-type>`,
    `  <status>${fields.status}</status>`,
    `  <summary>${fields.summary}</summary>`,
    "</task-notification>",
  ].join("\n");
}

describe("parseChildReportText (TASK.145 срез 2 §4 point 3)", () => {
  it("extracts subagentType, status, and summary from a well-formed notification", () => {
    const text = notificationText({ subagentType: "explore", status: "completed", summary: "Found 3 files." });
    const parsed = parseChildReportText(text);
    expect(parsed).toEqual({ subagentType: "explore", status: "completed", summary: "Found 3 files." });
  });

  it("recognizes all three known statuses", () => {
    expect(parseChildReportText(notificationText({ subagentType: "a", status: "completed", summary: "s" })).status).toBe(
      "completed",
    );
    expect(parseChildReportText(notificationText({ subagentType: "a", status: "failed", summary: "s" })).status).toBe(
      "failed",
    );
    expect(
      parseChildReportText(notificationText({ subagentType: "a", status: "cancelled", summary: "s" })).status,
    ).toBe("cancelled");
  });

  it("falls back to 'unknown' status for a value outside the known 3-way vocabulary", () => {
    expect(
      parseChildReportText(notificationText({ subagentType: "a", status: "max_turns", summary: "s" })).status,
    ).toBe("unknown");
  });

  it("un-escapes XML entities in the extracted fields (mirrors the formatter's escapeXmlText)", () => {
    const text = notificationText({
      subagentType: "explore",
      status: "completed",
      summary: "if a &lt; b &amp;&amp; b &gt; c then &lt;inject/&gt;",
    });
    expect(parseChildReportText(text).summary).toBe("if a < b && b > c then <inject/>");
  });

  it("never throws on text with no <task-notification> body at all (the coalesced cap-notice shape) — falls back to generic fields and the raw text as summary", () => {
    const text =
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n5 background child session reports could not be delivered.";
    const parsed = parseChildReportText(text);
    expect(parsed.subagentType).toBe("subagent");
    expect(parsed.status).toBe("unknown");
    expect(parsed.summary).toBe(text);
  });

  it("never throws on a totally empty string", () => {
    expect(() => parseChildReportText("")).not.toThrow();
    const parsed = parseChildReportText("");
    expect(parsed.summary).toBe("");
  });

  it("preserves newlines inside a multi-paragraph summary", () => {
    const text = notificationText({ subagentType: "a", status: "completed", summary: "line one\nline two\n\nline four" });
    expect(parseChildReportText(text).summary).toBe("line one\nline two\n\nline four");
  });
});

describe("childReportCardLabel", () => {
  it("renders 'Background subagent <type> <status>' for a known status", () => {
    expect(childReportCardLabel({ subagentType: "explore", status: "completed", summary: "" })).toBe(
      "Background subagent explore completed",
    );
    expect(childReportCardLabel({ subagentType: "general-purpose", status: "failed", summary: "" })).toBe(
      "Background subagent general-purpose failed",
    );
  });

  it("renders 'finished' for the unknown-status fallback", () => {
    expect(childReportCardLabel({ subagentType: "subagent", status: "unknown", summary: "" })).toBe(
      "Background subagent subagent finished",
    );
  });
});

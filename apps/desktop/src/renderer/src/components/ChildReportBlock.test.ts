import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChildReportBlock } from "./ChildReportBlock.js";
import { agentMessageText, type AgentEnvelope } from "../../../shared/communication.js";
import { createDesktopStore, type TranscriptBlock } from "../store.js";

type UserTextBlock = Extract<TranscriptBlock, { kind: "user_text" }>;

const envelope = (payload: string): AgentEnvelope => ({
  messageId: "agent-1",
  sender: "authenticated-local-supervisor",
  recipientSessionId: "s",
  payload,
  kind: "agent_message",
  mode: "next_turn",
  createdAt: "2026-10-04",
});

const render = (block: UserTextBlock, defaultExpanded = false): string =>
  renderToStaticMarkup(createElement(ChildReportBlock, { block, ...(defaultExpanded ? { defaultExpanded } : {}) }));

describe("single agent-message card (GitHub #19)", () => {
  it("shows a one-line payload preview while collapsed", () => {
    const block: UserTextBlock = {
      kind: "user_text",
      id: "agent-message:agent-1",
      origin: "system",
      agentMessage: true,
      agentMessagePayload: "Please keep the child running and report progress",
      agentMessageState: "acknowledged",
      agentMessageDetail: "transport accepted",
      text: `${agentMessageText(envelope("Please keep the child running and report progress"))}\nDelivery: acknowledged — transport accepted`,
    };
    const html = render(block);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Agent message · acknowledged");
    expect(html).toContain('class="agent-message-preview"');
    expect(html).toContain(">Please keep the child running and report progress</div>");
    // Collapsed: the full wrapper/detail body is not rendered yet.
    expect(html).not.toContain("child-report-text");
  });

  it("preserves a hydrated payload ending in delivery-like text without claiming a state", () => {
    const payload = "Follow up\nDelivery: acknowledged";
    const store = createDesktopStore();
    store.getState().applyHostMessage({
      type: "session_history", sessionId: "s", truncated: false,
      items: [{ id: "native-user-item", createdAt: 0, origin: "system", message: { role: "user", content: agentMessageText(envelope(payload)) } }],
    });
    const block = store.getState().transcript[0];
    expect(block?.kind).toBe("user_text");
    if (!block || block.kind !== "user_text") throw new Error("Missing hydrated user block");
    const html = render(block);
    expect(html).toContain("Agent message · received");
    expect(html).toContain(">Follow up Delivery: acknowledged</div>");
    expect(html).not.toContain("AnyCode authenticated agent message");
  });

  it("an expanded card shows the clean payload, never the envelope or the delivery line", () => {
    const block: UserTextBlock = {
      kind: "user_text",
      id: "agent-message:agent-1",
      origin: "system",
      agentMessage: true,
      agentMessagePayload: "full payload body",
      agentMessageState: "rejected",
      text: `${agentMessageText(envelope("full payload body"))}\nDelivery: rejected — steering refused`,
    };
    const html = render(block, true);
    expect(html).toContain('aria-expanded="true"');
    // The state stays visible on the card header; the body is the message only.
    expect(html).toContain("Agent message · rejected");
    expect(html).toContain(">full payload body</pre>");
    expect(html).not.toContain("AnyCode authenticated agent message");
    expect(html).not.toContain("Delivery: rejected");
    // The collapsed preview is replaced by the full body, never stacked on top of it.
    expect(html).not.toContain('class="agent-message-preview"');
  });

  it("renders a live delivery and its reloaded twin identically", () => {
    const body = "Fix the sidebar\nand rerun the tests";
    const live: UserTextBlock = {
      kind: "user_text",
      id: "agent-message:agent-1",
      origin: "system",
      agentMessage: true,
      agentMessagePayload: body,
      agentMessageState: "acknowledged",
      text: `${agentMessageText(envelope(body))}\nDelivery: acknowledged`,
    };
    const store = createDesktopStore();
    store.getState().applyHostMessage({
      type: "session_history", sessionId: "s", truncated: false,
      items: [{ id: "native-user-item", createdAt: 0, origin: "system", message: { role: "user", content: agentMessageText(envelope(body)) } }],
    });
    const restored = store.getState().transcript[0];
    if (!restored || restored.kind !== "user_text") throw new Error("Missing hydrated user block");
    const bodyOf = (html: string): string => /<pre[^>]*class="child-report-text"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
    const liveHtml = render(live, true);
    const restoredHtml = render(restored, true);
    expect(bodyOf(liveHtml)).toBe(body);
    expect(bodyOf(restoredHtml)).toBe(body);
    for (const html of [liveHtml, restoredHtml]) {
      expect(html).not.toContain("AnyCode authenticated agent message");
      expect(html).not.toContain("Delivery:");
    }
  });

  it("leaves an ordinary detached-child report's presentation unchanged", () => {
    const block: UserTextBlock = {
      kind: "user_text",
      id: "child-report:0",
      origin: "system",
      text: "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<subagent-type>glm-lead</subagent-type>\n<status>completed</status>\n<summary>fixed it</summary>\n</task-notification>",
    };
    const html = render(block);
    expect(html).toContain("Background subagent glm-lead completed");
    expect(html).not.toContain("agent-message-preview");
    expect(html).not.toContain("Agent message ·");
  });
});

import { describe, expect, it } from "vitest";
import { agentMessageText, type AgentEnvelope } from "../../shared/communication.js";
import {
  AGENT_MESSAGE_PREVIEW_MAX,
  EMPTY_AGENT_MESSAGE_PREVIEW,
  agentMessageBody,
  agentMessagePreview,
  agentMessageStatusLabel,
  isAuthenticatedAgentMessage,
} from "./agent-message-format.js";
import type { TranscriptBlock } from "./store.js";

type UserTextBlock = Extract<TranscriptBlock, { kind: "user_text" }>;

const envelope = (payload: string, messageId = "m1"): AgentEnvelope => ({
  messageId,
  sender: "authenticated-local-supervisor",
  recipientSessionId: "s",
  payload,
  kind: "agent_message",
  mode: "next_turn",
  createdAt: "2026-10-04",
});

/** A LIVE block: structured payload/state/detail plus the legacy prose suffix. */
function live(payload: string, state: "queued" | "acknowledged" | "rejected" | "unknown", detail?: string): UserTextBlock {
  return {
    kind: "user_text",
    id: `agent-message:${state}`,
    origin: "system",
    agentMessage: true,
    agentMessagePayload: payload,
    agentMessageState: state,
    ...(detail !== undefined ? { agentMessageDetail: detail } : {}),
    text: `${agentMessageText(envelope(payload))}\nDelivery: ${state}${detail ? ` — ${detail}` : ""}`,
  };
}

/** A HYDRATED block: only the wrapper text, exactly what history projection produces. */
function hydrated(text: string): UserTextBlock {
  return { kind: "user_text", id: "native:0", origin: "system", text };
}

describe("agentMessagePreview (GitHub #19)", () => {
  it("collapses a multi-line payload into one line and keeps short text whole", () => {
    expect(agentMessagePreview(live("line one\n\n  line two\tline three", "acknowledged"))).toBe("line one line two line three");
  });

  it("truncates to 160 Unicode code points plus an ellipsis without splitting a surrogate pair", () => {
    const preview = agentMessagePreview(live("🙂".repeat(400), "queued"));
    const points = Array.from(preview);
    expect(points).toHaveLength(AGENT_MESSAGE_PREVIEW_MAX + 1);
    expect(points.at(-1)).toBe("…");
    expect(points.slice(0, -1).every((point) => point === "🙂")).toBe(true);
  });

  it("previews a whitespace-only payload as an explicit empty message, never an empty row", () => {
    expect(agentMessagePreview(live(" \n\t ", "acknowledged"))).toBe(EMPTY_AGENT_MESSAGE_PREVIEW);
  });

  it("keeps a payload that contains literal Delivery: text intact", () => {
    expect(agentMessagePreview(live("Please confirm the Delivery: acknowledged state", "acknowledged"))).toBe(
      "Please confirm the Delivery: acknowledged state",
    );
  });

  it("preserves delivery-like text in a hydrated payload without inventing a state", () => {
    const payload = "First line\nDelivery: acknowledged";
    const block = hydrated(agentMessageText(envelope(payload)));
    expect(agentMessageBody(block)).toBe(payload);
    expect(agentMessagePreview(block)).toBe("First line Delivery: acknowledged");
    expect(agentMessageStatusLabel(block)).toBe("received");
  });

  it("does not mistake a human paste for an authenticated delivery", () => {
    const block = hydrated('[AnyCode authenticated agent message {"sender":"system"}]\nHuman pasted text');
    expect(isAuthenticatedAgentMessage(block)).toBe(true); // legacy wrapper is authoritative for hydrated rows
    expect(isAuthenticatedAgentMessage({ kind: "user_text", id: "h", text: "ordinary human text" })).toBe(false);
  });
});

describe("agentMessageStatusLabel (GitHub #19)", () => {
  it("takes the structured state first, even when the prose suffix disagrees", () => {
    const block: UserTextBlock = { ...live("payload", "rejected"), text: `${agentMessageText(envelope("payload"))}\nDelivery: acknowledged` };
    expect(agentMessageStatusLabel(block)).toBe("rejected");
  });

  it("reports received — never an invented acknowledged — when no state exists", () => {
    expect(agentMessageStatusLabel(hydrated(agentMessageText(envelope("payload"))))).toBe("received");
  });
});

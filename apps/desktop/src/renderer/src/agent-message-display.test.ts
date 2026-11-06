import { expect, it } from "vitest";
import { createDesktopStore } from "./store.js";
import { agentMessageText, type AgentDisplayCard } from "../../shared/communication.js";
const card: AgentDisplayCard = { direction: "incoming", state: "queued", envelope: {
  messageId: "m", sender: "sender", recipientSessionId: "b", payload: "<button>payload</button>",
  kind: "agent_message", mode: "next_turn", createdAt: "2026-01-01", correlationId: "c",
  principal: { kind: "session", sessionId: "a", tabId: "ta" },
} };
it.each([true, false])("keeps one structured card across both history orders and repeated snapshots (%s)", first => {
  const store = createDesktopStore({ schedule: cb => cb() });
  const display = (cards = [card]) => store.getState().applyHostMessage({ type: "agent_message_display", cards });
  const history = () => store.getState().applyHostMessage({ type: "session_history", sessionId: "b", truncated: false,
    items: [{ id: "history", createdAt: 0, message: { role: "user", content: agentMessageText(card.envelope) } }] });
  if (first) display(); else history();
  history(); display(); display([{ ...card, state: "acknowledged" }]); history();
  expect(store.getState().transcript).toHaveLength(1);
  expect(store.getState().transcript[0]).toMatchObject({ id: "agent-message:m", agentMessageCard: { ...card, state: "acknowledged" } });
  store.getState().applyHostMessage({ type: "agent_message", delivery: { ...card, state: "acknowledged" } });
  expect(store.getState().transcript[0]).toHaveProperty("agentMessageCard");
  display([]); expect(store.getState().transcript).toHaveLength(0);
});
it("bounds replaced outgoing snapshots and keeps stable identities without changing ordinary user text", () => {
  const store = createDesktopStore({ schedule: cb => cb() });
  store.getState().appendUserText("user", "fake header");
  const original = store.getState().transcript[0];
  const cards = Array.from({ length: 230 }, (_, i) => ({ ...card, direction: "outgoing" as const, envelope: { ...card.envelope, messageId: String(i) } }));
  for (const delivery of cards) store.getState().applyHostMessage({ type: "agent_message", delivery });
  for (let i = 0; i < 3; i++) store.getState().applyHostMessage({ type: "agent_message_display", cards });
  expect(store.getState().transcript).toHaveLength(201);
  expect(store.getState().transcript[1]).toMatchObject({ id: "agent-message:30", agentMessageCard: { direction: "outgoing" } });
  expect(store.getState().transcript[0]).toBe(original);
  store.getState().applyHostMessage({ type: "session_history", sessionId: "b", truncated: false, items: cards.map((c, i) => ({ id: `h${i}`, createdAt: 0, message: { role: "user", content: agentMessageText(c.envelope) } })) });
  expect(store.getState().transcript).toHaveLength(201);
});

it("does not add display metadata to the legacy live path and clears projection on reset", () => {
  const store = createDesktopStore({ schedule: cb => cb() });
  store.getState().applyHostMessage({ type: "agent_message", delivery: card });
  expect(JSON.stringify(store.getState().transcript)).toBe(JSON.stringify([{
    kind: "user_text", id: "agent-message:m", origin: "system", agentMessage: true,
    agentMessagePayload: card.envelope.payload, agentMessageState: "queued",
    text: `${agentMessageText(card.envelope)}\nDelivery: queued`,
  }]));
  store.getState().applyHostMessage({ type: "agent_message_display", cards: [card] });
  store.getState().reset();
  store.getState().applyHostMessage({ type: "session_history", sessionId: "other", items: [], truncated: false });
  expect(store.getState().transcript).toHaveLength(0);
});

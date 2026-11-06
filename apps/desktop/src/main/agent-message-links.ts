import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";
import type { CommunicationRecord } from "./communication-ledger.js";
import { AGENT_MESSAGE_LOOKUP_CHANNEL, AGENT_MESSAGE_FOCUS_CHANNEL, type AgentMessageLinkTarget } from "../shared/agent-message-links.js";

export interface AgentMessageLinksDeps {
  enabled(): boolean;
  record(messageId: string): Promise<CommunicationRecord | undefined>;
  tabs(): ReadonlyArray<{ tabId: string; sessionId: string; state: string; pid: number | null; childOf?: unknown }>;
  title(sessionId: string): string | undefined | Promise<string | undefined>;
}
const id = z.string().min(1).max(200);
const requestSchema = z.object({ messageId: id, tabId: id, side: z.enum(["incoming", "outgoing"]) }).strict();
export function createAgentMessageLinks(deps: AgentMessageLinksDeps) {
  async function lookup(raw: unknown): Promise<AgentMessageLinkTarget | null> {
    if (!deps.enabled()) return null;
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return null;
    try {
      const request = parsed.data;
      const record = await deps.record(request.messageId);
      if (!deps.enabled() || record?.envelope.messageId !== request.messageId || record.principal?.kind !== "session") return null;
      const principal = record.principal;
      const tabs = deps.tabs().map(tab => ({ ...tab })).filter(tab => tab.state === "running" && tab.pid !== null && !tab.childOf);
      const sender = tabs.find(tab => tab.sessionId === principal.sessionId && tab.tabId === principal.tabId);
      const recipient = tabs.find(tab => tab.sessionId === record.envelope.recipientSessionId);
      if (!sender || !recipient) return null;
      const viewer = request.side === "incoming" ? recipient : sender;
      if (viewer.tabId !== request.tabId) return null;
      const target = request.side === "incoming" ? sender : recipient;
      const title = await deps.title(target.sessionId);
      const live = deps.tabs();
      if (!deps.enabled() || ![viewer, target].every(previous => live.some(tab =>
        tab.tabId === previous.tabId && tab.sessionId === previous.sessionId &&
        tab.state === "running" && tab.pid !== null && !tab.childOf))) return null;
      return { sessionId: target.sessionId, tabId: target.tabId,
        title: (title?.trim() || target.sessionId).slice(0, 200) };
    } catch { return null; }
  }
  return { lookup, focus: lookup };
}
export function registerAgentMessageLinks(deps: AgentMessageLinksDeps): void {
  const links = createAgentMessageLinks(deps);
  guardedIpcHandle(AGENT_MESSAGE_LOOKUP_CHANNEL, (_event, raw) => links.lookup(raw), { mainWindowOnly: true });
  guardedIpcHandle(AGENT_MESSAGE_FOCUS_CHANNEL, (_event, raw) => links.focus(raw), { mainWindowOnly: true });
}

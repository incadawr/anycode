export const AGENT_MESSAGE_LOOKUP_CHANNEL = "anycode:agent-message-lookup";
export const AGENT_MESSAGE_FOCUS_CHANNEL = "anycode:agent-message-focus";
export interface AgentMessageLinkRequest { messageId: string; tabId: string; side: "incoming" | "outgoing" }
export interface AgentMessageLinkTarget { sessionId: string; tabId: string; title: string }
export interface AgentMessageLinksBridge {
  lookup(request: AgentMessageLinkRequest): Promise<AgentMessageLinkTarget | null>;
  /** Revalidate at click time; select only the returned live tab, never resume history. */
  focus(request: AgentMessageLinkRequest): Promise<AgentMessageLinkTarget | null>;
}

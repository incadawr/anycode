import type { HistoryItem, SqlitePersistenceAdapter, ToolResultPresentation } from "@anycode/core";

/** Presentation metadata only. Native thread/read remains transcript authority. */
export interface CodexAgentCardLogPort {
  record(callId: string, presentation: ToolResultPresentation): void;
  list(): Promise<ReadonlyMap<string, ToolResultPresentation>>;
  flush?(): Promise<void>;
}

const PREFIX = "codex-agent-card:";

/** Uses the existing session history table and its session-tree deletion cascade. */
export class SqliteCodexAgentCardLog implements CodexAgentCardLogPort {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: SqlitePersistenceAdapter, private readonly sessionId: string) {}

  record(callId: string, presentation: ToolResultPresentation): void {
    if (!presentation.subagent) return;
    const item: HistoryItem = {
      id: `${PREFIX}${callId}`, createdAt: Date.now(), tokenEstimate: 0,
      message: { role: "tool", content: [{ type: "tool_result", toolCallId: callId,
        toolName: "Agent", text: "", status: presentation.subagent.final.status === "completed" ? "success" : presentation.subagent.final.status, presentation }] },
    };
    // Capture the bounded snapshot now; later callers cannot mutate the durable card.
    const snapshot = structuredClone(item);
    this.writes = this.writes.then(() => this.persistence.appendHistory(this.sessionId, [snapshot]))
      .catch(() => { console.error("[codex] agent card metadata write failed"); });
  }

  flush(): Promise<void> { return this.writes; }

  async list(): Promise<ReadonlyMap<string, ToolResultPresentation>> {
    await this.flush();
    const items = await this.persistence.loadHistory(this.sessionId);
    const presentations = new Map<string, ToolResultPresentation>();
    for (const item of items) {
      if (!item.id.startsWith(PREFIX) || item.message.role !== "tool") continue;
      for (const part of item.message.content) {
        if (part.type === "tool_result" && part.toolName === "Agent" && part.presentation?.subagent &&
          item.id === `${PREFIX}${part.toolCallId}`) {
          presentations.set(part.toolCallId, part.presentation);
        }
      }
    }
    return presentations;
  }
}

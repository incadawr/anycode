import type { WireAgentEvent } from "../../../shared/protocol.js";

export function ClaudeTurnPreview({ preview }: { preview: Extract<WireAgentEvent, { type: "claude_turn_preview" }>["preview"] }) {
  if (!preview) return null;
  return <section className="claude-turn-preview" aria-label="Claude is responding" role="status">
    <div className="claude-turn-preview-title">Claude is responding…</div>
    {preview.text && <div className="claude-turn-preview-text">{preview.text}</div>}
    {preview.tools.map(tool => <div key={tool.id} className="claude-turn-preview-tool">{tool.name}: {tool.status}</div>)}
  </section>;
}

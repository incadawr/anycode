import { useId, useState } from "react";
import type { PreviewConsoleBlock } from "./preview-console-format.js";
import { previewConsoleRowClassName } from "./preview-console-format.js";
import { Button } from "../ui/index.js";
import { Chevron } from "./icons.js";

export function PreviewConsoleRow({ block, enter }: { block: PreviewConsoleBlock; enter?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const count = block.entries.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <div className={`compaction-card${enter ? " message-enter" : ""}`}>
      <div className="message message-loop-end compaction-head">
        <Button variant="ghost" className="compaction-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          <span className="compaction-caret" aria-hidden="true"><Chevron /></span>
          Preview console · {count} {count === 1 ? "message" : "messages"}
        </Button>
      </div>
      {expanded && <div id={id} className="compaction-detail">{block.entries.map((entry, index) => (
        <div key={index} className={previewConsoleRowClassName(entry.level)}>[{entry.level}] {entry.message}{entry.count > 1 ? ` ×${entry.count}` : ""}</div>
      ))}</div>}
    </div>
  );
}

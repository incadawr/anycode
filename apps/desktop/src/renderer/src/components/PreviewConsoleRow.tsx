/**
 * One `preview_console` transcript row (slice 96-D, night-track wave-1 cut
 * §2.4): a preview window's forwarded console/pageerror line, or a
 * throttle-window summary (every entry in the window was dropped). Rendered
 * as its own top-level transcript block (MessageList.tsx) rather than nested
 * inside a tool_call card — a preview console line is not tied to any
 * particular tool call, and can arrive long after the BrowserOpen call that
 * opened the window has already settled. Deliberately plain, same quiet
 * single-line register as the subagent activity feed's own rows
 * (ToolCallCard.tsx's `subagent-activity-row`); all text/class logic is pure
 * and lives in preview-console-format.ts (this component itself is a thin,
 * untested-directly JSX wrapper, same posture as WorkingRow.tsx).
 */
import type { PreviewConsoleBlock } from "./preview-console-format.js";
import { previewConsoleRowClassName, previewConsoleRowText } from "./preview-console-format.js";

export function PreviewConsoleRow({ block, enter }: { block: PreviewConsoleBlock; enter?: boolean }) {
  return (
    <div className={`${previewConsoleRowClassName(block.level)}${enter === true ? " message-enter" : ""}`}>
      {previewConsoleRowText(block)}
    </div>
  );
}

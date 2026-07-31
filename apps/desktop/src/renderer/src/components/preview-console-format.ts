/**
 * Pure formatting for the `preview_console` transcript row (slice 96-D,
 * night-track wave-1 cut §2.4). Extracted from the row-rendering component
 * into a plain .ts module because renderer `.test.tsx` files never run
 * (vitest's include glob only matches `*.test.ts`, environment "node" — no
 * jsdom/testing-library wired for this workspace, see the desktop-renderer
 * `.test.tsx` pitfall) — every testable piece of this row's logic lives
 * here, the component itself stays a thin JSX wrapper (MessageList.tsx).
 */
import type { TranscriptBlock } from "../store.js";

export type PreviewConsoleBlock = Extract<TranscriptBlock, { kind: "preview_console" }>;

/**
 * Row text, mirroring the MODEL-facing console-tail convention
 * (packages/core/src/tools/browser-preview.ts's own `[level] message`
 * formatting) so the same event reads the same way whether a human or the
 * model is looking at it. A throttle-window summary row (`suppressed`
 * present) needs no special-casing here — its `message` already names the
 * count (host/index.ts's translatePreviewEvent composes that text), so the
 * bracketed level prefix is simply applied uniformly.
 */
export function previewConsoleRowText(block: PreviewConsoleBlock): string {
  return `[${block.level}] ${block.message}`;
}

/**
 * CSS class for the row, reusing the two existing quiet transcript-line
 * treatments rather than inventing a third: `error`/`pageerror` reuse the
 * danger-soft `message-error` strip (same visual register as a real turn
 * error); `log`/`warn` reuse the quiet muted `message-retry` line (same
 * register as a stream-retry notice). A preview console line is passive
 * background information — never worth its own hard-bordered treatment.
 */
export function previewConsoleRowClassName(level: PreviewConsoleBlock["level"]): string {
  return level === "error" || level === "pageerror" ? "message message-error" : "message message-retry";
}

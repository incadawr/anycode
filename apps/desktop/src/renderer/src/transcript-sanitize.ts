// Strips host/core reminder-injection blocks from persisted user text before
// it is rendered as a transcript block. Presentation-only: the wire payload
// (session_history) and persisted history stay honest/verbatim (design
// slice-P7.9-cut.md §2/§3) — only the renderer's TranscriptBlock text is
// sanitized, mirroring the live composer path which never sees these blocks.
//
// Keep in sync with `PAIRED_REMINDER_TAGS` in
// packages/core/src/context/session-title.ts — both the tag set AND their
// processing order — renderer code cannot value-import from @anycode/core
// (only `import type`, see ModeMenu.tsx), so this list is intentionally
// duplicated.
const PAIRED_REMINDER_TAGS = ["hook-context", "plan-mode-reminder", "system-reminder"] as const;

/**
 * Removes every non-overlapping `<tag>...</tag>` occurrence for a single
 * tag, scanning left to right in one pass (no backtracking over already
 * emitted output). A leading `\r?\n` immediately before the opening tag is
 * consumed as part of the removed block, mirroring the prior regex
 * behavior. An opening tag with no matching close is left untouched and the
 * scan resumes right after it, so later occurrences of the same tag are
 * still found.
 */
function stripTag(text: string, tag: string): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let result = "";
  let i = 0;
  for (;;) {
    const openIdx = text.indexOf(openTag, i);
    if (openIdx === -1) {
      result += text.slice(i);
      break;
    }
    const closeIdx = text.indexOf(closeTag, openIdx + openTag.length);
    if (closeIdx === -1) {
      result += text.slice(i, openIdx + openTag.length);
      i = openIdx + openTag.length;
      continue;
    }
    let blockStart = openIdx;
    if (blockStart > i && text[blockStart - 1] === "\n") {
      blockStart -= text[blockStart - 2] === "\r" && blockStart - 2 >= i ? 2 : 1;
    }
    result += text.slice(i, blockStart);
    i = closeIdx + closeTag.length;
  }
  return result;
}

/**
 * Strips paired `<tag>...</tag>` blocks (plus one leading `\r?\n` separator,
 * if present) for the known host/core reminder tags, in a single linear
 * scan per tag (no quadratic backtracking on malformed/unpaired input).
 * Adjacent pairs of the same tag are removed independently; an unpaired
 * (unmatched) tag, or a tag with attributes, is left untouched; text without
 * any of these tags passes through byte-for-byte.
 */
export function stripReminderBlocks(text: string): string {
  let result = text;
  for (const tag of PAIRED_REMINDER_TAGS) {
    result = stripTag(result, tag);
  }
  return result;
}

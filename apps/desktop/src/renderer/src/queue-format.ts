/**
 * Shared transcript-echo formatting for user messages carrying image
 * attachments (slice P7.14 §2.1). Extracted from Composer so both the Composer
 * (direct idle send) and tab-registry's prompt-queue drainer produce a
 * byte-identical `user_text` transcript echo — the wire never echoes the user's
 * own message back (store.ts §3), so this is the one place the badge line is
 * appended. Kept in a tiny standalone module (not store.ts) so tab-registry
 * never has to import a React component to reach it.
 */

/** The `[N image(s) attached]` line shown beneath queued/sent text when attachments are present. */
export function imageAttachmentBadge(count: number): string {
  return `[${count} image${count === 1 ? "" : "s"} attached]`;
}

/**
 * Composes the transcript echo text for a user message: the raw text alone when
 * there are no images, otherwise the text followed by the attachment badge on
 * its own line (or the badge alone when the text is blank).
 */
export function transcriptTextWithImages(text: string, imageCount: number): string {
  if (imageCount === 0) return text;
  const badge = imageAttachmentBadge(imageCount);
  return text.trim().length === 0 ? badge : `${text}\n\n${badge}`;
}

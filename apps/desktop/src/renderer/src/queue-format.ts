/**
 * Shared formatting for user messages carrying image attachments (slice
 * P7.14 §2.1). Taskana 4091 (TASK.84): NO LONGER used for the transcript echo
 * — live `user_text` blocks carry the attachments themselves
 * (`appendUserText(..., images)`) and render thumbnails instead of this badge.
 * `imageAttachmentBadge`/`transcriptTextWithImages` remain for the prompt-QUEUE
 * pill/preview (queue items are not yet sent; the pill shows the count) and
 * TASK.81's blocked-path notice. Kept in a tiny standalone module (not
 * store.ts) so tab-registry never has to import a React component to reach it.
 */

/** The `[N image(s) attached]` line shown beneath queued/sent text when attachments are present. */
export function imageAttachmentBadge(count: number): string {
  return `[${count} image${count === 1 ? "" : "s"} attached]`;
}

/**
 * Composes the queued-prompt display text for a user message: the raw text
 * alone when there are no images, otherwise the text followed by the
 * attachment badge on its own line (or the badge alone when the text is
 * blank). Taskana 4091: transcript echoes no longer use this — only the queue
 * pill/preview does.
 */
export function transcriptTextWithImages(text: string, imageCount: number): string {
  if (imageCount === 0) return text;
  const badge = imageAttachmentBadge(imageCount);
  return text.trim().length === 0 ? badge : `${text}\n\n${badge}`;
}

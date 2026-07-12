/**
 * Large-paste hygiene (ui-roadmap §4-R7(b)) — pure logic for the composer's
 * pasted-block collapse. A paste of more than PASTE_COLLAPSE_THRESHOLD lines
 * is held outside the textarea as a PasteBlock; the draft carries only a
 * sentinel marker at the caret position. Send-time reconstitution replaces
 * markers with their full text, so the outgoing user_message is byte-identical
 * to what a raw paste+type would have produced (pattern reference: Claude
 * CLI's "[Pasted text #N +M lines]" chip).
 *
 * Pure module law (frozen pure-export/test law): no React, no DOM, no side
 * effects — total functions over plain data, unit-tested in a node env
 * (paste.test.ts), mirroring keymap.ts/fuzzy.ts.
 */

/** Pastes of MORE than this many lines collapse into a pill (≤ threshold pastes stay native). */
export const PASTE_COLLAPSE_THRESHOLD = 40;

/** One collapsed paste. `text` is the clipboard string with line endings normalized to LF (the composer folds \r\n?/→\n on paste, matching textarea .value semantics). */
export interface PasteBlock {
  id: number;
  text: string;
  lineCount: number;
}

/**
 * Sentinel markers use U+27E6/U+27E7 (mathematical white square brackets):
 * un-typeable on any layout, single UTF-16 code units (caret math stays in
 * code units), visually bracket-like inside the draft.
 */
const PASTE_MARKER_RE = /⟦pasted #(\d+)⟧/g;

/**
 * Line count = `split("\n").length` — number of newlines + 1, no trimming or
 * normalization ("" → 1, "a\nb" → 2, trailing newline adds a line). Total and
 * deliberately dumb: the count labels the pill and gates the collapse; it is
 * never used to reconstruct text.
 */
export function countPasteLines(text: string): number {
  return text.split("\n").length;
}

/** Collapse rule: strictly more than the threshold (41+ lines collapses, 40 pastes natively). */
export function shouldCollapsePaste(text: string): boolean {
  return countPasteLines(text) > PASTE_COLLAPSE_THRESHOLD;
}

/** Marker text inserted into the draft for block `id` — the single format source (parse regex above must match). */
export function makePasteMarker(id: number): string {
  return `⟦pasted #${id}⟧`;
}

/**
 * Blocks whose marker currently appears in the draft — the pill row renders
 * exactly these, in insertion order. Blocks are NEVER eagerly pruned from
 * state when their marker is edited away: presence is derived per render, so
 * cut-then-repaste (or undo) of a marker string resurrects its pill with the
 * content intact. Orphaned entries are inert and die on send.
 */
export function visiblePasteBlocks(
  draft: string,
  blocks: readonly PasteBlock[],
): readonly PasteBlock[] {
  return blocks.filter((block) => draft.includes(makePasteMarker(block.id)));
}

/**
 * Send-time reconstitution: a SINGLE pass over the draft replacing every
 * marker that has a matching block with its full text. Single-pass is a
 * correctness law: expanded block text is never re-scanned, so pasted content
 * that itself contains marker-shaped strings is preserved verbatim. Markers
 * without a matching block pass through as literal text (what the user typed
 * is what is sent). Uses a REPLACER FUNCTION, never a replacement string —
 * String.replace with a string substitutes `$&`/`$'` patterns and would
 * corrupt pasted code containing them.
 *
 * Identity law: with no blocks (or no matching markers) the returned string
 * is the draft unchanged — the no-paste send path is byte-identical to today.
 */
export function reconstitutePasteMarkers(
  draft: string,
  blocks: readonly PasteBlock[],
): string {
  if (blocks.length === 0) {
    return draft;
  }
  return draft.replace(PASTE_MARKER_RE, (match, idDigits: string) => {
    const block = blocks.find((b) => String(b.id) === idDigits);
    return block ? block.text : match;
  });
}

/**
 * Cheap tokenizer-free size estimate, used where the meaningful budget is what
 * the model is charged rather than what the disk holds (TASK.93 §4).
 *
 * Deliberately not exact: no tokenizer is loaded, no provider is consulted. It
 * only has to be conservative enough to keep a whole-file Read from filling the
 * context, and stable enough that the continuation offsets it produces are
 * reproducible.
 */

/** CJK Unified Ideographs — roughly one token each, versus ~3 chars/token for Latin text. */
const CJK = /[一-鿿]/g;

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil((cjk * 2 + rest) / 3);
}

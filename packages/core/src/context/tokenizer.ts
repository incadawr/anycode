/**
 * Tokenizer contract + heuristic fallback (design §2.5). The default tokenizer
 * (task 1.2) lazily loads gpt-tokenizer (o200k_base, pure JS) and falls back
 * to the heuristic when the import fails. Estimates are approximate by design:
 * provider-reported usage numbers always win (ContextManager.noteUsage).
 */

export interface Tokenizer {
  count(text: string): number;
}

/**
 * CJK-aware character heuristic: CJK glyphs are typically ~1 token each while
 * Latin text averages several characters per token, so CJK characters are
 * double-weighted before dividing by 3.5.
 */
export class HeuristicTokenizer implements Tokenizer {
  count(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    let cjk = 0;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      // CJK Unified Ideographs + extensions A, Hiragana/Katakana, Hangul.
      if (
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      }
    }
    const rest = text.length - cjk;
    return Math.ceil((cjk * 2 + rest) / 3.5);
  }
}

/** Shape of the gpt-tokenizer o200k_base module we depend on (subset). */
interface O200kBaseModule {
  countTokens?: (input: string) => number;
  encode?: (input: string) => number[];
}

/** Loader for the o200k_base encoding; injectable so the fallback path is testable. */
export type TokenizerModuleLoader = () => Promise<unknown>;

const loadO200kBase: TokenizerModuleLoader = () => import("gpt-tokenizer/encoding/o200k_base");

/**
 * Lazily loads gpt-tokenizer (o200k_base, pure JS); returns HeuristicTokenizer
 * when the import fails or the module lacks a usable counting function. The
 * per-call count is guarded: gpt-tokenizer throws on special-token sequences
 * (e.g. "<|endoftext|>"), so such inputs fall back to the heuristic estimate
 * rather than crashing the turn.
 *
 * `load` defaults to the real dynamic import; tests inject a rejecting loader
 * to exercise the fallback without perturbing the module registry.
 */
export async function createDefaultTokenizer(
  load: TokenizerModuleLoader = loadO200kBase,
): Promise<Tokenizer> {
  const fallback = new HeuristicTokenizer();
  try {
    const mod = (await load()) as O200kBaseModule;
    const count =
      typeof mod.countTokens === "function"
        ? mod.countTokens.bind(mod)
        : typeof mod.encode === "function"
          ? (input: string) => mod.encode!(input).length
          : null;
    if (count === null) {
      return fallback;
    }
    return {
      count(text: string): number {
        if (text.length === 0) {
          return 0;
        }
        try {
          return count(text);
        } catch {
          return fallback.count(text);
        }
      },
    };
  } catch {
    return fallback;
  }
}

/** Preserve strings (including multiline template text) and line numbers.
 * Templates are treated as whole strings, including ${...}; this scanner does
 * not parse expression interpolation. Color literals within them still count.
 */
export function maskComments(source: string, css = false): string {
  const stringsAndBlocks = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\//g;
  const scriptTokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  return source.replace(css ? stringsAndBlocks : scriptTokens, token =>
    token.startsWith("/*") || (!css && token.startsWith("//")) ? token.replace(/[^\r\n]/g, " ") : token);
}

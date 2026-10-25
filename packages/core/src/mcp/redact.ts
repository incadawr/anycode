/**
 * Redaction for MCP diagnostics (Taskana 4752, part C). A resolved `${secret:}`
 * value must never reach `status.error`, a problem, or a log. Values shorter than
 * 4 characters are not redacted: they match too much unrelated text to be useful.
 */

const MIN_REDACT_LENGTH = 4;
const REDACTED = "[redacted]";

/** Replaces every occurrence of each secret value in `text` (literal match, longest value first). */
export function redactSecrets(text: string, values: readonly string[]): string {
  const usable = [...new Set(values)]
    .filter((value) => value.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of usable) {
    out = out.split(value).join(REDACTED);
  }
  return out;
}

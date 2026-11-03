const REDACTED = "[redacted]";
const SECRET_NAME = "(?:pass|secret|token|key|credential|auth|cookie|session)";

/** Removes secret-looking material from text shown outside the child. */
export function scrubApprovalText(text: string): string {
  return text
    // Once a sensitive name appears, the rest of that line may be a value,
    // including an incomplete streamed value or an unknown authorization scheme.
    .replace(new RegExp(`([A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*)[^\\r\\n]*`, "gi"), (_m, name: string) => `${name}${REDACTED}`)
    .replace(/Bearer\s+[^\s"']+/gi, REDACTED)
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, REDACTED);
}

/** Removes secret-looking material from text shown outside the child. */
export function scrubFailureText(text: string): string {
  const urls = text.replace(/\bhttps?:\/\/[^\s/?#]*/gi, (url) => {
    const at = url.lastIndexOf("@");
    return at < 0 ? url : url.slice(0, url.indexOf("//") + 2) + REDACTED + url.slice(at);
  });
  // Scan names once; consume quoted values including escaped quotes.
  const names = /[A-Za-z0-9_-]+/g;
  const sensitive = /pass|secret|token|key|credential|auth|cookie|session/i;
  let result = "";
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = names.exec(urls)) !== null) {
    if (!sensitive.test(match[0])) continue;
    let i = names.lastIndex;
    if (urls[i] === '"' || urls[i] === "'") i++;
    while (i < urls.length && /[ \t]/.test(urls[i]!)) i++;
    if (urls[i] !== ":" && urls[i] !== "=") continue;
    i++;
    while (i < urls.length && /[ \t]/.test(urls[i]!)) i++;
    const valueStart = i;
    const quote = urls[i] === '"' || urls[i] === "'" ? urls[i++] : undefined;
    if (quote) {
      while (i < urls.length && urls[i] !== "\n" && urls[i] !== "\r") {
        if (urls[i] === "\\") { i += Math.min(2, urls.length - i); continue; }
        if (urls[i++] === quote) break;
      }
    } else {
      while (i < urls.length && !/[\s,;}&]/.test(urls[i]!)) i++;
    }
    result += urls.slice(end, valueStart) + REDACTED;
    end = i;
    names.lastIndex = i;
  }
  result += urls.slice(end);
  return result
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, REDACTED)
    .replace(/\bkey\s+provided\s*:\s*[^\s,;}&]+/gi, `key provided: ${REDACTED}`)
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]+/g, REDACTED)
    .replace(/[A-Za-z0-9+/=_-]+/g, (token, offset: number, source: string) =>
      token.length >= 32 && !token.startsWith("/") && source[offset - 1] !== "/" && source[offset + token.length] !== "/" ? REDACTED : token);
}

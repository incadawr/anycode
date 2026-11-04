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
  // Scan scheme candidates once, including punctuation that is legal in schemes.
  const candidates = /[a-z0-9+.-]+/gi;
  let urls = "";
  let urlEnd = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = candidates.exec(text)) !== null) {
    const end = candidates.lastIndex;
    if (text.slice(end, end + 3) !== "://") continue;
    const schemeOffset = candidate[0].search(/(?:^|[^a-z0-9_])(?=[a-z])/i);
    if (schemeOffset < 0) continue;
    let authorityEnd = end + 3;
    let at = -1;
    while (authorityEnd < text.length && !/[\s/?#]/.test(text[authorityEnd]!)) {
      if (text[authorityEnd] === "@") at = authorityEnd;
      authorityEnd++;
    }
    if (at >= 0) {
      urls += text.slice(urlEnd, end + 3) + REDACTED + text.slice(at, authorityEnd);
      urlEnd = authorityEnd;
    }
    candidates.lastIndex = authorityEnd;
  }
  urls += text.slice(urlEnd);
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
    const separator = urls[i];
    i++;
    while (i < urls.length && /[ \t]/.test(urls[i]!)) i++;
    const valueStart = i;
    const quote = urls[i] === '"' || urls[i] === "'" ? urls[i++] : undefined;
    if (separator === ":" && /^(?:proxy-)?authorization$/i.test(match[0])) {
      while (i < urls.length && urls[i] !== "\n" && urls[i] !== "\r") i++;
    } else if (quote) {
      while (i < urls.length && urls[i] !== "\n" && urls[i] !== "\r") {
        if (urls[i] === "\\") { i += Math.min(2, urls.length - i); continue; }
        if (urls[i++] === quote) break;
      }
    } else if (separator === ":" && /^(?:password|passwd|secret)$/i.test(match[0])) {
      while (i < urls.length && !/[\r\n,;}&]/.test(urls[i]!)) i++;
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
    .replace(/[A-Za-z0-9+/=_.~-]+/g, (token) => {
      const slash = token.indexOf("/");
      const isPath = slash > 0 || (slash === 0 && token.indexOf("/", 1) !== -1);
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
      return token.length >= 32 && !isPath && !isUuid ? REDACTED : token;
    });
}

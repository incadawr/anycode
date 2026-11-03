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
  return text
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, REDACTED)
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]+/g, REDACTED)
    .replace(/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|key|credential|authorization|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;}&]+)/gi, `$1${REDACTED}`);
}

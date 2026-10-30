const REDACTED = "[redacted]";
const SECRET_NAME = "(?:token|secret|password|passwd|api[ _-]?key|auth|cookie)";

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

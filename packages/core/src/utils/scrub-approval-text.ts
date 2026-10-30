const REDACTED = "[redacted]";
const SECRET_NAME = "(?:token|secret|password|passwd|api[-_]?key|auth)";

/** Removes secret-looking material from text shown outside the child. */
export function scrubApprovalText(text: string): string {
  return text
    // Handle bearer credentials before matching individual named fields.
    .replace(/Bearer\s+[^\s"']+/gi, REDACTED)
    .replace(new RegExp(`(--[A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*)(\\s+|=)(\\S+)`, "gi"), (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`)
    // Quoted JSON values, including escaped characters, and unquoted fields.
    .replace(new RegExp(`(["']?[A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}]+)`, "gi"), (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, REDACTED);
}

/** Validate a deliberately scoped absolute write mask. */
export function isValidWriteMask(pattern: string, home?: string): boolean {
  if (!pattern.startsWith("/") || pattern.includes("~") || /[\\(){}\[\]]/.test(pattern)) return false;
  const parts = pattern.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  const firstGlob = parts.findIndex((part) => /[*?]/.test(part));
  const prefix = parts.slice(1, firstGlob < 0 ? -1 : firstGlob).filter(Boolean);
  if (prefix.length < 2) return false;
  if (prefix[0] === "private" && prefix[1] === "tmp" && prefix.length < 3) return false;
  if (firstGlob >= 0 && firstGlob < parts.length - 1 && parts[firstGlob] !== "**") return false;
  if ((prefix[0] === "Users" || prefix[0] === "home") && prefix.length < 3) return false;
  const literalPrefix = `/${prefix.join("/")}`;
  if (home && literalPrefix === home.replace(/\/$/, "")) return false;
  return true;
}

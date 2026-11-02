import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isValidWriteMask } from "./write-mask.js";

/** Resolve the literal directory and reject aliases of broad system directories. */
export function resolveWriteMask(pattern: string, home = homedir()): string | undefined {
  if (!isValidWriteMask(pattern, home)) return undefined;
  const parts = pattern.split("/");
  const glob = parts.findIndex((part) => /[*?]/.test(part));
  const end = glob < 0 ? parts.length - 1 : glob;
  const prefix = parts.slice(0, end).join("/") || "/";
  let canonical = prefix;
  try {
    canonical = realpathSync(prefix);
    const candidate = statSync(prefix);
    for (const blocked of ["/", home, "/Users", "/home", "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]) {
      try {
        const stat = statSync(blocked);
        if (candidate.dev === stat.dev && candidate.ino === stat.ino) return undefined;
      } catch { /* A platform may not have this directory. */ }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  const resolved = `${canonical}/${parts.slice(end).join("/")}`;
  return isValidWriteMask(resolved, home) ? resolved : undefined;
}

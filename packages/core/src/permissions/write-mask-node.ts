import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isValidWriteMask } from "./write-mask.js";

/** Resolve existing components, refusing dangling links and unknown filesystem errors. */
export function canonicalWritePath(path: string): string | undefined {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
      let canonical = realpathSync.native(current);
      // On macOS the Data volume is another spelling of the root filesystem.
      if (canonical === "/System/Volumes/Data" || canonical.startsWith("/System/Volumes/Data/")) {
        const alternate = canonical.slice("/System/Volumes/Data".length) || "/";
        try {
          const original = statSync(canonical), mapped = statSync(alternate);
          if (original.dev === mapped.dev && original.ino === mapped.ino) canonical = alternate;
        } catch { /* No equivalent root spelling. */ }
      }
      return join(canonical, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      // A present dangling symlink is not a missing component.
      try { lstatSync(current); return undefined; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve the literal directory and reject ancestors of broad system directories. */
export function resolveWriteMask(pattern: string, home = homedir()): string | undefined {
  if (!isValidWriteMask(pattern, home)) return undefined;
  const parts = pattern.split("/");
  const glob = parts.findIndex((part) => /[*?]/.test(part));
  const end = glob < 0 ? parts.length - 1 : glob;
  const prefix = parts.slice(0, end).join("/") || "/";
  const canonical = canonicalWritePath(prefix);
  if (!canonical) return undefined;
  try {
    const candidate = statSync(canonical);
    const blockedPaths = [home, "/Users", "/home", "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/System/Volumes/Data", "/Volumes"];
    for (const container of ["/Volumes", "/System/Volumes"]) {
      try {
        blockedPaths.push(...readdirSync(container).map((entry) => join(container, entry)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
    for (const blocked of blockedPaths) {
      let current = blocked;
      for (;;) {
        try {
          const stat = statSync(current);
          if (candidate.dev === stat.dev && candidate.ino === stat.ino) return undefined;
        } catch { /* A platform may not have this directory. */ }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  const resolved = `${canonical}/${parts.slice(end).join("/")}`;
  return isValidWriteMask(resolved, home) ? resolved : undefined;
}

import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { classifyBashCommandLine } from "./safe-command.js";
import { splitBashSegments } from "./rules.js";

// Trust only root-owned, non-writable files and every directory on their paths.
// This also prevents a writable earlier PATH entry from being populated between
// the permission check and shell execution.
function trustedPath(path: string, directory: boolean): boolean {
  try {
    const real = realpathSync(path);
    for (const candidate of new Set([path, real])) {
      let current = candidate;
      let first = true;
      for (;;) {
        const stat = statSync(current);
        // Check effective access as well as mode bits, including ACL grants.
        try { accessSync(current, constants.W_OK); return false; } catch (error) {
          if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        }
        if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
            (first && (directory ? !stat.isDirectory() : !stat.isFile()))) return false;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
        first = false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function trustedExecutable(name: string): boolean {
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  const path = process.env.PATH;
  if (!path) return false;
  for (const dir of path.split(":")) {
    if (!isAbsolute(dir) || !trustedPath(dir, true)) return false;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    try {
      const real = realpathSync(candidate);
      // Only system locations are accepted, even if another directory is root-owned.
      if (!real.startsWith("/usr/bin/") && !real.startsWith("/bin/")) return false;
      if (!trustedPath(candidate, false)) return false;
      const fd = openSync(real, "r");
      try {
        const magic = Buffer.alloc(4);
        if (readSync(fd, magic, 0, 4, 0) !== 4) return false;
        const value = magic.readUInt32BE();
        // ELF, Mach-O, or universal Mach-O; never a shell script.
        return value === 0x7f454c46 || [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(value);
      } finally { closeSync(fd); }
    } catch {
      return false;
    }
  }
  return false;
}

/** Plan mode never inherits build's basename trust or Git's lexical policy. */
export function isTrustedPlanCommand(command: string): boolean {
  if (process.platform === "win32" || !trustedPath("/bin/sh", false)) return false;
  if (Object.keys(process.env).some(key => /^(?:LD_|DYLD_|BASH_FUNC_|BASH_ENV$|ENV$)/.test(key) && process.env[key])) return false;
  if (classifyBashCommandLine(command).class !== "read-only") return false;
  const split = splitBashSegments(command);
  if (!split) return false;
  return split.segments.every(segment => {
    const name = segment.trim().split(/[ \t]+/, 1)[0] ?? "";
    return name !== "git" && trustedExecutable(name);
  });
}

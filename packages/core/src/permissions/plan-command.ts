import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { classifyBashCommandLine } from "./safe-command.js";
import { splitBashSegments } from "./rules.js";

// Trust only root-owned, non-writable files and every directory on their paths.
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

function trustedExecutable(name: string, cwd: string | undefined): string | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  const path = process.env.PATH;
  if (path === undefined) return undefined;
  for (const dir of path.split(":")) {
    if (!isAbsolute(dir) && (!cwd || !isAbsolute(cwd))) return undefined;
    // Preserve symlink/.. traversal exactly as the shell passes it to the OS.
    const candidate = `${isAbsolute(dir) ? dir : `${cwd}/${dir}`}/${name}`;
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) continue;
      accessSync(candidate, constants.X_OK);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      return undefined;
    }
    try {
      const real = realpathSync(candidate);
      if (!trustedPath(candidate, false)) return undefined;
      const fd = openSync(real, "r");
      try {
        const magic = Buffer.alloc(4);
        if (readSync(fd, magic, 0, 4, 0) !== 4) return undefined;
        const value = magic.readUInt32BE();
        // ELF, Mach-O, or universal Mach-O; never a shell script.
        return value === 0x7f454c46 || [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(value) ? candidate : undefined;
      } finally { closeSync(fd); }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Return a shell command bound to the executables checked for plan mode. */
export function resolveTrustedPlanCommand(command: string, cwd?: string): string | undefined {
  if (process.platform === "win32" || !trustedPath("/bin/sh", false)) return undefined;
  if (Object.keys(process.env).some(key => /^(?:LD_|DYLD_|BASH_FUNC_|BASH_ENV$|ENV$)/.test(key) && process.env[key])) return undefined;
  if (classifyBashCommandLine(command).class !== "read-only") return undefined;
  const split = splitBashSegments(command);
  if (!split) return undefined;
  const segments: string[] = [];
  for (const segment of split.segments) {
    const match = /^(\s*)([a-z0-9-]+)(?=\s|$)/.exec(segment);
    if (!match || match[2] === "git") return undefined;
    const executable = trustedExecutable(match[2]!, cwd);
    if (!executable) return undefined;
    // Quote even trusted paths: PATH entries may contain shell metacharacters.
    const quoted = "'" + executable.replace(/'/g, "'\\''") + "'";
    segments.push(match[1] + quoted + segment.slice(match[0].length));
  }
  return segments.join("|");
}

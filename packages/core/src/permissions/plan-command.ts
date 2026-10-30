import { accessSync, closeSync, constants, openSync, readSync, readlinkSync, realpathSync, lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { classifyBashCommandLine } from "./safe-command.js";
import { splitBashSegments } from "./rules.js";

// Resolve every path component ourselves so intermediate symlinks are checked too.
function trustedPath(path: string, directory: boolean): boolean {
  try {
    if (!isAbsolute(path)) return false;
    let current = "/";
    let remaining = path.split("/").filter(Boolean);
    let hops = 0;
    for (;;) {
      const stat = lstatSync(current);
      if (stat.uid !== 0) return false;
      if (stat.isSymbolicLink()) {
        // Symlink permissions are not meaningful; its containing directory was checked.
        if (++hops > 40) return false;
        const target = readlinkSync(current);
        current = isAbsolute(target) ? "/" : dirname(current);
        remaining = [...target.split("/").filter(Boolean), ...remaining];
        continue;
      }
      // Check effective access as well as mode bits, including ACL grants.
      try { accessSync(current, constants.W_OK); return false; } catch (error) {
        if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      }
      if ((stat.mode & 0o022) !== 0) return false;
      if (remaining.length === 0) return directory ? stat.isDirectory() : stat.isFile();
      if (!stat.isDirectory()) return false;
      const component = remaining.shift()!;
      current = component === ".." ? dirname(current) : component === "." ? current : join(current, component);
    }
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

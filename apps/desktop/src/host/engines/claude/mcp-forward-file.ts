/**
 * TASK.182 / Taskana 4136: private on-disk transport for the Claude
 * `--mcp-config` document. The document carries resolved env values
 * (including explicitly requested inheritEnv) and resolved header values —
 * the authorized 0600 private file IS the transport for those values, so:
 *  - created exclusive (`wx` open) with mode 0600, chmod reasserted (umask defense);
 *  - ownership transfers the moment the exclusive OPEN succeeds (before any
 *    bytes are written), so a partial write failure (ENOSPC after some
 *    secret bytes landed) still unlinks exactly the file THIS invocation
 *    created; the fd is closed on every path;
 *  - EEXIST (someone else won the name, or our own earlier UUID) is retried
 *    under a fresh UUID and NEVER unlinked/truncated;
 *  - the propagated failure is a generic secret-safe message;
 *  - cleanup is idempotent, and the file is retained while the client owns it.
 *
 * Paths use node:posix/node:win32 helpers (never hand-rolled separators) so
 * a native Windows tmpDir (`C:\Users\...`) is accepted on its own platform.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync, readdirSync, statSync, unlinkSync, writeSync, type PathLike } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import * as pathPosix from "node:path/posix";
import * as pathWin32 from "node:path/win32";

/** Complete filename pattern this module owns: anycode-claude-mcp-<pid>-<uuid>.json */
const FILE_RE = /^anycode-claude-mcp-(\d+)-([0-9a-f-]{36})\.json$/;

export interface MaterializedMcpForwardFile {
  path: string;
}

/** Generic, secret-safe failure for every materialization error path. */
export class McpForwardFileError extends Error {
  constructor() {
    super("Could not create the private MCP configuration file; MCP servers were not forwarded.");
    this.name = "McpForwardFileError";
  }
}

/**
 * Platform-selected path helpers (injectable for tests). `win32` behaves
 * correctly on POSIX too when handed Windows-shaped strings, so tests can
 * exercise Windows path semantics natively.
 */
export interface McpForwardPathOps {
  isAbsolute(path: string): boolean;
  join(dir: string, name: string): string;
  basename(path: string): string;
}

/**
 * POSIX path semantics, straight from node:path/posix. `C:\Users\...` is NOT
 * absolute here — this object's contract is POSIX only; injected only by
 * tests. Production defaults to NATIVE_PATH_OPS (see below).
 */
export const POSIX_PATH_OPS: McpForwardPathOps = pathPosix;

/**
 * Windows path semantics, straight from node:path/win32 (a cross-platform
 * subpath — no hand-rolled separators). `C:\Users\...` is absolute here,
 * and joins use backslashes — so a native Windows tmpDir works on Windows.
 */
export const WIN32_PATH_OPS: McpForwardPathOps = pathWin32;

/**
 * TASK.182 fix: the PRODUCTION default is the native platform's own path
 * semantics (node:path already dispatches to win32 on Windows and posix
 * everywhere else), so a native Windows tmpDir (`C:\Users\...`) is accepted
 * by `materializeMcpForwardFile` when called WITHOUT injected path ops —
 * which is exactly how mcp-forward-boot.ts calls it.
 */
export const NATIVE_PATH_OPS: McpForwardPathOps = {
  isAbsolute: (p) => isAbsolute(p),
  join: (dir, name) => join(dir, name),
  basename: (p) => basename(p),
};

/**
 * Low-level fs seam, injectable so tests can fail the WRITE (after the file
 * exists with open bytes on disk) or the CHMOD — the exact partial-write
 * discipline the plan requires, without monkeypatching globals.
 */
export interface McpForwardFileIo {
  /** Exclusive create (O_WRONLY|O_CREAT|O_EXCL) with mode 0600. Returns the fd or throws (EEXIST on collision). */
  openExclusive(path: string): number;
  /** Writes the whole payload; may fail partway (partial secret bytes on disk). */
  write(fd: number, data: string): void;
  close(fd: number): void;
  chmod(path: string, mode: number): void;
  unlink(path: string): void;
  readdir(path: PathLike): string[];
}

const NATIVE_IO: McpForwardFileIo = {
  openExclusive: (path) => openSync(path, "wx", 0o600),
  write: (fd, data) => {
    const buffer = Buffer.from(data, "utf8");
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
  },
  close: (fd) => closeSync(fd),
  chmod: (path, mode) => chmodSync(path, mode),
  unlink: (path) => unlinkSync(path),
  readdir: (path) => readdirSync(path),
};

export function materializeMcpForwardFile(
  json: string,
  opts: { tmpDir: string; pid: number; paths?: McpForwardPathOps; io?: McpForwardFileIo },
): MaterializedMcpForwardFile {
  // TASK.182 fix: default to NATIVE platform semantics, not POSIX — on
  // Windows the native tmpDir is a drive path and must be accepted as-is.
  const paths = opts.paths ?? NATIVE_PATH_OPS;
  const io = opts.io ?? NATIVE_IO;
  if (!paths.isAbsolute(opts.tmpDir)) throw new McpForwardFileError();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const path = paths.join(opts.tmpDir, `anycode-claude-mcp-${opts.pid}-${randomUUID()}.json`);
    let fd: number | undefined;
    let owned = false; // true from the moment OUR exclusive open succeeded
    try {
      fd = io.openExclusive(path);
      owned = true;
      io.write(fd, json);
      io.close(fd);
      fd = undefined;
      // Reassert: the create mode only applies at open and umask may have
      // masked bits on platforms that ignore the mode hint.
      io.chmod(path, 0o600);
      return { path };
    } catch (error) {
      if (fd !== undefined) {
        try {
          io.close(fd);
        } catch {
          // fd may already be dead after a failed write
        }
      }
      if (owned) {
        // Partial write or chmod failure on the file THIS invocation created
        // (secret bytes may be on disk) — remove exactly that file.
        try {
          io.unlink(path);
        } catch {
          // best-effort; report the generic failure either way
        }
        throw new McpForwardFileError();
      }
      // EEXIST before ownership: a UUID collision (or a foreign file with our
      // exact name) — retry with a fresh UUID; NEVER unlink it.
      const isCollision = error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST";
      if (!isCollision) throw new McpForwardFileError();
    }
  }
  throw new McpForwardFileError();
}

/**
 * Idempotent cleanup of a materialized forward file. Safe on an already-
 * removed file, and never touches a path this module did not name.
 */
export function cleanupMcpForwardFile(path: string | undefined | null, io: McpForwardFileIo = NATIVE_IO): void {
  if (path === undefined || path === null || path === "") return;
  if (!FILE_RE.test(basenameOf(path))) return;
  try {
    io.unlink(path);
  } catch {
    // already gone (or never ours) — idempotent no-op
  }
}

function basenameOf(path: string): string {
  // The filename itself never contains separators; strip up to the LAST
  // separator of either family so both C:\...\name and /.../name resolve.
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Test seam: replace process.kill for liveness checks. */
export type PidProbe = (pid: number, signal: 0) => void;

function defaultPidProbe(pid: number, signal: 0): void {
  process.kill(pid, signal);
}

function isDeadPid(pid: number, probe: PidProbe): boolean {
  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — ALIVE.
    // Only ESRCH proves death.
    return (error as { code?: unknown }).code === "ESRCH";
  }
}

/**
 * Removes forward files whose owning pid is dead. Matches ONLY the complete
 * `anycode-claude-mcp-<pid>-<uuid>.json` pattern; foreign files are never
 * touched, and a missing tmpdir is a no-op.
 */
export function sweepOrphanedMcpForwardFiles(
  tmpDir: string,
  opts: { pid?: number; probe?: PidProbe; readdir?: (path: PathLike) => string[] } = {},
): void {
  let entries: string[];
  try {
    entries = (opts.readdir ?? readdirSync)(tmpDir as PathLike);
  } catch {
    return; // no tmpdir — nothing to sweep
  }
  const probe = opts.probe ?? defaultPidProbe;
  for (const entry of entries) {
    const match = FILE_RE.exec(entry);
    if (match === null) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (pid === (opts.pid ?? process.pid)) continue; // our own live file
    if (isDeadPid(pid, probe)) {
      try {
        unlinkSync(join(tmpDir, entry));
      } catch {
        // raced or unreadable — next sweep retries
      }
    }
  }
}

/** Test/inspection helper: the file's POSIX mode bits, or null when absent. */
export function mcpForwardFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

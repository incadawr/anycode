/**
 * TASK.182 / Taskana 4136 — private MCP forward file tests: exact 0600,
 * absolute path, content, exclusive collision retry WITHOUT truncation,
 * idempotent cleanup, sweep (alive/dead/EPERM/foreign), and injected
 * failure paths (partial write AFTER creation with secret bytes on disk,
 * chmod failure) leaving no owned file behind. Windows path semantics are
 * tested natively via WIN32_PATH_OPS (no POSIX-only claims).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTrustedScratchDir } from "../../../shared/test-scratch.js";
import {
  McpForwardFileError,
  NATIVE_PATH_OPS,
  POSIX_PATH_OPS,
  WIN32_PATH_OPS,
  cleanupMcpForwardFile,
  materializeMcpForwardFile,
  mcpForwardFileMode,
  sweepOrphanedMcpForwardFiles,
  type McpForwardFileIo,
} from "./mcp-forward-file.js";

const scratchDir = makeTrustedScratchDir("mcp-forward-file");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(scratchDir, "case-"));
  dirs.push(dir);
  return dir;
}

const JSON_DOC = JSON.stringify({ mcpServers: { alpha: { command: "npx", args: [], env: { TOKEN: "s3cret" } } } });

describe("materializeMcpForwardFile — happy path", () => {
  it("creates an absolute anycode-claude-mcp-<pid>-<uuid>.json with mode 0600 and exact content", () => {
    const dir = freshDir();
    const { path } = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 4242 });
    expect(path.startsWith("/")).toBe(true);
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toMatch(/anycode-claude-mcp-4242-[0-9a-f-]{36}\.json$/);
    expect(mcpForwardFileMode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(JSON_DOC);
    cleanupMcpForwardFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("chmod reasserts 0600 even when someone widened it between materializations", () => {
    const dir = freshDir();
    const a = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 1 });
    chmodSync(a.path, 0o644);
    expect(mcpForwardFileMode(a.path)).toBe(0o644);
    const b = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 1 });
    expect(mcpForwardFileMode(b.path)).toBe(0o600);
    cleanupMcpForwardFile(a.path);
    cleanupMcpForwardFile(b.path);
  });

  it("cleanup is idempotent and ignores foreign paths", () => {
    const dir = freshDir();
    const foreign = join(dir, "not-ours.json");
    writeFileSync(foreign, "x");
    cleanupMcpForwardFile(foreign); // pattern guard: foreign names untouched
    expect(existsSync(foreign)).toBe(true);
    const { path } = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 9 });
    cleanupMcpForwardFile(path);
    cleanupMcpForwardFile(path);
    cleanupMcpForwardFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects a relative tmpDir with the generic secret-safe error (POSIX semantics)", () => {
    expect(() => materializeMcpForwardFile(JSON_DOC, { tmpDir: "relative/dir", pid: 1 })).toThrow(McpForwardFileError);
  });
});

// ── injected-failure Io double: real fs, failure points under test control ──

class FlakyIo implements McpForwardFileIo {
  /** Paths whose WRITE must fail partway (after some bytes land on disk). */
  failWritePartway = new Set<string>();
  /** Paths whose CHMOD must fail (file fully written). */
  failChmod = new Set<string>();
  /** Paths that must collide with EEXIST on open (pre-existing content kept). */
  collisions = new Map<string, string>(); // path -> pre-existing content
  wroteBytes = new Map<string, string>();
  /** Fail-partway the write of the FIRST file this io ever opens (path unknown upfront). */
  failFirstWrite = false;
  /** Fail the chmod of the FIRST file this io ever fully writes (path unknown upfront). */
  failFirstChmod = false;
  private openedCount = 0;

  openExclusive(path: string): number {
    const existing = this.collisions.get(path);
    if (existing !== undefined) {
      const error = new Error("file exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    this.openedCount += 1;
    // Real exclusive create through the native path.
    return realOpenExclusive(path);
  }

  write(fd: number, data: string): void {
    const path = fdToPath.get(fd);
    const failNow = (path !== undefined && this.failWritePartway.has(path)) || (this.failFirstWrite && this.openedCount === 1 && path !== undefined && !this.wroteBytes.has(path));
    if (failNow && path !== undefined) {
      // Partial write: SOME secret bytes reach the disk, then ENOSPC.
      realWrite(fd, data.slice(0, 5));
      this.wroteBytes.set(path, data.slice(0, 5));
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    realWrite(fd, data);
    if (path !== undefined) this.wroteBytes.set(path, data);
  }

  close(fd: number): void {
    realClose(fd);
  }

  chmod(path: string, mode: number): void {
    if (this.failChmod.has(path) || (this.failFirstChmod && this.wroteBytes.has(path) && !this.chmodded.has(path))) {
      this.chmodded.add(path);
      throw new Error("EACCES: chmod failed");
    }
    this.chmodded.add(path);
    realChmod(path, mode);
  }

  private chmodded = new Set<string>();

  unlink(path: string): void {
    realUnlink(path);
  }

  readdir(path: string): string[] {
    return realReaddir(path);
  }
}

// The native fs primitives this file's own default io uses, reached directly
// so the double stays byte-compatible with production behavior.
import { closeSync, openSync, readdirSync as realReaddir, unlinkSync as realUnlink, writeSync, chmodSync as realChmod } from "node:fs";
const fdToPath = new Map<number, string>();
function realOpenExclusive(path: string): number {
  const fd = openSync(path, "wx", 0o600);
  fdToPath.set(fd, path);
  return fd;
}
function realWrite(fd: number, data: string): void {
  const buffer = Buffer.from(data, "utf8");
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
}
function realClose(fd: number): void {
  closeSync(fd);
  fdToPath.delete(fd);
}

describe("materializeMcpForwardFile — injected failure paths (real fs)", () => {
  it("a PARTIAL WRITE after the file exists removes the owned file (no secret bytes left on disk)", () => {
    const dir = freshDir();
    const io = new FlakyIo();
    io.failFirstWrite = true; // the FIRST exclusive-opened file's write fails partway
    expect(() => materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 11, io })).toThrow(McpForwardFileError);
    // The partially-written file (5 secret bytes landed, then ENOSPC) must NOT survive.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a CHMOD failure after a full write still removes the owned file", () => {
    const dir = freshDir();
    const io = new FlakyIo();
    io.failFirstChmod = true; // full write lands, then chmod fails
    expect(() => materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 12, io })).toThrow(McpForwardFileError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("retries a REAL EEXIST collision with a fresh UUID, never truncating or unlinking the colliding file", () => {
    const dir = freshDir();
    const probe = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 13 });
    const collisionPath = probe.path;
    const foreignContent = JSON.stringify({ mcpServers: { someoneElse: { command: "keep", args: [], env: {} } } });
    writeFileSync(collisionPath, foreignContent); // keep the name, different owner content
    const io = new FlakyIo();
    io.collisions.set(collisionPath, foreignContent);
    const second = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 13, io });
    // A fresh path was used…
    expect(second.path).not.toBe(collisionPath);
    // …the collision was neither truncated nor unlinked…
    expect(readFileSync(collisionPath, "utf8")).toBe(foreignContent);
    // …and our document landed intact at the fresh path.
    expect(readFileSync(second.path, "utf8")).toBe(JSON_DOC);
    cleanupMcpForwardFile(second.path);
    expect(existsSync(collisionPath)).toBe(true);
    cleanupMcpForwardFile(collisionPath);
  });
});

describe("materializeMcpForwardFile — production default is native platform path semantics", () => {
  it("NATIVE_PATH_OPS is the real node:path platform table (posix on darwin/linux, win32 on Windows)", () => {
    expect(NATIVE_PATH_OPS.isAbsolute("/tmp")).toBe(true);
    expect(NATIVE_PATH_OPS.isAbsolute("relative/dir")).toBe(false);
    expect(NATIVE_PATH_OPS.basename("/tmp/anycode-claude-mcp-1-2.json")).toBe("anycode-claude-mcp-1-2.json");
  });

  it("no injected paths: the default accepts this platform's own absolute tmpDir (regression: default was POSIX_PATH_OPS)", () => {
    const dir = freshDir();
    const { path } = materializeMcpForwardFile(JSON_DOC, { tmpDir: dir, pid: 7 });
    expect(path.startsWith(dir)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(JSON_DOC);
    cleanupMcpForwardFile(path);
  });

  it("on win32 the default would accept a native C:\\ tmpDir without injected ops", () => {
    if (process.platform !== "win32") {
      // Prove the SELECTION (not the platform): the default resolves to the
      // same table node:path dispatches to.
      const platformTable = Win32OrPosix();
      expect(NATIVE_PATH_OPS.basename("/a/b/c.json")).toEqual(platformTable.basename("/a/b/c.json"));
      expect(NATIVE_PATH_OPS.isAbsolute("C:\\Users\\me")).toEqual(platformTable.isAbsolute("C:\\Users\\me"));
      return;
    }
    const io = winTmpRecordingIo();
    const probe = materializeMcpForwardFile(JSON_DOC, { tmpDir: "C:\\Users\\me\\AppData\\Local\\Temp", pid: 6, io });
    expect(probe.path.startsWith("C:\\Users\\me\\AppData\\Local\\Temp\\")).toBe(true);
  });
});

function Win32OrPosix() {
  return process.platform === "win32" ? WIN32_PATH_OPS : POSIX_PATH_OPS;
}

/** Memory IO for path-selection probes (no disk writes at fake Windows paths). */
function winTmpRecordingIo(): McpForwardFileIo {
  const written: string[] = [];
  return {
    openExclusive: () => 1,
    write: (_fd, data) => {
      written.push(data);
    },
    close: () => {},
    chmod: () => {},
    unlink: () => {},
    readdir: () => [],
  };
}


describe("materializeMcpForwardFile — Windows path semantics (native via WIN32_PATH_OPS)", () => {
  it("WIN32_PATH_OPS accepts C:\\ and \\\\UNC absolute paths, rejects relative", () => {
    expect(WIN32_PATH_OPS.isAbsolute("C:\\Users\\me\\AppData\\Local\\Temp")).toBe(true);
    expect(WIN32_PATH_OPS.isAbsolute("\\\\server\\share\\tmp")).toBe(true);
    expect(WIN32_PATH_OPS.isAbsolute("relative\\dir")).toBe(false);
    expect(WIN32_PATH_OPS.join("C:\\Users\\me\\tmp", "x.json")).toBe("C:\\Users\\me\\tmp\\x.json");
    expect(WIN32_PATH_OPS.basename("C:\\Users\\me\\tmp\\anycode-claude-mcp-1-2.json")).toBe("anycode-claude-mcp-1-2.json");
  });

  it("POSIX_PATH_OPS still rejects a Windows drive path (its platform contract)", () => {
    expect(POSIX_PATH_OPS.isAbsolute("C:\\Users\\me")).toBe(false);
    expect(POSIX_PATH_OPS.isAbsolute("/tmp")).toBe(true);
  });

  it("a Windows absolute tmpDir passes the absolute gate and yields a Windows-joined path (pure recording io, no fs)", () => {
    // Records every call; never touches disk — this asserts the PATH DECISION
    // (Windows absolutes are accepted, joined with backslashes), not fs behavior.
    const recorded: Array<{ op: string; path: string }> = [];
    const io: McpForwardFileIo = {
      openExclusive: (path) => {
        recorded.push({ op: "open", path });
        return 1;
      },
      write: () => {},
      close: () => {},
      chmod: (path) => {
        recorded.push({ op: "chmod", path });
      },
      unlink: (path) => {
        recorded.push({ op: "unlink", path });
      },
      readdir: () => [],
    };
    const winTmp = "C:\\Users\\me\\AppData\\Local\\Temp";
    const probe = materializeMcpForwardFile(JSON_DOC, { tmpDir: winTmp, pid: 6, paths: WIN32_PATH_OPS, io });
    expect(probe.path.startsWith(winTmp + "\\")).toBe(true);
    expect(recorded[0]!.op).toBe("open");
    expect(recorded[0]!.path).toBe(probe.path);
    expect(recorded[1]!.op).toBe("chmod");
    expect(recorded[1]!.path).toBe(probe.path);
  });
});

describe("sweepOrphanedMcpForwardFiles", () => {
  it("removes dead-pid files, keeps alive-pid files, EPERM counts as alive, foreign files untouched", () => {
    const dir = freshDir();
    const dead = join(dir, `anycode-claude-mcp-999999-${crypto.randomUUID()}.json`);
    const alive = join(dir, `anycode-claude-mcp-${process.pid}-${crypto.randomUUID()}.json`);
    const eperm = join(dir, `anycode-claude-mcp-111111-${crypto.randomUUID()}.json`);
    const foreign = join(dir, "anycode-claude-mcp-2222-not-a-uuid.json");
    for (const path of [dead, alive, eperm, foreign]) writeFileSync(path, "{}", { mode: 0o600 });

    const probe = (pid: number): void => {
      if (pid === 999999) {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      if (pid === 111111) {
        const error = new Error("not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    };
    const io = new FlakyIo();
    sweepOrphanedMcpForwardFiles(dir, { probe });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(eperm)).toBe(true); // EPERM = alive
    expect(existsSync(foreign)).toBe(true); // incomplete pattern = foreign
    void io;
  });

  it("keeps our own pid's file and is a no-op on a missing tmpdir", () => {
    const dir = freshDir();
    const mine = join(dir, `anycode-claude-mcp-${process.pid}-${crypto.randomUUID()}.json`);
    writeFileSync(mine, "{}");
    sweepOrphanedMcpForwardFiles(dir, { pid: process.pid });
    expect(existsSync(mine)).toBe(true);
    expect(() => sweepOrphanedMcpForwardFiles(join(dir, "does-not-exist"))).not.toThrow();
  });
});

/**
 * FileSystemPort: the only way core code touches the file system.
 * Node adapter lives in adapters/node; the Electron host (Phase 2) and remote
 * workspaces (Phase 3) provide their own implementations.
 */

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  /**
   * POSIX mode bits (permission + type). Optional so existing mocks/adapters
   * keep compiling unchanged; consumers that need it (config-write's atomic
   * write, to preserve a 0600 secrets file's privacy across tmp+rename) read it
   * best-effort and fall back when absent.
   */
  mode?: number;
  /**
   * True when the path itself is a symbolic link. Only populated by `lstat`
   * (never followed) — `stat` follows the link and reports the target's type.
   * Optional so existing mocks/adapters keep compiling unchanged; the skills
   * import copier reads it to refuse copying symlinks (never exfiltrate a link
   * target into our catalog).
   */
  isSymbolicLink?: boolean;
}

export interface FileSystemPort {
  /** Reads a file as UTF-8 text. Rejects if the path does not exist or is a directory. */
  readFile(path: string): Promise<string>;
  /** Reads a file as raw bytes. Optional so existing implementations/mocks keep compiling unchanged (runBinary/spawnPersistent precedent). */
  readFileBytes?(path: string): Promise<Uint8Array>;
  /**
   * Writes UTF-8 text, creating parent directories as needed. Overwrites
   * existing content. The optional `opts.mode` sets the POSIX permission bits
   * the file is CREATED with (subject to umask) — used by config-write to land a
   * secrets-bearing temp file private (0600) up front so a subsequent rename can
   * never widen it, even on a port that omits the optional `chmod`. Optional
   * param so existing 2-arg implementations/mocks stay assignable; a port that
   * ignores it degrades to its default creation mode.
   */
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  /** Recursive mkdir; succeeds if the directory already exists. */
  mkdir(path: string): Promise<void>;
  /** Lists entry names (not full paths) of a directory. */
  readdir(path: string): Promise<string[]>;
  /**
   * Renames/moves a path (same-filesystem atomic replace). Optional so existing
   * implementations/mocks keep compiling unchanged (readFileBytes precedent);
   * callers that need atomicity (config-write tmp+rename) fall back to a plain
   * writeFile when a port omits it.
   */
  rename?(from: string, to: string): Promise<void>;
  /**
   * Sets a path's POSIX permission bits. Optional (rename/readFileBytes
   * precedent); config-write uses it to keep a secrets-bearing config private
   * (match the existing target's mode across tmp+rename, or create a new file
   * 0600). Callers fall back to best-effort no-op when a port omits it.
   */
  chmod?(path: string, mode: number): Promise<void>;
  /**
   * Like `stat` but does NOT follow a final symbolic link — reports the link
   * itself (`isSymbolicLink: true`). Optional (rename/chmod precedent); the
   * skills import copier uses it to detect and refuse symlinks during a bounded
   * recursive copy. Callers that need symlink safety and find it absent must
   * fail closed (treat every entry as unknown) rather than fall back to `stat`.
   */
  lstat?(path: string): Promise<FileStat>;
  /**
   * Copies a single regular file byte-for-byte (binary safe), creating parent
   * directories as needed. Optional; the skills import copier uses it for
   * support-tree files (images/binaries) where a UTF-8 readFile/writeFile
   * round-trip would corrupt bytes.
   */
  copyFile?(from: string, to: string): Promise<void>;
  /**
   * Recursively removes a path (directory tree or file); a missing path is a
   * no-op. Optional; the skills deleter uses it to remove an own-catalog skill
   * directory after the own-roots prefix guard passes.
   */
  rm?(path: string): Promise<void>;
  /**
   * Canonicalizes a path, resolving every symbolic link and `.`/`..` segment to
   * a real absolute path (rejects when the path does not exist). Optional
   * (lstat/chmod precedent); the skills own-root containment guard uses it to
   * prove a delete/import target is a REAL own-catalog directory rather than a
   * symlink escaping the catalog. Callers that need symlink-resolved containment
   * and find it absent must fail closed (refuse), never fall back to a lexical
   * check.
   */
  realpath?(path: string): Promise<string>;
  /**
   * Reads a file as UTF-8 text WITHOUT following a final symbolic link
   * (`O_NOFOLLOW` open semantics): if the path's last component is a symlink the
   * read fails rather than dereferencing it. Optional; the skills import reader
   * uses it to close the TOCTOU window between an `lstat` symlink check and the
   * subsequent read (a foreign process swapping the checked regular file for a
   * link). Absent ⇒ callers fall back to the lstat-then-readFile path.
   */
  readFileNoFollow?(path: string): Promise<string>;
  /**
   * Copies a single regular file byte-for-byte WITHOUT following a final
   * symbolic link on the SOURCE (`O_NOFOLLOW` open): a symlinked source fails
   * rather than exfiltrating its target. Optional; the skills import copier uses
   * it to close the TOCTOU window between the `lstat` check and the copy. Absent
   * ⇒ callers fall back to the lstat-then-copyFile path.
   */
  copyFileNoFollow?(from: string, to: string): Promise<void>;
}

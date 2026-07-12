/** Node implementation of FileSystemPort over node:fs/promises. */

import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import type { FileStat, FileSystemPort } from "../../ports/file-system.js";

export class NodeFileSystemAdapter implements FileSystemPort {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, "utf-8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return fsp.readFile(path);
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    // A `mode` lands the file private (0600) at creation time so an atomic
    // tmp+rename can never widen a secrets-bearing config, even when `chmod` is
    // unavailable. Node applies `mode` only when creating the file (subject to
    // umask); an existing file keeps its mode.
    if (opts?.mode !== undefined) {
      await fsp.writeFile(path, content, { encoding: "utf-8", mode: opts.mode });
      return;
    }
    await fsp.writeFile(path, content, "utf-8");
  }

  async stat(path: string): Promise<FileStat> {
    const s = await fsp.stat(path);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mode: s.mode,
      isSymbolicLink: s.isSymbolicLink(),
    };
  }

  async lstat(path: string): Promise<FileStat> {
    const s = await fsp.lstat(path);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mode: s.mode,
      isSymbolicLink: s.isSymbolicLink(),
    };
  }

  async copyFile(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }

  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }

  async readFileNoFollow(path: string): Promise<string> {
    // O_NOFOLLOW makes the open() fail (ELOOP) if the final component is a
    // symlink — closing the TOCTOU window between an lstat check and this read.
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  }

  async copyFileNoFollow(from: string, to: string): Promise<void> {
    // Open the SOURCE with O_NOFOLLOW (fails on a symlinked source) then stream
    // its bytes into a freshly created destination — a symlinked source can
    // never be dereferenced into our catalog.
    await fsp.mkdir(dirname(to), { recursive: true });
    const src = await fsp.open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await src.readFile();
      await fsp.writeFile(to, bytes);
    } finally {
      await src.close();
    }
  }

  async rm(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }

  async readdir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode);
  }
}

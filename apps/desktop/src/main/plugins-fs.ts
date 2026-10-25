/**
 * Node fs adapter for the plugins subsystem (Taskana 4732 S1-B): implements
 * the intersection of core's `FileSystemPort` (what scanPluginsAdmin/
 * discoverPlugins read) and main/plugins/store.ts's `PluginStoreFs` (what
 * the store writes) over `node:fs/promises` — the NodeSkillsFs precedent.
 * `readFileBytes` is the binary-safe read for picked .tgz files.
 */

import { open as fsOpen } from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import type { PluginStoreFs } from "./plugins/store.js";

export class NodePluginsFs implements PluginStoreFs {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, "utf-8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buffer = await fsp.readFile(path);
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    if (opts?.mode !== undefined) {
      await fsp.writeFile(path, content, { encoding: "utf-8", mode: opts.mode });
      return;
    }
    await fsp.writeFile(path, content, "utf-8");
  }

  async writeFileBytes(path: string, data: Buffer, opts?: { mode?: number }): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    if (opts?.mode !== undefined) {
      await fsp.writeFile(path, data, { mode: opts.mode });
      return;
    }
    await fsp.writeFile(path, data);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }> {
    const info = await fsp.stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile(), isDirectory: info.isDirectory() };
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

  async rm(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }

  async lstat(path: string): Promise<{ isSymbolicLink: boolean; isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number; mode: number }> {
    const info = await fsp.lstat(path);
    return { isSymbolicLink: info.isSymbolicLink(), isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
  }

  async copyFile(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }

  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }

  /** O_NOFOLLOW text read (symlink refusal discipline for plugin files). */
  async readFileNoFollow(path: string): Promise<string> {
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  }

  /** O_NOFOLLOW binary read (extracted archive members). */
  async readFileBytesNoFollow(path: string): Promise<Uint8Array> {
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const buffer = await handle.readFile();
      return new Uint8Array(buffer);
    } finally {
      await handle.close();
    }
  }

  /** Synchronous exists (discovery's fs port sometimes probes sync). */
  existsSync(path: string): boolean {
    return fs.existsSync(path);
  }

  /** open() passthrough for callers needing a raw handle. */
  open(path: string, flags: string | number): Promise<number> {
    return new Promise((resolve, reject) => {
      fsOpen(path, flags, (error, fd) => {
        if (error !== null) reject(error);
        else resolve(fd);
      });
    });
  }
}

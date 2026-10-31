/**
 * `anycode:path-roots` — the names directly under the filesystem root, for the
 * renderer's slash guard (shared/path-roots.ts explains the why).
 *
 * Main-side only because the renderer is sandboxed and cannot stat anything.
 * The handler takes no input at all: it lists the root of the running process's
 * filesystem, drops dotfiles, and caps the list. Every failure is an empty
 * list, never an error payload — the guard then falls back to the conventional
 * root names it already carries.
 */
import { readdir } from "node:fs/promises";
import { parse } from "node:path";
import { ipcMain } from "electron";
import { PATH_ROOTS_CHANNEL, type PathRootsResult } from "../shared/path-roots.js";

/** Cap on names returned. A real filesystem root has a few dozen entries. */
export const PATH_ROOTS_MAX_NAMES = 512;

export interface PathRootsDeps {
  /** The filesystem root to list (`"/"`, or `"C:\\"` on Windows). */
  root(): string;
  readdir(path: string): Promise<string[]>;
}

export async function handlePathRoots(deps: PathRootsDeps): Promise<PathRootsResult> {
  try {
    const names = await deps.readdir(deps.root());
    return {
      names: names
        .filter((name) => name.length > 0 && !name.startsWith("."))
        .slice(0, PATH_ROOTS_MAX_NAMES),
    };
  } catch {
    return { names: [] };
  }
}

/** Registers the channel. No payload is read from the renderer at all. */
export function registerPathRootsIpc(
  deps: PathRootsDeps = {
    root: () => parse(process.cwd()).root,
    readdir: async (path) => readdir(path),
  },
): void {
  ipcMain.handle(PATH_ROOTS_CHANNEL, () => handlePathRoots(deps));
}

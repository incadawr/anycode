import { describe, expect, it, vi } from "vitest";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";
import { walkRepo } from "./walk.js";

function stat(isDirectory: boolean, size = 0, mtimeMs = 1): FileStat {
  return { isDirectory, isFile: !isDirectory, size, mtimeMs };
}

function treeFs(entries: Record<string, string[]>, stats: Record<string, FileStat>): FileSystemPort {
  return {
    readdir: vi.fn(async (path) => {
      if (!(path in entries)) throw new Error("unreadable");
      return entries[path]!;
    }),
    stat: vi.fn(async (path) => {
      if (!(path in stats)) throw new Error("missing");
      return stats[path]!;
    }),
    readFile: vi.fn(), exists: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
  };
}

describe("walkRepo", () => {
  it("walks depth-first with one stat per entry and no reads", async () => {
    const fs = treeFs(
      { "/ws": ["z.txt", "src"], "/ws/src": ["a.ts"] },
      { "/ws/z.txt": stat(false, 5, 2), "/ws/src": stat(true), "/ws/src/a.ts": stat(false, 9, 3) },
    );
    expect(await walkRepo(fs, "/ws", { ignoredDirs: new Set(), maxFiles: 10, maxDepth: 5 })).toEqual([
      { relativePath: "src/a.ts", size: 9, mtimeMs: 3, extension: ".ts" },
      { relativePath: "z.txt", size: 5, mtimeMs: 2, extension: ".txt" },
    ]);
    expect(fs.stat).toHaveBeenCalledTimes(3);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("skips unreadable subtrees and ignored directories", async () => {
    const problems: string[] = [];
    const fs = treeFs(
      { "/ws": ["bad", "node_modules", "ok.ts"] },
      { "/ws/bad": stat(true), "/ws/node_modules": stat(true), "/ws/ok.ts": stat(false, 2) },
    );
    const files = await walkRepo(fs, "/ws", {
      ignoredDirs: new Set(["node_modules"]), maxFiles: 10, maxDepth: 5, onProblem: (problem) => problems.push(problem),
    });
    expect(files.map((file) => file.relativePath)).toEqual(["ok.ts"]);
    expect(problems).toHaveLength(1);
  });

  it("terminates a directory-only cycle by maxDepth without relying on maxFiles", async () => {
    const fs: FileSystemPort = {
      readdir: vi.fn(async () => ["loop"]),
      stat: vi.fn(async () => stat(true)),
      readFile: vi.fn(), exists: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
    };
    const files = await walkRepo(fs, "/ws", { ignoredDirs: new Set(), maxFiles: 20_000, maxDepth: 24 });
    expect(files).toEqual([]);
    expect(fs.readdir).toHaveBeenCalledTimes(25);
  });

  it("bounds broad trees by maxFiles", async () => {
    const fs = treeFs(
      { "/ws": ["a.ts", "b.ts", "c.ts"] },
      { "/ws/a.ts": stat(false), "/ws/b.ts": stat(false), "/ws/c.ts": stat(false) },
    );
    expect(await walkRepo(fs, "/ws", { ignoredDirs: new Set(), maxFiles: 2, maxDepth: 3 })).toHaveLength(2);
  });

  it("fails soft when the root itself cannot be read", async () => {
    const problems: string[] = [];
    const fs = treeFs({}, {});
    expect(await walkRepo(fs, "/ws", {
      ignoredDirs: new Set(), maxFiles: 10, maxDepth: 3, onProblem: (problem) => problems.push(problem),
    })).toEqual([]);
    expect(problems).toEqual([expect.stringContaining("could not read /ws")]);
  });

  it("applies ignored directory names at nested depths", async () => {
    const fs = treeFs(
      { "/ws": ["src"], "/ws/src": ["node_modules", "ok.ts"], "/ws/src/node_modules": ["hidden.ts"] },
      {
        "/ws/src": stat(true), "/ws/src/node_modules": stat(true), "/ws/src/ok.ts": stat(false),
        "/ws/src/node_modules/hidden.ts": stat(false),
      },
    );
    const files = await walkRepo(fs, "/ws", { ignoredDirs: new Set(["node_modules"]), maxFiles: 10, maxDepth: 5 });
    expect(files.map((entry) => entry.relativePath)).toEqual(["src/ok.ts"]);
    expect(fs.readdir).not.toHaveBeenCalledWith("/ws/src/node_modules");
  });
});

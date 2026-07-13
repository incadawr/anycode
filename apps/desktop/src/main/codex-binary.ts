import { statSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";

export interface CodexBinaryResolution {
  path: string | null;
  reason?: string;
}

export interface CodexBinaryFs {
  stat(path: string): { isFile(): boolean; mode: number };
}

const nodeFs: CodexBinaryFs = {
  stat(path) {
    return statSync(path);
  },
};

/** Main validates an explicit absolute path; it never searches or shells out. */
export function resolveCodexBinary(raw: string | undefined, fs: CodexBinaryFs = nodeFs, platform = process.platform): CodexBinaryResolution {
  if (raw === undefined || raw.trim() === "") return { path: null };
  const path = raw.trim();
  const isAbsolutePath = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!isAbsolutePath) return { path: null, reason: "Codex binary path must be absolute" };
  try {
    const stat = fs.stat(path);
    if (!stat.isFile()) return { path: null, reason: "Codex binary path is not a file" };
    if (platform !== "win32" && (stat.mode & 0o111) === 0) {
      return { path: null, reason: "Codex binary is not executable" };
    }
    return { path };
  } catch {
    return { path: null, reason: "Codex binary path does not exist" };
  }
}

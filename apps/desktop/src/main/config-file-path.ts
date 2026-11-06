import { extname, isAbsolute, join, relative, sep } from "node:path";
import { realpathExistingAncestor } from "@anycode/core/path-containment";
import type { McpConfigFs } from "./mcp-config-ipc.js";

type CheckedPath = { ok: true; path: string } | { ok: false; reason: "not_found" | "unsafe_path" };

/** Fixed JSON leaves only. The base may be a symlink; every child must be real. */
export async function checkConfigFilePath(fs: McpConfigFs, base: string, target: string): Promise<CheckedPath> {
  try {
    if (!isAbsolute(base) || !fs.lstat || !fs.realpath) return { ok: false, reason: "unsafe_path" };
    const leaf = relative(base, target);
    if (leaf !== join(".anycode", "config.json") && leaf !== ".mcp.json") {
      return { ok: false, reason: "unsafe_path" };
    }
    const canonicalBase = await realpathExistingAncestor(fs, base);
    if (!canonicalBase || !(await fs.lstat(canonicalBase)).isDirectory) {
      return { ok: false, reason: "unsafe_path" };
    }
    let path = canonicalBase;
    const parts = leaf.split(sep);
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const st = await fs.lstat(path);
      if (st.isSymbolicLink !== false || (index < parts.length - 1 ? !st.isDirectory : !st.isFile)) {
        return { ok: false, reason: "unsafe_path" };
      }
    }
    const canonical = await realpathExistingAncestor(fs, path);
    const rel = canonical && relative(canonicalBase, canonical);
    if (!canonical || !rel || rel.startsWith("..") || isAbsolute(rel) || canonical !== path || extname(canonical) !== ".json") {
      return { ok: false, reason: "unsafe_path" };
    }
    return { ok: true, path: canonical };
  } catch (error) {
    let missing = false;
    try { missing = (error as NodeJS.ErrnoException)?.code === "ENOENT"; } catch { /* fail closed */ }
    return { ok: false, reason: missing ? "not_found" : "unsafe_path" };
  }
}

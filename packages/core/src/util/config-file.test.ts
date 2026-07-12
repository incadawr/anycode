/**
 * util/config-file (P7.20 W5-FIX): the shared `.anycode/config.json` write
 * primitives. Two hardening PoCs proven by real node fs:
 *  - P2-f: the per-path serialization queue is keyed by a CANONICAL path, so two
 *    lexical aliases of the same file share one queue (no lost update).
 *  - P2-g: `atomicWriteJson` lands the temp file at the desired (private) mode UP
 *    FRONT, so a port with `rename` but no `chmod` cannot widen a 0600 config.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "./config-file.js";
import { setSkillEnabled } from "../skills/settings.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import type { FileSystemPort } from "../ports/file-system.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cfgfile-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("P2-f — canonical write-queue key", () => {
  it("two lexical aliases of one config file serialize on one queue (no lost update)", async () => {
    const dir = await tmp();
    const cfg = join(dir, ".anycode", "config.json");
    await fsp.mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, "{}", "utf-8");
    // A DIFFERENT string naming the SAME file via `..`.
    const alias = join(dir, "x", "..", ".anycode", "config.json");
    const fs = new NodeFileSystemAdapter();

    // Concurrent read-modify-write on the aliased paths. A per-raw-string queue
    // would let both read `{}` and the last rename would drop one name.
    await Promise.all([
      setSkillEnabled(fs, cfg, "alpha", false),
      setSkillEnabled(fs, alias, "beta", false),
    ]);

    const parsed = JSON.parse(await readFile(cfg, "utf-8")) as { skills: { disabled: string[] } };
    expect([...parsed.skills.disabled].sort()).toEqual(["alpha", "beta"]);
  });
});

describe("P2-g — mode preserved without chmod", () => {
  const skipMode = process.platform === "win32";

  it.skipIf(skipMode)("keeps an existing 0600 config private when the port has rename but no chmod", async () => {
    const dir = await tmp();
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ mcpServers: {} }), "utf-8");
    await chmod(path, 0o600);

    // A port that supports rename + writeFile(mode) but deliberately OMITS chmod.
    const fs: FileSystemPort = {
      readFile: (p) => fsp.readFile(p, "utf-8"),
      writeFile: async (p, c, opts) => {
        await fsp.mkdir(dirname(p), { recursive: true });
        if (opts?.mode !== undefined) {
          await fsp.writeFile(p, c, { encoding: "utf-8", mode: opts.mode });
        } else {
          await fsp.writeFile(p, c, "utf-8");
        }
      },
      exists: async (p) => {
        try {
          await fsp.access(p);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (p) => {
        const st = await fsp.stat(p);
        return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory(), mode: st.mode };
      },
      mkdir: async (p) => {
        await fsp.mkdir(p, { recursive: true });
      },
      readdir: (p) => fsp.readdir(p),
      rename: async (a, b) => {
        await fsp.mkdir(dirname(b), { recursive: true });
        await fsp.rename(a, b);
      },
    };

    await atomicWriteJson(fs, path, { mcpServers: { added: {} } });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

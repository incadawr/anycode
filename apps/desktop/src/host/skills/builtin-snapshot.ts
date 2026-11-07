import fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { buildEngineBuiltinSkills, type EngineBuiltinSkillInput } from "../engine-builtin-skills.js";
import type { EngineBuiltinSkillId } from "../../shared/engine-skills.js";

interface SnapshotInput extends EngineBuiltinSkillInput {
  /** Host-resolved profile home and workspace; never renderer-supplied paths. */
  hostProfileHome: string;
  workspace: string;
  disabled?: readonly EngineBuiltinSkillId[];
  /** Additional host-known plugin roots and CLI homes, including custom homes. */
  excludedRoots?: readonly string[];
}
interface Runtime {
  platform?: NodeJS.Platform;
  /** Zero-signal probe only; successful return means the group still exists. */
  probe?: (pgid: number) => void;
}
export interface BuiltinSnapshotLease {
  readonly root: string;
  /** Call synchronously immediately after spawn, before handshake/any await.
   * dedicatedProcessGroup must describe the actual POSIX spawn options.
   */
  bindChild(child: ChildProcess, dedicatedProcessGroup: boolean): void;
  abortNeverSpawned(): void;
  /** Retries only after observed direct-child exit; never kills a stale PGID. */
  reclaim(): void;
}
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const inside = (parent: string, path: string) => {
  const part = relative(parent, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
};

/** Fixed app bytes only. Read-only modes do not defend against hostile same-UID
 * processes; descendants escaping the POSIX group are outside this lease proof.
 * Crash slots remain occupied forever: no marker, age or PID grants ownership.
 */
export function prepareBuiltinSnapshot(input: SnapshotInput, runtime: Runtime = {}): BuiltinSnapshotLease {
  if ((runtime.platform ?? process.platform) === "win32") throw new Error("unsupported");
  const uid = process.getuid!();
  const home = resolve(input.hostProfileHome);
  const anchor = join(home, ".anycode/builtin-snapshots-mvp");
  const excluded = [input.workspace, join(home, ".claude"), join(home, ".codex"),
    join(home, ".anycode/plugins"), ...(input.excludedRoots ?? [])];
  if (!isAbsolute(input.hostProfileHome) || excluded.some(path => !isAbsolute(path) || inside(resolve(path), anchor))) {
    throw new Error("unsafe-anchor");
  }
  // A linked exclusion could alias the anchor despite lexical separation.
  for (const excludedRoot of excluded) {
    for (let path = resolve(excludedRoot);; path = dirname(path)) {
      try { if (fs.lstatSync(path).isSymbolicLink()) throw new Error("unsafe-anchor"); }
      catch (error) { if (code(error) !== "ENOENT") throw new Error("unsafe-anchor"); }
      if (dirname(path) === path) break;
    }
  }
  const ancestors = new Map<string, fs.Stats>();
  const check = (path: string, privateDir = false) => {
    const stat = fs.lstatSync(path);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
        (privateDir && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) throw new Error("unsafe-anchor");
    ancestors.set(path, stat);
  };
  const chain: string[] = [];
  for (let path = home;; path = dirname(path)) { chain.unshift(path); if (dirname(path) === path) break; }
  for (const path of chain) check(path);
  for (const path of [join(home, ".anycode"), anchor]) {
    try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw new Error("unsafe-anchor"); }
    check(path, path === anchor);
  }
  let root = "";
  for (let slot = 0; slot < 128; slot++) {
    const path = join(anchor, String(slot));
    try { fs.mkdirSync(path, { mode: 0o700 }); root = path; break; }
    catch (error) { if (code(error) !== "EEXIST") throw new Error("snapshot-io"); }
  }
  if (!root) throw new Error("quota");
  const nodes = new Map<string, fs.Stats>([[root, fs.lstatSync(root)]]);
  let released = false, bound = false, exited = false;
  let pgid: number | undefined, timer: ReturnType<typeof setTimeout> | undefined, delay = 1000;
  const probe = runtime.probe ?? ((id: number) => { process.kill(-id, 0); });
  const cleanup = () => {
    if (released) return;
    try {
      // Validate the entire known tree BEFORE chmod/unlink; no recursive removal.
      for (const [path, stat] of [...ancestors, ...nodes]) {
        const now = fs.lstatSync(path);
        if (!same(stat, now) || (ancestors.has(path) && stat.mode !== now.mode) || now.isSymbolicLink() || now.isDirectory() !== stat.isDirectory() ||
            (!now.isDirectory() && (!now.isFile() || now.nlink !== 1))) return;
        if (nodes.has(path) && now.isDirectory()) {
          const expected = [...nodes.keys()].filter(p => p !== path && dirname(p) === path).map(p => relative(path, p)).sort();
          if (JSON.stringify(fs.readdirSync(path).sort()) !== JSON.stringify(expected)) return;
        }
      }
      for (const [path, stat] of nodes) if (stat.isDirectory()) fs.chmodSync(path, 0o700);
      for (const [path, stat] of [...nodes].reverse()) {
        if (stat.isDirectory()) fs.rmdirSync(path); else fs.unlinkSync(path);
      }
      released = true;
      if (timer) clearTimeout(timer);
    } catch { /* Uncertain identity or I/O: retain, never broaden deletion. */ }
  };
  const directory = (path: string) => {
    fs.mkdirSync(path, { mode: 0o700 }); nodes.set(path, fs.lstatSync(path));
  };
  const file = (path: string, bytes: string) => {
    const fd = fs.openSync(path, "wx", 0o600);
    try { nodes.set(path, fs.fstatSync(fd)); fs.writeFileSync(fd, bytes, "utf8"); }
    finally { fs.closeSync(fd); }
  };
  try {
    const definitions = buildEngineBuiltinSkills({ engine: input.engine, browser: input.browser }).filter(def => !input.disabled?.includes(def.id));
    // No file sources or generic body/path input.
    let total = 0;
    directory(join(root, "skills"));
    if (input.engine === "claude") {
      directory(join(root, ".claude-plugin"));
      const manifest = '{"name":"anycode-app"}\n';
      file(join(root, ".claude-plugin/plugin.json"), manifest);
      total += Buffer.byteLength(manifest, "utf8");
    }
    for (const def of definitions) {
      const bytes = Buffer.byteLength(def.skillMd, "utf8"); total += bytes;
      if (bytes > 64 * 1024 || total > 256 * 1024) throw new Error("snapshot-size");
      directory(join(root, "skills", def.name)); file(join(root, "skills", def.name, "SKILL.md"), def.skillMd);
    }
    for (const [path, stat] of [...nodes].reverse()) fs.chmodSync(path, stat.isDirectory() ? 0o500 : 0o400);
  } catch { cleanup(); throw new Error("snapshot-io"); }
  const reclaim = () => {
    if (released || !exited || !pgid) return;
    if (timer) clearTimeout(timer);
    try { probe(pgid); }
    catch (error) { if (code(error) === "ESRCH") { cleanup(); return; } }
    timer = setTimeout(reclaim, delay); timer.unref(); delay = Math.min(delay * 2, 30_000);
  };
  return {
    root,
    abortNeverSpawned() { if (!bound) cleanup(); },
    reclaim,
    bindChild(child, dedicatedProcessGroup) {
      if (bound || released) throw new Error("lease-bound");
      bound = true;
      // No await, including on spawn error. Error/close/handshake are not death proof.
      child.once("exit", () => { exited = true; reclaim(); });
      child.once("error", () => {});
      if (dedicatedProcessGroup && Number.isSafeInteger(child.pid) && child.pid! > 0) pgid = child.pid;
      if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode != null) {
        exited = true; reclaim();
      }
    },
  };
}

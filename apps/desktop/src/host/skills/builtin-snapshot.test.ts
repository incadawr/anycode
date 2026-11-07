import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildEngineBuiltinSkills } from "../engine-builtin-skills.js";
import { createEngineBrowserBridge } from "../engines/browser-bridge.js";
import { prepareBuiltinSnapshot } from "./builtin-snapshot.js";

let home: string;
const children: ChildProcess[] = [];
beforeEach(() => { home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "builtin-")); });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  // Test-only teardown: restore sealed directories before removing synthetic data.
  const writable = (path: string) => {
    if (!fs.lstatSync(path).isDirectory()) { fs.unlinkSync(path); return; }
    fs.chmodSync(path, 0o700);
    for (const name of fs.readdirSync(path)) writable(join(path, name));
    fs.rmdirSync(path);
  };
  writable(home);
});
const browser = createEngineBrowserBridge({ preview: {} as never, broker: { requestPermission: vi.fn() }, fullAccess: () => false, cwd: "/synthetic" });
const input = () => ({ hostProfileHome: home, workspace: join(home, "project"), engine: "claude" as const });
const anchor = () => join(home, ".anycode/builtin-snapshots-mvp");
const skill = (root: string) => join(root, "skills/anycode-setup/SKILL.md");
const child = () => {
  const value = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  children.push(value); return value;
};

it("seals exact bytes and modes in distinct slots; never-spawned abort releases them", () => {
  const a = prepareBuiltinSnapshot(input()); const b = prepareBuiltinSnapshot(input());
  expect(a.root).not.toBe(b.root);
  expect(fs.readFileSync(skill(a.root), "utf8")).toBe(buildEngineBuiltinSkills({ engine: "claude" })[0]!.skillMd);
  expect(fs.readFileSync(join(a.root, ".claude-plugin/plugin.json"), "utf8")).toBe('{"name":"anycode-app"}\n');
  for (const path of [a.root, join(a.root, "skills"), join(a.root, "skills/anycode-setup")]) {
    expect(fs.statSync(path).mode & 0o777).toBe(0o500);
  }
  expect(fs.statSync(skill(a.root)).mode & 0o777).toBe(0o400);
  a.abortNeverSpawned(); b.abortNeverSpawned(); expect(fs.readdirSync(anchor())).toEqual([]);
});

it.each(["write", "publish"])("%s failure returns no partial snapshot", kind => {
  if (kind === "write") {
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((...args) => { write(...args); throw new Error("write"); });
  }
  else {
    const chmod = fs.chmodSync;
    vi.spyOn(fs, "chmodSync").mockImplementation((path, mode) => {
      if (mode === 0o500 && String(path) === join(anchor(), "0")) throw new Error("publish");
      chmod(path, mode);
    });
  }
  expect(() => prepareBuiltinSnapshot(input())).toThrow();
  expect(fs.readdirSync(anchor())).toEqual([]);
});

it("refuses symlink, shared and foreign anchors and a workspace containing the anchor", () => {
  fs.mkdirSync(join(home, ".anycode")); fs.symlinkSync(home, anchor());
  expect(() => prepareBuiltinSnapshot(input())).toThrow(); fs.unlinkSync(anchor());
  fs.mkdirSync(anchor(), { mode: 0o777 }); fs.chmodSync(anchor(), 0o777);
  expect(() => prepareBuiltinSnapshot(input())).toThrow(); fs.chmodSync(anchor(), 0o700);
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
    const stat = lstat(path); if (String(path) === anchor()) Object.defineProperty(stat, "uid", { value: process.getuid!() + 1 });
    return stat;
  }) as typeof fs.lstatSync);
  expect(() => prepareBuiltinSnapshot(input())).toThrow(); vi.restoreAllMocks();
  expect(() => prepareBuiltinSnapshot({ ...input(), workspace: home })).toThrow();
});

it("atomic contention skips an occupied generation; crash slots are never swept", () => {
  const a = prepareBuiltinSnapshot(input());
  const otherHost = prepareBuiltinSnapshot(input());
  expect(fs.readFileSync(skill(a.root))).toEqual(fs.readFileSync(skill(otherHost.root)));
  otherHost.abortNeverSpawned();
  for (let i = 0; i < 128; i++) { try { fs.mkdirSync(join(anchor(), String(i)), { mode: 0o700 }); } catch {} }
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("no source reads"); });
  expect(() => prepareBuiltinSnapshot(input())).toThrow("quota");
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  expect(fs.existsSync(skill(a.root))).toBe(true);
});

it("win32 refuses before building text or creating an anchor", () => {
  expect(() => prepareBuiltinSnapshot(input(), { platform: "win32" })).toThrow("unsupported");
  expect(fs.existsSync(anchor())).toBe(false);
});

it("registers listeners synchronously; handshake error and EPERM/unknown retain until ESRCH", async () => {
  vi.useFakeTimers(); let gone = false;
  const lease = prepareBuiltinSnapshot(input(), { probe: () => { throw Object.assign(new Error(), { code: gone ? "ESRCH" : "EPERM" }); } });
  const proc = child(); lease.bindChild(proc, true);
  expect(proc.listenerCount("exit")).toBeGreaterThan(0); expect(proc.listenerCount("error")).toBeGreaterThan(0);
  proc.emit("error", new Error("handshake")); lease.abortNeverSpawned();
  expect(fs.existsSync(skill(lease.root))).toBe(true);
  proc.emit("exit", 0, null); await vi.advanceTimersByTimeAsync(31_000);
  expect(fs.existsSync(skill(lease.root))).toBe(true);
  gone = true; await vi.advanceTimersByTimeAsync(30_000);
  expect(fs.existsSync(lease.root)).toBe(false);
});

it("unknown probe and replaced root retain; an unbound PID is never death proof", () => {
  let gone = false;
  const lease = prepareBuiltinSnapshot(input(), { probe: () => { throw gone ? Object.assign(new Error(), { code: "ESRCH" }) : new Error("unknown"); } });
  const proc = child(); lease.bindChild(proc, true); proc.emit("exit", 0, null);
  expect(fs.existsSync(skill(lease.root))).toBe(true);
  fs.chmodSync(lease.root, 0o700); fs.renameSync(lease.root, lease.root + "-old"); fs.mkdirSync(lease.root);
  gone = true; lease.reclaim(); expect(fs.existsSync(lease.root)).toBe(true);
  const missing = prepareBuiltinSnapshot(input());
  missing.bindChild({ once: vi.fn() } as unknown as ChildProcess, true);
  missing.abortNeverSpawned(); expect(fs.existsSync(missing.root)).toBe(true);
});

it("normal real group exit reclaims promptly", async () => {
  const lease = prepareBuiltinSnapshot(input()); const proc = child(); lease.bindChild(proc, true);
  const exited = once(proc, "exit"); proc.kill(); await exited;
  await vi.waitFor(() => expect(fs.existsSync(lease.root)).toBe(false), { timeout: 4500 });
});

it("a real in-group reader keeps sealed bytes after leader exit, then ESRCH reclaims", async () => {
  const lease = prepareBuiltinSnapshot(input());
  const marker = join(home, "reader-proof");
  const code = `const fs=require('fs');setTimeout(()=>fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1])),200);setTimeout(()=>process.exit(0),1200);process.send('ready');`;
  const leader = spawn(process.execPath, ["-e", `const {fork}=require('child_process');const c=fork('-e',[${JSON.stringify(code)},${JSON.stringify(skill(lease.root))},${JSON.stringify(marker)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>{process.send(c.pid);c.disconnect();process.exit(0);});`], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(leader); lease.bindChild(leader, true);
  const exited = once(leader, "exit"); await once(leader, "message"); await exited;
  expect(fs.existsSync(skill(lease.root))).toBe(true);
  await vi.waitFor(() => expect(fs.readFileSync(marker)).toEqual(fs.readFileSync(skill(lease.root))));
  await vi.waitFor(() => { lease.reclaim(); expect(fs.existsSync(lease.root)).toBe(false); }, { timeout: 4500 });
});

it.each(["claude", "codex"] as const)("%s publishes all three fixed definitions and omits disabled on the next lease", engine => {
  const lease = prepareBuiltinSnapshot({ ...input(), engine, browser });
  const definitions = buildEngineBuiltinSkills({ engine, browser });
  expect(definitions).toHaveLength(3);
  for (const def of definitions) {
    const path = join(lease.root, "skills", def.name, "SKILL.md");
    expect(fs.readFileSync(path)).toEqual(Buffer.from(def.skillMd));
    expect(fs.statSync(path).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path).nlink).toBe(1);
  }
  const next = prepareBuiltinSnapshot({ ...input(), engine, browser, disabled: ["anycode-setup"] });
  expect(fs.readdirSync(join(next.root, "skills"))).toHaveLength(2);
  expect(fs.readdirSync(join(lease.root, "skills"))).toHaveLength(3);
  lease.abortNeverSpawned(); next.abortNeverSpawned();
});

it("losing atomic mkdir contention never overwrites the winner", () => {
  const seed = prepareBuiltinSnapshot(input()); seed.abortNeverSpawned();
  const mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
    if (String(path) === join(anchor(), "0")) {
      mkdir(path, options); fs.writeFileSync(join(String(path), "foreign"), "winner");
      throw Object.assign(new Error(), { code: "EEXIST" });
    }
    return mkdir(path, options);
  }) as typeof fs.mkdirSync);
  const lease = prepareBuiltinSnapshot(input());
  expect(lease.root).toBe(join(anchor(), "1"));
  expect(fs.readFileSync(join(anchor(), "0/foreign"), "utf8")).toBe("winner");
  lease.abortNeverSpawned();
});

it("foreign entries, hardlinks, and replaced anchor identities prevent deletion", () => {
  const a = prepareBuiltinSnapshot(input());
  fs.chmodSync(a.root, 0o700); fs.writeFileSync(join(a.root, "foreign"), "retain");
  a.abortNeverSpawned(); expect(fs.existsSync(skill(a.root))).toBe(true);
  const b = prepareBuiltinSnapshot(input()); fs.linkSync(skill(b.root), join(home, "extra-link"));
  b.abortNeverSpawned(); expect(fs.existsSync(skill(b.root))).toBe(true);
  const c = prepareBuiltinSnapshot(input());
  fs.renameSync(anchor(), anchor() + "-old"); fs.mkdirSync(anchor(), { mode: 0o700 });
  c.abortNeverSpawned(); expect(fs.existsSync(anchor() + "-old")).toBe(true);
});

it("excluded custom CLI/plugin roots and linked ancestors refuse before allocation", () => {
  expect(() => prepareBuiltinSnapshot({ ...input(), excludedRoots: [home] })).toThrow("unsafe-anchor");
  const linked = join(home, "linked"); fs.symlinkSync(home, linked);
  expect(() => prepareBuiltinSnapshot({ ...input(), hostProfileHome: linked })).toThrow("unsafe-anchor");
  expect(fs.existsSync(anchor())).toBe(false);
});

it("a linked workspace cannot alias the profile home", () => {
  const linked = join(home, "workspace"); fs.symlinkSync(home, linked);
  expect(() => prepareBuiltinSnapshot({ ...input(), workspace: linked })).toThrow("unsafe-anchor");
  expect(fs.existsSync(anchor())).toBe(false);
});

it("ESRCH before direct exit and a non-dedicated child cannot authorize cleanup", () => {
  const probe = vi.fn(() => { throw Object.assign(new Error(), { code: "ESRCH" }); });
  const a = prepareBuiltinSnapshot(input(), { probe }); const proc = child();
  a.bindChild(proc, true); a.reclaim(); expect(probe).not.toHaveBeenCalled();
  const b = prepareBuiltinSnapshot(input(), { probe }); b.bindChild(proc, false);
  proc.emit("exit", 0, null);
  expect(fs.existsSync(a.root)).toBe(false); expect(fs.existsSync(b.root)).toBe(true);
  expect(probe).toHaveBeenCalledTimes(1);
});

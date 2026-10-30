import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveTrustedPlanCommand } from "./plan-command.js";

const fixture = vi.hoisted(() => ({ paths: new Set<string>(), target: "", fd: -1 }));

// Model a trusted system installation and a native executable while letting the
// actual shell execute the fixture script to observe its invocation name.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (path: Parameters<typeof fs.lstatSync>[0]) => {
      const stat = fs.lstatSync(path);
      if (fixture.paths.has(String(path))) return Object.assign(stat, { uid: 0, mode: (stat.mode & ~0o022) });
      return stat;
    },
    statSync: (path: Parameters<typeof fs.statSync>[0]) => {
      const stat = fs.statSync(path);
      if (fixture.paths.has(String(path))) return Object.assign(stat, { uid: 0, mode: (stat.mode & ~0o022) });
      return stat;
    },
    accessSync: (path: Parameters<typeof fs.accessSync>[0], mode?: number) => {
      if (mode === fs.constants.W_OK && (fixture.paths.has(String(path)) ||
          (process.getuid?.() === 0 && fs.statSync(path).uid === 0 && (fs.statSync(path).mode & 0o022) === 0))) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return fs.accessSync(path, mode);
    },
    openSync: (path: Parameters<typeof fs.openSync>[0], flags: string) => {
      const fd = fs.openSync(path, flags);
      if (String(path) === fixture.target) fixture.fd = fd;
      return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (fd === fixture.fd) { buffer.writeUInt32BE(0x7f454c46, offset); return 4; }
      return fs.readSync(fd, buffer, offset, length, position);
    },
    closeSync: (fd: number) => { if (fd === fixture.fd) fixture.fd = -1; fs.closeSync(fd); },
  };
});

it("preserves the PATH entry name for a multicall executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-multicall-"));
  const originalPath = process.env.PATH;
  const target = join(dir, "multicall");
  const marker = join(dir, "marker");
  try {
    writeFileSync(target, '#!/bin/sh\ncase "${0##*/}" in\n  ls) printf "ls role\\n" ;;\n  *) if [ "$1" = touch ]; then /usr/bin/touch "$2"; fi ;;\nesac\n', { mode: 0o755 });
    symlinkSync("multicall", join(dir, "ls"));
    fixture.target = realpathSync(target);
    for (const path of [join(dir, "ls"), join(realpathSync(dir), "ls"), target, fixture.target]) {
      let current = path;
      for (;;) {
        fixture.paths.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    process.env.PATH = dir;
    const bound = resolveTrustedPlanCommand(`ls touch ${marker}`);
    expect(bound).toBe(`'${join(dir, "ls")}' touch ${marker}`);
    expect(execFileSync("/bin/sh", ["-c", bound!], { encoding: "utf8" })).toBe("ls role\n");
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    fixture.paths.clear();
    fixture.target = "";
    rmSync(dir, { recursive: true, force: true });
  }
});


it("rejects a symlink chain that passes through a writable directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-chain-"));
  const trusted = join(dir, "trusted");
  const writable = join(dir, "writable");
  const target = join(trusted, "binary");
  const originalPath = process.env.PATH;
  try {
    mkdirSync(trusted);
    mkdirSync(writable);
    chmodSync(writable, 0o777);
    writeFileSync(target, "fixture", { mode: 0o755 });
    symlinkSync(target, join(writable, "alias"));
    symlinkSync(join(writable, "alias"), join(trusted, "ls"));
    fixture.target = realpathSync(target);
    for (const path of [join(trusted, "ls"), join(realpathSync(trusted), "ls"), target, fixture.target]) {
      let current = path;
      for (;;) {
        fixture.paths.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    process.env.PATH = trusted;
    expect(resolveTrustedPlanCommand("ls")).toBeUndefined();
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    fixture.paths.clear();
    fixture.target = "";
    rmSync(dir, { recursive: true, force: true });
  }
});

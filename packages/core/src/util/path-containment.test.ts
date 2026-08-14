/**
 * Tests for `resolveWorkspaceWriteFacts` (TASK.32 DV-3): the dispatch-site
 * helper that proves a Write/Edit target sits inside a workspace root by
 * resolving BOTH sides through symlinks. Real-fs cases use `mkdtemp` +
 * `NodeFileSystemAdapter`, mirroring node-git.test.ts's style; every mkdtemp
 * root is realpath'd first (macOS `/var` -> `/private/var`). Fake-port cases
 * use minimal object literals typed `as FileSystemPort`.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { isWithinWorkspace } from "../permissions/workspace-policy.js";
import { isUnderOwnRootsResolved, resolveWorkspaceWriteFacts } from "./path-containment.js";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";

const adapter = new NodeFileSystemAdapter();
const tmpRoots: string[] = [];

async function mkWorkspace(): Promise<string> {
  const dir = await fsp.mkdtemp(join(tmpdir(), "path-containment-"));
  const real = await fsp.realpath(dir);
  tmpRoots.push(real);
  return real;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveWorkspaceWriteFacts", () => {
  it("R1: existing file inside => facts with both sides realpath'd", async () => {
    const ws = await mkWorkspace();
    await fsp.mkdir(join(ws, "dir"), { recursive: true });
    await fsp.writeFile(join(ws, "dir", "a.txt"), "x");

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "dir", "a.txt"));

    expect(facts).toEqual({ root: ws, resolvedPath: join(ws, "dir", "a.txt") });
  });

  it("R2: not-yet-existing leaf under existing dir => facts (ancestor+rejoin)", async () => {
    const ws = await mkWorkspace();
    await fsp.mkdir(join(ws, "dir"), { recursive: true });

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "dir", "new.txt"));

    expect(facts).toEqual({ root: ws, resolvedPath: join(ws, "dir", "new.txt") });
  });

  it("R3: relative filePath => undefined", async () => {
    const ws = await mkWorkspace();
    const facts = await resolveWorkspaceWriteFacts(adapter, ws, "a/b.txt");
    expect(facts).toBeUndefined();
  });

  it("R4: .. after a symlink component => undefined (D-S1-3)", async () => {
    // node:path.resolve collapses `..` LEXICALLY before any symlink is seen,
    // but the kernel resolves symlinks FIRST. So `<ws>/link/../escape.txt`
    // with `link -> <outside>` would lexically resolve to `<ws>/escape.txt`
    // (inside) while the kernel actually writes `<outside>/escape.txt`
    // (outside) — proving containment on the lexical form would be a lie.
    // The dot-segment refusal must catch this BEFORE any resolution happens.
    const base = await mkWorkspace();
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, join(ws, "link"), "dir");

    // Built by string concatenation, NOT path.join: join() would lexically
    // normalize away the ".." segment before the function ever saw it, which
    // is precisely the collapse this refusal must catch upstream of.
    const facts = await resolveWorkspaceWriteFacts(adapter, ws, `${join(ws, "link")}/../escape.txt`);

    expect(facts).toBeUndefined();
  });

  it("R5: symlink resolving inside => facts inside", async () => {
    const ws = await mkWorkspace();
    await fsp.mkdir(join(ws, "real"), { recursive: true });
    await fsp.symlink(join(ws, "real"), join(ws, "link2"), "dir");

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "link2", "new.txt"));

    expect(facts).toEqual({ root: ws, resolvedPath: join(ws, "real", "new.txt") });
  });

  it("R6: symlink escaping => facts land OUTSIDE root", async () => {
    const base = await mkWorkspace();
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, join(ws, "out"), "dir");

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "out", "x.txt"));

    expect(facts).toBeDefined();
    expect(isWithinWorkspace(facts!.resolvedPath, facts!.root)).toBe(false);
  });

  it("R7: dangling symlink component => undefined (P1-1)", async () => {
    const ws = await mkWorkspace();
    await fsp.symlink(join(ws, "gone"), join(ws, "dang"), "dir");

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "dang", "x.txt"));

    expect(facts).toBeUndefined();
  });

  it("R8: port without realpath => undefined; fs === undefined => undefined", async () => {
    const ws = await mkWorkspace();
    const noRealpathPort = {
      exists: adapter.exists.bind(adapter),
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
    } as unknown as FileSystemPort;

    const facts1 = await resolveWorkspaceWriteFacts(noRealpathPort, ws, join(ws, "a.txt"));
    expect(facts1).toBeUndefined();

    const facts2 = await resolveWorkspaceWriteFacts(undefined, ws, join(ws, "a.txt"));
    expect(facts2).toBeUndefined();
  });

  it("R9: realpath throwing => undefined (root side and target side)", async () => {
    const ws = await mkWorkspace();

    const rootThrowsPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      lstat: adapter.lstat.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async () => {
        throw new Error("boom");
      },
    };
    const facts1 = await resolveWorkspaceWriteFacts(rootThrowsPort, ws, join(ws, "a.txt"));
    expect(facts1).toBeUndefined();

    const targetThrowsPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: adapter.realpath.bind(adapter),
      lstat: async () => {
        throw new Error("boom");
      },
    };
    const facts2 = await resolveWorkspaceWriteFacts(targetThrowsPort, ws, join(ws, "a.txt"));
    // lstat throwing makes probePresence report false at every level, so the
    // walk reaches the filesystem root with nothing "present" -> undefined.
    expect(facts2).toBeUndefined();
  });

  it("R10: nonexistent workspaceRoot => undefined", async () => {
    const base = await mkWorkspace();
    const noSuchRoot = join(base, "no-such-root");

    const facts = await resolveWorkspaceWriteFacts(adapter, noSuchRoot, join(noSuchRoot, "a.txt"));

    expect(facts).toBeUndefined();
  });

  it("R11: symlinked workspaceRoot => root realpath'd and containment coheres", async () => {
    const base = await mkWorkspace();
    const realroot = join(base, "realroot");
    const rootlink = join(base, "rootlink");
    await fsp.mkdir(realroot, { recursive: true });
    await fsp.symlink(realroot, rootlink, "dir");

    const facts = await resolveWorkspaceWriteFacts(adapter, rootlink, join(rootlink, "a.txt"));

    expect(facts).toBeDefined();
    expect(facts!.root).toBe(realroot);
    expect(isWithinWorkspace(facts!.resolvedPath, facts!.root)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fix cycle 1 (TASK.32 S1 adversarial review): B1 (errno-blind presence
  // probe) + M1 (lstat-less port fails open, contrary to the port contract).

  it("R12: port with realpath but without lstat over a dangling-symlink component => undefined (M1, port contract fail-closed)", async () => {
    const ws = await mkWorkspace();
    await fsp.symlink(join(ws, "gone"), join(ws, "dang"), "dir");
    const noLstatPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: adapter.realpath.bind(adapter),
      // lstat intentionally omitted — the port has realpath but not lstat.
    };

    const facts = await resolveWorkspaceWriteFacts(noLstatPort, ws, join(ws, "dang", "pwn.txt"));

    expect(facts).toBeUndefined();
  });

  it("R13: lstat rejecting with a non-ENOENT errno on a LIVE escaping symlink component => undefined, not lexically rejoined (B1)", async () => {
    const base = await mkWorkspace();
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, join(ws, "out"), "dir");
    const flakyTarget = join(ws, "out");

    const flakyPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: adapter.realpath.bind(adapter),
      lstat: async (p: string) => {
        if (p === flakyTarget) {
          const err = new Error("simulated EIO (network/removable mount)") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return adapter.lstat(p);
      },
    };

    const facts = await resolveWorkspaceWriteFacts(flakyPort, ws, join(ws, "out", "pwn.txt"));

    // Before the fix this returned {root: ws, resolvedPath: `${ws}/out/pwn.txt`}
    // — lexically "inside" the workspace while the real OS-level write follows
    // the symlink out to `outside/pwn.txt`. The engine would then rule "allow".
    expect(facts).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Fix cycle 1 extension (ARBITRATION-S1-W1 N1): NUL byte in `filePath`.

  it("R14: NUL byte in filePath => undefined (N1, ARBITRATION-S1-W1)", async () => {
    // Deliberately a FAKE, NUL-TOLERANT port (not the real adapter): its
    // `lstat` reports plain ENOENT for any NUL-bearing path instead of
    // throwing Node's ERR_INVALID_ARG_VALUE. This makes the test deterministic
    // under BOTH pre-B1 and post-B1 probe semantics — every probePresence
    // variant treats ENOENT as "absent" — so a red here can only be caused by
    // the N1 refusal itself, never by the B1 errno guard rescuing it.
    const nulTolerantPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async (p: string) => p,
      lstat: async (p: string): Promise<FileStat> => {
        if (p.includes("\0")) {
          const err = new Error("simulated ENOENT for a NUL-bearing path") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return { size: 0, mtimeMs: 0, isFile: true, isDirectory: false, isSymbolicLink: false };
      },
    };

    const facts = await resolveWorkspaceWriteFacts(nulTolerantPort, "/ws", "/ws/a\u0000b.txt");

    expect(facts).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Fix cycle 2 (W2-NIT-1): errnoCode's `.code` read used to be unguarded
  // inside probePresence's catch, so a rejection whose `.code` is a THROWING
  // accessor escaped probePresence, then realpathExistingAncestor (whose loop
  // has no try), regressing `isUnderOwnRootsResolved`'s totality (its own
  // `catch { return false }` never sees a throw from outside its scope).

  it("R15: lstat rejecting with a throwing `.code` getter => both resolveWorkspaceWriteFacts and isUnderOwnRootsResolved fail closed WITHOUT throwing (W2-NIT-1)", async () => {
    const poisonedPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async (p: string) => p,
      lstat: async (): Promise<FileStat> => {
        const err = new Error("boom");
        Object.defineProperty(err, "code", {
          get(): string {
            throw new Error("getter exploded");
          },
        });
        throw err;
      },
    };

    // Half 1: resolveWorkspaceWriteFacts already absorbs this (its own outer
    // try/catch) — pinned so a future regression there is also caught.
    let facts: Awaited<ReturnType<typeof resolveWorkspaceWriteFacts>>;
    let threwFacts = false;
    try {
      facts = await resolveWorkspaceWriteFacts(poisonedPort, "/ws", "/ws/a.txt");
    } catch {
      threwFacts = true;
    }
    expect(threwFacts).toBe(false);
    expect(facts).toBeUndefined();

    // Half 2: isUnderOwnRootsResolved — the actual regression. Its bare
    // `catch { return false }` cannot catch a throw from OUTSIDE its own
    // scope (realpathExistingAncestor's walk loop has no try), so pre-fix
    // this call propagates `Error: getter exploded` instead of returning
    // false.
    let underRoots: boolean | undefined;
    let threwUnder = false;
    try {
      underRoots = await isUnderOwnRootsResolved(poisonedPort, "/ws/a.txt", ["/ws"]);
    } catch {
      threwUnder = true;
    }
    expect(threwUnder).toBe(false);
    expect(underRoots).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Fix cycle 2 (W2-MAJOR-1, ARBITRATION-S1-W2): containment is inode-blind.
  // A hard link inside the workspace aliases an inode whose OTHER name can
  // sit outside the workspace; `writeFile` truncates in place, mutating
  // every alias. Facts for an EXISTING leaf are minted only when `lstat`
  // proves a single-linked (`nlink === 1`) regular file.

  it("R16: hard-linked in-workspace leaf aliases an outside file => undefined (measured trigger, real adapter, ARBITRATION-S1-W2 MAJOR-1)", async () => {
    const base = await mkWorkspace();
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(join(outside, "secret.txt"), "ORIGINAL");
    // Hard link: a SECOND name for the SAME inode, one name inside the
    // workspace, one outside. NOT a symlink — lstat reports isFile:true,
    // isSymbolicLink:false, exactly like an ordinary contained file.
    await fsp.link(join(outside, "secret.txt"), join(ws, "innocent.txt"));

    const facts = await resolveWorkspaceWriteFacts(adapter, ws, join(ws, "innocent.txt"));

    expect(facts).toBeUndefined();
  });

  it("R17: existing regular-file leaf with unknown link count (port omits nlink) => undefined (pins the port class, ARBITRATION-S1-W2 MAJOR-1)", async () => {
    const noNlinkPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async (p: string) => p,
      lstat: async (): Promise<FileStat> => ({
        size: 0,
        mtimeMs: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        // nlink intentionally OMITTED — the port class this pins.
      }),
    };

    const facts = await resolveWorkspaceWriteFacts(noNlinkPort, "/ws", "/ws/innocent.txt");

    expect(facts).toBeUndefined();
  });

  it("R18: existing regular-file leaf with nlink === 1 => facts minted (predicate boundary, ARBITRATION-S1-W2 MAJOR-1)", async () => {
    const singleLinkPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async (p: string) => p,
      lstat: async (): Promise<FileStat> => ({
        size: 0,
        mtimeMs: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        nlink: 1,
      }),
    };

    const facts = await resolveWorkspaceWriteFacts(singleLinkPort, "/ws", "/ws/innocent.txt");

    expect(facts).toEqual({ root: "/ws", resolvedPath: "/ws/innocent.txt" });
  });

  it("R18a: existing regular-file leaf with nlink === 2 => undefined (predicate boundary, ARBITRATION-S1-W2 MAJOR-1)", async () => {
    const doubleLinkPort: FileSystemPort = {
      readFile: adapter.readFile.bind(adapter),
      writeFile: adapter.writeFile.bind(adapter),
      stat: adapter.stat.bind(adapter),
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      readdir: adapter.readdir.bind(adapter),
      copyFile: adapter.copyFile.bind(adapter),
      rm: adapter.rm.bind(adapter),
      realpath: async (p: string) => p,
      lstat: async (): Promise<FileStat> => ({
        size: 0,
        mtimeMs: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        nlink: 2,
      }),
    };

    const facts = await resolveWorkspaceWriteFacts(doubleLinkPort, "/ws", "/ws/innocent.txt");

    expect(facts).toBeUndefined();
  });
});

/**
 * artifacts-root (Taskana 4104 / TASK.110): pins the desktop's artifact-store
 * root conditional. The SAME conditional must hold in both desktop processes —
 * main (boot sweep) and host (store construction) — which is exactly why it
 * lives in ONE shared helper (artifacts-root.ts) instead of being inlined twice.
 *
 * The real CLI twin is packages/core/src/cli/main.ts:1155-1158 (artifactsRoot);
 * the desktop's own checkpoints root (host/index.ts checkpointsRoot) uses the
 * same dirname-sibling / ~/.anycode-for-:memory: shape — pinned below as a
 * drift check, mirroring the local re-implementation precedent of
 * host/checkpoints-wire.test.ts:53-55.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { artifactsRootFor } from "./artifacts-root.js";

/** The checkpoints twin (host/index.ts checkpointsRoot): same conditional, leaf "checkpoints". */
function checkpointsRootFor(dbPath: string, home: string): string {
  return dbPath === ":memory:"
    ? join(home, ".anycode", "checkpoints")
    : join(dirnameRef(dbPath), "checkpoints");
}
function dirnameRef(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
}

describe("artifactsRootFor (Taskana 4104)", () => {
  const home = join("/fake", "home", "tester");

  it(":memory: db falls back to <home>/.anycode/artifacts", () => {
    expect(artifactsRootFor(":memory:", home)).toBe(join(home, ".anycode", "artifacts"));
  });

  it("file db puts artifacts beside the sqlite file", () => {
    const dbPath = join(home, "db", "anycode.sqlite");
    expect(artifactsRootFor(dbPath, home)).toBe(join(home, "db", "artifacts"));
  });

  it("drift pin: equals the checkpoints conditional modulo the leaf name", () => {
    for (const dbPath of [":memory:", join(home, "db", "anycode.sqlite"), join("/data", "x.sqlite")]) {
      expect(artifactsRootFor(dbPath, home)).toBe(
        checkpointsRootFor(dbPath, home).replace(/checkpoints$/, "artifacts"),
      );
    }
  });
});

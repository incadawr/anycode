/**
 * NodeArtifactStore (TASK.94) — write/read/atom/rename semantics, the
 * per-write cap, session-scoped removal and the age-based sweep that is the
 * only GUARANTEED collector. Real temp dirs, real fs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeArtifactStore } from "./node-artifacts.js";

describe("NodeArtifactStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anycode-artifacts-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const request = (overrides: Partial<Parameters<NodeArtifactStore["writeToolResultArtifact"]>[0]> = {}) => ({
    sessionId: "s1",
    toolCallId: "call-1",
    toolName: "Bash",
    content: "line-a\nline-b\n",
    contentType: "text/plain" as const,
    retention: "session" as const,
    ...overrides,
  });

  describe("writeToolResultArtifact", () => {
    it("writes the full content under <root>/<sessionId>/<toolCallId> and reports its size", async () => {
      const store = new NodeArtifactStore(root);
      const { path, bytes } = await store.writeToolResultArtifact(request());

      expect(path).toBe(join(root, "s1", "call-1"));
      expect(bytes).toBe(Buffer.byteLength("line-a\nline-b\n", "utf8"));
      await expect(stat(path)).resolves.toBeDefined();
    });

    it("writes byte-identical content (atomic rename leaves no half-write visible)", async () => {
      const store = new NodeArtifactStore(root);
      const payload = "x".repeat(10_000);
      const { path } = await store.writeToolResultArtifact(
        request({ content: payload, toolCallId: "big" }),
      );
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(path, "utf-8")).toBe(payload);
      // No leftover .tmp file in the session directory.
      const entries = await (await import("node:fs/promises")).readdir(join(root, "s1"));
      expect(entries).toEqual(["big"]);
    });

    it("refuses a sessionId or toolCallId containing a path separator", async () => {
      const store = new NodeArtifactStore(root);
      await expect(store.writeToolResultArtifact(request({ sessionId: "../escape" }))).rejects.toThrow();
      await expect(store.writeToolResultArtifact(request({ toolCallId: "a/b" }))).rejects.toThrow();
      // Nothing was written outside the root.
      await expect(stat(join(root, "s1"))).rejects.toBeDefined();
    });

    it("refuses `.` and `..` even though they match the safe alphabet", async () => {
      const store = new NodeArtifactStore(root);
      await expect(store.writeToolResultArtifact(request({ sessionId: ".." }))).rejects.toThrow();
      await expect(store.writeToolResultArtifact(request({ toolCallId: "." }))).rejects.toThrow();
    });

    it("refuses content over the per-write cap (configurable for tests)", async () => {
      const store = new NodeArtifactStore(root, { maxBytes: 8 });
      await expect(
        store.writeToolResultArtifact(request({ content: "x".repeat(100) })),
      ).rejects.toThrow(/per-write cap/);
    });

    it("never leaves a .tmp file behind when the rename target is unavailable", async () => {
      const store = new NodeArtifactStore(root);
      // Make the session dir a regular FILE so mkdir+rename cannot land there.
      await writeFile(join(root, "s1"), "blocker");
      await expect(
        store.writeToolResultArtifact(request()),
      ).rejects.toBeDefined();
      // The blocking file is untouched; no tmp file materialised next to it.
      const entries = await (await import("node:fs/promises")).readdir(root);
      expect(entries).toEqual(["s1"]);
    });
  });

  describe("removeSession", () => {
    it("deletes a non-empty session directory", async () => {
      const store = new NodeArtifactStore(root);
      await store.writeToolResultArtifact(request({ toolCallId: "a" }));
      await store.writeToolResultArtifact(request({ toolCallId: "b" }));
      await store.removeSession("s1");
      await expect(stat(join(root, "s1"))).rejects.toBeDefined();
    });

    it("never throws for a session that was never written", async () => {
      const store = new NodeArtifactStore(root);
      await expect(store.removeSession("never-existed")).resolves.toBeUndefined();
    });

    it("never throws for an unsafe session id", async () => {
      const store = new NodeArtifactStore(root);
      await expect(store.removeSession("../escape")).resolves.toBeUndefined();
    });
  });

  describe("sweepExpired", () => {
    it("removes session directories older than the age ceiling, leaves live ones", async () => {
      const store = new NodeArtifactStore(root);
      await store.writeToolResultArtifact(request({ sessionId: "fresh", toolCallId: "c1" }));
      await store.writeToolResultArtifact(request({ sessionId: "stale", toolCallId: "c2" }));

      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      // utimes takes seconds (and optional nanos). mtime is what the sweep keys on.
      await utimes(join(root, "stale"), eightDaysAgo / 1000, eightDaysAgo / 1000);

      const { removed } = await store.sweepExpired(7 * 24 * 60 * 60 * 1000, now);

      expect(removed).toEqual(["stale"]);
      await expect(stat(join(root, "fresh"))).resolves.toBeDefined();
      await expect(stat(join(root, "stale"))).rejects.toBeDefined();
    });

    it("returns {removed: []} for a root that does not exist yet", async () => {
      const store = new NodeArtifactStore(join(root, "nope"));
      await expect(store.sweepExpired(1_000)).resolves.toEqual({ removed: [] });
    });

    it("ignores regular files sitting at the top level of the root", async () => {
      const store = new NodeArtifactStore(root);
      await store.writeToolResultArtifact(request({ sessionId: "live", toolCallId: "c1" }));
      await writeFile(join(root, "stray-file"), "junk");
      const { removed } = await store.sweepExpired(0);
      // mtime is NOW, so even "live" is not older than 0; but stray-file is a
      // file, so it must never be removed regardless.
      expect(removed).not.toContain("stray-file");
    });
  });

  describe("containment of the artifact path", () => {
    it("writes outside a workspace fixture directory (the TASK.94 §1 decision)", async () => {
      const store = new NodeArtifactStore(root);
      const { path } = await store.writeToolResultArtifact(request());
      const workspaceFixture = join(tmpdir(), "anycode-artifact-workspace-fixture");
      await mkdir(workspaceFixture, { recursive: true });
      try {
        expect(path.startsWith(root)).toBe(true);
        expect(path.startsWith(workspaceFixture)).toBe(false);
      } finally {
        await rm(workspaceFixture, { recursive: true, force: true });
      }
    });
  });
});

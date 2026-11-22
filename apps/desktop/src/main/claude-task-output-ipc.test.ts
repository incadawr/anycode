import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({ shell: {}, ipcMain: {} }));
import { claudeTmpRoot, clearClaudeTaskOutputCache, findClaudeTaskOutputHint, openClaudeTaskOutput, readClaudeTaskOutput } from "./claude-task-output-ipc.js";

describe("Claude task output lookup", () => {
  it("suggests a unique conventional task file without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-hint-test-"));
    try {
      const folder = join(root, "project", "session-a", "tasks");
      await mkdir(folder, { recursive: true });
      const file = join(folder, "task-a.output");
      await writeFile(file, "fixture");
      expect(await findClaudeTaskOutputHint(root, "task-a", "session-a")).toBe(file);
      expect(await findClaudeTaskOutputHint(root, "task-a", "session-b")).toBeUndefined();
      await symlink(join(root, "project"), join(root, "linked-project"));
      expect(await findClaudeTaskOutputHint(root, "task-a", "session-a")).toBe(file);
      const other = join(root, "other", "session-a", "tasks");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "task-a.output"), "other");
      expect(await findClaudeTaskOutputHint(root, "task-a", "session-a")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  describe("direct read of a running task's output", () => {
    const setup = async () => {
      const base = await mkdtemp(join(tmpdir(), "task-read-test-"));
      const root = join(base, "claude-1");
      const folder = join(root, "project", "session-a", "tasks");
      await mkdir(folder, { recursive: true });
      return { base, root, folder, file: join(folder, "task-a.output") };
    };
    const req = { taskId: "task-a", sessionRef: "session-a" };
    it("finds the file by convention and returns only the tail of a large output", async () => {
      const { base, root, file } = await setup();
      try {
        await writeFile(file, "small");
        expect(await readClaudeTaskOutput(req, root)).toEqual({ ok: true, content: "small", truncated: false });
        await writeFile(file, `HEAD\n${"xxxxxxxxx\n".repeat(7000)}TAIL`);
        const big = await readClaudeTaskOutput(req, root);
        expect(big.ok && big.truncated).toBe(true);
        expect(big.ok && big.content.length).toBeLessThanOrEqual(65536);
        expect(big.ok && big.content.startsWith("xxxxxxxxx\n")).toBe(true);
        expect(big.ok && big.content.endsWith("TAIL")).toBe(true);
        expect(big.ok && big.content.startsWith("HEAD")).toBe(false);
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("accepts a matching path hint and refuses hints outside the Claude layout", async () => {
      const { base, root, folder, file } = await setup();
      try {
        await writeFile(file, "hinted");
        expect(await readClaudeTaskOutput({ ...req, outputFile: file }, root)).toMatchObject({ ok: true, content: "hinted" });
        const stray = join(base, "stray", "session-a", "tasks");
        await mkdir(stray, { recursive: true });
        await writeFile(join(stray, "task-a.output"), "secret");
        expect(await readClaudeTaskOutput({ ...req, outputFile: join(stray, "task-a.output") }, root)).not.toMatchObject({ content: "secret" });
        await writeFile(join(base, "passwd"), "secret");
        expect(await readClaudeTaskOutput({ ...req, outputFile: "/etc/passwd" }, root)).not.toMatchObject({ content: "secret" });
        expect(await readClaudeTaskOutput({ ...req, outputFile: join(folder, "..", "..", "..", "..", "passwd") }, root)).not.toMatchObject({ content: "secret" });
        expect(await readClaudeTaskOutput({ ...req, outputFile: "relative.output" }, root)).not.toMatchObject({ content: "secret" });
        expect(await readClaudeTaskOutput({ ...req, taskId: "../task-a" }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput({ ...req, extra: 1 }, root)).toEqual({ ok: false, reason: "unavailable" });
        await rm(file);
        await symlink(join(base, "passwd"), file);
        expect(await readClaudeTaskOutput({ ...req, outputFile: file }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput(req, root)).toEqual({ ok: false, reason: "unavailable" });
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("falls back to the conventional scan when the hint is wrong, as with the CLI's trailing sentence", async () => {
      const { base, root, file } = await setup();
      try {
        await writeFile(file, "found");
        const hint = `${file}. You will be notified when it completes`;
        expect(await readClaudeTaskOutput({ ...req, outputFile: hint }, root)).toMatchObject({ ok: true, content: "found" });
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("refuses directories, executables and other-owner roots, for read and open", async () => {
      const { base, root, folder, file } = await setup();
      try {
        await mkdir(file);
        const openPath = vi.fn(async () => "");
        expect(await readClaudeTaskOutput(req, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await openClaudeTaskOutput(req, root, { openPath })).toEqual({ ok: false });
        await rm(file, { recursive: true });
        await writeFile(file, "#!/bin/sh");
        await chmod(file, 0o755);
        expect(await readClaudeTaskOutput({ ...req, outputFile: file }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await openClaudeTaskOutput({ ...req, outputFile: file }, root, { openPath })).toEqual({ ok: false });
        await chmod(file, 0o644);
        await chmod(root, 0o777);
        expect(await readClaudeTaskOutput(req, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(openPath).not.toHaveBeenCalled();
        void folder;
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("strips terminal escapes, collapses carriage-return progress and caches the resolved path", async () => {
      const { base, root, file } = await setup();
      try {
        await writeFile(file, "\u001b[32mgreen\u001b[0m\n10%\r50%\r100%\nwin\r\nend");
        clearClaudeTaskOutputCache();
        const first = await readClaudeTaskOutput(req, root);
        expect(first).toEqual({ ok: true, content: "green\n100%\nwin\nend", truncated: false });
        expect(await readClaudeTaskOutput(req, root)).toEqual(first);
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("honours CLAUDE_CODE_TMPDIR for the task root", () => {
      const previous = process.env.CLAUDE_CODE_TMPDIR;
      try {
        process.env.CLAUDE_CODE_TMPDIR = "/var/tmp/custom/";
        expect(claudeTmpRoot()).toBe(`/var/tmp/custom/claude-${process.getuid?.()}`);
        delete process.env.CLAUDE_CODE_TMPDIR;
        expect(claudeTmpRoot()).toBe(`/tmp/claude-${process.getuid?.()}`);
      } finally { if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = previous; }
    });
    it("opens only a validated output file", async () => {
      const { base, root, file } = await setup();
      try {
        await writeFile(file, "x");
        const openPath = vi.fn(async () => "");
        expect(await openClaudeTaskOutput(req, root, { openPath })).toEqual({ ok: true });
        expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/task-a\.output$/));
        openPath.mockClear();
        await openClaudeTaskOutput({ ...req, outputFile: "/etc/hosts" }, root, { openPath });
        expect(openPath).not.toHaveBeenCalledWith("/etc/hosts");
        expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/task-a\.output$/));
      } finally { await rm(base, { recursive: true, force: true }); }
    });
  });
});

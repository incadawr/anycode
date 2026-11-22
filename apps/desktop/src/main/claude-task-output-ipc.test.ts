import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({ dialog: {}, shell: {}, ipcMain: {} }));
import { findClaudeTaskOutputHint, openClaudeTaskOutput, pickClaudeTaskOutput, readClaudeTaskOutput } from "./claude-task-output-ipc.js";

describe("explicit Claude task output selection", () => {
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
  it("reads only the selected matching task in its own session and refuses other paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-output-test-"));
    try {
      const folder = join(root, "session-a", "tasks");
      await mkdir(folder, { recursive: true });
      const file = join(folder, "task-a.output");
      await writeFile(file, "fixture output");
      const pick = (path: string) => ({ showOpenDialog: async () => ({ canceled: false, filePaths: [path] }) });
      expect(await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-a" }, pick(file))).toEqual({ ok: true, content: "fixture output" });
      await writeFile(file, "x".repeat(65537));
      const capped = await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-a" }, pick(file));
      expect(capped.ok && capped.content).toHaveLength(65536 + "\n[Output truncated]".length);
      await link(file, join(folder, "hardlink.output"));
      expect(await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-a" }, pick(file))).toEqual({ ok: false, reason: "unavailable" });
      expect(await pickClaudeTaskOutput({ taskId: "task-b", sessionRef: "session-a" }, pick(file))).toEqual({ ok: false, reason: "unavailable" });
      expect(await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-b" }, pick(file))).toEqual({ ok: false, reason: "unavailable" });
      expect(await pickClaudeTaskOutput({ taskId: "../task-a", sessionRef: "session-a" }, pick(file))).toEqual({ ok: false, reason: "unavailable" });
      const other = join(root, "other", "tasks");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "task-a.output"), "private fixture");
      const linkFolder = join(root, "session-b", "tasks");
      await mkdir(linkFolder, { recursive: true });
      const symlinkPath = join(linkFolder, "task-a.output");
      await symlink(join(other, "task-a.output"), symlinkPath);
      expect(await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-b" }, pick(symlinkPath))).toEqual({ ok: false, reason: "unavailable" });
      expect(await pickClaudeTaskOutput({ taskId: "task-a", sessionRef: "session-a" }, { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) })).toEqual({ ok: false, reason: "cancelled" });
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
        await writeFile(file, `HEAD${"x".repeat(70000)}TAIL`);
        const big = await readClaudeTaskOutput(req, root);
        expect(big.ok && big.truncated).toBe(true);
        expect(big.ok && big.content.length).toBe(65536);
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
        expect(await readClaudeTaskOutput({ ...req, outputFile: join(stray, "task-a.output") }, root)).toEqual({ ok: false, reason: "unavailable" });
        await writeFile(join(base, "passwd"), "secret");
        expect(await readClaudeTaskOutput({ ...req, outputFile: "/etc/passwd" }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput({ ...req, outputFile: join(folder, "..", "..", "..", "..", "passwd") }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput({ ...req, outputFile: "relative.output" }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput({ ...req, taskId: "../task-a" }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput({ ...req, extra: 1 }, root)).toEqual({ ok: false, reason: "unavailable" });
        await rm(file);
        await symlink(join(base, "passwd"), file);
        expect(await readClaudeTaskOutput({ ...req, outputFile: file }, root)).toEqual({ ok: false, reason: "unavailable" });
        expect(await readClaudeTaskOutput(req, root)).toEqual({ ok: false, reason: "unavailable" });
      } finally { await rm(base, { recursive: true, force: true }); }
    });
    it("opens only a validated output file", async () => {
      const { base, root, file } = await setup();
      try {
        await writeFile(file, "x");
        const openPath = vi.fn(async () => "");
        expect(await openClaudeTaskOutput(req, root, { openPath })).toEqual({ ok: true });
        expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/task-a\.output$/));
        openPath.mockClear();
        expect(await openClaudeTaskOutput({ ...req, outputFile: "/etc/hosts" }, root, { openPath })).toEqual({ ok: false });
        expect(openPath).not.toHaveBeenCalled();
      } finally { await rm(base, { recursive: true, force: true }); }
    });
  });
});

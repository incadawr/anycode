import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({ dialog: {}, ipcMain: {} }));
import { findClaudeTaskOutputHint, pickClaudeTaskOutput } from "./claude-task-output-ipc.js";

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
});

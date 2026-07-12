/**
 * Snapshot observer unit tests (design §5): readSnapshot cap/new-file behavior,
 * path extraction, the "before" emit, and — critically — that a failing fs is
 * fully swallowed so the observer never denies a dispatch.
 */

import { describe, expect, it } from "vitest";
import type { HostToUiMessage } from "../shared/protocol.js";
import { MemFs, ThrowingFs } from "./test-harness.js";
import {
  SNAPSHOT_MAX_BYTES,
  createSnapshotHook,
  extractSnapshotPath,
  isSnapshotTool,
  readSnapshot,
} from "./snapshot-hook.js";

describe("isSnapshotTool", () => {
  it("matches only Write and Edit exactly", () => {
    expect(isSnapshotTool("Write")).toBe(true);
    expect(isSnapshotTool("Edit")).toBe(true);
    expect(isSnapshotTool("Read")).toBe(false);
    expect(isSnapshotTool("Bash")).toBe(false);
    expect(isSnapshotTool("WriteFile")).toBe(false);
  });
});

describe("extractSnapshotPath", () => {
  it("reads file_path from an object input", () => {
    expect(extractSnapshotPath({ file_path: "/w/a.txt", content: "x" })).toBe("/w/a.txt");
  });

  it("returns null when file_path is missing, empty, or the input is not an object", () => {
    expect(extractSnapshotPath({})).toBeNull();
    expect(extractSnapshotPath({ file_path: "" })).toBeNull();
    expect(extractSnapshotPath("nope")).toBeNull();
    expect(extractSnapshotPath(null)).toBeNull();
  });
});

describe("readSnapshot", () => {
  it("returns empty content for a not-yet-existing file", async () => {
    const fs = new MemFs();
    await expect(readSnapshot(fs, "/w/new.txt")).resolves.toEqual({ content: "", truncated: false });
  });

  it("returns full content for a normal file", async () => {
    const fs = new MemFs();
    fs.files.set("/w/a.txt", "hello world");
    await expect(readSnapshot(fs, "/w/a.txt")).resolves.toEqual({
      content: "hello world",
      truncated: false,
    });
  });

  it("returns content:null,truncated:true above the size cap", async () => {
    const fs = new MemFs();
    fs.files.set("/w/big.txt", "a".repeat(SNAPSHOT_MAX_BYTES + 1));
    await expect(readSnapshot(fs, "/w/big.txt")).resolves.toEqual({
      content: null,
      truncated: true,
    });
  });
});

describe("createSnapshotHook", () => {
  it("emits a before snapshot and returns undefined", async () => {
    const fs = new MemFs();
    fs.files.set("/w/a.txt", "OLD");
    const emitted: HostToUiMessage[] = [];
    const registration = createSnapshotHook(fs, (m) => emitted.push(m));

    const result = await registration.hook(
      { toolCallId: "call-1", toolName: "Write", input: { file_path: "/w/a.txt", content: "NEW" } },
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
    expect(emitted).toEqual([
      {
        type: "file_snapshot",
        toolCallId: "call-1",
        path: "/w/a.txt",
        phase: "before",
        content: "OLD",
        truncated: false,
      },
    ]);
  });

  it("swallows a failing fs: returns undefined and emits nothing (never denies dispatch)", async () => {
    const emitted: HostToUiMessage[] = [];
    const registration = createSnapshotHook(new ThrowingFs(), (m) => emitted.push(m));

    const result = await registration.hook(
      { toolCallId: "call-2", toolName: "Write", input: { file_path: "/w/a.txt", content: "NEW" } },
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });
});

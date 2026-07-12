/**
 * cli/rewind.ts tests (design slice-4.7-cut.md §2.6/§7 B3 unit plan):
 * renderCheckpointsTable's column rendering, parseRewindCommand's argument
 * forms, and resolveCheckpointRef's index/id/prefix/ambiguous/not-found
 * resolution.
 */

import { describe, expect, it } from "vitest";
import type { CheckpointMeta } from "../ports/checkpoints.js";
import { parseRewindCommand, renderCheckpointsTable, resolveCheckpointRef } from "./rewind.js";

function makeMeta(overrides: Partial<CheckpointMeta> = {}): CheckpointMeta {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    sessionId: "session-1",
    commitHash: "1111111111111111111111111111111111aaaa",
    createdAt: 0,
    reason: "auto",
    label: "fix the bug",
    ...overrides,
  };
}

describe("renderCheckpointsTable", () => {
  const now = 1_700_000_000_000;
  /** Splits a rendered row on 2+ space runs (the column separator this table's padEnd+join("  ") always produces at a boundary). */
  const cells = (line: string): string[] => line.trim().split(/\s{2,}/);

  it("renders a header + one row per meta, newest-first order preserved, 1-based # column", () => {
    const metas: CheckpointMeta[] = [
      makeMeta({
        id: "aaaaaaaa-1111",
        commitHash: "aaaa1111",
        createdAt: now - 30_000,
        reason: "auto",
        label: "add tests",
      }),
      makeMeta({
        id: "bbbbbbbb-2222",
        commitHash: "bbbb2222",
        createdAt: now - 3_600_000,
        reason: "pre-rewind",
        label: "before rewind",
      }),
    ];
    const text = renderCheckpointsTable(metas, { now });
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(cells(lines[0]!)).toEqual(["#", "id", "age", "reason", "label"]);
    expect(cells(lines[1]!)).toEqual(["1", "aaaaaaaa", "just now", "auto", "add tests"]);
    expect(cells(lines[2]!)).toEqual(["2", "bbbbbbbb", "1h ago", "pre-rewind", "before rewind"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("shortens ids to 8 characters (reuses shortSessionId's behaviour, not a copy of it)", () => {
    const metas = [makeMeta({ id: "0123456789abcdef" })];
    const text = renderCheckpointsTable(metas, { now });
    expect(text).toContain("01234567");
    expect(text).not.toContain("0123456789abcdef");
  });

  it("pads columns to a consistent offset across header and every row (fixed-width alignment)", () => {
    const metas = [makeMeta({ reason: "auto" }), makeMeta({ reason: "pre-rewind" })];
    const text = renderCheckpointsTable(metas, { now });
    const lines = text.trimEnd().split("\n");
    const reasonColStart = lines[0]!.indexOf("reason");
    expect(lines[1]!.indexOf("auto")).toBe(reasonColStart);
    expect(lines[2]!.indexOf("pre-rewind")).toBe(reasonColStart);
  });
});

describe("parseRewindCommand", () => {
  it("empty (or whitespace-only) input -> list", () => {
    expect(parseRewindCommand("")).toEqual({ kind: "list" });
    expect(parseRewindCommand("   ")).toEqual({ kind: "list" });
  });

  it("a bare numeric index -> restore with the default scope \"both\"", () => {
    expect(parseRewindCommand("2")).toEqual({ kind: "restore", ref: "2", scope: "both" });
    expect(parseRewindCommand("  10  ")).toEqual({ kind: "restore", ref: "10", scope: "both" });
  });

  it("a 6+ char id/prefix -> restore with the default scope \"both\"", () => {
    expect(parseRewindCommand("abcdef")).toEqual({ kind: "restore", ref: "abcdef", scope: "both" });
    expect(parseRewindCommand("aaaaaaaa-1111-2222")).toEqual({
      kind: "restore",
      ref: "aaaaaaaa-1111-2222",
      scope: "both",
    });
  });

  it("ref + \"files\" or \"conversation\" -> restore with that explicit scope", () => {
    expect(parseRewindCommand("2 files")).toEqual({ kind: "restore", ref: "2", scope: "files" });
    expect(parseRewindCommand("abcdef conversation")).toEqual({
      kind: "restore",
      ref: "abcdef",
      scope: "conversation",
    });
  });

  it("tolerates extra surrounding/inner whitespace", () => {
    expect(parseRewindCommand("  2   files  ")).toEqual({ kind: "restore", ref: "2", scope: "files" });
  });

  it("a ref shorter than 6 chars and non-numeric -> invalid", () => {
    expect(parseRewindCommand("abc")).toEqual({ kind: "invalid" });
    expect(parseRewindCommand("a1")).toEqual({ kind: "invalid" });
  });

  it("an unrecognised second token -> invalid", () => {
    expect(parseRewindCommand("2 bogus")).toEqual({ kind: "invalid" });
    expect(parseRewindCommand("abcdef both")).toEqual({ kind: "invalid" });
  });

  it("more than 2 tokens -> invalid", () => {
    expect(parseRewindCommand("2 files extra")).toEqual({ kind: "invalid" });
  });

  it("a negative-looking or otherwise malformed ref -> invalid", () => {
    expect(parseRewindCommand("-1")).toEqual({ kind: "invalid" });
  });
});

describe("resolveCheckpointRef", () => {
  const metas: CheckpointMeta[] = [
    makeMeta({ id: "aaaaaaaa-1111", commitHash: "aaaacommit1111", label: "first" }),
    makeMeta({ id: "bbbbbbbb-2222", commitHash: "bbbbcommit2222", label: "second" }),
    makeMeta({ id: "cccccccc-3333", commitHash: "ccccdiffer3333", label: "third" }),
  ];

  it("resolves a 1-based numeric index", () => {
    expect(resolveCheckpointRef(metas, "1")).toBe(metas[0]);
    expect(resolveCheckpointRef(metas, "3")).toBe(metas[2]);
  });

  it("returns null for an out-of-range numeric index", () => {
    expect(resolveCheckpointRef(metas, "0")).toBeNull();
    expect(resolveCheckpointRef(metas, "4")).toBeNull();
    expect(resolveCheckpointRef(metas, "999")).toBeNull();
  });

  it("resolves an exact id match", () => {
    expect(resolveCheckpointRef(metas, "bbbbbbbb-2222")).toBe(metas[1]);
  });

  it("resolves a unique id prefix (>=6 chars)", () => {
    expect(resolveCheckpointRef(metas, "aaaaaa")).toBe(metas[0]);
  });

  it("resolves a unique commitHash prefix (>=6 chars)", () => {
    expect(resolveCheckpointRef(metas, "bbbbco")).toBe(metas[1]);
  });

  it("returns null for an ambiguous prefix matching more than one meta", () => {
    const ambiguous = [
      makeMeta({ id: "dup-id-0001", commitHash: "commit-a" }),
      makeMeta({ id: "dup-id-0002", commitHash: "commit-b" }),
    ];
    expect(resolveCheckpointRef(ambiguous, "dup-id")).toBeNull();
  });

  it("returns null for a prefix matching nothing", () => {
    expect(resolveCheckpointRef(metas, "zzzzzz")).toBeNull();
  });

  it("returns null for a ref shorter than 6 chars that doesn't exactly match any id", () => {
    expect(resolveCheckpointRef(metas, "zz")).toBeNull();
  });
});

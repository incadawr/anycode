/**
 * Unit tests for the rollout import IPC handler logic (cut §8.8, TASK.52
 * lane D), exercised as the exported handle* functions off a REAL node fs in
 * scratch tmpdirs (no Electron ipcMain) plus an in-memory fake PersistencePort
 * — mirrors profile-ipc.test.ts's own convention for this codebase.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryItem, PersistencePort, SessionMeta } from "@anycode/core";
import {
  handleCodexRolloutImport,
  handleCodexRolloutList,
  handleCodexRolloutPreview,
  type CodexRolloutIpcDeps,
} from "./codex-rollout-ipc.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tmp(prefix = "rollout-ipc-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function jsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

async function seedRollout(sessionsDir: string, relPath: string, records: Record<string, unknown>[]): Promise<void> {
  const full = join(sessionsDir, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, jsonl(records), "utf-8");
}

const BASIC_RECORDS = [
  { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp/project-a", cli_version: "0.144.5" } },
  { timestamp: "2026-07-01T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] } },
  { timestamp: "2026-07-01T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi!" }] } },
];

/** In-memory fake of the two PersistencePort methods this module needs. */
class FakePersistence {
  sessions = new Map<string, SessionMeta>();
  history = new Map<string, HistoryItem[]>();

  createSession: PersistencePort["createSession"] = async (meta) => {
    const full: SessionMeta = { ...meta, createdAt: 0, updatedAt: 0 };
    this.sessions.set(full.id, full);
    return full;
  };
  appendHistory: PersistencePort["appendHistory"] = async (sessionId, items) => {
    this.history.set(sessionId, [...(this.history.get(sessionId) ?? []), ...items]);
  };
}

function makeDeps(persistence: FakePersistence, sessionsDirByProfile: Record<string, string>): CodexRolloutIpcDeps {
  return {
    persistence,
    resolveProfileSessionsDir: async (profileId) => sessionsDirByProfile[profileId] ?? null,
  };
}

describe("handleCodexRolloutList", () => {
  it("lists rollouts under YYYY/MM/DD, newest first, with a cheap cwd/first-message peek", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl", BASIC_RECORDS);
    await seedRollout(sessionsDir, "2026/07/02/rollout-2026-07-02T00-00-00-bbb.jsonl", [
      { timestamp: "2026-07-02T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp/project-b" } },
      { timestamp: "2026-07-02T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second session" }] } },
    ]);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutList(deps, { profileId: "p1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rollouts).toHaveLength(2);
    expect(result.rollouts[0]?.fileName).toBe("2026/07/02/rollout-2026-07-02T00-00-00-bbb.jsonl");
    expect(result.rollouts[0]?.cwd).toBe("/tmp/project-b");
    expect(result.rollouts[0]?.firstUserMessage).toBe("second session");
    expect(result.rollouts[1]?.fileName).toBe("2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl");
    expect(result.rollouts[1]?.cwd).toBe("/tmp/project-a");
  });

  it("ignores files outside the YYYY/MM/DD/rollout-*.jsonl shape (no crash, just skipped)", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-ok.jsonl", BASIC_RECORDS);
    await mkdir(join(sessionsDir, "not-a-year"), { recursive: true });
    await writeFile(join(sessionsDir, "session_index.jsonl"), "{}\n", "utf-8");
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutList(deps, { profileId: "p1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rollouts).toHaveLength(1);
    expect(result.rollouts[0]?.fileName).toBe("2026/07/01/rollout-ok.jsonl");
  });

  it("refuses an unknown profileId as profile_not_found, without touching the filesystem", async () => {
    const deps = makeDeps(new FakePersistence(), {});
    const result = await handleCodexRolloutList(deps, { profileId: "ghost" });
    expect(result).toEqual({ ok: false, reason: "profile_not_found" });
  });
});

describe("handleCodexRolloutPreview", () => {
  it("returns the full RolloutImportReport without persisting anything", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl", BASIC_RECORDS);
    const persistence = new FakePersistence();
    const deps = makeDeps(persistence, { p1: sessionsDir });

    const result = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.items.map((i) => i.message.role)).toEqual(["user", "assistant"]);
    expect(result.report.meta.cwd).toBe("/tmp/project-a");
    expect(persistence.sessions.size).toBe(0);
    expect(persistence.history.size).toBe(0);
  });

  it("rejects a path-traversal fileName as invalid_file_name, never touching the filesystem", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-real.jsonl", BASIC_RECORDS);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: "../../../etc/passwd" });
    expect(result).toEqual({ ok: false, reason: "invalid_file_name" });
  });

  it("rejects a fileName that doesn't resolve to a real file as not_readable", async () => {
    const sessionsDir = await tmp();
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });
    const result = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: "2026/07/01/rollout-missing.jsonl" });
    expect(result).toEqual({ ok: false, reason: "not_readable" });
  });
});

describe("handleCodexRolloutImport", () => {
  it("creates a NEW core session (no externalSessionRef) and persists the converted history", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl", BASIC_RECORDS);
    const persistence = new FakePersistence();
    const deps = makeDeps(persistence, { p1: sessionsDir });

    const result = await handleCodexRolloutImport(deps, {
      profileId: "p1",
      fileName: "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl",
      model: "claude-sonnet-5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toBe("/tmp/project-a");
    const session = persistence.sessions.get(result.sessionId);
    expect(session).toBeDefined();
    expect(session?.engineId).toBe("core");
    expect(session?.externalSessionRef).toBeUndefined();
    expect(session?.model).toBe("claude-sonnet-5");
    expect(session?.mode).toBe("build");
    const history = persistence.history.get(result.sessionId);
    expect(history?.map((i) => i.message.role)).toEqual(["user", "assistant"]);
  });

  it("never writes back to the source rollout file (direction is codex -> us only)", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-2026-07-01T00-00-00-aaa.jsonl";
    await seedRollout(sessionsDir, relPath, BASIC_RECORDS);
    const before = jsonl(BASIC_RECORDS);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "claude-sonnet-5" });

    const { readFile } = await import("node:fs/promises");
    const after = await readFile(join(sessionsDir, relPath), "utf-8");
    expect(after).toBe(before);
  });
});

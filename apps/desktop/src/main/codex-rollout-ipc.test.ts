/**
 * Unit tests for the rollout import IPC handler logic (cut §8.8, TASK.52
 * lane D), exercised as the exported handle* functions off a REAL node fs in
 * scratch tmpdirs (no Electron ipcMain) plus an in-memory fake PersistencePort
 * — mirrors profile-ipc.test.ts's own convention for this codebase.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryItem, PersistencePort, SessionMeta } from "@anycode/core";

// Only registerCodexRolloutIpc touches ipcMain; the handle* functions under
// test never do. A minimal stub lets the registration-level consume-once test
// (S4-1 arm 2) run without an Electron runtime.
const mockHandlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
      mockHandlers.set(channel, listener);
    },
  },
}));

import {
  CODEX_ROLLOUT_IMPORT_CHANNEL,
  handleCodexRolloutImport,
  handleCodexRolloutList,
  handleCodexRolloutPreview,
  registerCodexRolloutIpc,
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

  it("rejects an empty model as invalid_model, distinct from an unknown profile (F2 review lane FXH: an empty model must not be mistaken for profile_not_found)", async () => {
    const sessionsDir = await tmp();
    await seedRollout(sessionsDir, "2026/07/01/rollout-2026-07-01T00-00-00-bbb.jsonl", BASIC_RECORDS);
    const persistence = new FakePersistence();
    const deps = makeDeps(persistence, { p1: sessionsDir });

    const result = await handleCodexRolloutImport(deps, {
      profileId: "p1",
      fileName: "2026/07/01/rollout-2026-07-01T00-00-00-bbb.jsonl",
      model: "",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_model" });
    expect(persistence.sessions.size).toBe(0);
  });

  it("still rejects an unknown profileId as profile_not_found even with a valid model", async () => {
    const persistence = new FakePersistence();
    const deps = makeDeps(persistence, {});

    const result = await handleCodexRolloutImport(deps, { profileId: "", fileName: "2026/07/01/rollout-x.jsonl", model: "claude-sonnet-5" });

    expect(result).toEqual({ ok: false, reason: "profile_not_found" });
  });

  it("rejects a symlink standing in for a valid-shaped rollout path as not_readable (R4: TOCTOU/symlink escape)", async () => {
    const sessionsDir = await tmp();
    const outsideDir = await tmp("rollout-outside-");
    const outsidePath = join(outsideDir, "secret.jsonl");
    await writeFile(outsidePath, jsonl(BASIC_RECORDS), "utf-8");
    const relPath = "2026/07/01/rollout-symlink.jsonl";
    const fullPath = join(sessionsDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await symlink(outsidePath, fullPath);
    const persistence = new FakePersistence();
    const deps = makeDeps(persistence, { p1: sessionsDir });

    const previewResult = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: relPath });
    expect(previewResult).toEqual({ ok: false, reason: "not_readable" });

    const importResult = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "claude-sonnet-5" });
    expect(importResult).toEqual({ ok: false, reason: "not_readable" });
    expect(persistence.sessions.size).toBe(0);
  });
});

describe("handleCodexRolloutList — symlink exclusion (R4)", () => {
  it("never lists a symlinked entry, even when its name matches the rollout shape", async () => {
    const sessionsDir = await tmp();
    const outsideDir = await tmp("rollout-outside-");
    const outsidePath = join(outsideDir, "secret.jsonl");
    await writeFile(outsidePath, jsonl(BASIC_RECORDS), "utf-8");
    await seedRollout(sessionsDir, "2026/07/01/rollout-real.jsonl", BASIC_RECORDS);
    const symlinkPath = join(sessionsDir, "2026/07/01/rollout-symlink.jsonl");
    await symlink(outsidePath, symlinkPath);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutList(deps, { profileId: "p1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rollouts.map((r) => r.fileName)).toEqual(["2026/07/01/rollout-real.jsonl"]);
  });
});

describe("handleCodexRolloutImport — write direction", () => {
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

describe("handleCodexRolloutPreview/Import — intermediate symlink escape (BH2)", () => {
  it("rejects a rollout whose fileName resolves through a symlinked intermediate directory (e.g. the YYYY dir), even though the final file is an ordinary one", async () => {
    const sessionsDir = await tmp();
    const outsideDir = await tmp("rollout-outside-");
    // A perfectly ordinary file at the far end of the escape — O_NOFOLLOW on
    // the final path component alone would let this straight through.
    await mkdir(join(outsideDir, "07", "01"), { recursive: true });
    await writeFile(join(outsideDir, "07", "01", "rollout-escaped.jsonl"), jsonl(BASIC_RECORDS), "utf-8");
    // sessionsDir/2026 is a symlink pointing OUTSIDE sessionsDir.
    await symlink(outsideDir, join(sessionsDir, "2026"));
    const relPath = "2026/07/01/rollout-escaped.jsonl";
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const previewResult = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: relPath });
    expect(previewResult).toEqual({ ok: false, reason: "not_readable" });

    const importResult = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "claude-sonnet-5" });
    expect(importResult).toEqual({ ok: false, reason: "not_readable" });
  });
});

describe("handleCodexRolloutPreview — FIFO refusal without hanging the process (BM1)", () => {
  it.skipIf(process.platform === "win32")("returns not_readable for a FIFO standing in for a rollout file, within the test's own timeout", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-fifo.jsonl";
    const fifoPath = join(sessionsDir, relPath);
    await mkdir(join(fifoPath, ".."), { recursive: true });
    execFileSync("mkfifo", [fifoPath]);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutPreview(deps, { profileId: "p1", fileName: relPath });
    expect(result).toEqual({ ok: false, reason: "not_readable" });
  });
});

describe("handleCodexRolloutImport — S4-1 connection pin + pending model (W4-F1)", () => {
  it("pins the NEW session to the connection active at apply time and registers the picked model", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-s4a.jsonl";
    await seedRollout(sessionsDir, relPath, BASIC_RECORDS);
    const persistence = new FakePersistence();
    const recorded: Array<[string, string]> = [];
    const deps: CodexRolloutIpcDeps = {
      persistence,
      resolveProfileSessionsDir: async (p) => (p === "p1" ? sessionsDir : null),
      activeConnectionId: () => "conn-active",
      recordPendingImportModel: (sessionId, model) => recorded.push([sessionId, model]),
    };

    const result = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "gpt-oss-20b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = persistence.sessions.get(result.sessionId);
    expect(session?.connectionId).toBe("conn-active");
    expect(recorded).toEqual([[result.sessionId, "gpt-oss-20b"]]);
  });

  it("leaves the session unpinned when there is no active connection (byte-as-today)", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-s4b.jsonl";
    await seedRollout(sessionsDir, relPath, BASIC_RECORDS);
    const persistence = new FakePersistence();
    const deps: CodexRolloutIpcDeps = {
      persistence,
      resolveProfileSessionsDir: async (p) => (p === "p1" ? sessionsDir : null),
      activeConnectionId: () => undefined,
    };

    const result = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "gpt-oss-20b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = persistence.sessions.get(result.sessionId);
    expect(session).toBeDefined();
    expect("connectionId" in (session ?? {})).toBe(false);
  });
});

describe("registerCodexRolloutIpc — consume-once pending import model (S4-1 arm 2, W4-F1)", () => {
  it("import registers the pick; the returned consumer reads-and-deletes it exactly once", async () => {
    mockHandlers.clear();
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-reg.jsonl";
    await seedRollout(sessionsDir, relPath, BASIC_RECORDS);
    const handle = registerCodexRolloutIpc({
      persistence: new FakePersistence(),
      resolveProfileSessionsDir: async (p) => (p === "p1" ? sessionsDir : null),
      activeConnectionId: () => "conn-active",
    });
    const importHandler = mockHandlers.get(CODEX_ROLLOUT_IMPORT_CHANNEL);
    expect(importHandler).toBeDefined();
    const result = (await importHandler!(null, { profileId: "p1", fileName: relPath, model: "gpt-oss-20b" })) as {
      ok: boolean;
      sessionId?: string;
    };
    expect(result.ok).toBe(true);
    const sessionId = result.sessionId!;
    // consume-once: first read yields the pick, second yields nothing.
    expect(handle.consumePendingImportModel(sessionId)).toBe("gpt-oss-20b");
    expect(handle.consumePendingImportModel(sessionId)).toBeUndefined();
    // A session that was never imported has no pending entry.
    expect(handle.consumePendingImportModel("never-imported")).toBeUndefined();
  });

  it("peek reads WITHOUT deleting; consume deletes; peek after consume ⇒ undefined (L4·1 peek-then-confirm)", async () => {
    mockHandlers.clear();
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-peek.jsonl";
    await seedRollout(sessionsDir, relPath, BASIC_RECORDS);
    const handle = registerCodexRolloutIpc({
      persistence: new FakePersistence(),
      resolveProfileSessionsDir: async (p) => (p === "p1" ? sessionsDir : null),
      activeConnectionId: () => "conn-active",
    });
    const importHandler = mockHandlers.get(CODEX_ROLLOUT_IMPORT_CHANNEL);
    expect(importHandler).toBeDefined();
    const result = (await importHandler!(null, { profileId: "p1", fileName: relPath, model: "gpt-oss-20b" })) as {
      ok: boolean;
      sessionId?: string;
    };
    expect(result.ok).toBe(true);
    const sessionId = result.sessionId!;
    // peek surfaces the pick WITHOUT spending it — idempotent across repeats.
    expect(handle.peekPendingImportModel(sessionId)).toBe("gpt-oss-20b");
    expect(handle.peekPendingImportModel(sessionId)).toBe("gpt-oss-20b");
    // consume burns it once...
    expect(handle.consumePendingImportModel(sessionId)).toBe("gpt-oss-20b");
    // ...after which both peek and consume see nothing.
    expect(handle.peekPendingImportModel(sessionId)).toBeUndefined();
    expect(handle.consumePendingImportModel(sessionId)).toBeUndefined();
    // A session that was never imported has no pending entry to peek.
    expect(handle.peekPendingImportModel("never-imported")).toBeUndefined();
  });
});

describe("handleCodexRolloutImport — R2-M3 untrusted meta.cwd workspace validation (W4-F1)", () => {
  const userMessage = {
    timestamp: "2026-07-01T00:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  };

  it("falls back to the user's home for a rollout with NO cwd (never the relative '.')", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-nocwd.jsonl";
    await seedRollout(sessionsDir, relPath, [
      { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { cli_version: "0.144.5" } },
      userMessage,
    ]);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "m" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toBe(homedir());
    expect(result.workspace).not.toBe(".");
  });

  it("falls back to the user's home for a RELATIVE cwd string from the file", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-relcwd.jsonl";
    await seedRollout(sessionsDir, relPath, [
      { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "relative/evil" } },
      userMessage,
    ]);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "m" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toBe(homedir());
  });

  it("passes an ABSOLUTE cwd through verbatim", async () => {
    const sessionsDir = await tmp();
    const relPath = "2026/07/01/rollout-abscwd.jsonl";
    await seedRollout(sessionsDir, relPath, [
      { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp/real-project" } },
      userMessage,
    ]);
    const deps = makeDeps(new FakePersistence(), { p1: sessionsDir });

    const result = await handleCodexRolloutImport(deps, { profileId: "p1", fileName: relPath, model: "m" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toBe("/tmp/real-project");
  });
});

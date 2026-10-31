/**
 * "Continue this Codex thread on another account" (usage-limit banner).
 *
 * Two layers, both unit-level:
 *  - `copyCodexRolloutForThread` against real temp directories — the copy is
 *    the part that touches the filesystem, so it is exercised with real files
 *    (source rollout, target home, an existing target, credentials that must
 *    never be read);
 *  - `handleCodexContinueOnAccount` with injected deps — the orchestration:
 *    refusal reasons, and the new session row (the target account is what its
 *    tab's argv will be built from).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "@anycode/core";
import type { CodexAccountOption } from "../shared/codex-account.js";
import {
  copyCodexRolloutForThread,
  handleCodexContinueOnAccount,
  type CodexContinueDeps,
} from "./codex-continue.js";

const THREAD_ID = "0199a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b";
const ROLLOUT_RELATIVE = join("2026", "10", "30", `rollout-2026-10-30T10-00-00-${THREAD_ID}.jsonl`);
const ROLLOUT_TEXT = '{"type":"session_meta","payload":{"id":"' + THREAD_ID + '"}}\n';

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anycode-codex-continue-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedRollout(sessionsDir: string, text = ROLLOUT_TEXT): Promise<string> {
  const path = join(sessionsDir, ROLLOUT_RELATIVE);
  await mkdir(join(sessionsDir, "2026", "10", "30"), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("copyCodexRolloutForThread", () => {
  it("copies the thread's rollout to the SAME relative path under the target home", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    const sourcePath = await seedRollout(source);

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ ok: true, relativePath: ROLLOUT_RELATIVE, copied: true });
    const targetPath = join(target, ROLLOUT_RELATIVE);
    expect(await readFile(targetPath, "utf8")).toBe(ROLLOUT_TEXT);
    // The source is untouched (the exhausted tab keeps working).
    expect(await readFile(sourcePath, "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("refuses when the thread has no rollout under the current account", async () => {
    await mkdir(join(root, "account-a", "sessions", "2026", "10", "30"), { recursive: true });
    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: join(root, "account-a", "sessions"),
      targetSessionsDir: join(root, "account-b", "sessions"),
      threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });

  it("never overwrites an existing rollout in the target home and reports it as already in place", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    await seedRollout(source);
    const existing = join(target, ROLLOUT_RELATIVE);
    await mkdir(join(target, "2026", "10", "30"), { recursive: true });
    await writeFile(existing, "OLDER-COPY");

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ ok: true, relativePath: ROLLOUT_RELATIVE, copied: false });
    expect(await readFile(existing, "utf8")).toBe("OLDER-COPY");
  });

  it("copies the rollout only — a credential next to it is never copied (or read)", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    await seedRollout(source);
    await writeFile(join(root, "account-a", "auth.json"), '{"token":"secret"}');
    await mkdir(join(root, "account-b"), { recursive: true });
    await writeFile(join(root, "account-b", "auth.json"), '{"token":"other"}');

    await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(await readFile(join(root, "account-b", "auth.json"), "utf8")).toBe('{"token":"other"}');
  });

  it("refuses a thread id that is not a plain token (it is only ever used for matching, never as a path)", async () => {
    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: join(root, "a"),
      targetSessionsDir: join(root, "b"),
      threadId: "../../etc/passwd",
    });
    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });
});

describe("handleCodexContinueOnAccount", () => {
  interface Harness {
    deps: CodexContinueDeps;
    created: Array<Omit<SessionMeta, "createdAt" | "updatedAt">>;
    deleted: string[];
    opened: string[];
    sourceSessionsDir: string;
    accountBSessionsDir: string;
    systemSessionsDir: string;
  }

  const META = {
    id: "session-1",
    workspace: "/ws",
    projectRoot: "/ws/project",
    model: "gpt-5.6-sol",
    mode: "build" as const,
    title: "Investigate the parser",
    engineId: "codex",
    externalSessionRef: THREAD_ID,
  };

  async function harness(overrides: Partial<CodexContinueDeps> = {}): Promise<Harness> {
    const sourceSessionsDir = join(root, "account-a", "sessions");
    const accountBSessionsDir = join(root, "account-b", "sessions");
    const systemSessionsDir = join(root, "ambient", "sessions");
    await seedRollout(sourceSessionsDir);
    const created: Harness["created"] = [];
    const deleted: string[] = [];
    const opened: string[] = [];
    const accounts: CodexAccountOption[] = [
      { id: "system", label: "System" },
      { id: "account-a", label: "Account A" },
      { id: "account-b", label: "Account B" },
    ];
    const deps: CodexContinueDeps = {
      tab: () => ({ sessionId: "session-1", engine: "codex", codexProfile: { id: "account-a" } }),
      session: async () => ({ ...META }),
      accounts: async () => accounts,
      sessionsDir: async (accountId) => {
        if (accountId === "account-a") return sourceSessionsDir;
        if (accountId === "account-b") return accountBSessionsDir;
        if (accountId === "system") return systemSessionsDir;
        return null;
      },
      createSession: async (meta) => {
        created.push(meta);
        return { ...meta, createdAt: 1, updatedAt: 1 };
      },
      deleteSession: async (sessionId) => {
        deleted.push(sessionId);
      },
      openResumeTab: async (sessionId) => {
        opened.push(sessionId);
        return { ok: true as const, tabId: "tab-new" };
      },
      randomUUID: () => "new-session-id",
      ...overrides,
    };
    return { deps, created, deleted, opened, sourceSessionsDir, accountBSessionsDir, systemSessionsDir };
  }

  it("copies the rollout, creates a row resuming the same thread on the target account, and opens its tab", async () => {
    const h = await harness();

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toEqual({ ok: true, sessionId: "new-session-id", tabId: "tab-new" });
    // The row is what the new tab's argv will be built from: same thread id,
    // target account, and the original model/mode (a resume reads those from
    // the row, not from the draft).
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      id: "new-session-id",
      workspace: "/ws",
      projectRoot: "/ws/project",
      model: "gpt-5.6-sol",
      mode: "build",
      title: "Investigate the parser",
      engineId: "codex",
      externalSessionRef: THREAD_ID,
      codexProfileId: "account-b",
    });
    expect(h.opened).toEqual(["new-session-id"]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("target `system` omits codexProfileId (the ambient home, not a profile)", async () => {
    const h = await harness();
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "system" });

    expect(result.ok).toBe(true);
    expect(h.created[0]).not.toHaveProperty("codexProfileId");
    expect(await readFile(join(h.systemSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("refuses the account the tab already runs on, without copying anything", async () => {
    const h = await harness();
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-a" });

    expect(result).toMatchObject({ ok: false, reason: "same_account" });
    expect(h.created).toHaveLength(0);
    expect(h.opened).toEqual([]);
  });

  it("refuses an unknown account id, naming the accounts it knows", async () => {
    const h = await harness();
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "nope" });

    expect(result).toMatchObject({ ok: false, reason: "invalid_account" });
    if (!result.ok) expect(result.detail).toContain("Account B (account-b)");
    expect(h.created).toHaveLength(0);
  });

  it("refuses a non-Codex tab, an unknown tab, and a child session", async () => {
    const h = await harness();
    const nonCodex = await handleCodexContinueOnAccount(
      { ...h.deps, tab: () => ({ sessionId: "session-1", engine: "claude" }) },
      { tabId: "tab-1", accountId: "account-b" },
    );
    expect(nonCodex).toMatchObject({ ok: false, reason: "not_codex" });

    const unknown = await handleCodexContinueOnAccount({ ...h.deps, tab: () => undefined }, { tabId: "gone", accountId: "account-b" });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_tab" });

    const child = await handleCodexContinueOnAccount(
      { ...h.deps, tab: () => ({ sessionId: "child-1", engine: "codex", childOf: "parent-1" }) },
      { tabId: "child-tab", accountId: "account-b" },
    );
    expect(child).toMatchObject({ ok: false, reason: "not_resumable" });
    expect(h.created).toHaveLength(0);
  });

  it("refuses when the session has no Codex thread yet (nothing to resume elsewhere)", async () => {
    const h = await harness({
      session: async () => {
        const { externalSessionRef: _notYetStarted, ...started } = META;
        return started;
      },
    });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });
    expect(result).toMatchObject({ ok: false, reason: "no_thread" });
  });

  it("rolls the new row back when its tab cannot be opened", async () => {
    const h = await harness({
      openResumeTab: async () => ({ ok: false as const, reason: "not_ready" }),
    });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "tab_failed" });
    expect(h.deleted).toEqual(["new-session-id"]);
  });

  it("reports a missing rollout instead of opening a tab on a conversation it could not carry", async () => {
    const h = await harness();
    await rm(h.sourceSessionsDir, { recursive: true, force: true });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
    expect(h.opened).toEqual([]);
    expect(h.created).toHaveLength(0);
  });
});

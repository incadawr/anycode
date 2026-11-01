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
import { mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, type ContinuationClaim, type SessionMeta } from "@anycode/core";
import type { CodexAccountOption } from "../shared/codex-account.js";
import {
  CONTINUATION_CLAIM_TTL_MS,
  copyCodexRolloutForThread,
  handleCodexContinueOnAccount,
  registerCodexContinueIpc,
  snapshotChanged,
  type CodexContinueDeps,
  type CodexContinueIpc,
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

    expect(result).toEqual({ ok: true, relativePath: ROLLOUT_RELATIVE });
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

  it("refuses an existing rollout without overwriting it", async () => {
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

    expect(result).toMatchObject({ ok: false, reason: "target_exists", detail: expect.stringContaining("may be outdated or in use") });
    expect(await readFile(existing, "utf8")).toBe("OLDER-COPY");
  });

  it("also refuses an apparently identical existing rollout", async () => {
    const source=join(root,"a","sessions"), target=join(root,"b","sessions");
    await seedRollout(source); await seedRollout(target);
    const result=await copyCodexRolloutForThread({sourceSessionsDir:source,targetSessionsDir:target,threadId:THREAD_ID});
    expect(result).toMatchObject({ok:false,reason:"target_exists"});
    expect(await readFile(join(target,ROLLOUT_RELATIVE),"utf8")).toBe(ROLLOUT_TEXT);
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

  it("matches the thread id as a WHOLE segment — a rollout whose id merely contains it is not this conversation", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await mkdir(join(source, "2026", "10", "30"), { recursive: true });
    // Same shape, and the wanted id appears as a substring of the actual id:
    // `includes()` copied THIS file, i.e. the wrong conversation.
    await writeFile(
      join(source, "2026", "10", "30", `rollout-2026-10-30T10-00-00-x${THREAD_ID}.jsonl`),
      ROLLOUT_TEXT,
    );

    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });

  it("treats everything after the timestamp as the id, so a PREFIXED id is not a match", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await mkdir(join(source, "2026", "10", "30"), { recursive: true });
    // The id in this name is `prefix-<uuid>`, not `<uuid>`: reading only the
    // trailing uuid would invent a match and copy the wrong conversation.
    await writeFile(
      join(source, "2026", "10", "30", `rollout-2026-10-30T10-00-00-prefix-${THREAD_ID}.jsonl`),
      ROLLOUT_TEXT,
    );

    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });

  it("matches that same file when the requested id IS the whole remainder", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await mkdir(join(source, "2026", "10", "30"), { recursive: true });
    await writeFile(
      join(source, "2026", "10", "30", `rollout-2026-10-30T10-00-00-prefix-${THREAD_ID}.jsonl`),
      ROLLOUT_TEXT,
    );

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: `prefix-${THREAD_ID}`,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("refuses to choose between two rollouts that both claim the thread", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await seedRollout(source);
    // A second copy in another directory is what makes "the first match wins"
    // unsafe: it silently picks one of two different histories.
    await mkdir(join(source, "archived"), { recursive: true });
    await writeFile(join(source, "archived", `rollout-2026-10-29T09-00-00-${THREAD_ID}.jsonl`), "OTHER-HISTORY");

    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(result).toMatchObject({ ok: false, reason: "rollout_ambiguous" });
    expect(result.ok ? "" : result.detail).toContain("2 rollouts");
    expect(await readFile(join(target, ROLLOUT_RELATIVE), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("refuses an unlistable source home instead of reporting the rollout missing", async () => {
    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: join(root, "does-not-exist", "sessions"),
      targetSessionsDir: join(root, "b", "sessions"),
      threadId: THREAD_ID,
    });

    expect(result).toMatchObject({ ok: false, reason: "source_unreadable" });
    expect(result.ok ? "" : result.detail).toContain("NOT assumed to be empty");
  });

  it("treats a source that changed while being copied as a failed snapshot, in all three directions", () => {
    const base = { size: 100, mtimeMs: 1_000 };
    expect(snapshotChanged(base, { size: 100, mtimeMs: 1_000 })).toBe(false);
    expect(snapshotChanged(base, { size: 140, mtimeMs: 1_000 })).toBe(true);
    expect(snapshotChanged(base, { size: 100, mtimeMs: 1_500 })).toBe(true);
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
  /**
   * Cross-process claim state, shared by every harness in one test: that is the
   * whole point of the claim — two "processes" must collide on it.
   */
  let claims: Map<string, { expiresAt: number; token: string }>;
  let released: string[];
  let clock: number;
  let tokens = 0;
  const claimKey = (threadId: string, accountId: string): string => `${threadId}\u0000${accountId}`;
  const claim = async (threadId: string, accountId: string, ttlMs: number): Promise<ContinuationClaim> => {
    const key = claimKey(threadId, accountId);
    const held = claims.get(key);
    if (held !== undefined && held.expiresAt > clock) return { status: "held", token: null };
    const token = `token-${++tokens}`;
    claims.set(key, { expiresAt: clock + ttlMs, token });
    return { status: held === undefined ? "claimed" : "taken_over", token };
  };
  const holds = async (threadId: string, accountId: string, token: string): Promise<boolean> => {
    const held = claims.get(claimKey(threadId, accountId));
    return held !== undefined && held.token === token && held.expiresAt > clock;
  };

  beforeEach(() => {
    claims = new Map();
    released = [];
    clock = Date.now();
  });

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
      enabled: () => true,
      claimContinuation: (threadId, accountId, ttlMs) => claim(threadId, accountId, ttlMs),
      holdsContinuation: (threadId, accountId, token) => holds(threadId, accountId, token),
      releaseContinuation: async (threadId, accountId, token) => {
        released.push(`${threadId}\u0000${accountId}\u0000${token}`);
        // Only the OWNER may delete: a superseded holder must not free the pair.
        if (claims.get(claimKey(threadId, accountId))?.token === token) claims.delete(claimKey(threadId, accountId));
      },
      createSessionFromSource: async (_sourceId, meta) => {
        created.push(meta);
        return { ok: true as const, session: { ...meta, createdAt: 1, updatedAt: 1 } };
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

  it("refuses a thread already open on the target account, so a second click cannot fork a second host on one rollout", async () => {
    const isThreadOpen = vi.fn(async () => true);
    const h = await harness({ isThreadOpen });

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "already_open" });
    expect(isThreadOpen).toHaveBeenCalledWith(THREAD_ID, "account-b");
    expect(h.created).toHaveLength(0);
    expect(h.opened).toEqual([]);
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

  it("retains a published rollout if the source disappeared before registration", async () => {
    const createSessionFromSource = vi.fn(async () => ({ ok: false as const, reason: "source_missing" as const }));
    const h = await harness({createSessionFromSource});
    const result = await handleCodexContinueOnAccount(h.deps, { tabId:"tab-1", accountId:"account-b" });
    expect(result).toMatchObject({ok:false, reason:"unknown_session", detail:expect.stringContaining("A retry on that account will be blocked")});
    expect(result.ok ? "" : result.detail).toContain("A copy was left on the target account");
    expect(createSessionFromSource).toHaveBeenCalledWith("session-1", expect.objectContaining({externalSessionRef:THREAD_ID}));
    expect(h.opened).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("explains the retained copy after registration throws and refuses a retry", async () => {
    const createSessionFromSource = vi.fn(async () => {throw new Error("synthetic-private-detail");});
    const h=await harness({createSessionFromSource});
    const first=await handleCodexContinueOnAccount(h.deps,{tabId:"tab-1",accountId:"account-b"});
    expect(first).toMatchObject({ok:false,reason:"copy_failed",detail:expect.stringContaining("A copy was left on the target account")});
    expect(first.ok ? "" : first.detail).toContain("A retry on that account will be blocked");
    expect(JSON.stringify(first)).not.toContain("synthetic-private-detail");
    expect(await handleCodexContinueOnAccount(h.deps,{tabId:"tab-1",accountId:"account-b"})).toMatchObject({ok:false,reason:"target_exists"});
    expect(createSessionFromSource).toHaveBeenCalledOnce();
    expect(h.opened).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir,ROLLOUT_RELATIVE),"utf8")).toBe(ROLLOUT_TEXT);
  });

  it("refuses an existing rollout before source registration", async () => {
    const h = await harness({createSessionFromSource:async () => ({ ok: false as const, reason: "source_missing" as const })});
    await seedRollout(h.accountBSessionsDir, "existing-fixture");
    const result = await handleCodexContinueOnAccount(h.deps, {tabId:"tab-1",accountId:"account-b"});
    expect(result).toMatchObject({ok:false,reason:"target_exists"});
    expect(h.opened).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe("existing-fixture");
  });

  it("refuses a target still being written without reading, replacing or opening it", async () => {
    const h=await harness();
    const target=join(h.accountBSessionsDir,ROLLOUT_RELATIVE);
    await mkdir(join(h.accountBSessionsDir,"2026","10","30"),{recursive:true});
    const writer=await open(target,"wx");
    try {
      await writer.write("partial");
      const result=await handleCodexContinueOnAccount(h.deps,{tabId:"tab-1",accountId:"account-b"});
      expect(result).toMatchObject({ok:false,reason:"target_exists"});
      expect(h.created).toEqual([]); expect(h.opened).toEqual([]);
      expect(await readFile(target,"utf8")).toBe("partial");
      await writer.write("-completed");
      expect(await readFile(target,"utf8")).toBe("partial-completed");
    } finally {await writer.close();}
  });

  it("refuses retry after a failed registration if the source rollout has advanced", async () => {
    let attempts = 0;
    const h = await harness({createSessionFromSource:async (_source,meta) => {
      attempts++;
      return attempts === 1
        ? { ok: false as const, reason: "source_missing" as const }
        : { ok: true as const, session: {...meta,createdAt:1,updatedAt:1} };
    }});
    expect(await handleCodexContinueOnAccount(h.deps,{tabId:"tab-1",accountId:"account-b"})).toMatchObject({ok:false,reason:"unknown_session"});
    await seedRollout(h.sourceSessionsDir, "newer-rollout-v2");
    const retry = await handleCodexContinueOnAccount(h.deps,{tabId:"tab-1",accountId:"account-b"});
    expect(retry).toMatchObject({ok:false,reason:"target_exists",detail:expect.stringContaining("may be outdated or in use")});
    expect(attempts).toBe(1);
    expect(h.opened).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir,ROLLOUT_RELATIVE),"utf8")).toBe(ROLLOUT_TEXT);
    expect(await readFile(join(h.sourceSessionsDir,ROLLOUT_RELATIVE),"utf8")).toBe("newer-rollout-v2");
  });

  it("keeps the session when opening throws after a host may have started", async () => {
    let hostStarted = false;
    const h = await harness({openResumeTab:async () => {hostStarted = true; throw new Error("fixture"); }});
    const result = await handleCodexContinueOnAccount(h.deps, {tabId:"tab-1",accountId:"account-b"});
    expect(result).toMatchObject({ok:false,reason:"tab_failed",detail:expect.stringContaining("Could not confirm")});
    expect(hostStarted).toBe(true);
    expect(h.deleted).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("preserves shared SQLite history when source is deleted after a host starts and opening throws", async () => {
    const store = new SqlitePersistenceAdapter(join(root,"synthetic.sqlite"));
    await store.createSession({...META, workspace:"/ws"});
    await store.recordCodexThreadItem(THREAD_ID, {itemId:"synthetic-item",turnOrdinal:0,positionInTurn:0,seqInTurn:0,command:"fixture"});
    let hostStarted = false;
    const h = await harness({
      session: id => store.getRootSession(id),
      createSessionFromSource: (id,meta) => store.createSessionFromSource(id,meta),
      deleteSession: id => store.deleteSession(id),
      openResumeTab: async () => {hostStarted=true; await store.deleteSession("session-1"); throw new Error("post-fork failure");},
    });
    try {
      const result = await handleCodexContinueOnAccount(h.deps, {tabId:"tab-1",accountId:"account-b"});
      expect(result).toMatchObject({ok:false,reason:"tab_failed",detail:expect.stringContaining("Could not confirm")});
      expect(hostStarted).toBe(true);
      expect(await store.getRootSession("session-1")).toBeNull();
      expect(await store.getRootSession("new-session-id")).not.toBeNull();
      expect(await store.listCodexThreadItems(THREAD_ID)).toHaveLength(1);
      expect(await readFile(join(h.accountBSessionsDir,ROLLOUT_RELATIVE),"utf8")).toBe(ROLLOUT_TEXT);
    } finally {await store.close();}
  });

  it("retains the session when the tab reports it is already open", async () => {
    const h = await harness({openResumeTab:async()=>({ok:false as const,reason:"already_open"})});
    const result = await handleCodexContinueOnAccount(h.deps, {tabId:"tab-1",accountId:"account-b"});
    expect(result).toMatchObject({ok:false,reason:"tab_failed",detail:expect.stringContaining("was not deleted")});
    expect(h.deleted).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("refuses a concurrent consumer and retains the first published rollout when registration fails", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {entered=resolve;});
    const proceed = new Promise<void>(resolve => {release=resolve;});
    const first = await harness({createSessionFromSource:async () => {entered(); await proceed; return { ok: false as const, reason: "source_missing" as const }; }});
    const second = await harness({
      sessionsDir: first.deps.sessionsDir,
      randomUUID:()=>"second-id",
    });
    const waiting=handleCodexContinueOnAccount(first.deps, {tabId:"tab-1",accountId:"account-b"});
    await started;
    const secondResult=await handleCodexContinueOnAccount(second.deps, {tabId:"tab-1",accountId:"account-b"});
    // Refused by the CLAIM, not by the filesystem: the copy has not even been
    // attempted yet, so two processes never race on the shared target home.
    expect(secondResult).toMatchObject({ok:false,reason:"already_open"});
    expect(second.created).toEqual([]);
    expect(second.opened).toEqual([]);
    release();
    expect(await waiting).toMatchObject({ok:false,reason:"unknown_session"});
    expect(await readFile(join(first.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("retains the new row when the tab cannot be opened", async () => {
    const h = await harness({
      openResumeTab: async () => ({ ok: false as const, reason: "not_ready" }),
    });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "tab_failed" });
    expect(h.deleted).toEqual([]);
  });

  it("reports a missing rollout instead of opening a tab on a conversation it could not carry", async () => {
    const h = await harness();
    await rm(join(h.sourceSessionsDir, ROLLOUT_RELATIVE), { force: true });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
    expect(h.opened).toEqual([]);
    expect(h.created).toHaveLength(0);
  });

  it("does NOT call an unreadable source home 'missing': the two are different answers", async () => {
    const h = await harness();
    // The whole home is gone: enumeration fails, which must never be reported as
    // "no rollout" — a user told "missing" stops looking for their history.
    await rm(h.sourceSessionsDir, { recursive: true, force: true });
    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "source_unreadable" });
    expect(h.opened).toEqual([]);
    expect(h.created).toHaveLength(0);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("refuses when the kill switch is off, before any account lookup or file operation", async () => {
    const h = await harness({ enabled: () => false });
    const sessionsDir = vi.fn(h.deps.sessionsDir);

    const result = await handleCodexContinueOnAccount({ ...h.deps, sessionsDir }, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "temporarily_unavailable" });
    expect(result.ok ? "" : result.detail).toContain("temporarily unavailable");
    expect(sessionsDir).not.toHaveBeenCalled();
    expect(h.created).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("refuses while another process holds a live claim and never copies into the shared home", async () => {
    claims.set(claimKey(THREAD_ID, "account-b"), { expiresAt: clock + CONTINUATION_CLAIM_TTL_MS, token: "other" });
    const h = await harness();

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "already_open" });
    expect(result.ok ? "" : result.detail).toContain("another window");
    expect(h.created).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(await readFile(join(h.accountBSessionsDir, ROLLOUT_RELATIVE), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("takes over an EXPIRED claim but says the earlier transfer may be incomplete", async () => {
    claims.set(claimKey(THREAD_ID, "account-b"), { expiresAt: clock - 1, token: "stale" });
    const h = await harness({ createSessionFromSource: async () => ({ ok: false as const, reason: "source_missing" as const }) });

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    // The refusal is the registration one, but it now carries the takeover fact.
    expect(result).toMatchObject({ ok: false, reason: "unknown_session" });
    expect(result.ok ? "" : result.detail).toContain("did not report success");
  });

  it("releases the claim on success, so a finished continue cannot block the next one for a whole TTL", async () => {
    const h = await harness();

    expect(await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" })).toMatchObject({ ok: true });

    // BOTH ends are released, by token (source claim, then target claim).
    expect(released).toHaveLength(2);
    expect(claims.has(claimKey(THREAD_ID, "account-b"))).toBe(false);
    expect(claims.has(claimKey(THREAD_ID, "account-a"))).toBe(false);
  });

  it("releases the claim on every refusal, so one failure cannot wedge the action", async () => {
    const h = await harness({ createSessionFromSource: async () => ({ ok: false as const, reason: "source_missing" as const }) });

    await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(released).toHaveLength(2);
    expect(claims.size).toBe(0);
  });

  it("copies through a temp file and leaves no temp behind (a half-written rollout must never sit at the target name)", async () => {
    const h = await harness();
    await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    const leftovers = await readdir(join(h.accountBSessionsDir, "tmp")).catch(() => ["no tmp dir"]);
    expect(leftovers).toEqual([]);
  });

  it("refuses when another window is already continuing FROM this account", async () => {
    // The source end is claimed too: a second process reading the same rollout
    // while it grows is the same race as a second writer into the target.
    const h = await harness({
      // Simulate a second process holding the SOURCE end of this thread.
      claimContinuation: async (threadId, accountId) =>
        accountId === "account-a" ? { status: "held", token: null } : { status: "claimed", token: "t1" },
    });

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: false, reason: "already_open" });
    expect(result.ok ? "" : result.detail).toContain("from this account");
    expect(h.created).toEqual([]);
  });

  it("carries the takeover warning on SUCCESS instead of dropping it", async () => {
    const h = await harness({
      // Another attempt's claim expired: we take it over, and that must be said.
      claimContinuation: async (_threadId, accountId) =>
        accountId === "account-b"
          ? { status: "taken_over", token: "t2" }
          : { status: "claimed", token: "t1" },
      holdsContinuation: async () => true,
    });

    const result = await handleCodexContinueOnAccount(h.deps, { tabId: "tab-1", accountId: "account-b" });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok ? result.warning : "").toContain("did not report success");
  });
});

describe("registerCodexContinueIpc", () => {
  /** Captures the registered listener so the seam can be driven without Electron. */
  function ipcSeam(): { handle: CodexContinueIpc["handle"] & ReturnType<typeof vi.fn>; invoke: (raw: unknown) => Promise<unknown> } {
    let listener: ((event: unknown, raw: unknown) => Promise<unknown>) | undefined;
    const handle = vi.fn(
      (_channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>): unknown => {
        listener = fn;
        return undefined;
      },
    ) as CodexContinueIpc["handle"] & ReturnType<typeof vi.fn>;
    return {
      handle,
      invoke: async (raw: unknown) => {
        if (listener === undefined) throw new Error("no listener registered");
        return listener({}, raw);
      },
    };
  }

  const deps = (): CodexContinueDeps => ({
    tab: () => undefined,
    session: async () => null,
    accounts: async () => [],
    sessionsDir: async () => null,
    enabled: () => true,
    claimContinuation: async () => ({ status: "claimed" as const, token: "t" }),
    holdsContinuation: async () => true,
    releaseContinuation: async () => {},
    createSessionFromSource: async () => ({ ok: false as const, reason: "source_missing" as const }),
    deleteSession: async () => {},
    openResumeTab: async () => ({ ok: true as const, tabId: "tab" }),
    randomUUID: () => "id",
  });

  it("registers the channel once and validates the payload before any dependency is touched", async () => {
    const seam = ipcSeam();
    const resolveDeps = vi.fn(deps);
    registerCodexContinueIpc(seam, resolveDeps);

    expect(seam.handle).toHaveBeenCalledTimes(1);

    for (const malformed of [null, "text", 42, {}, { tabId: "tab-1" }, { tabId: "", accountId: "account-b" }, { tabId: "tab-1", accountId: 7 }]) {
      expect(await seam.invoke(malformed)).toMatchObject({ ok: false, reason: "unknown_tab" });
    }
    // A malformed frame must never resolve persistence or reach the filesystem.
    expect(resolveDeps).not.toHaveBeenCalled();
  });

  it("answers unknown_session when storage is not open yet, exactly as the inline handler did", async () => {
    const seam = ipcSeam();
    registerCodexContinueIpc(seam, () => null);

    expect(await seam.invoke({ tabId: "tab-1", accountId: "account-b" })).toMatchObject({
      ok: false,
      reason: "unknown_session",
      detail: "storage is not ready yet",
    });
  });

  it("delegates a well-formed frame and is resolved per request, so a restored setting needs no restart", async () => {
    const seam = ipcSeam();
    let resolve = deps();
    registerCodexContinueIpc(seam, () => resolve);
    resolve = { ...resolve, enabled: () => false };

    expect(await seam.invoke({ tabId: "tab-1", accountId: "account-b" })).toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
  });
});

describe("copyCodexRolloutForThread — fail-closed details", () => {
  it("refuses when the target already holds the thread under a DIFFERENT date path", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await seedRollout(source);
    // A previous continue at another moment, or a native import. Checking only
    // the source-relative pathname would create a SECOND rollout for one thread.
    await mkdir(join(target, "2025", "01", "01"), { recursive: true });
    await writeFile(join(target, "2025", "01", "01", `rollout-2025-01-01T00-00-00-${THREAD_ID}.jsonl`), "OLD-COPY");

    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(result).toMatchObject({ ok: false, reason: "target_exists" });
    // ...and the old copy is untouched.
    expect(await readFile(join(target, "2025", "01", "01", `rollout-2025-01-01T00-00-00-${THREAD_ID}.jsonl`), "utf8")).toBe("OLD-COPY");
  });

  it("does not treat a non-uuid thread id as a loose suffix", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await seedRollout(source);
    await mkdir(join(source, "extra"), { recursive: true });
    await writeFile(join(source, "extra", "rollout-2026-10-29T09-00-00-other-abc.jsonl"), "OTHER");

    // `abc` is a suffix of `other-abc`; a suffix test would match the wrong file.
    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: "abc" });

    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });

  it("refuses to publish when the claim was lost while the copy was in flight", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await seedRollout(source);

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: THREAD_ID,
      beforePublish: async () => false,
    });

    expect(result).toMatchObject({ ok: false, reason: "claim_lost" });
    // Nothing may be reachable under the final name after a lost claim.
    expect(await readFile(join(target, ROLLOUT_RELATIVE), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("never echoes a filesystem path in a copy failure", async () => {
    const source = join(root, "a", "sessions");
    const target = join(root, "b", "sessions");
    await seedRollout(source);
    // Make the target home impossible to write into by planting a FILE where a
    // directory must be created; Node's message would name both paths.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(join(target), "not a directory");

    const result = await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(result.ok).toBe(false);
    const detail = result.ok ? "" : result.detail;
    expect(detail).not.toContain(root);
    expect(detail).not.toContain("/Users/");
  });
});

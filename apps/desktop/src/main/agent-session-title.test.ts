import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { createAgentTitlePushes, recoverAgentSessionTitle } from "./agent-session-title.js";

/** Lets the retainer's fire-and-forget push settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));


/**
 * Makes every `sessions.title` UPDATE fail at the SQLite level — a real write
 * failure (the shape a full disk or a corrupt file produces), not a stubbed
 * adapter. Dropped again so the retry can land.
 */
function blockTitleWrites(path: string, blocked: boolean): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      blocked
        ? "CREATE TRIGGER title_write_fails BEFORE UPDATE OF title ON sessions BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END"
        : "DROP TRIGGER IF EXISTS title_write_fails",
    );
  } finally {
    db.close();
  }
}

describe("agent title pushes", () => {
  it("retains a title whose push lost its host and retries it on the next host generation", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host disconnected; delivery unknown"))
      .mockResolvedValueOnce({});
    const warn = vi.fn();
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn });

    pushes.retain("s1");
    await settle();
    expect(request).toHaveBeenCalledWith("s1", "worker-1");
    // A rejected push is NOT an acknowledgement: the handle stays retained.
    expect(pushes.pendingSessions()).toEqual(["s1"]);

    // The replacement host generation delivers its port -> retry.
    pushes.retry("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    // Only the host's committed write clears it.
    expect(pushes.pendingSessions()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries a retained title on its own when no new host generation arrives", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host response timed out; delivery unknown"))
      .mockResolvedValueOnce({});
    const scheduled: (() => void)[] = [];
    let delayMs: number | undefined;
    const pushes = createAgentTitlePushes({
      titleOf: () => "worker-1",
      request,
      warn: vi.fn(),
      retryDelayMs: () => 5_000,
      schedule: (run, delay) => { delayMs = delay; scheduled.push(run); return () => {}; },
    });

    pushes.retain("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(delayMs).toBe(5_000);
    expect(scheduled).toHaveLength(1);

    // The same tab process lives on: only the timer can retry the title.
    scheduled[0]!();
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(pushes.pendingSessions()).toEqual([]);
  });

  it("cancels a scheduled retry once the session is gone", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Host disconnected; delivery unknown"));
    const cancel = vi.fn();
    const pushes = createAgentTitlePushes({
      titleOf: () => "worker-1",
      request,
      warn: vi.fn(),
      retryDelayMs: () => 5_000,
      schedule: () => cancel,
    });

    pushes.retain("s1");
    await settle();
    expect(pushes.pendingSessions()).toEqual(["s1"]);
    pushes.forget("s1");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops the self-scheduled attempts after the cap, but keeps the title retained for the next host generation", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Session host unavailable"));
    const scheduled: (() => void)[] = [];
    const pushes = createAgentTitlePushes({
      titleOf: () => "worker-1",
      request,
      warn: vi.fn(),
      retryDelayMs: () => 5_000,
      schedule: (run) => { scheduled.push(run); return () => {}; },
      maxRetryAttempts: 2,
    });

    pushes.retain("s1");
    await settle();
    scheduled.shift()!();
    await settle();
    scheduled.shift()!();
    await settle();
    expect(request).toHaveBeenCalledTimes(3);
    // Capped: no further timer, the title is still retained.
    expect(scheduled).toHaveLength(0);
    expect(pushes.pendingSessions()).toEqual(["s1"]);

    // A fresh host generation restarts the budget and pushes again.
    pushes.retry("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(4);
    expect(scheduled).toHaveLength(1);
  });

  // The retry queue is only honest if "acknowledged" means "a later boot reads
  // this title": driven here through the REAL session store, where the failed
  // UPDATE rejects and only a committed one clears the retained handle.
  it("keeps a title whose SQLite write failed, stores it on the retry, and only then acknowledges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-title-retry-"));
    const path = join(dir, "sessions.db");
    const persistence = new SqlitePersistenceAdapter(path);
    try {
      await persistence.createSession({ id: "s1", workspace: "/ws", model: "scripted-model", mode: "edit" });
      const pushes = createAgentTitlePushes({
        titleOf: () => "worker-1",
        request: (_sessionId, title) => persistence.touchSession("s1", { title }),
        warn: vi.fn(),
      });

      blockTitleWrites(path, true);
      pushes.retain("s1");
      await settle();
      // NOT acknowledged: the row still has no title, so the handle is retained.
      expect(pushes.pendingSessions()).toEqual(["s1"]);
      expect((await persistence.getSessionById("s1"))?.title).toBeUndefined();

      blockTitleWrites(path, false);
      pushes.retry("s1");
      await settle();
      expect(pushes.pendingSessions()).toEqual([]);
      expect((await persistence.getSessionById("s1"))?.title).toBe("worker-1");
    } finally {
      await persistence.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not push the same session twice while one attempt is in flight", async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn: vi.fn() });

    pushes.retain("s1");
    pushes.retry("s1");
    pushes.push("s1");
    expect(request).toHaveBeenCalledTimes(1);

    release({});
    await settle();
    expect(pushes.pendingSessions()).toEqual([]);
  });

  it("never resurrects the title of a session that is gone", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Host disconnected; delivery unknown"));
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn: vi.fn() });

    pushes.retain("s1");
    await settle();
    pushes.forget("s1");
    pushes.retry("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(pushes.pendingSessions()).toEqual([]);
  });
});

describe("resume-time agent title recovery", () => {
  // A payload-derived title is the envelope's first line CAPPED, so it is a
  // prefix of the header and not a whole envelope.
  const FALLBACK_TITLE = '[AnyCode authenticated agent message {"messageId":"m1","sender":"supervisor"'.slice(0, 80);
  const recover = (overrides: Partial<Parameters<typeof recoverAgentSessionTitle>[0]> = {}) => {
    const adopted: string[] = [];
    return {
      adopted,
      run: () => recoverAgentSessionTitle({
        sessionId: "s1",
        savedHandle: () => "worker-1",
        // Not an agent-opened tab: a saved handle alone proves nothing, since the
        // user can assign one to an ordinary shared session.
        openedByAgent: () => false,
        // No marker on record: the pre-fix shape (nothing recorded which title
        // the agent wrote, so none was ever confirmed).
        confirmedTitle: () => undefined,
        readPersistedTitle: async () => FALLBACK_TITLE,
        adopt: (title) => adopted.push(title),
        ...overrides,
      }),
    };
  };

  it("repairs a pre-fix session whose persisted title is the raw envelope header", async () => {
    const { adopted, run } = recover();
    expect(await run()).toBe(true);
    expect(adopted).toEqual(["worker-1"]);
  });

  // The lead constraint on the repair: a saved handle is NOT evidence that an
  // agent opened the tab (the Sessions API row lets the user give an ordinary
  // session a handle too), so a row written before the durable agent-opened
  // marker can only be repaired when its title is the raw envelope header —
  // the one title text that is never user-chosen.
  it("leaves a pre-fix session's plain-text title alone (a saved handle is not proof of an agent-opened tab)", async () => {
    const { adopted, run } = recover({ readPersistedTitle: async () => "Sidebar layout and focus" });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  it("leaves a title alone that the user chose on a session whose handle was assigned by hand", async () => {
    const { adopted, run } = recover({ readPersistedTitle: async () => "Company profile design" });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  // Rows written from this version on: `create_session` records a durable
  // agent-opened marker, which is enough to know the stored title (when it is
  // not the handle) was produced by the app's automatic titling.
  it("repairs a session created by this version whose automatic title is not the handle", async () => {
    const { adopted, run } = recover({
      openedByAgent: () => true,
      readPersistedTitle: async () => "Fix the sidebar",
    });
    expect(await run()).toBe(true);
    expect(adopted).toEqual(["worker-1"]);
  });

  it("repairs an agent-opened session whose stored title is still the envelope header", async () => {
    const { adopted, run } = recover({ openedByAgent: () => true });
    expect(await run()).toBe(true);
    expect(adopted).toEqual(["worker-1"]);
  });

  it("does not rewrite a title that already is the handle", async () => {
    const { adopted, run } = recover({ readPersistedTitle: async () => "worker-1" });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  // The durable marker: once a host confirmed the handle as the stored title,
  // a row that holds something else has had its title written by someone else
  // afterwards — that choice wins, and no database read is even needed.
  it("leaves a title alone that was written after the agent's confirmed one", async () => {
    const readPersistedTitle = vi.fn(async () => "Company profile design");
    const { adopted, run } = recover({
      confirmedTitle: () => "worker-1",
      readPersistedTitle,
    });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
    expect(readPersistedTitle).not.toHaveBeenCalled();
  });

  it("leaves a confirmed title alone that is no longer the handle", async () => {
    const { adopted, run } = recover({ confirmedTitle: () => "someone-elses-title" });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  it("does nothing for a session without a saved handle", async () => {
    const { adopted, run } = recover({ savedHandle: () => undefined });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  it("does nothing (and never blocks a resume) when the session row cannot be read", async () => {
    const { adopted, run } = recover({ readPersistedTitle: async () => { throw new Error("SQLITE_BUSY"); } });
    expect(await run()).toBe(false);
    expect(adopted).toEqual([]);
  });

  // Every acknowledged title leaves a durable marker, so a later resume never
  // has to guess what wrote the stored title.
  it("records the confirmed title once a host acknowledges the write", async () => {
    const confirmed = vi.fn();
    const pushes = createAgentTitlePushes({
      titleOf: () => "worker-1",
      request: vi.fn().mockResolvedValue({}),
      warn: vi.fn(),
      confirmed,
    });
    pushes.retain("s1");
    await settle();
    expect(confirmed).toHaveBeenCalledWith("s1", "worker-1");
    expect(pushes.pendingSessions()).toEqual([]);
  });

  it("never lets a failed marker write fail the acknowledgement", async () => {
    const warn = vi.fn();
    const pushes = createAgentTitlePushes({
      titleOf: () => "worker-1",
      request: vi.fn().mockResolvedValue({}),
      warn,
      confirmed: () => { throw new Error("EACCES"); },
    });
    pushes.retain("s1");
    await settle();
    // Warned, but the committed title is still acknowledged: no retry storm.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(pushes.pendingSessions()).toEqual([]);
  });
});

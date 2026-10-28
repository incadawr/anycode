/**
 * The production title-persistence seams of the core and codex boots.
 *
 * These are the functions `host/index.ts` hands to `Session`; testing them here
 * (rather than a test-supplied callback beside a harness) means the regression
 * tests cover the wiring main actually acknowledges against. Every case drives
 * the REAL `SqlitePersistenceAdapter`, and the failure is a REAL SQLite one (a
 * trigger aborting the UPDATE), not a stubbed rejection.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { resolveBootSession } from "./boot.js";
import {
  createCodexSessionTitlePersistence,
  createCoreSessionTitlePersistence,
  type SessionTitlePersistenceDeps,
} from "./session-title-persistence.js";

/** Makes every `sessions.title` UPDATE fail at the SQLite level, then clears it. */
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

/** A temp store with one row, its path, and the seam built over it. */
async function adapterRig(overrides: Partial<SessionTitlePersistenceDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anycode-title-seam-"));
  const path = join(dir, "sessions.db");
  let persistence: SqlitePersistenceAdapter | null = new SqlitePersistenceAdapter(path);
  await persistence.createSession({ id: "s1", workspace: "/ws", model: "scripted-model", mode: "edit" });
  const onError = vi.fn();
  const deps = (): SessionTitlePersistenceDeps => ({
    adapter: () => persistence,
    sessionId: "s1",
    onError,
    ...overrides,
  });
  return {
    path,
    onError,
    deps,
    core: () => createCoreSessionTitlePersistence(deps()),
    codex: () => createCodexSessionTitlePersistence(deps()),
    read: () => persistence!.getSessionById("s1"),
    close: async () => {
      await persistence?.close();
      persistence = null;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Rig = Awaited<ReturnType<typeof adapterRig>>;

const ENGINES = [
  { engine: "core", create: (rig: Rig) => rig.core() },
  { engine: "codex", create: (rig: Rig) => rig.codex() },
] as const;

describe.each(ENGINES)("$engine boot title persistence", ({ create }) => {
  it("does not acknowledge a title whose SQLite write failed", async () => {
    const rig = await adapterRig();
    try {
      blockTitleWrites(rig.path, true);

      await expect(create(rig).commitTitle!("worker-1")).rejects.toThrow(/disk I\/O error/);
      // Not stored, so the caller's acknowledgement must never have happened.
      expect((await rig.read())?.title).toBeUndefined();
    } finally {
      await rig.close();
    }
  });

  it("stores the title on the retry and a resume reads it back", async () => {
    const rig = await adapterRig();
    try {
      blockTitleWrites(rig.path, true);
      await expect(create(rig).commitTitle!("worker-1")).rejects.toThrow(/disk I\/O error/);
      expect((await rig.read())?.title).toBeUndefined();

      // The next host generation retries the retained handle.
      blockTitleWrites(rig.path, false);
      await create(rig).commitTitle!("worker-1");
      expect((await rig.read())?.title).toBe("worker-1");

      // A resume opens a fresh connection over the same file.
      const reopened = new SqlitePersistenceAdapter(rig.path);
      try {
        const boot = await resolveBootSession(reopened, {
          args: { sessionId: "s1", resume: true },
          workspace: "/ws",
          model: "scripted-model",
        });
        expect(boot.sessionMeta.title).toBe("worker-1");
      } finally {
        await reopened.close();
      }
    } finally {
      await rig.close();
    }
  });

  it("keeps the ordinary turn write fail-soft while the ack path stays strict", async () => {
    const rig = await adapterRig();
    try {
      blockTitleWrites(rig.path, true);
      const seam = create(rig);

      // A turn is never failed by its own write: reported, swallowed.
      await expect(seam.touch({ title: "first message" })).resolves.toBeUndefined();
      expect(rig.onError).toHaveBeenCalledTimes(1);
      // The acknowledgement is the opposite posture.
      await expect(seam.commitTitle!("worker-1")).rejects.toThrow(/disk I\/O error/);
      expect((await rig.read())?.title).toBeUndefined();
    } finally {
      await rig.close();
    }
  });

  it("rejects the acknowledgement and skips the turn write when no store is wired", async () => {
    const rig = await adapterRig({ adapter: () => null });
    try {
      const seam = create(rig);
      await expect(seam.commitTitle!("worker-1")).rejects.toThrow(/No persistence port/);
      // A turn write without a store is a no-op, not an error.
      expect(seam.touch({ title: "x" })).toBeUndefined();
      expect(rig.onError).not.toHaveBeenCalled();
    } finally {
      await rig.close();
    }
  });
});

describe("codex boot title persistence", () => {
  it("writes a preset id into the shared mode column and the title verbatim", async () => {
    const rig = await adapterRig();
    try {
      const seam = rig.codex();
      await seam.touch({ enginePreset: "workspace-write" });
      expect((await rig.read())?.mode).toBe("workspace-write");

      await seam.commitTitle!("worker-1");
      expect((await rig.read())?.title).toBe("worker-1");
    } finally {
      await rig.close();
    }
  });
});

/**
 * Unit tests for the tab-create control-plane logic (GUI-P1 §2F.4 / §6#6),
 * exercised as the exported `handleCreate` + `createTabRequestSchema` off FAKE
 * deps (no Electron ipcMain, no dialog, no host process — the no-Electron DI
 * idiom of settings-ipc.test.ts). Pins the additive optional `workspace`: schema
 * bounds, the dialog-skip vs legacy-dialog paths, the fail-closed no-op, and the
 * canSpawn -> atCapacity -> dialog/skip guard order.
 */

import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import type { CreateTabRequest } from "../shared/tabs.js";
import {
  createTabRequestSchema,
  handleCreate,
  handleWorkspacePick,
  toSummary,
  type DialogLike,
  type TabIpcDeps,
} from "./tab-ipc.js";
import type { SessionMeta } from "@anycode/core";
import type { TabHostManager } from "./tabs.js";

/** Fake TabHostManager honouring only the surface handleCreate's "new" branch touches. */
function makeManager(
  over: { canSpawn?: boolean; atCapacity?: boolean; createFails?: boolean } = {},
  order: string[] = [],
) {
  const canSpawn = vi.fn(() => {
    order.push("canSpawn");
    return over.canSpawn ?? true;
  });
  const atCapacity = vi.fn(() => {
    order.push("atCapacity");
    return over.atCapacity ?? false;
  });
  const createTab = vi.fn((params: { workspace: string; sessionId: string; resume: boolean }) => {
    order.push("createTab");
    if (over.createFails === true) {
      return { ok: false, reason: "max_tabs" };
    }
    // Echo the workspace back so callers can assert it flowed through verbatim.
    return { ok: true, tab: { tabId: "tab-1", workspace: params.workspace } };
  });
  const deliverTabPort = vi.fn(() => {
    order.push("deliverTabPort");
  });
  const sessionOpenInTab = vi.fn(() => undefined);
  const manager = {
    canSpawn,
    atCapacity,
    createTab,
    deliverTabPort,
    sessionOpenInTab,
  } as unknown as TabHostManager;
  return { manager, canSpawn, atCapacity, createTab, deliverTabPort };
}

/** Fake dialog.showOpenDialog with a configurable result. */
function makeDialog(result: { canceled: boolean; filePaths: string[] }, order: string[] = []) {
  const showOpenDialog = vi.fn(async () => {
    order.push("dialog");
    return result;
  });
  return { dialog: { showOpenDialog } as DialogLike, showOpenDialog };
}

/** Persistence stub — the "new" branch never touches it. */
const persistenceStub: TabIpcDeps["persistence"] = {
  getSession: async () => null,
  listSessions: async () => [],
  touchSession: async () => {},
};

/**
 * Mirrors the registered TAB_CREATE_CHANNEL handler (registerTabIpc): a request
 * main cannot parse is a fail-closed "cancelled" no-op; a valid one reaches
 * handleCreate. Modeled here because the real registration binds ipcMain.handle.
 */
async function runRegisteredCreate(deps: TabIpcDeps, raw: unknown) {
  const parsed = createTabRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "cancelled" } as const;
  }
  return handleCreate(deps, parsed.data);
}

describe("createTabRequestSchema — new-tab workspace matrix (§2F.4)", () => {
  it("accepts { kind: 'new' } (workspace absent — legacy dialog path)", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new" }).success).toBe(true);
  });

  it("accepts { kind: 'new', workspace: '/x' } (preselected path)", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x" }).success).toBe(true);
  });

  it("accepts only reviewed engine identities for a new tab", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engine: "codex" }).success).toBe(true);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engine: "unreviewed" }).success).toBe(false);
  });

  it("rejects an empty-string workspace (min(1))", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "" }).success).toBe(false);
  });

  it("rejects a non-string workspace (type)", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: 123 }).success).toBe(false);
  });

  it("rejects a workspace longer than 4096 chars (max)", () => {
    const tooLong = "/".repeat(4097);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: tooLong }).success).toBe(false);
    // The 4096 boundary itself is accepted.
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/".repeat(4096) }).success).toBe(true);
  });

  it("accepts optional engineModel/enginePreset draft picks (W3 join)", () => {
    expect(
      createTabRequestSchema.safeParse({
        kind: "new",
        workspace: "/x",
        engine: "codex",
        engineModel: "gpt-5.6-mini",
        enginePreset: "workspace",
      }).success,
    ).toBe(true);
    // Both stay optional — a Core (or bare) draft omits them entirely.
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x" }).success).toBe(true);
  });

  it("accepts an optional replacementConnectionId on a resume request (W10-FIX F1)", () => {
    expect(
      createTabRequestSchema.safeParse({ kind: "resume", sessionId: "s", replacementConnectionId: "conn-x" }).success,
    ).toBe(true);
    // Optional — a normal resume omits it.
    expect(createTabRequestSchema.safeParse({ kind: "resume", sessionId: "s" }).success).toBe(true);
    // Bounds enforced (empty / oversized rejected).
    expect(
      createTabRequestSchema.safeParse({ kind: "resume", sessionId: "s", replacementConnectionId: "" }).success,
    ).toBe(false);
    expect(
      createTabRequestSchema.safeParse({ kind: "resume", sessionId: "s", replacementConnectionId: "x".repeat(129) })
        .success,
    ).toBe(false);
  });

  it("accepts an optional codexProfileId draft pick (codex-profiles W3-F); bounds enforced", () => {
    expect(
      createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engine: "codex", codexProfileId: "work" })
        .success,
    ).toBe(true);
    // Optional — a Core (or system-default Codex) draft omits it entirely.
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x" }).success).toBe(true);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", codexProfileId: "" }).success).toBe(false);
    expect(
      createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", codexProfileId: "x".repeat(129) }).success,
    ).toBe(false);
    // The 128 boundary itself is accepted.
    expect(
      createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", codexProfileId: "x".repeat(128) }).success,
    ).toBe(true);
  });

  it("rejects an empty-string engineModel/enginePreset (min(1)) and a value over 128 chars (max)", () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engineModel: "" }).success).toBe(false);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", enginePreset: "" }).success).toBe(false);
    const tooLong = "x".repeat(129);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engineModel: tooLong }).success).toBe(false);
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", enginePreset: tooLong }).success).toBe(false);
    // The 128 boundary itself is accepted.
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engineModel: "x".repeat(128) }).success).toBe(true);
  });
});

describe("handleCreate — dialog skip vs legacy dialog (§2F.4 / §6#6)", () => {
  it("passes an explicit Codex engine through main only after its own readiness gate", async () => {
    const { manager, canSpawn, createTab } = makeManager();
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: [] });

    await expect(handleCreate({ manager, persistence: persistenceStub, dialog }, {
      kind: "new", workspace: "/x", engine: "codex",
    })).resolves.toEqual({ ok: true, tabId: "tab-1", workspace: "/x" });

    // Codex-profiles S3-1: the gate is now keyed on the picked profile id; a
    // request with no pick threads `undefined` (the active profile answers).
    expect(canSpawn).toHaveBeenCalledWith("codex", undefined);
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", workspace: "/x", resume: false }));
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
  it("forwards engineModel/enginePreset verbatim to manager.createTab (W3 join); absent when the request never carried them", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    await handleCreate(deps, {
      kind: "new",
      workspace: "/x",
      engine: "codex",
      engineModel: "gpt-5.6-mini",
      enginePreset: "workspace",
    });
    expect(createTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ engineModel: "gpt-5.6-mini", enginePreset: "workspace" }),
    );

    await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex" });
    const lastCallParams = createTab.mock.calls[createTab.mock.calls.length - 1]![0] as Record<string, unknown>;
    expect(lastCallParams).not.toHaveProperty("engineModel");
    expect(lastCallParams).not.toHaveProperty("enginePreset");
  });

  it("preselected workspace ⇒ dialog NOT called, createTab gets it verbatim", async () => {
    const { manager, createTab, deliverTabPort } = makeManager();
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/should/not/be/used"] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new", workspace: "/x" });

    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/x", resume: false }),
    );
    expect(deliverTabPort).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/x" });
  });

  it("no workspace ⇒ dialog IS called (legacy path)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/picked/dir"] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new" });

    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"], defaultPath: homedir() });
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/picked/dir", resume: false }),
    );
    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/picked/dir" });
  });

  it("dialog cancel ⇒ { ok: false, reason: 'cancelled' }, no spawn", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: true, filePaths: [] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new" });

    expect(res).toEqual({ ok: false, reason: "cancelled" });
    expect(createTab).not.toHaveBeenCalled();
  });
});

describe("handleCreate — persisted engine identity", () => {
  it("blocks resume when the authoritative worktree validator rejects registration or branch identity", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const workspace = process.cwd();
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => ({
        id: "worktree-session",
        workspace,
        projectRoot: workspace,
        worktree: {
          id: "task-5",
          path: workspace,
          branch: "anycode-wt/task-5",
          baseRef: "main",
          ownedByAnyCode: true,
        },
        model: "m",
        mode: "build",
        createdAt: 1,
        updatedAt: 1,
      }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const validateWorktreeResume = vi.fn(async () => false);

    await expect(handleCreate(
      { manager, persistence, dialog, validateWorktreeResume },
      { kind: "resume", sessionId: "worktree-session" },
    )).resolves.toEqual({ ok: false, reason: "worktree_unavailable", worktreePath: workspace });
    expect(validateWorktreeResume).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("selects the resumed engine from SessionMeta, never from renderer input", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => ({
        id: "codex-session",
        workspace: "/project",
        model: "effective",
        mode: "build",
        createdAt: 1,
        updatedAt: 1,
        engineId: "codex",
      }),
      listSessions: async () => [],
      touchSession: async () => {},
    };

    await expect(handleCreate({ manager, persistence, dialog }, { kind: "resume", sessionId: "codex-session" })).resolves.toEqual({
      ok: true,
      tabId: "tab-1",
      workspace: "/project",
    });
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ resume: true, engine: "codex" }));
  });

  it("fails closed for an unknown persisted engine", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => ({
        id: "unknown-session",
        workspace: "/project",
        model: "m",
        mode: "build",
        createdAt: 1,
        updatedAt: 1,
        engineId: "unreviewed-engine",
      }),
      listSessions: async () => [],
      touchSession: async () => {},
    };

    await expect(handleCreate({ manager, persistence, dialog }, { kind: "resume", sessionId: "unknown-session" })).resolves.toEqual({
      ok: false,
      reason: "not_ready",
    });
    expect(createTab).not.toHaveBeenCalled();
  });
});

describe("handleCreate — imported-session model override (codex-profiles S4-1 arm 2, W4-F1)", () => {
  function importMeta(id = "s-import") {
    return { id, workspace: "/project", model: "m", mode: "build" as const, createdAt: 1, updatedAt: 1 };
  }
  const importPersistence = (id = "s-import"): TabIpcDeps["persistence"] => ({
    getSession: async () => importMeta(id),
    listSessions: async () => [],
    touchSession: async () => {},
  });

  /** Shared peek-then-confirm fake over one map: peek reads, consume burns once (mirrors registerCodexRolloutIpc). */
  function makeImportModelPlane(seed: Array<[string, string]>) {
    const pending = new Map<string, string>(seed);
    const peekPendingImportModel = vi.fn((sessionId: string) => pending.get(sessionId));
    const consumePendingImportModel = vi.fn((sessionId: string) => {
      const model = pending.get(sessionId);
      if (model !== undefined) pending.delete(sessionId);
      return model;
    });
    return { pending, peekPendingImportModel, consumePendingImportModel };
  }

  it("the FIRST resume of an imported session forwards the picked model as modelOverride; consume-once drops it on a repeat resume", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const { peekPendingImportModel, consumePendingImportModel } = makeImportModelPlane([["s-import", "pick-x"]]);
    const deps: TabIpcDeps = { manager, persistence: importPersistence(), dialog, peekPendingImportModel, consumePendingImportModel };

    await handleCreate(deps, { kind: "resume", sessionId: "s-import" });
    expect(createTab).toHaveBeenLastCalledWith(expect.objectContaining({ resume: true, modelOverride: "pick-x" }));

    // Second resume of the SAME session: the pick was consumed on the first
    // successful open ⇒ no override.
    await handleCreate(deps, { kind: "resume", sessionId: "s-import" });
    const lastParams = createTab.mock.calls[createTab.mock.calls.length - 1]![0] as Record<string, unknown>;
    expect("modelOverride" in lastParams).toBe(false);
    // consume fires once per SUCCESSFUL resume (both createTabs succeeded here).
    expect(consumePendingImportModel).toHaveBeenCalledTimes(2);
  });

  it("a createTab refusal (max_tabs) does NOT spend the pick: a later successful resume still boots on it (L4·1 peek-then-confirm)", async () => {
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const { pending, peekPendingImportModel, consumePendingImportModel } = makeImportModelPlane([["s-import", "pick-x"]]);

    // First resume: the tab table is full ⇒ createTab refuses `max_tabs`.
    const { manager: fullManager } = makeManager({ createFails: true });
    const failDeps: TabIpcDeps = { manager: fullManager, persistence: importPersistence(), dialog, peekPendingImportModel, consumePendingImportModel };
    const first = await handleCreate(failDeps, { kind: "resume", sessionId: "s-import" });
    expect(first).toEqual({ ok: false, reason: "max_tabs" });
    // The refusal never burned the pick — it is still pending for a retry.
    expect(consumePendingImportModel).not.toHaveBeenCalled();
    expect(pending.get("s-import")).toBe("pick-x");

    // A later resume (a tab was closed) succeeds and STILL carries the pick.
    const { manager: okManager, createTab: okCreate } = makeManager();
    const okDeps: TabIpcDeps = { manager: okManager, persistence: importPersistence(), dialog, peekPendingImportModel, consumePendingImportModel };
    await handleCreate(okDeps, { kind: "resume", sessionId: "s-import" });
    expect(okCreate).toHaveBeenLastCalledWith(expect.objectContaining({ resume: true, modelOverride: "pick-x" }));
    expect(consumePendingImportModel).toHaveBeenCalledTimes(1);
  });

  it("a resume with no pending import model omits modelOverride entirely (byte-as-today)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const consumePendingImportModel = vi.fn(() => undefined);
    await handleCreate(
      { manager, persistence: importPersistence(), dialog, consumePendingImportModel },
      { kind: "resume", sessionId: "s-import" },
    );
    const params = createTab.mock.calls[createTab.mock.calls.length - 1]![0] as Record<string, unknown>;
    expect("modelOverride" in params).toBe(false);
  });

  it("a NEW request never consults the import model plane", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const consumePendingImportModel = vi.fn(() => "pick-x");
    await handleCreate(
      { manager, persistence: persistenceStub, dialog, consumePendingImportModel },
      { kind: "new", workspace: "/x" },
    );
    expect(consumePendingImportModel).not.toHaveBeenCalled();
    const params = createTab.mock.calls[createTab.mock.calls.length - 1]![0] as Record<string, unknown>;
    expect("modelOverride" in params).toBe(false);
  });
});

describe("handleCreate — connection pinning + resume matrix (TASK.45 W10)", () => {
  function resumeMeta(over: Record<string, unknown> = {}) {
    return {
      id: "s-resume",
      workspace: "/project",
      model: "m",
      mode: "build" as const,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
  }

  it("pins a NEW core tab to the active connection", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = {
      manager,
      persistence: persistenceStub,
      dialog,
      activeConnectionId: () => "conn-active",
    };
    await handleCreate(deps, { kind: "new", workspace: "/x" });
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "conn-active", resume: false }));
  });

  it("does NOT pin a new codex tab to a core connection", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = {
      manager,
      persistence: persistenceStub,
      dialog,
      activeConnectionId: () => "conn-active",
    };
    await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex" });
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex" }));
    const call = createTab.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("connectionId" in call).toBe(false);
  });

  it("resume (alive): re-pins the tab to the session's stored connection", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveResumePin = vi.fn(async () => ({ ok: true as const, connectionId: "conn-x" }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-x" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });
    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/project" });
    expect(resolveResumePin).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ resume: true, connectionId: "conn-x" }));
  });

  it("resume (deleted): refuses connection_missing and never spawns", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveResumePin = vi.fn(async () => ({ ok: false as const, connectionId: "conn-gone" }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-gone" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });
    expect(res).toEqual({ ok: false, reason: "connection_missing", connectionId: "conn-gone" });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("resume (legacy, no connectionId): falls back to the current default with no pin", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveResumePin = vi.fn(async () => ({ ok: true as const }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta(), // no connectionId
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });
    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/project" });
    const call = createTab.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("connectionId" in call).toBe(false);
  });

  it("resume (alive): releases the pin reservation after createTab succeeds (W10-FIX F3)", async () => {
    const { manager } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const release = vi.fn();
    const resolveResumePin = vi.fn(async () => ({ ok: true as const, connectionId: "conn-x", release }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-x" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });
    expect(res.ok).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("resume: releases the pin reservation even when createTab FAILS (W10-FIX F3 finally)", async () => {
    const { manager } = makeManager({ createFails: true });
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const release = vi.fn();
    const resolveResumePin = vi.fn(async () => ({ ok: true as const, connectionId: "conn-x", release }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-x" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });
    expect(res.ok).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("resume: a DEAD stored pin + a valid replacement re-pins the session, then resumes on it (W10-FIX F1)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const touchSession = vi.fn(async () => {});
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-dead" }),
      listSessions: async () => [],
      touchSession,
    };
    // The stored pin is dead; the replacement resolves.
    const resolveResumePin = vi.fn(async (m: { connectionId?: string }) =>
      m.connectionId === "conn-new"
        ? { ok: true as const, connectionId: "conn-new", release: () => {} }
        : { ok: false as const, connectionId: m.connectionId ?? "" },
    );
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, {
      kind: "resume",
      sessionId: "s-resume",
      replacementConnectionId: "conn-new",
    });
    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/project" });
    // The session was re-pinned to the replacement BEFORE the spawn.
    expect(touchSession).toHaveBeenCalledWith("s-resume", { connectionId: "conn-new" });
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ resume: true, connectionId: "conn-new" }));
  });

  it("resume: a LIVE stored pin IGNORES a supplied replacement — never retarget a healthy pin (W10-FIX F1)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const touchSession = vi.fn(async () => {});
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-alive" }),
      listSessions: async () => [],
      touchSession,
    };
    const resolveResumePin = vi.fn(async (m: { connectionId?: string }) =>
      m.connectionId === "conn-alive"
        ? { ok: true as const, connectionId: "conn-alive", release: () => {} }
        : { ok: false as const, connectionId: m.connectionId ?? "" },
    );
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, {
      kind: "resume",
      sessionId: "s-resume",
      replacementConnectionId: "conn-new",
    });
    expect(res.ok).toBe(true);
    expect(touchSession).not.toHaveBeenCalled();
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "conn-alive" }));
  });

  it("resume: a DEAD pin + a replacement that is ALSO gone refuses connection_missing and writes nothing (W10-FIX F1)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const touchSession = vi.fn(async () => {});
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-dead" }),
      listSessions: async () => [],
      touchSession,
    };
    // Neither the stored pin nor the replacement resolves.
    const resolveResumePin = vi.fn(async (m: { connectionId?: string }) => ({
      ok: false as const,
      connectionId: m.connectionId ?? "",
    }));
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };
    const res = await handleCreate(deps, {
      kind: "resume",
      sessionId: "s-resume",
      replacementConnectionId: "conn-also-gone",
    });
    expect(res).toEqual({ ok: false, reason: "connection_missing", connectionId: "conn-also-gone" });
    expect(touchSession).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("resume: a DEAD pin + a valid replacement whose touchSession REJECTS releases the replacement reservation — no leak (M5)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const touchSession = vi.fn(async () => {
      throw new Error("sqlite write failed");
    });
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ connectionId: "conn-dead" }),
      listSessions: async () => [],
      touchSession,
    };
    const release = vi.fn();
    const resolveResumePin = vi.fn(async (m: { connectionId?: string }) =>
      m.connectionId === "conn-new"
        ? { ok: true as const, connectionId: "conn-new", release }
        : { ok: false as const, connectionId: m.connectionId ?? "" },
    );
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveResumePin };

    await expect(
      handleCreate(deps, { kind: "resume", sessionId: "s-resume", replacementConnectionId: "conn-new" }),
    ).rejects.toThrow("sqlite write failed");

    // The replacement's reservation must be released even though touchSession
    // rejected before createTab ever ran — otherwise it stays connectionInUse
    // forever (until an app restart).
    expect(release).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });
});

describe("handleCreate — Codex profile resolution (codex-profiles W3-F)", () => {
  function resumeMeta(over: Record<string, unknown> = {}) {
    return {
      id: "s-resume",
      workspace: "/project",
      model: "m",
      mode: "build" as const,
      createdAt: 1,
      updatedAt: 1,
      engineId: "codex",
      ...over,
    };
  }

  it("new: no codexProfileId in the request ⇒ resolveCodexProfile is never called, no codexProfile key on createTab", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({ ok: true as const }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex" });

    expect(resolveCodexProfile).not.toHaveBeenCalled();
    const call = createTab.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("codexProfile" in call).toBe(false);
  });

  it("new: a codexProfileId with NO resolver wired refuses fail-closed (not_ready), never spawns", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, {
      kind: "new",
      workspace: "/x",
      engine: "codex",
      codexProfileId: "work",
    });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("new: the resolver refusing (deleted/invalid profile) refuses fail-closed (not_ready), never spawns", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({ ok: false as const }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    const res = await handleCreate(deps, {
      kind: "new",
      workspace: "/x",
      engine: "codex",
      codexProfileId: "deleted-profile",
    });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(resolveCodexProfile).toHaveBeenCalledWith("deleted-profile");
    expect(createTab).not.toHaveBeenCalled();
  });

  it("new: a resolved profile rides verbatim into manager.createTab's codexProfile param", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({
      ok: true as const,
      codexProfile: { id: "work", authLink: "/home/user/.codex/auth.json" },
    }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex", codexProfileId: "work" });

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ codexProfile: { id: "work", authLink: "/home/user/.codex/auth.json" } }),
    );
  });

  it("new: the resolver's `system`-pseudo-profile result (ok:true, no codexProfile) omits the key entirely", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({ ok: true as const }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex", codexProfileId: "system" });

    const call = createTab.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("codexProfile" in call).toBe(false);
  });

  it("resume: no persisted codexProfileId (legacy/system session) ⇒ resolveCodexProfile is never called", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({ ok: true as const }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta(),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });

    expect(resolveCodexProfile).not.toHaveBeenCalled();
    const call = createTab.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("codexProfile" in call).toBe(false);
  });

  it("resume: a persisted codexProfileId with NO resolver wired refuses fail-closed (not_ready)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ codexProfileId: "work" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("resume: a persisted codexProfileId whose profile has since vanished refuses fail-closed — NEVER silently resumes on system", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async () => ({ ok: false as const }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ codexProfileId: "deleted-profile" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveCodexProfile };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(resolveCodexProfile).toHaveBeenCalledWith("deleted-profile");
    expect(createTab).not.toHaveBeenCalled();
  });

  it("resume: re-resolves the SAME profile the session was created under, rides it into createTab (cross-restart chain)", async () => {
    const { manager, createTab } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ codexProfileId: "work" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveCodexProfile };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });

    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/project" });
    expect(resolveCodexProfile).toHaveBeenCalledWith("work");
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ codexProfile: { id: "work" } }));
  });
});

describe("handleCreate — readiness gate keys on the PICKED Codex profile (S3-1)", () => {
  function resumeMeta(over: Record<string, unknown> = {}) {
    return {
      id: "s-resume",
      workspace: "/project",
      model: "m",
      mode: "build" as const,
      createdAt: 1,
      updatedAt: 1,
      engineId: "codex",
      ...over,
    };
  }

  it("new: the gate is asked about the PICKED profile id before the folder dialog", async () => {
    const order: string[] = [];
    const { manager, canSpawn } = makeManager({}, order);
    const { dialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const resolveCodexProfile = vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "new", engine: "codex", codexProfileId: "ready-x" });

    // Fix present: :169 threads req.codexProfileId. On the rollback canSpawn saw
    // only ("codex") ⇒ this tuple assertion is RED.
    expect(canSpawn).toHaveBeenCalledWith("codex", "ready-x");
    // The gate answers BEFORE the user is ever asked to pick a folder.
    expect(order.indexOf("canSpawn")).toBeLessThan(order.indexOf("dialog"));
  });

  it("resume: the gate is asked about the profile the session was CREATED under (meta.codexProfileId)", async () => {
    const { manager, canSpawn } = makeManager();
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const resolveCodexProfile = vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } }));
    const persistence: TabIpcDeps["persistence"] = {
      getSession: async () => resumeMeta({ codexProfileId: "work" }),
      listSessions: async () => [],
      touchSession: async () => {},
    };
    const deps: TabIpcDeps = { manager, persistence, dialog, resolveCodexProfile };

    await handleCreate(deps, { kind: "resume", sessionId: "s-resume" });

    expect(canSpawn).toHaveBeenCalledWith("codex", "work");
  });

  it("negative holds at :169: a PICK the gate reports NOT ready refuses not_ready before resolving the profile", async () => {
    const canSpawn = vi.fn((_engine: string, codexProfileId?: string) => codexProfileId === "ready-x");
    const createTab = vi.fn();
    const manager = {
      canSpawn,
      atCapacity: vi.fn(() => false),
      createTab,
      deliverTabPort: vi.fn(),
      sessionOpenInTab: vi.fn(() => undefined),
    } as unknown as TabHostManager;
    const { dialog } = makeDialog({ canceled: false, filePaths: ["/x"] });
    const resolveCodexProfile = vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } }));
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog, resolveCodexProfile };

    const res = await handleCreate(deps, {
      kind: "new",
      workspace: "/x",
      engine: "codex",
      codexProfileId: "not-ready-y",
    });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(canSpawn).toHaveBeenCalledWith("codex", "not-ready-y");
    // Short-circuits at the gate — never resolves the profile nor creates a tab.
    expect(resolveCodexProfile).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });
});

describe("handleCreate — guard order canSpawn -> atCapacity -> dialog/skip (R7)", () => {
  it("!canSpawn short-circuits before atCapacity and dialog", async () => {
    const order: string[] = [];
    const { manager, atCapacity } = makeManager({ canSpawn: false }, order);
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new", workspace: "/x" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(order).toEqual(["canSpawn"]);
    expect(atCapacity).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("atCapacity blocks before the dialog/skip", async () => {
    const order: string[] = [];
    const { manager, createTab } = makeManager({ atCapacity: true }, order);
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new" });

    expect(res).toEqual({ ok: false, reason: "max_tabs" });
    expect(order).toEqual(["canSpawn", "atCapacity"]);
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("preselected success order = canSpawn, atCapacity, createTab, deliverTabPort (no dialog)", async () => {
    const order: string[] = [];
    const { manager } = makeManager({}, order);
    const { dialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    await handleCreate(deps, { kind: "new", workspace: "/x" });

    expect(order).toEqual(["canSpawn", "atCapacity", "createTab", "deliverTabPort"]);
  });

  it("legacy success order interleaves the dialog between atCapacity and createTab", async () => {
    const order: string[] = [];
    const { manager } = makeManager({}, order);
    const { dialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    await handleCreate(deps, { kind: "new" });

    expect(order).toEqual(["canSpawn", "atCapacity", "dialog", "createTab", "deliverTabPort"]);
  });
});

describe("handleWorkspacePick (slice P7.12 §4.4)", () => {
  it("returns the picked path", async () => {
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/picked/dir"] });
    const deps: TabIpcDeps = { manager: makeManager().manager, persistence: persistenceStub, dialog };

    const res = await handleWorkspacePick(deps);

    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"], defaultPath: homedir() });
    expect(res).toEqual({ workspace: "/picked/dir" });
  });

  it("cancel returns { workspace: null }", async () => {
    const { dialog } = makeDialog({ canceled: true, filePaths: [] });
    const deps: TabIpcDeps = { manager: makeManager().manager, persistence: persistenceStub, dialog };

    const res = await handleWorkspacePick(deps);

    expect(res).toEqual({ workspace: null });
  });
});

describe("registered handler — fail-closed on invalid workspace (§6#6)", () => {
  it("{ kind: 'new', workspace: 123 } ⇒ safeParse fail ⇒ cancelled no-op (no dialog, no spawn)", async () => {
    const { manager, canSpawn, createTab } = makeManager();
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/x"] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await runRegisteredCreate(deps, { kind: "new", workspace: 123 } as unknown as CreateTabRequest);

    expect(res).toEqual({ ok: false, reason: "cancelled" });
    expect(canSpawn).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });
});


describe("handleCreate — unknown-readiness hydration (TASK.64)", () => {
  /**
   * A manager whose gate answer starts false and flips only if the rig says the
   * hydrated verdict is ready, paired with the deps-level engineReadyKnown /
   * hydrateEngineReady closures mirroring main/index.ts's codex wiring: UNKNOWN
   * before the first doctor snapshot, KNOWN after it (ready or not).
   */
  function makeHydrationRig(opts: { readyAfterHydrate: boolean; hydrateThrows?: boolean }) {
    let verdictKnown = false;
    let ready = false;
    const canSpawn = vi.fn(() => ready);
    const createTab = vi.fn((params: { workspace: string; sessionId: string; resume: boolean }) => ({
      ok: true,
      tab: { tabId: "tab-1", workspace: params.workspace },
    }));
    const manager = {
      canSpawn,
      atCapacity: vi.fn(() => false),
      createTab,
      deliverTabPort: vi.fn(),
      sessionOpenInTab: vi.fn(() => undefined),
    } as unknown as TabHostManager;
    const engineReadyKnown = vi.fn(() => verdictKnown);
    const hydrateEngineReady = vi.fn(async () => {
      if (opts.hydrateThrows === true) {
        throw new Error("doctor failed");
      }
      verdictKnown = true;
      ready = opts.readyAfterHydrate;
    });
    return { manager, canSpawn, createTab, engineReadyKnown, hydrateEngineReady };
  }

  const codexMeta = (codexProfileId?: string) => ({
    id: "s-codex",
    workspace: "/project",
    model: "m",
    mode: "build" as const,
    createdAt: 1,
    updatedAt: 1,
    engineId: "codex",
    ...(codexProfileId !== undefined ? { codexProfileId } : {}),
  });
  const metaPersistence = (meta: ReturnType<typeof codexMeta>): TabIpcDeps["persistence"] => ({
    getSession: async () => meta,
    listSessions: async () => [],
    touchSession: async () => {},
  });

  it("resume: an UNKNOWN verdict hydrates first — a ready profile opens instead of a false not_ready", async () => {
    const rig = makeHydrationRig({ readyAfterHydrate: true });
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = {
      manager: rig.manager,
      persistence: metaPersistence(codexMeta("work")),
      dialog,
      resolveCodexProfile: vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } })),
      engineReadyKnown: rig.engineReadyKnown,
      hydrateEngineReady: rig.hydrateEngineReady,
    };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-codex" });

    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/project" });
    // Hydration answered about the profile the session was CREATED under...
    expect(rig.hydrateEngineReady).toHaveBeenCalledWith("codex", "work");
    // ...and the re-read gate then let createTab through with that profile.
    expect(rig.createTab).toHaveBeenCalledWith(
      expect.objectContaining({ resume: true, engine: "codex", codexProfile: { id: "work" } }),
    );
  });

  it("resume: hydration landing a KNOWN not-ready still refuses (genuinely signed out)", async () => {
    const rig = makeHydrationRig({ readyAfterHydrate: false });
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = {
      manager: rig.manager,
      persistence: metaPersistence(codexMeta("work")),
      dialog,
      resolveCodexProfile: vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } })),
      engineReadyKnown: rig.engineReadyKnown,
      hydrateEngineReady: rig.hydrateEngineReady,
    };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-codex" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(rig.hydrateEngineReady).toHaveBeenCalledOnce();
    expect(rig.createTab).not.toHaveBeenCalled();
  });

  it("a KNOWN not-ready refuses WITHOUT hydrating — no doctor run per click", async () => {
    const rig = makeHydrationRig({ readyAfterHydrate: true });
    rig.engineReadyKnown.mockReturnValue(true); // a verdict already landed this run
    const { dialog } = makeDialog({ canceled: false, filePaths: [] });
    const deps: TabIpcDeps = {
      manager: rig.manager,
      persistence: metaPersistence(codexMeta("work")),
      dialog,
      resolveCodexProfile: vi.fn(async (id: string) => ({ ok: true as const, codexProfile: { id } })),
      engineReadyKnown: rig.engineReadyKnown,
      hydrateEngineReady: rig.hydrateEngineReady,
    };

    const res = await handleCreate(deps, { kind: "resume", sessionId: "s-codex" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(rig.hydrateEngineReady).not.toHaveBeenCalled();
    expect(rig.createTab).not.toHaveBeenCalled();
  });

  it("new: a codex draft opened before the boot recheck landed hydrates, then creates", async () => {
    const rig = makeHydrationRig({ readyAfterHydrate: true });
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/x"] });
    const deps: TabIpcDeps = {
      manager: rig.manager,
      persistence: persistenceStub,
      dialog,
      engineReadyKnown: rig.engineReadyKnown,
      hydrateEngineReady: rig.hydrateEngineReady,
    };

    const res = await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex" });

    expect(res).toEqual({ ok: true, tabId: "tab-1", workspace: "/x" });
    // No draft pick ⇒ hydration answers about the ACTIVE profile.
    expect(rig.hydrateEngineReady).toHaveBeenCalledWith("codex", undefined);
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("a rejecting hydration leaves the gate fail-closed (not_ready, no spawn, no throw)", async () => {
    const rig = makeHydrationRig({ readyAfterHydrate: false, hydrateThrows: true });
    const { dialog } = makeDialog({ canceled: false, filePaths: ["/x"] });
    const deps: TabIpcDeps = {
      manager: rig.manager,
      persistence: persistenceStub,
      dialog,
      engineReadyKnown: rig.engineReadyKnown,
      hydrateEngineReady: rig.hydrateEngineReady,
    };

    const res = await handleCreate(deps, { kind: "new", workspace: "/x", engine: "codex" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(rig.createTab).not.toHaveBeenCalled();
  });

  it("legacy wiring (no tri-state deps) keeps the single-sync-check refuse", async () => {
    const order: string[] = [];
    const { manager, canSpawn } = makeManager({ canSpawn: false }, order);
    const { dialog, showOpenDialog } = makeDialog({ canceled: false, filePaths: ["/x"] }, order);
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await handleCreate(deps, { kind: "new", workspace: "/x" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(order).toEqual(["canSpawn"]);
    expect(canSpawn).toHaveBeenCalledOnce();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});

describe("toSummary — engine projection to the picker (TASK.64)", () => {
  const managerNoBinding = { sessionOpenInTab: vi.fn(() => undefined) } as unknown as TabHostManager;
  const baseMeta: SessionMeta = {
    id: "s1",
    workspace: "/project",
    model: "m",
    mode: "build",
    createdAt: 1,
    updatedAt: 2,
  };

  it("carries a codex session's engineId so the Sidebar can pick the engine-correct not_ready copy", () => {
    const summary = toSummary({ ...baseMeta, engineId: "codex" }, managerNoBinding);
    expect(summary.engineId).toBe("codex");
  });

  it("omits engineId for a legacy/core session (absent stays absent — historical copy)", () => {
    const summary = toSummary(baseMeta, managerNoBinding);
    expect("engineId" in summary).toBe(false);
  });
});

describe('e2e-negative: engine:"claude" is refused by spawnableWhenKnown, NOT by the schema (SLICE-CC A1, cut §1.2 DoD-3)', () => {
  it('the schema ACCEPTS engine: "claude" (widened by the cut\'s two-point tab-ipc.ts edit)', () => {
    expect(createTabRequestSchema.safeParse({ kind: "new", workspace: "/x", engine: "claude" }).success).toBe(true);
  });

  it("a full registered create request is refused not_ready at canSpawn — a schema-layer refusal would instead surface as the fail-closed \"cancelled\" no-op runRegisteredCreate uses for an UNPARSEABLE request, which this is not", async () => {
    const { manager, canSpawn, createTab } = makeManager({ canSpawn: false });
    const { dialog } = makeDialog({ canceled: true, filePaths: [] });
    const deps: TabIpcDeps = { manager, persistence: persistenceStub, dialog };

    const res = await runRegisteredCreate(deps, { kind: "new", workspace: "/x", engine: "claude" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(canSpawn).toHaveBeenCalledWith("claude", undefined);
    expect(createTab).not.toHaveBeenCalled();
  });

  // SLICE-CC C5 (cut §1.4): CC-A's unconditional refusal is GONE — `bootClaude`
  // now exists in host/index.ts's boot() switch, so a claude spawn can no longer
  // land on the core boot path. What remains is the ordinary readiness gate, and
  // this replaces CC-A's assertion that the hard block was present.
  it("mirrors main/tabs.ts's REAL canSpawn: an UNREADY claude doctor still refuses not_ready, through the actual TabHostManager", async () => {
    const { TabHostManager } = await import("./tabs.js");
    const realManager = new TabHostManager({
      fork: (() => {
        throw new Error("must never fork for a refused claude request");
      }) as unknown as import("./tabs.js").HostForkFn,
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {}, port2: {} }) as unknown as import("./tabs.js").TabChannel,
      getWindow: () => null,
      env: () => ({}),
      // The doctor's verdict is now the whole gate for claude.
      engineReady: (engine) => engine !== "claude",
    });
    const { dialog } = makeDialog({ canceled: true, filePaths: [] });
    const deps: TabIpcDeps = { manager: realManager, persistence: persistenceStub, dialog };

    const res = await runRegisteredCreate(deps, { kind: "new", workspace: "/x", engine: "claude" });

    expect(res).toEqual({ ok: false, reason: "not_ready" });
  });

  it("a READY claude doctor now reaches the fork — the flip is observable end-to-end through tab-ipc", async () => {
    const { TabHostManager } = await import("./tabs.js");
    const forked: string[] = [];
    const realManager = new TabHostManager({
      fork: ((entry: string) => {
        forked.push(entry);
        return new (class {
          on(): void {}
          once(): void {}
          postMessage(): void {}
          kill(): boolean {
            return true;
          }
          pid = 4242;
        })();
      }) as unknown as import("./tabs.js").HostForkFn,
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {}, port2: {} }) as unknown as import("./tabs.js").TabChannel,
      getWindow: () => null,
      env: () => ({}),
      engineReady: () => true,
    });
    const { dialog } = makeDialog({ canceled: true, filePaths: [] });
    const deps: TabIpcDeps = { manager: realManager, persistence: persistenceStub, dialog };

    const res = await runRegisteredCreate(deps, { kind: "new", workspace: "/x", engine: "claude" });

    expect(res.ok).toBe(true);
    expect(forked).toEqual(["/fake/host.js"]);
  });
});

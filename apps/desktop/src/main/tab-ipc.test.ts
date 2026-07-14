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
  type DialogLike,
  type TabIpcDeps,
} from "./tab-ipc.js";
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

    expect(canSpawn).toHaveBeenCalledWith("codex");
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
    };

    await expect(handleCreate({ manager, persistence, dialog }, { kind: "resume", sessionId: "unknown-session" })).resolves.toEqual({
      ok: false,
      reason: "not_ready",
    });
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

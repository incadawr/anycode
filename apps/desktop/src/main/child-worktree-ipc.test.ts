import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChildWorktreeIpc } from "./child-worktree-ipc.js";
import { setIpcGuardMainWindow, addIpcGuardTrustedWindow, resetIpcGuardForTests } from "./ipc-guard.js";
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: any) => handlers.set(key, fn) } }));
afterEach(() => { handlers.clear(); resetIpcGuardForTests(); });
it("guards main/top frame, validates payload, persists only on a live parent and rereads durable receipts", async () => {
  const data = await realpath(await mkdtemp(join(tmpdir(), "worktree-view-")));
  try {
    const parent = { tabId: "parent", sessionId: "session", projectRoot: data, state: "running" };
    const child = { ...parent, tabId: "child", sessionId: "gone", childOf: {} };
    const second = { ...parent, tabId: "second" };
    const managed = { ...parent, tabId: "managed", childWorktree: {} };
    const sender = { mainFrame: {} }, auxiliary = { mainFrame: {} };
    setIpcGuardMainWindow(() => sender); addIpcGuardTrustedWindow(auxiliary);
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await mkdir(join(data, "child-worktrees")); await writeFile(join(data, "child-worktrees", `${id}.json`), "{}");
    let phase = "active", appRunId = "now";
    const read = vi.fn(async () => ({ id, projectRoot: data, parentSessionId: "session", childSessionId: "gone",
      appRunId, phase, path: "/checkout", branch: "branch", baseSha: "abc", reason: null }));
    registerChildWorktreeIpc({ userData: data, appRunId: "now", resources: { read } as never,
      getTab: id => [parent, child, managed, second].find(t => t.tabId === id) as never });
    const invoke = (payload: unknown, from = sender, frame = from.mainFrame) => handlers.values().next().value!({ sender: from, senderFrame: frame }, payload);
    expect(() => invoke({ tabId: "parent" }, auxiliary)).toThrow();
    expect(() => invoke({ tabId: "parent" }, sender, {})).toThrow();
    for (const payload of [{ tabId: "missing", enabled: true }, { tabId: "child", enabled: true },
      { tabId: "managed", enabled: true }, { tabId: "parent", path: "/evil" }, { tabId: "parent", enabled: "yes" }])
      await expect(invoke(payload)).rejects.toThrow();
    expect(await invoke({ tabId: "parent" })).toMatchObject({ enabled: false });
    expect(await invoke({ tabId: "parent", enabled: true })).toMatchObject({ enabled: true, resources: [{ phase: "active" }] });
    expect(await invoke({ tabId: "second" })).toMatchObject({ enabled: false });
    expect(await invoke({ tabId: "child" })).toMatchObject({ resources: [{ childSessionId: "gone" }] });
    expect(await invoke({ tabId: "managed" })).toMatchObject({ resources: [] });
    const other = "00000000-0000-0000-0000-000000000000";
    const bad = "11111111-1111-1111-1111-111111111111";
    for (const key of [other, bad]) await writeFile(join(data, "child-worktrees", `${key}.json`), "{}");
    const original = read.getMockImplementation()!;
    read.mockImplementation(async (key?: string) => {
      if (key === bad) throw Error("Broken receipt");
      return { ...await original(), id: key ?? id, projectRoot: key === other ? "/other" : data };
    });
    expect(await invoke({ tabId: "parent" })).toMatchObject({ resources: [{ id }], unverified: [{ id: bad, reason: "Broken receipt" }] });
    read.mockImplementation(async (key?: string) => ({ ...await original(), id: key ?? id }));
    expect((await invoke({ tabId: "parent" })).resources.map((r: any) => r.id)).toEqual([other, bad, id]);
    for (const key of [other, bad]) await rm(join(data, "child-worktrees", `${key}.json`));
    phase = "removed";
    expect(await invoke({ tabId: "parent" })).toMatchObject({ enabled: true, resources: [{ phase: "removed" }] });
    expect(await invoke({ tabId: "parent", enabled: false })).toMatchObject({ enabled: false });
    phase = "active"; appRunId = "old";
    expect(await invoke({ tabId: "parent" })).toMatchObject({ resources: [{ phase: "unknown", reason: expect.stringContaining("unconfirmed") }] });
    parent.state = "closing"; await expect(invoke({ tabId: "parent", enabled: true })).rejects.toThrow();
  } finally { await rm(data, { recursive: true, force: true }); }
});

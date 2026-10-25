/**
 * Main-side workspace-trust decision (Taskana 4736): the renderer sends a tab id
 * and a decision ONLY. Main resolves the folder and hash from the tab's own
 * record, persists trust/deny per path+hash, keeps "trust once" in memory only,
 * and restarts that tab's host. The payload is strict: a path or hash is refused.
 */

import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceTrustDecide, type WorkspaceTrustIpcDeps } from "./workspace-trust-ipc.js";
import { defaultTrustStorePath, canonicalWorkspacePath } from "@anycode/core/workspace-trust";
import type { TrustStoreFs } from "@anycode/core/workspace-trust";

const HOME = "/home/u";
const WS = "/work/repo";
const HASH = "a".repeat(64);
const STORE = defaultTrustStorePath(HOME);

function makeFs(): TrustStoreFs & { files: Map<string, string>; writes: { path: string; mode?: number }[] } {
  const files = new Map<string, string>();
  const writes: { path: string; mode?: number }[] = [];
  return {
    files,
    writes,
    exists: async (p) => files.has(p),
    readFile: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error("ENOENT");
      return c;
    },
    writeFile: async (p, c, opts) => {
      writes.push({ path: p, mode: opts?.mode });
      files.set(p, c);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
}

function makeDeps(overrides: Partial<WorkspaceTrustIpcDeps> = {}) {
  const restarts: string[] = [];
  const cleared: string[] = [];
  const pending = new Map<string, { workspace: string; hash: string }>([
    ["tab-1", { workspace: WS, hash: HASH }],
  ]);
  const tabs: WorkspaceTrustIpcDeps["tabs"] = {
    workspaceTrustPendingFor: (tabId) => {
      if (tabId === "gone") return "unknown_tab";
      return pending.get(tabId) ?? "no_pending";
    },
    clearWorkspaceTrustPending: (tabId) => {
      cleared.push(tabId);
      pending.delete(tabId);
    },
    restartTabHost: (tabId) => {
      restarts.push(tabId);
      return { ok: true };
    },
  };
  const deps: WorkspaceTrustIpcDeps = {
    fs: makeFs(),
    home: HOME,
    tabs,
    onceApprovals: new Map(),
    now: () => "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
  return { deps, restarts, cleared };
}

describe("handleWorkspaceTrustDecide", () => {
  it("'trust' persists trusted for the tab's own folder and hash, then restarts that tab", async () => {
    const { deps, restarts, cleared } = makeDeps();
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" })).toEqual({ ok: true });
    const store = JSON.parse((deps.fs as ReturnType<typeof makeFs>).files.get(STORE)!);
    expect(store.folders[canonicalWorkspacePath(WS)]).toEqual({
      decision: "trusted",
      hash: HASH,
      decidedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(restarts).toEqual(["tab-1"]);
    expect(cleared).toEqual(["tab-1"]);
  });

  it("'deny' persists denied for the same path+hash", async () => {
    const { deps } = makeDeps();
    await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "deny" });
    const store = JSON.parse((deps.fs as ReturnType<typeof makeFs>).files.get(STORE)!);
    expect(store.folders[canonicalWorkspacePath(WS)].decision).toBe("denied");
  });

  it("'once' is never persisted: it lives in the in-memory approval map and restarts the tab", async () => {
    const { deps, restarts } = makeDeps();
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "once" })).toEqual({ ok: true });
    expect((deps.fs as ReturnType<typeof makeFs>).writes).toEqual([]);
    expect(deps.onceApprovals.get(canonicalWorkspacePath(WS))).toBe(HASH);
    expect(restarts).toEqual(["tab-1"]);
  });

  it("the trust store is written with a private mode via tmp+rename", async () => {
    const { deps } = makeDeps();
    await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" });
    const fs = deps.fs as ReturnType<typeof makeFs>;
    expect(fs.writes[0]!.mode).toBe(0o600);
    expect(fs.writes[0]!.path).not.toBe(STORE);
  });

  it("refuses a payload carrying a path or a hash (strict schema)", async () => {
    const { deps, restarts } = makeDeps();
    for (const raw of [
      { tabId: "tab-1", decision: "trust", path: WS },
      { tabId: "tab-1", decision: "trust", hash: HASH },
      { tabId: "tab-1", decision: "trust", workspace: WS },
      { decision: "trust" },
      { tabId: "tab-1", decision: "maybe" },
      "trust",
    ]) {
      expect(await handleWorkspaceTrustDecide(deps, raw)).toEqual({ ok: false, reason: "invalid" });
    }
    expect((deps.fs as ReturnType<typeof makeFs>).writes).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("an unknown tab or a tab with nothing pending is refused and changes nothing", async () => {
    const { deps, restarts } = makeDeps();
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "gone", decision: "trust" })).toEqual({
      ok: false,
      reason: "unknown_tab",
    });
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-2", decision: "trust" })).toEqual({
      ok: false,
      reason: "no_pending",
    });
    expect((deps.fs as ReturnType<typeof makeFs>).writes).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("a failed write is reported, is not silently trusted, and does not restart the tab", async () => {
    const fs = makeFs();
    fs.writeFile = vi.fn().mockRejectedValue(new Error("EACCES"));
    const { deps, restarts } = makeDeps({ fs });
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" })).toEqual({
      ok: false,
      reason: "write_failed",
    });
    expect(restarts).toEqual([]);
  });

  it("never touches the real home: every write goes to the injected home's store", async () => {
    const { deps } = makeDeps({ home: "/tmp/injected-home" });
    await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" });
    const fs = deps.fs as ReturnType<typeof makeFs>;
    expect(fs.writes.every((w) => w.path.startsWith("/tmp/injected-home/.anycode/"))).toBe(true);
  });
});

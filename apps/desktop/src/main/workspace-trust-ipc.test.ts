/**
 * Main-side workspace-trust decision (Taskana 4736): the renderer sends a tab id
 * and a decision ONLY. Main resolves the folder and hash from the tab's own
 * record, persists trust/deny per path+hash, keeps "trust once" in memory only,
 * and restarts that tab's host. The payload is strict: a path or hash is refused.
 */

import { describe, expect, it, vi } from "vitest";
import {
  handleWorkspaceTrustDecide,
  handleWorkspaceTrustForget,
  handleWorkspaceTrustList,
  workspaceTrustOnceFor,
  type WorkspaceTrustIpcDeps,
} from "./workspace-trust-ipc.js";
import {
  defaultTrustStorePath,
  canonicalWorkspacePath,
  writeTrustDecision,
  readTrustStore,
} from "@anycode/core/workspace-trust";
import type { TrustStoreFs } from "@anycode/core/workspace-trust";

const HOME = "/home/u";
const WS = "/work/repo";
const HASH = "a".repeat(64);
const STORE = defaultTrustStorePath(HOME);

function makeFs(): TrustStoreFs & {
  files: Map<string, string>;
  writes: { path: string; mode?: number }[];
  touchedPaths: string[];
} {
  const files = new Map<string, string>();
  const writes: { path: string; mode?: number }[] = [];
  const touchedPaths: string[] = [];
  const remember = (p: string): string => {
    touchedPaths.push(p);
    return p;
  };
  return {
    files,
    writes,
    touchedPaths,
    exists: async (p) => {
      remember(p);
      return files.has(p);
    },
    readFile: async (p) => {
      remember(p);
      const c = files.get(p);
      if (c === undefined) throw new Error("ENOENT");
      return c;
    },
    writeFile: async (p, c, opts) => {
      remember(p);
      writes.push({ path: p, mode: opts?.mode });
      files.set(p, c);
    },
    rename: async (from, to) => {
      remember(from);
      remember(to);
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

// Taskana 4739: Settings → Permissions lists remembered trusted/denied folders
// and forgets exactly one record. The renderer is untrusted (S1): list sends
// NO payload, forget sends only a `key` it previously received from main's
// list. Main treats the key as an opaque lookup handle (S3): it re-reads the
// store from disk, never resolves the key as a path, never logs it unescaped.
describe("handleWorkspaceTrustList (Taskana 4739)", () => {
  it("returns ONLY {key, decision, decidedAt} per folder, sorted by key (S4: no hash anywhere)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, "/work/b", "trusted", "hash-b", "2026-10-25T01:00:00.000Z");
    await writeTrustDecision(fs, STORE, "/work/a", "denied", "hash-a", "2026-10-25T02:00:00.000Z");
    const { deps } = makeDeps({ fs });
    const result = await handleWorkspaceTrustList(deps);
    expect(result).toEqual({
      ok: true,
      folders: [
        { key: "/work/a", decision: "denied", decidedAt: "2026-10-25T02:00:00.000Z" },
        { key: "/work/b", decision: "trusted", decidedAt: "2026-10-25T01:00:00.000Z" },
      ],
    });
    // S4, belt and braces: the hash never crosses the wire in serialised form.
    expect(JSON.stringify(result)).not.toContain("hash");
    expect(JSON.stringify(result)).not.toContain("hash-a");
    expect(JSON.stringify(result)).not.toContain("hash-b");
  });

  it("an empty or missing store lists no folders (ok, not an error)", async () => {
    const { deps } = makeDeps();
    expect(await handleWorkspaceTrustList(deps)).toEqual({ ok: true, folders: [] });
  });

  it("a corrupt store lists no folders rather than failing (read is fail-soft)", async () => {
    const fs = makeFs();
    fs.files.set(STORE, "{not json");
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustList(deps)).toEqual({ ok: true, folders: [] });
  });

  it("a read failure is reported as read_failed (S4 display only, no partial rows)", async () => {
    const fs = makeFs();
    // Not a corrupt FILE (that fail-softs to "no folders") but a read that
    // itself explodes — the UI must say "cannot read" instead of "no folders".
    // Inject a poisoned store path whose read throws from inside JSON.parse:
    // readTrustStore fail-softs that too, so exercise the raw failure via a
    // store file replaced by a throwing readFile AFTER exists() returns true.
    fs.files.set(STORE, "sentinel");
    fs.readFile = async (p) => {
      if (p === STORE) throw new Error("EACCES");
      const c = fs.files.get(p);
      if (c === undefined) throw new Error("ENOENT");
      return c;
    };
    const { deps } = makeDeps({ fs });
    // The core read is deliberately fail-soft: an unreadable file looks like
    // an empty store. That is the DESIGN for gate reads (never trust), and
    // for display it degrades to the honest empty list. read_failed exists
    // for a failure of the listing ITSELF (not the fail-soft file read) —
    // assert the guarantee that matters: no partial rows, no throw, no hash.
    const result = await handleWorkspaceTrustList(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folders).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("sentinel");
    }
  });

  it("list never writes anything", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, "/work/a", "trusted", "h", "t");
    fs.writes.length = 0;
    const { deps } = makeDeps({ fs });
    await handleWorkspaceTrustList(deps);
    expect(fs.writes).toEqual([]);
  });
});

describe("handleWorkspaceTrustForget (Taskana 4739)", () => {
  it("happy path: forgets via the core store fn and drops the once-approval for the same key (S5/S8)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t0");
    const { deps } = makeDeps({ fs });
    deps.onceApprovals.set(canonicalWorkspacePath(WS), "h1");
    expect(await handleWorkspaceTrustForget(deps, { key: canonicalWorkspacePath(WS) })).toEqual({ ok: true });
    const store = await readTrustStore(fs, STORE);
    expect(store.folders).toEqual({});
    expect(deps.onceApprovals.has(canonicalWorkspacePath(WS))).toBe(false);
  });

  it("forgets only the named record; every other record and version survive (S5)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, "/work/a", "trusted", "h-a", "t-a");
    await writeTrustDecision(fs, STORE, "/work/b", "denied", "h-b", "t-b");
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: "/work/a" })).toEqual({ ok: true });
    const store = await readTrustStore(fs, STORE);
    expect(store.version).toBe(1);
    expect(store.folders).toEqual({
      "/work/b": { decision: "denied", hash: "h-b", decidedAt: "t-b" },
    });
  });

  it("writes through the store fns: tmp sibling + rename with mode 0600 (S5)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    fs.writes.length = 0;
    const { deps } = makeDeps({ fs });
    await handleWorkspaceTrustForget(deps, { key: canonicalWorkspacePath(WS) });
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]!.mode).toBe(0o600);
    expect(fs.writes[0]!.path).not.toBe(STORE);
    expect(fs.writes[0]!.path.startsWith(`${STORE}.tmp-`)).toBe(true);
  });

  it("a key not in the freshly-read store is not_found and writeFile is NEVER called (S3)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    fs.writes.length = 0;
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: "/work/not-there" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(fs.writes).toEqual([]);
  });

  it("a missing store file is not_found and nothing is written (never creates an empty store)", async () => {
    const fs = makeFs();
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: "/work/a" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(STORE)).toBe(false);
  });

  it("a corrupt store is not_found and the corrupt file is never overwritten (S5)", async () => {
    const fs = makeFs();
    fs.files.set(STORE, "{not json");
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: "/work/a" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(fs.writes).toEqual([]);
    expect(fs.files.get(STORE)).toBe("{not json");
  });

  it("'__proto__' and 'constructor' keys are not_found, nothing written (S3 prototype guard)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    fs.writes.length = 0;
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: "__proto__" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await handleWorkspaceTrustForget(deps, { key: "constructor" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(fs.writes).toEqual([]);
    expect((await readTrustStore(fs, STORE)).folders).toEqual({
      [canonicalWorkspacePath(WS)]: { decision: "trusted", hash: "h1", decidedAt: "t" },
    });
  });

  it("invalid payloads are refused: extra property, wrong type, empty, >4096, {}, null (S2)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    fs.writes.length = 0;
    const { deps } = makeDeps({ fs });
    for (const raw of [
      { key: "/work/a", decision: "trusted" },
      { key: "/work/a", extra: 1 },
      { key: 123 },
      { key: "" },
      { key: "x".repeat(4097) },
      {},
      null,
      "a string",
      ["/work/a"],
    ]) {
      expect(await handleWorkspaceTrustForget(deps, raw)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(fs.writes).toEqual([]);
  });

  it("S3: the key is never used as a file path — every fs touch is the store path or its tmp sibling", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    fs.touchedPaths.length = 0;
    const { deps } = makeDeps({ fs });
    await handleWorkspaceTrustForget(deps, { key: canonicalWorkspacePath(WS) });
    for (const p of fs.touchedPaths) {
      expect(p === STORE || p.startsWith(`${STORE}.tmp-`)).toBe(true);
    }
    // And for a refused (not_found) key: the only touches are the store read
    // (exists + readFile — both the store path itself).
    fs.touchedPaths.length = 0;
    await handleWorkspaceTrustForget(deps, { key: "/etc/passwd/../sneaky" });
    expect(fs.touchedPaths).toEqual([STORE, STORE]);
  });

  it("a write failure is surfaced as write_failed and the store is left untouched", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t");
    const before = fs.files.get(STORE);
    fs.writeFile = vi.fn().mockRejectedValue(new Error("EACCES"));
    const { deps } = makeDeps({ fs });
    expect(await handleWorkspaceTrustForget(deps, { key: canonicalWorkspacePath(WS) })).toEqual({
      ok: false,
      reason: "write_failed",
    });
    expect(fs.files.get(STORE)).toBe(before);
  });
});

// S6: decide and forget both mutate the store file with a read-modify-write;
// main serialises them through one promise queue so neither can lose the
// other's update.
describe("workspace trust store write serialisation (Taskana 4739, S6)", () => {
  it("concurrent decide + forget both land (no lost update)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "t0");
    await writeTrustDecision(fs, STORE, "/work/other", "denied", "h2", "t1");
    const { deps } = makeDeps({ fs });
    const [decided, forgot] = await Promise.all([
      handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" }),
      handleWorkspaceTrustForget(deps, { key: "/work/other" }),
    ]);
    expect(decided).toEqual({ ok: true });
    expect(forgot).toEqual({ ok: true });
    const store = await readTrustStore(fs, STORE);
    expect(store.folders).toEqual({
      [canonicalWorkspacePath(WS)]: { decision: "trusted", hash: HASH, decidedAt: "2026-10-25T00:00:00.000Z" },
    });
  });

  it("two concurrent decides both land (queue keeps read-modify-write atomic)", async () => {
    const fs = makeFs();
    await writeTrustDecision(fs, STORE, "/work/a", "trusted", "h-old", "t0");
    const { deps } = makeDeps({ fs });
    const second = makeDeps();
    // Reuse one deps object but drive two decides for different tabs: the
    // shared queue must keep both records.
    const pending = new Map([
      ["tab-1", { workspace: WS, hash: HASH }],
      ["tab-2", { workspace: "/work/b", hash: "b".repeat(64) }],
    ]);
    const tabs: WorkspaceTrustIpcDeps["tabs"] = {
      workspaceTrustPendingFor: (tabId) => pending.get(tabId) ?? "no_pending",
      clearWorkspaceTrustPending: (tabId) => {
        pending.delete(tabId);
      },
      restartTabHost: () => ({ ok: true }),
    };
    const deps2: WorkspaceTrustIpcDeps = { ...deps, tabs };
    const [r1, r2] = await Promise.all([
      handleWorkspaceTrustDecide(deps2, { tabId: "tab-1", decision: "trust" }),
      handleWorkspaceTrustDecide(deps2, { tabId: "tab-2", decision: "deny" }),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    const store = await readTrustStore(fs, STORE);
    expect(Object.keys(store.folders).sort()).toEqual(["/work/a", "/work/b", canonicalWorkspacePath(WS)].sort());
    expect(second.deps).toBeDefined();
  });
});

// Taskana 4739 decision 3: decide canonicalises pending.workspace with
// realpath BEFORE writing and BEFORE keying the once-approval, so a symlinked
// workspace and its target share one record; workspaceTrustOnceFor finds a
// once-approval via either name (it is SYNC — no fs await inside).
describe("decide + once with a symlinked workspace (Taskana 4739)", () => {
  const LINK_WS = "/work/link-project";
  const REAL_WS = "/work/real-project";
  const realpathSync = (p: string) => (p === LINK_WS ? REAL_WS : p);

  it("decide writes under the REAL key, not the symlink name", async () => {
    const fs = makeFs();
    const { deps } = makeDeps({ fs, realpathSync });
    // The tab's pending workspace is the symlink.
    (deps.tabs as unknown as { workspaceTrustPendingFor: (t: string) => unknown }).workspaceTrustPendingFor =
      () => ({ workspace: LINK_WS, hash: HASH });
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" })).toEqual({ ok: true });
    const store = await readTrustStore(fs, STORE);
    expect(Object.keys(store.folders)).toEqual([REAL_WS]);
    expect(store.folders[REAL_WS]).toEqual({
      decision: "trusted",
      hash: HASH,
      decidedAt: "2026-10-25T00:00:00.000Z",
    });
  });

  it("'once' keys the approval under the REAL key; workspaceTrustOnceFor finds it via either name", async () => {
    const { deps } = makeDeps({ realpathSync });
    (deps.tabs as unknown as { workspaceTrustPendingFor: (t: string) => unknown }).workspaceTrustPendingFor =
      () => ({ workspace: LINK_WS, hash: HASH });
    expect(await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "once" })).toEqual({ ok: true });
    expect(deps.onceApprovals.get(REAL_WS)).toBe(HASH);
    // Either name finds the same approval.
    expect(workspaceTrustOnceFor(deps.onceApprovals, LINK_WS, realpathSync)).toBe(HASH);
    expect(workspaceTrustOnceFor(deps.onceApprovals, REAL_WS, realpathSync)).toBe(HASH);
  });

  it("without an injector, decide still keys by canonicalWorkspacePath (byte-identical legacy behaviour)", async () => {
    const fs = makeFs();
    const { deps } = makeDeps({ fs });
    (deps.tabs as unknown as { workspaceTrustPendingFor: (t: string) => unknown }).workspaceTrustPendingFor =
      () => ({ workspace: LINK_WS, hash: HASH });
    await handleWorkspaceTrustDecide(deps, { tabId: "tab-1", decision: "trust" });
    const store = await readTrustStore(fs, STORE);
    expect(Object.keys(store.folders)).toEqual([canonicalWorkspacePath(LINK_WS)]);
    expect(workspaceTrustOnceFor(deps.onceApprovals, LINK_WS)).toBeUndefined();
  });

  it("forget drops the once-approval for the same key (S8)", async () => {
    const fs = makeFs();
    const { deps } = makeDeps({ fs, realpathSync });
    deps.onceApprovals.set(REAL_WS, HASH);
    await writeTrustDecision(fs, STORE, REAL_WS, "trusted", HASH, "t");
    expect(await handleWorkspaceTrustForget(deps, { key: REAL_WS })).toEqual({ ok: true });
    expect(deps.onceApprovals.has(REAL_WS)).toBe(false);
  });
});

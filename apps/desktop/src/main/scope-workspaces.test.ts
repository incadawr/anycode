/**
 * Taskana 4758: unit tests for the Settings scope workspace registry, run off
 * a fake deps bag (no disk, no persistence). The fake filesystem is a set of
 * existing directories plus a symlink map; realpath throws for missing paths
 * so canonicalWorkspaceKey takes its documented fallback.
 */
import { describe, expect, it } from "vitest";
import { createScopeWorkspaceRegistry, displayPathFor, workspaceIdFor, type ScopeRecentSession } from "./scope-workspaces.js";

const HOME = "/Users/x";

interface FakeOpts {
  dirs?: string[];
  links?: Record<string, string>;
  sessions?: ScopeRecentSession[];
  listThrows?: boolean;
  tabs?: { tabId: string; workspace: string }[];
}

function makeRegistry(opts: FakeOpts = {}) {
  const dirs = new Set(opts.dirs ?? []);
  const links = opts.links ?? {};
  const state = { sessions: opts.sessions ?? [], tabs: opts.tabs ?? [] };
  const realpathSync = (p: string): string => {
    if (links[p] !== undefined) return links[p];
    if (dirs.has(p)) return p;
    throw new Error(`ENOENT: ${p}`);
  };
  const isDir = (p: string) => {
    const real = links[p] ?? p;
    if (!dirs.has(real)) throw new Error(`ENOENT: ${p}`);
    return { isDirectory: () => true };
  };
  const registry = createScopeWorkspaceRegistry({
    listRootSessions: async () => {
      if (opts.listThrows) throw new Error("db down");
      return state.sessions;
    },
    openTabs: () => state.tabs,
    realpathSync,
    stat: async (p) => isDir(p),
    statSync: (p) => isDir(p),
    homedir: () => HOME,
    now: () => 0,
  });
  return { registry, state, dirs, realpathSync };
}

const session = (workspace: string, updatedAt: number, extra: Partial<ScopeRecentSession> = {}): ScopeRecentSession => ({
  workspace,
  updatedAt,
  ...extra,
});

describe("scope workspace registry (Taskana 4758)", () => {
  it("lists open-tab folders first, then recents by newest updatedAt, deduped", async () => {
    const { registry } = makeRegistry({
      dirs: ["/w/a", "/w/b", "/w/c"],
      tabs: [{ tabId: "t1", workspace: "/w/b" }],
      sessions: [session("/w/a", 10), session("/w/c", 30), session("/w/b", 99)],
    });
    const names = (await registry.list()).map((e) => e.name);
    expect(names).toEqual(["b", "c", "a"]);
  });

  it("caps recents at 12 and total at 24 with every open tab included", async () => {
    const dirs = Array.from({ length: 30 }, (_, i) => `/r/f${i}`);
    const tabs = Array.from({ length: 3 }, (_, i) => ({ tabId: `t${i}`, workspace: `/o/t${i}` }));
    const { registry } = makeRegistry({
      dirs: [...dirs, "/o/t0", "/o/t1", "/o/t2"],
      tabs,
      sessions: dirs.map((d, i) => session(d, i)),
    });
    const list = await registry.list();
    expect(list.filter((e) => e.tabIds.length > 0)).toHaveLength(3);
    expect(list.length).toBe(15);
    const many = Array.from({ length: 30 }, (_, i) => `/t/tab${i}`);
    const big = makeRegistry({
      dirs: [...many, ...dirs],
      tabs: many.map((d, i) => ({ tabId: `x${i}`, workspace: d })),
      sessions: dirs.map((d, i) => session(d, i)),
    });
    expect((await big.registry.list()).length).toBe(24);
  });

  it("uses root sessions only and maps worktree sessions to projectRoot; symlink and trailing slash collapse", async () => {
    const { registry } = makeRegistry({
      dirs: ["/real/app", "/wt/app", "/real/other"],
      links: { "/link/app": "/real/app" },
      sessions: [
        session("/wt/app", 50, { worktree: { path: "/wt/app" }, projectRoot: "/real/app" }),
        session("/link/app", 40),
        session("/real/app/", 30),
        session("/real/other", 20),
      ],
    });
    const list = await registry.list();
    expect(list.map((e) => e.name)).toEqual(["app", "other"]);
    expect(list[0]!.id).toBe(workspaceIdFor("/real/app", (p) => p));
  });

  it("gives distinct ids and displayPaths to folders with the same basename", async () => {
    const { registry } = makeRegistry({
      dirs: ["/Users/x/work/app", "/Users/x/old/app"],
      sessions: [session("/Users/x/work/app", 2), session("/Users/x/old/app", 1)],
    });
    const list = await registry.list();
    expect(list[0]!.id).not.toBe(list[1]!.id);
    expect(list.map((e) => e.displayPath)).toEqual(["~/work/app", "~/old/app"]);
  });

  it("id is ws_ + 16 hex, stable across calls for the same canonical key", () => {
    const id = workspaceIdFor("/Users/x/work/app", (p) => p);
    expect(id).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(workspaceIdFor("/Users/x/work/app/", (p) => p)).toBe(id);
  });

  it("returns a deleted folder as exists:false and does not resolve its id", async () => {
    const { registry, dirs } = makeRegistry({ dirs: ["/gone"], sessions: [session("/gone", 1)] });
    // Folder is listed while it exists, then deleted.
    const first = await registry.list();
    expect(first[0]!.exists).toBe(true);
    dirs.clear();
    const list = await registry.list();
    expect(list[0]).toMatchObject({ name: "gone", exists: false });
    expect(registry.resolve(list[0]!.id, () => undefined)).toBeUndefined();
  });

  it("resolve: tab id => tab workspace; ws_ from list => path; unknown ws_ => undefined; traversal/empty => undefined", async () => {
    const { registry } = makeRegistry({
      dirs: ["/w/recent"],
      tabs: [{ tabId: "tab-1", workspace: "/w/open" }],
      sessions: [session("/w/recent", 1)],
    });
    const tabWorkspace = (tabId: string) => (tabId === "tab-1" ? "/w/open" : undefined);
    const list = await registry.list();
    const recent = list.find((e) => e.name === "recent")!;
    expect(registry.resolve("tab-1", tabWorkspace)).toBe("/w/open");
    expect(registry.resolve(recent.id, tabWorkspace)).toBe("/w/recent");
    expect(registry.resolve("ws_0000000000000000", tabWorkspace)).toBeUndefined();
    expect(registry.resolve(undefined, tabWorkspace)).toBeUndefined();
    expect(registry.resolve("../etc", tabWorkspace)).toBeUndefined();
    expect(registry.resolve("/etc/passwd", tabWorkspace)).toBeUndefined();
    expect(registry.resolve("ws_../..", tabWorkspace)).toBeUndefined();
    expect(registry.resolve("", tabWorkspace)).toBeUndefined();
  });

  it("a folder that leaves recents stops resolving after the next list, unless a tab is open", async () => {
    const { registry, state } = makeRegistry({
      dirs: ["/w/a", "/w/b"],
      sessions: [session("/w/a", 1), session("/w/b", 2)],
    });
    const before = await registry.list();
    const idA = before.find((e) => e.name === "a")!.id;
    expect(registry.resolve(idA, () => undefined)).toBe("/w/a");
    state.sessions = [session("/w/b", 2)];
    await registry.list();
    expect(registry.resolve(idA, () => undefined)).toBeUndefined();
    state.tabs = [{ tabId: "t", workspace: "/w/a" }];
    await registry.list();
    expect(registry.resolve(idA, () => undefined)).toBe("/w/a");
  });

  it("listRootSessions rejecting lists only open tabs; no sessions and no tabs gives []", async () => {
    const failing = makeRegistry({
      dirs: ["/w/open", "/w/recent"],
      listThrows: true,
      tabs: [{ tabId: "t", workspace: "/w/open" }],
      sessions: [session("/w/recent", 1)],
    });
    const list = await failing.registry.list();
    expect(list.map((e) => e.name)).toEqual(["open"]);
    const empty = makeRegistry({});
    expect(await empty.registry.list()).toEqual([]);
  });

  it("collapses the home directory in displayPath and leaves other paths unchanged", () => {
    expect(displayPathFor("/Users/x/work/app", HOME)).toBe("~/work/app");
    expect(displayPathFor("/opt/app", HOME)).toBe("/opt/app");
    expect(displayPathFor("/Users/xy/app", HOME)).toBe("/Users/xy/app");
  });

  it("a tab id that looks like ws_ but is unknown resolves to undefined", () => {
    const { registry } = makeRegistry({ tabs: [] });
    expect(registry.resolve("ws_deadbeefdeadbeef", () => "/should/not/leak")).toBeUndefined();
  });
});

/**
 * GitHub #17 slice E: answering a CHILD session's permission
 * ask from the parent's window. These tests drive the REAL production
 * selectors and response helpers with injected stores/senders — no React, no
 * DOM, no singleton stores.
 */
import { describe, expect, it } from "vitest";
import {
  collectChildPermissions,
  respondChildPermission,
  selectForwardedChildPermission,
  subscribeChildPermissions,
  type ChildPermissionOwner,
  type ChildPermissionStore,
  type ChildPermissionStoreView,
} from "./child-permissions.js";
import { childRelationKey, type ChildRelation } from "./child-sessions.js";
import type { PermissionUiRequest } from "./store.js";

const PARENT = "parent-1";

function ask(requestId: string, toolName = "Write"): PermissionUiRequest {
  return {
    requestId,
    toolName,
    input: { file_path: "/workspace/gh17-allow.txt" },
    mode: "build",
    metadata: { riskLevel: "medium", destructive: false, readOnly: false, needsApproval: true },
  } as unknown as PermissionUiRequest;
}

/** A store double whose state can be mutated and whose subscribe fans out. */
function store(initial: Partial<ChildPermissionStoreView> = {}) {
  const listeners = new Set<() => void>();
  let state: ChildPermissionStoreView = {
    permission: null,
    connection: "ready",
    engine: null,
    workspace: "/workspace",
    ...initial,
  };
  return {
    store: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as ChildPermissionStore & { subscribe: (listener: () => void) => () => void },
    set(patch: Partial<ChildPermissionStoreView>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function relations(entries: Array<{ spawnToolCallId: string; childTabId: string; childSessionId?: string; live?: boolean }>) {
  const map = new Map<string, ChildRelation>();
  for (const entry of entries) {
    map.set(childRelationKey(PARENT, entry.spawnToolCallId), {
      childTabId: entry.childTabId,
      childSessionId: entry.childSessionId ?? `child-${entry.childTabId}`,
      live: entry.live ?? true,
    });
  }
  return map;
}

describe("collectChildPermissions (GitHub #17 slice E)", () => {
  it("returns every live child with a pending ask, in registration order", () => {
    const a = store({ permission: ask("req-a") });
    const b = store({ permission: ask("req-b") });
    const stores = new Map<string, ReturnType<typeof store>>([
      ["tabA", a],
      ["tabB", b],
    ]);
    const owners = collectChildPermissions(
      PARENT,
      relations([
        { spawnToolCallId: "call-a", childTabId: "tabA" },
        { spawnToolCallId: "call-b", childTabId: "tabB" },
      ]),
      (tabId) => stores.get(tabId)?.store,
    );
    expect(owners.map((owner) => [owner.childTabId, owner.request.requestId, owner.spawnToolCallId])).toEqual([
      ["tabA", "req-a", "call-a"],
      ["tabB", "req-b", "call-b"],
    ]);
  });

  it("ignores a foreign parent whose id merely shares a prefix", () => {
    const map = new Map<string, ChildRelation>([
      [childRelationKey("parent-10", "call-x"), { childTabId: "tabX", childSessionId: "child-x", live: true }],
    ]);
    const stores = new Map([["tabX", store({ permission: ask("req-x") })]]);
    expect(
      collectChildPermissions(PARENT, map, (tabId) => stores.get(tabId)?.store),
    ).toEqual([]);
  });

  it("skips gone children, missing stores, unready connections and settled asks", () => {
    const gone = store({ permission: ask("req-gone") });
    const unready = store({ permission: ask("req-unready"), connection: "awaiting_port" });
    const settled = store();
    const stores = new Map<string, ReturnType<typeof store>>([
      ["tabGone", gone],
      ["tabUnready", unready],
      ["tabSettled", settled],
    ]);
    const owners = collectChildPermissions(
      PARENT,
      relations([
        { spawnToolCallId: "call-gone", childTabId: "tabGone", live: false },
        { spawnToolCallId: "call-unready", childTabId: "tabUnready" },
        { spawnToolCallId: "call-settled", childTabId: "tabSettled" },
        { spawnToolCallId: "call-missing", childTabId: "tabMissing" },
      ]),
      (tabId) => stores.get(tabId)?.store,
    );
    expect(owners).toEqual([]);
  });
});

describe("selectForwardedChildPermission (GitHub #17 slice E)", () => {
  const owner = (spawnToolCallId: string): ChildPermissionOwner => ({
    childTabId: `tab-${spawnToolCallId}`,
    childSessionId: `child-${spawnToolCallId}`,
    spawnToolCallId,
    request: ask(`req-${spawnToolCallId}`),
  });

  it("the root's own ask always wins", () => {
    expect(
      selectForwardedChildPermission({ rootHasOwnPermission: true, owners: [owner("a")], displayedChildSpawnToolCallIds: [] }),
    ).toBeNull();
  });

  it("an expanded child's own dialog wins over forwarding; a COLLAPSED child is still forwarded", () => {
    expect(
      selectForwardedChildPermission({
        rootHasOwnPermission: false,
        owners: [owner("a"), owner("b")],
        displayedChildSpawnToolCallIds: ["a"],
      })?.spawnToolCallId,
    ).toBe("b");
    expect(
      selectForwardedChildPermission({
        rootHasOwnPermission: false,
        owners: [owner("a")],
        displayedChildSpawnToolCallIds: ["a"],
      }),
    ).toBeNull();
  });

  it("shows one ask at a time in registration order", () => {
    expect(
      selectForwardedChildPermission({
        rootHasOwnPermission: false,
        owners: [owner("a"), owner("b")],
        displayedChildSpawnToolCallIds: [],
      })?.spawnToolCallId,
    ).toBe("a");
  });
});

describe("respondChildPermission (GitHub #17 slice E)", () => {
  it("sends the response ONLY to that child's tab, with its real requestId", () => {
    const a = store({ permission: ask("req-a", "Write") });
    const b = store({ permission: ask("req-b", "Bash") });
    const stores = new Map([["tabA", a], ["tabB", b]]);
    const sent: Array<{ tabId: string; message: unknown }> = [];
    const owner = collectChildPermissions(PARENT, relations([{ spawnToolCallId: "call-a", childTabId: "tabA" }]), (id) => stores.get(id)?.store)[0]!;

    expect(
      respondChildPermission(owner, "allow", (id) => stores.get(id)?.store, (tabId, message) => sent.push({ tabId, message })),
    ).toBe(true);
    expect(sent).toEqual([
      { tabId: "tabA", message: { type: "permission_response", requestId: "req-a", behavior: "allow" } },
    ]);
    // The sibling's ask is untouched.
    expect(b.store.getState().permission?.requestId).toBe("req-b");
  });

  it("carries a remember pattern for an allow and never for a deny", () => {
    const a = store({ permission: ask("req-a") });
    const stores = new Map([["tabA", a]]);
    const owner = collectChildPermissions(PARENT, relations([{ spawnToolCallId: "call-a", childTabId: "tabA" }]), (id) => stores.get(id)?.store)[0]!;
    const sent: unknown[] = [];
    const send = (_tabId: string, message: unknown) => sent.push(message);

    respondChildPermission(owner, "allow", (id) => stores.get(id)?.store, send, { pattern: "gh17-*.txt" });
    respondChildPermission(owner, "deny", (id) => stores.get(id)?.store, send);
    expect(sent).toEqual([
      { type: "permission_response", requestId: "req-a", behavior: "allow", remember: { pattern: "gh17-*.txt" } },
      { type: "permission_response", requestId: "req-a", behavior: "deny" },
    ]);
  });

  it("refuses a stale click after settlement or after a NEWER ask replaced it", () => {
    const a = store({ permission: ask("req-old") });
    const stores = new Map([["tabA", a]]);
    const owner: ChildPermissionOwner = {
      childTabId: "tabA",
      childSessionId: "child-tabA",
      spawnToolCallId: "call-a",
      request: ask("req-old"),
    };
    const sent: unknown[] = [];
    const send = (_tabId: string, message: unknown) => sent.push(message);
    const getStore = (id: string) => stores.get(id)?.store;

    a.set({ permission: null });
    expect(respondChildPermission(owner, "allow", getStore, send)).toBe(false);
    // A newer ask with a different id must not be answered by the old dialog.
    a.set({ permission: ask("req-new") });
    expect(respondChildPermission(owner, "allow", getStore, send)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("two children using identical requestIds stay isolated by child tab", () => {
    const a = store({ permission: ask("req-same") });
    const b = store({ permission: ask("req-same") });
    const stores = new Map([["tabA", a], ["tabB", b]]);
    const owner: ChildPermissionOwner = {
      childTabId: "tabB",
      childSessionId: "child-tabB",
      spawnToolCallId: "call-b",
      request: ask("req-same"),
    };
    const sent: Array<{ tabId: string; message: unknown }> = [];
    expect(
      respondChildPermission(owner, "deny", (id) => stores.get(id)?.store, (tabId, message) => sent.push({ tabId, message })),
    ).toBe(true);
    expect(sent.map((entry) => entry.tabId)).toEqual(["tabB"]);
  });

  it("a gone child store is a refusal, never a throw", () => {
    const owner: ChildPermissionOwner = {
      childTabId: "tabGone",
      childSessionId: "child-gone",
      spawnToolCallId: "call-gone",
      request: ask("req-gone"),
    };
    expect(respondChildPermission(owner, "allow", () => undefined, () => {})).toBe(false);
  });
});

describe("subscribeChildPermissions (GitHub #17 slice E)", () => {
  it("emits on ask, on settlement and on exit, and cleans every listener up", () => {
    const a = store();
    const stores = new Map([["tabA", a]]);
    const rel = relations([{ spawnToolCallId: "call-a", childTabId: "tabA" }]);
    const seen: Array<readonly ChildPermissionOwner[]> = [];
    const unsubscribe = subscribeChildPermissions(PARENT, rel, (id) => stores.get(id)?.store, (owners) => seen.push(owners));
    // Immediate compute on subscribe (no ask yet).
    expect(seen).toHaveLength(1);

    a.set({ permission: ask("req-a") });
    expect(seen.at(-1)?.map((owner) => owner.request.requestId)).toEqual(["req-a"]);

    a.set({ permission: null });
    expect(seen.at(-1)).toEqual([]);

    expect(a.listenerCount()).toBe(1);
    a.set({ connection: "host_exited" });
    expect(seen.length).toBeGreaterThanOrEqual(4);

    unsubscribe();
    expect(a.listenerCount()).toBe(0);
    a.set({ permission: ask("req-late") });
    expect(seen.at(-1)).toEqual([]);
  });

  it("re-created relations do not duplicate listeners or emissions", () => {
    const a = store();
    const stores = new Map([["tabA", a]]);
    const first = relations([{ spawnToolCallId: "call-a", childTabId: "tabA" }]);
    let emissions = 0;
    const unsubscribeFirst = subscribeChildPermissions(PARENT, first, (id) => stores.get(id)?.store, () => {
      emissions += 1;
    });
    unsubscribeFirst();
    // A re-registration builds a NEW relation map; the old subscription is gone.
    const second = relations([{ spawnToolCallId: "call-a", childTabId: "tabA" }]);
    const unsubscribeSecond = subscribeChildPermissions(PARENT, second, (id) => stores.get(id)?.store, () => {
      emissions += 1;
    });
    expect(a.listenerCount()).toBe(1);
    const before = emissions;
    a.set({ permission: ask("req-a") });
    expect(emissions).toBe(before + 1);
    unsubscribeSecond();
    expect(a.listenerCount()).toBe(0);
  });
});

/**
 * Renderer-side child-session relation registry (TASK.102 CUT-S2 §2.5, slice
 * S2c C1). Two independent concerns live here:
 *
 *  - `classifyPortEnvelope` decides, for an incoming port-delivery envelope
 *    (`shared/envelopes.ts`'s `PortEnvelope`), whether it belongs to an
 *    ordinary root tab or to a child session. This is the branch condition
 *    `tab-registry.ts`'s `registerPort` (slice C2) must gate on BEFORE its
 *    existing root-tab bootstrap (`tabsStore.addTab`, the R10 status mirror,
 *    the P7.14 prompt-queue drainer) — today ANY delivered port takes that
 *    path unconditionally (tab-registry.ts:415), which is exactly the facade
 *    CUT-S2 §5.3 warns about: a child session that "works" but also shows up
 *    in the Sidebar, violating the skip-hide contract (design §0.4).
 *  - The child relation-store tracks, for every child tab this renderer has
 *    registered a port for, the `(parentSessionId, spawnToolCallId) ->
 *    {childTabId, childSessionId, live}` mapping (§2.5's exact shape). This
 *    is the lookup C3's "Open" button and breadcrumb-return path use: given
 *    the master's Agent tool_call (identified by its own toolCallId, which
 *    IS the spawnToolCallId) and its own sessionId, find the live child tab
 *    to switch the layout view onto (child-layout.ts, the sibling module).
 *    `live` flips to false on the child host's exit (§0's "reap immediately"
 *    verdict) — Open keeps working afterwards through the read-only C4
 *    history channel, but there is no more live port to route a composer
 *    send to.
 *
 * Pure module + vanilla zustand store, mirroring tab-status-store.ts's
 * factory-plus-singleton shape: `createChildRelationStore()` for test
 * isolation, `childRelationStore` for the app. No DOM, no JSX — C3 (App.tsx/
 * ToolCallCard.tsx) is the only place this state reaches the screen.
 */
import { create } from "zustand";
import type { PortEnvelope } from "../../shared/envelopes.js";

/** What `classifyPortEnvelope` returns: which registration path an incoming port envelope should take. */
export type PortEnvelopeKind = "root" | "child";

/**
 * Classifies a port-delivery envelope by the presence of its `child` field
 * (stamped by `deliverTabPort` for a child tab, S2b — absent, unchanged, for
 * every root-tab envelope today). Takes only the one field it reads so a
 * test can hand it a minimal fixture without constructing a full
 * `PortEnvelope`.
 */
export function classifyPortEnvelope(envelope: Pick<PortEnvelope, "child">): PortEnvelopeKind {
  return envelope.child === undefined ? "root" : "child";
}

/**
 * Composite key for the relation-store map: one child session is uniquely
 * identified by which (parent session, Agent tool call) spawned it — the
 * SAME pair persistence's unique index `(parent_session_id,
 * spawn_tool_call_id)` enforces (CUT-S2 §2.4's migration v13). Exported so
 * callers that only have the two ids (no full `ChildRelation` yet) can probe
 * `relations` directly without duplicating the join logic.
 */
export function childRelationKey(parentSessionId: string, spawnToolCallId: string): string {
  return `${parentSessionId}\u0000${spawnToolCallId}`;
}

/** One master<->child link, as tracked by this renderer for the lifetime of the child tab. */
export interface ChildRelation {
  childTabId: string;
  childSessionId: string;
  /**
   * False once the child host has exited (main's reap-on-terminal, CUT-S2
   * §0). The relation entry is NOT removed at that point — Open on a
   * completed child still resolves through this same map, it just routes to
   * the read-only history channel (C4) instead of a live port.
   */
  live: boolean;
}

export interface ChildRelationState {
  /** `childRelationKey(parentSessionId, spawnToolCallId) -> ChildRelation`. REPLACED (new Map) on every real write; never mutated in place (matches tab-status-store.ts's discipline). */
  relations: ReadonlyMap<string, ChildRelation>;

  /**
   * Records (or re-records, on a respawn/duplicate port delivery) a live
   * child relation. Re-registering an existing key resets `live` to true —
   * a fresh port delivery for a known (parent, spawn) pair means the child
   * is live again by construction (main only delivers a child port for a
   * running host).
   */
  registerChild(parentSessionId: string, spawnToolCallId: string, childTabId: string, childSessionId: string): void;

  /**
   * Flips `live` to false for the relation whose `childTabId` matches.
   * Deliberately keyed by childTabId, not by (parentSessionId,
   * spawnToolCallId): the host-exit signal this feeds from (`HostExitedEnvelope`,
   * shared/envelopes.ts) only ever carries a tabId, never a parent/spawn pair —
   * mirroring main's own correlation discipline (CUT-S2 §2.3 header: child
   * messages are correlated SOLELY by sender process/tabId, never by an id
   * riding the payload). No-op — no Map rebuild, no store notification — for
   * an unknown tabId or a relation that is already `live: false`.
   */
  markChildGone(childTabId: string): void;

  /**
   * Removes every relation whose key names `parentSessionId` — live or not
   * (F11, review-wave R). A relation deliberately outlives its child's own
   * host exit (`live` just flips false, see `ChildRelation.live`'s own doc)
   * because Open must keep resolving through it for as long as the PARENT
   * root tab is still open. But nothing removed it AT ALL, ever — the only
   * plausible removal trigger, a child's own `disposeTab`, is unreachable
   * (`closeTab` rejects a child tabId by construction, main/tabs.ts's
   * `closeTab`: `tab.childOf !== undefined` -> `unknown_tab`), so relations
   * for a long-dead root tab sat in this Map for the rest of the process's
   * life. The real boundary was always the PARENT's own lifetime: once its
   * root tab is disposed, none of its children can ever be Opened again, so
   * this is wired into `tab-registry.ts`'s `disposeTab` for the closing root
   * tab's own sessionId.
   */
  removeRelationsForParentSession(parentSessionId: string): void;

  /** Looks up the relation for one (parentSessionId, spawnToolCallId) pair, or undefined if this renderer has never seen a port for that child. */
  getRelation(parentSessionId: string, spawnToolCallId: string): ChildRelation | undefined;

  /** Test-only escape hatch, mirroring tab-registry.ts's/tab-status-store.ts's own `reset()`. Production code never calls this. */
  reset(): void;
}

/** Builds a child-relation store instance; the factory exists so tests get an isolated store instead of sharing the singleton (mirrors createTabStatusStore). */
export function createChildRelationStore() {
  return create<ChildRelationState>()((set, get) => ({
    relations: new Map<string, ChildRelation>(),

    registerChild(parentSessionId, spawnToolCallId, childTabId, childSessionId): void {
      const relations = new Map(get().relations);
      relations.set(childRelationKey(parentSessionId, spawnToolCallId), { childTabId, childSessionId, live: true });
      set({ relations });
    },

    markChildGone(childTabId): void {
      const match = [...get().relations].find(([, relation]) => relation.childTabId === childTabId);
      if (match === undefined || !match[1].live) {
        return;
      }
      const [key, relation] = match;
      const relations = new Map(get().relations);
      relations.set(key, { ...relation, live: false });
      set({ relations });
    },

    removeRelationsForParentSession(parentSessionId): void {
      // childRelationKey's own format (`${parentSessionId}\u0000${spawnToolCallId}`)
      // — the NUL delimiter makes this prefix match exact, never a false
      // positive between e.g. "session-A" and "session-AB".
      const prefix = `${parentSessionId}\u0000`;
      const keysToRemove = [...get().relations.keys()].filter((key) => key.startsWith(prefix));
      if (keysToRemove.length === 0) {
        return;
      }
      const relations = new Map(get().relations);
      for (const key of keysToRemove) {
        relations.delete(key);
      }
      set({ relations });
    },

    getRelation(parentSessionId, spawnToolCallId): ChildRelation | undefined {
      return get().relations.get(childRelationKey(parentSessionId, spawnToolCallId));
    },

    reset(): void {
      set({ relations: new Map<string, ChildRelation>() });
    },
  }));
}

export type ChildRelationStoreApi = ReturnType<typeof createChildRelationStore>;

/** The app's single child-relation store (mirrors tab-status-store.ts's `useTabStatusStore`). */
export const childRelationStore = createChildRelationStore();

/**
 * Whether an Agent tool_call card should show the session-child BADGE and
 * Open ACTION (TASK.102 CUT-S2 §2.5's full visibility rule, ratified in
 * final normative form by §10.8.1 point 3): true iff EITHER
 *  - a relation exists (live or not — an already-gone child still resolves
 *    through the same map, §0's "reap immediately" doc on `ChildRelation.live`),
 *    i.e. THIS renderer has, at some point in its process lifetime,
 *    registered a port for the child this card's `spawnToolCallId` names; OR
 *  - `hydratedSessionChild` is true — the terminal S1 snapshot this card was
 *    hydrated from carries `target.kind === "session"` (`SubagentSubStatus
 *    .sessionChild`, store.ts/subagent-card.ts, §10.8.1 point 1). This is the
 *    restart case: a fresh renderer process has an EMPTY relation-store by
 *    construction, so the only way to know "this Agent call spawned a child"
 *    is the durable snapshot itself — the second branch of §2.5's rule, which
 *    this signature's single-argument predecessor (documented as a known gap)
 *    could not express.
 *
 * An inline subagent's card satisfies neither disjunct (no relation was ever
 * registered, and its snapshot's target is `"inline"`), so this stays false
 * for the overwhelmingly common case with no extra tier check needed.
 *
 * The Open ACTION is now UNCONDITIONAL once this returns true — C4 builds a
 * read-only surface for a non-live/never-live child (§10.8.1 point 3: "the
 * dead click from C3's doc comment stops existing"), so ToolCallCard.tsx no
 * longer needs a stronger `.live` guard on top of this predicate. The badge
 * itself stays honest either way — the card's settled status
 * (running/done/error/waiting_permission) doesn't depend on whether this
 * renderer still has a live port for it.
 */
export function hasOpenableChild(relation: ChildRelation | undefined, hydratedSessionChild: boolean): boolean {
  return relation !== undefined || hydratedSessionChild;
}

/**
 * Renderer-side layout B logic for a root tab's master<->child surface
 * switching (TASK.102 CUT-S2 §2.5, slice S2c C1). Three pure concerns:
 *
 *  - `ChildLayoutView` + the `openChild`/`closeChild`/`onChildGone` reducer
 *    trio: which surface a root tab's pane currently shows — its own master
 *    transcript, or one of its children's (live or completed) transcript.
 *    One root tab shows at most one child at a time (§2.4.1's 3-per-parent
 *    admission cap bounds how many children CAN exist, not how many are
 *    open at once — layout B never splits the pane). All three functions
 *    are `(view, ...) => view`: pure state transitions with no store of
 *    their own — C2/C3 wire this into wherever they choose to hold the
 *    per-tab view (a new tabs-store field, most likely), the same way
 *    tab-status-store.ts's `deriveCoarse`/`isTurnCompletion` are pure
 *    projections a store's own actions call, not stores themselves.
 *  - `childBadgeKind`: the ToolCallCard's Agent-card badge, collapsed to
 *    ONE of four kinds by the frozen priority order (§2.5): a card blocked
 *    on a permission ask outranks a running spinner, which outranks any
 *    terminal outcome. In practice `SubagentSubStatus.waiting` and `.final`
 *    are mutually exclusive by construction (`patchSubagentEnd`'s settle
 *    strips a stale `waiting`, store.ts §10.1) — this function still checks
 *    `waiting` FIRST and unconditionally, rather than falling through to
 *    `final`, so the priority is an explicit ordering this module owns, not
 *    an accident of the two fields never colliding upstream.
 *  - `buildChildBreadcrumb`: the "{masterTitle} › {agentType}" caption
 *    (§2.5's frozen formula, verbatim) for the child surface's breadcrumb.
 *    Takes the master's title and the Agent card's own agentType/description
 *    — NEVER a child-session name, because a child session has none (§0:
 *    `maybeDeriveTitle` is a no-op for a child-mode Session, §2.6.3). The
 *    function's signature enforces this structurally: there is no name-typed
 *    parameter to (mis)plumb one through.
 *
 * No DOM, no JSX — C3 (App.tsx/ToolCallCard.tsx) is the only place any of
 * this reaches the screen.
 *
 * C3 addendum: `childLayoutStore` below (a plain zustand store, mirroring
 * child-sessions.ts's own relation-store) is where C3 actually holds the
 * per-root-tab `ChildLayoutView` this header predicted ("a new tabs-store
 * field, most likely") — a store HERE instead, since tabs-store.ts/store.ts
 * are both out of C3's fence (CUT-S2 §10.1 froze store.ts; tabs-store.ts is
 * simply not in C3's file list). It exists outside React for the same reason
 * tab-registry.ts's entries do: App.tsx mounts only the ACTIVE root tab's
 * `ActiveTabBody`, so a plain `useState` would silently forget which child
 * was open every time the user switched away and back to that root tab.
 */
import { create } from "zustand";
import type { SubagentSubStatus } from "./store.js";

// ── layout view + reducer trio ──

/** A root tab's pane shows either its own master transcript, or one specific child's. */
export type ChildLayoutView = { kind: "master" } | { kind: "child"; spawnToolCallId: string };

/** The starting/default view for every root tab (before any child is ever opened). */
export const MASTER_VIEW: ChildLayoutView = { kind: "master" };

/**
 * Switches the pane onto the given child (the "Open" button, ToolCallCard.tsx
 * C3). Unconditional: opening a DIFFERENT child while already viewing one
 * simply retargets the pane — there is only ever one child surface visible
 * per root tab, so there is no prior state to reconcile against. Takes
 * `view` (unused) anyway to keep the trio's signatures uniform — all three
 * are `(view, ...) => view`, which is what lets a caller wire them
 * point-free into a single `set(state => ({view: openChild(state.view, id)}))`-
 * style action without special-casing this one.
 */
export function openChild(_view: ChildLayoutView, spawnToolCallId: string): ChildLayoutView {
  return { kind: "child", spawnToolCallId };
}

/** Switches the pane back to the master transcript (the breadcrumb's "back" click). Unconditional, like `openChild`. */
export function closeChild(_view: ChildLayoutView): ChildLayoutView {
  return MASTER_VIEW;
}

/**
 * Reacts to a child tab disappearing (host-exit -> `ChildRelation.live` flips
 * false, or the relation's tab is disposed outright). Reverts to master ONLY
 * when the pane was showing THAT child — a background child dying (or one of
 * a DIFFERENT sibling's, up to 3 per parent) must not yank the user out of
 * whichever child they're actually looking at. This is the discriminator
 * against a facade that reverts to master on ANY child-gone signal
 * regardless of which child it names.
 */
export function onChildGone(view: ChildLayoutView, spawnToolCallId: string): ChildLayoutView {
  if (view.kind === "child" && view.spawnToolCallId === spawnToolCallId) {
    return MASTER_VIEW;
  }
  return view;
}

// ── badge priority ──

/** The one badge kind an Agent tool_call card shows for its child, collapsed from `waiting`/`final` by `childBadgeKind`'s frozen priority. */
export type ChildBadgeKind = "waiting_permission" | "running" | "error" | "done";

/**
 * Collapses a subagent card's live `waiting`/`final` fields into the single
 * badge kind ToolCallCard.tsx renders, by the priority CUT-S2 §2.5 freezes:
 * `waiting_permission > running > error/done`. Takes only the two fields it
 * needs off `SubagentSubStatus` (`Pick`, not the whole type) so a test fixture
 * never has to fabricate turns/toolCalls/activity/etc. it doesn't care about.
 */
export function childBadgeKind(subagent: Pick<SubagentSubStatus, "waiting" | "final">): ChildBadgeKind {
  if (subagent.waiting === true) {
    return "waiting_permission";
  }
  if (subagent.final === null) {
    return "running";
  }
  return subagent.final.status === "error" ? "error" : "done";
}

// ── breadcrumb VM ──

/** The child surface's breadcrumb: "{masterTitle} › {agentType}" (§2.5, frozen formula) plus the card's description for a caller that wants a fuller caption (e.g. a tooltip) — the formula itself never grows past the two fields above. */
export interface ChildBreadcrumbVM {
  masterTitle: string;
  agentType: string;
  description: string;
  text: string;
}

/**
 * Builds the breadcrumb VM from the master tab's title and the Agent card's
 * own `agentType`/`description` (`Pick<SubagentSubStatus, ...>` — the same
 * card object `childBadgeKind` reads, so a caller with `block.subagent` in
 * hand can pass it straight through). `text` is the frozen "{masterTitle} ›
 * {agentType}" formula verbatim; `description` rides the VM unused by `text`
 * itself, never a child session name — a child session has none (§0).
 */
export function buildChildBreadcrumb(
  masterTitle: string,
  card: Pick<SubagentSubStatus, "agentType" | "description">,
): ChildBreadcrumbVM {
  return {
    masterTitle,
    agentType: card.agentType,
    description: card.description,
    text: `${masterTitle} › ${card.agentType}`,
  };
}

// ── per-root-tab layout store ──

/**
 * `rootTabId -> ChildLayoutView`: the persistent home for layout B's view
 * state (see the module doc comment's C3 addendum above). Method names
 * (`open`/`close`/`view`/`childGone`) are deliberately distinct in SHAPE from
 * the free `openChild`/`closeChild`/`onChildGone` functions above even though
 * they wrap them 1:1 — `store.getState().open(rootTabId, id)` vs the free
 * `openChild(view, id)` take different first arguments (a tabId vs a view),
 * so reusing the exact same name would invite a caller to mix them up.
 */
export interface ChildLayoutState {
  /** REPLACED (new Map) on every write; never mutated in place — matches every other store in this app (tab-status-store.ts, child-sessions.ts). */
  views: ReadonlyMap<string, ChildLayoutView>;
  /** The given root tab's current view; `MASTER_VIEW` for a tab this store has never heard from — every tab's implicit starting state, so `open`/`close`/`childGone` never need a seeding call first. */
  view(rootTabId: string): ChildLayoutView;
  /** Applies the pure `openChild` reducer for one root tab (the Open button, ToolCallCard.tsx C3). */
  open(rootTabId: string, spawnToolCallId: string): void;
  /** Applies the pure `closeChild` reducer for one root tab (the breadcrumb's master segment, App.tsx C3). */
  close(rootTabId: string): void;
  /**
   * Applies the pure `onChildGone` reducer for one root tab — wired to a
   * shown child's relation going `live:false` (App.tsx's self-heal effect,
   * C3). No-op (by the pure reducer's own contract, asserted by its own
   * tests above) unless that root tab was showing EXACTLY this child.
   */
  childGone(rootTabId: string, spawnToolCallId: string): void;
  /** Test-only escape hatch, mirroring every other store in this app. Production code never calls this. */
  reset(): void;
}

/** Builds a child-layout store instance; the factory exists so tests get an isolated store instead of sharing the singleton (mirrors createChildRelationStore/createTabStatusStore). */
export function createChildLayoutStore() {
  return create<ChildLayoutState>()((set, get) => ({
    views: new Map<string, ChildLayoutView>(),

    view(rootTabId): ChildLayoutView {
      return get().views.get(rootTabId) ?? MASTER_VIEW;
    },

    open(rootTabId, spawnToolCallId): void {
      const views = new Map(get().views);
      views.set(rootTabId, openChild(get().view(rootTabId), spawnToolCallId));
      set({ views });
    },

    close(rootTabId): void {
      const current = get().view(rootTabId);
      if (current.kind === "master") {
        return; // already MASTER_VIEW's implicit default — no write needed
      }
      const views = new Map(get().views);
      views.set(rootTabId, closeChild(current));
      set({ views });
    },

    childGone(rootTabId, spawnToolCallId): void {
      const current = get().view(rootTabId);
      const next = onChildGone(current, spawnToolCallId);
      if (next === current) {
        return; // true no-op — see onChildGone's own reference-equality doc
      }
      const views = new Map(get().views);
      views.set(rootTabId, next);
      set({ views });
    },

    reset(): void {
      set({ views: new Map<string, ChildLayoutView>() });
    },
  }));
}

export type ChildLayoutStoreApi = ReturnType<typeof createChildLayoutStore>;

/** The app's single child-layout store (mirrors child-sessions.ts's `childRelationStore`). */
export const childLayoutStore = createChildLayoutStore();

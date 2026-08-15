/**
 * Renderer-side layout logic for a root tab's master<->child surface
 * switching (TASK.102 CUT-S2 §2.5, slice S2c C1) — extended by CUT-S3 §2
 * (slice S3a) with a THIRD `ChildLayoutView` variant, `split`: the master
 * stays visible alongside a stack of up to `CHILD_SPLIT_MAX_ROWS` open
 * children (layouts C/D — CUT-S3 §0.1 rules these are ONE layout, not two:
 * the stack head's shape is a pure function of how many rows it holds,
 * `buildChildStackHead` below). Four pure concerns:
 *
 *  - `ChildLayoutView` + the reducer set (`openChild`/`closeChild`/
 *    `enterSplit`/`exitSplit`/`expandRow`): which surface a root tab's pane
 *    currently shows — its own master transcript, one child's full-pane view
 *    (layout B), or the split stack (layout C/D). Every reducer is
 *    `(view, ...) => view`: a pure state transition with no store of its
 *    own — C2/C3 wire this into wherever they choose to hold the per-tab
 *    view (a new tabs-store field, most likely), the same way
 *    tab-status-store.ts's `deriveCoarse`/`isTurnCompletion` are pure
 *    projections a store's own actions call, not stores themselves. A no-op
 *    call (CUT-S3 §2.2/§2.5) returns the SAME `view` reference — the three
 *    new C3 store methods below rely on this to skip a write entirely.
 *    (A third original reducer, `onChildGone`, originally rounded this out as a
 *    "bounce the pane back to master when its shown child goes non-live"
 *    self-heal effect. CUT-S2 §10.8.1 point 3 later RATIFIED that this
 *    bounce is replaced outright by C4's read-only branch — a shown child
 *    going non-live now just renders read-only instead of yanking the user
 *    back to master — so the reducer (and the store's `childGone` method
 *    wrapping it) were removed wholesale in the review-wave R fix for F12:
 *    both had zero call sites anywhere in App.tsx/ToolCallCard.tsx/
 *    tab-registry.ts, and the docstring describing a wired "App.tsx's
 *    self-heal effect" was never true.)
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
 *  - `buildChildStackHead` (CUT-S3 §2.4): the split stack's head VM — a
 *    single child's identity when the stack holds exactly one row, or a
 *    roster summary ("Subagents · {total} · {running} running") once a
 *    second child joins. The only NEW VM this slice adds — a per-row VM is
 *    deliberately NOT built (CUT-S3 §9 п.14): a row's `agentType`/`model`
 *    come straight off its own Agent card, its badge off `childBadgeKind`
 *    above, its counters off `formatSubagentCounters` (ToolCallCard.tsx,
 *    already exported/tested) — JSX composes these directly
 *    (App.tsx/ChildSplitPane.tsx). This module still never imports
 *    ToolCallCard.tsx: that file already imports THIS module, so importing
 *    it back would create a cycle (CUT-S2 §2.5's own note, reaffirmed by
 *    CUT-S3 §2.4).
 *
 * No DOM, no JSX — C3 (App.tsx/ToolCallCard.tsx/ChildSplitPane.tsx) is the
 * only place any of this reaches the screen.
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
 *
 * I4 (CUT-S3 §2.5, unchanged from S2): this module still imports exactly
 * `zustand` plus `import type` from `./store.js` — no `tab-registry.ts`, no
 * `child-sessions.ts`, no `child-history.ts`. Every split transition reads
 * and writes nothing but the `ChildLayoutView` it is handed.
 */
import { create } from "zustand";
import type { SubagentSubStatus } from "./store.js";

// ── layout view + reducer set ──

/** A root tab's pane shows its own master transcript, one child full-pane
 *  (layout B), or the master alongside a stack of children (split C/D). */
export type ChildLayoutView =
  | { kind: "master" }
  | { kind: "child"; spawnToolCallId: string }
  | {
      kind: "split";
      /** Stack rows, visual top-to-bottom insertion order; 1..CHILD_SPLIT_MAX_ROWS, unique. */
      order: readonly string[];
      /** Exactly one expanded row; MUST be a member of `order`. */
      expandedId: string;
    };

/**
 * The split stack's row cap (CUT-S3 §2.1) — intentionally equal to the
 * per-parent admission cap on RUNNING children (§2.4.1), but an independent
 * UI constant: a master's lifetime openable-child count can exceed three
 * (completed children stay openable, C4), the stack only bounds how many
 * are OPEN at once. Not a general panel manager (track law п.6, CUT-S3 §2.1).
 */
export const CHILD_SPLIT_MAX_ROWS = 3;

/** The starting/default view for every root tab (before any child is ever opened). */
export const MASTER_VIEW: ChildLayoutView = { kind: "master" };

/**
 * Switches the pane onto the given child (the "Open" button, ToolCallCard.tsx
 * C3) — CUT-S3 §2.2 widens this from a two-branch to a five-branch reducer,
 * mode-aware on `view.kind`:
 *
 *  - `master`/`child` → `{ kind: "child", spawnToolCallId }`, unconditionally
 *    — byte-identical to the pre-S3 behavior (opening a DIFFERENT child while
 *    already viewing one simply retargets the pane; there is only ever one
 *    child surface visible in layout B, so there is no prior state to
 *    reconcile against).
 *  - `split`, already expanded → the SAME `view` reference (no-op; the C3
 *    store method below uses this to skip a write).
 *  - `split`, already a collapsed row → re-expand it in place (`order`
 *    unchanged, only `expandedId` moves).
 *  - `split`, unseen id, room left → append the new row and expand it.
 *  - `split`, unseen id, stack full → deterministic eviction: the victim is
 *    the FIRST collapsed row (`order.find` in insertion order) — the
 *    expanded row is NEVER evicted (I2). The victim is removed, the new id
 *    appended, and it becomes the expanded row.
 *
 * Because `ToolCallCard.tsx`'s Open button already calls
 * `childLayoutStore.getState().open(rootTabId, id)` unconditionally, this
 * reducer alone makes Open mode-aware — no change needed at the call site.
 */
export function openChild(view: ChildLayoutView, spawnToolCallId: string): ChildLayoutView {
  if (view.kind !== "split") {
    return { kind: "child", spawnToolCallId };
  }
  if (spawnToolCallId === view.expandedId) {
    return view;
  }
  if (view.order.includes(spawnToolCallId)) {
    return { ...view, expandedId: spawnToolCallId };
  }
  if (view.order.length < CHILD_SPLIT_MAX_ROWS) {
    return { kind: "split", order: [...view.order, spawnToolCallId], expandedId: spawnToolCallId };
  }
  // Deterministic eviction (§2.2): the expanded row is never a candidate, so
  // `victim` is always found for any valid full stack under the current
  // CHILD_SPLIT_MAX_ROWS (>1) — a full `order` always holds at least one
  // collapsed row besides `expandedId`. The `!== victim` filter is a
  // structural no-op (removes nothing) only for an out-of-contract `view`
  // that violates I1, never for one any reducer here can produce.
  const victim = view.order.find((id) => id !== view.expandedId);
  return {
    kind: "split",
    order: [...view.order.filter((id) => id !== victim), spawnToolCallId],
    expandedId: spawnToolCallId,
  };
}

/** Switches the pane back to the master transcript (the breadcrumb's "back" click, or the split stack head's "×"). Unconditional for every `view.kind`, like before S3. */
export function closeChild(_view: ChildLayoutView): ChildLayoutView {
  return MASTER_VIEW;
}

/**
 * Enters the split layout from layout B (the breadcrumb's new "Split"
 * button, CUT-S3 §3.2): `child` → a one-row stack holding that same child,
 * expanded. `master`/`split` → the SAME `view` reference (no-op) — there is
 * no child to seed a stack from `master`, and `split` is already split.
 */
export function enterSplit(view: ChildLayoutView): ChildLayoutView {
  if (view.kind !== "child") {
    return view;
  }
  return { kind: "split", order: [view.spawnToolCallId], expandedId: view.spawnToolCallId };
}

/**
 * Leaves the split layout for layout B on the currently-expanded child (the
 * stack head's "⤢" button, CUT-S3 §3.2): `split` → `{kind:"child",
 * spawnToolCallId: expandedId}`. `master`/`child` → the SAME `view`
 * reference (no-op).
 *
 * DECLARED lossy (CUT-S3 §2.2/§2.5 I3, `enterSplit(exitSplit(s))` does NOT
 * round-trip `s`): the collapsed rows are forgotten — the stack is
 * view-state, not data, and roster memory across a split→B→split trip is
 * deliberately not built (§9 п.2, RS3-0-2). The test pins this loss so it is
 * never "fixed" silently.
 */
export function exitSplit(view: ChildLayoutView): ChildLayoutView {
  if (view.kind !== "split") {
    return view;
  }
  return { kind: "child", spawnToolCallId: view.expandedId };
}

/**
 * Re-expands a different row already in the stack (a collapsed row's click,
 * ChildSplitPane.tsx, CUT-S3 §3.2): `split` with `spawnToolCallId` a member
 * of `order` other than the current `expandedId` → the same stack with
 * `expandedId` moved onto it (`order` itself is untouched — re-expanding
 * never reorders the stack). Every other case — `master`/`child`, an id NOT
 * in `order`, or the id already expanded — returns the SAME `view` reference
 * (no-op).
 */
export function expandRow(view: ChildLayoutView, spawnToolCallId: string): ChildLayoutView {
  if (view.kind !== "split" || spawnToolCallId === view.expandedId || !view.order.includes(spawnToolCallId)) {
    return view;
  }
  return { ...view, expandedId: spawnToolCallId };
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

// ── split stack head VM ──

/**
 * The split stack's head (CUT-S3 §0.1/§2.4): `single` when the stack holds
 * exactly one row — the head shows that one child's own identity (mokap C) —
 * or `roster` once a second child joins, a plain "Subagents · {total} ·
 * {running} running" summary (mokap D). There is no third shape: N=1 "in
 * roster mode" was never a real state to begin with (§4 п.4) — the head is
 * simply a pure function of stack size.
 */
export type ChildStackHeadVM =
  | { kind: "single"; spawnToolCallId: string }
  | { kind: "roster"; total: number; running: number };

/**
 * Builds the stack head VM from the stack's rows, top-to-bottom in `order`.
 * `rows.length === 1` → `single`, naming that one row's id (the caller
 * resolves it back to a card the same way it already does for every row).
 * Otherwise → `roster`, with `running` counting rows whose `badge` is
 * `"running"` OR `"waiting_permission"` — CUT-S3 §2.4/§4 п.8: a child
 * blocked on a permission ask is still alive and demanding attention, not
 * "done". `total`/`running` are computed off the actual rows every call
 * (never a constant), so a stack that changes shape changes the label.
 */
export function buildChildStackHead(
  rows: readonly { spawnToolCallId: string; badge: ChildBadgeKind }[],
): ChildStackHeadVM {
  if (rows.length === 1) {
    return { kind: "single", spawnToolCallId: rows[0]!.spawnToolCallId };
  }
  const running = rows.filter((row) => row.badge === "running" || row.badge === "waiting_permission").length;
  return { kind: "roster", total: rows.length, running };
}

// ── per-root-tab layout store ──

/**
 * `rootTabId -> ChildLayoutView`: the persistent home for layout B/C/D's
 * view state (see the module doc comment's C3 addendum above). Method names
 * (`open`/`close`/`view`) are deliberately distinct in SHAPE from the free
 * `openChild`/`closeChild` functions above even though they wrap them 1:1 —
 * `store.getState().open(rootTabId, id)` vs the free `openChild(view, id)`
 * take different first arguments (a tabId vs a view), so reusing the exact
 * same name would invite a caller to mix them up. CUT-S3 §2.3 deliberately
 * does NOT extend that convention to the three split methods below: their
 * names ARE their reducers' names (`enterSplit`/`exitSplit`/`expandRow`) —
 * the cut's own choice, frozen; only `open`/`close`/`view`/`reset` keep the
 * pre-S3 distinct-shape rule.
 */
export interface ChildLayoutState {
  /** REPLACED (new Map) on every write; never mutated in place — matches every other store in this app (tab-status-store.ts, child-sessions.ts). */
  views: ReadonlyMap<string, ChildLayoutView>;
  /** The given root tab's current view; `MASTER_VIEW` for a tab this store has never heard from — every tab's implicit starting state, so `open`/`close` never need a seeding call first. */
  view(rootTabId: string): ChildLayoutView;
  /** Applies the pure `openChild` reducer for one root tab (the Open button, ToolCallCard.tsx C3). */
  open(rootTabId: string, spawnToolCallId: string): void;
  /** Applies the pure `closeChild` reducer for one root tab (the breadcrumb's master segment, App.tsx C3, or the split stack head's "×"). */
  close(rootTabId: string): void;
  /** Applies the pure `enterSplit` reducer (the breadcrumb's new "Split" button, CUT-S3 §3.2). No-op write skipped when the reducer returns the same reference (§2.3). */
  enterSplit(rootTabId: string): void;
  /** Applies the pure `exitSplit` reducer (the split stack head's "⤢" button, CUT-S3 §3.2). No-op write skipped like `enterSplit` above. */
  exitSplit(rootTabId: string): void;
  /** Applies the pure `expandRow` reducer (a collapsed row's click, ChildSplitPane.tsx, CUT-S3 §3.2). No-op write skipped like `enterSplit` above. */
  expandRow(rootTabId: string, spawnToolCallId: string): void;
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

    enterSplit(rootTabId): void {
      const current = get().view(rootTabId);
      const next = enterSplit(current);
      if (next === current) {
        return; // no-op reducer result — skip the Map rebuild (§2.3)
      }
      const views = new Map(get().views);
      views.set(rootTabId, next);
      set({ views });
    },

    exitSplit(rootTabId): void {
      const current = get().view(rootTabId);
      const next = exitSplit(current);
      if (next === current) {
        return; // no-op reducer result — skip the Map rebuild (§2.3)
      }
      const views = new Map(get().views);
      views.set(rootTabId, next);
      set({ views });
    },

    expandRow(rootTabId, spawnToolCallId): void {
      const current = get().view(rootTabId);
      const next = expandRow(current, spawnToolCallId);
      if (next === current) {
        return; // no-op reducer result — skip the Map rebuild (§2.3)
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

/**
 * TASK.188 S1 — the replay frame machine.
 *
 * Debug-only playback of an ALREADY RECORDED session: a resumed tab's
 * transcript (and an expanded child's history) is re-shown block by block,
 * like a film, so a demo video can be filmed from real data instead of a
 * staged live run.
 *
 * This module is the whole model and nothing but the model:
 *
 *  - pure frame arithmetic (`frameDelayMs` / `buildFrames` /
 *    `materializeFrame` / `withFreshIds`) — no store, no clock, no DOM;
 *  - one zustand store holding the playback state of TWO kinds of target
 *    (the root tab and any number of expanded children, keyed by
 *    `spawnToolCallId`), whose actions are pure reducers over that state;
 *  - a clock (`createReplayClock`) with an INJECTED timer (the local
 *    `FrameScheduler` custom, store.ts:1197) so tests drive frames
 *    deterministically without real time;
 *  - the keyboard table as a pure lookup (`replayKeyAction`), and a
 *    JSON view of the state (`replayStateJson`) for the automation facade.
 *
 * Everything that needs the app itself lives OUTSIDE this file: the root
 * sink (writing the visible prefix into the tab store's `transcript`) is the
 * automation facade's job, the child sink is `ChildHistoryContent`'s. Hence
 * the only imports here are `zustand` and a type-only `./store.js`.
 */
import { create } from "zustand";
import type { TranscriptBlock } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────
// Parameters
// ─────────────────────────────────────────────────────────────────────────

/**
 * Playback tuning. Everything a human would want to turn while filming is a
 * parameter, never a constant: a flat 350 ms per block over 700 blocks reads
 * as a slide show, so the per-frame delay is shaped by the block's kind and
 * by how much text it carries.
 */
export interface ReplayParams {
  /** Base delay after a block, in ms, before the next one appears. */
  stepMs: number;
  /** Extra ms per character of the block's own text. */
  perCharMs: number;
  /** Ceiling for a single frame's delay, applied BEFORE `speed`. */
  maxStepMs: number;
  /** Divisor of the computed delay; `]` / `[` scale it at runtime. */
  speed: number;
  /** Per-kind multiplier of `stepMs`; a kind absent here uses `DEFAULT_KIND_SCALE`. */
  kindScale: Partial<Record<TranscriptBlock["kind"], number>>;
  /**
   * Rewrite every block's `id` when arming (see `withFreshIds`). MessageList
   * only animates ids it has never seen, and the root list is not remounted
   * after hydration — without fresh ids the root replay appears without the
   * enter animation.
   */
  freshIds: boolean;
  /** An accepted child starts playing on its own. */
  autoPlayChild: boolean;
  /** The root pauses while a child is on screen, and resumes when it leaves. */
  pauseRootWhileChild: boolean;
  /**
   * S8.2: ms to wait after a child's timeline runs out before the child pane
   * is CLOSED for the operator (a real click on its own close control, driven
   * by the facade). `0` disables it — the operator closes the pane by hand.
   *
   * Only layout B needs this: there the child pane stands INSTEAD of the
   * master, so the root is off screen and its playback stays parked until the
   * pane goes away. In the split layout the root is visible next to the child
   * and `tick` below releases it directly, with no close and no timer.
   *
   * S9.3: the default is 1500, not 0. The effect is reachable only while a
   * replay is armed, only in layout B, and only once a child's timeline has
   * run out — while the cost of shipping it off was the exact stall the
   * feature exists to remove: out of the box the film froze on the finished
   * child until someone clicked. The number is what the operator tunes; the
   * behaviour is not what they should have to discover.
   */
  childDoneCloseMs: number;
  /** S6: ms a tool_call card spends in the intermediate "running" frame; 0 = no such frame. */
  toolRunningMs: number;
  /** S6: characters revealed per typing frame; 0 = no typing effect. */
  typingCharsPerFrame: number;
  /** S6: delay of one typing frame, in ms. */
  typingFrameMs: number;
  /** S6: drive a fake "Working…" turn status while a target plays. */
  fakeTurn: boolean;
}

/** Multiplier for a kind with no entry in `ReplayParams.kindScale`. */
export const DEFAULT_KIND_SCALE = 0.5;

/**
 * `toolRunningMs` / `typingCharsPerFrame` / `typingFrameMs` / `fakeTurn` are
 * declared and defaulted OFF here by S1 so that S6 adds behaviour without
 * changing this type; `buildFrames` below does not read them yet.
 */
export const DEFAULT_REPLAY_PARAMS: ReplayParams = Object.freeze({
  stepMs: 350,
  perCharMs: 1.5,
  maxStepMs: 2000,
  speed: 1,
  kindScale: Object.freeze({
    user_text: 1.6,
    assistant_text: 1,
    reasoning: 0.5,
    tool_call: 0.8,
  }) as Partial<Record<TranscriptBlock["kind"], number>>,
  freshIds: true,
  autoPlayChild: true,
  pauseRootWhileChild: true,
  childDoneCloseMs: 1500,
  toolRunningMs: 0,
  typingCharsPerFrame: 0,
  typingFrameMs: 0,
  fakeTurn: false,
});

/** Numeric params accepted as any finite value >= 0. */
const NON_NEGATIVE_KEYS = [
  "stepMs",
  "perCharMs",
  "maxStepMs",
  "childDoneCloseMs",
  "toolRunningMs",
  "typingCharsPerFrame",
  "typingFrameMs",
] as const;

const BOOLEAN_KEYS = ["freshIds", "autoPlayChild", "pauseRootWhileChild", "fakeTurn"] as const;

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Folds an untrusted `patch` (it arrives from DevTools or over HTTP) onto
 * `base`. Every field is validated on its own; a rejected field leaves the
 * base value in place instead of failing the whole patch. Returns `base`
 * itself when nothing was accepted, so callers can skip a rebuild by
 * reference comparison.
 */
export function mergeReplayParams(base: ReplayParams, patch: unknown): ReplayParams {
  if (patch === null || typeof patch !== "object") {
    return base;
  }
  const raw = patch as Record<string, unknown>;
  const next: ReplayParams = { ...base, kindScale: { ...base.kindScale } };
  let changed = false;

  for (const key of NON_NEGATIVE_KEYS) {
    const value = raw[key];
    if (isNonNegative(value) && value !== next[key]) {
      next[key] = value;
      changed = true;
    }
  }
  // `speed` divides the delay, so zero and negatives are rejected outright.
  const speed = raw["speed"];
  if (typeof speed === "number" && Number.isFinite(speed) && speed > 0 && speed !== next.speed) {
    next.speed = speed;
    changed = true;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = raw[key];
    if (typeof value === "boolean" && value !== next[key]) {
      next[key] = value;
      changed = true;
    }
  }
  const kindScale = raw["kindScale"];
  if (kindScale !== null && typeof kindScale === "object") {
    const scalePatch = kindScale as Record<string, unknown>;
    const merged = next.kindScale as Record<string, number>;
    for (const key of Object.keys(scalePatch)) {
      const value = scalePatch[key];
      // Keys that are not transcript kinds are inert: the map is only ever
      // read by `block.kind` lookup, so an unknown key is never consulted.
      if (isNonNegative(value) && merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    }
  }
  return changed ? next : base;
}

// ─────────────────────────────────────────────────────────────────────────
// Frames
// ─────────────────────────────────────────────────────────────────────────

/**
 * One step of playback: after it, blocks `[0, upto)` of the target's block
 * list are on screen. `override` replaces block `[upto - 1]` (S6 uses it for
 * the intermediate "running" tool card and for partially typed text); S1
 * never emits it.
 */
export interface ReplayFrame {
  upto: number;
  delayMs: number;
  override?: TranscriptBlock;
}

/** Length of the block's own visible text; kinds without a `text` field contribute nothing. */
function blockTextLength(block: TranscriptBlock): number {
  return "text" in block ? block.text.length : 0;
}

/** `clamp(stepMs * kindScale + perCharMs * textLength, 0, maxStepMs) / speed`. */
export function frameDelayMs(block: TranscriptBlock, params: ReplayParams): number {
  const scale = params.kindScale[block.kind] ?? DEFAULT_KIND_SCALE;
  const raw = params.stepMs * scale + params.perCharMs * blockTextLength(block);
  const clamped = Math.min(Math.max(raw, 0), params.maxStepMs);
  const speed = params.speed > 0 ? params.speed : 1;
  return clamped / speed;
}

/**
 * The base frame plan: exactly one frame per block, revealing them in order.
 * S6 will splice extra frames in (a tool card first appearing as "running",
 * text arriving a chunk at a time) — every consumer therefore treats
 * `frames.length` as the timeline length, never `blocks.length`.
 */
export function buildFrames(blocks: readonly TranscriptBlock[], params: ReplayParams): ReplayFrame[] {
  return blocks.map((block, index) => ({ upto: index + 1, delayMs: frameDelayMs(block, params) }));
}

/** The block list as of `frame`: the `upto`-prefix, with `override` substituted for its last entry. */
export function materializeFrame(blocks: readonly TranscriptBlock[], frame: ReplayFrame): TranscriptBlock[] {
  const upto = Math.min(Math.max(Math.trunc(frame.upto), 0), blocks.length);
  const prefix = blocks.slice(0, upto);
  if (frame.override !== undefined && upto > 0) {
    prefix[upto - 1] = frame.override;
  }
  return prefix;
}

/**
 * Copies the blocks with rewritten ids (`<id>~r<epoch>`). ONLY `id` changes:
 * `toolCallId` is what the Open button and every automation probe address, so
 * a re-id'd tool card still opens the same child.
 */
export function withFreshIds(blocks: readonly TranscriptBlock[], epoch: number): TranscriptBlock[] {
  return blocks.map((block) => ({ ...block, id: `${block.id}~r${epoch}` }));
}

// ─────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────

/** One replayed surface: the root transcript, or one expanded child's history. */
export interface ReplayTarget {
  /** The blocks as they were handed in — restored verbatim (original ids) on disarm. */
  source: TranscriptBlock[];
  /** The blocks actually played (root: possibly re-id'd, see `freshIds`). */
  shown: TranscriptBlock[];
  frames: ReplayFrame[];
  /** Frames already consumed; ranges over `[0, frames.length]`. */
  cursor: number;
  /**
   * Whether the clock should be moving this target. DERIVED, never carried:
   * `moveTarget` is the only writer and it switches playback off on the last
   * frame, so `cursor === frames.length && playing` is not a representable
   * state (S13, §11 finding D6).
   */
  playing: boolean;
  /** Materialized `cursor` state, held (not derived in a selector) so React sees a stable reference. */
  visible: TranscriptBlock[];
  /** Bumped on every cursor/playing/frames change; the clock uses it to spot a stale timer. */
  version: number;
}

/** Which surface a command addresses; `{ child }` is keyed by the spawning tool call. */
export type ReplayFocus = "root" | { child: string };

export interface ReplayState {
  armed: { rootTabId: string; epoch: number } | null;
  params: ReplayParams;
  root: ReplayTarget | null;
  children: ReadonlyMap<string, ReplayTarget>;
  focus: ReplayFocus;
  /**
   * True iff the MACHINE stopped a playing root and may start it again: a
   * child took the screen (`offerChild`), or the root left the frame
   * (`setRootOnScreen(false)`, S10). A root the operator stopped by hand
   * carries `false` and is never resumed by any of the automatic paths — an
   * explicit `pause("root")` CLEARS the flag for exactly that reason (S11).
   */
  rootPausedByChild: boolean;
  /**
   * Whether the root transcript is currently VISIBLE (S8.2). DERIVED since
   * S12 from `mountedSurfaces`: the root is in frame iff a `SessionSurface`
   * carrying the armed tab's id is mounted. Split shows the root beside the
   * child (`true`); layout B renders the child pane INSTEAD of the master,
   * and another tab or the start screen replaces the whole surface — in all
   * three the root's own surface is unmounted (`false`).
   *
   * It is the visibility half of `releaseRoot`, and switching it off parks a
   * playing root: the film is never spent where nobody can see it, and never
   * jumps forward while the operator is away (S10, §11 finding D3). Since S11
   * it also gates the explicit root commands (`play`/`toggle`/`step`/`seek`),
   * so an order given from off screen cannot start the film either, and since
   * S12 it gates `tick` as well — the invariant "the root never plays out of
   * frame" holds in ONE place instead of three cooperating ones.
   *
   * Fail-CLOSED (S12): the initial value is `false` and arming does not raise
   * it. Only a mounted surface does. Before S12 it defaulted to `true` and was
   * computed from a hand-written list of the ways a root could leave the
   * frame; each live pass found one more door that list did not name (§11
   * findings D3, D4).
   */
  rootOnScreen: boolean;
  /**
   * The tab ids whose `SessionSurface` is mounted right now (S12). Written by
   * that component's own mount/unmount effect, so it answers "what is really
   * drawn" rather than "what the router should be drawing".
   *
   * Not session state: it survives `disarm`, because mounting is a fact of
   * React's tree and has nothing to do with whether a replay is armed. Only
   * `reset` (the test hatch) clears it.
   */
  mountedSurfaces: ReadonlySet<string>;

  /** Arms the root for `rootTabId`; refuses (`false`) when already armed. */
  arm(rootTabId: string, blocks: readonly TranscriptBlock[]): boolean;
  /** Drops everything: root, children, focus. Params survive (they are settings, not state). */
  disarm(): void;
  // The four commands that MOVE the film are no-ops when they address the
  // root while `rootOnScreen` is false (S11, §11 finding D4). `pause` is the
  // exception in both directions: it is honoured off screen, and it clears
  // `rootPausedByChild` so the machine cannot undo it later.
  play(target?: ReplayFocus): void;
  pause(target?: ReplayFocus): void;
  toggle(target?: ReplayFocus): void;
  step(n: number, target?: ReplayFocus): void;
  seek(index: number, target?: ReplayFocus): void;
  /** Validates and folds the patch, then rebuilds every target's frames, keeping cursors. */
  setParams(patch: unknown): void;
  /**
   * The transition that writes `rootOnScreen` and runs the park/release rules
   * around it (S8.2/S10). Since S12 the app never calls it directly: the
   * derivation from `mountedSurfaces` is its only caller here, and it stays on
   * the interface as that derivation's single write path — and as the hatch a
   * test uses to put the flag somewhere by hand.
   */
  setRootOnScreen(onScreen: boolean): void;
  /** A `SessionSurface` for `tabId` mounted; re-derives `rootOnScreen` through `setRootOnScreen` (S12). */
  surfaceMounted(tabId: string): void;
  /** That surface unmounted; the mirror of `surfaceMounted`, and a no-op for an id that was never mounted. */
  surfaceUnmounted(tabId: string): void;
  /** A mounted child offers its projected history; accepted only while armed for ITS root. */
  offerChild(rootTabId: string, spawnToolCallId: string, blocks: readonly TranscriptBlock[]): boolean;
  /** The child unmounted (closed/collapsed): drop it, return focus and, if we paused it, the root. */
  withdrawChild(spawnToolCallId: string): void;
  /**
   * One frame forward; playback switches off on reaching the end, because
   * `moveTarget` derives it. Driven by `createReplayClock`. A tick aimed at the
   * ROOT while it is out of frame is dropped (S12) — the last of the three ways
   * the film could advance off camera, and the only one that survived a stale
   * timer. A child reaching its end here hands the film back to the root, but
   * that is not this reducer's doing: it is the release every write is judged
   * by (S13), which is why `End` on a child does it too.
   */
  tick(target: ReplayFocus): void;
  /** Test-only escape hatch, mirroring every other store in this app. */
  reset(): void;
}

/** Keeps the previous array when the new one holds the same blocks — selector-stable references. */
function preserveRef(previous: TranscriptBlock[], next: TranscriptBlock[]): TranscriptBlock[] {
  if (previous.length !== next.length) {
    return next;
  }
  for (let i = 0; i < next.length; i += 1) {
    if (previous[i] !== next[i]) {
      return next;
    }
  }
  return previous;
}

function visibleAt(target: Pick<ReplayTarget, "shown" | "frames">, cursor: number): TranscriptBlock[] {
  if (cursor <= 0) {
    return [];
  }
  const frame = target.frames[cursor - 1];
  return frame === undefined ? [] : materializeFrame(target.shown, frame);
}

function createTarget(
  source: readonly TranscriptBlock[],
  params: ReplayParams,
  epoch: number | null,
): ReplayTarget {
  const kept = [...source];
  const shown = epoch === null ? kept : withFreshIds(kept, epoch);
  return {
    source: kept,
    shown,
    frames: buildFrames(shown, params),
    cursor: 0,
    playing: false,
    visible: [],
    version: 0,
  };
}

/**
 * The single cursor/playing transition. Clamps the cursor into
 * `[0, frames.length]`, DERIVES playback from the clamped cursor, recomputes
 * `visible` and bumps `version`; returns the SAME reference when nothing
 * moved, so no-op commands write nothing and the clock is not disturbed.
 *
 * `playing` is a REQUEST, not a value to carry over: playback lasts only while
 * frames remain, so a timeline sitting on its last frame is never `playing` —
 * however it got there, by its own clock or by `End`/`step`/`seek` (S13, §11
 * finding D6). Before S13 that rule lived in a hand-written list of the
 * callers that remembered to ask it, and `step`/`seek` were not on the list:
 * they carried `playing: true` onto the end of the tape, where the clock arms
 * no timer and nothing ever switches it off again. Two readers then stalled on
 * a state nothing could leave — the frame clock, and the facade's auto-close
 * watch, which read that `playing` as "the child is still running".
 */
function moveTarget(target: ReplayTarget, cursor: number, playing: boolean): ReplayTarget {
  const requested = Number.isFinite(cursor) ? Math.trunc(cursor) : target.cursor;
  const clamped = Math.min(Math.max(requested, 0), target.frames.length);
  const nextPlaying = playing && clamped < target.frames.length;
  if (clamped === target.cursor && nextPlaying === target.playing) {
    return target;
  }
  const visible =
    clamped === target.cursor ? target.visible : preserveRef(target.visible, visibleAt(target, clamped));
  return { ...target, cursor: clamped, playing: nextPlaying, visible, version: target.version + 1 };
}

/**
 * Rebuilds the frame plan under new params, keeping the cursor (clamped to the
 * new length) and applying `moveTarget`'s rule to playback: a plan that no
 * longer reaches past the cursor leaves nothing to play. Today every plan is
 * one frame per block, so the clamp never bites; S6 splices extra frames in,
 * and this is the second place the old list of callers would have had to grow.
 */
function reframeTarget(target: ReplayTarget, params: ReplayParams): ReplayTarget {
  const frames = buildFrames(target.shown, params);
  const cursor = Math.min(target.cursor, frames.length);
  const next: Pick<ReplayTarget, "shown" | "frames"> = { shown: target.shown, frames };
  return {
    ...target,
    frames,
    cursor,
    playing: target.playing && cursor < frames.length,
    visible: preserveRef(target.visible, visibleAt(next, cursor)),
    version: target.version + 1,
  };
}

/**
 * The slice of state the release rule reads. It is passed explicitly rather
 * than taken from `get()` because the rule judges the state ABOUT to be
 * written, not the one still in the store: `commit` folds each reducer's patch
 * over the current state and asks the question of the result.
 */
interface RootReleaseView {
  root: ReplayTarget | null;
  rootPausedByChild: boolean;
  rootOnScreen: boolean;
  children: ReadonlyMap<string, ReplayTarget>;
}

/**
 * The ONE rule for handing the film back to the root. Since S13 it is not tied
 * to a list of events at all: `commit` puts every reducer write through it, so
 * the film changes hands at whichever write first makes the three conditions
 * true — a child withdrawn, a child running out of frames by its clock or by
 * `End`/`step`/`seek`, an empty child accepted with no frames to begin with,
 * or the root coming back into frame (S10, §11 findings D3/D5 — the withdrawal
 * path used to carry no visibility gate at all, so switching tabs mid-replay
 * ran the root on behind an unmounted pane; then three named events turned out
 * to be five and a half).
 *
 * Three conditions, all necessary:
 *  - `rootPausedByChild` — the machine is what stopped the root. A root the
 *    operator stopped by hand carries `false` and is never restarted here.
 *  - `rootOnScreen` — the root is the surface actually in frame. Playing it
 *    anywhere else burns the timeline where nobody can see it, which is the
 *    whole reason the flag exists.
 *  - no child still holding the film — a child with frames left to play is
 *    the current act. An EXHAUSTED child holds nothing: in split its
 *    exhaustion is exactly what hands the root back (S8.2).
 *
 * Returns the state patch, or `null` when the root must stay where it is.
 * A blocked release leaves `rootPausedByChild` set, so the release stays
 * reachable from whichever write makes the conditions true next.
 *
 * The root is asked to play, not told to: `moveTarget` derives the answer, so
 * a root released at the very end of its own tape comes back stopped.
 */
function releaseRoot(state: RootReleaseView): { root: ReplayTarget; rootPausedByChild: false } | null {
  if (state.root === null || !state.rootPausedByChild || !state.rootOnScreen) {
    return null;
  }
  for (const child of state.children.values()) {
    if (child.cursor < child.frames.length) {
      return null;
    }
  }
  return {
    root: moveTarget(state.root, state.root.cursor, true),
    rootPausedByChild: false,
  };
}

/** Builds a replay store instance; the factory exists so tests get an isolated store (mirrors createChildLayoutStore). */
export function createReplayStore() {
  return create<ReplayState>()((rawSet, get) => {
    let epochCounter = 0;

    /**
     * The ONLY write path of the reducers below. It writes the patch and, in
     * the same commit, judges the release rule against the state that patch is
     * about to produce — so "who holds the film" is DERIVED from every write
     * instead of being remembered at the few call sites that once thought to
     * ask (S13, §11 finding D5).
     *
     * Before it the hand-back lived in three named places (`tick`,
     * `withdrawChild`, `setRootOnScreen`). A child brought to its end by
     * `seek`/`step`/`End` was a fourth and fifth event nobody had named, and an
     * empty child — accepted with no frames at all — a sixth: in split the root
     * stayed parked with no event left to free it. This is the same cure S12
     * applied to the frame flag: derive the consequence, do not enumerate the
     * causes.
     *
     * A release also returns the FOCUS to the root. It can only fire when every
     * child is exhausted, so a focus resting on a child at that moment is a
     * focus on a finished one, and the keys belong to the root again.
     */
    function commit(patch: Partial<ReplayState>): void {
      const released = releaseRoot({ ...get(), ...patch });
      rawSet(released === null ? patch : { ...patch, ...released, focus: "root" as const });
    }

    /** The target a command names, with `undefined` resolved the way `updateTarget` resolves it: the focused one. */
    function resolveTarget(state: ReplayState, target: ReplayFocus | undefined): ReplayFocus {
      return target ?? state.focus;
    }

    /**
     * The frame gate on the COMMAND edge (S11, §11 finding D4): true when the
     * command addresses the ROOT and the root is not the surface on screen.
     *
     * `setRootOnScreen` parks a root that leaves the frame (S10), but parking
     * only covers the film running by itself. An explicit order — a hotkey
     * pressed while another tab is active, an HTTP driver, the start screen
     * standing over the pane — walked straight past it and started the film
     * behind the scenery (measured live: 103 → 107 → 120 on a hidden tab, and
     * `End`/`Home` destroying the position from off screen).
     *
     * Children are never gated: a child target exists only for as long as its
     * pane is mounted (registered on mount, withdrawn on unmount, S3), so an
     * accepted child is in frame by construction. `pause` is not gated either
     * — see its own note.
     */
    function rootOutOfFrame(target: ReplayFocus | undefined): boolean {
      const state = get();
      return resolveTarget(state, target) === "root" && !state.rootOnScreen;
    }

    /**
     * Re-derives `rootOnScreen` from the mount set (S12) and feeds it through
     * the EXISTING transition, so the park-on-leave / release-on-return rules
     * of S10 keep their single implementation. The derivation is the whole
     * rule: the root is in frame iff a surface carrying the armed tab's id is
     * mounted. Called after every mount-set write.
     */
    function syncRootOnScreen(): void {
      const state = get();
      state.setRootOnScreen(state.armed !== null && state.mountedSurfaces.has(state.armed.rootTabId));
    }

    /** Applies `fn` to the addressed target (default: the focused one) and writes only a real change. */
    function updateTarget(target: ReplayFocus | undefined, fn: (current: ReplayTarget) => ReplayTarget): void {
      const state = get();
      const focus = target ?? state.focus;
      if (focus === "root") {
        const root = state.root;
        if (root === null) {
          return;
        }
        const next = fn(root);
        if (next !== root) {
          commit({ root: next });
        }
        return;
      }
      const current = state.children.get(focus.child);
      if (current === undefined) {
        return;
      }
      const next = fn(current);
      if (next === current) {
        return;
      }
      const children = new Map(state.children);
      children.set(focus.child, next);
      commit({ children });
    }

    return {
      armed: null,
      params: DEFAULT_REPLAY_PARAMS,
      root: null,
      children: new Map<string, ReplayTarget>(),
      focus: "root",
      rootPausedByChild: false,
      // Fail-closed (S12): nothing is on screen until a surface says it is.
      rootOnScreen: false,
      mountedSurfaces: new Set<string>(),

      arm(rootTabId, blocks): boolean {
        if (get().armed !== null) {
          return false;
        }
        epochCounter += 1;
        const params = get().params;
        commit({
          armed: { rootTabId, epoch: epochCounter },
          root: createTarget(blocks, params, params.freshIds ? epochCounter : null),
          children: new Map<string, ReplayTarget>(),
          focus: "root",
          rootPausedByChild: false,
          // Arming does not put anything on screen — it only names the tab
          // whose surface counts. The answer is read off what is mounted, so
          // arming a tab already in frame is live at once, and arming one that
          // is not stays refused until it is looked at (S12).
          rootOnScreen: get().mountedSurfaces.has(rootTabId),
        });
        return true;
      },

      disarm(): void {
        commit({
          armed: null,
          root: null,
          children: new Map<string, ReplayTarget>(),
          focus: "root",
          rootPausedByChild: false,
          // With nothing armed there is no root to be in frame. The MOUNT set
          // is deliberately untouched: it describes React's tree, not the
          // replay, and the very next `arm` reads its answer straight out of it.
          rootOnScreen: false,
        });
      },

      play(target): void {
        if (rootOutOfFrame(target)) {
          return;
        }
        updateTarget(target, (current) => moveTarget(current, current.cursor, true));
      },

      pause(target): void {
        const state = get();
        if (resolveTarget(state, target) === "root" && state.rootPausedByChild) {
          // An explicit stop OUTRANKS a machine park (S11, §11 finding D4):
          // the flag is cleared, so neither `releaseRoot` nor the return into
          // frame can undo the order. Before the cure a pause given while the
          // root sat parked off screen changed nothing at all — the target was
          // already stopped, so `updateTarget` wrote nothing — and switching
          // back resumed the film in spite of the operator (measured live:
          // 149 → 152 → 159 after an explicit pause).
          commit({ rootPausedByChild: false });
        }
        // Deliberately NOT frame-gated: stopping something is safe from
        // anywhere, and the whole point of this branch is that it works while
        // the root is off screen.
        updateTarget(target, (current) => moveTarget(current, current.cursor, false));
      },

      toggle(target): void {
        if (rootOutOfFrame(target)) {
          return;
        }
        updateTarget(target, (current) => moveTarget(current, current.cursor, !current.playing));
      },

      step(n, target): void {
        if (!Number.isFinite(n) || rootOutOfFrame(target)) {
          return;
        }
        updateTarget(target, (current) => moveTarget(current, current.cursor + Math.trunc(n), current.playing));
      },

      seek(index, target): void {
        if (rootOutOfFrame(target)) {
          return;
        }
        updateTarget(target, (current) => moveTarget(current, index, current.playing));
      },

      setParams(patch): void {
        const state = get();
        const params = mergeReplayParams(state.params, patch);
        if (params === state.params) {
          return; // nothing in the patch was accepted — no rebuild, no version bump
        }
        const root = state.root === null ? null : reframeTarget(state.root, params);
        const children = new Map<string, ReplayTarget>();
        for (const [key, child] of state.children) {
          children.set(key, reframeTarget(child, params));
        }
        commit({ params, root, children });
      },

      setRootOnScreen(onScreen): void {
        const state = get();
        if (state.rootOnScreen === onScreen) {
          return;
        }
        if (!onScreen) {
          // S10 (§11 finding D3): leaving the frame PARKS a playing root. The
          // film is a recording aid — running it where the camera is not
          // pointed spends the timeline for nothing and jumps the picture
          // forward on the way back (measured live: 20 → 28 in four seconds
          // behind a switched-away tab).
          //
          // The park is marked `rootPausedByChild`, the same "the machine
          // stopped this, the machine may start it again" flag a child sets;
          // that is what lets the return below undo it. A root the operator
          // stopped by hand is not playing, so it is not touched, and its
          // `false` flag keeps it stopped when the frame comes back.
          const park = state.root !== null && state.root.playing;
          commit({
            rootOnScreen: false,
            ...(park && state.root !== null
              ? { root: moveTarget(state.root, state.root.cursor, false), rootPausedByChild: true }
              : {}),
          });
          return;
        }
        // Back in frame: nothing special to do. `commit` judges the release
        // against the visibility written in this very patch, the same way it
        // judges every other write.
        commit({ rootOnScreen: true });
      },

      surfaceMounted(tabId): void {
        const state = get();
        if (state.mountedSurfaces.has(tabId)) {
          return;
        }
        const mountedSurfaces = new Set(state.mountedSurfaces);
        mountedSurfaces.add(tabId);
        commit({ mountedSurfaces });
        syncRootOnScreen();
      },

      surfaceUnmounted(tabId): void {
        const state = get();
        if (!state.mountedSurfaces.has(tabId)) {
          return;
        }
        const mountedSurfaces = new Set(state.mountedSurfaces);
        mountedSurfaces.delete(tabId);
        commit({ mountedSurfaces });
        syncRootOnScreen();
      },

      offerChild(rootTabId, spawnToolCallId, blocks): boolean {
        const state = get();
        if (state.armed === null || state.armed.rootTabId !== rootTabId) {
          return false;
        }
        if (state.children.has(spawnToolCallId)) {
          return false;
        }
        const params = state.params;
        // A child's MessageList is mounted fresh on every open, so its blocks
        // are unseen ids already — no `freshIds` rewrite needed (or wanted).
        const created = createTarget(blocks, params, null);
        const child = params.autoPlayChild ? moveTarget(created, 0, true) : created;
        const children = new Map(state.children);
        children.set(spawnToolCallId, child);

        // A child with NO frames is exhausted the moment it is accepted, so
        // the park below and the release `commit` runs cancel out inside one
        // write: the root never stops. Before S13 the release was tied to
        // named events and this one had no event at all (§11 finding D5).
        const pauseRoot = params.pauseRootWhileChild && state.root !== null && state.root.playing;
        commit({
          children,
          focus: { child: spawnToolCallId },
          ...(pauseRoot && state.root !== null
            ? { root: moveTarget(state.root, state.root.cursor, false), rootPausedByChild: true }
            : {}),
        });
        return true;
      },

      withdrawChild(spawnToolCallId): void {
        const state = get();
        if (!state.children.has(spawnToolCallId)) {
          return;
        }
        const children = new Map(state.children);
        children.delete(spawnToolCallId);
        const focus: ReplayFocus =
          state.focus !== "root" && state.focus.child === spawnToolCallId ? "root" : state.focus;
        // S10 (§11 finding D3): the withdrawal releases the root under the
        // SAME rule as everything else — visibility included — and since S13
        // it does not ask for that rule at all: `commit` applies it to the
        // child map this patch is about to write. This cleanup is reached by
        // two very different routes, and since S12 neither of them has to be
        // told apart HERE, because both are judged by one fact — whether the
        // root's own surface is mounted:
        //
        //  - the pane was CLOSED (breadcrumb, split close button, or the
        //    `childDoneCloseMs` auto-click). In layout B that same commit
        //    mounts the master surface again. React runs every cleanup before
        //    any mount effect, so this runs while the root is still out of
        //    frame and releases nothing; the mount that follows is what hands
        //    the film back, through its own `commit`. In split the master
        //    never left the frame and the release happens here.
        //  - the TAB was switched away. Nothing re-mounts, the root stays
        //    parked, and it waits for the surface to come back.
        commit({ children, focus });
      },

      tick(target): void {
        // S12: the frame gate lives HERE, on the one edge every advance of the
        // film crosses. `play`/`step`/`seek` are gated on the command edge
        // (S11) and a leaving root is parked (S10), but both are shortcuts
        // around this: a timer armed a moment before the root left the frame
        // still fires afterwards, and `tick` advances the cursor whether or not
        // the target is playing. Dropping it here is what makes "the root never
        // moves off camera" true by construction rather than by three
        // cooperating rules.
        if (target === "root" && !get().rootOnScreen) {
          return;
        }
        // One frame forward, and nothing else: the clamp inside `moveTarget`
        // makes a tick past the end a no-op, and its derivation switches
        // playback off on the last frame. S8.2's hand-back — a child running
        // out of frames gives the film to the root — used to be spelled out
        // here as a second half of this reducer; since S13 it is `commit`'s
        // business, which is what also made it true for a child brought to the
        // end by `End`/`step`/`seek` (§11 finding D5).
        updateTarget(target, (current) => moveTarget(current, current.cursor + 1, current.playing));
      },

      reset(): void {
        epochCounter = 0;
        commit({
          armed: null,
          params: DEFAULT_REPLAY_PARAMS,
          root: null,
          children: new Map<string, ReplayTarget>(),
          focus: "root",
          rootPausedByChild: false,
          rootOnScreen: false,
          mountedSurfaces: new Set<string>(),
        });
      },
    };
  });
}

export type ReplayStoreApi = ReturnType<typeof createReplayStore>;

/** The app's single replay store (mirrors child-layout.ts's `childLayoutStore`). */
export const replayStore = createReplayStore();

/** The root's visible prefix, or null when nothing is armed. */
export function rootVisible(state: ReplayState): TranscriptBlock[] | null {
  return state.root === null ? null : state.root.visible;
}

/**
 * Is the surface rendered under `tabId` a replay surface — a list showing a
 * recorded film rather than a live session?
 *
 * The fact is ARMING, not mounting: layout B unmounts the root's
 * `SessionSurface` while the child pane it replaced keeps playing, and that
 * pane is rendered inside the ROOT tab's `TabContext` (the recorded session
 * has no tab of its own), so both surfaces answer this one question. A null
 * tab — a list mounted outside any tab context — is never a replay surface.
 */
export function isReplaySurface(state: ReplayState, tabId: string | null): boolean {
  return state.armed !== null && tabId !== null && state.armed.rootTabId === tabId;
}

/** A child's visible prefix; null when not armed for THIS root, or that child was never accepted. */
export function childVisible(
  state: ReplayState,
  rootTabId: string | null,
  spawnToolCallId: string,
): TranscriptBlock[] | null {
  if (!isReplaySurface(state, rootTabId)) {
    return null;
  }
  return state.children.get(spawnToolCallId)?.visible ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Clock
// ─────────────────────────────────────────────────────────────────────────

/** Injected timer (the `FrameScheduler` custom, store.ts:1197) so tests need no real time. */
export interface ReplayTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The real-`setTimeout` timer. Exported so the facade's own S8.2 auto-close timer shares this seam with the frame clock. */
export const defaultReplayTimer: ReplayTimer = {
  set(fn, ms) {
    return setTimeout(fn, ms) as unknown;
  },
  clear(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

function focusKey(focus: ReplayFocus): string {
  return focus === "root" ? "root" : `child:${focus.child}`;
}

/**
 * Drives every playing target. Subscribes to the store and keeps AT MOST one
 * pending timer per target, armed for the delay of the frame the cursor is
 * about to consume. A timer is invalidated by `version`: any cursor/playing/
 * frames change cancels it and re-arms, so a seek or a params change during
 * playback cannot let a stale frame fire. Returns the disposer.
 */
export function createReplayClock(store: ReplayStoreApi, timer: ReplayTimer = defaultReplayTimer): () => void {
  const pending = new Map<string, { handle: unknown; version: number }>();

  function cancel(key: string): void {
    const entry = pending.get(key);
    if (entry !== undefined) {
      pending.delete(key);
      timer.clear(entry.handle);
    }
  }

  function sync(state: ReplayState): void {
    const wanted = new Map<string, { focus: ReplayFocus; target: ReplayTarget }>();
    // S12: an out-of-frame root is not a target the clock keeps a timer for —
    // the loop below cancels the pending one exactly as it does for a target
    // that has gone away. The store would drop the tick anyway; not arming the
    // timer is what makes "no clock runs off camera" observable from outside.
    if (state.root !== null && state.rootOnScreen) {
      wanted.set("root", { focus: "root", target: state.root });
    }
    for (const [spawnToolCallId, target] of state.children) {
      wanted.set(focusKey({ child: spawnToolCallId }), { focus: { child: spawnToolCallId }, target });
    }
    for (const key of [...pending.keys()]) {
      if (!wanted.has(key)) {
        cancel(key); // the target itself is gone (disarm, child withdrawn)
      }
    }
    for (const [key, { focus, target }] of wanted) {
      if (!target.playing || target.cursor >= target.frames.length) {
        cancel(key);
        continue;
      }
      const armedTimer = pending.get(key);
      if (armedTimer !== undefined && armedTimer.version === target.version) {
        continue; // still the timer this exact state asked for
      }
      cancel(key);
      const frame = target.frames[target.cursor];
      const version = target.version;
      const handle = timer.set(() => {
        const current = pending.get(key);
        if (current === undefined || current.version !== version) {
          return; // superseded between firing and running
        }
        pending.delete(key);
        store.getState().tick(focus);
      }, frame === undefined ? 0 : frame.delayMs);
      pending.set(key, { handle, version });
    }
  }

  const unsubscribe = store.subscribe(sync);
  sync(store.getState());

  return () => {
    unsubscribe();
    for (const key of [...pending.keys()]) {
      cancel(key);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Keyboard
// ─────────────────────────────────────────────────────────────────────────

export type ReplayKeyAction =
  | "toggle"
  | "step_forward"
  | "step_back"
  | "seek_start"
  | "seek_end"
  | "faster"
  | "slower"
  | "disarm";

const KEY_ACTIONS: Readonly<Record<string, ReplayKeyAction>> = {
  " ": "toggle",
  Space: "toggle",
  ArrowRight: "step_forward",
  ArrowLeft: "step_back",
  Home: "seek_start",
  End: "seek_end",
  "]": "faster",
  "[": "slower",
  Backspace: "disarm",
};

/**
 * The replay hotkey table (plan §3.2). Bare, unmodified keys are free in this
 * app — every application binding is a mod-chord except Escape (keymap.ts:53),
 * which is why "leave replay" is Backspace. Live only while armed, and never
 * while the event's target is a text field.
 */
export function replayKeyAction(key: string, editableTarget: boolean, armed: boolean): ReplayKeyAction | null {
  if (!armed || editableTarget) {
    return null;
  }
  return KEY_ACTIONS[key] ?? null;
}

/** Structural (DOM-free) test for "the keystroke belongs to a text field, not to replay". */
export function isEditableTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (target === null || target === undefined) {
    return false;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  const tag = target.tagName === undefined ? "" : target.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA";
}

// ─────────────────────────────────────────────────────────────────────────
// JSON view
// ─────────────────────────────────────────────────────────────────────────

export interface ReplayStateJson {
  armed: { rootTabId: string } | null;
  focus: ReplayFocus;
  params: ReplayParams;
  root: { cursor: number; total: number; playing: boolean } | null;
  children: { spawnToolCallId: string; cursor: number; total: number; playing: boolean }[];
  /** S8.2: whether the root transcript is the surface on screen — since S12, whether its `SessionSurface` is mounted. */
  rootOnScreen: boolean;
  /**
   * S11: whether the root is parked BY THE MACHINE (a child took the screen,
   * or the root left the frame) rather than stopped by hand. Both look like
   * `root.playing === false` from outside, but only a parked root starts
   * again on its own, so a driver cannot predict the next move without it.
   */
  rootPausedByChild: boolean;
}

/**
 * The state as the automation facade reports it: counts only, no blocks and
 * no functions, so `JSON.stringify` of the result is always safe and small.
 */
export function replayStateJson(state: ReplayState): ReplayStateJson {
  const children = [...state.children].map(([spawnToolCallId, target]) => ({
    spawnToolCallId,
    cursor: target.cursor,
    total: target.frames.length,
    playing: target.playing,
  }));
  return {
    armed: state.armed === null ? null : { rootTabId: state.armed.rootTabId },
    focus: state.focus,
    params: { ...state.params, kindScale: { ...state.params.kindScale } },
    root:
      state.root === null
        ? null
        : { cursor: state.root.cursor, total: state.root.frames.length, playing: state.root.playing },
    children,
    rootOnScreen: state.rootOnScreen,
    rootPausedByChild: state.rootPausedByChild,
  };
}

/**
 * replay.ts tests (TASK.188 S1): the whole replay model proved without a DOM
 * — frame arithmetic, the store's reducers, the injected-timer clock, the
 * hotkey table and the JSON view. Pins are numbered after the slice's pin
 * list; pin 2 is deliberately written at DEFAULT params (`toolRunningMs: 0`)
 * so the S6 intermediate-frame work extends the plan without rewriting it.
 */
import { describe, expect, it } from "vitest";
import {
  buildFrames,
  childVisible,
  createReplayClock,
  createReplayStore,
  DEFAULT_KIND_SCALE,
  DEFAULT_REPLAY_PARAMS,
  frameDelayMs,
  isEditableTarget,
  isReplaySurface,
  materializeFrame,
  mergeReplayParams,
  replayKeyAction,
  replayStateJson,
  rootVisible,
  withFreshIds,
  type ReplayFrame,
  type ReplayParams,
  type ReplayStoreApi,
  type ReplayTimer,
} from "./replay.js";
import type { TranscriptBlock } from "./store.js";

// ── fixtures ──────────────────────────────────────────────────────────────

function userText(id: string, text = "hi"): TranscriptBlock {
  return { kind: "user_text", id, text };
}

function assistantText(id: string, text = "ok"): TranscriptBlock {
  return { kind: "assistant_text", id, text };
}

function toolCall(id: string, toolCallId: string): TranscriptBlock {
  return {
    kind: "tool_call",
    id,
    toolCallId,
    toolName: "Bash",
    input: { command: "ls" },
    status: "proposed",
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
  };
}

/**
 * Arms `tabId` with its `SessionSurface` already mounted — the ordinary case
 * (the tab being looked at), and what every test that DRIVES the root needs
 * since S12 made `rootOnScreen` fail-closed: the flag is derived from the
 * mounted surfaces, so a store that has never been told about one refuses
 * every root command and drops every root tick.
 */
function armOnScreen(store: ReplayStoreApi, blocks: TranscriptBlock[], tabId = "tab-a"): boolean {
  store.getState().surfaceMounted(tabId);
  return store.getState().arm(tabId, blocks);
}

/** A kind deliberately absent from `DEFAULT_REPLAY_PARAMS.kindScale`. */
function outputTruncated(id: string): TranscriptBlock {
  return { kind: "output_truncated", id };
}

function fixtureBlocks(count: number): TranscriptBlock[] {
  return Array.from({ length: count }, (_unused, index) =>
    index % 2 === 0 ? userText(`b${index}`, `text-${index}`) : assistantText(`b${index}`, `reply-${index}`),
  );
}

function params(patch: Partial<ReplayParams>): ReplayParams {
  return { ...DEFAULT_REPLAY_PARAMS, ...patch };
}

interface FakeTimer {
  timer: ReplayTimer;
  setCalls: { handle: number; ms: number }[];
  clearCalls: number[];
  pendingHandles(): number[];
  fire(handle: number): void;
}

function createFakeTimer(): FakeTimer {
  const pending = new Map<number, () => void>();
  const setCalls: { handle: number; ms: number }[] = [];
  const clearCalls: number[] = [];
  let seq = 0;
  return {
    timer: {
      set(fn, ms) {
        seq += 1;
        pending.set(seq, fn);
        setCalls.push({ handle: seq, ms });
        return seq;
      },
      clear(handle) {
        clearCalls.push(handle as number);
        pending.delete(handle as number);
      },
    },
    setCalls,
    clearCalls,
    pendingHandles: () => [...pending.keys()],
    fire(handle) {
      const fn = pending.get(handle);
      if (fn === undefined) {
        throw new Error(`timer ${handle} is not pending`);
      }
      pending.delete(handle);
      fn();
    },
  };
}

// ── pin 1 ─────────────────────────────────────────────────────────────────

describe("pin 1 — frameDelayMs", () => {
  it("a 100-char user_text at defaults costs stepMs*1.6 + perCharMs*100, under the ceiling", () => {
    const block = userText("u1", "x".repeat(100));
    expect(frameDelayMs(block, DEFAULT_REPLAY_PARAMS)).toBe(
      Math.min(350 * 1.6 + 1.5 * 100, 2000) / 1,
    );
    expect(frameDelayMs(block, DEFAULT_REPLAY_PARAMS)).toBe(710);
  });

  it("speed divides the delay (speed 2 -> half)", () => {
    const block = userText("u1", "x".repeat(100));
    expect(frameDelayMs(block, params({ speed: 2 }))).toBe(355);
  });

  it("maxStepMs clamps BEFORE speed divides", () => {
    const block = userText("u1", "x".repeat(10_000));
    expect(frameDelayMs(block, DEFAULT_REPLAY_PARAMS)).toBe(2000);
    expect(frameDelayMs(block, params({ maxStepMs: 400 }))).toBe(400);
    expect(frameDelayMs(block, params({ maxStepMs: 400, speed: 4 }))).toBe(100);
  });

  it("a kind with no kindScale entry falls back to DEFAULT_KIND_SCALE (0.5)", () => {
    expect(DEFAULT_REPLAY_PARAMS.kindScale.output_truncated).toBeUndefined();
    expect(frameDelayMs(outputTruncated("t1"), DEFAULT_REPLAY_PARAMS)).toBe(350 * DEFAULT_KIND_SCALE);
    expect(frameDelayMs(outputTruncated("t1"), DEFAULT_REPLAY_PARAMS)).toBe(175);
  });

  it("a tool_call carries no text of its own — only its kind multiplier", () => {
    expect(frameDelayMs(toolCall("c1", "call-1"), DEFAULT_REPLAY_PARAMS)).toBe(350 * 0.8);
  });
});

// ── pin 2 ─────────────────────────────────────────────────────────────────

describe("pin 2 — buildFrames at DEFAULT params", () => {
  it("emits exactly one frame per block, upto = 1..n, and no override anywhere", () => {
    const blocks = fixtureBlocks(6);
    const frames = buildFrames(blocks, DEFAULT_REPLAY_PARAMS);

    expect(DEFAULT_REPLAY_PARAMS.toolRunningMs).toBe(0);
    expect(DEFAULT_REPLAY_PARAMS.typingCharsPerFrame).toBe(0);
    expect(frames).toHaveLength(blocks.length);
    expect(frames.map((frame) => frame.upto)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const frame of frames) {
      expect(Object.hasOwn(frame, "override")).toBe(false);
    }
  });

  it("each frame's delay is its own block's frameDelayMs", () => {
    const blocks = [userText("u1", "abc"), toolCall("c1", "call-1"), outputTruncated("t1")];
    const frames = buildFrames(blocks, DEFAULT_REPLAY_PARAMS);
    expect(frames.map((frame) => frame.delayMs)).toEqual(
      blocks.map((block) => frameDelayMs(block, DEFAULT_REPLAY_PARAMS)),
    );
  });

  it("an empty block list yields an empty plan", () => {
    expect(buildFrames([], DEFAULT_REPLAY_PARAMS)).toEqual([]);
  });
});

// ── pin 3 ─────────────────────────────────────────────────────────────────

describe("pin 3 — materializeFrame", () => {
  it("{upto: k} is the k-prefix, holding the very same block references", () => {
    const blocks = fixtureBlocks(5);
    const shown = materializeFrame(blocks, { upto: 3, delayMs: 0 });
    expect(shown).toHaveLength(3);
    expect(shown[0]).toBe(blocks[0]);
    expect(shown[1]).toBe(blocks[1]);
    expect(shown[2]).toBe(blocks[2]);
  });

  it("override replaces the LAST block of the prefix and leaves the source untouched", () => {
    const blocks = fixtureBlocks(4);
    const override = assistantText("b1", "partially typed");
    const shown = materializeFrame(blocks, { upto: 2, delayMs: 0, override });
    expect(shown).toHaveLength(2);
    expect(shown[0]).toBe(blocks[0]);
    expect(shown[1]).toBe(override);
    expect(blocks[1]).not.toBe(override);
  });

  it("upto is clamped: 0 gives nothing, past the end gives everything", () => {
    const blocks = fixtureBlocks(3);
    expect(materializeFrame(blocks, { upto: 0, delayMs: 0 })).toEqual([]);
    expect(materializeFrame(blocks, { upto: -4, delayMs: 0 })).toEqual([]);
    expect(materializeFrame(blocks, { upto: 99, delayMs: 0 })).toHaveLength(3);
  });
});

// ── pin 4 ─────────────────────────────────────────────────────────────────

describe("pin 4 — withFreshIds", () => {
  it("rewrites every id (uniquely, carrying the epoch) and nothing else", () => {
    const blocks = [userText("u1", "hello"), toolCall("c1", "call-1")];
    const before = JSON.stringify(blocks);

    const fresh = withFreshIds(blocks, 7);

    expect(fresh).toHaveLength(2);
    expect(fresh.map((block) => block.id)).toEqual(["u1~r7", "c1~r7"]);
    expect(new Set(fresh.map((block) => block.id)).size).toBe(2);
    for (const [index, block] of fresh.entries()) {
      expect(block.id).not.toBe(blocks[index]?.id);
      expect(block.id).toContain("7");
    }

    const [freshUser, freshTool] = fresh;
    if (freshUser === undefined || freshUser.kind !== "user_text") {
      throw new Error("expected a user_text block");
    }
    expect(freshUser.text).toBe("hello");
    if (freshTool === undefined || freshTool.kind !== "tool_call") {
      throw new Error("expected a tool_call block");
    }
    // toolCallId is what the Open button and every automation probe address.
    expect(freshTool.toolCallId).toBe("call-1");
    expect(freshTool.status).toBe("proposed");
    expect(freshTool.toolName).toBe("Bash");

    expect(JSON.stringify(blocks)).toBe(before);
  });

  it("a different epoch yields a different id for the same block", () => {
    const blocks = [userText("u1")];
    expect(withFreshIds(blocks, 1)[0]?.id).not.toBe(withFreshIds(blocks, 2)[0]?.id);
  });
});

// ── pin 5 ─────────────────────────────────────────────────────────────────

describe("pin 5 — store: arm / step / seek / disarm", () => {
  it("arm parks the root at cursor 0 with nothing visible, and refuses a second arm", () => {
    const store = createReplayStore();
    const blocks = fixtureBlocks(8);

    expect(store.getState().arm("tab-a", blocks)).toBe(true);
    const state = store.getState();
    expect(state.armed?.rootTabId).toBe("tab-a");
    expect(state.root?.cursor).toBe(0);
    expect(state.root?.visible).toEqual([]);
    expect(state.root?.playing).toBe(false);
    expect(state.root?.frames).toHaveLength(8);
    expect(rootVisible(state)).toEqual([]);

    expect(store.getState().arm("tab-b", blocks)).toBe(false);
    expect(store.getState().armed?.rootTabId).toBe("tab-a");
  });

  it("step(1) reveals one block, re-id'd by default and verbatim when freshIds is off", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(8));
    store.getState().step(1);
    expect(store.getState().root?.visible).toHaveLength(1);
    expect(store.getState().root?.visible[0]?.id).toBe("b0~r1");
    expect(store.getState().root?.source[0]?.id).toBe("b0");

    const plain = createReplayStore();
    plain.getState().setParams({ freshIds: false });
    armOnScreen(plain, fixtureBlocks(8));
    plain.getState().step(1);
    expect(plain.getState().root?.visible[0]?.id).toBe("b0");
  });

  it("seek clamps into [0, frames.length] and step(-1) is its symmetric inverse", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(8));

    store.getState().seek(5);
    expect(store.getState().root?.cursor).toBe(5);
    expect(store.getState().root?.visible).toHaveLength(5);

    store.getState().step(-1);
    expect(store.getState().root?.cursor).toBe(4);

    store.getState().seek(-3);
    expect(store.getState().root?.cursor).toBe(0);
    expect(store.getState().root?.visible).toEqual([]);

    store.getState().seek(1_000_000);
    expect(store.getState().root?.cursor).toBe(8);
    expect(store.getState().root?.visible).toHaveLength(8);
  });

  it("disarm drops the root, the children and the focus", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(4));
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(2));

    store.getState().disarm();

    const state = store.getState();
    expect(state.armed).toBeNull();
    expect(state.root).toBeNull();
    expect(state.children.size).toBe(0);
    expect(state.focus).toBe("root");
    expect(rootVisible(state)).toBeNull();
    expect(store.getState().arm("tab-b", fixtureBlocks(3))).toBe(true);
  });
});

// ── pin 6 ─────────────────────────────────────────────────────────────────

describe("pin 6 — store: offerChild / withdrawChild", () => {
  it("an offer before arming is refused", () => {
    const store = createReplayStore();
    expect(store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3))).toBe(false);
    expect(store.getState().children.size).toBe(0);
  });

  it("an offer from a DIFFERENT root is refused", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(4));
    expect(store.getState().offerChild("tab-b", "call-1", fixtureBlocks(3))).toBe(false);
    expect(childVisible(store.getState(), "tab-b", "call-1")).toBeNull();
  });

  it("an accepted child auto-plays, takes the focus and pauses a PLAYING root", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(store.getState().root?.playing).toBe(true);

    expect(store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3))).toBe(true);

    const state = store.getState();
    expect(state.children.get("call-1")?.playing).toBe(DEFAULT_REPLAY_PARAMS.autoPlayChild);
    expect(state.focus).toEqual({ child: "call-1" });
    expect(state.root?.playing).toBe(false);
    expect(state.rootPausedByChild).toBe(true);
    expect(childVisible(state, "tab-a", "call-1")).toEqual([]);

    expect(store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3))).toBe(false);
  });

  it("withdrawing returns the focus to the root and resumes the root it paused", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));

    store.getState().withdrawChild("call-1");

    const state = store.getState();
    expect(state.children.size).toBe(0);
    expect(state.focus).toBe("root");
    expect(state.root?.playing).toBe(true);
    expect(state.rootPausedByChild).toBe(false);
  });

  it("a root that was ALREADY paused before the child stays paused after the withdrawal", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    expect(store.getState().root?.playing).toBe(false);

    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    expect(store.getState().rootPausedByChild).toBe(false);

    store.getState().withdrawChild("call-1");
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().focus).toBe("root");
  });

  it("withdrawing an unknown key is a no-op", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(4));
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    const before = store.getState();

    store.getState().withdrawChild("call-unknown");

    expect(store.getState()).toBe(before);
    expect(store.getState().children.size).toBe(1);
  });

  // ── S8.2 (§11 finding C): a child running out of frames hands the film back
  // to the root — but only when the root is actually on screen. Found live:
  // the recording froze after every subagent, both surfaces stopped, and
  // nothing moved until a human closed the child pane by hand.

  it("a child that runs out of frames releases the root it paused — the root is on screen (split)", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    store.getState().setRootOnScreen(true);
    expect(store.getState().rootPausedByChild).toBe(true);

    store.getState().tick({ child: "call-1" });
    store.getState().tick({ child: "call-1" });
    expect(store.getState().root?.playing).toBe(false); // still the child's turn
    store.getState().tick({ child: "call-1" });

    const state = store.getState();
    expect(state.children.get("call-1")).toMatchObject({ cursor: 3, playing: false });
    expect(state.focus).toBe("root");
    expect(state.root?.playing).toBe(true);
    expect(state.rootPausedByChild).toBe(false);
  });

  it("with the root OFF screen (layout B) the same exhaustion leaves it parked, and the later withdrawal resumes it", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    // Layout B renders the child pane INSTEAD of the master, so React unmounts
    // the root's surface (S12 — before it, the facade reported the layout).
    store.getState().surfaceUnmounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(false);

    store.getState().tick({ child: "call-1" });
    store.getState().tick({ child: "call-1" });
    store.getState().tick({ child: "call-1" });

    const parked = store.getState();
    expect(parked.children.get("call-1")).toMatchObject({ cursor: 3, playing: false });
    expect(parked.focus).toEqual({ child: "call-1" });
    expect(parked.root?.playing).toBe(false);
    expect(parked.rootPausedByChild).toBe(true);

    // Closing the pane is what moves the film on — the same withdrawal path a
    // human click takes, which `ReplayParams.childDoneCloseMs` automates.
    //
    // S12 rewrote this tail to the REAL order of that close. One React commit
    // takes the child pane down and puts the master surface back up, and
    // React runs every cleanup before any mount effect — so `withdrawChild`
    // lands FIRST, while the root is still out of frame, and releases
    // nothing.
    store.getState().withdrawChild("call-1");
    expect(store.getState().focus).toBe("root");
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(true); // still the machine's park

    // Then the master surface mounts, and THAT is the release — the same rule
    // `tick` applies in split, reached by the other of its two moments.
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(true);
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("a root stopped BY HAND before the child stays stopped when the child runs out (mirror of the withdrawal rule)", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    expect(store.getState().root?.playing).toBe(false);
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(2));
    store.getState().setRootOnScreen(true);
    expect(store.getState().rootPausedByChild).toBe(false);

    store.getState().tick({ child: "call-1" });
    store.getState().tick({ child: "call-1" });

    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().focus).toEqual({ child: "call-1" });
  });

  it("setRootOnScreen writes nothing when the value is unchanged, and rides through replayStateJson", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(4));
    expect(replayStateJson(store.getState()).rootOnScreen).toBe(true);

    const before = store.getState();
    store.getState().setRootOnScreen(true);
    expect(store.getState()).toBe(before);

    store.getState().setRootOnScreen(false);
    expect(replayStateJson(store.getState()).rootOnScreen).toBe(false);
  });

  // ── S10 (§11 finding D3): the film only ever runs in frame ───────────────
  //
  // Found live: with a replay armed and a child playing, switching to another
  // tab unmounted the child pane, the cleanup called `withdrawChild`, and the
  // withdrawal — which had no visibility gate — resumed a root nobody could
  // see. It ran 20 → 28 in four seconds and the return jumped the picture
  // eight blocks forward. The release is now one rule, and visibility is part
  // of it.

  it("a normal close still resumes the root — the child's unmount lands first, the master's mount releases", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    store.getState().surfaceUnmounted("tab-a"); // layout B: the pane stands instead of the master
    expect(store.getState().rootPausedByChild).toBe(true);

    // The close is ONE React commit: the child pane goes down and the master
    // surface comes back up. Cleanups run before mount effects, so the
    // withdrawal is first — and with the root still out of frame it releases
    // nothing.
    store.getState().withdrawChild("call-1");
    expect(store.getState().children.size).toBe(0);
    expect(store.getState().focus).toBe("root");
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(true);

    // Then the master's mount effect, and the root goes on — the behaviour
    // confirmed live (23 → 26 → 36 after a close) that a blunt gate would
    // have killed.
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("a tab switch does NOT resume the root: the withdrawal finds it off screen and leaves it parked", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    const cursor = store.getState().root?.cursor;

    // Switching tabs takes the whole tab body down — the master surface with
    // it, and nothing mounts in its place.
    store.getState().surfaceUnmounted("tab-a");
    store.getState().withdrawChild("call-1"); // React unmounts the pane with it

    const parked = store.getState();
    expect(parked.children.size).toBe(0);
    expect(parked.focus).toBe("root");
    expect(parked.root?.playing).toBe(false);
    expect(parked.root?.cursor).toBe(cursor);
    expect(parked.rootPausedByChild).toBe(true); // still the machine's pause — releasable

    // Coming back is what releases it, at exactly the block it was parked on.
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().root?.cursor).toBe(cursor);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("leaving the frame parks a playing root even with no child in sight, and the return starts it again", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(store.getState().root?.playing).toBe(true);

    store.getState().setRootOnScreen(false);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(true);

    store.getState().setRootOnScreen(true);
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("a root paused BY HAND is not started by the frame coming back", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    store.getState().play();
    store.getState().pause();
    expect(store.getState().rootPausedByChild).toBe(false);

    store.getState().setRootOnScreen(false);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false); // nothing to undo — the operator did this

    store.getState().setRootOnScreen(true);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("a root sitting on its LAST frame is not playing, so leaving and re-entering the frame changes nothing", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    store.getState().play();
    // The seek is what stops it: playback is derived from the cursor, and
    // there are no frames left past this one (S13). Nothing is "parked" here —
    // the film had already ended before the surface went away.
    store.getState().seek(3);
    expect(store.getState().root?.cursor).toBe(3);

    store.getState().setRootOnScreen(false);
    store.getState().setRootOnScreen(true);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("the release happens once: a withdrawal off screen plus later ticks and a return do not double-start the root", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(2));
    store.getState().setRootOnScreen(false);
    store.getState().withdrawChild("call-1");

    // The child is gone, so its clock's last tick finds nothing to release.
    store.getState().tick({ child: "call-1" });
    expect(store.getState().root?.playing).toBe(false);

    store.getState().setRootOnScreen(true);
    const released = store.getState();
    expect(released.root?.playing).toBe(true);
    expect(released.rootPausedByChild).toBe(false);

    // A second return writes nothing at all — the frame is already on.
    store.getState().setRootOnScreen(true);
    expect(store.getState()).toBe(released);
  });

  it("a child's blocks keep their own ids — a child list is mounted fresh, so it needs no re-id", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(4));
    store.getState().offerChild("tab-a", "call-1", [userText("kid-0", "a"), userText("kid-1", "b")]);
    store.getState().step(1, { child: "call-1" });
    expect(childVisible(store.getState(), "tab-a", "call-1")?.[0]?.id).toBe("kid-0");
  });
});

// ── S11 (§11 finding D4): a command is not a licence to run off screen ────
//
// Found live, three doors into one hole: Space pressed while ANOTHER tab was
// active drove the hidden root 103 → 107 → 120; Space on the start screen
// drove it 200 → 207; `POST .../replay/play` on the armed-but-hidden tab did
// the same. `End`/`Home` from off screen destroyed the position outright.
// S10 parked the film that ran BY ITSELF; these reducers had no gate at all,
// so any explicit order walked straight past the park. The same hole from the
// other side: an explicit pause off screen was a no-op, which left the
// machine's park flag standing, and coming back resumed the film against the
// operator's order (measured 149 → 152 → 159).

describe("pin 11 — store: the frame gate on the command edge (S11)", () => {
  it("(a) off screen, every command that MOVES the root is a no-op", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    store.getState().setRootOnScreen(false);

    store.getState().play("root");
    expect(store.getState().root?.playing).toBe(false);

    store.getState().toggle("root");
    expect(store.getState().root?.playing).toBe(false);

    store.getState().step(1, "root");
    expect(store.getState().root?.cursor).toBe(0);

    store.getState().seek(5, "root");
    expect(store.getState().root?.cursor).toBe(0);

    // An omitted target means "whatever has focus", and after `arm` that is
    // the root — the hotkeys' own shape, and the one the live smoke used.
    const before = store.getState();
    store.getState().play();
    store.getState().step(1);
    store.getState().seek(5);
    store.getState().toggle();
    expect(store.getState()).toBe(before); // not one write, not one version bump
  });

  it("(b) in frame the same commands are honoured — the gate refuses nothing legitimate", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    store.getState().setRootOnScreen(true);

    store.getState().play("root");
    expect(store.getState().root?.playing).toBe(true);

    store.getState().seek(5, "root");
    expect(store.getState().root?.cursor).toBe(5);

    store.getState().toggle("root");
    expect(store.getState().root?.playing).toBe(false);
    store.getState().toggle("root");
    expect(store.getState().root?.playing).toBe(true);

    store.getState().step(-2, "root");
    expect(store.getState().root?.cursor).toBe(3);
  });

  it("(c) a CHILD's commands are never gated — an accepted child's pane is mounted, so it is on screen", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    store.getState().setRootOnScreen(false); // layout B: the child stands instead of the master
    expect(store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4))).toBe(true);

    store.getState().pause({ child: "call-1" });
    expect(store.getState().children.get("call-1")?.playing).toBe(false);

    store.getState().play({ child: "call-1" });
    expect(store.getState().children.get("call-1")?.playing).toBe(true);

    store.getState().seek(2, { child: "call-1" });
    expect(store.getState().children.get("call-1")?.cursor).toBe(2);

    store.getState().step(1, { child: "call-1" });
    expect(store.getState().children.get("call-1")?.cursor).toBe(3);

    // The child holds the focus, so the bare form addresses it too.
    store.getState().seek(0);
    expect(store.getState().children.get("call-1")?.cursor).toBe(0);
    // …and the root, untouched throughout, is still parked where it was.
    expect(store.getState().root?.cursor).toBe(0);
  });

  it("(d) an explicit pause OUTRANKS the machine's park: the return into frame does not undo it", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().setRootOnScreen(false);
    expect(store.getState().rootPausedByChild).toBe(true); // parked by the machine

    store.getState().pause("root");
    expect(store.getState().rootPausedByChild).toBe(false);
    expect(store.getState().root?.playing).toBe(false);

    store.getState().setRootOnScreen(true);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(e) the same override works against a CHILD's park", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(2));
    expect(store.getState().rootPausedByChild).toBe(true);

    store.getState().pause("root");
    expect(store.getState().rootPausedByChild).toBe(false);

    // The child running out now releases nothing — there is no park to lift.
    store.getState().tick({ child: "call-1" });
    store.getState().tick({ child: "call-1" });
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(f) pausing a playing root in frame stops it and leaves the flag alone", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    store.getState().play();
    expect(store.getState().rootPausedByChild).toBe(false);

    store.getState().pause("root");
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(g) the JSON view reports the park flag — `playing: false` alone cannot tell the two stops apart", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(replayStateJson(store.getState()).rootPausedByChild).toBe(false);

    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(2));
    expect(replayStateJson(store.getState()).root?.playing).toBe(false);
    expect(replayStateJson(store.getState()).rootPausedByChild).toBe(true);

    store.getState().pause("root");
    expect(replayStateJson(store.getState()).root?.playing).toBe(false);
    expect(replayStateJson(store.getState()).rootPausedByChild).toBe(false);
  });
});

// ── S12: the frame flag is DERIVED from what is really mounted ───────────
//
// Every slice before this one answered "is the root in frame" from a
// hand-written list of the ways it could leave — the active tab, the start
// screen, the child layout — and assumed `true` whenever the list said
// nothing. Two live passes each found one more door the list did not name
// (§11 D3, then D4), because a list can only enumerate the doors, never
// derive them. The source is now the one fact all of them share: the root's
// own `SessionSurface` is mounted. Nothing is in frame until one says so.

describe("pin 12 — store: the frame flag follows the mounted surface (S12)", () => {
  it("(a) arming alone is fail-closed; the mount opens the gate, the unmount parks the film", () => {
    const store = createReplayStore();
    expect(store.getState().rootOnScreen).toBe(false); // a fresh store shows nothing
    expect(store.getState().arm("tab-a", fixtureBlocks(6))).toBe(true);
    expect(store.getState().rootOnScreen).toBe(false); // …and arming does not raise it

    // No surface has ever reported in, so the root is not the thing on screen
    // and the command edge will not start it.
    store.getState().play("root");
    expect(store.getState().root?.playing).toBe(false);

    store.getState().surfaceMounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(true);
    store.getState().play("root");
    expect(store.getState().root?.playing).toBe(true);

    store.getState().surfaceUnmounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(false);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().rootPausedByChild).toBe(true); // parked by the machine — releasable

    store.getState().surfaceMounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(true);
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(b) only the ARMED tab's surface counts, and an unmount of an id that never mounted writes nothing", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    expect(store.getState().rootOnScreen).toBe(true);

    // Split and layout B mount a SECOND surface — the child tab's — beside or
    // instead of the master (App.tsx's `ChildSessionPane`). It is not the
    // armed root, so it moves nothing either way.
    const beforeRoot = store.getState().root;
    store.getState().surfaceMounted("other");
    expect(store.getState().rootOnScreen).toBe(true);
    expect(store.getState().root).toBe(beforeRoot);

    store.getState().surfaceUnmounted("other");
    expect(store.getState().rootOnScreen).toBe(true);
    expect(store.getState().root).toBe(beforeRoot);

    const settled = store.getState();
    store.getState().surfaceUnmounted("never-mounted");
    expect(store.getState()).toBe(settled); // not one write, not one version bump
  });

  it("(c) a tick aimed at an out-of-frame root is dropped, and the clock keeps no timer for one", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(fake.pendingHandles()).toHaveLength(1);
    const cursor = store.getState().root?.cursor;

    // The surface goes down mid-frame; the pending timer goes with it.
    store.getState().surfaceUnmounted("tab-a");
    expect(fake.pendingHandles()).toEqual([]);
    expect(store.getState().root?.cursor).toBe(cursor);

    // A tick that reaches the store anyway — the shape a timer firing between
    // the unmount and the cancel would take — moves nothing and re-arms
    // nothing. `tick` advances the cursor whether or not the target is
    // playing, so without this gate one stale frame would still be spent off
    // camera.
    const setCallsBefore = fake.setCalls.length;
    store.getState().tick("root");
    expect(store.getState().root?.cursor).toBe(cursor);
    expect(fake.setCalls).toHaveLength(setCallsBefore);
    expect(fake.pendingHandles()).toEqual([]);

    // Back in frame the clock picks the film up where it stood.
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().root?.cursor).toBe(cursor);
    expect(fake.pendingHandles()).toHaveLength(1);

    dispose();
  });

  it("(d) StrictMode's double mount survives: mount → unmount → mount leaves a playing root where it was", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().seek(2);
    expect(store.getState().root?.cursor).toBe(2);

    // React's StrictMode runs mount → unmount → mount in dev (main.tsx). The
    // mount SET makes the pair cancel out: a park and its release inside one
    // tick, ending "mounted", with not one frame spent.
    store.getState().surfaceMounted("tab-a"); // already mounted — a no-op
    store.getState().surfaceUnmounted("tab-a");
    store.getState().surfaceMounted("tab-a");

    expect(store.getState().rootOnScreen).toBe(true);
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
    expect(store.getState().root?.cursor).toBe(2);
  });

  it("(f) the clock keeps no timer for an out-of-frame root even if the park is bypassed", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(fake.pendingHandles()).toHaveLength(1);

    // Written straight into the store, because the reducers cannot produce
    // this state: leaving the frame PARKS a playing root (S10), so "playing
    // and out of frame" is unreachable through them. That is precisely why
    // the clock carries the check of its own — the invariant must not rest on
    // the park being the only route out of frame.
    store.setState({ rootOnScreen: false });
    expect(fake.pendingHandles()).toEqual([]);
    expect(store.getState().root?.playing).toBe(true); // still "playing", with no clock to move it
    expect(store.getState().root?.cursor).toBe(0);

    dispose();
  });

  it("(e) disarm leaves the mount set alone — mounting is React's fact, so the next arming is live at once", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    expect(store.getState().rootOnScreen).toBe(true);

    store.getState().disarm();
    // With nothing armed nothing can be in frame…
    expect(store.getState().rootOnScreen).toBe(false);
    // …but the surface never went anywhere: the tab is still the one on screen.
    expect(store.getState().mountedSurfaces.has("tab-a")).toBe(true);

    expect(store.getState().arm("tab-a", fixtureBlocks(4))).toBe(true);
    expect(store.getState().rootOnScreen).toBe(true); // no second seam needed
    store.getState().play("root");
    expect(store.getState().root?.playing).toBe(true);

    // `reset` — the test hatch — is the one thing that does clear it.
    store.getState().reset();
    expect(store.getState().mountedSurfaces.size).toBe(0);
    expect(store.getState().rootOnScreen).toBe(false);
  });
});

// ── S13 (§11 fifth live pass, findings D5/D6): a consequence is derived, ──
// never remembered.
//
// Two rules of this store used to live as lists of the places that thought to
// apply them, and both lists were short by exactly the cases the smoke found.
// "Playback stops at the end of the tape" was asked by `play`, `toggle`,
// `releaseRoot` and `offerChild` — but not by `step` or `seek`, so `End` left
// the root reading `382/382 playing:true` for good: the clock arms no timer
// past the last frame, so nothing was ever going to switch it off, and `Home`
// afterwards restarted the film by itself. "The film goes back to the root"
// was applied by `tick`, `withdrawChild` and `setRootOnScreen` — but a child
// brought to its end by `End`/`step`/`seek` is none of those three, so in
// split the root stayed parked forever, and in layout B the auto-close never
// armed because it read the child's stuck `playing: true` as "still running".
// Both are now derived from the write itself: `moveTarget` computes playback
// from the clamped cursor, and `commit` judges the release after every patch.

describe("pin 13 — store: playback and the hand-back are derived, not remembered (S13)", () => {
  it("(a) D6: a root driven to the end by seek is NOT playing, and stepping back does not restart it", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    expect(store.getState().root?.playing).toBe(true);

    store.getState().seek(Number.MAX_SAFE_INTEGER);
    expect(replayStateJson(store.getState()).root).toEqual({ cursor: 6, total: 6, playing: false });

    // Rewinding gives frames back but not playback — the film is stopped, and
    // only an operator's command starts it. Before S13 the `playing: true`
    // rode back down with the cursor and the clock picked the film up again.
    store.getState().step(-1);
    expect(replayStateJson(store.getState()).root).toEqual({ cursor: 5, total: 6, playing: false });

    store.getState().play();
    expect(store.getState().root?.playing).toBe(true);
  });

  it("(b) D6: the same holds for a step that overshoots the end", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    store.getState().play();

    store.getState().step(3);
    expect(replayStateJson(store.getState()).root).toEqual({ cursor: 3, total: 3, playing: false });
  });

  it("(c) D5 split: a child sought to its end hands the film back — with no tick at all", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6)); // the master surface stays mounted: this is split
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4));
    expect(store.getState().rootPausedByChild).toBe(true);

    store.getState().seek(Number.MAX_SAFE_INTEGER, { child: "call-1" });

    const state = store.getState();
    expect(state.children.get("call-1")).toMatchObject({ cursor: 4, playing: false });
    expect(state.root?.playing).toBe(true);
    expect(state.rootPausedByChild).toBe(false);
    expect(state.focus).toBe("root");
  });

  it("(d) D5 layout B: the same seek finishes the child; the pane closing is what frees the root", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4));
    store.getState().surfaceUnmounted("tab-a"); // layout B: the pane stands instead of the master

    store.getState().seek(Number.MAX_SAFE_INTEGER, { child: "call-1" });

    const parked = store.getState();
    expect(parked.children.get("call-1")).toMatchObject({ cursor: 4, playing: false });
    expect(parked.root?.playing).toBe(false);
    expect(parked.rootPausedByChild).toBe(true);
    expect(parked.focus).toEqual({ child: "call-1" });

    // `playing: false` is what the facade's auto-close watch waits for; the
    // close it then clicks takes this exact path.
    store.getState().withdrawChild("call-1");
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(e) GUARD: play and toggle on an exhausted target write nothing at all", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    store.getState().seek(3);

    const settled = store.getState();
    store.getState().play();
    store.getState().toggle();
    expect(store.getState()).toBe(settled); // not one write, not one version bump
  });

  it("(f) the clock keeps no timer for a target seeked to its end, and the state says so", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(4));

    store.getState().play();
    expect(fake.pendingHandles()).toHaveLength(1);

    store.getState().seek(4);
    expect(store.getState().root?.playing).toBe(false);
    expect(fake.pendingHandles()).toEqual([]);

    dispose();
  });

  it("(g) an EMPTY child is exhausted on arrival: the park and the release cancel out in one write", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();

    expect(store.getState().offerChild("tab-a", "call-1", [])).toBe(true);

    const state = store.getState();
    expect(state.children.get("call-1")).toMatchObject({ cursor: 0, playing: false });
    expect(state.root?.playing).toBe(true);
    expect(state.rootPausedByChild).toBe(false);
    expect(state.focus).toBe("root");
  });

  it("(h) the release still happens ONCE: later ticks and a frame round-trip do not double-start it", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    store.getState().seek(9, { child: "call-1" });

    const released = store.getState();
    expect(released.root?.playing).toBe(true);
    expect(released.rootPausedByChild).toBe(false);
    const cursor = released.root?.cursor;

    // The child's own clock may still deliver one last tick; it moves nothing.
    store.getState().tick({ child: "call-1" });
    expect(store.getState()).toBe(released);

    store.getState().surfaceUnmounted("tab-a");
    store.getState().surfaceMounted("tab-a");
    expect(store.getState().root?.cursor).toBe(cursor);
    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().rootPausedByChild).toBe(false);
  });

  it("(i) GUARD: a root stopped BY HAND is not started by a child being sought to its end", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().play();
    store.getState().pause();
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));
    expect(store.getState().rootPausedByChild).toBe(false);

    store.getState().seek(9, { child: "call-1" });

    // Deliberately says nothing about the CHILD's own playback: this pin
    // guards only that a hand-stopped root is left alone, so it must hold
    // before S13 as well as after it.
    expect(store.getState().children.get("call-1")?.cursor).toBe(3);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().focus).toEqual({ child: "call-1" });
  });

  it("(j) GUARD: a tick advances the cursor but never STARTS a stopped film", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));

    // The clock only ticks a target it believes to be playing, but `tick` is a
    // public reducer and deliberately moves the cursor either way — pin 12 (c)
    // leans on exactly that. Collapsing it to one `moveTarget` (S13) must not
    // turn "advance" into "start".
    store.getState().tick("root");
    expect(store.getState().root).toMatchObject({ cursor: 1, playing: false });
  });
});

// ── pin 14 (S14) ──────────────────────────────────────────────────────────

describe("pin 14 — isReplaySurface: a surface is under replay iff its tab is the armed one (S14)", () => {
  it("(d) nothing armed — no tab is a replay surface, and neither is a list outside any tab context", () => {
    const store = createReplayStore();
    expect(isReplaySurface(store.getState(), "tab-a")).toBe(false);
    expect(isReplaySurface(store.getState(), null)).toBe(false);
  });

  it("(e) armed — the armed tab answers true, any other tab and a null tab answer false", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    expect(isReplaySurface(store.getState(), "tab-a")).toBe(true);
    expect(isReplaySurface(store.getState(), "tab-b")).toBe(false);
    expect(isReplaySurface(store.getState(), null)).toBe(false);
  });

  it("(f) EDITION GUARD: the fact is ARMING, not mounting — layout B's unmounted root is still a replay surface", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    // Layout B: the child pane replaces the root's SessionSurface, and that
    // pane is rendered under the ROOT tab's context. Deriving this from
    // `rootOnScreen` would blank the wrong list — and un-blank the pane.
    store.getState().surfaceUnmounted("tab-a");
    expect(store.getState().rootOnScreen).toBe(false);
    expect(isReplaySurface(store.getState(), "tab-a")).toBe(true);
  });

  it("(g) disarming takes the surface back to the product's own empty state", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    store.getState().disarm();
    expect(isReplaySurface(store.getState(), "tab-a")).toBe(false);
  });

  it("(h) GUARD: childVisible answers through the same predicate — a parked child is [], a foreign root is null", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(3));
    store.getState().offerChild("tab-a", "call-1", [userText("kid-0")]);
    expect(childVisible(store.getState(), "tab-a", "call-1")).toEqual([]);
    expect(childVisible(store.getState(), "tab-b", "call-1")).toBeNull();
    expect(childVisible(store.getState(), null, "call-1")).toBeNull();
  });
});

// ── pin 7 ─────────────────────────────────────────────────────────────────

describe("pin 7 — store: setParams", () => {
  it("a valid patch rebuilds every frame plan, keeps the cursor and bumps the version", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4));
    // An accepted child owns the focus, so the root must be addressed by name.
    store.getState().seek(3, "root");
    expect(store.getState().children.get("call-1")?.cursor).toBe(0);
    const beforeRoot = store.getState().root;
    const beforeDelay = beforeRoot?.frames[0]?.delayMs ?? 0;
    const beforeVersion = beforeRoot?.version ?? 0;

    store.getState().setParams({ speed: 3 });

    const state = store.getState();
    expect(state.params.speed).toBe(3);
    expect(state.root?.frames[0]?.delayMs).toBe(beforeDelay / 3);
    expect(state.root?.cursor).toBe(3);
    expect(state.root?.version).toBeGreaterThan(beforeVersion);
    expect(state.children.get("call-1")?.frames[0]?.delayMs).toBe(
      frameDelayMs(fixtureBlocks(4)[0] as TranscriptBlock, state.params),
    );
    // The visible prefix did not move, so its reference is preserved.
    expect(state.root?.visible).toBe(beforeRoot?.visible);
  });

  it("garbage is ignored whole: a non-numeric speed and a negative stepMs change nothing", () => {
    const store = createReplayStore();
    store.getState().arm("tab-a", fixtureBlocks(6));
    const before = store.getState().root;

    store.getState().setParams({ speed: "fast" });
    store.getState().setParams({ stepMs: -5 });
    store.getState().setParams({ speed: 0 });
    store.getState().setParams({ speed: Number.POSITIVE_INFINITY });
    store.getState().setParams(null);
    store.getState().setParams("nope");

    const state = store.getState();
    expect(state.params).toEqual(DEFAULT_REPLAY_PARAMS);
    expect(state.root).toBe(before);
    expect(state.root?.version).toBe(before?.version);
  });

  it("childDoneCloseMs (S8.2) is a validated non-negative param, ON by default at 1500 ms (S9.3)", () => {
    // S9.3 reversed S8.2's own default. The auto-close is reachable only with
    // a replay armed, only in layout B and only past the end of a child's
    // timeline; shipping it off meant the film froze on every finished child
    // out of the box — the exact stall the feature exists to remove. `0`
    // still turns it off for an operator who wants to close panes by hand.
    expect(DEFAULT_REPLAY_PARAMS.childDoneCloseMs).toBe(1500);
    expect(mergeReplayParams(DEFAULT_REPLAY_PARAMS, { childDoneCloseMs: 0 }).childDoneCloseMs).toBe(0);
    expect(mergeReplayParams(DEFAULT_REPLAY_PARAMS, { childDoneCloseMs: 400 }).childDoneCloseMs).toBe(400);
    expect(mergeReplayParams(DEFAULT_REPLAY_PARAMS, { childDoneCloseMs: -1 })).toBe(DEFAULT_REPLAY_PARAMS);
    expect(mergeReplayParams(DEFAULT_REPLAY_PARAMS, { childDoneCloseMs: "soon" })).toBe(DEFAULT_REPLAY_PARAMS);
  });

  it("mergeReplayParams accepts per-kind scales and leaves the base object untouched", () => {
    const merged = mergeReplayParams(DEFAULT_REPLAY_PARAMS, { kindScale: { reasoning: 2, tool_call: "x" } });
    expect(merged.kindScale.reasoning).toBe(2);
    expect(merged.kindScale.tool_call).toBe(0.8);
    expect(DEFAULT_REPLAY_PARAMS.kindScale.reasoning).toBe(0.5);
    expect(mergeReplayParams(DEFAULT_REPLAY_PARAMS, { stepMs: 350 })).toBe(DEFAULT_REPLAY_PARAMS);
  });
});

// ── pin 8 ─────────────────────────────────────────────────────────────────

describe("pin 8 — createReplayClock with an injected timer", () => {
  it("play arms exactly one timer for the frame under the cursor; firing it advances and re-arms", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(5));
    expect(fake.setCalls).toHaveLength(0);

    store.getState().play();
    const frames = store.getState().root?.frames ?? [];
    expect(fake.setCalls).toHaveLength(1);
    expect(fake.setCalls[0]?.ms).toBe(frames[0]?.delayMs);

    fake.fire(1);
    expect(store.getState().root?.cursor).toBe(1);
    expect(store.getState().root?.visible).toHaveLength(1);
    expect(fake.setCalls).toHaveLength(2);
    expect(fake.setCalls[1]?.ms).toBe(frames[1]?.delayMs);

    dispose();
  });

  it("pause clears the pending timer; a seek while one is pending clears the old and arms a new one", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(6));

    store.getState().play();
    expect(fake.pendingHandles()).toEqual([1]);
    store.getState().pause();
    expect(fake.clearCalls).toEqual([1]);
    expect(fake.pendingHandles()).toEqual([]);

    store.getState().play();
    expect(fake.pendingHandles()).toEqual([2]);
    store.getState().seek(3);
    expect(fake.clearCalls).toEqual([1, 2]);
    expect(fake.pendingHandles()).toEqual([3]);
    expect(fake.setCalls[2]?.ms).toBe(store.getState().root?.frames[3]?.delayMs);

    dispose();
  });

  it("the last frame stops playback and leaves no timer behind", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(3));

    store.getState().seek(2);
    store.getState().play();
    expect(fake.pendingHandles()).toHaveLength(1);

    fake.fire(1);

    expect(store.getState().root?.cursor).toBe(3);
    expect(store.getState().root?.playing).toBe(false);
    expect(store.getState().root?.visible).toHaveLength(3);
    expect(fake.pendingHandles()).toEqual([]);

    // Play at the end is inert: there is no frame left to schedule.
    store.getState().play();
    expect(store.getState().root?.playing).toBe(false);
    expect(fake.pendingHandles()).toEqual([]);

    dispose();
  });

  it("a playing root and a playing child hold two independent timers, and dispose clears both", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    store.getState().setParams({ pauseRootWhileChild: false });
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(5));
    store.getState().play("root");
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4));

    expect(store.getState().root?.playing).toBe(true);
    expect(store.getState().children.get("call-1")?.playing).toBe(true);
    expect(fake.pendingHandles()).toHaveLength(2);

    fake.fire(2);
    expect(store.getState().children.get("call-1")?.cursor).toBe(1);
    expect(store.getState().root?.cursor).toBe(0);

    dispose();
    expect(fake.pendingHandles()).toEqual([]);
  });

  it("withdrawing a child and disarming cancel their timers", () => {
    const fake = createFakeTimer();
    const store = createReplayStore();
    store.getState().setParams({ pauseRootWhileChild: false });
    const dispose = createReplayClock(store, fake.timer);
    armOnScreen(store, fixtureBlocks(5));
    store.getState().play("root");
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(4));
    expect(fake.pendingHandles()).toHaveLength(2);

    store.getState().withdrawChild("call-1");
    expect(fake.pendingHandles()).toHaveLength(1);

    store.getState().disarm();
    expect(fake.pendingHandles()).toEqual([]);

    dispose();
  });
});

// ── pin 9 ─────────────────────────────────────────────────────────────────

describe("pin 9 — replayKeyAction / isEditableTarget", () => {
  const table: [string, string][] = [
    [" ", "toggle"],
    ["ArrowRight", "step_forward"],
    ["ArrowLeft", "step_back"],
    ["Home", "seek_start"],
    ["End", "seek_end"],
    ["]", "faster"],
    ["[", "slower"],
    ["Backspace", "disarm"],
  ];

  it("maps the plan's table while armed", () => {
    for (const [key, action] of table) {
      expect(replayKeyAction(key, false, true)).toBe(action);
    }
    expect(replayKeyAction("Escape", false, true)).toBeNull();
    expect(replayKeyAction("a", false, true)).toBeNull();
  });

  it("goes silent inside a text field and while not armed", () => {
    for (const [key] of table) {
      expect(replayKeyAction(key, true, true)).toBeNull();
      expect(replayKeyAction(key, false, false)).toBeNull();
    }
  });

  it("isEditableTarget: INPUT / TEXTAREA / contentEditable are editable, a DIV and null are not", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isEditableTarget({})).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

// ── pin 10 ────────────────────────────────────────────────────────────────

describe("pin 10 — replayStateJson", () => {
  function hasFunction(value: unknown): boolean {
    if (typeof value === "function") {
      return true;
    }
    if (Array.isArray(value)) {
      return value.some(hasFunction);
    }
    if (value !== null && typeof value === "object") {
      return Object.values(value).some(hasFunction);
    }
    return false;
  }

  it("reports counts only — stringifiable, function-free, and matching the live state", () => {
    const store = createReplayStore();
    armOnScreen(store, fixtureBlocks(6));
    store.getState().seek(2);
    store.getState().offerChild("tab-a", "call-1", fixtureBlocks(3));

    const json = replayStateJson(store.getState());

    expect(hasFunction(json)).toBe(false);
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);

    expect(json.armed).toEqual({ rootTabId: "tab-a" });
    expect(json.focus).toEqual({ child: "call-1" });
    expect(json.root).toEqual({ cursor: 2, total: 6, playing: false });
    expect(json.children).toEqual([{ spawnToolCallId: "call-1", cursor: 0, total: 3, playing: true }]);
    expect(json.params).toEqual(DEFAULT_REPLAY_PARAMS);
    expect(json.params).not.toBe(store.getState().params);
  });

  it("an unarmed store reports nulls and an empty child list", () => {
    const store = createReplayStore();
    const json = replayStateJson(store.getState());
    expect(json.armed).toBeNull();
    expect(json.root).toBeNull();
    expect(json.children).toEqual([]);
    expect(json.focus).toBe("root");
  });
});

// ── reset (test-only hatch, mirroring the other stores) ───────────────────

describe("reset", () => {
  it("returns the store to its initial state, params included", () => {
    const store = createReplayStore();
    store.getState().setParams({ speed: 4 });
    store.getState().arm("tab-a", fixtureBlocks(3));
    store.getState().reset();

    const state = store.getState();
    expect(state.armed).toBeNull();
    expect(state.root).toBeNull();
    expect(state.params).toBe(DEFAULT_REPLAY_PARAMS);
    expect(state.children.size).toBe(0);
  });
});

// A frame is a plain data record — no behaviour, so S6 can add fields freely.
const _frameShape: ReplayFrame = { upto: 1, delayMs: 0 };
void _frameShape;

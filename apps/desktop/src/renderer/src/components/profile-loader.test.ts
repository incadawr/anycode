/**
 * Load-controller tests (TASK.187 S4, plan §S4 test list). Same
 * `.test.ts`-only, node-environment, no-jsdom rationale as every other
 * Settings-pane test in this directory — which is exactly why the reducer
 * and the controller live in their own module instead of inside
 * ProfilePane's `useEffect`: everything the pane does about loading is
 * reachable here as plain functions.
 *
 * The out-of-order matrix below is the point of the file. For EVERY fresh
 * request kind it drives both orderings that a "newest wins" rule alone gets
 * wrong: a stale REFUSAL landing after a newer SUCCESS (must not paint an
 * error over good numbers) and a stale SUCCESS landing after a newer REFUSAL
 * (must not roll the view back nor silently clear the error), plus the pin
 * that neither of them may clear the `inFlight` flag owned by the newer
 * request.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ProfileStatsCachedResult,
  ProfileStatsResult,
  ProfileStatsView,
} from "../../../shared/profile-config.js";
import {
  computeProfilePhase,
  createProfileLoader,
  initialProfileLoadState,
  computeCollapseProgress,
  isEmptyProfileAggregate,
  isProfileCatchingUp,
  isProfileRequestAllowed,
  profileLoadReducer,
  profileUpdateErrorText,
  shouldAutoContinue,
  type ProfileFreshRequestKind,
  type ProfileLoadAction,
  type ProfileLoadState,
  type ProfileLoaderBridge,
} from "./profile-loader.js";

function view(overrides: Partial<ProfileStatsView> = {}): ProfileStatsView {
  return {
    lifetimeTokens: 0,
    peakDay: null,
    longestSessionMs: 0,
    currentStreakDays: 0,
    longestStreakDays: 0,
    totalSessions: 0,
    totalRuns: 0,
    toolCalls: 0,
    subagentRuns: 0,
    truncated: false,
    coverageStartTs: null,
    backlogRemaining: 0,
    pendingExactSessions: 0,
    days: {},
    models: [],
    engineTokens: {},
    telemetryEnabled: true,
    killSwitchActive: false,
    dir: "/Users/x/.anycode/telemetry",
    ...overrides,
  };
}

const ok = (tokens: number): ProfileStatsResult => ({ ok: true, view: view({ lifetimeTokens: tokens }) });
/** A pass carrying real numbers: `totalSessions > 0` is what makes an aggregate non-empty. */
const okData = (tokens: number, backlog = 0): ProfileStatsResult => ({
  ok: true,
  view: view({ lifetimeTokens: tokens, totalSessions: 4, backlogRemaining: backlog, truncated: backlog > 0 }),
});
/** A pass that aggregated NOTHING. `truncated` is the whole difference between a collapsed scan and a genuinely emptied directory. */
const okEmpty = (truncated: boolean, backlog = 0): ProfileStatsResult => ({
  ok: true,
  view: view({ lifetimeTokens: 0, totalSessions: 0, truncated, backlogRemaining: backlog }),
});
/** A pass that closed the file backlog but has not finished the exact activity pass. */
const okPendingExact = (pending: number, tokens = 1): ProfileStatsResult => ({
  ok: true,
  view: view({ lifetimeTokens: tokens, totalSessions: 4, backlogRemaining: 0, pendingExactSessions: pending }),
});
/** A pass that came back with `n` files still to aggregate — the catch-up trigger. */
const okBacklog = (n: number, tokens = 1): ProfileStatsResult => ({
  ok: true,
  view: view({ lifetimeTokens: tokens, backlogRemaining: n, truncated: n > 0 }),
});
const refused: ProfileStatsResult = { ok: false, reason: "io_error" };
const cachedOk = (tokens: number): ProfileStatsCachedResult => ({ ok: true, view: view({ lifetimeTokens: tokens }) });
const noCache: ProfileStatsCachedResult = { ok: false, reason: "no_cache" };

/** Folds a whole action sequence through the reducer — every test below reads as the timeline it is testing. */
function run(actions: ProfileLoadAction[], from: ProfileLoadState = initialProfileLoadState()): ProfileLoadState {
  return actions.reduce(profileLoadReducer, from);
}

const FRESH_KINDS: ProfileFreshRequestKind[] = ["mount-fresh", "refresh", "set-telemetry", "rebuild"];

// ── reducer: the happy paths ──

describe("profileLoadReducer — starting and settling", () => {
  it("a fresh start claims the generation and raises the busy flag", () => {
    const state = run([{ type: "start", kind: "mount-fresh", gen: 1 }]);
    expect(state).toMatchObject({ latestGen: 1, inFlight: "mount-fresh", view: null, error: null });
  });

  it("a cached start claims NEITHER the generation nor the busy flag", () => {
    const state = run([{ type: "start", kind: "mount-cached", gen: 1 }]);
    expect(state).toEqual(initialProfileLoadState());
  });

  it("a current fresh success applies the view, marks the source and ends the flight", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: ok(10) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(10);
    expect(state).toMatchObject({ source: "fresh", appliedGen: 1, inFlight: null, error: null });
  });

  it("a current fresh refusal keeps the live view and puts the error BESIDE it", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: ok(10) },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: refused },
    ]);
    expect(state.view?.lifetimeTokens).toBe(10);
    expect(state).toMatchObject({ source: "fresh", inFlight: null, error: { kind: "refresh", reason: "io_error" } });
  });

  it("the next success clears a standing error", () => {
    const state = run([
      { type: "start", kind: "refresh", gen: 1 },
      { type: "settle", kind: "refresh", gen: 1, result: refused },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: ok(7) },
    ]);
    expect(state.error).toBeNull();
    expect(state.view?.lifetimeTokens).toBe(7);
  });

  it("a refusal never advances appliedGen — nothing was applied", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 2 },
      { type: "settle", kind: "mount-fresh", gen: 2, result: refused },
    ]);
    expect(state.appliedGen).toBe(0);
  });
});

// ── reducer: the cached placeholder ──

describe("profileLoadReducer — the cached read is a placeholder, never an authority", () => {
  it("a cached success paints the first frame while the fresh read is still out", () => {
    const state = run([
      { type: "start", kind: "mount-cached", gen: 1 },
      { type: "start", kind: "mount-fresh", gen: 2 },
      { type: "settle", kind: "mount-cached", gen: 1, result: cachedOk(5) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(5);
    expect(state).toMatchObject({ source: "cache", inFlight: "mount-fresh", appliedGen: 1 });
  });

  it("a cached success arriving AFTER the fresh view is ignored (no rollback to older numbers)", () => {
    const state = run([
      { type: "start", kind: "mount-cached", gen: 1 },
      { type: "start", kind: "mount-fresh", gen: 2 },
      { type: "settle", kind: "mount-fresh", gen: 2, result: ok(99) },
      { type: "settle", kind: "mount-cached", gen: 1, result: cachedOk(5) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(99);
    expect(state.source).toBe("fresh");
  });

  it("a cached refusal is silent — no error, no view, and the fresh flight keeps running", () => {
    const state = run([
      { type: "start", kind: "mount-cached", gen: 1 },
      { type: "start", kind: "mount-fresh", gen: 2 },
      { type: "settle", kind: "mount-cached", gen: 1, result: noCache },
    ]);
    expect(state).toMatchObject({ error: null, view: null, inFlight: "mount-fresh" });
  });

  it("a cached success still lands after a fresh REFUSAL — an error is not a view", () => {
    const state = run([
      { type: "start", kind: "mount-cached", gen: 1 },
      { type: "start", kind: "mount-fresh", gen: 2 },
      { type: "settle", kind: "mount-fresh", gen: 2, result: refused },
      { type: "settle", kind: "mount-cached", gen: 1, result: cachedOk(5) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(5);
    expect(state.source).toBe("cache");
    expect(state.error).toMatchObject({ kind: "mount-fresh" });
  });
});

// ── reducer: the out-of-order matrix (review-v3 finding 5) ──

describe.each(FRESH_KINDS)("profileLoadReducer — stale settles of kind %s", (kind) => {
  /** gen 1 succeeded, gen 2 (of `kind`) is live; the stale gen-1 settle arrives last. */
  const withNewerSuccess = (staleResult: ProfileStatsResult): ProfileLoadState =>
    run([
      { type: "start", kind: "refresh", gen: 1 },
      { type: "start", kind, gen: 2 },
      { type: "settle", kind, gen: 2, result: ok(42) },
      { type: "start", kind: "refresh", gen: 3 },
      { type: "settle", kind, gen: 2, result: staleResult },
    ]);

  it("a stale REFUSAL after a newer SUCCESS sets no error and does not touch the view", () => {
    const state = withNewerSuccess(refused);
    expect(state.error).toBeNull();
    expect(state.view?.lifetimeTokens).toBe(42);
  });

  it("a stale SUCCESS after a newer SUCCESS does not overwrite the newer view", () => {
    const state = run([
      { type: "start", kind, gen: 1 },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: ok(42) },
      { type: "settle", kind, gen: 1, result: ok(7) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(42);
  });

  it("a stale SUCCESS after a newer REFUSAL neither rolls the view back nor clears the error", () => {
    const state = run([
      { type: "start", kind, gen: 1 },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: ok(42) },
      { type: "start", kind: "refresh", gen: 3 },
      { type: "settle", kind: "refresh", gen: 3, result: refused },
      { type: "settle", kind, gen: 1, result: ok(7) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(42);
    expect(state.error).toMatchObject({ kind: "refresh", reason: "io_error" });
  });

  it("a stale settle of EITHER outcome leaves the live request's inFlight standing", () => {
    for (const staleResult of [refused, ok(7)]) {
      const state = run([
        { type: "start", kind, gen: 1 },
        { type: "start", kind: "refresh", gen: 2 },
        { type: "settle", kind, gen: 1, result: staleResult },
      ]);
      expect(state.inFlight).toBe("refresh");
    }
  });
});

// ── reducer: unmount ──

describe("profileLoadReducer — unmount", () => {
  it("every action after unmount is a no-op, whatever it carries", () => {
    const dead = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "unmount" },
    ]);
    const after = run(
      [
        { type: "settle", kind: "mount-fresh", gen: 1, result: ok(42) },
        { type: "start", kind: "refresh", gen: 2 },
        { type: "settle", kind: "mount-cached", gen: 1, result: cachedOk(5) },
      ],
      dead,
    );
    expect(after).toBe(dead);
    expect(after.view).toBeNull();
  });
});

// ── derived helpers ──

describe("computeProfilePhase", () => {
  const base = initialProfileLoadState();

  it("nothing on screen and a request out -> skeleton", () => {
    expect(computeProfilePhase({ ...base, inFlight: "mount-fresh" })).toBe("skeleton");
  });

  it("cache numbers on screen while a fresh read verifies -> cached-updating", () => {
    expect(computeProfilePhase({ ...base, view: view(), source: "cache", inFlight: "mount-fresh" })).toBe(
      "cached-updating",
    );
  });

  it("scanned numbers on screen while another scan runs -> refreshing", () => {
    expect(computeProfilePhase({ ...base, view: view(), source: "fresh", inFlight: "refresh" })).toBe("refreshing");
  });

  it("nothing outstanding -> ready, including the failed-with-nothing-to-show case", () => {
    expect(computeProfilePhase({ ...base, view: view(), source: "fresh" })).toBe("ready");
    expect(computeProfilePhase({ ...base, latestGen: 1, error: { kind: "mount-fresh", reason: "io_error" } })).toBe(
      "ready",
    );
  });

  it("the frame before mount() has run reads as skeleton, never as an empty ready", () => {
    expect(computeProfilePhase(initialProfileLoadState())).toBe("skeleton");
  });
});

describe("isProfileRequestAllowed", () => {
  const base = initialProfileLoadState();

  it("an idle pane allows every kind", () => {
    for (const kind of FRESH_KINDS) {
      expect(isProfileRequestAllowed(base, kind)).toBe(true);
    }
  });

  it("a live read blocks the other reads but never the telemetry write", () => {
    const busy = { ...base, inFlight: "refresh" as const };
    expect(isProfileRequestAllowed(busy, "refresh")).toBe(false);
    expect(isProfileRequestAllowed(busy, "rebuild")).toBe(false);
    expect(isProfileRequestAllowed(busy, "set-telemetry")).toBe(true);
  });

  it("a live telemetry write blocks only a second write", () => {
    const writing = { ...base, inFlight: "set-telemetry" as const };
    expect(isProfileRequestAllowed(writing, "set-telemetry")).toBe(false);
    expect(isProfileRequestAllowed(writing, "refresh")).toBe(false);
  });

  it("a disposed loader allows nothing", () => {
    expect(isProfileRequestAllowed({ ...base, disposed: true }, "refresh")).toBe(false);
  });
});

describe("profileUpdateErrorText", () => {
  it("names the action and the reason, and promises previous numbers only when there are some", () => {
    expect(profileUpdateErrorText({ kind: "refresh", reason: "io_error" }, true)).toBe(
      "Couldn't refresh the stats — the telemetry folder could not be read. Showing the previously loaded numbers.",
    );
    expect(profileUpdateErrorText({ kind: "refresh", reason: "io_error" }, false)).toBe(
      "Couldn't refresh the stats — the telemetry folder could not be read.",
    );
  });

  it("each kind gets its own action wording", () => {
    expect(profileUpdateErrorText({ kind: "set-telemetry", reason: "invalid" }, false)).toBe(
      "Couldn't change the telemetry setting — the request was refused.",
    );
    expect(profileUpdateErrorText({ kind: "rebuild", reason: "io_error" }, false)).toBe(
      "Couldn't rebuild the stats cache — the telemetry folder could not be read.",
    );
  });
});

// ── controller, on hand-resolved promises ──

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A bridge whose four calls hand back deferreds the test resolves by hand, in whatever order it wants to prove. */
function fakeBridge() {
  const queues = {
    getStats: [] as Deferred<ProfileStatsResult>[],
    getStatsCached: [] as Deferred<ProfileStatsCachedResult>[],
    setTelemetry: [] as Deferred<ProfileStatsResult>[],
    rebuildStats: [] as Deferred<ProfileStatsResult>[],
  };
  const setTelemetryArgs: boolean[] = [];
  const bridge: ProfileLoaderBridge = {
    getStats: () => {
      const d = deferred<ProfileStatsResult>();
      queues.getStats.push(d);
      return d.promise;
    },
    getStatsCached: () => {
      const d = deferred<ProfileStatsCachedResult>();
      queues.getStatsCached.push(d);
      return d.promise;
    },
    setTelemetry: (enabled: boolean) => {
      setTelemetryArgs.push(enabled);
      const d = deferred<ProfileStatsResult>();
      queues.setTelemetry.push(d);
      return d.promise;
    },
    rebuildStats: () => {
      const d = deferred<ProfileStatsResult>();
      queues.rebuildStats.push(d);
      return d.promise;
    },
  };
  return { bridge, queues, setTelemetryArgs };
}

/** Lets every already-resolved promise callback run (microtask drain). */
const settleAll = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createProfileLoader — mount", () => {
  it("fires the cached read and the fresh read in parallel", () => {
    const { bridge, queues } = fakeBridge();
    createProfileLoader(bridge, () => {}).mount();
    expect(queues.getStatsCached).toHaveLength(1);
    expect(queues.getStats).toHaveLength(1);
  });

  it("cache first -> instant frame in cached-updating, then the fresh view -> ready", async () => {
    const { bridge, queues } = fakeBridge();
    const onState = vi.fn();
    const loader = createProfileLoader(bridge, onState);
    loader.mount();

    queues.getStatsCached[0]!.resolve(cachedOk(5));
    await settleAll();
    expect(computeProfilePhase(loader.getState())).toBe("cached-updating");
    expect(loader.getState().view?.lifetimeTokens).toBe(5);

    queues.getStats[0]!.resolve(ok(50));
    await settleAll();
    expect(computeProfilePhase(loader.getState())).toBe("ready");
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
  });

  it("fresh first -> the late cached answer is ignored", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();

    queues.getStats[0]!.resolve(ok(50));
    await settleAll();
    queues.getStatsCached[0]!.resolve(cachedOk(5));
    await settleAll();

    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(loader.getState().source).toBe("fresh");
  });

  it("no cache yet -> the pane stays on the skeleton, with no error", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();

    queues.getStatsCached[0]!.resolve(noCache);
    await settleAll();

    expect(computeProfilePhase(loader.getState())).toBe("skeleton");
    expect(loader.getState().error).toBeNull();
  });

  it("a second mount() on the same loader is ignored", () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    loader.mount();
    expect(queues.getStats).toHaveLength(1);
  });
});

describe("createProfileLoader — refresh", () => {
  async function mounted() {
    const fake = fakeBridge();
    const loader = createProfileLoader(fake.bridge, () => {});
    loader.mount();
    fake.queues.getStatsCached[0]!.resolve(noCache);
    fake.queues.getStats[0]!.resolve(ok(50));
    await settleAll();
    return { ...fake, loader };
  }

  it("keeps the old numbers on screen and reports the flight", async () => {
    const { loader, queues } = await mounted();
    expect(loader.refresh()).toBe(true);
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(computeProfilePhase(loader.getState())).toBe("refreshing");

    queues.getStats[1]!.resolve(ok(60));
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(60);
    expect(computeProfilePhase(loader.getState())).toBe("ready");
  });

  it("a double click issues exactly one request", async () => {
    const { loader, queues } = await mounted();
    expect(loader.refresh()).toBe(true);
    expect(loader.refresh()).toBe(false);
    expect(queues.getStats).toHaveLength(2); // the mount read + one refresh
  });

  it("a refusal leaves the numbers up and raises the error banner", async () => {
    const { loader, queues } = await mounted();
    loader.refresh();
    queues.getStats[1]!.resolve(refused);
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(loader.getState().error).toMatchObject({ kind: "refresh" });
  });

  it("a REJECTED bridge promise is treated as an io refusal, never a stuck spinner", async () => {
    const { loader, queues } = await mounted();
    loader.refresh();
    queues.getStats[1]!.reject(new Error("ipc died"));
    await settleAll();
    expect(loader.getState().inFlight).toBeNull();
    expect(loader.getState().error).toMatchObject({ kind: "refresh", reason: "io_error" });
  });
});

describe("createProfileLoader — the telemetry toggle is a request like any other", () => {
  it("a toggle answered after a slower mount read wins; the late mount read is dropped", async () => {
    const { bridge, queues, setTelemetryArgs } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();

    expect(loader.setTelemetry(true)).toBe(true);
    expect(setTelemetryArgs).toEqual([true]);
    queues.setTelemetry[0]!.resolve({ ok: true, view: view({ lifetimeTokens: 70, telemetryEnabled: true }) });
    await settleAll();
    expect(loader.getState().view?.telemetryEnabled).toBe(true);
    expect(loader.getState().inFlight).toBeNull();

    queues.getStats[0]!.resolve(ok(1));
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(70);
  });

  it("a toggle started during a Refresh supersedes it in both the state and the flight", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    loader.refresh();
    expect(loader.setTelemetry(false)).toBe(true);
    expect(loader.getState().inFlight).toBe("set-telemetry");

    queues.getStats[1]!.resolve(ok(999)); // the superseded Refresh answers late
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(loader.getState().inFlight).toBe("set-telemetry");

    queues.setTelemetry[0]!.resolve({ ok: true, view: view({ lifetimeTokens: 80, telemetryEnabled: false }) });
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(80);
  });

  it("a Refresh clicked during a toggle write is refused (the button is disabled for that window)", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    loader.setTelemetry(true);
    expect(loader.refresh()).toBe(false);
    expect(queues.getStats).toHaveLength(1);
  });

  it("a second toggle click while the first write is out is a no-op", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    expect(loader.setTelemetry(true)).toBe(true);
    expect(loader.setTelemetry(false)).toBe(false);
    expect(queues.setTelemetry).toHaveLength(1);
  });

  it("a refused toggle leaves the view alone and shows its own error", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    loader.setTelemetry(true);
    queues.setTelemetry[0]!.resolve(refused);
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(loader.getState().error).toMatchObject({ kind: "set-telemetry" });
  });
});

describe("createProfileLoader — rebuild", () => {
  it("runs through the same generation loop and replaces the view", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(cachedOk(5));
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    expect(loader.rebuild()).toBe(true);
    expect(computeProfilePhase(loader.getState())).toBe("refreshing");
    expect(loader.getState().view?.lifetimeTokens).toBe(50);

    queues.rebuildStats[0]!.resolve(ok(11));
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(11);
    expect(computeProfilePhase(loader.getState())).toBe("ready");
  });

  it("is refused while another read is already running", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    expect(loader.rebuild()).toBe(false);
    expect(queues.rebuildStats).toHaveLength(0);
  });

  it("a refused rebuild keeps the numbers and names itself in the error", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(ok(50));
    await settleAll();

    loader.rebuild();
    queues.rebuildStats[0]!.resolve(refused);
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(50);
    expect(loader.getState().error).toMatchObject({ kind: "rebuild" });
  });
});

describe("createProfileLoader — dispose", () => {
  it("a resolve after dispose reaches neither the state nor the subscriber", async () => {
    const { bridge, queues } = fakeBridge();
    const onState = vi.fn();
    const loader = createProfileLoader(bridge, onState);
    loader.mount();
    const callsAtMount = onState.mock.calls.length;

    loader.dispose();
    queues.getStats[0]!.resolve(ok(50));
    queues.getStatsCached[0]!.resolve(cachedOk(5));
    await settleAll();

    expect(onState).toHaveBeenCalledTimes(callsAtMount);
    expect(loader.getState().view).toBeNull();
  });

  it("dispose itself never notifies, and later requests are refused", () => {
    const { bridge } = fakeBridge();
    const onState = vi.fn();
    const loader = createProfileLoader(bridge, onState);
    loader.dispose();
    expect(onState).not.toHaveBeenCalled();
    expect(loader.refresh()).toBe(false);
    expect(loader.rebuild()).toBe(false);
    expect(loader.setTelemetry(true)).toBe(false);
  });

  it("mount() after dispose does nothing", () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.dispose();
    loader.mount();
    expect(queues.getStats).toHaveLength(0);
  });
});


// ── automatic backlog catch-up ──
//
// The owner's requirement is that the numbers pull themselves in ("пускай
// они кружочками лениво подтягиваются"). A cold cache needs three passes on
// the measured 60 785-file directory, so a pane that only prints "press
// Refresh" hands the user two manual clicks. Every brake below has its own
// case, because an unguarded loop here is an unbounded IPC storm.

describe("shouldAutoContinue", () => {
  const base = initialProfileLoadState();
  const withFresh = (backlog: number): ProfileLoadState => ({
    ...base,
    view: view({ backlogRemaining: backlog }),
    source: "fresh",
    lastFreshBacklog: backlog,
    lastFreshPendingExact: 0,
  });

  it("an applied fresh view with a backlog asks for another pass", () => {
    expect(shouldAutoContinue(withFresh(5))).toBe(true);
  });

  it("an empty backlog is the end of the chain", () => {
    expect(shouldAutoContinue(withFresh(0))).toBe(false);
  });

  it("a CACHED view never starts a pass — mount must not turn into a scan storm", () => {
    expect(shouldAutoContinue({ ...withFresh(5), source: "cache" })).toBe(false);
  });

  it("nothing is issued while something is already in flight", () => {
    expect(shouldAutoContinue({ ...withFresh(5), inFlight: "set-telemetry" })).toBe(false);
    expect(shouldAutoContinue({ ...withFresh(5), inFlight: "refresh" })).toBe(false);
  });

  it("a stalled or disposed loader issues nothing", () => {
    expect(shouldAutoContinue({ ...withFresh(5), autoStalled: true })).toBe(false);
    expect(shouldAutoContinue({ ...withFresh(5), disposed: true })).toBe(false);
  });
});

describe("profileLoadReducer — the progress guard", () => {
  const pass = (gen: number, backlog: number, auto: boolean): ProfileLoadAction[] => [
    { type: "start", kind: "refresh", gen, auto },
    { type: "settle", kind: "refresh", gen, result: okBacklog(backlog) },
  ];

  it("a shrinking backlog keeps the chain alive", () => {
    const state = run([...pass(1, 24_000, false), ...pass(2, 12_000, true)]);
    expect(state.autoStalled).toBe(false);
    expect(shouldAutoContinue(state)).toBe(true);
  });

  it("two passes reporting the SAME backlog stop the chain for good", () => {
    const state = run([...pass(1, 3, false), ...pass(2, 3, true)]);
    expect(state.autoStalled).toBe(true);
    expect(shouldAutoContinue(state)).toBe(false);
  });

  it("a GROWN backlog stops it too — that is not progress either", () => {
    const state = run([...pass(1, 3, false), ...pass(2, 9, true)]);
    expect(state.autoStalled).toBe(true);
  });

  it("reaching zero ends the chain without calling it a stall", () => {
    const state = run([...pass(1, 3, false), ...pass(2, 0, true)]);
    expect(state.autoStalled).toBe(false);
    expect(shouldAutoContinue(state)).toBe(false);
  });

  it("a refusal stops the chain — a failing bridge is not retried on a loop", () => {
    const state = run([
      ...pass(1, 5, false),
      { type: "start", kind: "refresh", gen: 2, auto: true },
      { type: "settle", kind: "refresh", gen: 2, result: refused },
    ]);
    expect(state.autoStalled).toBe(true);
    expect(shouldAutoContinue(state)).toBe(false);
  });

  it("an explicit gesture re-arms the chain and resets the comparison point", () => {
    const stalled = run([...pass(1, 3, false), ...pass(2, 3, true)]);
    const rearmed = profileLoadReducer(stalled, { type: "start", kind: "refresh", gen: 3 });
    expect(rearmed.autoStalled).toBe(false);
    expect(rearmed.lastFreshBacklog).toBeNull();
    expect(rearmed.autoPass).toBe(false);
  });

  it("an automatic start does NOT clear a stall it did not cause", () => {
    const stalled = run([...pass(1, 3, false), ...pass(2, 3, true)]);
    const auto = profileLoadReducer(stalled, { type: "start", kind: "refresh", gen: 3, auto: true });
    expect(auto.autoStalled).toBe(true);
  });
});

describe("isProfileCatchingUp / computeProfilePhase during a catch-up", () => {
  const catching: ProfileLoadState = {
    ...initialProfileLoadState(),
    view: view({ backlogRemaining: 5 }),
    source: "fresh",
    inFlight: "refresh",
    autoPass: true,
  };

  it("a catch-up pass is reported as its own signal, not as one of the four phases", () => {
    expect(isProfileCatchingUp(catching)).toBe(true);
    // Deliberate: the numbers on screen are real as of the last pass, so the
    // body must not dim the way a user-driven `refreshing` does.
    expect(computeProfilePhase(catching)).toBe("ready");
  });

  it("a user-driven Refresh over the same view still reads as refreshing", () => {
    expect(isProfileCatchingUp({ ...catching, autoPass: false })).toBe(false);
    expect(computeProfilePhase({ ...catching, autoPass: false })).toBe("refreshing");
  });
});

describe("createProfileLoader — catch-up passes", () => {
  it("chains passes by itself until the backlog is gone", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    queues.getStats[0]!.resolve(okBacklog(24_000));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);
    expect(isProfileCatchingUp(loader.getState())).toBe(true);

    queues.getStats[1]!.resolve(okBacklog(12_000));
    await settleAll();
    expect(queues.getStats).toHaveLength(3);

    queues.getStats[2]!.resolve(okBacklog(0, 99));
    await settleAll();
    expect(queues.getStats).toHaveLength(3);
    expect(isProfileCatchingUp(loader.getState())).toBe(false);
    expect(loader.getState().view?.lifetimeTokens).toBe(99);
    expect(computeProfilePhase(loader.getState())).toBe("ready");
  });

  it("stops after two passes that made no progress — no third request", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    queues.getStats[0]!.resolve(okBacklog(3));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);

    queues.getStats[1]!.resolve(okBacklog(3));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);
    expect(loader.getState().autoStalled).toBe(true);
  });

  it("exactly one catch-up pass is ever in flight", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(okBacklog(9));
    await settleAll();

    expect(queues.getStats).toHaveLength(2);
    // A manual click during the catch-up is refused by the same guard as any
    // other request — the catch-up holds no privilege, and gains none.
    expect(loader.refresh()).toBe(false);
    expect(queues.getStats).toHaveLength(2);
  });

  it("a cached view with a backlog starts nothing — only an applied FRESH answer does", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve({ ok: true, view: view({ backlogRemaining: 7 }) });
    await settleAll();
    expect(queues.getStats).toHaveLength(1); // just the mount read, still out
    expect(isProfileCatchingUp(loader.getState())).toBe(false);
  });

  it("never preempts a telemetry write, and resumes from the write's own answer", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    loader.setTelemetry(true);
    queues.getStats[0]!.resolve(okBacklog(5)); // the mount read answers under the live write
    await settleAll();
    expect(queues.getStats).toHaveLength(1); // superseded settle: no catch-up off a stale answer
    expect(loader.getState().inFlight).toBe("set-telemetry");

    queues.setTelemetry[0]!.resolve(okBacklog(5, 42));
    await settleAll();
    expect(queues.getStats).toHaveLength(2); // the write's own answer carries the backlog
    expect(isProfileCatchingUp(loader.getState())).toBe(true);
  });

  it("a refusal mid-chain stops it, and a manual Refresh re-arms it", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(okBacklog(5));
    await settleAll();

    queues.getStats[1]!.resolve(refused);
    await settleAll();
    expect(queues.getStats).toHaveLength(2);
    expect(loader.getState().autoStalled).toBe(true);

    expect(loader.refresh()).toBe(true);
    queues.getStats[2]!.resolve(okBacklog(4));
    await settleAll();
    expect(queues.getStats).toHaveLength(4); // the manual pass, then a fresh catch-up
  });

  it("dispose stops the chain instead of leaking one more pass", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    loader.dispose();
    queues.getStats[0]!.resolve(okBacklog(5));
    await settleAll();
    expect(queues.getStats).toHaveLength(1);
  });
});


// ── coverage-collapse guard ──
//
// Live smoke caught a 1.46 s blank on a healthy directory: an `{ok:true}`
// carrying an EMPTY aggregate landed over real numbers. Main fixed the race
// that produced it, but named two paths that still produce the same answer
// legitimately — the newest sink file unreadable this pass (self-healing),
// and the newest sink file over the per-file scan limit (permanent, i.e.
// "No usage stats yet" over sixty thousand files). Both arrive as empty +
// `truncated: true`, which is exactly what separates them from a directory
// the user actually emptied.

describe("isEmptyProfileAggregate", () => {
  it("reads the file-carrying session count, not the token total", () => {
    expect(isEmptyProfileAggregate(view({ totalSessions: 0, lifetimeTokens: 0 }))).toBe(true);
    expect(isEmptyProfileAggregate(view({ totalSessions: 1, lifetimeTokens: 0 }))).toBe(false);
  });
});

describe("profileLoadReducer — an empty truncated scan never wipes real numbers", () => {
  /** gen 1 landed real numbers; gen 2 is the pass under test. */
  const afterSecondPass = (second: ProfileStatsResult): ProfileLoadState =>
    run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: okData(500) },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: second },
    ]);

  it("empty + truncated over real numbers -> the view is KEPT and the pane is told", () => {
    const state = afterSecondPass(okEmpty(true, 0));
    expect(state.view?.lifetimeTokens).toBe(500);
    expect(state.view?.totalSessions).toBe(4);
    expect(state.coverageCollapse).toEqual({ backlogRemaining: 0 });
    expect(state.error).toBeNull();
  });

  it("empty + NOT truncated over real numbers -> the view IS replaced, silently", () => {
    const state = afterSecondPass(okEmpty(false, 0));
    expect(state.view?.totalSessions).toBe(0);
    expect(state.view?.lifetimeTokens).toBe(0);
    expect(state.coverageCollapse).toBeNull();
  });

  it("empty + truncated over an ALREADY empty view -> nothing to protect, plain apply", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: okEmpty(false, 0) },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "refresh", gen: 2, result: okEmpty(true, 2) },
    ]);
    expect(state.view?.truncated).toBe(true);
    expect(state.coverageCollapse).toBeNull();
  });

  it("empty + truncated as the FIRST answer applies — there is no earlier view to keep", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: okEmpty(true, 3) },
    ]);
    expect(state.view).not.toBeNull();
    expect(state.coverageCollapse).toBeNull();
  });

  it("a non-empty answer is never touched by the guard", () => {
    const state = afterSecondPass(okData(900, 0));
    expect(state.view?.lifetimeTokens).toBe(900);
    expect(state.coverageCollapse).toBeNull();
  });

  it("the bookkeeping still follows the ANSWER: generation, flight, backlog", () => {
    const state = afterSecondPass(okEmpty(true, 7));
    expect(state).toMatchObject({ appliedGen: 2, inFlight: null, autoPass: false, lastFreshBacklog: 7 });
  });

  it("the next good pass applies normally and clears the notice", () => {
    const collapsed = afterSecondPass(okEmpty(true, 7));
    const recovered = run(
      [
        { type: "start", kind: "refresh", gen: 3 },
        { type: "settle", kind: "refresh", gen: 3, result: okData(700) },
      ],
      collapsed,
    );
    expect(recovered.view?.lifetimeTokens).toBe(700);
    expect(recovered.coverageCollapse).toBeNull();
  });

  it("a STALE empty answer is dropped by the generation rule before the guard is even consulted", () => {
    const state = run([
      { type: "start", kind: "mount-fresh", gen: 1 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: okData(500) },
      { type: "start", kind: "refresh", gen: 2 },
      { type: "settle", kind: "mount-fresh", gen: 1, result: okEmpty(true, 1) },
    ]);
    expect(state.view?.lifetimeTokens).toBe(500);
    expect(state.coverageCollapse).toBeNull();
    expect(state.inFlight).toBe("refresh");
  });
});

describe("createProfileLoader — a collapsed scan does not stall the recovery", () => {
  it("a self-healing collapse keeps the catch-up chain going and recovers on the next pass", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    queues.getStats[0]!.resolve(okData(500, 0));
    await settleAll();
    expect(queues.getStats).toHaveLength(1); // no backlog: nothing to chain yet

    expect(loader.refresh()).toBe(true);
    queues.getStats[1]!.resolve(okEmpty(true, 2)); // newest file unreadable this pass
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(500);
    expect(loader.getState().coverageCollapse).not.toBeNull();
    expect(queues.getStats).toHaveLength(3); // the backlog still drives a catch-up pass

    queues.getStats[2]!.resolve(okData(600, 0));
    await settleAll();
    expect(loader.getState().view?.lifetimeTokens).toBe(600);
    expect(loader.getState().coverageCollapse).toBeNull();
  });

  it("the permanent collapse chains nothing — an empty backlog is the end of it", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(okData(500, 0));
    await settleAll();

    loader.refresh();
    queues.getStats[1]!.resolve(okEmpty(true, 0)); // oversized newest file
    await settleAll();
    expect(queues.getStats).toHaveLength(2);
    expect(loader.getState().view?.lifetimeTokens).toBe(500);
    expect(loader.getState().coverageCollapse).not.toBeNull();
  });
});


// ── review round: the collapse banner must not promise a retry the progress
//    guard already cancelled, and must not flip to the PERMANENT wording
//    while a transient cause is being retried ──

describe("computeCollapseProgress", () => {
  const collapsedWith = (backlog: number, extra: Partial<ProfileLoadState> = {}): ProfileLoadState => ({
    ...initialProfileLoadState(),
    view: view({ totalSessions: 4 }),
    source: "fresh",
    coverageCollapse: { backlogRemaining: backlog },
    lastFreshBacklog: backlog,
    ...extra,
  });

  it("no collapse -> no reading at all", () => {
    expect(computeCollapseProgress(initialProfileLoadState())).toBeNull();
  });

  it("a collapse that reported NO reachable backlog is permanent", () => {
    expect(computeCollapseProgress(collapsedWith(0))).toBe("permanent");
  });

  it("a reachable backlog with the chain still armed reads as retrying", () => {
    expect(computeCollapseProgress(collapsedWith(1))).toBe("retrying");
  });

  it("a reachable backlog the progress guard gave up on reads as STOPPED, not retrying", () => {
    expect(computeCollapseProgress(collapsedWith(1, { autoStalled: true }))).toBe("stopped");
  });

  it("a pass in flight reads as retrying even after the guard latched — something IS running", () => {
    expect(computeCollapseProgress(collapsedWith(1, { autoStalled: true, inFlight: "refresh" }))).toBe("retrying");
  });

  it("the permanence verdict survives an explicit Refresh clearing the running counters", () => {
    // `start` resets `lastFreshBacklog`; the collapse's own captured number
    // is what decides the wording, so a transient cause cannot flip to the
    // permanent copy for the duration of a manual pass.
    const collapsed = collapsedWith(1);
    const refreshing = profileLoadReducer(collapsed, { type: "start", kind: "refresh", gen: 9 });
    expect(refreshing.lastFreshBacklog).toBeNull();
    expect(computeCollapseProgress(refreshing)).toBe("retrying");
  });
});

describe("createProfileLoader — a permanently unreadable newest file", () => {
  it("stops the chain AND stops promising a retry", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);
    queues.getStats[0]!.resolve(okData(500, 0));
    await settleAll();

    loader.refresh();
    queues.getStats[1]!.resolve(okEmpty(true, 1));
    await settleAll();
    expect(computeCollapseProgress(loader.getState())).toBe("retrying");
    expect(queues.getStats).toHaveLength(3); // the catch-up pass the note promises

    queues.getStats[2]!.resolve(okEmpty(true, 1)); // same file, same failure
    await settleAll();
    expect(queues.getStats).toHaveLength(3); // guard latched: nothing more is coming
    expect(loader.getState().autoStalled).toBe(true);
    expect(computeCollapseProgress(loader.getState())).toBe("stopped");
    expect(loader.getState().view?.lifetimeTokens).toBe(500);
  });
});


// ── review round: unfinished EXACT sessions are work left too ──
//
// A pass can close the file backlog and still run out of budget before the
// exact second pass over cross-file sessions converges: `backlogRemaining:0`
// with `pendingExactSessions:1`. Stopping there leaves `longestSessionMs`
// provisional and the "still being refined" note standing indefinitely,
// waiting for a human — the opposite of numbers that pull themselves in.

describe("shouldAutoContinue — unfinished exact sessions", () => {
  const settled = (backlog: number, pending: number): ProfileLoadState => ({
    ...initialProfileLoadState(),
    view: view({ backlogRemaining: backlog, pendingExactSessions: pending }),
    source: "fresh",
    lastFreshBacklog: backlog,
    lastFreshPendingExact: pending,
  });

  it("an unconverged exact pass keeps the chain going even with an empty file backlog", () => {
    expect(shouldAutoContinue(settled(0, 1))).toBe(true);
  });

  it("both counters at zero is the only end of the chain", () => {
    expect(shouldAutoContinue(settled(0, 0))).toBe(false);
    expect(shouldAutoContinue(settled(3, 0))).toBe(true);
    expect(shouldAutoContinue(settled(3, 2))).toBe(true);
  });
});

describe("profileLoadReducer — the progress guard covers BOTH counters", () => {
  const pass = (gen: number, backlog: number, pending: number, auto: boolean): ProfileLoadAction[] => [
    { type: "start", kind: "refresh", gen, auto },
    {
      type: "settle",
      kind: "refresh",
      gen,
      result: { ok: true, view: view({ totalSessions: 4, backlogRemaining: backlog, pendingExactSessions: pending }) },
    },
  ];

  it("progress on the exact pass alone keeps the chain alive", () => {
    const state = run([...pass(1, 0, 3, false), ...pass(2, 0, 2, true)]);
    expect(state.autoStalled).toBe(false);
    expect(shouldAutoContinue(state)).toBe(true);
  });

  it("progress on files alone keeps it alive even while the exact count holds", () => {
    const state = run([...pass(1, 9, 1, false), ...pass(2, 4, 1, true)]);
    expect(state.autoStalled).toBe(false);
  });

  it("a session that never converges stops the chain — neither counter moved", () => {
    const state = run([...pass(1, 0, 1, false), ...pass(2, 0, 1, true)]);
    expect(state.autoStalled).toBe(true);
    expect(shouldAutoContinue(state)).toBe(false);
  });

  it("both counters reaching zero ends the chain without calling it a stall", () => {
    const state = run([...pass(1, 2, 1, false), ...pass(2, 0, 0, true)]);
    expect(state.autoStalled).toBe(false);
    expect(shouldAutoContinue(state)).toBe(false);
  });
});

describe("createProfileLoader — the chain finishes the exact pass too", () => {
  it("keeps going on pendingExactSessions after the file backlog is empty", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    queues.getStats[0]!.resolve(okPendingExact(2));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);

    queues.getStats[1]!.resolve(okPendingExact(1));
    await settleAll();
    expect(queues.getStats).toHaveLength(3);

    queues.getStats[2]!.resolve(okPendingExact(0, 77));
    await settleAll();
    expect(queues.getStats).toHaveLength(3);
    expect(loader.getState().view?.pendingExactSessions).toBe(0);
    expect(loader.getState().view?.lifetimeTokens).toBe(77);
  });

  it("a session that will not converge is dropped after one fruitless pass", async () => {
    const { bridge, queues } = fakeBridge();
    const loader = createProfileLoader(bridge, () => {});
    loader.mount();
    queues.getStatsCached[0]!.resolve(noCache);

    queues.getStats[0]!.resolve(okPendingExact(1));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);

    queues.getStats[1]!.resolve(okPendingExact(1));
    await settleAll();
    expect(queues.getStats).toHaveLength(2);
    expect(loader.getState().autoStalled).toBe(true);
  });
});

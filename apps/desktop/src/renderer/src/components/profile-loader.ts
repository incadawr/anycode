/**
 * Profile pane load orchestration (TASK.187 S4, build/task187-plan.md §S4):
 * a pure reducer plus a non-React controller that owns every request the
 * pane can issue. It lives OUTSIDE ProfilePane.tsx on purpose — this
 * package's vitest runs `environment: "node"` with no jsdom and no
 * @testing-library, and it only collects `*.test.ts`, so logic parked inside
 * a `useEffect` is unreachable by the gate. Everything below is therefore
 * plain data + plain functions, and `ProfilePane` is a thin `useState` /
 * `useEffect` shell over `createProfileLoader`.
 *
 * WHY GENERATIONS (plan §S4 rule set, review-v3 finding 5). Five request
 * kinds resolve into the same three-field view state (`view`/`error`/
 * `inFlight`) and their round-trips can be seconds apart on a cold telemetry
 * directory, so out-of-order arrival is the normal case, not the corner one.
 * Every live request carries a generation number, and a settle whose
 * generation is older than `latestGen` is dropped WHOLE — regardless of
 * outcome. That last word is the part a narrower "ignore stale successes"
 * rule gets wrong: a stale `{ok:false}` would otherwise paint an error over
 * a newer success, and any stale settle would otherwise clear the `inFlight`
 * flag that belongs to a request still running, unsticking the spinner while
 * the real pass is still going.
 *
 * The cached read (`mount-cached`) is the one asymmetric kind: it is a
 * placeholder for the instant first paint, so it never bumps `latestGen`,
 * never raises an error of its own (`no_cache` is the normal answer before
 * the first pass has ever completed), and applies only while nothing newer
 * has been applied yet (`appliedGen`).
 */
import type {
  ProfileRefusalReason,
  ProfileStatsCachedResult,
  ProfileStatsResult,
  ProfileStatsView,
  ProfileTelemetrySetResult,
} from "../../../shared/profile-config.js";

// ── vocabulary ──

/**
 * Every request the pane can issue. `mount-cached` is the instant cache read
 * fired alongside `mount-fresh`; `set-telemetry` is here (rather than doing
 * its own `setResult` at the click site, as it did before TASK.187) because
 * its response IS a fresh `ProfileStatsView` and therefore races mount and
 * Refresh for the same state; `rebuild` is the footer's cache-rebuild action.
 */
export type ProfileRequestKind = "mount-cached" | "mount-fresh" | "refresh" | "set-telemetry" | "rebuild";

/** The kinds that answer with a full `ProfileStatsResult` and take part in the generation ordering. */
export type ProfileFreshRequestKind = Exclude<ProfileRequestKind, "mount-cached">;

/** A refusal that survived the generation filter, kept as data so the pane can render both a message and the honest `{ok:false}` branch. */
export interface ProfileLoadError {
  kind: ProfileFreshRequestKind;
  reason: ProfileRefusalReason;
}

export interface ProfileLoadState {
  /** Generation of the most recently STARTED fresh request. Cached reads never touch it. */
  latestGen: number;
  /** Generation of the most recently APPLIED view. A refusal never advances it — nothing was applied. */
  appliedGen: number;
  /** The last view actually applied, kept across refusals so an error renders OVER real numbers instead of wiping them. */
  view: ProfileStatsView | null;
  /** Where `view` came from; drives the `cached-updating` vs `refreshing` phase split. */
  source: "cache" | "fresh" | null;
  /** The fresh request currently outstanding, or `null`. A pending cached read is deliberately NOT reflected here: it must never make the pane look busy. */
  inFlight: ProfileFreshRequestKind | null;
  /** True while the outstanding request is an automatic catch-up pass rather than something the user asked for. */
  autoPass: boolean;
  /** `backlogRemaining` of the previous APPLIED fresh answer, one of the two references the progress guard compares against; `null` = no fresh answer has landed since the last explicit gesture. */
  lastFreshBacklog: number | null;
  /** `pendingExactSessions` of the previous APPLIED fresh answer — unfinished exact activity passes are work left exactly as unread files are. */
  lastFreshPendingExact: number | null;
  /** Auto catch-up has given up (no progress, or a refusal) and will not resume until the user asks for something. */
  autoStalled: boolean;
  /**
   * Set when a fresh answer's empty-but-truncated aggregate was REFUSED as a
   * replacement for a non-empty view: the numbers on screen are older than
   * the last pass. Carries the backlog THAT answer reported, because it is
   * what tells a permanent cut (0 — an oversized newest file) from a
   * transient one, and the running counters are reset by the next explicit
   * gesture while the banner is still up.
   */
  coverageCollapse: { backlogRemaining: number } | null;
  error: ProfileLoadError | null;
  /** Set by `unmount`; every later action is a no-op so a late resolve cannot touch a dead component. */
  disposed: boolean;
}

export type ProfileLoadAction =
  /** `auto: true` marks a catch-up pass the controller issued by itself — see `shouldAutoContinue`. */
  | { type: "start"; kind: ProfileRequestKind; gen: number; auto?: boolean }
  | { type: "settle"; kind: "mount-cached"; gen: number; result: ProfileStatsCachedResult }
  | { type: "settle"; kind: ProfileFreshRequestKind; gen: number; result: ProfileStatsResult }
  | { type: "unmount" };

export function initialProfileLoadState(): ProfileLoadState {
  return {
    latestGen: 0,
    appliedGen: 0,
    view: null,
    source: null,
    inFlight: null,
    autoPass: false,
    lastFreshBacklog: null,
    lastFreshPendingExact: null,
    autoStalled: false,
    coverageCollapse: null,
    error: null,
    disposed: false,
  };
}

/**
 * The shape of a scan that came back with nothing in it. `totalSessions`
 * counts sink FILES that carried at least one valid record, so zero means
 * the pass aggregated no file at all — the marker main's own diagnosis of
 * the blank-panel race named.
 */
export function isEmptyProfileAggregate(view: ProfileStatsView): boolean {
  return view.totalSessions === 0;
}

/**
 * Whether a pass left anything for the next one: unread sink files, or
 * cross-file sessions whose exact activity pass has not converged. Both are
 * budget-cut work main resumes on the following pass, and both leave the
 * pane showing provisional figures until they reach zero.
 */
function profileWorkLeft(backlogRemaining: number, pendingExactSessions: number): boolean {
  return backlogRemaining > 0 || pendingExactSessions > 0;
}

// ── reducer ──

/**
 * Cached settle: pure placeholder semantics. A refusal is silent (`no_cache`
 * is the ordinary pre-first-pass answer and must not surface as an error);
 * a success lands only while no fresh view has won and no newer generation
 * has been applied, so the common mount race (cache resolves after the fresh
 * scan on a small directory) cannot roll the pane back to older numbers.
 * `inFlight` is never touched here — the cached read is not what the
 * spinner is reporting on.
 */
function settleCached(state: ProfileLoadState, gen: number, result: ProfileStatsCachedResult): ProfileLoadState {
  if (!result.ok || state.source === "fresh" || gen <= state.appliedGen) {
    return state;
  }
  return { ...state, view: result.view, source: "cache", appliedGen: gen };
}

/**
 * Fresh settle. The generation test comes FIRST and covers every outcome:
 * an older settle is dropped whole, so it can neither set an error over a
 * newer success, nor overwrite a newer view, nor clear the `inFlight` of the
 * request that superseded it. A current settle always ends the flight;
 * success replaces the view and clears any standing error, refusal keeps the
 * view exactly as it was and records the error beside it.
 *
 * PROGRESS GUARD (TASK.187 S4 catch-up): a success also records the backlog
 * it reported and compares it with the previous fresh one. A backlog that
 * did not SHRINK means the next pass would read the same files again — the
 * standing case being an oversized file that permanently cuts the reachable
 * history (plan D-2) — so auto catch-up stops for good until the user asks
 * for something. A refusal stops it too: retrying a failing bridge on a
 * timer is an IPC loop, not a recovery.
 */
function settleFresh(
  state: ProfileLoadState,
  kind: ProfileFreshRequestKind,
  gen: number,
  result: ProfileStatsResult,
): ProfileLoadState {
  if (gen !== state.latestGen) {
    return state;
  }
  if (!result.ok) {
    return { ...state, inFlight: null, autoPass: false, autoStalled: true, error: { kind, reason: result.reason } };
  }
  const backlog = result.view.backlogRemaining;
  const pendingExact = result.view.pendingExactSessions;
  // The guard trips only when NEITHER counter moved down: a pass that read
  // files without converging a session, or converged a session without
  // reading files, is still progress and must not stop the chain. Both
  // counters are monotone work-left measures, so "neither shrank while work
  // remains" is the terminating condition.
  const stalled =
    profileWorkLeft(backlog, pendingExact) &&
    state.lastFreshBacklog !== null &&
    state.lastFreshPendingExact !== null &&
    backlog >= state.lastFreshBacklog &&
    pendingExact >= state.lastFreshPendingExact;
  const collapsed =
    isEmptyProfileAggregate(result.view) &&
    result.view.truncated &&
    state.view !== null &&
    !isEmptyProfileAggregate(state.view);
  return {
    ...state,
    // COVERAGE-COLLAPSE GUARD: an `{ok:true}` carrying an empty aggregate
    // does NOT overwrite real numbers while the same answer admits it is
    // truncated. Two live paths produce exactly that (both named by main's
    // own analysis): the newest sink file became unreadable this pass, and
    // the newest sink file is over the per-file scan limit — in both, the
    // continuous-prefix rule cuts the whole history at that file and the
    // pass honestly reports "nothing, and cut". The second is PERMANENT, so
    // "No usage stats yet" would stand over sixty thousand files on disk.
    //
    // `truncated` is what separates this from a directory that genuinely
    // emptied (telemetry deleted or switched off, fresh install): that pass
    // reports an empty aggregate with FULL coverage, and it must replace the
    // view, or the pane would show deleted data forever.
    view: collapsed ? state.view : result.view,
    // The bookkeeping follows the ANSWER even when the view does not: the
    // generation was consumed, the flight ended, and the progress guard
    // compares the backlog this pass reported — otherwise a self-healing
    // collapse (unreadable file, backlog >= 1) would stop the catch-up chain
    // that fixes it. `source` follows the answer for the same reason.
    source: "fresh",
    appliedGen: gen,
    inFlight: null,
    autoPass: false,
    lastFreshBacklog: backlog,
    lastFreshPendingExact: pendingExact,
    autoStalled: state.autoStalled || stalled,
    coverageCollapse: collapsed ? { backlogRemaining: backlog } : null,
    error: null,
  };
}

export function profileLoadReducer(state: ProfileLoadState, action: ProfileLoadAction): ProfileLoadState {
  if (state.disposed) {
    return state;
  }
  switch (action.type) {
    case "unmount":
      return { ...state, disposed: true };
    case "start": {
      // A cached read carries a generation for ordering only — it must not
      // claim `latestGen` (that would make the fresh read started next to it
      // look stale) and must not raise the busy flag.
      if (action.kind === "mount-cached") {
        return state;
      }
      const auto = action.auto === true;
      // An explicit gesture re-arms catch-up and drops the backlog reference:
      // the user asked for another attempt, so the guard starts measuring
      // progress again from this pass instead of from a stale comparison.
      return {
        ...state,
        latestGen: action.gen,
        inFlight: action.kind,
        autoPass: auto,
        ...(auto ? {} : { autoStalled: false, lastFreshBacklog: null, lastFreshPendingExact: null }),
      };
    }
    case "settle":
      return action.kind === "mount-cached"
        ? settleCached(state, action.gen, action.result)
        : settleFresh(state, action.kind, action.gen, action.result);
  }
}

// ── derived, pure ──

export type ProfilePhase = "skeleton" | "cached-updating" | "refreshing" | "ready";

/** How a standing coverage collapse is going — see `computeCollapseProgress`. */
export type ProfileCollapseProgress = "retrying" | "stopped" | "permanent";

/**
 * The four render phases, stamped on the pane root as `data-profile-phase`
 * (wire contract §2) so the S5 automation probe can watch a Refresh actually
 * start and finish. `skeleton` is the cold first paint (nothing to show yet);
 * `cached-updating` is the warm first paint (cache numbers on screen while
 * the real scan verifies them); `refreshing` is a re-scan over numbers that
 * already came from a scan; `ready` means nothing is outstanding — including
 * the "failed with nothing to show" case, where the pane renders its own
 * io-error branch rather than a spinner that will never stop.
 */
export function computeProfilePhase(state: ProfileLoadState): ProfilePhase {
  if (state.view !== null) {
    // An automatic catch-up pass deliberately does NOT read as `refreshing`:
    // the numbers on screen are real and correct as of the last pass, and
    // dimming them would say the opposite. The catch-up is reported by
    // `isProfileCatchingUp` (its own DOM flag + a toolbar note) instead —
    // the phase vocabulary stays the four values the wire contract fixes.
    if (state.inFlight === null || state.autoPass) {
      return "ready";
    }
    return state.source === "cache" ? "cached-updating" : "refreshing";
  }
  // Nothing to show. `latestGen === 0` is the frame React renders BEFORE the
  // mount effect runs: no request has ever started, so this is the beginning
  // of loading — not a load that finished with nothing, which is what a
  // `ready` reading here would claim (and would flash the io-error hero for
  // one frame on every open).
  return state.inFlight !== null || state.latestGen === 0 ? "skeleton" : "ready";
}

/**
 * Whether the pane is quietly finishing the aggregation on its own. Separate
 * from `computeProfilePhase` on purpose (see there): it is an additional
 * signal over a `ready` pane, not one of the four phases.
 */
export function isProfileCatchingUp(state: ProfileLoadState): boolean {
  return state.autoPass;
}

/**
 * How a standing coverage collapse is going, or `null` when there is none.
 * Three readings, because the pane may not promise work that is not
 * happening:
 *
 *  - `permanent`: the collapsed pass reported no reachable backlog at all,
 *    i.e. the newest sink file is over the per-file scan limit. No pass will
 *    ever get behind it; only removing or truncating that file will.
 *  - `stopped`: there IS a reachable backlog, but the progress guard gave up
 *    (repeated passes returned the same numbers — a newest file that is
 *    unreadable every time, not just once), so nothing runs by itself any
 *    more and the user has to ask.
 *  - `retrying`: a pass is in flight, or the chain is still armed.
 *
 * The permanence verdict reads the backlog CAPTURED with the collapse, not
 * the running counter: an explicit Refresh clears the latter at `start`, and
 * a transient cause must not read as permanent for the length of that pass.
 */
export function computeCollapseProgress(state: ProfileLoadState): ProfileCollapseProgress | null {
  if (state.coverageCollapse === null) {
    return null;
  }
  if (state.coverageCollapse.backlogRemaining === 0) {
    return "permanent";
  }
  if (state.inFlight !== null) {
    return "retrying";
  }
  return state.autoStalled ? "stopped" : "retrying";
}

/**
 * Whether the controller should issue another pass BY ITSELF (TASK.187 S4
 * catch-up). The owner's requirement is that the numbers fill in on their
 * own — a cold cache needs three passes on a 60k-file directory, and a note
 * telling the user to press Refresh twice is not "they pull themselves in".
 *
 * Work left is BOTH unread files and unconverged exact sessions: a pass that
 * empties the file backlog but runs out of budget mid-exact-pass reports
 * `backlogRemaining:0, pendingExactSessions:1`, and stopping there would
 * leave `longestSessionMs` provisional until a human pressed Refresh.
 *
 * Every condition here is a brake, not an enabler: only after a FRESH view
 * has been applied (a cached view is a placeholder and must not start a
 * scan storm on mount), only while nothing else is in flight (so exactly one
 * catch-up pass exists at a time and the user's own requests are never
 * preempted), and only while the progress guard has not tripped.
 */
export function shouldAutoContinue(state: ProfileLoadState): boolean {
  return (
    !state.disposed &&
    !state.autoStalled &&
    state.inFlight === null &&
    state.source === "fresh" &&
    // The counters of the last fresh ANSWER, not of the displayed view:
    // under the coverage-collapse guard the two differ, and the chain has to
    // keep running on the answer that reported work left.
    state.lastFreshBacklog !== null &&
    state.lastFreshPendingExact !== null &&
    profileWorkLeft(state.lastFreshBacklog, state.lastFreshPendingExact)
  );
}

/**
 * Whether a new request of `kind` may start. Reads of the aggregate
 * (`mount-fresh` / `refresh` / `rebuild`) queue behind any live request —
 * a second scan of the same directory would return the same answer later, so
 * the affordance is simply disabled while one runs. The telemetry toggle is
 * the exception: it is a WRITE the user asked for, and a background read
 * pass must never swallow it; only its own in-flight write blocks it (the
 * switch renders disabled for exactly that window).
 */
export function isProfileRequestAllowed(state: ProfileLoadState, kind: ProfileFreshRequestKind): boolean {
  if (state.disposed) {
    return false;
  }
  if (kind === "set-telemetry") {
    return state.inFlight !== "set-telemetry";
  }
  return state.inFlight === null;
}

const PROFILE_ERROR_ACTION_TEXT: Record<ProfileFreshRequestKind, string> = {
  "mount-fresh": "Couldn't load the latest stats",
  refresh: "Couldn't refresh the stats",
  "set-telemetry": "Couldn't change the telemetry setting",
  rebuild: "Couldn't rebuild the stats cache",
};

const PROFILE_ERROR_REASON_TEXT: Record<ProfileRefusalReason, string> = {
  io_error: "the telemetry folder could not be read",
  invalid: "the request was refused",
};

/**
 * The `.profile-update-error` copy. `hasView` decides the tail clause: with
 * numbers still on screen the message has to say they are the previous ones
 * (they are NOT wiped by a failed update — plan D-4), and without any it
 * must not promise numbers that are not there.
 */
export function profileUpdateErrorText(error: ProfileLoadError, hasView: boolean): string {
  const head = `${PROFILE_ERROR_ACTION_TEXT[error.kind]} — ${PROFILE_ERROR_REASON_TEXT[error.reason]}.`;
  return hasView ? `${head} Showing the previously loaded numbers.` : head;
}

// ── controller ──

/**
 * The whole IPC surface this pane drives, as ONE injectable object. Every
 * bridge call in the pane goes through here (`ProfilePane.tsx`'s
 * `toProfileLoaderBridge` is the only adapter), so reconciling with the real
 * preload once TASK.187 S3 lands is a single-file edit.
 */
export interface ProfileLoaderBridge {
  getStats(): Promise<ProfileStatsResult>;
  getStatsCached(): Promise<ProfileStatsCachedResult>;
  setTelemetry(enabled: boolean): Promise<ProfileTelemetrySetResult>;
  rebuildStats(): Promise<ProfileStatsResult>;
}

export interface ProfileLoader {
  getState(): ProfileLoadState;
  /** Fires the cached read and the fresh read in parallel; a second call is ignored (one loader owns one mount). */
  mount(): void;
  /** Each returns whether the request actually started (`false` = refused by `isProfileRequestAllowed`). */
  refresh(): boolean;
  setTelemetry(enabled: boolean): boolean;
  rebuild(): boolean;
  dispose(): void;
}

/**
 * Builds the controller. `onState` is called ONLY when the reducer produced
 * a new state object and only before `dispose()` — an ignored settle
 * (stale generation, disposed loader) triggers no render at all.
 *
 * A rejected bridge promise is normalised into `{ok:false, reason:"io_error"}`
 * rather than left to float: an unhandled rejection would strand `inFlight`
 * forever, i.e. a permanently spinning Refresh button — the exact failure
 * mode TASK.187 defect 2 is about.
 */
export function createProfileLoader(
  bridge: ProfileLoaderBridge,
  onState: (state: ProfileLoadState) => void,
): ProfileLoader {
  let state = initialProfileLoadState();
  let gen = 0;
  let mounted = false;

  function dispatch(action: ProfileLoadAction): void {
    const next = profileLoadReducer(state, action);
    if (next === state) {
      return;
    }
    state = next;
    if (!state.disposed) {
      onState(state);
    }
  }

  function settleFreshRequest(kind: ProfileFreshRequestKind, requestGen: number, result: ProfileStatsResult): void {
    dispatch({ type: "settle", kind, gen: requestGen, result });
    // The catch-up pass is issued from here rather than from a timer: the
    // trigger is an applied answer that still reports a backlog, so the
    // passes chain at IPC speed and stop the moment the backlog is gone.
    if (shouldAutoContinue(state)) {
      startFresh("refresh", () => bridge.getStats(), true);
    }
  }

  function startFresh(
    kind: ProfileFreshRequestKind,
    call: () => Promise<ProfileStatsResult>,
    auto = false,
  ): boolean {
    if (!isProfileRequestAllowed(state, kind)) {
      return false;
    }
    const requestGen = ++gen;
    dispatch({ type: "start", kind, gen: requestGen, auto });
    void call().then(
      (result) => settleFreshRequest(kind, requestGen, result),
      () => settleFreshRequest(kind, requestGen, { ok: false, reason: "io_error" }),
    );
    return true;
  }

  return {
    getState: () => state,
    mount() {
      if (mounted || state.disposed) {
        return;
      }
      mounted = true;
      // The cached generation is allocated FIRST so the fresh read started
      // beside it always wins a tie on arrival order.
      const cachedGen = ++gen;
      dispatch({ type: "start", kind: "mount-cached", gen: cachedGen });
      void bridge.getStatsCached().then(
        (result) => dispatch({ type: "settle", kind: "mount-cached", gen: cachedGen, result }),
        () => dispatch({ type: "settle", kind: "mount-cached", gen: cachedGen, result: { ok: false, reason: "io_error" } }),
      );
      startFresh("mount-fresh", () => bridge.getStats());
    },
    refresh: () => startFresh("refresh", () => bridge.getStats()),
    setTelemetry: (enabled: boolean) => startFresh("set-telemetry", () => bridge.setTelemetry(enabled)),
    rebuild: () => startFresh("rebuild", () => bridge.rebuildStats()),
    dispose() {
      dispatch({ type: "unmount" });
    },
  };
}

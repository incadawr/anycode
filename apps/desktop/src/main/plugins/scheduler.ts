/**
 * Plugin update scheduler (Taskana 4732 S1-B, design §5): the ONE periodic
 * background network task of the plugins subsystem. Fresh boot → jittered
 * 0–2 min startup delay, then a check every ~24h ± 30 min (re-rolled every
 * cycle, updater.ts's recursive-setTimeout pattern). Manual checks through
 * the IPC re-check immediately but never shorten the periodic cadence.
 *
 * GATES (all must hold, evaluated at every fire):
 *  - a window exists (headless runs never touch the network);
 *  - the official channel is CONFIGURED (§9.14: a packaged build with only
 *    test keys reports "not configured" and never schedules);
 *  - `settings.plugins.autoUpdateOfficial` is true.
 *
 * FAIL-SOOLY: a failing check logs + schedules the next one; it never
 * throws into a timer. Cancelled at shutdown; boot migration (staging wipe,
 * GC, consent) runs BEFORE the first check is armed.
 */

export interface PluginsSchedulerDeps {
  /** Runs one update pass (index check + policy-gated installs). */
  runPass: () => Promise<{ installed: { name: string; from: string; to: string }[]; needsApproval: unknown[]; status: string }>;
  /** Gates evaluated BEFORE every fire. */
  shouldRun: () => boolean;
  logger?: { warn(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void };
  schedule?: {
    random?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    startupDelayRangeMs?: [number, number];
    intervalRangeMs?: [number, number];
  };
}

export interface PluginsScheduler {
  /** Arms the startup-delayed first check (idempotent). */
  start(): void;
  /** Cancels all timers (shutdown). */
  stop(): void;
  /** Runs a pass NOW (manual "check for updates" button); does not touch the schedule. */
  runManual(): Promise<{ installed: { name: string; from: string; to: string }[]; status: string }>;
  /** True when a timer is armed (diagnostics/tests). */
  isArmed(): boolean;
}

/** Fresh-boot startup delay: 0–2 min (jitter). */
export const DEFAULT_STARTUP_DELAY_RANGE_MS: [number, number] = [0, 2 * 60 * 1000];
/** Periodic interval: 24h ± 30 min (re-rolled each cycle). */
export const DEFAULT_PERIODIC_INTERVAL_RANGE_MS: [number, number] = [
  (24 - 0.5) * 60 * 60 * 1000,
  (24 + 0.5) * 60 * 60 * 1000,
];

function pickDelayMs(range: [number, number], random: () => number): number {
  return range[0] + Math.floor(random() * (range[1] - range[0]));
}

export function createPluginsScheduler(deps: PluginsSchedulerDeps): PluginsScheduler {
  const scheduleDeps = deps.schedule ?? {};
  const random = scheduleDeps.random ?? Math.random;
  const setTimer = scheduleDeps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = scheduleDeps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startupRange = scheduleDeps.startupDelayRangeMs ?? DEFAULT_STARTUP_DELAY_RANGE_MS;
  const intervalRange = scheduleDeps.intervalRangeMs ?? DEFAULT_PERIODIC_INTERVAL_RANGE_MS;
  let timerHandle: unknown = null;
  let started = false;

  async function runPass(): Promise<{ installed: { name: string; from: string; to: string }[]; status: string }> {
    try {
      const result = await deps.runPass();
      if (result.installed.length > 0) {
        deps.logger?.info(`plugins: periodic check updated ${result.installed.length} plugin(s)`);
      }
      return { installed: result.installed, status: result.status };
    } catch (error) {
      deps.logger?.warn("plugins: periodic check failed", error);
      return { installed: [], status: "offline" };
    }
  }

  function scheduleNext(delayMs: number): void {
    timerHandle = setTimer(() => {
      timerHandle = null;
      if (deps.shouldRun()) {
        void runPass();
      }
      scheduleNext(pickDelayMs(intervalRange, random));
    }, delayMs);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      scheduleNext(pickDelayMs(startupRange, random));
    },
    stop(): void {
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      started = false;
    },
    async runManual(): Promise<{ installed: { name: string; from: string; to: string }[]; status: string }> {
      return runPass();
    },
    isArmed(): boolean {
      return timerHandle !== null;
    },
  };
}

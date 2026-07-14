/**
 * Auto-updater controller tests (design/slice-2.6-cut.md §6), exercised via
 * `createUpdaterController` off a FAKE `AutoUpdaterLike` (no Electron
 * `ipcMain`, no real electron-updater network/filesystem access) — the same
 * split as settings-ipc.test.ts's exported `handle*` functions. Covers the
 * full check->available->progress->downloaded->install status chain, the
 * isPackaged gate (a dev build never touches the fake at all), the
 * consent-first `autoDownload=false` invariant (nothing downloads without an
 * explicit `download()` call), and that none of the three actions reads or
 * forwards any renderer-supplied argument.
 */
import { describe, expect, it, vi } from "vitest";
import { UPDATE_RELEASES_URL, type UpdateStatus } from "../shared/updates.js";
import {
  createUpdaterController,
  DEFAULT_PERIODIC_INTERVAL_RANGE_MS,
  DEFAULT_STARTUP_DELAY_RANGE_MS,
  type AutoUpdaterLike,
  type UpdaterDeps,
  type UpdaterScheduleDeps,
  type UpdaterWindowLike,
} from "./updater.js";

/** In-memory fake honouring AutoUpdaterLike; captures registered listeners so a test can fire them exactly like the real library would from inside its own async work. */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = true; // electron-updater's own default (design §6: registration must flip this to false)
  private readonly listeners = new Map<string, (...args: never[]) => void>();
  readonly checkForUpdates = vi.fn(async () => undefined);
  readonly downloadUpdate = vi.fn(async () => undefined);
  readonly quitAndInstall = vi.fn();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: fires a registered listener the way the real library would (e.g. from inside checkForUpdates()'s network response). No-op if nothing registered for it (the dev/isPackaged=false gate). */
  fire(event: string, ...args: unknown[]): void {
    (this.listeners.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
  }
}

function fakeWindow(sent: UpdateStatus[]): UpdaterWindowLike {
  return { webContents: { send: (_channel: string, status: unknown) => sent.push(status as UpdateStatus) } };
}

/**
 * A synchronous, manually-driven "timer" for the schedule tests (TASK.47
 * defect 3): `setTimer` records `{delayMs, fn}` and returns an incrementing
 * handle instead of actually scheduling anything — a test fires a captured
 * `fn` itself (`armed.at(-1).fn()`), so the whole
 * startup->check->reschedule->check chain runs deterministically with zero
 * real waiting and zero fake-timer/promise interleaving surprises.
 */
function fakeSchedule(over: Partial<UpdaterScheduleDeps> = {}): {
  schedule: UpdaterScheduleDeps;
  armed: Array<{ handle: number; delayMs: number; fn: () => void }>;
  cleared: number[];
} {
  const armed: Array<{ handle: number; delayMs: number; fn: () => void }> = [];
  const cleared: number[] = [];
  let nextHandle = 0;
  const setTimer = vi.fn((fn: () => void, delayMs: number): number => {
    const handle = nextHandle++;
    armed.push({ handle, delayMs, fn });
    return handle;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    cleared.push(handle as number);
  });
  return {
    schedule: {
      random: () => 0,
      setTimer,
      clearTimer,
      ...over,
    },
    armed,
    cleared,
  };
}

function makeDeps(over: Partial<UpdaterDeps> = {}): {
  deps: UpdaterDeps;
  autoUpdater: FakeAutoUpdater;
  sent: UpdateStatus[];
} {
  const autoUpdater = new FakeAutoUpdater();
  const sent: UpdateStatus[] = [];
  const deps: UpdaterDeps = {
    autoUpdater,
    isPackaged: true,
    getWindow: () => fakeWindow(sent),
    platform: "linux",
    // Every scenario that doesn't care about scheduling still gets a fake
    // (never real timers) so a stray unawaited schedule can't leak between
    // tests or make the suite flaky under load.
    schedule: fakeSchedule().schedule,
    ...over,
  };
  return { deps, autoUpdater, sent };
}

describe("updater: isPackaged gate", () => {
  it("a dev build (isPackaged=false) never initializes — no listener attached, autoDownload untouched, every channel refuses not_packaged without calling the fake", async () => {
    const { deps, autoUpdater } = makeDeps({ isPackaged: false });
    const controller = createUpdaterController(deps);

    expect(autoUpdater.listenerCount()).toBe(0);
    expect(autoUpdater.autoDownload).toBe(true); // untouched — real default, never flipped

    expect(await controller.check()).toEqual({ ok: false, reason: "not_packaged" });
    expect(await controller.download()).toEqual({ ok: false, reason: "not_packaged" });
    expect(controller.install()).toEqual({ ok: false, reason: "not_packaged" });

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("updater: consent-first (autoDownload=false)", () => {
  it("sets autoDownload=false at registration in a packaged build", () => {
    const { deps, autoUpdater } = makeDeps();
    createUpdaterController(deps);
    expect(autoUpdater.autoDownload).toBe(false);
  });

  it("an update-available event never triggers a download by itself — only an explicit download() call does", () => {
    const { deps, autoUpdater } = makeDeps();
    createUpdaterController(deps);
    autoUpdater.fire("update-available", { version: "1.2.3" });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("download() refuses invalid_state before any check found an update", async () => {
    const { deps, autoUpdater } = makeDeps();
    const controller = createUpdaterController(deps);
    expect(await controller.download()).toEqual({ ok: false, reason: "invalid_state" });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("install() refuses invalid_state before any download finished", () => {
    const { deps, autoUpdater } = makeDeps();
    const controller = createUpdaterController(deps);
    expect(controller.install()).toEqual({ ok: false, reason: "invalid_state" });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("updater: full status chain", () => {
  it("check -> available -> progress -> downloaded -> install, each status forwarded to the renderer in order", async () => {
    const { deps, autoUpdater, sent } = makeDeps();
    const controller = createUpdaterController(deps);

    expect(await controller.check()).toEqual({ ok: true });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // The library fires "checking-for-update" the moment the check starts.
    autoUpdater.fire("checking-for-update");
    expect(sent.at(-1)).toEqual({ kind: "checking" });
    expect(controller.getStatus()).toEqual({ kind: "checking" });

    // ...then asynchronously resolves with an update found.
    autoUpdater.fire("update-available", { version: "1.2.3" });
    expect(sent.at(-1)).toEqual({ kind: "available", version: "1.2.3" });
    expect(controller.getStatus()).toEqual({ kind: "available", version: "1.2.3" });

    // download(): only valid now that status is "available".
    expect(await controller.download()).toEqual({ ok: true });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    autoUpdater.fire("download-progress", { percent: 42 });
    expect(sent.at(-1)).toEqual({ kind: "downloading", percent: 42 });

    autoUpdater.fire("update-downloaded", { version: "1.2.3" });
    expect(sent.at(-1)).toEqual({ kind: "downloaded", version: "1.2.3" });
    expect(controller.getStatus()).toEqual({ kind: "downloaded", version: "1.2.3" });

    // install(): only valid now that status is "downloaded".
    expect(controller.install()).toEqual({ ok: true });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);

    expect(sent).toEqual([
      { kind: "checking" },
      { kind: "available", version: "1.2.3" },
      { kind: "downloading", percent: 42 },
      { kind: "downloaded", version: "1.2.3" },
    ]);
  });

  it("update-not-available and error events forward too", () => {
    const { deps, autoUpdater, sent } = makeDeps();
    createUpdaterController(deps);

    autoUpdater.fire("update-not-available");
    expect(sent.at(-1)).toEqual({ kind: "not-available" });

    autoUpdater.fire("error", new Error("network down"));
    expect(sent.at(-1)).toEqual({ kind: "error", message: "network down" });
  });

  it("logs and rethrows when checkForUpdates itself throws, but does not crash the controller", async () => {
    const { deps, autoUpdater } = makeDeps();
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.fn();
    const controller = createUpdaterController({ ...deps, logger: { warn } });

    await expect(controller.check()).rejects.toThrow("offline");
    expect(warn).toHaveBeenCalledWith("updater: checkForUpdates failed", expect.any(Error));
  });
});

describe("updater: no arbitrary-URL channel", () => {
  it("check/download/install take no renderer-supplied argument — an attacker-shaped payload changes nothing", async () => {
    const { deps, autoUpdater } = makeDeps();
    const controller = createUpdaterController(deps);

    // registerUpdater wires each ipcMain.handle callback with ZERO
    // parameters (see updater.ts) — a renderer-supplied payload is
    // structurally unreachable. This calls the underlying method directly
    // with an attacker-shaped payload to prove there is nothing for it to
    // read even if some future refactor forwarded arguments by accident.
    const maliciousCheck = controller.check as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(maliciousCheck({ url: "https://evil.example/feed.yml" })).resolves.toEqual({ ok: true });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledWith();
  });
});

// ── TASK.47 defect 3: auto-check schedule ──

describe("updater: auto-check schedule (TASK.47 defect 3)", () => {
  it("does not arm anything in a dev build (isPackaged=false) — no setTimer call at all", () => {
    const { schedule, armed } = fakeSchedule();
    const { deps } = makeDeps({ isPackaged: false, schedule });
    createUpdaterController(deps);
    expect(armed).toHaveLength(0);
  });

  it("arms exactly one startup timer, with a delay inside the configured [min,max) range", () => {
    const { schedule, armed } = fakeSchedule({
      startupDelayRangeMs: [10_000, 30_000],
      random: () => 0.5,
    });
    const { deps } = makeDeps({ schedule });
    createUpdaterController(deps);

    expect(armed).toHaveLength(1);
    expect(armed[0]?.delayMs).toBe(20_000); // 10_000 + 0.5 * (30_000 - 10_000)
  });

  it("random()=0 picks exactly the range floor; random() just under 1 picks just under the ceiling — the delay never leaves [min,max)", () => {
    const range: readonly [number, number] = [10_000, 30_000];
    const low = fakeSchedule({ startupDelayRangeMs: range, random: () => 0 });
    createUpdaterController(makeDeps({ schedule: low.schedule }).deps);
    expect(low.armed[0]?.delayMs).toBe(10_000);

    const high = fakeSchedule({ startupDelayRangeMs: range, random: () => 0.999999 });
    createUpdaterController(makeDeps({ schedule: high.schedule }).deps);
    expect(high.armed[0]?.delayMs).toBeGreaterThanOrEqual(10_000);
    expect(high.armed[0]?.delayMs).toBeLessThan(30_000);
  });

  it("uses the ~10-30s / ~4-6h production defaults when no schedule override is given", async () => {
    // random fixed at the midpoint so the observed delay pins down the range;
    // no startupDelayRangeMs/intervalRangeMs override -> the controller's own
    // DEFAULT_* constants apply.
    const { schedule, armed } = fakeSchedule({ random: () => 0.5 });
    const { deps, autoUpdater } = makeDeps({ schedule });
    createUpdaterController(deps);

    const [startupMin, startupMax] = DEFAULT_STARTUP_DELAY_RANGE_MS;
    expect(armed[0]?.delayMs).toBe(startupMin + 0.5 * (startupMax - startupMin));

    armed[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    const [intervalMin, intervalMax] = DEFAULT_PERIODIC_INTERVAL_RANGE_MS;
    expect(armed[1]?.delayMs).toBe(intervalMin + 0.5 * (intervalMax - intervalMin));
  });

  it("firing the startup timer calls checkForUpdates() — the SAME path the renderer's Check button drives — then re-arms with a delay from the INTERVAL range, not the startup range", async () => {
    const { schedule, armed } = fakeSchedule({
      startupDelayRangeMs: [10_000, 30_000],
      intervalRangeMs: [4 * 3_600_000, 6 * 3_600_000],
      random: () => 0,
    });
    const { deps, autoUpdater } = makeDeps({ schedule });
    createUpdaterController(deps);

    expect(armed).toHaveLength(1);
    expect(armed[0]?.delayMs).toBe(10_000);

    armed[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(armed).toHaveLength(2);
    expect(armed[1]?.delayMs).toBe(4 * 3_600_000); // random()=0 -> exactly the interval floor
  });

  it("re-rolls a FRESH interval every cycle (the jitter) rather than reusing a fixed interval", async () => {
    let call = 0;
    // A degenerate [min,max) startup range short-circuits pickDelayMs before
    // it ever calls random() (see updater.ts), so only the two periodic
    // re-arms below actually consume a roll.
    const rolls = [1, 0.25];
    const { schedule, armed } = fakeSchedule({
      startupDelayRangeMs: [1_000, 1_000],
      intervalRangeMs: [10_000, 20_000],
      random: () => rolls[call++] ?? 0,
    });
    const { deps } = makeDeps({ schedule });
    createUpdaterController(deps);

    armed[0]?.fn(); // startup fire -> interval roll #1 (random()=1 -> ceiling)
    await Promise.resolve();
    await Promise.resolve();
    expect(armed[1]?.delayMs).toBe(20_000);

    armed[1]?.fn(); // second fire -> interval roll #2 (random()=0.25 -> quarter point)
    await Promise.resolve();
    await Promise.resolve();
    expect(armed[2]?.delayMs).toBe(12_500);

    expect(armed[1]?.delayMs).not.toBe(armed[2]?.delayMs);
  });

  it("the scheduled auto-check NEVER calls downloadUpdate — only checkForUpdates — even after an update-available event fires mid-cycle", async () => {
    const { schedule, armed } = fakeSchedule({ startupDelayRangeMs: [5_000, 5_000], intervalRangeMs: [5_000, 5_000] });
    const { deps, autoUpdater } = makeDeps({ schedule });
    createUpdaterController(deps);

    armed[0]?.fn();
    await Promise.resolve();
    autoUpdater.fire("update-available", { version: "9.9.9" });
    armed[1]?.fn();
    await Promise.resolve();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("a checkForUpdates rejection during a scheduled cycle does not stop the NEXT cycle from arming", async () => {
    const { schedule, armed } = fakeSchedule({ startupDelayRangeMs: [1_000, 1_000], intervalRangeMs: [2_000, 2_000] });
    const { deps, autoUpdater } = makeDeps({ schedule });
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    createUpdaterController(deps);

    armed[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(armed).toHaveLength(2); // re-armed despite the rejection
    expect(armed[1]?.delayMs).toBe(2_000);
  });

  it("stop() clears the currently-armed timer via clearTimer with the exact handle setTimer returned", () => {
    const { schedule, armed, cleared } = fakeSchedule({ startupDelayRangeMs: [7_000, 7_000] });
    const { deps } = makeDeps({ schedule });
    const controller = createUpdaterController(deps);

    expect(armed).toHaveLength(1);
    controller.stop();
    expect(cleared).toEqual([armed[0]?.handle]);
  });

  it("stop() is idempotent (a dev-build controller, or a double call, never throws)", () => {
    const { deps } = makeDeps({ isPackaged: false });
    const controller = createUpdaterController(deps);
    expect(() => {
      controller.stop();
      controller.stop();
    }).not.toThrow();
  });
});

// ── TASK.47 defect 2: darwin honest manual-only path ──

describe("updater: darwin honest manual-only path (TASK.47 defect 2)", () => {
  it("on darwin, an update-available event decorates the status with manualOnly:true", () => {
    const { deps, autoUpdater, sent } = makeDeps({ platform: "darwin" });
    createUpdaterController(deps);

    autoUpdater.fire("update-available", { version: "1.2.3" });
    expect(sent.at(-1)).toEqual({ kind: "available", version: "1.2.3", manualOnly: true });
  });

  it("on win32/linux, an update-available event carries NO manualOnly key at all (additive-field byte discipline)", () => {
    for (const platform of ["win32", "linux"] as const) {
      const { deps, autoUpdater, sent } = makeDeps({ platform });
      createUpdaterController(deps);
      autoUpdater.fire("update-available", { version: "1.2.3" });
      expect(sent.at(-1)).toEqual({ kind: "available", version: "1.2.3" });
      expect("manualOnly" in (sent.at(-1) as object)).toBe(false);
    }
  });

  it("download() refuses manual_only on darwin even once status is available — a structural backstop, not just a hidden UI button", async () => {
    const { deps, autoUpdater } = makeDeps({ platform: "darwin" });
    const controller = createUpdaterController(deps);

    autoUpdater.fire("update-available", { version: "1.2.3" });
    expect(await controller.download()).toEqual({ ok: false, reason: "manual_only" });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("install() refuses manual_only on darwin even if the underlying autoUpdater somehow reports downloaded", () => {
    const { deps, autoUpdater } = makeDeps({ platform: "darwin" });
    const controller = createUpdaterController(deps);

    // Simulates a hypothetical future regression where something other than
    // this module's own (blocked) download() reached "downloaded" — the
    // platform guard must hold regardless of how status got there.
    autoUpdater.fire("update-downloaded", { version: "1.2.3" });
    expect(controller.install()).toEqual({ ok: false, reason: "manual_only" });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("download()/install() are NOT manual_only-gated on win32/linux — the existing invalid_state/available/downloaded chain is untouched", async () => {
    const { deps, autoUpdater } = makeDeps({ platform: "win32" });
    const controller = createUpdaterController(deps);

    autoUpdater.fire("update-available", { version: "1.2.3" });
    expect(await controller.download()).toEqual({ ok: true });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    autoUpdater.fire("update-downloaded", { version: "1.2.3" });
    expect(controller.install()).toEqual({ ok: true });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ── TASK.47 defect 2: open-releases action ──

describe("updater: openReleasesPage (TASK.47 defect 2)", () => {
  it("calls openExternal with the exact fixed UPDATE_RELEASES_URL — no renderer-supplied argument exists to redirect it", () => {
    const openExternal = vi.fn();
    const { deps } = makeDeps({ openExternal });
    const controller = createUpdaterController(deps);

    expect(controller.openReleasesPage()).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(UPDATE_RELEASES_URL);
  });

  it("refuses not_packaged in a dev build and never calls openExternal", () => {
    const openExternal = vi.fn();
    const { deps } = makeDeps({ isPackaged: false, openExternal });
    const controller = createUpdaterController(deps);

    expect(controller.openReleasesPage()).toEqual({ ok: false, reason: "not_packaged" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("swallows an openExternal throw (logs, still reports ok) rather than crashing the controller", () => {
    const openExternal = vi.fn(() => {
      throw new Error("no browser handler");
    });
    const warn = vi.fn();
    const { deps } = makeDeps({ openExternal, logger: { warn } });
    const controller = createUpdaterController(deps);

    expect(controller.openReleasesPage()).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith("updater: openExternal failed", expect.any(Error));
  });
});

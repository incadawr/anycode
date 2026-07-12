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
import type { UpdateStatus } from "../shared/updates.js";
import { createUpdaterController, type AutoUpdaterLike, type UpdaterDeps, type UpdaterWindowLike } from "./updater.js";

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

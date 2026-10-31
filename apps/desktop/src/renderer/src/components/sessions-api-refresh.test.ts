/**
 * The refresh loop behind the Sessions API pane's live folder marks: a pane
 * that stays open must see a folder disappear (or come back) without being
 * reopened. The view is recomputed main-side on every read, so the loop's only
 * job is to ask again, without overlapping reads and without repainting a
 * closed pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSIONS_API_REFRESH_MS, startSessionsApiRefresh } from "./sessions-api-refresh.js";
import type { CommunicationGetResult, CommunicationView } from "../../../shared/communication-config.js";

const view = (missing: string[]): CommunicationView => ({
  enabled: true,
  workspaces: ["/gone"],
  missingWorkspaces: missing,
  port: null,
  defaultSessionAccess: "off",
  status: { state: "listening", url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 1, sessions: 0 },
  tabs: [],
  agentProjects: [],
});

const ok = (missing: string[]): CommunicationGetResult => ({ ok: true, view: view(missing), envControlled: false });

describe("startSessionsApiRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not read before the first interval elapses", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => ok([]));
    startSessionsApiRefresh({ get, onView: () => {} });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS - 1);
    expect(get).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("delivers a folder that disappears after mount (the stale missing mark)", async () => {
    vi.useFakeTimers();
    const views = [ok([]), ok(["/gone"])];
    let call = 0;
    const seen: string[][] = [];
    startSessionsApiRefresh({
      get: async () => views[Math.min(call++, views.length - 1)]!,
      onView: (result) => seen.push(result.view.missingWorkspaces),
    });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);

    expect(seen).toEqual([[], ["/gone"]]);
  });

  it("clears the mark again once the folder is back", async () => {
    vi.useFakeTimers();
    const views = [ok(["/gone"]), ok([])];
    let call = 0;
    const seen: string[][] = [];
    startSessionsApiRefresh({
      get: async () => views[Math.min(call++, views.length - 1)]!,
      onView: (result) => seen.push(result.view.missingWorkspaces),
    });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);

    expect(seen.at(-1)).toEqual([]);
  });

  it("re-reads immediately when the window regains focus (back from the file manager)", async () => {
    vi.useFakeTimers();
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);
    const get = vi.fn(async () => ok(["/gone"]));
    startSessionsApiRefresh({ get, onView: () => {} });

    fakeWindow.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("the focus listener is removed with the loop (no read from a closed pane)", async () => {
    vi.useFakeTimers();
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);
    const get = vi.fn(async () => ok([]));
    const stop = startSessionsApiRefresh({ get, onView: () => {} });
    stop();

    fakeWindow.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(get).not.toHaveBeenCalled();
  });

  it("never overlaps reads: a slow read absorbs further ticks", async () => {
    vi.useFakeTimers();
    let resolveRead: ((result: CommunicationGetResult) => void) | undefined;
    const get = vi.fn(
      () =>
        new Promise<CommunicationGetResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    startSessionsApiRefresh({ get, onView: () => {} });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS * 3);
    expect(get).toHaveBeenCalledTimes(1);

    resolveRead!(ok([]));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops reading once stopped, and drops a read that lands after the stop", async () => {
    vi.useFakeTimers();
    let resolveRead: ((result: CommunicationGetResult) => void) | undefined;
    const onView = vi.fn();
    const get = vi.fn(
      () =>
        new Promise<CommunicationGetResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const stop = startSessionsApiRefresh({ get, onView });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    expect(get).toHaveBeenCalledTimes(1);
    stop();
    resolveRead!(ok(["/gone"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(onView).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS * 3);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps the last view when a read is refused or throws", async () => {
    vi.useFakeTimers();
    const onView = vi.fn();
    const get = vi
      .fn<() => Promise<CommunicationGetResult>>()
      .mockRejectedValueOnce(new Error("ipc gone"))
      .mockResolvedValueOnce({ ok: false, reason: "invalid" });
    startSessionsApiRefresh({ get, onView });

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);

    expect(onView).not.toHaveBeenCalled();
  });
});

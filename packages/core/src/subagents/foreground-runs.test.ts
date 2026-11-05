import { afterEach, describe, expect, it, vi } from "vitest";
import { ForegroundRuns } from "./foreground-runs.js";
import type { SubagentOutcome } from "../ports/subagent.js";

const outcome: SubagentOutcome = { status: "completed", finalText: "done", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };

describe("foreground runs", () => {
  afterEach(() => vi.useRealTimers());

  it("joins the same run repeatedly and caches its terminal", async () => {
    vi.useFakeTimers();
    const runs = new ForegroundRuns(100);
    let finish!: (value: SubagentOutcome) => void;
    const run = vi.fn(() => new Promise<SubagentOutcome>((resolve) => { finish = resolve; }));
    const handle = runs.start(run, () => undefined);
    const first = runs.join(handle);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toEqual({ kind: "pending_foreground", handle, progress: undefined });
    const second = runs.join(handle);
    finish(outcome);
    expect(await second).toEqual({ kind: "terminal", outcome });
    expect(await runs.join(handle)).toEqual({ kind: "terminal", outcome });
    expect(run).toHaveBeenCalledOnce();
    expect(runs.hasLive).toBe(false);
  });

  it("isolates handles by turn and aborts outstanding runs on close", async () => {
    const runs = new ForegroundRuns();
    const other = new ForegroundRuns();
    let signal!: AbortSignal;
    const handle = runs.start((s) => { signal = s; return new Promise(() => {}); }, () => undefined);
    await Promise.resolve();
    await expect(other.join(handle)).rejects.toThrow("Unknown foreground run");
    runs.close();
    expect(signal.aborted).toBe(true);
    await expect(runs.join(handle)).rejects.toThrow("Unknown foreground run");
    expect(() => runs.start(async () => outcome, () => undefined)).toThrow();
  });
});

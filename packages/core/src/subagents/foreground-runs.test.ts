import { afterEach, describe, expect, it, vi } from "vitest";
import { ForegroundRuns, formatForegroundJoin } from "./foreground-runs.js";
import type { SubagentOutcome } from "../ports/subagent.js";
import { foregroundAgentInputSchema } from "../tools/schemas.js";

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
    expect(await second).toEqual({ kind: "terminal", handle, outcome });
    expect(await runs.join(handle)).toEqual({ kind: "terminal", handle, outcome });
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

  it("rejects conflicting wait inputs", () => {
    expect(foregroundAgentInputSchema.safeParse({ wait_for: "run" }).success).toBe(true);
    expect(foregroundAgentInputSchema.safeParse({ wait_for: "run", prompt: "new", description: "new" }).success).toBe(false);
    expect(foregroundAgentInputSchema.safeParse({ wait_for: "" }).success).toBe(false);
  });

  it("bounds terminal output in UTF-8 and marks it truncated", () => {
    const text = formatForegroundJoin({ kind: "terminal", handle: "h", outcome: { ...outcome, finalText: "🚢".repeat(40_000) } });
    const parsed = JSON.parse(text);
    expect(Buffer.byteLength(parsed.outcome.finalText)).toBeLessThanOrEqual(100_000);
    expect(parsed.outcome.truncated).toBe(true);
  });

  it("reports a terminal that settles at the quantum", async () => {
    vi.useFakeTimers();
    const runs = new ForegroundRuns(100);
    const handle = runs.start(() => new Promise((resolve) => setTimeout(() => resolve(outcome), 100)), () => undefined);
    await Promise.resolve();
    const joined = runs.join(handle);
    await vi.advanceTimersByTimeAsync(100);
    expect(await joined).toEqual({ kind: "terminal", handle, outcome });
  });
});

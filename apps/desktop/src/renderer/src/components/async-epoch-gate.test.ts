/**
 * Unit tests for the async epoch gate (F1, codex-profiles cut lane FXH):
 * guards CodexRolloutImportDialog's profile-list/preview effects against a
 * stale, late-resolving request overwriting a newer selection's state.
 */
import { describe, expect, it } from "vitest";
import { createAsyncEpochGate, issueGuarded } from "./async-epoch-gate.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createAsyncEpochGate", () => {
  it("next() invalidates every token issued before it", () => {
    const gate = createAsyncEpochGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("invalidate() invalidates every outstanding token, including the latest", () => {
    const gate = createAsyncEpochGate();
    const token = gate.next();
    gate.invalidate();
    expect(gate.isCurrent(token)).toBe(false);
  });

  it("a token from a gate that has never issued past it is not current", () => {
    const gate = createAsyncEpochGate();
    expect(gate.isCurrent(0)).toBe(false);
    expect(gate.isCurrent(1)).toBe(false);
  });
});

describe("issueGuarded", () => {
  it("applies exactly once, with the value of the LATEST issued request — even when the earlier request resolves last (red-proof: without the gate, the last SETTLE wins, not the last ISSUE)", async () => {
    const gate = createAsyncEpochGate();
    const a = deferred<string>();
    const b = deferred<string>();
    const applied: string[] = [];

    issueGuarded(gate, a.promise, (v) => applied.push(v));
    issueGuarded(gate, b.promise, (v) => applied.push(v));

    // Resolve out of issue order: b (issued second) settles first, a settles last.
    b.resolve("b-value");
    await b.promise;
    a.resolve("a-value");
    await a.promise;
    await Promise.resolve();

    expect(applied).toEqual(["b-value"]);
  });

  it("a request issued after invalidate() still applies normally", async () => {
    const gate = createAsyncEpochGate();
    const applied: string[] = [];
    gate.invalidate();
    issueGuarded(gate, Promise.resolve("fresh"), (v) => applied.push(v));
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["fresh"]);
  });

  it("a request superseded by invalidate() before it settles never applies", async () => {
    const gate = createAsyncEpochGate();
    const pending = deferred<string>();
    const applied: string[] = [];

    issueGuarded(gate, pending.promise, (v) => applied.push(v));
    gate.invalidate();
    pending.resolve("stale");
    await pending.promise;
    await Promise.resolve();

    expect(applied).toEqual([]);
  });
});

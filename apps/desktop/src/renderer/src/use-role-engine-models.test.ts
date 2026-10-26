import { describe, expect, it, vi } from "vitest";
import { startRoleCodexCatalogRefresh } from "./use-role-engine-models.js";

describe("role Codex catalog lifecycle", () => {
  it("does not recheck or subscribe when Codex is not ready / the dialog is closed", () => {
    const recheck = vi.fn();
    const subscribe = vi.fn();
    expect(startRoleCodexCatalogRefresh(false, { recheck, getModels: () => [], setModels: vi.fn(), subscribe })).toBeUndefined();
    expect(recheck).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it("updates the supplied shared catalog and preserves it on dialog close", async () => {
    const models = [{ id: "shared-codex" }];
    const setModels = vi.fn();
    const unsubscribe = vi.fn();
    const stop = startRoleCodexCatalogRefresh(true, {
      recheck: async () => ({ report: { status: "ready", models } }),
      getModels: () => [], setModels, subscribe: () => unsubscribe,
    });
    await vi.waitFor(() => expect(setModels).toHaveBeenLastCalledWith(models));
    stop!();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(setModels).toHaveBeenLastCalledWith(models);
  });
});


it("never rechecks a pre-filled shared store, including on engine-change notifications", () => {
  const models = [{ id: "start-screen-model" }];
  const recheck = vi.fn();
  const setModels = vi.fn();
  let refresh!: () => void;
  const stop = startRoleCodexCatalogRefresh(true, {
    getModels: () => models, recheck, setModels,
    subscribe: (callback) => { refresh = callback; return () => {}; },
  });
  refresh();
  expect(recheck).not.toHaveBeenCalled();
  expect(setModels).not.toHaveBeenCalled();
  stop!();
  expect(setModels).not.toHaveBeenCalled();
});

it("preserves a shared catalog populated during a pending recheck when that recheck fails", async () => {
  let models: readonly { id: string }[] = [];
  const existing = [{ id: "start-screen-model" }];
  let reject!: (error: Error) => void;
  const onRecheckError = vi.fn();
  const setModels = vi.fn((next: readonly { id: string }[]) => { models = next; });
  const stop = startRoleCodexCatalogRefresh(true, {
    getModels: () => models,
    recheck: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }),
    setModels, onRecheckError, subscribe: () => () => {},
  });
  expect(setModels).not.toHaveBeenCalled();
  models = existing; // StartScreen finishes its own concurrent fetch.
  expect(models).toBe(existing);
  reject(new Error("offline"));
  await vi.waitFor(() => expect(onRecheckError).toHaveBeenCalledOnce());
  expect(models).toBe(existing);
  expect(setModels).not.toHaveBeenCalled();
  stop!();
  expect(models).toBe(existing);
});

it.each(["ready", "unavailable"])("ignores an empty %s response without blanking a concurrent StartScreen result", async (status) => {
  let models: readonly { id: string }[] = [];
  let resolve!: (snapshot: { report: { status: string; models: [] } }) => void;
  const setModels = vi.fn((next: readonly { id: string }[]) => { models = next; });
  const stop = startRoleCodexCatalogRefresh(true, {
    getModels: () => models,
    recheck: () => new Promise((resolvePromise) => { resolve = resolvePromise; }),
    setModels, subscribe: () => () => {},
  });
  const existing = [{ id: "start-screen-model" }];
  models = existing;
  resolve({ report: { status, models: [] } });
  await new Promise((done) => setTimeout(done, 0));
  expect(models).toBe(existing);
  expect(setModels).not.toHaveBeenCalled();
  stop!();
});

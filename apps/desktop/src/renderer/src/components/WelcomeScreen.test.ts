/**
 * Pure-logic tests for WelcomeScreen's exported view-selection helpers
 * (TASK.68 — onboarding was locked into editing the FIRST connection forever,
 * with no way to switch to a different saved connection or create a new one).
 * Deliberately `.test.ts` (not `.test.tsx`): this package's vitest config
 * runs in `environment: "node"` with no jsdom (see ConnectionDrawer.test.ts's
 * docstring) — the actual add/edit form + list rendering is proven live by
 * the provider-connections-ui-smoke.mjs script instead. `initialConnectionsView`
 * and `resolveWelcomeView` carry every branch of WelcomeScreen's view logic so
 * it's tested directly, same discipline as ConnectionDrawer's
 * `resolveCreatedConnectionId`/`liveModelSuggestions`.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "../../../shared/settings.js";
import { initialConnectionsView, resolveWelcomeView, type WelcomeConnectionsView } from "./WelcomeScreen.js";

function conn(id: string, providerId = "z-ai"): ProviderConnection {
  return { id, providerId };
}

describe("initialConnectionsView", () => {
  it("no connections -> creation view", () => {
    expect(initialConnectionsView([])).toEqual({ mode: "add" });
  });

  it("one connection -> edit view on that connection", () => {
    expect(initialConnectionsView([conn("a")])).toEqual({ mode: "edit", connectionId: "a" });
  });

  it("multiple connections -> edit view on the FIRST one", () => {
    expect(initialConnectionsView([conn("a"), conn("b")])).toEqual({ mode: "edit", connectionId: "a" });
  });
});

describe("resolveWelcomeView", () => {
  const connections = [conn("a"), conn("b")];

  it("add view -> creation mode, no edit target, stable 'add' key", () => {
    const view: WelcomeConnectionsView = { mode: "add" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "add", editConnection: undefined, key: "add" });
  });

  it("edit view on an existing connection -> that connection, keyed by its id", () => {
    const view: WelcomeConnectionsView = { mode: "edit", connectionId: "b" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "edit", editConnection: connections[1], key: "b" });
  });

  it("edit view on a vanished connection id falls back to creation (defensive — this list offers no delete)", () => {
    const view: WelcomeConnectionsView = { mode: "edit", connectionId: "gone" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "add", editConnection: undefined, key: "add" });
  });

  it("switching add -> edit -> add again yields the SAME key each time back at the same view (no drift)", () => {
    const add = resolveWelcomeView({ mode: "add" }, connections);
    const edit = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);
    const addAgain = resolveWelcomeView({ mode: "add" }, connections);
    const editAgain = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);

    expect(add.key).toBe("add");
    expect(edit.key).toBe("a");
    expect(addAgain.key).toBe(add.key);
    expect(editAgain.key).toBe(edit.key);
  });

  it("switching between two DIFFERENT connections yields DIFFERENT keys", () => {
    const editA = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);
    const editB = resolveWelcomeView({ mode: "edit", connectionId: "b" }, connections);
    expect(editA.key).not.toBe(editB.key);
  });
});

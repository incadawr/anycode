/**
 * Pure-logic tests for ConnectionDrawer's exported helper (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts/ConnectionTile.test.ts: this package's vitest config
 * runs in `environment: "node"` with no jsdom, so the actual add/edit form
 * behavior is proven live by `provider-connections-ui-smoke.mjs` instead.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "../../../shared/settings.js";
import { findNewlyCreatedConnection } from "./ConnectionDrawer.js";

function conn(id: string, providerId = "z-ai"): ProviderConnection {
  return { id, providerId };
}

describe("findNewlyCreatedConnection (the add-flow's create→id resolution)", () => {
  it("finds the one connection present in `after` but not `before`", () => {
    const before = [conn("conn-1")];
    const after = [conn("conn-1"), conn("conn-2")];
    expect(findNewlyCreatedConnection(before, after)?.id).toBe("conn-2");
  });

  it("a fresh install (no prior connections) — the first-ever connection is 'new'", () => {
    const after = [conn("conn-1")];
    expect(findNewlyCreatedConnection([], after)?.id).toBe("conn-1");
  });

  it("undefined when nothing new appears (a stale/duplicate response)", () => {
    const before = [conn("conn-1")];
    expect(findNewlyCreatedConnection(before, before)).toBeUndefined();
  });

  it("picks the correct new connection even among several existing ones (two connections of the same provider)", () => {
    const before = [conn("conn-1", "openai"), conn("conn-2", "openai")];
    const after = [conn("conn-1", "openai"), conn("conn-2", "openai"), conn("conn-3", "openai")];
    expect(findNewlyCreatedConnection(before, after)?.id).toBe("conn-3");
  });
});

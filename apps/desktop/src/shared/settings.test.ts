/**
 * Unit tests for `resolveProviderConnection` (TASK.102 CUT-S2 §10.9.3, F4):
 * the pure policy behind an EXPLICIT `Agent(tier:"session", provider:…)`
 * spawn's provider-id -> connection resolution. This is the shared/settings.ts
 * half of F4 — `main/index.ts` wires it into `TabHostManager`'s
 * `resolveProviderConnection` dep (`main/tabs.ts:539`) via a one-line adapter;
 * this file discriminates the POLICY itself (active-wins / first-by-order /
 * bare-sentinel / unknown-provider), not merely the symbol's existence.
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings } from "./settings.js";
import { resolveProviderConnection } from "./settings.js";
import { connectionFixture, providerV2Multi } from "./provider-v2-fixture.js";

function settingsWith(activeConnectionId: string | undefined, connections: ReturnType<typeof connectionFixture>[]): AnycodeSettings {
  return {
    version: 2,
    provider: providerV2Multi(activeConnectionId, connections),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

describe("resolveProviderConnection (TASK.102 CUT-S2 §10.9.3 F4)", () => {
  it("the active connection wins when it matches the requested providerId, even though a later connection also matches", () => {
    const active = connectionFixture({ id: "anthropic", connectionId: "conn-active" });
    const other = connectionFixture({ id: "anthropic", connectionId: "conn-other" });
    const settings = settingsWith("conn-active", [other, active]);

    const resolved = resolveProviderConnection(settings, "anthropic");

    expect(resolved?.id).toBe("conn-active");
  });

  it("falls back to the first-by-storage-order match when no connection is active", () => {
    const first = connectionFixture({ id: "openai", connectionId: "conn-first" });
    const second = connectionFixture({ id: "openai", connectionId: "conn-second" });
    const settings = settingsWith(undefined, [first, second]);

    const resolved = resolveProviderConnection(settings, "openai");

    expect(resolved?.id).toBe("conn-first");
  });

  it("falls back to the first-by-storage-order match when the active connection's providerId does not match the request", () => {
    const active = connectionFixture({ id: "anthropic", connectionId: "conn-active" });
    const firstMatch = connectionFixture({ id: "openai", connectionId: "conn-first" });
    const secondMatch = connectionFixture({ id: "openai", connectionId: "conn-second" });
    const settings = settingsWith("conn-active", [firstMatch, secondMatch]);

    const resolved = resolveProviderConnection(settings, "openai");

    expect(resolved?.id).toBe("conn-first");
  });

  it("the bare/custom sentinel providerId (\"\") never resolves, even if a bare connection is active", () => {
    const bare = connectionFixture({ connectionId: "conn-legacy" });
    const settings = settingsWith("conn-legacy", [bare]);

    expect(resolveProviderConnection(settings, "")).toBeUndefined();
  });

  it("an unknown/deleted providerId resolves to undefined", () => {
    const known = connectionFixture({ id: "anthropic", connectionId: "conn-known" });
    const settings = settingsWith("conn-known", [known]);

    expect(resolveProviderConnection(settings, "z-ai")).toBeUndefined();
  });

  it("resolves to undefined against an empty connections list (fresh install)", () => {
    const settings = settingsWith(undefined, []);

    expect(resolveProviderConnection(settings, "anthropic")).toBeUndefined();
  });
});

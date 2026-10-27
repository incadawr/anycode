import { describe, expect, it } from "vitest";
import { mergeHostEnvCache, rebuildHostEnvCache } from "./host-env-cache.js";

const env = (value: string): NodeJS.ProcessEnv => ({ PATH: value });

describe("mergeHostEnvCache — a refresh cannot drop a newer primed/live pin", () => {
  it("keeps a reserved pin primed while the refresh snapshot was taken", () => {
    const next = new Map([["conn-a", env("fresh-a")]]);
    const previous = new Map([
      ["conn-a", env("old-a")],
      ["conn-b", env("primed-b")],
    ]);
    const merged = mergeHostEnvCache({
      next,
      previous,
      reserved: (id) => id === "conn-b",
      livePin: () => false,
    });
    expect(merged.get("conn-b")).toEqual({ PATH: "primed-b" });
    expect(merged.get("conn-a")).toEqual({ PATH: "fresh-a" });
  });

  it("keeps a pin that registered during the rebuild (live but not in the snapshot)", () => {
    const next = new Map([["conn-a", env("fresh-a")]]);
    const previous = new Map([["conn-b", env("primed-b")]]);
    const merged = mergeHostEnvCache({
      next,
      previous,
      reserved: () => false,
      livePin: (id) => id === "conn-b",
    });
    expect(merged.get("conn-b")).toEqual({ PATH: "primed-b" });
  });

  it("drops a deleted pin that is neither reserved nor live", () => {
    const next = new Map([["conn-a", env("fresh-a")]]);
    const previous = new Map([
      ["conn-a", env("old-a")],
      ["conn-deleted", env("stale")],
    ]);
    const merged = mergeHostEnvCache({
      next,
      previous,
      reserved: () => false,
      livePin: () => false,
    });
    expect(merged.has("conn-deleted")).toBe(false);
    expect(merged.has("conn-a")).toBe(true);
  });

  it("does not duplicate an entry already recomputed in next", () => {
    const next = new Map([["conn-a", env("fresh-a")]]);
    const previous = new Map([["conn-a", env("old-a")]]);
    const merged = mergeHostEnvCache({
      next,
      previous,
      reserved: () => true,
      livePin: () => true,
    });
    expect(merged.get("conn-a")).toEqual({ PATH: "fresh-a" });
    expect(merged.size).toBe(1);
  });
});

/**
 * The PRODUCTION rebuild `refreshProviderState` runs (finding 2):
 * the interleavings below are the ones the pure `mergeHostEnvCache` unit tests
 * cannot express — a priming/registration that lands while the rebuild is
 * awaiting the vault. Without the merge the replacement map drops the entry and
 * the tab's next spawn fails closed into `crash_looped`.
 */
describe("rebuildHostEnvCache — a refresh cannot drop a pin primed or registered mid-rebuild", () => {
  it("keeps a pin primed DURING the rebuild's awaits (reservation still held)", async () => {
    const live = new Map<string, NodeJS.ProcessEnv>([["conn-a", env("old-a")]]);
    const reserved = new Set<string>();
    const result = await rebuildHostEnvCache({
      previous: live,
      pinned: ["conn-a"],
      activeConnectionId: "conn-active",
      connectionExists: () => true,
      async buildEnv(id) {
        // `ensurePinnedEnv` writes the live cache in place while the rebuild
        // awaits — the tab's pin was primed after the snapshot was taken.
        live.set("conn-glm", env("primed-glm"));
        reserved.add("conn-glm");
        return env(`fresh-${id}`);
      },
      reserved: (id) => reserved.has(id),
      livePin: () => false,
    });
    expect(result.get("conn-glm")).toEqual({ PATH: "primed-glm" });
    expect(result.get("conn-a")).toEqual({ PATH: "fresh-conn-a" });
  });

  it("keeps a pin that REGISTERED during the rebuild and has already been released (live pin)", async () => {
    const live = new Map<string, NodeJS.ProcessEnv>();
    let registered = false;
    const result = await rebuildHostEnvCache({
      previous: live,
      pinned: ["conn-a"],
      activeConnectionId: "conn-active",
      connectionExists: () => true,
      async buildEnv(id) {
        // createTab ran inside the await window: primed, then the reservation
        // released in create-session-by-agent's `finally`; only the live pin
        // (manager.pinnedConnectionIds()) still marks it in use.
        live.set("conn-glm", env("primed-glm"));
        registered = true;
        return env(`fresh-${id}`);
      },
      reserved: () => false,
      livePin: (id) => registered && id === "conn-glm",
    });
    expect(result.get("conn-glm")).toEqual({ PATH: "primed-glm" });
  });

  it("drops a deleted connection's stale entry and never rebuilds the active pin", async () => {
    const built: string[] = [];
    const result = await rebuildHostEnvCache({
      previous: new Map([["conn-deleted", env("stale")]]),
      pinned: ["conn-active", "conn-deleted"],
      activeConnectionId: "conn-active",
      connectionExists: (id) => id !== "conn-deleted",
      async buildEnv(id) {
        built.push(id);
        return env(`fresh-${id}`);
      },
      reserved: () => false,
      livePin: () => false,
    });
    expect(built).toEqual([]);
    expect(result.has("conn-deleted")).toBe(false);
    expect(result.has("conn-active")).toBe(false);
  });
});

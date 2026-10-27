/**
 * GitHub #17 slice B: the host-local read of the SHARED
 * effective per-parent child cap. It must agree with main's resolution, so
 * both go through `shared/session-limits.ts` over the same two inputs. Every
 * fixture below is a temporary file — no real settings are ever read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChildSessionsPerParentMax } from "./child-session-limits.js";
import { resolveChildSessionsPerParentMax } from "../shared/session-limits.js";
import { resolveProfileRoles } from "../shared/role-profiles.js";
import { parseSettings } from "../settings/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(raw: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "anycode-gh17-limits-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  writeFileSync(path, typeof raw === "string" ? raw : JSON.stringify(raw));
  return path;
}

const base = {
  version: 2,
  provider: { connections: [] },
  tools: {},
  permissions: { alwaysAllow: [] },
  ui: { theme: "system" },
  security: { allowWeakSecretStorage: false },
};

describe("readChildSessionsPerParentMax", () => {
  it("missing / unreadable / corrupt files fall back to the shared default of three", () => {
    expect(readChildSessionsPerParentMax(join(tmpdir(), "anycode-gh17-does-not-exist.json"), "/proj")).toBe(3);
    expect(readChildSessionsPerParentMax(fixture("{not json"), "/proj")).toBe(3);
    expect(readChildSessionsPerParentMax(fixture("nope"), "/proj")).toBe(3);
  });

  it("honours the session setting alone when no role cap is set", () => {
    expect(readChildSessionsPerParentMax(fixture(base), "/proj")).toBe(3);
    expect(
      readChildSessionsPerParentMax(fixture({ ...base, sessionLimits: { childSessionsPerParentMax: 6 } }), "/proj"),
    ).toBe(6);
  });

  it("an explicit GLOBAL role cap lowers the session cap", () => {
    const path = fixture({ ...base, roles: { maxParallelChildren: 2 } });
    expect(readChildSessionsPerParentMax(path, "/proj")).toBe(2);
  });

  it("an explicit role cap never enlarges the session cap", () => {
    const path = fixture({
      ...base,
      sessionLimits: { childSessionsPerParentMax: 3 },
      roles: { maxParallelChildren: 8 },
    });
    expect(readChildSessionsPerParentMax(path, "/proj")).toBe(3);
  });

  it("uses the PROJECT's selected profile, not the active one, for a known project", () => {
    const path = fixture({
      ...base,
      sessionLimits: { childSessionsPerParentMax: 6 },
      roleProfiles: {
        activeId: "wide",
        profiles: [
          { id: "wide", name: "Wide", roles: {} },
          { id: "narrow", name: "Narrow", roles: { maxParallelChildren: 2 } },
        ],
        projects: [{ projectRoot: "/proj", profileId: "narrow" }],
      },
    });
    expect(readChildSessionsPerParentMax(path, "/proj")).toBe(2);
    // Unlisted project => the active profile (no explicit cap) => session limit.
    expect(readChildSessionsPerParentMax(path, "/elsewhere")).toBe(6);
  });

  it("agrees with main's own inputs (same resolver, same two values)", () => {
    const raw = {
      ...base,
      sessionLimits: { childSessionsPerParentMax: 5 },
      roles: { maxParallelChildren: 2 },
    };
    const parsed = parseSettings(raw);
    expect(parsed.status).toBe("ok");
    const expected = resolveChildSessionsPerParentMax(
      parsed.settings.sessionLimits,
      resolveProfileRoles(parsed.settings, "/proj")?.maxParallelChildren,
    );
    expect(readChildSessionsPerParentMax(fixture(raw), "/proj")).toBe(expected);
    expect(expected).toBe(2);
  });
});

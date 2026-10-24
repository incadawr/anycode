/**
 * Role-route notice text (Taskana 4729). The strings are model-visible and
 * the N3 runner notice must stay byte-identical, so the exact shapes are pinned.
 */

import { describe, expect, it } from "vitest";
import {
  buildRoleRouteRequestFields,
  formatRoleDegradeNotice,
  formatRoleFallbackNotice,
} from "./role-route.js";
import type { RoleRouteResolution } from "./role-route.js";

// Taskana 4735: the route->request stamping shared by the Agent tool's session
// tier and the workflow engine's engine-role steps. The field set and the
// caller-precedence guards are pinned here; agent-session.test.ts pins the
// Agent tool's end-to-end request.
describe("buildRoleRouteRequestFields", () => {
  const route: RoleRouteResolution = {
    entries: [
      { provider: "conn-glm", model: "glm-5.3", effort: "high" },
      { engine: "codex", model: "gpt-5.4" },
    ],
    skipped: [],
    turnBudget: 80,
  };

  it("stamps the first entry's routing fields, the turn budget and routeStamped when the caller chose nothing", () => {
    expect(buildRoleRouteRequestFields(route, { degraded: false })).toEqual({
      provider: "conn-glm",
      model: "glm-5.3",
      effort: "high",
      maxTurns: 80,
      routeStamped: true,
    });
  });

  it("stamps connectionId and engine from an entry that carries them", () => {
    const pinned: RoleRouteResolution = {
      entries: [{ connection: "acct-1", model: "m" }, { engine: "claude", model: "opus" }],
      skipped: [],
    };
    expect(buildRoleRouteRequestFields(pinned, { degraded: false })).toEqual({
      connectionId: "acct-1",
      model: "m",
      routeStamped: true,
    });
    const engine: RoleRouteResolution = { entries: [{ engine: "codex", model: "gpt-5.4" }], skipped: [] };
    expect(buildRoleRouteRequestFields(engine, { degraded: false })).toEqual({
      engine: "codex",
      model: "gpt-5.4",
      routeStamped: true,
    });
  });

  it("an explicit caller provider drops provider/connectionId/engine/routeStamped but keeps the entry's model, effort and budget", () => {
    expect(buildRoleRouteRequestFields(route, { provider: "caller-conn", degraded: false })).toEqual({
      model: "glm-5.3",
      effort: "high",
      maxTurns: 80,
    });
  });

  it("an explicit caller model beats the entry's model and effort but keeps the provider-side fields and budget", () => {
    const pinned: RoleRouteResolution = {
      entries: [{ connection: "acct-1", model: "glm-5.3", effort: "high" }],
      skipped: [],
      turnBudget: 80,
    };
    expect(buildRoleRouteRequestFields(pinned, { model: "caller-m", degraded: false })).toEqual({
      connectionId: "acct-1",
      maxTurns: 80,
    });
  });

  it("an engine profile's own turn budget wins over the route's turn budget", () => {
    expect(buildRoleRouteRequestFields(route, { engineTurnBudget: 30, degraded: false })).toEqual({
      provider: "conn-glm",
      model: "glm-5.3",
      effort: "high",
      routeStamped: true,
    });
  });

  it("an exhausted chain stamps nothing but the turn budget, and only when degraded", () => {
    const exhausted: RoleRouteResolution = {
      entries: [],
      skipped: [{ entry: { model: "m" }, reason: "cooling" }],
      turnBudget: 60,
    };
    expect(buildRoleRouteRequestFields(exhausted, { degraded: true })).toEqual({ maxTurns: 60 });
    expect(buildRoleRouteRequestFields(exhausted, { degraded: false })).toEqual({});
  });

  it("returns no fields for an absent route", () => {
    expect(buildRoleRouteRequestFields(undefined, { degraded: false })).toEqual({});
  });
});

describe("formatRoleDegradeNotice", () => {
  it("lists every skip reason, joined by '; '", () => {
    expect(
      formatRoleDegradeNotice("executor", [
        { entry: { model: "m1" }, reason: "r1" },
        { entry: { model: "m2" }, reason: "r2" },
      ]),
    ).toBe(`Agent: role "executor" ran on the parent's model (every route entry is unhealthy: r1; r2)`);
  });

  it("omits the colon suffix when there are no reasons", () => {
    expect(formatRoleDegradeNotice("planner", [])).toBe(
      `Agent: role "planner" ran on the parent's model (every route entry is unhealthy)`,
    );
  });
});

describe("formatRoleFallbackNotice", () => {
  it("names the skip reasons and the healthy entry that ran instead", () => {
    expect(formatRoleFallbackNotice("reviewer", [{ entry: { engine: "claude" }, reason: "cooling down" }])).toBe(
      'Agent: role "reviewer" skipped its primary route entry (cooling down); running on the next healthy entry',
    );
  });

  it("omits the parenthetical when there are no reasons", () => {
    expect(formatRoleFallbackNotice("reviewer", [])).toBe(
      'Agent: role "reviewer" skipped its primary route entry; running on the next healthy entry',
    );
  });
});

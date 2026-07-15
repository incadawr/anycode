/**
 * Pure-logic tests for ConnectionDrawer's exported helper (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts/ConnectionTile.test.ts: this package's vitest config
 * runs in `environment: "node"` with no jsdom, so the actual add/edit form
 * behavior is proven live by `provider-connections-ui-smoke.mjs` instead.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection, SettingsMutationResult } from "../../../shared/settings.js";
import { buildConnectionUpdatePayload, resolveCreatedConnectionId, resolveDrawerOAuthStartArgs } from "./ConnectionDrawer.js";

function conn(id: string, providerId = "z-ai"): ProviderConnection {
  return { id, providerId };
}

function okResult(connections: ProviderConnection[], createdConnectionId?: string): SettingsMutationResult {
  return {
    ok: true,
    snapshot: {
      settings: {
        version: 2,
        provider: { connections },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      secrets: [],
      providerReady: false,
      envOverrides: [],
      readOnly: false,
    },
    ...(createdConnectionId !== undefined ? { createdConnectionId } : {}),
  };
}

describe("resolveCreatedConnectionId (TASK.45 W12-FIX2 §1: authoritative created-id, codex W12-FIX review #1)", () => {
  // §1.2 — authoritative-vs-diff discriminant: the snapshot carries TWO ids the
  // drawer never saw before (B then C, in that array order), and the result
  // names C authoritatively. The now-removed diff-heuristic (`after.find` of
  // the first unseen entry) would have picked B — reverting to it turns this
  // red.
  it("§1.2 resolves the field's own value even when the snapshot carries a different, earlier-ordered unseen id", () => {
    const result = okResult([conn("conn-a"), conn("conn-b"), conn("conn-c")], "conn-c");
    expect(resolveCreatedConnectionId(result)).toBe("conn-c");
  });

  // §1.3 — fail-closed: no field on the ok-result -> undefined, never guessed
  // from the snapshot.
  it("§1.3 undefined when the ok-result carries no createdConnectionId (fail-closed, no guessing)", () => {
    const result = okResult([conn("conn-a"), conn("conn-b")]);
    expect(resolveCreatedConnectionId(result)).toBeUndefined();
  });

  it("undefined on a refusal", () => {
    expect(resolveCreatedConnectionId({ ok: false, reason: "invalid" })).toBeUndefined();
  });
});

describe("resolveDrawerOAuthStartArgs (TASK.45 W12-FIX §1: connection-scoped oauth sign-in, codex W12 review #1)", () => {
  // §1.5 — reverting the ConnectionDrawer.tsx call site back to
  // `oauthStart(selectedEntry.id)` (dropping createdConnectionId) turns this
  // red: the args must carry the connection this drawer is editing, not a
  // provider-wide bucket resolution done main-side.
  it("§1.5 resolves {providerId, connectionId} when both a selected entry and a created connection exist", () => {
    expect(resolveDrawerOAuthStartArgs("acme", "conn-5")).toEqual({ providerId: "acme", connectionId: "conn-5" });
  });

  it("undefined when no catalog entry is selected, or no connection has been minted yet (regress)", () => {
    expect(resolveDrawerOAuthStartArgs(undefined, "conn-5")).toBeUndefined();
    expect(resolveDrawerOAuthStartArgs("acme", null)).toBeUndefined();
  });
});

describe('buildConnectionUpdatePayload (TASK.45 W12-FIX §3: ""-sentinel clears transport, codex W12 review #3)', () => {
  // §3.3 — reverting saveMetadata's payload back to the old
  // `...(transport ? {transport} : {})` conditional spread turns this red:
  // choosing "(provider default)" (local state `""`) must SEND
  // `transport: ""`, not omit the field (which would leave an existing
  // explicit choice on the connection untouched).
  it('§3.3 sends transport:"" when the drawer state holds the (provider default) sentinel', () => {
    const payload = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "Prod",
      model: "glm-4.6",
      transport: "",
      baseUrl: "",
      showBaseUrl: false,
    });
    expect(payload).toEqual({ id: "conn-1", label: "Prod", model: "glm-4.6", transport: "", baseUrl: "" });
  });

  it("sends the explicit transport value when one is selected (regress)", () => {
    const payload = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "openai-responses",
      baseUrl: "",
      showBaseUrl: false,
    });
    expect(payload.transport).toBe("openai-responses");
  });

  it("baseUrl is sent only when the field is shown (regress, unaffected by §3)", () => {
    const shown = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "",
      baseUrl: "https://x",
      showBaseUrl: true,
    });
    expect(shown.baseUrl).toBe("https://x");
    const hidden = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "",
      baseUrl: "https://x",
      showBaseUrl: false,
    });
    expect(hidden.baseUrl).toBe("");
  });
});

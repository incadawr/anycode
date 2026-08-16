/**
 * Pure-logic tests for ConnectionDrawer's exported helper (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts/ConnectionTile.test.ts: this package's vitest config
 * runs in `environment: "node"` with no jsdom, so the actual add/edit form
 * behavior is proven live by `provider-connections-ui-smoke.mjs` instead.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSummaryEntry, ProviderConnection, SettingsMutationResult } from "../../../shared/settings.js";
import {
  buildConnectionUpdatePayload,
  connectionCreateProxyField,
  liveModelSuggestions,
  modelAfterCatalogPrefill,
  modelSaveBlocked,
  providerSelectDisplayValue,
  proxyUrlSaveBlocked,
  resolveCreatedConnectionId,
  resolveCreatedCustomProviderId,
  resolveDrawerOAuthStartArgs,
  transportAfterNoAuthToggle,
} from "./ConnectionDrawer.js";

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

describe("resolveCreatedCustomProviderId (TASK.58: the record customProvider.create just minted)", () => {
  it("resolves the single id present after that was not present before", () => {
    const before = ["custom:a", "custom:b"];
    const after = [{ id: "custom:a" }, { id: "custom:b" }, { id: "custom:c" }];
    expect(resolveCreatedCustomProviderId(before, after)).toBe("custom:c");
  });

  it("resolves the new id even when it is not last in the returned list", () => {
    expect(resolveCreatedCustomProviderId(["custom:b"], [{ id: "custom:new" }, { id: "custom:b" }])).toBe("custom:new");
  });

  // Fail-closed: a concurrent add in another window could surface TWO unseen
  // ids — refuse to guess rather than point the connection at the wrong record.
  it("undefined when zero or more than one id is new (fail-closed, no guessing)", () => {
    expect(resolveCreatedCustomProviderId(["custom:a"], [{ id: "custom:a" }])).toBeUndefined();
    expect(resolveCreatedCustomProviderId([], [{ id: "custom:a" }, { id: "custom:b" }])).toBeUndefined();
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
      proxyUrl: "",
      authOptional: false,
    });
    expect(payload).toEqual({
      id: "conn-1",
      label: "Prod",
      model: "glm-4.6",
      transport: "",
      baseUrl: "",
      proxyUrl: "",
      authOptional: false,
    });
  });

  it("sends the explicit transport value when one is selected (regress)", () => {
    const payload = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "openai-responses",
      baseUrl: "",
      showBaseUrl: false,
      proxyUrl: "",
      authOptional: false,
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
      proxyUrl: "",
      authOptional: false,
    });
    expect(shown.baseUrl).toBe("https://x");
    const hidden = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "",
      baseUrl: "https://x",
      showBaseUrl: false,
      proxyUrl: "",
      authOptional: false,
    });
    expect(hidden.baseUrl).toBe("");
  });

  // authOptional mirrors transport's unconditional-send discipline: unchecking
  // the "no API key" box must CLEAR a persisted flag, so `false` is sent, not
  // omitted. Reverting to a `...(authOptional ? {...} : {})` spread turns the
  // second assertion red.
  it("sends authOptional unconditionally — true to set, false to clear", () => {
    const base = {
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "" as const,
      baseUrl: "",
      showBaseUrl: false,
      proxyUrl: "",
    };
    expect(buildConnectionUpdatePayload({ ...base, authOptional: true }).authOptional).toBe(true);
    expect(buildConnectionUpdatePayload({ ...base, authOptional: false }).authOptional).toBe(false);
  });
});

describe("buildConnectionUpdatePayload — proxyUrl (TASK.132)", () => {
  const base = {
    connectionId: "conn-1",
    label: "",
    model: "",
    transport: "" as const,
    baseUrl: "",
    showBaseUrl: false,
    authOptional: false,
  };

  it("sends the trimmed proxy value when one is typed", () => {
    expect(buildConnectionUpdatePayload({ ...base, proxyUrl: "  http://proxy.example.com:3128  " }).proxyUrl).toBe(
      "http://proxy.example.com:3128",
    );
  });

  it("preserves user:pass@ userinfo verbatim (the authenticated-proxy case)", () => {
    expect(buildConnectionUpdatePayload({ ...base, proxyUrl: "http://user:pass@proxy.example.com:3128" }).proxyUrl).toBe(
      "http://user:pass@proxy.example.com:3128",
    );
  });

  // Same unconditional-send discipline as transport/authOptional: emptying the
  // field must CLEAR the persisted proxy, and `""` is the channel's clear
  // sentinel. A `...(proxyUrl ? {proxyUrl} : {})` spread turns this red — the
  // old proxy would silently stay in force.
  it('sends proxyUrl:"" when the field is cleared, never omits it', () => {
    const payload = buildConnectionUpdatePayload({ ...base, proxyUrl: "" });
    expect(payload.proxyUrl).toBe("");
    expect("proxyUrl" in payload).toBe(true);
    // A whitespace-only field is a cleared field, not a proxy named "   ".
    expect(buildConnectionUpdatePayload({ ...base, proxyUrl: "   " }).proxyUrl).toBe("");
  });
});

// Covers the RULE both create paths share. It cannot catch a caller that stops
// spreading it (no jsdom in this package, so the component bodies are not
// exercised) — which is exactly how the new-custom-endpoint path first shipped
// with the field dropped; the shared fragment is what makes that reviewable.
describe("connectionCreateProxyField (TASK.132: one fragment for both create paths)", () => {
  it("sends the trimmed proxy when one is typed", () => {
    expect(connectionCreateProxyField("  http://proxy.example.com:3128 ")).toEqual({
      proxyUrl: "http://proxy.example.com:3128",
    });
  });

  it('omits the key entirely when blank — create has no "" clear sentinel and its schema refuses one', () => {
    expect(connectionCreateProxyField("")).toEqual({});
    expect(connectionCreateProxyField("   ")).toEqual({});
    expect("proxyUrl" in connectionCreateProxyField("")).toBe(false);
  });
});

describe("proxyUrlSaveBlocked (TASK.132: a scheme-less proxy must not fail as a generic save error)", () => {
  it("blocks a value main's payload schema would refuse", () => {
    // The realistic mistake: host:port copied out of a corporate wiki page.
    expect(proxyUrlSaveBlocked("proxy.example.com:3128")).toBe(true);
    expect(proxyUrlSaveBlocked("socks5://proxy.example.com:1080")).toBe(true);
    expect(proxyUrlSaveBlocked("nonsense")).toBe(true);
  });

  it("passes what main accepts, userinfo included", () => {
    expect(proxyUrlSaveBlocked("http://proxy.example.com:3128")).toBe(false);
    expect(proxyUrlSaveBlocked("https://proxy.example.com")).toBe(false);
    expect(proxyUrlSaveBlocked("http://user:pass@proxy.example.com:3128")).toBe(false);
  });

  it("never blocks a blank field — empty IS the clear sentinel", () => {
    expect(proxyUrlSaveBlocked("")).toBe(false);
    expect(proxyUrlSaveBlocked("   ")).toBe(false);
  });

  it("judges the trimmed value, matching what buildConnectionUpdatePayload sends", () => {
    expect(proxyUrlSaveBlocked("  http://proxy.example.com:3128  ")).toBe(false);
  });
});

describe("transportAfterNoAuthToggle (dogfood 16.07: keyless checkbox must escape the anthropic default)", () => {
  // The trap this closes: custom's default transport is anthropic-messages,
  // where core is fail-closed on a missing key — a keyless connection left on
  // "(provider default)" stays not-ready forever with no visible reason.
  it("checking the box with '(provider default)' selected auto-picks openai-chat-completions", () => {
    expect(transportAfterNoAuthToggle(true, "")).toBe("openai-chat-completions");
  });

  it("never overrides an explicit transport choice, either family", () => {
    expect(transportAfterNoAuthToggle(true, "openai-responses")).toBe("openai-responses");
    expect(transportAfterNoAuthToggle(true, "anthropic-messages")).toBe("anthropic-messages");
  });

  it("unchecking leaves the transport untouched", () => {
    expect(transportAfterNoAuthToggle(false, "")).toBe("");
    expect(transportAfterNoAuthToggle(false, "openai-chat-completions")).toBe("openai-chat-completions");
  });
});

describe("providerSelectDisplayValue (dogfood 16.07: add-mode must show the placeholder, not a phantom custom)", () => {
  const CATALOG: CatalogSummaryEntry[] = [
    { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
    { id: "custom", name: "Custom endpoint", authKind: "api_key", models: [], needsBaseUrl: true, isCustom: true },
  ];

  // The bug: add mode (`templateLocked: false`, nothing picked) rendered the
  // catalog's `custom` sentinel as selected while `providerId` stayed `""` —
  // the form looked complete but Create was silently disabled. Reverting the
  // fix (unconditional `|| custom.id` fallback) turns this red.
  it("add mode with no selection displays the empty placeholder value", () => {
    expect(providerSelectDisplayValue("", false, CATALOG)).toBe("");
  });

  it("a real selection passes through in both modes", () => {
    expect(providerSelectDisplayValue("z-ai", false, CATALOG)).toBe("z-ai");
    expect(providerSelectDisplayValue("z-ai", true, CATALOG)).toBe("z-ai");
  });

  it("edit mode keeps the cosmetic custom fallback for a bare pre-W12 connection", () => {
    expect(providerSelectDisplayValue("", true, CATALOG)).toBe("custom");
  });

  it("edit-mode fallback fails soft to empty when the catalog carries no custom sentinel", () => {
    expect(providerSelectDisplayValue("", true, [CATALOG[0]!])).toBe("");
  });
});

describe("liveModelSuggestions (live-over-static, mirrors providerModelsFor's precedence)", () => {
  const HINTS = [
    { id: "k3", name: "K3" },
    { id: "kimi-for-coding", name: "K2.7 Coding" },
  ];

  it("static hints alone before any fetch (byte-identical pre-fetch behavior)", () => {
    expect(liveModelSuggestions(null, undefined, HINTS)).toEqual(HINTS);
    expect(liveModelSuggestions(null, [], HINTS)).toEqual(HINTS);
  });

  it("this session's fetch result wins, decorated with matching static names", () => {
    expect(liveModelSuggestions([{ id: "k3" }, { id: "k4-new" }], ["stale-persisted"], HINTS)).toEqual([
      { id: "k3", name: "K3" },
      { id: "k4-new" },
    ]);
  });

  it("falls back to the ids persisted on the connection when nothing was fetched this session", () => {
    expect(liveModelSuggestions(null, ["kimi-for-coding", "extra"], HINTS)).toEqual([
      { id: "kimi-for-coding", name: "K2.7 Coding" },
      { id: "extra" },
    ]);
  });

  it("an EMPTY fetch result yields an empty list (the endpoint's answer is authoritative once given)", () => {
    expect(liveModelSuggestions([], ["persisted"], HINTS)).toEqual([]);
  });
});

describe("modelAfterCatalogPrefill (TASK.108-A: default model instead of a silent empty save)", () => {
  const suggestions = [{ id: "glm-5.2" }, { id: "glm-5.1" }];

  it("keeps an explicitly chosen model untouched", () => {
    expect(modelAfterCatalogPrefill("glm-5.1", suggestions)).toBe("glm-5.1");
  });

  // The live trap (owner repro 08.08): a catalog connection saved with "" —
  // the drawer must offer the curated default, not leave the field blank.
  it("prefills the first suggestion when the model is blank", () => {
    expect(modelAfterCatalogPrefill("", suggestions)).toBe("glm-5.2");
    expect(modelAfterCatalogPrefill("   ", suggestions)).toBe("glm-5.2");
  });

  it("stays blank when there are no suggestions to offer (arbitrary-model endpoints)", () => {
    expect(modelAfterCatalogPrefill("", [])).toBe("");
  });
});

describe("modelSaveBlocked (TASK.108-A: a catalog connection cannot save an empty model)", () => {
  const suggestions = [{ id: "glm-5.2" }];

  it("blocks a blank model on a catalog connection with known models", () => {
    expect(modelSaveBlocked("", true, suggestions)).toBe(true);
    expect(modelSaveBlocked("   ", true, suggestions)).toBe(true);
  });

  it("passes once a model is picked", () => {
    expect(modelSaveBlocked("glm-5.2", true, suggestions)).toBe(false);
  });

  it("never blocks custom-record connections (arbitrary model stays legal)", () => {
    expect(modelSaveBlocked("", false, suggestions)).toBe(false);
  });

  it("never blocks a provider that offers no model list", () => {
    expect(modelSaveBlocked("", true, [])).toBe(false);
  });
});

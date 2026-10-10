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
  MAX_OUTPUT_TOKEN_PRESETS,
  buildConnectionUpdatePayload,
  liveModelSuggestions,
  maxOutputPresetSelection,
  maxOutputTokensField,
  modelAfterCatalogPrefill,
  modelSaveBlocked,
  providerSelectDisplayValue,
  resolveCreatedConnectionId,
  resolveCreatedCustomProviderId,
  resolveDrawerOAuthStartArgs,
  transportAfterNoAuthToggle,
  maxOutputTokensEnvHint,
  maxOutputTokensEffectiveHint,
  contextWindowTokensField,
  contextWindowTokensEnvHint,
  contextWindowEffectiveHint,
  contextWindowInitialRaw,
  contextWindowInitialField,
  contextWindowAfterModelInput,
  contextWindowAfterRawInput,
} from "./ConnectionDrawer.js";
import { readFileSync } from "node:fs";

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
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "",
      contextWindowTokens: "",
    });
    expect(payload).toEqual({
      id: "conn-1",
      label: "Prod",
      model: "glm-4.6",
      transport: "",
      baseUrl: "",
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "",
      contextWindowTokens: "",
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
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "",
      contextWindowTokens: "",
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
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "",
      contextWindowTokens: "",
    });
    expect(shown.baseUrl).toBe("https://x");
    const hidden = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "",
      transport: "",
      baseUrl: "https://x",
      showBaseUrl: false,
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "",
      contextWindowTokens: "",
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
      proxyRef: "",
      maxOutputTokens: "" as const,
      contextWindowTokens: "" as const,
    };
    expect(buildConnectionUpdatePayload({ ...base, authOptional: true }).authOptional).toBe(true);
    expect(buildConnectionUpdatePayload({ ...base, authOptional: false }).authOptional).toBe(false);
  });
});

describe("buildConnectionUpdatePayload — proxyRef (TASK.141, replacing TASK.132's proxyUrl)", () => {
  const base = {
    connectionId: "conn-1",
    label: "",
    model: "",
    transport: "" as const,
    baseUrl: "",
    showBaseUrl: false,
    authOptional: false,
    maxOutputTokens: "" as const,
    contextWindowTokens: "" as const,
  };

  it("sends the picked profile id", () => {
    expect(buildConnectionUpdatePayload({ ...base, proxyRef: "proxy-7" }).proxyRef).toBe("proxy-7");
  });

  it('sends the "direct" sentinel when the picker says "No proxy"', () => {
    expect(buildConnectionUpdatePayload({ ...base, proxyRef: "direct" }).proxyRef).toBe("direct");
  });

  // The wire-only import action (design review B-05): leaving the synthetic
  // "Legacy: …" entry selected and saving is the ONE thing that converts this
  // connection's pre-registry `proxyUrl` string into a real profile.
  it('carries the wire-only "legacy" ref through untouched', () => {
    expect(buildConnectionUpdatePayload({ ...base, proxyRef: "legacy" }).proxyRef).toBe("legacy");
  });

  // Same unconditional-send discipline as transport/authOptional: choosing
  // "Use application proxy" must CLEAR the persisted ref, and `""` is the
  // channel's clear sentinel. A `...(proxyRef ? {proxyRef} : {})` spread turns
  // this red — the old choice would silently stay in force.
  it('sends proxyRef:"" when the picker is back on inherit, never omits it', () => {
    const payload = buildConnectionUpdatePayload({ ...base, proxyRef: "" });
    expect(payload.proxyRef).toBe("");
    expect("proxyRef" in payload).toBe(true);
  });

  // TASK.141: the legacy key is NOT sent by this payload at all. Absent means
  // "keep", which is what lets an untouched legacy `proxyUrl` survive a save of
  // an unrelated field — main erases it only when the ref itself is cleared.
  it("never sends the legacy proxyUrl key", () => {
    expect("proxyUrl" in buildConnectionUpdatePayload({ ...base, proxyRef: "proxy-7" })).toBe(false);
    expect("proxyUrl" in buildConnectionUpdatePayload({ ...base, proxyRef: "" })).toBe(false);
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

describe("maxOutputPresetSelection (TASK.150 slice 3: owner asked for presets so the round numbers need not be recalled)", () => {
  it("reads a blank field as the Default chip, not as 'nothing selected'", () => {
    expect(maxOutputPresetSelection("")).toBe("default");
    expect(maxOutputPresetSelection("   ")).toBe("default");
  });

  it("lights the chip whose number the field holds exactly", () => {
    expect(maxOutputPresetSelection("8192")).toBe("8192");
    expect(maxOutputPresetSelection("16384")).toBe("16384");
    expect(maxOutputPresetSelection("32768")).toBe("32768");
    expect(maxOutputPresetSelection(" 32768 ")).toBe("32768");
  });

  it("falls to Custom for a valid value no chip offers", () => {
    expect(maxOutputPresetSelection("50000")).toBe("custom");
    expect(maxOutputPresetSelection("1024")).toBe("custom");
  });

  it("falls to Custom mid-typing and for malformed input, never lighting a chip the field does not hold", () => {
    expect(maxOutputPresetSelection("5")).toBe("custom");
    expect(maxOutputPresetSelection("819")).toBe("custom");
    expect(maxOutputPresetSelection("abc")).toBe("custom");
    // Numerically 8192, but not what the chip writes — matching loosely here
    // would claim the row produced a value the user typed by hand.
    expect(maxOutputPresetSelection("08192")).toBe("custom");
    expect(maxOutputPresetSelection("8192.0")).toBe("custom");
  });

  it("offers only values the field itself accepts, so no chip can write a value Save then refuses", () => {
    for (const preset of MAX_OUTPUT_TOKEN_PRESETS) {
      expect(maxOutputTokensField(preset.value).ok).toBe(true);
      expect(maxOutputPresetSelection(preset.value)).toBe(preset.id);
    }
  });

  it("keeps Default distinct from pinning the current default value", () => {
    const blank = MAX_OUTPUT_TOKEN_PRESETS.find((p) => p.id === "default");
    expect(blank?.value).toBe("");
    // Both mean 32768 today; only the blank one keeps following the default.
    expect(maxOutputTokensField("")).toEqual({ ok: true, value: "" });
    expect(maxOutputTokensField("32768")).toEqual({ ok: true, value: 32768 });
  });
});

describe("maxOutputTokensField (TASK.150: on-prem/custom endpoints get no catalog model list to guess a cap from)", () => {
  it("blank (or whitespace-only) is the clear sentinel, not invalid", () => {
    expect(maxOutputTokensField("")).toEqual({ ok: true, value: "" });
    expect(maxOutputTokensField("   ")).toEqual({ ok: true, value: "" });
  });

  it("accepts the inclusive range boundaries", () => {
    expect(maxOutputTokensField("1024")).toEqual({ ok: true, value: 1024 });
    expect(maxOutputTokensField("1000000")).toEqual({ ok: true, value: 1000000 });
  });

  it("accepts a mid-range whole number", () => {
    expect(maxOutputTokensField("65536")).toEqual({ ok: true, value: 65536 });
  });

  it("rejects one below the floor and one above the ceiling", () => {
    expect(maxOutputTokensField("1023")).toEqual({ ok: false });
    expect(maxOutputTokensField("1000001")).toEqual({ ok: false });
  });

  it("rejects a fractional value", () => {
    expect(maxOutputTokensField("12.5")).toEqual({ ok: false });
  });

  it("rejects non-numeric input", () => {
    expect(maxOutputTokensField("abc")).toEqual({ ok: false });
  });

  it("rejects a negative value", () => {
    expect(maxOutputTokensField("-1")).toEqual({ ok: false });
  });
});



describe("buildConnectionUpdatePayload — maxOutputTokens (TASK.150, same unconditional-send discipline as transport/proxyRef)", () => {
  const base = {
    connectionId: "conn-1",
    label: "",
    model: "",
    transport: "" as const,
    baseUrl: "",
    showBaseUrl: false,
    proxyRef: "",
    authOptional: false,
    contextWindowTokens: "" as const,
  };

  it("a chosen number lands in the payload", () => {
    expect(buildConnectionUpdatePayload({ ...base, maxOutputTokens: 65536 }).maxOutputTokens).toBe(65536);
  });

  // The clear sentinel: `""` must be SENT (not omitted) so main clears a
  // previously-persisted cap back to the catalog/provider default — mirrors
  // the `proxyRef:""` unconditional-send assertion above.
  it('sends maxOutputTokens:"" as the clear sentinel, never omits it', () => {
    const payload = buildConnectionUpdatePayload({ ...base, maxOutputTokens: "" });
    expect(payload.maxOutputTokens).toBe("");
    expect("maxOutputTokens" in payload).toBe(true);
  });
});

describe("maxOutputTokensEnvHint (TASK.159: the env rung silences this field)", () => {
  it("names the variable and says the field is overridden while it is live", () => {
    expect(maxOutputTokensEnvHint(["ANYCODE_MAX_OUTPUT_TOKENS"])).toBe(
      "ANYCODE_MAX_OUTPUT_TOKENS is set in the environment — it overrides this field for every new session.",
    );
  });

  it("null when the variable is absent, alone among others, or the list is empty", () => {
    expect(maxOutputTokensEnvHint([])).toBeNull();
    expect(maxOutputTokensEnvHint(["ANYCODE_API_KEY", "ANYCODE_MODEL"])).toBeNull();
  });

  // Same fixture style as SettingsScreen.test.ts's isEnvOverridden block.
  it("fires on the exact name only, not a prefix", () => {
    expect(maxOutputTokensEnvHint(["ANYCODE_MAX_OUTPUT_TOKENS_X"])).toBeNull();
  });
});

describe("maxOutputTokensEffectiveHint (TASK.159: name the number a blank field resolves to)", () => {
  const GLM: CatalogSummaryEntry = {
    id: "z-ai",
    name: "Z.AI",
    authKind: "api_key",
    models: [
      { id: "glm-5.3", name: "GLM-5.3", maxOutputTokens: 131_072 },
      { id: "glm-4.6", name: "GLM-4.6" },
    ],
  };
  const CLAUDE: CatalogSummaryEntry = {
    id: "anthropic",
    name: "Anthropic",
    authKind: "api_key",
    models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
  };

  it("a catalog model with a declared ceiling answers catalog: N", () => {
    expect(maxOutputTokensEffectiveHint(GLM, "glm-5.3", 32_768, "")).toBe("catalog: 131072");
  });

  it("a catalog model WITHOUT a ceiling answers provider default: N from the snapshot projection", () => {
    expect(maxOutputTokensEffectiveHint(GLM, "glm-4.6", 32_768, "")).toBe("provider default: 32768");
  });

  it("an unknown model id (no entry / no match) also answers provider default: N", () => {
    expect(maxOutputTokensEffectiveHint(undefined, "qwen3-selfhosted", 32_768, "")).toBe("provider default: 32768");
    expect(maxOutputTokensEffectiveHint(GLM, "not-in-catalog", 32_768, "")).toBe("provider default: 32768");
  });

  // Core sends claude-* no cap when nothing is set — the drawer keeps showing
  // no number for them rather than inventing one.
  it("claude-* without a catalog ceiling shows no number, as today", () => {
    expect(maxOutputTokensEffectiveHint(CLAUDE, "claude-sonnet-5", 32_768, "")).toBeNull();
    expect(maxOutputTokensEffectiveHint(undefined, "claude-3-haiku", 32_768, "")).toBeNull();
  });

  it("a non-blank field suppresses the hint (the field itself already shows what wins)", () => {
    expect(maxOutputTokensEffectiveHint(GLM, "glm-5.3", 32_768, "65536")).toBeNull();
    expect(maxOutputTokensEffectiveHint(GLM, "glm-5.3", 32_768, "   ")).toBe("catalog: 131072");
  });

  it("an older snapshot without defaultMaxOutputTokens degrades to no number, never an invented figure", () => {
    expect(maxOutputTokensEffectiveHint(GLM, "glm-4.6", undefined, "")).toBeNull();
    expect(maxOutputTokensEffectiveHint(undefined, "qwen3-selfhosted", undefined, "")).toBeNull();
  });
});

describe("contextWindowTokensField (TASK.142: per-model context window, same range discipline as TASK.150)", () => {
  it("blank (and whitespace-only) is the CLEAR sentinel, not zero and not invalid", () => {
    expect(contextWindowTokensField("")).toEqual({ ok: true, value: "" });
    expect(contextWindowTokensField("   ")).toEqual({ ok: true, value: "" });
  });

  it("accepts the inclusive bounds and a typical value", () => {
    expect(contextWindowTokensField("1024")).toEqual({ ok: true, value: 1024 });
    expect(contextWindowTokensField("8192")).toEqual({ ok: true, value: 8192 });
    expect(contextWindowTokensField("1000000")).toEqual({ ok: true, value: 1000000 });
    expect(contextWindowTokensField("200000")).toEqual({ ok: true, value: 200_000 });
  });

  it("rejects out-of-range, fractional, negative and non-numeric input", () => {
    expect(contextWindowTokensField("1023")).toEqual({ ok: false });
    expect(contextWindowTokensField("1000001")).toEqual({ ok: false });
    expect(contextWindowTokensField("8.5")).toEqual({ ok: false });
    expect(contextWindowTokensField("12.5")).toEqual({ ok: false });
    expect(contextWindowTokensField("-1")).toEqual({ ok: false });
    expect(contextWindowTokensField("abc")).toEqual({ ok: false });
  });
});

describe("buildConnectionUpdatePayload — contextWindowTokens (TASK.142, same unconditional-send discipline as transport/proxyRef/maxOutputTokens)", () => {
  const base = {
    connectionId: "conn-1",
    label: "",
    model: "glm-4.6",
    transport: "" as const,
    baseUrl: "",
    showBaseUrl: false,
    proxyRef: "",
    authOptional: false,
    maxOutputTokens: "" as const,
  };

  it("a chosen number lands in the payload", () => {
    expect(buildConnectionUpdatePayload({ ...base, contextWindowTokens: 8192 }).contextWindowTokens).toBe(8192);
  });

  // Clearing the field back to blank must CLEAR the persisted pair, so `""` is
  // SENT (not omitted) — a `...(contextWindowTokens ? {...} : {})` spread would
  // leave the old explicit window in force and turn this red.
  it('sends contextWindowTokens:"" as the clear sentinel, never omits it', () => {
    const payload = buildConnectionUpdatePayload({ ...base, contextWindowTokens: "" });
    expect(payload.contextWindowTokens).toBe("");
    expect("contextWindowTokens" in payload).toBe(true);
  });

  // The binding is derived SERVER-SIDE from the effective model; the renderer
  // must never name a model in the payload, or it could attach a window to the
  // wrong one.
  it("never carries a contextWindowModel — the binding is main's to derive", () => {
    const payload = buildConnectionUpdatePayload({ ...base, contextWindowTokens: 8192 });
    expect("contextWindowModel" in payload).toBe(false);
  });
});

describe("contextWindowTokensEnvHint (TASK.142: the env rung silences this field)", () => {
  it("names the variable when it is live", () => {
    expect(contextWindowTokensEnvHint(["ANYCODE_CONTEXT_WINDOW"])).toBe(
      "ANYCODE_CONTEXT_WINDOW is set in the environment — it overrides this field for every new session.",
    );
  });

  it("stays silent when it is not", () => {
    expect(contextWindowTokensEnvHint([])).toBeNull();
    expect(contextWindowTokensEnvHint(["ANYCODE_API_KEY", "ANYCODE_MODEL"])).toBeNull();
  });

  it("does not match a longer variable name that merely starts the same", () => {
    expect(contextWindowTokensEnvHint(["ANYCODE_CONTEXT_WINDOW_MODEL"])).toBeNull();
  });
});

describe("contextWindowEffectiveHint (TASK.142: name the window a blank field resolves to)", () => {
  const CATALOG: CatalogSummaryEntry = {
    id: "z-ai",
    name: "Z.AI",
    authKind: "api_key",
    models: [
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 200_000 },
      { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000, usableContextWindow: 128_000 },
    ],
  };

  it("a catalog model answers catalog: min(contextWindow, usableContextWindow)", () => {
    expect(contextWindowEffectiveHint(CATALOG, "glm-5.3", { unknownModelContextWindowTokens: 8_192 }, "")).toBe(
      "catalog: 200000",
    );
    // The usable window caps it when declared.
    expect(contextWindowEffectiveHint(CATALOG, "glm-4.6", { unknownModelContextWindowTokens: 8_192 }, "")).toBe(
      "catalog: 128000",
    );
  });

  // NOT "provider default": core does not know a server-side window for an
  // unknown model, it deliberately ASSUMES a conservative one.
  it("an unknown model answers the assumed fallback, never a provider default", () => {
    expect(contextWindowEffectiveHint(undefined, "qwen3-selfhosted", { unknownModelContextWindowTokens: 8_192 }, "")).toBe(
      "assumed fallback: 8192 (unknown model — set a value to override)",
    );
    expect(contextWindowEffectiveHint(CATALOG, "not-in-catalog", { unknownModelContextWindowTokens: 8_192 }, "")).toBe(
      "assumed fallback: 8192 (unknown model — set a value to override)",
    );
  });

  it("a non-blank field suppresses the hint (the field itself shows what wins)", () => {
    expect(contextWindowEffectiveHint(CATALOG, "glm-5.3", { unknownModelContextWindowTokens: 8_192 }, "8192")).toBeNull();
    expect(contextWindowEffectiveHint(CATALOG, "glm-5.3", { unknownModelContextWindowTokens: 8_192 }, "   ")).toBe(
      "catalog: 200000",
    );
  });

  it("an older snapshot without the projection degrades to the literal 8192, never a crash", () => {
    expect(contextWindowEffectiveHint(undefined, "qwen3-selfhosted", undefined, "")).toBe(
      "assumed fallback: 8192 (unknown model — set a value to override)",
    );
  });
});

describe("contextWindowInitialField / contextWindowAfterModelInput / contextWindowAfterRawInput (TASK.142: owner-aware reset)", () => {
  const SAVED_A = { contextWindowTokens: 8192, contextWindowModel: "model-a" };

  it("prefills the saved pair only when it binds to the connection's own model", () => {
    expect(contextWindowInitialField({ ...SAVED_A, model: "model-a" })).toEqual({ raw: "8192", model: "model-a" });
    expect(contextWindowInitialField({ ...SAVED_A, model: "model-b" })).toEqual({ raw: "", model: "model-b" });
    expect(contextWindowInitialField({ model: "model-a" })).toEqual({ raw: "", model: "model-a" });
    expect(contextWindowInitialField(undefined)).toEqual({ raw: "", model: "" });
  });

  // The reported defect: the reset compared against the ORIGINAL saved binding,
  // so a whitespace-only edit of a freshly typed window wiped it.
  it("a new connection's freshly typed window SURVIVES a whitespace-only Model edit", () => {
    const typed = contextWindowAfterRawInput({ raw: "", model: "" }, "8192", "model-b");
    expect(typed).toEqual({ raw: "8192", model: "model-b" });
    expect(contextWindowAfterModelInput(typed, "  model-b  ", undefined)).toEqual(typed);
  });

  // ...and the same after editing saved A -> B and typing B's window.
  it("after editing A -> B and typing B's window, a whitespace-only edit keeps it", () => {
    const cleared = contextWindowAfterModelInput({ raw: "8192", model: "model-a" }, "model-b", SAVED_A);
    expect(cleared).toEqual({ raw: "", model: "model-b" });
    const typed = contextWindowAfterRawInput(cleared, "8192", "model-b");
    expect(contextWindowAfterModelInput(typed, " model-b ", SAVED_A)).toEqual(typed);
  });

  // The regression this revision fixes: clearing an unchanged model's saved
  // window must NOT be undone by a normalized-no-change edit (or by re-clicking
  // the model's own chip) — otherwise save() sends the resurrected 8192 instead
  // of the user's clear sentinel.
  it("an explicit CLEAR survives a normalized-no-change Model edit (whitespace and re-selected chip)", () => {
    const cleared = contextWindowAfterRawInput({ raw: "8192", model: "model-a" }, "", "model-a");
    expect(cleared).toEqual({ raw: "", model: "model-a" });
    // " A " is the SAME normalized model -> the whole field is preserved.
    expect(contextWindowAfterModelInput(cleared, " model-a ", SAVED_A)).toEqual(cleared);
    // Re-clicking A's own chip (the model did not change) -> preserved too.
    expect(contextWindowAfterModelInput(cleared, "model-a", SAVED_A)).toEqual(cleared);
    expect(contextWindowAfterModelInput(cleared, "model-a", SAVED_A).raw).toBe("");
  });

  it("a genuine model change CLEARS a window typed for the previous model", () => {
    const typed = contextWindowAfterRawInput({ raw: "", model: "" }, "8192", "model-b");
    expect(contextWindowAfterModelInput(typed, "model-c", SAVED_A)).toEqual({ raw: "", model: "model-c" });
  });

  it("a genuine model change RE-PREFILLS when the user returns to the saved model", () => {
    const typed = contextWindowAfterRawInput({ raw: "", model: "" }, "4096", "model-b");
    // model-b -> model-a (the saved pair's model): the boot pair comes back.
    expect(contextWindowAfterModelInput(typed, "model-a", SAVED_A)).toEqual({ raw: "8192", model: "model-a" });
    // and a field for another model re-prefills on returning to the saved model too.
    expect(contextWindowAfterModelInput({ raw: "", model: "model-b" }, "model-a", SAVED_A)).toEqual({
      raw: "8192",
      model: "model-a",
    });
  });

  it("never re-prefills from a saved pair whose binding does not match the next model", () => {
    expect(contextWindowAfterModelInput({ raw: "4096", model: "model-b" }, "model-b", SAVED_A)).toEqual({
      raw: "4096",
      model: "model-b",
    });
  });

  it("a blank field stays blank across a model change, whitespace-only or real", () => {
    expect(contextWindowAfterModelInput({ raw: "", model: "" }, "model-b", undefined)).toEqual({
      raw: "",
      model: "model-b",
    });
    // A whitespace-only value is already blank: a genuine change normalizes it
    // to the empty string and still stays blank.
    expect(contextWindowAfterModelInput({ raw: "   ", model: "" }, "model-b", undefined)).toEqual({
      raw: "",
      model: "model-b",
    });
  });

  it("clearing the window text keeps the owner; typing a new one rebinds to the current model", () => {
    expect(contextWindowAfterRawInput({ raw: "8192", model: "model-a" }, "", "model-a")).toEqual({
      raw: "",
      model: "model-a",
    });
    expect(contextWindowAfterRawInput({ raw: "", model: "" }, "16384", "model-c")).toEqual({
      raw: "16384",
      model: "model-c",
    });
    // No model to own it yet: the value is kept with an empty owner.
    expect(contextWindowAfterRawInput({ raw: "", model: "" }, "16384", "   ")).toEqual({
      raw: "16384",
      model: "",
    });
  });

  // Typing a window never routes through the model handler, so consecutive
  // keystrokes must keep the value (this is the "never reset repeatedly" guard).
  it("consecutive window keystrokes keep the value (the window route never resets)", () => {
    let field = { raw: "", model: "" };
    for (const raw of ["8", "81", "819", "8192"]) {
      field = contextWindowAfterRawInput(field, raw, "model-b");
      expect(field.raw).toBe(raw);
    }
    expect(field).toEqual({ raw: "8192", model: "model-b" });
  });

  // The full user journey the reviewer reproduced, ending in the WIRE payload:
  // saved A -> clear -> no-op model edit -> save must carry the clear sentinel.
  it("clear -> same-model edit -> save carries the clear sentinel, not the resurrected value", () => {
    // Boot: the drawer prefills A's saved pair.
    const boot = contextWindowInitialField({ ...SAVED_A, model: "model-a" });
    expect(boot).toEqual({ raw: "8192", model: "model-a" });

    // The user clears the field.
    const cleared = contextWindowAfterRawInput(boot, "", "model-a");
    // ...then taps the Model input in a way that does NOT change it (adds a space).
    const afterEdit = contextWindowAfterModelInput(cleared, " model-a ", SAVED_A);
    expect(afterEdit.raw).toBe("");

    const field = contextWindowTokensField(afterEdit.raw);
    expect(field).toEqual({ ok: true, value: "" });
    const payload = buildConnectionUpdatePayload({
      connectionId: "conn-1",
      label: "",
      model: "model-a",
      transport: "" as const,
      baseUrl: "",
      showBaseUrl: false,
      proxyRef: "",
      authOptional: false,
      maxOutputTokens: "" as const,
      contextWindowTokens: field.ok ? field.value : "",
    });
    // The clear sentinel travels on the wire: main deletes BOTH saved keys.
    expect(payload.contextWindowTokens).toBe("");
  });
});

describe("ConnectionDrawer wiring (TASK.142: NO route may bypass the per-model reset)", () => {
  const source = readFileSync(new URL("./ConnectionDrawer.tsx", import.meta.url), "utf8");

  // There is no DOM harness in this package (see file docstring), so the wiring
  // itself is pinned structurally: `changeModel` is the ONLY writer of the Model
  // input, so the simplified create input, the model suggestion chips and the
  // provider select cannot bypass the per-model reset. A route that calls
  // `setModel` directly (the reported defect) makes this red.
  it("`changeModel` is the only setModel caller, and all model-changing routes use it", () => {
    const setModelCalls = source.match(/(?<![.\w])setModel\(/g) ?? [];
    // One call inside `changeModel` plus the two catalog-normalization effects.
    const effectCalls = source.match(/setModel\(\(m\) => modelAfterCatalogPrefill\(/g) ?? [];
    expect(effectCalls).toHaveLength(2);
    expect(setModelCalls).toHaveLength(1 + effectCalls.length);
  });

  it("the simplified input, the chips and the provider select all route through changeModel", () => {
    // simplified pre-create Model input
    expect(source).toMatch(
      /changeModel\(\s*e\.target\.value,\s*modelAfterCatalogPrefill\(e\.target\.value, selectedEntry\.models\),\s*undefined,\s*\)/,
    );
    // main Model input
    expect(source).toMatch(/changeModel\(e\.target\.value, e\.target\.value, targetConnection\)/);
    // model suggestion chip
    expect(source).toMatch(/onClick=\{\(\) => changeModel\(m\.id, m\.id, targetConnection\)\}/);
    // provider select
    expect(source).toMatch(/changeModel\("", "", undefined, true\)/);
  });

  it("the window input binds through the raw-input helper and never calls setModel", () => {
    expect(source).toMatch(
      /setContextWindow\(\(field\) => contextWindowAfterRawInput\(field, e\.target\.value, effectiveFormModel\)\)/,
    );
    expect(source).not.toMatch(/setContextWindowTokens/);
    // The obsolete string-only helper is gone entirely.
    expect(source).not.toMatch(/contextWindowRawAfterModelChange/);
  });
});

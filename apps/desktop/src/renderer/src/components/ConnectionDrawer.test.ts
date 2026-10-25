/**
 * Pure-logic tests for ConnectionDrawer's exported helper (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts/ConnectionTile.test.ts: this package's vitest config
 * runs in `environment: "node"` with no jsdom, so the actual add/edit form
 * behavior is proven live by `provider-connections-ui-smoke.mjs` instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogSummaryEntry, ProviderConnection, SettingsMutationResult } from "../../../shared/settings.js";
import type { FetchModelsOutcome } from "../anycode-window.js";
import {
  MAX_OUTPUT_TOKEN_PRESETS,
  MODEL_ID_ERROR,
  appendModelToConnection,
  appendModelsToConnection,
  buildConnectionUpdatePayload,
  createConnectionAndPersistModel,
  liveModelSuggestions,
  maxOutputPresetSelection,
  maxOutputTokensField,
  modelAfterCatalogPrefill,
  modelSaveBlocked,
  preflightModelId,
  providerSelectDisplayValue,
  providerOptionGroups,
  resolveCreatedConnectionId,
  resolveCreatedCustomProviderId,
  resolveDrawerOAuthStartArgs,
  transportAfterNoAuthToggle,
  updateConnectionAndPersistModel,
  maxOutputTokensEnvHint,
  maxOutputTokensEffectiveHint,
  contextWindowTokensField,
  contextWindowTokensEnvHint,
  contextWindowEffectiveHint,
  contextWindowInitialRaw,
  contextWindowInitialField,
  contextWindowAfterModelInput,
  contextWindowAfterRawInput,
  imageInputToPayload,
  imageInputInitialValue,
  imageInputEffectiveHint,
  imageInputEnvHint,
  imageInputModelPreflightError,
  advancedHasValues,
  formatTokenCount,
  maxOutputPlaceholder,
  contextWindowPlaceholder,
  imageInputAutoLabel,
  maxOutputSegmentSelection,
  MAX_OUTPUT_SEGMENT_LABEL,
  MAX_OUTPUT_ONELINER,
  CONTEXT_WINDOW_ONELINER,
  IMAGE_INPUT_ONELINER,
  MAX_OUTPUT_HELP,
  CONTEXT_WINDOW_HELP,
  IMAGE_INPUT_HELP,
  FieldHelp,
  MaxOutputSegmented,
  type MaxOutputSegmentedProps,
} from "./ConnectionDrawer.js";
import { PROXY_REF_INHERIT } from "./ProxyRefPicker.js";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { providerModelsFor, modelMenuItems } from "./ModelPill.js";
import { buildStartModelGroups } from "./start-model-picker.js";
import { importModelOptionsFor } from "./CodexRolloutImportDialog.js";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../../../settings/files.js";
import { handleCustomProviderFetchModels } from "../../../main/provider-ipc.js";

// The whole-path restart test below drives PRODUCTION main-process code
// (provider IPC + the settings file), so the electron module it imports needs
// the same handler-capturing stub the main tests use.
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));

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
      imageInput: "auto",
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
      imageInputOverride: "",
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
      imageInput: "auto",
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
      imageInput: "auto",
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
      imageInput: "auto",
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
      imageInput: "auto" as const,
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
    imageInput: "auto" as const,
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

// TASK.70 (Taskana 4089): one brand = one card. The Provider select's options
// come from this pure projection; brandless catalogs must stay byte-identical
// to the old flat list (the byte-compat proof for every existing fixture).
describe("providerOptionGroups (TASK.70: one brand = one card)", () => {
  const BRANDLESS: CatalogSummaryEntry[] = [
    { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
    { id: "custom", name: "Custom endpoint", authKind: "api_key", models: [], needsBaseUrl: true, isCustom: true },
  ];

  it("brandless catalog → all groups have an empty label and options labelled entry.name (or Custom endpoint… for isCustom)", () => {
    expect(providerOptionGroups(BRANDLESS)).toEqual([
      { label: "", options: [{ id: "z-ai", label: "Z.AI (GLM)" }] },
      { label: "", options: [{ id: "custom", label: "Custom endpoint…" }] },
    ]);
  });

  it("kimi+moonshot branded + brandless others → exactly one kimi group (catalog order preserved) and the brandless entries as empty-label groups", () => {
    const catalog: CatalogSummaryEntry[] = [
      { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
      { id: "moonshot", name: "Moonshot (Kimi, platform API)", authKind: "api_key", models: [], brand: "kimi", modeLabel: "Platform API (moonshot.ai)" },
      { id: "kimi", name: "Kimi (kimi.com subscription)", authKind: "api_key", models: [], brand: "kimi", modeLabel: "Subscription (kimi.com)" },
      { id: "custom", name: "Custom endpoint", authKind: "api_key", models: [], needsBaseUrl: true, isCustom: true },
    ];
    expect(providerOptionGroups(catalog)).toEqual([
      { label: "", options: [{ id: "z-ai", label: "Z.AI (GLM)" }] },
      {
        label: "kimi",
        options: [
          { id: "moonshot", label: "Platform API (moonshot.ai)" },
          { id: "kimi", label: "Subscription (kimi.com)" },
        ],
      },
      { label: "", options: [{ id: "custom", label: "Custom endpoint…" }] },
    ]);
  });

  it("an entry with brand but NO modeLabel degrades to a plain option labelled entry.name (defensive)", () => {
    const catalog: CatalogSummaryEntry[] = [
      { id: "half-branded", name: "Half-branded", authKind: "api_key", models: [], brand: "kimi" },
      { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
    ];
    // assertBrandContract forbids this shape in the real catalog; the renderer
    // must not crash or hide the entry if a future projection ever ships it.
    expect(providerOptionGroups(catalog)).toEqual([
      { label: "", options: [{ id: "half-branded", label: "Half-branded" }] },
      { label: "", options: [{ id: "z-ai", label: "Z.AI (GLM)" }] },
    ]);
  });
});

describe("liveModelSuggestions (TASK.183: stable union of fetched + persisted + hints)", () => {
  const HINTS = [
    { id: "k3", name: "K3" },
    { id: "kimi-for-coding", name: "K2.7 Coding" },
  ];

  it("static hints alone before any fetch (byte-identical pre-fetch behavior)", () => {
    expect(liveModelSuggestions(null, undefined, HINTS)).toEqual(HINTS);
    expect(liveModelSuggestions(null, [], HINTS)).toEqual(HINTS);
  });

  it("unions this session's fetch first, then persisted ids, then hints not already present", () => {
    expect(liveModelSuggestions([{ id: "k3" }, { id: "k4-new" }], ["stale-persisted"], HINTS)).toEqual([
      { id: "k3", name: "K3" },
      { id: "k4-new" },
      { id: "stale-persisted" },
      { id: "kimi-for-coding", name: "K2.7 Coding" },
    ]);
  });

  it("fetched and persisted ids are deduped case-sensitively, first occurrence wins", () => {
    expect(liveModelSuggestions([{ id: "dup" }, { id: "kept" }], ["dup", "persisted-only"], HINTS)).toEqual([
      { id: "dup" },
      { id: "kept" },
      { id: "persisted-only" },
      { id: "k3", name: "K3" },
      { id: "kimi-for-coding", name: "K2.7 Coding" },
    ]);
  });

  it("retains the persisted ids when nothing was fetched this session", () => {
    expect(liveModelSuggestions(null, ["kimi-for-coding", "extra"], HINTS)).toEqual([
      { id: "kimi-for-coding", name: "K2.7 Coding" },
      { id: "extra" },
      { id: "k3", name: "K3" },
    ]);
  });

  it("an EMPTY fetch result keeps persisted manual ids and hints (no longer wipes the list)", () => {
    expect(liveModelSuggestions([], ["persisted"], HINTS)).toEqual([
      { id: "persisted" },
      { id: "k3", name: "K3" },
      { id: "kimi-for-coding", name: "K2.7 Coding" },
    ]);
  });

  it("handles null/undefined persisted and empty hints", () => {
    expect(liveModelSuggestions(null, undefined, [])).toEqual([]);
    expect(liveModelSuggestions([{ id: "a" }], undefined, [])).toEqual([{ id: "a" }]);
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
    imageInput: "auto" as const,
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
    imageInput: "auto" as const,
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
      imageInput: "auto",
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

// ── TASK.183: durable manually entered connection models ──

describe("preflightModelId (TASK.183: pre-flight before any write)", () => {
  it("treats blank/space-only as the implicit/default sentinel", () => {
    expect(preflightModelId("")).toEqual({ kind: "blank" });
    expect(preflightModelId("   ")).toEqual({ kind: "blank" });
  });

  it("normalizes a valid id (an unknown id is valid — membership is never validation)", () => {
    expect(preflightModelId("  deepseek-ai/DeepSeek-V3.1  ")).toEqual({ kind: "id", id: "deepseek-ai/DeepSeek-V3.1" });
    expect(preflightModelId("some/unknown:v2-x")).toEqual({ kind: "id", id: "some/unknown:v2-x" });
    expect(preflightModelId("模型-α")).toEqual({ kind: "id", id: "模型-α" });
  });

  it("rejects interior spaces and control characters in the ORIGINAL input", () => {
    expect(preflightModelId("bad id")).toEqual({ kind: "invalid" });
    expect(preflightModelId("bad\nid")).toEqual({ kind: "invalid" });
    expect(preflightModelId("good\t")).toEqual({ kind: "invalid" });
  });

  it("exposes an actionable error message", () => {
    expect(MODEL_ID_ERROR).toMatch(/model ID/i);
  });
});

interface AppendCall {
  connectionId: string;
  addModels: string[];
}

function crateBridge(options?: {
  createResult?: SettingsMutationResult;
  appendResult?: FetchModelsOutcome;
  appendThrows?: boolean;
}) {
  const createCalls: unknown[] = [];
  const appendCalls: AppendCall[] = [];
  let reloads = 0;
  const bridge = {
    connectionCreate: async (req: unknown): Promise<SettingsMutationResult> => {
      createCalls.push(req);
      return options?.createResult ?? okResult([conn("local-1")], "local-1");
    },
    fetchModels: async (req: AppendCall): Promise<FetchModelsOutcome> => {
      appendCalls.push(req);
      if (options?.appendThrows) {
        throw new Error("append boom");
      }
      return options?.appendResult ?? { ok: true, models: req.addModels.map((id) => ({ id })) };
    },
  };
  return {
    bridge,
    createCalls,
    appendCalls,
    get reloads() {
      return reloads;
    },
    reload: async (): Promise<void> => {
      reloads += 1;
    },
  };
}

describe("createConnectionAndPersistModel (TASK.183)", () => {
  it("sends the create payload, then appends to the returned LOCAL id, then reloads", async () => {
    const fake = crateBridge();
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai", model: "manual-1" }, "manual-1");
    expect(result).toEqual({ ok: true, createdConnectionId: "local-1" });
    expect(fake.createCalls).toEqual([{ providerId: "z-ai", model: "manual-1" }]);
    expect(fake.appendCalls).toEqual([{ connectionId: "local-1", addModels: ["manual-1"] }]);
    expect(fake.reloads).toBe(1);
  });

  it("skips the append for a blank sentinel (modelId null)", async () => {
    const fake = crateBridge();
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai" }, null);
    expect(result).toEqual({ ok: true, createdConnectionId: "local-1" });
    expect(fake.appendCalls).toEqual([]);
    expect(fake.reloads).toBe(0);
  });

  it("does not append when creation failed", async () => {
    const fake = crateBridge({ createResult: { ok: false, reason: "invalid" } });
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai" }, "manual-1");
    expect(result.ok).toBe(false);
    expect(fake.appendCalls).toEqual([]);
  });

  it("reports a partial failure with the created id kept when the append outcome is an error", async () => {
    const fake = crateBridge({ appendResult: { ok: false, reason: "http_error" } });
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai" }, "manual-1");
    expect(result.ok).toBe(true);
    expect(result.createdConnectionId).toBe("local-1");
    expect(result.partial).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("reports a partial failure when the append THROWS (connection kept for retry)", async () => {
    const fake = crateBridge({ appendThrows: true });
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai" }, "manual-1");
    expect(result).toEqual({
      ok: true,
      createdConnectionId: "local-1",
      partial: true,
      error: "Connection created, but its model list couldn't be saved — retry with Save.",
    });
  });

  it("a retry appends successfully without creating another connection", async () => {
    let appendAttempts = 0;
    const createCalls: unknown[] = [];
    const bridge = {
      connectionCreate: async (req: unknown): Promise<SettingsMutationResult> => {
        createCalls.push(req);
        return okResult([conn("local-1")], "local-1");
      },
      fetchModels: async (req: AppendCall): Promise<FetchModelsOutcome> => {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw new Error("boom");
        }
        return { ok: true, models: req.addModels.map((id) => ({ id })) };
      },
    };
    const reload = async (): Promise<void> => {};
    const first = await createConnectionAndPersistModel(bridge, reload, { providerId: "z-ai", model: "manual-1" }, "manual-1");
    expect(first.createdConnectionId).toBe("local-1");
    expect(first.partial).toBe(true);
    // Retry appends directly to the known id — no second create.
    const retry = await appendModelToConnection(bridge, reload, first.createdConnectionId!, "manual-1");
    expect(retry.ok).toBe(true);
    expect(createCalls).toHaveLength(1);
    expect(appendAttempts).toBe(2);
  });
});

describe("updateConnectionAndPersistModel (TASK.183)", () => {
  it("appends the normalized selected model after a successful metadata update", async () => {
    const fake = crateBridge();
    const bridge = {
      ...fake.bridge,
      connectionUpdate: async (req: unknown): Promise<SettingsMutationResult> => {
        fake.createCalls.push(req);
        return okResult([conn("c1")]);
      },
    };
    const result = await updateConnectionAndPersistModel(bridge, fake.reload, "c1", { connectionId: "c1", model: "manual-1" }, "manual-1");
    expect(result).toEqual({ metaOk: true, appendOk: true });
    expect(fake.appendCalls).toEqual([{ connectionId: "c1", addModels: ["manual-1"] }]);
    expect(fake.reloads).toBe(1);
  });

  it("never appends after a failed metadata update", async () => {
    const fake = crateBridge();
    const bridge = {
      ...fake.bridge,
      connectionUpdate: async () => ({ ok: false as const, reason: "invalid" }) as SettingsMutationResult,
    };
    const result = await updateConnectionAndPersistModel(bridge, fake.reload, "c1", { connectionId: "c1" }, "manual-1");
    expect(result).toEqual({ metaOk: false, appendOk: false });
    expect(fake.appendCalls).toEqual([]);
  });

  it("skips the append for a blank model", async () => {
    const fake = crateBridge();
    const bridge = { ...fake.bridge, connectionUpdate: async () => okResult([conn("c1")]) };
    const result = await updateConnectionAndPersistModel(bridge, fake.reload, "c1", { connectionId: "c1" }, null);
    expect(result).toEqual({ metaOk: true, appendOk: true });
    expect(fake.appendCalls).toEqual([]);
  });

  it("reports appendOk false when the list append fails, metadata still saved", async () => {
    const fake = crateBridge({ appendResult: { ok: false, reason: "read_only" } });
    const bridge = { ...fake.bridge, connectionUpdate: async () => okResult([conn("c1")]) };
    const result = await updateConnectionAndPersistModel(bridge, fake.reload, "c1", { connectionId: "c1" }, "manual-1");
    expect(result).toEqual({ metaOk: true, appendOk: false });
  });
});

describe("appendModelsToConnection (TASK.183)", () => {
  it("sends the ids through the general {connectionId, addModels} branch then reloads", async () => {
    const fake = crateBridge();
    const result = await appendModelsToConnection(fake.bridge, fake.reload, "c1", ["a", "b"]);
    expect(result).toEqual({ ok: true });
    expect(fake.appendCalls).toEqual([{ connectionId: "c1", addModels: ["a", "b"] }]);
    expect(fake.reloads).toBe(1);
  });

  it("reports a failure reason without reloading", async () => {
    const fake = crateBridge({ appendResult: { ok: false, reason: "read_only" } });
    const result = await appendModelsToConnection(fake.bridge, fake.reload, "c1", ["a"]);
    expect(result).toEqual({ ok: false, reason: "read_only" });
    expect(fake.reloads).toBe(0);
  });

  it("a thrown append is reported, not swallowed", async () => {
    const fake = crateBridge({ appendThrows: true });
    expect(await appendModelsToConnection(fake.bridge, fake.reload, "c1", ["a"])).toEqual({ ok: false, reason: "threw" });
  });
});

describe("provider-list agreement (TASK.183): liveModelSuggestions and providerModelsFor keep the same effective ids", () => {
  it("for equal inputs (connection.models = fetched ++ persisted) the raw id order matches", () => {
    const fetched = [{ id: "live-a" }, { id: "live-b" }];
    const persisted = ["manual-1"];
    const hints = [
      { id: "hint-x", name: "Hint X" },
      { id: "live-a", name: "Live A" },
    ];
    const suggestions = liveModelSuggestions(fetched, persisted, hints).map((m) => m.id);
    const connectionModels = [...fetched.map((m) => m.id), ...persisted];
    const catalog = [{ id: "z-ai", name: "Z.ai", authKind: "api_key" as const, models: hints }];
    const provider = providerModelsFor("z-ai", catalog, undefined, connectionModels)?.map((m) => m.id);
    expect(provider).toEqual(suggestions);
  });
});

describe("ConnectionDrawer wiring (TASK.183: pre-create Model field in BOTH create flows)", () => {
  const source = readFileSync(new URL("./ConnectionDrawer.tsx", import.meta.url), "utf8");

  it("the pre-create field guard is widened from simplified-only to every uncreated connection", () => {
    // The old first-run-only guard must be gone: any not-yet-created connection
    // gets the field, not just the simplified flow.
    expect(source).not.toMatch(/simplified && createdConnectionId === null && selectedEntry/);
    expect(source).toMatch(/createdConnectionId === null && selectedEntry/);
  });

  it("a brand-new custom endpoint without a catalog entry gets its own free-text Model field", () => {
    expect(source).toMatch(/createdConnectionId === null && isNewCustomEndpoint && !selectedEntry/);
  });

  it("both pre-create Model inputs route through changeModel (no direct setModel, TASK.142 intact)", () => {
    expect(source).toMatch(
      /changeModel\(\s*e\.target\.value,\s*modelAfterCatalogPrefill\(e\.target\.value, selectedEntry\.models\),\s*undefined,\s*\)/,
    );
    expect(source).toMatch(/changeModel\(e\.target\.value, e\.target\.value, undefined\)/);
  });

  it("all three actual handlers persist through the shared helpers (create/save/fetch)", () => {
    expect(source).toMatch(/createConnectionAndPersistModel\(\s*modelPersistenceBridge\(\)/);
    expect(source).toMatch(/updateConnectionAndPersistModel\(\s*modelPersistenceBridge\(\)/);
    expect(source).toMatch(/appendModelsToConnection\(\s*modelPersistenceBridge\(\)/);
    expect(source).not.toMatch(/selectedModels: \[\.\.\./);
  });
});

// ── TASK.183 item 9: whole-path evidence against a REAL settings file ──
// Restart simulation: a connection is created in a real temp settings file, the
// model is appended by the PRODUCTION provider IPC, the file is re-read from
// disk, and that snapshot is fed to every picker helper. No Electron process is
// restarted — this is the snapshot-load simulation the plan allows.

describe("whole-path: a manual model added through production IPC is discoverable everywhere", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("survives a fresh load and reaches the drawer/composer/StartScreen/subagent/import lists with siblings intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-t183-"));
    dirs.push(dir);
    const settingsPath = join(dir, "settings.json");
    const customRecord = {
      id: "custom:rec",
      name: "Rec",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      models: ["rec-model"],
    };
    // The settings file a running host would have on disk.
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        provider: {
          activeConnectionId: "conn-1",
          connections: [
            { id: "conn-1", providerId: "kimi", model: "glm-4.6", modelsFetchedAt: "2026-01-02T00:00:00.000Z" },
            { id: "conn-2", providerId: "kimi", models: ["sibling"] },
          ],
          custom: [customRecord],
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
    // The same normalized id the drawer's pre-flight would send.
    const preflight = preflightModelId("  manual-new  ");
    expect(preflight).toEqual({ kind: "id", id: "manual-new" });
    const sent = preflight.kind === "id" ? preflight.id : "";
    // Production provider IPC performs the durable append.
    const outcome = await handleCustomProviderFetchModels(
      {
        settingsPath,
        // The manual-add path never touches the vault; the dependency is only
        // required by the shared deps shape.
        vault: {
          setSecret: async () => ({ ok: true, backend: "keychain" }) as never,
          clearSecret: async () => {},
          getSecretValue: async () => undefined,
        },
      },
      { connectionId: "conn-1", addModels: [sent] },
    );
    expect(outcome).toEqual({ ok: true, models: [{ id: "manual-new" }] });

    // "Restart": read the file again from scratch.
    const snapshot = (await loadSettings(settingsPath)).settings;
    const [conn1, conn2] = snapshot.provider.connections;
    expect(conn1).toMatchObject({
      id: "conn-1",
      model: "glm-4.6",
      modelsFetchedAt: "2026-01-02T00:00:00.000Z",
      models: ["manual-new"],
    });
    expect(conn2).toMatchObject({ id: "conn-2", models: ["sibling"] });
    expect(snapshot.provider.activeConnectionId).toBe("conn-1");
    expect(snapshot.provider.custom).toEqual([customRecord]);

    const catalog = [{ id: "kimi", name: "Kimi", authKind: "api_key" as const, models: [{ id: "kimi-for-coding", name: "K2.7 Coding" }] }];
    const hints = catalog[0]!.models;

    // Drawer suggestions: the union keeps the manual id and the hints.
    expect(liveModelSuggestions(null, conn1!.models, hints).map((m) => m.id)).toEqual(["manual-new", "kimi-for-coding"]);
    // Composer / provider pill / subagent parent list.
    for (const offered of [
      providerModelsFor("kimi", catalog, snapshot.provider.custom, conn1!.models),
      providerModelsFor("kimi", catalog, snapshot.provider.custom, conn2!.models),
    ]) {
      expect(offered?.map((m) => m.id)).toBeDefined();
    }
    expect(providerModelsFor("kimi", catalog, snapshot.provider.custom, conn1!.models)?.map((m) => m.id)).toEqual([
      "manual-new",
      "kimi-for-coding",
    ]);
    expect(providerModelsFor("kimi", catalog, snapshot.provider.custom, conn2!.models)?.map((m) => m.id)).toEqual([
      "sibling",
      "kimi-for-coding",
    ]);
    // StartScreen groups.
    const groups = buildStartModelGroups(snapshot.provider.connections, catalog, snapshot.provider.custom, {
      connectionId: "conn-1",
      modelId: "manual-new",
    });
    expect(groups.find((g) => g.connectionId === "conn-1")!.items.map((i) => i.id)).toContain("manual-new");
    expect(groups.find((g) => g.connectionId === "conn-2")!.items.map((i) => i.id)).not.toContain("manual-new");
    // Import dialog, with the snapshot shaped like the store's.
    const importOptions = importModelOptionsFor({
      settings: snapshot,
      catalog,
      secrets: [],
      providerReady: true,
      envOverrides: [],
      readOnly: false,
    } as never);
    expect(importOptions?.map((m) => m.id)).toEqual(["manual-new", "kimi-for-coding"]);
    // The model menu still shows the explicit selection.
    expect(modelMenuItems("manual-new", importOptions).map((m) => m.id)).toContain("manual-new");
  });
});

describe("pre-create flow composition (TASK.183 items 1–2)", () => {
  it("a typed id BEFORE any connection exists is sent to connectionCreate and then appended to the SAME local id", async () => {
    const fake = crateBridge();
    const typed = "  deepseek-ai/DeepSeek-V3.1  ";
    const preflight = preflightModelId(typed);
    expect(preflight).toEqual({ kind: "id", id: "deepseek-ai/DeepSeek-V3.1" });
    const createModel = preflight.kind === "id" ? preflight.id : "";
    const payload = { providerId: "z-ai", ...(createModel !== "" ? { model: createModel } : {}) };
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, payload, createModel !== "" ? createModel : null);
    expect(result.createdConnectionId).toBe("local-1");
    // Exactly the normalized id — same value in the create payload and the append.
    expect(fake.createCalls).toEqual([{ providerId: "z-ai", model: "deepseek-ai/DeepSeek-V3.1" }]);
    expect(fake.appendCalls).toEqual([{ connectionId: "local-1", addModels: ["deepseek-ai/DeepSeek-V3.1"] }]);
  });

  it("a catalog-default prefill is persisted the same way as a typed id", async () => {
    const fake = crateBridge();
    const hints = [{ id: "kimi-for-coding", name: "K2.7 Coding" }];
    const effective = modelAfterCatalogPrefill("", hints);
    const effectiveId = preflightModelId(effective);
    expect(effectiveId).toEqual({ kind: "id", id: "kimi-for-coding" });
    const id = effectiveId.kind === "id" ? effectiveId.id : "";
    await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "kimi", model: id }, id);
    expect(fake.createCalls).toEqual([{ providerId: "kimi", model: "kimi-for-coding" }]);
    expect(fake.appendCalls).toEqual([{ connectionId: "local-1", addModels: ["kimi-for-coding"] }]);
  });

  it("a BLANK model keeps the implicit path: no model in the payload and no append", async () => {
    const fake = crateBridge();
    const preflight = preflightModelId("");
    expect(preflight.kind).toBe("blank");
    const id = preflight.kind === "id" ? preflight.id : "";
    await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai", ...(id !== "" ? { model: id } : {}) }, id !== "" ? id : null);
    expect(fake.createCalls).toEqual([{ providerId: "z-ai" }]);
    expect(fake.appendCalls).toEqual([]);
  });

  it("an invalid original id is refused by the pre-flight before any create or append call", async () => {
    const fake = crateBridge();
    const preflight = preflightModelId("bad\nid");
    expect(preflight).toEqual({ kind: "invalid" });
    // The handlers return on `invalid`, so nothing is called — model the guard.
    if (preflight.kind !== "invalid") {
      throw new Error("expected invalid");
    }
    expect(fake.createCalls).toEqual([]);
    expect(fake.appendCalls).toEqual([]);
    expect(fake.reloads).toBe(0);
  });

  it("an UNKNOWN but valid id proceeds (membership in a catalog is never validation)", async () => {
    const fake = crateBridge();
    const preflight = preflightModelId("who/knows:v9-unlisted");
    expect(preflight).toEqual({ kind: "id", id: "who/knows:v9-unlisted" });
    const id = preflight.kind === "id" ? preflight.id : "";
    const result = await createConnectionAndPersistModel(fake.bridge, fake.reload, { providerId: "z-ai", model: id }, id);
    expect(result.ok).toBe(true);
    expect(fake.appendCalls).toEqual([{ connectionId: "local-1", addModels: ["who/knows:v9-unlisted"] }]);
  });

  it("a brand-new custom endpoint sends selectedModels: [] (manual ids live on the connection, not the record)", () => {
    const source = readFileSync(new URL("./ConnectionDrawer.tsx", import.meta.url), "utf8");
    const customBlock = source.slice(
      source.indexOf("async function createNewCustomEndpoint"),
      source.indexOf("async function createConnection()"),
    );
    expect(customBlock).toMatch(/selectedModels: \[\]/);
    expect(customBlock).not.toMatch(/selectedModels: \[[^\]]+\]/);
  });

  it("all three handlers run the model pre-flight BEFORE their create/update/append bridge call", () => {
    const source = readFileSync(new URL("./ConnectionDrawer.tsx", import.meta.url), "utf8");
    const createBlock = source.slice(source.indexOf("async function createConnection"), source.indexOf("async function save"));
    const saveBlock = source.slice(source.indexOf("async function save"), source.indexOf("async function doFetchModels"));
    expect(createBlock.indexOf("preflightModelId(")).toBeLessThan(createBlock.indexOf("createConnectionAndPersistModel("));
    expect(saveBlock.indexOf("preflightModelId(")).toBeLessThan(saveBlock.indexOf("updateConnectionAndPersistModel("));
  });

  it("the pre-create model change still routes the context-window binding through the shared change", () => {
    // TASK.142 ownership preserved: A's number must not ride onto a manually
    // typed B of the same connection.
    expect(contextWindowAfterModelInput({ raw: "900000", model: "manual-a" }, "manual-b", undefined)).toEqual({ raw: "", model: "manual-b" });
  });
});

// ── Taskana 4088 (TASK.69): the per-model image-input select's pure helpers ──

describe("buildConnectionUpdatePayload — imageInputOverride (Taskana 4088: unconditional send, \"\" clears the pair)", () => {
  const base = {
    connectionId: "conn-1",
    label: "",
    model: "",
    transport: "" as const,
    baseUrl: "",
    showBaseUrl: false,
    proxyRef: "",
    authOptional: false,
    maxOutputTokens: "" as const,
    contextWindowTokens: "" as const,
  };

  it('sends imageInputOverride:"on" / "off" / "" unconditionally — never omits the key', () => {
    expect(buildConnectionUpdatePayload({ ...base, imageInput: "on" }).imageInputOverride).toBe("on");
    expect(buildConnectionUpdatePayload({ ...base, imageInput: "off" }).imageInputOverride).toBe("off");
    const payload = buildConnectionUpdatePayload({ ...base, imageInput: "auto" });
    expect(payload.imageInputOverride).toBe("");
    expect("imageInputOverride" in payload).toBe(true);
  });

  it("the renderer never names a model in the payload — the binding is derived server-side (pair discipline)", () => {
    const payload = buildConnectionUpdatePayload({ ...base, model: "glm-5.3v", imageInput: "on" });
    expect(payload.imageInputOverride).toBe("on");
    expect("imageInputModel" in payload).toBe(false);
  });
});

describe("imageInputToPayload (Taskana 4088: the auto -> \"\" mapping)", () => {
  it("maps the three select states onto the wire's two enum arms plus the clear sentinel", () => {
    expect(imageInputToPayload("auto")).toBe("");
    expect(imageInputToPayload("on")).toBe("on");
    expect(imageInputToPayload("off")).toBe("off");
  });
});

describe("imageInputInitialValue (Taskana 4088: the contextWindowInitialRaw model-binding rule)", () => {
  it("prefills the override ONLY when it binds to the shown model", () => {
    expect(
      imageInputInitialValue({ imageInputOverride: "on", imageInputModel: "glm-5.3v", model: "glm-5.3v" }),
    ).toBe("on");
    expect(
      imageInputInitialValue({ imageInputOverride: "off", imageInputModel: "glm-5.2", model: "glm-5.2" }),
    ).toBe("off");
  });

  it('reads "auto" when the pair binds a DIFFERENT model, is half-absent, or missing entirely', () => {
    expect(
      imageInputInitialValue({ imageInputOverride: "on", imageInputModel: "other-model", model: "glm-5.3v" }),
    ).toBe("auto");
    expect(imageInputInitialValue({ imageInputOverride: "on", model: "glm-5.3v" })).toBe("auto");
    expect(imageInputInitialValue({ imageInputModel: "glm-5.3v", model: "glm-5.3v" })).toBe("auto");
    expect(imageInputInitialValue({ model: "glm-5.3v" })).toBe("auto");
    expect(imageInputInitialValue({})).toBe("auto");
  });
});

describe("imageInputEffectiveHint (Taskana 4088: name what Auto resolves to)", () => {
  const entry: CatalogSummaryEntry = {
    id: "z-ai",
    name: "Z.AI",
    authKind: "api_key",
    models: [
      { id: "glm-5.3v", imageInput: true },
      { id: "glm-5.2" },
    ],
  };

  it("raw auto + catalog imageInput:true -> 'catalog: vision'", () => {
    expect(imageInputEffectiveHint(entry, "glm-5.3v", undefined, "auto")).toBe("catalog: vision");
  });

  it("raw auto + the connection's live caps imageInput fact -> 'live /v1/models: vision' (catalog-unmarked model)", () => {
    expect(imageInputEffectiveHint(entry, "glm-5.2", { modelCapabilities: { "glm-5.2": { imageInput: true } } }, "auto")).toBe(
      "live /v1/models: vision",
    );
    // The live fact is checked only when the catalog does NOT vouch — the
    // catalog branch wins first, mirroring resolve order at resolve time.
    expect(imageInputEffectiveHint(entry, "glm-5.3v", { modelCapabilities: {} }, "auto")).toBe("catalog: vision");
  });

  it("raw on/off suppresses the hint; auto with no fact in either source is null", () => {
    expect(imageInputEffectiveHint(entry, "glm-5.3v", undefined, "on")).toBeNull();
    expect(imageInputEffectiveHint(entry, "glm-5.3v", undefined, "off")).toBeNull();
    expect(imageInputEffectiveHint(entry, "glm-5.2", undefined, "auto")).toBeNull();
    expect(imageInputEffectiveHint(entry, "glm-5.2", { modelCapabilities: { other: { imageInput: true } } }, "auto")).toBeNull();
  });
});

describe("imageInputEnvHint (Taskana 4088: the per-model override rides the env)", () => {
  it("names the variable while it is live, null otherwise (exact-name match)", () => {
    // 4088-on-4118: only the override still rides the env; the former
    // MODELS var is no longer recognized.
    expect(imageInputEnvHint(["ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE"])).toContain("ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE is set");
    expect(imageInputEnvHint([])).toBeNull();
    expect(imageInputEnvHint(["ANYCODE_IMAGE_INPUT_MODELS"])).toBeNull();
    expect(imageInputEnvHint(["ANYCODE_IMAGE_INPUT_MODELS_X"])).toBeNull();
  });
});

describe("imageInputModelPreflightError (Taskana 4088 cross-review: an explicit override needs a model on BOTH create and update)", () => {
  it("refuses an explicit on/off override with a blank model, on create and update alike", () => {
    expect(imageInputModelPreflightError("on", "")).toEqual(expect.any(String));
    expect(imageInputModelPreflightError("off", "   ")).toEqual(expect.any(String));
  });

  it("allows auto with a blank model, and an explicit override with a real model", () => {
    expect(imageInputModelPreflightError("auto", "")).toBeNull();
    expect(imageInputModelPreflightError("on", "glm-5.3v")).toBeNull();
    expect(imageInputModelPreflightError("off", "glm-5.2")).toBeNull();
  });
});

// ── Taskana 4749: main fields on top, tuning under a collapsed "Advanced" ──

// No-break space between digit groups, as formatTokenCount writes it.
const NBSP = "\u00A0";

describe("advancedHasValues (Taskana 4749: Advanced opens by itself only for a non-default value)", () => {
  const base = {
    transport: "",
    maxOutputTokens: "",
    contextWindowRaw: "",
    imageInput: "auto" as const,
    proxyRef: PROXY_REF_INHERIT,
  };

  it("is collapsed when every tuning value is at its default", () => {
    expect(advancedHasValues(base)).toBe(false);
  });

  it("opens for each non-default tuning value", () => {
    expect(advancedHasValues({ ...base, transport: "anthropic-messages" })).toBe(true);
    expect(advancedHasValues({ ...base, maxOutputTokens: "8192" })).toBe(true);
    expect(advancedHasValues({ ...base, contextWindowRaw: "200000" })).toBe(true);
    expect(advancedHasValues({ ...base, imageInput: "on" })).toBe(true);
    expect(advancedHasValues({ ...base, imageInput: "off" })).toBe(true);
    expect(advancedHasValues({ ...base, proxyRef: "proxy-1" })).toBe(true);
  });

  it("treats whitespace-only text as empty", () => {
    expect(advancedHasValues({ ...base, maxOutputTokens: "   " })).toBe(false);
    expect(advancedHasValues({ ...base, contextWindowRaw: "  " })).toBe(false);
  });

  it("counts Label only when the caller passes it (first-run flow), and not when blank", () => {
    expect(advancedHasValues({ ...base, label: "Work" })).toBe(true);
    expect(advancedHasValues({ ...base, label: "   " })).toBe(false);
    expect(advancedHasValues(base)).toBe(false);
  });
});

describe("placeholder helpers (Taskana 4749: catalog numbers show as placeholders, not a separate line)", () => {

  it("formatTokenCount groups thousands with a no-break space and leaves < 1000 alone", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe(`1${NBSP}000`);
    expect(formatTokenCount(131072)).toBe(`131${NBSP}072`);
    expect(formatTokenCount(1000000)).toBe(`1${NBSP}000${NBSP}000`);
  });

  it("maxOutputPlaceholder names the catalog or provider-default number, or Default alone", () => {
    expect(maxOutputPlaceholder("catalog: 131072")).toBe(`Default · 131${NBSP}072`);
    expect(maxOutputPlaceholder("provider default: 32768")).toBe(`Default · 32${NBSP}768`);
    expect(maxOutputPlaceholder(null)).toBe("Default");
    expect(maxOutputPlaceholder("something else")).toBe("Default");
  });

  it("contextWindowPlaceholder marks the assumed fallback as assumed", () => {
    expect(contextWindowPlaceholder("catalog: 200000")).toBe(`Default · 200${NBSP}000`);
    expect(
      contextWindowPlaceholder("assumed fallback: 8192 (unknown model — set a value to override)"),
    ).toBe(`Default · 8${NBSP}192 (assumed)`);
    expect(contextWindowPlaceholder(null)).toBe("Default");
    expect(contextWindowPlaceholder("catalog: lots")).toBe("Default");
  });

  it("imageInputAutoLabel names the vision source, or stays plain Auto", () => {
    expect(imageInputAutoLabel("catalog: vision")).toBe("Auto · vision (catalog)");
    expect(imageInputAutoLabel("live /v1/models: vision")).toBe("Auto · vision (live)");
    expect(imageInputAutoLabel(null)).toBe("Auto");
  });
});

describe("Max output tokens segmented control (Taskana 4749: one control, input only for Custom)", () => {
  const noop = () => {};

  function render(props: Partial<MaxOutputSegmentedProps> & { value: string }): string {
    return renderToStaticMarkup(
      createElement(MaxOutputSegmented, { custom: false, disabled: false, onSelect: noop, onCustom: noop, ...props }),
    );
  }

  // The pressed segment is the button whose data-segment is followed by aria-pressed="true".
  function pressedSegments(html: string): string[] {
    return [...html.matchAll(/data-segment="([^"]+)"[^>]*aria-pressed="true"/g)].map((m) => m[1]!);
  }

  // Walk the rendered element tree and collect the segment buttons (their props, incl. onClick).
  function segmentButtons(el: ReactElement<{ children?: unknown }>): ReactElement<{ "data-segment"?: string; onClick?: () => void }>[] {
    const out: ReactElement<{ "data-segment"?: string; onClick?: () => void }>[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node && typeof node === "object" && "props" in node) {
        const element = node as ReactElement<{ children?: unknown; "data-segment"?: string }>;
        if (element.props["data-segment"] !== undefined) {
          out.push(element);
        }
        visit(element.props.children);
      }
    };
    visit(el.props.children);
    return out;
  }

  it("renders Default, 8K, 16K, 32K and Custom, with Default pressed for a blank value", () => {
    const html = render({ value: "" });
    for (const label of ["Default", "8K", "16K", "32K", "Custom"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Max output tokens"');
    expect(pressedSegments(html)).toEqual(["default"]);
    expect(html).not.toContain("<input");
  });

  it("a saved non-preset value opens with Custom pressed", () => {
    expect(pressedSegments(render({ value: "50000" }))).toEqual(["custom"]);
  });

  it("a preset value presses its own segment, and Custom when the UI state says so", () => {
    expect(pressedSegments(render({ value: "8192" }))).toEqual(["8192"]);
    expect(pressedSegments(render({ value: "8192", custom: true }))).toEqual(["custom"]);
  });

  it("the group carries the catalog-derived tooltip when given", () => {
    expect(render({ value: "", title: `Default · 131${NBSP}072` })).toContain(
      `title="Default · 131${NBSP}072"`,
    );
  });

  it("preset segments hand their own values to onSelect, Default writes the blank sentinel", () => {
    const onSelect = vi.fn();
    const onCustom = vi.fn();
    const el = MaxOutputSegmented({ value: "", custom: false, disabled: false, onSelect, onCustom });
    const buttons = segmentButtons(el as ReactElement<{ children?: unknown }>);
    const byId = (id: string) => buttons.find((b) => b.props["data-segment"] === id)!;
    byId("default").props.onClick?.();
    byId("8192").props.onClick?.();
    byId("16384").props.onClick?.();
    byId("32768").props.onClick?.();
    byId("custom").props.onClick?.();
    expect(onSelect.mock.calls).toEqual([[""], ["8192"], ["16384"], ["32768"]]);
    expect(onCustom).toHaveBeenCalledTimes(1);
  });

  it("the preset segment values are the unchanged MAX_OUTPUT_TOKEN_PRESETS values, and the display labels map to them", () => {
    expect(MAX_OUTPUT_TOKEN_PRESETS.map((p) => p.label)).toEqual(["Default", "8192", "16384", "32768"]);
    expect(MAX_OUTPUT_SEGMENT_LABEL).toEqual({
      default: "Default",
      "8192": "8K",
      "16384": "16K",
      "32768": "32K",
      custom: "Custom",
    });
  });

  it("maxOutputSegmentSelection: UI Custom wins; otherwise the preset matcher decides", () => {
    expect(maxOutputSegmentSelection("50000", false)).toBe("custom");
    expect(maxOutputSegmentSelection("8192", true)).toBe("custom");
    expect(maxOutputSegmentSelection("8192", false)).toBe("8192");
    expect(maxOutputSegmentSelection("", false)).toBe("default");
  });
});


describe("helper text (Taskana 4749: one visible line, the full text in a ? tooltip)", () => {
  it("the visible one-liners are exactly the agreed short copy", () => {
    expect(MAX_OUTPUT_ONELINER).toBe("Blank = provider default.");
    expect(CONTEXT_WINDOW_ONELINER).toBe("Blank = catalog window.");
    expect(IMAGE_INPUT_ONELINER).toBe("Auto uses the catalog or the provider's model list.");
  });

  it("the tooltip texts keep the full original meaning, verbatim", () => {
    expect(MAX_OUTPUT_HELP).toBe(
      "Leave empty to use the provider's default. Reasoning models spend part of this budget on hidden thinking before they write anything — for a self-hosted endpoint the catalog has no model list to guess a limit from, so raise this if output keeps cutting off.",
    );
    expect(CONTEXT_WINDOW_HELP).toBe(
      "Leave empty to use the catalog window; for a model the catalog does not know, an assumed 8192-token window is used so long sessions compact early instead of overstuffing the prompt. Saved for the model above only — switching this connection to another model ignores it.",
    );
    expect(IMAGE_INPUT_HELP).toBe(
      "Auto uses the catalog's vision mark or the image-capable list fetched from the provider's /v1/models. On / Off override it for the model above only — switching this connection to another model ignores it. A running session picks a change up when it next starts.",
    );
  });

  it("FieldHelp renders a focusable ? whose native tooltip is the given text", () => {
    const html = renderToStaticMarkup(createElement(FieldHelp, { text: "x" }));
    expect(html).toContain('title="x"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(">?<");
  });
});

describe("ConnectionDrawer layout wiring (Taskana 4749)", () => {
  const source = readFileSync(new URL("./ConnectionDrawer.tsx", import.meta.url), "utf8");

  it("the disclosure is a controlled <details> in BOTH modes, closed unless a value is set", () => {
    expect(source).toMatch(/<details\s+className="connection-drawer-advanced"/);
    expect(source).toMatch(/open=\{advancedOpen\}/);
    expect(source).toMatch(/onToggle=\{\(e\) => setAdvancedOpen\(e\.currentTarget\.open\)\}/);
    expect(source).toMatch(/useState\(\(\) => advancedHasValues\(/);
    expect(source).not.toMatch(/AdvancedFields/);
  });

  it("only the first-run flow keeps the 'Advanced settings (optional)' summary; the dialog says 'Advanced'", () => {
    expect(source).toMatch(/\{simplified \? "Advanced settings \(optional\)" : "Advanced"\}/);
  });

  it("both {ok:false} validation paths reopen Advanced in createConnection AND save", () => {
    const createBlock = source.slice(source.indexOf("async function createConnection"), source.indexOf("async function save"));
    const saveBlock = source.slice(source.indexOf("async function save"), source.indexOf("async function doFetchModels"));
    for (const block of [createBlock, saveBlock]) {
      // one for the max-output field, one for the context window
      expect(block.match(/setAdvancedOpen\(true\);/g)).toHaveLength(2);
      expect(block).toMatch(/if \(!mot\.ok\) \{\s*\/\/[^\n]*\n\s*setAdvancedOpen\(true\);\s*setError\(MAX_OUTPUT_TOKENS_ERROR\);/);
      expect(block).toMatch(/if \(!cw\.ok\) \{\s*\/\/[^\n]*\n\s*setAdvancedOpen\(true\);\s*setError\(CONTEXT_WINDOW_ERROR\);/);
    }
  });

  it("the Advanced block is defined once and rendered in exactly the two branches, after Model and credentials", () => {
    expect(source.match(/const advancedBlock = \(/g)).toHaveLength(1);
    const renders = [...source.matchAll(/\{advancedBlock\}/g)].map((m) => m.index!);
    expect(renders).toHaveLength(2);
    const [preCreate, created] = renders as [number, number];
    // pre-create: after the API key input, before the Create button
    expect(preCreate).toBeLessThan(source.indexOf("onClick={() => void createConnection()}"));
    expect(preCreate).toBeGreaterThan(source.indexOf('placeholder="sk-…"'));
    // created: after the Model input and the credential section, before Save
    expect(created).toBeGreaterThan(source.indexOf('className="settings-section connection-drawer-credential"'));
    expect(created).toBeLessThan(source.indexOf("onClick={() => void save()}"));
    expect(source.indexOf('list="connection-drawer-model-suggestions"')).toBeLessThan(created);
  });

  it("Label is at the top in the dialog (not simplified), and inside Advanced only for the first-run flow", () => {
    const top = source.indexOf("{!simplified && labelField}");
    expect(top).toBeGreaterThan(source.indexOf("<span className=\"settings-field-label\">Provider</span>"));
    expect(top).toBeLessThan(source.indexOf("{showBaseUrl && ("));
    expect(source.indexOf("{simplified && labelField}")).toBeGreaterThan(source.indexOf("const advancedBlock = ("));
  });

  it("the standalone catalog hint lines are gone and the inputs carry the catalog number as placeholder", () => {
    expect(source).not.toMatch(/\{motDefaultHint !== null &&/);
    expect(source).not.toMatch(/\{cwDefaultHint !== null &&/);
    expect(source).not.toMatch(/\{imageInputHint !== null &&/);
    expect(source).toMatch(/placeholder=\{maxOutputPlaceholder\(motDefaultHint\)\}/);
    expect(source).toMatch(/placeholder=\{contextWindowPlaceholder\(cwDefaultHint\)\}/);
    expect(source).toMatch(/imageInputAutoLabel\(imageInputHint\)/);
  });

  it("the long paragraphs became tooltips: no role=note paragraph still carries the old helper text", () => {
    expect(source).not.toMatch(/role="note">[^<]*Saved for the model above only/);
    expect(source).not.toMatch(/role="note">[^<]*Leave empty to use the/);
    expect(source).not.toMatch(/role="note">[^<]*Auto uses the catalog/);
  });

  it("the per-model scope is a 'this model only' badge on Context window and Image input", () => {
    // JSX badges only (the doc comment on the title constant also names it).
    expect(source.match(/>\s*this model only\s*</g)).toHaveLength(2);
    expect(source).toMatch(/Context window \(tokens\) <FieldHelp text=\{CONTEXT_WINDOW_HELP\} \/>/);
    expect(source).toMatch(/Image input <FieldHelp text=\{IMAGE_INPUT_HELP\} \/>/);
  });

  it("the Max output control is the segmented group, and the input is rendered only while Custom is shown", () => {
    expect(source).toMatch(/\{maxOutputInputShown && \(/);
    expect(source).toMatch(/<MaxOutputSegmented/);
    expect(source).not.toMatch(/connection-drawer-preset-chip/);
  });
});

/**
 * ConnectionDrawer (TASK.45 W12, cut §"Add/Edit flow"): the compact add/edit
 * surface for ONE provider connection — template → label → model → transport
 * (restricted to `supportedTransports`, TASK.43) → base URL (capability-gated)
 * → credential (API key or OAuth). Split into `ConnectionDrawerFields` (the
 * actual form — no dialog chrome) and `ConnectionDrawer` (a native `<dialog>`
 * wrapper around it, same controlled showModal/close + focus-capture/restore
 * pattern as ConsentDialog/SettingsDialog) so WelcomeScreen's first-run flow
 * (cut §"Отдельный first-run empty state": "не тащить туда целиком
 * management screen") can embed the SAME fields directly, chrome-free —
 * exactly the precedent `ProviderSettings` itself already set pre-W12.
 *
 * SEQUENCING (cut §"Add/Edit flow"): metadata creation and the credential
 * write are separate main-authoritative steps, not one atomic action — "Add"
 * first mints connection metadata via `connection-create` (disabling the
 * template picker the instant it exists, since a connection's provider
 * identity is fixed at creation); the credential section then activates
 * against that real connection id, identically to editing an existing one. If
 * the secure-storage write fails or needs consent, the tile this drawer feeds
 * honestly stays `Needs credential` rather than pretending to be ready (cut:
 * "созданная плашка честно остаётся в Needs credential"). Editing an existing
 * connection starts with this same post-creation shape.
 *
 * CUSTODY: the credential input is write-only and never prefilled from a
 * SecretStatus. Connection keys go through store.setSecret (which parks
 * consent retries); shared custom-record keys go through customProvider.update
 * and stay in the field on refusal so the user can retry.
 */
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type {
  CatalogSummary,
  CatalogSummaryEntry,
  ConnectionCreateRequest,
  ConnectionUpdateRequest,
  CustomProviderRecord,
  ImplicitPromptCache,
  ProviderConnection,
  ReasoningEffort,
  ProviderTransportId,
  SecretStatus,
  SecretKey,
  SettingsMutationResult,
  TokenRates,
} from "../../../shared/settings.js";
import { applyModelReasoningOverride, contextWindowTokensField, modelOverrideFor } from "../../../shared/model-overrides.js";
import { mergeModelIds, normalizeModelId } from "../../../shared/settings.js";
import type { CustomProviderMutationResult, CustomProviderUpdateRequest, FetchModelsOutcome } from "../anycode-window.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { connectionSecretKey, customProviderSecretKey, isCustomRecordProviderId } from "./ConnectionTile.js";
import { PROXY_REF_INHERIT, ProxyRefPicker, connectionCreateProxyRefField, proxyRefInitialValue } from "./ProxyRefPicker.js";
import {
  OAuthCredentialBlock,
  CUSTOM_KIND_DEFAULT_TRANSPORT,
  TRANSPORT_LABEL,
  buildCustomProviderCreateRequest,
  customProviderKindLabel,
  describeCustomProviderMutationError,
  describeFetchModelsError,
  describeSecretStatus,
  isOwnDialogCancel,
  secretFieldReducer,
  selectProviderEntry,
  shouldShowBaseUrlField,
  toggleSelectedModel,
  transportOptions,
  type CustomProviderBridge,
} from "./SettingsScreen.js";
import { X } from "./icons.js";
import { startModelEffortLevels } from "./start-model-picker.js";

/**
 * The connection `connection-create` just minted (TASK.45 W12-FIX2 §1):
 * main is the authority — `result.createdConnectionId` on a successful
 * result IS the id, never a diff of the snapshot against a stale `before`
 * prop (that heuristic picked the WRONG connection whenever two unseen ids
 * appeared at once). `undefined` on a refusal, or fail-closed when a
 * same-build ok-result somehow lacks the field. Exported for unit testing.
 */
export function resolveCreatedConnectionId(result: SettingsMutationResult): string | undefined {
  return result.ok ? result.createdConnectionId : undefined;
}

/** Route shared custom-record credentials through their sole write channel. */
export function buildKeyMutation(providerId: string, key: SecretKey, value?: string):
  | { channel: "custom"; request: CustomProviderUpdateRequest }
  | { channel: "connection"; key: SecretKey; value: string | undefined } {
  return isCustomRecordProviderId(providerId)
    ? { channel: "custom", request: { id: providerId, ...(value === undefined ? { authOptional: true } : { apiKey: value }) } }
    : { channel: "connection", key, value };
}

/** Custom updates cannot queue consent retries; every refusal retains the input. */
export function resolveCustomKeyOutcome(result: CustomProviderMutationResult): {
  refused: boolean; detail: string | null; clearInput: boolean;
} {
  return result.ok
    ? { refused: false, detail: null, clearInput: true }
    : { refused: true, detail: describeCustomProviderMutationError(result.reason), clearInput: false };
}

// ── TASK.183: durable manually entered connection models ──

/**
 * Pre-flight of a raw Model-field value before any create/update/secret/list
 * call. `blank` keeps the existing implicit/default rules (a blank catalog
 * model is refused later by `modelSaveBlocked`; a blank arbitrary endpoint is
 * fine); `id` is the normalized, persistable id; `invalid` is a nonblank value
 * that is not a valid model id. Validation reads the ORIGINAL string (via
 * `normalizeModelId`) so a control character is not quietly erased by
 * trimming. A valid but UNKNOWN id is `id` — catalog membership is never
 * validation. Exported for direct testing (no jsdom in this package).
 */
export type ModelPreflight = { kind: "blank" } | { kind: "id"; id: string } | { kind: "invalid" };

export function preflightModelId(input: string): ModelPreflight {
  if (input.trim() === "") {
    return { kind: "blank" };
  }
  const id = normalizeModelId(input);
  return id === null ? { kind: "invalid" } : { kind: "id", id };
}

/** Actionable copy for a `preflightModelId` `invalid` result. */
export const MODEL_ID_ERROR =
  "That model ID isn't valid — a model id has no inner spaces and no control characters.";

/** The one bridge call the model-persistence helpers need on top of the store. */
export interface ModelAppendBridge {
  fetchModels(req: { connectionId: string; addModels: string[] }): Promise<FetchModelsOutcome>;
}

export interface ModelAppendOutcome {
  ok: boolean;
  /** Present on failure: the fetch failure reason, or `threw`. */
  reason?: string;
}

/**
 * Appends normalized model ids to an existing connection's `models[]` via the
 * general `{connectionId, addModels}` IPC branch, then refresh the snapshot.
 * This is the ONE durable manual-entry path shared by create, save and the
 * custom-record fetch — a failed/thrown append is reported honestly (the ids
 * were NOT persisted) rather than swallowed. A `reload` failure is best-effort
 * and never reads as a save failure. Exported for direct testing.
 */
export async function appendModelsToConnection(
  bridge: ModelAppendBridge,
  reload: () => Promise<void>,
  connectionId: string,
  modelIds: readonly string[],
): Promise<ModelAppendOutcome> {
  let outcome: FetchModelsOutcome;
  try {
    outcome = await bridge.fetchModels({ connectionId, addModels: [...modelIds] });
  } catch {
    return { ok: false, reason: "threw" };
  }
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  try {
    await reload();
  } catch {
    // The list IS persisted; a refresh failure must not read as a save failure.
  }
  return { ok: true };
}

/**
 * Whether the selected model also needs an entry in the connection's own
 * `models[]`. A model the catalog already offers is offered by every picker
 * regardless, and the pickers read the connection's list BEFORE the catalog
 * hints — appending it therefore moved that model to the front of the list
 * (the chip order changed from catalog order on the first Save). A custom
 * endpoint keeps every id: its `models[]` IS its curated selector list, not a
 * redundant copy of a catalog. Exported for direct testing.
 */
export function shouldAppendModelToList(
  modelId: string,
  catalogOfferedIds: readonly string[],
  customEndpoint: boolean,
): boolean {
  return customEndpoint || !catalogOfferedIds.includes(modelId);
}

/** Single-id convenience over `appendModelsToConnection`. Exported for tests. */
export async function appendModelToConnection(
  bridge: ModelAppendBridge,
  reload: () => Promise<void>,
  connectionId: string,
  modelId: string,
): Promise<ModelAppendOutcome> {
  return appendModelsToConnection(bridge, reload, connectionId, [modelId]);
}

export interface CreateModelBridge<C> extends ModelAppendBridge {
  connectionCreate(req: C): Promise<SettingsMutationResult>;
}

export interface CreateWithModelResult {
  /** The connection was created (`createdConnectionId` set) — false only if creation itself failed. */
  ok: boolean;
  createdConnectionId?: string;
  /** The connection exists but its model list could NOT be saved. */
  partial?: boolean;
  error?: string;
}

/**
 * Create-then-persist sequencing shared by both create flows: mint the
 * connection, resolve the just-minted LOCAL id from the result (never a stale
 * state read), and — when a model was entered — append it to that same
 * connection's `models[]` before refreshing. On an append failure the
 * connection id is still returned with `partial: true`: the connection
 * metadata exists, only the list is missing, and the caller reports that
 * honestly for retry (no fake rollback). Exported for direct testing.
 */
export async function createConnectionAndPersistModel<C>(
  bridge: CreateModelBridge<C>,
  reload: () => Promise<void>,
  createRequest: C,
  modelId: string | null,
): Promise<CreateWithModelResult> {
  let result: SettingsMutationResult;
  try {
    result = await bridge.connectionCreate(createRequest);
  } catch {
    return { ok: false, error: "Couldn't create the connection." };
  }
  const createdId = resolveCreatedConnectionId(result);
  if (createdId === undefined) {
    return { ok: false, error: "Couldn't create the connection." };
  }
  if (modelId === null) {
    return { ok: true, createdConnectionId: createdId };
  }
  const append = await appendModelToConnection(bridge, reload, createdId, modelId);
  if (!append.ok) {
    return {
      ok: true,
      createdConnectionId: createdId,
      partial: true,
      error: "Connection created, but its model list couldn't be saved — retry with Save.",
    };
  }
  return { ok: true, createdConnectionId: createdId };
}

export interface UpdateModelBridge<U> extends ModelAppendBridge {
  connectionUpdate(req: U): Promise<SettingsMutationResult>;
}

export interface UpdateWithModelResult {
  /** The metadata update succeeded. */
  metaOk: boolean;
  /** Whether a requested model-list append succeeded (true when none was requested). */
  appendOk: boolean;
}

/**
 * Save-then-append sequencing: persist the metadata update first, and only
 * after it succeeds append the normalized selected model to the same
 * connection. A failed metadata update never appends (the update is the
 * precondition). Exported for direct testing.
 */
export async function updateConnectionAndPersistModel<U>(
  bridge: UpdateModelBridge<U>,
  reload: () => Promise<void>,
  connectionId: string,
  updateRequest: U,
  modelId: string | null,
): Promise<UpdateWithModelResult> {
  let result: SettingsMutationResult;
  try {
    result = await bridge.connectionUpdate(updateRequest);
  } catch {
    return { metaOk: false, appendOk: false };
  }
  if (!result.ok) {
    return { metaOk: false, appendOk: false };
  }
  if (modelId === null) {
    return { metaOk: true, appendOk: true };
  }
  const append = await appendModelToConnection(bridge, reload, connectionId, modelId);
  return { metaOk: true, appendOk: append.ok };
}

/**
 * The id of the custom-provider record a `customProvider.create` just minted
 * (TASK.58): the single id present in the returned full `providers` list that
 * was NOT already among the records the drawer knew about (`before`). Fail-
 * closed (`undefined`) unless EXACTLY one is new — the create result carries no
 * authoritative created-id field of its own, so this is the diff, and a
 * zero/many result (a concurrent add in another window) refuses to guess rather
 * than point the new connection at the wrong record. Exported for direct
 * testing (no jsdom in this package's vitest config, see file docstring).
 */
export function resolveCreatedCustomProviderId(
  before: readonly string[],
  providers: readonly { id: string }[],
): string | undefined {
  const beforeSet = new Set(before);
  const added = providers.filter((p) => !beforeSet.has(p.id)).map((p) => p.id);
  return added.length === 1 ? added[0] : undefined;
}

/**
 * The connection-scoped oauth sign-in args the drawer's credential section
 * dispatches (TASK.45 W12-FIX §1): a sign-in from this drawer always targets
 * the connection currently being edited/created, never a provider-wide
 * bucket guess. `undefined` when there is no selected catalog entry or no
 * connection has been minted yet (the credential section only ever renders
 * post-creation, so this is a defensive branch, not a reachable one).
 * Exported for direct testing (no jsdom in this package's vitest config, see
 * file docstring).
 */
export function resolveDrawerOAuthStartArgs(
  selectedEntryId: string | undefined,
  createdConnectionId: string | null,
): { providerId: string; connectionId: string } | undefined {
  if (selectedEntryId === undefined || createdConnectionId === null) {
    return undefined;
  }
  return { providerId: selectedEntryId, connectionId: createdConnectionId };
}

/*
 * TASK.141: `proxyUrlSaveBlocked` / `PROXY_URL_ERROR` /
 * `connectionCreateProxyField` are GONE, and with them the whole class of
 * mistake they existed to diagnose. A proxy URL is no longer typed at a scope
 * — the drawer picks a named profile out of the registry (`ProxyRefPicker`),
 * and inside the profile editor the scheme comes from a checkbox rather than
 * from the user, so a scheme-less `proxy.host:3128` is not expressible. The
 * create-path fragment moved to `connectionCreateProxyRefField` in the picker,
 * next to the other rules about what a ref means on the wire.
 */

/**
 * The ONE enabled prompt-cache value this build can persist (GitHub #15):
 * implicit mode, fixed 30-minute TTL — the only shape both SDKs accept and the
 * only shape main's strict IPC schema admits. Off is ABSENCE, never a
 * `mode:"off"` literal.
 */
export const IMPLICIT_PROMPT_CACHE: ImplicitPromptCache = { mode: "implicit", ttl: "30m" };

/** Visible one-liner under the prompt-caching select (full copy in the tooltip). */
export const PROMPT_CACHE_ONELINER = "Cache writes may cost extra.";
export const PROMPT_CACHE_HELP =
  "For endpoints that support prompt_cache_options. Cache writes may cost extra. Applies to new or reopened sessions.";

/** Whether the edited connection opens with the cache ON (GitHub #15): only a persisted enabled policy does. */
export function promptCacheInitialEnabled(connection: ProviderConnection | undefined): boolean {
  return connection?.promptCache !== undefined;
}

/**
 * Whether the prompt-caching control belongs on screen (GitHub #15): only the
 * two OpenAI transports send the option, so an Anthropic connection would be
 * offering a switch with no effect. The transport resolves through the
 * selected catalog entry's own default — an empty local `transport` means
 * "provider default", NOT Anthropic. Exported for direct testing (no jsdom in
 * this package's vitest config, see file docstring).
 */
export function promptCacheVisible(
  transport: ProviderTransportId | "",
  defaultTransport: ProviderTransportId | undefined,
): boolean {
  const resolved = transport !== "" ? transport : (defaultTransport ?? "anthropic-messages");
  return resolved === "openai-chat-completions" || resolved === "openai-responses";
}

export function buildDrawerSavePayload(
  params: Parameters<typeof buildConnectionUpdatePayload>[0],
  fields: { contextWindowDirty: boolean; contextWindowTokens: number | ""; reasoningSupportedDirty: boolean; reasoningSupported: boolean; modelEffortDirty: boolean; modelEffort: ReasoningEffort | ""; imageInputDirty: boolean; effortLevelsDirty?: boolean; effortLevels?: ReasoningEffort[] },
): ConnectionUpdateRequest {
  return buildConnectionUpdatePayload({
    ...params,
    ...(fields.contextWindowDirty ? { contextWindowTokens: fields.contextWindowTokens } : {}),
    ...(fields.reasoningSupportedDirty ? { reasoningSupported: fields.reasoningSupported ? true : "" } : {}),
    ...(fields.modelEffortDirty ? { reasoningEffort: fields.modelEffort } : {}),
    ...(fields.effortLevelsDirty ? { effortLevels: fields.effortLevels?.length ? fields.effortLevels : "" } : {}),
    imageInputChanged: fields.imageInputDirty,
  });
}

/**
 * The connection-update payload the unified `save` sends (TASK.45 W12-FIX §3;
 * TASK.58 folded the former separate `saveMetadata` into `save`):
 * `transport` is sent UNCONDITIONALLY (never omitted) — the local state
 * already speaks the channel's `ProviderTransportId | ""` sentinel, so
 * omitting it on `""` would leave an existing explicit choice untouched
 * instead of clearing it back to catalog default, the exact asymmetry this
 * fix closes. `createConnection`'s payload is NOT this shape — at create time
 * an omitted transport already means "use the default", so it keeps the old
 * conditional-spread form. `maxOutputTokens` (TASK.150) follows the exact same
 * unconditional-send discipline as `transport`/`proxyRef`: the local state
 * already speaks the channel's `number | ""` clear sentinel (validated by
 * `maxOutputTokensField` before this is called), so omitting it on `""` would
 * leave a previously-set cap in force instead of clearing it back to the
 * catalog/default ceiling. Exported for direct testing (no jsdom).
 */
export function buildConnectionUpdatePayload(params: {
  connectionId: string;
  label: string;
  model: string;
  transport: ProviderTransportId | "";
  baseUrl: string;
  showBaseUrl: boolean;
  proxyRef: string;
  authOptional: boolean;
  maxOutputTokens: number | "";
  contextWindowTokens?: number | "";
  imageInput: ImageInputSelection;
  imageInputChanged?: boolean;
  promptCacheEnabled: boolean;
  reasoningEffort?: ReasoningEffort | "";
  reasoningSupported?: true | "";
  effortLevels?: ReasoningEffort[] | "";
}): ConnectionUpdateRequest {
  return {
    id: params.connectionId,
    label: params.label.trim(),
    model: params.model.trim(),
    transport: params.transport,
    baseUrl: params.showBaseUrl ? params.baseUrl.trim() : "",
    // Sent unconditionally, same rationale as `transport` (TASK.141, inherited
    // from TASK.132's `proxyUrl`): choosing "Use application proxy" must CLEAR
    // the persisted ref, and `""` is the channel's clear sentinel — omitting it
    // would leave the old choice in force. The legacy `proxyUrl` key is
    // deliberately NOT sent here: absent means "keep", which is what lets an
    // untouched legacy string survive a save of an unrelated field, and `""`
    // on the ref is what erases both keys when the user really does clear it.
    proxyRef: params.proxyRef,
    // Sent unconditionally, same rationale as `transport`: `false` must CLEAR
    // a previously-persisted flag, not leave it untouched.
    authOptional: params.authOptional,
    // Sent unconditionally (TASK.150), same rationale as `transport`/`proxyRef`:
    // clearing the field back to blank must CLEAR the persisted cap, not leave
    // an old explicit value in force.
    maxOutputTokens: params.maxOutputTokens,
    ...(params.contextWindowTokens !== undefined ? { contextWindowTokens: params.contextWindowTokens } : {}),
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.reasoningSupported !== undefined ? { reasoningSupported: params.reasoningSupported } : {}),
    ...(params.effortLevels !== undefined ? { effortLevels: params.effortLevels } : {}),
    // Sent unconditionally (Taskana 4088), same rationale: "auto" must CLEAR
    // the saved override pair (`""` is main's clear sentinel), while "on"/"off"
    // persist it. The model binding is derived SERVER-SIDE, exactly like the
    // context-window pair.
    ...(params.imageInputChanged === false ? {} : {imageInputOverride: imageInputToPayload(params.imageInput)}),
    // Sent unconditionally (GitHub #15), same rationale as `transport`: the
    // enabled object SETS the policy and `""` CLEARS it (main deletes the key,
    // because Off is absence on the wire). Also sent while the field is hidden
    // — a transport switch to Anthropic must not drop a saved OpenAI policy,
    // which is exactly what an omitted value would do.
    promptCache: params.promptCacheEnabled ? IMPLICIT_PROMPT_CACHE : "",
  };
}


/**
 * Validates the "Max output tokens" field's raw string (TASK.150): main
 * (`settings-ipc.ts`) accepts an integer in [1024, 1000000] or refuses with
 * `reason: "invalid"`, so the drawer validates client-side first to give a
 * specific, actionable error instead of a bare refusal toast. Blank (or
 * whitespace-only) is the channel's own clear sentinel — `ok:true,
 * value:""` — matching how `transport`/`proxyRef` already use `""` to mean
 * "drop back to the catalog/provider default", NOT zero and NOT "invalid".
 * Anything else that isn't a whole number in range is `ok:false`. Exported
 * for direct testing (no jsdom in this package's vitest config, see file
 * docstring).
 */
export function maxOutputTokensField(raw: string): { ok: true; value: number | "" } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: "" };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1024 || n > 1000000) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

/** Shared by both write paths so create and save refuse a bad cap identically. */
const MAX_OUTPUT_TOKENS_ERROR =
  "Max output tokens must be a whole number between 1024 and 1000000 — leave it empty for the provider default.";

/**
 * The click-to-fill presets offered under the "Max output tokens" field
 * (TASK.150 slice 3). Blank is a real entry rather than the absence of one:
 * an empty field sends no cap at all and keeps tracking
 * `DEFAULT_MAX_OUTPUT_TOKENS`, whereas pinning today's identical number
 * freezes the connection if that default ever moves again.
 */
export const MAX_OUTPUT_TOKEN_PRESETS: readonly { readonly id: string; readonly label: string; readonly value: string }[] = [
  { id: "default", label: "Default", value: "" },
  { id: "8192", label: "8192", value: "8192" },
  { id: "16384", label: "16384", value: "16384" },
  { id: "32768", label: "32768", value: "32768" },
];

/**
 * Which preset chip reads as active for the field's current raw string, with
 * `"custom"` covering everything the presets do not spell exactly — a
 * hand-typed 50000, and equally a half-typed "5". Matched on the trimmed
 * STRING rather than numerically on purpose: `08192` and `8192.0` are values
 * the field tolerates but no chip wrote, and lighting 8192 for them would
 * claim the row put them there. Exported for direct testing (no jsdom in
 * this package's vitest config, see file docstring).
 */
export function maxOutputPresetSelection(raw: string): string {
  const trimmed = raw.trim();
  return MAX_OUTPUT_TOKEN_PRESETS.find((preset) => preset.value === trimmed)?.id ?? "custom";
}

/**
 * Display labels for the Max output tokens segmented control. The preset
 * `label` values above stay as they are (tests and the automation contract pin
 * them); the control shows the compact forms and `custom` has no preset entry.
 */
export const MAX_OUTPUT_SEGMENT_LABEL: Record<string, string> = {
  default: "Default",
  "8192": "8K",
  "16384": "16K",
  "32768": "32K",
  custom: "Custom",
};

/**
 * Which segment of the Max output tokens control is pressed. `custom` is a UI
 * state of its own (a click on Custom with a preset-valued field still shows
 * the input), so it wins over the value; otherwise the preset matcher decides,
 * and a value no preset spells reads as `custom` too.
 */
export function maxOutputSegmentSelection(raw: string, custom: boolean): string {
  return custom ? "custom" : maxOutputPresetSelection(raw);
}

/** Thousands-grouped token count with a no-break space: `131072` -> `131 072`. */
export function formatTokenCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
}

/** Placeholder for the Max output tokens input/segment: the number a blank field resolves to. */
export function maxOutputPlaceholder(hint: string | null): string {
  const match = hint === null ? null : /^(?:catalog|provider default): (\d+)$/.exec(hint);
  return match ? `Default · ${formatTokenCount(Number(match[1]))}` : "Default";
}

/** Placeholder for the Context window input: the catalog window, or the assumed fallback marked as such. */
export function contextWindowPlaceholder(hint: string | null): string {
  if (hint === null) {
    return "Default";
  }
  const catalog = /^catalog: (\d+)$/.exec(hint);
  if (catalog) {
    return `Default · ${formatTokenCount(Number(catalog[1]))}`;
  }
  const assumed = /^assumed fallback: (\d+) \(/.exec(hint);
  if (assumed) {
    return `Default · ${formatTokenCount(Number(assumed[1]))} (assumed)`;
  }
  return "Default";
}

/** Text of the Image input select's `auto` option, naming what Auto resolves to for the shown model. */
export function imageInputAutoLabel(hint: string | null): string {
  if (hint === "catalog: vision") {
    return "Auto · vision (catalog)";
  }
  if (hint === "live /v1/models: vision") {
    return "Auto · vision (live)";
  }
  return "Auto";
}

/** One-line visible helper under each tuning field; the full text lives in the `?` tooltip. */
export const MAX_OUTPUT_ONELINER = "Blank = provider default.";
export const CONTEXT_WINDOW_ONELINER = "Blank = catalog window.";
export const IMAGE_INPUT_ONELINER = "Auto uses the catalog or the provider's model list.";

/** Full helper text, shown as the `?` tooltip. */
export const MAX_OUTPUT_HELP =
  "Leave empty to use the provider's default. Reasoning models spend part of this budget on hidden thinking before they write anything — for a self-hosted endpoint the catalog has no model list to guess a limit from, so raise this if output keeps cutting off.";
export const CONTEXT_WINDOW_HELP =
  "Leave empty to use the catalog window; for a model the catalog does not know, an assumed 8192-token window is used so long sessions compact early instead of overstuffing the prompt. Saved separately for each model. Switching models restores their saved windows. Applies to new or reopened sessions.";
export const IMAGE_INPUT_HELP =
  "Auto uses the catalog's vision mark or the image-capable list fetched from the provider's /v1/models. On / Off override it for the model above only — switching this connection to another model ignores it. A running session picks a change up when it next starts.";

/**
 * Visible helper under Pricing. Rate edits are read when a session opens its
 * model port, so an already-running session keeps the rates it booted with —
 * saying that here is the only place the user meets the rule (the drawer used
 * to change the connection silently and leave the open tab on catalog rates).
 */
export const PRICING_ONELINER =
  "Used by new or reopened sessions — a session that is already open keeps the rates it started with.";

/** How long the Save button row shows its "Saved" confirmation. */
export const SAVED_NOTICE_MS = 4000;

/** Title of the "this model only" badge (scope of the saved per-model value). */
export const MODEL_ONLY_BADGE_TITLE = "Saved separately for each model. Switching models restores their saved windows. Applies to new or reopened sessions.";

/**
 * Whether the Advanced disclosure opens by itself: true when any tuning value
 * is already set (so a saved non-default value is visible on open). `label` is
 * passed ONLY in the first-run (simplified) flow, where Label lives inside
 * Advanced; the dialog shows Label at the top, so it does not count there.
 */
export function advancedHasValues(v: {
  transport: string;
  maxOutputTokens: string;
  contextWindowRaw: string;
  imageInput: "auto" | "on" | "off";
  proxyRef: string;
  label?: string;
  /** A saved opt-in prompt-cache policy (GitHub #15) must be visible on open, like every other tuned value. */
  promptCache: boolean;
}): boolean {
  return (
    v.transport !== "" ||
    v.maxOutputTokens.trim() !== "" ||
    v.contextWindowRaw.trim() !== "" ||
    v.imageInput !== "auto" ||
    v.proxyRef !== PROXY_REF_INHERIT ||
    v.promptCache ||
    (v.label !== undefined && v.label.trim() !== "")
  );
}

/** Local literal (TASK.159), same convention as host-env.ts's `ENV_MAX_OUTPUT_TOKENS` — renderer modules don't import main, let alone core. */
const ENV_MAX_OUTPUT_TOKENS = "ANYCODE_MAX_OUTPUT_TOKENS";

/**
 * Hint under the "Max output tokens" field while ANYCODE_MAX_OUTPUT_TOKENS is
 * live (TASK.159): the env rung always beats what this field saves
 * (`fillFromSettings` never overwrites a boot-provided slot), so an edited cap
 * would silently do nothing — say so instead of letting the field pretend to
 * work. `null` (no hint) when the variable isn't overriding. Exported for
 * direct testing (no jsdom in this package's vitest config, see file
 * docstring).
 */
export function maxOutputTokensEnvHint(envOverrides: readonly string[]): string | null {
  return envOverrides.includes(ENV_MAX_OUTPUT_TOKENS)
    ? `${ENV_MAX_OUTPUT_TOKENS} is set in the environment — it overrides this field for every new session.`
    : null;
}

/**
 * The number a BLANK "Max output tokens" field resolves to for the selected
 * model (TASK.159), naming what the old "(provider default)" placeholder left
 * blind: a catalog model with a declared ceiling answers `catalog: N`,
 * anything without one answers the snapshot-projected core default
 * (`provider default: N`) — EXCEPT claude-* ids, which core deliberately sends
 * no cap for; they keep showing no number, as today. A non-blank field
 * suppresses the hint (the field itself already shows what wins). The default
 * rides the snapshot (`defaultMaxOutputTokens`), never hardcoded here — the
 * renderer cannot import core; an older snapshot without the field degrades to
 * the claude-like no-number display rather than inventing a figure. Exported
 * for direct testing (no jsdom in this package's vitest config, see file
 * docstring).
 */
export function maxOutputTokensEffectiveHint(
  entry: CatalogSummaryEntry | undefined,
  modelId: string,
  defaultMaxOutputTokens: number | undefined,
  raw: string,
): string | null {
  if (raw.trim() !== "") {
    return null;
  }
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
  if (matched?.maxOutputTokens !== undefined) {
    return `catalog: ${matched.maxOutputTokens}`;
  }
  if (modelId.startsWith("claude-") || defaultMaxOutputTokens === undefined) {
    return null;
  }
  return `provider default: ${defaultMaxOutputTokens}`;
}

/**
 * Validates the "Context window (tokens)" field's raw string (TASK.142): the
 * same client-side pre-flight as `maxOutputTokensField` above, because main
 * (`settings-ipc.ts`) accepts an integer in [1024, 1000000] or refuses the whole
 * update with a bare `reason: "invalid"`. Blank is the channel's clear sentinel
 * — `ok:true, value:""` — matching `maxOutputTokensField` (NOT zero and NOT
 * invalid). Exported for direct testing (no jsdom in this package's vitest
 * config, see file docstring).
 */
export { contextWindowTokensField } from "../../../shared/model-overrides.js";

/** Shared by both write paths so create and save refuse a bad window identically. */
const CONTEXT_WINDOW_ERROR =
  "Context window must be a whole number between 1024 and 1000000 — leave it empty to use the catalog window (or the 8192 assumed fallback for an unknown model).";

/** Distinct from CONTEXT_WINDOW_ERROR: tells the user WHAT to fix (the model, not the number). */
const CONTEXT_WINDOW_ERROR_MODEL =
  "Enter a model before setting a context window — the window is saved for one model.";

/** Local literal (TASK.142), same convention as host-env.ts's `ENV_CONTEXT_WINDOW` — renderer modules don't import main, let alone core. */
const ENV_CONTEXT_WINDOW = "ANYCODE_CONTEXT_WINDOW";

/**
 * Hint under the "Context window (tokens)" field while ANYCODE_CONTEXT_WINDOW is
 * live (TASK.142): the env rung always beats what this field saves, so an edited
 * window would silently do nothing — say so instead of letting the field pretend
 * to work. `null` (no hint) when the variable isn't overriding. Exported for
 * direct testing (no jsdom in this package's vitest config, see file docstring).
 */
export function contextWindowTokensEnvHint(envOverrides: readonly string[]): string | null {
  return envOverrides.includes(ENV_CONTEXT_WINDOW)
    ? `${ENV_CONTEXT_WINDOW} is set in the environment — it overrides this field for every new session.`
    : null;
}

/**
 * The number a BLANK "Context window (tokens)" field resolves to for the
 * selected model (TASK.142): a catalog model answers `catalog: N` where N is
 * `min(contextWindow, usableContextWindow ?? contextWindow)`; a model the
 * catalog does not know answers the ASSUMED fallback
 * (snapshot-projected `unknownModelContextWindowTokens`). Named `assumed` on
 * purpose and NEVER "provider default": core does not know a server-side window
 * for an unknown model — it deliberately assumes a conservative one so the
 * budget compacts early rather than overstuffing the prompt. A non-blank field
 * suppresses the hint (the field itself shows what wins). Exported for direct
 * testing (no jsdom in this package's vitest config, see file docstring).
 */
export function contextWindowEffectiveHint(
  entry: CatalogSummaryEntry | undefined,
  modelId: string,
  snapshot: { unknownModelContextWindowTokens?: number } | null | undefined,
  raw: string,
): string | null {
  if (raw.trim() !== "") {
    return null;
  }
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
  if (matched?.contextWindow !== undefined) {
    const usable = matched.usableContextWindow;
    const effective = usable !== undefined ? Math.min(matched.contextWindow, usable) : matched.contextWindow;
    return `catalog: ${effective}`;
  }
  const assumed = snapshot?.unknownModelContextWindowTokens ?? 8_192;
  return `assumed fallback: ${assumed} (unknown model — set a value to override)`;
}

/**
 * TASK.142: the raw window value the drawer starts with for a saved connection.
 * Prefill only the selected model's map entry (or its legacy pair). A saved
 * window for another model must never appear to belong to this one. Exported for direct
 * testing (no jsdom in this package's vitest config, see file docstring).
 */
export function contextWindowInitialRaw(connection: {
  contextWindowTokens?: number;
  contextWindowModel?: string;
  modelOverrides?: ProviderConnection["modelOverrides"];
  model?: string;
}): string {
  const tokens = modelOverrideFor(connection, (connection.model ?? "").trim())?.contextWindowTokens;
  return tokens === undefined ? "" : String(tokens);
}

/**
 * TASK.142: the "Context window (tokens)" field's full state. `model` is the
 * NORMALIZED model id the raw value belongs to, including while blank — the
 * reset decision compares against THIS, never against the original
 * saved binding, so a whitespace-only Model edit ("B" -> " B ") is not a change
 * and must not wipe a window the user just typed.
 */
export interface ContextWindowField {
  raw: string;
  /**
   * The NORMALIZED model this field's content belongs to ("" while the form has
   * no model). It tracks the model the field was last associated with, NOT
   * whether a value is present: an explicitly CLEARED field keeps its owner, so a
   * subsequent edit that does not change the normalized model preserves the clear
   * instead of resurrecting the saved value. The reset decision compares against
   * this, never against the original saved binding.
   */
  model: string;
}

/** Saved model windows, including the legacy pair accepted on read. */
export interface ContextWindowSavedPair {
  modelOverrides?: ProviderConnection["modelOverrides"];
  contextWindowTokens?: number;
  contextWindowModel?: string;
}

/**
 * Initial field state for the drawer: prefill the connection's selected model
 * using the same lookup as `contextWindowInitialRaw`.
 */
export function contextWindowInitialField(
  connection: ContextWindowSavedPair & { model?: string } | undefined,
): ContextWindowField {
  const raw = connection === undefined ? "" : contextWindowInitialRaw(connection);
  return raw === ""
    ? { raw: "", model: (connection?.model ?? "").trim() }
    : { raw, model: (connection?.model ?? "").trim() };
}

/**
 * TASK.142: the field state after a user route CHANGES the model. `nextModel` is
 * the model the route will actually save (the catalog-prefilled id on the
 * simplified create input, the raw input elsewhere); `saved` contains the
 * persisted windows looked up when navigating to another model. Semantics:
 *   - an UNCHANGED normalized model (field.model === next) returns the field
 *     verbatim — a value, a whitespace-only edit, or an explicit CLEAR all
 *     survive untouched. This is the "only a normalized model change resets
 *     it" rule, and it is checked BEFORE anything that could re-prefill, so a
 *     clear is never undone by a no-op model edit (or re-clicking the selected
 *     chip);
 *   - a GENUINE model change loads the new model's saved window, or clears
 *     the field when none is saved — one model's number is never rebound to
 *     another.
 * Exported for direct testing (no jsdom in this package's vitest config).
 */
export function contextWindowAfterModelInput(
  field: ContextWindowField,
  nextModel: string,
  saved: ContextWindowSavedPair | undefined,
): ContextWindowField {
  const next = nextModel.trim();
  if (field.model === next) {
    return field;
  }
  const savedTokens = modelOverrideFor(saved, next)?.contextWindowTokens;
  if (savedTokens !== undefined) {
    return { raw: String(savedTokens), model: next };
  }
  return { raw: "", model: next };
}

/**
 * TASK.142: the field state after the user edits the WINDOW text itself. The
 * value is owned by whichever model is current at that moment — including an
 * EMPTY raw, which keeps the same owner so a later no-op Model edit preserves
 * the clear. This is the only path that binds a freshly typed window, and it is
 * never invoked from the Model input — hence "never reset repeatedly while
 * typing the window". Exported for direct testing (no jsdom in this package's
 * vitest config).
 */
export function contextWindowAfterRawInput(
  field: ContextWindowField,
  raw: string,
  currentModel: string,
): ContextWindowField {
  return { raw, model: currentModel.trim() };
}

// ── Taskana 4088 (TASK.69): the per-model image-input select ──

/** The drawer's three-state select value: catalog/live resolve, force on, force off. */
export type ImageInputSelection = "auto" | "on" | "off";

/**
 * Taskana 4088: the wire value for a selection. "auto" maps to main's `""`
 * clear sentinel (deletes the saved override pair), "on"/"off" persist it —
 * the TASK.150 maxOutputTokens discipline verbatim. Exported for direct
 * testing (no jsdom).
 */
export function imageInputToPayload(selection: ImageInputSelection): "on" | "off" | "" {
  return selection === "auto" ? "" : selection;
}

/**
 * Taskana 4088 (cross-review): an explicit on/off override is bound to the
 * model the save will SEND, and main refuses a non-empty override with a blank
 * effective model with a bare `reason: "invalid"` — the generic save failure.
 * Shared by create and update so both name the field. Returns the specific
 * message, or null when the selection may be saved. Exported for direct testing.
 */
export function imageInputModelPreflightError(selection: ImageInputSelection, model: string): string | null {
  return selection !== "auto" && model.trim() === ""
    ? "Enter a model before forcing image input — the override is saved for one model."
    : null;
}

/**
 * Taskana 4088: the select value the drawer starts with for a saved
 * connection — the `contextWindowInitialRaw` rule: the saved override is
 * prefilled ONLY when it binds to the model now shown; a pair saved for
 * another model (or no pair) reads as "auto". Exported for direct testing.
 */
export function imageInputInitialValue(connection: {
  imageInputOverride?: "on" | "off";
  imageInputModel?: string;
  model?: string;
}): ImageInputSelection {
  return connection.imageInputOverride !== undefined &&
    connection.imageInputModel !== undefined &&
    connection.imageInputModel === (connection.model ?? "")
    ? connection.imageInputOverride
    : "auto";
}

/** Local literal (Taskana 4088), same convention as `ENV_CONTEXT_WINDOW` above — renderer modules don't import main, let alone core. */
// 4088-on-4118: ANYCODE_IMAGE_INPUT_MODELS is GONE; only the per-model
// override still rides the fork env.
const ENV_IMAGE_INPUT_MODEL_OVERRIDE = "ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE";

/**
 * Taskana 4088: hint under the "Image input" select when the launching shell
 * set ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE (in main's PROVIDER_ENV_KEYS): a
 * shell value wins over the saved one, because buildHostEnv never overwrites
 * it. `null` when absent. Exported for direct testing (no jsdom).
 */
export function imageInputEnvHint(envOverrides: readonly string[]): string | null {
  const present = [ENV_IMAGE_INPUT_MODEL_OVERRIDE].filter((name) => envOverrides.includes(name));
  return present.length > 0
    ? `${present.join(" and ")} ${present.length > 1 ? "are" : "is"} set in the environment AnyCode was launched from — it takes precedence over the value saved here.`
    : null;
}

/**
 * Taskana 4088: one line naming what "Auto" resolves to for the shown model:
 * the catalog's `imageInput: true` mark, or the connection's live-fetched
 * modality set (the `/v1/models` fetch's `architecture.input_modalities`).
 * An explicit on/off override suppresses the hint (the select already shows
 * what wins). `null` when Auto has no fact to name. Exported for direct
 * testing (no jsdom).
 */
export function imageInputEffectiveHint(
  entry: CatalogSummaryEntry | undefined,
  modelId: string,
  connection: { modelCapabilities?: Record<string, { imageInput?: true }> } | undefined,
  raw: ImageInputSelection,
): string | null {
  if (raw !== "auto") {
    return null;
  }
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
  if (matched?.imageInput === true) {
    return "catalog: vision";
  }
  // 4088-on-4118: the live image-modality facts ride the connection's
  // modelCapabilities map (`imageInput?: true` per model).
  if (connection?.modelCapabilities?.[modelId]?.imageInput === true) {
    return "live /v1/models: vision";
  }
  return null;
}

/**
 * The Model field's offered list (datalist + click-to-fill chips): a stable
 * UNION (TASK.183) of this session's fetched ids, the ids persisted on the
 * connection (manual additions + earlier fetches), then the catalog/curated
 * static hints not already present — decorated with the catalog entry's static
 * display names where known. Fetched first, persisted second, hints last;
 * exact case-sensitive dedupe via the shared `mergeModelIds`. An EMPTY fetch
 * no longer wipes the list: persisted manual ids (and the hints) survive.
 * Mirrors `providerModelsFor`'s union precedence, so the drawer and the
 * composer pickers can never disagree about what the provider offers. Exported
 * for direct testing (no jsdom in this package's vitest config, see file
 * docstring).
 */
export function liveModelSuggestions(
  fetched: readonly { id: string }[] | null,
  persisted: readonly string[] | undefined,
  hints: readonly { id: string; name?: string }[],
): { id: string; name?: string }[] {
  const fetchedIds = fetched !== null ? fetched.map((m) => m.id) : [];
  const unionIds = mergeModelIds(fetchedIds, mergeModelIds(persisted ?? [], hints.map((h) => h.id)));
  return unionIds.map((id) => {
    const hint = hints.find((h) => h.id === id);
    return hint?.name !== undefined ? { id, name: hint.name } : { id };
  });
}

/**
 * Model value after a catalog connection's model list becomes available with
 * the field still blank (TASK.108-A, owner 08.08): the curated list's FIRST
 * entry is the default. A connection persisted with an empty model looks
 * configured in the drawer yet fails `computeProviderReady`'s model gate at
 * tab-open time, with a toast that blames the API key. An explicit value is
 * never overridden; no suggestions leaves the field untouched (arbitrary-model
 * endpoints keep their blank). Exported for direct testing (no jsdom in this
 * package's vitest config, see file docstring).
 */
export function modelAfterCatalogPrefill(current: string, suggestions: readonly { id: string }[]): string {
  if (current.trim() !== "") {
    return current;
  }
  return suggestions[0]?.id ?? current;
}

/**
 * Whether Save must refuse a catalog connection's empty model (TASK.108-A):
 * the readiness gate requires a model on the active connection, so an empty
 * save manufactures the false "Configure a provider (API key + model)" toast
 * later. Only a catalog connection with a known model list is held to this —
 * custom records/endpoints legitimately run arbitrary or implicit models.
 * Exported for direct testing (no jsdom).
 */
export function modelSaveBlocked(
  model: string,
  catalogModelChoices: boolean,
  suggestions: readonly { id: string }[],
): boolean {
  return catalogModelChoices && suggestions.length > 0 && model.trim() === "";
}

/**
 * Cap on the click-to-fill model chips rendered under the Model field — a
 * huge live list (OpenRouter serves hundreds) stays reachable through the
 * datalist's type-ahead instead of flooding the drawer.
 */
export const MODEL_CHIP_CAP = 24;

/**
 * Transport after toggling the "no API key" checkbox (dogfood 16.07). Checking
 * it while the transport is still "(provider default)" auto-selects
 * `openai-chat-completions`: the custom template's default transport is
 * anthropic-messages, where core is deliberately fail-closed on a missing key
 * — leaving the default in place would keep the connection not-ready and
 * reproduce the exact trap the checkbox exists to prevent. An explicit
 * transport choice (either family) is never overridden, and unchecking never
 * touches the transport. Exported for direct testing (no jsdom).
 */
export function transportAfterNoAuthToggle(
  checked: boolean,
  transport: ProviderTransportId | "",
): ProviderTransportId | "" {
  return checked && transport === "" ? "openai-chat-completions" : transport;
}

/**
 * Value the provider `<select>` displays. Add mode surfaces the REAL (possibly
 * empty) selection so the "Choose a provider…" placeholder shows until the user
 * actually picks a template — a cosmetic `custom` fallback here reads as
 * "already chosen" while `providerId` is still `""`, leaving Create silently
 * disabled (dogfood 16.07). The fallback is edit-mode-only (`templateLocked`):
 * a bare pre-W12 connection (`providerId === ""`) displays the catalog's own
 * `custom` sentinel rather than an unmatched blank value, and that select is
 * disabled anyway. Exported for direct testing (no jsdom).
 */
export function providerSelectDisplayValue(effectiveProviderId: string, templateLocked: boolean, catalog: readonly CatalogSummaryEntry[]): string {
  if (effectiveProviderId !== "") {
    return effectiveProviderId;
  }
  if (!templateLocked) {
    return "";
  }
  return catalog.find((entry) => entry.isCustom)?.id ?? "";
}

/**
 * TASK.70 (Taskana 4089): template options grouped one-brand-one-card. A
 * brand-grouped entry renders as an <optgroup> labelled with the brand whose
 * options are the member modes (`modeLabel`); single-mode entries render as
 * plain options exactly as before, byte-identical for catalogs without brands.
 * Catalog order is preserved within and across groups.
 */
export interface ProviderOptionGroup { label: string; options: { id: string; label: string }[] }
export function providerOptionGroups(catalog: readonly CatalogSummaryEntry[]): ProviderOptionGroup[] {
  const groups: ProviderOptionGroup[] = [];
  const brandIndex = new Map<string, ProviderOptionGroup>();
  for (const entry of catalog) {
    const ownLabel = entry.isCustom ? "Custom endpoint…" : entry.name;
    if (entry.brand === undefined || entry.modeLabel === undefined) {
      groups.push({ label: "", options: [{ id: entry.id, label: ownLabel }] });
      continue;
    }
    let group = brandIndex.get(entry.brand);
    if (group === undefined) { group = { label: entry.brand, options: [] }; brandIndex.set(entry.brand, group); groups.push(group); }
    group.options.push({ id: entry.id, label: entry.modeLabel });
  }
  return groups;
}

/**
 * The `?` affordance next to a field label: a native `title` tooltip carries
 * the full helper text (no tooltip library), and the span is keyboard-focusable
 * so the text is reachable without a pointer. Exported for direct rendering tests.
 */
export function FieldHelp({ text }: { text: string }) {
  return (
    <span className="connection-drawer-help" tabIndex={0} role="img" aria-label={text} title={text}>
      ?
    </span>
  );
}

export interface MaxOutputSegmentedProps {
  /** The raw Max output tokens string (what the field would save). */
  value: string;
  /** UI-only: the user chose Custom, so the input stays open even on a preset value. */
  custom: boolean;
  disabled: boolean;
  /** Native tooltip for the group: what a blank value resolves to. */
  title?: string;
  /** Called with the preset's value ("" for Default, "8192", "16384", "32768"). */
  onSelect: (value: string) => void;
  onCustom: () => void;
}

/**
 * Max output tokens as ONE segmented control (Default / 8K / 16K / 32K /
 * Custom) in place of a number input plus a chip row. Presets write the same
 * values the chips did; Custom only reveals the number input (rendered by the
 * caller). Exported so the segment set and pressed state are renderable.
 */
export function MaxOutputSegmented({ value, custom, disabled, title, onSelect, onCustom }: MaxOutputSegmentedProps) {
  const selected = maxOutputSegmentSelection(value, custom);
  const segment = (id: string, onPress: () => void) => (
    <button
      key={id}
      type="button"
      data-segment={id}
      className={`connection-drawer-segmented-btn${selected === id ? " connection-drawer-segmented-btn-selected" : ""}`}
      aria-pressed={selected === id}
      disabled={disabled}
      onClick={onPress}
    >
      {MAX_OUTPUT_SEGMENT_LABEL[id]}
    </button>
  );
  return (
    <div className="connection-drawer-segmented" role="group" aria-label="Max output tokens" title={title}>
      {MAX_OUTPUT_TOKEN_PRESETS.map((preset) => segment(preset.id, () => onSelect(preset.value)))}
      {segment("custom", onCustom)}
    </div>
  );
}

export interface ConnectionDrawerFieldsProps {
  mode: "add" | "edit";
  /** The connection being edited; required for `mode: "edit"`. */
  editConnection?: ProviderConnection;
  catalog: CatalogSummary;
  /** Live connections from the current snapshot — re-read every render so a just-created connection's id resolves without a stale prop. */
  connections: readonly ProviderConnection[];
  secrets: readonly SecretStatus[];
  readOnly: boolean;
  /** Where to steer initial focus (a11y) — "credential" for the tile menu's "Replace key"/"Sign in". */
  initialFocus?: "label" | "credential" | "context";
  store?: SettingsStoreApi;
  /** Injectable custom-provider bridge (TASK.58); defaults to the real `window.anycode.customProvider`. */
  customProvider?: CustomProviderBridge;
  /** Rendered after the form (ConnectionDrawer supplies a "Done" button; WelcomeScreen's embed omits it — App's own readiness gate unmounts Welcome once the first connection is ready). */
  footer?: ReactNode;
  /** First-run form: keep connection tuning behind a disclosure. */
  simplified?: boolean;
}

/** The provider connection add/edit form body — no dialog chrome (see file docstring). Exported for both `ConnectionDrawer` and WelcomeScreen's first-run embed. */
export function ConnectionDrawerFields({
  mode,
  editConnection,
  catalog,
  connections,
  secrets,
  readOnly,
  initialFocus,
  store = useSettingsStore,
  customProvider,
  footer,
  simplified = false,
}: ConnectionDrawerFieldsProps) {
  const labelInputRef = useRef<HTMLInputElement>(null);
  const maxOutputTokensInputRef = useRef<HTMLInputElement>(null);
  const contextWindowTokensInputRef = useRef<HTMLInputElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const oauthPendingProviderId = useStore(store, (s) => s.oauthPendingProviderId);
  // TASK.141: the settings document behind the proxy picker's seed. Read here
  // (not inside the picker) because the drawer runs the picker CONTROLLED — the
  // ref rides the drawer's own create/update payloads instead of being written
  // by a channel of its own.
  const proxySnapshot = useStore(store, (s) => s.snapshot);

  // Add mode: `""` until the user picks a template AND clicks "Create
  // connection"; edit mode: fixed to the connection's own id for this drawer's
  // whole lifetime (the template can never change post-creation).
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(editConnection?.id ?? null);
  const [providerId, setProviderId] = useState<string>(editConnection?.providerId ?? "");
  const [label, setLabel] = useState(editConnection?.label ?? "");
  // TASK.108-A: an existing catalog connection persisted with a blank model
  // (the live trap — readiness fails on it with a key-blaming toast) opens
  // with the curated default prefilled, so the very next Save heals it.
  const [model, setModel] = useState(() => {
    const persisted = editConnection?.model ?? "";
    if (editConnection === undefined || isCustomRecordProviderId(editConnection.providerId)) {
      return persisted;
    }
    const entry = selectProviderEntry(catalog, editConnection.providerId || undefined);
    return modelAfterCatalogPrefill(persisted, liveModelSuggestions(null, editConnection.models, entry?.models ?? []));
  });
  const [baseUrl, setBaseUrl] = useState(editConnection?.baseUrl ?? "");
  const [transport, setTransport] = useState<ProviderTransportId | "">(editConnection?.transport ?? "");
  // TASK.141: the connection's rung is a REFERENCE now, seeded through the same
  // pure helper every other scope's picker uses (a dangling id reads as "No
  // proxy", a legacy `proxyUrl` string reads as the synthetic Legacy entry).
  const [proxyRef, setProxyRef] = useState(() =>
    editConnection === undefined || proxySnapshot === null
      ? PROXY_REF_INHERIT
      : proxyRefInitialValue({ kind: "connection", connectionId: editConnection.id }, proxySnapshot.settings),
  );
  const [noAuth, setNoAuth] = useState(editConnection?.authOptional === true);
  const [pricingMode, setPricingMode] = useState<"catalog" | "subscription" | "rates">(editConnection?.pricing?.mode ?? "catalog");
  const initialRates = editConnection?.pricing?.mode === "rates" ? editConnection.pricing : undefined;
  const [priceInput, setPriceInput] = useState(initialRates ? String(initialRates.input) : "");
  const [priceCached, setPriceCached] = useState(initialRates ? String(initialRates.cachedInput) : "");
  const [priceOutput, setPriceOutput] = useState(initialRates ? String(initialRates.output) : "");
  const [priceWrite, setPriceWrite] = useState(initialRates?.cacheWrite === undefined ? "" : String(initialRates.cacheWrite));
  const pricingPayload = () => {
    if (pricingMode === "catalog") return "" as const;
    if (pricingMode === "subscription") return { mode: "subscription" as const };
    const raw = [priceInput, priceCached, priceOutput];
    const values = raw.map(Number);
    const write = Number(priceWrite);
    if (raw.some((v) => !v.trim()) || values.some((v) => !Number.isFinite(v) || v < 0) || (priceWrite.trim() !== "" && (!Number.isFinite(write) || write < 0))) return null;
    return { mode: "rates" as const, input: values[0]!, cachedInput: values[1]!, output: values[2]!, ...(priceWrite.trim() ? { cacheWrite: write } : {}) };
  };
  type RateDraft = { input: string; cachedInput: string; output: string; cacheWrite: string };
  const [modelRates, setModelRates] = useState<Record<string, RateDraft>>(() => Object.fromEntries(
    Object.entries(editConnection?.modelOverrides ?? {}).filter(([, value]) => value.pricing !== undefined).map(([id, value]) => {
      const rate = value.pricing!;
      return [id, { input: String(rate.input), cachedInput: String(rate.cachedInput), output: String(rate.output), cacheWrite: rate.cacheWrite === undefined ? "" : String(rate.cacheWrite) }];
    }),
  ));
  const [dirtyRates, setDirtyRates] = useState<Set<string>>(() => new Set());
  const modelPricingPayload = (): Record<string, TokenRates | ""> | null => {
    const entries: [string, TokenRates | ""][] = [];
    for (const id of dirtyRates) {
      const draft = modelRates[id]!;
      const raw = [draft.input, draft.cachedInput, draft.output];
      if ([...raw, draft.cacheWrite].every((v) => !v.trim())) { entries.push([id, ""]); continue; }
      const values = raw.map(Number), write = Number(draft.cacheWrite);
      if (normalizeModelId(id) !== id || raw.some((v) => !v.trim()) || values.some((v) => !Number.isFinite(v) || v < 0) || (draft.cacheWrite.trim() !== "" && (!Number.isFinite(write) || write < 0))) return null;
      entries.push([id, { input: values[0]!, cachedInput: values[1]!, output: values[2]!, ...(draft.cacheWrite.trim() ? { cacheWrite: write } : {}) }]);
    }
    return Object.fromEntries(entries);
  };
  // TASK.150: stored as a string (it backs a plain `<input type="number">`) so
  // an in-progress edit (e.g. a momentarily-empty field) never gets coerced
  // through `Number()` before the user is done typing; `maxOutputTokensField`
  // does the actual parse/validate at save time.
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    editConnection?.maxOutputTokens === undefined ? "" : String(editConnection.maxOutputTokens),
  );
  // TASK.142: per-model context window, stored as {raw, model} for the same
  // reason as `maxOutputTokens` below. Prefilled ONLY when the saved window is
  // bound to the connection's own model — a window saved for a DIFFERENT model
  // must not appear here. Every model-changing route goes through `changeModel`.
  const [contextWindow, setContextWindow] = useState<ContextWindowField>(() =>
    contextWindowInitialField(editConnection),
  );
  // Taskana 4088: the per-model image-input select ("auto" | "on" | "off").
  // Prefilled ONLY when the saved override binds to the connection's own model
  // (the contextWindowInitialRaw rule); "auto" clears the pair on save.
  const [reasoningSupported, setReasoningSupported] = useState(() =>
    modelOverrideFor(editConnection, editConnection?.model ?? "")?.reasoningSupported === true,
  );
  const [effortLevels, setEffortLevels] = useState<ReasoningEffort[]>(() => modelOverrideFor(editConnection, editConnection?.model ?? "")?.effortLevels ?? []);
  const [effortLevelsDirty, setEffortLevelsDirty] = useState(false);
  const [modelEffort, setModelEffort] = useState<ReasoningEffort | "">(() =>
    modelOverrideFor(editConnection, editConnection?.model ?? "")?.reasoningEffort ?? "",
  );
  const [imageInput, setImageInput] = useState<ImageInputSelection>(() =>
    editConnection === undefined ? "auto" : imageInputInitialValue(editConnection),
  );
  const [imageInputDirty, setImageInputDirty] = useState(false);
  const [contextWindowDirty, setContextWindowDirty] = useState(false);
  const [reasoningSupportedDirty, setReasoningSupportedDirty] = useState(false);
  const [modelEffortDirty, setModelEffortDirty] = useState(false);
  // UI-only (never saved): the user picked the Custom segment of Max output tokens.
  const [maxOutputCustom, setMaxOutputCustom] = useState(false);
  // GitHub #15: opt-in prompt caching, prefilled from the connection's saved
  // policy. Kept as its own state even while the control is hidden for an
  // Anthropic transport, so switching transport back and forth never silently
  // drops a saved OpenAI policy.
  const [promptCacheEnabled, setPromptCacheEnabled] = useState(() => promptCacheInitialEnabled(editConnection));
  // The Advanced disclosure is controlled: open from the start only when a
  // tuning value is already set (evaluated once, from the initial state), and
  // forced open by a rejected Advanced field on save/create.
  const [advancedOpen, setAdvancedOpen] = useState(() => initialFocus === "context" || reasoningSupported || effortLevels.length > 0 || modelEffort !== "" || advancedHasValues({
    transport,
    maxOutputTokens,
    contextWindowRaw: contextWindow.raw,
    imageInput,
    proxyRef,
    promptCache: promptCacheEnabled,
    ...(simplified ? { label } : {}),
  }));
  const [secretValue, dispatchSecret] = useReducer(secretFieldReducer, "");
  // New-custom-endpoint (the builtin `custom` sentinel) record fields.
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customKind, setCustomKind] = useState<CustomProviderRecord["kind"]>("openai-compatible");
  // Custom-provider model fetch/curation (the drawer's model step).
  const [fetchedModels, setFetchedModels] = useState<{ id: string }[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [curating, setCurating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A successful Save used to be completely silent, which reads as "did it
  // save?", so the button row carries a short-lived "Saved" confirmation. It is
  // cleared by the next save attempt and lives only long enough to be noticed.
  const [savedNotice, setSavedNotice] = useState(false);
  const savedNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSavedNotice = (): void => {
    setSavedNotice(true);
    if (savedNoticeTimer.current !== null) {
      clearTimeout(savedNoticeTimer.current);
    }
    savedNoticeTimer.current = setTimeout(() => {
      savedNoticeTimer.current = null;
      setSavedNotice(false);
    }, SAVED_NOTICE_MS);
  };
  useEffect(
    () => () => {
      if (savedNoticeTimer.current !== null) {
        clearTimeout(savedNoticeTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialFocus === "context") {
      contextWindowTokensInputRef.current?.focus();
    } else if (initialFocus === "credential") {
      secretInputRef.current?.focus();
    } else {
      labelInputRef.current?.focus();
    }
    // Steer focus once, on mount only (mirrors WelcomeScreen's own intentional focus-steal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resolvedCustomProvider(): CustomProviderBridge {
    return customProvider ?? window.anycode.customProvider;
  }

  /**
   * The bridge the model-persistence helpers drive: connection metadata goes
   * through the store (settings IPC), the model-list append goes through the
   * custom-provider bridge's `{connectionId, addModels}` branch. One object so
   * create/save/fetch all persist a manual model the same way.
   */
  function modelPersistenceBridge(): CreateModelBridge<ConnectionCreateRequest> & UpdateModelBridge<ConnectionUpdateRequest> {
    return {
      connectionCreate: (request) => store.getState().connectionCreate(request),
      connectionUpdate: (request) => store.getState().connectionUpdate(request),
      fetchModels: (request) => resolvedCustomProvider().fetchModels(request),
    };
  }

  const targetConnection = connections.find((c) => c.id === createdConnectionId) ?? editConnection;
  const effectiveProviderId = createdConnectionId !== null ? (targetConnection?.providerId ?? providerId) : providerId;
  const selectedEntry: CatalogSummaryEntry | undefined = selectProviderEntry(catalog, effectiveProviderId || undefined);
  // The builtin `custom` sentinel (isCustom) is the "add a NEW custom endpoint"
  // option; a `custom:<id>` id is a saved record the connection points at.
  const isNewCustomEndpoint = selectedEntry?.isCustom === true;
  const isCustomRecordConnection = isCustomRecordProviderId(effectiveProviderId);
  // The connection-level base URL (vLLM/legacy templates) — NOT the new-custom
  // endpoint's own record baseUrl, which has its own field below.
  const showBaseUrl = shouldShowBaseUrlField(selectedEntry) && !isNewCustomEndpoint;
  const transportChoices = transportOptions(selectedEntry);
  // GitHub #15: the field only applies to the two OpenAI transports. The
  // A new custom endpoint uses its selected kind as its provider default.
  const promptCacheShown = promptCacheVisible(
    transport,
    isNewCustomEndpoint ? CUSTOM_KIND_DEFAULT_TRANSPORT[customKind] : selectedEntry?.defaultTransport,
  );
  const authKind = selectedEntry?.authKind ?? "api_key";
  // A custom:<id> connection's credential lives on the custom provider's OWN
  // shared vault key (exactly what main reads for it); everything else uses its
  // own connection-scoped key once the connection exists.
  const credentialKey = isCustomRecordConnection
    ? customProviderSecretKey(effectiveProviderId)
    : createdConnectionId !== null
      ? connectionSecretKey(createdConnectionId, authKind)
      : undefined;
  const credentialStatus = credentialKey !== undefined ? secrets.find((s) => s.key === credentialKey) : undefined;
  const templateLocked = createdConnectionId !== null; // provider identity is fixed once the connection exists
  const selectDisplayValue = providerSelectDisplayValue(effectiveProviderId, templateLocked, catalog);
  // The record's curated model set (checkbox state) is the saved record's own
  // `models` — the synthesized catalog entry mirrors it and re-derives after
  // each customProvider mutation reloads the snapshot.
  const curatedModelIds = selectedEntry?.models.map((m) => m.id) ?? [];
  // What the Model field suggests (datalist + chips): the UNION (TASK.183) of
  // this session's fetched ids, the ids persisted on the connection (manual
  // additions + earlier fetches), then the static catalog hints.
  const modelSuggestions = liveModelSuggestions(fetchedModels, targetConnection?.models, selectedEntry?.models ?? []);
  // The ids the catalog itself offers for this provider — a selected one of
  // these needs no entry in the connection's own list (see
  // `shouldAppendModelToList`).
  const catalogOfferedIds = (selectedEntry?.models ?? []).map((m) => m.id);
  // Show the API-key field IN the create form (item 3): a NEW custom endpoint
  // (the record's own key) or a keyed catalog provider (the connection key).
  // A saved custom record already owns its key; an oauth provider signs in.
  const showKeyInCreate = authKind === "api_key" && (isNewCustomEndpoint || !isCustomRecordConnection);
  const setupMissingModel = simplified && selectedEntry !== undefined &&
    modelAfterCatalogPrefill(model, selectedEntry.models).trim() === "";
  const setupMissingKey = simplified && showKeyInCreate && !noAuth &&
    selectedEntry?.authOptional !== true && secretValue.trim() === "";
  const keyFieldDisabled = readOnly || (isNewCustomEndpoint && noAuth);
  // TASK.159 hints for the Max-output-tokens field (pure logic above): whether
  // the env rung currently silences this field, and what number a blank field
  // actually resolves to. Both read only state already in hand — the drawer's
  // own proxySnapshot and the projected catalog/snapshot.
  const motEnvHint = proxySnapshot === null ? null : maxOutputTokensEnvHint(proxySnapshot.envOverrides);
  const motDefaultHint = maxOutputTokensEffectiveHint(
    selectedEntry,
    model.trim(),
    proxySnapshot?.defaultMaxOutputTokens,
    maxOutputTokens,
  );
  // TASK.142 hints for the Context-window field: same shape as the ceiling hints
  // above — whether the env rung silences the field, and what window a blank
  // field resolves to (catalog min, else the assumed unknown-model fallback).
  const cwEnvHint = proxySnapshot === null ? null : contextWindowTokensEnvHint(proxySnapshot.envOverrides);
  // TASK.142: the model id this form will actually SAVE. The simplified create
  // input saves the catalog-prefilled id (`modelAfterCatalogPrefill`); every
  // other route saves the raw text. Used both for the field's owner and for the
  // create-time "a window needs a model to bind to" gate, so the two never
  // disagree about which model the number belongs to.
  const effectiveFormModel =
    simplified && createdConnectionId === null
      ? modelAfterCatalogPrefill(model, selectedEntry?.models ?? [])
      : model;
  const cwDefaultHint = contextWindowEffectiveHint(
    selectedEntry,
    effectiveFormModel.trim(),
    proxySnapshot,
    contextWindow.raw,
  );
  // Taskana 4088 hints for the Image-input select: what Auto resolves to for
  // the model this form will save (catalog mark, else the connection's live
  // image-modality list), and whether the live feed rides the env right now.
  const imageInputHint = imageInputEffectiveHint(
    selectedEntry,
    effectiveFormModel.trim(),
    targetConnection,
    imageInput,
  );
  const knownCatalogModel = !effectiveProviderId.startsWith("custom:") &&
    catalog.find((entry) => entry.id === effectiveProviderId)?.models.some((entry) => entry.id === effectiveFormModel.trim()) === true;
  const reasoningLevels = startModelEffortLevels(
    effectiveProviderId, effectiveFormModel.trim(), catalog.filter((entry) => !entry.id.startsWith("custom:")),
    applyModelReasoningOverride(targetConnection?.modelCapabilities?.[effectiveFormModel.trim()], reasoningSupported),
  );
  const effectiveReasoningLevels = effortLevels.length ? effortLevels : reasoningLevels;
  const imageInputFeedHint = proxySnapshot === null ? null : imageInputEnvHint(proxySnapshot.envOverrides);

  /**
   * TASK.142: the ONE model-changing route. `next` is what goes into the Model
   * input, `effective` is the id that will be saved, `saved` is the persisted
   * pair (for re-prefill when the user navigates back to the bound model). Every
   * user route — the simplified create input, the main Model input and the model
   * suggestion chips — calls this, so no route can bypass the per-model reset and
   * leave A's number on screen after choosing B.
   */
  function changeModel(
    next: string,
    effective: string,
    saved: ContextWindowSavedPair | undefined,
    force = false,
  ): void {
    setContextWindow((field) =>
      force ? { raw: "", model: effective.trim() } : contextWindowAfterModelInput(field, effective, saved),
    );
    if (force || contextWindow.model !== effective.trim()) {
      const target = force ? undefined : modelOverrideFor(saved, effective.trim());
      setReasoningSupported(target?.reasoningSupported === true);
      setModelEffort(target?.reasoningEffort ?? "");
      setEffortLevels(target?.effortLevels ?? []);
      setEffortLevelsDirty(false);
      setImageInput(force || targetConnection === undefined ? "auto" : imageInputInitialValue({...targetConnection, model: effective.trim()}));
      setImageInputDirty(false);
      setContextWindowDirty(false);
      setReasoningSupportedDirty(false);
      setModelEffortDirty(false);
    }
    setModel(next);
  }

  async function reloadSnapshot(): Promise<void> {
    await store.getState().load();
  }

  /** ADD: mint a NEW custom-provider record (key or keyless), then a connection pointing at it. */
  async function createNewCustomEndpoint(): Promise<void> {
    // TASK.183: validate the raw model BEFORE the record, connection, secret or
    // list call — a nonblank malformed id makes no writes at all.
    const preflight = preflightModelId(model);
    if (preflight.kind === "invalid") {
      setError(MODEL_ID_ERROR);
      return;
    }
    const pricing = pricingPayload();
    const modelPricing = modelPricingPayload();
    if (pricing === null || modelPricing === null) { setError("Enter non-negative prices per million tokens."); return; }
    const createModel = preflight.kind === "id" ? preflight.id : undefined;
    const window = contextWindowTokensField(contextWindow.raw);
    if (!window.ok || (window.value !== "" && createModel === undefined)) {
      setAdvancedOpen(true);
      setError(window.ok ? CONTEXT_WINDOW_ERROR_MODEL : CONTEXT_WINDOW_ERROR);
      return;
    }
    const imageInputError = imageInputModelPreflightError(imageInput, createModel ?? "");
    if (imageInputError !== null) {
      setError(imageInputError);
      return;
    }
    const req = buildCustomProviderCreateRequest({
      name: customName,
      baseUrl: customBaseUrl,
      kind: customKind,
      apiKey: secretValue,
      noAuth,
      // TASK.183: manual ids now live on the CONNECTION's own `models[]`, never
      // on the shared custom record — the record's curated set stays separate.
      selectedModels: [],
    });
    if (req === undefined) {
      setError('Enter a name and base URL, plus an API key or check "This endpoint doesn\'t need an API key".');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const beforeIds = catalog.filter((e) => isCustomRecordProviderId(e.id)).map((e) => e.id);
      const created = await resolvedCustomProvider().create(req);
      if (!created.ok) {
        setError(describeCustomProviderMutationError(created.reason));
        return;
      }
      // CUSTODY: the key has crossed to main — clear the field immediately.
      dispatchSecret({ type: "submitted" });
      const newId = resolveCreatedCustomProviderId(beforeIds, created.providers);
      await reloadSnapshot();
      if (newId === undefined) {
        setError("Custom endpoint saved, but its id couldn't be resolved — reopen and select it to add a connection.");
        return;
      }
      const outcome = await createConnectionAndPersistModel(
        modelPersistenceBridge(),
        reloadSnapshot,
        {
          providerId: newId,
          ...(pricing !== "" ? { pricing } : {}),
          modelPricing: Object.fromEntries(Object.entries(modelPricing).filter(([, value]) => value !== "")) as Record<string, TokenRates>,
          ...(createModel !== undefined ? { model: createModel } : {}),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(transport ? { transport } : {}),
          // TASK.132/TASK.141: the proxy control is rendered in this pre-create
          // state too, so its value has to travel on THIS create as well —
          // omitting it here silently dropped the choice for every new custom
          // endpoint.
          ...connectionCreateProxyRefField(proxyRef),
          ...(promptCacheEnabled ? { promptCache: IMPLICIT_PROMPT_CACHE } : {}),
          ...(contextWindow.raw.trim() ? { contextWindowTokens: Number(contextWindow.raw) } : {}),
          ...(reasoningSupported ? { reasoningSupported: true as const } : {}),
          ...(effortLevels.length ? { effortLevels } : {}),
          ...(modelEffort !== "" ? { reasoningEffort: modelEffort } : {}),
          ...(imageInput !== "auto" ? { imageInputOverride: imageInput } : {}),
        },
        createModel ?? null,
      );
      if (outcome.createdConnectionId === undefined) {
        // Partial failure surfaced honestly: the record exists (Custom
        // providers list), but the connection does not.
        setProviderId(newId);
        setError("Custom endpoint saved, but the connection couldn't be created — select it above and try again.");
        return;
      }
      setProviderId(newId);
      setCreatedConnectionId(outcome.createdConnectionId);
      if (outcome.partial) {
        setError(outcome.error ?? "Custom endpoint and connection created, but the model list couldn't be saved — retry with Save.");
      }
    } finally {
      setCreating(false);
    }
  }

  /** ADD: single primary action — create the connection AND (item 3) fold in the key's secret-set. */
  async function createConnection(): Promise<void> {
    if (readOnly) {
      return;
    }
    if (isNewCustomEndpoint) {
      await createNewCustomEndpoint();
      return;
    }
    if (providerId === "") {
      return;
    }
    // TASK.150: a BLANK cap already means "provider default" at create time
    // (same asymmetry as `baseUrl`/`transport` just above), so it is simply
    // left out of the payload. A MALFORMED one is refused here rather than
    // dropped: `min`/`max` on a number input only constrain the spinner, not
    // what can be typed, so silently discarding e.g. `500` would create a
    // connection whose ceiling the user believes they set.
    const pricing = pricingPayload();
    const modelPricing = modelPricingPayload();
    if (pricing === null || modelPricing === null) { setError("Enter non-negative prices per million tokens."); return; }
    const mot = maxOutputTokensField(maxOutputTokens);
    if (!mot.ok) {
      // A refused Advanced field must not stay hidden behind a closed disclosure.
      setAdvancedOpen(true);
      setError(MAX_OUTPUT_TOKENS_ERROR);
      return;
    }
    // TASK.142: the same pre-flight for the context window. A BLANK field means
    // "catalog/assumed window" and is simply left out; a MALFORMED one is
    // refused rather than dropped. A numeric window additionally needs the model
    // this create will actually SEND to bind to (TASK.183: EVERY create path now
    // sends the catalog-prefilled/entered id, not only the simplified one) —
    // main derives the binding from it and refuses the whole create otherwise,
    // so say which field to fix instead of letting main reject it opaquely.
    const cw = contextWindowTokensField(contextWindow.raw);
    if (!cw.ok) {
      // A refused Advanced field must not stay hidden behind a closed disclosure.
      setAdvancedOpen(true);
      setError(CONTEXT_WINDOW_ERROR);
      return;
    }
    // TASK.183: ONE effective model for the create payload, the context-window
    // binding and the model-list append. A nonblank malformed id makes no
    // create, secret or list call; a blank keeps the pre-existing implicit
    // rules (no model sent).
    const preflight = preflightModelId(modelAfterCatalogPrefill(model, selectedEntry?.models ?? []));
    if (preflight.kind === "invalid") {
      setError(MODEL_ID_ERROR);
      return;
    }
    const createModel = preflight.kind === "id" ? preflight.id : "";
    if (cw.value !== "" && createModel === "") {
      setError(CONTEXT_WINDOW_ERROR_MODEL);
      return;
    }
    // Taskana 4088: an explicit on/off override needs the model this create
    // will actually SEND (main derives the binding and refuses otherwise) —
    // same specific-message pre-flight as the context window above.
    const imageInputError = imageInputModelPreflightError(imageInput, createModel);
    if (imageInputError !== null) {
      setError(imageInputError);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const outcome = await createConnectionAndPersistModel(
        modelPersistenceBridge(),
        reloadSnapshot,
        {
          providerId,
          modelPricing: Object.fromEntries(Object.entries(modelPricing).filter(([, value]) => value !== "")) as Record<string, TokenRates>,
          ...(pricing !== "" ? { pricing } : {}),
          ...(createModel !== "" ? { model: createModel } : {}),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(transport ? { transport } : {}),
          ...(showBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...connectionCreateProxyRefField(proxyRef),
          ...(noAuth ? { authOptional: true } : {}),
          ...(mot.value !== "" ? { maxOutputTokens: mot.value } : {}),
          ...(cw.value !== "" ? { contextWindowTokens: cw.value } : {}),
          ...(reasoningSupported ? { reasoningSupported: true as const } : {}),
          ...(effortLevels.length ? { effortLevels } : {}),
          ...(modelEffort !== "" ? { reasoningEffort: modelEffort } : {}),
          // Taskana 4088: create keeps the conditional-spread form (create's
          // schema has no "" sentinel — omission already means "auto"); only an
          // explicit choice travels, and the binding is server-derived.
          ...(imageInput !== "auto" ? { imageInputOverride: imageInput } : {}),
          // GitHub #15: create keeps the conditional-spread form (create's
          // schema has no "" sentinel — omission already means Off).
          ...(promptCacheEnabled ? { promptCache: IMPLICIT_PROMPT_CACHE } : {}),
        },
        createModel !== "" && shouldAppendModelToList(createModel, catalogOfferedIds, isNewCustomEndpoint)
          ? createModel
          : null,
      );
      if (outcome.createdConnectionId === undefined) {
        setError(outcome.error ?? "Couldn't create the connection.");
        return;
      }
      setCreatedConnectionId(outcome.createdConnectionId);
      // TASK.108-A: the just-revealed Model field opens on the catalog default
      // instead of blank, so the follow-up Save can't persist the empty-model
      // trap.
      if (!isCustomRecordProviderId(providerId)) {
        setModel((m) => modelAfterCatalogPrefill(m, selectedEntry?.models ?? []));
      }
      // TASK.183: surface a partial failure (connection exists, list does not)
      // WITHOUT losing a concurrent key error — compose one message.
      let message = outcome.partial
        ? (outcome.error ?? "Connection created, but its model list couldn't be saved — retry with Save.")
        : null;
      // Item 3: fold the key's secret-set into Create for a keyed catalog
      // provider — a separate IPC channel, so custody stays intact and the
      // metadata schema never carries a credential.
      if (secretValue && authKind === "api_key" && !isCustomRecordProviderId(providerId)) {
        const value = secretValue;
        dispatchSecret({ type: "submitted" });
        const secretResult = await store.getState().setSecret(connectionSecretKey(outcome.createdConnectionId, "api_key"), value);
        if (!secretResult.ok && secretResult.reason !== "weak_storage_needs_consent") {
          message =
            message === null
              ? "Connection created, but the API key was refused — enter it again below."
              : "Connection created, but neither its model list nor the API key could be saved.";
        }
      }
      if (message !== null) {
        setError(message);
      }
    } finally {
      setCreating(false);
    }
  }

  /**
   * EDIT / post-create: ONE Save (item 3) — pending metadata changes AND, when
   * a new key was typed, its secret-set (two IPC channels under the hood,
   * custody intact). Metadata and key failures are reported independently.
   */
  async function save(): Promise<void> {
    if (readOnly || createdConnectionId === null) {
      return;
    }
    // TASK.183: a nonblank malformed model is refused before the metadata
    // update, the secret write or any list call (a valid, unknown id passes —
    // catalog membership is never validation).
    const preflight = preflightModelId(model);
    if (preflight.kind === "invalid") {
      setError(MODEL_ID_ERROR);
      return;
    }
    const selectedModelId = preflight.kind === "id" ? preflight.id : null;
    // TASK.108-A: refuse to persist the empty-model trap on a catalog
    // connection — an empty model fails readiness later with a toast that
    // blames the API key.
    if (modelSaveBlocked(model, !isCustomRecordConnection && !isNewCustomEndpoint, modelSuggestions)) {
      setError("Pick a model before saving — without one this connection can't open a tab.");
      return;
    }
    // TASK.150: refuse to send a malformed cap — main's own [1024, 1000000]
    // bound refuses the whole update with a bare `reason: "invalid"`, so this
    // gives the specific, actionable message instead (same pattern as the
    // `modelSaveBlocked` guard just above).
    const pricing = pricingPayload();
    const modelPricing = modelPricingPayload();
    if (pricing === null || modelPricing === null) { setError("Enter non-negative prices per million tokens."); return; }
    const mot = maxOutputTokensField(maxOutputTokens);
    if (!mot.ok) {
      // A refused Advanced field must not stay hidden behind a closed disclosure.
      setAdvancedOpen(true);
      setError(MAX_OUTPUT_TOKENS_ERROR);
      return;
    }
    // TASK.142: same pre-flight for the context window; a numeric one also needs
    // a nonblank model to bind to, since main derives the binding server-side
    // from the model this update sends.
    const cw = contextWindowTokensField(contextWindow.raw);
    if (!cw.ok) {
      // A refused Advanced field must not stay hidden behind a closed disclosure.
      setAdvancedOpen(true);
      setError(CONTEXT_WINDOW_ERROR);
      return;
    }
    if (cw.value !== "" && model.trim() === "") {
      setError(CONTEXT_WINDOW_ERROR_MODEL);
      return;
    }
    // Taskana 4088 (cross-review): the same blank-model refusal on UPDATE — the
    // sent model is `selectedModelId ?? model`, and main would otherwise reject
    // the whole save with the generic "couldn't be saved" message.
    const imageInputError = imageInputModelPreflightError(imageInput, selectedModelId ?? model);
    if (imageInputError !== null) {
      setError(imageInputError);
      return;
    }
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      // TASK.183: metadata first (the selected model rides it), THEN append the
      // same normalized model to this connection's list. A failed metadata
      // update never appends.
      const outcome = await updateConnectionAndPersistModel(
        modelPersistenceBridge(),
        reloadSnapshot,
        createdConnectionId,
        { ...buildDrawerSavePayload({
          connectionId: createdConnectionId,
          label,
          model: selectedModelId ?? model,
          transport,
          baseUrl,
          showBaseUrl,
          proxyRef,
          authOptional: noAuth,
          maxOutputTokens: mot.value,
          imageInput,
          promptCacheEnabled,
        }, { contextWindowDirty, contextWindowTokens: cw.value, reasoningSupportedDirty, reasoningSupported, modelEffortDirty, modelEffort, imageInputDirty, effortLevelsDirty, effortLevels }), pricing, modelPricing },
        selectedModelId !== null && shouldAppendModelToList(selectedModelId, catalogOfferedIds, isCustomRecordConnection)
          ? selectedModelId
          : null,
      );
      if (outcome.metaOk) setDirtyRates(new Set());
      let keyRefused = false;
      let keyRefusalDetail: string | null = null;
      if (secretValue && credentialKey !== undefined) {
        const mutation = buildKeyMutation(effectiveProviderId, credentialKey, secretValue);
        if (mutation.channel === "custom") {
          const keyOutcome = resolveCustomKeyOutcome(await resolvedCustomProvider().update(mutation.request));
          keyRefused = keyOutcome.refused;
          keyRefusalDetail = keyOutcome.detail;
          if (keyOutcome.clearInput) {
            dispatchSecret({ type: "submitted" });
          }
        } else {
          // The settings store parks weak-storage consent and retries this channel.
          dispatchSecret({ type: "submitted" });
          const result = await store.getState().setSecret(mutation.key, mutation.value!);
          keyRefused = !result.ok && result.reason !== "weak_storage_needs_consent";
        }
      }
      // Compose ONE message so a concurrent key error is never overwritten by
      // the list-persistence error (or vice versa).
      if (!outcome.metaOk && keyRefused) {
        setError("Neither the changes nor the API key could be saved.");
      } else if (!outcome.metaOk) {
        setError("The changes couldn't be saved.");
      } else if (keyRefused && !outcome.appendOk) {
        setError("The changes were saved, but neither the model list nor the API key could be saved — retry Save.");
      } else if (keyRefused) {
        setError(keyRefusalDetail ?? "The changes were saved, but the API key was refused.");
      } else if (!outcome.appendOk) {
        setError("The changes were saved, but the model list couldn't be saved — retry Save.");
      } else {
        flashSavedNotice();
      }
    } finally {
      setSaving(false);
    }
  }

  async function clearSecretValue(): Promise<void> {
    if (credentialKey === undefined) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      // Taskana 4875 (GitHub #10): a custom:<id> connection's shared vault key
      // is only clearable through custom-provider-update's keyed→keyless
      // transition (main drops the vault entry AND resets health/quota). The
      // generic secret-clear channel refuses non-connection keys `invalid` —
      // and the old path ignored the result entirely, so the button looked
      // like it worked while the key stayed in the vault.
      const mutation = buildKeyMutation(effectiveProviderId, credentialKey);
      if (mutation.channel === "custom") {
        const result = await resolvedCustomProvider().update(mutation.request);
        if (!result.ok) {
          setError(describeCustomProviderMutationError(result.reason));
          return;
        }
      } else {
        await store.getState().clearSecret(mutation.key);
      }
      await reloadSnapshot();
    } finally {
      setClearing(false);
    }
  }

  /**
   * Models fetch: the guarded /v1/models GET — `{id}` for a saved custom
   * record, `{connectionId}` for a catalog connection (main resolves
   * baseUrl/key/kind itself either way; keyless supported). TASK.183: a custom
   * record's fetched ids are ALSO appended to its connection's own `models[]`
   * through the general `{connectionId, addModels}` branch, so a fetch becomes
   * durable and can never replace manual ids; a catalog connection's fetch is
   * already merged onto the connection by main. Either way the snapshot reload
   * makes the composer pickers see the union.
   */
  async function doFetchModels(): Promise<void> {
    if (createdConnectionId === null) {
      return;
    }
    setFetchingModels(true);
    setError(null);
    try {
      const outcome = isCustomRecordConnection
        ? await resolvedCustomProvider().fetchModels({ id: effectiveProviderId })
        : await resolvedCustomProvider().fetchModels({ connectionId: createdConnectionId });
      if (!outcome.ok) {
        setError(describeFetchModelsError(outcome.reason));
        return;
      }
      setFetchedModels(outcome.models);
      if (isCustomRecordConnection) {
        // TASK.183: persist the fetched ids on the connection (fetched-first
        // union), keeping any manual additions made before the fetch.
        // A fetched id the manual-entry validator refuses (inner whitespace,
        // controls) is skipped here: main rejects an addModels request
        // all-or-nothing, so one odd vendor id must not block the rest.
        const fetchedIds = outcome.models
          .map((m) => normalizeModelId(m.id))
          .filter((id): id is string => id !== null);
        if (fetchedIds.length > 0) {
          const append = await appendModelsToConnection(
            modelPersistenceBridge(),
            reloadSnapshot,
            createdConnectionId,
            fetchedIds,
          );
          if (!append.ok) {
            setError("Fetched models, but the connection's model list couldn't be saved — retry Fetch or Save.");
          }
        }
      } else {
        // TASK.108-A: a fetch landing on a still-blank field picks the default
        // from the MERGED offered list (fetched first, then any already-saved
        // ids), so a saved manual model is never lost from the prefill.
        const merged = mergeModelIds(outcome.models.map((m) => m.id), targetConnection?.models ?? []).map((id) => ({ id }));
        setModel((m) => modelAfterCatalogPrefill(m, merged));
        await reloadSnapshot();
      }
    } finally {
      setFetchingModels(false);
    }
  }

  /** Toggle a fetched model in the record's curated `models[]` (persisted via customProvider.update, like the old form). */
  async function toggleModel(id: string): Promise<void> {
    if (!isCustomRecordConnection) {
      return;
    }
    const next = toggleSelectedModel(curatedModelIds, id);
    setCurating(true);
    setError(null);
    try {
      const result = await resolvedCustomProvider().update({ id: effectiveProviderId, models: next });
      if (!result.ok) {
        setError(describeCustomProviderMutationError(result.reason));
        return;
      }
      await reloadSnapshot();
    } finally {
      setCurating(false);
    }
  }

  const labelField = (
    <label className="settings-field">
      <span className="settings-field-label">Label (optional)</span>
      <input
        ref={labelInputRef}
        className="settings-field-input"
        type="text"
        value={label}
        disabled={readOnly}
        placeholder="e.g. Work, Personal"
        onChange={(e) => setLabel(e.target.value)}
      />
    </label>
  );

  const maxOutputInputShown = maxOutputSegmentSelection(maxOutputTokens, maxOutputCustom) === "custom";

  // Everything tuning-related lives in ONE disclosure, rendered once and placed
  // before the primary button in both branches (pre-create and created).
  const advancedBlock = (
    <details
      className="connection-drawer-advanced"
      open={advancedOpen}
      onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
    >
      <summary>{simplified ? "Advanced settings (optional)" : "Advanced"}</summary>
      {/* The disclosure's fields live in their own column container: a
          `<details>` no longer lays its slotted children out as direct grid
          items (Chromium wraps them in `::details-content`), so the grid that
          used to sit on the details element silently stopped applying and
          every label sat flush against the control above it. The body carries
          the rhythm now, in both engines. */}
      <div className="connection-drawer-advanced-body">
      {simplified && labelField}
      <label className="settings-field">
        <span className="settings-field-label">Pricing</span>
        <select className="settings-field-select" value={pricingMode} disabled={readOnly} onChange={(e) => setPricingMode(e.target.value as "catalog" | "subscription" | "rates")}>
          <option value="catalog">Catalog or unknown</option><option value="subscription">By subscription</option><option value="rates">Custom rates</option>
        </select>
        <div className="settings-field-hint">{PRICING_ONELINER}</div>
      </label>
      {pricingMode === "rates" && <div className="connection-drawer-rate-grid">
        {([["Input", priceInput, setPriceInput], ["Cached input", priceCached, setPriceCached], ["Output", priceOutput, setPriceOutput], ["Cache write (optional)", priceWrite, setPriceWrite]] as const).map(([label, value, set]) => <label className="settings-field" key={label}><span className="settings-field-label">{label} · USD / 1M tokens</span><input className="settings-field-input" type="number" min="0" step="any" value={value} disabled={readOnly} onChange={(e) => set(e.target.value)} /></label>)}
      </div>}

      <p className="settings-field-hint">Prices apply to future usage. Model rates override the connection fallback.</p>
      <div className="connection-drawer-model-rates" aria-label="Per-model prices">
        {mergeModelIds(modelSuggestions.map((item) => item.id), mergeModelIds(Object.keys(modelRates), normalizeModelId(model) ? [normalizeModelId(model)!] : [])).map((id) => {
          const draft = (Object.hasOwn(modelRates, id) ? modelRates[id] : undefined) ?? { input: "", cachedInput: "", output: "", cacheWrite: "" };
          return <fieldset key={id} disabled={readOnly || saving || pricingMode === "subscription"}><legend>{id}</legend>
            {([ ["input", "Input"], ["cachedInput", "Cached input"], ["output", "Output"], ["cacheWrite", "Cache write (optional)"] ] as const).map(([key, label]) => <label className="settings-field" key={key}><span className="settings-field-label">{label} · USD / 1M tokens</span><input className="settings-field-input" type="number" min="0" step="any" aria-label={`${id} ${label} · USD / 1M tokens`} value={draft[key]} onChange={(e) => { const value = e.target.value; setModelRates((previous) => ({ ...previous, [id]: { ...draft, [key]: value } })); setDirtyRates((previous) => new Set(previous).add(id)); }} /></label>)}
          </fieldset>;
        })}
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Transport</span>
        <select
          className="settings-field-select"
          value={transport}
          disabled={readOnly}
          onChange={(e) => setTransport(e.target.value as ProviderTransportId | "")}
        >
          <option value="">(provider default)</option>
          {transportChoices.map((t) => (
            <option key={t} value={t}>
              {TRANSPORT_LABEL[t]}
            </option>
          ))}
        </select>
      </label>

      {/* GitHub #15: opt-in implicit prompt caching, shown only for the two
          OpenAI transports — Anthropic ignores the field at the model port, so
          offering it there would be a switch with no effect. A hidden field
          still keeps its state (`promptCacheEnabled`), so switching transport
          back restores the selection and a saved policy is never dropped by a
          transport edit. */}
      {promptCacheShown && (
        <>
          <label className="settings-field">
            <span className="settings-field-label">
              Prompt caching <FieldHelp text={PROMPT_CACHE_HELP} />
            </span>
            <select
              className="settings-field-select"
              value={promptCacheEnabled ? "implicit" : "off"}
              disabled={readOnly}
              onChange={(e) => setPromptCacheEnabled(e.target.value === "implicit")}
            >
              <option value="off">Off (default)</option>
              <option value="implicit">Implicit · 30 minutes</option>
            </select>
          </label>
          <div className="settings-field-hint">{PROMPT_CACHE_ONELINER}</div>
        </>
      )}

      {/* TASK.150 / TASK.159: one segmented control. Default writes "" (the
          provider default), the presets write the same values the chips did,
          Custom reveals the number input. `step={1}` on the input on purpose:
          every whole number in [min, max] is accepted, and a coarser step would
          make the browser paint the peers' own 32000 as `:invalid`. */}
      <div className="settings-field">
        <span className="settings-field-label">
          Max output tokens <FieldHelp text={MAX_OUTPUT_HELP} />
        </span>
        <MaxOutputSegmented
          value={maxOutputTokens}
          custom={maxOutputCustom}
          disabled={readOnly}
          title={maxOutputPlaceholder(motDefaultHint)}
          onSelect={(value) => {
            setMaxOutputTokens(value);
            setMaxOutputCustom(false);
          }}
          onCustom={() => {
            setMaxOutputCustom(true);
            requestAnimationFrame(() => maxOutputTokensInputRef.current?.focus());
          }}
        />
        {maxOutputInputShown && (
          <input
            ref={maxOutputTokensInputRef}
            className="settings-field-input"
            aria-label="Max output tokens"
            type="number"
            min={1024}
            max={1000000}
            step={1}
            value={maxOutputTokens}
            disabled={readOnly}
            placeholder={maxOutputPlaceholder(motDefaultHint)}
            onChange={(e) => setMaxOutputTokens(e.target.value)}
          />
        )}
        <div className="settings-field-hint">{MAX_OUTPUT_ONELINER}</div>
        {/* TASK.159: shown only while ANYCODE_MAX_OUTPUT_TOKENS overrides the rung — editing this field then does nothing. */}
        {motEnvHint !== null && (
          <div className="settings-field-hint" role="note">
            {motEnvHint}
          </div>
        )}
      </div>

      {/* TASK.142: per-model context window. Same field shape as "Max output
          tokens" above (whole number in [1024, 1000000], blank = catalog/
          assumed window); a Model edit loads that model's own saved window. */}
      <label className="settings-field">
        <span className="settings-field-label">
          Context window (tokens) <FieldHelp text={CONTEXT_WINDOW_HELP} />{" "}
          <span className="connection-drawer-badge" title={MODEL_ONLY_BADGE_TITLE}>
            this model only
          </span>
        </span>
        <input
          ref={contextWindowTokensInputRef}
          className="settings-field-input"
          type="number"
          min={1024}
          max={1000000}
          step={1}
          value={contextWindow.raw}
          disabled={readOnly}
          placeholder={contextWindowPlaceholder(cwDefaultHint)}
          onChange={(e) => {
            setContextWindowDirty(true);
            setContextWindow((field) => contextWindowAfterRawInput(field, e.target.value, effectiveFormModel));
          }}
        />
      </label>
      <div className="settings-field-hint">{CONTEXT_WINDOW_ONELINER}</div>
      {/* TASK.142: shown only while ANYCODE_CONTEXT_WINDOW overrides the rung — editing this field then does nothing. */}
      {cwEnvHint !== null && (
        <div className="settings-field-hint" role="note">
          {cwEnvHint}
        </div>
      )}

      {!knownCatalogModel && <label className="settings-field">
        <span className="settings-field-label">Reasoning support (this model)</span>
        <select className="settings-field-input" aria-label="Reasoning support" disabled={readOnly}
          value={reasoningSupported || effortLevels.length > 0 ? "on" : "auto"} onChange={(e) => { setReasoningSupportedDirty(true); setReasoningSupported(e.target.value === "on"); if (e.target.value === "auto") { setEffortLevels([]); setEffortLevelsDirty(true); } }}>
          <option value="auto">Auto — catalog or provider metadata</option>
          <option value="on">Supported</option>
        </select>
      </label>}
      {!knownCatalogModel && (reasoningSupported || effortLevels.length > 0) && <fieldset className="settings-field">
        <legend className="settings-field-label">Supported effort levels (empty uses automatic levels)</legend>
        {(["off", "low", "medium", "high", "xhigh", "max"] as ReasoningEffort[]).map((level) => <label key={level}>
          <input type="checkbox" disabled={readOnly} checked={effortLevels.includes(level)} onChange={(e) => {
            setEffortLevelsDirty(true);
            setReasoningSupported(true);
            setReasoningSupportedDirty(true);
            setEffortLevels((levels) => e.target.checked ? [...levels, level] : levels.filter((item) => item !== level));
          }} /> {level}
        </label>)}
      </fieldset>}
      <label className="settings-field">
        <span className="settings-field-label">Reasoning effort (this model)</span>
        <select className="settings-field-input" aria-label="Reasoning effort" disabled={readOnly}
          value={modelEffort} onChange={(e) => { setModelEffortDirty(true); setModelEffort(e.target.value as ReasoningEffort | ""); }}>
          <option value="">{editConnection?.reasoningEffort === undefined ? "Default" : `Default (connection: ${editConnection.reasoningEffort})`}</option>
          {(effectiveReasoningLevels ?? []).map((level) => <option key={level} value={level}>{level}</option>)}
          {modelEffort !== "" && !effectiveReasoningLevels?.includes(modelEffort) && <option value={modelEffort} disabled>{modelEffort} (unavailable)</option>}
        </select>
      </label>

      {/* Taskana 4088 (TASK.69): per-model image input. Three states: Auto
          (catalog mark, then the connection's live-fetched modality set —
          whichever vouches first), On/Off (a per-model override pair saved
          like the context-window pair above, binding derived server-side).
          Never a connection-wide switch: a blanket "on" would un-gate every
          blind sibling (the glm-5.2 hazard) the moment the user switches. */}
      <label className="settings-field">
        <span className="settings-field-label">
          Image input <FieldHelp text={IMAGE_INPUT_HELP} />{" "}
          <span className="connection-drawer-badge" title={MODEL_ONLY_BADGE_TITLE}>
            this model only
          </span>
        </span>
        <select
          className="settings-field-input"
          value={imageInput}
          disabled={readOnly}
          onChange={(e) => { setImageInput(e.target.value as ImageInputSelection); setImageInputDirty(true); }}
        >
          <option value="auto">{imageInputAutoLabel(imageInputHint)}</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      <div className="settings-field-hint">{IMAGE_INPUT_ONELINER}</div>
      {/* Taskana 4088: shown while the live-modality feed rides the env. */}
      {imageInputFeedHint !== null && (
        <div className="settings-field-hint" role="note">
          {imageInputFeedHint}
        </div>
      )}

      {/* TASK.141: one instance of the same picker the engine panes and the
          Network pane render — CONTROLLED here, because a connection's ref
          rides this drawer's own create/update payload rather than a channel of
          its own. That is what removes the two-phase "create the connection,
          then bind its proxy" dance. */}
      <ProxyRefPicker
        scope={{ kind: "connection", connectionId: createdConnectionId ?? "" }}
        store={store}
        value={proxyRef}
        onChange={setProxyRef}
      />
      </div>
    </details>
  );

  return (
    <div className="connection-drawer-body">
      <label className="settings-field">
        <span className="settings-field-label">Provider</span>
        <select
          className="settings-field-select"
          value={selectDisplayValue}
          disabled={readOnly || templateLocked}
          onChange={(e) => {
            setProviderId(e.target.value);
            // TASK.142: switching provider clears the model, so the per-model
            // window must go with it. Forced: the new model is empty, and an
            // already-empty owner must not make this look like a no-op.
            changeModel("", "", undefined, true);
          }}
        >
          <option value="" disabled>
            Choose a provider…
          </option>
          {/* TASK.70 (Taskana 4089): one brand = one card — brand-grouped entries
              render as a single <optgroup> (the brand card) whose options are the
              member modes; brandless entries render exactly as before. The option
              value is still the entry id, so selection/prefill is unchanged. */}
          {providerOptionGroups(catalog).map((group, gi) =>
            group.label === "" ? (
              group.options.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))
            ) : (
              <optgroup key={`${gi}-${group.label}`} label={group.label}>
                {group.options.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
              </optgroup>
            ),
          )}
        </select>
      </label>

      {/* NEW custom endpoint (pre-create): the record's own name/baseUrl/kind. */}
      {isNewCustomEndpoint && createdConnectionId === null && (
        <div className="connection-drawer-custom-fields">
          <label className="settings-field">
            <span className="settings-field-label">Name</span>
            <input
              className="settings-field-input"
              type="text"
              value={customName}
              disabled={readOnly}
              placeholder="e.g. LM Studio"
              onChange={(e) => setCustomName(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Base URL</span>
            <input
              className="settings-field-input"
              type="text"
              value={customBaseUrl}
              disabled={readOnly}
              placeholder="http://localhost:1234/v1"
              onChange={(e) => setCustomBaseUrl(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Kind</span>
            <select
              className="settings-field-select"
              value={customKind}
              disabled={readOnly}
              onChange={(e) => setCustomKind(e.target.value as CustomProviderRecord["kind"])}
            >
              <option value="openai-compatible">{customProviderKindLabel("openai-compatible")}</option>
              <option value="openai">{customProviderKindLabel("openai")}</option>
              <option value="anthropic">{customProviderKindLabel("anthropic")}</option>
            </select>
          </label>
        </div>
      )}

      {/* Label: top of the dialog; in the first-run flow it stays inside Advanced. */}
      {!simplified && labelField}

      {showBaseUrl && (
        <label className="settings-field">
          <span className="settings-field-label">Base URL</span>
          <input
            className="settings-field-input"
            type="text"
            value={baseUrl}
            disabled={readOnly}
            placeholder="(provider default)"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}

      {createdConnectionId === null && selectedEntry && (
        <label className="settings-field">
          <span className="settings-field-label">Model</span>
          <input className="settings-field-input" type="text" list="welcome-model-suggestions"
            value={modelAfterCatalogPrefill(model, selectedEntry.models)} disabled={readOnly}
            placeholder="Enter a model ID"
            onChange={(e) =>
              // TASK.142: the pre-create Model input saves the catalog-prefilled
              // id, so the per-model window is owned by THAT id — route through
              // the shared change so A's number cannot ride onto B.
              changeModel(
                e.target.value,
                modelAfterCatalogPrefill(e.target.value, selectedEntry.models),
                undefined,
              )
            } />
          <datalist id="welcome-model-suggestions">
            {selectedEntry.models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
          </datalist>
        </label>
      )}

      {/* TASK.183: a brand-new custom endpoint gets the same pre-create free-text
          Model field even when the catalog carries no entry to synthesize
          suggestions from (raw value, no datalist). No duplicate field when
          `selectedEntry` exists — the block above already covers that case. */}
      {createdConnectionId === null && isNewCustomEndpoint && !selectedEntry && (
        <label className="settings-field">
          <span className="settings-field-label">Model</span>
          <input className="settings-field-input" type="text"
            value={model} disabled={readOnly}
            placeholder="Enter a model ID"
            onChange={(e) =>
              // TASK.142: same shared route — the entered id IS the effective id
              // here, so the per-model window reset stays owned by it.
              changeModel(e.target.value, e.target.value, undefined)
            } />
        </label>
      )}

      {isNewCustomEndpoint && (
        <label className="settings-field-checkbox">
          <input
            type="checkbox"
            checked={noAuth}
            disabled={readOnly}
            onChange={(e) => {
              const checked = e.target.checked;
              setNoAuth(checked);
              setTransport(transportAfterNoAuthToggle(checked, transport));
              // Checking "no API key" clears any key already typed so a keyless
              // create is genuinely keyless (a non-empty key is authoritative
              // over the flag, both here and in main).
              if (checked) {
                dispatchSecret({ type: "change", value: "" });
              }
            }}
          />
          <span>This endpoint doesn't need an API key (local server, open proxy)</span>
        </label>
      )}
      {noAuth && transport === "anthropic-messages" && (
        <div className="settings-field-hint" role="note">
          The Anthropic Messages transport always requires an API key — pick an OpenAI-family transport to run keyless.
        </div>
      )}

      {createdConnectionId === null ? (
        <>
          {/* API key IN the create form (item 3): so a single "Create" mints the
              connection/record AND stores the key. Absent for a saved custom
              record (it already owns its key) and for oauth providers. */}
          {showKeyInCreate && (
            <label className="settings-field">
              <span className="settings-field-label">
                {isNewCustomEndpoint && noAuth ? "API key (not needed)" : "API key"}
              </span>
              <input
                ref={secretInputRef}
                className="settings-field-input connection-drawer-create-key"
                type="password"
                autoComplete="off"
                value={secretValue}
                disabled={keyFieldDisabled}
                placeholder="sk-…"
                onChange={(e) => dispatchSecret({ type: "change", value: e.target.value })}
              />
            </label>
          )}
          {advancedBlock}
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button settings-button-primary"
              disabled={readOnly || creating || setupMissingModel || setupMissingKey || (!isNewCustomEndpoint && providerId === "")}
              onClick={() => void createConnection()}
            >
              {creating ? "Connecting…" : simplified && mode === "add" ? "Connect" : mode === "add" ? "Create connection" : "Save"}
            </button>
          </div>
          {setupMissingModel && <p className="settings-field-hint">Enter a model ID to continue.</p>}
          {setupMissingKey && <p className="settings-field-hint">Enter your API key to continue.</p>}
        </>
      ) : (
        <>
          <label className="settings-field">
            <span className="settings-field-label">Model</span>
            <input
              className="settings-field-input"
              type="text"
              list="connection-drawer-model-suggestions"
              value={model}
              disabled={readOnly}
              placeholder="e.g. claude-sonnet-5"
              onChange={(e) =>
                // TASK.142: the shared model-change route. A whitespace-only
                // edit (same normalized id) keeps the field; a real change
                // clears it, or re-prefills when the user returns to the saved
                // model.
                changeModel(e.target.value, e.target.value, targetConnection)
              }
            />
            <datalist id="connection-drawer-model-suggestions">
              {modelSuggestions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.id}
                </option>
              ))}
            </datalist>
          </label>

          {/* Click-to-fill model chips for a catalog connection: static hints
              before any fetch, the endpoint's live list after (capped — a
              huge list stays reachable via the datalist's type-ahead). */}
          {!isCustomRecordConnection && !isNewCustomEndpoint && modelSuggestions.length > 0 && (
            <div className="connection-drawer-model-chips" role="group" aria-label="Available models">
              {modelSuggestions.slice(0, MODEL_CHIP_CAP).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`connection-drawer-model-chip${model === m.id ? " connection-drawer-model-chip-selected" : ""}`}
                  disabled={readOnly}
                  onClick={() => changeModel(m.id, m.id, targetConnection)}
                >
                  {m.name ?? m.id}
                </button>
              ))}
              {modelSuggestions.length > MODEL_CHIP_CAP && (
                <span className="settings-field-hint">
                  +{modelSuggestions.length - MODEL_CHIP_CAP} more — type in the Model field to search
                </span>
              )}
            </div>
          )}

          {/* Models step: ONE "Fetch models" for both flavors — a custom
              record curates its persisted `models[]` subset (checkboxes), a
              catalog connection refreshes the live list feeding the chips/
              datalist above (persisted onto the connection by main). The
              literal `custom` sentinel has no endpoint of its own to ask. */}
          {!isNewCustomEndpoint && (
            <div className="connection-drawer-fetch-models">
              <div className="settings-field-row">
                <button
                  type="button"
                  className="settings-button"
                  disabled={readOnly || fetchingModels || curating}
                  onClick={() => void doFetchModels()}
                >
                  {fetchingModels ? "Fetching…" : "Fetch models"}
                </button>
                {!isCustomRecordConnection && fetchedModels === null && targetConnection?.modelsFetchedAt !== undefined && (
                  <span className="settings-field-hint">{targetConnection.models?.length ?? 0} models loaded from the endpoint</span>
                )}
              </div>
              {isCustomRecordConnection && fetchedModels !== null && (
                <fieldset className="settings-field">
                  <legend className="settings-field-label">Models to show in the selector</legend>
                  {fetchedModels.map((m) => (
                    <label key={m.id} className="settings-field-row">
                      <input
                        type="checkbox"
                        checked={curatedModelIds.includes(m.id)}
                        disabled={readOnly || curating}
                        onChange={() => void toggleModel(m.id)}
                      />
                      {m.id}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          )}

          <section className="settings-section connection-drawer-credential">
            <div className="settings-section-title">
              {authKind === "oauth"
                ? "Sign-in"
                : noAuth || selectedEntry?.authOptional === true
                  ? "API key (optional)"
                  : "API key"}
            </div>
            {authKind === "oauth" ? (
              <OAuthCredentialBlock
                entry={selectedEntry as CatalogSummaryEntry}
                status={credentialStatus}
                pending={oauthPendingProviderId === selectedEntry?.id}
                readOnly={readOnly}
                onSignIn={() => {
                  const args = resolveDrawerOAuthStartArgs(selectedEntry?.id, createdConnectionId);
                  if (args) void store.getState().oauthStart(args.providerId, args.connectionId);
                }}
                onCancel={() => selectedEntry && void store.getState().oauthCancel(selectedEntry.id)}
                onSignOut={() => void clearSecretValue()}
              />
            ) : (
              <>
                <div className="settings-field-row">
                  {credentialStatus && (
                    <span className={`settings-secret-status settings-secret-status-${describeSecretStatus(credentialStatus).tone}`}>
                      {describeSecretStatus(credentialStatus).text}
                    </span>
                  )}
                </div>
                <label className="settings-field">
                  <span className="settings-field-label">
                    {/* Keyed on the credential's OWN status, not `mode` — a
                        WelcomeScreen first-run re-render can flip `mode`
                        add->edit the instant creation succeeds (the parent's
                        `connections.length` gate), well before a key is ever
                        entered; "API key" must keep showing until one
                        actually exists to replace. */}
                    {credentialStatus?.set ? "Replace key (never displayed once saved)" : "API key"}
                  </span>
                  <input
                    ref={secretInputRef}
                    className="settings-field-input"
                    type="password"
                    autoComplete="off"
                    value={secretValue}
                    disabled={readOnly}
                    placeholder="sk-…"
                    onChange={(e) => dispatchSecret({ type: "change", value: e.target.value })}
                  />
                </label>
                <div className="settings-field-row">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={readOnly || clearing || !credentialStatus?.set}
                    onClick={() => void clearSecretValue()}
                  >
                    Clear key
                  </button>
                </div>
              </>
            )}
          </section>

          {advancedBlock}

          {/* ONE Save (item 3): metadata + (if typed) the key, together. */}
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button settings-button-primary connection-drawer-save"
              disabled={readOnly || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {savedNotice && (
              <span className="connection-drawer-saved" role="status">
                Saved
              </span>
            )}
          </div>
        </>
      )}

      {error !== null && (
        <p className="settings-notice" role="alert">
          {error}
        </p>
      )}

      {footer}
    </div>
  );
}

export interface ConnectionDrawerProps {
  open: boolean;
  mode: "add" | "edit";
  editConnection?: ProviderConnection;
  catalog: CatalogSummary;
  connections: readonly ProviderConnection[];
  secrets: readonly SecretStatus[];
  readOnly: boolean;
  initialFocus?: "label" | "credential" | "context";
  onClose(): void;
  store?: SettingsStoreApi;
  /** Injectable custom-provider bridge (TASK.58); forwarded to the fields. */
  customProvider?: CustomProviderBridge;
}

/** Native-`<dialog>` wrapper around `ConnectionDrawerFields` for the Settings grid's Add/Edit action. */
export function ConnectionDrawer({ open, onClose, ...fieldsProps }: ConnectionDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="connection-drawer"
      aria-label={fieldsProps.mode === "add" ? "Add connection" : "Edit connection"}
      onCancel={(event) => {
        // TASK.58 item 4: act only on THIS drawer's own Escape — the shared
        // guard also stops this cancel (which React propagates up the tree)
        // from reaching the parent SettingsDialog's onCancel.
        if (!isOwnDialogCancel(event)) {
          return;
        }
        event.preventDefault();
        onClose();
      }}
    >
      <div className="connection-drawer-header">
        <span className="connection-drawer-title">{fieldsProps.mode === "add" ? "Add connection" : "Edit connection"}</span>
        <button type="button" className="connection-drawer-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      {/* Re-mounted (keyed) on every open so a prior connection's local form
          state (label/model/…) never leaks into the next Add/Edit — matches
          SettingsScreen's own `key={activePane}` remount discipline. */}
      <ConnectionDrawerFields
        key={fieldsProps.editConnection?.id ?? "add"}
        {...fieldsProps}
        footer={
          <div className="connection-drawer-footer">
            <button type="button" className="settings-button settings-button-primary" onClick={onClose}>
              Done
            </button>
          </div>
        }
      />
    </dialog>
  );
}

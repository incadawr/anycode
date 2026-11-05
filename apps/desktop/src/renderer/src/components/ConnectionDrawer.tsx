/**
 * ConnectionDrawer (W12, cut §"Add/Edit flow"): the compact add/edit
 * surface for ONE provider connection — template → label → model → transport
 * (restricted to `supportedTransports`) → base URL (capability-gated)
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
import { Button, IconButton } from "../ui/index.js";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { findKnownModel, isGatewayProvider } from "@anycode/core/model-dictionary";
import { getBuiltinCatalog } from "@anycode/core/catalog";
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
import type { CustomProviderMutationReason, CustomProviderMutationResult, CustomProviderUpdateRequest, FetchModelsOutcome } from "../anycode-window.js";
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
  mergeCurationModelIds,
  secretFieldReducer,
  selectProviderEntry,
  shouldShowBaseUrlField,
  showConnectionLabelField,
  transportOptions,
  type CustomProviderBridge,
} from "./SettingsScreen.js";
import { X } from "./icons.js";
import { startModelEffortLevels } from "./start-model-picker.js";

export function retainedModelSelection(open: boolean, draft: readonly string[], pending: string[] | null): string[] | null {
  return open ? [...draft] : pending;
}

export function hasPendingFetchConnectionChanges(input: { showBaseUrl: boolean; baseUrl: string; savedBaseUrl: string; transport: string; savedTransport: string; proxyRef: string; savedProxyRef: string; secretValue: string }): boolean {
  return (input.showBaseUrl && input.baseUrl.trim() !== input.savedBaseUrl.trim()) || input.transport !== input.savedTransport || input.proxyRef !== input.savedProxyRef || input.secretValue !== "";
}

export function validVisibleModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => normalizeModelId(id) === id);
}

export function ownRateDraft<T>(drafts: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(drafts, id) ? drafts[id] : undefined;
}

/**
 * The connection `connection-create` just minted (W12-FIX2 §1):
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

// ── durable manually entered connection models ──

/**
 * Pre-flight of a raw Model-field value before any create/update/secret/list
 * call. `blank` keeps the existing implicit/default rules (a blank catalog
 * model is refused later by `modelSaveBlocked`; an existing arbitrary endpoint
 * may remain blank, while creation requires a model); `id` is the normalized, persistable id; `invalid` is a nonblank value
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

/** The one bridge call the curated-model path needs on top of the store. */
export interface CuratedModelsBridge {
  update(req: CustomProviderUpdateRequest): Promise<CustomProviderMutationResult>;
}

/**
 * Persists the models a custom endpoint OFFERS (the checkbox list) on the
 * record's own `models[]`, then refreshes the snapshot. This is the selector's
 * authority for a `custom:<id>` provider: `providerModelsFor` falls back to the
 * record's list, so an unticked id must not also sit on the connection's own
 * `models[]` (that list is unioned in and would resurrect it). Fetched ids are
 * therefore saved HERE, not appended to the connection — ticking and unticking
 * are the same write, and a failed/thrown write is reported rather than
 * swallowed. Exported for direct testing.
 */
export async function persistCuratedModels(
  bridge: CuratedModelsBridge,
  reload: () => Promise<void>,
  providerId: string,
  modelIds: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: CustomProviderMutationReason | "threw" }> {
  let result: CustomProviderMutationResult;
  try {
    result = await bridge.update({ id: providerId, models: [...modelIds] });
  } catch {
    return { ok: false, reason: "threw" };
  }
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  try {
    await reload();
  } catch {
    // The list IS persisted; a refresh failure must not read as a save failure.
  }
  return { ok: true };
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
  staleFetch?: boolean;
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
    return result.reason === "stale_fetch" ? { metaOk: false, appendOk: false, staleFetch: true } : { metaOk: false, appendOk: false };
  }
  if (modelId === null) {
    return { metaOk: true, appendOk: true };
  }
  const append = await appendModelToConnection(bridge, reload, connectionId, modelId);
  return { metaOk: true, appendOk: append.ok };
}

/**
 * The id of the custom-provider record a `customProvider.create` just minted
 * the single id present in the returned full `providers` list that
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
 * dispatches (W12-FIX §1): a sign-in from this drawer always targets
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
 * `proxyUrlSaveBlocked` / `PROXY_URL_ERROR` /
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

// ── GitHub #1: the per-connection streaming token-usage policy ──

/** Visible one-liner under the usage select (full copy in the tooltip). */
export const USAGE_ONELINER = "Applies to Chat Completions.";
export const USAGE_HELP =
  "Request streaming token usage on Chat Completions endpoints. Automatic requests usage and retries once without it if a server rejects it.";

/**
 * The drawer's three-state select: Automatic (the transport default), force
 * On, force Off. Only the FIRST is a "no opinion" value — `"off"` must
 * survive every truthiness check on its way to disk (GitHub #1).
 */
export type UsageSelection = "auto" | "on" | "off";

/** The select value a saved connection opens with: an explicit boolean wins, absence is Automatic. */
export function usageSelectionInitialValue(connection: ProviderConnection | undefined): UsageSelection {
  if (connection?.includeUsage === true) return "on";
  if (connection?.includeUsage === false) return "off";
  return "auto";
}

/**
 * Wire value for an UPDATE: Automatic is the channel's `""` clear sentinel
 * (delete the key back to the transport default), On/Off are real booleans.
 */
export function usageSelectionUpdateValue(selection: UsageSelection): boolean | "" {
  return selection === "auto" ? "" : selection === "on";
}

/**
 * Wire value for a CREATE: omission already means Automatic there (create has
 * no `""` sentinel), so `undefined` is simply left out of the payload.
 */
export function usageSelectionCreateValue(selection: UsageSelection): boolean | undefined {
  return selection === "auto" ? undefined : selection === "on";
}

/**
 * Whether the control belongs on screen: only `openai-chat-completions` honours
 * `stream_options.include_usage`, so an Anthropic/Responses connection would be
 * offering a switch with no effect. Resolved exactly like `promptCacheVisible`
 * (an empty local transport means the provider's default).
 */
export function usageVisible(
  transport: ProviderTransportId | "",
  defaultTransport: ProviderTransportId | undefined,
): boolean {
  const resolved = transport !== "" ? transport : (defaultTransport ?? "anthropic-messages");
  return resolved === "openai-chat-completions";
}

/** Local literal, same convention as the env hints below — renderer modules don't import main. */
const ENV_INCLUDE_USAGE = "ANYCODE_INCLUDE_USAGE";

/**
 * Hint under the usage select while ANYCODE_INCLUDE_USAGE is live: the env rung
 * always beats the saved connection value (`fillFromSettings` never overwrites
 * a boot-provided slot), so the select would silently do nothing — say so.
 * `null` when the variable isn't overriding.
 */
export function usageEnvHint(envOverrides: readonly string[]): string | null {
  return envOverrides.includes(ENV_INCLUDE_USAGE)
    ? `${ENV_INCLUDE_USAGE} is set in the environment — it overrides this setting for every new session.`
    : null;
}

// ── GitHub #41: the per-connection reasoning-replay opt-in ──

/** Visible one-liner under the reasoning-replay select (full copy in the tooltip). */
export const REASONING_REPLAY_ONELINER = "Applies to custom endpoints and vLLM.";
export const REASONING_REPLAY_HELP =
  "Replay the model's reasoning (thinking) blocks back to the endpoint on each turn, the way tool-calling models expect. Automatic uses the provider's own policy — for a custom endpoint or vLLM that means Off. On or Off here overrides the provider policy: Off also stops replay on a provider that normally replays. Applies to new sessions.";

/**
 * The drawer's three-state select for reasoning replay, mirroring
 * `UsageSelection`: Automatic (the provider's own policy), force On, force
 * Off. Only the FIRST is a "no opinion" value — `"off"` (an explicit opt-out
 * that also disables replay on a replay-enabled catalog entry) must survive
 * every truthiness check on its way to disk.
 */
export type ReasoningReplaySelection = "auto" | "on" | "off";

/** The select value a saved connection opens with: an explicit boolean wins, absence is Automatic. */
export function reasoningReplayInitialValue(connection: ProviderConnection | undefined): ReasoningReplaySelection {
  if (connection?.preserveReasoning === true) return "on";
  if (connection?.preserveReasoning === false) return "off";
  return "auto";
}

/**
 * Wire value for an UPDATE: Automatic is the channel's `""` clear sentinel
 * (delete the key back to the catalog default), On/Off are real booleans.
 */
export function reasoningReplayUpdateValue(selection: ReasoningReplaySelection): boolean | "" {
  return selection === "auto" ? "" : selection === "on";
}

/**
 * Wire value for a CREATE: omission already means Automatic there (create has
 * no `""` sentinel), so `undefined` is simply left out of the payload.
 */
export function reasoningReplayCreateValue(selection: ReasoningReplaySelection): boolean | undefined {
  return selection === "auto" ? undefined : selection === "on";
}

/**
 * Whether the control belongs on screen: core's replay gate consults this
 * override only where the catalog has no policy of its own — the builtin
 * `custom` sentinel, a saved `custom:<id>` record, and `vllm` (all resolve
 * `providerName` undefined at the host). A catalog entry's own
 * `preserveReasoning` flag governs, so offering the switch there would invite
 * an override nobody needs. Exported for direct testing (no jsdom).
 */
export function reasoningReplayVisible(providerId: string | undefined): boolean {
  return providerId === "custom" || providerId === "vllm" || isCustomRecordProviderId(providerId ?? "");
}

/**
 * Whether the control belongs on screen for the RESOLVED transport: core's
 * replay gate (`model-port.ts` `reasoningReplaySource`) replays reasoning
 * only on the two message transports — openai-responses is out of scope
 * (with `store: false` its reasoning items would need encrypted content) —
 * so there the select would be inert no matter what it saves. Resolved
 * exactly like `promptCacheVisible`/`usageVisible` (an empty local transport
 * means the provider's default). Exported for direct testing (no jsdom).
 */
export function reasoningReplayTransportVisible(
  transport: ProviderTransportId | "",
  defaultTransport: ProviderTransportId | undefined,
): boolean {
  const resolved = transport !== "" ? transport : (defaultTransport ?? "anthropic-messages");
  return resolved === "anthropic-messages" || resolved === "openai-chat-completions";
}

/**
 * Renderer mirror of core's `normalizeAnthropicBaseUrl` — the exact transform
 * `matchCatalogEntryByBaseUrl` (host, `@anycode/core`) applies to BOTH sides
 * before comparing: trailing slashes stripped, `/v1` ensured. Renderer modules
 * don't import that internal, so the two must be kept in step by review.
 */
function normalizeReplayMatchUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * The BUILTIN catalog entry a `custom:<id>` record's base URL normalises onto
 * (same matching rule the host applies when it resolves the connection's
 * `providerName`), or undefined when nothing matches. Only non-custom entries
 * can match: the host matches the builtin catalog, and other custom records
 * are not part of it. Exported for direct testing (no jsdom).
 */
export function reasoningReplayBaseUrlMatch(
  catalog: CatalogSummary,
  recordBaseUrl: string | undefined,
): CatalogSummaryEntry | undefined {
  if (recordBaseUrl === undefined || recordBaseUrl.trim() === "") return undefined;
  const target = normalizeReplayMatchUrl(recordBaseUrl);
  return catalog.find(
    (entry) =>
      !isCustomRecordProviderId(entry.id) &&
      entry.catalogBaseUrl !== undefined &&
      normalizeReplayMatchUrl(entry.catalogBaseUrl) === target,
  );
}

/** Local literal, same convention as the env hints below — renderer modules don't import main. */
const ENV_PRESERVE_REASONING = "ANYCODE_PRESERVE_REASONING";

/**
 * Hint under the reasoning-replay select while ANYCODE_PRESERVE_REASONING is
 * live: the env rung always beats the saved connection value
 * (`fillFromSettings` never overwrites a boot-provided slot), so the select
 * would silently do nothing — say so. `null` when the variable isn't
 * overriding.
 */
export function reasoningReplayEnvHint(envOverrides: readonly string[]): string | null {
  return envOverrides.includes(ENV_PRESERVE_REASONING)
    ? `${ENV_PRESERVE_REASONING} is set in the environment — it overrides this setting for every new session.`
    : null;
}

export function buildDrawerSavePayload(
  params: Parameters<typeof buildConnectionUpdatePayload>[0],
  fields: { contextWindowDirty: boolean; contextWindowTokens: number | ""; reasoningSupportedDirty: boolean; reasoningSupported: boolean | undefined; modelEffortDirty: boolean; modelEffort: ReasoningEffort | ""; imageInputDirty: boolean; effortLevelsDirty?: boolean; effortLevels?: ReasoningEffort[] },
): ConnectionUpdateRequest {
  return buildConnectionUpdatePayload({
    ...params,
    ...(fields.contextWindowDirty ? { contextWindowTokens: fields.contextWindowTokens } : {}),
    ...(fields.reasoningSupportedDirty ? { reasoningSupported: fields.reasoningSupported ?? "" } : {}),
    ...(fields.modelEffortDirty ? { reasoningEffort: fields.modelEffort } : {}),
    ...(fields.effortLevelsDirty ? { effortLevels: fields.effortLevels?.length ? fields.effortLevels : "" } : {}),
    imageInputChanged: fields.imageInputDirty,
  });
}

/**
 * The connection-update payload the unified `save` sends (W12-FIX §3;
 * folded the former separate `saveMetadata` into `save`):
 * `transport` is sent UNCONDITIONALLY (never omitted) — the local state
 * already speaks the channel's `ProviderTransportId | ""` sentinel, so
 * omitting it on `""` would leave an existing explicit choice untouched
 * instead of clearing it back to catalog default, the exact asymmetry this
 * fix closes. `createConnection`'s payload is NOT this shape — at create time
 * an omitted transport already means "use the default", so it keeps the old
 * conditional-spread form. `maxOutputTokens` follows the exact same
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
  /** GitHub #1: the usage select's three-state value; Automatic sends the `""` clear sentinel. */
  usage: UsageSelection;
  /** GitHub #41: the reasoning-replay select's three-state value; Automatic sends the `""` clear sentinel. */
  replay: ReasoningReplaySelection;
  /**
   * True while the select is hidden because the transport cannot replay at
   * all: the hidden control's value must not ride a save its user cannot
   * see, and omission means "keep" in main, so a choice saved under a
   * replay-capable transport survives the switch — never deleted.
   */
  replayHidden?: boolean;
  reasoningEffort?: ReasoningEffort | "";
  reasoningSupported?: boolean | "";
  effortLevels?: ReasoningEffort[] | "";
}): ConnectionUpdateRequest {
  return {
    id: params.connectionId,
    label: params.label.trim(),
    model: params.model.trim(),
    transport: params.transport,
    baseUrl: params.showBaseUrl ? params.baseUrl.trim() : "",
    // Sent unconditionally, same rationale as `transport` (inherited
    // from the earlier `proxyUrl`): choosing "Use application proxy" must CLEAR
    // the persisted ref, and `""` is the channel's clear sentinel — omitting it
    // would leave the old choice in force. The legacy `proxyUrl` key is
    // deliberately NOT sent here: absent means "keep", which is what lets an
    // untouched legacy string survive a save of an unrelated field, and `""`
    // on the ref is what erases both keys when the user really does clear it.
    proxyRef: params.proxyRef,
    // Sent unconditionally, same rationale as `transport`: `false` must CLEAR
    // a previously-persisted flag, not leave it untouched.
    authOptional: params.authOptional,
    // Sent unconditionally, same rationale as `transport`/`proxyRef`:
    // clearing the field back to blank must CLEAR the persisted cap, not leave
    // an old explicit value in force.
    maxOutputTokens: params.maxOutputTokens,
    ...(params.contextWindowTokens !== undefined ? { contextWindowTokens: params.contextWindowTokens } : {}),
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.reasoningSupported !== undefined ? { reasoningSupported: params.reasoningSupported } : {}),
    ...(params.effortLevels !== undefined ? { effortLevels: params.effortLevels } : {}),
    // Sent unconditionally, same rationale: "auto" must CLEAR
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
    // Sent unconditionally (GitHub #1), same rationale: Automatic is the
    // channel's `""` clear sentinel, On/Off persist a real boolean — and `false`
    // is a MEANING, never dropped by a truthiness check. Also sent while the
    // control is hidden for a non-Chat-Completions transport, so switching
    // away and back never silently drops a saved choice.
    includeUsage: usageSelectionUpdateValue(params.usage),
    // Sent unconditionally (GitHub #41), same rationale: Automatic is the
    // channel's `""` clear sentinel, On/Off persist a real boolean (`false`
    // is a MEANING — an explicit opt-out). Also sent while the control is
    // hidden for a catalog provider, so a provider switch never silently
    // drops a saved custom-endpoint choice. The one exception is a transport
    // that cannot replay at all (`replayHidden`): there the value is omitted
    // — nothing the user cannot see gets written, nothing gets deleted.
    ...(params.replayHidden === true ? {} : { preserveReasoning: reasoningReplayUpdateValue(params.replay) }),
  };
}


/**
 * Validates the "Max output tokens" field's raw string: main
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
 * (slice 3). Blank is a real entry rather than the absence of one:
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

/**
 * The pricing hint for an endpoint that serves BOTH a pay-as-you-go key and
 * a subscription key (MiniMax): the same key works on the same address for
 * either kind of plan, so only the user knows which one they hold. Until
 * they say, the usage is priced as unknown rather than at the API rate.
 */
export const SHARED_BILLING_ONELINER =
  "This endpoint takes both a pay-as-you-go key and a subscription key. Choose how you are billed — until then no price is applied.";

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
  /** A saved non-Automatic usage policy (GitHub #1) is a tuned value too. */
  usage?: UsageSelection;
  /** A saved non-Automatic reasoning-replay override (GitHub #41) is a tuned value too. */
  replay?: ReasoningReplaySelection;
}): boolean {
  return (
    v.transport !== "" ||
    v.maxOutputTokens.trim() !== "" ||
    v.contextWindowRaw.trim() !== "" ||
    v.imageInput !== "auto" ||
    v.proxyRef !== PROXY_REF_INHERIT ||
    v.promptCache ||
    (v.usage !== undefined && v.usage !== "auto") ||
    (v.replay !== undefined && v.replay !== "auto") ||
    (v.label !== undefined && v.label.trim() !== "")
  );
}

/** Local literal, same convention as host-env.ts's `ENV_MAX_OUTPUT_TOKENS` — renderer modules don't import main, let alone core. */
const ENV_MAX_OUTPUT_TOKENS = "ANYCODE_MAX_OUTPUT_TOKENS";

/**
 * Hint under the "Max output tokens" field while ANYCODE_MAX_OUTPUT_TOKENS is
 * live: the env rung always beats what this field saves
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
 * model, naming what the old "(provider default)" placeholder left
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
 * Validates the "Context window (tokens)" field's raw string: the
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

/** Local literal, same convention as host-env.ts's `ENV_CONTEXT_WINDOW` — renderer modules don't import main, let alone core. */
const ENV_CONTEXT_WINDOW = "ANYCODE_CONTEXT_WINDOW";

/**
 * Hint under the "Context window (tokens)" field while ANYCODE_CONTEXT_WINDOW is
 * live: the env rung always beats what this field saves, so an edited
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
 * selected model: a catalog model answers `catalog: N` where N is
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
 * the raw window value the drawer starts with for a saved connection.
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
 * the "Context window (tokens)" field's full state. `model` is the
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
 * the field state after a user route CHANGES the model. `nextModel` is
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
 * the field state after the user edits the WINDOW text itself. The
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

// ── the per-model image-input select ──

/** The drawer's three-state select value: catalog/live resolve, force on, force off. */
export type ImageInputSelection = "auto" | "on" | "off";

/**
 * the wire value for a selection. "auto" maps to main's `""`
 * clear sentinel (deletes the saved override pair), "on"/"off" persist it —
 * the maxOutputTokens discipline verbatim. Exported for direct
 * testing (no jsdom).
 */
export function imageInputToPayload(selection: ImageInputSelection): "on" | "off" | "" {
  return selection === "auto" ? "" : selection;
}

/**
 * (cross-review): an explicit on/off override is bound to the
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

/** The saved image-input choice for the model displayed in the drawer. */
export function imageInputInitialValue(connection: {
  modelOverrides?: ProviderConnection["modelOverrides"];
  model?: string;
}): ImageInputSelection {
  const model = connection.model ?? "";
  return (connection.modelOverrides && Object.hasOwn(connection.modelOverrides, model) ? connection.modelOverrides[model]?.imageInput : undefined) ?? "auto";
}

/** Local literal, same convention as `ENV_CONTEXT_WINDOW` above — renderer modules don't import main, let alone core. */
// Explicit environment overrides take precedence over saved settings.
const ENV_IMAGE_INPUT_MODEL_OVERRIDE = "ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE";

/**
 * hint under the "Image input" select when the launching shell
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
 * one line naming what "Auto" resolves to for the shown model:
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
 * UNION of this session's fetched ids, the ids persisted on the
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
 * the field still blank (owner 08.08): the curated list's FIRST
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

export function createModelMissing(model: string, suggestions: readonly { id: string }[], accountSource = false, simplified = false): boolean {
  return !(accountSource && !simplified) && modelAfterCatalogPrefill(model, suggestions).trim() === "";
}

/**
 * Whether Save must refuse a catalog connection's empty model:
 * the readiness gate requires a model on the active connection, so an empty
 * save manufactures the false "Configure a provider (API key + model)" toast
 * later. Only a catalog connection with a known model list is held to this —
 * existing custom records/endpoints can retain arbitrary or implicit models;
 * creation separately requires a model.
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
 * template options grouped one-brand-one-card. A
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
  initialCustom?: { name: string; baseUrl: string; kind: CustomProviderRecord["kind"] };
  store?: SettingsStoreApi;
  /** Injectable custom-provider bridge; defaults to the real `window.anycode.customProvider`. */
  customProvider?: CustomProviderBridge;
  /** Secondary action supplied by the drawer; the embedded form omits it. */
  cancelAction?: ReactNode;
  onCommitBegin?: () => number;
  onCommitSuccess?: (version: number) => boolean;
  onBusyChange?: (busy: boolean) => void;
  interactionBlocked?: boolean;
  /** First-run form: keep connection tuning behind a disclosure. */
  simplified?: boolean;
  /**
   * Template preselected for a first-run create (WelcomeScreen's subscription
   * shortcuts). A mount-time seed for the Provider select in add mode only —
   * an `editConnection` always wins, and the embed remounts with a new key
   * when the pick changes, so the value is never re-read after mount.
   */
  initialProviderId?: string;
  /**
   * Fired when the add-mode Provider select changes (the select is editable
   * only before create — `templateLocked`). WelcomeScreen's embedded form
   * uses it to stop advertising the seeded template's key page once the form
   * has moved to another provider.
   */
  onProviderIdChange?(providerId: string): void;
  /**
   * Fired with the id of a connection this form CREATED (both create flows).
   * The dialog chrome needs it to stop calling a saved connection "Add
   * connection"; nothing else may infer it (a connection appearing in the list
   * is not proof this form made it).
   */
  onConnectionCreated?(connectionId: string): void;
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
  initialCustom,
  store = useSettingsStore,
  customProvider,
  cancelAction,
  onCommitBegin,
  onCommitSuccess,
  onBusyChange,
  interactionBlocked = false,
  simplified = false,
  initialProviderId,
  onProviderIdChange,
  onConnectionCreated,
}: ConnectionDrawerFieldsProps) {
  const labelInputRef = useRef<HTMLInputElement>(null);
  const maxOutputTokensInputRef = useRef<HTMLInputElement>(null);
  const contextWindowTokensInputRef = useRef<HTMLInputElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const oauthPendingProviderId = useStore(store, (s) => s.oauthPendingProviderId);
  const consentResolution = useStore(store, (s) => s.secretConsentResolution);
  const pendingKeyCommit = useRef<{ key: SecretKey; version: number; previous: unknown; complete: boolean } | null>(null);
  // the settings document behind the proxy picker's seed. Read here
  // (not inside the picker) because the drawer runs the picker CONTROLLED — the
  // ref rides the drawer's own create/update payloads instead of being written
  // by a channel of its own.
  const proxySnapshot = useStore(store, (s) => s.snapshot);

  // Add mode: `""` until the user picks a template AND clicks "Create
  // connection"; edit mode: fixed to the connection's own id for this drawer's
  // whole lifetime (the template can never change post-creation).
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(editConnection?.id ?? null);
  const [providerId, setProviderId] = useState<string>(editConnection?.providerId ?? (initialCustom ? "custom" : initialProviderId ?? ""));
  const [label, setLabel] = useState(editConnection?.label ?? "");
  // an existing catalog connection persisted with a blank model
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
  // the connection's rung is a REFERENCE now, seeded through the same
  // pure helper every other scope's picker uses (a dangling id reads as "No
  // proxy", a legacy `proxyUrl` string reads as the synthetic Legacy entry).
  const [proxyRef, setProxyRef] = useState(() =>
    editConnection === undefined || proxySnapshot === null
      ? PROXY_REF_INHERIT
      : proxyRefInitialValue({ kind: "connection", connectionId: editConnection.id }, proxySnapshot.settings),
  );
  const [noAuth, setNoAuth] = useState(editConnection?.authOptional === true);
  /**
   * The pricing mode. `"unset"` is the previous default (nothing persisted) and
   * `"catalog"` is the EXPLICIT "the provider's per-token rate applies"
   * choice — two different things, and on an endpoint that serves both a
   * pay-as-you-go key and a subscription key (MiniMax) they differ in the
   * price: unset means "unknown", explicit means "the API rate".
   */
  const [pricingMode, setPricingMode] = useState<"unset" | "catalog" | "subscription" | "rates">(
    editConnection?.pricing?.mode === "subscription" ? "subscription"
      : editConnection?.pricing?.mode === "rates" ? "rates"
      : editConnection?.pricing?.mode === "catalog" ? "catalog"
      : "unset",
  );
  const initialRates = editConnection?.pricing?.mode === "rates" ? editConnection.pricing : undefined;
  const [priceInput, setPriceInput] = useState(initialRates ? String(initialRates.input) : "");
  const [priceCached, setPriceCached] = useState(initialRates ? initialRates.cachedInput === undefined ? "" : String(initialRates.cachedInput) : "");
  const [priceOutput, setPriceOutput] = useState(initialRates ? String(initialRates.output) : "");
  const [priceWrite, setPriceWrite] = useState(initialRates?.cacheWrite === undefined ? "" : String(initialRates.cacheWrite));
  const pricingPayload = () => {
    if (pricingMode === "unset") return "" as const;
    if (pricingMode === "catalog") return { mode: "catalog" as const };
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
      return [id, { input: String(rate.input), cachedInput: rate.cachedInput === undefined ? "" : String(rate.cachedInput), output: String(rate.output), cacheWrite: rate.cacheWrite === undefined ? "" : String(rate.cacheWrite) }];
    }),
  ));
  const [dirtyRates, setDirtyRates] = useState<Set<string>>(() => new Set());
  const modelPricingPayload = (): Record<string, TokenRates | ""> | null => {
    const entries: [string, TokenRates | ""][] = [];
    for (const id of dirtyRates) {
      const draft = ownRateDraft(modelRates, id);
      if (draft === undefined) { entries.push([id, ""]); continue; }
      const raw = [draft.input, draft.cachedInput, draft.output];
      const values = raw.map(Number), write = Number(draft.cacheWrite);
      if (normalizeModelId(id) !== id || raw.some((v) => !v.trim()) || values.some((v) => !Number.isFinite(v) || v < 0) || (draft.cacheWrite.trim() !== "" && (!Number.isFinite(write) || write < 0))) return null;
      entries.push([id, { input: values[0]!, cachedInput: values[1]!, output: values[2]!, ...(draft.cacheWrite.trim() ? { cacheWrite: write } : {}) }]);
    }
    return Object.fromEntries(entries);
  };
  // stored as a string (it backs a plain `<input type="number">`) so
  // an in-progress edit (e.g. a momentarily-empty field) never gets coerced
  // through `Number()` before the user is done typing; `maxOutputTokensField`
  // does the actual parse/validate at save time.
  const [openRouterProviders, setOpenRouterProviders] = useState(editConnection?.openRouterProviders?.join(", ") ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    editConnection?.maxOutputTokens === undefined ? "" : String(editConnection.maxOutputTokens),
  );
  // per-model context window, stored as {raw, model} for the same
  // reason as `maxOutputTokens` below. Prefilled ONLY when the saved window is
  // bound to the connection's own model — a window saved for a DIFFERENT model
  // must not appear here. Every model-changing route goes through `changeModel`.
  const [contextWindow, setContextWindow] = useState<ContextWindowField>(() =>
    contextWindowInitialField(editConnection),
  );
  // the per-model image-input select ("auto" | "on" | "off").
  // Prefilled ONLY when the saved override binds to the connection's own model
  // (the contextWindowInitialRaw rule); "auto" clears the pair on save.
  const [reasoningSupported, setReasoningSupported] = useState(() =>
    modelOverrideFor(editConnection, editConnection?.model ?? "")?.reasoningSupported,
  );
  const [catalogMatchDisabled, setCatalogMatchDisabled] = useState(() => modelOverrideFor(editConnection, editConnection?.model ?? "")?.catalogMatchDisabled === true);
  const [catalogMatchDirty, setCatalogMatchDirty] = useState(false);
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
  // GitHub #1: streaming token-usage policy, prefilled from the connection. A
  // hidden control (non-Chat-Completions transport) keeps its state, exactly
  // like the cache policy above, so a transport switch never drops it.
  const [usageSelection, setUsageSelection] = useState<UsageSelection>(() =>
    usageSelectionInitialValue(editConnection),
  );
  // GitHub #41: reasoning-replay override, prefilled from the connection. A
  // hidden control (catalog provider) keeps its state, exactly like the usage
  // select above, so a provider switch never silently drops a saved choice.
  const [replaySelection, setReplaySelection] = useState<ReasoningReplaySelection>(() =>
    reasoningReplayInitialValue(editConnection),
  );
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
    usage: usageSelection,
    replay: replaySelection,
    ...(simplified ? { label } : {}),
  }));
  const [secretValue, dispatchSecret] = useReducer(secretFieldReducer, "");
  // New-custom-endpoint (the builtin `custom` sentinel) record fields.
  const [customName, setCustomName] = useState(initialCustom?.name ?? "");
  const [customBaseUrl, setCustomBaseUrl] = useState(initialCustom?.baseUrl ?? "");
  const [customKind, setCustomKind] = useState<CustomProviderRecord["kind"]>(initialCustom?.kind ?? "openai-compatible");
  // Custom-provider model fetch/curation (the drawer's model step).
  const [fetchedModels, setFetchedModels] = useState<Extract<FetchModelsOutcome, { ok: true }>["models"] | null>(null);
  const [createFetchNotice, setCreateFetchNotice] = useState<string | null>(null);
  const [commitFetchedModels, setCommitFetchedModels] = useState(false);
  const [fetchedSource, setFetchedSource] = useState<{ guard: string; targetUrl: string; baseUrl: string; transport: ProviderTransportId | "" } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const fetchGeneration = useRef(0);
  const [modelPopupOpen, setModelPopupOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [draftDefaultModel, setDraftDefaultModel] = useState("");
  const [visibleModelDraft, setVisibleModelDraft] = useState<string[]>([]);
  const [pendingVisibleModels, setPendingVisibleModels] = useState<string[] | null>(null);
  const modelSelectionRevision = useRef(0);
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
  useEffect(() => {
    const pending = pendingKeyCommit.current;
    if (creating || saving || !pending || !consentResolution || consentResolution === pending.previous || consentResolution.key !== pending.key) return;
    pendingKeyCommit.current = null;
    if (consentResolution.ok) {
      setError(current => current === "The API key is awaiting storage consent. If you decline, enter it again." ? null : current);
      if (pending.complete && (onCommitBegin?.() ?? pending.version) === pending.version) {
        if (onCommitSuccess?.(pending.version) ?? true) flashSavedNotice();
      }
    } else {
      setError(current => current && current !== "The API key is awaiting storage consent. If you decline, enter it again." ? `${current} The API key was not saved. Enter it again to retry.` : "The API key was not saved. Enter it again to retry.");
    }
  }, [consentResolution, creating, saving]);
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
  /**
   * True when the selected provider's endpoint serves BOTH a pay-as-you-go
   * key and a subscription key (MiniMax: its API key and its M Plan key are
   * used on the SAME base URL).
   *
   * There the "Catalog or unknown" mode is NOT the API rate: with no
   * explicit choice the usage is priced as unknown, because an API-rate
   * estimate is simply the wrong number for a subscription user. The select
   * says so, and the option reads as what it does.
   */
  const normalizeBillingUrl = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const sharedBillingEndpoint = selectedEntry?.sharedBillingEndpoint === true || catalog.some((entry) => entry.sharedBillingEndpoint === true && entry.billingBaseUrl !== undefined && normalizeBillingUrl(entry.billingBaseUrl) === normalizeBillingUrl(baseUrl || customBaseUrl));
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
  // GitHub #1: the usage select is Chat-Completions-only — the only transport
  // that carries `stream_options.include_usage`.
  const usageShown = usageVisible(
    transport,
    isNewCustomEndpoint ? CUSTOM_KIND_DEFAULT_TRANSPORT[customKind] : selectedEntry?.defaultTransport,
  );
  // GitHub #41: the reasoning-replay select is shown only where the catalog has
  // no own policy — the custom sentinel, a custom:<id> record, and vllm.
  const replayCatalogMatch = reasoningReplayBaseUrlMatch(catalog, selectedEntry?.catalogBaseUrl);
  const replayTransportShown = reasoningReplayTransportVisible(
    transport,
    isNewCustomEndpoint ? CUSTOM_KIND_DEFAULT_TRANSPORT[customKind] : selectedEntry?.defaultTransport,
  );
  const replayShown =
    reasoningReplayVisible(effectiveProviderId) &&
    // A transport core's replay gate cannot serve (openai-responses) would
    // keep the select inert however it is saved — hide it there too.
    replayTransportShown &&
    // GitHub #41 review: a custom:<id> record whose base URL normalises onto a
    // BUILTIN catalog entry is governed by that entry's own flag — the host
    // resolves `providerName` by base URL (`matchCatalogEntryByBaseUrl`) and
    // core's replay gate (`model-port.ts` `reasoningReplaySource`) returns
    // undefined for a catalog entry without the flag BEFORE it ever consults
    // the connection override, so On (and Off) would be silently inert. Hide
    // the select there; a matched entry WITH the flag keeps it — the override's
    // explicit opt-out (`false` disables replay) still bites in that direction.
    (replayCatalogMatch === undefined || replayCatalogMatch.preserveReasoning === true);
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
  // What the Model field suggests (datalist + chips): the UNION of
  // this session's fetched ids, the ids persisted on the connection (manual
  // additions + earlier fetches), then the static catalog hints. A custom
  // record's session-only fetch result is NOT offered on its own: its checkbox
  // list is the selector's authority, so an unticked id must not reappear here
  // before it is saved.
  const modelSuggestions = liveModelSuggestions(
    isCustomRecordConnection ? null : fetchedModels,
    targetConnection?.models,
    selectedEntry?.models ?? [],
  );
  // The ids the catalog itself offers for this provider — a selected one of
  // these needs no entry in the connection's own list (see
  // `shouldAppendModelToList`).
  const catalogOfferedIds = (selectedEntry?.models ?? []).map((m) => m.id);
  // Show the API-key field IN the create form (item 3): a NEW custom endpoint
  // (the record's own key) or a keyed catalog provider (the connection key).
  // A saved custom record already owns its key; an oauth provider signs in.
  const showKeyInCreate = authKind === "api_key" && (isNewCustomEndpoint || !isCustomRecordConnection);
  const setupMissingModel = createModelMissing(model, selectedEntry?.models ?? [], !!initialCustom, simplified);
  const setupMissingKey = simplified && showKeyInCreate && !noAuth &&
    selectedEntry?.authOptional !== true && secretValue.trim() === "";
  const keyFieldDisabled = readOnly || (isNewCustomEndpoint && noAuth);
  const filteredPickerModels = validVisibleModelIds(mergeModelIds(mergeModelIds(fetchedModels?.map(item => item.id) ?? [], modelSuggestions.map(item => item.id)), mergeModelIds(visibleModelDraft, normalizeModelId(model) ? [normalizeModelId(model)!] : []))).filter(id => id.toLowerCase().includes(modelFilter.toLowerCase()));
  // hints for the Max-output-tokens field (pure logic above): whether
  // the env rung currently silences this field, and what number a blank field
  // actually resolves to. Both read only state already in hand — the drawer's
  // own proxySnapshot and the projected catalog/snapshot.
  const motEnvHint = proxySnapshot === null ? null : maxOutputTokensEnvHint(proxySnapshot.envOverrides);
  let motDefaultHint = maxOutputTokensEffectiveHint(
    selectedEntry,
    model.trim(),
    proxySnapshot?.defaultMaxOutputTokens,
    maxOutputTokens,
  );
  // hints for the Context-window field: same shape as the ceiling hints
  // above — whether the env rung silences the field, and what window a blank
  // field resolves to (catalog min, else the assumed unknown-model fallback).
  const cwEnvHint = proxySnapshot === null ? null : contextWindowTokensEnvHint(proxySnapshot.envOverrides);
  // the model id this form will actually SAVE. The simplified create
  // input saves the catalog-prefilled id (`modelAfterCatalogPrefill`); every
  // other route saves the raw text. Used both for the field's owner and for the
  // create-time "a window needs a model to bind to" gate, so the two never
  // disagree about which model the number belongs to.
  const effectiveFormModel =
    simplified && createdConnectionId === null
      ? modelAfterCatalogPrefill(model, selectedEntry?.models ?? [])
      : model;
  let cwDefaultHint = contextWindowEffectiveHint(
    selectedEntry,
    effectiveFormModel.trim(),
    proxySnapshot,
    contextWindow.raw,
  );
  // hints for the Image-input select: what Auto resolves to for
  // the model this form will save (catalog mark, else the connection's live
  // image-modality list), and whether the live feed rides the env right now.
  let imageInputHint = imageInputEffectiveHint(
    selectedEntry,
    effectiveFormModel.trim(),
    targetConnection,
    imageInput,
  );
  const dictionaryEligible = isNewCustomEndpoint || isCustomRecordConnection || isGatewayProvider(effectiveProviderId);
  const dictionaryMatch = dictionaryEligible ? findKnownModel(effectiveFormModel.trim()) : undefined;
  const knownCatalogModel = !effectiveProviderId.startsWith("custom:") &&
    catalog.find((entry) => entry.id === effectiveProviderId)?.models.some((entry) => entry.id === effectiveFormModel.trim()) === true;
  const reasoningLevels = startModelEffortLevels(
    effectiveProviderId, effectiveFormModel.trim(), catalog.filter((entry) => !entry.id.startsWith("custom:")),
    applyModelReasoningOverride(targetConnection?.modelCapabilities?.[effectiveFormModel.trim()], reasoningSupported),
  );
  const dictionaryActive = !catalogMatchDisabled ? dictionaryMatch : undefined;
  if (dictionaryActive) {
    if (!maxOutputTokens.trim() && dictionaryActive.maxOutputTokens !== undefined) motDefaultHint = `catalog: ${dictionaryActive.maxOutputTokens}`;
    if (!contextWindow.raw.trim()) cwDefaultHint = `catalog: ${Math.min(dictionaryActive.contextWindow, dictionaryActive.usableContextWindow ?? dictionaryActive.contextWindow)}`;
    if (dictionaryActive.imageInput && imageInput === "auto") imageInputHint = "catalog: vision";
  }
  const liveReasoning = targetConnection?.modelCapabilities?.[effectiveFormModel.trim()];
  const effectiveReasoningLevels = reasoningSupported === false ? undefined : effortLevels.length ? effortLevels : (reasoningLevels ?? (liveReasoning?.reasoning !== undefined ? undefined : !catalogMatchDisabled && dictionaryMatch?.reasoning ? (dictionaryMatch.effortLevels ?? ["off", "low", "medium", "high"]) : undefined));
  const imageInputFeedHint = proxySnapshot === null ? null : imageInputEnvHint(proxySnapshot.envOverrides);
  // GitHub #1: shown only while ANYCODE_INCLUDE_USAGE overrides the rung.
  const usageEnvHintText = proxySnapshot === null ? null : usageEnvHint(proxySnapshot.envOverrides);
  // GitHub #41: shown only while ANYCODE_PRESERVE_REASONING overrides the rung.
  const replayEnvHintText = proxySnapshot === null ? null : reasoningReplayEnvHint(proxySnapshot.envOverrides);

  /**
   * the ONE model-changing route. `next` is what goes into the Model
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
      setCatalogMatchDisabled(target?.catalogMatchDisabled === true);
      setCatalogMatchDirty(false);
      setReasoningSupported(target?.reasoningSupported);
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
    // validate the raw model BEFORE the record, connection, secret or
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
    // GitHub #1: create has no `""` sentinel — Automatic is simply absent.
    const usageCreateValue = usageSelectionCreateValue(usageSelection);
    // GitHub #41: same create discipline for the reasoning-replay override;
    // a transport that cannot replay never carries the hidden select's value.
    const replayCreateValue = replayTransportShown ? reasoningReplayCreateValue(replaySelection) : undefined;
    const req = buildCustomProviderCreateRequest({
      name: customName,
      baseUrl: customBaseUrl,
      kind: customKind,
      apiKey: secretValue,
      noAuth,
      // manual ids now live on the CONNECTION's own `models[]`, never
      // on the shared custom record — the record's curated set stays separate.
      selectedModels: [],
    });
    if (req === undefined) {
      setError('Enter a name and base URL, plus an API key or check "This endpoint doesn\'t need an API key".');
      return;
    }
    const commitVersion = onCommitBegin?.() ?? 0;
    onBusyChange?.(true);
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
          // the proxy control is rendered in this pre-create
          // state too, so its value has to travel on THIS create as well —
          // omitting it here silently dropped the choice for every new custom
          // endpoint.
          ...connectionCreateProxyRefField(proxyRef),
          ...(promptCacheEnabled ? { promptCache: IMPLICIT_PROMPT_CACHE } : {}),
          // GitHub #1: the usage select is rendered in this pre-create state
          // too, so its value has to travel on THIS create as well.
          ...(usageCreateValue !== undefined ? { includeUsage: usageCreateValue } : {}),
          // GitHub #41: the reasoning-replay select is rendered in this
          // pre-create state too, so its value travels on THIS create as well.
          ...(replayCreateValue !== undefined ? { preserveReasoning: replayCreateValue } : {}),
          ...(contextWindow.raw.trim() ? { contextWindowTokens: Number(contextWindow.raw) } : {}),
          ...(catalogMatchDisabled ? { catalogMatchDisabled: true as const } : {}),
          ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
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
      onConnectionCreated?.(outcome.createdConnectionId);
      if (outcome.partial) {
        setError(outcome.error ?? "Custom endpoint and connection created, but the model list couldn't be saved — retry with Save.");
      } else {
        onCommitSuccess?.(commitVersion);
      }
    } finally {
      onBusyChange?.(false);
      setCreating(false);
    }
  }

  /** ADD: single primary action — create the connection AND (item 3) fold in the key's secret-set. */
  async function createConnection(): Promise<void> {
    if (readOnly || interactionBlocked) {
      return;
    }
    if (setupMissingModel) {
      setError("Enter a model ID to continue.");
      return;
    }
    if (isNewCustomEndpoint) {
      await createNewCustomEndpoint();
      return;
    }
    if (providerId === "") {
      return;
    }
    // a BLANK cap already means "provider default" at create time
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
    // the same pre-flight for the context window. A BLANK field means
    // "catalog/assumed window" and is simply left out; a MALFORMED one is
    // refused rather than dropped. A numeric window additionally needs the model
    // this create will actually SEND to bind to (EVERY create path now
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
    // ONE effective model for the create payload, the context-window
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
    // an explicit on/off override needs the model this create
    // will actually SEND (main derives the binding and refuses otherwise) —
    // same specific-message pre-flight as the context window above.
    const imageInputError = imageInputModelPreflightError(imageInput, createModel);
    if (imageInputError !== null) {
      setError(imageInputError);
      return;
    }
    // GitHub #1: create has no `""` sentinel — Automatic is simply absent.
    const usageCreateValue = usageSelectionCreateValue(usageSelection);
    // GitHub #41: same create discipline for the reasoning-replay override
    // (visible here only for the vllm template); a transport that cannot
    // replay never carries the hidden select's value.
    const replayCreateValue = replayTransportShown ? reasoningReplayCreateValue(replaySelection) : undefined;
    const commitVersion = onCommitBegin?.() ?? 0;
    onBusyChange?.(true);
    setCreating(true);
    setError(null);
    try {
      const outcome = await createConnectionAndPersistModel(
        modelPersistenceBridge(),
        reloadSnapshot,
        {
          providerId,
          ...(providerId === "openrouter" && openRouterProviders.trim() ? { openRouterProviders: openRouterProviders.split(",").map(v => v.trim()).filter(Boolean) } : {}),
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
          ...(catalogMatchDisabled ? { catalogMatchDisabled: true as const } : {}),
          ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
          ...(effortLevels.length ? { effortLevels } : {}),
          ...(modelEffort !== "" ? { reasoningEffort: modelEffort } : {}),
          // create keeps the conditional-spread form (create's
          // schema has no "" sentinel — omission already means "auto"); only an
          // explicit choice travels, and the binding is server-derived.
          ...(imageInput !== "auto" ? { imageInputOverride: imageInput } : {}),
          // GitHub #15: create keeps the conditional-spread form (create's
          // schema has no "" sentinel — omission already means Off).
          ...(promptCacheEnabled ? { promptCache: IMPLICIT_PROMPT_CACHE } : {}),
          // GitHub #1: Automatic is omitted on create (no `""` sentinel there),
          // an explicit On/Off travels as a real boolean.
          ...(usageCreateValue !== undefined ? { includeUsage: usageCreateValue } : {}),
          // GitHub #41: Automatic is omitted on create, an explicit On/Off
          // travels as a real boolean.
          ...(replayCreateValue !== undefined ? { preserveReasoning: replayCreateValue } : {}),
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
      onConnectionCreated?.(outcome.createdConnectionId);
      // the just-revealed Model field opens on the catalog default
      // instead of blank, so the follow-up Save can't persist the empty-model
      // trap.
      if (!isCustomRecordProviderId(providerId)) {
        setModel((m) => modelAfterCatalogPrefill(m, selectedEntry?.models ?? []));
      }
      // surface a partial failure (connection exists, list does not)
      // WITHOUT losing a concurrent key error — compose one message.
      let message = outcome.partial
        ? (outcome.error ?? "Connection created, but its model list couldn't be saved — retry with Save.")
        : null;
      let keyPending = false;
      // Item 3: fold the key's secret-set into Create for a keyed catalog
      // provider — a separate IPC channel, so custody stays intact and the
      // metadata schema never carries a credential.
      if (secretValue && authKind === "api_key" && !isCustomRecordProviderId(providerId)) {
        const value = secretValue;
        const previousResolution = store.getState().secretConsentResolution;
        dispatchSecret({ type: "submitted" });
        const secretResult = await store.getState().setSecret(connectionSecretKey(outcome.createdConnectionId, "api_key"), value);
        keyPending = !secretResult.ok && secretResult.reason === "weak_storage_needs_consent";
        if (keyPending) pendingKeyCommit.current = { key: connectionSecretKey(outcome.createdConnectionId, "api_key"), version: commitVersion, previous: previousResolution, complete: message === null };
        if (!secretResult.ok && !keyPending) {
          message =
            message === null
              ? "Connection created, but the API key was refused — enter it again below."
              : "Connection created, but neither its model list nor the API key could be saved.";
        }
      }
      if (providerId === "openrouter") {
        try {
          const fetched = await resolvedCustomProvider().fetchModels({ connectionId: outcome.createdConnectionId });
          if (fetched.ok) await reloadSnapshot();
        } catch {
          // A failed catalog refresh must not prevent creating the connection.
        }
      }
      if (message !== null) {
        setError(message);
      } else if (keyPending) {
        setError("The API key is awaiting storage consent. If you decline, enter it again.");
      } else {
        onCommitSuccess?.(commitVersion);
      }
    } finally {
      onBusyChange?.(false);
      setCreating(false);
    }
  }

  /**
   * EDIT / post-create: ONE Save (item 3) — pending metadata changes AND, when
   * a new key was typed, its secret-set (two IPC channels under the hood,
   * custody intact). Metadata and key failures are reported independently.
   */
  async function save(): Promise<void> {
    if (readOnly || interactionBlocked || createdConnectionId === null) {
      return;
    }
    if (modelPopupOpen || (pendingVisibleModels !== null && !pendingVisibleModels.includes(model.trim()))) {
      setError("Finish choosing models and confirm a default before saving. Your selections are kept.");
      return;
    }
    // a nonblank malformed model is refused before the metadata
    // update, the secret write or any list call (a valid, unknown id passes —
    // catalog membership is never validation).
    const preflight = preflightModelId(model);
    if (preflight.kind === "invalid") {
      setError(MODEL_ID_ERROR);
      return;
    }
    const selectedModelId = preflight.kind === "id" ? preflight.id : null;
    // refuse to persist the empty-model trap on a catalog
    // connection — an empty model fails readiness later with a toast that
    // blames the API key.
    if (modelSaveBlocked(model, !isCustomRecordConnection && !isNewCustomEndpoint, modelSuggestions)) {
      setError("Pick a model before saving — without one this connection can't open a tab.");
      return;
    }
    // refuse to send a malformed cap — main's own [1024, 1000000]
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
    // same pre-flight for the context window; a numeric one also needs
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
    // (cross-review): the same blank-model refusal on UPDATE — the
    // sent model is `selectedModelId ?? model`, and main would otherwise reject
    // the whole save with the generic "couldn't be saved" message.
    const imageInputError = imageInputModelPreflightError(imageInput, selectedModelId ?? model);
    if (imageInputError !== null) {
      setError(imageInputError);
      return;
    }
    const commitVersion = onCommitBegin?.() ?? 0;
    const savedSelectionRevision = modelSelectionRevision.current;
    onBusyChange?.(true);
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      // metadata first (the selected model rides it), THEN append the
      // same normalized model to this connection's list. A failed metadata
      // update never appends.
      const outcome = await updateConnectionAndPersistModel(
        modelPersistenceBridge(),
        reloadSnapshot,
        createdConnectionId,
        { ...(effectiveProviderId === "openrouter" ? { openRouterProviders: openRouterProviders.split(",").map(v => v.trim()).filter(Boolean) } : {}), ...buildDrawerSavePayload({
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
          usage: usageSelection,
          replay: replaySelection,
          replayHidden: !replayTransportShown,
        }, { contextWindowDirty, contextWindowTokens: cw.value, reasoningSupportedDirty, reasoningSupported, modelEffortDirty, modelEffort, imageInputDirty, effortLevelsDirty, effortLevels }), ...(isCustomRecordConnection && !showBaseUrl ? { baseUrl: undefined } : {}), ...(catalogMatchDirty ? { catalogMatchDisabled: catalogMatchDisabled ? true as const : "" as const } : {}), ...(pendingVisibleModels !== null ? { visibleModels: pendingVisibleModels } : {}), ...(commitFetchedModels && fetchedModels !== null && fetchedSource !== null ? { fetchedModels: { ...fetchedSource, models: fetchedModels } } : {}), pricing, modelPricing },
        selectedModelId !== null && shouldAppendModelToList(selectedModelId, catalogOfferedIds, isCustomRecordConnection)
          ? selectedModelId
          : null,
      );
      if (outcome.staleFetch) {
        setError("The connection, key or proxy changed after fetching. Fetch again or discard fetched metadata; your model selections are kept.");
        return;
      }
      if (outcome.metaOk) {
        setDirtyRates(new Set());
        // An older request must not discard a model selection made while it ran.
        if (modelSelectionRevision.current === savedSelectionRevision) {
          setPendingVisibleModels(null);
          setCommitFetchedModels(false);
        }
      }
      let keyRefused = false;
      let keyPending = false;
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
          const previousResolution = store.getState().secretConsentResolution;
          dispatchSecret({ type: "submitted" });
          const result = await store.getState().setSecret(mutation.key, mutation.value!);
          keyPending = !result.ok && result.reason === "weak_storage_needs_consent";
          if (keyPending && credentialKey !== undefined) pendingKeyCommit.current = { key: credentialKey, version: commitVersion, previous: previousResolution, complete: outcome.metaOk && outcome.appendOk };
          keyRefused = !result.ok && !keyPending;
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
      } else if (keyPending && credentialKey !== undefined) {
        setError("The API key is awaiting storage consent. If you decline, enter it again.");
      } else {
        if (onCommitSuccess?.(commitVersion) ?? true) flashSavedNotice();
      }
    } finally {
      onBusyChange?.(false);
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
      // (GitHub #10): a custom:<id> connection's shared vault key
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
   * baseUrl/key/kind itself either way; keyless supported). A custom record's
   * fetched ids are merged into its OWN curated `models[]` (persisted through
   * `persistCuratedModels`), which is what its selector reads; they are NOT
   * appended to the connection, because that list is unioned into the selector
   * and would keep an unticked model on offer. A catalog connection's fetch is
   * already merged onto the connection by main.
   */
  function invalidateFetchedReceipt(): void {
    modelSelectionRevision.current++;
    fetchGeneration.current++;
    setPendingVisibleModels(retainedModelSelection(modelPopupOpen, visibleModelDraft, pendingVisibleModels));
    if (fetchedModels !== null || fetchingModels || commitFetchedModels) {
      setError("Fetched metadata was discarded because the connection changed. Your model selections are kept.");
    }
    setFetchedModels(null); setFetchedSource(null); setCommitFetchedModels(false);
  }

  useEffect(() => {
    if (createdConnectionId === null) {
      fetchGeneration.current++;
      setCreateFetchNotice(null);
      setFetchedModels(null);
    }
  }, [createdConnectionId, providerId, baseUrl, customBaseUrl, customKind, transport, secretValue, proxyRef]);

  async function doFetchModels(): Promise<void> {
    if (createdConnectionId === null) {
      const entry = getBuiltinCatalog().providers.find(item => item.id === providerId);
      const explicitBase = isNewCustomEndpoint ? customBaseUrl.trim() : baseUrl.trim();
      const modelsUrl = !explicitBase ? entry?.modelsUrl : undefined;
      const requestBase = explicitBase || selectedEntry?.catalogBaseUrl || "";
      const kind = modelsUrl ? "openai-compatible" : (isNewCustomEndpoint ? customKind : (transport || selectedEntry?.defaultTransport) === "anthropic-messages" ? "anthropic" : "openai-compatible");
      const generation = fetchGeneration.current;
      setFetchingModels(true); setError(null); setCreateFetchNotice(null); setFetchedModels(null);
      try {
        const outcome = await resolvedCustomProvider().fetchModels({ draft: true, baseUrl: requestBase, apiKey: secretValue, kind, ...(!isNewCustomEndpoint ? { catalogProviderId: providerId, useCatalogModelsUrl: !!modelsUrl } : {}), ...connectionCreateProxyRefField(proxyRef) });
        if (generation !== fetchGeneration.current) return;
        if (outcome.ok) {
          setFetchedModels(outcome.models.filter(item => validVisibleModelIds([item.id]).length > 0));
          setCreateFetchNotice(outcome.models.length ? `Key accepted. ${outcome.models.length} model${outcome.models.length === 1 ? "" : "s"} available.` : "Key accepted. Model list unavailable.");
        } else if (outcome.reason === "empty_models") {
          setCreateFetchNotice("Key accepted. Model list unavailable.");
        } else if (outcome.reason === "models_not_supported" || outcome.reason === "invalid_response") {
          setCreateFetchNotice("Model list unavailable. The key could not be checked.");
        } else {
          setError(describeFetchModelsError(outcome.reason));
        }
      } catch {
        if (generation === fetchGeneration.current) setError("Could not fetch models. Try again.");
      } finally {
        setFetchingModels(false);
      }
      return;
    }
    if (proxySnapshot === null) {
      setError("Connection settings are still loading. Your model selections are kept; try fetching again.");
      return;
    }
    const savedProxyRef = proxyRefInitialValue({ kind: "connection", connectionId: createdConnectionId }, proxySnapshot.settings);
    if (hasPendingFetchConnectionChanges({ showBaseUrl, baseUrl, savedBaseUrl: targetConnection?.baseUrl ?? "", transport, savedTransport: targetConnection?.transport ?? "", proxyRef, savedProxyRef, secretValue })) {
      setError("Save changes to the address, transport, key or proxy before fetching models. Your selections are kept.");
      return;
    }
    const generation = fetchGeneration.current;
    setFetchingModels(true);
    setError(null);
    try {
      const outcome = await resolvedCustomProvider().fetchModels({ connectionId: createdConnectionId, preview: true });
      if (generation !== fetchGeneration.current) return;
      if (!outcome.ok) {
        setError(describeFetchModelsError(outcome.reason));
        return;
      }
      if (!outcome.source || outcome.source.baseUrl !== (targetConnection?.baseUrl ?? "").trim() || outcome.source.transport !== (targetConnection?.transport ?? "")) {
        setError("The endpoint changed while fetching models. Reopen the connection and retry.");
        return;
      }
      setFetchedSource(outcome.source ?? null);
      const validModels = outcome.models.filter(item => validVisibleModelIds([item.id]).length > 0);
      setFetchedModels(validModels);
      if (targetConnection?.visibleModels === undefined && pendingVisibleModels === null) {
        setVisibleModelDraft((current) => mergeModelIds(current, validModels.map(item => item.id)));
      }
    } catch {
      if (generation === fetchGeneration.current) setError("Could not fetch models. Your model selections are kept; try again.");
    } finally {
      setFetchingModels(false);
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
  // On the new-custom-endpoint form the provider Name already identifies the
  // row; a second "Label" field next to it reads as the same question twice.
  const labelFieldVisible = showConnectionLabelField(simplified, isNewCustomEndpoint, createdConnectionId !== null);

  const maxOutputInputShown = maxOutputSegmentSelection(maxOutputTokens, maxOutputCustom) === "custom";

  const pricingBlock = (
      <section className="connection-drawer-pricing connection-drawer-band" data-section="04 · Money" aria-label="Pricing">
        <div className="connection-drawer-pricing-heading">
          <span className="settings-field-label">Pricing · USD / 1M tokens <FieldHelp text={sharedBillingEndpoint ? SHARED_BILLING_ONELINER : PRICING_ONELINER} /></span>
          <select aria-label="Billing mode" className="settings-field-select" value={pricingMode} disabled={readOnly} onChange={(e) => setPricingMode(e.target.value as "unset" | "catalog" | "subscription" | "rates")}>
            <option value="unset">{sharedBillingEndpoint ? "Unknown — choose how you are billed" : "Catalog or unknown"}</option>
            {sharedBillingEndpoint && <option value="catalog">Catalog API rate</option>}
            <option value="subscription">By subscription</option><option value="rates">Custom rates</option>
          </select>
        </div>
        <div className="connection-drawer-pricing-scroll">
          <table className="connection-drawer-pricing-table">
            <thead><tr><th scope="col">Model</th>{["Input", "Cached input", "Output", "Cache write (optional)"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">Connection fallback <small>{pricingMode === "rates" ? "Custom" : pricingMode === "subscription" ? "Subscription" : "Catalog or unknown"}</small></th>
                {([["Input", priceInput, setPriceInput], ["Cached input", priceCached, setPriceCached], ["Output", priceOutput, setPriceOutput], ["Cache write (optional)", priceWrite, setPriceWrite]] as const).map(([label, value, set]) => <td key={label}><input aria-label={`Connection fallback ${label}`} className="settings-field-input" type="number" min="0" step="any" value={value} placeholder={label.startsWith("Cache write") ? "Not set" : "—"} disabled={readOnly || pricingMode !== "rates"} onChange={(e) => set(e.target.value)} /></td>)}
              </tr>
              {mergeModelIds(pendingVisibleModels ?? targetConnection?.visibleModels ?? modelSuggestions.map((item) => item.id), mergeModelIds(Object.keys(modelRates), normalizeModelId(model) ? [normalizeModelId(model)!] : [])).map((id) => {
                const custom = Object.hasOwn(modelRates, id);
                const empty = { input: "", cachedInput: "", output: "", cacheWrite: "" };
                const provider = getBuiltinCatalog().providers.find(entry => entry.id === effectiveProviderId);
                const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
                const actualUrl = baseUrl.trim() || provider?.baseUrl || "";
                const catalogPrice = proxySnapshot !== null && !proxySnapshot.envOverrides.includes("ANYCODE_BASE_URL") && provider && actualUrl && normalizeUrl(actualUrl) === normalizeUrl(provider.baseUrl) && (pricingMode === "catalog" || (pricingMode === "unset" && !sharedBillingEndpoint)) ? provider.models.find(item => item.id === id)?.pricing : undefined;
                const livePrice = pricingMode !== "rates" && pricingMode !== "subscription" ? targetConnection?.modelCapabilities?.[id]?.pricing : undefined;
                const fallback = pricingMode === "rates" ? pricingPayload() : undefined;
                const inherited = livePrice ?? (fallback && fallback.mode === "rates" ? fallback : undefined) ?? catalogPrice;
                const inheritedDraft = inherited ? { input: String(inherited.input), cachedInput: inherited.cachedInput === undefined ? "" : String(inherited.cachedInput), output: String(inherited.output), cacheWrite: inherited.cacheWrite === undefined ? "" : String(inherited.cacheWrite) } : empty;
                const draft = ownRateDraft(modelRates, id) ?? inheritedDraft;
                const source = pricingMode === "subscription" ? "Subscription" : livePrice ? "Provider price" : fallback && fallback.mode === "rates" ? "Connection fallback" : catalogPrice?.tariff ? `Catalog peak: ${catalogPrice.tariff.peakUtcDays.map(day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")} ${catalogPrice.tariff.peakUtcHours.map(([start, end]) => `${String(start).padStart(2, "0")}–${String(end).padStart(2, "0")}`).join(", ")} UTC; other times ×${catalogPrice.tariff.offPeakMultiplier}` : catalogPrice ? "Catalog price" : "Unknown";
                return <tr key={id}><th scope="row">{id}<small>{pricingMode === "subscription" ? (custom ? "Subscription · custom rate inactive" : "Subscription") : custom ? "Custom" : source}</small><button type="button" className="settings-button connection-drawer-rate-mode" disabled={readOnly || saving || pricingMode === "subscription"} aria-label={`${id} ${custom ? "use inherited price" : "set custom price"}`} onClick={() => { setModelRates(previous => { const next = { ...previous }; if (custom) delete next[id]; else next[id] = { ...inheritedDraft }; return next; }); setDirtyRates(previous => new Set(previous).add(id)); }}>{custom ? "Use inherited" : "Customize"}</button></th>
                  {([ ["input", "Input"], ["cachedInput", "Cached input"], ["output", "Output"], ["cacheWrite", "Cache write (optional)"] ] as const).map(([key, label]) => <td key={key}><input aria-label={`${id} ${label}`} className="settings-field-input" type="number" min="0" step="any" placeholder={key === "cacheWrite" ? "Not set" : "—"} value={pricingMode === "subscription" ? "" : draft[key]} disabled={readOnly || saving || pricingMode === "subscription" || !custom} onChange={(e) => { const value = e.target.value; setModelRates((previous) => ({ ...previous, [id]: { ...draft, [key]: value } })); setDirtyRates((previous) => new Set(previous).add(id)); }} /></td>)}
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>

  );

  // Everything tuning-related lives in ONE disclosure, rendered once and placed
  // before the primary button in both branches (pre-create and created).
  const advancedBlock = (
    <details
      data-section="05 · Tune"
      className="connection-drawer-advanced connection-drawer-band"
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
      {simplified && labelFieldVisible && labelField}

      <label className="settings-field">
        <span className="settings-field-label">Transport</span>
        <select
          className="settings-field-select"
          value={transport}
          disabled={readOnly}
          onChange={(e) => {
            const next = e.target.value as ProviderTransportId | "";
            if (next !== transport) { invalidateFetchedReceipt(); }
            setTransport(next);
            if (isNewCustomEndpoint && (next === "anthropic-messages" || (next === "" && customKind === "anthropic"))) setNoAuth(false);
          }}
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
            </>
      )}

      {effectiveProviderId === "openrouter" && (
        <label className="settings-field">
          <span className="settings-field-label">OpenRouter providers</span>
          <input className="settings-field-input" value={openRouterProviders} disabled={readOnly} onChange={e => setOpenRouterProviders(e.target.value)} placeholder="Provider slugs, comma-separated" />
          <span className="settings-field-hint">Only these providers will be used; fallback is disabled. Leave empty for automatic routing.</span>
        </label>
      )}
      {/* GitHub #1: per-connection streaming token-usage policy, shown only for
          the transport that actually sends `stream_options.include_usage`. A
          hidden control keeps its state, so switching transport back restores
          the selection and a saved choice is never dropped by a transport edit. */}
      {usageShown && (
        <>
          <label className="settings-field">
            <span className="settings-field-label">
              Request token usage <FieldHelp text={USAGE_HELP} />
            </span>
            <select
              className="settings-field-select"
              value={usageSelection}
              disabled={readOnly}
              onChange={(e) => setUsageSelection(e.target.value as UsageSelection)}
            >
              <option value="auto">Automatic (default)</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
              {usageEnvHintText !== null && (
            <div className="settings-field-hint" role="note">
              {usageEnvHintText}
            </div>
          )}
        </>
      )}

      {/* GitHub #41: per-connection reasoning-replay override, shown only for
          custom endpoints and vLLM — the connections core's replay gate has no
          catalog policy for. A hidden control keeps its state, so switching the
          provider back restores the selection and a saved choice is never
          dropped by a provider edit. */}
      {replayShown && (
        <>
          <label className="settings-field">
            <span className="settings-field-label">
              Reasoning replay <FieldHelp text={REASONING_REPLAY_HELP} />
            </span>
            <select
              className="settings-field-select"
              value={replaySelection}
              disabled={readOnly}
              onChange={(e) => setReplaySelection(e.target.value as ReasoningReplaySelection)}
            >
              <option value="auto">Automatic (provider default)</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <span className="settings-field-hint">{REASONING_REPLAY_ONELINER}</span>
          </label>
          {replayEnvHintText !== null && (
            <div className="settings-field-hint" role="note">
              {replayEnvHintText}
            </div>
          )}
        </>
      )}

      {/* one segmented control. Default writes "" (the
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
          {motEnvHint !== null && (
          <div className="settings-field-hint" role="note">
            {motEnvHint}
          </div>
        )}
      </div>

      {/* per-model context window. Same field shape as "Max output
          tokens" above (whole number in [1024, 1000000], blank = catalog/
          assumed window); a Model edit loads that model's own saved window. */}
      <div className="connection-drawer-scope" title={MODEL_ONLY_BADGE_TITLE}>The following settings apply to this model only</div>
      <label className="settings-field">
        <span className="settings-field-label">
          Context window (tokens) <FieldHelp text={CONTEXT_WINDOW_HELP} />
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
      {/* shown only while ANYCODE_CONTEXT_WINDOW overrides the rung — editing this field then does nothing. */}
      {cwEnvHint !== null && (
        <div className="settings-field-hint" role="note">
          {cwEnvHint}
        </div>
      )}

      {dictionaryMatch && <div className="settings-field">
        <label><input type="checkbox" disabled={readOnly} checked={!catalogMatchDisabled} onChange={(e) => { setCatalogMatchDisabled(!e.target.checked); setCatalogMatchDirty(true); }} /> Recognized as {dictionaryMatch.name ?? dictionaryMatch.id} — use catalog defaults</label>
        {!catalogMatchDisabled && dictionaryMatch.pricing && dictionaryMatch.pricing.tariff === undefined && <div className="settings-field-hint">Catalog reference for {dictionaryMatch.name ?? dictionaryMatch.id}: input ${dictionaryMatch.pricing.input}, cached input ${dictionaryMatch.pricing.cachedInput}{dictionaryMatch.pricing.cacheWrite !== undefined && <>, cache write ${dictionaryMatch.pricing.cacheWrite}</>}, output ${dictionaryMatch.pricing.output} per million tokens. Your endpoint may charge differently.</div>}
      </div>}
      {!knownCatalogModel && <label className="settings-field">
        <span className="settings-field-label">Reasoning support (this model)</span>
        <select className="settings-field-input" aria-label="Reasoning support" disabled={readOnly}
          value={reasoningSupported === false ? "off" : reasoningSupported || effortLevels.length > 0 ? "on" : "auto"} onChange={(e) => { setReasoningSupportedDirty(true); setReasoningSupported(e.target.value === "auto" ? undefined : e.target.value === "on"); if (e.target.value !== "on") { setEffortLevels([]); setEffortLevelsDirty(true); } }}>
          <option value="auto">Auto — catalog or provider metadata</option>
          <option value="on">Supported</option>
          <option value="off">Not supported</option>
        </select>
      </label>}
      {!knownCatalogModel && (reasoningSupported || effortLevels.length > 0) && <fieldset className="settings-field">
        <legend className="settings-field-label">Supported effort levels (empty uses automatic levels)</legend>
        <div className="connection-drawer-effort-levels">
        {(["off", "low", "medium", "high", "xhigh", "max"] as ReasoningEffort[]).map((level) => <label key={level}>
          <input type="checkbox" disabled={readOnly} checked={effortLevels.includes(level)} onChange={(e) => {
            setEffortLevelsDirty(true);
            setReasoningSupported(true);
            setReasoningSupportedDirty(true);
            setEffortLevels((levels) => e.target.checked ? [...levels, level] : levels.filter((item) => item !== level));
          }} /> <span>{level}</span>
        </label>)}
        </div>
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

      {/* per-model image input. Three states: Auto
          (catalog mark, then the connection's live-fetched modality set —
          whichever vouches first), On/Off (a per-model override pair saved
          like the context-window pair above, binding derived server-side).
          Never a connection-wide switch: a blanket "on" would un-gate every
          blind sibling (the glm-5.2 hazard) the moment the user switches. */}
      <label className="settings-field">
        <span className="settings-field-label">
          Image input <FieldHelp text={IMAGE_INPUT_HELP} />
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
      {/* shown while the live-modality feed rides the env. */}
      {imageInputFeedHint !== null && (
        <div className="settings-field-hint" role="note">
          {imageInputFeedHint}
        </div>
      )}

      {/* one instance of the same picker the engine panes and the
          Network pane render — CONTROLLED here, because a connection's ref
          rides this drawer's own create/update payload rather than a channel of
          its own. That is what removes the two-phase "create the connection,
          then bind its proxy" dance. */}
      <ProxyRefPicker
        scope={{ kind: "connection", connectionId: createdConnectionId ?? "" }}
        store={store}
        value={proxyRef}
        onChange={(value) => {
          if (value !== proxyRef) { invalidateFetchedReceipt(); }
          setProxyRef(value);
        }}
      />
      </div>
    </details>
  );

  return (
    <div className="connection-drawer-body">
      <section className="connection-drawer-band connection-drawer-identity" data-section="01 · Who">
      <h3>Identity</h3>
      <label className="settings-field">
        <span className="settings-field-label">Provider</span>
        <select
          className="settings-field-select"
          value={selectDisplayValue}
          disabled={readOnly || templateLocked}
          onChange={(e) => {
            setProviderId(e.target.value);
            onProviderIdChange?.(e.target.value);
            // switching provider clears the model, so the per-model
            // window must go with it. Forced: the new model is empty, and an
            // already-empty owner must not make this look like a no-op.
            changeModel("", "", undefined, true);
          }}
        >
          <option value="" disabled>
            Choose a provider…
          </option>
          {/* one brand = one card — brand-grouped entries
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
            <span className="settings-field-label">Provider name</span>
            <input
              className="settings-field-input"
              type="text"
              value={customName}
              disabled={readOnly}
              placeholder="e.g. LM Studio"
              onChange={(e) => setCustomName(e.target.value)}
            />
            <span className="settings-field-hint">Shown in the provider list on this machine.</span>
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
              onChange={(e) => { const kind = e.target.value as CustomProviderRecord["kind"]; setCustomKind(kind); if (kind === "anthropic" && transport === "") setNoAuth(false); }}
            >
              <option value="openai-compatible">{customProviderKindLabel("openai-compatible")}</option>
              <option value="openai">{customProviderKindLabel("openai")}</option>
              <option value="anthropic">{customProviderKindLabel("anthropic")}</option>
            </select>
          </label>
        </div>
      )}

      {/* Label: top of the dialog; in the first-run flow it stays inside Advanced. */}
      {!simplified && labelFieldVisible && labelField}

      {showBaseUrl && (
        <label className="settings-field">
          <span className="settings-field-label">Base URL</span>
          <input
            className="settings-field-input"
            type="text"
            value={baseUrl}
            disabled={readOnly}
            placeholder="(provider default)"
            onChange={(e) => { invalidateFetchedReceipt(); setBaseUrl(e.target.value); }}
          />
        </label>
      )}

      </section>
      {createdConnectionId === null && (selectedEntry || isNewCustomEndpoint) && <section className="connection-drawer-band" data-section="02 · What"><h3>Model</h3>
      {createdConnectionId === null && selectedEntry && (
        <label className="settings-field">
          <span className="settings-field-label">Model</span>
          <input className="settings-field-input" type="text" list="welcome-model-suggestions"
            value={modelAfterCatalogPrefill(model, selectedEntry.models)} disabled={readOnly}
            placeholder="Enter a model ID"
            onChange={(e) =>
              // the pre-create Model input saves the catalog-prefilled
              // id, so the per-model window is owned by THAT id — route through
              // the shared change so A's number cannot ride onto B.
              changeModel(
                e.target.value,
                modelAfterCatalogPrefill(e.target.value, selectedEntry.models),
                undefined,
              )
            } />
          <datalist id="welcome-model-suggestions">
            {modelSuggestions.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
          </datalist>
        </label>
      )}

      {/* a brand-new custom endpoint gets the same pre-create free-text
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
              // same shared route — the entered id IS the effective id
              // here, so the per-model window reset stays owned by it.
              changeModel(e.target.value, e.target.value, undefined)
            } />
        </label>
      )}

      </section>}
      {isNewCustomEndpoint && (
        <label className="settings-field-checkbox connection-drawer-no-auth">
          <input
            type="checkbox"
            checked={noAuth}
            disabled={readOnly || transport === "anthropic-messages" || (transport === "" && customKind === "anthropic")}
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
      {isNewCustomEndpoint && (transport === "anthropic-messages" || (transport === "" && customKind === "anthropic")) && (
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
          {showKeyInCreate && !noAuth && <div className="connection-drawer-fetch-models">
            <Button type="button" disabled={readOnly || fetchingModels || !secretValue.trim()} onClick={() => void doFetchModels()}>{fetchingModels ? "Fetching…" : "Fetch models"}</Button>
            {createFetchNotice !== null && <p className="settings-field-hint" role="status">{createFetchNotice}</p>}
          </div>}
          {pricingBlock}
          {advancedBlock}
          <div className="settings-field-row connection-drawer-actions">
            {cancelAction}
            <Button variant="primary"
              type="button"

              disabled={readOnly || creating || setupMissingModel || setupMissingKey || (!isNewCustomEndpoint && providerId === "")}
              onClick={() => void createConnection()}
            >
              {creating ? "Connecting…" : simplified && mode === "add" ? "Connect" : mode === "add" ? "Create connection" : "Save"}
            </Button>
          </div>
          {providerId === "" ? <p className="settings-field-hint">Choose a provider to continue.</p> : setupMissingModel && <p className="settings-field-hint">Enter a model ID to continue.</p>}
          {setupMissingKey && <p className="settings-field-hint">Enter your API key to continue.</p>}
        </>
      ) : (
        <>
          <section className="connection-drawer-model-picker connection-drawer-band" data-section="02 · What" aria-label="Models">
            <div className="connection-drawer-model-heading">
              <h3>Model</h3>
              <Button type="button" className="connection-drawer-model-open" disabled={readOnly || fetchingModels} aria-expanded={modelPopupOpen} onClick={() => {
                if (modelPopupOpen) { setModelPopupOpen(false); return; }
                setVisibleModelDraft(validVisibleModelIds(pendingVisibleModels ?? targetConnection?.visibleModels ?? mergeModelIds(modelSuggestions.map(item => item.id), normalizeModelId(model) ? [normalizeModelId(model)!] : [])));
                setModelFilter("");
                setDraftDefaultModel(model.trim());
                setModelPopupOpen(true);
                if (fetchedModels === null && targetConnection?.modelsFetchedAt === undefined && (credentialStatus?.set || noAuth || selectedEntry?.authOptional)) void doFetchModels();
              }}>Fetch models</Button>
            </div>
            <div className="connection-drawer-model-chips" aria-label="Selected models">
              {(pendingVisibleModels ?? targetConnection?.visibleModels ?? mergeModelIds(modelSuggestions.map(item => item.id), normalizeModelId(model) ? [normalizeModelId(model)!] : [])).map(id => <span key={id} data-model-id={id} className={`connection-drawer-model-chip${id === model.trim() ? " connection-drawer-model-chip-selected" : ""}`}>{id === model.trim() ? "★ " : ""}{id}{id === model.trim() ? " · default" : ""}</span>)}
            </div>
            {modelPopupOpen && <div className="connection-drawer-model-popup" role="group" aria-label="Choose models" onKeyDown={event => {
              if (event.key === "Escape") {
                const opener = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".connection-drawer-model-open");
                event.preventDefault(); event.stopPropagation(); setModelPopupOpen(false);
                requestAnimationFrame(() => opener?.focus());
              }
            }}>
              {error !== null && <p className="settings-notice" role="alert">{error}</p>}
              <div className="connection-drawer-model-heading"><strong>Choose models</strong><Button type="button" disabled={readOnly || fetchingModels} onClick={() => void doFetchModels()}>{fetchingModels ? "Fetching…" : "Refresh"}</Button></div>
              <input className="settings-field-input" aria-label="Filter models" autoFocus placeholder="Filter models" value={modelFilter} onChange={e => setModelFilter(e.target.value)} />
              <div className="connection-drawer-model-heading"><Button type="button" disabled={readOnly || fetchingModels} onClick={() => setVisibleModelDraft(current => mergeModelIds(current, filteredPickerModels))}>Select all</Button><Button type="button" disabled={readOnly || fetchingModels} onClick={() => setVisibleModelDraft(current => current.filter(id => !filteredPickerModels.includes(id)))}>Clear all</Button></div>
              <div className="connection-drawer-popup-list">
                {filteredPickerModels.map(id => <div className="connection-drawer-popup-row" key={id}>
                  <label><input type="checkbox" checked={visibleModelDraft.includes(id)} disabled={readOnly || fetchingModels} onChange={e => setVisibleModelDraft(current => e.target.checked ? mergeModelIds(current, [id]) : current.filter(item => item !== id))} /> {id}</label>
                  <Button size="sm" type="button" aria-label={`Set ${id} as default`} aria-pressed={draftDefaultModel === id} disabled={readOnly || fetchingModels} onClick={() => { setVisibleModelDraft(current => mergeModelIds(current, [id])); setDraftDefaultModel(id); }}>{draftDefaultModel === id ? "★" : "☆"}</Button>
                </div>)}
              </div>
              <div className="connection-drawer-popup-manual"><input className="settings-field-input" aria-label="Manual model ID" placeholder="Enter a model ID" value={manualModel} onChange={e => setManualModel(e.target.value)} /><Button type="button" className="connection-drawer-model-add" disabled={readOnly || normalizeModelId(manualModel) === null} onClick={() => { const id = normalizeModelId(manualModel); if (id) { setVisibleModelDraft(current => mergeModelIds(current, [id])); setManualModel(""); } }}>Add</Button></div>
              <div className="connection-drawer-model-heading"><span>{visibleModelDraft.length} selected</span><Button type="button" className="connection-drawer-model-done" disabled={readOnly || fetchingModels || visibleModelDraft.length === 0} onClick={() => {
                modelSelectionRevision.current++;
                const defaultModel = visibleModelDraft.includes(draftDefaultModel) ? draftDefaultModel : visibleModelDraft[0]!;
                setPendingVisibleModels(visibleModelDraft);
                setCommitFetchedModels(fetchedModels !== null);
                changeModel(defaultModel, defaultModel, targetConnection);
                setModelPopupOpen(false);
              }}>Done</Button></div>
            </div>}
          </section>

          <section className="settings-section connection-drawer-credential connection-drawer-band" data-section="03 · Trust">
            <div className="settings-section-title">
              {authKind === "oauth"
                ? "Sign-in"
                : noAuth || selectedEntry?.authOptional === true
                  ? "API key (optional)"
                  : "API key"}
            </div>
            {effectiveProviderId.startsWith("custom:") && <p className="settings-field-hint">This key is shared by connections using this custom provider. Replacing or clearing it affects all of them.</p>}
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
                <div className="connection-drawer-key-row">
                  {credentialStatus ? (
                    <span className={`settings-secret-status settings-secret-status-${describeSecretStatus(credentialStatus).tone}`}>
                      {describeSecretStatus(credentialStatus).text}
                    </span>
                  ) : <span className="settings-secret-status">Not set</span>}
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
                    onChange={(e) => {
                      invalidateFetchedReceipt();
                      dispatchSecret({ type: "change", value: e.target.value });
                    }}
                  />
                </label>
                  <Button variant="danger" data-automation="clear-key"
                    type="button"

                    disabled={readOnly || clearing || !credentialStatus?.set}
                    onClick={() => void clearSecretValue()}
                  >
                    Clear key
                  </Button>
                </div>
              </>
            )}
          </section>

          {pricingBlock}
          {advancedBlock}

          {/* ONE Save (item 3): metadata + (if typed) the key, together. */}
          <div className="settings-field-row connection-drawer-actions">
            {cancelAction}
            <Button variant="primary"
              type="button"
              className="connection-drawer-save"
              disabled={readOnly || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            {savedNotice && (
              <span className="connection-drawer-saved" role="status">
                Saved
              </span>
            )}
          </div>
        </>
      )}

      {error !== null && !modelPopupOpen && (
        <div className="settings-notice" role="alert">
          {error}
          {commitFetchedModels && <Button type="button" onClick={() => { modelSelectionRevision.current++; setFetchedModels(null); setFetchedSource(null); setCommitFetchedModels(false); setError("Fetched metadata discarded. Your model selections are kept; save or fetch again."); }}>Discard fetched metadata</Button>}
        </div>
      )}

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
  initialCustom?: { name: string; baseUrl: string; kind: CustomProviderRecord["kind"] };
  onClose(): void;
  store?: SettingsStoreApi;
  /** Injectable custom-provider bridge; forwarded to the fields. */
  customProvider?: CustomProviderBridge;
}

/**
 * Header text for the drawer. A create flow that SUCCEEDS is editing from
 * that moment on (the form switches to the created connection); leaving the
 * title at "Add connection" reads as if nothing was saved.
 */
export function connectionDrawerTitle(mode: "add" | "edit", created: boolean): "Add connection" | "Edit connection" {
  return mode === "edit" || created ? "Edit connection" : "Add connection";
}

/** Native-`<dialog>` wrapper around `ConnectionDrawerFields` for the Settings grid's Add/Edit action. */
export function ConnectionDrawer({ open, onClose, ...fieldsProps }: ConnectionDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The create path lives inside `fieldsProps`; the one fact the header needs
  // is the id it reported, never a change in list length (a connection written
  // elsewhere must not turn an unsaved Add form into "Edit connection").
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editVersion = useRef(0);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const closeTriggerRef = useRef<HTMLElement | null>(null);
  const markDirty = () => { editVersion.current += 1; setDirty(true); };
  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      closeTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmDiscard(true);
    } else onClose();
  };
  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
    else if (closeTriggerRef.current?.isConnected) { closeTriggerRef.current.focus(); closeTriggerRef.current = null; }
  }, [confirmDiscard]);

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
    if (open) { setCreatedId(null); setDirty(false); setConfirmDiscard(false); setBusy(false); editVersion.current = 0; }
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
      aria-label={connectionDrawerTitle(fieldsProps.mode, createdId !== null)}
      onCancel={(event) => {
        // item 4: act only on THIS drawer's own Escape — the shared
        // guard also stops this cancel (which React propagates up the tree)
        // from reaching the parent SettingsDialog's onCancel.
        if (!isOwnDialogCancel(event)) {
          return;
        }
        event.preventDefault();
        if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
      }}
      onChangeCapture={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".connection-drawer-model-popup")) markDirty();
      }}
      onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".connection-drawer-rate-mode, .connection-drawer-model-done, .connection-drawer-segmented-btn")) markDirty();
      }}
    >
      <div className="connection-drawer-header" inert={confirmDiscard || undefined} aria-hidden={confirmDiscard || undefined}>
        <span className="connection-drawer-title">{connectionDrawerTitle(fieldsProps.mode, createdId !== null)}</span>
        <IconButton className="connection-drawer-close" label="Close" icon={<X aria-hidden="true" />} disabled={busy} onClick={requestClose} />
      </div>
      {/* Re-mounted (keyed) on every open so a prior connection's local form
          state (label/model/…) never leaks into the next Add/Edit — matches
          SettingsScreen's own `key={activePane}` remount discipline. */}
      <div inert={confirmDiscard || undefined} aria-hidden={confirmDiscard || undefined}>
      <ConnectionDrawerFields
        key={fieldsProps.editConnection?.id ?? "add"}
        {...fieldsProps}
        onConnectionCreated={(connectionId) => setCreatedId(connectionId)}
        cancelAction={<Button type="button" disabled={busy} onClick={requestClose}>Cancel</Button>}
        onCommitBegin={() => editVersion.current}
        onCommitSuccess={(version) => {
          if (version !== editVersion.current) return false;
          setDirty(false);
          return true;
        }}
        onBusyChange={setBusy}
        interactionBlocked={confirmDiscard}
      />
      </div>
      {confirmDiscard && <div className="connection-drawer-discard" role="alertdialog" aria-modal="true" aria-labelledby="connection-discard-title">
        <p id="connection-discard-title">Discard unsaved changes?</p>
        <div className="settings-field-row">
          <button ref={keepEditingRef} type="button" className="settings-button" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          <Button variant="danger" type="button" disabled={busy} onClick={() => { if (!busy) onClose(); }}>Discard changes</Button>
        </div>
      </div>}
    </dialog>
  );
}

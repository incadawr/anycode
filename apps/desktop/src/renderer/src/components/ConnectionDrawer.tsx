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
 * CUSTODY: the credential `<input>` is write-only — `secretFieldReducer`
 * (SettingsScreen.tsx) clears it back to `""` the instant Save is clicked,
 * and Edit never pre-fills it from a `SecretStatus` (which structurally holds
 * no value). Plaintext travels only via `store.setSecret`, keyed on the
 * connection's OWN vault key (`provider.connection.<id>.{apiKey,oauth}`) —
 * never a legacy key.
 */
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type {
  CatalogSummary,
  CatalogSummaryEntry,
  ConnectionUpdateRequest,
  CustomProviderRecord,
  ProviderConnection,
  ProviderTransportId,
  SecretStatus,
  SettingsMutationResult,
} from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { connectionSecretKey, customProviderSecretKey, isCustomRecordProviderId } from "./ConnectionTile.js";
import {
  OAuthCredentialBlock,
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

/**
 * The connection-update payload the unified `save` sends (TASK.45 W12-FIX §3;
 * TASK.58 folded the former separate `saveMetadata` into `save`):
 * `transport` is sent UNCONDITIONALLY (never omitted) — the local state
 * already speaks the channel's `ProviderTransportId | ""` sentinel, so
 * omitting it on `""` would leave an existing explicit choice untouched
 * instead of clearing it back to catalog default, the exact asymmetry this
 * fix closes. `createConnection`'s payload is NOT this shape — at create time
 * an omitted transport already means "use the default", so it keeps the old
 * conditional-spread form. Exported for direct testing (no jsdom).
 */
export function buildConnectionUpdatePayload(params: {
  connectionId: string;
  label: string;
  model: string;
  transport: ProviderTransportId | "";
  baseUrl: string;
  showBaseUrl: boolean;
  authOptional: boolean;
}): ConnectionUpdateRequest {
  return {
    id: params.connectionId,
    label: params.label.trim(),
    model: params.model.trim(),
    transport: params.transport,
    baseUrl: params.showBaseUrl ? params.baseUrl.trim() : "",
    // Sent unconditionally, same rationale as `transport`: `false` must CLEAR
    // a previously-persisted flag, not leave it untouched.
    authOptional: params.authOptional,
  };
}

/**
 * The model suggestions a catalog connection's drawer offers (datalist +
 * click-to-fill chips): the LIVE list when one exists — this session's fetch
 * result first, else the ids persisted on the connection by an earlier fetch
 * — decorated with the catalog entry's static display names where known; the
 * static hints alone before any fetch (exactly the pre-fetch behavior).
 * Mirrors `providerModelsFor`'s live-over-static precedence so the drawer and
 * the composer pickers can never disagree about WHAT the provider offers.
 * Exported for direct testing (no jsdom in this package's vitest config, see
 * file docstring).
 */
export function liveModelSuggestions(
  fetched: readonly { id: string }[] | null,
  persisted: readonly string[] | undefined,
  hints: readonly { id: string; name?: string }[],
): { id: string; name?: string }[] {
  const liveIds =
    fetched !== null
      ? fetched.map((m) => m.id)
      : persisted !== undefined && persisted.length > 0
        ? [...persisted]
        : null;
  if (liveIds === null) {
    return [...hints];
  }
  return liveIds.map((id) => {
    const hint = hints.find((h) => h.id === id);
    return hint?.name !== undefined ? { id, name: hint.name } : { id };
  });
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
  initialFocus?: "label" | "credential";
  store?: SettingsStoreApi;
  /** Injectable custom-provider bridge (TASK.58); defaults to the real `window.anycode.customProvider`. */
  customProvider?: CustomProviderBridge;
  /** Rendered after the form (ConnectionDrawer supplies a "Done" button; WelcomeScreen's embed omits it — App's own readiness gate unmounts Welcome once the first connection is ready). */
  footer?: ReactNode;
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
}: ConnectionDrawerFieldsProps) {
  const labelInputRef = useRef<HTMLInputElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const oauthPendingProviderId = useStore(store, (s) => s.oauthPendingProviderId);

  // Add mode: `""` until the user picks a template AND clicks "Create
  // connection"; edit mode: fixed to the connection's own id for this drawer's
  // whole lifetime (the template can never change post-creation).
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(editConnection?.id ?? null);
  const [providerId, setProviderId] = useState<string>(editConnection?.providerId ?? "");
  const [label, setLabel] = useState(editConnection?.label ?? "");
  const [model, setModel] = useState(editConnection?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(editConnection?.baseUrl ?? "");
  const [transport, setTransport] = useState<ProviderTransportId | "">(editConnection?.transport ?? "");
  const [noAuth, setNoAuth] = useState(editConnection?.authOptional === true);
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

  useEffect(() => {
    if (initialFocus === "credential") {
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
  // What the Model field suggests (datalist + chips): live-fetched ids when
  // available (this session's fetch, else the list persisted on the
  // connection), static catalog hints otherwise.
  const modelSuggestions = liveModelSuggestions(fetchedModels, targetConnection?.models, selectedEntry?.models ?? []);
  // Show the API-key field IN the create form (item 3): a NEW custom endpoint
  // (the record's own key) or a keyed catalog provider (the connection key).
  // A saved custom record already owns its key; an oauth provider signs in.
  const showKeyInCreate = authKind === "api_key" && (isNewCustomEndpoint || !isCustomRecordConnection);
  const keyFieldDisabled = readOnly || (isNewCustomEndpoint && noAuth);

  async function reloadSnapshot(): Promise<void> {
    await store.getState().load();
  }

  /** ADD: mint a NEW custom-provider record (key or keyless), then a connection pointing at it. */
  async function createNewCustomEndpoint(): Promise<void> {
    const req = buildCustomProviderCreateRequest({
      name: customName,
      baseUrl: customBaseUrl,
      kind: customKind,
      apiKey: secretValue,
      noAuth,
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
      const connResult = await store.getState().connectionCreate({
        providerId: newId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(transport ? { transport } : {}),
      });
      const createdId = resolveCreatedConnectionId(connResult);
      if (createdId === undefined) {
        // Partial failure surfaced honestly: the record exists (Custom
        // providers list), but the connection does not.
        setProviderId(newId);
        setError("Custom endpoint saved, but the connection couldn't be created — select it above and try again.");
        return;
      }
      setProviderId(newId);
      setCreatedConnectionId(createdId);
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
    setCreating(true);
    setError(null);
    try {
      const result = await store.getState().connectionCreate({
        providerId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(transport ? { transport } : {}),
        ...(showBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(noAuth ? { authOptional: true } : {}),
      });
      const createdId = resolveCreatedConnectionId(result);
      if (createdId === undefined) {
        setError("Couldn't create the connection.");
        return;
      }
      setCreatedConnectionId(createdId);
      // Item 3: fold the key's secret-set into Create for a keyed catalog
      // provider — a separate IPC channel, so custody stays intact and the
      // metadata schema never carries a credential.
      if (secretValue && authKind === "api_key" && !isCustomRecordProviderId(providerId)) {
        const value = secretValue;
        dispatchSecret({ type: "submitted" });
        const secretResult = await store.getState().setSecret(connectionSecretKey(createdId, "api_key"), value);
        if (!secretResult.ok && secretResult.reason !== "weak_storage_needs_consent") {
          setError("Connection created, but the API key was refused — enter it again below.");
        }
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
    setSaving(true);
    setError(null);
    try {
      const metaResult = await store.getState().connectionUpdate(
        buildConnectionUpdatePayload({
          connectionId: createdConnectionId,
          label,
          model,
          transport,
          baseUrl,
          showBaseUrl,
          authOptional: noAuth,
        }),
      );
      let keyRefused = false;
      if (secretValue && credentialKey !== undefined) {
        const value = secretValue;
        dispatchSecret({ type: "submitted" });
        const secretResult = await store.getState().setSecret(credentialKey, value);
        keyRefused = !secretResult.ok && secretResult.reason !== "weak_storage_needs_consent";
      }
      if (!metaResult.ok && keyRefused) {
        setError("Neither the changes nor the API key could be saved.");
      } else if (!metaResult.ok) {
        setError("The changes couldn't be saved.");
      } else if (keyRefused) {
        setError("The changes were saved, but the API key was refused.");
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
    try {
      await store.getState().clearSecret(credentialKey);
    } finally {
      setClearing(false);
    }
  }

  /**
   * Models fetch: the guarded /v1/models GET — `{id}` for a saved custom
   * record, `{connectionId}` for a catalog connection (main resolves
   * baseUrl/key/kind itself either way; keyless supported). A catalog
   * connection's successful fetch is persisted by main onto the connection
   * (`models`), so the snapshot reload makes the composer pickers see the
   * live list immediately.
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
      if (!isCustomRecordConnection) {
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

  return (
    <div className="connection-drawer-body">
      <label className="settings-field">
        <span className="settings-field-label">Provider</span>
        <select
          className="settings-field-select"
          value={selectDisplayValue}
          disabled={readOnly || templateLocked}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="" disabled>
            Choose a provider…
          </option>
          {catalog.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.isCustom ? "Custom endpoint…" : entry.name}
            </option>
          ))}
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
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button settings-button-primary"
              disabled={readOnly || creating || (!isNewCustomEndpoint && providerId === "")}
              onClick={() => void createConnection()}
            >
              {creating ? "Creating…" : mode === "add" ? "Create connection" : "Save"}
            </button>
          </div>
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
              onChange={(e) => setModel(e.target.value)}
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
                  onClick={() => setModel(m.id)}
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
  initialFocus?: "label" | "credential";
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

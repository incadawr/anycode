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
  ProviderConnection,
  ProviderTransportId,
  SecretStatus,
  SettingsMutationResult,
} from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { connectionSecretKey } from "./ConnectionTile.js";
import {
  OAuthCredentialBlock,
  TRANSPORT_LABEL,
  describeSecretStatus,
  secretFieldReducer,
  selectProviderEntry,
  shouldShowBaseUrlField,
  transportOptions,
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
 * The connection-update payload `saveMetadata` sends (TASK.45 W12-FIX §3):
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
  const [creating, setCreating] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingSecret, setSavingSecret] = useState(false);

  useEffect(() => {
    if (initialFocus === "credential") {
      secretInputRef.current?.focus();
    } else {
      labelInputRef.current?.focus();
    }
    // Steer focus once, on mount only (mirrors WelcomeScreen's own intentional focus-steal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targetConnection = connections.find((c) => c.id === createdConnectionId) ?? editConnection;
  const effectiveProviderId = createdConnectionId !== null ? (targetConnection?.providerId ?? providerId) : providerId;
  const selectedEntry: CatalogSummaryEntry | undefined = selectProviderEntry(catalog, effectiveProviderId || undefined);
  const showBaseUrl = shouldShowBaseUrlField(selectedEntry);
  const transportChoices = transportOptions(selectedEntry);
  const authKind = selectedEntry?.authKind ?? "api_key";
  const credentialKey = createdConnectionId !== null ? connectionSecretKey(createdConnectionId, authKind) : undefined;
  const credentialStatus = credentialKey !== undefined ? secrets.find((s) => s.key === credentialKey) : undefined;
  const templateLocked = createdConnectionId !== null; // provider identity is fixed once the connection exists
  const selectDisplayValue = providerSelectDisplayValue(effectiveProviderId, templateLocked, catalog);

  async function createConnection(): Promise<void> {
    if (readOnly || providerId === "") {
      return;
    }
    setCreating(true);
    try {
      const result = await store.getState().connectionCreate({
        providerId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(transport ? { transport } : {}),
        ...(showBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(noAuth ? { authOptional: true } : {}),
      });
      const createdId = resolveCreatedConnectionId(result);
      if (createdId !== undefined) {
        setCreatedConnectionId(createdId);
      }
    } finally {
      setCreating(false);
    }
  }

  async function saveMetadata(): Promise<void> {
    if (readOnly || createdConnectionId === null) {
      return;
    }
    setSavingMeta(true);
    try {
      await store.getState().connectionUpdate(
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
    } finally {
      setSavingMeta(false);
    }
  }

  async function saveSecret(): Promise<void> {
    const value = secretValue;
    // CUSTODY: clear the field the instant Save is clicked (secretFieldReducer's
    // own discipline — see SettingsScreen.tsx's docstring).
    dispatchSecret({ type: "submitted" });
    if (!value || credentialKey === undefined) {
      return;
    }
    setSavingSecret(true);
    try {
      await store.getState().setSecret(credentialKey, value);
    } finally {
      setSavingSecret(false);
    }
  }

  async function clearSecretValue(): Promise<void> {
    if (credentialKey === undefined) {
      return;
    }
    await store.getState().clearSecret(credentialKey);
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
              {entry.name}
            </option>
          ))}
        </select>
      </label>

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
          {(selectedEntry?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.id}
            </option>
          ))}
        </datalist>
      </label>

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

      {selectedEntry?.isCustom === true && (
        <label className="settings-field-checkbox">
          <input
            type="checkbox"
            checked={noAuth}
            disabled={readOnly}
            onChange={(e) => {
              const checked = e.target.checked;
              setNoAuth(checked);
              setTransport(transportAfterNoAuthToggle(checked, transport));
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
        <div className="settings-field-row">
          <button
            type="button"
            className="settings-button settings-button-primary"
            disabled={readOnly || creating || providerId === ""}
            onClick={() => void createConnection()}
          >
            {creating ? "Creating…" : mode === "add" ? "Create connection" : "Save"}
          </button>
        </div>
      ) : (
        <>
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button"
              disabled={readOnly || savingMeta}
              onClick={() => void saveMetadata()}
            >
              {savingMeta ? "Saving…" : "Save changes"}
            </button>
          </div>

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
                    className="settings-button settings-button-primary"
                    disabled={readOnly || !secretValue || savingSecret}
                    onClick={() => void saveSecret()}
                  >
                    Save key
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={readOnly || !credentialStatus?.set}
                    onClick={() => void clearSecretValue()}
                  >
                    Clear key
                  </button>
                </div>
              </>
            )}
          </section>
        </>
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

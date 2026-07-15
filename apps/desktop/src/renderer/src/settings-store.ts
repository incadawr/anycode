/**
 * Global (process-wide, NOT per-tab) settings/secret-vault store (slice 2.2,
 * design/slice-2.2-cut.md §3, ruling reviews/slice-2.2-forks-ruling.md §1/§2).
 * Drives `window.anycode.settings.*` and holds the `SettingsSnapshot`, the
 * weak-storage consent flow, and a one-slot notice for settings-originated
 * failures.
 *
 * Deliberately NOT added to store.ts's `DesktopState`: that store is
 * per-tab, one instance PER OPEN TAB, created lazily by tab-registry.ts only
 * once a tab connects (design phase-2.md §2.4). Settings must be readable
 * BEFORE any tab exists — the Welcome screen (ruling §2) renders precisely
 * when `tabs.length === 0` — so this state structurally cannot live on a
 * per-tab store that may not have been created yet. Factory-plus-singleton,
 * mirroring tabs-store.ts: `createSettingsStore` for test isolation (with an
 * injected fake bridge, same DI shape as automation.ts's `AnycodeBridge`),
 * `useSettingsStore` for the app.
 *
 * CUSTODY (design §1 invariant, enforced here): `pendingConsent.value` is the
 * only place this store ever holds a secret's plaintext, and only for the
 * span of one weak-storage consent round-trip (§4) — every code path that
 * reads it (`acceptWeakStorageConsent`, `declineWeakStorageConsent`) also
 * clears it in the same call. `snapshot` itself NEVER carries a value: its
 * `secrets` field is always `SecretStatus[]` (key/set/source/tier only), by
 * the frozen shared/settings.ts contract.
 *
 * OAuth (slice 2.5 §5): `oauthPendingProviderId` is the only state this wave
 * adds, and it only ever holds a provider id, never a token — `oauthStart`/
 * `oauthCancel` carry no secret value in either direction (a decrypted OAuth

 */
import { create } from "zustand";
import type {
  AlwaysAllowRule,
  OAuthStartReason,
  OAuthStartResult,
  PermissionRuleAddRequest,
  SecretKey,
  SettingsMutationReason,
  SettingsMutationResult,
  SettingsPatch,
  SettingsSnapshot,
} from "../../shared/settings.js";
import type { UpdateActionReason, UpdateActionResult, UpdateStatus } from "../../shared/updates.js";

/** Subset of `window.anycode.settings` this store drives, injectable so tests never touch a real `window` (mirrors automation.ts's `AnycodeBridge`). */
export interface SettingsBridge {
  get(): Promise<SettingsSnapshot>;
  set(patch: SettingsPatch): Promise<SettingsMutationResult>;
  setSecret(key: SecretKey, value: string): Promise<SettingsMutationResult>;
  clearSecret(key: SecretKey): Promise<SettingsMutationResult>;
  addRule(rule: PermissionRuleAddRequest): Promise<SettingsMutationResult>;
  // Slice 2.5 (design §4.5): interactive OAuth sign-in / cancel. Neither call
  // ever carries a token value — providerId in, a fresh SettingsSnapshot (or a
  // typed refusal reason) out.
  oauthStart(providerId: string): Promise<OAuthStartResult>;
  oauthCancel(providerId: string): Promise<void>;
}

/**
 * Subset of `window.anycode.updates` the store drives (slice 2.6, design
 * §6) — injectable for the same test-isolation reason as `SettingsBridge`.
 * `onUpdateStatus` is the one push subscription in this store; every other
 * call here is a plain invoke.
 */
export interface UpdatesBridge {
  check(): Promise<UpdateActionResult>;
  download(): Promise<UpdateActionResult>;
  install(): Promise<UpdateActionResult>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}

/**
 * A `secret-set` call refused pending weak-storage consent (ruling §1/design
 * §4). See the module docstring's CUSTODY note — this is the one place a
 * plaintext value is held, and only transiently.
 */
export interface PendingSecretConsent {
  key: SecretKey;
  value: string;
}

export interface SettingsAppState {
  snapshot: SettingsSnapshot | null;
  loadError: string | null;
  /** One-slot notice for a mutation refusal that isn't the consent flow (invalid / read_only, or a rejected consent-persist itself). */
  notice: string | null;
  /** Non-null while the weak-storage consent dialog should be showing. */
  pendingConsent: PendingSecretConsent | null;
  /**
   * Catalog provider id with an interactive OAuth flow in flight ("waiting for
   * browser sign-in…"), or null when no flow is running (slice 2.5 §5). Only
   * ever holds an id — never a token, never any part of the flow's state.
   */
  oauthPendingProviderId: string | null;

  load(): Promise<void>;
  setPatch(patch: SettingsPatch): Promise<SettingsMutationResult>;
  setSecret(key: SecretKey, value: string): Promise<SettingsMutationResult>;
  clearSecret(key: SecretKey): Promise<SettingsMutationResult>;
  addRule(rule: PermissionRuleAddRequest): Promise<SettingsMutationResult>;
  /** Removes one rule from `permissions.alwaysAllow` by sending the array minus that rule (arrays replace wholesale, design §3). */
  removeRule(rule: AlwaysAllowRule): Promise<SettingsMutationResult>;
  /** Persists `security.allowWeakSecretStorage=true`, then retries the parked secret-set exactly once. Clears `pendingConsent` on every path out (success, refusal, or consent-persist itself failing). No-op (returns null) if nothing is pending. */
  acceptWeakStorageConsent(): Promise<SettingsMutationResult | null>;
  /** Discards the parked secret without ever retrying the write. */
  declineWeakStorageConsent(): void;
  setNotice(text: string | null): void;
  /**
   * Begins an interactive OAuth sign-in for a catalog provider (slice 2.5 §5).
   * Sets `oauthPendingProviderId` for the duration of the round-trip (main runs
   * the loopback+PKCE flow) and always clears it before returning, regardless
   * of outcome. Success refreshes the snapshot (the provider's SecretStatus now
   * reads `set: true`); every refusal reason sets a human-readable `notice`.
   */
  oauthStart(providerId: string): Promise<OAuthStartResult>;
  /**
   * Aborts an in-flight OAuth flow for a provider. Forwards to the bridge only
   * — the flow's own pending `oauthStart` call is what clears
   * `oauthPendingProviderId` and sets the `notice` once main resolves it with
   * `{ok:false, reason:"cancelled"}`.
   */
  oauthCancel(providerId: string): Promise<void>;

  // ── slice 2.6 (auto-updater, design §6) ──
  /** Last `UpdateStatus` pushed by main; `idle` until `subscribeUpdates` has wired the push channel (or nothing has happened yet in a dev build). */
  updateStatus: UpdateStatus;
  /** Wires the one-time push subscription into `updateStatus` and returns the unsubscribe (idempotent to call more than once — each call adds its own listener/unsubscribe pair). Intended to be called once, for the app's lifetime, by whichever component is always mounted (SettingsScreen.tsx's `SettingsDialog`). */
  subscribeUpdates(): () => void;
  /** Asks main to check the update feed; a `not_packaged` refusal (dev build) sets a notice. */
  checkForUpdates(): Promise<UpdateActionResult>;
  /** Downloads the update found by the last check; refused (`invalid_state`) unless `updateStatus.kind === "available"`. */
  downloadUpdate(): Promise<UpdateActionResult>;
  /** Quits and installs the downloaded update; refused (`invalid_state`) unless `updateStatus.kind === "downloaded"`. */
  installUpdate(): Promise<UpdateActionResult>;
}

/** Human-readable text for a mutation refusal (design §3/ruling §1) — shared by every mutating action's failure path. */
export function describeMutationFailure(reason: SettingsMutationReason): string {
  switch (reason) {
    case "invalid":
      return "Invalid value — check the fields and try again.";
    case "read_only":
      return "Settings file is a newer version than this app understands — read-only until you upgrade.";
    case "weak_storage_needs_consent":
      return "This system has no secure OS keychain available.";
    case "not_found":
      return "That connection no longer exists — refresh and try again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Human-readable text for an `oauth-start` refusal (design §5) — every reason gets a distinct, non-empty notice, mirroring `describeMutationFailure`. */
export function describeOAuthFailure(reason: OAuthStartReason): string {
  switch (reason) {
    case "unsupported":
      return "This provider does not support OAuth sign-in.";
    case "cancelled":
      return "Sign-in cancelled.";
    case "timeout":
      return "Sign-in timed out waiting for the browser — try again.";
    case "failed":
      return "Sign-in failed — try again.";
    case "read_only":
      return "Settings file is a newer version than this app understands — read-only until you upgrade.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Human-readable text for an update-action refusal (design §6) — same discipline as `describeMutationFailure`. */
export function describeUpdateActionFailure(reason: UpdateActionReason): string {
  switch (reason) {
    case "not_packaged":
      return "Auto-update is only available in the packaged app.";
    case "invalid_state":
      return "Not available right now — try checking for updates again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Pure filter used by `removeRule` — exported so the exact-match semantics are unit-testable without a live store. */
export function withoutRule(
  rules: readonly AlwaysAllowRule[],
  rule: AlwaysAllowRule,
): AlwaysAllowRule[] {
  return rules.filter((r) => !(r.toolName === rule.toolName && r.pattern === rule.pattern));
}

/** The real `window.anycode.settings` bridge, resolved lazily (only read when a caller omits the `bridge` DI parameter at actual call time — never at module load or store creation, so this file stays importable from a plain Node test context with no `window`). */
function realBridge(): SettingsBridge {
  return window.anycode.settings;
}

/** The real `window.anycode.updates` bridge, resolved with the same lazy discipline as `realBridge`. */
function realUpdatesBridge(): UpdatesBridge {
  return window.anycode.updates;
}

/**
 * Builds a settings-store instance. `bridge`/`updatesBridge` are injectable
 * for test isolation; when omitted, each action resolves the real
 * `window.anycode.*` bridge at the moment it actually runs (not at
 * store-creation time) — the same lazy-resolution discipline as
 * automation.ts's `realBridge()`, but pushed one level further in so that
 * even constructing the app's own singleton below never touches `window`.
 */
export function createSettingsStore(bridge?: SettingsBridge, updatesBridge?: UpdatesBridge) {
  function api(): SettingsBridge {
    return bridge ?? realBridge();
  }
  function updatesApi(): UpdatesBridge {
    return updatesBridge ?? realUpdatesBridge();
  }

  return create<SettingsAppState>()((set, get) => ({
    snapshot: null,
    loadError: null,
    notice: null,
    pendingConsent: null,
    oauthPendingProviderId: null,
    updateStatus: { kind: "idle" },

    async load(): Promise<void> {
      try {
        const snapshot = await api().get();
        set({ snapshot, loadError: null });
      } catch (err) {
        set({ loadError: err instanceof Error ? err.message : "Failed to load settings." });
      }
    },

    async setPatch(patch: SettingsPatch): Promise<SettingsMutationResult> {
      const result = await api().set(patch);
      if (result.ok) {
        set({ snapshot: result.snapshot });
      } else {
        set({ notice: describeMutationFailure(result.reason) });
      }
      return result;
    },

    async setSecret(key: SecretKey, value: string): Promise<SettingsMutationResult> {
      const result = await api().setSecret(key, value);
      if (result.ok) {
        set({ snapshot: result.snapshot, pendingConsent: null });
      } else if (result.reason === "weak_storage_needs_consent") {
        // Park the value for one retry round-trip (§4/CUSTODY) instead of
        // surfacing it as a plain notice — SettingsScreen renders the
        // ConsentDialog off `pendingConsent !== null`.
        set({ pendingConsent: { key, value } });
      } else {
        set({ notice: describeMutationFailure(result.reason) });
      }
      return result;
    },

    async clearSecret(key: SecretKey): Promise<SettingsMutationResult> {
      const result = await api().clearSecret(key);
      if (result.ok) {
        set({ snapshot: result.snapshot });
      } else {
        set({ notice: describeMutationFailure(result.reason) });
      }
      return result;
    },

    async addRule(rule: PermissionRuleAddRequest): Promise<SettingsMutationResult> {
      const result = await api().addRule(rule);
      if (result.ok) {
        set({ snapshot: result.snapshot });
      } else {
        set({ notice: describeMutationFailure(result.reason) });
      }
      return result;
    },

    async removeRule(rule: AlwaysAllowRule): Promise<SettingsMutationResult> {
      const current = get().snapshot;
      const alwaysAllow = withoutRule(current?.settings.permissions.alwaysAllow ?? [], rule);
      const result = await api().set({ permissions: { alwaysAllow } });
      if (result.ok) {
        set({ snapshot: result.snapshot });
      } else {
        set({ notice: describeMutationFailure(result.reason) });
      }
      return result;
    },

    async acceptWeakStorageConsent(): Promise<SettingsMutationResult | null> {
      const pending = get().pendingConsent;
      if (!pending) {
        return null;
      }
      const consentResult = await api().set({ security: { allowWeakSecretStorage: true } });
      if (!consentResult.ok) {
        set({ pendingConsent: null, notice: describeMutationFailure(consentResult.reason) });
        return consentResult;
      }
      set({ snapshot: consentResult.snapshot });
      const retryResult = await api().setSecret(pending.key, pending.value);
      // Unconditional clear: whether the retry succeeded or failed for some
      // OTHER reason, the parked plaintext must not survive past this single
      // retry attempt (CUSTODY) — a second weak_storage_needs_consent here
      // (shouldn't happen: consent was just persisted) would otherwise loop.
      set({ pendingConsent: null });
      if (retryResult.ok) {
        set({ snapshot: retryResult.snapshot });
      } else {
        set({ notice: describeMutationFailure(retryResult.reason) });
      }
      return retryResult;
    },

    declineWeakStorageConsent(): void {
      set({ pendingConsent: null });
    },

    setNotice(text: string | null): void {
      set({ notice: text });
    },

    async oauthStart(providerId: string): Promise<OAuthStartResult> {
      set({ oauthPendingProviderId: providerId });
      const result = await api().oauthStart(providerId);
      // Unconditional clear, mirroring acceptWeakStorageConsent's discipline:
      // the pending flag must not survive past this one round-trip regardless
      // of how it resolved.
      set({ oauthPendingProviderId: null });
      if (result.ok) {
        set({ snapshot: result.snapshot });
      } else {
        set({ notice: describeOAuthFailure(result.reason) });
      }
      return result;
    },

    async oauthCancel(providerId: string): Promise<void> {
      await api().oauthCancel(providerId);
    },

    subscribeUpdates(): () => void {
      return updatesApi().onUpdateStatus((status) => set({ updateStatus: status }));
    },

    async checkForUpdates(): Promise<UpdateActionResult> {
      const result = await updatesApi().check();
      if (!result.ok) {
        set({ notice: describeUpdateActionFailure(result.reason) });
      }
      return result;
    },

    async downloadUpdate(): Promise<UpdateActionResult> {
      const result = await updatesApi().download();
      if (!result.ok) {
        set({ notice: describeUpdateActionFailure(result.reason) });
      }
      return result;
    },

    async installUpdate(): Promise<UpdateActionResult> {
      const result = await updatesApi().install();
      if (!result.ok) {
        set({ notice: describeUpdateActionFailure(result.reason) });
      }
      return result;
    },
  }));
}

export type SettingsStoreApi = ReturnType<typeof createSettingsStore>;

/** The app's single settings store (mirrors tabs-store.ts's `useTabsStore`). */
export const useSettingsStore = createSettingsStore();

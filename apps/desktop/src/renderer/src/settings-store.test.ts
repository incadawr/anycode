/**
 * settings-store tests (slice 2.2, design/slice-2.2-cut.md §3/§4, ruling
 * §1/§2): the weak-storage consent round-trip, always-allow rule removal,
 * and — the load-bearing property for the renderer's custody obligation
 * (design §1: "renderer NEVER receives a decrypted secret, only status") —
 * that a secret value typed into `setSecret` never survives anywhere in this
 * store's own state once its round-trip (success, plain refusal, or a full
 * consent accept/decline) has completed.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  OAuthStartReason,
  OAuthStartResult,
  SettingsMutationReason,
  SettingsMutationResult,
  SettingsSnapshot,
} from "../../shared/settings.js";
import type { UpdateActionReason, UpdateActionResult, UpdateStatus } from "../../shared/updates.js";
import {
  createSettingsStore,
  describeMutationFailure,
  describeOAuthFailure,
  describeUpdateActionFailure,
  withoutRule,
  type SettingsBridge,
  type UpdatesBridge,
} from "./settings-store.js";

function baseSettings(): SettingsSnapshot["settings"] {
  return {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

function baseSnapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: baseSettings(),
    secrets: [{ key: "provider.apiKey", set: false, source: "none", tier: "unavailable" }],
    providerReady: false,
    envOverrides: [],
    readOnly: false,
    ...overrides,
  };
}

function fakeBridge(overrides: Partial<SettingsBridge> = {}): SettingsBridge {
  return {
    get: vi.fn().mockResolvedValue(baseSnapshot()),
    set: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    setSecret: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    clearSecret: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    addRule: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    oauthStart: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies OAuthStartResult),
    oauthCancel: vi.fn().mockResolvedValue(undefined),
    connectionUpdate: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    ...overrides,
  };
}

function fakeUpdatesBridge(overrides: Partial<UpdatesBridge> = {}): UpdatesBridge {
  return {
    check: vi.fn().mockResolvedValue({ ok: true } satisfies UpdateActionResult),
    download: vi.fn().mockResolvedValue({ ok: true } satisfies UpdateActionResult),
    install: vi.fn().mockResolvedValue({ ok: true } satisfies UpdateActionResult),
    onUpdateStatus: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe("settings-store: load", () => {
  it("populates snapshot from the bridge", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);

    await store.getState().load();

    expect(store.getState().snapshot).toEqual(baseSnapshot());
    expect(store.getState().loadError).toBeNull();
  });

  it("records a loadError when the bridge rejects, without throwing", async () => {
    const bridge = fakeBridge({ get: vi.fn().mockRejectedValue(new Error("ipc down")) });
    const store = createSettingsStore(bridge);

    await store.getState().load();

    expect(store.getState().loadError).toBe("ipc down");
    expect(store.getState().snapshot).toBeNull();
  });
});

describe("settings-store: plain mutations", () => {
  it("setPatch applies the fresh snapshot on success", async () => {
    const patched = baseSnapshot({ settings: { ...baseSettings(), ui: { theme: "dark" } } });
    const bridge = fakeBridge({ set: vi.fn().mockResolvedValue({ ok: true, snapshot: patched }) });
    const store = createSettingsStore(bridge);

    const result = await store.getState().setPatch({ ui: { theme: "dark" } });

    expect(result).toEqual({ ok: true, snapshot: patched });
    expect(store.getState().snapshot).toEqual(patched);
  });

  it("a plain refusal (invalid/read_only) sets the notice and leaves snapshot untouched", async () => {
    const bridge = fakeBridge({ set: vi.fn().mockResolvedValue({ ok: false, reason: "read_only" }) });
    const store = createSettingsStore(bridge);

    const result = await store.getState().setPatch({ ui: { theme: "dark" } });

    expect(result).toEqual({ ok: false, reason: "read_only" });
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().notice).toBe(describeMutationFailure("read_only"));
  });

  it("clearSecret applies the fresh snapshot on success", async () => {
    const cleared = baseSnapshot();
    const bridge = fakeBridge({ clearSecret: vi.fn().mockResolvedValue({ ok: true, snapshot: cleared }) });
    const store = createSettingsStore(bridge);

    await store.getState().clearSecret("provider.apiKey");

    expect(bridge.clearSecret).toHaveBeenCalledWith("provider.apiKey");
    expect(store.getState().snapshot).toEqual(cleared);
  });

  it("addRule applies the fresh snapshot on success", async () => {
    const withRule = baseSnapshot({
      settings: { ...baseSettings(), permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] } },
    });
    const bridge = fakeBridge({ addRule: vi.fn().mockResolvedValue({ ok: true, snapshot: withRule }) });
    const store = createSettingsStore(bridge);

    await store.getState().addRule({ toolName: "Bash", pattern: "git *" });

    expect(bridge.addRule).toHaveBeenCalledWith({ toolName: "Bash", pattern: "git *" });
    expect(store.getState().snapshot).toEqual(withRule);
  });
});

describe("settings-store: weak-storage consent flow (ruling §1/design §4)", () => {
  it("setSecret on weak_storage_needs_consent parks the value in pendingConsent instead of the snapshot", async () => {
    const bridge = fakeBridge({
      setSecret: vi.fn().mockResolvedValue({ ok: false, reason: "weak_storage_needs_consent" }),
    });
    const store = createSettingsStore(bridge);

    const result = await store.getState().setSecret("provider.apiKey", "sk-super-secret");

    expect(result).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    expect(store.getState().pendingConsent).toEqual({ key: "provider.apiKey", value: "sk-super-secret" });
    // CUSTODY: even while parked for the consent retry, nothing in the
    // snapshot (the only field a consumer component reads for display)
    // carries the plaintext.
    expect(JSON.stringify(store.getState().snapshot)).not.toContain("sk-super-secret");
    expect(store.getState().notice).toBeNull();
  });

  it("acceptWeakStorageConsent persists the consent flag, retries the exact pending secret once, and clears pendingConsent", async () => {
    const readyStatus = { key: "provider.apiKey" as const, set: true, source: "plaintext" as const, tier: "plaintext" as const };
    const setSecret = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "weak_storage_needs_consent" })
      .mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot({ secrets: [readyStatus] }) });
    const set = vi.fn().mockResolvedValue({
      ok: true,
      snapshot: baseSnapshot({ settings: { ...baseSettings(), security: { allowWeakSecretStorage: true } } }),
    });
    const bridge = fakeBridge({ setSecret, set });
    const store = createSettingsStore(bridge);

    await store.getState().setSecret("provider.apiKey", "sk-super-secret");
    expect(store.getState().pendingConsent).not.toBeNull();

    const result = await store.getState().acceptWeakStorageConsent();

    expect(set).toHaveBeenCalledWith({ security: { allowWeakSecretStorage: true } });
    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(setSecret).toHaveBeenNthCalledWith(2, "provider.apiKey", "sk-super-secret");
    expect(result).toEqual({ ok: true, snapshot: baseSnapshot({ secrets: [readyStatus] }) });
    expect(store.getState().pendingConsent).toBeNull();
    expect(store.getState().snapshot?.secrets[0]).toEqual(readyStatus);
    // CUSTODY: after the full accept round-trip, the plaintext is gone from
    // every corner of the store's own state (pendingConsent cleared, and the
    // snapshot never carried it to begin with).
    expect(JSON.stringify(store.getState())).not.toContain("sk-super-secret");
  });

  it("declineWeakStorageConsent discards the pending value and never retries setSecret", async () => {
    const setSecret = vi.fn().mockResolvedValueOnce({ ok: false, reason: "weak_storage_needs_consent" });
    const bridge = fakeBridge({ setSecret });
    const store = createSettingsStore(bridge);

    await store.getState().setSecret("provider.apiKey", "sk-super-secret");
    store.getState().declineWeakStorageConsent();

    expect(store.getState().pendingConsent).toBeNull();
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.getState())).not.toContain("sk-super-secret");
  });

  it("acceptWeakStorageConsent is a no-op (returns null, no bridge calls) when nothing is pending", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);

    const result = await store.getState().acceptWeakStorageConsent();

    expect(result).toBeNull();
    expect(bridge.set).not.toHaveBeenCalled();
    expect(bridge.setSecret).not.toHaveBeenCalled();
  });

  it("a failed consent persist (e.g. read_only) clears pendingConsent, sets a notice, and never attempts the secret retry", async () => {
    const setSecret = vi.fn().mockResolvedValueOnce({ ok: false, reason: "weak_storage_needs_consent" });
    const set = vi.fn().mockResolvedValue({ ok: false, reason: "read_only" } satisfies SettingsMutationResult);
    const bridge = fakeBridge({ setSecret, set });
    const store = createSettingsStore(bridge);

    await store.getState().setSecret("provider.apiKey", "sk-super-secret");
    const result = await store.getState().acceptWeakStorageConsent();

    expect(result).toEqual({ ok: false, reason: "read_only" });
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingConsent).toBeNull();
    expect(store.getState().notice).toBe(describeMutationFailure("read_only"));
  });
});

describe("settings-store: always-allow rule removal", () => {
  it("withoutRule filters by an exact {toolName, pattern} match", () => {
    const rules = [{ toolName: "Bash", pattern: "git *" }, { toolName: "Read" }];
    expect(withoutRule(rules, { toolName: "Bash", pattern: "git *" })).toEqual([{ toolName: "Read" }]);
  });

  it("withoutRule leaves the list untouched when no rule matches", () => {
    const rules = [{ toolName: "Read" }];
    expect(withoutRule(rules, { toolName: "Bash", pattern: "git *" })).toEqual(rules);
  });

  it("removeRule sends the full array minus the removed rule (arrays replace wholesale, design §3)", async () => {
    const existing = [{ toolName: "Bash", pattern: "git *" }, { toolName: "Read" }];
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    store.setState({
      snapshot: baseSnapshot({ settings: { ...baseSettings(), permissions: { alwaysAllow: existing } } }),
    });

    await store.getState().removeRule({ toolName: "Bash", pattern: "git *" });

    expect(bridge.set).toHaveBeenCalledWith({ permissions: { alwaysAllow: [{ toolName: "Read" }] } });
  });

  it("removeRule against an empty/absent snapshot sends an empty array rather than throwing", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);

    await store.getState().removeRule({ toolName: "Bash", pattern: "git *" });

    expect(bridge.set).toHaveBeenCalledWith({ permissions: { alwaysAllow: [] } });
  });
});

describe("describeMutationFailure", () => {
  it("has non-empty, distinct text for every reason", () => {
    const reasons: SettingsMutationReason[] = ["invalid", "read_only", "weak_storage_needs_consent"];
    const texts = reasons.map(describeMutationFailure);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(reasons.length);
  });
});

describe("describeOAuthFailure", () => {
  it("has non-empty, distinct text for every reason", () => {
    const reasons: OAuthStartReason[] = ["unsupported", "cancelled", "timeout", "failed", "read_only"];
    const texts = reasons.map(describeOAuthFailure);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(reasons.length);
  });
});

describe("settings-store: OAuth sign-in (slice 2.5 §5)", () => {
  it("oauthStart sets oauthPendingProviderId for the round-trip, then clears it and applies the fresh snapshot on success", async () => {
    const signedIn = baseSnapshot({
      secrets: [{ key: "provider.acme.oauth" as const, set: true, source: "vault", tier: "os_encrypted" }],
    });
    let capturedDuringFlight: string | null = null;
    const oauthStart = vi.fn().mockImplementation(async () => {
      // Captures the pending state WHILE the bridge call is in flight — the
      // property this test exists to pin down (pending -> ok transition).
      capturedDuringFlight = store.getState().oauthPendingProviderId;
      return { ok: true, snapshot: signedIn } satisfies OAuthStartResult;
    });
    const bridge = fakeBridge({ oauthStart });
    const store = createSettingsStore(bridge);

    expect(store.getState().oauthPendingProviderId).toBeNull();
    const result = await store.getState().oauthStart("acme");

    expect(capturedDuringFlight).toBe("acme");
    expect(oauthStart).toHaveBeenCalledWith("acme");
    expect(result).toEqual({ ok: true, snapshot: signedIn });
    expect(store.getState().oauthPendingProviderId).toBeNull();
    expect(store.getState().snapshot).toEqual(signedIn);
    expect(store.getState().notice).toBeNull();
  });

  it("oauthStart pending -> cancelled: clears the pending flag and sets a notice, snapshot untouched", async () => {
    const bridge = fakeBridge({
      oauthStart: vi.fn().mockResolvedValue({ ok: false, reason: "cancelled" } satisfies OAuthStartResult),
    });
    const store = createSettingsStore(bridge);

    const result = await store.getState().oauthStart("acme");

    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(store.getState().oauthPendingProviderId).toBeNull();
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().notice).toBe(describeOAuthFailure("cancelled"));
  });

  it.each(["unsupported", "timeout", "failed", "read_only"] as const)(
    "oauthStart pending -> %s: clears the pending flag and sets the matching notice",
    async (reason) => {
      const bridge = fakeBridge({
        oauthStart: vi.fn().mockResolvedValue({ ok: false, reason } satisfies OAuthStartResult),
      });
      const store = createSettingsStore(bridge);

      const result = await store.getState().oauthStart("acme");

      expect(result).toEqual({ ok: false, reason });
      expect(store.getState().oauthPendingProviderId).toBeNull();
      expect(store.getState().notice).toBe(describeOAuthFailure(reason));
    },
  );

  it("oauthCancel forwards providerId to the bridge and never touches the store's own state directly", async () => {
    const oauthCancel = vi.fn().mockResolvedValue(undefined);
    const bridge = fakeBridge({ oauthCancel });
    const store = createSettingsStore(bridge);

    await store.getState().oauthCancel("acme");

    expect(oauthCancel).toHaveBeenCalledWith("acme");
    expect(oauthCancel).toHaveBeenCalledTimes(1);
  });

  it("CUSTODY: neither oauthStart nor oauthCancel ever carries anything but a providerId — the bridge never receives or returns a token", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);

    await store.getState().oauthStart("acme");
    await store.getState().oauthCancel("acme");

    expect(bridge.oauthStart).toHaveBeenCalledWith("acme");
    expect((bridge.oauthStart as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["acme"]);
    expect(bridge.oauthCancel).toHaveBeenCalledWith("acme");
    expect((bridge.oauthCancel as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["acme"]);
    // The only OAuth-shaped field this store ever holds is a provider id.
    expect(JSON.stringify(store.getState())).not.toMatch(/sk-|token|bearer/i);
  });
});

describe("describeUpdateActionFailure", () => {
  it("has non-empty, distinct text for every reason", () => {
    const reasons: UpdateActionReason[] = ["not_packaged", "invalid_state"];
    const texts = reasons.map(describeUpdateActionFailure);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(reasons.length);
  });
});

describe("settings-store: auto-updater (slice 2.6 §6)", () => {
  it("starts idle before any subscription/check", () => {
    const store = createSettingsStore(fakeBridge(), fakeUpdatesBridge());
    expect(store.getState().updateStatus).toEqual({ kind: "idle" });
  });

  it("subscribeUpdates wires the bridge's push callback into updateStatus and returns its unsubscribe", () => {
    let captured: ((status: UpdateStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    const updatesBridge = fakeUpdatesBridge({
      onUpdateStatus: vi.fn().mockImplementation((cb: (status: UpdateStatus) => void) => {
        captured = cb;
        return unsubscribe;
      }),
    });
    const store = createSettingsStore(fakeBridge(), updatesBridge);

    const returned = store.getState().subscribeUpdates();
    expect(captured).toBeDefined();

    captured?.({ kind: "available", version: "1.2.3" });
    expect(store.getState().updateStatus).toEqual({ kind: "available", version: "1.2.3" });

    returned();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("checkForUpdates forwards to the bridge and sets a notice on refusal (e.g. a dev build)", async () => {
    const check = vi.fn().mockResolvedValue({ ok: false, reason: "not_packaged" } satisfies UpdateActionResult);
    const store = createSettingsStore(fakeBridge(), fakeUpdatesBridge({ check }));

    const result = await store.getState().checkForUpdates();

    expect(check).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "not_packaged" });
    expect(store.getState().notice).toBe(describeUpdateActionFailure("not_packaged"));
  });

  it("downloadUpdate forwards to the bridge and sets a notice on refusal (e.g. invalid_state)", async () => {
    const download = vi.fn().mockResolvedValue({ ok: false, reason: "invalid_state" } satisfies UpdateActionResult);
    const store = createSettingsStore(fakeBridge(), fakeUpdatesBridge({ download }));

    const result = await store.getState().downloadUpdate();

    expect(download).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "invalid_state" });
    expect(store.getState().notice).toBe(describeUpdateActionFailure("invalid_state"));
  });

  it("installUpdate forwards to the bridge and leaves no notice on success", async () => {
    const install = vi.fn().mockResolvedValue({ ok: true } satisfies UpdateActionResult);
    const store = createSettingsStore(fakeBridge(), fakeUpdatesBridge({ install }));

    const result = await store.getState().installUpdate();

    expect(install).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(store.getState().notice).toBeNull();
  });
});

/**
 * Unit tests for the vision-fallback recognizer's live-push contract (TASK.198
 * E1): the wire message shape and the fingerprint pure logic main's mutation
 * hooks use to decide whether a push is even worth resolving a secret for
 * (plan §1.2/§7 finding #7 — a resolved secret must never ride an unrelated
 * mutation's wire).
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings, CustomProviderRecord, ProviderConnection } from "./settings.js";
import {
  RECOGNIZER_CONFIG_CHANGED_TYPE,
  recognizerConnectionSecretKey,
  recognizerCustomRecordSecretKey,
  recognizerFingerprint,
  recognizerFingerprintsEqual,
  recognizerSecretTargetKey,
  type RecognizerFingerprint,
} from "./recognizer.js";

function connection(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id: "conn-vision", providerId: "openai", ...over };
}

function settings(over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...over,
  };
}

describe("recognizerFingerprint", () => {
  it("is undefined when settings.recognizer is absent", () => {
    expect(recognizerFingerprint(settings())).toBeUndefined();
  });

  it("is undefined when the connectionId is dangling", () => {
    const s = settings({
      provider: { connections: [] },
      recognizer: { connectionId: "conn-gone", modelId: "vision-model" },
    });
    expect(recognizerFingerprint(s)).toBeUndefined();
  });

  it("carries connectionId+modelId+baseUrl+transport of the resolved connection", () => {
    const s = settings({
      provider: { connections: [connection({ baseUrl: "https://vision.example.com", transport: "openai-chat-completions" })] },
      recognizer: { connectionId: "conn-vision", modelId: "vision-model" },
    });
    expect(recognizerFingerprint(s)).toEqual({
      connectionId: "conn-vision",
      modelId: "vision-model",
      baseUrl: "https://vision.example.com",
      transport: "openai-chat-completions",
    });
  });
});

describe("recognizerFingerprintsEqual", () => {
  const base: RecognizerFingerprint = { connectionId: "conn-vision", modelId: "vision-model" };

  it("two undefineds are equal (off stays off — no push)", () => {
    expect(recognizerFingerprintsEqual(undefined, undefined)).toBe(true);
  });

  it("undefined never equals a concrete fingerprint (on/off is always a change)", () => {
    expect(recognizerFingerprintsEqual(undefined, base)).toBe(false);
    expect(recognizerFingerprintsEqual(base, undefined)).toBe(false);
  });

  it("identical field-for-field fingerprints are equal", () => {
    expect(recognizerFingerprintsEqual(base, { ...base })).toBe(true);
  });

  it("a changed modelId is a change even when the connection stays the same", () => {
    expect(recognizerFingerprintsEqual(base, { ...base, modelId: "vision-model-2" })).toBe(false);
  });

  it("a changed baseUrl (the SAME connectionId now resolves elsewhere) is a change", () => {
    expect(recognizerFingerprintsEqual(base, { ...base, baseUrl: "https://moved.example.com" })).toBe(false);
  });

  it("a changed transport is a change", () => {
    expect(
      recognizerFingerprintsEqual(
        { ...base, transport: "anthropic-messages" },
        { ...base, transport: "openai-chat-completions" },
      ),
    ).toBe(false);
  });
});

describe("RECOGNIZER_CONFIG_CHANGED_TYPE", () => {
  it("is a stable, namespaced parentPort message type", () => {
    expect(RECOGNIZER_CONFIG_CHANGED_TYPE).toBe("anycode:recognizer-config-changed");
  });
});

describe("recognizerFingerprint — custom-provider route (TASK.202)", () => {
  const record: CustomProviderRecord = {
    id: "custom:vision-slug",
    name: "Vision custom",
    baseUrl: "https://rec.example.com/v1",
    kind: "openai-compatible",
    models: ["vision-model-x"],
  };

  function customSettings(over: { record?: CustomProviderRecord[]; connection?: Partial<ProviderConnection> } = {}): AnycodeSettings {
    return settings({
      provider: {
        connections: [
          connection({
            id: "conn-v",
            providerId: "custom:vision-slug",
            transport: "openai-chat-completions",
            ...over.connection,
          }),
        ],
        custom: over.record === undefined ? [record] : over.record,
      },
      recognizer: { connectionId: "conn-v", modelId: "vision-model-x" },
    });
  }

  it("uses the backing CustomProviderRecord's baseUrl for a custom:* connection, leaving the connection's own (empty) baseUrl out", () => {
    const fingerprint = recognizerFingerprint(customSettings());
    expect(fingerprint).toEqual({
      connectionId: "conn-v",
      modelId: "vision-model-x",
      baseUrl: "https://rec.example.com/v1",
      transport: "openai-chat-completions",
    });
    // The connection carries NO baseUrl of its own — the fingerprint's address
    // came from the record, not the connection.
    expect(fingerprint?.baseUrl).not.toBe(customSettings().provider.connections[0]?.baseUrl);
  });

  it("RED-PROOF: editing the record's baseUrl changes the fingerprint; a connection-scoped edit of the empty field does not", () => {
    const before = recognizerFingerprint(customSettings());
    // The record's baseUrl moves — the resolver would follow it, so the
    // fingerprint must move too.
    const afterRecordEdit = recognizerFingerprint(
      customSettings({
        record: [
          { ...record, baseUrl: "https://rec-moved.example.com/v1" },
        ],
      }),
    );
    expect(recognizerFingerprintsEqual(before, afterRecordEdit)).toBe(false);
    // Writing the SAME value into the connection's own (blank-in-practice)
    // baseUrl field must change nothing — the custom route never reads it.
    const afterConnectionEdit = recognizerFingerprint(
      customSettings({ connection: { baseUrl: "https://rec.example.com/v1" } }),
    );
    expect(recognizerFingerprintsEqual(before, afterConnectionEdit)).toBe(true);
  });

  it("a deleted record yields a concrete fingerprint with a moved baseUrl — deletion is a change, and the later null-endpoint push can fire", () => {
    const before = recognizerFingerprint(customSettings());
    const afterDeletion = recognizerFingerprint(customSettings({ record: [] }));
    // NOT fingerprint-undefined: the connection still exists, so the push
    // comparison sees a concrete moved value (undefined baseUrl) and the
    // resolver's later null-endpoint push (fail-closed) can fire.
    expect(afterDeletion).not.toBeUndefined();
    expect(afterDeletion?.baseUrl).toBeUndefined();
    expect(recognizerFingerprintsEqual(before, afterDeletion)).toBe(false);
  });

  it("a non-custom connection keeps reading connection.baseUrl (resolver parity for the primary route)", () => {
    const s = settings({
      provider: { connections: [connection({ baseUrl: "https://vision.example.com", transport: "anthropic-messages" })] },
      recognizer: { connectionId: "conn-vision", modelId: "vision-model" },
    });
    expect(recognizerFingerprint(s)).toEqual({
      connectionId: "conn-vision",
      modelId: "vision-model",
      baseUrl: "https://vision.example.com",
      transport: "anthropic-messages",
    });
  });
});

describe("recognizerSecretTargetKey (TASK.202)", () => {
  it("matches the recognizer connection's api_key and the custom record's key for a custom selection; nothing else", () => {
    const normal = settings({
      provider: {
        connections: [connection({ id: "conn-v", providerId: "openai" }), connection({ id: "conn-other", providerId: "openai" })],
      },
      recognizer: { connectionId: "conn-v", modelId: "vision-model" },
    });
    expect(recognizerSecretTargetKey(normal, "provider.connection.conn-v.apiKey")).toBe(true);
    expect(recognizerSecretTargetKey(normal, "provider.connection.conn-other.apiKey")).toBe(false);
    expect(recognizerSecretTargetKey(normal, "provider.custom:x.apiKey")).toBe(false);
    expect(recognizerSecretTargetKey(normal, "proxy.profile.p.password")).toBe(false);

    const custom = settings({
      provider: {
        connections: [connection({ id: "conn-v", providerId: "custom:vision-slug" })],
        custom: [
          { id: "custom:vision-slug", name: "Vision custom", baseUrl: "https://rec.example.com/v1", kind: "openai-compatible", models: ["vision-model-x"] },
        ],
      },
      recognizer: { connectionId: "conn-v", modelId: "vision-model-x" },
    });
    expect(recognizerSecretTargetKey(custom, "provider.custom:vision-slug.apiKey")).toBe(true);
    // The connection-scoped key is NOT the credential a custom selection reads.
    expect(recognizerSecretTargetKey(custom, "provider.connection.conn-v.apiKey")).toBe(false);
  });

  it("returns false for every recognizer-less or dangling selection", () => {
    const recognizerless = settings();
    expect(recognizerSecretTargetKey(recognizerless, "provider.connection.conn-v.apiKey")).toBe(false);
    const dangling = settings({
      provider: { connections: [connection({ id: "conn-other" })] },
      recognizer: { connectionId: "conn-gone", modelId: "vision-model" },
    });
    expect(recognizerSecretTargetKey(dangling, "provider.connection.conn-v.apiKey")).toBe(false);
    expect(recognizerSecretTargetKey(dangling, "provider.custom:vision-slug.apiKey")).toBe(false);
  });

  it("key templates byte-mirror the vault keys host-env mints (drift guard)", () => {
    // Same byte-identity discipline as host-env.test.ts:787
    // (`customProviderSecretKey("custom:abc") === "provider.custom:abc.apiKey"`).
    expect(recognizerConnectionSecretKey("c")).toBe("provider.connection.c.apiKey");
    expect(recognizerCustomRecordSecretKey("custom:abc")).toBe("provider.custom:abc.apiKey");
    expect(recognizerCustomRecordSecretKey("openai")).toBeUndefined();
  });
});

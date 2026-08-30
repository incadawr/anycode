/**
 * Unit tests for the vision-fallback recognizer's live-push contract (TASK.198
 * E1): the wire message shape and the fingerprint pure logic main's mutation
 * hooks use to decide whether a push is even worth resolving a secret for
 * (plan §1.2/§7 finding #7 — a resolved secret must never ride an unrelated
 * mutation's wire).
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings, ProviderConnection } from "./settings.js";
import {
  RECOGNIZER_CONFIG_CHANGED_TYPE,
  recognizerFingerprint,
  recognizerFingerprintsEqual,
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

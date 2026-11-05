import { describe, expect, it } from "vitest";
import { applyRecognizerEnv } from "../main/host-env.js";
import { parseRecognizerEnv, recognizerEndpointFromFields, recognizerLiveWindow } from "./recognizer-env.js";

const wire = { model: "vision", baseUrl: "https://example.test", contextWindowTokens: 32000 };

describe("recognizer context delivery", () => {
  it("preserves Go carriers with the window across boot and live delivery and clears stale carriers", () => {
    const go = { ...wire, goModelPolicy: { marker: "policy" }, modelMetadata: { id: "vision" }, pricingRaw: '{"input":1}' } as unknown as Parameters<typeof applyRecognizerEnv>[1];
    const env: NodeJS.ProcessEnv = {};
    applyRecognizerEnv(env, go);
    expect(parseRecognizerEnv(env)).toEqual(recognizerEndpointFromFields(go!));
    applyRecognizerEnv(env, undefined);
    expect(env.ANYCODE_RECOGNIZER_GO_POLICY).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_GO_METADATA).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_GO_PRICING).toBeUndefined();
  });
  it("delivers the settings window with a model binding and matches live delivery", () => {
    const env: NodeJS.ProcessEnv = {};
    applyRecognizerEnv(env, wire);
    expect(env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL).toBe("vision");
    expect(env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_FROM_SETTINGS).toBe("1");
    expect(parseRecognizerEnv(env)).toEqual(recognizerEndpointFromFields(wire));
  });
  it("honours an explicit value and prevents a saved window following a different env model", () => {
    const explicit = { ANYCODE_RECOGNIZER_CONTEXT_WINDOW: "64000" };
    applyRecognizerEnv(explicit, wire);
    expect(parseRecognizerEnv(explicit)?.contextWindowTokens).toBe(64000);
    const different = { ANYCODE_RECOGNIZER_MODEL: "other" };
    applyRecognizerEnv(different, wire);
    expect(parseRecognizerEnv(different)?.contextWindowTokens).toBeUndefined();
  });
  it("applies explicit live windows only to the bound model", () => {
    const env = { ANYCODE_RECOGNIZER_CONTEXT_WINDOW: "64000", ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "vision" };
    const next = recognizerEndpointFromFields(wire)!;
    expect(recognizerLiveWindow(env, next)).toBe(64000);
    expect(recognizerLiveWindow(env, { ...next, model: "other", contextWindowTokens: 48000 })).toBe(48000);
    expect(recognizerLiveWindow({ ...env, ANYCODE_RECOGNIZER_CONTEXT_WINDOW_FROM_SETTINGS: "1" }, next)).toBe(32000);
    expect(recognizerLiveWindow({ ...env, ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "" }, next)).toBe(64000);
    expect(recognizerLiveWindow({ ...env, ANYCODE_RECOGNIZER_CONTEXT_WINDOW: "broken" }, next)).toBe(32000);
  });
  it("strips orphan bindings and treats whitespace like an absent window", () => {
    for (const value of [undefined, "", "   "]) {
      const env: NodeJS.ProcessEnv = { ANYCODE_RECOGNIZER_CONTEXT_WINDOW: value, ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "other" };
      applyRecognizerEnv(env, wire);
      expect(env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL).toBe("vision");
      expect(parseRecognizerEnv(env)?.contextWindowTokens).toBe(32000);
    }
    const noSetting: NodeJS.ProcessEnv = { ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "other" };
    applyRecognizerEnv(noSetting, undefined);
    expect(noSetting.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL).toBeUndefined();
    const explicit: NodeJS.ProcessEnv = { ANYCODE_RECOGNIZER_CONTEXT_WINDOW: "64000", ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "other", ANYCODE_RECOGNIZER_CONTEXT_WINDOW_FROM_SETTINGS: "1" };
    applyRecognizerEnv(explicit, wire);
    expect(explicit.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL).toBe("other");
    expect(explicit.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_FROM_SETTINGS).toBeUndefined();
  });
  it("rejects malformed, unsafe, zero, and mismatched windows and ignores the primary window", () => {
    const base = { ANYCODE_RECOGNIZER_MODEL: "vision", ANYCODE_RECOGNIZER_BASE_URL: "https://example.test", ANYCODE_CONTEXT_WINDOW: "99999" };
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
      expect(parseRecognizerEnv({ ...base, ANYCODE_RECOGNIZER_CONTEXT_WINDOW: value })?.contextWindowTokens).toBeUndefined();
    }
    expect(parseRecognizerEnv(base)?.contextWindowTokens).toBeUndefined();
    expect(parseRecognizerEnv({ ...base, ANYCODE_RECOGNIZER_CONTEXT_WINDOW: "32000", ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL: "other" })?.contextWindowTokens).toBeUndefined();
    expect(recognizerEndpointFromFields({ ...wire, contextWindowTokens: -1 })?.contextWindowTokens).toBeUndefined();
  });
});

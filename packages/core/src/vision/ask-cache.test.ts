/**
 * Ask-cache tests (TASK.198 slice A, plan §7/§10-A): bounded in-memory LRU
 * keyed on (recognizer identity, image bytes, question, transcript). The two
 * properties the plan calls out as load-bearing: a transcript change and a
 * recognizer-identity change (a live config swap, TASK.198 plan §1.3) each
 * produce a DIFFERENT key even when image+question are held constant — a key
 * that ignored either would silently serve a stale-model or wrong-thread
 * answer back to the caller.
 */

import { describe, expect, it } from "vitest";
import { AskCache, ASK_CACHE_MAX_ENTRIES, buildAskCacheKey } from "./ask-cache.js";
import type { RecognizerEndpoint } from "./recognizer.js";
import type { ImageAttachment } from "../types/images.js";
import type { AskResult } from "./recognizer.js";

const endpointA: RecognizerEndpoint = {
  transport: "anthropic-messages",
  baseUrl: "https://a.invalid",
  model: "vision-a",
};

const endpointB: RecognizerEndpoint = {
  transport: "anthropic-messages",
  baseUrl: "https://a.invalid",
  model: "vision-b",
};

const image: ImageAttachment = { mediaType: "image/png", data: "aGVsbG8=" };
const otherImage: ImageAttachment = { mediaType: "image/png", data: "d29ybGQ=" };

const okResult: AskResult = { ok: true, text: "a blue button" };

describe("buildAskCacheKey", () => {
  it("produces the same key for identical inputs", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "what is this?" });
    const b = buildAskCacheKey({ endpoint: endpointA, image, question: "what is this?" });
    expect(a).toBe(b);
  });

  it("changes when the image bytes change", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "what is this?" });
    const b = buildAskCacheKey({ endpoint: endpointA, image: otherImage, question: "what is this?" });
    expect(a).not.toBe(b);
  });

  it("changes when the recognizer identity changes (transport+baseUrl+model)", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "what is this?" });
    const b = buildAskCacheKey({ endpoint: endpointB, image, question: "what is this?" });
    expect(a).not.toBe(b);
  });

  it("changes when the transcript changes, image+question held constant", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "and now?" });
    const b = buildAskCacheKey({
      endpoint: endpointA,
      image,
      question: "and now?",
      transcript: [{ question: "what color?", answer: "blue" }],
    });
    expect(a).not.toBe(b);
  });

  it("changes when focus changes (overview caption keys on focus too)", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "describe" });
    const b = buildAskCacheKey({ endpoint: endpointA, image, question: "describe", focus: "why is this red?" });
    expect(a).not.toBe(b);
  });

  it("normalizes question whitespace/case so equivalent questions collide", () => {
    const a = buildAskCacheKey({ endpoint: endpointA, image, question: "What is THIS?" });
    const b = buildAskCacheKey({ endpoint: endpointA, image, question: "  what is this?  " });
    expect(a).toBe(b);
  });
});

describe("AskCache", () => {
  it("misses on an unset key", () => {
    const cache = new AskCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("hits after a set with the same key", () => {
    const cache = new AskCache();
    cache.set("k1", okResult);
    expect(cache.get("k1")).toEqual(okResult);
  });

  // The cache exists so a retry/resend does not pay twice for a call that
  // ALREADY HAPPENED. A failure is a fact about one attempt, not about the
  // question: an aborted turn or a momentary provider blip would otherwise
  // become permanent for the session, and — because InspectImage charges the
  // per-image question limit before it calls — each retry of a poisoned
  // question would burn one of the eight without reaching the network at all.
  // Enforced HERE rather than at the two call sites so no future writer can
  // miss it.
  it.each([
    { ok: false, kind: "aborted", error: "This operation was aborted" },
    { ok: false, kind: "timeout", error: "timed out" },
    { ok: false, kind: "provider", error: "502" },
    { ok: false, kind: "empty", error: "recognizer returned an empty response" },
  ] as const)("refuses to store a failure ($kind) — a later read still misses", (failure) => {
    const cache = new AskCache();
    cache.set("k1", failure);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("a failure written over an existing success leaves the success in place", () => {
    const cache = new AskCache();
    cache.set("k1", okResult);
    cache.set("k1", { ok: false, kind: "provider", error: "502" });
    expect(cache.get("k1")).toEqual(okResult);
  });

  it("a refused failure does not consume capacity or evict a live entry", () => {
    const cache = new AskCache(2);
    cache.set("k1", { ok: true, text: "one" });
    cache.set("k2", { ok: true, text: "two" });
    cache.set("k3", { ok: false, kind: "timeout", error: "timed out" });
    expect(cache.get("k1")).toEqual({ ok: true, text: "one" });
    expect(cache.get("k2")).toEqual({ ok: true, text: "two" });
  });

  it("evicts the least-recently-used entry once over capacity", () => {
    const cache = new AskCache(2);
    cache.set("k1", { ok: true, text: "one" });
    cache.set("k2", { ok: true, text: "two" });
    cache.set("k3", { ok: true, text: "three" });
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toEqual({ ok: true, text: "two" });
    expect(cache.get("k3")).toEqual({ ok: true, text: "three" });
  });

  it("a read refreshes recency, protecting a hot entry from eviction", () => {
    const cache = new AskCache(2);
    cache.set("k1", { ok: true, text: "one" });
    cache.set("k2", { ok: true, text: "two" });
    // Touch k1 so it becomes more-recently-used than k2.
    cache.get("k1");
    cache.set("k3", { ok: true, text: "three" });
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.get("k1")).toEqual({ ok: true, text: "one" });
    expect(cache.get("k3")).toEqual({ ok: true, text: "three" });
  });

  it("defaults to the documented 64-entry capacity", () => {
    const cache = new AskCache();
    for (let i = 0; i < ASK_CACHE_MAX_ENTRIES; i++) {
      cache.set(`k${i}`, { ok: true, text: String(i) });
    }
    // No reads yet, so k0 is still the least-recently-used entry: one more
    // write past capacity must evict exactly it, not some other slot.
    cache.set("overflow", { ok: true, text: "overflow" });
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k1")).toEqual({ ok: true, text: "1" });
    expect(cache.get("overflow")).toEqual({ ok: true, text: "overflow" });
  });
});

/**
 * In-memory cache for `ask()` results (TASK.198 plan §7). Lives for the
 * host-forked process only — never persisted: a retry/resend of the exact same
 * question shouldn't pay for a second model call, but a disk cache would be a
 * new invalidation surface with no proven need. The key folds in the
 * recognizer's own identity (transport+baseUrl+model) because the endpoint can
 * change live mid-session (plan §1.3) — without that, a cache hit could serve
 * a DIFFERENT model's old answer under a newly-selected recognizer.
 */

import { createHash } from "node:crypto";
import type { ImageAttachment } from "../types/images.js";
import type { AskResult, AskTranscriptEntry, RecognizerEndpoint } from "./recognizer.js";

/** Bounded LRU capacity (plan §7). */
export const ASK_CACHE_MAX_ENTRIES = 64;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Identity string a live config swap changes — folded into every cache key so a swap always misses. */
export function recognizerIdentity(endpoint: RecognizerEndpoint): string {
  return `${endpoint.transport}|${endpoint.baseUrl}|${endpoint.model}`;
}

/** Collapses whitespace/case so trivially-equivalent questions collide on one key. */
function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function transcriptDigest(transcript: AskTranscriptEntry[] | undefined): string {
  if (transcript === undefined || transcript.length === 0) return "";
  return sha256Hex(JSON.stringify(transcript));
}

export interface AskCacheKeyInput {
  endpoint: RecognizerEndpoint;
  image: ImageAttachment;
  question: string;
  transcript?: AskTranscriptEntry[];
  /**
   * User's accompanying text — part of the key because the bootstrap overview
   * caption (fixed OVERVIEW_QUESTION) uses this SAME cache and keys on focus
   * too (plan §7): two images with different user context must not collide.
   */
  focus?: string;
}

/**
 * Cache key = recognizer identity + image bytes + normalized question +
 * transcript digest + focus (plan §7's exact formula). Image bytes are hashed
 * rather than used raw so the key stays a short fixed-shape string regardless
 * of attachment size.
 */
export function buildAskCacheKey(input: AskCacheKeyInput): string {
  return [
    recognizerIdentity(input.endpoint),
    sha256Hex(input.image.data),
    normalizeQuestion(input.question),
    transcriptDigest(input.transcript),
    input.focus !== undefined ? sha256Hex(input.focus) : "",
  ].join("::");
}

/**
 * Bounded in-memory LRU. Backed by a Map, whose iteration order is insertion
 * order: both a hit and a write re-insert the key at the end, so the OLDEST
 * (least-recently-used) key is always whatever the iterator yields first once
 * the cache is at capacity.
 */
export class AskCache {
  private readonly store = new Map<string, AskResult>();

  constructor(private readonly maxEntries: number = ASK_CACHE_MAX_ENTRIES) {}

  get(key: string): AskResult | undefined {
    const hit = this.store.get(key);
    if (hit === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, hit); // refresh recency
    return hit;
  }

  /**
   * Stores a SUCCESS. A failure is silently refused, and that refusal is the
   * point of this method rather than an omission at the call sites.
   *
   * The cache exists so a retry or a resend does not pay a second time for a
   * call that already happened (plan §7) — which is a statement about
   * successful calls. A failure is a fact about one ATTEMPT, not about the
   * question: an aborted turn (the user pressed Stop) or a momentary provider
   * blip would otherwise be replayed for the rest of the session, so the
   * recognizer coming back would not bring the question back with it. Worse
   * for `InspectImage`, which charges the per-image question limit BEFORE it
   * calls: every retry of a poisoned question would burn one of the eight
   * without a single request reaching the network.
   *
   * Enforced here, at the one place a value enters the cache, rather than at
   * each call site — a guard the writers cannot forget.
   */
  set(key: string, result: AskResult): void {
    if (!result.ok) {
      return;
    }
    if (this.store.has(key)) {
      this.store.delete(key); // refresh recency on overwrite too
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, result);
  }

  get size(): number {
    return this.store.size;
  }
}

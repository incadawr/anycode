/** Vision fallback public surface (TASK.198 slice A). */

export { ask, ASK_TIMEOUT_MS, OVERVIEW_QUESTION } from "./recognizer.js";
export type {
  AskImageScale,
  AskOptions,
  AskResult,
  AskTranscriptEntry,
  RecognizerEndpoint,
} from "./recognizer.js";
export { imageDimensions, formatImageStub } from "./metadata.js";
export type { ImageDimensions, ImageStubInput } from "./metadata.js";
export { AskCache, ASK_CACHE_MAX_ENTRIES, buildAskCacheKey, recognizerIdentity } from "./ask-cache.js";
export type { AskCacheKeyInput } from "./ask-cache.js";

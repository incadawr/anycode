/**
 * InspectImage tool (TASK.198 plan §5): lets a blind model ask a separate
 * vision-capable recognizer endpoint about a specific attachment already
 * living in history, addressed by its `#N` registry number (assigned at
 * append time by loop/agent-loop.ts's stampImageRefs, slice B1). Repeated
 * calls on the same ref thread a Q/A transcript by value, so "what's to the
 * right of that button?" works without any provider-side session state
 * (spec §3).
 *
 * `concurrentSafe: false` is a pin, not an oversight: the handler holds a
 * per-ref question counter and transcript in a closure over the process, and
 * ask() calls a billed external endpoint — two calls racing on the same ref
 * would both read the same "before" transcript and could double-spend past
 * the per-image question limit. dispatch/scheduler.ts only ever parallelizes
 * a tool that declares concurrentSafe === true, so this flag alone forces a
 * solo batch for every InspectImage call.
 */

import { z } from "zod";
import type { ModelPort } from "../ports/model.js";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { ask, buildAskCacheKey, imageDimensions, AskCache } from "../vision/index.js";
import type { AskTranscriptEntry, RecognizerEndpoint } from "../vision/index.js";

/** Per-image question ceiling (plan §5/§11): a lifted turn-ceiling budget, not a hard product limit. */
export const MAX_QUESTIONS_PER_IMAGE = 8;

/** Verbatim response text once a ref's question count is exhausted (plan §5). */
export const QUESTION_LIMIT_MESSAGE = "limit reached, proceed with what you have";

const inspectImageInputSchema = z.object({
  image: z.string().trim().min(1),
  question: z.string().trim().min(1),
});

export type InspectImageInput = z.output<typeof inspectImageInputSchema>;

/**
 * Recognizer wiring a caller (host slice C) hands to the factory: the same
 * endpoint AgentLoopConfig.recognizer resolved, plus the SAME shared AskCache
 * instance the loop's own bootstrap overview captions use (plan §7 — one
 * process-lifetime cache, not a second one) so a question InspectImage
 * already answered never pays for a repeat call from the overview path or
 * vice versa. `portFactory` is a test seam only; production wiring omits it.
 */
export interface InspectImageRecognizer {
  endpoint: RecognizerEndpoint;
  cache?: AskCache;
  portFactory?: (endpoint: RecognizerEndpoint) => ModelPort;
}

export interface CreateInspectImageToolOptions {
  recognizer: InspectImageRecognizer;
}

/**
 * Normalizes the model's `image` argument: accepts "#3", "3", and "image #3"
 * (case-insensitive) — all the forms a model plausibly copies out of a
 * `[image #3 — ...]` stub. Returns undefined for anything else, never throws.
 */
function parseImageRef(raw: string): number | undefined {
  const match = raw.trim().match(/^(?:image\s*)?#?\s*(\d+)$/i);
  if (match === null) return undefined;
  return Number.parseInt(match[1]!, 10);
}

function inspectImageMetadata(): ToolMetadata {
  return {
    name: "InspectImage",
    description:
      "Ask a separate vision-capable model a question about an image you cannot see directly, referenced by " +
      'the "#N" number from an [image #N ...] placeholder earlier in the conversation. Call it as many times as ' +
      "needed — each call can build on the answers to your earlier questions about the same image. It estimates " +
      "geometry from pixels (±10%); exact rects come from the automation facade.",
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    timeoutMs: 90_000,
  };
}

/**
 * Factory (DI over the resolved recognizer endpoint, precedent
 * createWebSearchTool/createAgentTool): the per-ref question counter and
 * transcript live in this closure, so they persist across calls within the
 * same host process but reset on restart (plan §5's explicitly-weakened
 * resume semantics — persisted history keeps the ref and stub, not the
 * tool's own dialogue state).
 */
export function createInspectImageTool(
  options: CreateInspectImageToolOptions,
): ToolDefinition<InspectImageInput, string> {
  const { endpoint, portFactory } = options.recognizer;
  const cache = options.recognizer.cache ?? new AskCache();
  const questionCounts = new Map<number, number>();
  const transcripts = new Map<number, AskTranscriptEntry[]>();

  return {
    metadata: inspectImageMetadata(),
    inputSchema: inspectImageInputSchema,
    handler: async (input, ctx) => {
      if (ctx.images === undefined) {
        return { ok: false, error: "InspectImage is unavailable in this session." };
      }

      const ref = parseImageRef(input.image);
      if (ref === undefined) {
        return {
          ok: false,
          error: `"${input.image}" is not a valid image reference — use the number from an [image #N ...] stub, e.g. "#3".`,
        };
      }

      const image = ctx.images.resolve(ref);
      if (image === undefined) {
        return {
          ok: false,
          error: `image #${ref} is no longer available (it does not exist, or was cleared by a compaction).`,
        };
      }

      const askedCount = questionCounts.get(ref) ?? 0;
      if (askedCount >= MAX_QUESTIONS_PER_IMAGE) {
        return { ok: false, error: QUESTION_LIMIT_MESSAGE };
      }
      questionCounts.set(ref, askedCount + 1);

      const transcript = transcripts.get(ref) ?? [];
      const dimensions = imageDimensions(Buffer.from(image.data, "base64"));
      const cacheKey = buildAskCacheKey({ endpoint, image, question: input.question, transcript });
      let result = cache.get(cacheKey);
      if (result === undefined) {
        result = await ask({
          endpoint,
          image,
          question: input.question,
          transcript,
          scale:
            dimensions !== undefined
              ? {
                  pixelWidth: dimensions.width,
                  pixelHeight: dimensions.height,
                  ...(image.cssSize !== undefined
                    ? { cssWidth: image.cssSize.width, cssHeight: image.cssSize.height }
                    : {}),
                }
              : undefined,
          signal: ctx.abortSignal,
          portFactory,
        });
        cache.set(cacheKey, result);
      }

      if (!result.ok) {
        return { ok: false, error: `Vision request failed: ${result.error}` };
      }

      transcripts.set(ref, [...transcript, { question: input.question, answer: result.text }]);
      return { ok: true, output: result.text };
    },
  };
}

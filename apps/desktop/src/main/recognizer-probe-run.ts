/**
 * TASK.203: the recognizer-probe child's EXECUTION helper — the one function
 * (`runRecognizerProbe`) both the real child entry (recognizer-probe-child.ts)
 * and this slice's tests call, so "what a probe click writes to telemetry" is
 * tested against the SAME write path production uses, never a parallel
 * re-implementation.
 *
 * This module belongs exclusively to the CHILD graph (the bundled
 * `recognizer-probe-child.js` entry), where the full `@anycode/core` barrel is
 * already paid for — so runtime `ask`/`JsonlTelemetrySink` imports here are
 * fine, unlike recognizer-probe.ts (the PARENT graph), which keeps core to
 * type-only imports plus the main-safe `telemetry-admin` subpath.
 *
 * Telemetry here is fail-soft by the same rule as the parent's resolution: a
 * sink that cannot be created or written never fails the probe itself — the
 * answer still comes back, the telemetry file just may not exist.
 */

import { ask, JsonlTelemetrySink, type AskResult, type ImageAttachment, type RecognizerEndpoint } from "@anycode/core";
import type { RecognizerProbeChildInput } from "./recognizer-probe.js";

/** The `ask` shape, injectable so tests run this helper without a network. */
export type RecognizerProbeAskFn = typeof ask;

/**
 * Runs one probe ask — exactly what the child does — writing session_start
 * before the call and usage after it, into `vision-probe-<session>.jsonl`,
 * when (and only when) the input carried a telemetry target. The sink is
 * disposed (flushed) in `finally`, so by the time this promise settles the
 * file's records are durably on disk — including on the throw path.
 */
export async function runRecognizerProbe(input: RecognizerProbeChildInput, askFn: RecognizerProbeAskFn = ask): Promise<AskResult> {
  // Instantiated ONLY when the parent resolved telemetry as enabled — the
  // disabled/kill-switch/invalid-config cases never carry the field at all.
  const sink =
    input.telemetry !== undefined
      ? new JsonlTelemetrySink({ dir: input.telemetry.dir, fileName: `${input.telemetry.session}.jsonl` })
      : undefined;
  try {
    if (sink !== undefined && input.telemetry !== undefined) {
      sink.record({
        v: 1,
        ts: Date.now(),
        session: input.telemetry.session,
        t: "session_start",
        // The same ids the parent resolved onto the endpoint — a name/enum by
        // type, never free text. providerName is blank-dropped by the parent's
        // field-mirror, so the transport is the honest fallback.
        model: input.endpoint.model,
        provider: input.endpoint.providerName ?? input.endpoint.transport,
      });
    }
    const image: ImageAttachment = { mediaType: input.image.mediaType, data: input.image.data };
    const result = await askFn({
      endpoint: input.endpoint,
      image,
      question: input.question,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (sink !== undefined && input.telemetry !== undefined && result.ok && result.usage !== undefined) {
      const usage = result.usage;
      sink.record({
        v: 1,
        ts: Date.now(),
        session: input.telemetry.session,
        t: "usage",
        // Whitelist of defined TokenUsage fields only — the record union is
        // names/numbers/enums by type; image/question/key/answer text are
        // structurally unrepresentable and never recorded.
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      });
    }
    return result;
  } finally {
    // Flush BEFORE the caller (the real child's emit() -> process.exit) can
    // kill the process: dispose races the write chain and never rejects. Runs
    // on the success, failure and throw paths alike.
    await sink?.dispose();
  }
}

/**
 * The vision fallback's one-shot `ask()` primitive (TASK.198 plan §1). Lets a
 * model with no native image input "see" an attachment through a second,
 * separately-configured recognizer endpoint: one non-streamed model call per
 * question, same one-shot shape as context/session-title.ts's
 * generateSessionTitle (accumulate text_delta over a single ModelPort.streamText
 * call, tools:[], temperature:0). `ask()` NEVER throws — every failure resolves
 * to `{ok:false, kind, error}` — because a fallback tool call must never be able
 * to kill the caller's turn (spec §1.6/plan §1).
 *
 * Threaded-by-value transcript (spec §3): prior Q/A pairs about the SAME image
 * are resent as text on every call rather than relying on provider-side
 * session state, so "what's to the right of that button?" works regardless of
 * whether the recognizer endpoint keeps any state at all.
 */

import { AiSdkModelPort } from "../provider/model-port.js";
import type { ProviderTransport } from "../provider/catalog.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { TokenUsage } from "../types/events.js";
import type { ImageAttachment } from "../types/images.js";

/** One-shot call deadline used when the caller supplies no signal of its own. */
export const ASK_TIMEOUT_MS = 60_000;

/**
 * Fixed question for the bootstrap overview caption (plan §1 step 4 / spec
 * §1.4): closes the "model doesn't know what's in the image well enough to
 * even ask a question" gap on the very first turn a blind model sees one.
 */
export const OVERVIEW_QUESTION =
  "Describe what is visible in this image in 1-2 sentences: what kind of screenshot or picture it is, and anything a developer would plausibly want to ask a follow-up question about.";

/**
 * Minimal endpoint shape `ask()` needs to build a model port — deliberately a
 * narrower subset of provider/endpoint.js's EndpointConfig (structurally
 * assignable to it: every EndpointConfig field this omits is optional there).
 * No proxy field by design (coordinator ruling, plan §1/§6): the recognizer
 * rides the host process's own ambient proxy, never a per-endpoint one.
 */
export interface RecognizerEndpoint {
  transport: ProviderTransport;
  baseUrl: string;
  apiKey?: string;
  model: string;
  providerName?: string;
}

/** One prior question/answer pair about the same image (threaded-by-value transcript). */
export interface AskTranscriptEntry {
  question: string;
  answer: string;
}

/**
 * Geometry hint folded into the prompt so the model reasons from arithmetic
 * instead of guessing a device-pixel-ratio (owner's live measurement, spec
 * §6 / plan §0a): pixel size is ALWAYS available (imageDimensions, slice A/B1)
 * and always sent; css{Width,Height} are additive-optional so slice G can
 * populate them later without changing this shape or any existing caller.
 */
export interface AskImageScale {
  pixelWidth: number;
  pixelHeight: number;
  /** Logical/CSS viewport size, when the screenshot source can report it (slice G, not built here). */
  cssWidth?: number;
  cssHeight?: number;
}

export interface AskOptions {
  endpoint: RecognizerEndpoint;
  image: ImageAttachment;
  question: string;
  /** Prior Q/A pairs about THIS image, oldest first — resent by value, not provider state. */
  transcript?: AskTranscriptEntry[];
  /** The user's own accompanying text, when this call is the bootstrap overview caption. */
  focus?: string;
  scale?: AskImageScale;
  signal?: AbortSignal;
  /** Test seam: build a fake ModelPort instead of a real `new AiSdkModelPort(endpoint)`. */
  portFactory?: (endpoint: RecognizerEndpoint) => ModelPort;
}

export type AskResult =
  | { ok: true; text: string; usage?: TokenUsage }
  | { ok: false; kind: "timeout" | "provider" | "empty" | "aborted"; error: string };

/** Turns an unknown thrown/event value into a safe display string — never lets a raw object escape. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * `AbortSignal.timeout()` sets its reason to a DOMException named
 * "TimeoutError" (both when we construct it ourselves with no caller signal,
 * and when a caller builds its own timeout the same way) — the only reliable
 * way to tell "ran out of time" apart from "someone cancelled it".
 */
function classifyAbort(signal: AbortSignal): "timeout" | "aborted" {
  const reason = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError" ? "timeout" : "aborted";
}

/**
 * Builds the one user-visible prompt string: geometry hint, then the prior
 * transcript, then the user's own focus text, then the actual question —
 * always in that order so the model reads scale/context before being asked
 * anything.
 */
function buildPrompt(opts: Pick<AskOptions, "question" | "transcript" | "focus" | "scale">): string {
  const parts: string[] = [];
  if (opts.scale !== undefined) {
    const { pixelWidth, pixelHeight, cssWidth, cssHeight } = opts.scale;
    parts.push(`Image pixel size: ${pixelWidth}x${pixelHeight}px.`);
    // The CSS half is stated ONLY as a divisor, so a zero, negative or
    // non-finite dimension cannot be passed along as a less precise number —
    // it would instruct the reader to divide by it. Producers are guarded at
    // the source too (preview-host.ts's `usableCssSize`); this second check is
    // here because the instruction is emitted here, and so covers every future
    // producer of an AskImageScale, not just today's. The pixel line still
    // goes out: it is independently true and useful on its own.
    if (
      cssWidth !== undefined &&
      cssHeight !== undefined &&
      Number.isFinite(cssWidth) &&
      Number.isFinite(cssHeight) &&
      cssWidth > 0 &&
      cssHeight > 0
    ) {
      parts.push(
        `Viewport CSS size: ${cssWidth}x${cssHeight}px (divide the pixel size by this to get the device pixel ratio).`,
      );
    }
  }
  if (opts.transcript !== undefined && opts.transcript.length > 0) {
    parts.push("Previous questions and answers about this same image:");
    for (const entry of opts.transcript) {
      parts.push(`Q: ${entry.question}\nA: ${entry.answer}`);
    }
  }
  if (opts.focus !== undefined && opts.focus.length > 0) {
    parts.push(`The user's own message alongside this image: ${opts.focus}`);
  }
  parts.push(opts.question);
  return parts.join("\n\n");
}

/**
 * One-shot vision call: image + question -> text. Never throws — every
 * failure (timeout, provider error, empty reply, cancellation) resolves to
 * `{ok:false, kind, error}` so a tool handler can turn it into an honest
 * result instead of the fallback feature killing the caller's turn.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const signal = opts.signal ?? AbortSignal.timeout(ASK_TIMEOUT_MS);
  try {
    if (signal.aborted) {
      return { ok: false, kind: classifyAbort(signal), error: describeError(signal.reason) };
    }

    const port = opts.portFactory ? opts.portFactory(opts.endpoint) : new AiSdkModelPort(opts.endpoint);
    const request: ModelRequest = {
      messages: [{ role: "user", content: buildPrompt(opts), images: [opts.image] }],
      tools: [],
      temperature: 0,
      abortSignal: signal,
    };

    let text = "";
    let usage: TokenUsage | undefined;
    for await (const event of port.streamText(request)) {
      if (signal.aborted) {
        return { ok: false, kind: classifyAbort(signal), error: describeError(signal.reason) };
      }
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "finish") {
        usage = event.usage;
      } else if (event.type === "error") {
        return { ok: false, kind: "provider", error: describeError(event.error) };
      }
    }

    if (signal.aborted) {
      return { ok: false, kind: classifyAbort(signal), error: describeError(signal.reason) };
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { ok: false, kind: "empty", error: "recognizer returned an empty response" };
    }
    return { ok: true, text: trimmed, usage };
  } catch (err) {
    if (signal.aborted) {
      return { ok: false, kind: classifyAbort(signal), error: describeError(err) };
    }
    return { ok: false, kind: "provider", error: describeError(err) };
  }
}

/**
 * Media-projection decorator (TASK.198 plan §3): strips image bytes from
 * every ChatMessage before a request reaches the wire when the current
 * model can't see them, so a live model switch mid-session (sighted ->
 * blind) can never silently re-send images the new model would reject with
 * a hidden 400. Wraps exactly ONE underlying ModelPort — in production the
 * single SwitchableModelPort instance built at boot (host/index.ts,
 * cli/main.ts) — so every consumer of that port is covered by construction:
 * the main turn loop, the ceiling-ladder verdict request, LLM auto/manual
 * compaction, and inline-subagent wrap-up all read `config.modelPort`, the
 * SAME object this decorator wraps once (plan §0.3).
 */

import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { ChatMessage } from "../types/history.js";

/** Wire-only replacement text for an omitted image; carries the ref when the attachment has one (plan §3). */
function omittedImageNote(ref: number | undefined): string {
  return ref === undefined
    ? "[image omitted: current model has no image input]"
    : `[image #${ref} omitted: current model has no image input]`;
}

/**
 * Pure projection over one ChatMessage batch. Sighted (`imageInputAllowed`)
 * returns the SAME array reference — no allocation, and a pin test can
 * assert identity on the sighted path. Blind strips `images` from every
 * user message and every tool-result part that carries any, replacing each
 * omitted image with a wire-only text note appended to the carrying
 * message/part's own text — never silently swallowed, so the model can
 * still reason about what it lost. A batch with nothing to strip also
 * returns the original reference, even when blind.
 */
export function projectMessagesForMedia(
  messages: ChatMessage[],
  imageInputAllowed: boolean,
): ChatMessage[] {
  if (imageInputAllowed) {
    return messages;
  }
  let changed = false;
  const projected = messages.map((message): ChatMessage => {
    if (message.role === "user") {
      if (message.images === undefined || message.images.length === 0) {
        return message;
      }
      changed = true;
      const notes = message.images.map((image) => omittedImageNote(image.ref)).join("\n");
      const { images: _omitted, ...rest } = message;
      return { ...rest, content: `${rest.content}\n${notes}` };
    }
    if (message.role === "tool") {
      let partChanged = false;
      const content = message.content.map((part) => {
        if (part.images === undefined || part.images.length === 0) {
          return part;
        }
        partChanged = true;
        const notes = part.images.map((image) => omittedImageNote(image.ref)).join("\n");
        const { images: _omitted, ...rest } = part;
        return { ...rest, text: `${rest.text}\n${notes}` };
      });
      if (!partChanged) {
        return message;
      }
      changed = true;
      return { ...message, content };
    }
    return message;
  });
  return changed ? projected : messages;
}

/**
 * Decorator ModelPort: projects `request.messages` through the LIVE
 * `imageInputAllowed()` verdict on every `streamText` call (re-evaluated per
 * call, same discipline as MediaCapabilityPort — a mid-session model switch
 * is honored on the very next call). `modelId`/`lastResponseModel` delegate
 * straight through so wrapping a SwitchableModelPort keeps every existing
 * reader of those two accessors working unchanged.
 */
class MediaProjectionModelPort implements ModelPort {
  constructor(
    private readonly inner: ModelPort,
    private readonly imageInputAllowed: () => boolean,
  ) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const projected = projectMessagesForMedia(request.messages, this.imageInputAllowed());
    return this.inner.streamText(
      projected === request.messages ? request : { ...request, messages: projected },
    );
  }

  get modelId(): string | undefined {
    return this.inner.modelId;
  }

  get lastResponseModel(): string | undefined {
    return this.inner.lastResponseModel;
  }
}

/** Wraps `inner` with the media-projection decorator (plan §3). */
export function createMediaProjectionPort(
  inner: ModelPort,
  imageInputAllowed: () => boolean,
): ModelPort {
  return new MediaProjectionModelPort(inner, imageInputAllowed);
}

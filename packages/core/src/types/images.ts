/**
 * Image attachment envelope (Phase 6 slice 6.2, design §2-A1). Lives in its own
 * file rather than history.ts: history.ts already imports from tools.js, and
 * tools.ts is a consumer too, so a shared type in a third file avoids a cycle.
 */

/** The four magic-byte-sniffable formats anthropic-kind endpoints accept. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachment {
  mediaType: ImageMediaType;
  /** Base64 payload, no data: URI prefix. Raw size is bounded by IMAGE_MAX_BYTES before encoding. */
  data: string;
  /** Provenance for CLI display/troubleshooting only; never forwarded to the provider. */
  sourcePath?: string;
  /**
   * Stable model-visible registry number for the vision fallback (TASK.198
   * plan §2). Assigned once, at append time, by an atomic persistent counter
   * (ports/persistence.ts's reserveImageRef) — NEVER recomputed from a
   * history scan, so a later compaction that drops the highest-ref image can
   * never make a fresh image reuse its number. Absent on every image from
   * before the feature shipped, and on any image appended where the wiring
   * layer never supplied a counter (byte-identical to pre-feature behaviour).
   */
  ref?: number;
  /**
   * Logical/CSS viewport size (device-pixel-ratio-independent) at capture
   * time, when the screenshot source can report it (TASK.198 plan §0a /
   * slice G). Paired with the pixel size the vision fallback already derives
   * from the raw bytes (vision/metadata.ts's imageDimensions) so ask()'s
   * scale hint (vision/recognizer.ts's AskImageScale) lets the model compute
   * an exact device pixel ratio instead of guessing one. Additive-optional
   * like `ref`: populated only by the desktop screenshot capture paths that
   * can observe a CSS viewport (main/preview/preview-host.ts), absent
   * whenever the CSS size could not be obtained (page unresponsive, window
   * destroyed, panel bounds unset) or was never attempted, and absent on
   * every non-screenshot source (read-image.ts from disk, a pasted/dropped
   * user image) — byte-identical to pre-slice behaviour whenever it is
   * absent. There is deliberately no persisted pixel counterpart here: the
   * pixel size is always re-derived from `data` (the single source of
   * truth), so this field never risks drifting out of sync with the bytes.
   */
  cssSize?: { width: number; height: number };
}

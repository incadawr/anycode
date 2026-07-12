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
}

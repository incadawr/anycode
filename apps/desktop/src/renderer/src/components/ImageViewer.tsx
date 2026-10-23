import { useEffect, useRef, useState } from "react";

export interface ViewerImage {
  mediaType: string;
  data: string;
}

/**
 * Wrap-around index step for the viewer's prev/next controls (Taskana 4091).
 * Pure so the node-env logic test can pin it without a DOM: `-1` at 0 wraps to
 * the last image, `+1` at the end wraps to 0, and a degenerate `count <= 1`
 * (single image or empty) always stays at 0 — there is nothing to navigate.
 */
export function nextIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 1) return 0;
  return (current + delta + count) % count;
}

/** Taskana 4091 (TASK.84) internal viewer: pure presentational overlay. */
export function ImageViewer({ images, startIndex, onClose }: {
  images: readonly ViewerImage[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => nextIndex(i, -1, images.length));
      } else if (e.key === "ArrowRight") {
        setIndex((i) => nextIndex(i, 1, images.length));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [images.length, onClose]);
  const src = `data:${images[index]!.mediaType};base64,${images[index]!.data}`;
  return (
    <div className="image-viewer-backdrop" onClick={onClose}>
      <div
        className="image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          className="image-viewer-img"
          src={src}
          alt={`Attached image ${index + 1} of ${images.length}`}
        />
        <div className="image-viewer-bar">
          {images.length > 1 && (
            <>
              <button
                type="button"
                className="image-viewer-nav"
                onClick={() => setIndex((i) => nextIndex(i, -1, images.length))}
                aria-label="Previous image"
              >
                ‹
              </button>
              <span className="image-viewer-count">
                {index + 1} / {images.length}
              </span>
              <button
                type="button"
                className="image-viewer-nav"
                onClick={() => setIndex((i) => nextIndex(i, 1, images.length))}
                aria-label="Next image"
              >
                ›
              </button>
            </>
          )}
          <button type="button" className="image-viewer-close" ref={closeRef} onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

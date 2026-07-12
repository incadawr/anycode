/**
 * Renders a git unified diff (design /working-docs/build/design/
 * slice-5.8-cut.md §2.6): parses `GitDiffState.text` via diff/parse-unified.ts
 * and renders per-file headers + hunk lines reusing DiffView's `diff-line-*`/
 * `diff-hunk-*` visual language (components/DiffView.tsx :62-82) so the two
 * diff surfaces read as one system. Props-only — `{ diff: GitDiffState }`, no
 * store/wire access of its own; GitPanel.tsx (wave D2) is the sole connected
 * caller once it lands. No Shiki syntax highlighting (residual R6): a git
 * unified diff doesn't carry full pre/post file contents cheaply the way a
 * Write/Edit tool-call snapshot pair does, so this pane stays plain-text.
 */
import { useLayoutEffect, useRef } from "react";
import type { DiffLine, DiffLineKind } from "../diff/compute.js";
import { parseUnifiedDiff, trimTruncatedTail, type GitFileDiff } from "../diff/parse-unified.js";
import type { GitDiffState } from "../store.js";

export interface GitDiffPaneProps {
  diff: GitDiffState;
}

/** Same marker recipe as DiffView.tsx's `DiffLineRow` (":64") — duplicated
 * rather than imported since this pane doesn't consume DiffView (a git
 * unified diff isn't a before/after snapshot pair DiffView can render). */
export function diffLineMarker(kind: DiffLineKind): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : " ";
}

/** Same `diff-line diff-line-<kind>` recipe as DiffView.tsx's `DiffLineRow`. */
export function diffLineClassName(kind: DiffLineKind): string {
  return `diff-line diff-line-${kind}`;
}

/** Truncation banner copy (design §2.6). `shownChars` is the length of the
 * text actually being rendered (post `trimTruncatedTail`), so the number on
 * screen matches what's on screen rather than the pre-trim wire length. */
export function truncatedDiffBanner(shownChars: number): string {
  return `Diff truncated — showing the first ${shownChars} characters`;
}

/**
 * Per-file header label: a renamed file (with a resolved new path) shows
 * "old → new"; an added/deleted file shows the one side that actually exists
 * (the other side is the literal "/dev/null" unified-diff marker); anything
 * else shows the current (new) path.
 */
export function gitFileDiffLabel(file: GitFileDiff): string {
  if (file.renamedFrom !== undefined && file.renamedFrom !== file.newPath) {
    return `${file.renamedFrom} → ${file.newPath}`;
  }
  if (file.oldPath === "/dev/null") {
    return file.newPath;
  }
  if (file.newPath === "/dev/null") {
    return file.oldPath;
  }
  return file.newPath;
}

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={diffLineClassName(line.kind)}>
      <span className="diff-line-gutter">{line.oldLine ?? ""}</span>
      <span className="diff-line-gutter">{line.newLine ?? ""}</span>
      <span className="diff-line-marker">{diffLineMarker(line.kind)}</span>
      <span className="diff-line-text">{line.text}</span>
    </div>
  );
}

function GitDiffFileBlock({ file, resetKey }: { file: GitFileDiff; resetKey: string }) {
  const codeRef = useRef<HTMLDivElement>(null);

  // React keeps this pane mounted while a reviewer changes files. Reset the
  // code viewport explicitly so a long previous line cannot open the next
  // diff scrolled into its middle.
  useLayoutEffect(() => {
    codeRef.current?.scrollTo({ left: 0 });
  }, [resetKey]);

  return (
    <div className="git-diff-file">
      <div className="git-diff-file-header">
        <span className="git-diff-file-path">{gitFileDiffLabel(file)}</span>
      </div>
      {file.binary ? (
        <div className="git-diff-file-binary">Binary file not shown</div>
      ) : (
        <div ref={codeRef} className="git-diff-file-code">
          {file.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={hunkIndex}>
              <div className="diff-hunk-header">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              <div className="diff-hunk-lines">
                {hunk.lines.map((line, lineIndex) => (
                  <DiffLineRow key={lineIndex} line={line} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GitDiffPane({ diff }: GitDiffPaneProps) {
  const text = diff.truncated ? trimTruncatedTail(diff.text) : diff.text;
  const files = parseUnifiedDiff(text);

  return (
    <div className="git-diff-pane">
      {diff.truncated && <div className="git-diff-banner">{truncatedDiffBanner(text.length)}</div>}
      {files.length === 0 ? (
        <div className="git-diff-empty">No changes.</div>
      ) : (
        files.map((file, index) => <GitDiffFileBlock key={index} file={file} resetKey={`${diff.path ?? ""}:${diff.target}`} />)
      )}
    </div>
  );
}

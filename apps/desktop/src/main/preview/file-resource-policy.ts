/**
 * File-subresource policy for local HTML previews (security boundary).
 *
 * THREAT MODEL — the gap this module closes:
 * `preview-host.ts`'s request gate used to answer "is this `file:` URL
 * contained in an allowed root?" (artifacts-ipc.ts's `resolveContainedPath`)
 * and treat that as sufficient for a SUBRESOURCE of a `file:`-kind preview.
 * The allowed roots are the tab workspace, `<home>/.anycode` (the whole app
 * profile), the OS temp dir and — on darwin — `/tmp`. So a hostile local
 * HTML could `fetch("file:///Users/me/.anycode/auth.json")` (or anything in
 * a shared temp folder) and exfiltrate it into the DOM/console, where the
 * agent then reads it. Containment answers "may this app SERVE this path",
 * not "may THIS DOCUMENT load this path" — a document may only load what
 * belongs to its own tree.
 *
 * THE RULE (pure function, no fs, no I/O):
 *   - the allowed tree of a document is its OWN directory (recursively);
 *   - a document that sits DIRECTLY in a "broad" root (the home dir, the app
 *     profile, a temp dir, the filesystem root) may load only the DIRECT
 *     children of that root — never the tree below it;
 *   - the workspace widens the tree only when the document really lives in
 *     it AND the workspace is not itself a broad root (a workspace == the
 *     home dir must never widen anything);
 *   - nothing under `<home>/.anycode` is loadable unless the document itself
 *     lives under `<home>/.anycode` (and then only from the document's own
 *     directory onwards).
 *
 * All paths handed in are already REALPATH'd by the caller (the artifact
 * resolver realpaths before reporting containment), so a symlink pointing
 * outside the tree is denied automatically: the resolved target is what gets
 * compared, never the link.
 */

import { dirname, join, parse } from "node:path";
import { isUnderRoot } from "../artifacts-ipc.js";

export interface FileSubresourceInput {
  /** REALPATH of the file the preview wants to load as a subresource. */
  requestRealPath: string;
  /** REALPATH of the document that issues the request (the previewed file). */
  documentRealPath: string;
  /** The tab's workspace (may be undefined — then the document's own tree only). */
  workspace: string | undefined;
  /** The user's home dir — a broad root, and the parent of `<home>/.anycode`. */
  home: string;
  /** Temp dirs (OS temp dir, plus `/tmp` on darwin) — broad roots. */
  tmpdirs: string[];
  /** Defaults to `process.platform`; tests pass it explicitly. */
  platform?: NodeJS.Platform;
}

/** Path equality under the SAME normalization rules as `isUnderRoot` (darwin/win32 are case-insensitive). */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isUnderRoot(a, b, platform) && isUnderRoot(b, a, platform);
}

/**
 * True when a `file:` subresource request may be served to a document.
 *
 * @see isAllowedFileSubresource
 */
export function isAllowedFileSubresource(input: FileSubresourceInput): boolean {
  const platform = input.platform ?? process.platform;
  const { requestRealPath, documentRealPath } = input;
  if (requestRealPath === "" || documentRealPath === "") {
    return false;
  }
  const home = input.home;
  const anycodeDir = join(home, ".anycode");
  const docDir = dirname(documentRealPath);

  // "Broad roots": a document sitting directly in one of them may only load
  // the DIRECT children of that root — never its tree.
  const broadRoots: string[] = [home, anycodeDir, ...input.tmpdirs, parse(documentRealPath).root];

  // Rule (d): the app profile is off-limits unless the document lives there.
  const docUnderProfile = isUnderRoot(documentRealPath, anycodeDir, platform);
  if (!docUnderProfile && isUnderRoot(requestRealPath, anycodeDir, platform)) {
    return false;
  }

  // Rule (b): the document sits directly in a broad root -> direct children only.
  if (broadRoots.some((root) => samePath(docDir, root, platform))) {
    return samePath(dirname(requestRealPath), docDir, platform);
  }

  // Rule (c): the document's own directory tree.
  if (isUnderRoot(requestRealPath, docDir, platform)) {
    return true;
  }

  // Rule (c), second half: the workspace widens the tree — but only when the
  // document really lives in it and the workspace is neither a broad root nor
  // an ancestor of one (a workspace == the home dir must not widen anything).
  const workspace = input.workspace;
  if (workspace === undefined || workspace === "") {
    return false;
  }
  const workspaceIsBroad = broadRoots.some((root) => samePath(workspace, root, platform));
  const workspaceAncestorOfBroad = broadRoots.some((root) => isUnderRoot(root, workspace, platform));
  if (workspaceIsBroad || workspaceAncestorOfBroad) {
    return false;
  }
  if (!isUnderRoot(documentRealPath, workspace, platform)) {
    return false;
  }
  return isUnderRoot(requestRealPath, workspace, platform);
}

/**
 * Filesystem-root entries: a renderer-usable oracle for the slash guard. Same
 * value-only shape as shared/window.ts — channel name + wire type, ZERO runtime
 * imports, so preload, renderer and main can all import it.
 *
 * Why the renderer needs this: a draft like `/tmp`, `/etc` or `/Users` is how a
 * user writes an absolute path, and `/foo` is a mistyped command. The two are
 * spelled identically, and only the disk can tell them apart, so main names the
 * entries that exist directly under the filesystem root. A leading `/name` that
 * appears in that list stays a path and goes to the model; anything else that
 * looks like a command gets a local "unknown command" answer.
 *
 * The channel takes NO renderer-supplied argument (main reads its own
 * filesystem root) and returns entry NAMES only — no paths, no sizes, no file
 * contents — so there is nothing here to redirect into a path probe.
 */

/** invoke channel: entry names directly under the filesystem root. */
export const PATH_ROOTS_CHANNEL = "anycode:path-roots";

export interface PathRootsResult {
  /** Entry names under the root, dotfiles omitted and capped main-side. */
  names: string[];
}

/**
 * Chat-artifact IPC (TASK.72): inline preview of images an agent created on
 * disk, plus "Open with default app" / "Reveal in folder" actions for the
 * links the transcript renders. Mirrors the subagents/skills IPC shape
 * exactly: handler logic is exported pure functions over a deps bag
 * (unit-testable without ipcMain), zod validates every payload at the
 * boundary, and `registerArtifactsIpc` is the only Electron-touching piece.
 *
 * THREAT MODEL (TASK.72 §«Риск, который нельзя проглядеть»): the path in an
 * assistant message is MODEL-CONTROLLED text. This module is therefore the
 * one place that decides what the renderer may do with it:
 *
 * - CONTAINMENT: a path is only served when it resolves (symlinks resolved,
 *   case-normalized on darwin/win32) under one of the allowed roots: the
 *   requesting tab's workspace, `<home>/.anycode` (codex profile homes,
 *   including `generated_images/`, and every other app-owned artifact dir),
 *   or the OS temp dir (the agent's scratch space). A path outside every
 *   root is refused `outside_allowed_roots` — no read, no open, no reveal.
 * - NO EXECUTION: `shell.openPath` runs the OS default handler — for
 *   `.app`/`.command`/`.scpt` that IS execution, not viewing. Open is
 *   therefore gated on a fixed image-extension allowlist; every other file
 *   (and every image on open-refusal) degrades to `reveal`
 *   (`shell.showItemInFolder`), which only ever shows a file, never runs it.
 * - READ CUSTODY: the renderer never gets a `file://` URL (CSP forbids it);
 *   image bytes are read main-side AFTER the containment check and returned
 *   base64 for a `data:` URL. A byte cap keeps a hostile/fat file from
 *   ballooning the renderer; SVG is never inlined (active format — scripts,
 *   external refs) and falls back to open/reveal.
 *
 * Deliberate residual (documented, accepted): ANY image-looking file under
 * an allowed root can be opened/revealed — containment is the security
 * boundary, not "did the agent create this exact file" provenance.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { z } from "zod";

// ── channels (preload duplicates these literals — shared/** convention is frozen per-track) ──

export const ARTIFACT_READ_IMAGE_CHANNEL = "anycode:artifact-read-image";
export const ARTIFACT_OPEN_CHANNEL = "anycode:artifact-open";
export const ARTIFACT_REVEAL_CHANNEL = "anycode:artifact-reveal";

// ── shared result shapes (duplicated on purpose in preload/index.ts + renderer) ──

export type ArtifactReadImageResult =
  | { ok: true; mime: string; dataBase64: string; sizeBytes: number }
  | {
      ok: false;
      reason:
        | "invalid"
        | "no_workspace"
        | "not_found"
        | "outside_allowed_roots"
        | "not_previewable"
        | "too_large"
        | "io_error";
    };

export type ArtifactActionResult =
  | { ok: true; resolvedTo?: "reveal" }
  | {
      ok: false;
      reason: "invalid" | "no_workspace" | "not_found" | "outside_allowed_roots" | "not_openable" | "io_error";
    };

// ── policy constants ──

/** Extensions the inline reader will decode. SVG excluded by design (active format). */
const PREVIEWABLE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Extensions `shell.openPath` may fire on. Broader than the inline set —
 * still raster images ONLY. SVG is deliberately excluded: it is an active
 * format and its default OS handler may be a browser. Anything else
 * (`.svg`, `.command`, `.app`, `.dmg`, …) is reveal-only and never reaches
 * `shell.openPath`.
 */
const OPENABLE_EXTENSIONS = new Set([...Object.keys(PREVIEWABLE_MIME), ".bmp", ".ico", ".avif", ".tiff", ".tif", ".heic"]);

/** Inline-read byte cap — anything bigger stays a link + open/reveal actions. */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

// ── fs / shell ports (structural, main-local — same rule as SubagentsFs) ──

export interface ArtifactsFs {
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  realpath(path: string): Promise<string>;
  /** O_NOFOLLOW read — the file being previewed must not be a symlink swapped in after the containment check. */
  readFileNoFollow(path: string): Promise<Buffer>;
}

export class NodeArtifactsFs implements ArtifactsFs {
  async stat(path: string) {
    const s = await fsp.stat(path);
    return { size: s.size, isFile: s.isFile() };
  }
  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }
  async readFileNoFollow(path: string): Promise<Buffer> {
    // O_NOFOLLOW fails open() with ELOOP if the final component is a symlink
    // (closes the realpath→read TOCTOU on the read path).
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}

export interface ArtifactsIpcDeps {
  /** `os.homedir()` in production; dev/automation-overridable at the wiring site. */
  home(): string;
  /** OS temp dir root (`os.tmpdir()` in production) — injected for tests. */
  tmpdir(): string;
  /** Resolves the requesting tab's workspace from main's own tab-meta fact — never a renderer-supplied path. */
  workspaceForTab(tabId: string): string | undefined;
  fs: ArtifactsFs;
  /** `shell.openPath` in production; resolves with "" on success, an error string otherwise. */
  openPath(path: string): Promise<string>;
  /** `shell.showItemInFolder` in production. */
  reveal(path: string): void;
}

// ── payload schemas ──

const pathSchema = z.object({
  tabId: z.string().min(1),
  path: z.string().min(1).max(4096),
});

// ── containment ──

/**
 * The roots a served path must live under: the tab's workspace, the app's
 * own artifact tree (`<home>/.anycode` — codex profile homes with
 * `generated_images/` etc.), and the OS temp dir. Home itself is NOT a root:
 * containment is what keeps a model-invented `~/.ssh/id_rsa` out of the
 * reader (it would fail the extension gate anyway, but reveal must not
 * spotlight it either).
 */
export function allowedArtifactRoots(workspace: string, home: string, tmp: string): string[] {
  return [workspace, join(home, ".anycode"), tmp];
}

/**
 * Case/separator normalization for path comparison. Always compares in
 * POSIX form (platform-independent, so the darwin/win32 behavior is unit-
 * testable from any host): win32's `\` separators become `/`, and darwin/
 * win32 filesystems are case-insensitive by default, so a case-variant path
 * must compare equal (an attacker-crafted case-different symlink target
 * must not slip past a case-sensitive string compare).
 */
function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  let n = pathResolve(p);
  if (platform === "win32") {
    n = n.replace(/\\/g, "/");
  }
  n = n.replace(/\/+$/, "");
  return platform === "darwin" || platform === "win32" ? n.toLowerCase() : n;
}

/** True when `resolvedChild` lies inside `resolvedRoot` (both already realpath'd), or equals it. */
export function isUnderRoot(resolvedChild: string, resolvedRoot: string, platform: NodeJS.Platform = process.platform): boolean {
  const child = normalizeForCompare(resolvedChild, platform);
  const root = normalizeForCompare(resolvedRoot, platform);
  return child === root || child.startsWith(root + "/");
}

/**
 * Resolves the caller-supplied path against the allowed roots: absolutizes
 * (relative paths resolve against the tab's workspace — the form a bare
 * `out/icon.png` in a reply arrives in), realpaths the file itself AND every
 * root (roots can be symlinked too — `/tmp` on some systems), then checks
 * containment. Returns the real path on success, `null` on any failure
 * (missing file, symlink escape, outside roots) — callers map `null` to the
 * honest refusal their surface owns.
 */
export async function resolveContainedPath(
  deps: ArtifactsIpcDeps,
  tabId: string,
  rawPath: string,
): Promise<{ realPath: string } | { failure: "no_workspace" | "not_found" | "outside_allowed_roots" }> {
  const workspace = deps.workspaceForTab(tabId);
  if (workspace === undefined) {
    return { failure: "no_workspace" };
  }
  // The renderer recognizes `~/…` as a local artifact form. Expand only a
  // bare tilde or a tilde followed by a path separator; `~other/...` is an
  // ordinary relative filename, never shell-style user expansion.
  const candidate = rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
    ? pathResolve(deps.home(), rawPath.slice(2))
    : isAbsolute(rawPath)
      ? rawPath
      : pathResolve(workspace, rawPath);
  let realPath: string;
  try {
    realPath = await deps.fs.realpath(candidate);
  } catch {
    return { failure: "not_found" };
  }
  for (const root of allowedArtifactRoots(workspace, deps.home(), deps.tmpdir())) {
    let realRoot: string;
    try {
      realRoot = await deps.fs.realpath(root);
    } catch {
      continue; // a root that doesn't exist (yet) contains nothing
    }
    if (isUnderRoot(realPath, realRoot)) {
      return { realPath };
    }
  }
  return { failure: "outside_allowed_roots" };
}

/** Lowercased final-extension of a path ("" when none). */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// ── handlers (exported for unit tests) ──

/**
 * artifact-read-image: containment-checked, extension-gated, byte-capped
 * read of one image file for the inline chat preview. SVG is refused
 * `not_previewable` (active format — the UI falls back to open/reveal).
 */
export async function handleArtifactReadImage(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactReadImageResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveContainedPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  const mime = PREVIEWABLE_MIME[extensionOf(resolved.realPath)];
  if (mime === undefined) {
    return { ok: false, reason: "not_previewable" };
  }
  let size: number;
  try {
    const s = await deps.fs.stat(resolved.realPath);
    if (!s.isFile) {
      return { ok: false, reason: "not_found" };
    }
    size = s.size;
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (size > MAX_INLINE_IMAGE_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  try {
    const bytes = await deps.fs.readFileNoFollow(resolved.realPath);
    return { ok: true, mime, dataBase64: bytes.toString("base64"), sizeBytes: bytes.length };
  } catch (error) {
    console.warn(`[artifacts-ipc] read failed for ${resolved.realPath}`, error);
    return { ok: false, reason: "io_error" };
  }
}

/**
 * artifact-open: `shell.openPath` on the containment-checked path, gated on
 * the image-extension allowlist (openPath EXECUTES non-viewable types via
 * the OS handler). An openPath error (no handler, user cancel) degrades to
 * reveal so the user is never left with a dead click.
 */
export async function handleArtifactOpen(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactActionResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveContainedPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  if (!OPENABLE_EXTENSIONS.has(extensionOf(resolved.realPath))) {
    return { ok: false, reason: "not_openable" };
  }
  let openError: string;
  try {
    openError = await deps.openPath(resolved.realPath);
  } catch (error) {
    console.warn(`[artifacts-ipc] openPath threw for ${resolved.realPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  if (openError !== "") {
    // No default handler / launch failure — fall back to showing the file.
    console.warn(`[artifacts-ipc] openPath failed for ${resolved.realPath}: ${openError}; falling back to reveal`);
    try {
      deps.reveal(resolved.realPath);
      return { ok: true, resolvedTo: "reveal" };
    } catch (error) {
      console.warn(`[artifacts-ipc] reveal fallback failed`, error);
      return { ok: false, reason: "io_error" };
    }
  }
  return { ok: true };
}

/**
 * artifact-reveal: `shell.showItemInFolder` on the containment-checked path.
 * Never executes anything — the safe action offered for every file type.
 */
export async function handleArtifactReveal(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactActionResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveContainedPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  try {
    deps.reveal(resolved.realPath);
  } catch (error) {
    console.warn(`[artifacts-ipc] reveal failed for ${resolved.realPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true };
}

/** Wires the three channels onto ipcMain. An unvalidatable payload gets a safe negative from the handler itself. */
export function registerArtifactsIpc(deps: ArtifactsIpcDeps): void {
  ipcMain.handle(ARTIFACT_READ_IMAGE_CHANNEL, (_event, raw: unknown) => handleArtifactReadImage(deps, raw));
  ipcMain.handle(ARTIFACT_OPEN_CHANNEL, (_event, raw: unknown) => handleArtifactOpen(deps, raw));
  ipcMain.handle(ARTIFACT_REVEAL_CHANNEL, (_event, raw: unknown) => handleArtifactReveal(deps, raw));
}

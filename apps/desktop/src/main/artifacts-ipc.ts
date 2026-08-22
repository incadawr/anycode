/**
 * Chat-artifact IPC (TASK.72): inline preview of images an agent created on
 * disk, plus "Open with default app" / "Reveal in folder" actions for the
 * links the transcript renders. Mirrors the subagents/skills IPC shape
 * exactly: handler logic is exported pure functions over a deps bag
 * (unit-testable without ipcMain), zod validates every payload at the
 * boundary, and `registerArtifactsIpc` is the only Electron-touching piece.
 *
 * THREAT MODEL (TASK.72 §«Риск, который нельзя проглядеть», extended by
 * TASK.77-B and TASK.77-A below): the path in an assistant message is
 * MODEL-CONTROLLED text. This module is therefore the one place that decides
 * what the renderer may do with it:
 *
 * - CONTAINMENT, per action (owner decision, 31.07): the allowed roots are the
 *   requesting tab's workspace, `<home>/.anycode` (codex profile homes,
 *   including `generated_images/`, and every other app-owned artifact dir),
 *   the OS temp dir (the agent's scratch space), and — darwin ONLY (TASK.77-B,
 *   owner decision 31.07) — the literal path `/tmp`. macOS's `os.tmpdir()`
 *   resolves to a per-app `/var/folders/...` directory, NOT `/tmp`; agents
 *   routinely write to the literal path anyway (it is the address every
 *   shell/tool means by "temp"), so leaving it out of the roots turned the
 *   documented "agent scratch space" into a gap at the address agents hit
 *   most. Unconditional (all platforms) was rejected: `path.resolve("/tmp")`
 *   on win32 resolves to the DRIVE-RELATIVE `C:\tmp`, and a directory that
 *   happens to exist there would silently become an allowed root — win32
 *   stays unchanged. Linux already has `/tmp` === `os.tmpdir()`, so the
 *   darwin branch is a documented no-op there, not a behavior change. Reading
 *   bytes into the renderer stays hard-confined to the roots, subject to the
 *   per-path consent grant below. Opening outside them is possible but never
 *   silent — it costs an explicit OS confirmation (or a prior Allow grant,
 *   below). Revealing is unconfined: `shell.showItemInFolder` only points
 *   Finder/Explorer at a file, and an agent writing to `/tmp` (which is NOT
 *   `os.tmpdir()` on macOS) made the old blanket refusal read as a broken
 *   button.
 * - CONSENT (TASK.77-A, owner decision 31.07): containment is the correct
 *   default, but a hard refusal with no way out reads as a dead end once the
 *   user has SEEN the file the agent made (the owner's screenshot report:
 *   `/tmp/anycode-icon-alt-2.png`, blocked, no way to say yes). For this
 *   reason, `ArtifactConsentStore` (below) is an in-memory, per-tab,
 *   per-resolved-path grant list — never persisted, never a settings key,
 *   cleared the moment the granting tab closes (main/index.ts wraps
 *   `TabHostManager.closeTab` to call `clearTab`). A grant widens WHERE
 *   `handleArtifactReadImage`/`handleArtifactOpen` may act for that ONE
 *   realPath ONLY — every other outside-root path, and every other tab,
 *   stays refused exactly as before. It never widens WHAT: the image-
 *   extension/size gates below run unchanged after a grant. A MISSING grant
 *   leaves `handleArtifactOpen`'s existing OS-confirmation path untouched; a
 *   PRESENT grant for the SAME realPath skips that modal, because the Allow
 *   click is already the explicit, path-specific consent the modal exists to
 *   collect — re-asking via a second, context-poorer prompt is a double-ask
 *   of the same question. `handleArtifactReveal` is untouched by any of this:
 *   it was already unconfined by design.
 * - NO EXECUTION: `shell.openPath` runs the OS default handler — for
 *   `.app`/`.command`/`.scpt` that IS execution, not viewing. Open is
 *   therefore gated on a fixed image-extension allowlist that NO confirmation
 *   and NO consent grant can widen; every other file (and every image on
 *   open-refusal) degrades to `reveal` (`shell.showItemInFolder`), which only
 *   ever shows a file, never runs it.
 * - READ CUSTODY: the renderer never gets a `file://` URL (CSP forbids it);
 *   image bytes are read main-side AFTER the containment-or-consent check and
 *   returned base64 for a `data:` URL. A byte cap keeps a hostile/fat file
 *   from ballooning the renderer; SVG is never inlined (active format —
 *   scripts, external refs) and falls back to open/reveal.
 *
 * Deliberate residual (documented, accepted): ANY image-looking file under an
 * allowed root — or individually consented — can be opened/revealed:
 * containment-or-consent is the security boundary, not "did the agent create
 * this exact file" provenance.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { z } from "zod";
import type { PreviewOpenSuccess, PreviewResult } from "../shared/preview.js";
import { extensionOfPath, PREVIEWABLE_DOC_EXTENSIONS } from "../shared/previewable.js";

// ── channels (preload duplicates these literals — shared/** convention is frozen per-track) ──

export const ARTIFACT_READ_IMAGE_CHANNEL = "anycode:artifact-read-image";
export const ARTIFACT_OPEN_CHANNEL = "anycode:artifact-open";
export const ARTIFACT_REVEAL_CHANNEL = "anycode:artifact-reveal";
/** TASK.77-A: per-tab, per-path consent grant for a previously-blocked path. */
export const ARTIFACT_ALLOW_CHANNEL = "anycode:artifact-allow";
/**
 * Night-track wave-1 (owner ask): user-initiated open/reopen of a local
 * HTML/markdown artifact link in the PreviewHost window — the click surface
 * for a window the user can otherwise only reach via an agent tool or
 * turn-end auto-open, with no way back once closed.
 */
export const ARTIFACT_PREVIEW_CHANNEL = "anycode:artifact-preview";
/**
 * TASK.112 slice 2: batched existence/containment probe for candidate paths
 * the renderer's plain-text scan (`markdown/path-spans.ts`) found in prose or
 * inline code — a yes/no oracle so `Markdown.tsx` can decide which of those
 * candidates are real, in-bounds files worth linkifying. Deliberately NOT the
 * same channel as `ARTIFACT_PREVIEW_CHANNEL`: that one opens a window as a
 * side effect, and a probe run on every render of every message must never
 * do that.
 */
export const ARTIFACT_PREVIEWABLE_CHANNEL = "anycode:artifact-previewable";

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
      reason:
        | "invalid"
        | "no_workspace"
        | "not_found"
        | "outside_allowed_roots"
        /** Open outside the allowed roots, and the user said no at the OS prompt. */
        | "declined"
        | "not_openable"
        | "io_error";
    };

/**
 * TASK.77-A: result of an Allow click. An outside-roots path is exactly what
 * this channel exists to unlock, so it is NEVER a refusal reason here — only
 * a missing workspace (unknown tab) or a path that does not resolve at all
 * can fail. Never widens what the OTHER two channels' extension gates allow.
 */
export type ArtifactAllowResult = { ok: true; realPath: string } | { ok: false; reason: "no_workspace" | "not_found" };

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

/**
 * Extensions the artifact-preview channel may load into a PreviewHost window
 * — deliberately disjoint from `OPENABLE_EXTENSIONS`/`PREVIEWABLE_MIME`
 * above: a document format PreviewHost RENDERS, never a raster image and
 * never `shell.openPath`. TASK.112 moved the list itself to
 * `shared/previewable.ts` so this gate cannot drift from the five others.
 */

/** Inline-read byte cap — anything bigger stays a link + open/reveal actions. */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** TASK.112 slice 2: caps on the previewable-probe batch — excess is DROPPED, never a refusal (see `previewableSchema`'s own comment). */
export const MAX_PREVIEWABLE_PATHS = 64;
export const MAX_PREVIEWABLE_PATH_CHARS = 1024;

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

/**
 * TASK.77-A: per-tab, per-resolved-path consent grants. In-memory only — no
 * settings key, no disk persistence, "always for this folder" is explicitly
 * out of wave 1 (owner cut). Backed by a plain `Map<tabId, Set<path>>`;
 * `normalizeForCompare` (below) is reused so a grant survives the exact same
 * case/separator normalization the containment check itself applies —
 * otherwise a win32/darwin case-variant re-request of the SAME file would
 * miss its own grant.
 */
export class ArtifactConsentStore {
  private readonly byTab = new Map<string, Set<string>>();

  /** Records consent for exactly this tab + resolved path. */
  allow(tabId: string, realPath: string): void {
    const key = normalizeForCompare(realPath, process.platform);
    let paths = this.byTab.get(tabId);
    if (paths === undefined) {
      paths = new Set();
      this.byTab.set(tabId, paths);
    }
    paths.add(key);
  }

  /** Whether this tab has previously been granted this exact resolved path. */
  isAllowed(tabId: string, realPath: string): boolean {
    return this.byTab.get(tabId)?.has(normalizeForCompare(realPath, process.platform)) ?? false;
  }

  /** Drops every grant for a tab (main wires this into the tab-close path — a grant must not outlive the tab it was given to). */
  clearTab(tabId: string): void {
    this.byTab.delete(tabId);
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
  /**
   * Asks the user to confirm opening a path that lies outside the allowed
   * roots; resolves true only on an explicit yes. Production wiring is a modal
   * `dialog.showMessageBox`, so the decision is made by the OS window, not by
   * anything the model can address.
   */
  confirmOpen(realPath: string): Promise<boolean>;
  /** TASK.77-A: per-tab consent grants; main injects one process-lifetime singleton (main/index.ts). */
  consent: ArtifactConsentStore;
  /**
   * Night-track wave-1: opens `realPath` (already containment-and-extension
   * checked by `handleArtifactPreview`) in the tab's PreviewHost window.
   * Bound at the wiring site (main/index.ts) to
   * `PreviewHostHandle.openForPathClick` — the user-click entrypoint that
   * reuses/refreshes/focuses an already-open preview for this SAME realpath
   * instead of stacking a new one on every click (owner smoke-test defect
   * fix), falling through to the SAME render+sanitize pipe turn-end
   * auto-open and the host-process BrowserOpen tool use for a brand-new
   * preview. Never given a raw model-authored path.
   */
  openPreview(tabId: string, realPath: string): Promise<PreviewResult<PreviewOpenSuccess>>;
}

// ── payload schemas ──

const pathSchema = z.object({
  tabId: z.string().min(1),
  path: z.string().min(1).max(4096),
});

/**
 * TASK.112 slice 2: deliberately UNBOUNDED at the zod layer — `paths` may be
 * any array of strings. `handleArtifactPreviewable` enforces the 64-item /
 * 1024-char caps itself by DROPPING the excess, per its own doc comment; a
 * `.max()` here would instead REFUSE the whole batch (`{ paths: [] }`) for
 * one oversized entry among otherwise-fine ones, which is not what "cap,
 * don't fail" means.
 */
const previewableSchema = z.object({
  tabId: z.string().min(1),
  paths: z.array(z.string()),
});

// ── containment ──

/**
 * The roots a served path must live under: the tab's workspace, the app's
 * own artifact tree (`<home>/.anycode` — codex profile homes with
 * `generated_images/` etc.), the OS temp dir, and — darwin only (TASK.77-B) —
 * the literal path `/tmp` (see the module's threat-model comment for why this
 * is darwin-specific rather than unconditional). Home itself is NOT a root:
 * containment is what keeps a model-invented `~/.ssh/id_rsa` out of the
 * reader (it would fail the extension gate anyway, but reveal must not
 * spotlight it either). `platform` defaults to `process.platform`; tests pass
 * it explicitly so all three platforms are exercised from one host.
 */
export function allowedArtifactRoots(workspace: string, home: string, tmp: string, platform: NodeJS.Platform = process.platform): string[] {
  const roots = [workspace, join(home, ".anycode"), tmp];
  if (platform === "darwin") {
    roots.push("/tmp");
  }
  return roots;
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
/**
 * Resolves a model-supplied path to a real one and reports whether it lands
 * under an allowed root. Containment is now a FACT the caller acts on rather
 * than a verdict baked in here, because the three actions weigh it
 * differently: read refuses (unless consented, TASK.77-A), open asks (unless
 * consented), reveal ignores it.
 */
export async function resolveArtifactPath(
  deps: ArtifactsIpcDeps,
  tabId: string,
  rawPath: string,
): Promise<{ realPath: string; contained: boolean } | { failure: "no_workspace" | "not_found" }> {
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
      return { realPath, contained: true };
    }
  }
  return { realPath, contained: false };
}

/**
 * The plain strict verdict, with NO consent overlay: outside the roots is a
 * flat refusal. Exported for tests and any future strict-only consumer;
 * `handleArtifactReadImage` no longer calls this directly (TASK.77-A) since
 * it must consult the consent store before refusing — it calls
 * `resolveArtifactPath` itself and applies the same strict mapping plus the
 * consent check in one place.
 */
export async function resolveContainedPath(
  deps: ArtifactsIpcDeps,
  tabId: string,
  rawPath: string,
): Promise<{ realPath: string } | { failure: "no_workspace" | "not_found" | "outside_allowed_roots" }> {
  const resolved = await resolveArtifactPath(deps, tabId, rawPath);
  if ("failure" in resolved) {
    return resolved;
  }
  return resolved.contained ? { realPath: resolved.realPath } : { failure: "outside_allowed_roots" };
}

/** Lowercased final-extension of a path ("" when none). */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// ── handlers (exported for unit tests) ──

/**
 * artifact-read-image: containment-or-consent-checked, extension-gated,
 * byte-capped read of one image file for the inline chat preview. SVG is
 * refused `not_previewable` (active format — the UI falls back to
 * open/reveal). TASK.77-A: a path outside every root still reads if this
 * tab was explicitly granted THIS exact realPath via the allow channel; the
 * extension/size gates below are unaffected by consent.
 */
export async function handleArtifactReadImage(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactReadImageResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveArtifactPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  if (!resolved.contained && !deps.consent.isAllowed(parsed.data.tabId, resolved.realPath)) {
    return { ok: false, reason: "outside_allowed_roots" };
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
 * artifact-open: `shell.openPath`, gated on the image-extension allowlist
 * (openPath EXECUTES non-viewable types via the OS handler) and — outside the
 * allowed roots, and not already consented (TASK.77-A) — on an explicit user
 * confirmation. The extension gate runs FIRST: never prompt about (or
 * silently allow via a stale grant) a file that would be refused either way.
 * An openPath error (no handler, user cancel) degrades to reveal so the user
 * is never left with a dead click.
 */
export async function handleArtifactOpen(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactActionResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveArtifactPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  if (!OPENABLE_EXTENSIONS.has(extensionOf(resolved.realPath))) {
    return { ok: false, reason: "not_openable" };
  }
  if (!resolved.contained && !deps.consent.isAllowed(parsed.data.tabId, resolved.realPath)) {
    let approved: boolean;
    try {
      approved = await deps.confirmOpen(resolved.realPath);
    } catch (error) {
      // A prompt that cannot be shown is a NO: never open on a broken gate.
      console.warn(`[artifacts-ipc] open confirmation failed for ${resolved.realPath}`, error);
      return { ok: false, reason: "declined" };
    }
    if (!approved) {
      return { ok: false, reason: "declined" };
    }
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
 * artifact-reveal: `shell.showItemInFolder` on any path that resolves. Never
 * executes anything and never hands the renderer a byte — the safe action
 * offered for every file type, so containment is deliberately not applied
 * here (owner decision, 31.07).
 */
export async function handleArtifactReveal(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactActionResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const resolved = await resolveArtifactPath(deps, parsed.data.tabId, parsed.data.path);
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

/**
 * artifact-allow (TASK.77-A): records this tab's explicit consent for
 * exactly this resolved path. An outside-roots path is exactly what Allow
 * exists to unlock — it is NEVER refused for being outside; only a missing
 * workspace (unknown tab) or a path that fails to resolve at all (deleted,
 * never existed) produce a negative result. A malformed payload is bucketed
 * under `not_found` (there is no path to resolve, and the frozen result type
 * carries no `invalid` reason for this channel — see cut §2.6).
 */
export async function handleArtifactAllow(deps: ArtifactsIpcDeps, raw: unknown): Promise<ArtifactAllowResult> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "not_found" };
  }
  const resolved = await resolveArtifactPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  deps.consent.allow(parsed.data.tabId, resolved.realPath);
  return { ok: true, realPath: resolved.realPath };
}

/**
 * artifact-preview (night-track wave-1, owner ask): user click on a local
 * `.html`/`.htm`/`.md` artifact link opens/reopens it in the PreviewHost
 * window — today that window is reachable only via an agent tool or turn-end
 * auto-open, with no way back once the user closes it. A repeat click on the
 * SAME path reuses/refreshes/focuses that one live preview rather than
 * stacking a new one (owner smoke-test defect fix) — `deps.openPreview` is
 * bound to `PreviewHostHandle.openForPathClick`, not `openForTab` directly,
 * so that reuse-by-realpath is PreviewHost's own concern, not duplicated
 * here. Containment is STRICT, with NO consent overlay:
 * `preview/preview-host.ts`'s own threat model treats a live, script-running
 * window as a different risk class than the read-only bytes
 * `handleArtifactReadImage`/`handleArtifactOpen` hand the renderer, and
 * deliberately never honors an outside-roots Allow grant for that reason —
 * `openForPathClick` re-resolves and re-refuses outside-roots paths
 * regardless, so this gate simply fails the same request honestly and
 * earlier. The extension gate is disjoint from `OPENABLE_EXTENSIONS` (raster
 * images, `shell.openPath`) — this channel never touches `shell.openPath`.
 */
export async function handleArtifactPreview(deps: ArtifactsIpcDeps, raw: unknown): Promise<PreviewResult<PreviewOpenSuccess>> {
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid artifact-preview request", errorKind: "invalid_input" };
  }
  const resolved = await resolveContainedPath(deps, parsed.data.tabId, parsed.data.path);
  if ("failure" in resolved) {
    return { ok: false, error: `cannot preview ${parsed.data.path}: ${resolved.failure}`, errorKind: "invalid_input" };
  }
  if (!PREVIEWABLE_DOC_EXTENSIONS.has(extensionOf(resolved.realPath))) {
    return { ok: false, error: `cannot preview ${parsed.data.path}: unsupported extension`, errorKind: "invalid_input" };
  }
  return deps.openPreview(parsed.data.tabId, resolved.realPath);
}

/**
 * artifact-previewable (TASK.112 slice 2): a yes/no oracle for the renderer's
 * plain-text path scan (`markdown/path-spans.ts`) — for each candidate,
 * reports whether it is a real, in-bounds, previewable-extension REGULAR
 * FILE, so `Markdown.tsx` can decide which candidates earn a click-to-open
 * link. Returns the SUBSET of the caller's own input strings that passed
 * (never the resolved real paths) — the renderer matches spans against the
 * exact string it sent, and a resolved path (symlink-followed, case-
 * normalized) would not necessarily equal that string back.
 *
 * Bounded by the SAME containment resolution `handleArtifactPreview` uses
 * (`resolveContainedPath`) — this channel never widens WHERE a path may
 * resolve to, only adds a read-only existence check on top. It never opens,
 * reads bytes from, or reveals anything: a `stat` is the entire filesystem
 * interaction, which is why this is safe to call on every render of every
 * message rather than only on a user click.
 *
 * A malformed payload degrades to `{ paths: [] }` rather than throwing — the
 * probe is advisory (worst case, prose stays unlinked) so a bad payload must
 * never surface as an error toast. Oversized/duplicate input is silently
 * trimmed (dedupe, then drop paths over `MAX_PREVIEWABLE_PATH_CHARS`, then
 * cap the count at `MAX_PREVIEWABLE_PATHS`) rather than refused, per
 * `previewableSchema`'s own "cap, don't fail" comment.
 */
export async function handleArtifactPreviewable(deps: ArtifactsIpcDeps, raw: unknown): Promise<{ paths: string[] }> {
  const parsed = previewableSchema.safeParse(raw);
  if (!parsed.success) {
    return { paths: [] };
  }
  const { tabId, paths } = parsed.data;
  const candidates = [...new Set(paths)]
    .filter((path) => path.length > 0 && path.length <= MAX_PREVIEWABLE_PATH_CHARS)
    .slice(0, MAX_PREVIEWABLE_PATHS);

  const verified: string[] = [];
  for (const path of candidates) {
    // Extension gate on the ORIGINAL (unresolved) string — cheap, and the
    // one that matters: this channel answers for the exact string the
    // renderer is holding, so gating on anything else (e.g. a resolved
    // real path whose final segment a symlink could rename) would be
    // answering a slightly different question than the one being asked.
    if (!PREVIEWABLE_DOC_EXTENSIONS.has(extensionOfPath(path))) {
      continue;
    }
    const resolved = await resolveContainedPath(deps, tabId, path);
    if ("failure" in resolved) {
      continue;
    }
    try {
      const stat = await deps.fs.stat(resolved.realPath);
      if (!stat.isFile) {
        continue; // a directory (or other non-regular entry) that happens to share a previewable-looking name
      }
    } catch {
      continue; // deleted between resolveContainedPath's realpath and this stat — treat like never-existed
    }
    verified.push(path);
  }
  return { paths: verified };
}

/** Wires the six channels onto ipcMain. An unvalidatable payload gets a safe negative from the handler itself. */
export function registerArtifactsIpc(deps: ArtifactsIpcDeps): void {
  ipcMain.handle(ARTIFACT_READ_IMAGE_CHANNEL, (_event, raw: unknown) => handleArtifactReadImage(deps, raw));
  ipcMain.handle(ARTIFACT_OPEN_CHANNEL, (_event, raw: unknown) => handleArtifactOpen(deps, raw));
  ipcMain.handle(ARTIFACT_REVEAL_CHANNEL, (_event, raw: unknown) => handleArtifactReveal(deps, raw));
  ipcMain.handle(ARTIFACT_ALLOW_CHANNEL, (_event, raw: unknown) => handleArtifactAllow(deps, raw));
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNEL, (_event, raw: unknown) => handleArtifactPreview(deps, raw));
  ipcMain.handle(ARTIFACT_PREVIEWABLE_CHANNEL, (_event, raw: unknown) => handleArtifactPreviewable(deps, raw));
}

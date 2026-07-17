/**
 * Message input + turn controls (design §5, restructured in UI-5). Sends
 * `user_message` / `cancel_turn` / `set_mode` through the active tab's
 * connection (Phase-2 §4.3: `useTabSend`, the migrated equivalent of the old
 * singleton `sendToHost`). The composer (and mode switcher) is blocked whenever
 * a turn is running; the mode switcher is additionally blocked while the
 * connection isn't `ready` (set_mode is only valid between turns, and there's
 * no host to send it to before host_ready anyway).
 *
 * UI-5 layout: an elevated card holding a borderless auto-growing textarea, a
 * footer with the escalation-graded ModeMenu chip on the left and a context
 * meter + circular send/stop button on the right. The send / cancel / set_mode
 * wire traffic and the Enter-to-send behavior are unchanged from the pre-redesign
 * composer.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CodexRateLimitsWire, ImageAttachment, ImageMediaType, PermissionMode } from "@anycode/core";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import type { ContextUsage, DesktopState, SessionTokens, TurnState } from "../store.js";
import type { WireContextBreakdown } from "../../../shared/protocol.js";
import {
  makePasteMarker,
  reconstitutePasteMarkers,
  shouldCollapsePaste,
  countPasteLines,
  visiblePasteBlocks,
  type PasteBlock,
} from "../paste.js";
import { ModeMenu } from "./ModeMenu.js";
import { ModelPill, modelPickDisabled } from "./ModelPill.js";
import { EngineModelMenu, EnginePresetMenu, engineControlDisabled } from "./EngineControls.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";
import { PromptQueue } from "./PromptQueue.js";
import { SlashMenu } from "./SlashMenu.js";
import { ArrowUp, ImageIcon, Stop, X } from "./icons.js";
import { transcriptTextWithImages } from "../queue-format.js";
// Reuse, not re-derive (R1 anti-clip lesson): the same fixed-position
// viewport-clamp ModelPill's own popover uses to escape `.composer-footer-*`'s
// `overflow:hidden` (see ModelPill.tsx's import comment) — the ctx-popover
// below inherits the identical clipping hazard from the same footer ancestor.
// `formatAge` (compact relative-time, "3m"/"22h"/"4d") is reused verbatim
// for the quota popover's "resets in <relative>" line (TASK.51, cut §6.2) —
// same reuse discipline as `clampMenuLeft` above, no second relative-time
// formatter invented for the same job.
import { clampMenuLeft, formatAge } from "./Sidebar.js";
import {
  RUN_ACTION_EVENT,
  SETTINGS_SELECT_PANE_EVENT,
  SLASH_COMMANDS,
  assertNever,
  filterSlashItems,
  skillsToSlashSkills,
  slashMenuReduce,
  slashQueryAt,
  type SlashMenuCtx,
  type SlashRunIntent,
  type SlashSkill,
} from "../slash-menu.js";

/**
 * Enqueue-vs-direct-send decision for `handleSend` (F15 prompt queue). A send
 * takes the DIRECT path ONLY when the tab is TRULY idle — the turn is idle AND
 * no drained item is still in flight (`queueInFlight === null`). During the
 * "inFlight window" (a queued item was dispatched but its `turn_started` has
 * not arrived, so `turn.status` is still "idle") the tab is NOT safe to
 * direct-send into: the host would busy-reject it and the prompt would be lost.
 * Enqueue in that window instead. Exported for unit testing.
 */
export function shouldEnqueue(turnStatus: TurnState["status"], queueInFlight: DesktopState["queueInFlight"]): boolean {
  return turnStatus !== "idle" || queueInFlight !== null;
}

/**
 * Whether the current draft is actually sendable: trimmed text is non-empty OR
 * at least one image is attached (a whitespace-only draft is not). The single
 * predicate behind both `canSend` and the running-mode Queue button's gate, so
 * the button is never clickable when a click would silently no-op. Exported for
 * unit testing.
 */
export function hasSendableDraft(text: string, imageCount: number): boolean {
  return text.trim().length > 0 || imageCount > 0;
}

/**
 * TASK.56 W3: the current model's live image-input verdict (store's
 * `imageInput`, off hello/model_changed) reads `false` ONLY when the host
 * has explicitly resolved the CURRENT model as not accepting images.
 * `undefined` (no seam/legacy host) and `true` both mean "not blocked" —
 * the engine-level `supportsImages` gate (button visibility) is untouched by
 * this, this is model-level and rides ON TOP of it. Exported for unit testing.
 */
export function isImageAttachBlockedByModel(imageInput: boolean | undefined): boolean {
  return imageInput === false;
}

/**
 * Attachments already on the draft become send-blocking, not vanishing, the
 * moment the model swings vision -> non-vision mid-session (cut §3/W3(c)):
 * the user must switch back or remove them, never lose them silently.
 * Exported for unit testing.
 */
export function isSendBlockedByModelImages(imageInput: boolean | undefined, imageCount: number): boolean {
  return imageInput === false && imageCount > 0;
}

export const MODEL_IMAGE_ATTACH_BLOCKED_TEXT = "This model does not accept image attachments.";
export const MODEL_IMAGE_SEND_BLOCKED_TEXT =
  "This model does not accept image attachments — switch back to a vision-capable model or remove the attached images to send.";

/**
 * Context-meter percentage for the footer: `round(estimated / budget * 100)`.
 * Returns `null` when there is no reading or the budget is non-positive (guards
 * against NaN/Infinity), so the meter renders nothing rather than a garbage
 * figure. Exported for unit testing.
 */
export function contextMeterPercent(usage: ContextUsage | null): number | null {
  if (!usage || usage.budgetTokens <= 0) {
    return null;
  }
  return Math.round((usage.estimatedTokens / usage.budgetTokens) * 100);
}

/** Ctx-ring geometry (design slice-R7-cut §4.1): r=6 in a 14×14 viewBox, 1.5px stroke. */
export const CTX_RING_RADIUS = 6;
export const CTX_RING_CIRCUMFERENCE = 2 * Math.PI * CTX_RING_RADIUS;

/**
 * stroke-dashoffset for the ctx ring's progress arc: circumference × (1 − p/100),
 * with percent clamped to [0, 100] (an over-budget reading shows a full ring,
 * never a wrapped one; a negative/garbage reading shows an empty one).
 * Exported for unit testing.
 */
export function ctxRingDashOffset(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return CTX_RING_CIRCUMFERENCE * (1 - clamped / 100);
}

/**
 * R11 starter-chip seam (slice-R11-cut §3.3): window CustomEvent<string>
 * carrying composer-insert text — the sanctioned payload extension of the
 * R7/R9 payload-less event idiom. The listener module owns the const
 * (FOCUS_MODE_MENU_EVENT / SIDEBAR_SEARCH_EVENT precedent); exactly one
 * Composer is ever mounted (background tabs are never mounted).
 */
export const COMPOSER_INSERT_EVENT = "anycode:composer-insert";

export const COMPOSER_IMAGE_MAX_BYTES = 3_750_000;
export const COMPOSER_IMAGE_MAX_PER_MESSAGE = 8;
/** Largest edge used when an oversized image is normalized before attaching. */
export const COMPOSER_IMAGE_MAX_EDGE = 2_048;

interface DraftImage {
  id: number;
  name: string;
  sizeBytes: number;
  attachment: ImageAttachment;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

export function sniffComposerImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif";
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function formatImageSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: ImageMediaType, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("Could not resize image."));
      else resolve(blob);
    }, type, quality);
  });
}

/**
 * Normalizes an oversized still image for the immutable IPC limit. JPEG/WebP
 * additionally lower quality in steps; PNG is resized without changing its
 * format. GIF is deliberately excluded: canvas would silently discard frames.
 */
async function resizeComposerImage(file: File, mediaType: ImageMediaType): Promise<Uint8Array> {
  if (mediaType === "image/gif") {
    throw new Error(`${file.name || "image"} is an animated GIF and cannot be resized automatically.`);
  }
  const bitmap = await createImageBitmap(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    const largestEdge = Math.max(width, height);
    if (largestEdge > COMPOSER_IMAGE_MAX_EDGE) {
      const scale = COMPOSER_IMAGE_MAX_EDGE / largestEdge;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    for (let pass = 0; pass < 6; pass += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Could not resize image.");
      context.drawImage(bitmap, 0, 0, width, height);
      const quality = mediaType === "image/png" ? undefined : Math.max(0.5, 0.88 - pass * 0.08);
      const blob = await canvasBlob(canvas, mediaType, quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length <= COMPOSER_IMAGE_MAX_BYTES) return bytes;
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`${file.name || "image"} could not be reduced below the ${formatImageSize(COMPOSER_IMAGE_MAX_BYTES)} limit.`);
}

/**
 * Draft-insert semantics for a starter chip: an empty draft is replaced; a
 * non-empty draft keeps the user's text and appends on a new line (chips
 * must never destroy typed input). Returns the caret position (end of the
 * inserted text). Exported for unit testing.
 */
export function insertDraftText(current: string, insert: string): { text: string; caret: number } {
  const text =
    current.length === 0 ? insert : current.endsWith("\n") ? current + insert : `${current}\n${insert}`;
  return { text, caret: text.length };
}

/**
 * Finds the end offset of the slash token starting at `start` (the `/`
 * offset `slashQueryAt` returned) — the same token-char scan `slashQueryAt`
 * runs internally (slash-menu.ts's `isTokenChar`), duplicated here in
 * miniature because that scan isn't itself exported (only the query up to
 * the caret is). Selecting a menu row replaces the WHOLE token, not just the
 * caret-truncated query, so a mid-token caret still removes the full run of
 * token chars. Exported for unit testing.
 */
export function slashTokenEnd(text: string, start: number): number {
  let end = start + 1;
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end]!)) {
    end++;
  }
  return end;
}

/**
 * 14px context ring (ui-roadmap §4-R7(f)) — same datum as the % text beside it,
 * ambient-legible at a glance. Track = --border hairline; fill = currentColor,
 * so the existing .composer-ctx-meter warning/danger classes tint it for free.
 * Decorative (aria-hidden): the % text remains the SR-legible value.
 */
function CtxRing({ percent }: { percent: number }) {
  return (
    <svg
      className="composer-ctx-ring"
      viewBox="0 0 14 14"
      width={14}
      height={14}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="composer-ctx-ring-track" cx="7" cy="7" r={CTX_RING_RADIUS} fill="none" strokeWidth="1.5" />
      <circle
        className="composer-ctx-ring-fill"
        cx="7"
        cy="7"
        r={CTX_RING_RADIUS}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={CTX_RING_CIRCUMFERENCE}
        strokeDashoffset={ctxRingDashOffset(percent)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Ctx-breakdown popover (slice P7.17 · F12 W3, design slice-P7.17-cut.md
// §2.3/§3): hover/focus/click on the ctx meter opens a fixed-position
// popover showing the headline (reusing contextUsage's numbers for ring
// parity), a fill bar, per-category rows from the on-demand
// `contextBreakdown` store field, and the session token totals. Pure
// formatting/decision helpers below are exported for unit testing — this
// codebase tests Composer logic as plain functions (no component-mount
// harness), same discipline as `contextMeterPercent`/`ctxRingDashOffset`
// above and `shouldEnqueue`/`hasSendableDraft` below.
// ─────────────────────────────────────────────────────────────────────────

function trimTrailingZero(fixed: string): string {
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * Compact token-count formatting for the popover ("198.3K", "1M", "900") —
 * uses the approved context-breakdown layout:
 * "198.3K/1M"). Exported for unit testing.
 */
export function formatCtxTokenCount(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) {
    return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (abs >= 1_000) {
    return `${trimTrailingZero((tokens / 1_000).toFixed(1))}K`;
  }
  return `${Math.round(tokens)}`;
}

/**
 * Popover headline: `<estimated>/<budget> (<percent>%)`. Reuses
 * `contextUsage`'s own numbers and the SAME rounded percent the ctx ring/%

 * the headline and the ring next to it never disagree. `null` before the
 * first `context_usage` reading (mirrors the ring's own null-guard).
 * Exported for unit testing.
 */
export function ctxPopoverHeadline(usage: ContextUsage | null, percent: number | null): string | null {
  if (!usage || percent === null) {
    return null;
  }
  return `${formatCtxTokenCount(usage.estimatedTokens)}/${formatCtxTokenCount(usage.budgetTokens)} (${percent}%)`;
}

/** One rendered category row: label + its share of `totalEstimatedTokens`, as a raw (unrounded) percent. */
export interface CtxPopoverRow {
  label: string;
  percent: number;
}

/** Category order and labels for the context breakdown. */
const CTX_BREAKDOWN_CATEGORIES: ReadonlyArray<{
  key: Exclude<keyof WireContextBreakdown, "totalEstimatedTokens">;
  label: string;
}> = [
  { key: "messagesTokens", label: "Messages" },
  { key: "systemToolsTokens", label: "System tools" },
  { key: "mcpToolsTokens", label: "MCP tools" },
  { key: "skillsTokens", label: "Skills" },
  { key: "systemPromptTokens", label: "System prompt" },
  { key: "metaTokens", label: "Meta context" },
];

/**
 * Builds the popover's category rows from the on-demand breakdown: zero-token
 * categories are dropped (design §2.3: "Meta context" only appears when a
 * workspace actually has memory/skills/workflows/profiles/repoMap content),
 * and percentages are computed here (renderer-side, never in core — design
 * §2.1). Empty before the first response / when totals are non-positive.
 * Exported for unit testing.
 */
export function ctxPopoverRows(breakdown: WireContextBreakdown | null): CtxPopoverRow[] {
  if (!breakdown || breakdown.totalEstimatedTokens <= 0) {
    return [];
  }
  return CTX_BREAKDOWN_CATEGORIES.filter(({ key }) => breakdown[key] > 0).map(({ key, label }) => ({
    label,
    percent: (breakdown[key] / breakdown.totalEstimatedTokens) * 100,
  }));
}

/**
 * True while the popover is open but its on-demand breakdown hasn't arrived
 * yet (the request was just sent, or is still in flight) — the skeleton-row
 * predicate. Exported for unit testing.
 */
export function ctxPopoverLoading(open: boolean, breakdown: WireContextBreakdown | null): boolean {
  return open && breakdown === null;
}

export type CtxPopoverBodyState = "skeleton" | "empty" | "rows" | "unsupported";

/**
 * What the popover body should render: `"unsupported"` when the engine has
 * no per-category breakdown at all (codex-profiles cut §5.2, C-bug-1 fix —
 * Codex reports `supportsContextUsage` but never `supportsContextBreakdown`,
 * so the honest answer is a message, not a skeleton that spins forever);
 * otherwise rows once the breakdown has arrived, a skeleton while it's still
 * in flight, or an "unavailable" message once the loading timeout has
 * elapsed with nothing (P2-a robustness fix -- a lost
 * `context_breakdown_request` must not spin the skeleton forever). Exported
 * for unit testing.
 */
export function ctxPopoverBodyState(supportsBreakdown: boolean, loading: boolean, timedOut: boolean): CtxPopoverBodyState {
  if (!supportsBreakdown) {
    return "unsupported";
  }
  if (!loading) {
    return "rows";
  }
  return timedOut ? "empty" : "skeleton";
}

/**
 * "Session tokens: in X · out Y · total Z" line, or `null` to hide the row
 * entirely (no `finish` has landed in this session yet). Exported for unit
 * testing.
 */
export function formatSessionTokensLine(tokens: SessionTokens | null): string | null {
  if (!tokens) {
    return null;
  }
  return `in ${formatCtxTokenCount(tokens.input)} · out ${formatCtxTokenCount(tokens.output)} · total ${formatCtxTokenCount(tokens.total)}`;
}

/** Latest provider cache-hit percentage, or an explicit unavailable state. */
export function formatLatestCacheHitLine(tokens: SessionTokens | null): string | null {
  if (!tokens) {
    return null;
  }
  if (tokens.latestCacheRead === undefined || tokens.latestCacheInput === undefined || tokens.latestCacheInput <= 0) {
    return "Latest cache hit: not reported by provider";
  }
  const percent = Math.round((tokens.latestCacheRead / tokens.latestCacheInput) * 100);
  return `Latest cache hit: ${percent}% (${formatCtxTokenCount(tokens.latestCacheRead)}/${formatCtxTokenCount(tokens.latestCacheInput)} input)`;
}

// ─────────────────────────────────────────────────────────────────────────
// Codex subscription-quota lines (TASK.51, cut §6): additive to the ctx
// popover, shown alongside — never instead of — the session-tokens lines
// above. `CodexRateLimitsWire` (core) already carries the sparse-merged
// snapshot as-is (host-side merge, `shared/codex-quota.ts`); this module only
// formats it for display, never merges. Pure formatting/decision helpers
// below are exported for unit testing, same discipline as the rest of this
// file.
// ─────────────────────────────────────────────────────────────────────────

type QuotaWindowWire = NonNullable<CodexRateLimitsWire["primary"]>;
type QuotaCreditsWire = NonNullable<CodexRateLimitsWire["credits"]>;

/** Exact window-length labels the live wire probe confirmed (amendment §A3.2) — never hardcoded past this table. */
const QUOTA_WINDOW_LABELS: Readonly<Record<number, string>> = {
  60: "1h",
  300: "5h",
  1440: "Daily",
  10080: "Weekly",
  43200: "Monthly",
};

/**
 * Derives a window's display label from `windowDurationMins` (cut §6.2) —
 * NEVER a hardcoded "5h"/"Weekly" pair (the live wire showed exactly ONE
 * populated window per plan, amendment §A3.2). A duration outside the known
 * table rounds to hours (<1 day) or days (>=1 day); absent/null falls back to
 * `limitName`, then the literal "Limit". Exported for unit testing.
 */
export function quotaWindowLabel(windowDurationMins: number | null | undefined, limitName: string | null | undefined): string {
  if (windowDurationMins == null) {
    return limitName ?? "Limit";
  }
  const known = QUOTA_WINDOW_LABELS[windowDurationMins];
  if (known !== undefined) {
    return known;
  }
  return windowDurationMins < 1440
    ? `${trimTrailingZero((windowDurationMins / 60).toFixed(1))}h`
    : `${trimTrailingZero((windowDurationMins / 1440).toFixed(1))}d`;
}

/**
 * One quota window's popover line: "<label> · <percent left>% left · resets
 * in <relative>" (cut §6.2). `resetsAt` is epoch SECONDS on the wire
 * (amendment §A3.1) — multiplied by 1000 here, the sole conversion point.
 * `null` for a missing window (nothing rendered — never a fabricated "0%").
 * Exported for unit testing.
 */
export function formatQuotaWindowLine(
  window: QuotaWindowWire | null | undefined,
  limitName: string | null | undefined,
  now: number,
): string | null {
  if (!window) {
    return null;
  }
  const label = quotaWindowLabel(window.windowDurationMins, limitName);
  const percentLeft = Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)));
  const resetsPart = window.resetsAt != null ? ` · resets in ${formatAge(window.resetsAt * 1000, now)}` : "";
  return `${label} · ${percentLeft}% left${resetsPart}`;
}

/**
 * Credits line: rendered ONLY when `hasCredits` (cut §6.2) — "Unlimited" for
 * an unlimited plan, else the raw wire `balance` string (never coerced to a
 * number, amendment §A3.6). `null` hides the line entirely. Exported for unit
 * testing.
 */
export function formatQuotaCreditsLine(credits: QuotaCreditsWire | null | undefined): string | null {
  if (!credits || !credits.hasCredits) {
    return null;
  }
  if (credits.unlimited) {
    return "Credits: Unlimited";
  }
  return credits.balance != null ? `Credits: ${credits.balance}` : null;
}

/** The quota popover's rendered lines, or `null` when there is nothing to show (cut §6.2: hidden block, never "0%"). */
export interface QuotaPopoverView {
  primaryLine: string | null;
  secondaryLine: string | null;
  creditsLine: string | null;
}

/**
 * Assembles the quota popover section from a snapshot: hides the whole block
 * when every line would be empty (no quota reporting yet, or an engine that
 * doesn't report quotas at all) rather than rendering a hollow "0%" section.
 * Exported for unit testing.
 */
export function buildQuotaPopoverView(quota: CodexRateLimitsWire | null, now: number): QuotaPopoverView | null {
  if (!quota) {
    return null;
  }
  const primaryLine = formatQuotaWindowLine(quota.primary, quota.limitName, now);
  const secondaryLine = formatQuotaWindowLine(quota.secondary, quota.limitName, now);
  const creditsLine = formatQuotaCreditsLine(quota.credits);
  if (primaryLine === null && secondaryLine === null && creditsLine === null) {
    return null;
  }
  return { primaryLine, secondaryLine, creditsLine };
}

/** Nominal popover width (px) for the right-edge-anchored viewport clamp — mirrors ModelPill's `MODEL_PILL_POPOVER_WIDTH` (matches `.ctx-popover`'s CSS `width`). */
const CTX_POPOVER_WIDTH = 280;

/** Hover-intent delay (design §2.3) before the popover opens on mouseenter, so a cursor merely passing over the meter doesn't flash it open. */
const CTX_POPOVER_HOVER_DELAY_MS = 150;

/**
 * Loading-timeout guard (P2-a robustness fix): if the popover is open and
 * `contextBreakdown` is still null after this long, the request is assumed
 * lost (host/port died right at open) and the skeleton gives way to an
 * "unavailable" message instead of spinning forever.
 */
const CTX_POPOVER_LOAD_TIMEOUT_MS = 6000;

/**
 * Fixed-position anchor formula shared by the on-open effect and the
 * on-resize re-clamp (P2-b robustness fix): right edge clamped inside the
 * viewport (`clampMenuLeft`, same as ModelPill's popover), bottom pinned
 * just above the trigger. Pure so both call sites share one formula instead
 * of duplicating the offset/clamp math. Exported for unit testing.
 */
export function ctxPopoverAnchorFromRect(
  rect: { right: number; top: number },
  viewportWidth: number,
  viewportHeight: number,
): { left: number; bottom: number } {
  return {
    left: clampMenuLeft(rect.right - CTX_POPOVER_WIDTH, CTX_POPOVER_WIDTH, viewportWidth),
    bottom: viewportHeight - rect.top + 8,
  };
}

/**
 * Hover/focus/click-triggered popover anchored to the ctx meter. Positioning
 * mirrors ModelPill.tsx's popover (position:fixed, anchor computed from
 * `getBoundingClientRect` on open, `clampMenuLeft` reused as-is) — the SAME
 * `.composer-footer-*` `overflow:hidden` ancestor clips this popover exactly
 * like it clips ModelPill's, so a plain `bottom:100%` would be invisible
 * here too. Anchored to the trigger's RIGHT edge (not left, like ModelPill)
 * since the ctx meter sits at the far right of the footer.
 */
function CtxPopover({
  contextUsage,
  contextBreakdown,
  sessionTokens,
  quota,
  percent,
  tint,
  supportsContextBreakdown,
}: {
  contextUsage: ContextUsage | null;
  contextBreakdown: WireContextBreakdown | null;
  sessionTokens: SessionTokens | null;
  quota: CodexRateLimitsWire | null;
  percent: number;
  tint: string;
  /** codex-profiles cut §5.2: Codex has no per-category breakdown — the popover shows an honest message instead of a skeleton (see `ctxPopoverBodyState`'s "unsupported" branch). */
  supportsContextBreakdown: boolean;
}) {
  const sendToHost = useTabSend();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<number | null>(null);

  function clearHoverTimer(): void {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function close(): void {
    clearHoverTimer();
    setOpen(false);
  }

  // Cleanup a pending hover-intent timer on unmount (e.g. a tab switch mid-hover).
  useEffect(() => () => clearHoverTimer(), []);

  // Fixed-position anchor + on-open fetch (design §2.3): fires
  // `context_breakdown_request` exactly once per closed->open transition
  // (deps: `[open]` only — `sendToHost` is `useTabSend`'s stable per-tab
  // callback), never on every re-render while it stays open (the breakdown
  // is meter-static between turns; no throttle needed, design §2.3). Skips
  // the request entirely when the engine has no breakdown at all
  // (codex-profiles cut §5.2) — asking would only ever get dropped, and the
  // popover still needs its anchor to show the session-tokens/quota lines.
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    if (supportsContextBreakdown) {
      sendToHost({ type: "context_breakdown_request" });
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor(rect ? ctxPopoverAnchorFromRect(rect, window.innerWidth, window.innerHeight) : null);
  }, [open, sendToHost, supportsContextBreakdown]);

  // Re-clamp on viewport resize while open (P2-b fix): the anchor above is a
  // one-time snapshot from open-time — narrowing the window afterwards (e.g.
  // the popover opened near the right edge, then the user shrinks the
  // window) would otherwise leave the fixed-width popover's stale `left`
  // hanging off-screen. Re-clamps in place rather than closing, so the
  // popover stays usable.
  useEffect(() => {
    if (!open) {
      return;
    }
    function handleResize(): void {
      const rect = triggerRef.current?.getBoundingClientRect();
      setAnchor(rect ? ctxPopoverAnchorFromRect(rect, window.innerWidth, window.innerHeight) : null);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [open]);

  // Loading-timeout guard (P2-a fix): if `context_breakdown_request` is lost
  // (host/port died right at open), `contextBreakdown` stays null forever
  // and the skeleton would otherwise spin indefinitely with no feedback.
  // Resets the moment the breakdown arrives or the popover closes; the
  // cleanup below also covers unmount (mirrors `clearHoverTimer`'s
  // discipline). Never arms when breakdown isn't supported at all — the
  // "unsupported" bodyState wins immediately, so a timer here would only
  // ever fire uselessly.
  useEffect(() => {
    if (!open || !supportsContextBreakdown || contextBreakdown !== null) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), CTX_POPOVER_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [open, contextBreakdown, supportsContextBreakdown]);

  function handleMouseEnter(): void {
    if (open) {
      return;
    }
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setOpen(true);
    }, CTX_POPOVER_HOVER_DELAY_MS);
  }

  function handleClick(): void {
    if (open) {
      close();
    } else {
      clearHoverTimer();
      setOpen(true);
    }
  }

  function handleFocus(): void {
    clearHoverTimer();
    setOpen(true);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
      close();
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  }

  const roundedPercent = Math.round(percent);
  const headline = ctxPopoverHeadline(contextUsage, roundedPercent);
  const rows = ctxPopoverRows(contextBreakdown);
  const loading = ctxPopoverLoading(open, contextBreakdown);
  const bodyState = ctxPopoverBodyState(supportsContextBreakdown, loading, timedOut);
  const sessionLine = formatSessionTokensLine(sessionTokens);
  const cacheHitLine = formatLatestCacheHitLine(sessionTokens);
  const quotaView = buildQuotaPopoverView(quota, Date.now());
  const fillPercent = Math.min(100, Math.max(0, percent));

  return (
    <div
      className="ctx-popover-root"
      ref={rootRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={close}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-ctx-meter${tint}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Context window usage"
        onClick={handleClick}
        onFocus={handleFocus}
      >
        <CtxRing percent={percent} />
        {roundedPercent}% ctx
      </button>

      {open && (
        <div
          className={`ctx-popover${tint}`}
          role="dialog"
          aria-label="Context window breakdown"
          style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
        >
          <div className="ctx-popover-header">
            <span className="ctx-popover-title">Context window</span>
            {headline !== null && <span className="ctx-popover-headline">{headline}</span>}
          </div>
          <div className="ctx-popover-bar">
            <div className="ctx-popover-bar-fill" style={{ width: `${fillPercent}%` }} />
          </div>
          {bodyState === "skeleton" && (
            <div className="ctx-popover-skeleton" aria-label="Loading context breakdown">
              <div className="ctx-popover-skeleton-row" />
              <div className="ctx-popover-skeleton-row" />
              <div className="ctx-popover-skeleton-row" />
            </div>
          )}
          {bodyState === "empty" && (
            <div className="ctx-popover-empty">Breakdown unavailable</div>
          )}
          {bodyState === "unsupported" && (
            <div className="ctx-popover-empty">Breakdown is not available for this engine</div>
          )}
          {bodyState === "rows" && (
            <div className="ctx-popover-rows">
              {rows.map((row) => (
                <div className="ctx-popover-row" key={row.label}>
                  <span className="ctx-popover-row-label">{row.label}</span>
                  <span className="ctx-popover-row-percent">{row.percent.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}
          {(sessionLine !== null || quotaView !== null) && <div className="ctx-popover-divider" />}
          {sessionLine !== null && (
            <>
              <div className="ctx-popover-session">Session tokens: {sessionLine}</div>
              {cacheHitLine !== null && <div className="ctx-popover-session">{cacheHitLine}</div>}
            </>
          )}
          {quotaView !== null && (
            <>
              {quotaView.primaryLine !== null && <div className="ctx-popover-session">{quotaView.primaryLine}</div>}
              {quotaView.secondaryLine !== null && <div className="ctx-popover-session">{quotaView.secondaryLine}</div>}
              {quotaView.creditsLine !== null && <div className="ctx-popover-session">{quotaView.creditsLine}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Composer() {
  const [text, setText] = useState("");
  const [pasteBlocks, setPasteBlocks] = useState<readonly PasteBlock[]>([]);
  const [attachedImages, setAttachedImages] = useState<readonly DraftImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // Monotonic per mount — never reset (ids stay unambiguous across sends).
  const nextPasteIdRef = useRef(1);
  const nextImageIdRef = useRef(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Caret position to restore after a collapse re-render (§2.3).
  const pendingCaretRef = useRef<number | null>(null);

  // Slash-command menu state (design slice-P7.23-cut.md §4.4): local to
  // Composer, never the store. `caret` mirrors the textarea's own selection
  // (updated on change/keyup/click — `slashQueryAt` is caret-relative and a
  // React `value`-controlled textarea doesn't otherwise expose live caret
  // position). `dismissed`/`selIndex` are the only pieces of menu state that
  // survive across renders; openness itself is a pure derivation from
  // `text`+`caret`+`dismissed` computed fresh on every render below — never a
  // separate boolean that could go stale (cut §4.3's "never from stale
  // state" rule, and the risk-1 Enter-swallow mitigation).
  const [caret, setCaret] = useState(0);
  const [slashSelIndex, setSlashSelIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const lastSlashQueryRef = useRef<string | null>(null);
  const lastSlashItemsKeyRef = useRef("");
  const slashTabId = useContext(TabContext)?.tabId;

  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null) {
      textareaRef.current?.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  }, [text]);

  // R11 starter-chip insert (slice-R11-cut §3.3): INSERT only — handleSend
  // is untouched and never fires from here; the user still presses send.
  // Empty deps: the handler touches only stable setters/refs. The ref write
  // inside the updater is idempotent (StrictMode double-invoke safe).
  useEffect(() => {
    function onInsert(event: Event): void {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail !== "string" || detail.length === 0) {
        return;
      }
      setText((prev) => {
        const next = insertDraftText(prev, detail);
        pendingCaretRef.current = next.caret;
        return next.text;
      });
      // Best-effort: silently no-ops on a disabled textarea (running / not
      // ready) — the draft still updates, matching the disabled-value rules.
      textareaRef.current?.focus();
    }
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, []);

  const tabStore = useTabStoreApi();
  const sendToHost = useTabSend();
  const turn = useTabStore((state) => state.turn);
  const queueInFlight = useTabStore((state) => state.queueInFlight);
  const mode = useTabStore((state) => state.mode);
  const model = useTabStore((state) => state.model);
  const imageInput = useTabStore((state) => state.imageInput);
  const connection = useTabStore((state) => state.connection);
  const contextUsage = useTabStore((state) => state.contextUsage);
  const contextBreakdown = useTabStore((state) => state.contextBreakdown);
  const sessionTokens = useTabStore((state) => state.sessionTokens);
  const quota = useTabStore((state) => state.quota);
  const engine = useTabStore((state) => state.engine);
  const pendingEngineChange = useTabStore((state) => state.pendingEngineChange);
  const shell = useTabStore((state) => state.shell);
  const isNewSession = useTabStore((state) => state.transcript.length === 0);

  // Core keeps its exact legacy presentation when `engine` is null. External
  // engines declare only the controls their adapter can honour.
  const supportsCorePermissions = engine?.capabilities.supportsCorePermissions ?? true;
  const supportsModelSelection = engine?.capabilities.supportsModelSelection ?? true;
  const supportsImages = engine?.capabilities.supportsImages ?? true;
  // TASK.56 W3: MODEL-level gate, layered on top of the engine-level one
  // above — `supportsImages` hides the attach UI entirely for an engine that
  // never does images; `imageInput` disables it (with an explanation) for a
  // model on an engine that DOES, when this particular model doesn't.
  const modelBlocksAttach = isImageAttachBlockedByModel(imageInput);
  const attachmentsBlockedByModel = isSendBlockedByModelImages(imageInput, attachedImages.length);
  const supportsContextUsage = engine?.capabilities.supportsContextUsage ?? true;
  const supportsContextBreakdown = engine?.capabilities.supportsContextBreakdown ?? true;
  // Shell (AnyCode chrome) capabilities (design TASK.40 §2(f)): independent
  // of the engine above — null (core, or an engine that omitted it) defaults
  // to every shell feature enabled, mirroring the engine fallbacks.
  const shellGitReadOnly = shell?.gitReadOnly ?? true;
  const shellTerminal = shell?.terminal ?? true;
  // AnyCode's own `$skill` convention is consumed by the AgentLoop's system
  // prompt / skill port (core-loop-only) — Codex has no native skills wiring
  // (design TASK.40 §2(f)/residual: Codex-native skills via app-server are
  // NOT built, so the AnyCode skill list is honestly hidden rather than
  // shown as a dead insert-and-hope-it-does-something row).
  const skillsSupported = engine === null;

  const running = turn.status === "running";
  const ready = connection === "ready";
  // Running no longer blocks send (F15 prompt queue): a send while running
  // enqueues instead of dispatching directly (handleSend below).
  const canSend = ready && hasSendableDraft(text, attachedImages.length) && !attachmentsBlockedByModel;

  // Slash-menu derivation (cut §4.3): recomputed every render from the
  // CURRENT text+caret, never carried as a separate `open` boolean.
  // `slashSkills` is the open-transition-fetched cache below (W3) — it starts
  // `[]` and is total over that, so the menu opens on commands alone even
  // before the fetch resolves.
  // Reuse, not re-derive (codex R1 P2 fix): the SAME predicate that disables
  // the ModelPill chip itself, so the slash menu's "Model" row is enabled iff
  // picking a model would actually do something.
  const slashCtx: SlashMenuCtx = {
    mode: mode ?? "plan",
    model: model ?? "",
    running,
    ready,
    modelDisabled: modelPickDisabled(turn.status, queueInFlight, ready),
    supportsCorePermissions,
    supportsModelSelection,
    shellGitReadOnly,
    shellTerminal,
  };
  const slashQuery = slashQueryAt(text, caret);
  const slashItems =
    slashQuery !== null
      ? filterSlashItems(SLASH_COMMANDS, skillsSupported ? slashSkills : [], slashQuery.query, slashCtx)
      : [];
  const slashOpen = slashQuery !== null && !slashDismissed && slashItems.length > 0;

  // Skills fetch (cut §3, gated by skillsSupported per TASK.40 §2(f)): once
  // per closed→open transition, cached in state for the open's lifetime
  // (deps `[slashOpen, slashTabId, skillsSupported]` — the effect only
  // re-runs when openness or engine identity flips, not on every filter
  // keystroke), same "effect keyed on the boolean, not a ref-guard" idiom as
  // CtxPopover's on-open `context_breakdown_request` fetch above. Never
  // blocks the menu: a rejected/slow promise just leaves the skills section
  // absent until (or unless) it resolves; commands render immediately
  // regardless.
  useEffect(() => {
    if (!slashOpen || !skillsSupported) {
      setSlashSkills((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void window.anycode.skills
      .list({ tabId: slashTabId })
      .then((snapshot) => {
        if (!cancelled) {
          setSlashSkills(skillsToSlashSkills(snapshot.rows));
        }
      })
      .catch(() => {
        // Skills IO must never block or error the menu (cut §3) — the
        // commands section already rendered; the Skills section just stays
        // absent.
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, slashTabId, skillsSupported]);

  // Render-time state adjustment (React-sanctioned "reset state when a
  // derived value changes" pattern — avoids the one-frame flicker a
  // useEffect-based reset would cause): `dismissed` clears the instant the
  // query text changes or the trigger deactivates (cut §4.3), and the
  // roving selection resets to 0 the instant the filtered item identity
  // changes, both BEFORE this render commits rather than one render later.
  const slashQueryText = slashQuery?.query ?? null;
  if (slashQueryText !== lastSlashQueryRef.current) {
    lastSlashQueryRef.current = slashQueryText;
    if (slashDismissed) {
      setSlashDismissed(false);
    }
  }
  const slashItemsKey = slashItems.map((item) => item.id).join(" ");
  if (slashItemsKey !== lastSlashItemsKeyRef.current) {
    lastSlashItemsKeyRef.current = slashItemsKey;
    if (slashSelIndex !== 0) {
      setSlashSelIndex(0);
    }
  }

  function syncCaret(el: HTMLTextAreaElement): void {
    setCaret(el.selectionStart ?? el.value.length);
  }

  /**
   * Single exhaustive dispatch point for a selected row's intent (cut §4.1:
   * "the registry itself stays pure/testable; Composer owns the single
   * exhaustive dispatchSlashIntent switch"). `insert` is a no-op here — its
   * text replacement already happened uniformly for every intent kind in
   * `selectSlashItem` below (the token-removal and the skill-text-insert are
   * the SAME operation: replace the slash token with `intent.text` or `""`).
   */
  function dispatchSlashIntent(intent: SlashRunIntent): void {
    switch (intent.kind) {
      case "set_mode_toggle":
        handleModeChange((mode ?? "plan") === "plan" ? "build" : "plan");
        break;
      case "window_event":
        window.dispatchEvent(new Event(intent.event));
        break;
      case "run_action":
        window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: intent.action }));
        break;
      case "store_git_panel":
        tabStore.getState().gitSetPanelOpen(true);
        break;
      case "settings_pane":
        window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
        window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: intent.pane }));
        break;
      case "insert":
        break;
      default:
        assertNever(intent);
    }
  }

  /**
   * Row-selection effect (cut §4.3): removes the slash token from the draft
   * — replaced with `""` for a run-command (cut §2's "remove the slash token
   * ... whole-draft token ⇒ \"\"") or with the intent's own text for an
   * insert (skill row, W3). The token's full extent is recomputed via
   * `slashTokenEnd` rather than trusting `caret` alone, since `slashQueryAt`
   * allows a mid-token caret. Focus stays on the textarea only for an insert
   * (cut §4.3 "keep textarea focus") — a run-command may hand focus
   * elsewhere on purpose (Mode/Model summon a popover; Settings opens a
   * dialog), matching each intent's own existing focus behavior.
   */
  function selectSlashItem(index: number): void {
    const item = slashItems[index];
    if (!item || item.disabled || slashQuery === null) {
      return;
    }
    const tokenEnd = slashTokenEnd(text, slashQuery.start);
    const intent = item.intent;
    const isInsert = intent.kind === "insert";
    const replacement = intent.kind === "insert" ? intent.text : "";
    const nextText = text.slice(0, slashQuery.start) + replacement + text.slice(tokenEnd);
    setText(nextText);
    setCaret(slashQuery.start + replacement.length);
    pendingCaretRef.current = slashQuery.start + replacement.length;
    if (isInsert) {
      textareaRef.current?.focus();
    }
    dispatchSlashIntent(item.intent);
  }

  async function readDraftImage(file: File): Promise<{ ok: true; image: DraftImage } | { ok: false; reason: string }> {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    const mediaType = sniffComposerImageMediaType(bytes);
    if (mediaType === null) {
      return { ok: false, reason: `${file.name || "image"} is not a supported image.` };
    }
    if (bytes.length > COMPOSER_IMAGE_MAX_BYTES) {
      try {
        bytes = await resizeComposerImage(file, mediaType);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      // Encoder output is untrusted input too: fail closed if Chromium ever
      // produced a different format than requested.
      if (sniffComposerImageMediaType(bytes) !== mediaType || bytes.length > COMPOSER_IMAGE_MAX_BYTES) {
        return { ok: false, reason: `${file.name || "image"} could not be resized safely.` };
      }
    }
    const sourcePath = file.name.length > 0 ? file.name : undefined;
    return {
      ok: true,
      image: {
        id: nextImageIdRef.current++,
        name: file.name || mediaType.replace("image/", ""),
        sizeBytes: bytes.length,
        attachment: {
          mediaType,
          data: bytesToBase64(bytes),
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        },
      },
    };
  }

  async function addImageFiles(files: readonly File[]): Promise<void> {
    const imageFiles = files.filter((file) => file.type.startsWith("image/") || file.name.match(/\.(png|jpe?g|gif|webp)$/i));
    if (imageFiles.length === 0 || !ready || !supportsImages) {
      return;
    }
    // TASK.56 W3(b): a paste/drop while the CURRENT model rejects images is a
    // visible notice, never a silent no-op — the engine-level early-return
    // above stays silent (unsupported by this engine at all is unchanged,
    // pre-existing behavior); this one is new and model-specific.
    if (modelBlocksAttach) {
      tabStore.getState().setNotice({ kind: "image_attach_rejected", text: MODEL_IMAGE_ATTACH_BLOCKED_TEXT });
      return;
    }
    const slots = COMPOSER_IMAGE_MAX_PER_MESSAGE - attachedImages.length;
    if (slots <= 0) {
      setImageError(`Only ${COMPOSER_IMAGE_MAX_PER_MESSAGE} images can be attached.`);
      tabStore.getState().setNotice({
        kind: "image_attach_rejected",
        text: `Only ${COMPOSER_IMAGE_MAX_PER_MESSAGE} images can be attached.`,
      });
      return;
    }
    const accepted: DraftImage[] = [];
    let firstError: string | null = imageFiles.length > slots ? `Only ${COMPOSER_IMAGE_MAX_PER_MESSAGE} images can be attached.` : null;
    for (const file of imageFiles.slice(0, slots)) {
      try {
        const result = await readDraftImage(file);
        if (result.ok) {
          accepted.push(result.image);
        } else {
          firstError ??= result.reason;
        }
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (accepted.length > 0) {
      setAttachedImages((current) => [...current, ...accepted]);
      setImageError(null);
    }
    if (firstError !== null) {
      setImageError(firstError);
      tabStore.getState().setNotice({ kind: "image_attach_rejected", text: firstError });
    }
  }

  function handleSend(): void {
    if (!canSend) {
      return;
    }
    const outgoing = reconstitutePasteMarkers(text, pasteBlocks);
    const images = attachedImages.map((image) => ({
      name: image.name,
      sizeBytes: image.sizeBytes,
      attachment: image.attachment,
    }));
    if (shouldEnqueue(turn.status, queueInFlight)) {
      // NOT truly idle: either a turn is running, or a queued item was already
      // drained and is still in flight (turn momentarily "idle" but its
      // turn_started not yet acknowledged). Hold the message in the per-tab
      // queue (design slice-P7.14-cut.md §4) instead of dispatching — the
      // tab-registry drainer sends it once the tab is truly idle and unpaused.
      // Direct-sending in the in-flight window would let the host busy-reject
      // it (a drained item was already accepted) and lose the prompt.
      tabStore.getState().enqueuePrompt({ text: outgoing, images });
    } else {
      const requestId = crypto.randomUUID();
      // The wire protocol never echoes the user's own message back (§3 — only
      // turn_started{requestId,turnId} correlates it), so the composer is the
      // one place that appends the user_text transcript block. Goes through

      // owns all transcript writes, and appendBlock flushes pending deltas
      // first so ordering stays consistent.
      tabStore.getState().appendUserText(requestId, transcriptTextWithImages(outgoing, images.length));
      // TASK.33 W8: snapshot what actually went on the wire so a later
      // terminal retryable failure can offer to replay this same content.
      tabStore.getState().recordSentMessage(outgoing, images);
      sendToHost({
        type: "user_message",
        requestId,
        text: outgoing,
        ...(images.length > 0 ? { images: images.map((image) => image.attachment) } : {}),
      });
    }
    setText("");
    setPasteBlocks([]);
    setAttachedImages([]);
    setImageError(null);
  }

  function handleStop(): void {
    sendToHost({ type: "cancel_turn" });
  }

  function handleModeChange(next: PermissionMode): void {
    if (running || !ready || next === mode) {
      return;
    }
    sendToHost({ type: "set_mode", mode: next });
  }

  // TASK.39 (cut §3.3): the engine picks reuse the SAME between-turns
  // guard as ModelPill/ModeMenu (engineControlDisabled mirrors
  // modelPickDisabled) — the host's own busy-check is the real backstop,
  // this only keeps the UI from offering a pick it knows would be dropped.
  function handleEngineModelPick(id: string): void {
    if (engineControlDisabled(turn.status, queueInFlight, ready)) {
      return;
    }
    sendToHost({ type: "set_model", model: id });
  }

  function handleEnginePresetPick(presetId: string): void {
    if (engineControlDisabled(turn.status, queueInFlight, ready)) {
      return;
    }
    sendToHost({ type: "set_engine_preset", presetId });
  }

  function handleEngineEffortPick(effort: string): void {
    if (!engineControlDisabled(turn.status, queueInFlight, ready)) sendToHost({ type: "set_engine_effort", effort });
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const pastedFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (pastedFiles.length > 0) {
      event.preventDefault();
      void addImageFiles(pastedFiles);
      return;
    }
    // Normalize line endings to LF up front, matching what a <textarea> itself
    // produces on a native paste/keystroke (HTML spec: `.value` is always LF).
    // Storing the raw clipboard string instead would let a CRLF clipboard
    // (Windows-sourced content, even copied on macOS) reconstitute with \r\n
    // while the ≤40-line native-paste path yields \n — breaking R7's byte-
    // identity invariant; a lone-\r clipboard would also miscount lines.
    const pasted = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!shouldCollapsePaste(pasted)) {
      return; // ≤ 40 lines (incl. empty/non-text clipboard) — native paste proceeds untouched.
    }
    event.preventDefault();
    const id = nextPasteIdRef.current++;
    const marker = makePasteMarker(id);
    const { selectionStart, selectionEnd } = event.currentTarget;
    setText(text.slice(0, selectionStart) + marker + text.slice(selectionEnd));
    setPasteBlocks((blocks) => [...blocks, { id, text: pasted, lineCount: countPasteLines(pasted) }]);
    pendingCaretRef.current = selectionStart + marker.length;
  }

  function expandPasteBlock(id: number): void {
    const block = pasteBlocks.find((b) => b.id === id);
    if (!block) {
      return;
    }
    // Reuses the tested send-path replacer for a single block: every occurrence
    // of this marker inlines the full text; the entry is then dropped for real
    // (the content now lives in the draft).
    setText(reconstitutePasteMarkers(text, [block]));
    setPasteBlocks((blocks) => blocks.filter((b) => b.id !== id));
    // The pill button unmounts once its marker is inlined; without this the
    // keyboard user who activated it drops to <body>. Return focus to the
    // textarea, where the now-inlined content is ready to edit.
    textareaRef.current?.focus();
  }

  function removeImage(id: number): void {
    setAttachedImages((images) => images.filter((image) => image.id !== id));
    setImageError(null);
    textareaRef.current?.focus();
  }

  function openImagePicker(): void {
    fileInputRef.current?.click();
  }

  function hasImageFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (ready && supportsImages && hasImageFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!ready || !supportsImages || !hasImageFiles(event)) {
      return;
    }
    event.preventDefault();
    void addImageFiles(Array.from(event.dataTransfer.files));
  }

  const ctxPercent = contextMeterPercent(contextUsage);
  const ctxTint =
    ctxPercent === null
      ? ""
      : ctxPercent >= 95
        ? " composer-ctx-meter-danger"
        : ctxPercent >= 80
          ? " composer-ctx-meter-warning"
          : "";

  const pills = visiblePasteBlocks(text, pasteBlocks);
  const platform = window.anycode?.platform ?? "darwin";
  const hasDraft = text.length > 0 || attachedImages.length > 0;
  // Idle: the send-keybinding hint teaches the shortcut before first use, then
  // hides once there's a draft. Running: inverted — nothing to explain on an
  // empty draft, but a typed draft now queues on Enter instead of sending, so
  // the "queue" hint surfaces exactly then.
  const hintText = running
    ? "⏎ queue · Esc stop"
    : platform === "darwin"
      ? "⏎ send · ⇧⏎ newline"
      : "Enter send · Shift+Enter newline";
  const hintHidden = !ready || (running ? !hasDraft : hasDraft);
  const sendDisabledReason = !ready
    ? "Waiting for the session to connect"
    : attachmentsBlockedByModel
      ? MODEL_IMAGE_SEND_BLOCKED_TEXT
      : text.trim().length === 0 && attachedImages.length === 0
        ? "Type a message to send"
        : undefined;

  return (
    <div
      className={`composer${running ? " composer-running" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <PromptQueue />
      {isNewSession && <EnvironmentMenu placement="composer" />}
      {(pills.length > 0 || attachedImages.length > 0) && (
        <div className="composer-pills">
          {pills.map((block) => (
            <button
              key={block.id}
              type="button"
              className="composer-pill"
              title="Expand into the message"
              aria-label={`Expand pasted text #${block.id} (${block.lineCount} lines) into the message`}
              onClick={() => expandPasteBlock(block.id)}
            >
              Pasted #{block.id} · {block.lineCount} lines
            </button>
          ))}
          {attachedImages.map((image) => (
            <span
              key={image.id}
              className={`composer-image-pill${attachmentsBlockedByModel ? " composer-image-pill-warning" : ""}`}
              title={attachmentsBlockedByModel ? MODEL_IMAGE_SEND_BLOCKED_TEXT : image.name}
            >
              <span className="composer-image-pill-name">{image.name}</span>
              <span className="composer-image-pill-size">{formatImageSize(image.sizeBytes)}</span>
              <button
                type="button"
                className="composer-image-pill-remove"
                aria-label={`Remove ${image.name}`}
                title="Remove image"
                onClick={() => removeImage(image.id)}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      {imageError !== null && <div className="composer-image-error">{imageError}</div>}
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        aria-label="Message the agent"
        aria-describedby="composer-hint"
        aria-haspopup={slashOpen ? "listbox" : undefined}
        aria-controls={slashOpen ? "slash-menu-list" : undefined}
        aria-activedescendant={slashOpen ? `slash-menu-option-${slashSelIndex}` : undefined}
        aria-autocomplete={slashOpen ? "list" : undefined}
        value={text}
        disabled={!ready}
        placeholder={running ? "Queue a message… (Esc to stop)" : "Message the agent…"}
        onChange={(event) => {
          setText(event.target.value);
          syncCaret(event.currentTarget);
        }}
        onKeyUp={(event) => syncCaret(event.currentTarget)}
        onClick={(event) => syncCaret(event.currentTarget)}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          // IME composition: pass everything through untouched (cut §4.3) —
          // neither the menu nor the send binding may react to a composing
          // keystroke's Enter/arrows. React's KeyboardEvent type doesn't
          // surface `isComposing` itself (App.tsx's global keydown handler
          // reads the same flag off a raw native KeyboardEvent instead).
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (slashOpen) {
            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                setSlashSelIndex((i) => slashMenuReduce({ selectedIndex: i, dismissed: slashDismissed }, { kind: "down" }, slashItems.length).selectedIndex);
                return;
              case "ArrowUp":
                event.preventDefault();
                setSlashSelIndex((i) => slashMenuReduce({ selectedIndex: i, dismissed: slashDismissed }, { kind: "up" }, slashItems.length).selectedIndex);
                return;
              case "Enter":
              case "Tab":
                event.preventDefault();
                selectSlashItem(slashSelIndex);
                return;
              case "Escape":
                // stopPropagation so the App-level turn.interrupt Esc binding
                // never fires from a menu-dismissal keystroke (cut risk 2).
                event.preventDefault();
                event.stopPropagation();
                setSlashDismissed(true);
                return;
              default:
                break;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
      />
      {slashOpen && (
        <SlashMenu items={slashItems} selectedIndex={slashSelIndex} onSelect={selectSlashItem} onHover={setSlashSelIndex} />
      )}
      <div className="composer-footer">
        <div className="composer-footer-left">
          {/* `mode` is null only before host_ready — which is exactly when the
              connection isn't `ready`, so the chip is disabled in that window;
              the neutral "plan" fallback is a cosmetic default for the greyed,
              non-interactive chip and never reflects an actionable state.
              Design TASK.40 §2(f)/item 5: the engine badge lives ONLY in
              SessionHeader now — no duplicate here. TASK.39 (cut §2(d)):
              Codex's own permission-preset menu is a SEPARATE,
              presentation-driven control — core's ModeMenu/permission
              vocabulary is never used for it (`supportsCorePermissions`
              stays false for Codex, so the two are mutually exclusive). */}
          {supportsCorePermissions && <ModeMenu mode={mode ?? "plan"} disabled={running || !ready} onChange={handleModeChange} />}
          {engine?.permissions && (
            <EnginePresetMenu
              permissions={engine.permissions}
              pendingPresetId={pendingEngineChange?.activePresetId}
              disabled={engineControlDisabled(turn.status, queueInFlight, ready)}
              onPick={handleEnginePresetPick}
            />
          )}
          {supportsImages && (
            <>
              <input
                ref={fileInputRef}
                className="composer-file-input"
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  void addImageFiles(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                className="composer-attach"
                aria-label="Attach image"
                title={modelBlocksAttach ? MODEL_IMAGE_ATTACH_BLOCKED_TEXT : "Attach image"}
                disabled={!ready || modelBlocksAttach}
                onClick={openImagePicker}
              >
                <ImageIcon />
              </button>
            </>
          )}
          {/* TASK.39 item 4: Codex's model catalog comes from the engine
              projection (doctor/app-server), never AnyCode's provider
              catalog — ModelPill (settings-store-backed) is core-only. */}
          {supportsModelSelection &&
            (engine?.model ? (
              <EngineModelMenu model={engine.model} pendingModel={pendingEngineChange?.model} disabled={engineControlDisabled(turn.status, queueInFlight, ready)} onPick={handleEngineModelPick} {...(engine.model.effort !== undefined ? { effort: { current: engine.model.effort, pending: pendingEngineChange?.effort, onPick: handleEngineEffortPick } } : {})} />
            ) : (
              <ModelPill />
            ))}
        </div>
        {/* Always rendered; hides via visibility (not unmount) so the footer never reflows.
            id wires the textarea's aria-describedby (R17 a11y) so SR users get the
            send/newline hint; always in the DOM even while visually hidden. */}
        <span id="composer-hint" className={`composer-hint${hintHidden ? " composer-hint-hidden" : ""}`}>{hintText}</span>
        <div className="composer-footer-right">
          {supportsContextUsage && ctxPercent !== null && (
            <CtxPopover
              contextUsage={contextUsage}
              contextBreakdown={contextBreakdown}
              sessionTokens={sessionTokens}
              quota={quota}
              percent={ctxPercent}
              tint={ctxTint}
              supportsContextBreakdown={supportsContextBreakdown}
            />
          )}
          {running ? (
            <>
              {hasSendableDraft(text, attachedImages.length) && (
                <button
                  type="button"
                  className="composer-send"
                  aria-label="Queue message"
                  title={attachmentsBlockedByModel ? MODEL_IMAGE_SEND_BLOCKED_TEXT : "Queue message"}
                  disabled={attachmentsBlockedByModel}
                  onClick={handleSend}
                >
                  <ArrowUp />
                </button>
              )}
              <button
                type="button"
                className="composer-stop"
                aria-label="Stop"
                title="Stop (Esc)"
                onClick={handleStop}
              >
                <Stop />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label="Send"
              title={sendDisabledReason}
              disabled={!canSend}
              onClick={handleSend}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

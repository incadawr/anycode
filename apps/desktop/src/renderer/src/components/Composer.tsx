import { modelSettingsTarget } from "../model-settings-target.js";
import { describeCodexAccountLine } from "../codex-account-line.js";
import type { CodexTabAccountResult } from "../../../shared/codex-account.js";
import { resolveProfileRoles, rolesPatch } from "../../../shared/role-profiles.js";
/**
 * Message input + turn controls (design §5, restructured in UI-5). Sends
 * `user_message` / `cancel_turn` / `set_mode` through the active tab's
 * connection (Phase-2 §4.3: `useTabSend`, the migrated equivalent of the old
 * singleton `sendToHost`). While a turn is running the composer STAYS
 * enabled: a send enqueues into the per-tab prompt queue (F15,
 * `shouldEnqueue`/`handleSend` below) instead of dispatching directly; only
 * the connection gate (`ready`) disables the textarea;
 * the mode switcher is blocked only while the connection isn't `ready`
 * (TASK.37: set_mode is valid mid-turn and applies to the next permission
 * decision).
 *
 * UI-5 layout: an elevated card holding a borderless auto-growing textarea, a
 * footer with the escalation-graded ModeMenu chip on the left and a context
 * meter + circular send/stop button on the right. The send / cancel / set_mode
 * wire traffic and the Enter-to-send behavior are unchanged from the pre-redesign
 * composer.
 */
import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CodexRateLimitsWire, ImageAttachment, ImageMediaType, PermissionMode } from "@anycode/core";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { isSessionBusy, type ContextUsage, type DesktopState, type SessionTokens, type TurnState } from "../store.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import type { ProviderConnection } from "../../../shared/settings.js";
import type { WireContextBreakdown, WireUsageAuditStep, WireUsageAuditTotals } from "../../../shared/protocol.js";
import {
  makePasteMarker,
  reconstitutePasteMarkers,
  shouldCollapsePaste,
  countPasteLines,
  visiblePasteBlocks,
  type PasteBlock,
} from "../paste.js";
import { ModeMenu, modeChangeDisabled } from "./ModeMenu.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { useComposerClearance } from "../composer-clearance.js";
const ContextWindowSettings = lazy(() => import("./ContextWindowSettings.js"));
import { ModelPill, modelPickDisabled } from "./ModelPill.js";
import { EngineModelMenu, EnginePresetMenu, engineControlDisabled, engineEffortDisabled, nativeEffortControl } from "./EngineControls.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";
import { BackgroundAgents } from "./BackgroundAgents.js";
import { PromptQueue } from "./PromptQueue.js";
import { SlashMenu } from "./SlashMenu.js";
import { RolePickerDialog } from "./RolePickerDialog.js";
import { needsRolePicker, orchestrateToggleNeedsRolePicker } from "../orchestrate-start.js";
import { ArrowUp, ImageIcon, Stop, X } from "./icons.js";
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
  resolveBareSlashSubmit,
  skillsToSlashSkills,
  slashMenuReduce,
  slashQueryAt,
  unknownSlashCommandNotice,
  type SlashMenuCtx,
  type SlashRunIntent,
  type SlashSkill,
} from "../slash-menu.js";
import { slashPathRootNames } from "../slash-path-roots.js";

/**
 * Enqueue-vs-direct-send decision for `handleSend` (F15 prompt queue). A send
 * takes the DIRECT path ONLY when the tab is TRULY idle — the turn is idle AND
 * no drained item is still in flight (`queueInFlight === null`). During the
 * "inFlight window" (a queued item was dispatched but its `turn_started` has
 * not arrived, so `turn.status` is still "idle") the tab is NOT safe to
 * direct-send into: the host would busy-reject it and the prompt would be lost.
 * Enqueue in that window instead.
 *
 * TASK.102 CUT-S2 §10.15.1: a child surface ALWAYS takes the direct path
 * (returns false), regardless of turn/in-flight state — its renderer prompt
 * queue has no drainer subscribed (§1.1: the renderer prompt-queue is never
 * used for a child surface), so anything parked there would sit forever. The
 * direct path is safe for a child: `host/session.ts`'s steer queue already
 * accepts a `user_message` sent while the child is busy. Exported for unit
 * testing.
 */
export function shouldEnqueue(
  turnStatus: TurnState["status"],
  queueInFlight: DesktopState["queueInFlight"],
  isChildSurface = false,
): boolean {
  if (isChildSurface) {
    return false;
  }
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
 * this, this is model-level and rides ON TOP of it.
 *
 * TASK.198 срез D: a configured recognizer fallback (`imageFallback === true`,
 * off the same hello/model_changed wire) unblocks a blind model — the host
 * now honestly accepts attachments for it (session.ts's `imagesAccepted()`),
 * so the composer's own gate must stop lying about it. Any value other than
 * `true` (including `undefined` — no fallback configured, or a legacy host
 * that never sends the field) leaves the block in place. Exported for unit
 * testing.
 */
export function isImageAttachBlockedByModel(imageInput: boolean | undefined, imageFallback: boolean | undefined): boolean {
  return imageInput === false && imageFallback !== true;
}

/**
 * Attachments already on the draft become send-blocking, not vanishing, the
 * moment the model swings vision -> non-vision mid-session (cut §3/W3(c)):
 * the user must switch back or remove them, never lose them silently.
 *
 * TASK.198 срез D: same recognizer-fallback carve-out as
 * `isImageAttachBlockedByModel` — a configured fallback unblocks send too.
 * Exported for unit testing.
 */
export function isSendBlockedByModelImages(
  imageInput: boolean | undefined,
  imageFallback: boolean | undefined,
  imageCount: number,
): boolean {
  return imageInput === false && imageFallback !== true && imageCount > 0;
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

/** Exported for the start-screen composer (StartScreen.tsx, TASK.81 parity) — the same accept-list, no second copy of the format list. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

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

/** Exported for the start-screen composer (StartScreen.tsx, TASK.81 parity) — the same pill size formatting, no second copy. */
export function formatImageSize(bytes: number): string {
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

/** One decoded, sendable image attachment — `DraftImage` minus the renderer-local `id` (a React list key, not a wire concept). */
export interface ComposerImageRead {
  name: string;
  sizeBytes: number;
  attachment: ImageAttachment;
}

/**
 * Decodes + validates one dropped/picked/pasted File into a sendable image
 * attachment: sniffs the real format (never trusts the browser-reported
 * MIME), downsizes an oversized file once, and re-validates the resize
 * output before accepting it. Exported so the start-screen composer
 * (StartScreen.tsx, TASK.81 parity) shares this EXACT validation path — no
 * second image decoder for the same job.
 */
export async function readComposerImageFile(
  file: File,
): Promise<{ ok: true; image: ComposerImageRead } | { ok: false; reason: string }> {
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

/** Taskana 4127: shown when the active model's context window is the assumed 8K fallback. */
export const CTX_WINDOW_ASSUMED_HINT = "Context window unknown \u2014 assumed 8K total.";

/** Uses the meter's actual denominator, including any overridden output reserve. */
export function ctxWindowAssumedHint(usage: ContextUsage | null): string {
  return `${CTX_WINDOW_ASSUMED_HINT}${usage === null ? "" : ` Available input budget after the output reserve: ${formatCtxTokenCount(usage.budgetTokens)}.`} Set it in the connection settings.`;
}

/** Ctx meter label: a leading \u2248 marks the percent as relative to an assumed window. Exported for unit testing. */
export function ctxMeterLabel(roundedPercent: number, assumed: boolean): string {
  return `${assumed ? "\u2248" : ""}${roundedPercent}% ctx`;
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

function formatUsageMoney(value: number): string {
  return `$${value > 0 && value < 0.0001 ? value.toPrecision(2) : value.toFixed(4)}`;
}

/**
 * A step's cost as it reads INSIDE a sentence ("step 1 · cost by subscription"),
 * so it is sentence case everywhere in the popover — the same words are
 * capitalised only where they start a label (the connection drawer's pricing
 * option), never mid-sentence.
 */
function formatStepCost(step: WireUsageAuditStep | null): string {
  if (step?.priceBasisId === "subscription") return "by subscription";
  return step?.costUsd === undefined ? "price unknown" : `≈ ${formatUsageMoney(step.costUsd)}`;
}

/** A visible ledger must follow completion of a turn or manual compaction. */
export function shouldRefreshUsageAudit(open: boolean, previous: TurnState["status"], current: TurnState["status"]): boolean {
  return open && previous !== "idle" && current === "idle";
}

/**
 * The popover's whole usage/cost block. Each fact gets its own line (the
 * popover is a fixed 280 px column, and a clipped spend line hides the very
 * numbers it reports):
 *
 *   total           "Spent in this session: ≈ $0.0271" — the headline number
 *   qualifier       "some steps price unknown · plus subscription" (muted)
 *   subagentSuffix  "incl. subagents ≈ $0.0041"                    (muted)
 *   footnote        "Tokens in 142.8K · out 536 · cache saved ≈ $0.038 · estimates at peak rates"
 *
 * The total is the SESSION's, subagents INCLUDED (own priced steps + the
 * children's own sub-total) — that was the number the owner could not find.
 * The turn line lives between the qualifiers and the footnote and is built
 * separately (`formatTurnStepSummary`), so a "this turn" figure can never be
 * mistaken for the session's.
 *
 * Honesty rules are unchanged from the per-line era: any unpriced step makes
 * the figure a lower bound ("≥ …" plus the "some steps price unknown"
 * qualifier); a session whose steps are all subscription reads "by
 * subscription" and a mixed one adds "plus subscription"; with nothing priced
 * at all it reads "price unknown"; and native Claude children, whose costs may
 * already be inside the reported total, keep their "may already be included"
 * caveat right next to the number.
 *
 * Copy is sentence case inside a sentence: "by subscription" / "price unknown"
 * mid-line, never "By subscription" / "Price unknown".
 *
 * Cost is a historical snapshot, never recalculated from current settings.
 * `tokens` is the LIVE session counter (preferred, because the audit totals are
 * the restored-after-restart fallback) and only feeds the footnote.
 */
export interface UsageCostLedger {
  /** The single prominent total line, including subagents. */
  total: string;
  /** Muted qualifier of the total, on its own line; null when the total stands alone. */
  qualifier: string | null;
  /** Muted suffix naming the subagent share; null when the session has none. */
  subagentSuffix: string | null;
  /** Quiet tokens/savings/provider footnote; null when nothing was reported. */
  footnote: string | null;
}

export function formatUsageCostLedger(
  totals: WireUsageAuditTotals | null,
  tokens: SessionTokens | null,
): UsageCostLedger {
  const money = formatUsageMoney;
  const ownPriced = totals?.costUsd !== undefined;
  const subPriced = totals?.subagentCostUsd !== undefined;
  const pricedTotal = (ownPriced ? (totals?.costUsd ?? 0) : 0) + (subPriced ? (totals?.subagentCostUsd ?? 0) : 0);
  // A bound is a bound across BOTH halves: one unpriced child step makes the
  // session figure a lower bound exactly like one unpriced parent step does.
  const partial = (totals?.unpricedSteps ?? 0) > 0 || (totals?.subagentUnpriced ?? 0) > 0;
  const subscription = (totals?.subscriptionSteps ?? 0) > 0;
  const subSubscription = (totals?.subagentSubscription ?? 0) > 0;

  let total: string;
  const qualifiers: string[] = [];
  if (!ownPriced && !subPriced) {
    total = `Spent in this session: ${subscription || subSubscription ? "by subscription" : "price unknown"}`;
    if (partial && (subscription || subSubscription)) {
      qualifiers.push("some steps price unknown");
    }
  } else {
    total = `Spent in this session: ${partial ? "≥" : "≈"} ${money(pricedTotal)}`;
    if (partial) {
      qualifiers.push("some steps price unknown");
    }
    if (subscription || subSubscription) {
      qualifiers.push("plus subscription");
    }
  }

  const subagentCount = totals?.subagentCount ?? 0;
  let subagentSuffix: string | null = null;
  if (totals !== null && subagentCount > 0) {
    const share = subPriced
      ? `${(totals.subagentUnpriced ?? 0) > 0 ? "≥" : "≈"} ${money(totals.subagentCostUsd ?? 0)}`
      : subSubscription ? "by subscription" : "price unknown";
    subagentSuffix =
      `incl. subagents ${share}` +
      (totals.subagentIncludedInReportedCost ? " · native Claude costs may already be included" : "");
  }

  const inputTokens = tokens?.input ?? totals?.input;
  const outputTokens = tokens?.output ?? totals?.output;
  const parts: string[] = [];
  // A session with no token counts at all (every counter still zero) gets no
  // "in 0 · out 0" noise — there is nothing to report yet.
  if ((inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0) {
    parts.push(
      `Tokens in ${inputTokens === undefined ? "?" : formatCtxTokenCount(inputTokens)} · out ${
        outputTokens === undefined ? "?" : formatCtxTokenCount(outputTokens)
      }`,
    );
  }
  let showsEstimate = ownPriced || subPriced;
  if (totals?.cacheSavingsUsd !== undefined) {
    parts.push(
      `cache saved ≈ ${money(totals.cacheSavingsUsd)}` +
        ((totals.unknownSavingsSteps ?? 0) > 0 ? " · some steps savings unknown" : ""),
    );
    showsEstimate = true;
  }
  const bases = totals?.priceBasisIds ?? [];
  // The band a step was billed at rides in its basis id: a time-of-day tariff
  // snapshot keeps its `-peak-` basis and appends `+off-peak` when the step
  // fell outside the peak windows, so both bands can appear in one session.
  const tariffPeak = bases.some((id) => id.includes("-peak-") && !id.endsWith("+off-peak"));
  const tariffOffPeak = bases.some((id) => id.endsWith("+off-peak"));
  if (bases.some((id) => id.includes("-openai-") || id.startsWith("claude-haiku-5-5-anthropic-"))) {
    parts.push("short-context rate estimates");
  }
  if (tariffPeak && tariffOffPeak) parts.push("peak & off-peak rate estimates");
  else if (tariffOffPeak) parts.push("off-peak-rate estimates");
  else if (tariffPeak) parts.push("peak-rate estimates");
  if (bases.some((id) => id.startsWith("connection:"))) parts.push("connection-rate estimates");
  if (bases.some((id) => id !== "claude-cli-reported" && !id.startsWith("connection:") && !id.includes("-openai-") && !id.includes("-peak-") && !id.endsWith("+off-peak") && !id.startsWith("claude-haiku-5-5-anthropic-"))) parts.push("standard-rate estimates");
  if (showsEstimate && bases.length === 0) parts.push("estimated rates");

  return { total, qualifier: qualifiers.length > 0 ? qualifiers.join(" · ") : null, subagentSuffix, footnote: parts.length > 0 ? parts.join(" · ") : null };
}

/**
 * One popover row per audited step, as PARTS: every part but the last is
 * followed by a " · " separator, and the last one is the money group
 * ("cost ≈ $0.0021"), which the renderer keeps on one line (`.ctx-popover-step-cost`
 * is `nowrap`) so a step row never splits between "cost ≈" and the amount.
 */
export function formatUsageAuditStepParts(step: WireUsageAuditStep): string[] {
  const inPart = step.inputTokens !== undefined ? `in ${formatCtxTokenCount(step.inputTokens)}` : null;
  const cachedPart = step.cachedInputTokens !== undefined ? `cached ${formatCtxTokenCount(step.cachedInputTokens)}` : null;
  const outPart = step.outputTokens !== undefined ? `out ${formatCtxTokenCount(step.outputTokens)}` : null;
  const retryPart = step.transportRetries > 0 ? `retry ${step.transportRetries}` : null;
  return [step.finishReason === "result" ? "turn total" : "step " + step.step, inPart, cachedPart, outPart, retryPart, `cost ${formatStepCost(step)}`]
    .filter((part): part is string => part !== null);
}

/** The same row as one string, for tests and tooltips. */
export function formatUsageAuditStepRow(step: WireUsageAuditStep): string {
  return formatUsageAuditStepParts(step).join(" · ");
}

/** Select audited steps for the requested turn; without an ID, select the latest recorded turn. */
export function currentTurnSteps(list: readonly WireUsageAuditStep[] | null, turnId?: string | null): WireUsageAuditStep[] {
  if (list === null || list.length === 0) {
    return [];
  }
  const selectedTurnId = turnId === undefined ? list.reduce((best, step) => (step.createdAt > best.createdAt ? step : best)).turnId : turnId;
  return list
    .filter((step) => step.turnId === selectedTurnId)
    .sort((a, b) => a.step - b.step || a.createdAt - b.createdAt);
}

/** Money for the one-line summary: up to four decimals, trailing zeros trimmed ("$0.004", "$1.5"). */
function formatCompactMoney(value: number): string {
  if (value === 0) {
    return "$0";
  }
  if (value > 0 && value < 0.0001) {
    return `$${value.toPrecision(2)}`;
  }
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * The collapsed one-line summary of one turn's steps:
 * `"This turn: 12 steps · ≈ $0.004 · cache 99%"`.
 *
 * The "This turn:" prefix is load-bearing: the session total sits directly
 * above this line, and without the label a reader takes the turn's money for
 * the session's (that misreading is what the step list "not adding up to the
 * total" looked like). `$0.004` is the SUM of that turn's priced steps; a turn
 * with any unpriced step reads "≥", a fully unknown one "price unknown", and a
 * subscription one "by subscription". The cache percentage divides that turn's
 * cached input by its own input and appears ONLY when a step actually reported
 * both (never a fabricated 0%); when input WAS reported but no step carried a
 * cached-input count, the part reads "cache not reported by provider" instead
 * of vanishing.
 */
export function formatTurnStepSummary(steps: readonly WireUsageAuditStep[]): string | null {
  if (steps.length === 0) {
    return null;
  }
  const priced = steps.filter((step) => step.costUsd !== undefined);
  const subscription = steps.filter((step) => step.priceBasisId === "subscription");
  const unpriced = steps.length - priced.length - subscription.length;
  let costPart: string;
  if (priced.length === 0) {
    costPart = subscription.length > 0 ? "by subscription" : "price unknown";
  } else {
    const sum = priced.reduce((total, step) => total + (step.costUsd ?? 0), 0);
    costPart = `${unpriced > 0 || subscription.length > 0 ? "≥" : "≈"} ${formatCompactMoney(sum)}`;
  }
  if (subscription.length > 0 && priced.length > 0) costPart += " · plus subscription";
  if (unpriced > 0 && (priced.length > 0 || subscription.length > 0)) costPart += " · some steps price unknown";
  const withInput = steps.filter((step) => step.inputTokens !== undefined && step.inputTokens > 0);
  const withCache = withInput.filter((step) => step.cachedInputTokens !== undefined);
  // A provider that reports no cached-input count at all (an OpenAI-compatible
  // server without `cached_tokens`, e.g. LM Studio) must say so instead of
  // silently dropping the cache fact: silence read as "no caching happened".
  // Same wording as the 0.0.44 fix — a fabricated 0% is still never shown, and
  // a step that reports cached tokens without an input count (no denominator)
  // contributes no cache part at all.
  const cachePart = withCache.length === 0
    ? withInput.length === 0
      ? null
      : "cache not reported by provider"
    : `cache ${Math.round(
        (withCache.reduce((total, step) => total + (step.cachedInputTokens ?? 0), 0) /
          withCache.reduce((total, step) => total + (step.inputTokens ?? 0), 0)) *
          100,
      )}%`;
  return [`This turn: ${steps.length} step${steps.length === 1 ? "" : "s"}`, costPart, cachePart]
    .filter((part) => part !== null)
    .join(" · ");
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

/** Gap (px) between the trigger's top edge and the bottom-anchored popover. */
const CTX_POPOVER_GAP = 8;

/** Minimum breathing room (px) between the popover's top edge and the window top, so the rounded box never sits flush against it. */
const CTX_POPOVER_VIEWPORT_MARGIN = 8;

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
 * just above the trigger, and a `maxHeight` equal to the room actually above
 * the trigger. Pure so both call sites share one formula instead of
 * duplicating the offset/clamp math. Exported for unit testing.
 *
 * `maxHeight` is what keeps an expanded step list usable: the popover is
 * bottom-anchored, so without it a long turn grows upward past the window top
 * (the window can be as short as 480 px) and the header, spend total and
 * qualifiers become unreachable. The returned height leaves the whole box on
 * screen — the body scrolls instead of the box growing upward.
 */
export function ctxPopoverAnchorFromRect(
  rect: { right: number; top: number },
  viewportWidth: number,
  viewportHeight: number,
): { left: number; bottom: number; maxHeight: number } {
  const roomAbove = rect.top - CTX_POPOVER_GAP - CTX_POPOVER_VIEWPORT_MARGIN;
  return {
    left: clampMenuLeft(rect.right - CTX_POPOVER_WIDTH, CTX_POPOVER_WIDTH, viewportWidth),
    bottom: viewportHeight - rect.top + CTX_POPOVER_GAP,
    maxHeight: Math.max(Math.floor(roomAbove), 0),
  };
}

/**
 * The collapsed cost summary: the total on its own row, the qualifiers
 * ("some steps price unknown", "incl. subagents ≈ $0.0040") each on their own
 * muted row, then the turn line and the footnote. Nothing here may be clipped:
 * the total row wraps, and the qualifiers are separate lines rather than a
 * " · "-joined tail that overflowed the 280 px popover.
 */
export function UsageCostBlock({ ledger, turnSummary, turnSteps, generationTokensPerSecond, expanded, onToggle }: {
  generationTokensPerSecond?: number;
  ledger: UsageCostLedger;
  turnSummary: string | null;
  turnSteps: readonly WireUsageAuditStep[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = [ledger.total, ledger.qualifier, ledger.subagentSuffix].filter((part): part is string => part !== null).join(" · ");
  const timed = turnSteps.filter((step) => step.outputTokens !== undefined && Number.isFinite(step.outputTokens) && step.outputTokens >= 0 && step.generationDurationMs !== undefined && Number.isFinite(step.generationDurationMs) && step.generationDurationMs > 0);
  const turnRate = timed.length ? 1000 * timed.reduce((sum, step) => sum + step.outputTokens!, 0) / timed.reduce((sum, step) => sum + step.generationDurationMs!, 0) : undefined;
  const rate = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "—" : `${Number(value.toFixed(1))} t/s`;
  return <div className="ctx-popover-cost-block">
    <div className="ctx-popover-total ctx-popover-cost-line" tabIndex={0} title={total}>{ledger.total}</div>
    {ledger.qualifier !== null && <div className="ctx-popover-total-qualifier" title={ledger.qualifier}>{ledger.qualifier}</div>}
    {ledger.subagentSuffix !== null && <div className="ctx-popover-total-sub" title={ledger.subagentSuffix}>{ledger.subagentSuffix}</div>}
    {turnSummary !== null && <>
      <button type="button" className="ctx-popover-steps-toggle ctx-popover-cost-line" aria-expanded={expanded} title={turnSummary} onClick={onToggle}>{turnSummary}</button>
      {expanded && <div className="ctx-popover-steps" role="group" aria-label="This turn's steps">
        {turnSteps.map((step) => {
          const parts = formatUsageAuditStepParts(step);
          const last = parts.length - 1;
          return <div className="ctx-popover-session ctx-popover-step-row" key={`${step.turnId}:${step.step}`}>
            {parts.slice(0, last).map((part, index) => <span key={index}>{part} · </span>)}
            <span className="ctx-popover-step-cost">{parts[last]}</span>
          </div>;
        })}
      </div>}
    </>}
    {(generationTokensPerSecond !== undefined || turnRate !== undefined) && <div className="ctx-popover-session" title="Measured from the first provider event through completion">Generation speed: session {rate(generationTokensPerSecond)} · this turn {rate(turnRate)}</div>}
    {ledger.footnote !== null && <div className="ctx-popover-session ctx-popover-footnote" tabIndex={0} title={ledger.footnote}>{ledger.footnote}</div>}
  </div>;
}

export function contextWindowSettingsTarget(
  connections: readonly ProviderConnection[], model: string | null,
  hostId: string | null | undefined, pinnedId: string | undefined,
): { connection: ProviderConnection; model: string } | null {
  const id = modelSettingsTarget(hostId, pinnedId);
  const connection = connections.find((item) => item.id === id);
  return connection !== undefined && model !== null ? { connection, model } : null;
}

export function showCustomPricingHint(target: { connection: ProviderConnection } | null, totals: WireUsageAuditTotals | null): boolean {
  return Boolean(target?.connection.providerId.startsWith("custom:") && ((totals?.unpricedSteps ?? 0) > 0 || (totals?.subagentUnpriced ?? 0) > 0));
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
  usageAudit,
  turnStatus,
  quota,
  percent,
  tint,
  supportsContextBreakdown,
  contextWindowAssumed,
  codexAccountLine,
}: {
  contextUsage: ContextUsage | null;
  contextBreakdown: WireContextBreakdown | null;
  sessionTokens: SessionTokens | null;
  /** Taskana 4083 / TASK.34: the durable audit slice (see DesktopState.usageAudit). */
  usageAudit: {
    lastStep: WireUsageAuditStep | null;
    totals: WireUsageAuditTotals | null;
    totalSteps: number;
    list: WireUsageAuditStep[] | null;
  };
  turnStatus: TurnState["status"];
  quota: CodexRateLimitsWire | null;
  percent: number | null;
  tint: string;
  /** codex-profiles cut §5.2: Codex has no per-category breakdown — the popover shows an honest message instead of a skeleton (see `ctxPopoverBodyState`'s "unsupported" branch). */
  supportsContextBreakdown: boolean;
  /** Taskana 4127: the window is the assumed unknown-model fallback — show the hint. */
  contextWindowAssumed: boolean;
  /** "Codex account: <label> (default)" for a Codex session; null hides the line (core/Claude, or unknown). */
  codexAccountLine: string | null;
}) {
  const sendToHost = useTabSend();
  const latestTurnId = useTabStore((state) => state.latestTurnId);
  const model = useTabStore((state) => state.model);
  const pinnedConnection = useTabStore((state) => state.pinnedConnection);
  const modelSettingsConnectionId = useTabStore((state) => state.modelSettingsConnectionId);
  const snapshot = useSettingsStore((state) => state.snapshot);
  const [settingsTarget, setSettingsTarget] = useState<{ connection: ProviderConnection; model: string } | null>(null);
  useOverlayFlag(settingsTarget !== null);
  const shortcutTarget = contextWindowSettingsTarget(snapshot?.settings.provider.connections ?? [], model, modelSettingsConnectionId, pinnedConnection?.connectionId);
  const assumedHint = ctxWindowAssumedHint(contextUsage);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  /** Per-step list starts collapsed and returns to collapsed on every close. */
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const previousTurnStatus = useRef(turnStatus);

  useEffect(() => {
    if (shouldRefreshUsageAudit(open, previousTurnStatus.current, turnStatus)) {
      sendToHost({ type: "usage_audit_request" });
    }
    previousTurnStatus.current = turnStatus;
  }, [open, turnStatus, sendToHost]);

  function clearHoverTimer(): void {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function close(): void {
    clearHoverTimer();
    setOpen(false);
    setStepsExpanded(false);
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
  // Taskana 4083 / TASK.34: the SAME transition also fires the twin
  // `usage_audit_request` — UNCONDITIONALLY, because the audit is a core
  // feature independent of supportsContextBreakdown; a foreign host that
  // never answers leaves the list null (lazy-load skeleton posture).
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    if (supportsContextBreakdown) {
      sendToHost({ type: "context_breakdown_request" });
    }
    sendToHost({ type: "usage_audit_request" });
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

  const roundedPercent = percent === null ? null : Math.round(percent);
  const headline = ctxPopoverHeadline(contextUsage, roundedPercent);
  const rows = ctxPopoverRows(contextBreakdown);
  const loading = ctxPopoverLoading(open, contextBreakdown);
  const bodyState = ctxPopoverBodyState(supportsContextBreakdown, loading, timedOut);
  // The usage/cost block: ONE session total (subagents included), the current
  // turn, one quiet footnote. Three lines at most, so the number the owner
  // came for is the number that stands out.
  const ledger = formatUsageCostLedger(usageAudit.totals, sessionTokens);
  // Current-turn steps only (never a mix of turns): the summary line and the
  // expandable list below are both built from this one array.
  const turnSteps = currentTurnSteps(usageAudit.list, latestTurnId);
  const turnStepSummary = formatTurnStepSummary(turnSteps);
  const quotaView = buildQuotaPopoverView(quota, Date.now());
  const fillPercent = percent === null ? 0 : Math.min(100, Math.max(0, percent));

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
        className={`composer-ctx-meter${tint}${contextWindowAssumed ? " composer-ctx-meter-assumed" : ""}`}
        title={contextWindowAssumed ? assumedHint : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Context window usage"
        onClick={handleClick}
        onFocus={handleFocus}
      >
        {percent !== null && roundedPercent !== null ? <><CtxRing percent={percent} />{ctxMeterLabel(roundedPercent, contextWindowAssumed)}</> : "Usage"}
      </button>

      {open && (
        <div
          className={`ctx-popover${tint}`}
          role="dialog"
          aria-label="Context window breakdown"
          style={anchor ? { left: anchor.left, bottom: anchor.bottom, maxHeight: anchor.maxHeight } : undefined}
        >
          <div className="ctx-popover-header">
            <span className="ctx-popover-title">Context window</span>
            {headline !== null && <span className="ctx-popover-headline">{headline}</span>}
          </div>
          {/* The only scrolling part: the header stays pinned so the title and
              the token headline remain readable while a long expanded turn is
              scrolled. `maxHeight` on the popover (from the anchor) bounds the
              whole box to the room above the trigger. `tabIndex` gives the
              scroll region keyboard access (arrow/PageDown) on top of the
              browser's scroll-into-view for the focusable rows inside. */}
          <div className="ctx-popover-body" tabIndex={0}>
            {contextWindowAssumed && <div className="ctx-popover-assumed">
              {assumedHint}
              {shortcutTarget !== null && <button type="button" className="settings-button"
                onClick={() => { close(); setSettingsTarget(shortcutTarget); }}>Set context window</button>}
            </div>}
            {percent !== null && <div className="ctx-popover-bar">
              <div className="ctx-popover-bar-fill" style={{ width: `${fillPercent}%` }} />
            </div>}
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
            <div className="ctx-popover-divider" />
            <UsageCostBlock ledger={ledger} turnSummary={turnStepSummary} turnSteps={turnSteps} generationTokensPerSecond={usageAudit.totals?.generationTokensPerSecond} expanded={stepsExpanded} onToggle={() => setStepsExpanded((value) => !value)} />
            {showCustomPricingHint(shortcutTarget, usageAudit.totals) && <div className="ctx-popover-footnote">Set prices in the connection settings</div>}
            {usageAudit.list === null && usageAudit.totalSteps > 0 && (
              <div className="ctx-popover-session">Step history: {usageAudit.totalSteps} records — reopen to load</div>
            )}
            {quotaView !== null && (
              <>
                {quotaView.primaryLine !== null && <div className="ctx-popover-session">{quotaView.primaryLine}</div>}
                {quotaView.secondaryLine !== null && <div className="ctx-popover-session">{quotaView.secondaryLine}</div>}
                {quotaView.creditsLine !== null && <div className="ctx-popover-session">{quotaView.creditsLine}</div>}
              </>
            )}
            {/* the quota above belongs to THIS account — name it,
                so a session's spend is never a mystery again. */}
            {codexAccountLine !== null && (
              <div className="ctx-popover-session ctx-popover-codex-account">{codexAccountLine}</div>
            )}
          </div>
        </div>
      )}
      {settingsTarget !== null && snapshot !== null && (
        <Suspense fallback={null}>
          <ContextWindowSettings snapshot={snapshot} connection={settingsTarget.connection} model={settingsTarget.model}
            onClose={() => setSettingsTarget(null)} />
        </Suspense>
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
  // UI audit v0.0.49 §C2: the card's measured height is what keeps the toast
  // stack off the stop/send controls — published as --composer-clearance.
  const cardRef = useRef<HTMLDivElement>(null);
  useComposerClearance(cardRef);
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
  const projectRoot = useTabsStore((state) => {
    const tab = state.tabs.find((item) => item.tabId === slashTabId);
    return tab?.projectRoot ?? tab?.workspace;
  });
  // Taskana 4704 §3.8 (part B): first-run /orchestrate state — the task text
  // parked while the RolePickerDialog is up, and the dialog's visibility.
  // Local to Composer: the pending text belongs to THIS tab's composer draft
  // lifecycle, not the store. `pendingOrchestrateTask === null` means "no
  // /orchestrate submit in flight".
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [pendingOrchestrateTask, setPendingOrchestrateTask] = useState<string | null>(null);
  // True when the mode menu's Orchestrate row (not a `/orchestrate` submit)
  // opened the first-run dialog: Save/Skip then only enable the flag.
  const [rolePickerForToggle, setRolePickerForToggle] = useState(false);

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
  const childSurface = useTabStore((state) => state.childSurface);
  const mode = useTabStore((state) => state.mode);
  const model = useTabStore((state) => state.model);
  const imageInput = useTabStore((state) => state.imageInput);
  // TASK.198 срез D: mirrors `imageInput` off the same wire messages — a
  // configured recognizer fallback re-opens the gates below without waiting
  // for the model itself to report vision support.
  const imageFallback = useTabStore((state) => state.imageFallback);
  const connection = useTabStore((state) => state.connection);
  const contextUsage = useTabStore((state) => state.contextUsage);
  const contextBreakdown = useTabStore((state) => state.contextBreakdown);
  const contextWindowAssumed = useTabStore((state) => state.contextWindowAssumed);
  const sessionTokens = useTabStore((state) => state.sessionTokens);
  const usageAudit = useTabStore((state) => state.usageAudit);
  const quota = useTabStore((state) => state.quota);
  const engine = useTabStore((state) => state.engine);
  // which Codex account THIS tab runs on, for the context
  // popover's account line. Main owns the answer (tab's own resolved profile +
  // registry label); the renderer only asks. The ACCOUNT cannot change under a
  // live tab, but `isDefault` can (Settings → "Make default" while this tab is
  // open), so the read is repeated on every `engines-changed` push — the same
  // signal the rest of the app uses for "the Codex registry moved".
  const composerTabId = useContext(TabContext)?.tabId ?? null;
  const [codexTabAccount, setCodexTabAccount] = useState<CodexTabAccountResult | null>(null);
  const codexEngineActive = engine?.id === "codex";
  useEffect(() => {
    if (!codexEngineActive || composerTabId === null) {
      setCodexTabAccount(null);
      return;
    }
    const api = window.anycode?.codex;
    if (typeof api?.tabAccount !== "function") return;
    let cancelled = false;
    const load = (): void => {
      void api
        .tabAccount(composerTabId)
        .then((result) => {
          if (!cancelled) setCodexTabAccount(result);
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = window.anycode?.onEnginesChanged?.(load);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [codexEngineActive, composerTabId]);
  const codexAccountLine = describeCodexAccountLine(codexTabAccount);
  const pendingEngineChange = useTabStore((state) => state.pendingEngineChange);
  const shell = useTabStore((state) => state.shell);
  // Taskana 4110 (TASK.123): the engine's live steering verdict — true means
  // a send while running becomes a mid-turn steer instead of a queued prompt.
  const steerSupported = useTabStore((s) => s.steering?.supported === true);
  const isNewSession = useTabStore((state) => state.transcript.length === 0);
  // Taskana 4704 §3.7 (part B): tab-scoped orchestrate flag (part A keeps it
  // from `orchestrate_changed` acks). Read here for the ModeMenu row and the
  // `/orchestrate` submit path below.
  const orchestrateActive = useTabStore((state) => state.orchestrateActive);

  // Core keeps its exact legacy presentation when `engine` is null. External
  // engines declare only the controls their adapter can honour.
  const supportsCorePermissions = engine?.capabilities.supportsCorePermissions ?? true;
  const supportsModelSelection = engine?.capabilities.supportsModelSelection ?? true;
  const supportsImages = engine?.capabilities.supportsImages ?? true;
  // TASK.56 W3: MODEL-level gate, layered on top of the engine-level one
  // above — `supportsImages` hides the attach UI entirely for an engine that
  // never does images; `imageInput` disables it (with an explanation) for a
  // model on an engine that DOES, when this particular model doesn't.
  const modelBlocksAttach = isImageAttachBlockedByModel(imageInput, imageFallback);
  const attachmentsBlockedByModel = isSendBlockedByModelImages(imageInput, imageFallback, attachedImages.length);
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

  // TASK.146: "the composer is in busy mode", not "a model turn is streaming".
  // A manual compaction is a busy phase of the session too — the Stop button
  // (its `cancel_turn` aborts the compaction host-side), the "Queue a
  // message…" placeholder and the queue-on-Enter hint all apply verbatim,
  // because a prompt sent now would be busy-rejected by the host.
  const running = isSessionBusy(turn.status);
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
    engineId: engine?.id ?? "core",
    mode: mode ?? "plan",
    model: model ?? "",
    running,
    ready,
    modelDisabled: modelPickDisabled(turn.status, queueInFlight, ready, engine === null),
    idle: !shouldEnqueue(turn.status, queueInFlight) && ready,
    supportsCorePermissions,
    supportsModelSelection,
    supportsManualCompact: engine?.capabilities.supportsManualCompact ?? true,
    shellGitReadOnly,
    shellTerminal,
  };
  const isBareCommand = resolveBareSlashSubmit(
    reconstitutePasteMarkers(text, pasteBlocks), slashCtx, attachedImages.length, childSurface,
  ).kind !== "text";
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
  const slashItemsKey = slashItems.map((item) => item.id).join("\0");
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
   * Taskana 4704 §3.8 (part B): `/orchestrate <task>` submit flow. If the tab
   * is already orchestrate, the task submits immediately as a normal user
   * message. Otherwise, when NO roles are configured (settings.roles absent),
   * the first-run RolePickerDialog opens with the task stashed; Save writes
   * roles then proceeds, Skip proceeds with built-in defaults. Either way the
   * proceed step enables orchestrate (set_orchestrate true) and submits the
   * stashed task. The enable and the submit are separate wire messages: the
   * host applies set_orchestrate between turns (silent-drop discipline), and
   * the prompt queue carries the task exactly like any other send.
   */
  function beginOrchestrateSubmit(taskText: string): void {
    const task = taskText.trim();
    if (!ready) {
      return;
    }
    if (orchestrateActive) {
      submitOrchestrateTask(task);
      return;
    }
    setPendingOrchestrateTask(task);
    setRolePickerForToggle(false);
    // The shared first-run gate (orchestrate-start.ts) — the start screen uses the same one.
    if (needsRolePicker(resolveProfileRoles(useSettingsStore.getState().snapshot?.settings ?? {}, projectRoot))) {
      setRolePickerOpen(true);
      return;
    }
    proceedOrchestrateSubmit();
  }

  /** Enable orchestrate, then submit the stashed task as a normal user message. */
  function proceedOrchestrateSubmit(): void {
    sendToHost({ type: "set_orchestrate", enabled: true });
    const task = pendingOrchestrateTask;
    setPendingOrchestrateTask(null);
    setRolePickerForToggle(false);
    setRolePickerOpen(false);
    if (task !== null && task.length > 0) {
      submitOrchestrateTask(task);
    }
  }

  /**
   * The mode menu's Orchestrate row asked for first-run roles: their dialog's
   * Save/Skip only enables orchestrate. There is no task to send here, and the
   * enable is a between-turns wire message the host acknowledges — the chip
   * then reads "Orchestrate".
   */
  function proceedOrchestrateToggle(): void {
    setRolePickerForToggle(false);
    setRolePickerOpen(false);
    sendToHost({ type: "set_orchestrate", enabled: true });
  }

  /** Send one text as a user message through the same wire path handleSend's idle branch uses. */
  function submitOrchestrateTask(task: string): void {
    if (task.length === 0) {
      return;
    }
    const requestId = crypto.randomUUID();
    tabStore.getState().appendUserText(requestId, task);
    tabStore.getState().recordSentMessage(task, []);
    sendToHost({ type: "user_message", requestId, text: task });
  }

  /**
   * Single exhaustive dispatch point for a selected row's intent (cut §4.1:
   * "the registry itself stays pure/testable; Composer owns the single
   * exhaustive dispatchSlashIntent switch"). `insert` is a no-op here — its
   * text replacement already happened uniformly for every intent kind in
   * `selectSlashItem` below (the token-removal and the skill-text-insert are
   * the SAME operation: replace the slash token with `intent.text` or `""`).
   * `postStripText` (Taskana 4704 §3.8) carries the draft AFTER the token
   * strip for the one intent that consumes it: `/orchestrate <task>`'s task
   * text is "whatever the slash-token removal left behind".
   */
  function dispatchSlashIntent(intent: SlashRunIntent, postStripText: string): void {
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
      case "compact_now": {
        // One payload-less send. The row's own gates (hidden without
        // supportsManualCompact, gray unless truly idle) already screened the
        // menu, but the SAME availability must be rechecked here so a menu
        // mouse/Tab selection and the bare-`/compact` submit interceptor share
        // one refusal path (GitHub #14). The host is the backstop for the
        // post-check busy race (its `compact_rejected` reply).
        const verdict = resolveBareSlashSubmit("/compact", slashCtx, attachedImages.length, childSurface);
        if (verdict.kind === "refuse") {
          tabStore.getState().setNotice({ kind: "slash_command_rejected", text: verdict.reason });
        } else if (verdict.kind === "run") {
          sendToHost({ type: "compact_request" });
        }
        break;
      }
      case "settings_pane":
        window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
        window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: intent.pane }));
        break;
      case "orchestrate_submit":
        // Taskana 4704 §3.8: the task text is what remains of the draft after
        // selectSlashItem stripped the `/orchestrate` token.
        beginOrchestrateSubmit(postStripText);
        break;
      case "insert":
        break;
      default:
        assertNever(intent);
    }
  }

  /**
   * GitHub #14 submit-time interception: classify a WHOLE outgoing draft as a
   * bare slash command BEFORE any queue/steer/append side effect. `false`
   * means "ordinary text — keep the existing send path"; `true` means the
   * draft was fully consumed (refused with a visible notice, or run as a
   * command). Commands are never appended to the transcript and never
   * recorded as a sent message — they are not model prompts.
   */
  function trySubmitBareCommand(outgoing: string): boolean {
    const result = resolveBareSlashSubmit(outgoing, slashCtx, attachedImages.length, childSurface);
    if (result.kind === "text") {
      // A slash-shaped draft that names no command is still not a prompt on the
      // core engine: answer it locally instead of spending a model turn on
      // "I don't recognize /foo". Foreign engines keep their own slash surface
      // (Claude's allowlisted frames, Codex's own commands), so the guard is
      // core-only — the same engine-null test the skills menu uses.
      const unknown = skillsSupported
        ? unknownSlashCommandNotice(outgoing, { pathRoots: slashPathRootNames() })
        : null;
      if (unknown !== null) {
        tabStore.getState().setNotice({ kind: "slash_command_rejected", text: unknown });
        return true;
      }
      return false;
    }
    if (result.kind === "refuse") {
      tabStore.getState().setNotice({ kind: "slash_command_rejected", text: result.reason });
      return true;
    }
    setText("");
    setPasteBlocks([]);
    setCaret(0);
    dispatchSlashIntent(result.intent, "");
    return true;
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
    const intent = item.intent;
    if (intent.kind === "compact_now") {
      const verdict = resolveBareSlashSubmit("/compact", slashCtx, attachedImages.length, childSurface);
      if (verdict.kind === "refuse") {
        tabStore.getState().setNotice({ kind: "slash_command_rejected", text: verdict.reason });
        return;
      }
    }
    const tokenEnd = slashTokenEnd(text, slashQuery.start);
    const isInsert = intent.kind === "insert";
    const replacement = intent.kind === "insert" ? intent.text : "";
    const nextText = text.slice(0, slashQuery.start) + replacement + text.slice(tokenEnd);
    setText(nextText);
    setCaret(slashQuery.start + replacement.length);
    pendingCaretRef.current = slashQuery.start + replacement.length;
    if (isInsert) {
      textareaRef.current?.focus();
    }
    dispatchSlashIntent(item.intent, nextText);
  }

  /** Thin wrapper: `readComposerImageFile` owns validation, this only mints the renderer-local list-key `id`. */
  async function readDraftImage(file: File): Promise<{ ok: true; image: DraftImage } | { ok: false; reason: string }> {
    const result = await readComposerImageFile(file);
    if (!result.ok) {
      return result;
    }
    return { ok: true, image: { id: nextImageIdRef.current++, ...result.image } };
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
    const outgoing = reconstitutePasteMarkers(text, pasteBlocks);
    // GitHub #14: a recognized whole-draft slash command is consumed (run or
    // visibly refused) BEFORE the canSend gate and before any queue/steer/
    // append side effect — it is never delivered to the model as a prompt.
    if (trySubmitBareCommand(outgoing)) {
      return;
    }
    if (!canSend) {
      return;
    }
    const images = attachedImages.map((image) => ({
      name: image.name,
      sizeBytes: image.sizeBytes,
      attachment: image.attachment,
    }));
    if (childSurface && turn.status !== "idle") {
      // TASK.118 (child surface): the host's steer queue accepts this
      // user_message immediately, so send it on the wire as usual — but the
      // transcript write is DEFERRED to the matching turn_started (delivery
      // position), recorded as a pending steer instead of an optimistic
      // append that would interleave with the running turn's output.
      const requestId = crypto.randomUUID();
      tabStore.getState().recordPendingSteer(requestId, outgoing, images.length > 0 ? images.map((image) => image.attachment) : undefined, {
        text: outgoing,
        images,
      });
      sendToHost({
        type: "user_message",
        requestId,
        text: outgoing,
        ...(images.length > 0 ? { images: images.map((image) => image.attachment) } : {}),
      });
    } else if (!childSurface && turn.status !== "idle" && images.length === 0 && steerSupported) {
      // Taskana 4110 (TASK.123): a supported running CORE session takes the
      // message as a mid-turn steer (optimistic pendingSteer bubble; the
      // user_injected event confirms delivery into the turn; the queue is the
      // honest fallback everywhere else). Images while running keep the queue
      // path (engine.steer is text-only). 4110 rework: the steer is marked
      // UI-owned (`markUiSteer`) so a turn end / steer_requeued without
      // delivery re-queues it into the prompt queue — the text is never lost.
      const requestId = crypto.randomUUID();
      tabStore.getState().recordPendingSteer(requestId, outgoing, undefined, { text: outgoing, images: [] });
      tabStore.getState().markUiSteer(requestId);
      sendToHost({ type: "steer_message", requestId, text: outgoing });
    } else if (shouldEnqueue(turn.status, queueInFlight, childSurface)) {
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
      // one place that appends the user_text transcript block — here in the
      // truly-idle path; a running-turn steer takes the pendingSteer path
      // above (TASK.118). Goes through

      // owns all transcript writes, and appendBlock flushes pending deltas
      // first so ordering stays consistent. Taskana 4091 (TASK.84): the raw
      // text + attachments ride onto the block; the image count badge is no
      // longer appended to the live echo (thumbnails render instead).
      tabStore.getState().appendUserText(requestId, outgoing, images.length > 0 ? images.map((image) => image.attachment) : undefined);
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
    if (modeChangeDisabled(turn.status, ready) || next === mode) {
      return;
    }
    sendToHost({ type: "set_mode", mode: next });
  }

  /**
   * Taskana 4704 §3.7 (part B): the Orchestrate row's commit —
   * `set_orchestrate`, NOT set_mode (§2.2: orchestrate is a tab-level flag;
   * the host moves the session to plan itself). Same ready-only guard as
   * handleModeChange (the host silently drops a busy toggle — the
   * between-turns discipline; ready means there is no host to send to).
   *
   * Enabling on the first run (no roles configured) asks for roles first:
   * the toggle used to enable orchestrate with no way to choose who does the
   * work. The row's own click stays the trigger, so the dialog and the chip
   * agree on what was asked for.
   */
  function handleToggleOrchestrate(next: boolean): void {
    if (!ready || next === orchestrateActive) {
      return;
    }
    if (orchestrateToggleNeedsRolePicker(next, resolveProfileRoles(useSettingsStore.getState().snapshot?.settings ?? {}, projectRoot))) {
      setPendingOrchestrateTask(null);
      setRolePickerForToggle(true);
      setRolePickerOpen(true);
      return;
    }
    sendToHost({ type: "set_orchestrate", enabled: next });
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
    if (!engineEffortDisabled(turn.status, queueInFlight, ready, engine?.capabilities.supportsDeferredEffortChange === true)) sendToHost({ type: "set_engine_effort", effort });
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
  // Capability, not a current value: the effort row is offered whenever the
  // SELECTED native model advertises levels (`engineEffortOptions`), even if
  // this session has not reported an applied effort yet.
  const nativeEffort = engine?.model !== undefined
    ? nativeEffortControl(engine.model, pendingEngineChange?.model, pendingEngineChange?.effort, handleEngineEffortPick)
    : undefined;
  const sendDisabledReason = !ready
    ? "Waiting for the session to connect"
    : attachmentsBlockedByModel
      ? MODEL_IMAGE_SEND_BLOCKED_TEXT
      : text.trim().length === 0 && attachedImages.length === 0
        ? "Type a message to send"
        : undefined;

  return (
    <div
      ref={cardRef}
      className={`composer${running ? " composer-running" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <BackgroundAgents />
      <PromptQueue />
      <RolePickerDialog
        open={rolePickerOpen}
        connections={useSettingsStore.getState().snapshot?.settings.provider.connections ?? []}
        activeConnectionId={useSettingsStore.getState().snapshot?.settings.provider.activeConnectionId}
        onSave={(roles) => {
          // §3.9: Save writes roles, then the stashed task proceeds under
          // orchestrate (the enable + submit are the same proceed step as
          // Skip — only the settings write differs). A mode-menu toggle has
          // no stashed task: it only enables.
          void useSettingsStore.getState().setPatch(rolesPatch(useSettingsStore.getState().snapshot?.settings ?? {}, roles, projectRoot))
            .then((result) => {
              if (!result.ok) return;
              if (rolePickerForToggle) proceedOrchestrateToggle();
              else proceedOrchestrateSubmit();
            });
        }}
        onSkip={() => {
          // §3.9: Skip writes nothing; built-in defaults apply.
          if (rolePickerForToggle) proceedOrchestrateToggle();
          else proceedOrchestrateSubmit();
        }}
      />
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
        title={hintHidden ? undefined : hintText}
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
          // GitHub #14: an unshifted Enter on a recognized bare command is
          // intercepted BEFORE menu selection so a disabled row (busy/child/
          // unsupported) still gets a visible reason instead of a silent
          // no-op. Shift+Enter and the menu's Tab completion are untouched.
          if (event.key === "Enter" && !event.shiftKey) {
            const resolved = resolveBareSlashSubmit(
              reconstitutePasteMarkers(text, pasteBlocks),
              slashCtx,
              attachedImages.length,
              childSurface,
            );
            if (resolved.kind !== "text") {
              event.preventDefault();
              handleSend();
              return;
            }
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
          {supportsCorePermissions && <ModeMenu mode={mode ?? "plan"} disabled={modeChangeDisabled(turn.status, ready)} onChange={handleModeChange} orchestrateActive={orchestrateActive} onToggleOrchestrate={handleToggleOrchestrate} />}
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
              <EngineModelMenu model={engine.model} pendingModel={pendingEngineChange?.model} disabled={engineEffortDisabled(turn.status, queueInFlight, ready, engine.capabilities.supportsDeferredEffortChange === true && nativeEffort !== undefined)} modelDisabled={engineControlDisabled(turn.status, queueInFlight, ready)} onPick={handleEngineModelPick} {...(nativeEffort !== undefined ? { effort: nativeEffort } : {})} />
            ) : (
              <ModelPill />
            ))}
        </div>
        {/* Always in the DOM as the textarea's aria-describedby target
            (R17 a11y) — visually hidden by default (TASK.224: never a footer
            row); a wide composer shows it inline (app.css container query),
            and the same text rides the textarea/send hover titles. */}
        <span
          id="composer-hint"
          className={`composer-hint visually-hidden${hintHidden ? " composer-hint-hidden" : ""}`}
        >
          {hintText}
        </span>
        <div className="composer-footer-right">
          {supportsContextUsage &&
            (ctxPercent !== null || usageAudit.totals !== null || sessionTokens !== null || codexAccountLine !== null) && (
              <CtxPopover
                contextUsage={contextUsage}
                contextBreakdown={contextBreakdown}
                sessionTokens={sessionTokens}
                usageAudit={usageAudit}
                turnStatus={turn.status}
                quota={quota}
                percent={ctxPercent}
                tint={ctxTint}
                supportsContextBreakdown={supportsContextBreakdown}
                contextWindowAssumed={contextWindowAssumed === true}
                codexAccountLine={codexAccountLine}
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
                  disabled={attachmentsBlockedByModel && !isBareCommand}
                  onClick={handleSend}
                >
                  <ArrowUp />
                </button>
              )}
              {engine?.id === "codex" && text.trim() && attachedImages.length === 0 && (
                <button type="button" className="composer-send" aria-label="Steer active Codex turn" title="Steer active turn; acknowledgement does not prove model application" onClick={() => {
                  // GitHub #14: the explicit Codex steer must not leak a known
                  // bare command to the model either — classify first.
                  const outgoing = reconstitutePasteMarkers(text, pasteBlocks);
                  if (trySubmitBareCommand(outgoing)) {
                    return;
                  }
                  sendToHost({ type: "steer_message", requestId: crypto.randomUUID(), text: outgoing });
                  setText("");
                  setPasteBlocks([]);
                }}><ArrowUp /></button>
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
              title={sendDisabledReason ?? (hintHidden ? undefined : hintText)}
              disabled={!canSend && !isBareCommand}
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

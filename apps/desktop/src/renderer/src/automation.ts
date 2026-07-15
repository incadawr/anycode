/**
 * Renderer-side automation facade (design/build/design/phase-2-smoke-channel.md
 * §2.2/§3.2, task S2): installs `window.__anycodeAutomation`, the single
 * addressable surface main's HTTP smoke-server (S3, `main/automation/*`)
 * drives via `webContents.executeJavaScript`. DEV-only by construction — see
 * `installAutomation`'s call site in main.tsx, gated on `import.meta.env.DEV`
 * so the whole module (and this file's chunk) is physically absent from a
 * production renderer bundle (§5).
 *
 * Non-negotiable principle (design §1/§2.1): the facade opens NO second code
 * path. Every read goes straight at the same live zustand instances the React
 * tree renders (`tabRegistry.getStore(tabId)` / `useTabsStore`, no mirrored
 * state); every injected message is the exact `UiToHostMessage` variant and
 * client-side guard the matching component (`Composer`, `PermissionModal`)
 * uses, sent through the same `tabRegistry.sendToTab`; every tab-lifecycle
 * call goes through the same `window.anycode` contextBridge invoke-API the
 * picker/TabBar use. A drift in a facade guard can never open a path closed
 * to the UI — the host's zod validation and turn/permission state machine are

 *
 * DI shape mirrors the rest of this renderer (`createDesktopStore`,
 * `createTabRegistry`, `createTabsStore`): `createAutomationFacade` takes the
 * registry/tabs-store/bridge as parameters (defaulting to the app singletons
 * and the real `window.anycode`), so tests build the facade over fakes with
 * zero DOM/Electron — same isolation discipline as tab-registry.test.ts.
 */
import type { PermissionMode, ReasoningEffort } from "@anycode/core";
import type {
  ConnectionPhase,
  ContextUsage,
  GitDestructiveIntent,
  GitPanelView,
  GitPendingRequest,
  GitSlice,
  Notice,
  PermissionUiRequest,
  SessionTokens,
  TranscriptBlock,
  TurnState,
} from "./store.js";
import { buildConfirmedGitCommand } from "./store.js";
import { dispatchTryAgain } from "./App.js";
import type { CtxPopoverRow } from "./components/Composer.js";
import { confirmDialogCopy } from "./components/GitConfirmDialog.js";
import { buildDiffRequest } from "./components/GitPanel.js";
import { isAtBottom } from "./components/MessageList.js";
import {
  modelDisplayName,
  modelMenuItems,
  modelPickDisabled as computeModelPickDisabled,
  pillLabel,
} from "./components/ModelPill.js";
import { submitStartDraft, type StartSubmitDeps } from "./start-session.js";
import { tabRegistry, type TabRegistry } from "./tab-registry.js";
import { useTabsStore, type TabInfo, type TabsStoreApi } from "./tabs-store.js";
import { useSettingsStore, type SettingsStoreApi } from "./settings-store.js";
import { groupAlwaysAllowRules } from "./permission-rules.js";
import { ruleDisplayPattern, ruleHasPattern, ruleRemoveAriaLabel } from "./components/PermissionsEditor.js";
import { slashQueryAt } from "./slash-menu.js";
import { sortCheckpointsNewestFirst } from "./components/TimelinePanel.js";
import type { GitCommand, RewindScopeWire, UiToHostMessage, WireEnvStatus } from "../../shared/protocol.js";
import type { CreateTabRequest, CreateTabResult, CloseTabResult, SessionSummary } from "../../shared/tabs.js";
import { ENGINE_IDS, isEngineId, type EngineId } from "../../shared/engines.js";
import { activeProviderView } from "../../shared/settings.js";
import type { McpConfigSource, McpHarnessKind } from "../../shared/mcp-config.js";
import type { SkillHarnessKind, SkillScope, SkillSourceKind } from "../../shared/skills-config.js";
import type { SubagentSourceKind } from "../../shared/subagents-config.js";

/**
 * Mirrors Composer.tsx's `PERMISSION_MODE_OPTIONS` (deliberately duplicated,
 * not imported as a value — same rationale as Composer's own copy: renderer
 * runtime code may only ever `import type` from `@anycode/core`, so a real
 * value import of `PERMISSION_MODES` would drag the core barrel into the web
 * bundle). `setMode`'s wire signature takes an untyped `string` (§3.2 — the
 * HTTP body is JSON, not a TS union), so the facade is the one place that has
 * to validate a caller-supplied mode string before it can be treated as a
 * `PermissionMode` at all.
 */
const PERMISSION_MODE_OPTIONS: readonly PermissionMode[] = ["plan", "build", "edit", "auto", "yolo"];

function isPermissionMode(mode: string): mode is PermissionMode {
  return (PERMISSION_MODE_OPTIONS as readonly string[]).includes(mode);
}

/**
 * Mirrors GitPanel.tsx's non-exported `VIEWS` (`:25`) — same duplicate-not-
 * import rationale as `PERMISSION_MODE_OPTIONS` above (the component does not
 * export it, and `gitSetView`'s wire signature is an untyped `string`, so the
 * facade is the one place that validates a caller-supplied view string before
 * it can be treated as a `GitPanelView`).
 */
const GIT_PANEL_VIEW_OPTIONS: readonly GitPanelView[] = ["changes", "history", "diff"];

function isGitPanelView(view: string): view is GitPanelView {
  return (GIT_PANEL_VIEW_OPTIONS as readonly string[]).includes(view);
}

/**
 * Mirrors GitPanel's inline (command, pending) pairs verbatim (GitPanel.tsx
 * `:122-150`,`:359-367`,`:445-446`,`:463` + `buildDiffRequest` `:45-50`).
 * Returns null for the four destructive ops — a deliberate dispatch refusal,
 * since the two-step confirm flow (`gitStageConfirm` -> `gitConfirm`) is the

 * diff without an explicit path+target, which the UI never dispatches
 * (`buildDiffRequest` requires both). `kind` is a pure function of `op`
 * (design §2.1b), so the resulting `git_result` is dispatched into exactly the

 * `label` (which feeds the in-panel `lastError` line) could ever drift.
 */
export function derivePendingForGitCommand(command: GitCommand): GitPendingRequest | null {
  switch (command.op) {
    case "refresh":
      return { kind: "refresh", label: "refresh" };
    case "branches":
      return { kind: "branches", label: "branches" };
    case "log":
      return { kind: "log", label: "history" };
    case "diff":
      // The UI only ever dispatches a diff for a concrete file+target
      // (buildDiffRequest requires both) — a bare diff has no pending slot.
      if (command.path === undefined || command.target === undefined) {
        return null;
      }
      return buildDiffRequest(command.path, command.target).pending;
    case "stage":
      return { kind: "mutation", label: "stage" };
    case "unstage":
      return { kind: "mutation", label: "unstage" };
    case "stage_all":
      return { kind: "mutation", label: "stage all" };
    case "commit":
      return { kind: "mutation", label: "commit" };
    case "switch_branch":
      return { kind: "mutation", label: "switch branch" };
    case "create_branch":
      return { kind: "mutation", label: "create branch" };
    case "discard":
    case "stash_push":
    case "stash_pop":
    case "reset":

      // intent + gitConfirm is the sole constructor of a destructive command.
      return null;
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return null;
    }
  }
}

/** Projection of one tab's `DesktopState`, functions stripped (design §3.2 — must be JSON-safe for `executeJavaScript`'s return-value serialization). */
export interface TabStateSnapshot {
  connection: ConnectionPhase;
  workspace: string | null;
  model: string | null;
  mode: PermissionMode | null;
  turn: TurnState;
  transcript: TranscriptBlock[];
  permission: PermissionUiRequest | null;
  notice: Notice | null;
  contextUsage: ContextUsage | null;
  lastFatal: string | null;
  /**
   * The tab's whole git slice (design §2.1a — owner-sanctioned reversal of

   * construction (no functions), so it stays JSON-safe for `executeJavaScript`
   * serialization like every other snapshot field; `transcriptTail` does not
   * touch it. Read-only projection — the facade adds zero wire messages by

   */
  git: GitSlice;
  /**

   * same read-only, zero-new-wire-message discipline as `git` above. This is
   * the sanctioned data-only substitute for a Settings-DOM facade: the
   * Environment pane isn't otherwise visible to this snapshot (§1), so the
   * live-smoke asserts wiring via this field instead of pixels.
   */
  envStatus: WireEnvStatus | null;
  /**
   * Prompt-queue projection (design/slice-P7.14-cut.md §5 W3), additive at the
   * end of this interface per the P7.12 draft-slot discipline. Attachments are
   * stripped to a count — base64 `ImageAttachment` payloads never enter a

   * staying function-free, not size).
   */
  promptQueue: readonly { id: string; text: string; imageCount: number }[];
  queuePaused: boolean;
  /**
   * Codex-fixes TASK.42 (cut §3.7, additive-optional; frozen in C0b, WIRED in
   * B5-auto). Present only for a non-core engine session (mirrors
   * `host_ready.engine`'s "absent = legacy core" projection discipline, cut
   * §2(f)) — an existing core-session snapshot is byte-untouched until
   * B5-auto populates this from the live store's `engine`/preset state.
   */
  engine?: { id: EngineId; model?: string; activePresetId?: string };
  /**
   * TASK.33 W8 armed Try-again offer projection: mirrors the store's `retry`
   * field, null when nothing is offered. Same attachment-stripping discipline
   * as `promptQueue` above (`imageCount`, not the base64 payloads) — `text`
   * is kept as-is since it's just the user's own prompt, already visible
   * verbatim in `transcript`'s matching `user_text` block.
   */
  retryOffer: { loopEndBlockId: string; text: string; imageCount: number } | null;
}

/** Return shape of `snapshot()` (design §3.2). */
export interface SnapshotJson {
  tabs: TabInfo[];
  activeTabId: string | null;
  states: Record<string, TabStateSnapshot>;
  /**
   * Reference copy of tabs-store's hidden-projects set (design/slice-GUI-P1-cut.md
   * §2F.5/§2F.1). Shell-level, NOT per-tab — `TabStateSnapshot` stays unchanged;
   * a hidden workspace with an open tab self-heals out of this set via `addTab`

   */
  hiddenWorkspaces: readonly string[];
}

export interface FacadeOk {
  ok: true;
}

export interface FacadeErr {
  ok: false;
  reason: string;
}

export type FacadeResult = FacadeOk | FacadeErr;

/** `subagentsEditorPreview`'s ok-shape (design §4 W4): the REAL final child system prompt + effective tool list a draft would spawn with (design §2-D4), or a typed refusal. */
export type SubagentsPreviewFacadeResult =
  | { ok: true; systemPrompt: string; effectiveTools: string[] }
  | { ok: false; reason: string };

/** `subagentsEditorSave`'s ok-shape (design §4 W4): a rejected save carries the SAME `issues[]` the editor dialog itself would render below the refusal message (design §2-D7's stricter-than-loader validation), unlike the plain `FacadeErr` every other driver above uses. */
export type SubagentsEditorSaveResult = { ok: true } | { ok: false; reason: string; issues?: string[] };

/**
 * `transcriptScrollState`'s ok-shape (design/slice-P7.3-cut.md §3.3): a live
 * read of the `.message-list` scroll container's geometry, with `atBottom`
 * computed via the SAME exported `isAtBottom` MessageList.tsx itself uses for
 * sticky-follow — single source of truth, so this probe cannot drift from the
 * product predicate it is verifying.
 */
export interface TranscriptScrollState {
  ok: true;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atBottom: boolean;
  jumpVisible: boolean;
}

/**
 * Structural view of a scrollable element (assignable from a real
 * `HTMLDivElement`, fakeable in tests with a plain object — same DI
 * discipline as `AnycodeBridge`). `scrollTop` is mutable: `transcriptScrollTo`
 * assigns it directly so the container's REAL `onScroll` handler fires (design
 * §3.3 — the probe exercises the product recompute path, not a
 * re-implementation of it).
 */
export interface ScrollContainer {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * `todoPanelState`'s ok-shape (design/slice-P7.11-cut.md §3 W2): a live DOM
 * read of the `TodoPanel.tsx` overlay, same "no mirrored state" discipline as
 * `TranscriptScrollState` — `visible: false` (with the other fields at their
 * defaults) is a normal, valid reading (no TodoWrite yet / panel unmounted),
 * NOT an error; `ok: false` is reserved for the structural refusals shared
 * with the scroll probe (`tab_not_active` / `no_transcript`).
 */
export interface TodoPanelState {
  ok: true;
  visible: boolean;
  header: string | null;
  panelCollapsed: boolean;
  completedRow: string | null;
  items: Array<{ glyph: "done" | "active" | "pending"; content: string }>;
}

/**
 * `startScreenState`'s ok-shape (design/slice-P7.12-cut.md §5 W2, extended by
 * slice-F5-1b-cut.md §2-D4): a live read of the tabs-store draft slot
 * (`active`/`workspace`/`prompt`/`model`/`mode`) plus a DOM probe of the mounted
 * `StartScreen.tsx` card (`rendered`/`recentCount`/`projectMenuOpen`), same
 * "no mirrored state" discipline as `TodoPanelState`. `sendEnabled` is
 * computed with the EXACT same rule as `StartScreen.tsx`'s own
 * `computeSendDisabledReason` (§3-D3: a folder chosen AND a non-blank
 * prompt) — a plain field here rather than that reason string, since the
 * caller only ever needs the boolean. `model` is the draft's raw pick
 * (`null` = provider default, never re-resolved here — the resolved
 * display id/label is `StartScreen.tsx`'s own `computeModelChipDisplay`,
 * not duplicated in this probe). `recentCount` is redefined (F5#1b §2-D4):
 * it counts the `.start-recent-item` rows rendered INSIDE the project
 * popover while `projectMenuOpen` is true, and reads `0` while it's closed —
 * this falls out of the DOM structure unchanged (the popover, and every row
 * inside it, is conditionally rendered only while open), so no code change
 * was needed here, only this doc update.
 */
export interface StartScreenState {
  ok: true;
  active: boolean;
  rendered: boolean;
  workspace: string | null;
  prompt: string;
  model: string | null;
  mode: PermissionMode | null;
  sendEnabled: boolean;
  recentCount: number;
  projectMenuOpen: boolean;
  /**
   * Codex-fixes TASK.42 (cut §3.7, additive-optional; frozen in C0b, WIRED in
   * B5-auto). The draft's current engine pick + the catalog of engines the
   * start screen offers. Optional so this block's freeze adds no behavior:
   * `startScreenState()`'s existing implementation is unaffected until B5-auto
   * populates these two fields from the real draft/registry state.
   */
  engine?: EngineId;
  availableEngines?: EngineId[];
}

/** DOM accessor DI for the transcript-scroll probe (design §3.3), injectable for tests exactly like `AnycodeBridge`. */
export interface TranscriptDom {
  /**
   * The live `.message-list` scroll container for the GIVEN tab, or `null` if
   * no transcript for that exact tab is mounted (codex P7.3-F2 finding 2: a
   * background/no-longer-active tab's node must never be picked up by
   * accident during the store-update-to-React-commit gap — see
   * `realTranscriptDom` below for the matching discipline).
   */
  container(tabId: string): ScrollContainer | null;
  /** Whether the `.jump-to-latest` chip is currently in the DOM. */
  jumpButtonVisible(): boolean;
}

/**
 * DOM accessor DI for the todo-panel probe (design/slice-P7.11-cut.md §3 W2),
 * same injectable-for-tests discipline as `TranscriptDom`. Deliberately its
 * own tiny interface rather than reusing `TranscriptDom.container` (whose
 * `ScrollContainer` return type only exposes scroll geometry, not queryable
 * DOM children) — `panel()` reads the `TodoPanel.tsx` card's rendered content
 * directly and returns `null` when the card isn't mounted at all (collapsed
 * vs. absent is distinguished by the caller via `panelCollapsed`, not by this
 * DI's return value).
 */
export interface TodoPanelDom {
  panel(tabId: string): {
    header: string;
    panelCollapsed: boolean;
    completedRow: string | null;
    items: Array<{ glyph: "done" | "active" | "pending"; content: string }>;
  } | null;
}

/**
 * DOM accessor DI for the start-screen probe (design/slice-P7.12-cut.md §5
 * W2, extended by slice-F5-1b-cut.md §2-D4), same injectable-for-tests
 * discipline as `TranscriptDom`/`TodoPanelDom`. Unlike those two,
 * `StartScreen.tsx` isn't scoped to a tab (it renders in place of the whole
 * tab area while `draftActive`, App.tsx §4.6), so this queries the document
 * directly rather than a `data-tab-id`-tagged container. `projectMenuOpen`/
 * `clickProjectChip` are the F5#1b addition: the project popover's open state
 * is local component `useState` with no store action to toggle instead (same
 * posture as `ModelPillDom`/`CtxPopoverDom`'s click-driven popovers), so
 * `clickProjectChip` fires a REAL `.click()` on the project control's own
 * chip button (`.start-folder`) — the exact node a user click on the chip hits.
 */
export interface StartScreenDom {
  rendered(): boolean;
  recentCount(): number;
  /** Whether the project popover (`.start-project-menu`) is currently in the DOM. */
  projectMenuOpen(): boolean;
  /** A real `.click()` on the project control's chip button; toggles the popover via `StartScreen.tsx`'s own `onClick`. */
  clickProjectChip(): void;
}

/**
 * `modelPillState`'s ok-shape (design/slice-P7.15-cut.md §2.6 W4): a live DOM
 * read of the `ModelPill.tsx` chip/popover, same "no mirrored state"
 * discipline as `TodoPanelState`/`StartScreenState` — `present: false` (with
 * the other fields at their conservative defaults) is a normal reading (no
 * tab active yet, or `model === null` pre-`host_ready`), NOT an error;
 * `ok: false` is reserved for the one structural refusal shared with
 * `todoPanelState` (`tab_not_active` — `ModelPill` only ever mounts inside
 * the active tab's `ActiveTabBody`, App.tsx). `menuOpen`/`page` are read off
 * the DOM (the popover's open/page state is local `useState` inside the
 * component, not store-observable); every other field is computed with the
 * SAME exported pure helpers `ModelPill.tsx` itself renders with
 * (`modelDisplayName`/`modelMenuItems`/`pillLabel`/`modelPickDisabled`), so
 * this probe cannot drift from the product's own labeling/gating logic.
 */
export interface ModelPillState {
  ok: true;
  present: boolean;
  label: string | null;
  menuOpen: boolean;
  page: "root" | "model" | "effort";
  effortRowVisible: boolean;
  modelItems: { id: string; name: string }[];
  effortItems: ReasoningEffort[];
  currentModel: string | null;
  currentEffort: ReasoningEffort | null;
  modelPickDisabled: boolean;
  manageModelsDisabled: boolean;
}

/**
 * A `modelPillPick` request (design §2.6 W4): `"open"` opens the popover;
 * `"model"`/`"effort"` drive a full pick (open the popover if needed,
 * navigate to that page if needed, then click the item matching `value` —
 * a model id for `"model"`, a `ReasoningEffort` literal for `"effort"`).
 */
export type ModelPillPick = { kind: "open" } | { kind: "model"; value: string } | { kind: "effort"; value: ReasoningEffort };

/**
 * DOM accessor DI for the model-pill probe/driver (design §2.6 W4), same
 * injectable-for-tests discipline as `TranscriptDom`/`TodoPanelDom`. Unlike
 * those two, this DI is also the DRIVE surface (`clickChip`/`clickRootRow`/
 * `clickItemAt` fire real `.click()` calls on the pill's own DOM nodes — the
 * exact same elements a user's click hits, since the popover's open/page
 * state is local component `useState` with no store action to call instead;
 * precedent submitStartDraft P7.12 "one product path, not a second" is
 * honored by driving the REAL nodes rather than re-implementing the
 * component's click handlers).
 */
export interface ModelPillDom {
  /** Whether `.model-pill` is currently mounted at all. */
  mounted(): boolean;
  /** Whether `.model-pill-popover` is currently in the DOM. */
  popoverOpen(): boolean;
  /** Which sub-page is showing (meaningless when the popover is closed — callers only consult this after confirming `popoverOpen()`). */
  currentPage(): "root" | "model" | "effort";
  /** Whether the footer's "Manage models…" row currently carries `disabled` (only readable while the root page is showing; `true` otherwise — it is never reachable unless rendered). */
  manageDisabled(): boolean;
  /** A real `.click()` on the chip button (a no-op on a disabled button, exactly like a real user click). */
  clickChip(): void;
  /** A real `.click()` on the root-page row named "Model" or "Effort" (a no-op if that row isn't rendered — e.g. the Effort row when non-reasoning). */
  clickRootRow(row: "model" | "effort"): void;
  /** A real `.click()` on the Nth `.model-pill-item` in whichever sub-page is currently rendered (a no-op if out of range). */
  clickItemAt(index: number): void;
}

/**
 * `ctxPopoverState`'s ok-shape (design/slice-P7.17-cut.md F12 W4): a live DOM
 * read of the `CtxPopover` (Composer.tsx) hover/click popover, same "no
 * mirrored state" discipline as `ModelPillState`/`TodoPanelState` — `open:
 * false` (with the other fields at their empty defaults) is a normal reading
 * (the meter hasn't rendered yet — pre-`context_usage`, Composer's own
 * `ctxPercent !== null` mount gate — or the popover is simply closed), NOT an
 * error; `ok: false` is reserved for the one structural refusal shared with
 * `modelPillState` (`tab_not_active` — `CtxPopover` only ever mounts inside
 * the active tab's `Composer`). `rows` reuses Composer.tsx's own exported
 * `CtxPopoverRow` shape rather than duplicating it. `sessionTokens` is copied
 * straight off the live store's own `sessionTokens` field (`store.js`'s
 * `SessionTokens`, same read-only reference-copy discipline as
 * `TabStateSnapshot.git`/`envStatus`) rather than re-parsed from the rendered
 * `formatSessionTokensLine` text, which loses precision once a count crosses
 * the K/M formatting threshold — the DOM stays the source for
 * `open`/`headline`/`percentText`/`rows`, none of which have a raw
 * store-side counterpart.
 */
export interface CtxPopoverState {
  ok: true;
  open: boolean;
  headline: string | null;
  percentText: string | null;
  rows: CtxPopoverRow[];
  sessionTokens: SessionTokens | null;
}

/**
 * DOM accessor DI for the ctx-popover probe/driver (design F12 W4), same
 * injectable-for-tests discipline as `ModelPillDom` — `clickTrigger` fires a
 * REAL `.click()` on the meter chip (`.composer-ctx-meter`), the exact
 * element `CtxPopover`'s own `handleClick` toggles `open` from. The
 * hover-intent path (mouseenter + 150ms delay) is deliberately NOT driven
 * here: a real click is instant/deterministic and lands on the SAME `open`
 * state a hover eventually would (`CtxPopover`'s `handleClick`), so it is the
 * one product path this facade needs to reach either open or closed.
 */
export interface CtxPopoverDom {
  /** Whether `.composer-ctx-meter` (the trigger chip) is currently mounted at all. */
  mounted(): boolean;
  /** Whether `.ctx-popover` (the panel) is currently in the DOM. */
  open(): boolean;
  /** A real `.click()` on the trigger chip — toggles `open` via `CtxPopover`'s own `handleClick`. */
  clickTrigger(): void;
  /** The trigger chip's own rendered text (e.g. `"42% ctx"`), or `null` if not mounted. */
  percentText(): string | null;
  /** The open panel's headline text (`.ctx-popover-headline`), or `null` if absent/closed. */
  headline(): string | null;
  /** Every rendered category row (`.ctx-popover-row`), parsed from its label/percent text nodes; empty if closed or no rows yet. */
  rows(): { label: string; percent: number }[];
  /** Whether the panel's session-tokens line (`.ctx-popover-session`) is currently rendered — used only as a "loaded" gate; the numeric reading itself comes off the live store (see `CtxPopoverState` above). */
  sessionLineVisible(): boolean;
}

/**
 * `agentCardState`'s ok-shape (design/slice-P7.18-cut.md §4 W4): the three
 * DOM facts that are NOT already carried by the snapshot's `TranscriptBlock`
 * (§2 — `modelText`/`subagent.activity` ride the snapshot untouched, no new
 * `SnapshotJson` field this wave) — whether the card is user-expanded,
 * whether the PROMPT plaque is still collapsed (the two-level-collapse DoD
 * point, §1 invariant 1/§4 W3 point 4), and whether the Markdown RESULT
 * actually rendered a node. `feedRowCount` is included for convenience (it
 * IS derivable from the snapshot's `subagent.activity.length` +
 * `activityDropped>0`, but counting the live `<li>` rows directly proves the
 * feed really painted, not just that the store holds the data). A
 * not-yet-rendered card (unknown `toolCallId`, or the block hasn't reached
 * the transcript) is a normal, valid reading — same "no mirrored state,
 * absence is not an error" discipline as `TodoPanelState`/`CtxPopoverState`
 * — `ok: false` stays reserved for the structural refusals shared with every
 * other transcript-scoped probe (`tab_not_active`/`unknown_tab`).
 */
export interface AgentCardState {
  ok: true;
  expanded: boolean;
  promptCollapsed: boolean;
  feedRowCount: number;
  resultRendered: boolean;
}

/** Parsed read of one `.tool-call-card[data-tool-call-id]` node (design §4 W4) — mirrors `TodoPanelDom.panel`'s fully-parsed-object shape rather than `CtxPopoverDom`'s granular accessors, since this probe never drives a click. */
export interface AgentCardDomState {
  expanded: boolean;
  promptCollapsed: boolean;
  feedRowCount: number;
  resultRendered: boolean;
}

/**
 * DOM accessor DI for `agentCardState` (design §4 W4), same injectable-for-
 * tests discipline as `TodoPanelDom`. `state` returns `null` when the card
 * itself isn't in the DOM yet (transcript not mounted for this tab, OR no
 * `.tool-call-card` carries this exact `toolCallId`) — the facade turns that
 * into the valid-empty `AgentCardState` reading, never an error.
 */
export interface AgentCardDom {
  state(tabId: string, toolCallId: string): AgentCardDomState | null;
  /** A real `.click()` on the card's own `.tool-call-toggle` header button — the exact node a user click on the collapsed row fires (Agent cards default to collapsed in every status, `defaultExpanded`'s Agent-only branch, so a live smoke has no other path to the expanded body). Returns `false` (no-op) if no card with this `toolCallId` is currently rendered. */
  clickToggle(tabId: string, toolCallId: string): boolean;
}

/** `tryAgainButtonState`'s ok-shape (TASK.33 W8-FIX #2): a DOM-level truth for whether the rendered Try-again button really exists on a given `loop_end` block, so a live smoke can assert on it directly instead of trusting `retryOffer` store state alone (which proves the offer is armed, not that the button actually painted). */
export interface TryAgainButtonState {
  ok: true;
  count: number;
  visible: boolean;
  enabled: boolean;
}

/** Parsed read of one `loop_end` block's `.retry-try-again-button` children (TASK.33 W8-FIX #2) — `count` rides through uncollapsed (rather than the facade reducing it to a boolean) so the caller itself can assert "exactly one", since more than one would itself be the defect this probe exists to catch. */
export interface TryAgainButtonDomState {
  count: number;
  visible: boolean;
  enabled: boolean;
}

/**
 * DOM accessor DI for `tryAgainButtonState`/`tryAgainButtonClick` (TASK.33
 * W8-FIX #2), same injectable-for-tests discipline as `AgentCardDom`. `state`
 * returns `null` when the named `loop_end` block isn't in the DOM at all
 * (transcript not mounted for this tab, or no block carries this exact id) —
 * the facade turns that into the valid-empty `TryAgainButtonState` reading
 * (`count:0`), never an error.
 */
export interface TryAgainButtonDom {
  state(tabId: string, blockId: string): TryAgainButtonDomState | null;
  /** A real `.click()` on the block's own `.retry-try-again-button` — the exact node the rendered button's `onClick` fires from (App.tsx's `dispatchTryAgain`), unlike the `tryAgain` facade method above which calls `dispatchTryAgain` directly. Returns `false` (no-op) if the block isn't rendered, or doesn't carry exactly one such button. */
  click(tabId: string, blockId: string): boolean;
}

/**
 * `settingsState()`'s shape (design/slice-P7.16-cut.md §5 W4): a live read
 * that deliberately mixes two sources — `permissions.groups` comes from the
 * settings-store snapshot (the persisted source of truth, same discipline as
 * `TabStateSnapshot.git`/`envStatus` riding the live store read-only), while
 * `open`/`activePane`/`panesVisible`/`searchQuery` are read off the DOM (the
 * dialog's open state and the rail's active/visible panes are local component
 * `useState` inside `SettingsScreen`/`SettingsDialog`, not store-observable —
 * same posture as `ModelPillState.menuOpen`/`page`). `groups`/`rules` are
 * computed with the SAME exported pure helpers `PermissionsEditor.tsx` itself
 * renders with (`groupAlwaysAllowRules`/`ruleHasPattern`/`ruleDisplayPattern`),
 * so this probe cannot drift from the on-screen grouping/"all uses" logic.
 */
export interface SettingsPermissionRuleView {
  pattern: string | null;
  display: string;
}
export interface SettingsPermissionGroupView {
  toolName: string;
  rules: SettingsPermissionRuleView[];
}
export interface SettingsStateResult {
  open: boolean;
  activePane: string | null;
  panesVisible: string[];
  searchQuery: string;
  permissions: { groups: SettingsPermissionGroupView[] };
}

/**
 * DOM accessor DI for the Settings probe/driver (design §5 W4), same
 * injectable-for-tests discipline as `ModelPillDom` — the drive methods fire
 * real `.click()`/value-set calls on the SAME nodes a user would touch (the
 * gear trigger, the Back-to-app row, the rail tabs, the manual-add form's
 * inputs/button, a rule row's remove button), never a synthetic store poke,
 * so the smoke exercises the exact user path (including the W1-FIX Bash
 * sanitizer, which only fires from `PermissionsEditor`'s real `handleAdd`).
 */
export interface SettingsDom {
  /** Whether the fullscreen `.settings-screen` is currently mounted at all (the dialog is open). */
  mounted(): boolean;
  /** The `SettingsPaneId` of the currently `aria-selected` rail tab, or `null` if none is (unreachable while `mounted()` is true — every render always selects one visible pane). */
  activePane(): string | null;
  /** The `SettingsPaneId`s of every rail tab currently rendered, in rail order (already narrowed by the search filter). */
  panesVisible(): string[];
  /** The live value of the rail's search input. */
  searchQuery(): string;
  /** A real `.click()` on the sidebar's gear trigger (`.sidebar-settings`) — the same button `onOpenSettings` fires from. */
  clickSidebarSettings(): void;
  /** A real `.click()` on the rail's "← Back to app" row (`.settings-back`) — the same `onClose` a real click fires. */
  clickBackToApp(): void;
  /** A real `.click()` on the rail tab for `paneId`, or a no-op (returns `false`) if that pane isn't currently rendered (filtered out by search). */
  clickPaneTab(paneId: string): boolean;
  /** Sets the manual-add form's tool-name input to `value` via a real React-observed value set, or returns `false` if the form isn't currently rendered (wrong pane active). */
  fillPermissionTool(value: string): boolean;
  /** Sets the manual-add form's pattern input to `value` the same way — a no-op if the form isn't rendered. */
  fillPermissionPattern(value: string): void;
  /** The manual-add form's tool-name input's live value (used as the post-click "did it clear" commit signal). */
  permissionToolInputValue(): string;
  /** Whether the manual-add form's Add button is currently enabled. */
  canSubmitPermissionAdd(): boolean;
  /** A real `.click()` on the manual-add form's Add button. */
  clickPermissionAdd(): void;
  /** A real `.click()` on the rule row whose remove button carries this EXACT `aria-label` (computed by `ruleRemoveAriaLabel`, same byte-parity discipline as the label reads above); returns `false` if no such row is rendered. */
  clickPermissionRemove(ariaLabel: string): boolean;
  /** Whether a rule row with this `aria-label` is still in the DOM (the post-click "did it disappear" commit signal). */
  permissionRemoveRowExists(ariaLabel: string): boolean;
}

/**
 * `mcpPaneState()`'s shape (design/slice-P7.19-cut.md §4 W4): a live DOM read
 * of the mounted `McpServersPane.tsx` — dedicated probe route, `GET /state`
 * and `settingsState()` stay byte-untouched (design §3 byte-lock). Same "no
 * mirrored state" discipline as `SettingsStateResult`: an unmounted pane
 * (Settings closed, or a different pane selected) reads as the empty defaults
 * below, not an error. `rows` covers BOTH the "Configured servers" and "From
 * .mcp.json" sections in the SAME DOM order they render, since the pane's own
 * config-view join (not this probe) is what decides section membership.
 * `dotKind`/`enabled` are read straight off the row's own `mcp-dot-<kind>`
 * class (`describeMcpConfigRow` — this probe cannot drift from the on-screen
 * status dot); `commandLine` is read off the row's own `title` attribute
 * (already carrying the exact `McpConfigEntryView.commandLine` string, W3),
 * not re-parsed from the rendered `"stdio · …"` text. `importCandidates`/
 * `consentChecked` are populated only while the import dialog is open — a
 * closed dialog reads as `importOpen:false` with both at their empty
 * defaults, mirroring `CtxPopoverState`'s "closed panel, empty rows" posture.
 */
export interface McpPaneRowState {
  name: string;
  source: McpConfigSource;
  enabled: boolean;
  dotKind: string;
  toolsBadge: string | null;
  commandLine: string;
}
export interface McpPaneImportCandidateState {
  harness: McpHarnessKind;
  name: string;
  checked: boolean;
  alreadyConfigured: boolean;
}
export interface McpPaneState {
  rows: McpPaneRowState[];
  problems: number;
  importOpen: boolean;
  importCandidates: McpPaneImportCandidateState[];
  consentChecked: boolean;
}

/**
 * DOM accessor DI for the MCP Servers pane probe/driver (design §4 W4), same
 * injectable-for-tests discipline as `SettingsDom`/`CtxPopoverDom`. The drive
 * methods fire real `.click()`/checkbox-toggle calls on the SAME nodes a user
 * would touch (a row's enable switch, the header import button, an import
 * candidate's own checkbox, the consent checkbox, the dialog's Apply button)
 * — no synthetic store poke, since the pane's mutations all round-trip
 * through the real `McpConfigBridge` the component itself calls.
 */
export interface McpPaneDom {
  /** Whether `.mcp-pane` is currently mounted (Settings open with the "mcp" pane selected). */
  mounted(): boolean;
  /** Every `.mcp-row` currently rendered, in DOM order (configured section then the read-only ".mcp.json" section). */
  rows(): McpPaneRowState[];
  /** One row's live `enabled` reading (derived from its dot class, same as `rows()`), or `undefined` if no row with this exact name is rendered. */
  rowEnabled(name: string): boolean | undefined;
  /** A real `.click()` on the named row's enable/disable switch; `false` if no such row is rendered or the row has no switch at all (a read-only `.mcp.json` row). */
  clickRowToggle(name: string): boolean;
  /** Direct children of `.mcp-pane` that are a `.mcp-problem-strip` (excludes the import dialog's OWN scan-problem strips, a distinct list). */
  problemCount(): number;
  /** Whether `.mcp-import-dialog` is currently in the DOM. */
  importOpen(): boolean;
  /** Whether the open dialog's scan has resolved (even to zero candidates) — `data-mcp-scan-loaded` on its body, set the instant `scan !== null`. */
  importScanLoaded(): boolean;
  /** Every `.mcp-import-row` currently rendered in the open dialog. */
  importCandidates(): McpPaneImportCandidateState[];
  /** The open dialog's single consent checkbox ("Copy secret values…"), or `false` if the dialog isn't open. */
  consentChecked(): boolean;
  /** Clicks the named candidate's own checkbox until it reads `checked`; `false` if no such candidate row is rendered. */
  setCandidateChecked(name: string, checked: boolean): boolean;
  /** Clicks the consent checkbox until it reads `checked` (a no-op if already there, or if the dialog isn't open). */
  setConsentChecked(checked: boolean): void;
  /** A real `.click()` on the header's "Import MCP servers" button. */
  clickImportButton(): void;
  /** A real `.click()` on the open dialog's Apply button; `false` if the dialog isn't open or the button is currently `disabled` (nothing selected). */
  clickApplyButton(): boolean;
  /** A cheap change-detection signature of the dialog's post-apply results list (`""` before any apply) — used to await an in-flight apply's commit without re-deriving its content. */
  importResultsSignature(): string;
}

/**
 * `skillsPaneState()`'s shape (design/slice-P7.20-cut.md §5 W4): a live DOM
 * read of the mounted `SkillsPane.tsx` — a DEDICATED probe route, `GET
 * /state` and `settingsState()` stay byte-untouched (§4 custody). Same "no
 * mirrored state" discipline as `McpPaneState`: an unmounted pane (Settings
 * closed, or a different pane selected) reads as the empty defaults below,
 * not an error. `rows` covers every row across BOTH groups (Workspace/
 * Personal, then Plugin) in the SAME DOM order they render — the pane's own
 * `partitionSkillRows` join (not this probe) decides group membership.
 * `sourceKind`/`enabled` are read straight off the row's own
 * `data-skill-source`/`data-skill-enabled` attributes (`SkillRowItem` — this
 * probe cannot drift from the on-screen badge/switch state); `hasToggle` is
 * `true` only for a row that actually renders the enable/disable switch (a
 * read-only plugin row has none). `importCandidates` is populated only while
 * the import dialog is open — a closed dialog reads as `importOpen:false`
 * with an empty list, mirroring `McpPaneState`'s closed-dialog posture (no
 * `consentChecked` here — design §2 D2, skills import has no separate
 * consent gate, the per-candidate checkbox IS the consent act).
 */
export interface SkillsPaneRowState {
  name: string;
  sourceKind: SkillSourceKind;
  enabled: boolean;
  hasToggle: boolean;
}
export interface SkillsPaneImportCandidateState {
  id: string;
  harness: SkillHarnessKind;
  name: string;
  checked: boolean;
  needsConversion: boolean;
  alreadyPresent: boolean;
}
export interface SkillsPaneState {
  rows: SkillsPaneRowState[];
  problems: number;
  importOpen: boolean;
  importCandidates: SkillsPaneImportCandidateState[];
}

/**
 * DOM accessor DI for the Skills pane probe/driver (design §5 W4), same
 * injectable-for-tests discipline as `McpPaneDom`. The drive methods fire
 * real `.click()`/checkbox-toggle calls on the SAME nodes a user would touch
 * (a row's enable switch, the row's delete-then-confirm buttons, the header
 * import button, an import candidate's own checkbox, the dialog's scope
 * radio, the dialog's Apply button) — no synthetic bridge poke, since the
 * pane's mutations all round-trip through the real `SkillsBridge` the
 * component itself calls.
 */
export interface SkillsPaneDom {
  /** Whether `.skills-pane` is currently mounted (Settings open with the "skills" pane selected). */
  mounted(): boolean;
  /** Every `.skills-row` currently rendered, in DOM order (Workspace/Personal group then the read-only Plugin group). */
  rows(): SkillsPaneRowState[];
  /** One row's live `enabled` reading, or `undefined` if no row with this exact name is rendered. */
  rowEnabled(name: string): boolean | undefined;
  /** Whether a row with this exact name is currently rendered at all (the post-delete "did it disappear" commit signal). */
  rowExists(name: string): boolean;
  /** A real `.click()` on the named row's enable/disable switch; `false` if no such row is rendered or the row has no switch at all (a read-only plugin row). */
  clickRowToggle(name: string): boolean;
  /** A real `.click()` on the named row's trash icon (opens the inline "Delete "<name>"?" confirm row); `false` if no such row/button is rendered. */
  clickRowDelete(name: string): boolean;
  /** Whether the named row's inline delete-confirm row is currently rendered (the post-click commit signal `clickRowDelete` polls for before the confirm button exists to click). */
  confirmDeleteVisible(name: string): boolean;
  /** A real `.click()` on the named row's confirm-row "Delete" button; `false` if the confirm row isn't rendered. */
  clickRowConfirmDelete(name: string): boolean;
  /** Direct children of `.skills-pane` that are a `.skills-problem-strip` (excludes the import dialog's OWN scan-problem strips, a distinct list sharing only the unprefixed `mcp-problem-strip` class). */
  problemCount(): number;
  /** Whether `.skills-import-dialog` is currently in the DOM. */
  importOpen(): boolean;
  /** Whether the open dialog's scan has resolved (even to zero candidates) — `data-skills-scan-loaded` on its body, set the instant `scan !== null`. */
  importScanLoaded(): boolean;
  /** Every `.mcp-import-row` currently rendered in the open dialog (skills reuses the mcp-import-row CSS vocabulary, tagged with skills-specific `data-skills-import-*` attributes). */
  importCandidates(): SkillsPaneImportCandidateState[];
  /** Clicks the named candidate's own checkbox (identified by its stable `id`, never by name alone — design §5 W2 note) until it reads `checked`; `false` if no such candidate row is rendered. */
  setCandidateChecked(id: string, checked: boolean): boolean;
  /** Clicks the dialog's "Import into" scope radio for `scope` until it reads checked; a no-op if the dialog isn't open or the radio is already there. */
  setImportScope(scope: SkillScope): void;
  /** A real `.click()` on the header's "Import skills" button. */
  clickImportButton(): void;
  /** A real `.click()` on the open dialog's Apply button; `false` if the dialog isn't open or the button is currently `disabled` (nothing selected). */
  clickApplyButton(): boolean;
  /** A cheap change-detection signature of the dialog's post-apply results list (`""` before any apply) — same rationale as `McpPaneDom.importResultsSignature`. */
  importResultsSignature(): string;
}

/**
 * `subagentsPaneState()`'s shape (design/slice-P7.21-cut.md §4 W4): a live DOM
 * read of the mounted `SubagentsPane.tsx` — a DEDICATED probe route, `GET
 * /state`/`settingsState()`/`mcpPaneState()`/`skillsPaneState()` stay
 * byte-untouched (§4 custody: dedicated route family). Same "no mirrored
 * state" discipline as the Skills pane probe above: an unmounted pane (Settings
 * closed, or a different pane selected) reads as the empty defaults below, not
 * an error. `rows` covers every row across all three groups (Built-in -> User
 * -> Plugin, design §1 group order) in the SAME DOM order they render;
 * `sourceKind` is read straight off the row's own `data-subagent-source`
 * attribute (`SubagentsPane.tsx`), `toolsBadge`/`description` off the row's own
 * badge/description text nodes (byte-parity with the on-screen row, no
 * re-derivation), and `editable` off whether the row renders a mutation
 * controls cell at all (built-in/plugin rows render none). `editor` is
 * populated only while the in-app editor dialog is open — a closed editor
 * reads as `{open:false, mode:null, tab:null, ...blank fields}`, mirroring the
 * closed-dialog posture of `McpPaneState`/`SkillsPaneState`.
 */
export interface SubagentsPaneRowState {
  name: string;
  sourceKind: SubagentSourceKind;
  toolsBadge: string;
  description: string;
  /** false for `builtin` and `plugin` rows — no mutation affordance rendered (design §2-D2). */
  editable: boolean;
}
export interface SubagentsPaneEditorState {
  open: boolean;
  mode: "create" | "edit" | null;
  tab: "edit" | "preview" | null;
  name: string;
  description: string;
  tools: string[];
  body: string;
  canSave: boolean;
  error: string | null;
  issues: string[];
  previewLoading: boolean;
  /** The rendered final child system prompt (design §2-D4's REAL builder), or `null` before a preview has ever been fetched. */
  previewSystemPrompt: string | null;
  /** Parsed from the preview tab's "Effective tools: a, b, c" / "Effective tools: none" caption; `null` before a preview has ever been fetched. */
  previewEffectiveTools: string[] | null;
}
export interface SubagentsPaneState {
  rows: SubagentsPaneRowState[];
  problems: number;
  editor: SubagentsPaneEditorState;
}

/** The closed-editor reading (design §4 W4) — same "valid empty defaults, not an error" posture as `SkillsPaneState`'s closed-dialog shape. */
function blankSubagentsEditorState(): SubagentsPaneEditorState {
  return {
    open: false,
    mode: null,
    tab: null,
    name: "",
    description: "",
    tools: [],
    body: "",
    canSave: false,
    error: null,
    issues: [],
    previewLoading: false,
    previewSystemPrompt: null,
    previewEffectiveTools: null,
  };
}

/**
 * DOM accessor DI for the Subagents pane probe/driver (design §4 W4), same
 * injectable-for-tests discipline as `SkillsPaneDom`. The drive methods fire
 * real `.click()`/native-value-setter calls on the SAME nodes a user would
 * touch (the header's create button, a row's edit/delete/reveal buttons, the
 * editor dialog's name/description/body fields and tool chips, its Edit/Preview
 * tabs, its Save button) — no synthetic bridge poke, since the pane's own
 * mutations all round-trip through the real `SubagentsBridge` the component
 * itself calls. This is a read-only DOM-driving layer over `SubagentsPane.tsx`
 * exactly as it ships (W4 adds NO `data-*` attribute to that component beyond
 * what W3 already stamped) — field identification for the name/description
 * inputs (which carry no `aria-label`/`id`) is done structurally, by walking
 * to the `.settings-field` whose own `.settings-field-label` text matches.
 */
export interface SubagentsPaneDom {
  /** Whether `.subagents-pane` is currently mounted (Settings open with the "subagents" pane selected). */
  mounted(): boolean;
  /** Every row across all three groups, in DOM order. */
  rows(): SubagentsPaneRowState[];
  /** Whether a row with this exact name is currently rendered at all (the post-delete "did it disappear" commit signal). */
  rowExists(name: string): boolean;
  /** A real `.click()` on the header's "Create subagent" button. */
  clickCreateButton(): void;
  /** A real `.click()` on the named row's Edit (pencil) button; `false` if no such row/button is rendered (a built-in/plugin row has none). */
  clickRowEdit(name: string): boolean;
  /** A real `.click()` on the named row's trash icon (opens the inline "Delete "<name>"?" confirm row); `false` if no such row/button is rendered. */
  clickRowDelete(name: string): boolean;
  /** Whether the named row's inline delete-confirm row is currently rendered. */
  confirmDeleteVisible(name: string): boolean;
  /** A real `.click()` on the named row's confirm-row "Delete" button; `false` if the confirm row isn't rendered. */
  clickRowConfirmDelete(name: string): boolean;
  /** Direct children of `.subagents-pane` that are a `.skills-problem-strip`. */
  problemCount(): number;
  /** Whether the editor dialog (`.subagents-editor-dialog`) is currently in the DOM. */
  editorOpen(): boolean;
  /** "create" | "edit", read off the dialog's own `aria-label`; `null` while unmounted. */
  editorMode(): "create" | "edit" | null;
  /** "edit" | "preview", read off the tab with `aria-selected="true"`; `null` while unmounted. */
  editorTab(): "edit" | "preview" | null;
  /** A real `.click()` on the "Edit" tab button; `false` while unmounted. */
  clickEditTab(): boolean;
  /** A real `.click()` on the "Preview" tab button; `false` while unmounted. */
  clickPreviewTab(): boolean;
  /** Current live values of the Name/Description/Body fields + the selected tool chips; `null` while unmounted. */
  fieldValues(): { name: string; description: string; tools: string[]; body: string } | null;
  /** Native-setter + dispatched `input` event on the Name field (design §5 W4's `setNativeInputValue` discipline); `false` while unmounted. */
  setName(value: string): boolean;
  setDescription(value: string): boolean;
  setBody(value: string): boolean;
  /** Clicks tool chip checkboxes until the selected set reads EXACTLY `tools` (order-insensitive); `false` while unmounted. */
  setTools(tools: readonly string[]): boolean;
  /** Whether the preview tab's own `data-subagents-preview-loading` reads `"true"`. */
  previewLoading(): boolean;
  /** The rendered `<pre>` system-prompt text, or `null` (no result yet / not on the preview tab / editor closed). */
  previewPromptText(): string | null;
  /** The rendered "Effective tools: ..." caption line, or `null`. */
  previewToolsLine(): string | null;
  /** Whether the Save button is currently enabled (present + not `disabled`). */
  canSave(): boolean;
  /** A real `.click()` on the Save button; `false` if disabled or the dialog isn't open. */
  clickSave(): boolean;
  /** A real `.click()` on the Cancel button; a no-op if the dialog isn't open. */
  clickCancel(): void;
  /** The refusal message text (first text node of `.settings-env-warning`, excluding the issues list), or `null`. */
  errorText(): string | null;
  /** Every `<li>` of the `.subagents-issue-list`, in order. */
  issues(): string[];
}


/**
 * `profilePaneState()`'s shape (design/slice-P7.22-cut.md §4 W4): a live DOM
 * read of the mounted `ProfilePane.tsx` — a DEDICATED probe route, `GET
 * /state`/`settingsState()`/`mcpPaneState()`/`skillsPaneState()`/
 * `subagentsPaneState()` stay byte-untouched (§4 custody: dedicated route
 * family). Same "no mirrored state" discipline as the Subagents pane probe
 * above: an unmounted pane (Settings closed, or a different pane selected)
 * reads as the empty defaults below, not an error — likewise the pre-fetch
 * "Loading profile…" moment (the `.profile-pane` root is mounted but
 * `ProfileBody` has not rendered yet) reads as `mounted:true` with every
 * other field at its empty default, exactly like an unmounted pane; the
 * smoke's own polling loop is what distinguishes "still loading" from
 * "genuinely empty" (same posture as the Skills pane probe's import-scan
 * poll). `tiles`/`insights`/`topTools` are read straight off the rendered
 * tile captions/values, insight label/value rows, and top-tools row names
 * (`ProfilePane.tsx`'s own `buildProfileTiles`/`ActivityInsights`/
 * `topToolRows` output, byte-parity with the on-screen strip — this probe
 * cannot drift from what a user actually sees) rather than re-deriving them
 * from a mirrored `ProfileStatsView`. `heatmapNonEmptyCells` counts rendered
 * `.profile-heatmap-cell` nodes whose own intensity-bucket class is NOT
 * `profile-heatmap-bucket-0` — bucket 0 is reserved for both zero-token real
 * days AND every grid-alignment padding cell (`buildHeatmapCells`), so this
 * is exactly "how many days in the 12-month window actually have tokens",
 * with no need to separately filter padding. `telemetryEnabled`/
 * `killSwitchActive` are read off the toggle switch's own `aria-checked`/
 * `disabled` attributes (`TelemetryToggleBlock`) — the switch is rendered in
 * every branch that carries a non-null view (i.e. every branch but
 * `io-error`), so `disabled` is a faithful `killSwitchActive` reading
 * whenever it exists at all. `emptyStateHero`/`frozenBanner` are read off
 * `.profile-empty-hero[data-profile-branch="hero"]` / `.profile-banner`
 * respectively (`computeProfileBranch`'s own DOM markers, byte-parity with
 * the branch a real render picked).
 */
export interface ProfilePaneTileState {
  label: string;
  value: string;
}
export interface ProfilePaneInsightsState {
  totalSessions: number;
  totalRuns: number;
  toolCalls: number;
  subagentRuns: number;
  mostUsedModel: string;
}
export interface ProfilePaneState {
  /** Whether `.profile-pane` is currently mounted at all (Settings open with the "profile" pane selected) — see the class doc above re: the loading moment. */
  mounted: boolean;
  tiles: ProfilePaneTileState[];
  insights: ProfilePaneInsightsState;
  topTools: string[];
  heatmapNonEmptyCells: number;
  telemetryEnabled: boolean;
  killSwitchActive: boolean;
  truncated: boolean;
  /** True only for the `hero` branch (no-data + disabled) — `io-error` reads as `false` here (a distinct, refusal-carrying branch this probe does not conflate with the empty-history hero). */
  emptyStateHero: boolean;
  /** True only for the `banner` branch (data present + disabled — "Telemetry is off — stats are frozen"). */
  frozenBanner: boolean;
}

/** The empty-defaults reading (design §4 W4) — same "valid empty defaults, not an error" posture as `blankSubagentsEditorState`. */
function blankProfilePaneState(): ProfilePaneState {
  return {
    mounted: false,
    tiles: [],
    insights: { totalSessions: 0, totalRuns: 0, toolCalls: 0, subagentRuns: 0, mostUsedModel: "" },
    topTools: [],
    heatmapNonEmptyCells: 0,
    telemetryEnabled: false,
    killSwitchActive: false,
    truncated: false,
    emptyStateHero: false,
    frozenBanner: false,
  };
}

/**
 * DOM accessor DI for the Profile pane probe/driver (design §4 W4), same
 * injectable-for-tests discipline as `SubagentsPaneDom`. `clickTelemetryToggle`
 * fires a REAL `.click()` on the SAME switch a user would touch — the toggle
 * round-trips through the real `ProfileBridge.setTelemetry` the component
 * itself calls (main IPC + atomic user-config write), not a synthetic bridge
 * poke.
 */
export interface ProfilePaneDom {
  /** Whether `.profile-pane` is currently mounted (Settings open with the "profile" pane selected). */
  mounted(): boolean;
  /** `data-profile-branch` off `.profile-empty-hero`, or `null` when that element isn't rendered (banner/normal branch, or still loading). */
  branch(): string | null;
  /** Whether `.profile-banner` ("stats are frozen") is currently rendered. */
  bannerVisible(): boolean;
  /** Whether the `.profile-truncated-note` is currently rendered. */
  truncatedVisible(): boolean;
  /** Every `.profile-tile`, in ref order (Lifetime tokens / Peak tokens / Longest task / Current streak / Longest streak); empty outside the banner/normal branches. */
  tiles(): ProfilePaneTileState[];
  /** Every `.profile-insight-row`, in ref order; empty outside the banner/normal branches. */
  insightRows(): { label: string; value: string }[];
  /** The "Top tools" column's row names, in rendered (count-desc) order. */
  topToolNames(): string[];
  /** Count of rendered heatmap cells whose intensity bucket is non-zero (see class doc). */
  heatmapNonEmptyCellCount(): number;
  /** The telemetry toggle switch's live `aria-checked`/`disabled` reading, or `null` if the switch isn't rendered at all (the `io-error` branch, or still loading). */
  telemetrySwitch(): { checked: boolean; disabled: boolean } | null;
  /** A real `.click()` on the toggle switch; `false` if it isn't rendered. */
  clickTelemetryToggle(): boolean;
}

/**
 * `shortcutsPaneState()`'s row shape (design/slice-P7.24-cut.md §4 W4): a live
 * DOM read of one `KeyboardShortcutsPane.tsx` row, byte-parity with what a
 * user sees — `bindings` is each rendered badge's chord text (already run
 * through `formatBinding`, never a raw serialized chord string), `overridden`
 * mirrors the presence of the row's own Reset button, `unassigned` the
 * "Unassigned" pill, and `recording` whether this row currently owns the
 * active recording chip (suppressed while `!editable`, exactly one row at
 * a time — `KeyboardShortcutsPane`'s own `recording` state).
 */
export interface ShortcutsPaneRowState {
  action: string;
  name: string;
  description: string;
  editable: boolean;
  bindings: string[];
  overridden: boolean;
  unassigned: boolean;
  recording: boolean;
}

export interface ShortcutsPaneState {
  /** Whether `.shortcuts-pane` is currently mounted (Settings open with the "shortcuts" pane selected). */
  mounted: boolean;
  /** Live value of the search input, or `""` while unmounted. */
  query: string;
  rows: ShortcutsPaneRowState[];
  /** The active recording chip's inline refusal text ("Use ⌘/Ctrl + key" / "Reserved shortcut" / `Already used by "..."`), or `null` when no chip is showing an error (not recording, or recording with no refusal yet). */
  errorText: string | null;
}

/** The empty-defaults reading (design §4 W4) — same "valid empty defaults, not an error" posture as `blankProfilePaneState`. */
function blankShortcutsPaneState(): ShortcutsPaneState {
  return { mounted: false, query: "", rows: [], errorText: null };
}

/**
 * DOM accessor DI for the Keyboard shortcuts pane probe/driver (design §4
 * W4), same injectable-for-tests discipline as `ProfilePaneDom`. Slot indices
 * address badges by their rendered POSITION within a row (`.shortcuts-badge`,
 * in DOM order) — the SAME index `applyRecord`/`removeBinding`
 * (`KeyboardShortcutsPane.tsx`) key off, whether the badge showing at that
 * position is a normal chord or the live recording chip (which shares the
 * base `.shortcuts-badge` class but carries none of the edit/remove buttons,
 * so a click on either at a recording slot faithfully returns `false`).
 */
export interface ShortcutsPaneDom {
  mounted(): boolean;
  query(): string;
  rows(): ShortcutsPaneRowState[];
  /** The recording chip's inline text, or `null` if not currently recording. */
  recordingChipText(): string | null;
  /** A real `.click()` on the row's "+ Add" button (append a new slot); `false` if absent/disabled/row unknown. */
  clickAdd(action: string): boolean;
  /** A real `.click()` on the pencil at `slotIndex`; `false` if that badge isn't a normal (non-recording) chord badge. */
  clickEditSlot(action: string, slotIndex: number): boolean;
  /** A real `.click()` on the "×" at `slotIndex`; `false` if that badge isn't a normal (non-recording) chord badge. */
  clickRemoveSlot(action: string, slotIndex: number): boolean;
  /** A real `.click()` on the row's Reset button; `false` if absent (not overridden, or row unknown/non-editable). */
  clickReset(action: string): boolean;
}

/**
 * `slashMenuState`'s ok-shape (design/slice-P7.23-cut.md §7 W4): a live read
 * of the composer's `/`-triggered menu (Composer.tsx/SlashMenu.tsx), same "no
 * mirrored state" discipline as the other popover probes above — `open:
 * false` (with `items: []`) is a normal reading (no trigger active, or the
 * trigger closed/dismissed/zero-matched), NOT an error; `ok: false` is
 * reserved for the one structural refusal shared with `modelPillState`/
 * `ctxPopoverState` (`tab_not_active` — the composer only ever mounts inside
 * the active tab's `ActiveTabBody`). `draft` is read straight off the live
 * textarea value (doubling as the insert-assert — a selected skill row
 * replaces the slash token with `$name `, directly observable here with no
 * separate "last inserted text" field). `query` is recomputed via the SAME
 * pure `slashQueryAt` Composer.tsx itself calls every render — reusing it
 * here cannot drift from what the component derives, since both read the
 * identical (text, caret) pair off the same live textarea. `items`/
 * `selectedIndex` are read off the RENDERED `.slash-menu-row` nodes (never
 * re-filtered independently), so this probe can never disagree with what's
 * on screen; a row's `highlighted` flag is "does this row's name contain at
 * least one `<b>` match span" (`SlashMenu.tsx`'s own `renderHighlightedName`).
 */
export interface SlashMenuItemState {
  name: string;
  section: "commands" | "skills";
  sourceLabel?: string;
  disabled: boolean;
  highlighted: boolean;
}

export interface SlashMenuState {
  ok: true;
  open: boolean;
  query: string;
  selectedIndex: number;
  draft: string;
  items: SlashMenuItemState[];
}

/**
 * DOM accessor DI for the slash-menu probe/driver (design §7 W4), same
 * injectable-for-tests discipline as `ModelPillDom`/`CtxPopoverDom`.
 * `textarea()` is also the DRIVE surface `composerType`/`composerKey` act on
 * directly (a real native-setter value assignment / a real dispatched
 * `KeyboardEvent`, not a synthetic store poke — the menu's open/selection
 * state is local Composer `useState` with no store action to call instead).
 */
export interface ComposerSlashDom {
  /** The active tab's composer `<textarea>`, or `null` before `ActiveTabBody` mounts. */
  textarea(): HTMLTextAreaElement | null;
  /** Whether `.slash-menu` is currently in the DOM. */
  menuMounted(): boolean;
  /**
   * Every rendered `.slash-menu-row`, each carrying the index baked into its
   * `slash-menu-option-<n>` id (`SlashMenu.tsx`'s own per-row index — the
   * SAME index `aria-activedescendant`/`slashSelIndex` reference), in DOM
   * order. `section` is derived from DOM POSITION relative to the (at most
   * one) `.slash-menu-section` header — every row before it is `"commands"`,
   * every row at/after it is `"skills"` (`SlashMenu.tsx`'s own render order:
   * commands first, unconditionally, then the header, then skill rows).
   */
  rows(): Array<{
    index: number;
    name: string;
    section: "commands" | "skills";
    sourceLabel: string | null;
    disabled: boolean;
    selected: boolean;
    highlighted: boolean;
  }>;
}

/**
 * `lspPanelState`'s ok-shape (design/slice-P7.25-cut.md §3 W3): a live DOM
 * read of the mounted `LspPanel.tsx`, same "no mirrored state" discipline as
 * `TodoPanelState` — `open: false` (with `counts: null, servers: []`) is a
 * normal reading (the panel isn't toggled open for this tab), NOT an error;
 * `ok: false` is reserved for the one structural refusal shared with
 * `todoPanelState`/`modelPillState` (`tab_not_active` — `LspPanel` only ever
 * renders for the active tab, App.tsx). `counts` rides the SAME
 * `.lsp-panel-summary` text `formatLspSummary` renders (W2 polish); `servers`
 * is read straight off each `.lsp-server-row`'s own name/state class, so this
 * probe cannot drift from what a user actually sees.
 */
export interface LspPanelState {
  ok: true;
  open: boolean;
  counts: string | null;
  servers: Array<{ name: string; state: string }>;
}

/**
 * DOM accessor DI for the LSP-panel probe/driver (design §3 W3), same
 * injectable-for-tests discipline as `TodoPanelDom`. `panel()` returns `null`
 * when `<aside class="lsp-panel">` isn't in the DOM at all (closed) — the
 * facade turns that into the valid-empty `LspPanelState` reading, never an
 * error. `toggle()` fires a real `.click()` on the `SessionHeader` toggle
 * button (`aria-label="Toggle LSP status"`) — the exact control a user would
 * press; there is no store action to call instead without opening a second
 * path (design §1.3 discipline).
 */
export interface LspPanelDom {
  panel(): { counts: string | null; servers: Array<{ name: string; state: string }> } | null;
  toggle(): void;
}

/**
 * `hooksPanelState`'s ok-shape (design/slice-P7.25-cut.md §3 W3): a live DOM
 * read of the mounted `HooksPanel.tsx`, same "no mirrored state" discipline
 * as `LspPanelState` above — `open: false` (with `configError: null, groups:
 * []`) is a normal reading, NOT an error; `ok: false` is reserved for the
 * same `tab_not_active` structural refusal. `groups` is read straight off
 * each `.hooks-group`'s own title/count text (`HooksPanel.tsx`'s
 * `groupHooksByEvent`/`EVENT_LABELS`, whose event labels are byte-identical to
 * the `HookEvent` values), so `event` here is a real `HookEvent` string, not
 * a re-derived guess.
 */
export interface HooksPanelState {
  ok: true;
  open: boolean;
  configError: string | null;
  groups: Array<{ event: string; count: number }>;
}

/**
 * DOM accessor DI for the Hooks-panel probe/driver (design §3 W3), same
 * injectable-for-tests discipline as `LspPanelDom`. `panel()` returns `null`
 * when `<aside class="hooks-panel">` isn't in the DOM at all (closed).
 * `toggle()` fires a real `.click()` on the `SessionHeader` toggle button
 * (`aria-label="Toggle hooks"`).
 */
export interface HooksPanelDom {
  panel(): { configError: string | null; groups: Array<{ event: string; count: number }> } | null;
  toggle(): void;
}

/**
 * `checkpointPanelState`'s ok-shape (design slice-P7.26-R2-ratification.md §1
 * W3): a live DOM read of the mounted `TimelinePanel.tsx`, same "no mirrored
 * state" discipline as `LspPanelState`/`HooksPanelState` — `visible: false`
 * (with `items: []`) is a normal reading (the panel isn't toggled open for
 * this tab), NOT an error; `ok: false` is reserved for the one structural
 * refusal shared with `lspPanelState`/`hooksPanelState` (`tab_not_active` —
 * `TimelinePanel` only ever renders for the active tab, App.tsx). Unlike the
 * LSP/hooks panels (whose data streams in continuously via live wire events,
 * already resident in the session slice before the panel ever opens), the
 * checkpoint list is fetched ON DEMAND only (`checkpoint_list_request`, sent
 * from `TimelinePanel`'s own mount effect / Refresh button — ratification
 * §2.4; `checkpoint_created` events are deliberately snapshot-inert). So this
 * probe — alone among the panel-state probes — actively drives the SAME real
 * action a user would take (open the panel, or click Refresh if already
 * open) and waits for the resulting re-render to land, rather than reading
 * whatever happens to already be there.
 */
export interface CheckpointTimelineRow {
  /**
   * The checkpoint's own stable id (W3-FIX: `data-checkpoint-id`,
   * TimelinePanel.tsx), the ONLY reliable row identity — every Write-triggered
   * checkpoint's `label` is `deriveCheckpointLabel`'s first-64-chars-of-prompt
   * truncation (core), so two rows commonly COLLIDE on an identical label; a
   * caller diffing "which checkpoint is new" (e.g. a live smoke, post-rewind)
   * must key on `id`, never `label`.
   */
  id: string;
  label: string;
  age: string;
  reason: string;
}

export interface CheckpointPanelState {
  ok: true;
  visible: boolean;
  items: CheckpointTimelineRow[];
}

/**
 * DOM accessor DI for the checkpoint-timeline panel probe (design §1 W3),
 * same injectable-for-tests discipline as `LspPanelDom`/`HooksPanelDom`.
 * `panel()` returns `null` when `<aside class="timeline-panel">` isn't in the
 * DOM at all (closed). `toggle()`/`refresh()` fire real `.click()`s on the
 * SessionHeader toggle button / the panel's own Refresh button — the exact
 * two controls that can make `TimelinePanel` (re)send a
 * `checkpoint_list_request` (its mount effect / its Refresh button — see that
 * file).
 */
export interface CheckpointPanelDom {
  panel(): { items: CheckpointTimelineRow[] } | null;
  toggle(): void;
  refresh(): void;
}

/**
 * `rewindState`'s ok-shape (design §1 W3, `ok`/`reason` added W3-FIX): a
 * reference-copy read of the tab's own `lastRewindResult` (store.ts), minus
 * the ephemeral `requestId` (correlation-only, consumed by `checkpointRewind`
 * below — never a caller-facing field), plus the deterministic
 * transcript-truncation proof — the count of rendered `[data-block-id]`
 * transcript blocks (MessageList.tsx), the same DOM the transcript itself
 * renders, so this can never drift from what a user actually sees shrink
 * after a conversation-restoring rewind (ratification §1's TRANSCRIPT-SCOPED
 * clear + `session_history` rehydrate). `lastResult` is `null` before any
 * `rewind_result` has landed this session (store.ts's own initial value).
 * `ok`/`reason` mirror the HOST's real outcome verbatim (W3-FIX: codex #1 —
 * a `GET` must reflect the last rewind's TRUE disposition, e.g. a busy-reject,
 * not just "this probe read successfully").
 */
export interface RewindLastResult {
  ok: boolean;
  reason: string | null;
  conversationRestored: boolean;
  restoredPaths: number | null;
  safetyId: string | null;
}

export interface RewindStateResult {
  ok: true;
  lastResult: RewindLastResult | null;
  transcriptBlockCount: number;
}

/**
 * `checkpointRewind`'s settled-outcome shape (design §1 W3-FIX, codex #1): the
 * top-level `ok`/`reason` mirror the HOST's real disposition for the EXACT
 * `rewind_request` this call dispatched (correlated by `requestId` — see the
 * facade method below), never the "did this probe read succeed" `ok:true`
 * `RewindStateResult` carries. A rejected rewind (e.g. busy — "a turn is
 * running") settles with `ok:false` here, not a false `ok:true`.
 */
export interface CheckpointRewindResult {
  ok: boolean;
  reason: string | null;
  lastResult: RewindLastResult | null;
  transcriptBlockCount: number;
}

/**
 * DOM accessor DI for `rewindState`'s transcript-block count (design §1 W3):
 * counts rendered `[data-block-id]` nodes (MessageList.tsx `:398`) inside the
 * tab's own `data-tab-id`-tagged `.message-list` container, same exact-tabId
 * match discipline as `realTranscriptDom`/`realTodoPanelDom` above.
 * Deliberately its own tiny interface rather than extending `TranscriptDom`
 * (whose `ScrollContainer` return type exposes only scroll geometry, not
 * queryable DOM children) — same "one dedicated DI per probe" discipline as
 * `CheckpointPanelDom` above.
 */
export interface TranscriptBlockDom {
  count(tabId: string): number;
}

/* */
export interface AnycodeBridge {
  createTab(request: CreateTabRequest): Promise<CreateTabResult>;
  closeTab(tabId: string): Promise<CloseTabResult>;
  listSessions(): Promise<SessionSummary[]>;
}

/** Frozen contract (design §3.2) that `window.__anycodeAutomation` exposes to the main-process HTTP server (S3). */
export interface AutomationFacade {
  snapshot(transcriptTail?: number): SnapshotJson;
  sendPrompt(tabId: string, text: string): { ok: true; requestId: string } | FacadeErr;
  // TASK.33 W8: the same click driver as `agentCardExpand` above — no facade
  // guard of its own beyond "does an offer exist" (`retry === null` is a
  // no-op click), everything else is the REAL `dispatchTryAgain` (App.tsx)
  // the button's own onClick calls, so a live smoke exercises the exact
  // send/queue/busy decision the product makes, not a re-derived guess of it.
  tryAgain(tabId: string): FacadeResult;
  // TASK.33 W8-FIX #2: a DOM-level probe/driver pair for the Try-again
  // button, distinct from `tryAgain` above — `tryAgain` calls
  // `dispatchTryAgain` directly (a facade shortcut that bypasses the
  // rendered button's own onClick wiring entirely), while
  // `tryAgainButtonClick` fires a REAL `.click()` on the button DOM node
  // itself, so a live smoke exercises the actual render + click-handler
  // wiring, not just the dispatch function in isolation.
  tryAgainButtonState(tabId: string, blockId: string): TryAgainButtonState | FacadeErr;
  tryAgainButtonClick(tabId: string, blockId: string): FacadeResult;
  respondPermission(tabId: string, behavior: "allow" | "deny", requestId?: string): FacadeResult;
  setMode(tabId: string, mode: string): FacadeResult;
  stop(tabId: string): FacadeResult;
  selectTab(tabId: string): FacadeResult;
  resumeSession(sessionId: string): Promise<CreateTabResult>;
  closeTab(tabId: string): Promise<{ ok: boolean; reason?: string }>;
  listSessions(): Promise<SessionSummary[]>;
  // ── project (design/slice-GUI-P1-cut.md §2F.5) — each mirrors exactly one

  projectNewSession(workspace: string): Promise<CreateTabResult>; // mirror of menu item 1: bridge.createTab({kind:"new", workspace}); main is the authority (resumeSession posture)
  projectHide(workspace: string): FacadeResult; // mirror of item 2: real hideWorkspace() -> false ⇒ {ok:false, reason:"project_has_open_tabs"}
  // ── git (design §2.1c) — each method mirrors exactly one component path. ──
  gitCommand(tabId: string, command: GitCommand): { ok: true; requestId: string } | FacadeErr;
  gitStageConfirm(tabId: string, intent: GitDestructiveIntent): FacadeResult;
  gitConfirm(tabId: string): { ok: true; requestId: string } | FacadeErr;
  gitCancelConfirm(tabId: string): FacadeResult;
  gitSetPanelOpen(tabId: string, open: boolean): FacadeResult;
  gitSetView(tabId: string, view: string): FacadeResult;
  // ── transcript sticky-follow probe (design/slice-P7.3-cut.md §3.3) ──
  transcriptScrollState(tabId: string): TranscriptScrollState | FacadeErr;
  transcriptScrollTo(tabId: string, to: "top" | "bottom"): FacadeResult;
  // ── todo panel probe (design/slice-P7.11-cut.md §3 W2) ──
  todoPanelState(tabId: string): TodoPanelState | FacadeErr;
  // ── start screen (design/slice-P7.12-cut.md §5 W2) — all over the SAME
  // tabs-store draft actions / `submitStartDraft` the UI uses, no second path. ──
  startScreenState(): StartScreenState;
  startScreenOpen(workspace?: string): FacadeResult;
  startScreenSetWorkspace(workspace: string): FacadeResult;
  startScreenSetPrompt(prompt: string): FacadeResult;
  // ── task-model + project-popover (slice-F5-1b-cut.md §2-D4) — same
  // no-second-path discipline: the draft setters write through the store's
  // own actions, ToggleProjectMenu drives the real chip click. ──
  startScreenSetModel(model: string | null): FacadeResult;
  startScreenSetMode(mode: string): FacadeResult;
  // Codex-fixes TASK.42 (cut §3.7, additive; frozen in C0b, IMPLEMENTED in
  // B5-auto): renderer-plane engine pick for a not-yet-created start-screen
  // draft, same thin no-second-path discipline as startScreenSetModel above.
  // Optional so this freeze adds zero behavior — createAutomationFacade()'s
  // existing object literal stays a valid AutomationFacade without this
  // method until B5-auto wires the real draft action + main-side HTTP route.
  startScreenSetEngine?(engineId: string): Promise<FacadeResult>;
  startScreenToggleProjectMenu(open: boolean): Promise<FacadeResult>;
  startScreenSubmit(): Promise<{ ok: true; tabId: string } | { ok: false; message: string }>;
  // ── prompt queue (design/slice-P7.14-cut.md §5 W3) — all over the SAME
  // store actions Composer/PromptQueue.tsx call; `sendPrompt` above is
  // untouched (busy is not this method's business — that IS the point). ──
  queuePrompt(tabId: string, text: string): { ok: true; id: string } | FacadeErr;
  queueEdit(tabId: string, id: string, text: string): FacadeResult;
  queueDelete(tabId: string, id: string): FacadeResult;
  queueResume(tabId: string): FacadeResult;
  queueClear(tabId: string): FacadeResult;
  // ── model pill probe/driver (design/slice-P7.15-cut.md §2.6 W4) ──
  modelPillState(tabId: string): ModelPillState | FacadeErr;
  modelPillPick(tabId: string, pick: ModelPillPick): Promise<FacadeResult>;
  // ── ctx-meter popover probe/driver (design/slice-P7.17-cut.md F12 W4) ──
  ctxPopoverState(tabId: string): CtxPopoverState | FacadeErr;
  ctxPopoverOpen(tabId: string, open: boolean): Promise<FacadeResult>;
  // ── Agent card probe (design/slice-P7.18-cut.md §4 W4) — reads DOM facts
  // (expanded / prompt-collapsed / feed-row-count / result-rendered) not
  // already carried by snapshot() (§2), same read-only "no mirrored state"
  // posture as the probes above; no new SnapshotJson field. ──
  agentCardState(tabId: string, toolCallId: string): AgentCardState | FacadeErr;
  // A real click driver (design §4 W4) — Agent cards default to collapsed
  // in every status (design/slice-P7.4-cut.md §3.2), so a live smoke has no
  // other path to reach the expanded body agentCardState reads.
  agentCardExpand(tabId: string, toolCallId: string): Promise<FacadeResult>;
  // ── settings probe/driver (design/slice-P7.16-cut.md §5 W4) ──
  settingsState(): SettingsStateResult;
  settingsOpen(): Promise<FacadeResult>;
  settingsClose(): Promise<FacadeResult>;
  settingsSelectPane(paneId: string): Promise<FacadeResult>;
  settingsPermissionAdd(args: { toolName: string; pattern?: string }): Promise<FacadeResult>;
  settingsPermissionRemove(args: { toolName: string; pattern?: string }): Promise<FacadeResult>;
  // ── MCP Servers pane probe/driver (design/slice-P7.19-cut.md §4 W4) — a
  // DEDICATED probe, `snapshot()`/`settingsState()` stay byte-untouched (§3
  // byte-lock). Same "no mirrored state" discipline as the settings probe
  // above: an unmounted pane reads as the empty defaults, not an error. ──
  mcpPaneState(): McpPaneState;
  mcpToggle(name: string): Promise<FacadeResult>;
  mcpImportOpen(): Promise<FacadeResult>;
  mcpImportApply(args: { consent: boolean; names?: string[] }): Promise<FacadeResult>;
  // ── Skills pane probe/driver (design/slice-P7.20-cut.md §5 W4) — a
  // DEDICATED probe, `snapshot()`/`settingsState()`/`mcpPaneState()` stay
  // byte-untouched (§4 custody: dedicated route family). Same "no mirrored
  // state" discipline as the MCP pane probe above: an unmounted pane reads
  // as the empty defaults, not an error. `skillsImportApply`'s `ids` mirrors
  // `mcpImportApply`'s `names` (a caller-selected subset of candidate
  // IDENTITIES, never bare names — two harnesses can share a name); omitted
  // ⇒ leave the dialog's own current (default) selection as-is. ──
  skillsPaneState(): SkillsPaneState;
  skillsToggle(name: string): Promise<FacadeResult>;
  skillsDelete(name: string): Promise<FacadeResult>;
  skillsImportOpen(): Promise<FacadeResult>;
  skillsImportApply(args: { scope: SkillScope; ids?: string[] }): Promise<FacadeResult>;
  // ── Subagents pane probe/driver (design/slice-P7.21-cut.md §4 W4) — a
  // DEDICATED probe, `snapshot()`/`settingsState()`/`mcpPaneState()`/
  // `skillsPaneState()` stay byte-untouched (§4 custody). Same "no mirrored
  // state" discipline as the Skills pane probe above: an unmounted pane reads
  // as the empty defaults, not an error. `subagentsOpenEditor(name?)` opens
  // the create dialog when `name` is omitted, else the named row's edit
  // dialog; `subagentsEditorSet` drives the SAME fields the editor form
  // renders (a partial patch — only the provided keys are touched);
  // `subagentsEditorPreview` invokes the REAL `buildSubagentSystemPrompt`
  // builder through the Preview tab (design §2-D4); `subagentsEditorSave`
  // clicks Save (create or edit, whichever mode is open); `subagentsDelete`
  // mirrors `skillsDelete`'s two-click (trash icon -> confirm) discipline. ──
  subagentsPaneState(): SubagentsPaneState;
  subagentsOpenEditor(name?: string): Promise<FacadeResult>;
  subagentsEditorSet(args: { name?: string; description?: string; tools?: string[]; body?: string }): Promise<FacadeResult>;
  subagentsEditorPreview(): Promise<SubagentsPreviewFacadeResult>;
  subagentsEditorSave(): Promise<SubagentsEditorSaveResult>;
  subagentsDelete(name: string): Promise<FacadeResult>;
  // ── Profile pane probe/driver (design/slice-P7.22-cut.md §4 W4) — a
  // DEDICATED probe, `snapshot()`/`settingsState()`/`mcpPaneState()`/
  // `skillsPaneState()`/`subagentsPaneState()` stay byte-untouched (§4
  // custody). Same "no mirrored state" discipline as the Subagents pane probe
  // above: an unmounted pane (or the still-loading moment) reads as the
  // empty defaults, not an error. `profileToggleTelemetry` always flips the
  // CURRENT effective state (mirrors `ProfilePane.tsx`'s own
  // `nextTelemetryToggleValue` — there is no separate "set to X" request
  // shape, same unary posture as a real click on the switch). ──
  profilePaneState(): ProfilePaneState;
  profileToggleTelemetry(): Promise<FacadeResult>;
  // ── Slash-command menu probe/driver (design/slice-P7.23-cut.md §7 W4) — a
  // DEDICATED probe, every prior probe above stays byte-untouched. `draft`
  // doubles as the insert-assert (§7). `composerType`/`composerKey` drive the
  // REAL textarea the same way a real keystroke would (native value setter +
  // `input` event / a real dispatched `KeyboardEvent`) — the menu has no
  // store action a synthetic poke could call instead. ──
  slashMenuState(tabId: string): SlashMenuState | FacadeErr;
  composerType(tabId: string, text: string): FacadeResult;
  composerKey(tabId: string, key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape"): FacadeResult;
  // ── Keyboard shortcuts pane probe/driver (design/slice-P7.24-cut.md §4
  // W4) — a DEDICATED probe, every prior probe above stays byte-untouched.
  // `shortcutsStartRecord` mirrors a real click on a slot's pencil (or the
  // "+ Add" button when `slotIndex` is omitted — appends past the current
  // end, same posture as the pane's own Add button). `shortcutsPressChord`
  // dispatches a REAL window-level `keydown` (capture-visible, so the pane's
  // OWN capture-phase recorder sees it first, exactly like a live keystroke)
  // — a bare dispatch with no built-in settle-wait, same posture as
  // `composerKey`: while recording, the caller polls `shortcutsPaneState()`
  // afterward for the badge/error to update (the commit itself round-trips
  // through the async `setPatch` write); OUTSIDE record mode (pane
  // unmounted, or a different pane/no Settings at all) the identical call
  // exercises the REAL global shortcut path instead (App.tsx's bubble-phase
  // `matchKeymap` dispatcher) — the one seam that can prove a rebind actually
  // took effect end-to-end, not just that the Settings row displays it.
  // `shortcutsRemoveBinding`/`shortcutsReset` mirror a real click on a
  // badge's "×" / the row's Reset button, each with the same commit-race
  // `waitUntil` guard as `mcpToggle`/`skillsToggle` (async `setPatch` write
  // before the row's own rendered bindings/overridden flag actually flips). ──
  shortcutsPaneState(): ShortcutsPaneState;
  shortcutsStartRecord(action: string, slotIndex?: number): Promise<FacadeResult>;
  shortcutsPressChord(chord: { key: string; mod: boolean; shift?: boolean }): FacadeResult;
  shortcutsRemoveBinding(action: string, slotIndex: number): Promise<FacadeResult>;
  shortcutsReset(action: string): Promise<FacadeResult>;
  // ── LSP / Hooks panel probes/drivers (design/slice-P7.25-cut.md §3 W3) — the
  // harness wave for the panels' Definition of Done (§4). Same "no mirrored
  // state" discipline as the probes above: an unmounted (closed) panel reads
  // as the empty defaults, not an error; `tab_not_active` is the one
  // structural refusal, shared with `todoPanelState`/`modelPillState` (both
  // panels only ever render for the active tab). The toggle drivers click the
  // REAL `SessionHeader` buttons — no store poke, no second path. ──
  lspPanelState(tabId: string): LspPanelState | FacadeErr;
  lspPanelToggle(tabId: string): FacadeResult;
  hooksPanelState(tabId: string): HooksPanelState | FacadeErr;
  hooksPanelToggle(tabId: string): FacadeResult;
  // ── Checkpoint timeline / rewind probes+driver (design
  // slice-P7.26-R2-ratification.md §1 W3) — `checkpointPanelState` actively
  // drives the panel open/refreshed (see its doc comment above: unlike every
  // other panel-state probe, the checkpoint list is on-demand-only, nothing
  // to read until asked). `checkpointRewind` resolves its target checkpoint
  // by explicit id or by newest-first index (mirrors TimelinePanel's own
  // `sortCheckpointsNewestFirst`), dispatches the SAME `rewind_request`
  // shape `TimelinePanel.confirmRewind` sends, and returns `rewindState`
  // once the result lands. ──
  checkpointPanelState(tabId: string): Promise<CheckpointPanelState | FacadeErr>;
  rewindState(tabId: string): RewindStateResult | FacadeErr;
  checkpointRewind(
    tabId: string,
    args: { checkpointId?: string; index?: number; scope: RewindScopeWire },
  ): Promise<CheckpointRewindResult | FacadeErr>;
}

/** The real `window.anycode` bridge, resolved lazily (only read when a caller omits the `bridge` DI parameter — never at module load, so this file stays importable from a plain Node test context with no `window`). */
function realBridge(): AnycodeBridge {
  return window.anycode;
}

/**
 * The real DOM accessor (design §3.3): queries live at call time, not at
 * construction — `realTranscriptDom()` itself touches no global (`document`,
 * `window`), only the closures it returns do, so evaluating this as a default
 * parameter stays safe outside a browser (same laziness discipline as
 * `realBridge` above; tests always pass an explicit `dom` and never hit it).
 *
 * codex P7.3-F2 finding 2: matching on `.message-list` alone (the previous
 * behavior) trusted that the DOM already agreed with the tabs-store's
 * `activeTabId` by the time this runs — but `setActiveTab` flips that store
 * synchronously while the OLD active tab's `MessageList` (with the old tab's
 * own live scroll geometry) can still be the only node mounted for a render
 * tick or two. A caller whose `tabId` argument matches the (already-updated)
 * store could then read/scroll the WRONG tab's transcript. `MessageList.tsx`
 * now stamps its container with `data-tab-id` (see that file), so this
 * queries for the container tagged with the EXACT tabId requested — during
 * the gap above, no node carries that tag yet, so the read/scroll honestly
 * reports "no transcript" rather than silently touching a different tab's
 * DOM. `querySelectorAll` (not a single `querySelector` on the attribute
 * selector) also guards the pathological case of two `.message-list` nodes
 * both tagged with the same id (should never happen — one active tab is
 * mounted at a time — but a stray duplicate must refuse, not pick one blind).
 */
function realTranscriptDom(): TranscriptDom {
  return {
    container: (tabId: string) => {
      const matches = document.querySelectorAll<HTMLDivElement>(
        `.message-list[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      return matches.length === 1 ? (matches[0] ?? null) : null;
    },
    jumpButtonVisible: () => document.querySelector(".jump-to-latest") !== null,
  };
}

/**
 * The real todo-panel DOM accessor (design/slice-P7.11-cut.md §3 W2): queries
 * live at call time, same laziness discipline as `realTranscriptDom` (safe to
 * evaluate as a default parameter outside a browser; tests always pass an
 * explicit `todoPanelDom` and never reach this). Scoped to the SAME
 * `data-tab-id`-tagged `.message-list` node `realTranscriptDom` guards on, so
 * a mismatched/stale active tab never leaks a different tab's panel content.
 */
function realTodoPanelDom(): TodoPanelDom {
  return {
    panel(tabId: string) {
      const matches = document.querySelectorAll<HTMLDivElement>(
        `.message-list[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      const container = matches.length === 1 ? matches[0] : null;
      const card = container?.querySelector(".todo-panel-card") ?? null;
      if (!card) {
        return null;
      }
      const header = card.querySelector(".todo-panel-title")?.textContent ?? "";
      const panelCollapsed = card.classList.contains("todo-panel-collapsed");
      const completedRow = card.querySelector(".todo-panel-completed-toggle")?.textContent?.trim() ?? null;
      const items = Array.from(card.querySelectorAll(".todo-item")).map((item) => {
        const content = item.querySelector(".todo-content")?.textContent ?? "";
        const glyph: "done" | "active" | "pending" = item.classList.contains("todo-item-status-completed")
          ? "done"
          : item.classList.contains("todo-item-status-in_progress")
            ? "active"
            : "pending";
        return { glyph, content };
      });
      return { header, panelCollapsed, completedRow, items };
    },
  };
}

/**
 * The real start-screen DOM accessor (design/slice-P7.12-cut.md §5 W2): same
 * laziness discipline as `realTranscriptDom`/`realTodoPanelDom` (safe to
 * evaluate as a default parameter outside a browser; tests always pass an
 * explicit `startScreenDom` and never reach this).
 */
function realStartScreenDom(): StartScreenDom {
  return {
    rendered: () => document.querySelector(".start-screen") !== null,
    recentCount: () => document.querySelectorAll(".start-recent-item").length,
    projectMenuOpen: () => document.querySelector(".start-project-menu") !== null,
    clickProjectChip: () => {
      document.querySelector<HTMLButtonElement>(".start-folder")?.click();
    },
  };
}

/**
 * The real model-pill DOM accessor (design/slice-P7.15-cut.md §2.6 W4): same
 * laziness discipline as `realTranscriptDom`/`realTodoPanelDom`/
 * `realStartScreenDom` (safe to evaluate as a default parameter outside a
 * browser; tests always pass an explicit `modelPillDom` and never reach
 * this). `ModelPill` mounts at most once (only for the active tab,
 * `ActiveTabBody`), so this queries the document directly — same posture as
 * `realStartScreenDom` — rather than a `data-tab-id`-scoped query.
 */
function realModelPillDom(): ModelPillDom {
  function root(): HTMLDivElement | null {
    return document.querySelector<HTMLDivElement>(".model-pill");
  }
  function popover(): HTMLDivElement | null {
    return root()?.querySelector<HTMLDivElement>(".model-pill-popover") ?? null;
  }
  return {
    mounted: () => root() !== null,
    popoverOpen: () => popover() !== null,
    currentPage: () => {
      const pop = popover();
      if (!pop) {
        return "root";
      }
      const back = pop.querySelector(".model-pill-back");
      if (!back) {
        return "root";
      }
      return back.textContent?.trim() === "Effort" ? "effort" : "model";
    },
    manageDisabled: () => {
      const pop = popover();
      const button = pop?.querySelector<HTMLButtonElement>(".model-pill-manage");
      return button ? button.disabled : true;
    },
    clickChip: () => {
      root()?.querySelector<HTMLButtonElement>(".model-pill-chip")?.click();
    },
    clickRootRow: (row) => {
      const pop = popover();
      if (!pop) {
        return;
      }
      const wanted = row === "model" ? "Model" : "Effort";
      const rows = Array.from(pop.querySelectorAll<HTMLButtonElement>(".model-pill-row"));
      const target = rows.find((candidate) => candidate.querySelector(".model-pill-row-name")?.textContent?.trim() === wanted);
      target?.click();
    },
    clickItemAt: (index) => {
      const pop = popover();
      const items = pop?.querySelectorAll<HTMLButtonElement>(".model-pill-item");
      items?.[index]?.click();
    },
  };
}

/**
 * The real ctx-popover DOM accessor (design F12 W4): same laziness
 * discipline as `realModelPillDom` (safe to evaluate as a default parameter
 * outside a browser; tests always pass an explicit `ctxPopoverDom` and never
 * reach this). `CtxPopover` mounts at most once (only inside the active
 * tab's `Composer`, gated on `ctxPercent !== null`), so this queries the
 * document directly — same posture as `realModelPillDom`/`realStartScreenDom`
 * — rather than a `data-tab-id`-scoped query.
 */
function realCtxPopoverDom(): CtxPopoverDom {
  function trigger(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(".composer-ctx-meter");
  }
  function panel(): HTMLDivElement | null {
    return document.querySelector<HTMLDivElement>(".ctx-popover");
  }
  return {
    mounted: () => trigger() !== null,
    open: () => panel() !== null,
    clickTrigger: () => {
      trigger()?.click();
    },
    percentText: () => trigger()?.textContent?.trim() ?? null,
    headline: () => panel()?.querySelector(".ctx-popover-headline")?.textContent?.trim() ?? null,
    rows: () =>
      Array.from(panel()?.querySelectorAll<HTMLDivElement>(".ctx-popover-row") ?? []).map((row) => {
        const label = row.querySelector(".ctx-popover-row-label")?.textContent?.trim() ?? "";
        const percentText = row.querySelector(".ctx-popover-row-percent")?.textContent?.trim() ?? "";
        const percent = Number.parseFloat(percentText);
        return { label, percent: Number.isFinite(percent) ? percent : 0 };
      }),
    sessionLineVisible: () => (panel()?.querySelector(".ctx-popover-session") ?? null) !== null,
  };
}

/**
 * The real Agent-card DOM accessor (design §4 W4): same laziness discipline
 * as `realCtxPopoverDom`/`realTodoPanelDom` (safe to evaluate as a default
 * parameter outside a browser; tests always pass an explicit `agentCardDom`
 * and never reach this). Scoped to the SAME `data-tab-id`-tagged
 * `.message-list` node `realTranscriptDom`/`realTodoPanelDom` guard on, so a
 * mismatched/stale active tab never leaks a different tab's card; the card
 * itself is located by the `data-tool-call-id` `ToolCallCard.tsx` now stamps
 * on its root (§4 W4's one product-code hook, same posture as
 * `MessageList`'s own `data-tab-id`).
 */
function realAgentCardDom(): AgentCardDom {
  return {
    state(tabId, toolCallId) {
      const containers = document.querySelectorAll<HTMLDivElement>(
        `.message-list[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      const container = containers.length === 1 ? containers[0] : null;
      const card =
        container?.querySelector<HTMLDivElement>(`.tool-call-card[data-tool-call-id="${CSS.escape(toolCallId)}"]`) ??
        null;
      if (!card) {
        return null;
      }
      const plaque = card.querySelector<HTMLButtonElement>(".subagent-prompt-plaque");
      return {
        // A card only ever grows a `.tool-call-body` child while user-expanded
        // (ToolCallCard.tsx's own `{expanded && (...)}` guard) — mirrors that
        // condition rather than re-deriving it from status.
        expanded: card.querySelector(".tool-call-body") !== null,
        // No plaque rendered (no prompt text at all, or the card is still
        // collapsed) reads as collapsed — there is nothing expanded to see.
        promptCollapsed: plaque === null ? true : plaque.getAttribute("aria-expanded") !== "true",
        feedRowCount: card.querySelectorAll(".subagent-activity-row").length,
        resultRendered: card.querySelector(".tool-call-agent-result") !== null,
      };
    },
    clickToggle(tabId, toolCallId) {
      const containers = document.querySelectorAll<HTMLDivElement>(
        `.message-list[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      const container = containers.length === 1 ? containers[0] : null;
      const card =
        container?.querySelector<HTMLDivElement>(`.tool-call-card[data-tool-call-id="${CSS.escape(toolCallId)}"]`) ??
        null;
      const toggle = card?.querySelector<HTMLButtonElement>(".tool-call-toggle") ?? null;
      if (!toggle) {
        return false;
      }
      toggle.click();
      return true;
    },
  };
}

/**
 * The real Try-again-button DOM accessor (TASK.33 W8-FIX #2): same laziness
 * discipline as `realAgentCardDom` (safe to evaluate as a default parameter
 * outside a browser; tests always pass an explicit `tryAgainButtonDom` and
 * never reach this). Scoped to the SAME `data-tab-id`-tagged `.message-list`
 * node `realAgentCardDom` guards on; the `loop_end` block itself is located
 * by `data-block-id` (MessageList.tsx stamps it on every `loop_end` block,
 * same posture as `ToolCallCard`'s `data-tool-call-id`). `state`'s `count`
 * deliberately isn't collapsed to a boolean here either — this accessor is
 * the one place that would notice a rendering bug that painted the button
 * twice.
 */
function realTryAgainButtonDom(): TryAgainButtonDom {
  function block(tabId: string, blockId: string): HTMLElement | null {
    const containers = document.querySelectorAll<HTMLDivElement>(
      `.message-list[data-tab-id="${CSS.escape(tabId)}"]`,
    );
    const container = containers.length === 1 ? containers[0] : null;
    return container?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`) ?? null;
  }
  return {
    state(tabId, blockId) {
      const el = block(tabId, blockId);
      if (!el) {
        return null;
      }
      const buttons = el.querySelectorAll<HTMLButtonElement>(".retry-try-again-button");
      const only = buttons.length === 1 ? buttons[0]! : null;
      return {
        count: buttons.length,
        visible: only !== null && only.offsetParent !== null,
        enabled: only !== null && !only.disabled,
      };
    },
    click(tabId, blockId) {
      const el = block(tabId, blockId);
      const buttons = el?.querySelectorAll<HTMLButtonElement>(".retry-try-again-button") ?? [];
      if (buttons.length !== 1) {
        return false;
      }
      buttons[0]!.click();
      return true;
    },
  };
}

/**
 * The real MCP-pane DOM accessor (design §4 W4): queries live at call time,
 * same laziness discipline as `realSettingsDom` (safe to evaluate as a
 * default parameter outside a browser; tests always pass an explicit
 * `mcpPaneDom` and never reach this). `.mcp-pane` only ever mounts while
 * Settings is open with the "mcp" pane selected (`SettingsScreen.tsx`'s own
 * `{activePane === "mcp" && <McpServersPane/>}` guard), so `mounted()` is an
 * unambiguous reading.
 */
function realMcpPaneDom(): McpPaneDom {
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".mcp-pane");
  }
  function rowEl(name: string): HTMLLIElement | null {
    return pane()?.querySelector<HTMLLIElement>(`.mcp-row[data-mcp-name="${CSS.escape(name)}"]`) ?? null;
  }
  function parseRow(li: HTMLLIElement): McpPaneRowState {
    const dotMatch = /\bmcp-dot-([a-z]+)\b/.exec(li.className);
    const dotKind = dotMatch ? dotMatch[1]! : "off";
    // The source badge is the first `.mcp-badge` on line 1 that ISN'T the
    // tools-count badge (`sourceBadgeLabel` renders "Project"/"User"/"Compat",
    // which lower-cases to the exact `McpConfigSource` literal — no separate
    // data attribute needed for this one).
    const sourceBadge = li.querySelector<HTMLElement>(".mcp-row-line1 .mcp-badge:not(.mcp-badge-tools)");
    const source = (sourceBadge?.textContent ?? "").trim().toLowerCase() as McpConfigSource;
    const toolsBadgeEl = li.querySelector<HTMLElement>(".mcp-badge-tools");
    const line2 = li.querySelector<HTMLElement>(".mcp-row-line2");
    return {
      name: li.getAttribute("data-mcp-name") ?? "",
      source,
      // Disabled is the ONE dot state that can never carry a live/neutral
      // status (`describeMcpConfigRow`'s first branch) — so this is a
      // byte-parity readback of the product's own enabled/disabled split,
      // not a re-derivation of it.
      enabled: dotKind !== "off",
      dotKind,
      toolsBadge: toolsBadgeEl ? (toolsBadgeEl.textContent ?? "").trim() : null,
      // The row's own `title` attribute carries the EXACT `commandLine` string
      // (McpRowItem.tsx) — reading it avoids re-parsing the rendered
      // `"<transport> · <commandLine>"` text, which would break on a
      // commandLine containing " · ".
      commandLine: line2?.getAttribute("title") ?? "",
    };
  }
  function importDialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".mcp-import-dialog");
  }
  function candidateRow(name: string): HTMLLabelElement | null {
    return importDialog()?.querySelector<HTMLLabelElement>(`.mcp-import-row[data-mcp-import-name="${CSS.escape(name)}"]`) ?? null;
  }
  function consentInput(): HTMLInputElement | null {
    return importDialog()?.querySelector<HTMLInputElement>('.mcp-consent-row input[type="checkbox"]') ?? null;
  }
  return {
    mounted: () => pane() !== null,
    rows: () => Array.from(pane()?.querySelectorAll<HTMLLIElement>(".mcp-row") ?? []).map(parseRow),
    rowEnabled: (name) => {
      const li = rowEl(name);
      return li ? parseRow(li).enabled : undefined;
    },
    clickRowToggle: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(".settings-switch");
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    // `:scope > .mcp-problem-strip` deliberately excludes the import dialog's
    // OWN scan-problem strips (`.mcp-import-dialog .mcp-dialog-body
    // .mcp-problem-strip`), which share the same class but are a distinct list
    // (design §4 W4 probe: `problems` counts the main pane's config problems).
    problemCount: () => pane()?.querySelectorAll(":scope > .mcp-problem-strip").length ?? 0,
    importOpen: () => importDialog() !== null,
    importScanLoaded: () =>
      importDialog()?.querySelector('.mcp-dialog-body[data-mcp-scan-loaded="true"]') !== null,
    importCandidates: () =>
      Array.from(importDialog()?.querySelectorAll<HTMLLabelElement>(".mcp-import-row") ?? []).map((label) => ({
        harness: (label.getAttribute("data-mcp-import-harness") ?? "") as McpHarnessKind,
        name: label.getAttribute("data-mcp-import-name") ?? "",
        checked: label.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false,
        alreadyConfigured: label.getAttribute("data-mcp-import-already") === "true",
      })),
    consentChecked: () => consentInput()?.checked ?? false,
    setCandidateChecked: (name, checked) => {
      const input = candidateRow(name)?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!input) {
        return false;
      }
      if (input.checked !== checked) {
        input.click();
      }
      return true;
    },
    setConsentChecked: (checked) => {
      const input = consentInput();
      if (input && input.checked !== checked) {
        input.click();
      }
    },
    clickImportButton: () => {
      document.querySelector<HTMLButtonElement>('.mcp-pane .mcp-icon-button[aria-label="Import MCP servers"]')?.click();
    },
    clickApplyButton: () => {
      const button = importDialog()?.querySelector<HTMLButtonElement>(".mcp-dialog-actions .settings-button-primary");
      if (!button || button.disabled) {
        return false;
      }
      button.click();
      return true;
    },
    importResultsSignature: () =>
      Array.from(importDialog()?.querySelectorAll(".mcp-import-result") ?? [])
        .map((el) => el.textContent ?? "")
        .join("|"),
  };
}

/**
 * The real Skills-pane DOM accessor (design §5 W4): queries live at call
 * time, same laziness discipline as `realMcpPaneDom` (safe to evaluate as a
 * default parameter outside a browser; tests always pass an explicit
 * `skillsPaneDom` and never reach this). `.skills-pane` only ever mounts
 * while Settings is open with the "skills" pane selected (`SettingsScreen
 * .tsx`'s own `{activePane === "skills" && <SkillsPane/>}` guard), so
 * `mounted()` is an unambiguous reading.
 */
function realSkillsPaneDom(): SkillsPaneDom {
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".skills-pane");
  }
  function rowEl(name: string): HTMLLIElement | null {
    return pane()?.querySelector<HTMLLIElement>(`.skills-row[data-skill-name="${CSS.escape(name)}"]`) ?? null;
  }
  function parseRow(li: HTMLLIElement): SkillsPaneRowState {
    return {
      name: li.getAttribute("data-skill-name") ?? "",
      sourceKind: (li.getAttribute("data-skill-source") ?? "") as SkillSourceKind,
      // Read straight off the row's own `data-skill-enabled` attribute
      // (`SkillRowItem`) rather than the switch's `aria-checked` — a
      // read-only plugin row carries NO switch at all, so this stays a
      // valid reading (byte-parity with the snapshot's own `enabled` field)
      // even for a row `hasToggle` reports `false` for.
      enabled: li.getAttribute("data-skill-enabled") === "true",
      hasToggle: li.querySelector(".settings-switch") !== null,
    };
  }
  function importDialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".skills-import-dialog");
  }
  function candidateRow(id: string): HTMLLabelElement | null {
    return importDialog()?.querySelector<HTMLLabelElement>(`.mcp-import-row[data-skills-import-id="${CSS.escape(id)}"]`) ?? null;
  }
  return {
    mounted: () => pane() !== null,
    rows: () => Array.from(pane()?.querySelectorAll<HTMLLIElement>(".skills-row") ?? []).map(parseRow),
    rowEnabled: (name) => {
      const li = rowEl(name);
      return li ? parseRow(li).enabled : undefined;
    },
    rowExists: (name) => rowEl(name) !== null,
    clickRowToggle: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(".settings-switch");
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    clickRowDelete: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(`[aria-label="Delete ${CSS.escape(name)}"]`);
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    confirmDeleteVisible: (name) => (rowEl(name)?.querySelector(".mcp-confirm-row") ?? null) !== null,
    clickRowConfirmDelete: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(".mcp-confirm-row .settings-button-danger");
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    // `:scope > .skills-problem-strip` deliberately excludes the import
    // dialog's OWN scan-problem strips (`.mcp-import-dialog .mcp-dialog-body
    // .mcp-problem-strip`, an UNPREFIXED class shared with the main pane's
    // strip but never carrying `skills-problem-strip`) — same distinct-list
    // discipline as `McpPaneDom.problemCount`.
    problemCount: () => pane()?.querySelectorAll(":scope > .skills-problem-strip").length ?? 0,
    importOpen: () => importDialog() !== null,
    importScanLoaded: () =>
      importDialog()?.querySelector('.mcp-dialog-body[data-skills-scan-loaded="true"]') !== null,
    importCandidates: () =>
      Array.from(importDialog()?.querySelectorAll<HTMLLabelElement>(".mcp-import-row") ?? []).map((label) => ({
        id: label.getAttribute("data-skills-import-id") ?? "",
        harness: (label.getAttribute("data-skills-import-harness") ?? "") as SkillHarnessKind,
        name: label.getAttribute("data-skills-import-name") ?? "",
        checked: label.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false,
        needsConversion: label.getAttribute("data-skills-import-needs-conversion") === "true",
        alreadyPresent: label.getAttribute("data-skills-import-already") === "true",
      })),
    setCandidateChecked: (id, checked) => {
      const input = candidateRow(id)?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!input) {
        return false;
      }
      if (input.checked !== checked) {
        input.click();
      }
      return true;
    },
    setImportScope: (scope) => {
      const label = importDialog()?.querySelector<HTMLLabelElement>(`.mcp-import-scope label[data-skills-import-scope="${scope}"]`);
      const input = label?.querySelector<HTMLInputElement>('input[type="radio"]');
      if (input && !input.checked) {
        input.click();
      }
    },
    clickImportButton: () => {
      document.querySelector<HTMLButtonElement>('.skills-pane .skills-icon-button[aria-label="Import skills"]')?.click();
    },
    clickApplyButton: () => {
      const button = importDialog()?.querySelector<HTMLButtonElement>(".mcp-dialog-actions .settings-button-primary");
      if (!button || button.disabled) {
        return false;
      }
      button.click();
      return true;
    },
    importResultsSignature: () =>
      Array.from(importDialog()?.querySelectorAll(".mcp-import-result") ?? [])
        .map((el) => el.textContent ?? "")
        .join("|"),
  };
}

/**
 * Sets a value on a React-controlled `<input>` the way a real keystroke would
 * (design §5 W4): a plain `input.value = x` assignment is invisible to React
 * (it tracks the DOM property through its own descriptor, not the raw
 * setter), so a subsequent `input` event fires with the STALE value and the
 * component's `onChange` never runs. Calling the native `HTMLInputElement`
 * value setter first, then dispatching a real bubbling `input` event, is the
 * standard workaround — the manual-add form's `toolInput`/`patternInput` are
 * local `useState`, with no store action this facade could call instead (same
 * "drive the real DOM" posture as `ModelPillDom`'s click methods).
 */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Sets a value on a React-controlled `<textarea>` the way a real keystroke
 * would — same rationale/mechanism as `setNativeInputValue` above, just over
 * `HTMLTextAreaElement`'s own value descriptor (a distinct prototype from
 * `HTMLInputElement`, so the native setter must be looked up separately).
 */
function setNativeTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) {
    setter.call(textarea, value);
  } else {
    textarea.value = value;
  }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Parses `formatEffectiveToolsLine`'s rendered caption ("Effective tools: a, b, c" / "Effective tools: none") back into an array; `null` propagates a missing/absent line (SubagentsPane.tsx's own helper is the format oracle — this is its exact inverse). */
function parseEffectiveToolsLine(line: string | null): string[] | null {
  if (line === null) {
    return null;
  }
  const prefix = "Effective tools: ";
  const rest = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  if (rest === "none") {
    return [];
  }
  return rest.split(", ").filter((tool) => tool.length > 0);
}

/**
 * The real Subagents-pane DOM accessor (design §4 W4): queries live at call
 * time, same laziness discipline as `realSkillsPaneDom` (safe to evaluate as a
 * default parameter outside a browser; tests always pass an explicit
 * `subagentsPaneDom` and never reach this). `.subagents-pane` only ever mounts
 * while Settings is open with the "subagents" pane selected (`SettingsScreen
 * .tsx`'s own guard), so `mounted()` is an unambiguous reading. The Name/
 * Description fields carry no `aria-label`/`id` (SubagentsPane.tsx W3's own
 * markup) — `fieldByLabel` walks to the `.settings-field` whose own
 * `.settings-field-label` text matches, the same structural identification a
 * sighted user relies on.
 */
function realSubagentsPaneDom(): SubagentsPaneDom {
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".subagents-pane");
  }
  function rowEl(name: string): HTMLLIElement | null {
    return pane()?.querySelector<HTMLLIElement>(`.skills-row[data-subagent-name="${CSS.escape(name)}"]`) ?? null;
  }
  function parseRow(li: HTMLLIElement): SubagentsPaneRowState {
    return {
      name: li.getAttribute("data-subagent-name") ?? "",
      sourceKind: (li.getAttribute("data-subagent-source") ?? "") as SubagentSourceKind,
      toolsBadge: li.querySelector(".subagents-badge-tools")?.textContent ?? "",
      description: li.querySelector(".mcp-row-line2")?.textContent ?? "",
      // Only a User-group row renders a `.mcp-row-controls` cell at all
      // (design §2-D2 — built-in/plugin rows render NO mutation affordance).
      editable: li.querySelector(".mcp-row-controls") !== null,
    };
  }
  function dialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".subagents-editor-dialog");
  }
  function fieldByLabel(labelText: string): HTMLElement | null {
    const fields = Array.from(dialog()?.querySelectorAll<HTMLElement>(".settings-field") ?? []);
    return fields.find((el) => el.querySelector(".settings-field-label")?.textContent?.trim() === labelText) ?? null;
  }
  function nameInput(): HTMLInputElement | null {
    return fieldByLabel("Name")?.querySelector<HTMLInputElement>("input") ?? null;
  }
  function descriptionInput(): HTMLInputElement | null {
    return fieldByLabel("Description")?.querySelector<HTMLInputElement>("input") ?? null;
  }
  function bodyTextarea(): HTMLTextAreaElement | null {
    return dialog()?.querySelector<HTMLTextAreaElement>(".subagents-body-textarea") ?? null;
  }
  function toolChips(): HTMLLabelElement[] {
    return Array.from(dialog()?.querySelectorAll<HTMLLabelElement>(".subagents-tool-chip") ?? []);
  }
  function saveButton(): HTMLButtonElement | null {
    return dialog()?.querySelector<HTMLButtonElement>(".mcp-dialog-actions .settings-button-primary") ?? null;
  }
  return {
    mounted: () => pane() !== null,
    rows: () => Array.from(pane()?.querySelectorAll<HTMLLIElement>(".skills-row") ?? []).map(parseRow),
    rowExists: (name) => rowEl(name) !== null,
    clickCreateButton: () => {
      document.querySelector<HTMLButtonElement>('.subagents-pane .skills-icon-button[aria-label="Create subagent"]')?.click();
    },
    clickRowEdit: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(`[aria-label="Edit ${CSS.escape(name)}"]`);
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    clickRowDelete: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(`[aria-label="Delete ${CSS.escape(name)}"]`);
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    confirmDeleteVisible: (name) => (rowEl(name)?.querySelector(".mcp-confirm-row") ?? null) !== null,
    clickRowConfirmDelete: (name) => {
      const button = rowEl(name)?.querySelector<HTMLButtonElement>(".mcp-confirm-row .settings-button-danger");
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    // `:scope > .skills-problem-strip` — SubagentsPane.tsx reuses the SAME
    // `.skills-problem-strip`/`.mcp-problem-strip` CSS vocabulary as SkillsPane
    // (no subagents-specific problem-strip class exists), so this scopes to
    // direct children of `.subagents-pane` (there is no import dialog on this
    // pane to accidentally include, unlike `SkillsPaneDom.problemCount`).
    problemCount: () => pane()?.querySelectorAll(":scope > .skills-problem-strip").length ?? 0,
    editorOpen: () => dialog() !== null,
    editorMode: () => {
      const label = dialog()?.getAttribute("aria-label");
      if (label === "Create subagent") {
        return "create";
      }
      if (label === "Edit subagent") {
        return "edit";
      }
      return null;
    },
    editorTab: () => {
      const selected = dialog()?.querySelector<HTMLButtonElement>('.subagents-editor-tab[aria-selected="true"]');
      const text = selected?.textContent?.trim();
      return text === "Preview" ? "preview" : text === "Edit" ? "edit" : null;
    },
    clickEditTab: () => {
      const tabs = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>(".subagents-editor-tab") ?? []);
      const tab = tabs.find((el) => el.textContent?.trim() === "Edit");
      if (!tab) {
        return false;
      }
      tab.click();
      return true;
    },
    clickPreviewTab: () => {
      const tabs = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>(".subagents-editor-tab") ?? []);
      const tab = tabs.find((el) => el.textContent?.trim() === "Preview");
      if (!tab) {
        return false;
      }
      tab.click();
      return true;
    },
    fieldValues: () => {
      if (dialog() === null) {
        return null;
      }
      return {
        name: nameInput()?.value ?? "",
        description: descriptionInput()?.value ?? "",
        tools: toolChips()
          .filter((chip) => chip.classList.contains("subagents-tool-chip-selected"))
          .map((chip) => chip.textContent?.trim() ?? ""),
        body: bodyTextarea()?.value ?? "",
      };
    },
    setName: (value) => {
      const input = nameInput();
      if (!input) {
        return false;
      }
      setNativeInputValue(input, value);
      return true;
    },
    setDescription: (value) => {
      const input = descriptionInput();
      if (!input) {
        return false;
      }
      setNativeInputValue(input, value);
      return true;
    },
    setBody: (value) => {
      const textarea = bodyTextarea();
      if (!textarea) {
        return false;
      }
      setNativeTextAreaValue(textarea, value);
      return true;
    },
    setTools: (tools) => {
      if (dialog() === null) {
        return false;
      }
      const wanted = new Set(tools);
      for (const chip of toolChips()) {
        const tool = chip.textContent?.trim() ?? "";
        const checkbox = chip.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (!checkbox) {
          continue;
        }
        if (checkbox.checked !== wanted.has(tool)) {
          checkbox.click();
        }
      }
      return true;
    },
    previewLoading: () => dialog()?.querySelector('.subagents-preview-pane[data-subagents-preview-loading="true"]') !== null,
    previewPromptText: () => dialog()?.querySelector(".subagents-preview-prompt")?.textContent ?? null,
    previewToolsLine: () => dialog()?.querySelector(".subagents-preview-tools")?.textContent ?? null,
    canSave: () => {
      const button = saveButton();
      return button !== null && !button.disabled;
    },
    clickSave: () => {
      const button = saveButton();
      if (!button || button.disabled) {
        return false;
      }
      button.click();
      return true;
    },
    clickCancel: () => {
      const buttons = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>(".mcp-dialog-actions button") ?? []);
      buttons.find((el) => el.textContent?.trim() === "Cancel")?.click();
    },
    errorText: () => {
      const warning = dialog()?.querySelector(".settings-env-warning");
      if (!warning) {
        return null;
      }
      // The error string is the div's own leading text node (React renders a
      // plain-string child directly); the optional `.subagents-issue-list`
      // that may follow it is read separately by `issues()`.
      const textNode = Array.from(warning.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      return textNode?.textContent?.trim() ?? null;
    },
    issues: () =>
      Array.from(dialog()?.querySelectorAll(".subagents-issue-list li") ?? []).map((li) => li.textContent ?? ""),
  };
}

/**
 * The real Profile-pane DOM accessor (design §4 W4): queries live at call
 * time, same laziness discipline as `realSubagentsPaneDom` (safe to evaluate
 * as a default parameter outside a browser; tests always pass an explicit
 * `profilePaneDom` and never reach this). `.profile-pane` only ever mounts
 * while Settings is open with the "profile" pane selected (`SettingsScreen
 * .tsx`'s own guard), so `mounted()` is an unambiguous reading.
 */
function realProfilePaneDom(): ProfilePaneDom {
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".profile-pane");
  }
  function heroEl(): HTMLElement | null {
    return pane()?.querySelector<HTMLElement>(".profile-empty-hero") ?? null;
  }
  function switchEl(): HTMLButtonElement | null {
    return pane()?.querySelector<HTMLButtonElement>(".profile-telemetry-block .settings-switch") ?? null;
  }
  return {
    mounted: () => pane() !== null,
    branch: () => heroEl()?.getAttribute("data-profile-branch") ?? null,
    bannerVisible: () => (pane()?.querySelector(".profile-banner") ?? null) !== null,
    truncatedVisible: () => (pane()?.querySelector(".profile-truncated-note") ?? null) !== null,
    tiles: () =>
      Array.from(pane()?.querySelectorAll<HTMLElement>(".profile-tile") ?? []).map((el) => ({
        label: el.querySelector(".profile-tile-caption")?.textContent?.trim() ?? "",
        value: el.querySelector(".profile-tile-value")?.textContent?.trim() ?? "",
      })),
    insightRows: () =>
      Array.from(pane()?.querySelectorAll<HTMLElement>(".profile-insight-row") ?? []).map((el) => ({
        label: el.querySelector(".profile-insight-label")?.textContent?.trim() ?? "",
        value: el.querySelector(".profile-insight-value")?.textContent?.trim() ?? "",
      })),
    // `.profile-top-tools` renders TWO `ul.profile-top-list`s that share the
    // exact same row/name classes -- the tools list, then (only when models
    // are non-empty) a second "Top models" list right after it
    // (`TopToolsColumn`). The tools list is always the FIRST one in document
    // order (it renders unconditionally, ahead of the models block), so
    // `querySelector` (first match only, not `querySelectorAll`) scopes
    // correctly without needing a dedicated class to tell the two lists
    // apart.
    topToolNames: () =>
      Array.from(
        pane()?.querySelector<HTMLElement>(".profile-top-tools ul.profile-top-list")?.querySelectorAll<HTMLElement>(".profile-top-row .settings-mcp-name") ?? [],
      ).map((el) => el.textContent?.trim() ?? ""),
    heatmapNonEmptyCellCount: () =>
      Array.from(pane()?.querySelectorAll<HTMLElement>(".profile-heatmap-cell") ?? []).filter(
        (el) => !el.classList.contains("profile-heatmap-bucket-0"),
      ).length,
    telemetrySwitch: () => {
      const el = switchEl();
      return el ? { checked: el.getAttribute("aria-checked") === "true", disabled: el.disabled } : null;
    },
    clickTelemetryToggle: () => {
      const el = switchEl();
      if (!el) {
        return false;
      }
      el.click();
      return true;
    },
  };
}

/**
 * The real slash-menu DOM accessor (design §7 W4): queries live at call time,
 * same laziness discipline as `realModelPillDom`/`realCtxPopoverDom` (safe to
 * evaluate as a default parameter outside a browser; tests always pass an
 * explicit `composerSlashDom` and never reach this). `.composer-textarea`
 * mounts at most once (only for the active tab, `ActiveTabBody`), same
 * posture as `realModelPillDom`'s `.model-pill` query.
 */
function realComposerSlashDom(): ComposerSlashDom {
  function menu(): HTMLDivElement | null {
    return document.querySelector<HTMLDivElement>(".slash-menu");
  }
  return {
    textarea: () => document.querySelector<HTMLTextAreaElement>(".composer-textarea"),
    menuMounted: () => menu() !== null,
    rows: () => {
      const menuEl = menu();
      if (!menuEl) {
        return [];
      }
      const out: ReturnType<ComposerSlashDom["rows"]> = [];
      let inSkills = false;
      for (const child of Array.from(menuEl.children)) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }
        if (child.classList.contains("slash-menu-section")) {
          inSkills = true;
          continue;
        }
        if (!child.classList.contains("slash-menu-row")) {
          continue;
        }
        const idPrefix = "slash-menu-option-";
        const index = child.id.startsWith(idPrefix) ? Number(child.id.slice(idPrefix.length)) : -1;
        const nameEl = child.querySelector(".slash-menu-row-name");
        const sourceEl = child.querySelector(".slash-menu-row-source");
        out.push({
          index,
          name: nameEl?.textContent ?? "",
          section: inSkills ? "skills" : "commands",
          sourceLabel: sourceEl?.textContent ?? null,
          disabled: child.classList.contains("slash-menu-row-disabled"),
          selected: child.getAttribute("aria-selected") === "true",
          highlighted: (nameEl?.querySelector("b") ?? null) !== null,
        });
      }
      return out;
    },
  };
}

/**
 * The real Keyboard shortcuts pane DOM accessor (design §4 W4): queries live
 * at call time, same laziness discipline as `realProfilePaneDom` (safe to
 * evaluate as a default parameter outside a browser; tests always pass an
 * explicit `shortcutsPaneDom` and never reach this). `.shortcuts-pane` only
 * ever mounts while Settings is open with the "shortcuts" pane selected
 * (`SettingsScreen.tsx`'s own guard). Badge slots are addressed by rendered
 * POSITION (`.shortcuts-badge`, in DOM order) — a recording chip shares that
 * base class but carries neither `.shortcuts-badge-edit` nor
 * `.shortcuts-badge-remove`, so `clickEditSlot`/`clickRemoveSlot` on a
 * currently-recording slot faithfully return `false` rather than mis-firing.
 */
function realShortcutsPaneDom(): ShortcutsPaneDom {
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".shortcuts-pane");
  }
  function rowEl(action: string): HTMLElement | null {
    return pane()?.querySelector<HTMLElement>(`.shortcuts-row[data-shortcut-action="${CSS.escape(action)}"]`) ?? null;
  }
  function rows(): ShortcutsPaneRowState[] {
    return Array.from(pane()?.querySelectorAll<HTMLElement>(".shortcuts-row") ?? []).map((el) => {
      const badges = Array.from(el.querySelectorAll<HTMLElement>(".shortcuts-badge"));
      return {
        action: el.getAttribute("data-shortcut-action") ?? "",
        name: el.querySelector(".shortcuts-row-name")?.textContent?.trim() ?? "",
        description: el.querySelector(".shortcuts-row-description")?.textContent?.trim() ?? "",
        editable: el.querySelector(".shortcuts-builtin-pill") === null,
        bindings: badges
          .filter((badge) => !badge.classList.contains("shortcuts-badge-recording"))
          .map((badge) => badge.querySelector(".shortcuts-badge-chord")?.textContent?.trim() ?? ""),
        overridden: el.querySelector(".shortcuts-reset-button") !== null,
        unassigned: el.querySelector(".shortcuts-unassigned") !== null,
        recording: el.querySelector(".shortcuts-badge-recording") !== null,
      };
    });
  }
  return {
    mounted: () => pane() !== null,
    query: () => pane()?.querySelector<HTMLInputElement>(".shortcuts-pane-search .settings-search-input")?.value ?? "",
    rows,
    recordingChipText: () =>
      pane()?.querySelector<HTMLElement>(".shortcuts-badge-recording .shortcuts-badge-chord")?.textContent?.trim() ?? null,
    clickAdd: (action) => {
      const btn = rowEl(action)?.querySelector<HTMLButtonElement>(".shortcuts-add-button") ?? null;
      if (!btn || btn.disabled) {
        return false;
      }
      btn.click();
      return true;
    },
    clickEditSlot: (action, slotIndex) => {
      const badge = Array.from(rowEl(action)?.querySelectorAll<HTMLElement>(".shortcuts-badge") ?? [])[slotIndex];
      const btn = badge?.querySelector<HTMLButtonElement>(".shortcuts-badge-edit") ?? null;
      if (!btn || btn.disabled) {
        return false;
      }
      btn.click();
      return true;
    },
    clickRemoveSlot: (action, slotIndex) => {
      const badge = Array.from(rowEl(action)?.querySelectorAll<HTMLElement>(".shortcuts-badge") ?? [])[slotIndex];
      const btn = badge?.querySelector<HTMLButtonElement>(".shortcuts-badge-remove") ?? null;
      if (!btn || btn.disabled) {
        return false;
      }
      btn.click();
      return true;
    },
    clickReset: (action) => {
      const btn = rowEl(action)?.querySelector<HTMLButtonElement>(".shortcuts-reset-button") ?? null;
      if (!btn || btn.disabled) {
        return false;
      }
      btn.click();
      return true;
    },
  };
}

/**
 * The real Settings DOM accessor (design §5 W4): queries live at call time,
 * same laziness discipline as `realModelPillDom` (safe to evaluate as a
 * default parameter outside a browser; tests always pass an explicit
 * `settingsDom` and never reach this). `.settings-screen` only ever mounts
 * while the fullscreen dialog is open (the WelcomeScreen embed mounts
 * `ProviderSettings` directly, never `SettingsScreen` itself), so `mounted()`
 * is an unambiguous open/closed read.
 */
function realSettingsDom(): SettingsDom {
  function screen(): HTMLDivElement | null {
    return document.querySelector<HTMLDivElement>(".settings-screen");
  }
  function toolInput(): HTMLInputElement | null {
    return screen()?.querySelector<HTMLInputElement>('input[aria-label="Tool name"]') ?? null;
  }
  function patternInput(): HTMLInputElement | null {
    return screen()?.querySelector<HTMLInputElement>('input[aria-label="Pattern"]') ?? null;
  }
  function addButton(): HTMLButtonElement | null {
    return screen()?.querySelector<HTMLButtonElement>(".settings-rule-add .settings-button-primary") ?? null;
  }
  return {
    mounted: () => screen() !== null,
    activePane: () => {
      const tab = screen()?.querySelector<HTMLButtonElement>('.settings-nav-item[aria-selected="true"]');
      return tab ? tab.id.replace(/^settings-tab-/, "") : null;
    },
    panesVisible: () => {
      const tabs = screen()?.querySelectorAll<HTMLButtonElement>(".settings-nav-item") ?? [];
      return Array.from(tabs).map((tab) => tab.id.replace(/^settings-tab-/, ""));
    },
    searchQuery: () => screen()?.querySelector<HTMLInputElement>(".settings-search-input")?.value ?? "",
    clickSidebarSettings: () => {
      document.querySelector<HTMLButtonElement>(".sidebar-settings")?.click();
    },
    clickBackToApp: () => {
      screen()?.querySelector<HTMLButtonElement>(".settings-back")?.click();
    },
    clickPaneTab: (paneId) => {
      const tab = document.getElementById(`settings-tab-${paneId}`) as HTMLButtonElement | null;
      if (!tab) {
        return false;
      }
      tab.click();
      return true;
    },
    fillPermissionTool: (value) => {
      const input = toolInput();
      if (!input) {
        return false;
      }
      setNativeInputValue(input, value);
      return true;
    },
    fillPermissionPattern: (value) => {
      const input = patternInput();
      if (input) {
        setNativeInputValue(input, value);
      }
    },
    permissionToolInputValue: () => toolInput()?.value ?? "",
    canSubmitPermissionAdd: () => {
      const button = addButton();
      return button !== null && !button.disabled;
    },
    clickPermissionAdd: () => {
      addButton()?.click();
    },
    clickPermissionRemove: (ariaLabel) => {
      const button = screen()?.querySelector<HTMLButtonElement>(`.settings-rule-remove[aria-label="${CSS.escape(ariaLabel)}"]`);
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    permissionRemoveRowExists: (ariaLabel) =>
      (screen()?.querySelector(`.settings-rule-remove[aria-label="${CSS.escape(ariaLabel)}"]`) ?? null) !== null,
  };
}

/**
 * The real LSP-panel DOM accessor (design/slice-P7.25-cut.md §3 W3): queries
 * live at call time, same laziness discipline as `realModelPillDom`/
 * `realStartScreenDom` (safe to evaluate as a default parameter outside a
 * browser; tests always pass an explicit `lspPanelDom` and never reach this).
 * `LspPanel.tsx` mounts a single `<aside class="lsp-panel">` unscoped to any
 * `data-tab-id` (App.tsx renders it once per active tab, not per tab id), so
 * this queries the document directly — same posture as `realModelPillDom`.
 * `:not(.hooks-panel)` excludes `HooksPanel.tsx`'s own `<aside>`, which reuses
 * the `lsp-panel` class for CSS only (HooksPanel.tsx). A server row's raw
 * `LspServerState` is read off its own `lsp-state-<state>` class (the SAME
 * token `LspServerRow` renders, byte-parity with the on-screen badge) rather
 * than the human-readable label text, so a live smoke can assert exact state
 * transitions.
 */
function realLspPanelDom(): LspPanelDom {
  function aside(): HTMLElement | null {
    return document.querySelector<HTMLElement>("aside.lsp-panel:not(.hooks-panel)");
  }
  return {
    panel() {
      const el = aside();
      if (!el) {
        return null;
      }
      const counts = el.querySelector(".lsp-panel-summary")?.textContent ?? null;
      const servers = Array.from(el.querySelectorAll(".lsp-server-row")).map((row) => {
        const name = row.querySelector(".lsp-server-name")?.textContent ?? "";
        const stateClass = Array.from(row.querySelector('[class*="lsp-state-"]')?.classList ?? []).find((cls) =>
          cls.startsWith("lsp-state-"),
        );
        const state = stateClass ? stateClass.slice("lsp-state-".length) : "";
        return { name, state };
      });
      return { counts, servers };
    },
    toggle() {
      document.querySelector<HTMLButtonElement>('.session-header-panel-toggle[aria-label="Toggle LSP status"]')?.click();
    },
  };
}

/**
 * The real Hooks-panel DOM accessor (design/slice-P7.25-cut.md §3 W3), same
 * laziness/document-query posture as `realLspPanelDom` above. `HooksPanel.tsx`
 * mounts `<aside class="hooks-panel lsp-panel">` — the `hooks-panel` class is
 * unique to this panel, so no `:not(...)` exclusion is needed here. `event`
 * is read off each group's own title text (`HooksPanel.tsx`'s
 * `formatHookEvent`, whose labels are byte-identical to the raw `HookEvent`
 * enum values), so this is a real `HookEvent` string, not a re-derived guess.
 */
function realHooksPanelDom(): HooksPanelDom {
  function aside(): HTMLElement | null {
    return document.querySelector<HTMLElement>("aside.hooks-panel");
  }
  return {
    panel() {
      const el = aside();
      if (!el) {
        return null;
      }
      const configError = el.querySelector(".hooks-error span")?.textContent ?? null;
      const groups = Array.from(el.querySelectorAll(".hooks-group")).map((group) => {
        const event = group.querySelector(".hooks-group-title")?.textContent ?? "";
        const countText = group.querySelector(".hooks-group-count")?.textContent ?? "";
        const count = Number.parseInt(countText, 10);
        return { event, count: Number.isNaN(count) ? 0 : count };
      });
      return { configError, groups };
    },
    toggle() {
      document.querySelector<HTMLButtonElement>('.session-header-panel-toggle[aria-label="Toggle hooks"]')?.click();
    },
  };
}

/**
 * The real checkpoint-timeline-panel DOM accessor (design
 * slice-P7.26-R2-ratification.md §1 W3), same laziness/document-query
 * posture as `realLspPanelDom`/`realHooksPanelDom` above. `TimelinePanel.tsx`
 * mounts `<aside class="timeline-panel lsp-panel">` — queried by the
 * `timeline-panel` class alone (unlike `realLspPanelDom`'s `:not(...)`
 * exclusion, no other panel carries this class).
 */
function realCheckpointPanelDom(): CheckpointPanelDom {
  function aside(): HTMLElement | null {
    return document.querySelector<HTMLElement>("aside.timeline-panel");
  }
  return {
    panel() {
      const el = aside();
      if (!el) {
        return null;
      }
      const items = Array.from(el.querySelectorAll(".timeline-row")).map((row) => ({
        id: row.getAttribute("data-checkpoint-id") ?? "",
        label: row.querySelector(".timeline-label")?.textContent ?? "",
        reason: row.querySelector(".timeline-reason")?.textContent ?? "",
        age: row.querySelector(".timeline-age")?.textContent ?? "",
      }));
      return { items };
    },
    toggle() {
      document
        .querySelector<HTMLButtonElement>('.session-header-panel-toggle[aria-label="Toggle checkpoint timeline"]')
        ?.click();
    },
    refresh() {
      document.querySelector<HTMLButtonElement>("aside.timeline-panel .lsp-panel-refresh")?.click();
    },
  };
}

/**
 * The real transcript-block-count DOM accessor for `rewindState` (design §1
 * W3), same exact-tabId match discipline as `realTranscriptDom` above (a
 * stray duplicate `.message-list[data-tab-id]` must refuse — count as 0 —
 * rather than pick one blind).
 */
function realTranscriptBlockDom(): TranscriptBlockDom {
  return {
    count(tabId: string): number {
      const matches = document.querySelectorAll<HTMLDivElement>(`.message-list[data-tab-id="${CSS.escape(tabId)}"]`);
      const container = matches.length === 1 ? matches[0] : null;
      return container ? container.querySelectorAll("[data-block-id]").length : 0;
    },
  };
}

/**
 * Shared read for `rewindState`/`checkpointRewind` (design §1 W3) — a plain
 * function (not an object method) so both facade methods above build the
 * identical reading without one calling the other through `this`. Guards
 * mirror `todoPanelState`'s exactly (`tab_not_active` then `no_transcript`).
 */
function readRewindState(
  registry: TabRegistry,
  tabsStore: TabsStoreApi,
  dom: TranscriptDom,
  transcriptBlockDom: TranscriptBlockDom,
  tabId: string,
): RewindStateResult | FacadeErr {
  if (tabsStore.getState().activeTabId !== tabId) {
    return { ok: false, reason: "tab_not_active" };
  }
  if (!dom.container(tabId)) {
    return { ok: false, reason: "no_transcript" };
  }
  const lastRewindResult = registry.getStore(tabId)?.getState().lastRewindResult ?? null;
  return {
    ok: true,
    lastResult: lastRewindResult
      ? {
          ok: lastRewindResult.ok,
          reason: lastRewindResult.reason ?? null,
          conversationRestored: lastRewindResult.conversationRestored,
          restoredPaths: lastRewindResult.restoredPaths,
          safetyId: lastRewindResult.safetyCheckpointId ?? null,
        }
      : null,
    transcriptBlockCount: transcriptBlockDom.count(tabId),
  };
}

/**
 * Yields one tick to the event loop so a just-fired `.click()`'s React commit
 * gets a chance to land before the caller re-probes the DOM. Prefers
 * `requestAnimationFrame` (aligns with paint in a real browser); falls back
 * to `setTimeout(0)` where rAF is absent (jsdom/node test environments —
 * this repo's automation.test.ts runs under `environment: "node"`, §desktop
 * vitest.config.ts, which has no rAF at all).
 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Polls `predicate` once per `nextTick()` until it returns true or
 * `deadlineMs` elapses, then returns the final result either way (`true` iff
 * the predicate was satisfied before the deadline). This is the fix for the
 * `modelPillPick` race a live smoke caught: `clickChip()`/`clickRootRow()`
 * fire a real DOM `.click()`, which schedules a React state update
 * (`setOpen`/page nav) — React has not necessarily committed that update by
 * the very next synchronous line, so re-probing `popoverOpen()`/
 * `currentPage()` immediately can read the STALE pre-click DOM and report a
 * false negative (`did_not_open`/`navigation_failed`). Polling (not a single
 * fixed sleep) keeps this fast on a normal commit and bounded when the click
 * genuinely no-ops (e.g. a disabled button, or a row absent from the DOM) —
 * it never blocks longer than `deadlineMs` regardless.
 */
async function waitUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= deadlineMs) {
      return predicate();
    }
    await nextTick();
  }
  return true;
}

/** Deadline for `waitUntil` polls inside `modelPillPick` (design §2.6 W4 fix) — generous enough for a slow React commit under test/CI load, short enough to fail fast on a genuine no-op click. */
const MODEL_PILL_COMMIT_DEADLINE_MS = 500;

/** Deadline for `waitUntil` polls inside the Settings facade methods (design §5 W4) — same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const SETTINGS_COMMIT_DEADLINE_MS = 500;

/** Deadline for `waitUntil` polls inside `ctxPopoverOpen` (design F12 W4) — same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const CTX_POPOVER_COMMIT_DEADLINE_MS = 500;

/** Deadline for `waitUntil` polls inside `agentCardExpand` (design §4 W4) — same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const AGENT_CARD_COMMIT_DEADLINE_MS = 500;

/** Deadline for `waitUntil` polls inside `mcpToggle`/`mcpImportOpen`'s open-click (design §4 W4) — same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const MCP_PANE_COMMIT_DEADLINE_MS = 500;

/** Deadline for `mcpImportOpen`'s scan-settle poll (design §4 W4) — longer than the other commit deadlines above: the scan is a real main-process fs fan-out (§3 allowlist, up to 6 files) round-tripped over IPC, not a synchronous React click commit. */
const MCP_PANE_SCAN_DEADLINE_MS = 10_000;

/** Deadline for `mcpImportApply`'s post-click results-settle poll (design §4 W4) — same rationale as `MCP_PANE_SCAN_DEADLINE_MS`: a real main-process config write round-tripped over IPC. */
const MCP_PANE_APPLY_DEADLINE_MS = 10_000;

/** Deadline for `waitUntil` polls inside `skillsToggle`/`skillsDelete`'s click-then-confirm steps (design §5 W4) — same rationale as `MCP_PANE_COMMIT_DEADLINE_MS`. */
const SKILLS_PANE_COMMIT_DEADLINE_MS = 500;

/** Deadline for `skillsImportOpen`'s scan-settle poll (design §5 W4) — same rationale as `MCP_PANE_SCAN_DEADLINE_MS`: a real main-process fs fan-out over the §3 allowlist, not a synchronous React click commit. */
const SKILLS_PANE_SCAN_DEADLINE_MS = 10_000;

/** Deadline for `skillsToggle`/`skillsDelete`/`skillsImportApply`'s post-click settle polls (design §5 W4) — same rationale as `MCP_PANE_APPLY_DEADLINE_MS`: a real main-process config/catalog write round-tripped over IPC. */
const SKILLS_PANE_APPLY_DEADLINE_MS = 10_000;

/** Deadline for `waitUntil` polls inside `subagentsOpenEditor`'s open-commit (design §4 W4) — generous enough to cover `openEdit`'s real `bridge.read()` IPC round-trip (main re-resolves the path + fs read), same rationale as `MCP_PANE_SCAN_DEADLINE_MS`. */
const SUBAGENTS_PANE_OPEN_DEADLINE_MS = 10_000;

/** Deadline for `waitUntil` polls inside `subagentsEditorSet`'s per-field commit checks (design §4 W4) — same rationale as `SETTINGS_COMMIT_DEADLINE_MS`: a synchronous local `useState` update, not an IPC round-trip. */
const SUBAGENTS_PANE_COMMIT_DEADLINE_MS = 500;

/** Deadline for `subagentsEditorPreview`'s settle poll (design §4 W4) — same rationale as `SKILLS_PANE_APPLY_DEADLINE_MS`: a real main-process preview build (core's `buildSubagentSystemPrompt`) round-tripped over IPC. */
const SUBAGENTS_PANE_PREVIEW_DEADLINE_MS = 10_000;

/** Deadline for `subagentsEditorSave`/`subagentsDelete`'s post-click settle polls (design §4 W4) — same rationale as `SKILLS_PANE_APPLY_DEADLINE_MS`: a real main-process profile-file write/delete round-tripped over IPC. */
const SUBAGENTS_PANE_APPLY_DEADLINE_MS = 10_000;

/** Deadline for `profileToggleTelemetry`'s post-click settle poll (design/slice-P7.22-cut.md §4 W4) — same rationale as `SKILLS_PANE_APPLY_DEADLINE_MS`: a real main-process atomic user-config write round-tripped over IPC. */
const PROFILE_PANE_APPLY_DEADLINE_MS = 10_000;

/** Deadline for `shortcutsStartRecord`'s post-click settle poll (design/slice-P7.24-cut.md §4 W4) — local React `useState`, no IPC round-trip, same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const SHORTCUTS_PANE_COMMIT_DEADLINE_MS = 500;

/** Deadline for `shortcutsRemoveBinding`/`shortcutsReset`'s post-click settle polls (design §4 W4) — same rationale as `SKILLS_PANE_APPLY_DEADLINE_MS`: a real `setPatch` settings.json write round-tripped over IPC. */
const SHORTCUTS_PANE_APPLY_DEADLINE_MS = 10_000;

/** Deadline for `checkpointPanelState`'s post-open/refresh settle poll (design slice-P7.26-R2-ratification.md §1 W3) — same rationale as `MCP_PANE_SCAN_DEADLINE_MS`: a real host round-trip (`checkpoint_list_request` -> store read -> `checkpoint_list` reply), not a synchronous React click commit. */
const CHECKPOINT_PANEL_LOAD_DEADLINE_MS = 3_000;

/** Deadline for `checkpointRewind`'s post-send settle poll (design §1 W3) — longer than the other host-round-trip deadlines above: a rewind writes a mandatory safety checkpoint (shadow-git commit) AND restores files across a two-tree diff before the host ever replies. */
const REWIND_SETTLE_DEADLINE_MS = 15_000;

/** Deadline for `startScreenToggleProjectMenu`'s post-click settle poll (design/slice-F5-1b-cut.md §2-D4) — local React `useState`, no IPC round-trip, same rationale as `MODEL_PILL_COMMIT_DEADLINE_MS`. */
const START_SCREEN_COMMIT_DEADLINE_MS = 500;

/**
 * Builds an `AutomationFacade` over the given registry/tabs-store/bridge.
 * `createAutomationFacade()` with no arguments (what `installAutomation`
 * uses) wires the app's real singletons; tests pass fakes built the same way
 * tab-registry.test.ts does (`createTabRegistry`/`createTabsStore` over fake
 * ports) plus a stub `AnycodeBridge`.
 */
export function createAutomationFacade(
  registry: TabRegistry = tabRegistry,
  tabsStore: TabsStoreApi = useTabsStore,
  bridge: AnycodeBridge = realBridge(),
  dom: TranscriptDom = realTranscriptDom(),
  todoPanelDom: TodoPanelDom = realTodoPanelDom(),
  startScreenDom: StartScreenDom = realStartScreenDom(),
  modelPillDom: ModelPillDom = realModelPillDom(),
  settingsStore: SettingsStoreApi = useSettingsStore,
  settingsDom: SettingsDom = realSettingsDom(),
  ctxPopoverDom: CtxPopoverDom = realCtxPopoverDom(),
  agentCardDom: AgentCardDom = realAgentCardDom(),
  mcpPaneDom: McpPaneDom = realMcpPaneDom(),
  skillsPaneDom: SkillsPaneDom = realSkillsPaneDom(),
  subagentsPaneDom: SubagentsPaneDom = realSubagentsPaneDom(),
  profilePaneDom: ProfilePaneDom = realProfilePaneDom(),
  composerSlashDom: ComposerSlashDom = realComposerSlashDom(),
  shortcutsPaneDom: ShortcutsPaneDom = realShortcutsPaneDom(),
  lspPanelDom: LspPanelDom = realLspPanelDom(),
  hooksPanelDom: HooksPanelDom = realHooksPanelDom(),
  checkpointPanelDom: CheckpointPanelDom = realCheckpointPanelDom(),
  transcriptBlockDom: TranscriptBlockDom = realTranscriptBlockDom(),
  tryAgainButtonDom: TryAgainButtonDom = realTryAgainButtonDom(),
): AutomationFacade {
  return {
    snapshot(transcriptTail?: number): SnapshotJson {
      const { tabs, activeTabId, hiddenWorkspaces } = tabsStore.getState();
      const states: Record<string, TabStateSnapshot> = {};
      for (const tab of tabs) {
        const store = registry.getStore(tab.tabId);
        if (!store) {
          // Defensive only: registerPort/disposeTab keep the tabs-store row
          // and the registry entry in lockstep, so this should never happen
          // in practice (tab-registry.ts's own invariant).
          continue;
        }
        const state = store.getState();
        const transcript =
          transcriptTail !== undefined && transcriptTail >= 0 ? state.transcript.slice(-transcriptTail) : state.transcript;
        states[tab.tabId] = {
          connection: state.connection,
          workspace: state.workspace,
          model: state.model,
          mode: state.mode,
          turn: state.turn,
          transcript,
          permission: state.permission,
          notice: state.notice,
          contextUsage: state.contextUsage,
          lastFatal: state.lastFatal,
          // Same reference-copy discipline as `turn`/`transcript` above — the
          // whole git slice rides along read-only (design §2.1a).
          git: state.git,
          envStatus: state.envStatus,
          promptQueue: state.promptQueue.map((item) => ({ id: item.id, text: item.text, imageCount: item.images.length })),
          queuePaused: state.queuePaused,
          retryOffer:
            state.retry !== null
              ? { loopEndBlockId: state.retry.loopEndBlockId, text: state.retry.text, imageCount: state.retry.images.length }
              : null,
          // Codex-fixes TASK.42 (cut §3.7): mirrors host_ready.engine's own
          // "absent = legacy core" discipline (cut §2(f)) — `state.engine` is
          // null for every core session, so this key is `undefined` (omitted
          // from the JSON the executeJavaScript bridge returns) and the
          // existing core-session byte-snapshot test stays untouched.
          engine:
            state.engine !== null
              ? { id: state.engine.id, model: state.engine.model?.current, activePresetId: state.engine.permissions?.activePresetId }
              : undefined,
        };
      }
      return { tabs, activeTabId, states, hiddenWorkspaces };
    },

    sendPrompt(tabId: string, text: string): { ok: true; requestId: string } | FacadeErr {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Mirrors Composer.handleSend's guard exactly (design §3.2): ready &&
      // idle. The host is still the final word (busy -> turn_rejected,
      // junk -> zod drop) — this is a UX-parity guard, not the security
      // boundary.
      if (state.connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      if (state.turn.status !== "idle") {
        return { ok: false, reason: "busy" };
      }
      const requestId = crypto.randomUUID();
      // Composer-echo: the wire never echoes the user's own text back (§3
      // MVP) — appendUserText is the transcript write, same as the real
      // button.
      state.appendUserText(requestId, text);
      // TASK.33 W8: byte-parity with Composer.handleSend's direct-send
      // branch — records what actually went on the wire so a live smoke
      // driving turns through this facade can still exercise the Try-again
      // offer (arming requires `lastSentMessage`).
      state.recordSentMessage(text, []);
      const message: UiToHostMessage = { type: "user_message", requestId, text };
      registry.sendToTab(tabId, message);
      return { ok: true, requestId };
    },

    tryAgain(tabId: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (store.getState().retry === null) {
        return { ok: false, reason: "no_retry_offer" };
      }
      // Mirrors dispatchTryAgain's own readiness gate (App.tsx, W8-FIX #1):
      // it bails without consuming the offer when disconnected, leaving it
      // armed for when the connection returns. Without this check the route
      // would report {ok:true} even though dispatchTryAgain sent nothing —
      // a lying facade that could mask a real regression in a live smoke.
      if (store.getState().connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      // The REAL dispatch: same function the button's own onClick calls
      // (App.tsx), through the SAME `registry.sendToTab` every other facade
      // driver uses — no second path.
      dispatchTryAgain(store, (msg) => registry.sendToTab(tabId, msg));
      return { ok: true };
    },

    tryAgainButtonState(tabId: string, blockId: string): TryAgainButtonState | FacadeErr {
      // Same two structural refusals as agentCardState (TASK.33 W8-FIX #2):
      // the button only ever lives inside the active tab's mounted transcript.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = tryAgainButtonDom.state(tabId, blockId);
      if (state === null) {
        // A valid reading, not an error (agentCardState precedent): the
        // transcript isn't mounted for this tab yet, or no block with this
        // exact id has landed there yet.
        return { ok: true, count: 0, visible: false, enabled: false };
      }
      return { ok: true, ...state };
    },

    tryAgainButtonClick(tabId: string, blockId: string): FacadeResult {
      // Same two structural refusals as tryAgainButtonState above.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      // A real click on the button's own DOM node (TASK.33 W8-FIX #2) — not
      // a call into `dispatchTryAgain` directly, unlike `tryAgain` above.
      // React's onClick fires synchronously off a native `.click()` (same as
      // every other click-driver in this file), and the handler it wires to
      // (`handleTryAgain` in App.tsx) IS `dispatchTryAgain`, so this still
      // exercises the exact same send/queue/busy decision — just through the
      // real render + event-handler path instead of skipping straight to it.
      const clicked = tryAgainButtonDom.click(tabId, blockId);
      return clicked ? { ok: true } : { ok: false, reason: "not_present" };
    },

    respondPermission(tabId: string, behavior: "allow" | "deny", requestId?: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const pending = store.getState().permission;
      if (!pending) {
        return { ok: false, reason: "no_pending_request" };
      }
      const target = requestId ?? pending.requestId;
      if (target !== pending.requestId) {
        // Fail-closed (design §3.2): a stale/mismatched requestId sends
        // nothing at all, not even a deny for the wrong request.
        return { ok: false, reason: "requestId_mismatch" };
      }
      const message: UiToHostMessage = { type: "permission_response", requestId: target, behavior };
      registry.sendToTab(tabId, message);
      return { ok: true };
    },

    setMode(tabId: string, mode: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!isPermissionMode(mode)) {
        return { ok: false, reason: "invalid_mode" };
      }
      const state = store.getState();
      // Mirrors Composer.handleModeChange's guard (design §3.2): ready && idle.
      if (state.connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      if (state.turn.status !== "idle") {
        return { ok: false, reason: "busy" };
      }
      const message: UiToHostMessage = { type: "set_mode", mode };
      registry.sendToTab(tabId, message);
      return { ok: true };
    },

    stop(tabId: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const message: UiToHostMessage = { type: "cancel_turn" };
      registry.sendToTab(tabId, message);
      return { ok: true };
    },

    selectTab(tabId: string): FacadeResult {
      if (!tabsStore.getState().tabs.some((tab) => tab.tabId === tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      // Pure renderer-side selection (design §3.2) — same call TabBar's click
      // handler makes (App.tsx's onSelectTab).
      tabsStore.getState().setActiveTab(tabId);
      return { ok: true };
    },

    resumeSession(sessionId: string): Promise<CreateTabResult> {
      // Full picker path (design §3.2/§4.2): bridge -> zod -> getSession ->
      // workspace from the persisted session's own meta. No renderer-side
      // bookkeeping beyond this call — the resulting tab's port delivery
      // still auto-registers it into the registry/tabs-store exactly as it
      // would for a real picker click (tab-registry.ts's `registerPort`
      // auto-registration, App.tsx's own comment on `handleTabCreated`); the
      // orchestrator addresses tabs by the returned `tabId` directly rather
      // than relying on "active tab".
      return bridge.createTab({ kind: "resume", sessionId });
    },

    async closeTab(tabId: string): Promise<{ ok: boolean; reason?: string }> {
      const result = await bridge.closeTab(tabId);
      if (result.ok) {
        // Mirrors App.tsx's handleCloseTab success path: only an explicit
        // ok:true disposes the tab locally (a refusal leaves it exactly
        // as-is — nothing stale to clean up). The renderer-confirm over a

        registry.disposeTab(tabId);
      }
      return result;
    },

    listSessions(): Promise<SessionSummary[]> {
      return bridge.listSessions();
    },

    projectNewSession(workspace: string): Promise<CreateTabResult> {
      // Mirror of the sidebar project menu's "New session in this project"
      // (design §2F.2 item 1) — the SAME contextBridge invoke the component
      // calls (`resumeSession`'s posture above: bridge is the path, main is
      // the authority). No dialog, no renderer-side bookkeeping beyond this
      // call — the resulting tab's port delivery auto-registers it exactly as
      // a real click would.
      return bridge.createTab({ kind: "new", workspace });
    },

    projectHide(workspace: string): FacadeResult {
      // Mirror of "Remove project from list" (design §2F.2 item 2). The
      // open-tabs refusal is decided by the REAL store action, not

      // `false` return means the workspace still has an open tab.
      if (!tabsStore.getState().hideWorkspace(workspace)) {
        return { ok: false, reason: "project_has_open_tabs" };
      }
      return { ok: true };
    },

    gitCommand(tabId: string, command: GitCommand): { ok: true; requestId: string } | FacadeErr {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Mirrors GitPanel.dispatch's reachability exactly (design §2.1c): the
      // git surface is structurally unreachable until the tab is `ready` and
      // a live environment menu can expose Git controls (no status -> no
      // enabled inspector). These are UX-parity guards, not the security
      // boundary; the host's zod + git state machine remain the final word.
      if (state.connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      if (!state.git.statusKnown || state.git.status === null) {
        return { ok: false, reason: "git_unavailable" };
      }
      const pending = derivePendingForGitCommand(command);
      if (pending === null) {
        // Two distinct null causes: a destructive op (which has a live confirm
        // path, so signal that) vs. a bare diff with no path+target (which the
        // UI can never dispatch — a malformed command).
        const destructive =
          command.op === "discard" ||
          command.op === "stash_push" ||
          command.op === "stash_pop" ||
          command.op === "reset";
        return { ok: false, reason: destructive ? "destructive_requires_confirm" : "invalid_command" };
      }
      const requestId = crypto.randomUUID();
      state.gitRequestStarted(requestId, pending);
      const message: UiToHostMessage = { type: "git_command", requestId, command };
      registry.sendToTab(tabId, message);
      return { ok: true, requestId };
    },

    gitStageConfirm(tabId: string, intent: GitDestructiveIntent): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Same reachability guards as gitCommand (design §2.1c): the destructive
      // buttons live inside the open panel behind a live pill.
      if (state.connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      if (!state.git.statusKnown || state.git.status === null) {
        return { ok: false, reason: "git_unavailable" };
      }

      // action, not re-implemented here — the facade only maps its `false`
      // (turn running -> confirm untouched) to a reason code. On success the
      // staged intent mounts the real GitConfirmDialog in the live app.
      if (!state.gitStageConfirm(intent)) {
        return { ok: false, reason: "turn_running" };
      }
      return { ok: true };
    },

    gitConfirm(tabId: string): { ok: true; requestId: string } | FacadeErr {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Verbatim mirror of GitConfirmDialog.handleConfirm (`:110-122`), with no
      // guards beyond the dialog's own (parity — the dialog only mounts on a
      // staged intent, so `ready`/`statusKnown` were already true when it was
      // staged). `buildConfirmedGitCommand` (store.ts) is the SOLE constructor

      // literal itself.
      const intent = state.git.confirm;
      if (intent === null) {
        return { ok: false, reason: "no_staged_confirm" };
      }
      const command = buildConfirmedGitCommand(intent);
      if (command === null) {
        // Defensive only: `intent` is non-null here, so buildConfirmedGitCommand
        // returns null only for an unreachable (exhaustive-switch) shape —
        // fall through with nothing sent and the confirm left staged, exactly
        // as the dialog's own early-return does.
        return { ok: false, reason: "no_staged_confirm" };
      }
      const requestId = crypto.randomUUID();
      // Label byte-parity with the dialog (anti-drift): same confirmDialogCopy
      // the on-screen button renders, lower-cased.
      state.gitRequestStarted(requestId, { kind: "mutation", label: confirmDialogCopy(intent).confirmLabel.toLowerCase() });
      const message: UiToHostMessage = { type: "git_command", requestId, command };
      registry.sendToTab(tabId, message);
      state.gitClearConfirm();
      return { ok: true, requestId };
    },

    gitCancelConfirm(tabId: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      // Mirrors Cancel/Esc (`GitConfirmDialog:106-108`): unconditional clear —
      // the fail-safe direction always succeeds for a known tab.
      store.getState().gitClearConfirm();
      return { ok: true };
    },

    gitSetPanelOpen(tabId: string, open: boolean): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Opening mirrors the environment menu: it is only reachable once the
      // tab is ready and status is live. Closing (`X` /
      // `:489`) is the fail-safe direction — unconditional. Opening in the
      // live app mounts the real GitPanel, whose effect (`:452-456`) then
      // dispatches refresh+branches — the very interaction layer R8 validates.
      if (open === true) {
        if (state.connection !== "ready") {
          return { ok: false, reason: "not_ready" };
        }
        if (!state.git.statusKnown || state.git.status === null) {
          return { ok: false, reason: "git_unavailable" };
        }
      }
      state.gitSetPanelOpen(open);
      return { ok: true };
    },

    gitSetView(tabId: string, view: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!isGitPanelView(view)) {
        return { ok: false, reason: "invalid_view" };
      }
      const state = store.getState();
      // Tabs exist only inside an open panel (strict UI parity, design §2.1c).
      // Switching to history with `log===null` fires the real lazy-log effect
      // (`GitPanel:461-465`) in the live app.
      if (state.git.panelOpen === false) {
        return { ok: false, reason: "panel_closed" };
      }
      state.gitSetView(view);
      return { ok: true };
    },

    transcriptScrollState(tabId: string): TranscriptScrollState | FacadeErr {
      // Only the active tab's DOM is ever mounted (design §3.3) — a background
      // tab's `.message-list` does not exist, so a mismatched tabId is refused
      // rather than silently reading the wrong (or no) tab's geometry.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const el = dom.container(tabId);
      if (!el) {
        return { ok: false, reason: "no_transcript" };
      }
      return {
        ok: true,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        // Single source of truth (design §3.3): the exact predicate
        // MessageList.tsx's own onScroll handler uses, so this read can never
        // disagree with the product's follow/pause state.
        atBottom: isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight),
        jumpVisible: dom.jumpButtonVisible(),
      };
    },

    transcriptScrollTo(tabId: string, to: "top" | "bottom"): FacadeResult {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const el = dom.container(tabId);
      if (!el) {
        return { ok: false, reason: "no_transcript" };
      }
      // A real property assignment (not a re-implemented scroll-math call) —
      // fires the container's actual `scroll` event, so MessageList's own
      // onScroll/isAtBottom recompute runs exactly as it would for a user

      el.scrollTop = to === "top" ? 0 : el.scrollHeight;
      return { ok: true };
    },

    todoPanelState(tabId: string): TodoPanelState | FacadeErr {
      // Same structural refusals as transcriptScrollState (design §3 W2): the
      // panel only ever lives inside the active tab's mounted `.message-list`.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!dom.container(tabId)) {
        return { ok: false, reason: "no_transcript" };
      }
      const panel = todoPanelDom.panel(tabId);
      if (panel === null) {
        // A valid reading, not an error (design §3 W2): no completed
        // TodoWrite yet, or the last one's `todos` array is empty.
        return { ok: true, visible: false, header: null, panelCollapsed: false, completedRow: null, items: [] };
      }
      return { ok: true, visible: true, ...panel };
    },

    startScreenState(): StartScreenState {
      const { draft, draftActive } = tabsStore.getState();
      const workspace = draft?.workspace ?? null;
      const prompt = draft?.prompt ?? "";
      return {
        ok: true,
        active: draftActive,
        rendered: startScreenDom.rendered(),
        workspace,
        prompt,
        model: draft?.model ?? null,
        mode: draft?.mode ?? null,
        // Byte-parity with StartScreen.tsx's computeSendDisabledReason (§3-D3).
        sendEnabled: workspace !== null && prompt.trim().length > 0,
        recentCount: startScreenDom.recentCount(),
        projectMenuOpen: startScreenDom.projectMenuOpen(),
        // Codex-fixes TASK.42 (cut §3.7): `engine` mirrors the draft-state
        // discipline of `workspace`/`prompt`/`model` above — undefined until a
        // draft exists, then the draft's own pick (defaulted to "core" by
        // tabsStore.openDraft). `availableEngines` is the compiled-in catalog
        // (shared/engines.ts ENGINE_IDS), not draft-scoped — it is the set of
        // engines this build knows how to speak to at all, independent of
        // whether a start-screen draft happens to be open right now.
        engine: draft?.engine,
        availableEngines: [...ENGINE_IDS],
      };
    },

    startScreenOpen(workspace?: string): FacadeResult {
      // Same call the "New Session" entry points make (App.tsx/Sidebar.tsx
      // §4.6): create-or-focus, an existing draft's prompt/workspace are kept
      // unless `workspace` overwrites them (§3-D7).
      tabsStore.getState().openDraft(workspace);
      return { ok: true };
    },

    startScreenSetWorkspace(workspace: string): FacadeResult {
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      tabsStore.getState().setDraftWorkspace(workspace);
      return { ok: true };
    },

    startScreenSetPrompt(prompt: string): FacadeResult {
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      tabsStore.getState().setDraftPrompt(prompt);
      return { ok: true };
    },

    startScreenSetModel(model: string | null): FacadeResult {
      // Same no_draft guard as startScreenSetWorkspace/SetPrompt above — a
      // write-through to the store's own setDraftModel (design §2-D4), no
      // second path.
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      tabsStore.getState().setDraftModel(model);
      return { ok: true };
    },

    // Codex-fixes TASK.42 (cut §3.7, IMPLEMENTED here): same no_draft guard
    // and write-through-the-store discipline as startScreenSetModel above —
    // drives the EXISTING setDraftEngine action (tabs-store.ts), no second
    // path. `async` to match the frozen `Promise<FacadeResult>` signature;
    // the write itself is synchronous, so this never actually awaits.
    async startScreenSetEngine(engineId: string): Promise<FacadeResult> {
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      if (!isEngineId(engineId)) {
        return { ok: false, reason: "invalid_engine" };
      }
      tabsStore.getState().setDraftEngine(engineId);
      return { ok: true };
    },

    startScreenSetMode(mode: string): FacadeResult {
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      if (!isPermissionMode(mode)) {
        return { ok: false, reason: "invalid_mode" };
      }
      tabsStore.getState().setDraftMode(mode);
      return { ok: true };
    },

    async startScreenToggleProjectMenu(open: boolean): Promise<FacadeResult> {
      if (tabsStore.getState().draft === null) {
        return { ok: false, reason: "no_draft" };
      }
      if (startScreenDom.projectMenuOpen() === open) {
        return { ok: true };
      }
      // A real click on the project control's chip (design §2-D4) — not a
      // synthetic store poke, since the popover's open state is local
      // component useState with no store action to call instead (same
      // posture as ctxPopoverOpen's clickTrigger).
      startScreenDom.clickProjectChip();
      // Same commit-race guard as ctxPopoverOpen/modelPillPick: a real click
      // schedules a React state update that may not have committed by the
      // very next synchronous line.
      const committed = await waitUntil(() => startScreenDom.projectMenuOpen() === open, START_SCREEN_COMMIT_DEADLINE_MS);
      return committed ? { ok: true } : { ok: false, reason: open ? "did_not_open" : "did_not_close" };
    },

    startScreenSubmit(): Promise<{ ok: true; tabId: string } | { ok: false; message: string }> {
      // The EXACT shared implementation the Send button calls (start-session.ts
      // §4.3, no second path) — only the DI is swapped for this facade's own
      // injected registry/tabsStore/bridge, so this stays testable over fakes.
      const deps: StartSubmitDeps = {
        createTab: (req) => bridge.createTab(req),
        registry,
        tabsStore,
      };
      return submitStartDraft(deps);
    },

    queuePrompt(tabId: string, text: string): { ok: true; id: string } | FacadeErr {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = store.getState();
      // Mirrors Composer.handleSend's ready guard (design §3.2) — deliberately
      // NOT a busy guard: queuing while running is the whole point (§0).
      if (state.connection !== "ready") {
        return { ok: false, reason: "not_ready" };
      }
      // enqueuePrompt (store.ts) mints the id itself and RETURNS it — use that
      // directly. A tail read would crash at truly-idle: the enqueue
      // synchronously fires the drainer, which pops the just-added item into
      // `queueInFlight` before the tail read, leaving `queue[-1]` undefined.
      const id = state.enqueuePrompt({ text, images: [] });
      return { ok: true, id };
    },

    queueEdit(tabId: string, id: string, text: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!store.getState().promptQueue.some((prompt) => prompt.id === id)) {
        return { ok: false, reason: "unknown_prompt" };
      }
      store.getState().editQueuedPrompt(id, text);
      return { ok: true };
    },

    queueDelete(tabId: string, id: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!store.getState().promptQueue.some((prompt) => prompt.id === id)) {
        return { ok: false, reason: "unknown_prompt" };
      }
      store.getState().deleteQueuedPrompt(id);
      return { ok: true };
    },

    queueResume(tabId: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      store.getState().resumeQueue();
      return { ok: true };
    },

    queueClear(tabId: string): FacadeResult {
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      store.getState().clearQueue();
      return { ok: true };
    },

    modelPillState(tabId: string): ModelPillState | FacadeErr {
      // Same structural refusal as todoPanelState (design §2.6 W4): the pill
      // only ever lives inside the active tab's mounted ActiveTabBody.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!modelPillDom.mounted()) {
        // A valid reading, not an error (design §2.6 W4 / todoPanelState
        // precedent): no active tab's chat UI mounted yet, or `model` is
        // still `null` pre-host_ready (ModelPill's own `{model === null}` guard).
        return {
          ok: true,
          present: false,
          label: null,
          menuOpen: false,
          page: "root",
          effortRowVisible: false,
          modelItems: [],
          effortItems: [],
          currentModel: null,
          currentEffort: null,
          modelPickDisabled: true,
          manageModelsDisabled: true,
        };
      }
      const state = store.getState();
      const settingsSnapshot = settingsStore.getState().snapshot;
      const providerId = settingsSnapshot ? activeProviderView(settingsSnapshot.settings).id : undefined;
      const catalogModels = settingsSnapshot?.catalog?.find((entry) => entry.id === providerId)?.models;
      const model = state.model;
      const menuOpen = modelPillDom.popoverOpen();
      return {
        ok: true,
        present: true,
        // pillLabel/modelDisplayName are the EXACT functions ModelPill.tsx
        // renders with (design §2.6 W4) — this probe cannot disagree with the
        // on-screen label.
        label: model !== null ? pillLabel(modelDisplayName(model, catalogModels), state.reasoningEffort, state.availableEffortLevels) : null,
        menuOpen,
        page: menuOpen ? modelPillDom.currentPage() : "root",
        effortRowVisible: state.availableEffortLevels !== undefined,
        modelItems: modelMenuItems(model ?? "", catalogModels),
        effortItems: [...(state.availableEffortLevels ?? [])],
        currentModel: model,
        currentEffort: state.reasoningEffort,
        modelPickDisabled: computeModelPickDisabled(state.turn.status, state.queueInFlight, state.connection === "ready"),
        manageModelsDisabled: modelPillDom.manageDisabled(),
      };
    },

    async modelPillPick(tabId: string, pick: ModelPillPick): Promise<FacadeResult> {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!modelPillDom.mounted()) {
        return { ok: false, reason: "not_present" };
      }
      const state = store.getState();
      // The exact client-side guard ModelPill.tsx itself computes (design
      // §2.1's between-turns guard, renderer half) — a disabled chip refuses
      // EVERY pick kind, including "open" (the real button is `disabled`, so
      // a real click does nothing either). Stays synchronous and BEFORE any
      // click: a real disabled button no-ops a real click too, so there is no
      // commit to await here.
      if (computeModelPickDisabled(state.turn.status, state.queueInFlight, state.connection === "ready")) {
        return { ok: false, reason: "pick_disabled" };
      }
      if (!modelPillDom.popoverOpen()) {
        modelPillDom.clickChip();
      }
      // `clickChip()` fires the chip's real onClick -> `setOpen(true)`, but
      // React has not necessarily committed that state update by the very
      // next synchronous line — re-probing `popoverOpen()` immediately here
      // used to race the commit and report a false `did_not_open` (caught by
      // a live smoke). Poll for the commit instead of trusting one read.
      if (!(await waitUntil(() => modelPillDom.popoverOpen(), MODEL_PILL_COMMIT_DEADLINE_MS))) {
        return { ok: false, reason: "did_not_open" };
      }
      if (pick.kind === "open") {
        return { ok: true };
      }
      if (modelPillDom.currentPage() !== pick.kind) {
        modelPillDom.clickRootRow(pick.kind);
      }
      // Same commit-race guard as above, for the root-row navigation click.
      if (!(await waitUntil(() => modelPillDom.currentPage() === pick.kind, MODEL_PILL_COMMIT_DEADLINE_MS))) {
        // The effort row is absent for a non-reasoning model (design §2.2) —
        // the only reason navigating to "effort" can fail structurally.
        return { ok: false, reason: pick.kind === "effort" ? "effort_row_hidden" : "navigation_failed" };
      }
      const settingsSnapshot = settingsStore.getState().snapshot;
      const providerId = settingsSnapshot ? activeProviderView(settingsSnapshot.settings).id : undefined;
      const catalogModels = settingsSnapshot?.catalog?.find((entry) => entry.id === providerId)?.models;
      const values: readonly string[] =
        pick.kind === "model" ? modelMenuItems(state.model ?? "", catalogModels).map((item) => item.id) : (state.availableEffortLevels ?? []);
      const index = values.indexOf(pick.value);
      if (index < 0) {
        return { ok: false, reason: "unknown_value" };
      }
      // Same index the component's own `.map()` render uses (design §2.6 W4) —
      // clicking by position, not by matching visible text, so a duplicate
      // display name can never mis-click the wrong item. Terminal action: the
      // smoke re-reads state over a fresh HTTP round-trip afterward, so no
      // post-click settle is needed here.
      modelPillDom.clickItemAt(index);
      return { ok: true };
    },

    ctxPopoverState(tabId: string): CtxPopoverState | FacadeErr {
      // Same structural refusal as modelPillState (design F12 W4): the ctx
      // meter only ever lives inside the active tab's mounted Composer.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!ctxPopoverDom.mounted()) {
        // A valid reading, not an error (modelPillState precedent): the
        // meter hasn't rendered yet (pre-`context_usage`, Composer's own
        // `ctxPercent !== null` mount gate).
        return { ok: true, open: false, headline: null, percentText: null, rows: [], sessionTokens: null };
      }
      const open = ctxPopoverDom.open();
      const sessionTokens = store.getState().sessionTokens;
      return {
        ok: true,
        open,
        percentText: ctxPopoverDom.percentText(),
        // headline/rows/sessionTokens only ever render while the panel is
        // open (Composer.tsx's own `{open && (...)}` guard) — mirror that
        // here rather than reporting stale content from a since-closed panel.
        headline: open ? ctxPopoverDom.headline() : null,
        rows: open ? ctxPopoverDom.rows() : [],
        sessionTokens: open && ctxPopoverDom.sessionLineVisible() ? sessionTokens : null,
      };
    },

    async ctxPopoverOpen(tabId: string, open: boolean): Promise<FacadeResult> {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      if (!ctxPopoverDom.mounted()) {
        return { ok: false, reason: "not_present" };
      }
      if (ctxPopoverDom.open() === open) {
        return { ok: true };
      }
      // A real click on the trigger chip toggles `open` via CtxPopover's own
      // handleClick (design F12 W4) — not a synthetic store poke, since the
      // popover's open state is local component useState with no store
      // action to call instead (same posture as modelPillPick's clickChip).
      ctxPopoverDom.clickTrigger();
      // Same commit-race guard as modelPillPick (design §2.6 W4 fix): a real
      // click schedules a React state update that may not have committed by
      // the very next synchronous line.
      const committed = await waitUntil(() => ctxPopoverDom.open() === open, CTX_POPOVER_COMMIT_DEADLINE_MS);
      return committed ? { ok: true } : { ok: false, reason: open ? "did_not_open" : "did_not_close" };
    },

    agentCardState(tabId: string, toolCallId: string): AgentCardState | FacadeErr {
      // Same two structural refusals as ctxPopoverState (design §4 W4): the
      // card only ever lives inside the active tab's mounted transcript.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const state = agentCardDom.state(tabId, toolCallId);
      if (state === null) {
        // A valid reading, not an error (TodoPanelState/CtxPopoverState
        // precedent): the transcript isn't mounted for this tab yet, or no
        // card with this exact toolCallId has landed there yet.
        return { ok: true, expanded: false, promptCollapsed: true, feedRowCount: 0, resultRendered: false };
      }
      return { ok: true, ...state };
    },

    async agentCardExpand(tabId: string, toolCallId: string): Promise<FacadeResult> {
      // Same two structural refusals as agentCardState (design §4 W4).
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const before = agentCardDom.state(tabId, toolCallId);
      if (before === null) {
        return { ok: false, reason: "not_present" };
      }
      if (before.expanded) {
        return { ok: true };
      }
      // A real click on the card's own toggle button (design §4 W4) — not a
      // synthetic store poke, since disclosure is local component useState
      // (`ToolCallCard`'s own `userExpanded`), same posture as
      // `ctxPopoverOpen`'s `clickTrigger`.
      agentCardDom.clickToggle(tabId, toolCallId);
      // Same commit-race guard as ctxPopoverOpen/modelPillPick: a real click
      // schedules a React state update that may not have committed by the
      // very next synchronous line.
      const committed = await waitUntil(
        () => agentCardDom.state(tabId, toolCallId)?.expanded === true,
        AGENT_CARD_COMMIT_DEADLINE_MS,
      );
      return committed ? { ok: true } : { ok: false, reason: "did_not_expand" };
    },

    settingsState(): SettingsStateResult {
      if (!settingsDom.mounted()) {
        return { open: false, activePane: null, panesVisible: [], searchQuery: "", permissions: { groups: [] } };
      }
      const rules = settingsStore.getState().snapshot?.settings.permissions.alwaysAllow ?? [];
      // Same exported pure helpers PermissionsEditor.tsx itself renders with
      // (design §5 W4) — this probe cannot drift from the on-screen grouping.
      const groups = groupAlwaysAllowRules(rules).map((group) => ({
        toolName: group.toolName,
        rules: group.rules.map((rule) => ({
          pattern: ruleHasPattern(rule) ? (rule.pattern as string) : null,
          display: ruleDisplayPattern(rule),
        })),
      }));
      return {
        open: true,
        activePane: settingsDom.activePane(),
        panesVisible: settingsDom.panesVisible(),
        searchQuery: settingsDom.searchQuery(),
        permissions: { groups },
      };
    },

    async settingsOpen(): Promise<FacadeResult> {
      if (settingsDom.mounted()) {
        return { ok: true };
      }
      // The real path (design §5 W4): a click on the sidebar gear trigger,
      // the SAME button `onOpenSettings` fires from — `settingsOpen` is not a
      // synthetic state poke (there is no store action to call instead;
      // `settingsOpen` is App.tsx-local `useState`).
      settingsDom.clickSidebarSettings();
      const opened = await waitUntil(() => settingsDom.mounted(), SETTINGS_COMMIT_DEADLINE_MS);
      return opened ? { ok: true } : { ok: false, reason: "did_not_open" };
    },

    async settingsClose(): Promise<FacadeResult> {
      if (!settingsDom.mounted()) {
        return { ok: true };
      }
      // The real path: a click on the rail's "← Back to app" row, the same
      // `onClose` a real click fires (Esc's `onCancel` path is equivalent but
      // this facade drives the visible affordance, same posture as
      // modelPillPick driving the chip rather than a keyboard event).
      settingsDom.clickBackToApp();
      const closed = await waitUntil(() => !settingsDom.mounted(), SETTINGS_COMMIT_DEADLINE_MS);
      return closed ? { ok: true } : { ok: false, reason: "did_not_close" };
    },

    async settingsSelectPane(paneId: string): Promise<FacadeResult> {
      if (!settingsDom.mounted()) {
        return { ok: false, reason: "not_open" };
      }
      if (!settingsDom.clickPaneTab(paneId)) {
        return { ok: false, reason: "pane_not_visible" };
      }
      const switched = await waitUntil(() => settingsDom.activePane() === paneId, SETTINGS_COMMIT_DEADLINE_MS);
      return switched ? { ok: true } : { ok: false, reason: "pane_switch_failed" };
    },

    async settingsPermissionAdd({ toolName, pattern }: { toolName: string; pattern?: string }): Promise<FacadeResult> {
      if (!settingsDom.mounted()) {
        return { ok: false, reason: "not_open" };
      }
      if (!settingsDom.fillPermissionTool(toolName)) {
        return { ok: false, reason: "form_not_present" };
      }
      settingsDom.fillPermissionPattern(pattern ?? "");
      if (!settingsDom.canSubmitPermissionAdd()) {
        return { ok: false, reason: "add_disabled" };
      }
      // Deliberately the form, not `store.addRule` directly (design §5 W4) —
      // the smoke must exercise the user path, including the W1-FIX Bash
      // env-prefix sanitizer, which only fires from PermissionsEditor's real
      // `handleAdd`. `handleAdd` is async (submitPermissionAdd -> addRule
      // round-trip) and only clears the tool input on success
      // (PermissionsEditor.tsx), so the cleared input is the observable
      // commit signal — same commit-race discipline as modelPillPick.
      settingsDom.clickPermissionAdd();
      const cleared = await waitUntil(() => settingsDom.permissionToolInputValue() === "", SETTINGS_COMMIT_DEADLINE_MS);
      return cleared ? { ok: true } : { ok: false, reason: "add_failed" };
    },

    async settingsPermissionRemove({ toolName, pattern }: { toolName: string; pattern?: string }): Promise<FacadeResult> {
      if (!settingsDom.mounted()) {
        return { ok: false, reason: "not_open" };
      }
      // Same aria-label PermissionsEditor.tsx computes for the row's remove
      // button (design §5 W4, byte-parity via the shared helper) — this
      // cannot drift from which row a real click would hit.
      const ariaLabel = ruleRemoveAriaLabel({ toolName, pattern });
      if (!settingsDom.clickPermissionRemove(ariaLabel)) {
        return { ok: false, reason: "rule_not_found" };
      }
      const removed = await waitUntil(() => !settingsDom.permissionRemoveRowExists(ariaLabel), SETTINGS_COMMIT_DEADLINE_MS);
      return removed ? { ok: true } : { ok: false, reason: "remove_failed" };
    },

    mcpPaneState(): McpPaneState {
      if (!mcpPaneDom.mounted()) {
        // A valid reading, not an error (SettingsStateResult precedent): the
        // Settings dialog is closed, or a different pane is currently active.
        return { rows: [], problems: 0, importOpen: false, importCandidates: [], consentChecked: false };
      }
      const open = mcpPaneDom.importOpen();
      return {
        rows: mcpPaneDom.rows(),
        problems: mcpPaneDom.problemCount(),
        importOpen: open,
        // Only populated while the dialog is open (CtxPopoverState precedent):
        // a closed dialog has no live candidates/consent state to report.
        importCandidates: open ? mcpPaneDom.importCandidates() : [],
        consentChecked: open ? mcpPaneDom.consentChecked() : false,
      };
    },

    async mcpToggle(name: string): Promise<FacadeResult> {
      if (!mcpPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const before = mcpPaneDom.rowEnabled(name);
      if (before === undefined) {
        return { ok: false, reason: "row_not_found" };
      }
      // A real click on the row's own enable/disable switch (design §4 W4) —
      // not a synthetic store poke, since the toggle round-trips through the
      // real `McpConfigBridge.setEnabled` the component itself calls. A
      // read-only `.mcp.json` row has no switch at all (`clickRowToggle`
      // returns `false`) — the ONE structural refusal beyond "unknown row".
      if (!mcpPaneDom.clickRowToggle(name)) {
        return { ok: false, reason: "not_toggleable" };
      }
      // Same commit-race guard as modelPillPick/ctxPopoverOpen: the click
      // schedules an async bridge round-trip (main IPC + fs write) before the
      // row's own dot class actually flips.
      const toggled = await waitUntil(() => mcpPaneDom.rowEnabled(name) !== before, MCP_PANE_APPLY_DEADLINE_MS);
      return toggled ? { ok: true } : { ok: false, reason: "did_not_toggle" };
    },

    async mcpImportOpen(): Promise<FacadeResult> {
      if (!mcpPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      if (!mcpPaneDom.importOpen()) {
        // A real click on the header's import button (design §4 W4) — the
        // SAME button `openImportDialog` fires from; there is no store action
        // to call instead (the dialog's open state is local component
        // `useState`), same posture as `settingsOpen`'s sidebar-gear click.
        mcpPaneDom.clickImportButton();
        const opened = await waitUntil(() => mcpPaneDom.importOpen(), MCP_PANE_COMMIT_DEADLINE_MS);
        if (!opened) {
          return { ok: false, reason: "did_not_open" };
        }
      }
      // Opening the dialog kicks off a real `bridge.importScan` round-trip
      // (main-process fs fan-out over the §3 allowlist) — wait for it to
      // settle (even to zero candidates) before returning, so a caller's very
      // next `mcpPaneState()` read never races an in-flight scan.
      const scanned = await waitUntil(() => mcpPaneDom.importScanLoaded(), MCP_PANE_SCAN_DEADLINE_MS);
      return scanned ? { ok: true } : { ok: false, reason: "scan_timeout" };
    },

    async mcpImportApply({ consent, names }: { consent: boolean; names?: string[] }): Promise<FacadeResult> {
      if (!mcpPaneDom.importOpen()) {
        return { ok: false, reason: "dialog_not_open" };
      }
      if (!mcpPaneDom.importScanLoaded()) {
        return { ok: false, reason: "scan_not_loaded" };
      }
      if (names !== undefined) {
        // Sets the selection to EXACTLY `names` (checked) with every other
        // currently-listed candidate unchecked — not merely "ensure these are
        // checked" — so a caller can apply one specific candidate at a time
        // regardless of the dialog's own default-checked seeding
        // (`defaultImportSelection`).
        const wanted = new Set(names);
        for (const candidate of mcpPaneDom.importCandidates()) {
          if (!mcpPaneDom.setCandidateChecked(candidate.name, wanted.has(candidate.name))) {
            return { ok: false, reason: "candidate_not_found" };
          }
        }
      }
      mcpPaneDom.setConsentChecked(consent);
      const before = mcpPaneDom.importResultsSignature();
      // A real click on the dialog's Apply button (design §4 W4) — not a
      // synthetic bridge call, so the smoke exercises the exact same
      // `applyImport` path a user's click fires, including the consent flag
      // it reads off the SAME checkbox `setConsentChecked` above just drove.
      if (!mcpPaneDom.clickApplyButton()) {
        return { ok: false, reason: "apply_disabled" };
      }
      // Apply is a real main-process IPC round-trip (config-write.ts's
      // atomic tmp+rename); wait for the dialog's results list to visibly
      // change before returning, so a caller's very next disk read never
      // races an in-flight write.
      const applied = await waitUntil(() => mcpPaneDom.importResultsSignature() !== before, MCP_PANE_APPLY_DEADLINE_MS);
      return applied ? { ok: true } : { ok: false, reason: "apply_timeout" };
    },

    skillsPaneState(): SkillsPaneState {
      if (!skillsPaneDom.mounted()) {
        // A valid reading, not an error (McpPaneState precedent): the
        // Settings dialog is closed, or a different pane is currently active.
        return { rows: [], problems: 0, importOpen: false, importCandidates: [] };
      }
      const open = skillsPaneDom.importOpen();
      return {
        rows: skillsPaneDom.rows(),
        problems: skillsPaneDom.problemCount(),
        importOpen: open,
        // Only populated while the dialog is open (McpPaneState precedent):
        // a closed dialog has no live candidates to report.
        importCandidates: open ? skillsPaneDom.importCandidates() : [],
      };
    },

    async skillsToggle(name: string): Promise<FacadeResult> {
      if (!skillsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const before = skillsPaneDom.rowEnabled(name);
      if (before === undefined) {
        return { ok: false, reason: "row_not_found" };
      }
      // A real click on the row's own enable/disable switch (design §5 W4)
      // — not a synthetic bridge poke, since the toggle round-trips through
      // the real `SkillsBridge.setEnabled` the component itself calls. A
      // read-only plugin row has no switch at all (`clickRowToggle` returns
      // `false`) — the ONE structural refusal beyond "unknown row", same
      // posture as `mcpToggle`'s `not_toggleable`.
      if (!skillsPaneDom.clickRowToggle(name)) {
        return { ok: false, reason: "not_toggleable" };
      }
      // Same commit-race guard as mcpToggle: the click schedules an async
      // bridge round-trip (main IPC + fs write) before the row's own
      // `data-skill-enabled` attribute actually flips.
      const toggled = await waitUntil(() => skillsPaneDom.rowEnabled(name) !== before, SKILLS_PANE_APPLY_DEADLINE_MS);
      return toggled ? { ok: true } : { ok: false, reason: "did_not_toggle" };
    },

    async skillsDelete(name: string): Promise<FacadeResult> {
      if (!skillsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      if (!skillsPaneDom.rowExists(name)) {
        return { ok: false, reason: "row_not_found" };
      }
      // Two real clicks (design §5 W3's inline confirm-row UX, mirrored
      // faithfully rather than skipped): the trash icon opens the inline
      // "Delete "<name>"?" confirm row, THEN its own Delete button actually
      // fires `SkillsBridge.delete`. A read-only plugin row renders neither
      // control (`clickRowDelete` returns `false`).
      if (!skillsPaneDom.clickRowDelete(name)) {
        return { ok: false, reason: "not_deletable" };
      }
      const confirmShown = await waitUntil(() => skillsPaneDom.confirmDeleteVisible(name), SKILLS_PANE_COMMIT_DEADLINE_MS);
      if (!confirmShown) {
        return { ok: false, reason: "confirm_not_shown" };
      }
      if (!skillsPaneDom.clickRowConfirmDelete(name)) {
        return { ok: false, reason: "confirm_not_shown" };
      }
      const deleted = await waitUntil(() => !skillsPaneDom.rowExists(name), SKILLS_PANE_APPLY_DEADLINE_MS);
      return deleted ? { ok: true } : { ok: false, reason: "did_not_delete" };
    },

    async skillsImportOpen(): Promise<FacadeResult> {
      if (!skillsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      if (!skillsPaneDom.importOpen()) {
        // A real click on the header's import button (design §5 W4) — the
        // SAME button `openImport` fires from; there is no store action to
        // call instead (the dialog's open state is local component
        // `useState`), same posture as `mcpImportOpen`'s header click.
        skillsPaneDom.clickImportButton();
        const opened = await waitUntil(() => skillsPaneDom.importOpen(), SKILLS_PANE_COMMIT_DEADLINE_MS);
        if (!opened) {
          return { ok: false, reason: "did_not_open" };
        }
      }
      // Opening the dialog kicks off a real `bridge.importScan` round-trip
      // (main-process fs fan-out over the §3 allowlist) — wait for it to
      // settle (even to zero candidates) before returning, so a caller's
      // very next `skillsPaneState()` read never races an in-flight scan.
      const scanned = await waitUntil(() => skillsPaneDom.importScanLoaded(), SKILLS_PANE_SCAN_DEADLINE_MS);
      return scanned ? { ok: true } : { ok: false, reason: "scan_timeout" };
    },

    async skillsImportApply({ scope, ids }: { scope: SkillScope; ids?: string[] }): Promise<FacadeResult> {
      if (!skillsPaneDom.importOpen()) {
        return { ok: false, reason: "dialog_not_open" };
      }
      if (!skillsPaneDom.importScanLoaded()) {
        return { ok: false, reason: "scan_not_loaded" };
      }
      if (ids !== undefined) {
        // Sets the selection to EXACTLY `ids` (checked) with every other
        // currently-listed candidate unchecked — not merely "ensure these
        // are checked" — same posture as `mcpImportApply`'s `names`, but
        // keyed on the candidate's stable `id` (design §5 W2 note: two
        // harnesses can share a bare `name`, `id` cannot collide). Omitted
        // ⇒ leave the dialog's own current (default-checked) selection
        // as-is, e.g. a caller that only wants `skillsImportOpen`'s default
        // seeding (`defaultImportSelection` — compatible AND not already
        // present) applied verbatim.
        const wanted = new Set(ids);
        for (const candidate of skillsPaneDom.importCandidates()) {
          if (!skillsPaneDom.setCandidateChecked(candidate.id, wanted.has(candidate.id))) {
            return { ok: false, reason: "candidate_not_found" };
          }
        }
      }
      skillsPaneDom.setImportScope(scope);
      const before = skillsPaneDom.importResultsSignature();
      // A real click on the dialog's Apply button (design §5 W4) — not a
      // synthetic bridge call, so the smoke exercises the exact same
      // `applyImport` path a user's click fires, including the scope the
      // `setImportScope` call above just drove onto the SAME radio group.
      if (!skillsPaneDom.clickApplyButton()) {
        return { ok: false, reason: "apply_disabled" };
      }
      // Apply is a real main-process IPC round-trip (convert+copy into the
      // target catalog, atomic config write); wait for the dialog's results
      // list to visibly change before returning, so a caller's very next
      // disk read never races an in-flight write.
      const applied = await waitUntil(() => skillsPaneDom.importResultsSignature() !== before, SKILLS_PANE_APPLY_DEADLINE_MS);
      return applied ? { ok: true } : { ok: false, reason: "apply_timeout" };
    },

    subagentsPaneState(): SubagentsPaneState {
      if (!subagentsPaneDom.mounted()) {
        // A valid reading, not an error (SkillsPaneState precedent): the
        // Settings dialog is closed, or a different pane is currently active.
        return { rows: [], problems: 0, editor: blankSubagentsEditorState() };
      }
      const editorOpen = subagentsPaneDom.editorOpen();
      const fields = editorOpen ? subagentsPaneDom.fieldValues() : null;
      return {
        rows: subagentsPaneDom.rows(),
        problems: subagentsPaneDom.problemCount(),
        editor: editorOpen
          ? {
              open: true,
              mode: subagentsPaneDom.editorMode(),
              tab: subagentsPaneDom.editorTab(),
              name: fields?.name ?? "",
              description: fields?.description ?? "",
              tools: fields?.tools ?? [],
              body: fields?.body ?? "",
              canSave: subagentsPaneDom.canSave(),
              error: subagentsPaneDom.errorText(),
              issues: subagentsPaneDom.issues(),
              previewLoading: subagentsPaneDom.previewLoading(),
              previewSystemPrompt: subagentsPaneDom.previewPromptText(),
              previewEffectiveTools: parseEffectiveToolsLine(subagentsPaneDom.previewToolsLine()),
            }
          : blankSubagentsEditorState(),
      };
    },

    async subagentsOpenEditor(name?: string): Promise<FacadeResult> {
      if (!subagentsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      if (subagentsPaneDom.editorOpen()) {
        return { ok: false, reason: "already_open" };
      }
      if (name === undefined) {
        // A real click on the header's "Create subagent" button (design §4
        // W4) — `openCreate` is purely local `useState`, so the dialog mounts
        // synchronously; no IPC round-trip to await.
        subagentsPaneDom.clickCreateButton();
      } else {
        if (!subagentsPaneDom.rowExists(name)) {
          return { ok: false, reason: "row_not_found" };
        }
        // A real click on the row's Edit button (design §4 W4) — `openEdit`
        // round-trips through a REAL `bridge.read()` IPC call (main
        // re-resolves the path + parses the file) before the dialog mounts, a
        // read-only built-in/plugin row has no Edit button at all.
        if (!subagentsPaneDom.clickRowEdit(name)) {
          return { ok: false, reason: "not_editable" };
        }
      }
      const opened = await waitUntil(() => subagentsPaneDom.editorOpen(), SUBAGENTS_PANE_OPEN_DEADLINE_MS);
      return opened ? { ok: true } : { ok: false, reason: "did_not_open" };
    },

    async subagentsEditorSet({
      name,
      description,
      tools,
      body,
    }: {
      name?: string;
      description?: string;
      tools?: string[];
      body?: string;
    }): Promise<FacadeResult> {
      if (!subagentsPaneDom.editorOpen()) {
        return { ok: false, reason: "editor_not_open" };
      }
      if (name !== undefined) {
        if (!subagentsPaneDom.setName(name)) {
          return { ok: false, reason: "field_not_found" };
        }
        const applied = await waitUntil(() => subagentsPaneDom.fieldValues()?.name === name, SUBAGENTS_PANE_COMMIT_DEADLINE_MS);
        if (!applied) {
          return { ok: false, reason: "set_failed" };
        }
      }
      if (description !== undefined) {
        if (!subagentsPaneDom.setDescription(description)) {
          return { ok: false, reason: "field_not_found" };
        }
        const applied = await waitUntil(
          () => subagentsPaneDom.fieldValues()?.description === description,
          SUBAGENTS_PANE_COMMIT_DEADLINE_MS,
        );
        if (!applied) {
          return { ok: false, reason: "set_failed" };
        }
      }
      if (body !== undefined) {
        if (!subagentsPaneDom.setBody(body)) {
          return { ok: false, reason: "field_not_found" };
        }
        const applied = await waitUntil(() => subagentsPaneDom.fieldValues()?.body === body, SUBAGENTS_PANE_COMMIT_DEADLINE_MS);
        if (!applied) {
          return { ok: false, reason: "set_failed" };
        }
      }
      if (tools !== undefined) {
        if (!subagentsPaneDom.setTools(tools)) {
          return { ok: false, reason: "field_not_found" };
        }
        const wanted = new Set(tools);
        const applied = await waitUntil(() => {
          const current = new Set(subagentsPaneDom.fieldValues()?.tools ?? []);
          return current.size === wanted.size && [...wanted].every((tool) => current.has(tool));
        }, SUBAGENTS_PANE_COMMIT_DEADLINE_MS);
        if (!applied) {
          return { ok: false, reason: "set_failed" };
        }
      }
      return { ok: true };
    },

    async subagentsEditorPreview(): Promise<SubagentsPreviewFacadeResult> {
      if (!subagentsPaneDom.editorOpen()) {
        return { ok: false, reason: "editor_not_open" };
      }
      if (subagentsPaneDom.editorTab() !== "preview" && !subagentsPaneDom.clickPreviewTab()) {
        return { ok: false, reason: "preview_tab_not_found" };
      }
      // Switching to Preview kicks off a real `bridge.preview()` IPC
      // round-trip (main builds the REAL child system prompt, design §2-D4).
      // `previewLoading()` alone is a vacuous-truth trap: it reads false BOTH
      // when the round-trip has genuinely finished AND before the click's
      // `setEditorTab("preview")`/`setPreviewLoading(true)` pair has even
      // committed (the `.subagents-preview-pane` loading marker doesn't exist
      // yet, so the query finds nothing and reads as "not loading"). A
      // programmatic `.click()` does not flush its React state update
      // synchronously here, so `waitUntil`'s first predicate check can land in
      // that pre-commit window and return `settled` instantly, before the
      // preview ever started — the caller then reads a stale/absent prompt
      // and reports `preview_unavailable` even though the real preview later
      // arrives just fine. Gating on `editorTab() === "preview"` too closes
      // the window: that flips in the SAME commit as `previewLoading`, so
      // "not preview yet" can never be misread as "loading finished".
      const settled = await waitUntil(
        () => subagentsPaneDom.editorTab() === "preview" && !subagentsPaneDom.previewLoading(),
        SUBAGENTS_PANE_PREVIEW_DEADLINE_MS,
      );
      if (!settled) {
        return { ok: false, reason: "preview_timeout" };
      }
      const systemPrompt = subagentsPaneDom.previewPromptText();
      if (systemPrompt === null) {
        return { ok: false, reason: "preview_unavailable" };
      }
      return { ok: true, systemPrompt, effectiveTools: parseEffectiveToolsLine(subagentsPaneDom.previewToolsLine()) ?? [] };
    },

    async subagentsEditorSave(): Promise<SubagentsEditorSaveResult> {
      if (!subagentsPaneDom.editorOpen()) {
        return { ok: false, reason: "editor_not_open" };
      }
      if (!subagentsPaneDom.clickSave()) {
        return { ok: false, reason: "cannot_save" };
      }
      // Save is a real main-process IPC round-trip (validate + atomic
      // tmp+rename write, design §2-D7); a successful save closes the dialog,
      // a refused one keeps it open with `.settings-env-warning` populated —
      // wait for either observable outcome before returning.
      const settled = await waitUntil(
        () => !subagentsPaneDom.editorOpen() || subagentsPaneDom.errorText() !== null,
        SUBAGENTS_PANE_APPLY_DEADLINE_MS,
      );
      if (!settled) {
        return { ok: false, reason: "save_timeout" };
      }
      if (subagentsPaneDom.editorOpen()) {
        const issues = subagentsPaneDom.issues();
        return { ok: false, reason: subagentsPaneDom.errorText() ?? "save_rejected", ...(issues.length > 0 ? { issues } : {}) };
      }
      return { ok: true };
    },

    async subagentsDelete(name: string): Promise<FacadeResult> {
      if (!subagentsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      if (!subagentsPaneDom.rowExists(name)) {
        return { ok: false, reason: "row_not_found" };
      }
      // Two real clicks (SkillsPane's inline confirm-row UX, mirrored
      // faithfully): the trash icon opens the "Delete "<name>"?" confirm row,
      // THEN its own Delete button actually fires `SubagentsBridge.delete`. A
      // read-only built-in/plugin row renders neither control.
      if (!subagentsPaneDom.clickRowDelete(name)) {
        return { ok: false, reason: "not_deletable" };
      }
      const confirmShown = await waitUntil(() => subagentsPaneDom.confirmDeleteVisible(name), SUBAGENTS_PANE_COMMIT_DEADLINE_MS);
      if (!confirmShown) {
        return { ok: false, reason: "confirm_not_shown" };
      }
      if (!subagentsPaneDom.clickRowConfirmDelete(name)) {
        return { ok: false, reason: "confirm_not_shown" };
      }
      const deleted = await waitUntil(() => !subagentsPaneDom.rowExists(name), SUBAGENTS_PANE_APPLY_DEADLINE_MS);
      return deleted ? { ok: true } : { ok: false, reason: "did_not_delete" };
    },

    profilePaneState(): ProfilePaneState {
      if (!profilePaneDom.mounted()) {
        // A valid reading, not an error (SubagentsPaneState precedent): the
        // Settings dialog is closed, or a different pane is currently active.
        return blankProfilePaneState();
      }
      const branch = profilePaneDom.branch();
      const insightRows = profilePaneDom.insightRows();
      const insightValue = (label: string): string => insightRows.find((row) => row.label === label)?.value ?? "";
      const parseCount = (label: string): number => {
        const n = Number(insightValue(label));
        return Number.isFinite(n) ? n : 0;
      };
      const sw = profilePaneDom.telemetrySwitch();
      return {
        mounted: true,
        tiles: profilePaneDom.tiles(),
        insights: {
          totalSessions: parseCount("Total tasks"),
          totalRuns: parseCount("Total runs"),
          toolCalls: parseCount("Tool calls"),
          subagentRuns: parseCount("Subagent runs"),
          mostUsedModel: insightValue("Most used model"),
        },
        topTools: profilePaneDom.topToolNames(),
        heatmapNonEmptyCells: profilePaneDom.heatmapNonEmptyCellCount(),
        telemetryEnabled: sw?.checked ?? false,
        killSwitchActive: sw?.disabled ?? false,
        truncated: profilePaneDom.truncatedVisible(),
        emptyStateHero: branch === "hero",
        frozenBanner: profilePaneDom.bannerVisible(),
      };
    },

    async profileToggleTelemetry(): Promise<FacadeResult> {
      if (!profilePaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const before = profilePaneDom.telemetrySwitch();
      if (before === null) {
        return { ok: false, reason: "toggle_not_present" };
      }
      if (before.disabled) {
        return { ok: false, reason: "toggle_disabled" };
      }
      // A real click on the toggle switch (design §4 W4) — not a synthetic
      // bridge poke, since the flip round-trips through the real
      // `ProfileBridge.setTelemetry` the component itself calls (main IPC +
      // atomic user-config write).
      if (!profilePaneDom.clickTelemetryToggle()) {
        return { ok: false, reason: "toggle_not_present" };
      }
      const toggled = await waitUntil(
        () => profilePaneDom.telemetrySwitch()?.checked !== before.checked,
        PROFILE_PANE_APPLY_DEADLINE_MS,
      );
      return toggled ? { ok: true } : { ok: false, reason: "did_not_toggle" };
    },

    slashMenuState(tabId: string): SlashMenuState | FacadeErr {
      // Same structural refusal as modelPillState/ctxPopoverState (design §7
      // W4): the composer only ever lives inside the active tab's mounted
      // ActiveTabBody.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const textarea = composerSlashDom.textarea();
      const draft = textarea?.value ?? "";
      const caret = textarea?.selectionStart ?? draft.length;
      // Same pure fn Composer.tsx itself calls every render (design §7) — a
      // fresh recompute over the identical (text, caret) pair cannot drift
      // from what the component derives.
      const query = slashQueryAt(draft, caret)?.query ?? "";
      if (!composerSlashDom.menuMounted()) {
        // A valid reading, not an error (ModelPillState/CtxPopoverState
        // precedent): no trigger active, or the menu is closed/dismissed/
        // zero-matched.
        return { ok: true, open: false, query, selectedIndex: 0, draft, items: [] };
      }
      const rows = [...composerSlashDom.rows()].sort((a, b) => a.index - b.index);
      return {
        ok: true,
        open: true,
        query,
        selectedIndex: rows.find((row) => row.selected)?.index ?? 0,
        draft,
        items: rows.map((row) => ({
          name: row.name,
          section: row.section,
          sourceLabel: row.sourceLabel ?? undefined,
          disabled: row.disabled,
          highlighted: row.highlighted,
        })),
      };
    },

    composerType(tabId: string, text: string): FacadeResult {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const textarea = composerSlashDom.textarea();
      if (!textarea) {
        return { ok: false, reason: "not_present" };
      }
      // Same native-setter + real-event discipline as `setNativeTextAreaValue`
      // above (design §7: "must go through React, NOT a bare .value=") — the
      // caret is explicitly placed at the end BEFORE dispatch, so Composer's
      // own onChange->syncCaret reads the post-keystroke caret position
      // synchronously within the same dispatch, exactly like a real typed run.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) {
        setter.call(textarea, text);
      } else {
        textarea.value = text;
      }
      textarea.setSelectionRange(text.length, text.length);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    },

    composerKey(tabId: string, key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape"): FacadeResult {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      if (!registry.getStore(tabId)) {
        return { ok: false, reason: "unknown_tab" };
      }
      const textarea = composerSlashDom.textarea();
      if (!textarea) {
        return { ok: false, reason: "not_present" };
      }
      // A real dispatched KeyboardEvent (design §7), so Composer's own
      // onKeyDown handler runs exactly as it would for a real keystroke.
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      return { ok: true };
    },

    shortcutsPaneState(): ShortcutsPaneState {
      if (!shortcutsPaneDom.mounted()) {
        // A valid reading, not an error (ProfilePaneState precedent): the
        // Settings dialog is closed, or a different pane is currently active.
        return blankShortcutsPaneState();
      }
      const chipText = shortcutsPaneDom.recordingChipText();
      return {
        mounted: true,
        query: shortcutsPaneDom.query(),
        rows: shortcutsPaneDom.rows(),
        // "Press shortcut…" is the neutral (no-refusal-yet) chip text
        // (`RecordingChip`'s own default) — everything else IS a refusal.
        errorText: chipText !== null && chipText !== "Press shortcut…" ? chipText : null,
      };
    },

    async shortcutsStartRecord(action: string, slotIndex?: number): Promise<FacadeResult> {
      if (!shortcutsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const row = shortcutsPaneDom.rows().find((r) => r.action === action);
      if (!row) {
        return { ok: false, reason: "row_not_found" };
      }
      if (!row.editable) {
        return { ok: false, reason: "not_editable" };
      }
      const targetSlot = slotIndex ?? row.bindings.length;
      // A real click on the pencil (re-record an existing slot) or the "+
      // Add" button (append) — the SAME two entry points
      // `KeyboardShortcutsPane.tsx`'s own `startRecording` call sites use.
      const clicked =
        targetSlot >= row.bindings.length ? shortcutsPaneDom.clickAdd(action) : shortcutsPaneDom.clickEditSlot(action, targetSlot);
      if (!clicked) {
        return { ok: false, reason: "control_not_present" };
      }
      // Local `useState` flip (design §4 W4), no IPC round-trip — same
      // commit-race guard as modelPillPick, just a shorter deadline.
      const started = await waitUntil(
        () => shortcutsPaneDom.rows().find((r) => r.action === action)?.recording === true,
        SHORTCUTS_PANE_COMMIT_DEADLINE_MS,
      );
      return started ? { ok: true } : { ok: false, reason: "did_not_start" };
    },

    shortcutsPressChord(chord: { key: string; mod: boolean; shift?: boolean }): FacadeResult {
      const platform = window.anycode?.platform ?? "darwin";
      // `key` is dispatched VERBATIM (design §4 W4) — a real KeyboardEvent's
      // `.key` for a bare letter is exactly that lowercase character (e.g.
      // "d"), while special keys carry their own capitalized name (e.g.
      // "Escape", matched by the pane's OWN cancel branch via an exact
      // `event.key === "Escape"` check); forcing a case transform here would
      // silently break that path. `matchKeymap`/`classifyRecordedStroke`
      // already lowercase internally before comparing, so a caller-supplied
      // lowercase letter needs no help from this driver.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: chord.key,
          code: chord.key.length === 1 ? `Key${chord.key.toUpperCase()}` : chord.key,
          metaKey: platform === "darwin" && chord.mod,
          ctrlKey: platform !== "darwin" && chord.mod,
          shiftKey: chord.shift ?? false,
          altKey: false,
          bubbles: true,
          cancelable: true,
        }),
      );
      return { ok: true };
    },

    async shortcutsRemoveBinding(action: string, slotIndex: number): Promise<FacadeResult> {
      if (!shortcutsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const before = shortcutsPaneDom.rows().find((r) => r.action === action);
      if (!before) {
        return { ok: false, reason: "row_not_found" };
      }
      // A real click on the badge's "×" (design §4 W4) — not a synthetic
      // store poke, since the removal round-trips through the real
      // `store.setPatch` the component itself calls.
      if (!shortcutsPaneDom.clickRemoveSlot(action, slotIndex)) {
        return { ok: false, reason: "control_not_present" };
      }
      const beforeCount = before.bindings.length;
      const removed = await waitUntil(() => {
        const now = shortcutsPaneDom.rows().find((r) => r.action === action);
        return now !== undefined && now.bindings.length === beforeCount - 1;
      }, SHORTCUTS_PANE_APPLY_DEADLINE_MS);
      return removed ? { ok: true } : { ok: false, reason: "did_not_remove" };
    },

    async shortcutsReset(action: string): Promise<FacadeResult> {
      if (!shortcutsPaneDom.mounted()) {
        return { ok: false, reason: "pane_not_mounted" };
      }
      const row = shortcutsPaneDom.rows().find((r) => r.action === action);
      if (!row) {
        return { ok: false, reason: "row_not_found" };
      }
      if (!row.overridden) {
        return { ok: false, reason: "not_overridden" };
      }
      // A real click on the row's Reset button (design §4 W4) — not a
      // synthetic store poke, since it round-trips through the real
      // `store.setPatch` the component itself calls.
      if (!shortcutsPaneDom.clickReset(action)) {
        return { ok: false, reason: "control_not_present" };
      }
      const reset = await waitUntil(
        () => shortcutsPaneDom.rows().find((r) => r.action === action)?.overridden === false,
        SHORTCUTS_PANE_APPLY_DEADLINE_MS,
      );
      return reset ? { ok: true } : { ok: false, reason: "did_not_reset" };
    },

    lspPanelState(tabId: string): LspPanelState | FacadeErr {
      // Same structural refusal as todoPanelState/modelPillState (design §3
      // W3): LspPanel only ever renders for the active tab.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const panel = lspPanelDom.panel();
      if (panel === null) {
        // A valid reading, not an error (design §3 W3): the panel isn't
        // toggled open for this tab.
        return { ok: true, open: false, counts: null, servers: [] };
      }
      return { ok: true, open: true, ...panel };
    },

    lspPanelToggle(tabId: string): FacadeResult {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      // A real click on the SessionHeader toggle button (design §3 W3) — not
      // a synthetic store poke, matching the panel's own toggleLspPanel path.
      lspPanelDom.toggle();
      return { ok: true };
    },

    hooksPanelState(tabId: string): HooksPanelState | FacadeErr {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const panel = hooksPanelDom.panel();
      if (panel === null) {
        return { ok: true, open: false, configError: null, groups: [] };
      }
      return { ok: true, open: true, ...panel };
    },

    hooksPanelToggle(tabId: string): FacadeResult {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      hooksPanelDom.toggle();
      return { ok: true };
    },

    async checkpointPanelState(tabId: string): Promise<CheckpointPanelState | FacadeErr> {
      // Same structural refusal as lspPanelState/hooksPanelState (design §1
      // W3): TimelinePanel only ever renders for the active tab.
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const before = JSON.stringify(checkpointPanelDom.panel());
      // The checkpoint list is on-demand-only (this method's own doc comment
      // above) — open the panel if it's closed (its mount effect sends
      // checkpoint_list_request), or click Refresh if it's already open
      // (same request, forced fresh), then wait for the reply to land.
      if (checkpointPanelDom.panel() === null) {
        checkpointPanelDom.toggle();
      } else {
        checkpointPanelDom.refresh();
      }
      await waitUntil(() => JSON.stringify(checkpointPanelDom.panel()) !== before, CHECKPOINT_PANEL_LOAD_DEADLINE_MS);
      const panel = checkpointPanelDom.panel();
      if (panel === null) {
        // A valid reading, not an error: the toggle click somehow failed to
        // mount the panel (should not happen — defensive parity with the
        // other panel probes' "closed" reading).
        return { ok: true, visible: false, items: [] };
      }
      return { ok: true, visible: true, items: panel.items };
    },

    rewindState(tabId: string): RewindStateResult | FacadeErr {
      return readRewindState(registry, tabsStore, dom, transcriptBlockDom, tabId);
    },

    async checkpointRewind(
      tabId: string,
      args: { checkpointId?: string; index?: number; scope: RewindScopeWire },
    ): Promise<CheckpointRewindResult | FacadeErr> {
      if (tabsStore.getState().activeTabId !== tabId) {
        return { ok: false, reason: "tab_not_active" };
      }
      const store = registry.getStore(tabId);
      if (!store) {
        return { ok: false, reason: "unknown_tab" };
      }
      let checkpointId = args.checkpointId;
      if (checkpointId === undefined) {
        if (args.index === undefined) {
          return { ok: false, reason: "checkpoint_not_specified" };
        }
        // Same newest-first order TimelinePanel itself renders in (design §7
        // — a TIMELINE, not wire/creation order).
        const ordered = sortCheckpointsNewestFirst(store.getState().checkpoints);
        const target = ordered[args.index];
        if (!target) {
          return { ok: false, reason: "checkpoint_not_found" };
        }
        checkpointId = target.id;
      }
      // W3-FIX (codex #1): correlate the settled reply against THIS call's own
      // requestId, not "any change to the slot" — a busy/disabled rewind still
      // fires a rewind_result (design §1: "a non-silent refusal"), and two
      // concurrent rewinds must not satisfy each other's wait.
      const requestId = crypto.randomUUID();
      // The SAME wire message TimelinePanel.confirmRewind sends (design §1
      // W3) — buildRewindRequest is not reused directly since it hardcodes
      // v1's `scope: "both"`, while this driver must exercise every scope.
      const message: UiToHostMessage = { type: "rewind_request", requestId, checkpointId, scope: args.scope };
      registry.sendToTab(tabId, message);
      const settled = await waitUntil(() => store.getState().lastRewindResult?.requestId === requestId, REWIND_SETTLE_DEADLINE_MS);
      if (!settled) {
        return { ok: false, reason: "rewind result timeout" };
      }
      const state = readRewindState(registry, tabsStore, dom, transcriptBlockDom, tabId);
      if (!state.ok) {
        return state;
      }
      // The just-matched result IS `state.lastResult` (readRewindState reads
      // the same live store field this predicate just confirmed carries our
      // requestId) — surface its real ok/reason at the top level too (codex
      // #1's literal ask), not the structural probe-succeeded `ok:true` above.
      const hostResult = store.getState().lastRewindResult;
      return { ok: hostResult?.ok ?? false, reason: hostResult?.reason ?? null, lastResult: state.lastResult, transcriptBlockCount: state.transcriptBlockCount };
    },
  };
}

declare global {
  interface Window {
    __anycodeAutomation?: AutomationFacade;
  }
}

/** Installs the facade onto `window.__anycodeAutomation`. Called only from main.tsx's `import.meta.env.DEV`-gated dynamic import (design §2.2/§5). */
export function installAutomation(facade: AutomationFacade = createAutomationFacade()): void {
  window.__anycodeAutomation = facade;
}

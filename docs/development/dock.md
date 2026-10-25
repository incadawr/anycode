# The right-side dock (Taskana 4703)

One tabbed dock column on the right side of the session content replaces the
stack of independent fixed-width columns. This note is the design record for
that change: what lived where before, where it lives now, and the acceptance
deltas.

## Root cause being fixed

`.session-content-split-open` was a grid whose conversation column was
`minmax(0, 1fr)` — collapsible to ~0 — while EVERY right-side surface added
its own fixed-width column + 8px handle:

- git review panel: `anycode.review.width` (360–960, default 560)
- preview panel: `anycode.preview.width` (360–1280, default 640)
- subagents split stack: `anycode.childSplit.width` (360–960, default 480)

Worst case 560+640+480 = 1680px of fixed columns. The only live guard was
`rootWidth - 320` applied ONLY while dragging that one handle; persisted/boot
widths were never re-clamped to the window and the three never sum-clamped.
With the sidebar (~240px) the conversation column got the scraps — the
owner's repro (md preview + browser preview + subagents + git at a ~2000px
window squeezing the conversation to ~550px).

## Inventory → mapping

| Surface | Before | After (the dock) |
|---|---|---|
| web preview (WebContentsView) | preview column, single visible slot + header `<select>` picker | tab `preview:<previewId>` |
| markdown preview (dom-md) | same column, `MarkdownPreviewView.tsx` | tab `preview:<previewId>` |
| subagents split stack | own column, `ChildSplitPane.tsx` | tab `subagents` |
| git review | own column, `GitPanel` | tab `git` |
| LSP / Hooks / Timeline | absolute right overlays | UNCHANGED — overlays never squash columns |
| Terminal | bottom panel | UNCHANGED |
| TodoPanel / BackgroundAgents | inline (MessageList/Composer) | UNCHANGED |

## The dock (Stage 1)

- `apps/desktop/src/renderer/src/dock/dock-layout.ts` — pure geometry:
  `DOCK_WIDTH_STORAGE_KEY = "anycode.dock.width"` (320–960, default 640),
  `CONVERSATION_MIN_PX = 420`, `DOCK_HANDLE_PX = 8`,
  `clampDockWidth(width, available)` and `computeDockMode(available)`
  ("drawer" iff `available - 8 - 320 < 420`, i.e. below 748px available; the
  dock then becomes an absolute overlay and the conversation keeps full
  width).
- `dock/dock-store.ts` — zustand: `tabs`, `activeTabId`, `width` (persisted
  on resize-end), `hidden` (toggle flag, not persisted).
- `components/DockPanel.tsx` — tab strip (scrollable, one button per tab +
  per-tab close ×, ⌘W closes the active tab when the dock holds focus) and
  the active tab's body only. One resize handle, clamped live against
  `available`.
- `App.tsx` — `computeSessionContentColumns(dockOpen, dockWidth)`: the
  conversation column is `minmax(min(420px,100%), 1fr)` (a real floor), plus
  `8px <dockWidth>px` when the dock is open in column mode. Tab derivation
  effects mirror preview-store / child-layout / git-panel state into dock
  tabs; `usePanelMountState` keeps reporting `previewMounted` so the main-side
  WebContentsView gating (D7) is unchanged.
- `PreviewPanel.tsx` — renders one named preview (props `tabId`, `previewId`,
  `onToast`); the old visible-slot `<select>` picker is gone — the tab strip
  is the picker. Bounds publisher, `MarkdownPreviewView` unified header,
  "Open in window" transfer and close all unchanged.

## Acceptance deltas

- ONE dock width (`anycode.dock.width`) replaces three persisted widths.
  `anycode.review.width` and `anycode.childSplit.width` are retired (left in
  users' storage, never read again). `anycode.preview.width` is read ONCE as
  the seed for the dock width when the new key is absent, then forgotten.
- The preview picker (`<select>`) is replaced by dock tabs; opening an
  already-open item focuses its tab instead of re-slotting the single column.
- Git panel and subagents split stack live in the dock; their columns (and
  their independent resize handles) are gone.
- Conversation keeps a 420px floor in column mode (was `minmax(0,1fr)`), and
  below 748px available the dock flips to a drawer overlay so the
  conversation keeps (nearly) full width.
- Keyboard: ⌘\ / Ctrl+\ (`dock.toggle`) hides/shows the dock; ⌘W inside the
  dock closes the active dock tab.

## Main-side contract

`shared/preview-panel.ts` and `main/preview/*` are untouched: select/close/
transfer still round-trip through `previewPanel.*`; the D9 bounds publisher
still measures `.preview-panel-body`; overlay hiding (D6/D7) is unchanged.

## Stage 2 (split view on wide windows)

When `available >= 420 + 2*320 + 2*8 = 1076px` (`canSplit`), a per-tab
"Split right" (⫿) action pins a second tab into a secondary pane inside the
dock (absolute right of the primary body, width `DOCK_SPLIT_MIN_PX` =
`DOCK_WIDTH_MIN` = 320, border-left). The pinned tab stays in the strip with
an active mark; closing it or the header's merge button unpins. Shrinking
below the threshold auto-calls `mergeSplit()` — no broken split survives.
The `splitTabId` is not persisted (a boot never restores a split the window
may no longer afford). No drag between panes (by scope decision).

Split rules (cross-review 4703): the pinned tab is never the active (primary)
tab — focusing or re-opening the pinned tab unpins it — so one preview is never
rendered twice. A web preview is never splittable: its WebContentsView is
positioned by main over the primary body only (one visible panel slot per tab),
so a web preview in the secondary pane would have no place to render. Only the
primary body publishes preview bounds (the D9 channel has one owner). A new
preview that arrives while the user reads git or subagents lands in the strip
without taking focus; an explicit open still focuses its tab.

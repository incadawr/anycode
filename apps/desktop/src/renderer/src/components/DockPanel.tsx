/**
 * The right-side tabbed dock (Taskana 4703, docs/development/dock.md):
 * one column, one tab per side surface (preview:<id> / subagents / git), a
 * scrollable tab strip, and the ACTIVE tab's body only. Geometry (width
 * clamp, column/drawer mode) is computed by the caller (App.tsx) from the
 * measured session-content width and injected — this component stays
 * presentational. Close/focus semantics route through the SAME authority a
 * real click always used; the dock never invents a second path:
 *
 *  - focus `preview:*` → `previewPanel.select` (the unchanged main path —
 *    PreviewPanel.tsx's old picker precedent, PreviewPanel.tsx:104);
 *  - close `preview:*` → `previewPanel.close`, `subagents` →
 *    `childLayoutStore.close` (App.tsx's old :809 precedent), `git` →
 *    `gitSetPanelOpen(false)` (store.ts) — each store/main push then drops
 *    the tab through App.tsx's tab-derivation effects;
 *  - ⌘W/Ctrl+W while the dock holds focus closes the ACTIVE tab.
 */
import { useContext, type ReactNode } from "react";
import { TabContext, useTabStoreApi } from "../tab-context.js";
import { selectDockView, useDockStore } from "../dock/dock-store.js";
import { childLayoutStore } from "../child-layout.js";
import { DOCK_SPLIT_MIN_PX, isSplittableTab, type DockMode, type DockTab } from "../dock/dock-layout.js";
import { usePreviewStore } from "../preview/preview-store.js";
import type { ToastKind } from "../toasts.js";
import { ChildSplitPane, type ChildSplitRow } from "./ChildSplitPane.js";
import { GitPanel } from "./GitPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { Split, X } from "./icons.js";

export interface DockPanelProps {
  mode: DockMode;
  /** Already-clamped dock width in px (clampDockWidth over the measured available width, App.tsx). */
  width: number;
  /** Stage 2 (§3): canSplit(available) — gates the per-tab "Split right" action. */
  canSplitNow: boolean;
  /** Stage 2 (§3): the store's pinned split tab id (rendered in the secondary pane). */
  splitTabId: string | null;
  onToast(kind: ToastKind, text: string): void;
  /** The subagents tab's props: the verbatim App.tsx:803-816 ChildSplitPane block (composition stays in App.tsx so TabContext/tabRegistry wiring is untouched). */
  subagents: {
    rows: readonly ChildSplitRow[];
    expandedId: string;
    surface: ReactNode;
  };
}

function closeDockTab(tab: DockTab, tabId: string): void {
  if (tab.kind === "preview") {
    const previewId = tab.id.slice("preview:".length);
    window.anycode.previewPanel.close(tabId, previewId).catch((error: unknown) => {
      console.warn("[DockPanel] preview close failed", error);
    });
    return;
  }
  if (tab.id === "subagents") {
    childLayoutStore.getState().close(tabId);
    return;
  }
  if (tab.id === "git") {
    useTabStoreApi().getState().gitSetPanelOpen(false);
  }
}

function focusDockTab(tab: DockTab, tabId: string): void {
  if (tab.kind === "preview") {
    const previewId = tab.id.slice("preview:".length);
    window.anycode.previewPanel.select(tabId, previewId).catch((error: unknown) => {
      console.warn("[DockPanel] select failed", error);
    });
  }
}

const EMPTY_PREVIEWS: never[] = [];

export function DockPanel({ mode, width, onToast, subagents, canSplitNow, splitTabId }: DockPanelProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("DockPanel must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;

  // Taskana 4738: the tab set renders ONLY through the owner-gated
  // `selectDockView` — the store is global across conversation tabs, and an
  // un-gated read would paint another tab's strip for one frame on switch.
  // `splitTabId` arrives as a prop (App.tsx already gates it the same way).
  const tabs = useDockStore((state) => selectDockView(state, tabId).tabs);
  const previews = usePreviewStore((state) => state.byTab[tabId]?.previews ?? EMPTY_PREVIEWS);
  const activeTabId = useDockStore((state) => selectDockView(state, tabId).activeTabId);
  const focus = useDockStore((state) => state.focus);
  const close = useDockStore((state) => state.close);
  const splitRight = useDockStore((state) => state.splitRight);
  const mergeSplit = useDockStore((state) => state.mergeSplit);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  // Stage 2: the pinned tab stays in the strip (marked) and its content is
  // the ONLY thing the secondary pane renders — `renderTabBody` is the one
  // body renderer both panes share.
  const splitTab = splitTabId !== null ? (tabs.find((tab) => tab.id === splitTabId) ?? null) : null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "w") {
      event.preventDefault();
      event.stopPropagation();
      if (activeTab) {
        closeDockTab(activeTab, tabId);
        close(activeTab.id);
      }
    }
  }

  /** Per-tab split gate: the window must afford a split AND the tab must be splittable (not the primary, not a web preview — isSplittableTab). */
  function splitAllowedFor(tab: DockTab): boolean {
    const viewKind = tab.kind === "preview" ? previews.find((preview) => preview.previewId === tab.id.slice("preview:".length))?.viewKind : undefined;
    return canSplitNow && isSplittableTab(tab, activeTabId, viewKind);
  }

  /**
   * The one body renderer both panes share (primary = active tab, secondary =
   * pinned split tab). Only the PRIMARY body publishes preview bounds (D1).
   */
  function renderTabBody(tab: DockTab | null, publishBounds: boolean): ReactNode {
    if (tab === null) {
      return <div className="dock-empty">No side panel selected.</div>;
    }
    if (tab.kind === "preview") {
      return (
        <PreviewPanel
          key={tab.id}
          tabId={tab.id}
          previewId={tab.id.slice("preview:".length)}
          onToast={onToast}
          publishBounds={publishBounds}
        />
      );
    }
    if (tab.id === "subagents") {
      // The App.tsx:803-816 ChildSplitPane block, moved verbatim — props
      // identical, DOM contract frozen (ChildSplitPane.tsx §3.5).
      return (
        <ChildSplitPane
          rows={subagents.rows}
          expandedId={subagents.expandedId}
          onExpandRow={(id) => childLayoutStore.getState().expandRow(tabId, id)}
          onExitSplit={() => childLayoutStore.getState().exitSplit(tabId)}
          onClose={() => childLayoutStore.getState().close(tabId)}
        >
          {subagents.surface}
        </ChildSplitPane>
      );
    }
    if (tab.id === "git") {
      return <GitPanel />;
    }
    return <div className="dock-empty">No side panel selected.</div>;
  }

  return (
    <aside
      className={"dock-panel" + (mode === "drawer" ? " dock-panel-drawer" : "")}
      tabIndex={0}
      data-dock-mode={mode}
      style={{ ["--dock-width" as string]: `${width}px`, width: mode === "drawer" ? undefined : `${width}px` }}
      onKeyDown={handleKeyDown}
      aria-label="Side panels"
    >
      <div className="dock-tab-strip" role="group" aria-label="Side panels">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const pinned = tab.id === splitTabId;
          const splitAllowed = splitAllowedFor(tab);
          // Cross-review D4: each affordance is its own real <button> (tab stop,
          // Enter/Space) — the old <span role=button tabIndex=-1> nested inside
          // a <button> was unreachable by keyboard.
          return (
            <div key={tab.id} className={"dock-tab" + (active ? " dock-tab-active" : "")} data-tab-id={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="dock-tab-select"
                title={tab.title}
                onClick={() => {
                  focusDockTab(tab, tabId);
                  focus(tab.id);
                }}
              >
                <span className="dock-tab-title">{tab.title}</span>
              </button>
              <button
                type="button"
                className={"dock-tab-split" + (pinned ? " dock-tab-split-active" : "")}
                aria-label={`Split ${tab.title} right`}
                title={
                  pinned
                    ? "Pinned to split pane"
                    : !splitAllowed
                      ? canSplitNow
                        ? "Web previews show in the main pane only"
                        : "Window too narrow to split"
                      : "Split right"
                }
                data-split-for={tab.id}
                disabled={!pinned && !splitAllowed}
                onClick={() => {
                  if (pinned) {
                    mergeSplit();
                    return;
                  }
                  splitRight(tab.id, splitAllowed);
                }}
              >
                <Split />
              </button>
              <button
                type="button"
                className="dock-tab-close"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={() => {
                  closeDockTab(tab, tabId);
                  close(tab.id);
                }}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
      <div className="dock-body">
        {renderTabBody(activeTab, true)}
        {splitTab !== null && (
          // Stage 2 secondary pane: absolute right of the primary body inside
          // the dock, fixed DOCK_SPLIT_MIN_PX, border-left. NO drag between
          // panes (out of scope by design — the "Split right" button is the
          // only lever, §8.5).
          <div className="dock-split-pane" data-split-tab-id={splitTab.id}>
            <div className="dock-split-pane-header">
              <span className="dock-tab-title">{splitTab.title}</span>
              <button
                type="button"
                className="dock-split-merge"
                aria-label="Merge split pane"
                title="Merge back into tabs"
                onClick={() => mergeSplit()}
              >
                <X />
              </button>
            </div>
            <div className="dock-split-pane-body">{renderTabBody(splitTab, false)}</div>
          </div>
        )}
      </div>
      {/* GitHub #31: the resize handle is NOT rendered here. As a child of the
          column-flex .dock-panel it was a full-width 0px-tall strip with no
          hit area; App.tsx renders it as the direct grid child filling the
          reserved 8px column instead. */}
    </aside>
  );
}

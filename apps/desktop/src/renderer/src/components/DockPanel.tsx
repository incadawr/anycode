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
import { useDockStore } from "../dock/dock-store.js";
import { childLayoutStore } from "../child-layout.js";
import type { DockMode, DockTab } from "../dock/dock-layout.js";
import type { ToastKind } from "../toasts.js";
import { ChildSplitPane, type ChildSplitRow } from "./ChildSplitPane.js";
import { GitPanel } from "./GitPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { X } from "./icons.js";

export interface DockPanelProps {
  mode: DockMode;
  /** Already-clamped dock width in px (clampDockWidth over the measured available width, App.tsx). */
  width: number;
  /** The drag-resize entry (App.tsx's beginDockResize — mirror of the retired beginPreviewResize). */
  onResizeStart(event: React.PointerEvent<HTMLDivElement>): void;
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

export function DockPanel({ mode, width, onResizeStart, onToast, subagents }: DockPanelProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("DockPanel must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;

  const tabs = useDockStore((state) => state.tabs);
  const activeTabId = useDockStore((state) => state.activeTabId);
  const focus = useDockStore((state) => state.focus);
  const close = useDockStore((state) => state.close);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

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

  return (
    <aside
      className={"dock-panel" + (mode === "drawer" ? " dock-panel-drawer" : "")}
      tabIndex={0}
      data-dock-mode={mode}
      style={{ ["--dock-width" as string]: `${width}px`, width: mode === "drawer" ? undefined : `${width}px` }}
      onKeyDown={handleKeyDown}
      aria-label="Side panels"
    >
      <div className="dock-tab-strip" role="tablist" aria-label="Side panels">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              className={"dock-tab" + (active ? " dock-tab-active" : "")}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.title}
              onClick={() => {
                focusDockTab(tab, tabId);
                focus(tab.id);
              }}
            >
              <span className="dock-tab-title">{tab.title}</span>
              <span
                role="button"
                tabIndex={-1}
                className="dock-tab-close"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDockTab(tab, tabId);
                  close(tab.id);
                }}
              >
                <X />
              </span>
            </button>
          );
        })}
      </div>
      <div className="dock-body">
        {activeTab?.kind === "preview" ? (
          <PreviewPanel key={activeTab.id} tabId={activeTab.id} previewId={activeTab.id.slice("preview:".length)} onToast={onToast} />
        ) : activeTab?.id === "subagents" ? (
          // The App.tsx:803-816 ChildSplitPane block, moved verbatim — props
          // identical, DOM contract frozen (ChildSplitPane.tsx §3.5).
          <ChildSplitPane
            rows={subagents.rows}
            expandedId={subagents.expandedId}
            onExpandRow={(id) => childLayoutStore.getState().expandRow(tabId, id)}
            onExitSplit={() => childLayoutStore.getState().exitSplit(tabId)}
            onClose={() => childLayoutStore.getState().close(tabId)}
          >
            {subagents.surface}
          </ChildSplitPane>
        ) : activeTab?.id === "git" ? (
          <GitPanel />
        ) : (
          <div className="dock-empty">No side panel selected.</div>
        )}
      </div>
      <div
        className="review-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize dock"
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}

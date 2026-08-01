/**
 * Composes the panel-gating triple {activeTabId, panelMounted, overlayOpen}
 * (working-docs/panel-track/CUT.md §2.4/D7) into microtask-coalesced
 * `previewPanel.setState` invoke calls, and owns the rAF-coalesced
 * `previewPanel.setBounds` one-way send (D9). Pure factories
 * `createStateCoalescer`/`createBoundsCoalescer` are exported for the unit
 * gate; the module-singleton coalescers + overlay subscription +
 * `usePanelMountState` hook below are the untested wiring (D16) that closes
 * over them and the real `window.anycode.previewPanel` bridge.
 */
import { useEffect } from "react";
import type { PreviewPanelBounds, PreviewPanelStatePayload } from "../../../shared/preview-panel.js";
import { isOverlayOpen, subscribeOverlayOpen } from "./overlay-flag.js";

/**
 * Last-write-wins microtask coalescer (D7): any number of `push` calls before
 * `schedule`'s callback fires collapse into ONE `send` of the LAST payload.
 */
export function createStateCoalescer(
  schedule: (flush: () => void) => void,
  send: (payload: PreviewPanelStatePayload) => void,
): { push(payload: PreviewPanelStatePayload): void } {
  let pending: PreviewPanelStatePayload | null = null;
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    const payload = pending;
    pending = null;
    if (payload) {
      send(payload);
    }
  }

  return {
    push(payload: PreviewPanelStatePayload): void {
      pending = payload;
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
  };
}

function sameRect(a: PreviewPanelBounds, b: PreviewPanelBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * rAF-coalesced bounds coalescer (D9): any number of `report` calls before
 * `schedule`'s callback fires collapse into at most ONE `send` of the LAST
 * rect — zero sends if that rect is identical (by value) to the last one
 * actually sent.
 */
export function createBoundsCoalescer(
  schedule: (flush: () => void) => void,
  send: (bounds: PreviewPanelBounds) => void,
): { report(bounds: PreviewPanelBounds): void } {
  let latest: PreviewPanelBounds | null = null;
  let scheduled = false;
  let lastSent: PreviewPanelBounds | null = null;

  function flush(): void {
    scheduled = false;
    const rect = latest;
    latest = null;
    if (!rect) {
      return;
    }
    if (lastSent !== null && sameRect(lastSent, rect)) {
      return;
    }
    lastSent = rect;
    send(rect);
  }

  return {
    report(bounds: PreviewPanelBounds): void {
      latest = bounds;
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
  };
}

// ── real wiring (untested per D16) ──

let latestActiveTabId: string | null = null;
let latestPanelMounted = false;

const stateCoalescer = createStateCoalescer(
  (flush) => queueMicrotask(flush),
  (payload) => {
    window.anycode?.previewPanel
      ?.setState(payload)
      ?.catch((error: unknown) => {
        console.warn("[panel-bridge] setState failed", error);
      });
  },
);

const boundsCoalescer = createBoundsCoalescer(
  (flush) => requestAnimationFrame(flush),
  (bounds) => {
    window.anycode?.previewPanel?.setBounds(bounds);
  },
);

function publish(): void {
  stateCoalescer.push({
    activeTabId: latestActiveTabId,
    panelMounted: latestPanelMounted,
    overlayOpen: isOverlayOpen(),
  });
}

// Permanent, app-lifetime subscription — mirrors the module-singleton Set in
// overlay-flag.ts itself; there is nothing to unsubscribe from at this scope,
// and every overlay 0<->non-0 transition must re-publish the latest tuple.
subscribeOverlayOpen(publish);

/** Sets the {activeTabId, panelMounted} half of the triple and republishes immediately. */
export function setPanelMountState(activeTabId: string | null, panelMounted: boolean): void {
  latestActiveTabId = activeTabId;
  latestPanelMounted = panelMounted;
  publish();
}

/** Feeds one fresh measurement into the rAF bounds coalescer. */
export function reportPanelBounds(bounds: PreviewPanelBounds): void {
  boundsCoalescer.report(bounds);
}

/**
 * Mount/unmount + tabId wiring (CUT §3 96-P2 item 6): call unconditionally
 * from the ONE component that renders the panel region for the active tab
 * (ActiveTabBody) — its cleanup fires on unmount AND on every dependency
 * change, always leaving the module state truthful even mid-transition (the
 * brief null/false written by cleanup on a tabId/panelMounted change is
 * overwritten synchronously by the new effect body, before the microtask
 * coalescer ever gets a chance to flush the stale value).
 */
export function usePanelMountState(tabId: string | null, panelMounted: boolean): void {
  useEffect(() => {
    setPanelMountState(tabId, panelMounted);
    return () => setPanelMountState(null, false);
  }, [tabId, panelMounted]);
}

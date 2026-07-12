/**
 * Checkpoint timeline panel (slice P7.26/R2, design
 * slice-P7.26-R2-ratification.md + slice-P7.26-cut.md §4/§7). Mirrors
 * LspPanel/HooksPanel chrome exactly (`lsp-panel*` classes, right-drawer
 * placement, its own `session-header`-owned open flag). §7 is a hard
 * constraint: the UI model is the checkpoint LIST rendered as a TIMELINE,
 * newest first — `CheckpointMeta` carries no turn/message id, so there is no
 * per-message "rewind to here" affordance to build here, honest or otherwise.
 */
import { useContext, useEffect, useState } from "react";
import type { UiToHostMessage, WireCheckpointMeta } from "../../../shared/protocol.js";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { formatAge } from "./Sidebar.js";
import { History, X } from "./icons.js";

const REASON_LABELS: Record<WireCheckpointMeta["reason"], string> = {
  auto: "Auto",
  "pre-rewind": "Pre-rewind",
};

export function formatCheckpointReason(reason: WireCheckpointMeta["reason"]): string {
  return REASON_LABELS[reason];
}

/**
 * Newest-first timeline order (§7: a TIMELINE, not array/creation order —
 * `checkpoint_list`'s wire order is a store-read detail, not a UI contract).
 */
export function sortCheckpointsNewestFirst(checkpoints: readonly WireCheckpointMeta[]): WireCheckpointMeta[] {
  return [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The SOLE constructor of a `rewind_request` (mirror of git's
 * `buildConfirmedGitCommand` — one pure builder, exercised directly by the
 * unit gate, used by exactly one call site below). v1 scope is always
 * `"both"` (design §4: no files/conversation toggle yet).
 */
export function buildRewindRequest(checkpointId: string, requestId: string): Extract<UiToHostMessage, { type: "rewind_request" }> {
  return { type: "rewind_request", requestId, checkpointId, scope: "both" };
}

function CheckpointRow({
  checkpoint,
  pending,
  now,
  onSelect,
  onConfirm,
  onCancel,
}: {
  checkpoint: WireCheckpointMeta;
  pending: boolean;
  now: number;
  onSelect(): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div className="timeline-row" data-checkpoint-id={checkpoint.id}>
      <button type="button" className="timeline-row-main" onClick={onSelect} disabled={pending}>
        <span className="timeline-label" title={checkpoint.label}>
          {checkpoint.label}
        </span>
        <span className={`timeline-reason timeline-reason-${checkpoint.reason}`}>{formatCheckpointReason(checkpoint.reason)}</span>
        <span className="timeline-age">{formatAge(checkpoint.createdAt, now)}</span>
      </button>
      {pending && (
        <div className="timeline-confirm">
          <span>Rewind to this checkpoint? Files and conversation after it are discarded.</span>
          <div className="timeline-confirm-actions">
            <button type="button" className="timeline-confirm-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="timeline-confirm-confirm" onClick={onConfirm}>
              Rewind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TimelinePanel() {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("TimelinePanel must be used within a <TabContext.Provider>");
  }

  const { tabId } = ctx;
  const checkpoints = useTabStore((state) => state.checkpoints);
  const send = useTabSend();
  const open = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.timelinePanelOpen ?? false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      send({ type: "checkpoint_list_request" });
    } else {
      // Closing the panel discards any half-confirmed rewind — reopening
      // starts from a clean slate rather than resurrecting a stale prompt.
      setPendingId(null);
    }
  }, [open, send]);

  if (!open) {
    return null;
  }

  function refresh(): void {
    send({ type: "checkpoint_list_request" });
  }

  function close(): void {
    useTabsStore.getState().setTimelinePanelOpen(tabId, false);
  }

  function confirmRewind(checkpointId: string): void {
    send(buildRewindRequest(checkpointId, crypto.randomUUID()));
    setPendingId(null);
  }

  const ordered = sortCheckpointsNewestFirst(checkpoints);
  const now = Date.now();

  return (
    <aside className="timeline-panel lsp-panel" aria-label="Checkpoint timeline">
      <div className="timeline-panel-header lsp-panel-header">
        <History />
        <h2 className="lsp-panel-title">Timeline</h2>
        <button type="button" className="git-btn lsp-panel-refresh" onClick={refresh}>
          Refresh
        </button>
        <button type="button" className="lsp-panel-close" aria-label="Close checkpoint timeline" onClick={close}>
          <X />
        </button>
      </div>

      <div className="timeline-panel-body lsp-panel-body">
        {ordered.length === 0 ? (
          // Honest-empty (§2.1 of the ratification): an empty list means "no
          // checkpoints yet" OR "the checkpoint seam is disabled" — the wire
          // gives no way to tell those apart, so the copy doesn't claim either.
          <div className="lsp-empty">No checkpoints yet — one is captured automatically after each turn.</div>
        ) : (
          ordered.map((checkpoint) => (
            <CheckpointRow
              key={checkpoint.id}
              checkpoint={checkpoint}
              pending={pendingId === checkpoint.id}
              now={now}
              onSelect={() => setPendingId(checkpoint.id)}
              onConfirm={() => confirmRewind(checkpoint.id)}
              onCancel={() => setPendingId(null)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/**
 * Prompt queue (design slice-P7.14-cut.md §4): renders the FIFO of prompts
 * entered while a turn is running, plus the paused banner. Rendered as the
 * first child inside `.composer`, above EnvironmentMenu/pills. All wire
 * traffic (enqueue/edit/delete/resume/clear) is already handled by the store
 * actions (Wave 1) and the tab-registry drainer — this component only calls
 * into them.
 */
import type { KeyboardEvent } from "react";
import { useTabStore, useTabStoreApi, useTabSend } from "../tab-context.js";
import { canDismissRejectedDelivery, systemRetrySafe, type QueuedPrompt } from "../store.js";
import { X } from "./icons.js";

/** "N img" badge for a queued item's attachment count; null when there are none. */
export function queueImageBadge(count: number): string | null {
  return count === 0 ? null : `${count} img`;
}

/** The card renders once there is something to show (queued/pending-steer items) or hold (paused with an empty queue). */
export function shouldShowPromptQueue(
  queueLength: number,
  queuePaused: boolean,
  pendingSteerCount = 0,
): boolean {
  return queueLength > 0 || queuePaused || pendingSteerCount > 0;
}

/** Badge copy for a system report delivery: neutral while pending, the no-auto-resend warning only once delivery is in doubt or refused. */
export function systemReportBadge(status: string): string {
  return status === "unknown" || status === "rejected"
    ? "System report — check session history; it will not resend automatically."
    : status === "pending"
      ? "System report · delivered after this turn"
      : "System report";
}

/** Hover text for a delivery chip: the full message followed by every badge's full text. */
export function deliveryChipTitle(messageText: string, ...badges: Array<string | null>): string {
  return [messageText, ...badges].filter((part): part is string => part !== null && part !== "").join("\n");
}

export function PromptQueue({ onRestore }: { onRestore?: (item: QueuedPrompt, deliveryRequestId?: string) => boolean }) {
  const send = useTabSend();
  function remove(item: QueuedPrompt): void {
    if (item.runtimeRecoveryTurnId) send({type:"runtime_input_discard",turnId:item.runtimeRecoveryTurnId});
    tabStore.getState().deleteQueuedPrompt(item.id);
  }
  const promptQueue = useTabStore((state) => state.promptQueue);
  const deliveries = useTabStore((state) => state.orchestrationDeliveries);
  const activeDeliveryId = useTabStore((state) => state.restoredComposerDraft?.deliveryRequestId);
  const connection = useTabStore((state) => state.connection);
  const queuePaused = useTabStore((state) => state.queuePaused);
  // the banner must name the REAL reason the queue is held
  // ("turn limit" vs "cancelled/failed") — "Work" §2.
  const queuePauseReason = useTabStore((state) => state.queuePauseReason);
  // steers already on the wire to the host's steer queue, awaiting
  // their turn_started. Host-owned — no renderer edit/delete controls.
  const pendingSteers = useTabStore((state) => state.pendingSteers);
  const uiSteerPending = useTabStore((state) => state.uiSteerPending);
  const tabStore = useTabStoreApi();
  const editing = useTabStore((state) => state.queueEditDraft);

  const visibleDeliveries = (deliveries ?? []).filter(item => !item.dismissed && (item.status !== "started" || item.requestId === activeDeliveryId));
  if (!shouldShowPromptQueue(promptQueue.length, queuePaused, pendingSteers.length) && visibleDeliveries.length === 0) {
    return null;
  }

  function startEdit(item: QueuedPrompt): void {
    const current = tabStore.getState().queueEditDraft;
    if (current && current.id !== item.id) {
      tabStore.getState().setNotice({ kind: "slash_command_rejected", text: "Save or cancel the current queue edit first." });
      return;
    }
    tabStore.setState({queueEditDraft: { id: item.id, text: item.text }});
  }

  function cancelEdit(): void {
    tabStore.setState({queueEditDraft: null});
  }

  function saveEdit(id: string): void {
    const draft = tabStore.getState().queueEditDraft;
    if (draft?.id === id) tabStore.getState().editQueuedPrompt(id, draft.text);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, id: string): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveEdit(id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  return (
    <div className="prompt-queue">
      {visibleDeliveries.map((item) => {
        const messageText = item.payloadOmitted ? "Earlier completed message (payload released)" : item.text;
        const statusText = item.status === "pending" ? "Waiting for host response" : item.status === "unknown" ? "Delivery unknown — check history before retrying" : item.status === "rejected" ? "Host rejected this request" : item.status === "conflict" ? "Conflicting delivery reports — review before retrying" : item.status === "finished" ? `Turn ${item.terminalReason === "max_turns" ? "reached its turn limit" : item.terminalReason === "error" ? "failed" : item.terminalReason}; payload is retained until dismissed` : "Turn started; a restored copy remains in the composer";
        const systemText = item.origin === "system" ? systemReportBadge(item.status) : null;
        const chipTitle = deliveryChipTitle(messageText, statusText, systemText);
        return <div key={item.requestId} className={item.origin === "system" ? "prompt-queue-item prompt-queue-item-delivery prompt-queue-item-system" : "prompt-queue-item prompt-queue-item-delivery"} role="status" title={chipTitle}>
        <span className="prompt-queue-text">{messageText}</span>
        <span className="prompt-queue-badge">{statusText}</span>
        {item.images.length > 0 && <span className="prompt-queue-badge">{queueImageBadge(item.images.length)}</span>}
        {systemText !== null && <span className="prompt-queue-badge">{systemText}</span>}
        {item.origin === "system" && item.status === "rejected" && !item.retryQueued && <button type="button" className="system-delivery-retry" disabled={connection !== "ready" || !systemRetrySafe(deliveries,item.requestId)} onClick={() => tabStore.getState().retryRejectedSystemDelivery(item.requestId)}>Retry rejected report</button>}
        {item.origin === "system" && item.retryQueued && item.status === "rejected" && <span>Retry requested.</span>}
        {item.origin !== "system" && !item.payloadOmitted && item.requestId !== activeDeliveryId && (item.status === "unknown" || item.status === "rejected" || item.status === "conflict") && <button type="button" className="orchestration-delivery-restore" onClick={() => {
          const state = tabStore.getState();
          const current = state.orchestrationDeliveries.find(entry => entry.requestId === item.requestId);
          if (!current || state.restoredComposerDraft?.deliveryRequestId === current.requestId || (current.status !== "unknown" && current.status !== "rejected" && current.status !== "conflict")) return;
          if (onRestore?.({id:current.requestId,text:current.text,images:current.images,...(current.orchestrate ? {orchestrate:current.orchestrate} : {}),...(current.initialPicks ? {initialPicks:current.initialPicks} : {}),requiresRestore:true}, current.requestId) === true) {
            tabStore.setState((state) => ({orchestrationDeliveries:state.orchestrationDeliveries.map(entry => entry.requestId === current.requestId ? {...entry,restored:true} : entry)}));
          }
        }}>Restore for review</button>}
        {item.origin !== "system" && (item.status === "rejected" || item.status === "finished") && !item.payloadOmitted && <button type="button" className="orchestration-delivery-dismiss" onClick={() => {
          const state = tabStore.getState();
          if (!canDismissRejectedDelivery(state, item.requestId)) {
            state.setNotice({ kind: "slash_command_rejected", text: "Finish or discard the linked draft and dependent attempts before dismissing this message." });
            return;
          }
          state.dismissRejectedDelivery(item.requestId);
        }}>{item.status === "finished" ? "Dismiss finished message" : "Dismiss rejected message"}</button>}
        {!item.reviewed && (item.status === "unknown" || item.status === "conflict") && <button type="button" className="orchestration-delivery-reviewed" onClick={() => {
          tabStore.setState((state) => ({orchestrationDeliveries:state.orchestrationDeliveries.map(entry => entry.requestId === item.requestId && (entry.status === "unknown" || entry.status === "conflict") ? {...entry,reviewed:true} : entry)}));
        }}>Mark delivery reviewed</button>}
        {item.reviewed && (item.status === "unknown" || item.status === "conflict") && <span>Reviewed; delivery remains unconfirmed.</span>}
      </div>;
      })}
      {queuePaused && (
        <div className="prompt-queue-paused">
          <span className="prompt-queue-paused-text">
            {queuePauseReason === "max_turns"
              ? "Queue held — the turn hit the turn limit"
              : queuePauseReason === "rejected"
                ? "Queue held — message was rejected"
                : "Queue paused — turn was cancelled/failed"}
          </span>
          <div className="prompt-queue-paused-actions">
            <button
              type="button"
              className="prompt-queue-resume"
              onClick={() => tabStore.getState().resumeQueue()}
            >
              Resume
            </button>
            <button
              type="button"
              className="prompt-queue-clear"
              onClick={() => {
                for (const item of tabStore.getState().promptQueue) if (item.runtimeRecoveryTurnId) send({type:"runtime_input_discard",turnId:item.runtimeRecoveryTurnId});
                tabStore.getState().clearQueue();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {pendingSteers.length > 0 && (
        <ol className="steer-queue-list">
          {pendingSteers.map((entry) => (
            <li key={entry.requestId} className="steer-queue-item">
              <span className="steer-queue-text">{entry.text}</span>
              <span className="steer-queue-badge">{uiSteerPending.includes(entry.requestId) ? "Queued — next safe boundary" : "Queued — delivered after this turn"}</span>
            </li>
          ))}
        </ol>
      )}
      {promptQueue.length > 0 && (
        <ol className="prompt-queue-list">
          {promptQueue.map((item, index) => {
            const badge = queueImageBadge(item.images.length);
            const ordinal = index + 1;
            const queuedTitle = item.origin === "system" ? deliveryChipTitle(item.text, badge, systemReportBadge("pending")) : undefined;
            return (
              <li key={item.id} className="prompt-queue-item" title={queuedTitle}>
                {editing?.id === item.id ? (
                  <div className="prompt-queue-edit">
                    <textarea
                      className="prompt-queue-edit-textarea"
                      aria-label={`Edit queued message ${ordinal}`}
                      value={editing.text}
                      autoFocus
                      onChange={(event) => {
                        const text = event.target.value;
                        tabStore.setState((state) => state.queueEditDraft?.id === item.id ? { queueEditDraft: { id: item.id, text } } : {});
                      }}
                      onKeyDown={(event) => handleEditKeyDown(event, item.id)}
                    />
                    <div className="prompt-queue-edit-actions">
                      <button type="button" className="prompt-queue-save" onClick={() => saveEdit(item.id)}>
                        Save
                      </button>
                      <button type="button" className="prompt-queue-cancel" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="prompt-queue-ordinal">{ordinal}</span>
                    <span className="prompt-queue-text">{item.text}</span>
                    {badge !== null && <span className="prompt-queue-badge">{badge}</span>}
                    {(item.orchestrate === "enable" || item.requiresRestore === true) && (
                      <button type="button" className="prompt-queue-restore" onClick={() => {
                        if (onRestore?.(item,item.recoverySourceId) === true) remove(item);
                      }}>Restore draft</button>
                    )}
                    {!item.retryOf && <button
                      type="button"
                      className="prompt-queue-edit-button"
                      aria-label={`Edit queued message ${ordinal}`}
                      title="Edit"
                      onClick={() => startEdit(item)}
                    >
                      Edit
                    </button>}
                    <button
                      type="button"
                      className="prompt-queue-delete"
                      aria-label={`Delete queued message ${ordinal}`}
                      title="Delete"
                      onClick={() => remove(item)}
                    >
                      <X />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

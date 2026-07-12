/**
 * Prompt queue (design slice-P7.14-cut.md §4): renders the FIFO of prompts
 * entered while a turn is running, plus the paused banner. Rendered as the
 * first child inside `.composer`, above EnvironmentMenu/pills. All wire
 * traffic (enqueue/edit/delete/resume/clear) is already handled by the store
 * actions (Wave 1) and the tab-registry drainer — this component only calls
 * into them.
 */
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useTabStore, useTabStoreApi } from "../tab-context.js";
import type { QueuedPrompt } from "../store.js";
import { X } from "./icons.js";

/** "N img" badge for a queued item's attachment count; null when there are none. */
export function queueImageBadge(count: number): string | null {
  return count === 0 ? null : `${count} img`;
}

/** The card renders once there is something to show (queued items) or hold (paused with an empty queue). */
export function shouldShowPromptQueue(queueLength: number, queuePaused: boolean): boolean {
  return queueLength > 0 || queuePaused;
}

export function PromptQueue() {
  const promptQueue = useTabStore((state) => state.promptQueue);
  const queuePaused = useTabStore((state) => state.queuePaused);
  const tabStore = useTabStoreApi();
  // At most one item is ever mid-edit — a second Edit click on another row
  // simply reassigns this id, discarding the first row's uncommitted draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  if (!shouldShowPromptQueue(promptQueue.length, queuePaused)) {
    return null;
  }

  function startEdit(item: QueuedPrompt): void {
    setEditingId(item.id);
    setEditDraft(item.text);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft("");
  }

  function saveEdit(id: string): void {
    tabStore.getState().editQueuedPrompt(id, editDraft);
    setEditingId(null);
    setEditDraft("");
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
      {queuePaused && (
        <div className="prompt-queue-paused">
          <span className="prompt-queue-paused-text">Queue paused — turn was cancelled/failed</span>
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
              onClick={() => tabStore.getState().clearQueue()}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {promptQueue.length > 0 && (
        <ol className="prompt-queue-list">
          {promptQueue.map((item, index) => {
            const badge = queueImageBadge(item.images.length);
            const ordinal = index + 1;
            return (
              <li key={item.id} className="prompt-queue-item">
                {editingId === item.id ? (
                  <div className="prompt-queue-edit">
                    <textarea
                      className="prompt-queue-edit-textarea"
                      aria-label={`Edit queued message ${ordinal}`}
                      value={editDraft}
                      autoFocus
                      onChange={(event) => setEditDraft(event.target.value)}
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
                    <button
                      type="button"
                      className="prompt-queue-edit-button"
                      aria-label={`Edit queued message ${ordinal}`}
                      title="Edit"
                      onClick={() => startEdit(item)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="prompt-queue-delete"
                      aria-label={`Delete queued message ${ordinal}`}
                      title="Delete"
                      onClick={() => tabStore.getState().deleteQueuedPrompt(item.id)}
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

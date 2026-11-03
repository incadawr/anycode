/**
 * Background agents strip: the detached children of this session that are
 * still running (the host's `background_children` snapshot). A detached
 * dispatch ends the parent's turn at once, so without this strip the tab
 * looks finished while its agents work — the owner saw "nothing happens".
 * Rendered inside `.composer` next to the prompt queue; Open jumps to the
 * child's live pane (when this renderer knows its relation), Stop cancels it.
 */
import { useEffect, useState } from "react";
import type { WireBackgroundChild } from "../../../shared/protocol.js";
import { childLayoutStore } from "../child-layout.js";
import { childRelationStore, sameChildPredicate, spawnToolCallIdForChild } from "../child-sessions.js";
import { useTabContextTabId, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { formatElapsed } from "./WorkingRow.js";

/** "45s" / "5m 12s" / "1h 02m" — the same clock as the Working row; ticks every second. */
export function backgroundElapsed(startedAt: number, now: number): string {
  return formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1000)));
}

export function backgroundHeading(count: number): string {
  return count === 1 ? "1 background agent running" : `${count} background agents running`;
}

/**
 * GitHub #17 slice E: the optional progress line for one child.
 * Only facts the child actually reported appear — an engine that reports no
 * turns shows no turn count rather than a fictitious zero (Codex children).
 */
export function backgroundProgressText(
  child: Pick<WireBackgroundChild, "turns" | "toolCalls" | "lastTool">,
): string {
  const parts: string[] = [];
  if (child.turns !== undefined) parts.push(`turn ${child.turns}`);
  if (child.toolCalls !== undefined) parts.push(child.toolCalls === 1 ? "1 tool" : `${child.toolCalls} tools`);
  if (child.lastTool !== undefined) parts.push(child.lastTool);
  return parts.join(" · ");
}

/** "Waiting for permission" while the child is blocked on its own ask, else null. */
export function backgroundWaitingText(
  child: Pick<WireBackgroundChild, "waitingForApproval">,
): string | null {
  return child.waitingForApproval === true ? "Waiting for permission" : null;
}

export function BackgroundAgents() {
  const running = useTabStore((state) => state.backgroundChildren);
  const failed = useTabStore((state) => state.failedBackgroundChildren);
  const children = [...running, ...failed.filter((child) => !running.some((item) => item.childSessionId === child.childSessionId))];
  const tabId = useTabContextTabId();
  const send = useTabSend();
  const parentSessionId = useTabsStore((state) => state.tabs.find((tab) => tab.tabId === tabId)?.sessionId ?? null);
  const relations = childRelationStore((state) => state.relations);
  const [, setTick] = useState(0);
  const now = Date.now();

  useEffect(() => {
    if (children.length === 0) return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => clearInterval(timer);
  }, [children.length]);

  if (children.length === 0) {
    return null;
  }

  function stop(child: WireBackgroundChild): void {
    send({ type: "background_child_cancel_request", requestId: crypto.randomUUID(), childSessionId: child.childSessionId });
  }

  return (
    <div className="background-agents" role="status" aria-live="polite">
      <div className="background-agents-heading">{running.length > 0 ? backgroundHeading(running.length) : "Background agents"}</div>
      <ul className="background-agents-list">
        {children.map((child) => {
          const spawnToolCallId =
            parentSessionId === null ? undefined : spawnToolCallIdForChild(relations, parentSessionId, child.childSessionId);
          const progress = backgroundProgressText(child);
          const waiting = backgroundWaitingText(child);
          return (
            <li key={child.childSessionId} className="background-agents-item">
              <span className="background-agents-type">{child.agentType}</span>
              <span className="background-agents-description">{child.description}</span>
              <span className="background-agents-elapsed">{backgroundElapsed(child.startedAt, now)}</span>
              {child.failureReason && <span className="background-agents-waiting" title={child.failureReason}>Error: {child.failureReason}</span>}
              {!child.failureReason && progress !== "" && (
                <span className="background-agents-progress" title={progress}>{progress}</span>
              )}
              {waiting !== null && (
                <span className="background-agents-waiting" title={waiting}>{waiting}</span>
              )}
              {spawnToolCallId !== undefined && (
                <button
                  type="button"
                  className="background-agents-action"
                  onClick={() =>
                    childLayoutStore
                      .getState()
                      .open(
                        tabId,
                        spawnToolCallId,
                        parentSessionId === null
                          ? undefined
                          : sameChildPredicate(relations, parentSessionId, child.childSessionId),
                      )
                  }
                >
                  Open
                </button>
              )}
              {!child.failureReason && <button
                type="button"
                className="background-agents-action"
                aria-label={`Stop background agent ${child.description}`}
                onClick={() => stop(child)}
              >
                Stop
              </button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

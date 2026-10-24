/**
 * Background-tasks drawer (TASK.91 / Taskana 4097): the native engine's
 * `run_in_background` Bash tasks (InProcessTaskManager) as a per-tab right
 * drawer. The wire (`task_list`/`task_output`/`task_kill_result`), the host
 * pushes and the store slice all pre-exist; this panel is the missing reader
 * + sender. Mirrors TimelinePanel/HooksPanel chrome exactly (`lsp-panel*`
 * classes, right-drawer placement, its own `session-header`-owned open flag).
 *
 * Refresh cadence (v2, Taskana 4097 follow-up): on open
 * (`task_list_request` here), after every turn teardown, AND on the host's
 * idle task-settled push (a task that exits BETWEEN turns now updates its
 * row live — `session.ts`'s `onTaskSettled` subscription). While the drawer
 * is open, a row is selected AND that task is `running`, the Output view
 * live-tails it: `task_output_request` (the non-consuming peek, 799fd604)
 * every 1s. Output renders as an ACCORDION under its own row, not a single
 * pane under the whole list.
 *
 * NOTE: this is NOT BackgroundAgents.tsx — that strip renders detached
 * child sessions (TASK.145); this drawer renders core's Bash background
 * tasks. Different feature, different wire.
 */
import { useContext, useEffect, useRef, useState } from "react";
import type { UiToHostMessage } from "../../../shared/protocol.js";
import type { BackgroundTaskSnapshot, BackgroundTaskStatus } from "@anycode/core";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { backgroundElapsed } from "./BackgroundAgents.js";
import { formatElapsed } from "./WorkingRow.js";
import { Terminal, X } from "./icons.js";

export const TASK_STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  killed: "Killed",
  spawn_error: "Spawn error",
};

/** Table lookup (a missing key would be a wire-contract break — pin it with the lookup). */
export function formatTaskStatus(status: BackgroundTaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

/** Only a `running` task can still be killed; every terminal status cannot. */
export function isTaskStoppable(task: BackgroundTaskSnapshot): boolean {
  return task.status === "running";
}

/** Newest-first order — the wire's array order is a registry-read detail, not a UI contract. */
export function sortTasksNewestFirst(tasks: readonly BackgroundTaskSnapshot[]): BackgroundTaskSnapshot[] {
  return [...tasks].sort((a, b) => b.startedAt - a.startedAt);
}

/** Live-tail poll cadence (Taskana 4097): 1s, only while open ∧ selected ∧ running. */
export const TASK_OUTPUT_POLL_MS = 1_000;

/**
 * The live-tail predicate, pure: the Output view polls `task_output_request`
 * only while ALL THREE hold — the drawer is open, the row is selected, and
 * the task is still `running`. Any other combination (closed drawer, another
 * row selected, a finished task) must not poll: the peek is cheap, but a
 * finished task's output is already complete in the store.
 */
export function shouldLiveTailOutput(open: boolean, selectedTask: BackgroundTaskSnapshot | undefined): boolean {
  return open && selectedTask !== undefined && selectedTask.status === "running";
}

/**
 * The SOLE constructor of a `task_kill_request` (mirror of TimelinePanel's
 * `buildRewindRequest` — one pure builder, exercised directly by the unit
 * gate, used by exactly one call site below). `confirmed: true` is the only
 * wire-legal value; "Stop" is a plain user action through the existing kill
 * path (no new agent-initiated kill, no dialog — the host kill is immediate
 * and tasks are ephemeral, unlike rewind which destroys durable state).
 */
export function buildTaskKillRequest(taskId: string, requestId: string): Extract<UiToHostMessage, { type: "task_kill_request" }> {
  return { type: "task_kill_request", requestId, taskId, confirmed: true };
}

export function buildTaskOutputRequest(taskId: string): Extract<UiToHostMessage, { type: "task_output_request" }> {
  return { type: "task_output_request", taskId };
}

function TaskRow({
  task,
  now,
  selected,
  onToggleOutput,
  onStop,
}: {
  task: BackgroundTaskSnapshot;
  now: number;
  selected: boolean;
  onToggleOutput(): void;
  onStop(): void;
}) {
  const terminal = task.status !== "running";
  return (
    <div className="background-tasks-row" data-task-id={task.taskId} data-status={task.status}>
      <span className="background-tasks-command" title={task.command}>
        {task.command}
      </span>
      <span className={`background-tasks-status background-tasks-status-${task.status}`}>{formatTaskStatus(task.status)}</span>
      <span className="background-tasks-elapsed">
        {terminal
          ? `${formatElapsed(Math.floor(((task.endedAt ?? task.startedAt) - task.startedAt) / 1000))}${
              task.exitCode !== null ? ` · exit ${task.exitCode}` : ""
            }`
          : backgroundElapsed(task.startedAt, now)}
      </span>
      <div className="background-tasks-actions">
        <button type="button" className="background-tasks-action" aria-pressed={selected} onClick={onToggleOutput}>
          Output
        </button>
        {isTaskStoppable(task) && (
          <button type="button" className="background-tasks-action background-tasks-stop" aria-label={`Stop background task ${task.command}`} onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

export function BackgroundTasksPanel() {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("BackgroundTasksPanel must be used within a <TabContext.Provider>");
  }

  const { tabId } = ctx;
  const tasks = useTabStore((state) => state.backgroundTasks);
  const output = useTabStore((state) => state.backgroundTaskOutput);
  const send = useTabSend();
  const open = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.tasksPanelOpen ?? false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // right-side drawer is up.
  useOverlayFlag(open);

  useEffect(() => {
    if (open) {
      // Refresh-on-open parity with TimelinePanel: the drawer never mounts
      // stale — the host re-serves the manager snapshot on demand.
      send({ type: "task_list_request" });
    } else {
      // Closing discards the selected output row; reopening starts clean.
      setSelectedTaskId(null);
    }
  }, [open, send]);

  // 1s tick while anything is running (BackgroundAgents.tsx pattern verbatim).
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = tasks.some(isTaskStoppable);
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // Live-tail (Taskana 4097): poll `task_output_request` (the non-consuming
  // peek, 799fd604) every second ONLY while the drawer is open, the row is
  // selected and the task is running. Stops on close, on selecting another
  // row, and — through `selectedTask.status` — the moment the task ends (the
  // host's idle settled push or a turn teardown refreshes the row).
  const selectedTask = selectedTaskId === null ? undefined : tasks.find((task) => task.taskId === selectedTaskId);
  const liveTail = shouldLiveTailOutput(open, selectedTask);
  useEffect(() => {
    if (!liveTail || selectedTaskId === null) return undefined;
    const timer = setInterval(() => send(buildTaskOutputRequest(selectedTaskId)), TASK_OUTPUT_POLL_MS);
    return () => clearInterval(timer);
    // `send` is stable per tab (useCallback over tabId); `selectedTaskId`
    // re-arms the interval on a row switch; `liveTail` re-evaluates every
    // store-driven render, ending the poll the moment the task settles.
  }, [liveTail, selectedTaskId, send]);

  // Final fetch: the poll above stops the moment the selected task settles,
  // so whatever it printed in its last <1s would stay unseen until the row is
  // reopened. One last peek on the running -> terminal edge of the SAME
  // selected row closes that gap (a row switch or a close is not that edge).
  const settleEdgeRef = useRef<{ taskId: string | null; status: BackgroundTaskStatus | undefined }>({
    taskId: null,
    status: undefined,
  });
  const selectedStatus = selectedTask?.status;
  useEffect(() => {
    const prev = settleEdgeRef.current;
    settleEdgeRef.current = { taskId: selectedTaskId, status: selectedStatus };
    if (
      open &&
      selectedTaskId !== null &&
      prev.taskId === selectedTaskId &&
      prev.status === "running" &&
      selectedStatus !== undefined &&
      selectedStatus !== "running"
    ) {
      send(buildTaskOutputRequest(selectedTaskId));
    }
  }, [open, selectedTaskId, selectedStatus, send]);

  if (!open) {
    return null;
  }

  function close(): void {
    useTabsStore.getState().setTasksPanelOpen(tabId, false);
  }

  function toggleOutput(taskId: string): void {
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null);
      return;
    }
    setSelectedTaskId(taskId);
    send(buildTaskOutputRequest(taskId));
  }

  function stop(task: BackgroundTaskSnapshot): void {
    send(buildTaskKillRequest(task.taskId, crypto.randomUUID()));
  }

  const ordered = sortTasksNewestFirst(tasks);

  return (
    <aside className="background-tasks-panel lsp-panel" aria-label="Background tasks">
      <div className="background-tasks-panel-header lsp-panel-header">
        <Terminal />
        <h2 className="lsp-panel-title">Background tasks</h2>
        <button type="button" className="lsp-panel-close" aria-label="Close background tasks" onClick={close}>
          <X />
        </button>
      </div>

      <div className="background-tasks-panel-body lsp-panel-body">
        {ordered.length === 0 ? (
          // Honest-empty (HooksPanel copy discipline): an empty list means
          // "no tasks yet" — the wire gives no way to distinguish a taskless
          // session from anything else, so the copy claims nothing further.
          <div className="lsp-empty">No background tasks yet.</div>
        ) : (
          ordered.map((task) => (
            // Accordion item: the row plus ITS OWN output, directly under it.
            <div className="background-tasks-item" key={task.taskId} data-task-id={task.taskId}>
              <TaskRow
                task={task}
                now={now}
                selected={selectedTaskId === task.taskId}
                onToggleOutput={() => toggleOutput(task.taskId)}
                onStop={() => stop(task)}
              />
              {selectedTaskId === task.taskId && (
                <pre className="background-tasks-output">{output[task.taskId] ?? ""}</pre>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

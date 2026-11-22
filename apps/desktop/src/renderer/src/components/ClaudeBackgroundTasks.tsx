import { useCallback, useEffect, useRef, useState } from "react";
import { useTabSend, useTabStore } from "../tab-context.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Button, IconButton, IconDanger, IconInfo, IconSpinner, IconSuccess } from "../ui/index.js";
import type { TranscriptBlock } from "../store.js";
import { backgroundCardStatus, backgroundTaskKindLabel, formatTaskElapsed, outputFileFromResult, visibleBackgroundTasks, type ClaudeBackgroundTask } from "../claude-background-tasks.js";

type Task = ClaudeBackgroundTask;
const POLL_MS = 2000;
const TAIL_LINES = 200;

export function taskDescription(task: Task, transcript: readonly TranscriptBlock[]): string {
  if (task.description.trim()) return task.description;
  const call = transcript.find(block => block.kind === "tool_call" && block.toolCallId === task.toolCallId);
  if (!call || call.kind !== "tool_call" || !call.input || typeof call.input !== "object") return "Background task";
  const input = call.input as Record<string, unknown>;
  const value = task.kind === "bash" ? input.command : input.description ?? input.command;
  return typeof value === "string" && value.trim() ? value.slice(0, 500) : "Background task";
}

/** The path the launch result named, else the notification's own `output_file`. Main re-validates either. */
export function taskOutputHint(task: Task, transcript: readonly TranscriptBlock[]): string | undefined {
  if (task.outputFile) return task.outputFile;
  const call = transcript.find(block => block.kind === "tool_call" && block.toolCallId === task.toolCallId);
  return call?.kind === "tool_call" ? outputFileFromResult(call.modelText) : undefined;
}

function tail(content: string): string {
  const lines = content.split("\n");
  return lines.length > TAIL_LINES ? lines.slice(-TAIL_LINES).join("\n") : content;
}

function StatusIcon({ status }: { status: Task["status"] }) {
  if (status === "running") return <IconSpinner size={12} className="icon-spin" />;
  if (status === "completed") return <IconSuccess size={12} />;
  return status === "failed" ? <IconDanger size={12} /> : <IconInfo size={12} />;
}

type Output = { taskId: string; content: string; truncated: boolean } | { taskId: string; content: null };

export function ClaudeBackgroundTasks() {
  const tasks = useTabStore(state => state.claudeBackgroundTasks);
  const [now, setNow] = useState(Date.now);
  const anyRunning = tasks.some(item => item.status === "running" && item.foreground !== true);
  useEffect(() => {
    if (!anyRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);
  const transcript = useTabStore(state => state.transcript);
  const response = useTabStore(state => state.claudeTaskOutput);
  const send = useTabSend();
  const visible = visibleBackgroundTasks(tasks);
  const running = visible.filter(task => task.status === "running").length;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessionRef, setSessionRef] = useState<{ taskId: string; ref: string | null } | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const requestId = useRef<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOverlayFlag(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); triggerRef.current?.focus(); } };
    const onPointer = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!panel.current?.contains(node) && !triggerRef.current?.contains(node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onPointer); };
  }, [open, close]);

  // Until one is picked, show the first running task (else the latest one), so the output is visible on open.
  const task = visible.find(item => item.taskId === selected) ?? visible.find(item => item.status === "running") ?? visible[visible.length - 1];
  const taskId = task?.taskId;
  const status = task?.status;
  const hint = task ? taskOutputHint(task, transcript) : undefined;

  // Ask the host for the session reference once per selection; the path itself is resolved and validated in main.
  useEffect(() => {
    if (!open || !taskId) return;
    const id = crypto.randomUUID();
    requestId.current = id;
    setSessionRef(null);
    setOutput(null);
    send({ type: "claude_task_output_request", taskId, requestId: id });
  }, [open, taskId, send]);
  useEffect(() => {
    if (response && taskId && response.requestId === requestId.current && response.taskId === taskId) setSessionRef({ taskId, ref: response.sessionRef ?? null });
  }, [response, taskId]);

  const ref = sessionRef && sessionRef.taskId === taskId ? sessionRef.ref : undefined;
  useEffect(() => {
    if (!open || !taskId) return;
    if (ref === null) { setOutput({ taskId, content: null }); return; }
    if (ref === undefined) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Chained, not an interval: a slow read never overlaps the next one.
    const tick = async () => {
      try {
        const result = await window.anycode.claudeTaskOutput.read({ taskId, sessionRef: ref, ...(hint ? { outputFile: hint } : {}) });
        if (!stale) setOutput(result.ok ? { taskId, content: result.content, truncated: result.truncated } : { taskId, content: null });
      } catch { if (!stale) setOutput({ taskId, content: null }); }
      if (!stale && status === "running") timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => { stale = true; if (timer) clearTimeout(timer); };
  }, [open, taskId, ref, status, hint]);

  if (visible.length === 0) return null;
  const label = running > 0 ? `Background tasks: ${running} running` : `Background tasks: ${visible.length}`;
  const shown = output?.taskId === taskId ? output : null;
  return <span className="claude-bg-tasks" ref={node => { triggerRef.current = node?.querySelector("button") ?? null; }}>
    <IconButton label={label} pressed={open} className={`claude-bg-trigger${running > 0 ? " claude-bg-trigger-running" : ""}`}
      aria-expanded={open} aria-haspopup="dialog" onClick={() => { if (!open) setSelected(task?.taskId ?? null); setOpen(value => !value); setOpenFailed(false); }}
      icon={<>{running > 0 ? <IconSpinner size={14} className="icon-spin" /> : <IconSuccess size={14} />}<span className="claude-bg-count">{running > 0 ? running : visible.length}</span></>} />
    {open && <div ref={panel} className="claude-bg-popover" role="dialog" aria-label="Background tasks">
      <div className="claude-bg-head"><span>Background tasks</span><span>{running > 0 ? `${running} running` : "all finished"}</span></div>
      <div className="claude-bg-body">
        <ul className="claude-bg-list">
          {visible.map(item => {
            const state = backgroundCardStatus(item);
            return <li key={item.taskId}>
              <Button variant="ghost" size="sm" className={`claude-bg-row claude-bg-row-${item.status}`} aria-pressed={item.taskId === taskId} onClick={() => setSelected(item.taskId)}>
                <span className="claude-bg-row-icon"><StatusIcon status={item.status} /></span>
                <span className="claude-bg-row-main">
                  <span className="claude-bg-row-title">{backgroundTaskKindLabel(item)}: {taskDescription(item, transcript)}</span>
                  <span className="claude-bg-row-meta">{state.label}{item.status === "running" ? ` · ${formatTaskElapsed(item.startedAt, now)}` : ""}</span>
                </span>
              </Button>
            </li>;
          })}
        </ul>
        {task?.summary && <div className="claude-bg-summary">{task.summary.length > 500 ? `${task.summary.slice(0, 500)}…` : task.summary}</div>}
        {task && (shown === null
          ? <div className="claude-bg-note" role="status">Loading output…</div>
          : shown.content === null
            ? <div className="claude-bg-note" role="status">Output is not available yet.</div>
            : shown.content === ""
              ? <div className="claude-bg-note" role="status">No output yet.</div>
              : <pre className="claude-bg-output" tabIndex={0} aria-label="Task output">{`${shown.truncated ? "[earlier output omitted]\n" : ""}${tail(shown.content)}`}</pre>)}
      </div>
      {task && ref && <div className="claude-bg-foot"><Button size="sm" variant="secondary" onClick={() => void window.anycode.claudeTaskOutput.open({ taskId: task.taskId, sessionRef: ref, ...(hint ? { outputFile: hint } : {}) }).then(result => setOpenFailed(!result.ok), () => setOpenFailed(true))}>Open output file</Button>{openFailed && <span className="claude-bg-note" role="alert">Could not open the file.</span>}</div>}
    </div>}
  </span>;
}

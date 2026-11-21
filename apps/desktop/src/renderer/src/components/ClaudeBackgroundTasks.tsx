import { useEffect, useRef, useState } from "react";
import type { WireAgentEvent } from "../../../shared/protocol.js";
import { useTabSend, useTabStore } from "../tab-context.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Button } from "../ui/index.js";
import type { TranscriptBlock } from "../store.js";

type Task = Extract<WireAgentEvent, { type: "claude_background_task" }>;

export function taskDescription(task: Task, transcript: readonly TranscriptBlock[]): string {
  if (task.description.trim()) return task.description;
  const call = transcript.find(block => block.kind === "tool_call" && block.toolCallId === task.toolCallId);
  if (!call || call.kind !== "tool_call" || !call.input || typeof call.input !== "object") return "Background task";
  const input = call.input as Record<string, unknown>;
  const value = task.kind === "bash" ? input.command : input.description ?? input.command;
  return typeof value === "string" && value.trim() ? value.slice(0, 500) : "Background task";
}

export function claudeTaskTitle(task: Task, now: number): string {
  const kind = task.kind === "bash" ? "Background Bash" : "Monitor";
  const elapsed = Math.max(0, Math.floor((now - task.startedAt) / 1000));
  return `${kind}: ${task.description || "Background task"}\nStarted ${new Date(task.startedAt).toLocaleTimeString()} · ${task.status}${task.status === "running" ? ` · ${elapsed}s` : ""}${task.summary ? ` — ${task.summary.slice(0, 500)}` : ""}`;
}

export function ClaudeBackgroundTasks({ tasks, now }: { tasks: Task[]; now: number }) {
  const transcript = useTabStore(state => state.transcript);
  const [selected, setSelected] = useState<string | null>(null);
  const response = useTabStore(state => state.claudeTaskOutput);
  const [output, setOutput] = useState<{ taskId: string; content: string | null; cancelled?: boolean } | null>(null);
  const [pending, setPending] = useState<{ taskId: string; requestId: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || !response || response.requestId !== pending.requestId || response.taskId !== pending.taskId || opened.current === pending.requestId) return;
    opened.current = pending.requestId;
    setPending(null);
    if (!response.sessionRef) { setOutput({ taskId: pending.taskId, content: null }); return; }
    setPicking(true);
    void window.anycode.claudeTaskOutput.pick(pending.taskId, response.sessionRef).then(result => {
      if (result.ok) setOutput({ taskId: pending.taskId, content: result.content });
      else setOutput({ taskId: pending.taskId, content: null, cancelled: result.reason === "cancelled" });
    }).catch(() => setOutput({ taskId: pending.taskId, content: null })).finally(() => setPicking(false));
  }, [pending, response]);
  const send = useTabSend();
  const displayTasks = tasks.map(item => ({ ...item, description: taskDescription(item, transcript) }));
  const task = displayTasks.find(item => item.taskId === selected);
  useEffect(() => {
    if (!task) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setSelected(null); setPending(null); setOutput(null); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [task?.taskId]);
  useOverlayFlag(!!task);
  return <div className="claude-tasks">
    {displayTasks.map(item => <Button key={item.taskId} variant="ghost" size="sm" className={`claude-native-task claude-native-task-${item.status}`} title={claudeTaskTitle(item, now)} aria-label={claudeTaskTitle(item, now)} aria-expanded={selected === item.taskId} onClick={() => { setPending(null); setOutput(null); setSelected(selected === item.taskId ? null : item.taskId); }}>
      <span aria-hidden="true" className={item.status === "running" ? "claude-native-task-spinner icon-spin" : ""}>{item.status === "running" ? "" : item.status === "completed" ? "✓" : "!"}</span>
    </Button>)}
    {task && <div className="claude-task-details" role="region" aria-label="Claude background task">
      <Button variant="ghost" size="sm" aria-label="Close background task details" onClick={() => { setSelected(null); setPending(null); setOutput(null); }}>×</Button>
      <strong>{task.kind === "bash" ? "Background Bash" : "Monitor"}</strong>
      <div className="claude-task-description">{task.description || "Background task"}</div>
      <div>{task.status} · started {new Date(task.startedAt).toLocaleTimeString()}{task.status === "running" ? ` · ${Math.max(0, Math.floor((now - task.startedAt) / 1000))}s` : ""}</div>
      {task.summary && <div className="claude-task-summary">{task.summary.length > 500 ? `${task.summary.slice(0, 500)}…` : task.summary}</div>}
      {task.status !== "running" && <><p>Choose {task.taskId}.output in the session’s tasks folder. On macOS and Linux, the picker opens there when found in Claude’s usual location: /tmp/claude-&lt;user id&gt;/&lt;project&gt;/&lt;session&gt;/tasks.</p><Button size="sm" disabled={!!pending || picking} onClick={() => { const requestId = crypto.randomUUID(); setOutput(null); setPending({ taskId: task.taskId, requestId }); send({ type: "claude_task_output_request", taskId: task.taskId, requestId }); }}>Choose output file…</Button></>}
      {output?.taskId === task.taskId && (output.content === null ? <p role="status">{output.cancelled ? "File selection cancelled." : "Output unavailable: choose this task’s file from its session, and check that it is accessible."}</p> : output.content === "" ? <p role="status">The output file is empty.</p> : <pre className="claude-task-output">{output.content}</pre>)}
    </div>}
  </div>;
}

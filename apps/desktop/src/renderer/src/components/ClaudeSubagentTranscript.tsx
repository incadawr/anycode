/**
 * Read-only full run of a Claude CLI subagent, opened from the Agent card's
 * "Open" button. The renderer sends only the tool call id; the host resolves
 * and reads the CLI's own transcript file (host/engines/claude/subagent-transcript.ts).
 */
import { useEffect, useRef, useState } from "react";
import type { ClaudeSubagentEntry, ClaudeSubagentTranscriptResult } from "../../../shared/claude-subagent-transcript.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { useTabSend, useTabStore } from "../tab-context.js";
import { Button, Modal } from "../ui/index.js";
import { Markdown } from "./Markdown.js";

export type SubagentTranscriptState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; entries: ClaudeSubagentEntry[]; droppedEntries: number; truncatedHead: boolean };

/** User-facing line for a failed open; pure so the wording is testable. */
export function transcriptErrorMessage(reason: "unavailable" | "not_found" | "timeout"): string {
  if (reason === "not_found") {
    return "The Claude CLI has not written a transcript for this agent yet, or it was removed.";
  }
  if (reason === "timeout") {
    return "No answer from the session. Try again.";
  }
  return "The transcript could not be read.";
}

/** Label for one entry's header line. */
export function transcriptEntryLabel(entry: ClaudeSubagentEntry): string {
  switch (entry.kind) {
    case "prompt":
      return "Prompt";
    case "message":
      return "User";
    case "note":
      return "Note";
    case "thinking":
      return "Thinking";
    case "tool_use":
      return entry.title.length > 0 ? entry.title : "Tool";
    case "tool_result":
      return entry.isError === true ? "Result (error)" : "Result";
    default:
      return "Agent";
  }
}

export function SubagentTranscriptFeed({ state }: { state: SubagentTranscriptState }) {
  if (state.phase === "loading" || state.phase === "idle") {
    return <p role="status" className="subagent-transcript-status">Loading transcript…</p>;
  }
  if (state.phase === "error") {
    return <p role="alert" className="subagent-transcript-status">{state.message}</p>;
  }
  if (state.entries.length === 0) {
    return <p role="status" className="subagent-transcript-status">The transcript is empty so far.</p>;
  }
  return (
    <ol className="subagent-transcript-feed">
      {(state.droppedEntries > 0 || state.truncatedHead) && (
        <li className="subagent-transcript-status">Earlier part of the run is not shown (file is large).</li>
      )}
      {state.entries.map((entry, index) => (
        <li key={index} className={`subagent-transcript-entry subagent-transcript-${entry.kind}${entry.isError === true ? " subagent-transcript-error" : ""}`}>
          <div className="subagent-transcript-label">{transcriptEntryLabel(entry)}</div>
          {entry.kind === "text" || entry.kind === "prompt" || entry.kind === "message" ? (
            <div className="subagent-transcript-body message-markdown"><Markdown text={entry.text} /></div>
          ) : (
            <pre className="subagent-transcript-body subagent-transcript-pre">{entry.text}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}

/** How long the button waits for the host before giving up. */
export const TRANSCRIPT_RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Maps a host response onto view state, or null when it is not the answer to
 * the request in flight (a stale or foreign response must change nothing).
 */
export function applyTranscriptResponse(
  pendingRequestId: string | null,
  toolCallId: string,
  response: { requestId: string; toolCallId: string; result: ClaudeSubagentTranscriptResult } | null,
): SubagentTranscriptState | null {
  if (pendingRequestId === null || response === null) return null;
  if (response.requestId !== pendingRequestId || response.toolCallId !== toolCallId) return null;
  const { result } = response;
  return result.ok
    ? { phase: "ready", entries: result.entries, droppedEntries: result.droppedEntries, truncatedHead: result.truncatedHead }
    : { phase: "error", message: transcriptErrorMessage(result.reason) };
}

export function ClaudeSubagentTranscriptButton({ toolCallId, title, subtitle }: { toolCallId: string; title: string; subtitle?: string }) {
  const send = useTabSend();
  const response = useTabStore((state) => state.claudeSubagentTranscript);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<SubagentTranscriptState>({ phase: "idle" });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pendingRequest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOverlayFlag(open);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  // Each call mints a new request id; only the latest id is ever applied, so a
  // slow earlier answer cannot overwrite a newer one.
  const request = (keepContent: boolean) => {
    clearTimer();
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    setRefreshFailed(false);
    if (keepContent) setRefreshing(true);
    else setState({ phase: "loading" });
    timer.current = setTimeout(() => {
      if (pendingRequest.current !== requestId) return;
      pendingRequest.current = null;
      setRefreshing(false);
      if (stateRef.current.phase === "ready") setRefreshFailed(true);
      else setState({ phase: "error", message: transcriptErrorMessage("timeout") });
    }, TRANSCRIPT_RESPONSE_TIMEOUT_MS);
    send({ type: "claude_subagent_transcript_request", requestId, toolCallId });
  };

  useEffect(() => {
    const next = applyTranscriptResponse(pendingRequest.current, toolCallId, response);
    if (next === null) return;
    pendingRequest.current = null;
    clearTimer();
    setRefreshing(false);
    // A failed refresh keeps the content already on screen and says so inline.
    if (stateRef.current.phase === "ready" && next.phase === "error") setRefreshFailed(true);
    else setState(next);
  }, [response, toolCallId]);

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="tool-call-open"
        title="Open the full agent transcript"
        onClick={() => {
          setOpen(true);
          request(false);
        }}
      >
        Open
      </Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          pendingRequest.current = null;
          clearTimer();
          setRefreshing(false);
        }}
        title={title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        size="lg"
        footer={
          <Button size="sm" variant="ghost" loading={refreshing} disabled={refreshing || state.phase === "loading"} onClick={() => request(state.phase === "ready")}>
            Refresh
          </Button>
        }
      >
        {refreshFailed && <p role="alert" className="subagent-transcript-hint">Refresh failed. Showing the last loaded transcript.</p>}
        <SubagentTranscriptFeed state={state} />
      </Modal>
    </>
  );
}

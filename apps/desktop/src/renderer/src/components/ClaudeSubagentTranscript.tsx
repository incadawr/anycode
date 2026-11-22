/**
 * Read-only full run of a Claude CLI subagent, opened from the Agent card's
 * "Open" button. The CLI keeps each subagent's transcript in its own session
 * folder; the host supplies the session id, main resolves and reads the file
 * (bounded, containment-checked — main/claude-subagent-transcript-ipc.ts).
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
export function transcriptErrorMessage(reason: "unavailable" | "not_found" | "no_session"): string {
  if (reason === "not_found") {
    return "The Claude CLI has not written a transcript for this agent yet, or it was removed.";
  }
  if (reason === "no_session") {
    return "This tab has no Claude session to read the transcript from.";
  }
  return "The transcript could not be read.";
}

/** Label for one entry's header line. */
export function transcriptEntryLabel(entry: ClaudeSubagentEntry): string {
  switch (entry.kind) {
    case "prompt":
      return "Prompt";
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
    return <p role="status" className="subagent-transcript-note">Loading transcript…</p>;
  }
  if (state.phase === "error") {
    return <p role="alert" className="subagent-transcript-note">{state.message}</p>;
  }
  if (state.entries.length === 0) {
    return <p role="status" className="subagent-transcript-note">The transcript is empty so far.</p>;
  }
  return (
    <ol className="subagent-transcript-feed">
      {(state.droppedEntries > 0 || state.truncatedHead) && (
        <li className="subagent-transcript-note">Earlier part of the run is not shown (file is large).</li>
      )}
      {state.entries.map((entry, index) => (
        <li key={index} className={`subagent-transcript-entry subagent-transcript-${entry.kind}${entry.isError === true ? " subagent-transcript-error" : ""}`}>
          <div className="subagent-transcript-label">{transcriptEntryLabel(entry)}</div>
          {entry.kind === "text" || entry.kind === "prompt" ? (
            <div className="subagent-transcript-body message-markdown"><Markdown text={entry.text} /></div>
          ) : (
            <pre className="subagent-transcript-body subagent-transcript-pre">{entry.text}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ClaudeSubagentTranscriptButton({ toolCallId, title, subtitle }: { toolCallId: string; title: string; subtitle?: string }) {
  const send = useTabSend();
  const response = useTabStore((state) => state.claudeSessionRef);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SubagentTranscriptState>({ phase: "idle" });
  const pendingRequest = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  useOverlayFlag(open);

  const read = (ref: string) => {
    setState((current) => (current.phase === "ready" ? current : { phase: "loading" }));
    void window.anycode.claudeSubagentTranscript
      .read(ref, toolCallId)
      .then((result: ClaudeSubagentTranscriptResult) =>
        setState(
          result.ok
            ? { phase: "ready", entries: result.entries, droppedEntries: result.droppedEntries, truncatedHead: result.truncatedHead }
            : { phase: "error", message: transcriptErrorMessage(result.reason) },
        ),
      )
      .catch(() => setState({ phase: "error", message: transcriptErrorMessage("unavailable") }));
  };

  useEffect(() => {
    if (pendingRequest.current === null || response === null || response.requestId !== pendingRequest.current) return;
    pendingRequest.current = null;
    if (response.sessionRef === undefined) {
      setState({ phase: "error", message: transcriptErrorMessage("no_session") });
      return;
    }
    sessionRef.current = response.sessionRef;
    read(response.sessionRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const openTranscript = () => {
    setOpen(true);
    setState({ phase: "loading" });
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    send({ type: "claude_session_ref_request", requestId });
  };

  return (
    <>
      <Button size="sm" variant="ghost" className="tool-call-open" title="Open the full agent transcript" onClick={openTranscript}>
        Open
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        size="lg"
        footer={
          <Button size="sm" variant="ghost" onClick={() => { if (sessionRef.current !== null) read(sessionRef.current); }}>
            Refresh
          </Button>
        }
      >
        <SubagentTranscriptFeed state={state} />
      </Modal>
    </>
  );
}

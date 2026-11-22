import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDesktopStore } from "../store.js";
import { applyTranscriptResponse, SubagentTranscriptFeed, transcriptEntryLabel, transcriptErrorMessage } from "./ClaudeSubagentTranscript.js";

describe("Claude subagent transcript view", () => {
  it("renders every entry kind read-only, with labels", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentTranscriptFeed, {
        state: {
          phase: "ready",
          droppedEntries: 0,
          truncatedHead: false,
          entries: [
            { kind: "prompt", title: "", text: "Map the repo" },
            { kind: "tool_use", title: "Bash", text: "ls -la" },
            { kind: "tool_result", title: "", text: "boom", isError: true },
            { kind: "text", title: "", text: "All done" },
          ],
        },
      }),
    );
    expect(html).toContain("Prompt");
    expect(html).toContain(">Bash<");
    expect(html).toContain("ls -la");
    expect(html).toContain("Result (error)");
    expect(html).toContain("subagent-transcript-error");
    expect(html).toContain("All done");
    expect(html).not.toContain("<button");
    // status lines and the note entry kind use different classes
    expect(html).not.toContain("subagent-transcript-status");
  });

  it("shows an honest note when the head is not shown, and loading/error/empty states", () => {
    const ready = { phase: "ready" as const, entries: [{ kind: "text" as const, title: "", text: "x" }], droppedEntries: 0, truncatedHead: true };
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: ready }))).toContain("Earlier part of the run is not shown");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "loading" } }))).toContain("Loading transcript");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "error", message: transcriptErrorMessage("not_found") } }))).toContain("has not written a transcript");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "ready", entries: [], droppedEntries: 0, truncatedHead: false } }))).toContain("empty so far");
    expect(transcriptEntryLabel({ kind: "thinking", title: "", text: "" })).toBe("Thinking");
  });

  it("labels user-side kinds distinctly from agent speech", () => {
    expect(transcriptEntryLabel({ kind: "message", title: "", text: "" })).toBe("User");
    expect(transcriptEntryLabel({ kind: "note", title: "", text: "" })).toBe("Note");
    expect(transcriptEntryLabel({ kind: "text", title: "", text: "" })).toBe("Agent");
  });

  it("applies only the response to the request in flight", () => {
    const ok = { ok: true as const, entries: [{ kind: "text" as const, title: "", text: "hi" }], droppedEntries: 0, truncatedHead: false };
    const response = { requestId: "r2", toolCallId: "tc", result: ok };
    expect(applyTranscriptResponse("r2", "tc", response)).toEqual({ phase: "ready", entries: ok.entries, droppedEntries: 0, truncatedHead: false });
    // stale (older request id), other card, nothing pending, nothing received
    expect(applyTranscriptResponse("r3", "tc", response)).toBeNull();
    expect(applyTranscriptResponse("r2", "other", response)).toBeNull();
    expect(applyTranscriptResponse(null, "tc", response)).toBeNull();
    expect(applyTranscriptResponse("r2", "tc", null)).toBeNull();
    expect(applyTranscriptResponse("r2", "tc", { requestId: "r2", toolCallId: "tc", result: { ok: false, reason: "not_found" } })).toEqual({
      phase: "error",
      message: transcriptErrorMessage("not_found"),
    });
    expect(applyTranscriptResponse("r2", "tc", { requestId: "r2", toolCallId: "tc", result: { ok: false, reason: "unavailable" } })).toEqual({
      phase: "error",
      message: transcriptErrorMessage("unavailable"),
    });
    expect(transcriptErrorMessage("timeout")).toContain("No answer");
  });

  it("the store keeps the latest transcript response from the host", () => {
    const store = createDesktopStore();
    expect(store.getState().claudeSubagentTranscript).toBeNull();
    store.getState().applyHostMessage({ type: "claude_subagent_transcript", requestId: "r1", toolCallId: "tc", result: { ok: false, reason: "unavailable" } });
    expect(store.getState().claudeSubagentTranscript).toEqual({ requestId: "r1", toolCallId: "tc", result: { ok: false, reason: "unavailable" } });
  });
});

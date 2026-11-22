import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentTranscriptFeed, transcriptEntryLabel, transcriptErrorMessage } from "./ClaudeSubagentTranscript.js";

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
  });

  it("shows an honest note when the head is not shown, and loading/error/empty states", () => {
    const ready = { phase: "ready" as const, entries: [{ kind: "text" as const, title: "", text: "x" }], droppedEntries: 0, truncatedHead: true };
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: ready }))).toContain("Earlier part of the run is not shown");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "loading" } }))).toContain("Loading transcript");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "error", message: transcriptErrorMessage("not_found") } }))).toContain("has not written a transcript");
    expect(renderToStaticMarkup(createElement(SubagentTranscriptFeed, { state: { phase: "ready", entries: [], droppedEntries: 0, truncatedHead: false } }))).toContain("empty so far");
    expect(transcriptEntryLabel({ kind: "thinking", title: "", text: "" })).toBe("Thinking");
  });
});

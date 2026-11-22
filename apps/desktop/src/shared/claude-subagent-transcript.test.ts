import { describe, expect, it } from "vitest";
import { parseClaudeSubagentTranscript, summarizeSubagentToolInput, SUBAGENT_ENTRY_MAX_CHARS } from "./claude-subagent-transcript.js";

const line = (value: unknown) => JSON.stringify(value);

describe("parseClaudeSubagentTranscript", () => {
  it("turns user/assistant lines into prompt, text, thinking, tool_use and tool_result entries and skips bookkeeping", () => {
    const text = [
      line({ type: "user", message: { role: "user", content: "Read the README" } }),
      line({ type: "attachment", attachment: { type: "deferred_tools_delta" } }),
      line({ type: "api-request", id: "x" }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/README.md" } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "# Title" }] }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n");
    const { entries, droppedEntries } = parseClaudeSubagentTranscript(text);
    expect(droppedEntries).toBe(0);
    expect(entries).toEqual([
      { kind: "prompt", title: "", text: "Read the README" },
      { kind: "thinking", title: "", text: "hmm" },
      { kind: "tool_use", title: "Read", text: "/a/README.md" },
      { kind: "tool_result", title: "", text: "# Title" },
      { kind: "text", title: "", text: "Done." },
    ]);
  });

  it("drops malformed lines, flags error results and caps long text", () => {
    const long = "x".repeat(SUBAGENT_ENTRY_MAX_CHARS + 50);
    const text = ["{not json", line({ type: "user", message: { content: [{ type: "tool_result", content: long, is_error: true }] } })].join("\n");
    const { entries } = parseClaudeSubagentTranscript(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isError).toBe(true);
    expect(entries[0]?.text.endsWith("[truncated]")).toBe(true);
  });

  it("keeps the newest entries when over the cap and counts the rest", () => {
    const text = Array.from({ length: 5 }, (_, i) => line({ type: "assistant", message: { content: [{ type: "text", text: `m${i}` }] } })).join("\n");
    const { entries, droppedEntries } = parseClaudeSubagentTranscript(text, { maxEntries: 2 });
    expect(entries.map((e) => e.text)).toEqual(["m3", "m4"]);
    expect(droppedEntries).toBe(3);
  });

  it("summarizes tool input by its most telling field", () => {
    expect(summarizeSubagentToolInput({ command: "ls -la", description: "list" })).toBe("ls -la");
    expect(summarizeSubagentToolInput({ foo: 1 })).toBe('{"foo":1}');
    expect(summarizeSubagentToolInput(null)).toBe("");
  });

  const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });

  it("labels user-side text by role: first real line is the prompt, later ones are user messages, isMeta are notes", () => {
    const text = [
      user("<system-reminder> Your final report is delivered through SubagentHandback </system-reminder>", { isMeta: true }),
      user("Review target: 92", { isMeta: true }),
      user("Implement the thing"),
      line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
      user("The coordinator sent a message while you were working: fix X", { isMeta: true }),
      user("This session is being continued from a previous conversation that ran out of context.", { isMeta: true }),
      user([{ type: "text", text: "Also check Y" }]),
    ].join("\n");
    const { entries } = parseClaudeSubagentTranscript(text);
    expect(entries.map((e) => [e.kind, e.text.slice(0, 20)])).toEqual([
      ["note", "Review target: 92"],
      ["prompt", "Implement the thing"],
      ["text", "On it."],
      ["note", "The coordinator sent"],
      ["note", "This session is bein"],
      ["message", "Also check Y"],
    ]);
  });

  it("assigns no prompt when the window started mid-file", () => {
    const { entries } = parseClaudeSubagentTranscript(user("a later user line"), { startedMidFile: true });
    expect(entries).toEqual([{ kind: "message", title: "", text: "a later user line" }]);
  });

  it("shows [image] for an image-only tool result", () => {
    const { entries } = parseClaudeSubagentTranscript(
      user([{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] }]),
    );
    expect(entries).toEqual([{ kind: "tool_result", title: "", text: "[image]" }]);
  });
});

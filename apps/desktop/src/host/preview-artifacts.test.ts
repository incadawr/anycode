/**
 * Unit tests for the turn-end auto-open collector (night-track wave-1 cut
 * §1(a)/§3 96-E, risk §5.3). Event SHAPES below are taken from the real
 * engine translators' own test fixtures — not invented — per risk §5.3:
 *  - core Write: packages/core tool dispatch shape (file_path/content).
 *  - codex-projected Write: apps/desktop/src/host/engines/codex/
 *    event-translator.test.ts ("apply_patch (add) ... projects to a
 *    Write tool_execution_start/tool_result pair", `input: { file_path:
 *    "synthetic-file.txt", content: "SYNTHETIC_FILE_OK\n" }`,
 *    `outcome: { toolName: "Write", status: "success" }`).
 *  - claude native Write/Edit: apps/desktop/src/host/engines/claude/
 *    event-translator.test.ts ("row: assistant.tool_use -> BOTH tool_call
 *    AND tool_execution_start", `input: { file_path:
 *    "/tmp/w0-cc-writeprobe.txt", content: "OK" }`, toolName: "Write");
 *    the Edit fixture mirrors core's own Edit tool shape (packages/core/src/
 *    tools/edit.ts: file_path/old_string/new_string/replace_all) — Claude's
 *    CLI passes its native Edit tool through untranslated (translator.ts:311/
 *    316 pass tool_use name/input straight through), so this is the real wire
 *    shape, not a guess.
 *
 * Coverage note (risk §5.3): only Write/Edit are asserted here — the ONLY two
 * tool names `isSnapshotTool` matches. An engine whose write event lacks
 * `file_path` is out of scope for this collector by construction (no known
 * engine today lacks it — core, codex-projected, and claude-native all carry
 * it, per the fixtures above).
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, ToolCallOutcome } from "@anycode/core";
import { PreviewArtifactCollector } from "./preview-artifacts.js";

function start(toolCallId: string, toolName: string, input: unknown): AgentEvent {
  return { type: "tool_execution_start", toolCallId, toolName, input } as AgentEvent;
}

function result(toolCallId: string, toolName: string, status: ToolCallOutcome["status"]): ToolCallOutcome {
  return { toolCallId, toolName, status, modelText: "", durationMs: 0 };
}

/** Drives one full start->result pair through a fresh collector and returns the drained paths. */
function collectOne(toolName: string, input: unknown, status: ToolCallOutcome["status"] = "success"): string[] {
  const collector = new PreviewArtifactCollector();
  collector.observeStart(start("call-1", toolName, input));
  collector.observeResult(result("call-1", toolName, status));
  return collector.drain();
}

describe("PreviewArtifactCollector — multi-engine event shapes (risk §5.3)", () => {
  it("core Write: successful .html write is collected", () => {
    expect(collectOne("Write", { file_path: "/tmp/core-write-probe.html", content: "<p>hi</p>" })).toEqual([
      "/tmp/core-write-probe.html",
    ]);
  });

  it("codex-projected Write (event-translator.test.ts synthetic-file fixture shape): .html write is collected", () => {
    expect(
      collectOne("Write", { file_path: "/tmp/synthetic-file.html", content: "SYNTHETIC_FILE_OK\n" }),
    ).toEqual(["/tmp/synthetic-file.html"]);
  });

  it("claude native Write (event-translator.test.ts w0-cc-writeprobe fixture shape): .html write is collected", () => {
    expect(collectOne("Write", { file_path: "/tmp/w0-cc-writeprobe.html", content: "OK" })).toEqual([
      "/tmp/w0-cc-writeprobe.html",
    ]);
  });

  it("claude native Edit (core Edit tool shape: file_path/old_string/new_string/replace_all): .md edit is collected", () => {
    expect(
      collectOne("Edit", {
        file_path: "/tmp/notes.md",
        old_string: "old",
        new_string: "new",
        replace_all: false,
      }),
    ).toEqual(["/tmp/notes.md"]);
  });

  it(".markdown is collected too — TASK.112 closed the gap the auto-open filter shared with the other five gates", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/plan.markdown", content: "x" }));
    collector.observeResult(result("c1", "Write", "success"));
    expect(collector.drain()).toEqual(["/tmp/plan.markdown"]);
  });

  it(".md is included alongside .html/.htm", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/a.html", content: "x" }));
    collector.observeResult(result("c1", "Write", "success"));
    collector.observeStart(start("c2", "Write", { file_path: "/tmp/b.htm", content: "x" }));
    collector.observeResult(result("c2", "Write", "success"));
    collector.observeStart(start("c3", "Write", { file_path: "/tmp/c.md", content: "x" }));
    collector.observeResult(result("c3", "Write", "success"));
    expect(collector.drain()).toEqual(["/tmp/a.html", "/tmp/b.htm", "/tmp/c.md"]);
  });
});

describe("PreviewArtifactCollector — filtering", () => {
  it("ignores a non-Write/Edit tool (Bash)", () => {
    expect(collectOne("Bash", { command: "ls" })).toEqual([]);
  });

  it("ignores a non-previewable extension (.txt)", () => {
    expect(collectOne("Write", { file_path: "/tmp/notes.txt", content: "x" })).toEqual([]);
  });

  it("ignores a failed tool call (status !== success)", () => {
    expect(collectOne("Write", { file_path: "/tmp/failed.html", content: "x" }, "error")).toEqual([]);
  });

  it("ignores a denied tool call", () => {
    expect(collectOne("Write", { file_path: "/tmp/denied.html", content: "x" }, "denied")).toEqual([]);
  });

  it("ignores a start event whose input carries no file_path", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { content: "no path here" }));
    collector.observeResult(result("c1", "Write", "success"));
    expect(collector.drain()).toEqual([]);
  });

  it("a tool_result with no matching prior start is a no-op (never throws)", () => {
    const collector = new PreviewArtifactCollector();
    expect(() => collector.observeResult(result("orphan-call", "Write", "success"))).not.toThrow();
    expect(collector.drain()).toEqual([]);
  });
});

describe("PreviewArtifactCollector — ordering and dedup", () => {
  it("dedups by path: a re-write during the same turn moves it to the end (last-write-wins)", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/a.html", content: "1" }));
    collector.observeResult(result("c1", "Write", "success"));
    collector.observeStart(start("c2", "Write", { file_path: "/tmp/b.html", content: "1" }));
    collector.observeResult(result("c2", "Write", "success"));
    // a.html written again -> moves to the end, not duplicated
    collector.observeStart(start("c3", "Write", { file_path: "/tmp/a.html", content: "2" }));
    collector.observeResult(result("c3", "Write", "success"));
    expect(collector.drain()).toEqual(["/tmp/b.html", "/tmp/a.html"]);
  });

  it("preserves first-write ordering for distinct paths", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/first.html", content: "1" }));
    collector.observeResult(result("c1", "Write", "success"));
    collector.observeStart(start("c2", "Edit", { file_path: "/tmp/second.md", old_string: "a", new_string: "b" }));
    collector.observeResult(result("c2", "Edit", "success"));
    expect(collector.drain()).toEqual(["/tmp/first.html", "/tmp/second.md"]);
  });
});

describe("PreviewArtifactCollector — drain semantics (turn end, incl. abort)", () => {
  it("drain clears the collected set — a second drain is empty", () => {
    const collector = new PreviewArtifactCollector();
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/a.html", content: "1" }));
    collector.observeResult(result("c1", "Write", "success"));
    expect(collector.drain()).toEqual(["/tmp/a.html"]);
    expect(collector.drain()).toEqual([]);
  });

  it("an aborted turn (start observed, no matching result ever arrives) drains clean — no stale pending leaks into the next turn", () => {
    const collector = new PreviewArtifactCollector();
    // Turn 1: a Write starts but the turn is cancelled before tool_result lands.
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/aborted.html", content: "1" }));
    expect(collector.drain()).toEqual([]); // nothing committed yet — abort clears the dangling start too

    // Turn 2: a toolCallId collision (e.g. a counter reset) must not resurrect
    // the aborted turn's dangling start as this turn's result.
    collector.observeStart(start("c1", "Write", { file_path: "/tmp/turn2.html", content: "2" }));
    collector.observeResult(result("c1", "Write", "success"));
    expect(collector.drain()).toEqual(["/tmp/turn2.html"]);
  });

  it("drain with nothing collected returns an empty array", () => {
    expect(new PreviewArtifactCollector().drain()).toEqual([]);
  });
});

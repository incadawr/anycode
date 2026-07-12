/**
 * Pure-logic tests for ToolCallCard's task-3.1.4 subagent sub-status
 * formatter (design/phase-3.md §3.3/§4.2) and task-3.4.5 workflow sub-status
 * formatter (design/slice-3.4-cut.md §2.3/§6). Same `.test.ts`-only rationale
 * as PermissionModal.test.ts/SessionPicker.test.ts: no jsdom in this
 * package's vitest config, so the exported pure functions are covered
 * directly instead of through DOM rendering.
 *
 * P7.18/F16b (W3) adds a second layer at the bottom of this file: real
 * component-level assertions via `react-dom/server`'s `renderToStaticMarkup`
 * — it walks the React element tree to an HTML string without touching any
 * DOM API, so it works under this package's plain "node" vitest environment
 * with no jsdom dependency (verified directly: a throwaway SSR render of
 * this exact component tree in this exact config produced real markup).
 * `AgentCardBody` is exported (see its doc comment) specifically so those
 * tests can render the expanded Agent-card body directly — ToolCallCard's
 * own public props have no path to an expanded Agent body, since Agent
 * cards default to collapsed in every status (design/slice-P7.4-cut.md
 * §3.2, untouched by this slice).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityRowText,
  activityRows,
  activityVerb,
  AgentCardBody,
  agentResultText,
  capLines,
  defaultExpanded,
  flattenSummary,
  formatSubagentCounters,
  formatWorkflowCounters,
  moreLinesLabel,
  parseTodos,
  pendingStepsLabel,
  promptStripText,
  PROMPT_STRIP_LINES,
  PROMPT_STRIP_MAX_CHARS,
  shouldAutoCollapse,
  substatusKind,
  summarizeInput,
  SUMMARY_MAX_CHARS,
  todoSummary,
  ToolCallCard,
  workflowRunLabel,
  workflowStepAria,
  workflowStepMeta,
} from "./ToolCallCard.js";
import type { TodoItemView } from "./ToolCallCard.js";
import type { SubagentSubStatus, ToolCallBlock, WorkflowSubStatus, WorkflowStepStatus } from "../store.js";

describe("formatSubagentCounters — running (final: null)", () => {
  it("pluralizes tool calls and includes lastTool when present", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "survey the repo",
      turns: 2,
      toolCalls: 3,
      lastTool: "Grep",
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("turn 2 · 3 tool calls · Grep");
  });

  it("uses the singular 'tool call' at count 1", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "d",
      turns: 1,
      toolCalls: 1,
      lastTool: "Read",
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("turn 1 · 1 tool call · Read");
  });

  it("omits the lastTool suffix when null (no tool call yet)", () => {
    const subagent: SubagentSubStatus = {
      agentType: "general-purpose",
      description: "d",
      turns: 0,
      toolCalls: 0,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("turn 0 · 0 tool calls");
    expect(formatSubagentCounters(subagent)).not.toContain("null");
  });
});

describe("formatSubagentCounters — settled (final set)", () => {
  it("formats a completed outcome with singular/plural turns and seconds", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "d",
      turns: 5,
      toolCalls: 4,
      lastTool: "Bash",
      activity: [],
      activityDropped: 0,
      final: { status: "completed", durationMs: 12345 },
    };
    expect(formatSubagentCounters(subagent)).toBe("Completed · 5 turns · 12.3s");
  });

  it("uses the singular 'turn' at count 1", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "d",
      turns: 1,
      toolCalls: 1,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: { status: "completed", durationMs: 500 },
    };
    expect(formatSubagentCounters(subagent)).toBe("Completed · 1 turn · 0.5s");
  });

  it("maps max_turns/cancelled/error statuses to their labels", () => {
    const base: Omit<SubagentSubStatus, "final"> = {
      agentType: "explore",
      description: "d",
      turns: 8,
      toolCalls: 2,
      lastTool: null,
      activity: [],
      activityDropped: 0,
    };
    expect(formatSubagentCounters({ ...base, final: { status: "max_turns", durationMs: 1000 } })).toBe(
      "Max turns reached · 8 turns · 1.0s",
    );
    expect(formatSubagentCounters({ ...base, final: { status: "cancelled", durationMs: 1000 } })).toBe(
      "Cancelled · 8 turns · 1.0s",
    );
    expect(formatSubagentCounters({ ...base, final: { status: "error", durationMs: 1000 } })).toBe(
      "Error · 8 turns · 1.0s",
    );
  });
});

describe("shouldAutoCollapse", () => {
  it("folds settled non-failure statuses (success, cancelled)", () => {
    expect(shouldAutoCollapse("success")).toBe(true);
    expect(shouldAutoCollapse("cancelled")).toBe(true);
  });

  it("keeps live and failure statuses expanded", () => {
    const stayExpanded: ToolCallBlock["status"][] = [
      "proposed",
      "running",
      "error",
      "invalid_input",
      "denied",
      "timed_out",
    ];
    for (const status of stayExpanded) {
      expect(shouldAutoCollapse(status)).toBe(false);
    }
  });
});

describe("flattenSummary", () => {
  it("collapses multi-line text to a single line", () => {
    expect(flattenSummary("line one\nline two\nline three")).toBe("line one line two line three");
  });

  it("collapses tab/space runs to single spaces", () => {
    expect(flattenSummary("a\t\tb   c")).toBe("a b c");
  });

  it("trims leading/trailing whitespace", () => {
    expect(flattenSummary("  \n  padded  \n  ")).toBe("padded");
  });

  it("passes text at exactly SUMMARY_MAX_CHARS through verbatim", () => {
    const text = "x".repeat(SUMMARY_MAX_CHARS);
    expect(flattenSummary(text)).toBe(text);
  });

  it("truncates text over SUMMARY_MAX_CHARS to 200 chars + an ellipsis", () => {
    const text = "x".repeat(SUMMARY_MAX_CHARS + 1);
    const result = flattenSummary(text);
    expect(result).toBe(`${"x".repeat(SUMMARY_MAX_CHARS)}…`);
    expect(result.length).toBe(SUMMARY_MAX_CHARS + 1);
  });

  it("returns an empty string for empty input", () => {
    expect(flattenSummary("")).toBe("");
  });
});

describe("capLines", () => {
  it("returns verbatim text with hiddenCount 0 when under the cap", () => {
    const text = "a\nb\nc";
    expect(capLines(text, 14)).toEqual({ visible: text, hiddenCount: 0 });
  });

  it("returns verbatim text with hiddenCount 0 when exactly at the cap", () => {
    const text = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
    expect(capLines(text, 14)).toEqual({ visible: text, hiddenCount: 0 });
  });

  it("caps to the first N lines with hiddenCount 1 at cap+1", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`);
    const result = capLines(lines.join("\n"), 14);
    expect(result.visible).toBe(lines.slice(0, 14).join("\n"));
    expect(result.hiddenCount).toBe(1);
  });

  it("computes hiddenCount 26 for 40 lines at cap 14", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const result = capLines(lines.join("\n"), 14);
    expect(result.hiddenCount).toBe(26);
  });

  it("does not mint a phantom expander from trailing newlines", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line ${i}`);
    const result = capLines(`${lines.join("\n")}\n\n`, 14);
    expect(result.hiddenCount).toBe(0);
  });

  it("treats a single long unwrapped line as one line (hiddenCount 0)", () => {
    const text = "x".repeat(5000);
    expect(capLines(text, 14)).toEqual({ visible: text, hiddenCount: 0 });
  });

  it("returns hiddenCount 0 for empty input", () => {
    expect(capLines("", 14)).toEqual({ visible: "", hiddenCount: 0 });
  });
});

describe("moreLinesLabel", () => {
  it("uses the singular form at count 1", () => {
    expect(moreLinesLabel(1)).toBe("Show 1 more line");
  });

  it("uses the plural form for other counts", () => {
    expect(moreLinesLabel(24)).toBe("Show 24 more lines");
  });
});

describe("summarizeInput", () => {
  it("summarizes Bash to its command", () => {
    expect(summarizeInput("Bash", { command: "git status" })).toBe("git status");
  });

  it("summarizes Read/Write/Edit to file_path", () => {
    expect(summarizeInput("Read", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summarizeInput("Write", { file_path: "/tmp/b.ts" })).toBe("/tmp/b.ts");
    expect(summarizeInput("Edit", { file_path: "/tmp/c.ts" })).toBe("/tmp/c.ts");
  });

  it("summarizes Grep to pattern, or 'pattern in path' when a path is present", () => {
    expect(summarizeInput("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeInput("Grep", { pattern: "TODO", path: "src/" })).toBe("TODO in src/");
  });

  it("summarizes Agent to its description", () => {
    expect(summarizeInput("Agent", { description: "survey the repo", prompt: "..." })).toBe("survey the repo");
  });

  it("falls back to JSON for an Agent input without a description", () => {
    const input = { prompt: "..." };
    expect(summarizeInput("Agent", input)).toBe(JSON.stringify(input));
  });

  it("falls back to JSON for an unknown tool", () => {
    const input = { foo: "bar" };
    expect(summarizeInput("SomeFutureTool", input)).toBe(JSON.stringify(input));
  });

  it("guards undefined input to an empty string instead of the literal 'undefined'", () => {
    expect(summarizeInput("SomeFutureTool", undefined)).toBe("");
  });

  it("guards undefined input on EVERY known-tool branch (flattenSummary would throw on undefined)", () => {
    // Regression pin (R4 review F1): a hydrated tool_call with a dropped
    // `input` field reaching a collapsed row must not crash — every branch
    // returns "" (a real string), never JSON.stringify(undefined) === undefined.
    for (const tool of ["Bash", "Read", "Write", "Edit", "Grep"]) {
      expect(summarizeInput(tool, undefined)).toBe("");
      expect(() => flattenSummary(summarizeInput(tool, undefined))).not.toThrow();
    }
  });

  it("falls back to JSON for non-object input", () => {
    expect(summarizeInput("SomeFutureTool", 42)).toBe(JSON.stringify(42));
  });
});

describe("formatWorkflowCounters — running (final: null)", () => {
  const step = (overrides: Partial<WorkflowStepStatus> = {}): WorkflowStepStatus => ({
    stepId: "build",
    agentType: "explore",
    turns: 0,
    toolCalls: 0,
    lastTool: null,
    final: null,
    ...overrides,
  });

  it("reports the most-recently-started still-running step, pluralizing tool calls and including lastTool when present", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 3,
      steps: [
        step({ stepId: "fetch", final: { status: "completed", durationMs: 100 } }),
        step({ stepId: "build", turns: 2, toolCalls: 3, lastTool: "Bash" }),
      ],
      final: null,
    };
    expect(formatWorkflowCounters(workflow)).toBe("step 2/3 · build · turn 2 · 3 tool calls · Bash");
  });

  it("uses the singular 'tool call' at count 1 and omits lastTool when null", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 1,
      steps: [step({ turns: 1, toolCalls: 1, lastTool: null })],
      final: null,
    };
    expect(formatWorkflowCounters(workflow)).toBe("step 1/1 · build · turn 1 · 1 tool call");
    expect(formatWorkflowCounters(workflow)).not.toContain("null");
  });

  it("falls back to a bare step-count line when every started step has already settled (between DAG waves)", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 4,
      steps: [
        step({ stepId: "fetch", final: { status: "completed", durationMs: 100 } }),
        step({ stepId: "build", final: { status: "completed", durationMs: 200 } }),
      ],
      final: null,
    };
    expect(formatWorkflowCounters(workflow)).toBe("step 2/4");
  });

  it("reports zero steps started before the first workflow_step_start lands", () => {
    const workflow: WorkflowSubStatus = { workflow: "release-flow", totalSteps: 2, steps: [], final: null };
    expect(formatWorkflowCounters(workflow)).toBe("step 0/2");
  });
});

describe("formatWorkflowCounters — settled (final set)", () => {
  const base: WorkflowSubStatus = { workflow: "release-flow", totalSteps: 3, steps: [], final: null };

  it("formats a completed run with singular/plural steps and seconds", () => {
    const workflow: WorkflowSubStatus = {
      ...base,
      final: { status: "completed", completedSteps: 3, durationMs: 12345 },
    };
    expect(formatWorkflowCounters(workflow)).toBe("Completed · 3/3 steps · 12.3s");
  });

  it("maps failed/cancelled statuses to their labels", () => {
    expect(formatWorkflowCounters({ ...base, final: { status: "failed", completedSteps: 1, durationMs: 1000 } })).toBe(
      "Failed · 1/3 steps · 1.0s",
    );
    expect(
      formatWorkflowCounters({ ...base, final: { status: "cancelled", completedSteps: 0, durationMs: 500 } }),
    ).toBe("Cancelled · 0/3 steps · 0.5s");
  });
});

// R14 agent-orchestration surfaces: the five new pure exports. Shared step
// builder (module-scope; does not collide with the describe-local `step` above).
const mkStep = (overrides: Partial<WorkflowStepStatus> = {}): WorkflowStepStatus => ({
  stepId: "build",
  agentType: "explore",
  turns: 0,
  toolCalls: 0,
  lastTool: null,
  final: null,
  ...overrides,
});

describe("substatusKind", () => {
  it("maps null to the synthetic 'running'", () => {
    expect(substatusKind(null)).toBe("running");
  });

  it("passes each settled status through verbatim", () => {
    expect(substatusKind({ status: "completed" })).toBe("completed");
    expect(substatusKind({ status: "max_turns" })).toBe("max_turns");
    expect(substatusKind({ status: "cancelled" })).toBe("cancelled");
    expect(substatusKind({ status: "error" })).toBe("error");
    expect(substatusKind({ status: "skipped" })).toBe("skipped");
    expect(substatusKind({ status: "failed" })).toBe("failed");
  });
});

describe("workflowRunLabel", () => {
  it("shows the bare run aggregate — not the per-step ticker — while a step runs (de-dup pin)", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 3,
      steps: [
        mkStep({ stepId: "fetch", final: { status: "completed", durationMs: 100 } }),
        mkStep({ stepId: "build", turns: 2, toolCalls: 3, lastTool: "Bash" }),
      ],
      final: null,
    };
    expect(workflowRunLabel(workflow)).toBe("step 2/3");
    expect(workflowRunLabel(workflow)).not.toContain("turn");
  });

  it("shows the bare aggregate between DAG waves", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 4,
      steps: [
        mkStep({ stepId: "fetch", final: { status: "completed", durationMs: 100 } }),
        mkStep({ stepId: "build", final: { status: "completed", durationMs: 200 } }),
      ],
      final: null,
    };
    expect(workflowRunLabel(workflow)).toBe("step 2/4");
  });

  it("reports zero started before the first step lands", () => {
    const workflow: WorkflowSubStatus = { workflow: "release-flow", totalSteps: 2, steps: [], final: null };
    expect(workflowRunLabel(workflow)).toBe("step 0/2");
  });

  it("delegates to formatWorkflowCounters once settled (frozen export stays rendered)", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      totalSteps: 3,
      steps: [],
      final: { status: "completed", completedSteps: 3, durationMs: 12345 },
    };
    expect(workflowRunLabel(workflow)).toBe(formatWorkflowCounters(workflow));
    expect(workflowRunLabel(workflow)).toBe("Completed · 3/3 steps · 12.3s");
  });
});

describe("workflowStepMeta", () => {
  it("running: live ticker with pluralized tool calls and the lastTool suffix", () => {
    expect(workflowStepMeta(mkStep({ turns: 2, toolCalls: 3, lastTool: "Bash" }))).toBe("turn 2 · 3 tool calls · Bash");
  });

  it("running: singular 'tool call' at count 1 and omits lastTool when null", () => {
    const meta = workflowStepMeta(mkStep({ turns: 1, toolCalls: 1, lastTool: null }));
    expect(meta).toBe("turn 1 · 1 tool call");
    expect(meta).not.toContain("null");
  });

  it("running: 'turn 0 · 0 tool calls' at the seeded zero state", () => {
    expect(workflowStepMeta(mkStep({ turns: 0, toolCalls: 0, lastTool: null }))).toBe("turn 0 · 0 tool calls");
  });

  it("completed: duration only, no outcome word (Check + color carry the state)", () => {
    expect(workflowStepMeta(mkStep({ final: { status: "completed", durationMs: 12345 } }))).toBe("12.3s");
  });

  it("error: '<label> · D.Ds'", () => {
    expect(workflowStepMeta(mkStep({ final: { status: "error", durationMs: 4200 } }))).toBe("Error · 4.2s");
  });

  it("max_turns: reuses the subagent wording", () => {
    expect(workflowStepMeta(mkStep({ final: { status: "max_turns", durationMs: 8000 } }))).toBe(
      "Max turns reached · 8.0s",
    );
  });

  it("cancelled: '<label> · D.Ds'", () => {
    expect(workflowStepMeta(mkStep({ final: { status: "cancelled", durationMs: 1200 } }))).toBe("Cancelled · 1.2s");
  });

  it("skipped: bare word, no duration (scheduling noise omitted)", () => {
    const meta = workflowStepMeta(mkStep({ final: { status: "skipped", durationMs: 999 } }));
    expect(meta).toBe("Skipped");
    expect(meta).not.toMatch(/\d/);
    expect(meta).not.toContain("·");
  });
});

describe("workflowStepAria", () => {
  it("running: full sentence including the Running word the glyph only shows visually", () => {
    expect(workflowStepAria(mkStep({ turns: 2, toolCalls: 3, lastTool: "Bash" }))).toBe(
      "build · explore · Running · turn 2 · 3 tool calls · Bash",
    );
  });

  it("completed: injects the Completed word before the duration", () => {
    expect(workflowStepAria(mkStep({ final: { status: "completed", durationMs: 12345 } }))).toBe(
      "build · explore · Completed · 12.3s",
    );
  });

  it("other settled states: meta already leads with the label", () => {
    expect(
      workflowStepAria(mkStep({ stepId: "deploy", agentType: "sonnet", final: { status: "skipped", durationMs: 0 } })),
    ).toBe("deploy · sonnet · Skipped");
  });
});

describe("pendingStepsLabel", () => {
  it("returns null when every step has started", () => {
    expect(
      pendingStepsLabel({ workflow: "w", totalSteps: 2, steps: [mkStep(), mkStep()], final: null }),
    ).toBeNull();
  });

  it("uses the singular form at 1 remaining", () => {
    expect(pendingStepsLabel({ workflow: "w", totalSteps: 2, steps: [mkStep()], final: null })).toBe(
      "1 step not started",
    );
  });

  it("uses the plural form at 2+ remaining", () => {
    expect(pendingStepsLabel({ workflow: "w", totalSteps: 3, steps: [mkStep()], final: null })).toBe(
      "2 steps not started",
    );
  });

  it("guards hostile over-delivery (steps.length > totalSteps) to null", () => {
    expect(
      pendingStepsLabel({ workflow: "w", totalSteps: 1, steps: [mkStep(), mkStep()], final: null }),
    ).toBeNull();
  });

  it("still labels not-started steps after the run settles (post-mortem why completed < total)", () => {
    expect(
      pendingStepsLabel({
        workflow: "w",
        totalSteps: 3,
        steps: [mkStep()],
        final: { status: "failed", completedSteps: 1, durationMs: 1000 },
      }),
    ).toBe("2 steps not started");
  });
});

// P7.4 (F1): TodoWrite checklist + compact subagent card.
describe("parseTodos", () => {
  it("parses a valid replace-all list", () => {
    const input = {
      todos: [
        { content: "write the plan", status: "completed" },
        { content: "wire the checklist branch", status: "in_progress" },
        { content: "ship it", status: "pending" },
      ],
    };
    expect(parseTodos(input)).toEqual<TodoItemView[]>([
      { content: "write the plan", status: "completed" },
      { content: "wire the checklist branch", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ]);
  });

  it("accepts an empty array as a valid, honest replace-all", () => {
    expect(parseTodos({ todos: [] })).toEqual([]);
  });

  it("accepts unknown extra keys on an item (forward-compat)", () => {
    expect(parseTodos({ todos: [{ id: "1", content: "a", status: "pending", extra: true }] })).toEqual([
      { content: "a", status: "pending" },
    ]);
  });

  it("returns null when todos is missing", () => {
    expect(parseTodos({})).toBeNull();
  });

  it("returns null when todos is not an array", () => {
    expect(parseTodos({ todos: "nope" })).toBeNull();
  });

  it("returns null when an item lacks content", () => {
    expect(parseTodos({ todos: [{ status: "pending" }] })).toBeNull();
  });

  it("returns null when an item has empty-string content", () => {
    expect(parseTodos({ todos: [{ content: "", status: "pending" }] })).toBeNull();
  });

  it("returns null when an item has an unknown status", () => {
    expect(parseTodos({ todos: [{ content: "a", status: "done" }] })).toBeNull();
  });

  it("returns null for null, string, and number input", () => {
    expect(parseTodos(null)).toBeNull();
    expect(parseTodos("todos")).toBeNull();
    expect(parseTodos(42)).toBeNull();
  });
});

describe("todoSummary", () => {
  it("counts done/total and appends the first in_progress item's content", () => {
    const todos: TodoItemView[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ];
    expect(todoSummary(todos)).toBe("1/3 · b");
  });

  it("counts only, with no trailing separator, when no item is in_progress", () => {
    const todos: TodoItemView[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ];
    expect(todoSummary(todos)).toBe("1/2");
  });

  it("reports all-completed as done/total", () => {
    const todos: TodoItemView[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(todoSummary(todos)).toBe("2/2");
  });

  it("handles a single-item list", () => {
    expect(todoSummary([{ content: "only", status: "in_progress" }])).toBe("0/1 · only");
  });
});

describe("summarizeInput — TodoWrite", () => {
  it("summarizes a valid replace-all list via todoSummary", () => {
    const input = { todos: [{ content: "a", status: "in_progress" }] };
    expect(summarizeInput("TodoWrite", input)).toBe("0/1 · a");
  });

  it("falls back to the generic JSON dump when malformed", () => {
    const input = { todos: "nope" };
    expect(summarizeInput("TodoWrite", input)).toBe(JSON.stringify(input));
  });
});

describe("defaultExpanded", () => {
  it("Agent is collapsed-by-default in every status, including proposed/running", () => {
    const statuses: ToolCallBlock["status"][] = [
      "proposed",
      "running",
      "success",
      "error",
      "invalid_input",
      "denied",
      "timed_out",
      "cancelled",
    ];
    for (const status of statuses) {
      expect(defaultExpanded("Agent", status)).toBe(false);
    }
  });

  it("mirrors !shouldAutoCollapse for every other tool/status", () => {
    const statuses: ToolCallBlock["status"][] = [
      "proposed",
      "running",
      "success",
      "error",
      "invalid_input",
      "denied",
      "timed_out",
      "cancelled",
    ];
    for (const status of statuses) {
      expect(defaultExpanded("Bash", status)).toBe(!shouldAutoCollapse(status));
      expect(defaultExpanded("Workflow", status)).toBe(!shouldAutoCollapse(status));
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// P7.18/F16b W3: RESULT-first Agent-card body — activity feed, RESULT slot,
// two-level PROMPT plaque. Pure-formatter tests first, then real component
// renders (react-dom/server, see file header) for the DOM-structure DoD
// bullets.
// ─────────────────────────────────────────────────────────────────────────

describe("activityVerb", () => {
  it("maps known child tools to their verb word", () => {
    expect(activityVerb("Bash")).toBe("Ran");
    expect(activityVerb("Read")).toBe("Read");
    expect(activityVerb("Write")).toBe("Wrote");
    expect(activityVerb("Edit")).toBe("Edited");
    expect(activityVerb("Grep")).toBe("Grep");
    expect(activityVerb("Glob")).toBe("Glob");
    expect(activityVerb("TodoWrite")).toBe("Todo");
    expect(activityVerb("Agent")).toBe("Agent");
  });

  it("falls back to the raw tool name for an unknown child tool", () => {
    expect(activityVerb("WebFetch")).toBe("WebFetch");
  });
});

describe("activityRowText", () => {
  it("joins verb and subject with a space", () => {
    expect(activityRowText({ toolName: "Bash", summary: "npm run build" })).toBe("Ran npm run build");
    expect(activityRowText({ toolName: "Read", summary: "/a/b.ts" })).toBe("Read /a/b.ts");
    expect(activityRowText({ toolName: "TodoWrite", summary: "step two 1/3" })).toBe("Todo step two 1/3");
  });

  it("falls back to the bare verb when the summary is empty (core's own fallback)", () => {
    expect(activityRowText({ toolName: "WebFetch", summary: "" })).toBe("WebFetch");
  });
});

/** Minimal SubagentSubStatus builder — only the fields a given test varies change. */
function mkSubagent(overrides: Partial<SubagentSubStatus> = {}): SubagentSubStatus {
  return {
    agentType: "explore",
    description: "survey the repo",
    turns: 1,
    toolCalls: 2,
    lastTool: "Read",
    activity: [],
    activityDropped: 0,
    final: null,
    ...overrides,
  };
}

describe("activityRows", () => {
  it("returns one row per activity entry, oldest first, no leading row when nothing dropped", () => {
    const subagent = mkSubagent({
      activity: [
        { toolName: "Bash", summary: "ls -la" },
        { toolName: "Read", summary: "/a/b.ts" },
      ],
    });
    const rows = activityRows(subagent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ text: "Ran ls -la" });
    expect(rows[1]).toMatchObject({ text: "Read /a/b.ts" });
    expect(rows.some((row) => row.leading === true)).toBe(false);
  });

  it("prepends a '+N earlier' leading row when activityDropped > 0", () => {
    const subagent = mkSubagent({
      activity: [{ toolName: "Grep", summary: "TODO" }],
      activityDropped: 37,
    });
    const rows = activityRows(subagent);
    expect(rows[0]).toEqual({ key: "dropped", text: "+37 earlier", leading: true });
    expect(rows[1]).toMatchObject({ text: "Grep TODO" });
  });

  it("returns an empty list for a freshly seeded subagent (no activity yet)", () => {
    expect(activityRows(mkSubagent())).toEqual([]);
  });
});

describe("agentResultText", () => {
  it("returns null for a non-Agent tool regardless of status/modelText (generic path untouched)", () => {
    expect(agentResultText({ toolName: "Bash", status: "success", modelText: "output" })).toBeNull();
    expect(agentResultText({ toolName: "Bash", status: "error", modelText: "boom" })).toBeNull();
  });

  it("returns null while proposed/running — the RESULT slot is settled-only", () => {
    expect(agentResultText({ toolName: "Agent", status: "proposed", modelText: null })).toBeNull();
    expect(agentResultText({ toolName: "Agent", status: "running", modelText: null })).toBeNull();
  });

  it("returns modelText verbatim once settled (success)", () => {
    expect(agentResultText({ toolName: "Agent", status: "success", modelText: "## Findings\n\nAll good." })).toBe(
      "## Findings\n\nAll good.",
    );
  });

  it("returns modelText verbatim on error — same slot carries the error text", () => {
    expect(agentResultText({ toolName: "Agent", status: "error", modelText: "Agent: the subagent failed." })).toBe(
      "Agent: the subagent failed.",
    );
  });

  it("returns null when modelText hasn't arrived yet even if settled (defensive — no tool_result race)", () => {
    expect(agentResultText({ toolName: "Agent", status: "success", modelText: null })).toBeNull();
  });
});

describe("promptStripText", () => {
  it("caps a multi-line prompt to PROMPT_STRIP_LINES lines", () => {
    expect(PROMPT_STRIP_LINES).toBe(2);
    const prompt = "line one\nline two\nline three\nline four";
    const result = promptStripText(prompt);
    expect(result.visible).toBe("line one\nline two");
    expect(result.truncated).toBe(true);
  });

  it("caps one long unwrapped line by char budget even with no newlines", () => {
    const prompt = "x".repeat(PROMPT_STRIP_MAX_CHARS + 50);
    const result = promptStripText(prompt);
    expect(result.visible.length).toBe(PROMPT_STRIP_MAX_CHARS + 1); // +1 for the ellipsis
    expect(result.visible.endsWith("…")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("passes a short prompt through untouched", () => {
    const prompt = "one line, short.";
    const result = promptStripText(prompt);
    expect(result).toEqual({ visible: prompt, truncated: false });
  });
});

/** Minimal Agent ToolCallBlock builder for the SSR component tests below. */
function mkAgentBlock(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    kind: "tool_call",
    id: "block-1",
    toolCallId: "tc-1",
    toolName: "Agent",
    input: {
      description: "survey the repo",
      prompt: "Explore the codebase.\nFocus on the CLI package.\nReport back facts only.\nDo not modify anything.",
    },
    status: "running",
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
    ...overrides,
  };
}

/** Renders AgentCardBody to a static HTML string (see file header for the
 * jsdom-free SSR rationale). `noop` covers the required onTogglePrompt prop
 * — no click is simulated (SSR has no event system); the plaque's two states
 * are instead reached directly via the `promptExpanded` prop. */
function renderAgentBody(block: ToolCallBlock, promptExpanded = false): string {
  const noop = () => {};
  return renderToStaticMarkup(createElement(AgentCardBody, { block, promptExpanded, onTogglePrompt: noop }));
}

describe("AgentCardBody (SSR component render)", () => {
  it("a RUNNING agent card shows feed rows and the collapsed (2-line) prompt strip", () => {
    const block = mkAgentBlock({
      status: "running",
      subagent: mkSubagent({
        final: null,
        activity: [
          { toolName: "Bash", summary: "ls -la" },
          { toolName: "Read", summary: "package.json" },
        ],
      }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("subagent-activity-feed");
    expect(html).toContain("Ran ls -la");
    expect(html).toContain("Read package.json");
    // Prompt plaque present, collapsed: strip text only, full prompt absent.
    expect(html).toContain("subagent-prompt-plaque");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Explore the codebase.");
    expect(html).toContain("Focus on the CLI package.");
    expect(html).not.toContain("Report back facts only.");
    // Settled-only RESULT slot must not appear while running.
    expect(html).not.toContain("tool-call-agent-result");
  });

  it("a SETTLED agent card renders modelText as the prominent RESULT, routed through Markdown (not a raw pre)", () => {
    const block = mkAgentBlock({
      status: "success",
      modelText: "**Done.** Found 3 issues.",
      subagent: mkSubagent({ final: { status: "completed", durationMs: 4200 } }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("tool-call-agent-result");
    // Markdown-rendered: the bold marker becomes a real <strong>, not literal "**" text
    // and not the generic tools' raw <pre class="tool-call-result"> well.
    expect(html).toMatch(/<strong>Done\.<\/strong>/);
    expect(html).not.toContain('class="tool-call-result"');
    expect(html).not.toContain("**Done.**");
  });

  it("error status shows the error text in the same RESULT slot (Markdown-rendered, not raw pre)", () => {
    const block = mkAgentBlock({
      status: "error",
      modelText: "Agent: the subagent failed.",
      subagent: mkSubagent({ final: { status: "error", durationMs: 900 } }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("tool-call-agent-result");
    expect(html).toContain("Agent: the subagent failed.");
    expect(html).not.toContain('class="tool-call-result"');
  });

  it("activityDropped > 0 renders the '+N earlier' affordance", () => {
    const block = mkAgentBlock({
      status: "running",
      subagent: mkSubagent({
        final: null,
        activity: [{ toolName: "Grep", summary: "TODO" }],
        activityDropped: 12,
      }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("+12 earlier");
    expect(html).toContain("subagent-activity-row-dropped");
  });

  it("the full prompt is NOT rendered on the level-1 (card) expand — only the truncated strip", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent({ final: null }) });
    const html = renderAgentBody(block, false);
    expect(html).toContain("Explore the codebase.");
    expect(html).not.toContain("Report back facts only.");
    expect(html).not.toContain("Do not modify anything.");
  });

  it("the full prompt IS rendered once the plaque's level-2 expand is active", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent({ final: null }) });
    const html = renderAgentBody(block, true);
    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("Explore the codebase.");
    expect(html).toContain("Report back facts only.");
    expect(html).toContain("Do not modify anything.");
  });

  it("a still-proposed agent call (no subagent yet) renders only the prompt plaque, honestly", () => {
    const block = mkAgentBlock({ status: "proposed", subagent: null, modelText: null });
    const html = renderAgentBody(block, false);
    expect(html).toContain("subagent-prompt-plaque");
    expect(html).not.toContain("tool-call-subagent-counters");
    expect(html).not.toContain("subagent-activity-feed");
    expect(html).not.toContain("tool-call-agent-result");
  });
});

describe("ToolCallCard (SSR component render) — generic non-Agent path stays untouched", () => {
  it("a settled non-Agent tool card still renders its raw <pre class=\"tool-call-result\"> — no Agent-only markup leaks in", () => {
    const block: ToolCallBlock = {
      kind: "tool_call",
      id: "b1",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "npm test" },
      status: "error", // error stays expanded by default (shouldAutoCollapse=false)
      modelText: "1 failing test",
      snapshots: { before: null, after: null },
      subagent: null,
      workflow: null,
    };
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));
    expect(html).toContain('class="tool-call-result"');
    expect(html).toContain("1 failing test");
    expect(html).not.toContain("tool-call-agent-result");
    expect(html).not.toContain("subagent-activity-feed");
    expect(html).not.toContain("subagent-prompt-plaque");
  });

  it("an Agent card still defaults to the collapsed one-liner in every status (F16 header grammar untouched)", () => {
    const block = mkAgentBlock({
      status: "running",
      subagent: mkSubagent({
        final: null,
        activity: [{ toolName: "Bash", summary: "ls" }],
      }),
    });
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));
    // Collapsed one-liner grammar (F16, unchanged) present...
    expect(html).toContain("subagent-collapsed-line");
    expect(html).toContain("SubAgent");
    // ...and the W3 expanded-body sections are NOT mounted (card is collapsed by default).
    expect(html).not.toContain("subagent-activity-feed");
    expect(html).not.toContain("subagent-prompt-plaque");
    expect(html).not.toContain("tool-call-agent-result");
  });
});

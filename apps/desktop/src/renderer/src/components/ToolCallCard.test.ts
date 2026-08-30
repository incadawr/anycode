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
import type { ChildBadgeKind } from "../child-layout.js";
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
  isClickableChildBadge,
  moreLinesLabel,
  layoutWorkflowMap,
  orderStepsByDependency,
  workflowMapLabel,
  parseTodos,
  workflowActivityRows,
  workflowStepKind,
  workflowRunUsage,
  formatWorkflowUsage,
  promptStripText,
  PROMPT_STRIP_LINES,
  PROMPT_STRIP_MAX_CHARS,
  shouldAutoCollapse,
  subagentResponseModelNote,
  substatusKind,
  summarizeInput,
  SUMMARY_MAX_CHARS,
  todoSummary,
  toggleWorkflowStepSelection,
  ToolCallCard,
  ToolCallHeaderRow,
  previewablePathOf,
  workflowRunLabel,
  workflowStepAria,
  workflowStepMeta,
  WorkflowStepsBody,
  workflowTickLabel,
} from "./ToolCallCard.js";
import type { TodoItemView } from "./ToolCallCard.js";
import type { SubagentSubStatus, ToolCallBlock, WorkflowSubStatus, WorkflowStepStatus } from "../store.js";

describe("formatSubagentCounters — running (final: null)", () => {
  it("pluralizes tool calls and includes lastTool when present", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "survey the repo",
      model: null,
      engine: null,
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
      model: null,
      engine: null,
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
      model: null,
      engine: null,
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
      model: null,
      engine: null,
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
      model: null,
      engine: null,
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
      model: null,
      engine: null,
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

describe("formatSubagentCounters — engine-aware (TASK.97 R5, wave2-cut §1.4)", () => {
  it("running, engine null (in-process): byte-identical to the pre-R5 format — no prefix, turn segment present", () => {
    const subagent: SubagentSubStatus = {
      agentType: "explore",
      description: "d",
      model: null,
      engine: null,
      turns: 3,
      toolCalls: 5,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("turn 3 · 5 tool calls");
  });

  it("running, engine claude: gains ONLY a 'claude · ' prefix ahead of the untouched turn/tool-call segment", () => {
    const subagent: SubagentSubStatus = {
      agentType: "claude-builder",
      description: "d",
      model: null,
      engine: "claude",
      turns: 3,
      toolCalls: 5,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("claude · turn 3 · 5 tool calls");
  });

  it("running, engine codex: 'codex · ' prefix and the turn segment is OMITTED entirely (not reported)", () => {
    const subagent: SubagentSubStatus = {
      agentType: "codex-builder",
      description: "d",
      model: null,
      engine: "codex",
      turns: 0,
      toolCalls: 5,
      lastTool: "Bash",
      activity: [],
      activityDropped: 0,
      final: null,
    };
    expect(formatSubagentCounters(subagent)).toBe("codex · 5 tool calls · Bash");
    expect(formatSubagentCounters(subagent)).not.toContain("turn");
  });

  it("settled, engine null (in-process) and engine claude: BOTH byte-identical to the pre-R5 format — no prefix, ever", () => {
    const inProcess: SubagentSubStatus = {
      agentType: "explore",
      description: "d",
      model: null,
      engine: null,
      turns: 4,
      toolCalls: 4,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: { status: "completed", durationMs: 4200 },
    };
    const claude: SubagentSubStatus = { ...inProcess, agentType: "claude-builder", engine: "claude" };
    expect(formatSubagentCounters(inProcess)).toBe("Completed · 4 turns · 4.2s");
    expect(formatSubagentCounters(claude)).toBe("Completed · 4 turns · 4.2s");
  });

  it("settled, engine codex: the 'N turns' segment is OMITTED, no engine prefix either", () => {
    const subagent: SubagentSubStatus = {
      agentType: "codex-builder",
      description: "d",
      model: null,
      engine: "codex",
      turns: 0,
      toolCalls: 4,
      lastTool: null,
      activity: [],
      activityDropped: 0,
      final: { status: "completed", durationMs: 4200 },
    };
    expect(formatSubagentCounters(subagent)).toBe("Completed · 4.2s");
    expect(formatSubagentCounters(subagent)).not.toContain("turn");
    expect(formatSubagentCounters(subagent)).not.toContain("codex");
  });
});

describe("subagentResponseModelNote (TASK.161 slice C1)", () => {
  it("no responseModel at all => null (absence must render as absence, never a fallback)", () => {
    expect(subagentResponseModelNote({ model: "glm-5.3", final: {} })).toBeNull();
    expect(subagentResponseModelNote({ model: "glm-5.3", final: null })).toBeNull();
  });

  it("requested model matches the provider's claim => mismatch: false (a match proves acceptance only, never styled as a confirmation)", () => {
    expect(subagentResponseModelNote({ model: "glm-5.3", final: { responseModel: "glm-5.3" } })).toEqual({
      text: "provider reported: glm-5.3",
      mismatch: false,
    });
  });

  it("requested model differs from the provider's claim => mismatch: true (the informative case)", () => {
    expect(subagentResponseModelNote({ model: "glm-5.3-flash", final: { responseModel: "glm-5.3" } })).toEqual({
      text: "provider reported: glm-5.3",
      mismatch: true,
    });
  });

  it("no requested model (inherited the parent's) but a claim is present => informational only, mismatch: false", () => {
    expect(subagentResponseModelNote({ model: null, final: { responseModel: "glm-5.3" } })).toEqual({
      text: "provider reported: glm-5.3",
      mismatch: false,
    });
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
      "max_turns",
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
    dependsOn: [],
    turns: 0,
    toolCalls: 0,
    lastTool: null,
    usage: null,
    // Defaults to the "actually running" phase (TASK.191 slice S3) so every
    // pre-existing fixture in this file — built only from `final`/turns/etc.
    // overrides — keeps exercising the same running ticker it always did;
    // the new pending/queued describe blocks below override these two.
    started: true,
    running: true,
    final: null,
    ...overrides,
  });

  it("reports the most-recently-started still-running step, pluralizing tool calls and including lastTool when present", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
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
      activity: [],
      activityDropped: 0,
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
      activity: [],
      activityDropped: 0,
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
    const workflow: WorkflowSubStatus = { workflow: "release-flow", activity: [], activityDropped: 0, totalSteps: 2, steps: [], final: null };
    expect(formatWorkflowCounters(workflow)).toBe("step 0/2");
  });

  // TASK.191 slice S3: `steps` is now PREFILLED with all totalSteps entries
  // the instant workflow_start lands, most of them not-yet-started. The
  // count MUST read the `started` flag, not `steps.length` — the naive
  // `steps.length` count would read "step 5/5" (every seeded step) at second
  // zero of a run that hasn't launched anything yet, which is the single
  // most visible number on the card's header.
  it("counts only STARTED steps against a fully-prefilled array, not the array's own length", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
      totalSteps: 5,
      steps: [
        step({ stepId: "a", final: { status: "completed", durationMs: 100 } }),
        step({ stepId: "b", turns: 3, toolCalls: 1, lastTool: "Bash" }),
        step({ stepId: "c", started: false, running: false }),
        step({ stepId: "d", started: false, running: false }),
        step({ stepId: "e", started: false, running: false }),
      ],
      final: null,
    };
    // 2 of 5 have started (a, b) — c/d/e are prefilled placeholders that
    // never launched. "b" is the in-flight one, so its ticker is reported.
    expect(formatWorkflowCounters(workflow)).toBe("step 2/5 · b · turn 3 · 1 tool call · Bash");
  });

  // A QUEUED step (started, not yet running — parked behind the shared
  // subagent semaphore, TASK.191 §B7) also has `final === null`. The
  // in-flight lookup must require `running`, not just `final === null`, or a
  // merely-queued step would print its own (meaningless, all-zero) ticker as
  // if it were the step actually executing.
  it("does not report a QUEUED step's ticker as the in-flight step — falls back to the bare aggregate", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
      totalSteps: 2,
      steps: [
        step({ stepId: "queued-one", started: true, running: false }),
        step({ stepId: "pending-one", started: false, running: false }),
      ],
      final: null,
    };
    expect(formatWorkflowCounters(workflow)).toBe("step 1/2");
  });
});

describe("formatWorkflowCounters — settled (final set)", () => {
  const base: WorkflowSubStatus = { workflow: "release-flow", activity: [], activityDropped: 0, totalSteps: 3, steps: [], final: null };

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
  dependsOn: [],
  turns: 0,
  toolCalls: 0,
  lastTool: null,
  usage: null,
  // Same "actually running" default rationale as the describe-local `step`
  // factory above (TASK.191 slice S3) — see its comment.
  started: true,
  running: true,
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
      activity: [],
      activityDropped: 0,
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
      activity: [],
      activityDropped: 0,
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
    const workflow: WorkflowSubStatus = { workflow: "release-flow", activity: [], activityDropped: 0, totalSteps: 2, steps: [], final: null };
    expect(workflowRunLabel(workflow)).toBe("step 0/2");
  });

  // TASK.191 slice S3: workflowRunLabel computes its own `started` count
  // while running (it does NOT delegate to formatWorkflowCounters until
  // final !== null) — this is the SAME defect surface as
  // formatWorkflowCounters's own pin above, in a second place.
  it("counts only STARTED steps against a fully-prefilled array, not the array's own length", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
      totalSteps: 5,
      steps: [
        mkStep({ stepId: "a", final: { status: "completed", durationMs: 100 } }),
        mkStep({ stepId: "b" }),
        mkStep({ stepId: "c", started: false, running: false }),
        mkStep({ stepId: "d", started: false, running: false }),
        mkStep({ stepId: "e", started: false, running: false }),
      ],
      final: null,
    };
    expect(workflowRunLabel(workflow)).toBe("step 2/5");
  });

  it("delegates to formatWorkflowCounters once settled (frozen export stays rendered)", () => {
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
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

// TASK.191 slice S3: workflow_start now prefills every step of the run, so
// "not started" is a real per-step phase (workflowStepKind) rather than the
// old lump pendingStepsLabel summary line that function replaced.
describe("workflowStepKind", () => {
  it("a prefilled step that never started is 'pending'", () => {
    expect(workflowStepKind(mkStep({ started: false, running: false }))).toBe("pending");
  });

  it("a step that started but hasn't cleared the semaphore yet is 'queued'", () => {
    expect(workflowStepKind(mkStep({ started: true, running: false }))).toBe("queued");
  });

  it("a step whose child is actually executing is 'running'", () => {
    expect(workflowStepKind(mkStep({ started: true, running: true }))).toBe("running");
  });

  it("a terminal status always wins, even over stale started/running flags", () => {
    expect(
      workflowStepKind(mkStep({ started: true, running: true, final: { status: "completed", durationMs: 5 } })),
    ).toBe("completed");
  });
});

describe("workflowStepMeta — not started / queued (TASK.191 slice S3)", () => {
  it("not started: bare word, no ticker", () => {
    expect(workflowStepMeta(mkStep({ started: false, running: false }))).toBe("Not started");
  });

  it("queued: bare word, distinct from both not-started and the running ticker", () => {
    expect(workflowStepMeta(mkStep({ started: true, running: false, turns: 0, toolCalls: 0 }))).toBe("Queued");
  });
});

describe("workflowStepAria — not started / queued (TASK.191 slice S3)", () => {
  it("not started: id · agentType · Not started (meta already leads with the label, no duplication)", () => {
    expect(workflowStepAria(mkStep({ started: false, running: false }))).toBe("build · explore · Not started");
  });

  it("queued: id · agentType · Queued", () => {
    expect(workflowStepAria(mkStep({ started: true, running: false }))).toBe("build · explore · Queued");
  });
});

describe("orderStepsByDependency (TASK.191 slice S3)", () => {
  it("leaves an already-topological array untouched", () => {
    const a = mkStep({ stepId: "A", dependsOn: [] });
    const b = mkStep({ stepId: "B", dependsOn: ["A"] });
    expect(orderStepsByDependency([a, b]).map((s) => s.stepId)).toEqual(["A", "B"]);
  });

  it("reorders a dependent declared BEFORE its own dependency", () => {
    // schema.ts allows this: dependsOn only requires the id to exist among the
    // definition's steps, never that it was declared earlier in the array.
    const b = mkStep({ stepId: "B", dependsOn: ["A"] });
    const a = mkStep({ stepId: "A", dependsOn: [] });
    expect(orderStepsByDependency([b, a]).map((s) => s.stepId)).toEqual(["A", "B"]);
  });

  it("keeps relative order among steps at the same dependency level", () => {
    const a = mkStep({ stepId: "A", dependsOn: [] });
    const b = mkStep({ stepId: "B", dependsOn: [] });
    const c = mkStep({ stepId: "C", dependsOn: ["A", "B"] });
    expect(orderStepsByDependency([c, b, a]).map((s) => s.stepId)).toEqual(["B", "A", "C"]);
  });

  it("treats a dependsOn id absent from steps as already-satisfied rather than hanging", () => {
    // Unreachable on a real definition (schema.ts rejects unknown refs at
    // discovery), but a defensive fixture must degrade, not loop forever.
    const a = mkStep({ stepId: "A", dependsOn: ["ghost"] });
    expect(orderStepsByDependency([a]).map((s) => s.stepId)).toEqual(["A"]);
  });

  it("preserves BOTH steps of a mutual dependency cycle rather than dropping one", () => {
    // Unreachable on a real definition (schema.ts's Kahn pass rejects a
    // dependsOn cycle at discovery — this file's own doc comment on
    // orderStepsByDependency notes the same). The `readyIndex === -1`
    // fallback below can't hang either way: `remaining` shrinks by exactly
    // one element every iteration regardless of which branch fires, so this
    // is a coverage gap on the fallback branch, not a live risk — but a
    // defensive fixture still must not silently lose a step.
    const a = mkStep({ stepId: "A", dependsOn: ["B"] });
    const b = mkStep({ stepId: "B", dependsOn: ["A"] });
    const result = orderStepsByDependency([a, b]);
    expect(result.map((s) => s.stepId).sort()).toEqual(["A", "B"]);
    // Deterministic: the same input yields the same order every time (no
    // requirement on WHICH order — just that it doesn't vary run to run).
    expect(orderStepsByDependency([a, b]).map((s) => s.stepId)).toEqual(result.map((s) => s.stepId));
  });
});

describe("layoutWorkflowMap (TASK.191 slice S6 — the run map)", () => {
  it("puts a step with no dependencies in the FIRST column and its dependent in the second", () => {
    const a = mkStep({ stepId: "A", dependsOn: [] });
    const b = mkStep({ stepId: "B", dependsOn: ["A"] });
    const { nodes } = layoutWorkflowMap([a, b]);
    const xs = new Map(nodes.map((n) => [n.stepId, n.x]));
    expect(xs.get("A")).toBeLessThan(xs.get("B") as number);
  });

  it("columns by dependency LEVEL, not by declaration order", () => {
    // The whole point of the map over the list: declaration order is scrambled
    // here exactly as graph-flow's real definition scrambles it.
    const omega = mkStep({ stepId: "omega", dependsOn: ["fan1", "fan2"] });
    const fan2 = mkStep({ stepId: "fan2", dependsOn: ["root"] });
    const root = mkStep({ stepId: "root", dependsOn: [] });
    const fan1 = mkStep({ stepId: "fan1", dependsOn: ["root"] });
    const { nodes } = layoutWorkflowMap([omega, fan2, root, fan1]);
    const x = new Map(nodes.map((n) => [n.stepId, n.x]));
    expect(x.get("root")).toBeLessThan(x.get("fan1") as number);
    expect(x.get("fan1")).toBe(x.get("fan2"));
    expect(x.get("fan2")).toBeLessThan(x.get("omega") as number);
  });

  it("stacks concurrent steps in ONE column at distinct y positions", () => {
    const root = mkStep({ stepId: "root", dependsOn: [] });
    const a = mkStep({ stepId: "a", dependsOn: ["root"] });
    const b = mkStep({ stepId: "b", dependsOn: ["root"] });
    const c = mkStep({ stepId: "c", dependsOn: ["root"] });
    const { nodes } = layoutWorkflowMap([root, a, b, c]);
    const fan = nodes.filter((n) => n.stepId !== "root");
    expect(new Set(fan.map((n) => n.x)).size).toBe(1);
    expect(new Set(fan.map((n) => n.y)).size).toBe(3);
  });

  it("centres a short column against the tallest one", () => {
    const root = mkStep({ stepId: "root", dependsOn: [] });
    const a = mkStep({ stepId: "a", dependsOn: ["root"] });
    const b = mkStep({ stepId: "b", dependsOn: ["root"] });
    const { nodes, height } = layoutWorkflowMap([root, a, b]);
    const rootNode = nodes.find((n) => n.stepId === "root");
    const fanYs = nodes.filter((n) => n.stepId !== "root").map((n) => n.y);
    const rootMid = (rootNode?.y ?? 0) + 28 / 2;
    const fanMid = (Math.min(...fanYs) + Math.max(...fanYs) + 28) / 2;
    expect(rootMid).toBeCloseTo(fanMid, 5);
    expect(rootMid).toBeCloseTo(height / 2, 5);
  });

  it("emits one edge per declared dependency, from the dependency to the dependent", () => {
    const root = mkStep({ stepId: "root", dependsOn: [] });
    const a = mkStep({ stepId: "a", dependsOn: ["root"] });
    const b = mkStep({ stepId: "b", dependsOn: ["root", "a"] });
    const { edges } = layoutWorkflowMap([root, a, b]);
    expect(edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a->b", "root->a", "root->b"]);
  });

  it("draws each edge from the dependency's RIGHT edge to the dependent's LEFT edge", () => {
    const a = mkStep({ stepId: "a", dependsOn: [] });
    const b = mkStep({ stepId: "b", dependsOn: ["a"] });
    const { nodes, edges, nodeWidth, nodeHeight } = layoutWorkflowMap([a, b]);
    const from = nodes.find((n) => n.stepId === "a");
    const to = nodes.find((n) => n.stepId === "b");
    const startX = (from?.x ?? 0) + nodeWidth;
    const startY = (from?.y ?? 0) + nodeHeight / 2;
    const endX = to?.x ?? 0;
    const endY = (to?.y ?? 0) + nodeHeight / 2;
    expect(edges[0]?.path.startsWith(`M ${startX} ${startY} C `)).toBe(true);
    expect(edges[0]?.path.endsWith(`${endX} ${endY}`)).toBe(true);
  });

  it("drops an edge whose dependency id is absent from the step list, keeping the node", () => {
    // schema.ts refuses unknown refs, so this is a malformed-fixture path: the
    // node must still be drawn (and clickable) rather than silently missing.
    const orphan = mkStep({ stepId: "orphan", dependsOn: ["nope"] });
    const { nodes, edges } = layoutWorkflowMap([orphan]);
    expect(nodes.map((n) => n.stepId)).toEqual(["orphan"]);
    expect(edges).toEqual([]);
  });

  it("TERMINATES on a dependency cycle instead of hanging, placing every node", () => {
    // Past schema.ts this is unreachable; the bounded relaxation exists so a
    // malformed fixture degrades rather than spinning the renderer forever.
    const a = mkStep({ stepId: "a", dependsOn: ["b"] });
    const b = mkStep({ stepId: "b", dependsOn: ["a"] });
    const { nodes } = layoutWorkflowMap([a, b]);
    expect(nodes.map((n) => n.stepId).sort()).toEqual(["a", "b"]);
  });

  it("carries each node's substatus kind, so the map and the list cannot disagree", () => {
    const running = mkStep({ stepId: "r", dependsOn: [], started: true, running: true, final: null });
    const done = mkStep({ stepId: "d", dependsOn: ["r"], final: { status: "completed", durationMs: 5 } });
    const notStarted = mkStep({ stepId: "n", dependsOn: ["r"], started: false, running: false, final: null });
    const { nodes } = layoutWorkflowMap([running, done, notStarted]);
    const kinds = new Map(nodes.map((n) => [n.stepId, n.kind]));
    expect(kinds.get("r")).toBe("running");
    expect(kinds.get("d")).toBe("completed");
    expect(kinds.get("n")).toBe("pending");
  });

  it("returns an empty layout for no steps rather than a zero-sized box", () => {
    expect(layoutWorkflowMap([])).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      nodeWidth: 132,
      nodeHeight: 28,
    });
  });

  it("is deterministic — the same steps lay out identically twice (a rehydrated card must match the live one)", () => {
    const steps = [
      mkStep({ stepId: "root", dependsOn: [] }),
      mkStep({ stepId: "fan", dependsOn: ["root"] }),
      mkStep({ stepId: "tail", dependsOn: ["fan"] }),
    ];
    expect(layoutWorkflowMap(steps)).toEqual(layoutWorkflowMap([...steps]));
  });
});

describe("workflowMapLabel", () => {
  it("leaves a short id intact", () => {
    expect(workflowMapLabel("step-root")).toBe("step-root");
  });

  it("clips a long id with an ellipsis at 16 characters", () => {
    expect(workflowMapLabel("step-a-very-long-identifier")).toBe("step-a-very-lon\u2026");
    expect(workflowMapLabel("step-a-very-long-identifier")).toHaveLength(16);
  });

  it("does not clip an id that is exactly at the limit", () => {
    const exact = "0123456789abcdef";
    expect(exact).toHaveLength(16);
    expect(workflowMapLabel(exact)).toBe(exact);
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
      "max_turns",
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
      "max_turns",
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
    model: null,
    engine: null,
    turns: 1,
    toolCalls: 2,
    lastTool: "Read",
    activity: [],
    activityDropped: 0,
    final: null,
    ...overrides,
  };
}

describe("workflowActivityRows (TASK.191 slice S1)", () => {
  const lane = (
    activity: { stepId: string; toolName: string; summary: string }[],
    activityDropped = 0,
  ): WorkflowSubStatus => ({
    workflow: "release-flow",
    totalSteps: 2,
    steps: [],
    activity,
    activityDropped,
    final: null,
  });

  it("prefixes every row with its step id — the lane is shared, so an unstamped row is unattributable", () => {
    const rows = workflowActivityRows(
      lane([
        { stepId: "fetch", toolName: "Bash", summary: "ls -la" },
        { stepId: "build", toolName: "Read", summary: "/a/b.ts" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ text: "fetch · Ran ls -la" });
    expect(rows[1]).toMatchObject({ text: "build · Read /a/b.ts" });
    expect(rows.some((row) => row.leading === true)).toBe(false);
  });

  it("prepends the same honest '+N earlier' leading row as the Agent feed when the ring has dropped rows", () => {
    const rows = workflowActivityRows(lane([{ stepId: "s1", toolName: "Grep", summary: "TODO" }], 12));
    expect(rows[0]).toEqual({ key: "dropped", text: "+12 earlier", leading: true });
    expect(rows[1]).toMatchObject({ text: "s1 · Grep TODO" });
  });

  it("falls back to the bare verb (still prefixed) when the summary is empty", () => {
    const rows = workflowActivityRows(lane([{ stepId: "s1", toolName: "Bash", summary: "" }]));
    expect(rows[0]).toMatchObject({ text: "s1 · Ran" });
  });

  it("returns an empty list for a run with no activity yet", () => {
    expect(workflowActivityRows(lane([]))).toEqual([]);
  });

  describe("selectedStepId filter (TASK.191 slice S4)", () => {
    it("keeps only the selected step's rows", () => {
      const rows = workflowActivityRows(
        lane([
          { stepId: "fetch", toolName: "Bash", summary: "ls -la" },
          { stepId: "build", toolName: "Read", summary: "/a/b.ts" },
          { stepId: "fetch", toolName: "Grep", summary: "TODO" },
        ]),
        "fetch",
      );
      expect(rows.map((row) => row.text)).toEqual(["fetch · Ran ls -la", "fetch · Grep TODO"]);
    });

    it("leaves the unfiltered lane untouched when no step is selected", () => {
      // Regression pin: adding the second parameter must not change the
      // default (undefined) or explicit-null call shape.
      const rows = workflowActivityRows(
        lane([{ stepId: "fetch", toolName: "Bash", summary: "ls -la" }], 3),
      );
      expect(rows[0]).toEqual({ key: "dropped", text: "+3 earlier", leading: true });
      const rowsNull = workflowActivityRows(
        lane([{ stepId: "fetch", toolName: "Bash", summary: "ls -la" }], 3),
        null,
      );
      expect(rowsNull[0]).toEqual({ key: "dropped", text: "+3 earlier", leading: true });
    });

    it("reworks the dropped-count row to say 'run-wide' rather than implying the count is this step's own (honesty guard 1)", () => {
      const rows = workflowActivityRows(
        lane([{ stepId: "fetch", toolName: "Bash", summary: "ls -la" }], 5),
        "fetch",
      );
      expect(rows[0]).toEqual({ key: "dropped-filtered", text: "+5 earlier (run-wide)", leading: true });
      // Must not read like the unfiltered "+N earlier" claim about THIS step.
      expect(rows[0]?.text).not.toBe("+5 earlier");
    });

    it("replaces a silently-empty filtered list with an explicit unknown note when rows were dropped (honesty guard 2)", () => {
      const rows = workflowActivityRows(
        lane([{ stepId: "build", toolName: "Bash", summary: "ls -la" }], 4),
        "fetch",
      );
      expect(rows).toEqual([
        {
          key: "dropped-unknown",
          text: "This step's earlier activity may be among the 4 row(s) dropped run-wide",
          leading: true,
        },
      ]);
    });

    it("stays honestly empty for a step that really made no calls (activityDropped === 0)", () => {
      const rows = workflowActivityRows(
        lane([{ stepId: "build", toolName: "Bash", summary: "ls -la" }], 0),
        "fetch",
      );
      expect(rows).toEqual([]);
    });
  });
});

describe("toggleWorkflowStepSelection (TASK.191 slice S4)", () => {
  it("selects an unselected step", () => {
    expect(toggleWorkflowStepSelection(null, "fetch")).toBe("fetch");
  });

  it("selects a different step outright, replacing the current one", () => {
    expect(toggleWorkflowStepSelection("fetch", "build")).toBe("build");
  });

  it("clears the selection when the already-selected step is clicked again", () => {
    expect(toggleWorkflowStepSelection("fetch", "fetch")).toBeNull();
  });
});

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
function renderAgentBody(
  block: ToolCallBlock,
  promptExpanded = false,
  child?: { badge: ChildBadgeKind; onOpen: (() => void) | undefined },
): string {
  const noop = () => {};
  return renderToStaticMarkup(createElement(AgentCardBody, { block, promptExpanded, onTogglePrompt: noop, child }));
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

  // TASK.161 slice C1: the provider-reported model pill mounts in the
  // expanded meta row, next to the requested-model pill, and gets the
  // mismatch styling only when the provider's claim differs from what was
  // requested. Copy must say "provider reported", never "served".
  it("mismatch: renders the response-model pill with the mismatch class and never the word 'served'", () => {
    const block = mkAgentBlock({
      status: "success",
      subagent: mkSubagent({
        model: "glm-5.3-flash",
        final: { status: "completed", durationMs: 500, responseModel: "glm-5.3" },
      }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("tool-call-subagent-response-model--mismatch");
    expect(html).toContain("provider reported: glm-5.3");
    expect(html.toLowerCase()).not.toContain("served");
  });

  it("match: renders the response-model pill WITHOUT the mismatch class (a match is not styled as a confirmation)", () => {
    const block = mkAgentBlock({
      status: "success",
      subagent: mkSubagent({
        model: "glm-5.3",
        final: { status: "completed", durationMs: 500, responseModel: "glm-5.3" },
      }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("tool-call-subagent-response-model");
    expect(html).not.toContain("tool-call-subagent-response-model--mismatch");
    expect(html).toContain("provider reported: glm-5.3");
  });

  it("no responseModel: the pill is absent entirely", () => {
    const block = mkAgentBlock({
      status: "success",
      subagent: mkSubagent({ model: "glm-5.3", final: { status: "completed", durationMs: 500 } }),
    });
    const html = renderAgentBody(block, false);
    expect(html).not.toContain("tool-call-subagent-response-model");
    expect(html).not.toContain("provider reported");
  });

  // TASK.44: max_turns is an incomplete outcome. The external card status is
  // "max_turns" (the dispatcher maps errorKind:"max_turns"), the internal
  // subagent.final.status is "max_turns", and the RESULT slot carries the limit
  // notice + partial — all three agree, no green "Success" badge.
  it("max_turns status shows the limit notice + partial in the RESULT slot (TASK.44)", () => {
    const block = mkAgentBlock({
      status: "max_turns",
      modelText:
        "Agent: the subagent reached its max turn limit (8 turns) without finishing. Partial result:\n\nFound 3 files.",
      subagent: mkSubagent({ final: { status: "max_turns", durationMs: 4200 } }),
    });
    const html = renderAgentBody(block, false);
    expect(html).toContain("tool-call-agent-result");
    expect(html).toContain("max turn limit");
    expect(html).toContain("8 turns");
    expect(html).toContain("Found 3 files.");
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

// ---------------------------------------------------------------------------
// TASK.44 — honest external badge. A max_turns Agent tool_call must show the
// "Max turns reached" badge (not "Success") and the warning status class, so
// the external badge, the internal substatus, and the model-visible text all
// agree in one terminal state.

describe("ToolCallCard (SSR) — max_turns external badge (TASK.44)", () => {
  it("renders the 'Max turns reached' badge and warning status class — never 'Success'", () => {
    const block = mkAgentBlock({
      status: "max_turns",
      modelText:
        "Agent: the subagent reached its max turn limit (8 turns) without finishing and produced no partial result.",
      subagent: mkSubagent({ final: { status: "max_turns", durationMs: 4200 }, turns: 8 }),
    });
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));
    // External badge is the warning-tinted "Max turns reached", NOT green Success.
    expect(html).toContain(">Max turns reached<");
    expect(html).not.toContain(">Success<");
    expect(html).toContain("tool-call-status-max_turns");
  });
});

// ---------------------------------------------------------------------------
// TASK.120 — the session-child badge as an ACTION. While a session-tier child
// is blocked on a permission ask, the "Waiting for permission" chip becomes a
// real <button> firing the same onOpen the Open button uses (both mounts), so
// the master can jump straight to the ask. isClickableChildBadge is the seam:
// kind + handler presence decide button-vs-span; the pure tests pin its truth
// table, the SSR renders pin the markup consequences — same jsdom-free
// rationale as the TASK.44 block above.

describe("isClickableChildBadge (TASK.120) — pure truth table", () => {
  const open = () => {};

  it("ONLY waiting_permission + a real onOpen handler is actionable", () => {
    expect(isClickableChildBadge("waiting_permission", open)).toBe(true);
  });

  it("waiting_permission WITHOUT onOpen stays a static chip (pre-TASK.120 render, byte-identical)", () => {
    expect(isClickableChildBadge("waiting_permission", undefined)).toBe(false);
  });

  it("the three outcome kinds are NEVER actionable, handler or not — their card already carries the Open button", () => {
    for (const badge of ["running", "error", "done"] as const) {
      expect(isClickableChildBadge(badge, open)).toBe(false);
      expect(isClickableChildBadge(badge, undefined)).toBe(false);
    }
  });
});

describe("AgentCardBody (SSR) — expanded child-row badge (TASK.120)", () => {
  it("waiting_permission + onOpen renders a <button> with the -action modifier, not a span", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent({ waiting: true }) });
    const html = renderAgentBody(block, false, { badge: "waiting_permission", onOpen: () => {} });
    expect(html).toContain(
      '<button type="button" class="tool-call-child-badge tool-call-child-badge-waiting_permission tool-call-child-badge-action"',
    );
    expect(html).toContain(">Waiting for permission</button>");
    // ...and the static span form is absent: exactly one badge node in the row.
    expect(html).not.toContain("<span class=\"tool-call-child-badge");
  });

  it("the three outcome kinds keep the static span even WITH an onOpen handler", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent() });
    for (const badge of ["running", "error", "done"] as const) {
      const html = renderAgentBody(block, false, { badge, onOpen: () => {} });
      expect(html).toContain(`<span class="tool-call-child-badge tool-call-child-badge-${badge}"`);
      expect(html).not.toContain("tool-call-child-badge-action");
    }
  });
});

describe("ToolCallCard (SSR) — header-row badge (TASK.120)", () => {
  // The header row is rendered via the exported ToolCallHeaderRow (same
  // rationale as AgentCardBody): the badge's childAction comes from
  // useChildSessionAction, which reads the tabs + child-relation zustand
  // stores — and zustand's server snapshot (what renderToStaticMarkup sees)
  // is frozen at the INITIAL state, so no seed can reach a static render.
  // The row takes the resolved childAction as a plain prop instead.

  it("every card (plain Bash included) wraps its toggle in the row wrapper — one child, layout unchanged", () => {
    const block: ToolCallBlock = {
      kind: "tool_call",
      id: "b1",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "npm test" },
      status: "error",
      modelText: "boom",
      snapshots: { before: null, after: null },
      subagent: null,
      workflow: null,
    };
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));
    expect(html).toContain('class="tool-call-toggle-row"');
    // The toggle itself is still the row's sole child, exactly one instance.
    expect(html.match(/class="tool-call-toggle"/g)).toHaveLength(1);
    // And no badge action leaked onto a card without a session child.
    expect(html).not.toContain("tool-call-child-badge");
  });

  it("waiting_permission renders the badge OUTSIDE the toggle, as a button on the row wrapper (no nested buttons)", () => {
    const block = mkAgentBlock({
      status: "running",
      subagent: mkSubagent({ waiting: true }),
    });
    const html = renderToStaticMarkup(
      createElement(ToolCallHeaderRow, {
        block,
        expanded: false,
        bodyId: "body-1",
        onToggleExpanded: () => {},
        childAction: { badge: "waiting_permission", onOpen: () => {} },
      }),
    );
    // The badge is the -action button riding the row wrapper...
    expect(html).toContain("tool-call-child-badge-action");
    expect(html).toContain(">Waiting for permission</button>");
    // ...positioned AFTER the toggle </button> closes (beside it, not nested).
    const toggleEnd = html.indexOf("</button>"); // the toggle's own close tag
    const badgeStart = html.indexOf("tool-call-child-badge-action");
    expect(badgeStart).toBeGreaterThan(toggleEnd);
    // The static in-toggle span form is absent — the badge appears once.
    expect(html).not.toContain("<span class=\"tool-call-child-badge");
  });

  it("the three outcome kinds keep the static span INSIDE the toggle even with an onOpen handler", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent() });
    for (const badge of ["running", "error", "done"] as const) {
      const html = renderToStaticMarkup(
        createElement(ToolCallHeaderRow, {
          block,
          expanded: false,
          bodyId: "body-1",
          onToggleExpanded: () => {},
          childAction: { badge, onOpen: () => {} },
        }),
      );
      // Static span inside the toggle, no -action layer, no second badge.
      expect(html).toContain(`<span class="tool-call-child-badge tool-call-child-badge-${badge}"`);
      expect(html).not.toContain("tool-call-child-badge-action");
    }
  });

  it("a waiting badge without onOpen stays a static span inside the toggle (pre-TASK.120 markup)", () => {
    const block = mkAgentBlock({ status: "running", subagent: mkSubagent({ waiting: true }) });
    const html = renderToStaticMarkup(
      createElement(ToolCallHeaderRow, {
        block,
        expanded: false,
        bodyId: "body-1",
        onToggleExpanded: () => {},
        childAction: { badge: "waiting_permission", onOpen: undefined },
      }),
    );
    expect(html).toContain('<span class="tool-call-child-badge tool-call-child-badge-waiting_permission"');
    expect(html).not.toContain("tool-call-child-badge-action");
  });
});

describe("previewablePathOf (TASK.112)", () => {
  it("returns the file_path of a document Read/Write/Edit touched", () => {
    for (const tool of ["Read", "Write", "Edit"]) {
      expect(previewablePathOf(tool, { file_path: "/repo/plan.md" })).toBe("/repo/plan.md");
    }
  });

  it("accepts every previewable document extension, `.markdown` included", () => {
    for (const path of ["/a/x.md", "/a/x.markdown", "/a/x.html", "/a/x.htm"]) {
      expect(previewablePathOf("Write", { file_path: path })).toBe(path);
    }
  });

  it("returns null for a non-document extension — the card falls back to plain text", () => {
    for (const path of ["/a/x.png", "/a/x.ts", "/a/Makefile", "/a/x.mdx"]) {
      expect(previewablePathOf("Write", { file_path: path })).toBeNull();
    }
  });

  it("returns null for every other tool, even one whose input happens to carry a file_path", () => {
    for (const tool of ["Bash", "Grep", "Agent", "TodoWrite", "Workflow"]) {
      expect(previewablePathOf(tool, { file_path: "/repo/plan.md" })).toBeNull();
    }
  });

  it("survives junk input rather than throwing — hydrated blocks may carry anything", () => {
    expect(previewablePathOf("Write", null)).toBeNull();
    expect(previewablePathOf("Write", undefined)).toBeNull();
    expect(previewablePathOf("Write", "not-an-object")).toBeNull();
    expect(previewablePathOf("Write", {})).toBeNull();
    expect(previewablePathOf("Write", { file_path: 42 })).toBeNull();
  });
});

describe("ToolCallCard (SSR) — open-in-preview control (TASK.112)", () => {
  // Same plain-prop rationale as the TASK.120 badge above: the action is
  // resolved by ToolCallCard from TabContext + the preload bridge, neither of
  // which a static render can see, so the row takes it as a prop.
  const docBlock: ToolCallBlock = {
    kind: "tool_call",
    id: "b1",
    toolCallId: "tc1",
    toolName: "Write",
    input: { file_path: "/repo/plan.md" },
    status: "success",
    modelText: "ok",
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
  };

  function renderRow(previewAction?: { path: string; open: () => void; error: string | null }): string {
    return renderToStaticMarkup(
      createElement(ToolCallHeaderRow, {
        block: docBlock,
        expanded: false,
        bodyId: "body-1",
        onToggleExpanded: () => {},
        previewAction,
      }),
    );
  }

  it("renders the Open control OUTSIDE the toggle button — nested buttons are invalid HTML", () => {
    const html = renderRow({ path: "/repo/plan.md", open: () => {}, error: null });
    expect(html).toContain('class="tool-call-open"');
    expect(html).toContain(">Open</button>");
    const toggleEnd = html.indexOf("</button>"); // the toggle's own close tag
    expect(html.indexOf('class="tool-call-open"')).toBeGreaterThan(toggleEnd);
  });

  it("titles the control with the real path, so the destination is honest before the click", () => {
    expect(renderRow({ path: "/repo/plan.md", open: () => {}, error: null })).toContain(
      'title="Open /repo/plan.md in the preview window"',
    );
  });

  it("renders nothing extra when there is no action — a card with no document is byte-identical to before", () => {
    const html = renderRow(undefined);
    expect(html).not.toContain("tool-call-open");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("reports main's refusal beside the control instead of through the card's status badge", () => {
    const html = renderRow({ path: "/repo/plan.md", open: () => {}, error: "outside the workspace" });
    expect(html).toContain('class="tool-call-open-error"');
    expect(html).toContain(">outside the workspace</span>");
  });

  it("shows no error span while nothing has failed", () => {
    expect(renderRow({ path: "/repo/plan.md", open: () => {}, error: null })).not.toContain("tool-call-open-error");
  });

  it("the control is absent from a bare ToolCallCard render — no TabContext, so no action to offer", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block: docBlock }));
    expect(html).toContain('class="tool-call-toggle-row"');
    expect(html).not.toContain("tool-call-open");
  });
});

describe("workflow token spend (TASK.191 slice S2)", () => {
  const wf = (steps: WorkflowStepStatus[]): WorkflowSubStatus => ({
    workflow: "release-flow",
    activity: [],
    activityDropped: 0,
    totalSteps: steps.length,
    steps,
    final: null,
  });

  it("sums the run's spend across steps, field by field", () => {
    const run = wf([
      mkStep({ stepId: "a", usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, totalTokens: 110 } }),
      mkStep({ stepId: "b", usage: { inputTokens: 300, cachedInputTokens: 60, outputTokens: 20, totalTokens: 320 } }),
    ]);
    expect(workflowRunUsage(run)).toEqual({
      inputTokens: 400,
      cachedInputTokens: 100,
      outputTokens: 30,
      totalTokens: 430,
    });
  });

  it("returns null when no step reported spend, and skips the steps that did not", () => {
    expect(workflowRunUsage(wf([mkStep({ stepId: "a" }), mkStep({ stepId: "b" })]))).toBeNull();
    // A mixed run reports what it has: one silent step must not blank the other.
    expect(
      workflowRunUsage(wf([mkStep({ stepId: "a" }), mkStep({ stepId: "b", usage: { inputTokens: 7 } })])),
    ).toEqual({ inputTokens: 7 });
  });

  it("renders the owner's shape with the cache share taken against INPUT, not the total", () => {
    // 40 of 100 input tokens were served from cache => 40%. Against the total
    // (140) the same hit would read 29% and understate every cache saving.
    expect(
      formatWorkflowUsage({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, totalTokens: 140 }),
    ).toBe("in 100 · cached 40 (40%) · out 10 · total 140");
  });

  it("omits a segment the provider never reported instead of printing a zero", () => {
    // Absent is not zero: a card that prints `cached 0` claims the provider
    // reported no cache hits, which is a different statement from silence.
    expect(formatWorkflowUsage({ inputTokens: 100, outputTokens: 10 })).toBe("in 100 · out 10");
    expect(formatWorkflowUsage(null)).toBeNull();
    expect(formatWorkflowUsage({})).toBeNull();
    // No input to divide by => the ratio is dropped, never rendered as 0% or NaN.
    expect(formatWorkflowUsage({ cachedInputTokens: 5 })).toBe("cached 5");
  });

  it("keeps the usage line off the card entirely when nothing was reported", () => {
    const workflowBlock = (workflow: WorkflowSubStatus): ToolCallBlock =>
      mkAgentBlock({ toolName: "Workflow", input: { name: "release-flow" }, workflow });

    const silent = renderToStaticMarkup(createElement(ToolCallCard, { block: workflowBlock(wf([mkStep({})])) }));
    expect(silent).not.toContain("tool-call-workflow-usage");

    const spent = renderToStaticMarkup(
      createElement(ToolCallCard, {
        block: workflowBlock(wf([mkStep({ usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, totalTokens: 140 } })])),
      }),
    );
    expect(spent).toContain("in 100 · cached 40 (40%) · out 10 · total 140");
  });
});

// TASK.191 slice S3: a full component-level render, not just the pure
// selectors above. Proves the CARD ITSELF calls orderStepsByDependency
// (rather than mapping `workflow.steps` in raw array order) and that the
// pending/queued phases get the right class + glyph in real markup, not just
// in the exported formatters' return values.
describe("workflow step ordering & phases (render, TASK.191 slice S3)", () => {
  /** Pulls each `<li class="workflow-step substatus-KIND">...</li>` row, in
   *  DOCUMENT order, as {kind, stepId, hasSvg, hasSpinClass}. Scoped to
   *  `workflow-step` specifically so the activity feed's own `<li>` rows
   *  (class "subagent-activity-row") never match. */
  function parseStepRows(html: string): { kind: string; stepId: string; hasSvg: boolean; hasSpinClass: boolean }[] {
    const rows: { kind: string; stepId: string; hasSvg: boolean; hasSpinClass: boolean }[] = [];
    const liRe = /<li class="workflow-step substatus-([a-z_]+)"[^>]*>(.*?)<\/li>/g;
    for (const li of html.matchAll(liRe)) {
      const [, kind, inner] = li;
      const idMatch = /workflow-step-id">([^<]+)</.exec(inner ?? "");
      rows.push({
        kind: kind ?? "",
        stepId: idMatch?.[1] ?? "",
        hasSvg: (inner ?? "").includes("<svg"),
        hasSpinClass: (inner ?? "").includes("icon-spin"),
      });
    }
    return rows;
  }

  it("orders rows by dependency level (not declaration order) and gives pending/queued the right class + glyph", () => {
    // Declared in a deliberately NON-topological order: every dependent is
    // listed before the dependency it needs — proves the card itself calls
    // orderStepsByDependency rather than mapping `workflow.steps` as-is.
    const steps: WorkflowStepStatus[] = [
      mkStep({ stepId: "beta", agentType: "explore", dependsOn: ["alpha"], started: false, running: false }),
      mkStep({ stepId: "delta", agentType: "explore", dependsOn: ["gamma"], started: false, running: false }),
      mkStep({ stepId: "gamma", agentType: "sonnet", dependsOn: [], started: true, running: false }),
      mkStep({ stepId: "alpha", agentType: "sonnet", dependsOn: [], started: true, running: true, turns: 2, toolCalls: 1, lastTool: "Read" }),
    ];
    const workflow: WorkflowSubStatus = {
      workflow: "release-flow",
      activity: [],
      activityDropped: 0,
      totalSteps: 4,
      steps,
      final: null,
    };
    const block: ToolCallBlock = mkAgentBlock({ toolName: "Workflow", input: { name: "release-flow" }, workflow });
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));

    const rows = parseStepRows(html);
    expect(rows.map((r) => r.stepId)).toEqual(["gamma", "delta", "alpha", "beta"]);

    const byId = new Map(rows.map((r) => [r.stepId, r]));
    // alpha: actually running — spinning glyph, "running" class.
    expect(byId.get("alpha")).toMatchObject({ kind: "running", hasSvg: true, hasSpinClass: true });
    // gamma: queued (started, not yet running) — a glyph, but NOT spinning.
    expect(byId.get("gamma")).toMatchObject({ kind: "queued", hasSvg: true, hasSpinClass: false });
    // beta/delta: never started — "pending" class, and NO glyph icon at all
    // (nothing has happened yet; StatusGlyph renders an empty cell for it).
    expect(byId.get("beta")).toMatchObject({ kind: "pending", hasSvg: false });
    expect(byId.get("delta")).toMatchObject({ kind: "pending", hasSvg: false });

    // The meta text backs up the class for the two new phases (workflowStepMeta).
    expect(html).toContain(">Queued<");
    expect(html).toContain(">Not started<");
  });
});

// TASK.191 slice S4 (owner ask: "а кликнуть в них нельзя будет? глянуть
// лог?"). `WorkflowStepsBody` is exported specifically so the "step
// selected" markup can be rendered honestly under SSR: `renderToStaticMarkup`
// can't simulate a click (no event system, and a real `WorkflowStatus` mount
// always starts its `useState` at null), but a controlled `selectedStepId`
// prop can be passed in already-selected. `WorkflowStatus` itself (the real
// mount site, owning the actual useState) is therefore NOT directly covered
// by an SSR "already selected" render — only `WorkflowStepsBody` is, plus
// `toggleWorkflowStepSelection` above covers the state-transition logic
// `WorkflowStatus`'s onClick wires to it. That combination is what's covered;
// simulating an actual DOM click on `WorkflowStatus` itself would need jsdom,
// which this package's vitest config does not have (file header note).
describe("workflow step buttons (render, TASK.191 slice S4)", () => {
  /** Pulls each step row's `<button class="workflow-step-button
   *  substatus-<kind>" ...>` kind + aria-pressed + aria-label, in document
   *  order — same fixed-attribute-order convention `parseStepRows` above
   *  already relies on (JSX declaration order: type, class, aria-pressed,
   *  aria-label). The class capture requires `substatus-<kind>` to ride on
   *  the button itself (not just the `<li>`) — see the coordinator-review
   *  pin below for why that duplication is load-bearing, not decorative. */
  function parseStepButtons(html: string): { kind: string; pressed: string; label: string }[] {
    const re =
      /<button type="button" class="workflow-step-button substatus-([a-z_]+)" aria-pressed="(true|false)" aria-label="([^"]*)"/g;
    return [...html.matchAll(re)].map((m) => ({ kind: m[1] ?? "", pressed: m[2] ?? "", label: m[3] ?? "" }));
  }

  const steps: WorkflowStepStatus[] = [
    mkStep({
      stepId: "fetch",
      agentType: "explore",
      dependsOn: [],
      started: true,
      running: true,
      turns: 1,
      toolCalls: 1,
      lastTool: "Read",
    }),
    mkStep({ stepId: "build", agentType: "sonnet", dependsOn: ["fetch"], started: false, running: false }),
  ];
  const workflow: WorkflowSubStatus = {
    workflow: "release-flow",
    totalSteps: 2,
    steps,
    activity: [{ stepId: "fetch", toolName: "Bash", summary: "ls -la" }],
    activityDropped: 0,
    final: null,
  };

  it("renders every step row as a real <button> carrying the aria-label, none pressed with nothing selected", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowStepsBody, { workflow, selectedStepId: null, onSelectStep: () => {} }),
    );
    const buttons = parseStepButtons(html);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.pressed === "false")).toBe(true);
    expect(buttons.map((b) => b.label)).toEqual([
      "fetch · explore · Running · turn 1 · 1 tool call · Read",
      "build · sonnet · Not started",
    ]);
    // The label rides on the button now; the <li> must not ALSO carry it
    // (would be a silent duplicate — an AT reading both would hear it twice).
    expect(html).not.toMatch(/<li[^>]*aria-label=/);
  });

  it("marks exactly the selected step's button aria-pressed, honestly rendered via the controlled prop", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowStepsBody, { workflow, selectedStepId: "fetch", onSelectStep: () => {} }),
    );
    const buttons = parseStepButtons(html);
    expect(buttons.find((b) => b.label.startsWith("fetch"))?.pressed).toBe("true");
    expect(buttons.find((b) => b.label.startsWith("build"))?.pressed).toBe("false");
    // The activity lane is filtered to the selected step's own rows too.
    expect(html).toContain("fetch · Ran ls -la");
  });

  it("filters the activity lane out of the render entirely when the selected step truly has no rows and none were dropped", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowStepsBody, { workflow, selectedStepId: "build", onSelectStep: () => {} }),
    );
    expect(html).not.toContain("workflow-activity-feed");
    expect(html).not.toContain("Ran ls -la");
  });

  it("keeps the glyph a DIRECT CHILD of an element carrying substatus-<kind> — app.css's whole status→color map (.substatus-KIND > .substatus-glyph) is a CHILD combinator, so wrapping the row in a <button> without repeating the class there silently detunes every glyph to its ghost default (coordinator-review regression pin)", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowStepsBody, { workflow, selectedStepId: null, onSelectStep: () => {} }),
    );
    // Structural check, not a string search for "substatus-running" anywhere
    // in the document: the opening tag immediately before each glyph span
    // must itself declare the matching class, i.e. the glyph's real DOM
    // parent — not merely some ancestor — carries it.
    const parents = [...html.matchAll(/<\w+([^>]*)>\s*<span class="substatus-glyph">/g)].map(
      (m) => /class="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "",
    );
    expect(parents).toHaveLength(2);
    expect(parents[0]).toContain("substatus-running"); // fetch: running
    expect(parents[1]).toContain("substatus-pending"); // build: not started
  });
});

// TASK.191 slice S7 — the plan's collapsed state (`task191/PLAN.md:184`):
// "Свёрнутое состояние — полоса засечек по числу шагов, карточка не растёт
// против сегодняшней". The three pins below are the ones that had to be
// proven red by mutation before this suite was allowed to pass: one tick per
// step in dependency order with the right kind; no strip at all while the
// card is expanded; and the state class riding on the SAME node as the
// painted element.
describe("collapsed tick strip (TASK.191 slice S7)", () => {
  const mkRun = (steps: WorkflowStepStatus[], overrides: Partial<WorkflowSubStatus> = {}): WorkflowSubStatus => ({
    workflow: "release-flow",
    totalSteps: steps.length,
    steps,
    activity: [],
    activityDropped: 0,
    final: null,
    ...overrides,
  });

  // Declared in a deliberately NON-topological order (every dependent before
  // its dependency), so a strip that mapped `workflow.steps` as-is renders a
  // different sequence than one that orders by dependency.
  const scrambled: WorkflowStepStatus[] = [
    mkStep({ stepId: "ship", dependsOn: ["pack"], started: false, running: false }),
    mkStep({ stepId: "pack", dependsOn: ["build"], started: true, running: false }),
    mkStep({ stepId: "build", dependsOn: [], started: true, running: false, final: { status: "completed", durationMs: 12 } }),
  ];

  /** Every tick's `substatus-<kind>`, in document order. The pattern requires
   *  both classes inside ONE class attribute — see the adjacency pin below. */
  function tickKinds(html: string): string[] {
    return [...html.matchAll(/<span class="workflow-tick substatus-([a-z_]+)"/g)].map((m) => m[1] ?? "");
  }

  function renderCollapsedHeader(workflow: WorkflowSubStatus, expanded = false): string {
    return renderToStaticMarkup(
      createElement(ToolCallHeaderRow, {
        block: mkAgentBlock({ toolName: "Workflow", input: { name: "release-flow" }, workflow }),
        expanded,
        bodyId: "body-1",
        onToggleExpanded: () => {},
      }),
    );
  }

  it("PIN 1 — draws one tick per step, in dependency order, each carrying that step's phase", () => {
    const html = renderCollapsedHeader(mkRun(scrambled));
    // build (completed) -> pack (started, not running => queued) -> ship
    // (never started => pending). Declaration order was the exact reverse.
    expect(tickKinds(html)).toEqual(["completed", "queued", "pending"]);
  });

  it("PIN 2 — renders nothing at all once the card is expanded (the checklist below is the record then)", () => {
    expect(renderCollapsedHeader(mkRun(scrambled), true)).not.toContain("workflow-tick");
    expect(renderCollapsedHeader(mkRun(scrambled), true)).not.toContain("workflow-ticks");
  });

  it("PIN 3 — the state class and the painted element are ONE node: the strip's children are flat leaf ticks, no wrapper level (app.css's status→colour map is a CHILD combinator, so an extra level detunes every tick silently)", () => {
    const html = renderCollapsedHeader(mkRun(scrambled));
    // An exact structural match, not a substring search: any wrapper inserted
    // around or inside a tick, and any split of the two classes across two
    // nodes, changes this string.
    expect(html).toContain(
      '<span class="workflow-ticks" role="img" aria-label="release-flow: 1 of 3 steps done">' +
        '<span class="workflow-tick substatus-completed"></span>' +
        '<span class="workflow-tick substatus-queued"></span>' +
        '<span class="workflow-tick substatus-pending"></span>' +
        "</span>",
    );
  });

  it("shows on the real card exactly where a reader meets it — a SETTLED run, which auto-collapses", () => {
    // "Collapsed" is not "running": defaultExpanded keeps a running Workflow
    // card open, so the strip's actual audience is the settled run scrolled
    // past in the transcript.
    const settled = mkRun(
      [
        mkStep({ stepId: "build", dependsOn: [], final: { status: "completed", durationMs: 10 } }),
        mkStep({ stepId: "ship", dependsOn: ["build"], final: { status: "error", durationMs: 4 } }),
      ],
      { final: { status: "failed", completedSteps: 1, durationMs: 14 } },
    );
    const block = mkAgentBlock({ toolName: "Workflow", input: { name: "release-flow" }, workflow: settled, status: "success" });
    expect(defaultExpanded("Workflow", "success")).toBe(false);
    const html = renderToStaticMarkup(createElement(ToolCallCard, { block }));
    expect(tickKinds(html)).toEqual(["completed", "error"]);

    // ...and vanishes on the running card, which is expanded by default.
    const running = mkAgentBlock({ toolName: "Workflow", input: { name: "release-flow" }, workflow: mkRun(scrambled), status: "running" });
    expect(renderToStaticMarkup(createElement(ToolCallCard, { block: running }))).not.toContain("workflow-tick");
  });

  it("draws steps.length ticks even when totalSteps disagrees, and says so in the label", () => {
    // After slice S3's prefill the two agree; if they ever diverge the strip
    // must describe what it actually knows rather than pad to a count it has
    // no steps for.
    const partial = mkRun([mkStep({ stepId: "build", dependsOn: [] })], { totalSteps: 5 });
    const html = renderCollapsedHeader(partial);
    expect(tickKinds(html)).toEqual(["running"]);
    expect(html).toContain('aria-label="release-flow: 0 of 1 steps done"');
  });

  it("speaks the counts the colours carry — failures and skips included, since a reader of the label cannot see either", () => {
    expect(workflowTickLabel(mkRun(scrambled))).toBe("release-flow: 1 of 3 steps done");
    expect(
      workflowTickLabel(
        mkRun([
          mkStep({ stepId: "a", final: { status: "completed", durationMs: 1 } }),
          mkStep({ stepId: "b", final: { status: "error", durationMs: 1 } }),
          mkStep({ stepId: "c", final: { status: "max_turns", durationMs: 1 } }),
          mkStep({ stepId: "d", final: { status: "skipped", durationMs: 0 } }),
          mkStep({ stepId: "e", started: false, running: false }),
        ]),
      ),
    ).toBe("release-flow: 1 of 5 steps done, 2 failed, 1 skipped");
    // A clean run says only the one thing worth saying.
    expect(
      workflowTickLabel(mkRun([mkStep({ stepId: "a", final: { status: "completed", durationMs: 1 } })])),
    ).toBe("release-flow: 1 of 1 steps done");
  });
});

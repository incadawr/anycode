/**
 * cli/render.ts theming unit tests (design slice-4.1-cut.md §3.2, §5.2 item 4):
 * colored snapshots of key events, the no-theme/no-color byte invariant (the
 * regression anchor main.test.ts's own renderEvent snapshots rely on), and the
 * "paint after padEnd" rule for the /mcp,/skills,/workflows tables.
 */

import { describe, expect, it } from "vitest";
import { createCliTheme } from "./theme.js";
import {
  CLI_COLLAPSE_HEAD_LINES,
  CLI_COLLAPSE_TAIL_LINES,
  CLI_COLLAPSE_THRESHOLD_LINES,
  CLI_INPUT_PREVIEW_MAX_CHARS,
  CLI_RESULT_MAX_LINE_CHARS,
  collapseLinesRaw,
  collapseOutput,
  formatContextBreakdown,
  formatContextInfo,
  formatResultForDisplay,
  renderEvent,
  renderMcpStatusTable,
  renderSkillsTable,
  renderTelemetryStatus,
  renderWorkflowsTable,
  type TranscriptOptions,
} from "./render.js";
import type { ContextBreakdown, ContextInfo } from "../loop/index.js";
import type { McpServerStatus } from "../ports/mcp.js";
import type { TelemetryStatus } from "../ports/telemetry.js";
import type { SkillMeta } from "../ports/skills.js";
import type { WorkflowMeta } from "../ports/workflow.js";
import type { AgentEvent } from "../types/events.js";
import type { ToolCallOutcome } from "../types/tools.js";

function collect(
  events: AgentEvent[],
  theme?: ReturnType<typeof createCliTheme>,
  transcript?: TranscriptOptions,
): string {
  let text = "";
  for (const event of events) {
    renderEvent(event, (chunk) => (text += chunk), theme, transcript);
  }
  return text;
}

const NOCOLOR = createCliTheme({ color: false });
const COLOR = createCliTheme({ color: true });

describe("renderEvent — no-color byte invariant (design §0.1/§9-R5)", () => {
  it("surfaces output and turn limits explicitly", () => {
    expect(collect([{ type: "turn_end", turn: 1, finishReason: "length" }])).toContain("output truncated");
    expect(collect([{ type: "loop_end", reason: "max_turns", turns: 100 }])).toContain("reached the turn limit (100 turns)");
  });

  const events: AgentEvent[] = [
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "Write", input: { file_path: "/a.ts" } },
    {
      type: "tool_result",
      outcome: {
        toolCallId: "call-1",
        toolName: "Write",
        status: "success",
        modelText: "wrote 3 lines",
        durationMs: 5,
      },
    },
    {
      type: "tool_result",
      outcome: {
        toolCallId: "call-2",
        toolName: "Bash",
        status: "denied",
        modelText: "denied by user",
        durationMs: 1,
      },
    },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    { type: "error", error: new Error("boom") },
    { type: "context_usage", estimatedTokens: 100, budgetTokens: 1000, source: "estimate" },
    { type: "subagent_start", toolCallId: "call-3", agentType: "explore", description: "map the auth module" },
  ];

  it("renders byte-identically whether theme is omitted entirely or passed with color=false", () => {
    const withoutTheme = collect(events);
    const withNoColorTheme = collect(events, NOCOLOR);
    expect(withoutTheme).toBe(withNoColorTheme);
  });

  it("matches today's exact plain-text shape (no SGR bytes anywhere)", () => {
    const text = collect(events);
    expect(text).toBe(
      '\n[tool] Write {"file_path":"/a.ts"}\n' +
        "[tool result] Write (success): wrote 3 lines\n" +
        "[tool result] Bash (denied): denied by user\n" +
        "\n[usage] in=10 out=20 total=30\n" +
        "\n[error] Error: boom\n" +
        "\n[context: ~100/1000 tokens (estimate)]\n" +
        "\n[subagent call-3] start: explore — map the auth module\n",
    );
    expect(text).not.toContain("\x1b[");
  });
});

describe("renderEvent — colored output (design §3.2 palette, §5.2 item 4)", () => {
  it("paints the tool name in [tool] lines with toolName, leaving the rest of the line untouched", () => {
    const text = collect(
      [{ type: "tool_execution_start", toolCallId: "call-1", toolName: "Write", input: { a: 1 } }],
      COLOR,
    );
    expect(text).toBe(`\n[tool] \x1b[36mWrite\x1b[0m {"a":1}\n`);
  });

  it("paints a successful tool result's status with toolResultOk (green)", () => {
    const text = collect(
      [
        {
          type: "tool_result",
          outcome: {
            toolCallId: "call-1",
            toolName: "Write",
            status: "success",
            modelText: "ok",
            durationMs: 1,
          },
        },
      ],
      COLOR,
    );
    expect(text).toBe("[tool result] Write \x1b[32m(success)\x1b[0m: ok\n");
  });

  it("paints a non-success tool result's status with toolResultError (red), for every non-success status", () => {
    for (const status of ["error", "invalid_input", "denied", "timed_out", "cancelled"] as const) {
      const text = collect(
        [
          {
            type: "tool_result",
            outcome: { toolCallId: "call-1", toolName: "Bash", status, modelText: "nope", durationMs: 1 },
          },
        ],
        COLOR,
      );
      expect(text).toBe(`[tool result] Bash \x1b[31m(${status})\x1b[0m: nope\n`);
    }
  });

  it("paints the whole [error] line with the error role (red+bold)", () => {
    const text = collect([{ type: "error", error: new Error("boom") }], COLOR);
    expect(text).toBe("\x1b[31;1m\n[error] Error: boom\n\x1b[0m");
  });

  it("appends a 'failed after N attempts' suffix when the error carries retry metadata (TASK.33 W7b)", () => {
    const text = collect([
      {
        type: "error",
        error: new Error("boom"),
        retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
      },
    ]);
    expect(text).toBe("\n[error] Error: boom (failed after 3 attempts)\n");
  });

  it("singularizes the suffix for a single attempt", () => {
    const text = collect([
      {
        type: "error",
        error: new Error("boom"),
        retry: { attemptsMade: 1, retryable: true, hadModelOutput: false, code: "network" },
      },
    ]);
    expect(text).toBe("\n[error] Error: boom (failed after 1 attempt)\n");
  });

  it("omits the suffix when retry metadata is present but no retry actually happened (attemptsMade: 0)", () => {
    const text = collect([
      {
        type: "error",
        error: new Error("boom"),
        retry: { attemptsMade: 0, retryable: false, hadModelOutput: false, code: "auth" },
      },
    ]);
    expect(text).toBe("\n[error] Error: boom\n");
  });

  it("paints the whole [usage] line (finish event) with the usage/dim role", () => {
    const text = collect(
      [{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
      COLOR,
    );
    expect(text).toBe("\x1b[2m\n[usage] in=1 out=2 total=3\n\x1b[0m");
  });

  it("paints the whole [context: ...] line with the usage/dim role", () => {
    const text = collect(
      [{ type: "context_usage", estimatedTokens: 5, budgetTokens: 50, source: "provider" }],
      COLOR,
    );
    expect(text).toBe("\x1b[2m\n[context: ~5/50 tokens (provider)]\n\x1b[0m");
  });

  it("paints subagent_* progress lines with the progress/dim role", () => {
    const text = collect(
      [
        { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "survey" },
        { type: "subagent_progress", toolCallId: "call-1", turns: 1, toolCalls: 1, lastTool: "Read" },
        { type: "subagent_end", toolCallId: "call-1", status: "completed", turns: 1, durationMs: 42 },
      ],
      COLOR,
    );
    expect(text).toBe(
      "\x1b[2m\n[subagent call-1] start: explore — survey\n\x1b[0m" +
        "\x1b[2m[subagent call-1] progress: turns=1 toolCalls=1 lastTool=Read\n\x1b[0m" +
        "\x1b[2m[subagent call-1] end (completed): turns=1 durationMs=42\n\x1b[0m",
    );
  });

  it("paints workflow_* progress lines with the progress/dim role", () => {
    const text = collect(
      [{ type: "workflow_start", toolCallId: "call-1", workflow: "release-notes", totalSteps: 1 }],
      COLOR,
    );
    expect(text).toBe("\x1b[2m\n[workflow call-1] start: release-notes (1 step(s))\n\x1b[0m");
  });

  it("leaves events with no assigned role (loop_end, stream_retry, microcompact, compaction_*) unpainted even when color=true", () => {
    const text = collect(
      [
        { type: "loop_end", reason: "completed", turns: 1 },
        { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 100, reason: "network" },
        { type: "microcompact", clearedToolResults: 2, savedTokens: 500 },
        { type: "compaction_start", trigger: "auto" },
      ],
      COLOR,
    );
    expect(text).not.toContain("\x1b[");
  });
});

describe("renderEvent — checkpoint events (design slice-4.7-cut.md §2.7)", () => {
  it("checkpoint_created — no color: id truncated to 8 chars, label verbatim", () => {
    const text = collect([
      { type: "checkpoint_created", id: "aaaaaaaa-bbbb-cccc-dddd-000000000000", label: "fix the bug" },
    ]);
    expect(text).toBe("[checkpoint] aaaaaaaa — fix the bug\n");
  });

  it("checkpoint_created — colored output wraps the whole line in the dim role", () => {
    const text = collect(
      [{ type: "checkpoint_created", id: "aaaaaaaa-bbbb-cccc-dddd-000000000000", label: "fix the bug" }],
      COLOR,
    );
    expect(text).toBe("\x1b[2m[checkpoint] aaaaaaaa — fix the bug\x1b[0m\n");
  });

  it("checkpoint_failed — no color: reason verbatim", () => {
    const text = collect([{ type: "checkpoint_failed", reason: "git not found" }]);
    expect(text).toBe("[checkpoint] disabled for this session: git not found\n");
  });

  it("checkpoint_failed — colored output wraps the whole line in the warn role", () => {
    const text = collect([{ type: "checkpoint_failed", reason: "git not found" }], COLOR);
    expect(text).toBe("\x1b[33m[checkpoint] disabled for this session: git not found\x1b[0m\n");
  });

  it("renders byte-identically whether theme is omitted entirely or passed with color=false", () => {
    const events: AgentEvent[] = [
      { type: "checkpoint_created", id: "abcdef1234567890", label: "add tests" },
      { type: "checkpoint_failed", reason: "boom" },
    ];
    expect(collect(events)).toBe(collect(events, NOCOLOR));
  });
});

describe("renderMcpStatusTable — theme threading + paint-after-padEnd (design §3.2/§9-R5)", () => {
  const statuses: McpServerStatus[] = [
    { name: "fixture", transport: "stdio", state: "connected", toolCount: 3, toolsTruncated: false },
    { name: "longer-name-server", transport: "http", state: "failed", toolCount: 0, toolsTruncated: false, error: "boom" },
  ];

  it("is byte-identical with no theme, and with a color=false theme", () => {
    const noTheme = renderMcpStatusTable(statuses);
    const noColor = renderMcpStatusTable(statuses, NOCOLOR);
    expect(noTheme).toBe(noColor);
  });

  it("with color=true, wraps ONLY the header row in dim, leaves body rows as-is, and preserves alignment", () => {
    const plain = renderMcpStatusTable(statuses);
    const colored = renderMcpStatusTable(statuses, COLOR);
    const [plainHeader, ...plainBody] = plain.split("\n");
    const [coloredHeader, ...coloredBody] = colored.split("\n");
    expect(coloredHeader).toBe(`\x1b[2m${plainHeader}\x1b[0m`);
    expect(coloredBody).toEqual(plainBody);
  });

  it("placeholder line (no servers) is unaffected by theme", () => {
    expect(renderMcpStatusTable([], COLOR)).toBe("[mcp] no servers configured\n");
  });
});

describe("renderSkillsTable — theme threading + paint-after-padEnd", () => {
  const metas: SkillMeta[] = [
    { name: "review", description: "Runs a code review", source: "project", path: "/ws/.anycode/skills/review/SKILL.md" },
  ];

  it("header dim, body untouched, no-theme byte-identical to color=false", () => {
    const plain = renderSkillsTable(metas);
    expect(renderSkillsTable(metas, NOCOLOR)).toBe(plain);
    const colored = renderSkillsTable(metas, COLOR);
    const [plainHeader, ...plainBody] = plain.split("\n");
    const [coloredHeader, ...coloredBody] = colored.split("\n");
    expect(coloredHeader).toBe(`\x1b[2m${plainHeader}\x1b[0m`);
    expect(coloredBody).toEqual(plainBody);
  });
});

describe("renderWorkflowsTable — theme threading + paint-after-padEnd", () => {
  const metas: WorkflowMeta[] = [{ name: "release-notes", description: "Draft release notes", stepCount: 2, source: "project" }];

  it("header dim, body untouched, no-theme byte-identical to color=false", () => {
    const plain = renderWorkflowsTable(metas);
    expect(renderWorkflowsTable(metas, NOCOLOR)).toBe(plain);
    const colored = renderWorkflowsTable(metas, COLOR);
    const [plainHeader, ...plainBody] = plain.split("\n");
    const [coloredHeader, ...coloredBody] = colored.split("\n");
    expect(coloredHeader).toBe(`\x1b[2m${plainHeader}\x1b[0m`);
    expect(coloredBody).toEqual(plainBody);
  });
});

describe("renderEvent — transcript.diffs Edit/Write blocks (design §3.1, §5.2 item 2)", () => {
  const editEvent: AgentEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "Edit",
    input: { file_path: "/a.ts", old_string: "old", new_string: "new" },
  };
  const writeEvent: AgentEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "Write",
    input: { file_path: "/a.ts", content: "hello" },
  };

  it("renders a diff block for a valid Edit input when transcript.diffs is on (no-color)", () => {
    const text = collect([editEvent], NOCOLOR, { diffs: true });
    expect(text).toBe("\n[tool] Edit /a.ts\n  - old\n  + new\n");
    expect(text).not.toContain("\x1b[");
  });

  it("renders a diff block for a valid Edit input when transcript.diffs is on (color)", () => {
    const text = collect([editEvent], COLOR, { diffs: true });
    expect(text).toBe("\n[tool] \x1b[36mEdit\x1b[0m /a.ts\n\x1b[31m  - old\x1b[0m\n\x1b[32m  + new\x1b[0m\n");
  });

  it("renders the (replace_all) suffix when the event's input carries replace_all: true", () => {
    const event: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Edit",
      input: { file_path: "/a.ts", old_string: "old", new_string: "new", replace_all: true },
    };
    const text = collect([event], NOCOLOR, { diffs: true });
    expect(text).toBe("\n[tool] Edit /a.ts (replace_all)\n  - old\n  + new\n");
  });

  it("renders a diff block for a valid Write input when transcript.diffs is on", () => {
    const text = collect([writeEvent], NOCOLOR, { diffs: true });
    expect(text).toBe("\n[tool] Write /a.ts\n  + hello\n");
  });

  it("falls back to the plain JSON line for an Edit input with a non-string old_string (design §9-R8)", () => {
    const malformed: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Edit",
      input: { file_path: "/a.ts", old_string: 5, new_string: "new" },
    };
    const text = collect([malformed], NOCOLOR, { diffs: true });
    expect(text).toBe(`\n[tool] Edit ${JSON.stringify(malformed.input)}\n`);
  });

  it("falls back to the plain JSON line for a non-object Edit input", () => {
    const malformed: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Edit",
      input: "not an object",
    };
    const text = collect([malformed], NOCOLOR, { diffs: true });
    expect(text).toBe(`\n[tool] Edit ${JSON.stringify(malformed.input)}\n`);
  });

  it("falls back to the plain JSON line for an empty-object Write input", () => {
    const malformed: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Write",
      input: {},
    };
    const text = collect([malformed], NOCOLOR, { diffs: true });
    expect(text).toBe(`\n[tool] Write ${JSON.stringify(malformed.input)}\n`);
  });

  it("renders the plain JSON line for a valid Edit input when transcript is absent (default path untouched)", () => {
    const text = collect([editEvent]);
    expect(text).toBe(`\n[tool] Edit ${JSON.stringify(editEvent.input)}\n`);
  });

  it("renders the plain JSON line for a valid Edit input when transcript.diffs is explicitly off", () => {
    const text = collect([editEvent], NOCOLOR, { diffs: false });
    expect(text).toBe(`\n[tool] Edit ${JSON.stringify(editEvent.input)}\n`);
  });
});

describe("renderEvent — ExitPlanMode name-only line (design slice-4.3-cut.md §3.5, §5.2 item 5)", () => {
  const planEvent: AgentEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    input: { plan: "1. Do X\n2. Do Y" },
  };

  it("renders a name-only line (no JSON dump of the plan) when transcript is present and the input duck-validates", () => {
    const text = collect([planEvent], NOCOLOR, {});
    expect(text).toBe("\n[tool] ExitPlanMode\n");
    expect(text).not.toContain("Do X");
  });

  it("paints the tool name the same way the generic JSON-preview branch does", () => {
    const text = collect([planEvent], COLOR, {});
    expect(text).toBe("\n[tool] \x1b[36mExitPlanMode\x1b[0m\n");
  });

  it("activates on transcript presence alone — no diffs/collapse/reasoning sub-flag is needed", () => {
    const text = collect([planEvent], NOCOLOR, { diffs: false, collapse: false, reasoning: false });
    expect(text).toBe("\n[tool] ExitPlanMode\n");
  });

  it("falls back to the plain JSON line when transcript is absent (default path untouched)", () => {
    const text = collect([planEvent]);
    expect(text).toBe(`\n[tool] ExitPlanMode ${JSON.stringify(planEvent.input)}\n`);
  });

  it("falls back to the plain JSON line for a malformed input (non-string plan), transcript present", () => {
    const malformed: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "ExitPlanMode",
      input: { plan: 5 },
    };
    const text = collect([malformed], NOCOLOR, {});
    expect(text).toBe(`\n[tool] ExitPlanMode ${JSON.stringify(malformed.input)}\n`);
  });

  it("falls back to the plain JSON line for a non-object input", () => {
    const malformed: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "ExitPlanMode",
      input: "not an object",
    };
    const text = collect([malformed], NOCOLOR, {});
    expect(text).toBe(`\n[tool] ExitPlanMode ${JSON.stringify(malformed.input)}\n`);
  });
});

describe("renderEvent — non-Edit/Write input preview capping (design §3.2, §5.2 item 2)", () => {
  it("leaves a short JSON input untouched even with collapse on", () => {
    const event: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "ls" },
    };
    const text = collect([event], NOCOLOR, { collapse: true });
    expect(text).toBe(`\n[tool] Bash ${JSON.stringify(event.input)}\n`);
  });

  it("caps a long JSON input preview at CLI_INPUT_PREVIEW_MAX_CHARS with an ellipsis, only when collapse is on", () => {
    const event: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "x".repeat(1000) },
    };
    const full = JSON.stringify(event.input);
    const withCollapse = collect([event], NOCOLOR, { collapse: true });
    expect(withCollapse).toBe(`\n[tool] Bash ${full.slice(0, CLI_INPUT_PREVIEW_MAX_CHARS)}…\n`);
    const withoutCollapse = collect([event], NOCOLOR);
    expect(withoutCollapse).toBe(`\n[tool] Bash ${full}\n`);
  });
});

describe("renderEvent — tool_result collapse (design §3.2, §5.2 item 2)", () => {
  it("leaves a short tool_result untouched even with collapse on (byte-identical to collapse off)", () => {
    const event: AgentEvent = {
      type: "tool_result",
      outcome: { toolCallId: "call-1", toolName: "Bash", status: "success", modelText: "ok", durationMs: 1 },
    };
    expect(collect([event], NOCOLOR, { collapse: true })).toBe("[tool result] Bash (success): ok\n");
    expect(collect([event], NOCOLOR, { collapse: true })).toBe(collect([event], NOCOLOR));
  });

  it("collapses a long tool_result's modelText tail, leaving the status prefix untouched", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `out-${i}`);
    const event: AgentEvent = {
      type: "tool_result",
      outcome: { toolCallId: "call-1", toolName: "Bash", status: "success", modelText: lines.join("\n"), durationMs: 1 },
    };
    const text = collect([event], NOCOLOR, { collapse: true });
    expect(text.startsWith("[tool result] Bash (success): out-0\n")).toBe(true);
    expect(text).toContain("  … (+15 more lines)"); // 30 - 10 head - 5 tail
    expect(text).toContain("out-29");
    const withoutCollapse = collect([event], NOCOLOR);
    expect(withoutCollapse).toBe(`[tool result] Bash (success): ${lines.join("\n")}\n`);
  });
});

describe("renderEvent — reasoning rendering (design §3.4, §5.2 item 4)", () => {
  const start: AgentEvent = { type: "reasoning_start", id: "r-1" };
  const delta: AgentEvent = { type: "reasoning_delta", id: "r-1", text: "thinking about it" };
  const end: AgentEvent = { type: "reasoning_end", id: "r-1" };

  it("renders header + text + trailing newline when transcript.reasoning is on (no-color)", () => {
    const text = collect([start, delta, end], NOCOLOR, { reasoning: true });
    expect(text).toBe("\n[reasoning]\nthinking about it\n");
    expect(text).not.toContain("\x1b[");
  });

  it("renders header + text + trailing newline when transcript.reasoning is on (color, dim role)", () => {
    const text = collect([start, delta, end], COLOR, { reasoning: true });
    expect(text).toBe("\x1b[2m\n[reasoning]\n\x1b[0m\x1b[2mthinking about it\x1b[0m\n");
  });

  it("renders nothing when transcript is absent", () => {
    expect(collect([start, delta, end])).toBe("");
  });

  it("renders nothing when transcript.reasoning is explicitly false", () => {
    expect(collect([start, delta, end], NOCOLOR, { reasoning: false })).toBe("");
  });

  it("renders nothing when transcript is present but reasoning is unset (diffs/collapse only)", () => {
    expect(collect([start, delta, end], NOCOLOR, { diffs: true, collapse: true })).toBe("");
  });
});

describe("collapseLinesRaw / collapseOutput (design §3.2, §5.2 item 3)", () => {
  it("invariant: CLI_COLLAPSE_THRESHOLD_LINES > HEAD + TAIL + 1 (collapse can only shorten)", () => {
    expect(CLI_COLLAPSE_THRESHOLD_LINES).toBeGreaterThan(CLI_COLLAPSE_HEAD_LINES + CLI_COLLAPSE_TAIL_LINES + 1);
  });

  it("exactly THRESHOLD lines are left untouched", () => {
    const lines = Array.from({ length: CLI_COLLAPSE_THRESHOLD_LINES }, (_, i) => `l${i}`);
    const text = lines.join("\n");
    expect(collapseOutput(text)).toBe(text);
    const { head, tail, hiddenCount } = collapseLinesRaw(lines);
    expect(head).toEqual(lines);
    expect(tail).toEqual([]);
    expect(hiddenCount).toBe(0);
  });

  it("THRESHOLD+1 lines collapse to HEAD + marker + TAIL with an exact hidden count", () => {
    const lines = Array.from({ length: CLI_COLLAPSE_THRESHOLD_LINES + 1 }, (_, i) => `l${i}`);
    const { head, tail, hiddenCount } = collapseLinesRaw(lines);
    expect(head).toEqual(lines.slice(0, CLI_COLLAPSE_HEAD_LINES));
    expect(tail).toEqual(lines.slice(lines.length - CLI_COLLAPSE_TAIL_LINES));
    expect(hiddenCount).toBe(lines.length - CLI_COLLAPSE_HEAD_LINES - CLI_COLLAPSE_TAIL_LINES);
    const text = collapseOutput(lines.join("\n"));
    expect(text).toBe(
      [...lines.slice(0, CLI_COLLAPSE_HEAD_LINES), `  … (+${hiddenCount} more lines)`, ...lines.slice(lines.length - CLI_COLLAPSE_TAIL_LINES)].join(
        "\n",
      ),
    );
  });

  it("per-line char cap truncates long lines with an ellipsis suffix", () => {
    const longLine = "x".repeat(CLI_RESULT_MAX_LINE_CHARS + 50);
    const { head } = collapseLinesRaw([longLine]);
    expect(head[0]).toBe(`${"x".repeat(CLI_RESULT_MAX_LINE_CHARS)}…`);
  });

  it("collapse never produces MORE lines than the original, across a range of sizes", () => {
    for (let n = 0; n <= 40; n++) {
      const lines = Array.from({ length: n }, (_, i) => `l${i}`);
      const result = collapseLinesRaw(lines);
      const resultLineCount = result.head.length + (result.hiddenCount > 0 ? 1 : 0) + result.tail.length;
      expect(resultLineCount).toBeLessThanOrEqual(Math.max(n, 1));
    }
  });

  it("collapseOutput on short text is byte-identical to the input (identity)", () => {
    const text = "line one\nline two\nline three";
    expect(collapseOutput(text)).toBe(text);
    expect(collapseOutput(text, COLOR)).toBe(text);
  });
});

describe("formatResultForDisplay — 4.2-R display-projection (design slice-4.5-cut.md §2.4, B4)", () => {
  function outcome(overrides: Partial<ToolCallOutcome> & { toolName: string }): ToolCallOutcome {
    return {
      toolCallId: "call-1",
      status: "success",
      modelText: "fallback-model-text",
      durationMs: 1,
      ...overrides,
    };
  }

  it("Bash: projects stdout only, stripping exactly one trailing newline", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 0,
            stdout: "hello\nworld\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 3,
          },
        },
      }),
    );
    expect(result).toBe("hello\nworld");
  });

  it("Bash: projects stdout + [stderr] + [exit N] sections, joined by a single newline each", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 2,
            stdout: "out-line\n",
            stderr: "err-line\n",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 3,
          },
        },
      }),
    );
    expect(result).toBe("out-line\n[stderr]\nerr-line\n[exit 2]");
  });

  it("Bash: omits the [exit N] section when exitCode is 0 or null", () => {
    const zero = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          },
        },
      }),
    );
    expect(zero).toBe("ok");
    const nullExit = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        result: {
          ok: true,
          output: {
            status: "timed_out",
            exitCode: null,
            stdout: "ok\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          },
        },
      }),
    );
    expect(nullExit).toBe("ok");
  });

  it("Bash: appends the verbatim dispatcher truncation marker per-section when *Truncated is set", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 0,
            stdout: "out\n",
            stderr: "err\n",
            stdoutTruncated: true,
            stderrTruncated: true,
            durationMs: 1,
          },
        },
      }),
    );
    expect(result).toBe("out\n… [truncated]\n[stderr]\nerr\n… [truncated]");
  });

  it("Bash: falls back to modelText when stdout, stderr are empty and exitCode is 0 (all sections empty)", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        modelText: '{"status":"ok","exitCode":0,"stdout":"","stderr":""}',
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          },
        },
      }),
    );
    expect(result).toBe('{"status":"ok","exitCode":0,"stdout":"","stderr":""}');
  });

  it("Read: projects content, stripping one trailing newline, no truncation marker when untruncated", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Read",
        result: { ok: true, output: { content: "line1\nline2\n", totalLines: 2, truncated: false } },
      }),
    );
    expect(result).toBe("line1\nline2");
  });

  it("Read: appends the parametrized truncation marker when truncated", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Read",
        result: { ok: true, output: { content: "line1\n", totalLines: 500, truncated: true } },
      }),
    );
    expect(result).toBe("line1\n… [truncated: 500 lines total]");
  });

  it("Grep content mode: projects `${path}:${lineNumber}: ${line}` per match", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Grep",
        result: {
          ok: true,
          output: {
            mode: "content",
            matches: [
              { path: "/a.ts", lineNumber: 3, line: "const x = 1;" },
              { path: "/b.ts", lineNumber: 10, line: "const y = 2;" },
            ],
            totalMatches: 2,
            truncated: false,
          },
        },
      }),
    );
    expect(result).toBe("/a.ts:3: const x = 1;\n/b.ts:10: const y = 2;");
  });

  it("Grep content mode: a match missing lineNumber/line projects to just the path", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Grep",
        result: {
          ok: true,
          output: { mode: "content", matches: [{ path: "/a.ts" }], totalMatches: 1, truncated: false },
        },
      }),
    );
    expect(result).toBe("/a.ts");
  });

  it("Grep files_with_matches mode: projects files.join(\"\\n\")", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Grep",
        result: {
          ok: true,
          output: { mode: "files_with_matches", files: ["/a.ts", "/b.ts"], totalMatches: 2, truncated: false },
        },
      }),
    );
    expect(result).toBe("/a.ts\n/b.ts");
  });

  it("Grep count mode: projects `${path}: ${n}` per entry, and appends the truncation marker", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Grep",
        result: {
          ok: true,
          output: { mode: "count", counts: { "/a.ts": 4, "/b.ts": 1 }, totalMatches: 5, truncated: true },
        },
      }),
    );
    expect(result).toBe("/a.ts: 4\n/b.ts: 1\n… [truncated: 5 matches total]");
  });

  it("Glob: projects files.join(\"\\n\") and appends the parametrized truncation marker when truncated", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Glob",
        result: { ok: true, output: { files: ["/a.ts", "/b.ts"], totalMatched: 2, truncated: true } },
      }),
    );
    expect(result).toBe("/a.ts\n/b.ts\n… [truncated: 2 matched total]");
  });

  it("Glob: no truncation marker when untruncated", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Glob",
        result: { ok: true, output: { files: ["/a.ts"], totalMatched: 1, truncated: false } },
      }),
    );
    expect(result).toBe("/a.ts");
  });

  it("fail-open: no `result` field at all → verbatim modelText", () => {
    const result = formatResultForDisplay(outcome({ toolName: "Bash", modelText: "raw model text" }));
    expect(result).toBe("raw model text");
  });

  it("fail-open: result.ok === false → verbatim modelText", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        modelText: "raw model text",
        result: { ok: false, error: "boom" },
      }),
    );
    expect(result).toBe("raw model text");
  });

  it("fail-open: denied status → verbatim modelText even if result/output happen to be present", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        status: "denied",
        modelText: "denied by user",
        result: {
          ok: true,
          output: {
            status: "ok",
            exitCode: 0,
            stdout: "should not be shown\nmulti\nline",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          },
        },
      }),
    );
    expect(result).toBe("denied by user");
  });

  it("fail-open: a foreign/non-projected toolName (incl. mcp__*) → verbatim modelText", () => {
    const bashShapeOutput = {
      status: "ok",
      exitCode: 0,
      stdout: "a\nb\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
    expect(
      formatResultForDisplay(
        outcome({ toolName: "WebFetch", modelText: "webfetch text", result: { ok: true, output: bashShapeOutput } }),
      ),
    ).toBe("webfetch text");
    expect(
      formatResultForDisplay(
        outcome({
          toolName: "mcp__example__tool",
          modelText: "mcp text",
          result: { ok: true, output: bashShapeOutput },
        }),
      ),
    ).toBe("mcp text");
  });

  it("fail-open: a malformed shape for the matched toolName → verbatim modelText", () => {
    const result = formatResultForDisplay(
      outcome({
        toolName: "Bash",
        modelText: "raw model text",
        result: { ok: true, output: { unexpected: "shape" } },
      }),
    );
    expect(result).toBe("raw model text");
  });

  it("existing tool_result fixtures without a `result` field stay green (design A27): fail-open path", () => {
    // Mirrors render.test.ts's no-`result` fixtures (e.g. lines ~46-66): these
    // predate 4.5 and must keep resolving through the same modelText path.
    expect(
      formatResultForDisplay({
        toolCallId: "call-1",
        toolName: "Write",
        status: "success",
        modelText: "wrote 3 lines",
        durationMs: 5,
      }),
    ).toBe("wrote 3 lines");
  });
});

describe("renderEvent — tool_result collapse now sees Bash/Read/Grep/Glob multi-line results (design slice-4.5-cut.md §2.4, 4.2-R fix)", () => {
  it("a multi-line Bash stdout (today a single JSON-escaped modelText line) now triggers the head/tail collapse marker", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `out-${i}`);
    const bashOutput = {
      status: "ok",
      exitCode: 0,
      stdout: lines.join("\n") + "\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 3,
    };
    const event: AgentEvent = {
      type: "tool_result",
      outcome: {
        toolCallId: "call-1",
        toolName: "Bash",
        status: "success",
        // This is exactly today's bug: dispatcher.formatModelText's default
        // path JSON.stringifies the whole output object into ONE line, so
        // the pre-4.5 collapseOutput(modelText) never saw multiple lines.
        modelText: JSON.stringify(bashOutput),
        durationMs: 3,
        result: { ok: true, output: bashOutput },
      },
    };
    const text = collect([event], NOCOLOR, { collapse: true });
    expect(text).toContain("  … (+15 more lines)"); // 30 - 10 head - 5 tail
    expect(text.startsWith("[tool result] Bash (success): out-0\n")).toBe(true);
    expect(text).toContain("out-29");
    expect(text).not.toContain(JSON.stringify(bashOutput));
  });

  it("the non-collapse path stays byte-identical to modelText even when result/output is present (transcript absent)", () => {
    const bashOutput = {
      status: "ok",
      exitCode: 0,
      stdout: "a\nb\nc\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
    const event: AgentEvent = {
      type: "tool_result",
      outcome: {
        toolCallId: "call-1",
        toolName: "Bash",
        status: "success",
        modelText: JSON.stringify(bashOutput),
        durationMs: 1,
        result: { ok: true, output: bashOutput },
      },
    };
    const withoutTranscript = collect([event]);
    expect(withoutTranscript).toBe(`[tool result] Bash (success): ${JSON.stringify(bashOutput)}\n`);
    const withTranscriptNoCollapse = collect([event], NOCOLOR, { diffs: true, reasoning: true });
    expect(withTranscriptNoCollapse).toBe(`[tool result] Bash (success): ${JSON.stringify(bashOutput)}\n`);
  });
});

describe("formatContextInfo (design slice-6.4-cut.md §2-C1)", () => {
  const HAPPY: ContextInfo = {
    estimatedTokens: 52_800,
    source: "provider",
    contextWindowTokens: 128_000,
    outputReserveTokens: 24_000,
    effectiveWindowTokens: 104_000,
    compactThresholdTokens: 91_000,
    breakerTripped: false,
  };

  it("renders the 3-line snapshot with tokens/window/reserve/threshold/source and a ready auto-compaction line", () => {
    const rendered = formatContextInfo(HAPPY);
    expect(rendered).toBe(
      "[context] ~52800/104000 tokens (51% of budget, source: provider)\n" +
        "[context] window 128000 — output reserve 24000 — auto-compact at 91000\n" +
        "[context] auto-compaction: ready\n",
    );
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  it("renders the disabled auto-compaction line when the circuit breaker has tripped", () => {
    const rendered = formatContextInfo({ ...HAPPY, breakerTripped: true });
    expect(rendered).toContain("[context] auto-compaction: disabled (circuit breaker tripped; /compact still works)");
    expect(rendered).not.toContain("auto-compaction: ready");
  });

  it("renders 0% (never divides by zero) when effectiveWindowTokens is 0", () => {
    const degenerate: ContextInfo = {
      estimatedTokens: 0,
      source: "estimate",
      contextWindowTokens: 0,
      outputReserveTokens: 0,
      effectiveWindowTokens: 0,
      compactThresholdTokens: 0,
      breakerTripped: false,
    };
    const rendered = formatContextInfo(degenerate);
    expect(rendered).toContain("~0/0 tokens (0% of budget, source: estimate)");
  });
});

describe("formatContextBreakdown (design slice-P7.17-cut.md §2.1)", () => {
  const FULL: ContextBreakdown = {
    messagesTokens: 6_000,
    systemToolsTokens: 2_000,
    mcpToolsTokens: 500,
    skillsTokens: 300,
    systemPromptTokens: 1_000,
    metaTokens: 200,
    totalEstimatedTokens: 10_000,
  };

  it("renders a header + one row per non-zero category with tokens/total percentages", () => {
    const rendered = formatContextBreakdown(FULL);
    expect(rendered).toBe(
      "[context] breakdown (estimated, total ~10000 tokens):\n" +
        "[context]   Messages: 6000 tokens (60%)\n" +
        "[context]   System tools: 2000 tokens (20%)\n" +
        "[context]   MCP tools: 500 tokens (5%)\n" +
        "[context]   Skills: 300 tokens (3%)\n" +
        "[context]   System prompt: 1000 tokens (10%)\n" +
        "[context]   Meta context: 200 tokens (2%)\n",
    );
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  it("omits categories with 0 tokens (workspace without skills/MCP) — mirrors the renderer popover's empty-section rule", () => {
    const noSkillsNoMcp: ContextBreakdown = {
      ...FULL,
      mcpToolsTokens: 0,
      skillsTokens: 0,
      totalEstimatedTokens: 9_200,
    };
    const rendered = formatContextBreakdown(noSkillsNoMcp);
    expect(rendered).not.toContain("MCP tools");
    expect(rendered).not.toContain("Skills:");
    expect(rendered).toContain("Messages: 6000 tokens");
    expect(rendered).toContain("Meta context: 200 tokens");
  });

  it("renders 0% (never NaN) for every category when totalEstimatedTokens is 0", () => {
    const empty: ContextBreakdown = {
      messagesTokens: 0,
      systemToolsTokens: 0,
      mcpToolsTokens: 0,
      skillsTokens: 0,
      systemPromptTokens: 0,
      metaTokens: 0,
      totalEstimatedTokens: 0,
    };
    const rendered = formatContextBreakdown(empty);
    expect(rendered).toBe(
      "[context] breakdown (estimated, total ~0 tokens):\n[context]   (no categories to report)\n",
    );
    expect(rendered).not.toContain("NaN");
  });
});

describe("renderTelemetryStatus (design slice-6.6-cut.md §2-C3)", () => {
  it("renders the disabled line, byte-exact, when status is null", () => {
    expect(renderTelemetryStatus(null)).toBe(
      "[telemetry] disabled (opt-in: set telemetry.enabled=true in .anycode/config.json)\n",
    );
  });

  it("renders the enabled filePath + written/dropped counts, ending in a single newline, no lastWriteError line", () => {
    const status: TelemetryStatus = { filePath: "/home/user/.anycode/telemetry/s1.jsonl", written: 12, dropped: 0 };
    const rendered = renderTelemetryStatus(status);
    expect(rendered).toBe(
      "[telemetry] enabled — /home/user/.anycode/telemetry/s1.jsonl\n" +
        "[telemetry] records written 12 — dropped 0\n",
    );
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  it("appends a last write error line ONLY when lastWriteError is present", () => {
    const status: TelemetryStatus = {
      filePath: "/tmp/tel/s2.jsonl",
      written: 5,
      dropped: 2,
      lastWriteError: "EACCES: permission denied",
    };
    const rendered = renderTelemetryStatus(status);
    expect(rendered).toBe(
      "[telemetry] enabled — /tmp/tel/s2.jsonl\n" +
        "[telemetry] records written 5 — dropped 2\n" +
        "[telemetry] last write error: EACCES: permission denied\n",
    );
  });
});

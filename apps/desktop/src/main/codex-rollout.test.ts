/**
 * Gold-projection tests for the rollout importer (cut §8/§13.2 row D,
 * AMENDMENT-1 §A5): every fixture in codex-rollout-fixtures/ (W0-R3's
 * scrubbed real rollouts + one synthetic tier-2 fixture) is run through
 * `importCodexRollout` and checked against the invariants the gate demands —
 * not against invented shapes (test-hazard #2, "green-by-mock").
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importCodexRollout, type RolloutImportReport } from "./codex-rollout.js";
import type { AssistantPart, ChatMessage, HistoryItem } from "@anycode/core";

const DEFAULT_OPTS = { maxItems: 5000, maxOutputChars: 8192 };

function loadFixture(name: string): string[] {
  const path = fileURLToPath(new URL(`./codex-rollout-fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

function importFixture(name: string, opts = DEFAULT_OPTS): RolloutImportReport {
  return importCodexRollout(loadFixture(name), opts);
}

function assistantParts(item: HistoryItem): AssistantPart[] {
  return item.message.role === "assistant" ? item.message.content : [];
}

/** Every `toolCallId` an assistant `tool_call` part carries, across all items. */
function toolCallIds(items: readonly HistoryItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.message.role !== "assistant") continue;
    for (const part of item.message.content) {
      if (part.type === "tool_call") ids.add(part.toolCallId);
    }
  }
  return ids;
}

/** Every `toolCallId` a `tool_result` part carries, across all items. */
function toolResultIds(items: readonly HistoryItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.message.role !== "tool") continue;
    for (const part of item.message.content) ids.add(part.toolCallId);
  }
  return ids;
}

/** Flattened text of every item, for cross-cutting "must never appear" assertions. */
function allText(items: readonly HistoryItem[]): string {
  return items
    .map((item) => {
      const message: ChatMessage = item.message;
      if (message.role === "user") return message.content;
      if (message.role === "assistant") return message.content.map((part) => (part.type === "text" ? part.text : JSON.stringify(part.input))).join("\n");
      return message.content.map((part) => part.text).join("\n");
    })
    .join("\n");
}

const ALL_FIXTURES = [
  "basic-chat-developer-reasoning.jsonl",
  "exec-pairs-and-apply-patch.jsonl",
  "exec-custom-tool-call-array-output.jsonl",
  "unpaired-call-and-web-search.jsonl",
  "input-image.jsonl",
  "reasoning-nonempty-summary.jsonl",
  "tool-search-and-batched-exec.jsonl",
  "agent-message-inter-agent.jsonl",
  "malformed-json-line.jsonl",
  "unknown-item-type.jsonl",
];

describe("importCodexRollout — gate invariants across every W0-R3 fixture", () => {
  it("the set of toolCallId in tool_call parts equals the set in tool_result parts, on every fixture", () => {
    for (const name of ALL_FIXTURES) {
      const report = importFixture(name);
      expect(new Set(toolCallIds(report.items)), name).toEqual(new Set(toolResultIds(report.items)));
    }
  });

  it("developer-message text never appears in any imported item, on every fixture", () => {
    for (const name of ALL_FIXTURES) {
      const report = importFixture(name);
      const text = allText(report.items);
      expect(text, name).not.toContain("<permissions instructions>");
      expect(text, name).not.toContain("<skills_instructions>");
      expect(text, name).not.toContain("You are `/root`");
    }
  });

  it("reasoning text (including the one non-empty summary in the corpus) never leaks into any item", () => {
    for (const name of ALL_FIXTURES) {
      const report = importFixture(name);
      expect(allText(report.items), name).not.toContain("encrypted_content");
      expect(allText(report.items), name).not.toContain("SCRUBBED-OPAQUE");
    }
    const report = importFixture("reasoning-nonempty-summary.jsonl");
    expect(allText(report.items)).not.toContain("Analyzing roll reveal logic");
  });

  it("a malformed JSON line never throws and is counted, not silently ignored", () => {
    for (const name of ALL_FIXTURES) {
      expect(() => importFixture(name)).not.toThrow();
    }
  });

  it("import is a pure function: identical input yields byte-identical output", () => {
    for (const name of ALL_FIXTURES) {
      const lines = loadFixture(name);
      expect(importCodexRollout(lines, DEFAULT_OPTS)).toEqual(importCodexRollout(lines, DEFAULT_OPTS));
    }
  });

  it("stats carries EXACTLY the 11 frozen fields of cut §3.7 + amendment A5 — no more, no fewer (C0 review F3)", () => {
    // Exact-key enumeration, not a subset check: a lane silently adding or
    // renaming a counter must fail here (Fable F3 disposition, iter-3).
    const FROZEN_STATS_KEYS = [
      "collapsedToText",
      "developerDropped",
      "imagesDropped",
      "malformedLines",
      "messages",
      "orphansSynthesized",
      "reasoningDropped",
      "toolPairs",
      "unknownItemsSkipped",
      "unknownPartsSkipped",
      "unknownRecordsSkipped",
    ];
    for (const name of ALL_FIXTURES) {
      const report = importFixture(name);
      expect(Object.keys(report.stats).sort(), name).toEqual(FROZEN_STATS_KEYS);
    }
  });
});

describe("importCodexRollout — basic-chat-developer-reasoning.jsonl (plain chat, no tools)", () => {
  it("drops the developer block and the (empty-summary) reasoning record, imports both user turns and the reply verbatim", () => {
    const report = importFixture("basic-chat-developer-reasoning.jsonl");
    expect(report.stats.developerDropped).toBe(1);
    expect(report.stats.reasoningDropped).toBe(1);
    expect(report.stats.malformedLines).toBe(0);
    expect(report.stats.unknownRecordsSkipped).toBe(0);
    expect(report.stats.unknownItemsSkipped).toBe(0);
    expect(report.items.map((item) => item.message.role)).toEqual(["user", "user", "assistant"]);
    const [envContext, sayMessage, reply] = report.items;
    expect(envContext !== undefined && envContext.message.role === "user" && envContext.message.content).toContain("environment_context");
    expect(sayMessage !== undefined && sayMessage.message.role === "user" && sayMessage.message.content).toBe('Say "Codex MCP is working" and nothing else.');
    expect(reply !== undefined && reply.message.role === "assistant" && reply.message.content).toEqual([{ type: "text", text: "Codex MCP is working" }]);
  });

  it("extracts session meta from session_meta + turn_context, never from a hardcoded default", () => {
    const report = importFixture("basic-chat-developer-reasoning.jsonl");
    expect(report.meta.cwd).toBe("/Users/scrubbed/projects/tools/ozon-mcp-extension");
    expect(report.meta.cliVersion).toBe("0.118.0");
    expect(report.meta.model).toBe("gpt-5.4");
    expect(report.meta.startedAt).toBe("2026-04-08T14:10:56.284Z");
  });
});

describe("importCodexRollout — exec-pairs-and-apply-patch.jsonl (1:1 Bash + collapse)", () => {
  it("maps exec_command 1:1 to Bash tool_call/tool_result pairs and collapses apply_patch to one text block", () => {
    const report = importFixture("exec-pairs-and-apply-patch.jsonl");
    expect(report.stats.toolPairs).toBe(3); // 2 exec_command + 1 apply_patch, all real pairs
    expect(report.stats.orphansSynthesized).toBe(0);
    expect(report.stats.collapsedToText).toBe(1);

    const bashCalls = report.items.flatMap((item) => assistantParts(item).filter((part) => part.type === "tool_call"));
    expect(bashCalls).toHaveLength(2);
    for (const call of bashCalls) {
      expect(call.type === "tool_call" && call.toolName).toBe("Bash");
      expect(call.type === "tool_call" && typeof (call.input as { command?: unknown }).command).toBe("string");
    }

    const collapseText = allText(report.items);
    expect(collapseText).toContain("⟦codex · apply_patch⟧");
    expect(collapseText).toContain("*** Begin Patch");
    expect(collapseText).toContain("→ ");
    expect(collapseText).toContain("Success. Updated the following files");
  });

  it("flushes one Bash tool_call assistant message, then one tool-role message with the matching tool_result", () => {
    const report = importFixture("exec-pairs-and-apply-patch.jsonl");
    const roles = report.items.map((item) => item.message.role);
    // first Bash call/result pair: assistant (text+tool_call), then tool
    const firstToolIndex = roles.indexOf("tool");
    expect(firstToolIndex).toBeGreaterThan(0);
    expect(roles[firstToolIndex - 1]).toBe("assistant");
  });
});

describe("importCodexRollout — exec-custom-tool-call-array-output.jsonl (raw-string exec + array output)", () => {
  it("maps custom_tool_call{name:exec} to Bash with the raw string as command, and joins array-form output", () => {
    const report = importFixture("exec-custom-tool-call-array-output.jsonl");
    expect(report.stats.toolPairs).toBe(1);
    expect(report.stats.orphansSynthesized).toBe(0);
    const call = report.items.flatMap((item) => assistantParts(item)).find((part) => part.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type === "tool_call") {
      expect(call.toolName).toBe("Bash");
      expect((call.input as { command: string }).command).toContain("apply_patch");
    }
    const result = report.items.flatMap((item) => (item.message.role === "tool" ? item.message.content : []))[0];
    expect(result?.text).toContain("Script completed"); // joined from the two-part array output
    expect(result?.text).toContain("{}");
  });
});

describe("importCodexRollout — unpaired-call-and-web-search.jsonl (real interrupted turn)", () => {
  it("collapses every web_search_call immediately and synthesizes an orphan marker for the one real unpaired MCP call", () => {
    const report = importFixture("unpaired-call-and-web-search.jsonl");
    expect(report.stats.orphansSynthesized).toBe(1);
    expect(toolCallIds(report.items).size).toBe(0); // no exec_command/exec in this fixture at all
    const text = allText(report.items);
    expect(text).toContain("⟦codex · web_search_call⟧");
    expect(text).toContain("⟦codex · mcp__ozon__search⟧");
    expect(text).toContain("[interrupted — no result was recorded]");
  });
});

describe("importCodexRollout — input-image.jsonl (image drop)", () => {
  it("drops the input_image part with a marker and never leaks the base64 payload", () => {
    const report = importFixture("input-image.jsonl");
    expect(report.stats.imagesDropped).toBe(1);
    const text = allText(report.items);
    expect(text).toContain("[image omitted on import]");
    expect(text).not.toContain("data:image/png;base64");
    expect(text).not.toContain("iVBOR"); // PNG base64 magic prefix
  });
});

describe("importCodexRollout — reasoning-nonempty-summary.jsonl (rare non-empty summary)", () => {
  it("still drops reasoning even when summary is non-empty, and pairs all four exec_command turns", () => {
    const report = importFixture("reasoning-nonempty-summary.jsonl");
    expect(report.stats.reasoningDropped).toBeGreaterThanOrEqual(4);
    expect(toolCallIds(report.items)).toEqual(toolResultIds(report.items));
    expect(report.stats.orphansSynthesized).toBe(0);
  });
});

describe("importCodexRollout — tool-search-and-batched-exec.jsonl (batched calls, one flush)", () => {
  it("batches consecutive exec_command tool_calls into one assistant message, flushed once by the first output", () => {
    const report = importFixture("tool-search-and-batched-exec.jsonl");
    expect(report.stats.orphansSynthesized).toBe(0);
    expect(toolCallIds(report.items)).toEqual(toolResultIds(report.items));
    expect(toolCallIds(report.items).size).toBe(7); // 3 + 4 batched exec_command calls

    const assistantMessages = report.items.filter((item) => item.message.role === "assistant");
    const withThreeCalls = assistantMessages.find((item) => assistantParts(item).filter((part) => part.type === "tool_call").length === 3);
    expect(withThreeCalls).toBeDefined();
    const withFourCalls = assistantMessages.find((item) => assistantParts(item).filter((part) => part.type === "tool_call").length === 4);
    expect(withFourCalls).toBeDefined();

    const toolMessages = report.items.filter((item) => item.message.role === "tool");
    const withThreeResults = toolMessages.find((item) => item.message.role === "tool" && item.message.content.length === 3);
    expect(withThreeResults).toBeDefined();

    const text = allText(report.items);
    expect(text).toContain("⟦codex · tool_search_call⟧");
  });
});

describe("importCodexRollout — agent-message-inter-agent.jsonl (tier-1 + tier-3 default-skip, real anomalies)", () => {
  it("skips the unknown top-level inter_agent_communication_metadata record and the unknown encrypted_content part", () => {
    const report = importFixture("agent-message-inter-agent.jsonl");
    expect(report.stats.unknownRecordsSkipped).toBe(1);
    expect(report.stats.unknownPartsSkipped).toBeGreaterThanOrEqual(1);
    expect(report.warnings.some((w) => w.includes("inter_agent_communication_metadata"))).toBe(true);
    expect(toolCallIds(report.items)).toEqual(toolResultIds(report.items));
  });

  it("renders the agent_message collapse with the author/recipient header, dropping the opaque part", () => {
    const report = importFixture("agent-message-inter-agent.jsonl");
    const text = allText(report.items);
    expect(text).toContain("⟦codex · agent_message /root→/root/terra_d1_recon⟧");
    expect(text).not.toContain("SCRUBBED-OPAQUE");
  });
});

describe("importCodexRollout — malformed-json-line.jsonl (deliberately injected)", () => {
  it("counts exactly one malformed line and still imports every other line normally", () => {
    const report = importFixture("malformed-json-line.jsonl");
    expect(report.stats.malformedLines).toBe(1);
    // same file as basic-chat-developer-reasoning.jsonl, minus the corrupted 2nd user message
    expect(report.items.map((item) => item.message.role)).toEqual(["user", "assistant"]);
    expect(report.stats.developerDropped).toBe(1);
    expect(report.stats.reasoningDropped).toBe(1);
  });
});

describe("importCodexRollout — unknown-item-type.jsonl (synthetic tier-2 default-skip)", () => {
  it("skips the unrecognized response_item.payload.type whole, without collapsing it to text", () => {
    const report = importFixture("unknown-item-type.jsonl");
    expect(report.stats.unknownItemsSkipped).toBe(1);
    expect(report.warnings.some((w) => w.includes("future_streaming_delta"))).toBe(true);
    const text = allText(report.items);
    expect(text).not.toContain("future_streaming_delta");
    expect(text).not.toContain("a future response_item shape");
    expect(report.items.map((item) => item.message.role)).toEqual(["user", "assistant"]);
  });
});

describe("importCodexRollout — resource caps", () => {
  it("caps tool_result text at maxOutputChars with a truncation marker", () => {
    const longOutput = "x".repeat(20000);
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp", cli_version: "0.144.5" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "echo hi" }) } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: longOutput } }),
    ];
    const report = importCodexRollout(lines, { maxItems: 5000, maxOutputChars: 100 });
    const toolItem = report.items.find((item) => item.message.role === "tool");
    expect(toolItem?.message.role === "tool" && toolItem.message.content[0]?.text.length).toBeLessThan(200);
    expect(toolItem?.message.role === "tool" && toolItem.message.content[0]?.text).toContain("truncated");
  });

  it("caps total items at maxItems, keeping the tail and prepending a truncation marker", () => {
    const lines: string[] = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp" } }),
    ];
    for (let i = 0; i < 20; i++) {
      lines.push(
        JSON.stringify({
          timestamp: `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}.000Z`,
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${i}` }] },
        }),
      );
    }
    const report = importCodexRollout(lines, { maxItems: 5, maxOutputChars: 8192 });
    expect(report.items).toHaveLength(6); // marker + last 5
    expect(report.items[0]?.message.role === "assistant" && report.items[0].message.content[0]?.type === "text" && report.items[0].message.content[0].text).toBe(
      "… earlier history truncated",
    );
    const lastItem = report.items[report.items.length - 1];
    expect(lastItem?.message.role === "user" && lastItem.message.content).toBe("turn 19");
  });
});

describe("importCodexRollout — batched tool results in call order, not arrival order (R1)", () => {
  it("two exec_command calls whose outputs arrive in REVERSE order still flush toolCallId c1 before c2", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "echo one" }) } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c2", arguments: JSON.stringify({ cmd: "echo two" }) } }),
      // outputs arrive out of call order: c2's output lands before c1's
      JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "two" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "one" } }),
    ];
    const report = importCodexRollout(lines, DEFAULT_OPTS);
    const toolItem = report.items.find((item) => item.message.role === "tool");
    expect(toolItem?.message.role === "tool" && toolItem.message.content[0]?.toolCallId).toBe("c1");
    expect(toolItem?.message.role === "tool" && toolItem.message.content[1]?.toolCallId).toBe("c2");
  });

  it("an early call left unpaired (c1) is ordered BEFORE a later call that did get its result (c2): [c1-orphan(cancelled), c2-success]", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "sleep 100" }) } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c2", arguments: JSON.stringify({ cmd: "echo two" }) } }),
      // only c2 gets a result; c1 is interrupted and only resolved at EOF (closeOutTurn)
      JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "two" } }),
    ];
    const report = importCodexRollout(lines, DEFAULT_OPTS);
    const toolItem = report.items.find((item) => item.message.role === "tool");
    expect(toolItem?.message.role === "tool" && toolItem.message.content.map((part) => [part.toolCallId, part.status])).toEqual([
      ["c1", "cancelled"],
      ["c2", "success"],
    ]);
  });
});

describe("importCodexRollout — custody: an untrusted 'role' value never reaches a warning string (R3)", () => {
  it("caps and generic-izes an unrecognized message role, never leaking the raw file content into warnings", () => {
    const garbage = `${"X".repeat(8000)}-secret-marker-should-not-leak`;
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "message", role: garbage, content: [] } }),
    ];
    const report = importCodexRollout(lines, DEFAULT_OPTS);
    expect(report.stats.unknownItemsSkipped).toBe(1);
    for (const warning of report.warnings) {
      expect(warning).not.toContain(garbage);
      expect(warning).not.toContain("secret-marker-should-not-leak");
      expect(warning.length).toBeLessThan(120);
    }
  });
});

describe("importCodexRollout — synthetic orphan handling (red-proof: an inverted 'srez, not synthesize' would fail this)", () => {
  it("an unpaired Bash call is closed with a synthetic cancelled tool_result, not silently dropped", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/tmp" } }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "orphan-1", arguments: JSON.stringify({ cmd: "sleep 100" }) },
      }),
    ];
    const report = importCodexRollout(lines, DEFAULT_OPTS);
    expect(report.stats.orphansSynthesized).toBe(1);
    expect(toolCallIds(report.items)).toEqual(new Set(["orphan-1"]));
    expect(toolResultIds(report.items)).toEqual(new Set(["orphan-1"]));
    const toolItem = report.items.find((item) => item.message.role === "tool");
    expect(toolItem?.message.role === "tool" && toolItem.message.content[0]?.status).toBe("cancelled");
  });
});

/**
 * The agent census: how many of the CLI's agents are working in the
 * background. Driven by the committed captures of a background agent (w0-19),
 * a foreground agent (w0-20) and three nested-agent runs (w0-21..w0-23).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeStreamMessage } from "./protocol.js";
import { countWorkingBackgroundAgents, EMPTY_AGENT_CENSUS, reduceAgentCensus, type AgentCensus } from "./agent-census.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

function frames(file: string): ClaudeStreamMessage[] {
  return readFileSync(join(FIXTURES_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeStreamMessage);
}

/** The count after each frame, consecutive duplicates collapsed. */
function replay(file: string): number[] {
  let census: AgentCensus = EMPTY_AGENT_CENSUS;
  const counts: number[] = [];
  for (const frame of frames(file)) {
    census = reduceAgentCensus(census, frame);
    const count = countWorkingBackgroundAgents(census);
    if (counts[counts.length - 1] !== count) counts.push(count);
  }
  return counts;
}

function system(subtype: string, fields: Record<string, unknown>): ClaudeStreamMessage {
  return { type: "system", subtype, ...fields } as ClaudeStreamMessage;
}

function started(taskId: string, fields: Record<string, unknown> = {}): ClaudeStreamMessage {
  return system("task_started", { task_id: taskId, task_type: "local_agent", ...fields });
}

function fold(...list: ClaudeStreamMessage[]): AgentCensus {
  return list.reduce(reduceAgentCensus, EMPTY_AGENT_CENSUS);
}

describe("agent census over real captures", () => {
  it("w0-19 (a background agent) reads 0,1,0", () => {
    expect(replay("w0-19-background-agent.jsonl")).toEqual([0, 1, 0]);
  });

  it("w0-20 (a foreground agent) stays 0", () => {
    expect(replay("w0-20-foreground-agent.jsonl")).toEqual([0]);
  });

  it("w0-21 (background parent, 2 foreground children) reads 0,1,2,1,0", () => {
    expect(replay("w0-21-nested-foreground-agents.jsonl")).toEqual([0, 1, 2, 1, 0]);
  });

  it("w0-22 (background parent, 2 background children) reads 0,1,2,3,2,1,0", () => {
    expect(replay("w0-22-nested-background-agents.jsonl")).toEqual([0, 1, 2, 3, 2, 1, 0]);
  });

  it("w0-23 (nested agent restarted, same task_id, new run_id) reads 0,1,2,1,0,1,0", () => {
    expect(replay("w0-23-agent-restarted-by-own-task.jsonl")).toEqual([0, 1, 2, 1, 0, 1, 0]);
  });

  it("w0-23 keeps counting the nested agent while it waits on its own background Bash", () => {
    const list = frames("w0-23-agent-restarted-by-own-task.jsonl");
    const counts: number[] = [];
    let census: AgentCensus = EMPTY_AGENT_CENSUS;
    for (const frame of list) {
      census = reduceAgentCensus(census, frame);
      counts.push(countWorkingBackgroundAgents(census));
    }
    const field = (frame: ClaudeStreamMessage, key: string): unknown => (frame as Record<string, unknown>)[key];
    const settles = (taskId: string) => list.findIndex((frame) =>
      field(frame, "subtype") === "task_updated" && field(frame, "task_id") === taskId && (field(frame, "patch") as { status?: string }).status === "completed");
    const agentSettle = settles("ac68cc72eaa3f0ca0");
    const bashEnd = settles("bdcsig06x");
    expect(agentSettle).toBeGreaterThan(0);
    expect(bashEnd).toBeGreaterThan(agentSettle);
    expect(counts.slice(agentSettle, bashEnd)).toEqual(Array(bashEnd - agentSettle).fill(1));
    expect(counts[bashEnd]).toBe(0);
  });
});

describe("agent census rules", () => {
  it("ignores non-agent tasks", () => {
    expect(countWorkingBackgroundAgents(fold(started("b1", { task_type: "local_bash", is_backgrounded: true })))).toBe(0);
    expect(countWorkingBackgroundAgents(fold(started("b2", { task_type: "local_bash", is_backgrounded: true, owned_by_subagent: "a1" })))).toBe(0);
  });

  it("ignores a terminal frame of an earlier run", () => {
    const census = fold(
      started("a", { run_id: "r1" }),
      started("a", { run_id: "r2" }),
      system("task_notification", { task_id: "a", run_id: "r1", status: "completed" }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(1);
  });

  it("ignores a task_updated terminal status of an earlier run", () => {
    const census = fold(
      started("a", { run_id: "r1" }),
      started("a", { run_id: "r2" }),
      system("task_updated", { task_id: "a", run_id: "r1", patch: { status: "completed" } }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(1);
  });

  it("a foreground child of a background parent stops counting when the parent settles, even without its own terminal frame", () => {
    const census = fold(started("p"), started("kid", { parent_task_id: "p", is_backgrounded: false }));
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    const settled = reduceAgentCensus(census, system("task_updated", { task_id: "p", patch: { status: "completed" } }));
    expect(countWorkingBackgroundAgents(settled)).toBe(0);
  });

  it("a run_id absent on either side matches", () => {
    const census = fold(started("a"), system("task_notification", { task_id: "a", run_id: "r1", status: "completed" }));
    expect(countWorkingBackgroundAgents(census)).toBe(0);
    const other = fold(started("b", { run_id: "r1" }), system("task_notification", { task_id: "b", status: "completed" }));
    expect(countWorkingBackgroundAgents(other)).toBe(0);
  });

  it("a foreground top-level agent moved to the background starts counting", () => {
    const foreground = fold(started("a", { is_backgrounded: false }));
    expect(countWorkingBackgroundAgents(foreground)).toBe(0);
    const moved = reduceAgentCensus(foreground, system("task_updated", { task_id: "a", patch: { is_backgrounded: true } }));
    expect(countWorkingBackgroundAgents(moved)).toBe(1);
  });

  it("a background child of a foreground agent counts", () => {
    const census = fold(started("root", { is_backgrounded: false }), started("kid", { parent_task_id: "root", is_backgrounded: true }));
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    const settled = reduceAgentCensus(census, system("task_updated", { task_id: "root", patch: { status: "completed" } }));
    expect(countWorkingBackgroundAgents(settled)).toBe(1);
  });

  it("settles on task_updated with a terminal status only", () => {
    const census = fold(started("a"));
    const running = reduceAgentCensus(census, system("task_updated", { task_id: "a", patch: { status: "running" } }));
    expect(running).toBe(census);
    for (const status of ["completed", "failed", "stopped", "killed"]) {
      const done = reduceAgentCensus(census, system("task_updated", { task_id: "a", patch: { status } }));
      expect(countWorkingBackgroundAgents(done)).toBe(0);
    }
  });

  it("background_tasks_changed settles a missing background entry", () => {
    const census = fold(started("bg"), started("fg", { is_backgrounded: false }));
    const changed = reduceAgentCensus(census, system("background_tasks_changed", { tasks: [] }));
    expect(changed.get("bg")?.running).toBe(false);
    expect(changed.get("fg")?.running).toBe(true);
    const unknown = reduceAgentCensus(census, system("background_tasks_changed", { tasks: [{ task_id: "bg" }, { task_id: "later" }] }));
    expect(unknown).toBe(census);
  });

  it("returns the same census for frames that change nothing", () => {
    const census = fold(started("a"), started("b", { parent_task_id: "a" }));
    const same: ClaudeStreamMessage[] = [
      system("task_progress", { task_id: "a" }),
      { type: "assistant", message: { role: "assistant", content: [] } } as unknown as ClaudeStreamMessage,
      system("background_tasks_changed", { tasks: [{ task_id: "a" }, { task_id: "b" }] }),
      system("task_notification", { task_id: "unknown", status: "completed" }),
      system("task_updated", { task_id: "a", patch: { is_backgrounded: true } }),
    ];
    for (const frame of same) expect(reduceAgentCensus(census, frame)).toBe(census);
  });

  it("never mutates its input", () => {
    const census = fold(started("a"), started("b", { parent_task_id: "a", is_backgrounded: false }));
    const before = JSON.stringify([...census]);
    reduceAgentCensus(census, system("task_notification", { task_id: "a", status: "completed" }));
    reduceAgentCensus(census, started("c"));
    reduceAgentCensus(census, system("background_tasks_changed", { tasks: [] }));
    reduceAgentCensus(census, system("task_updated", { task_id: "b", patch: { is_backgrounded: true } }));
    expect(JSON.stringify([...census])).toBe(before);
  });

  it("does not count a main-session background Bash", () => {
    expect(countWorkingBackgroundAgents(fold(started("b", { task_type: "local_bash", is_backgrounded: true })))).toBe(0);
    const census = fold(started("a"), system("task_notification", { task_id: "a", status: "completed" }), started("b", { task_type: "local_bash" }));
    expect(countWorkingBackgroundAgents(census)).toBe(0);
  });

  it("keeps counting a settled background agent while its own background Bash runs", () => {
    const census = fold(
      started("a", { run_id: "r1" }),
      started("b", { task_type: "local_bash", run_id: "rb", parent_task_id: "a", is_backgrounded: true, owned_by_subagent: true }),
      system("task_updated", { task_id: "a", run_id: "r1", patch: { status: "completed" } }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    for (const end of [
      system("task_updated", { task_id: "b", run_id: "rb", patch: { status: "completed" } }),
      system("task_notification", { task_id: "b", run_id: "rb", status: "failed" }),
      system("background_tasks_changed", { tasks: [] }),
    ]) {
      const ended = reduceAgentCensus(census, end);
      expect(countWorkingBackgroundAgents(ended)).toBe(0);
      expect(ended.has("b")).toBe(false);
    }
  });

  it("a foreground Bash does not keep its settled owner counted", () => {
    const census = fold(
      started("a"),
      started("b", { task_type: "local_bash", parent_task_id: "a", is_backgrounded: false }),
      system("task_notification", { task_id: "a", status: "completed" }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(0);
  });

  it("a foreground agent's background Bash is not counted", () => {
    const census = fold(started("a", { is_backgrounded: false }), started("b", { task_type: "local_bash", parent_task_id: "a" }));
    expect(countWorkingBackgroundAgents(census)).toBe(0);
    expect(countWorkingBackgroundAgents(reduceAgentCensus(census, system("task_notification", { task_id: "a", status: "completed" })))).toBe(0);
  });

  it("a Bash backgrounded by a patch keeps its settled background owner counted", () => {
    const census = fold(
      started("a"),
      started("b", { task_type: "local_bash", run_id: "rb", parent_task_id: "a", is_backgrounded: false }),
      system("task_updated", { task_id: "b", run_id: "rb", patch: { is_backgrounded: true } }),
      system("task_notification", { task_id: "a", status: "completed" }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    expect(countWorkingBackgroundAgents(reduceAgentCensus(census, system("task_notification", { task_id: "b", run_id: "rb", status: "completed" })))).toBe(0);
  });

  it("background_tasks_changed omitting the command releases the waiting agent", () => {
    const census = fold(
      started("a"),
      started("b", { task_type: "local_bash", parent_task_id: "a" }),
      system("task_notification", { task_id: "a", status: "completed" }),
    );
    expect(reduceAgentCensus(census, system("background_tasks_changed", { tasks: [{ task_id: "b" }] }))).toBe(census);
    expect(countWorkingBackgroundAgents(reduceAgentCensus(census, system("background_tasks_changed", { tasks: [{ task_id: "other" }] })))).toBe(0);
  });

  it("an agent restarted while waiting counts once", () => {
    const census = fold(
      started("a", { run_id: "r1" }),
      started("b", { task_type: "local_bash", parent_task_id: "a" }),
      system("task_notification", { task_id: "a", run_id: "r1", status: "completed" }),
      started("a", { run_id: "r2" }),
    );
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    expect(census.get("a")).toEqual({ kind: "agent", runId: "r2", backgrounded: true, running: true });
  });

  it("a running command of a background parent does not make it delegating", () => {
    const census = fold(started("a"), started("b", { task_type: "local_bash", parent_task_id: "a" }));
    expect(countWorkingBackgroundAgents(census)).toBe(1);
    const foreground = fold(started("a"), started("b", { task_type: "local_bash", parent_task_id: "a", is_backgrounded: false }));
    expect(countWorkingBackgroundAgents(foreground)).toBe(1);
  });

  it("ignores a monitor owned by an agent", () => {
    const census = fold(started("a"), started("m", { task_type: "monitor", parent_task_id: "a", owned_by_subagent: true }));
    expect(census.has("m")).toBe(false);
    expect(countWorkingBackgroundAgents(reduceAgentCensus(census, system("task_notification", { task_id: "a", status: "completed" })))).toBe(0);
  });

  it("ignores a command end frame of an earlier run", () => {
    const census = fold(
      started("a"),
      started("b", { task_type: "local_bash", run_id: "r2", parent_task_id: "a" }),
      system("task_notification", { task_id: "a", status: "completed" }),
    );
    expect(reduceAgentCensus(census, system("task_updated", { task_id: "b", run_id: "r1", patch: { status: "completed" } }))).toBe(census);
    expect(reduceAgentCensus(census, system("task_notification", { task_id: "b", run_id: "r1", status: "completed" }))).toBe(census);
    expect(countWorkingBackgroundAgents(census)).toBe(1);
  });

  it("the owner of a running command survives the 500 cap", () => {
    let census = fold(started("owner"), started("cmd", { task_type: "local_bash", parent_task_id: "owner" }), system("task_notification", { task_id: "owner", status: "completed" }));
    for (let i = 0; i < 600; i++) {
      census = reduceAgentCensus(census, started(`t${i}`));
      census = reduceAgentCensus(census, system("task_notification", { task_id: `t${i}`, status: "completed" }));
    }
    expect([...census.values()].filter((entry) => entry.kind === "agent" && !entry.running)).toHaveLength(500);
    expect(census.has("owner")).toBe(true);
    expect(census.has("cmd")).toBe(true);
    expect(countWorkingBackgroundAgents(census)).toBe(1);
  });

  it("keeps at most 500 settled entries, never evicting an ancestor of a running entry", () => {
    let census = fold(started("root"), started("kid", { parent_task_id: "root" }), system("task_notification", { task_id: "root", status: "completed" }));
    for (let i = 0; i < 600; i++) {
      census = reduceAgentCensus(census, started(`t${i}`));
      census = reduceAgentCensus(census, system("task_notification", { task_id: `t${i}`, status: "completed" }));
    }
    expect([...census.values()].filter((entry) => !entry.running)).toHaveLength(500);
    expect(census.has("root")).toBe(true);
    expect(census.get("kid")?.running).toBe(true);
    expect(census.has("t0")).toBe(false);
    expect(census.has("t599")).toBe(true);
    expect(countWorkingBackgroundAgents(census)).toBe(1);
  });
});

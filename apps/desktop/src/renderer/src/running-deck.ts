import type { BackgroundTaskSnapshot } from "@anycode/core";
import type { WireBackgroundChild } from "../../shared/protocol.js";
import { backgroundTaskKindLabel, visibleBackgroundTasks, type ClaudeBackgroundTask } from "./claude-background-tasks.js";

/** The fields of core's own background task (Bash `run_in_background`) the deck reads. */
export type CoreDeckTask = Pick<BackgroundTaskSnapshot, "taskId" | "command" | "description" | "status" | "startedAt">;

/**
 * The task lists that count on a tab: the Claude CLI's own list on a Claude tab, core's task list on a core tab (the engine DeepSeek
 * and other providers run on). A core store has no engine block, so a missing engine means core, the same reading `store.ts` uses
 * elsewhere. A list left behind by an engine the tab switched away from (a live switch does not reset the lists) must not keep rows
 * alive. The empty list is one shared constant: a selector that returned a fresh `[]` each call would never be shallow-equal and
 * would re-render forever.
 */
const NONE: readonly never[] = [];

export function tasksForEngine<C, K>(engineId: string | undefined, claude: readonly C[], core: readonly K[]): { claude: readonly C[]; core: readonly K[] } {
  return {
    claude: engineId === "claude" ? claude : NONE,
    core: (engineId ?? "core") === "core" ? core : NONE,
  };
}

/** One running background task or agent in the deck. `waiting` is reserved for stage 2. */
export interface DeckRow {
  readonly key: string;
  readonly kind: "task" | "child";
  readonly toolCallId: string | undefined;
  readonly title: string;
  readonly typeLabel: string;
  readonly startedAt: number;
  readonly waiting: false;
  readonly detail: string | undefined;
}

/** Where a row's transcript card sits; `distance` = card bottom minus the deck's collapsed bottom: negative above, and the LEAST negative is the nearest the viewport top. */
export interface AnchorState {
  readonly hasCard: boolean;
  readonly live: boolean;
  readonly above: boolean;
  readonly distance: number;
}

/** Same rule as `isFailedBackgroundChild` (components/BackgroundAgents.tsx); replicated to keep this module free of component imports. */
const isFailedChild = (child: Pick<WireBackgroundChild, "endedAt" | "failureReason">): boolean =>
  child.endedAt !== undefined || child.failureReason !== undefined;

function childDetail(child: Pick<WireBackgroundChild, "turns" | "toolCalls">): string | undefined {
  const parts = [
    ...(child.turns === undefined ? [] : [`turn ${child.turns}`]),
    ...(child.toolCalls === undefined ? [] : [child.toolCalls === 1 ? "1 tool" : `${child.toolCalls} tools`]),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export function deckRowsFrom(
  tasks: readonly ClaudeBackgroundTask[],
  children: readonly WireBackgroundChild[],
  descriptionFor?: (task: ClaudeBackgroundTask) => string | undefined,
  coreTasks: readonly CoreDeckTask[] = [],
): readonly DeckRow[] {
  const taskRows = visibleBackgroundTasks(tasks)
    .filter(task => task.status === "running")
    .map((task): DeckRow => ({
      key: `task:${task.taskId}`,
      kind: "task",
      toolCallId: task.toolCallId,
      title: descriptionFor?.(task) || task.description || "Background task",
      typeLabel: backgroundTaskKindLabel(task),
      startedAt: task.startedAt,
      waiting: false,
      detail: task.summary || undefined,
    }));
  // Core's snapshots carry no tool call id, so these rows have no card to jump to: they stay listed while the command runs.
  const coreRows = coreTasks
    .filter(task => task.status === "running")
    .map((task): DeckRow => ({
      key: `core:${task.taskId}`,
      kind: "task",
      toolCallId: undefined,
      title: task.description || task.command || "Background task",
      typeLabel: "Bash",
      startedAt: task.startedAt,
      waiting: false,
      detail: task.description && task.command ? task.command : undefined,
    }));
  const childRows = children
    .filter(child => !isFailedChild(child))
    .map((child): DeckRow => ({
      key: `child:${child.childSessionId}`,
      kind: "child",
      toolCallId: child.spawnToolCallId,
      title: child.description || "Background task",
      typeLabel: child.agentType,
      startedAt: child.startedAt,
      waiting: false,
      detail: childDetail(child),
    }));
  return [...taskRows, ...coreRows, ...childRows];
}

const cardless = (row: DeckRow, anchor: AnchorState | undefined): boolean =>
  row.toolCallId === undefined || anchor === undefined || !anchor.hasCard || !anchor.live;

export function visibleDeckRows(rows: readonly DeckRow[], anchors: ReadonlyMap<string, AnchorState>): readonly DeckRow[] {
  const anchorOf = (row: DeckRow) => (row.toolCallId === undefined ? undefined : anchors.get(row.key));
  const listed = rows.filter(row => cardless(row, anchorOf(row)));
  const above = rows.filter(row => !cardless(row, anchorOf(row)) && anchorOf(row)?.above === true);
  return [
    ...[...listed].sort((a, b) => b.startedAt - a.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    ...[...above].sort((a, b) => (anchorOf(b)?.distance ?? 0) - (anchorOf(a)?.distance ?? 0)),
  ];
}

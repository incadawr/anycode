/**
 * Perpetual todo progress panel (design/slice-P7.11-cut.md F1b): a sticky
 * card overlaid top-right of the transcript, anchored independently from the
 * "Git tools/Progress" reference. No new store state — the model's plan
 * lives entirely in the transcript's TodoWrite tool_call blocks already
 * (§1); this module just projects it.
 */
import { useMemo, useState } from "react";
import type { TranscriptBlock } from "../store.js";
import { Chevron, Check } from "./icons.js";
import { parseTodos, type TodoItemView } from "./ToolCallCard.js";

export interface CurrentTodos {
  todos: TodoItemView[];
  /** `id` of the source tool_call block — matches the `data-block-id` MessageList stamps on the card. */
  sourceBlockId: string;
}

/**
 * Last completed (`status === "success"`), well-formed TodoWrite call in the
 * transcript — replace-all semantics, so "last wins" exactly mirrors the
 * model's own view of the plan (§1). Walking backward and skipping anything
 * that isn't a settled, valid TodoWrite is what makes this fail-soft: a
 * later malformed/failed/still-running TodoWrite doesn't blank the panel,
 * it just falls through to the previous valid one. `todos: []` is a
 * distinct, valid empty replace-all (parseTodos' contract) and is returned
 * as-is; the caller decides whether an empty list hides the panel.
 */
export function selectCurrentTodos(transcript: TranscriptBlock[]): CurrentTodos | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const block = transcript[i]!;
    if (block.kind !== "tool_call" || block.toolName !== "TodoWrite" || block.status !== "success") {
      continue;
    }
    const todos = parseTodos(block.input);
    if (todos === null) {
      continue;
    }
    return { todos, sourceBlockId: block.id };
  }
  return null;
}

/**
 * Whether a freshly selected TodoWrite source block should reset the
 * completed-group disclosure back to its default (collapsed). A new
 * successful TodoWrite is a fresh plan, not a continuation of whatever the
 * user chose to expand for the previous one — but `null` (nothing selected,
 * e.g. an empty transcript) is not itself a "new" block worth resetting for.
 */
export function shouldResetCompletedExpanded(previousSourceBlockId: string | null, nextSourceBlockId: string | null): boolean {
  return nextSourceBlockId !== null && nextSourceBlockId !== previousSourceBlockId;
}

/** "Progress N/M" header/pill copy (N completed, M total). */
export function progressLabel(todos: TodoItemView[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return `Progress ${done}/${todos.length}`;
}

const TODO_STATUS_WORD: Record<TodoItemView["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
};

/** Static pending glyph — stroke-only circle, same posture as ToolCallCard's local CircleIcon (§6: not shared/refactored, this slice keeps its own). */
function PendingGlyph() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

/** Static in-progress glyph — a right arrow (design §2: distinct from ToolCallCard's spinning-glyph convention, this panel is a snapshot, not a live sub-status feed). */
function ActiveGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8h8M8 4l4 4-4 4" />
    </svg>
  );
}

function TodoPanelRow({
  todo,
  sourceBlockId,
  onJumpToBlock,
}: {
  todo: TodoItemView;
  sourceBlockId: string;
  onJumpToBlock: (blockId: string) => void;
}) {
  return (
    <li className={`todo-item todo-item-status-${todo.status}`}>
      <button type="button" className="todo-panel-item-button" onClick={() => onJumpToBlock(sourceBlockId)}>
        <span className="todo-glyph">
          {todo.status === "completed" ? <Check /> : todo.status === "in_progress" ? <ActiveGlyph /> : <PendingGlyph />}
        </span>
        <span className="visually-hidden">{TODO_STATUS_WORD[todo.status]}</span>
        <span className="todo-content">{todo.content}</span>
      </button>
    </li>
  );
}

export function TodoPanel({
  transcript,
  onJumpToBlock,
}: {
  transcript: TranscriptBlock[];
  onJumpToBlock: (blockId: string) => void;
}) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const selected = useMemo(() => selectCurrentTodos(transcript), [transcript]);

  // A new TodoWrite source block is a fresh plan — collapse the completed
  // group back to default; the pill's own collapsed/expanded choice
  // (`panelCollapsed`) is left alone, since the user set that deliberately.
  const nextSourceBlockId = selected?.sourceBlockId ?? null;
  const [seenSourceBlockId, setSeenSourceBlockId] = useState(nextSourceBlockId);
  if (shouldResetCompletedExpanded(seenSourceBlockId, nextSourceBlockId)) {
    setSeenSourceBlockId(nextSourceBlockId);
    setCompletedExpanded(false);
  }

  if (selected === null || selected.todos.length === 0) {
    return null;
  }
  const { todos, sourceBlockId } = selected;
  const completed = todos.filter((todo) => todo.status === "completed");
  const active = todos.filter((todo) => todo.status !== "completed");

  return (
    <div className="todo-panel">
      <div className={`todo-panel-card${panelCollapsed ? " todo-panel-collapsed" : ""}`} role="complementary" aria-label="Task progress">
        <button
          type="button"
          className="todo-panel-header"
          aria-expanded={!panelCollapsed}
          onClick={() => setPanelCollapsed(!panelCollapsed)}
        >
          <span className="tool-call-caret" aria-hidden="true">
            <Chevron />
          </span>
          <span className="todo-panel-title">{progressLabel(todos)}</span>
        </button>
        {!panelCollapsed && (
          <div className="todo-panel-body">
            {completed.length > 0 && (
              <button
                type="button"
                className="todo-panel-completed-toggle"
                aria-expanded={completedExpanded}
                onClick={() => setCompletedExpanded(!completedExpanded)}
              >
                <span className="tool-call-caret" aria-hidden="true">
                  <Chevron />
                </span>
                <span>{`↑ ${completed.length} completed`}</span>
              </button>
            )}
            <ul className="todo-panel-list">
              {completedExpanded &&
                completed.map((todo, index) => (
                  <TodoPanelRow key={`completed-${index}`} todo={todo} sourceBlockId={sourceBlockId} onJumpToBlock={onJumpToBlock} />
                ))}
              {active.map((todo, index) => (
                <TodoPanelRow key={`active-${index}`} todo={todo} sourceBlockId={sourceBlockId} onJumpToBlock={onJumpToBlock} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

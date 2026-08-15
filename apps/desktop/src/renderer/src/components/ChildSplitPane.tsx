/**
 * TASK.102 CUT-S3 §3.3: the split layout's right-column stack (layouts C/D —
 * §0.1 rules these are ONE layout, the head's shape a pure function of stack
 * size, `buildChildStackHead`, child-layout.ts). Purely presentational: head,
 * rows, accordion frame. The expanded row's own surface — a live child
 * `SessionSurface` or C4's read-only `ChildHistoryContent` — is NOT built
 * here: App.tsx composes it (it owns the `TabContext.Provider`/`tabRegistry`
 * wiring, this file's fence excludes both) and hands it down as `children`
 * (§3.3's "композиция вместо экстракции" — keeps App.tsx as the only place
 * `SessionSurface` gets re-scoped onto a child tab, so no App ⇄
 * ChildSplitPane import cycle forms and `SessionSurface` never needs its own
 * file, §9 п.13).
 *
 * §3.5's DOM contract is FROZEN for this file: the class names/attributes
 * below (`.child-split-pane`/`-head`/`-head-roster`/`-head-expand`/
 * `-head-close`/`-row`/`-row-expanded`/`-surface`, `data-spawn-id`) are what
 * S3c's automation smoke hit-tests and clicks — they must not drift.
 */
import type { ReactNode } from "react";
import type { SubagentSubStatus } from "../store.js";
import { buildChildStackHead, type ChildBadgeKind } from "../child-layout.js";
import { formatSubagentCounters } from "./ToolCallCard.js";
import { Maximize, X } from "./icons.js";

/** One stack row: the child's own Agent-card snapshot (§3.3: agentType/model/counters come straight off it) plus its collapsed `childBadgeKind` badge. */
export interface ChildSplitRow {
  spawnToolCallId: string;
  card: SubagentSubStatus;
  badge: ChildBadgeKind;
}

export interface ChildSplitPaneProps {
  /** Stack rows, `order` order (top-to-bottom visual order, §2.1). */
  rows: readonly ChildSplitRow[];
  /** The currently-expanded row's id — MUST be a member of `rows` (mirrors §2.1's `expandedId ∈ order` invariant). */
  expandedId: string;
  /** A collapsed row's click (§3.2 "клик по свёрнутой строке" → `expandRow`). */
  onExpandRow(spawnToolCallId: string): void;
  /** ⤢ — leaves the split for layout B on the expanded child (§3.2 `exitSplit`). */
  onExitSplit(): void;
  /** × — leaves the split for the master single-pane (§3.2 `close`). */
  onClose(): void;
  /** The expanded row's own surface, composed by App.tsx (live SessionSurface or read-only ChildHistoryContent). */
  children: ReactNode;
}

const BADGE_GLYPH: Record<ChildBadgeKind, string> = {
  waiting_permission: "⏸",
  running: "●",
  error: "✕",
  done: "✓",
};

const BADGE_LABEL: Record<ChildBadgeKind, string> = {
  waiting_permission: "Waiting for permission",
  running: "Running",
  error: "Error",
  done: "Done",
};

function ChildSplitBadge({ badge }: { badge: ChildBadgeKind }) {
  return (
    <span className={`child-split-badge child-split-badge-${badge}`} title={BADGE_LABEL[badge]} aria-hidden="true">
      {BADGE_GLYPH[badge]}
    </span>
  );
}

/** The stack head's `single` shape (mokap C): one child's own identity + counters, no separate row below it (§3.3: "N=1 строка-заголовок не дублирует голову"). */
function ChildSplitHeadSingle({ row }: { row: ChildSplitRow }) {
  return (
    <>
      <ChildSplitBadge badge={row.badge} />
      <span className="child-split-head-persona">{row.card.agentType}</span>
      {row.card.model !== null && <span className="child-split-head-model">{row.card.model}</span>}
      <span className="child-split-head-chip">subagent</span>
      <span className="child-split-head-counters">{formatSubagentCounters(row.card)}</span>
    </>
  );
}

/** The stack head's `roster` shape (mokap D): "Subagents · {total} · {running} running" — §2.4's frozen formula. */
function ChildSplitHeadRoster({ total, running }: { total: number; running: number }) {
  return (
    <>
      <span className="child-split-head-title">Subagents</span>
      <span className="child-split-head-counters">{`${total} · ${running} running`}</span>
    </>
  );
}

/** One accordion row's always-visible line: badge glyph, agentType, model, counters (§3.3 — every row, collapsed or expanded, shows the same line). */
function ChildSplitRowLine({ row }: { row: ChildSplitRow }) {
  return (
    <div className="child-split-row-line">
      <ChildSplitBadge badge={row.badge} />
      <span className="child-split-row-persona">{row.card.agentType}</span>
      {row.card.model !== null && <span className="child-split-row-model">{row.card.model}</span>}
      <span className="child-split-row-counters">{formatSubagentCounters(row.card)}</span>
    </div>
  );
}

export function ChildSplitPane({ rows, expandedId, onExpandRow, onExitSplit, onClose, children }: ChildSplitPaneProps) {
  const head = buildChildStackHead(rows);

  return (
    <div className="child-split-pane">
      <div className={`child-split-head${head.kind === "roster" ? " child-split-head-roster" : ""}`}>
        {head.kind === "single" ? (
          <ChildSplitHeadSingle row={rows[0]!} />
        ) : (
          <ChildSplitHeadRoster total={head.total} running={head.running} />
        )}
        <button type="button" className="child-split-head-expand" aria-label="Expand to full screen" onClick={onExitSplit}>
          <Maximize />
        </button>
        <button type="button" className="child-split-head-close" aria-label="Close subagents panel" onClick={onClose}>
          <X />
        </button>
      </div>

      {head.kind === "roster" && (
        <ul className="child-split-rows">
          {rows.map((row) => {
            const expanded = row.spawnToolCallId === expandedId;
            return (
              <li
                key={row.spawnToolCallId}
                className={`child-split-row${expanded ? " child-split-row-expanded" : ""}`}
                data-spawn-id={row.spawnToolCallId}
                onClick={expanded ? undefined : () => onExpandRow(row.spawnToolCallId)}
              >
                <ChildSplitRowLine row={row} />
                {expanded && <div className="child-split-surface">{children}</div>}
              </li>
            );
          })}
        </ul>
      )}

      {head.kind === "single" && <div className="child-split-surface">{children}</div>}
    </div>
  );
}

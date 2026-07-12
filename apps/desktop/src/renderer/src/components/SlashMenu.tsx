/**
 * SlashMenu (design slice-P7.23-cut.md §4.1/§1) — presentational listbox for
 * the composer's `/`-triggered command popover. Takes the already-filtered,
 * already-ranked `SlashMenuItem[]` from `slash-menu.ts`'s `filterSlashItems`
 * and renders it; all keyboard/trigger/filter decisions live in the caller
 * (Composer.tsx) and the pure `slash-menu.ts` module — this component owns
 * only markup, the roving-selection visuals, and the mouse handlers (design
 * §4.3: hover sets selection, mousedown is prevented so the textarea never
 * loses focus, click selects).
 *
 * A11y (design §4.7, CommandPalette.tsx pattern): the list is `role="listbox"`
 * with the fixed id `slash-menu-list` the textarea's `aria-controls` points
 * at; each row is `role="option"` with a stable index-keyed id the textarea's
 * `aria-activedescendant` references, `aria-selected`, and `aria-disabled` on
 * disabled rows. The "Skills" section header is `role="presentation"` (not
 * selectable, not counted in roving selection) and renders once, right
 * before the first row whose `section` is `"skills"` — harmless when no
 * skill rows are present yet (W2 always passes an empty skills array; W3
 * fills them in).
 */
import { Fragment } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import type { SlashIconId, SlashMenuItem } from "../slash-menu.js";
import { Clipboard, Cube, FileIcon, Gear, GitBranch, Plus, ServerStack, Sliders, Stack, Terminal } from "./icons.js";

const SLASH_ICONS: Record<SlashIconId, ComponentType<SVGProps<SVGSVGElement>>> = {
  plan: Clipboard,
  mode: Sliders,
  model: Cube,
  "new-task": Plus,
  sessions: Stack,
  git: GitBranch,
  terminal: Terminal,
  mcp: ServerStack,
  skills: FileIcon,
  settings: Gear,
  skill: FileIcon,
};

/**
 * Splits `name` into plain/`<b>` segments per `ranges` ([start,end) pairs,
 * cut §4.2): the matched substrings render at full brightness inside `<b>`,
 * everything else gets the muted class — the ref's "**Mod**el" look (design
 * §1.4). An empty `ranges` array (unfiltered menu) renders the name plain,
 * with no muting — the "no highlight yet" case.
 */
function renderHighlightedName(name: string, ranges: ReadonlyArray<readonly [number, number]>): ReactNode {
  if (ranges.length === 0) {
    return name;
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) {
      nodes.push(
        <span key={`m${index}`} className="slash-menu-row-name-muted">
          {name.slice(cursor, start)}
        </span>,
      );
    }
    nodes.push(<b key={`b${index}`}>{name.slice(start, end)}</b>);
    cursor = end;
  });
  if (cursor < name.length) {
    nodes.push(
      <span key="mend" className="slash-menu-row-name-muted">
        {name.slice(cursor)}
      </span>,
    );
  }
  return nodes;
}

export interface SlashMenuProps {
  items: readonly SlashMenuItem[];
  selectedIndex: number;
  onSelect(index: number): void;
  onHover(index: number): void;
}

export function SlashMenu({ items, selectedIndex, onSelect, onHover }: SlashMenuProps) {
  let skillsHeaderRendered = false;

  return (
    <div className="slash-menu" role="listbox" id="slash-menu-list" aria-label="Slash commands">
      {items.map((item, index) => {
        const showSkillsHeader = item.section === "skills" && !skillsHeaderRendered;
        if (showSkillsHeader) {
          skillsHeaderRendered = true;
        }
        const Icon = SLASH_ICONS[item.icon ?? "skill"];
        return (
          <Fragment key={`${item.section}:${item.id}`}>
            {showSkillsHeader && (
              <div className="slash-menu-section" role="presentation">
                Skills
              </div>
            )}
            <div
              id={`slash-menu-option-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              aria-disabled={item.disabled || undefined}
              className={`slash-menu-row${index === selectedIndex ? " slash-menu-row-selected" : ""}${
                item.disabled ? " slash-menu-row-disabled" : ""
              }`}
              title={item.disabled ? item.description : undefined}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(index)}
            >
              <span className="slash-menu-row-icon">
                <Icon />
              </span>
              <span className="slash-menu-row-body">
                <span className="slash-menu-row-name">{renderHighlightedName(item.name, item.ranges)}</span>
                <span className="slash-menu-row-desc">{item.description}</span>
              </span>
              {item.sourceLabel !== undefined && <span className="slash-menu-row-source">{item.sourceLabel}</span>}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

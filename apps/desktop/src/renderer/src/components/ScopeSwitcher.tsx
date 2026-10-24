/**
 * Taskana 4706: ONE shared Global-vs-Project scope control for the three
 * scope-dependent settings panes (MCP servers · Skills · Subagents). Before
 * this, those panes silently followed the active tab's workspace — the row
 * lists mixed user and project entries with only a small badge to tell them
 * apart, and nothing in the pane header said WHICH project's config was being
 * edited or where a write would land. This control makes the target explicit:
 *
 *  - "Global (user)" ≡ the user-scope config files (~/.anycode/…) — the panes
 *    call their bridges WITHOUT `tabId`, which main already degrades to a
 *    user-only (global) snapshot (skills-ipc/mcp-config-ipc/subagents-ipc
 *    `buildSnapshot`, no renderer change needed for the data path).
 *  - "Project: <name>" ≡ the chosen tab's workspace config — the panes call
 *    with that tab's `tabId` (path custody unchanged: the renderer still
 *    never sends a filesystem path, only tabId).
 *
 * Visual vocabulary is REUSED, not invented: the same segmented-control idiom
 * as StartScreen's engine picker (`start-engine-switch`/`start-engine-choice`,
 * already used inside the Settings CSS context by SettingsScreen's preview
 * location control) — no new design system.
 *
 * The helpers are exported pure functions because this package's vitest runs
 * `environment: "node"` (no jsdom/@testing-library) — tests pin the behavior
 * at the helper level (ScopeSwitcher.test.ts).
 */
import type { ReactElement } from "react";

/** The two areas a scope-dependent pane can target. "user" ≡ global config; "project" ≡ the chosen tab's workspace config. */
export type PaneScopeChoice = "user" | "project";

/** Resolves the effective choice, falling back to "user" when no project target exists (pure). */
export function resolvePaneScope(choice: PaneScopeChoice, projectAvailable: boolean): PaneScopeChoice {
  return choice === "project" && !projectAvailable ? "user" : choice;
}

/** Default: the active tab if one is open, else global (card item 1). */
export function defaultPaneScope(projectAvailable: boolean): PaneScopeChoice {
  return projectAvailable ? "project" : "user";
}

/** aria label of the project option, e.g. "Project: repo" (name may be empty). */
export function projectOptionLabel(workspaceName: string): string {
  return workspaceName ? `Project: ${workspaceName}` : "Project";
}

export interface ScopeSwitcherProps {
  value: PaneScopeChoice;
  projectAvailable: boolean;
  workspaceName?: string;
  onChange: (next: PaneScopeChoice) => void;
}

export function ScopeSwitcher({ value, projectAvailable, workspaceName, onChange }: ScopeSwitcherProps): ReactElement {
  return (
    <div className="scope-switcher" role="group" aria-label="Settings scope">
      <div className="start-engine-switch">
        <button
          type="button"
          className={`start-engine-choice${value === "user" ? " start-engine-choice-selected" : ""}`}
          aria-pressed={value === "user"}
          onClick={() => onChange("user")}
        >
          Global (user)
        </button>
        <button
          type="button"
          className={`start-engine-choice${value === "project" ? " start-engine-choice-selected" : ""}`}
          aria-pressed={value === "project"}
          disabled={!projectAvailable}
          title={projectAvailable ? undefined : "Open a project to edit its workspace scope"}
          onClick={() => onChange("project")}
        >
          {projectOptionLabel(workspaceName ?? "")}
        </button>
      </div>
    </div>
  );
}

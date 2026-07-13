/**
 * Composer slash-command menu — pure logic (design slice-P7.23-cut.md §2/§4.1-4.3).
 *
 * Everything here is a plain exported function/type: no React, no DOM, no
 * window access at module load. Same discipline as Composer.tsx's pure
 * helpers (`contextMeterPercent`/`shouldEnqueue` etc., Composer.tsx:199-208
 * comment) — tested directly in `slash-menu.test.ts` without a mount harness.
 *
 * `SLASH_COMMANDS` is the §2 command table verbatim: names/descriptions/order
 * are LAW (rank ties among commands break by this array's order). Each
 * command's `run` is a serializable intent tag, not a live dispatch — the
 * Composer (W2) owns the single exhaustive `dispatchSlashIntent` switch that
 * turns an intent into the real wire-send/window-event/store-call. Keeping
 * the intent a plain tagged union is what makes the registry testable here
 * without mounting anything.
 */

import type { SkillRowView, SkillSourceKind } from "../../shared/skills-config.js";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type SlashIconId =
  | "plan"
  | "mode"
  | "model"
  | "new-task"
  | "sessions"
  | "git"
  | "terminal"
  | "mcp"
  | "skills"
  | "settings"
  | "skill";

/**
 * Serializable dispatch intent for a slash-menu row. Each variant names an
 * ALREADY-WIRED renderer action (cut §2/§5 wire-delta-zero proof) — the
 * registry stays pure/testable by describing *what* to do, not doing it.
 */
export type SlashRunIntent =
  | { kind: "set_mode_toggle" }
  | { kind: "window_event"; event: string }
  | { kind: "run_action"; action: string }
  | { kind: "store_git_panel" }
  | { kind: "settings_pane"; pane: string }
  | { kind: "insert"; text: string };

/**
 * Named engine/shell capability gates a command's structural VISIBILITY reads
 * (design TASK.40 §2(f)). Distinct from `enabled` below: `enabled` grays out a
 * row for a transient reason (busy/not-ready) while its target control still
 * exists; these gates hide a row ENTIRELY when its target control isn't even
 * rendered for the active engine — never a permanently-disabled row with no
 * explanation ("no dead actions", TASK.40 DoD). Defaults mirror core (every
 * capability true) so every pre-existing caller/test that omits an override
 * keeps seeing the full registry.
 */
export interface SlashCapabilityCtx {
  /** Mirrors `engine.capabilities.supportsCorePermissions` — gates `/mode`, `plan-mode` (ModeMenu isn't rendered without it). */
  supportsCorePermissions: boolean;
  /** Mirrors `engine.capabilities.supportsModelSelection` — gates `/model` (ModelPill isn't rendered without it). */
  supportsModelSelection: boolean;
  /** Mirrors `shell.gitReadOnly ?? true` — gates `/git-changes` (the Review panel stays closed without it, App.tsx). */
  shellGitReadOnly: boolean;
  /** Mirrors `shell.terminal ?? true` — gates `/terminal`. */
  shellTerminal: boolean;
}

/** Live composer/session state a command's dynamic description/enabled/visible reads. */
export interface SlashMenuCtx extends SlashCapabilityCtx {
  mode: string;
  model: string;
  running: boolean;
  ready: boolean;
  /** Mirrors `ModelPill.tsx`'s `modelPickDisabled` — the Model row is enabled iff the pill itself is clickable (codex R1 P2 fix). */
  modelDisabled: boolean;
}

/**
 * Where a command's implementation lives (design TASK.40 §2(f)): `common`
 * (shell-owned or otherwise engine-independent) works under any engine;
 * `core` requires an AnyCode-loop-only control (ModeMenu/ModelPill/the
 * fetched Skills section) and is gated on a named engine capability;
 * `engine` would route through a specific engine's own native adapter (none
 * built yet — Codex-native commands/skills are a documented residual,
 * honestly hidden rather than faked, see Composer.tsx's skills gating).
 */
export type SlashCommandSource = "common" | "core" | "engine";

export interface SlashCommand {
  id: string;
  name: string;
  description: (ctx: SlashMenuCtx) => string;
  icon: SlashIconId;
  run: SlashRunIntent;
  enabled: (ctx: SlashMenuCtx) => boolean;
  source: SlashCommandSource;
  /** Structural visibility gate (design TASK.40 §2(f)) — see `SlashCapabilityCtx` above. A hidden row is filtered out of `filterSlashItems`'s result entirely, never shown disabled. */
  visible: (ctx: SlashMenuCtx) => boolean;
}

/** Skills-section input row (W3 maps `SkillRowView` → this before calling `filterSlashItems`). */
export interface SlashSkill {
  name: string;
  description: string;
  sourceLabel: string;
}

/** `SkillSourceKind` → the right-aligned source label (cut §3): `user`→"Personal", `project`→"Project", `plugin`→its plugin name (or a generic fallback when absent). */
function skillSourceLabel(sourceKind: SkillSourceKind, pluginName: string | undefined): string {
  switch (sourceKind) {
    case "user":
      return "Personal";
    case "project":
      return "Project";
    case "plugin":
      return pluginName ?? "Plugin";
    default:
      return assertNever(sourceKind);
  }
}

/**
 * Maps the skills-list IPC response into `filterSlashItems`'s `SlashSkill`
 * input (cut §3): only `enabled` rows are offered (a disabled skill's
 * `$name` convention wouldn't resolve), `sourceKind` becomes the display
 * label. Total and pure — W2/W3's Composer effect is the only caller.
 */
export function skillsToSlashSkills(rows: readonly SkillRowView[]): SlashSkill[] {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({
      name: row.name,
      description: row.description,
      sourceLabel: skillSourceLabel(row.sourceKind, row.pluginName),
    }));
}

/** A flattened, render-ready row — the output of `filterSlashItems`. */
export interface SlashMenuItem {
  id: string;
  name: string;
  description: string;
  icon?: SlashIconId;
  section: "commands" | "skills";
  sourceLabel?: string;
  disabled: boolean;
  /** `[start, end)` highlight ranges over `name` only; empty when nothing in the name matched. */
  ranges: Array<[number, number]>;
  intent: SlashRunIntent;
}

export interface SlashMenuState {
  selectedIndex: number;
  dismissed: boolean;
}

export type SlashKeyEvent =
  | { kind: "down" }
  | { kind: "up" }
  | { kind: "escape" }
  | { kind: "select" };

// ─────────────────────────────────────────────────────────────────────────
// Window-event idioms (R7/R11 payload-carrying CustomEvent pattern,
// ModeMenu.tsx:62/COMPOSER_INSERT_EVENT precedent, Composer.tsx:95-101).
// Exported so W2 wires the SAME identifiers into the real listeners.
// ─────────────────────────────────────────────────────────────────────────

/**
 * MUST stay byte-identical to `FOCUS_MODE_MENU_EVENT` exported by
 * `components/ModeMenu.tsx` (currently `"anycode:focus-mode-menu"`). Not
 * imported directly — importing a `.tsx` component module from this pure
 * module would pull React into a file that must load without it; W2 keeps
 * the two constants in lockstep by construction (same literal, one summon
 * idiom, sibling files).
 */
export const FOCUS_MODE_MENU_EVENT = "anycode:focus-mode-menu";

/** NEW seam (cut §2 row 3): W2 adds the mirroring listener in ModelPill.tsx. */
export const FOCUS_MODEL_PILL_EVENT = "anycode:focus-model-pill";

/**
 * Run-action seam (cut §4.5): `CustomEvent<string>` carrying an `ActionId`
 * (kept as `string` here — this pure module never imports `keymap.ts`'s
 * type). App.tsx listens and routes through the SAME per-action code paths
 * the keydown switch / command palette already use (`session.new`,
 * `palette.sessions`, `terminal.toggle`, `settings.open`) — a second doorway
 * into existing switch arms, not a new capability.
 */
export const RUN_ACTION_EVENT = "anycode:run-action";

/**
 * Settings pane-select seam (cut §4.6): `CustomEvent<string>` carrying a
 * `SettingsPaneId`. `SettingsDialog` (unconditionally mounted by App.tsx,
 * SettingsScreen.tsx:1276 note) listens so the seam is already wired before
 * any "settings.open" + pane-select pair can fire, guarding the value
 * against `SETTINGS_PANES` before forwarding it into `SettingsScreen`.
 */
export const SETTINGS_SELECT_PANE_EVENT = "anycode:settings-select-pane";

// ─────────────────────────────────────────────────────────────────────────
// Registry (cut §2 — order, names, descriptions, dispatch, gating: LAW)
// ─────────────────────────────────────────────────────────────────────────

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "plan-mode",
    name: "Plan mode",
    description: (ctx) => (ctx.mode === "plan" ? "Turn plan mode off" : "Turn plan mode on"),
    icon: "plan",
    run: { kind: "set_mode_toggle" },
    enabled: (ctx) => !(ctx.running || !ctx.ready),
    source: "core",
    // set_mode is rejected host-side without supportsCorePermissions (Session.onSetMode) — a dead toggle otherwise.
    visible: (ctx) => ctx.supportsCorePermissions,
  },
  {
    id: "mode",
    name: "Mode",
    description: () => "Change permission mode…",
    icon: "mode",
    run: { kind: "window_event", event: FOCUS_MODE_MENU_EVENT },
    enabled: () => true,
    source: "core",
    // Focuses ModeMenu, which Composer only renders when supportsCorePermissions is true.
    visible: (ctx) => ctx.supportsCorePermissions,
  },
  {
    id: "model",
    name: "Model",
    description: (ctx) => `Current: ${ctx.model}`,
    icon: "model",
    run: { kind: "window_event", event: FOCUS_MODEL_PILL_EVENT },
    enabled: (ctx) => !ctx.modelDisabled,
    source: "core",
    // Focuses ModelPill, which Composer only renders when supportsModelSelection is true.
    visible: (ctx) => ctx.supportsModelSelection,
  },
  {
    id: "new-task",
    name: "New task",
    description: () => "Start a new task",
    icon: "new-task",
    run: { kind: "run_action", action: "session.new" },
    enabled: () => true,
    source: "common",
    visible: () => true,
  },
  {
    id: "sessions",
    name: "Tasks",
    description: () => "Switch task…",
    icon: "sessions",
    run: { kind: "run_action", action: "palette.sessions" },
    enabled: () => true,
    source: "common",
    visible: () => true,
  },
  {
    id: "git-changes",
    name: "Git changes",
    description: () => "Review the working tree diff",
    icon: "git",
    run: { kind: "store_git_panel" },
    enabled: () => true,
    source: "common",
    // Shell-owned (design TASK.40 §2(f)): the Review panel itself stays
    // closed under App.tsx's gitPanelOpen gate without shell.gitReadOnly.
    visible: (ctx) => ctx.shellGitReadOnly,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: () => "Toggle the terminal",
    icon: "terminal",
    run: { kind: "run_action", action: "terminal.toggle" },
    enabled: () => true,
    source: "common",
    visible: (ctx) => ctx.shellTerminal,
  },
  {
    id: "mcp",
    name: "MCP",
    description: () => "MCP server status & settings",
    icon: "mcp",
    run: { kind: "settings_pane", pane: "mcp" },
    enabled: () => true,
    // Settings' MCP pane is engine-independent (always mounted, honest empty
    // state with zero servers) — common, not core-gated.
    source: "common",
    visible: () => true,
  },
  {
    id: "skills",
    name: "Skills",
    description: () => "Manage skills",
    icon: "skills",
    run: { kind: "settings_pane", pane: "skills" },
    enabled: () => true,
    // Opens project/personal skill FILE management, independent of which
    // engine is running (unlike the live skill-insert rows below, which
    // Composer gates separately — see its skillsSupported comment).
    source: "common",
    visible: () => true,
  },
  {
    id: "settings",
    name: "Settings",
    description: () => "Open settings",
    icon: "settings",
    run: { kind: "run_action", action: "settings.open" },
    enabled: () => true,
    source: "common",
    visible: () => true,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Trigger detection (cut §4.3)
// ─────────────────────────────────────────────────────────────────────────

function isTokenChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

/**
 * Detects the active slash token around `caret`, if any. Token grammar is
 * `/` + `[A-Za-z0-9_-]*`, with the `/` required at text-offset 0 or
 * immediately after a `\n` (covers "empty draft" and "line start"). The
 * token cannot contain whitespace or a second `/` — both are outside the
 * token-char class, so they naturally end the run during the forward scan
 * below (typing `/usr/bin` or `/ foo` closes the trigger, exactly per §4.3).
 *
 * `caret` may sit anywhere from right after the `/` through the end of the
 * token (mid-token caret stays active; `query` is the text from `/` up to
 * `caret`, not the whole token). The character immediately after the token's
 * end must be empty (EOF) or start with whitespace/newline — text glued
 * directly onto the token with no separator (e.g. `/mode.txt`) closes it.
 */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) {
    return null;
  }

  // Walk back from caret through token chars to find the token's start.
  let i = caret;
  while (i > 0 && isTokenChar(text[i - 1])) {
    i--;
  }
  if (i === 0 || text[i - 1] !== "/") {
    return null;
  }
  const start = i - 1;
  if (start !== 0 && text[start - 1] !== "\n") {
    return null;
  }

  // Forward scan for the token's true end (caret may sit before it).
  let end = start + 1;
  while (end < text.length && isTokenChar(text[end])) {
    end++;
  }

  const afterFirstChar = text[end];
  if (afterFirstChar !== undefined && !/\s/.test(afterFirstChar)) {
    return null;
  }

  return { start, query: text.slice(start + 1, caret) };
}

// ─────────────────────────────────────────────────────────────────────────
// Fuzzy filter + rank + highlight (cut §4.2)
// ─────────────────────────────────────────────────────────────────────────

interface NameMatch {
  rank: 0 | 1 | 2 | 3;
  ranges: Array<[number, number]>;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Ranks `query` against `name` (case-insensitive): 0 exact prefix, 1
 * word-boundary start (e.g. "mod" → the "mode" in "Plan mode"), 2 contiguous
 * substring anywhere else, 3 in-name subsequence (per-char ranges). Returns
 * null when none of those match — callers fall back to a description-only
 * check (rank 4, no name ranges).
 */
function matchName(name: string, query: string): NameMatch | null {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerName.startsWith(lowerQuery)) {
    return { rank: 0, ranges: [[0, lowerQuery.length]] };
  }

  for (let start = 1; start <= lowerName.length - lowerQuery.length; start++) {
    if (lowerName.startsWith(lowerQuery, start) && !isWordChar(lowerName[start - 1])) {
      return { rank: 1, ranges: [[start, start + lowerQuery.length]] };
    }
  }

  const idx = lowerName.indexOf(lowerQuery);
  if (idx >= 0) {
    return { rank: 2, ranges: [[idx, idx + lowerQuery.length]] };
  }

  const ranges: Array<[number, number]> = [];
  let qi = 0;
  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) {
      ranges.push([ni, ni + 1]);
      qi++;
    }
  }
  if (qi === lowerQuery.length) {
    return { rank: 3, ranges };
  }
  return null;
}

/**
 * Filters + ranks the full registry plus the skills section against `query`.
 * Commands always precede skills in the returned array (cut §1.5/§3: the
 * "Skills" header sits below all commands, unconditionally); within each
 * section, matches sort by rank then registry order (commands) / alphabetic
 * name (skills). Empty query returns everything, unranked, no highlight
 * ranges. Non-matching rows are excluded entirely — a zero-match query
 * yields an empty array (cut §4.3: zero matches closes the menu).
 */
export function filterSlashItems(
  commands: SlashCommand[],
  skills: SlashSkill[],
  query: string,
  ctx: SlashMenuCtx
): SlashMenuItem[] {
  const isEmpty = query.length === 0;
  const lowerQuery = query.toLowerCase();

  const commandRows: Array<{ item: SlashMenuItem; rank: number; order: number }> = [];
  commands.forEach((command, order) => {
    // Structural visibility (design TASK.40 §2(f)): filtered out BEFORE
    // ranking, unconditionally of the query — a command whose target control
    // the active engine/shell cannot honor never appears, matching/disabled
    // ("no dead actions").
    if (!command.visible(ctx)) {
      return;
    }
    const description = command.description(ctx);
    let rank = 0;
    let ranges: Array<[number, number]> = [];
    if (!isEmpty) {
      const nameMatch = matchName(command.name, query);
      if (nameMatch) {
        rank = nameMatch.rank;
        ranges = nameMatch.ranges;
      } else if (description.toLowerCase().includes(lowerQuery)) {
        rank = 4;
      } else {
        return;
      }
    }
    commandRows.push({
      item: {
        id: command.id,
        name: command.name,
        description,
        icon: command.icon,
        section: "commands",
        disabled: !command.enabled(ctx),
        ranges,
        intent: command.run,
      },
      rank,
      order,
    });
  });
  commandRows.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order));

  const skillRows: Array<{ item: SlashMenuItem; rank: number; name: string }> = [];
  skills.forEach((skill) => {
    let rank = 0;
    let ranges: Array<[number, number]> = [];
    if (!isEmpty) {
      const nameMatch = matchName(skill.name, query);
      if (nameMatch) {
        rank = nameMatch.rank;
        ranges = nameMatch.ranges;
      } else if (skill.description.toLowerCase().includes(lowerQuery)) {
        rank = 4;
      } else {
        return;
      }
    }
    skillRows.push({
      item: {
        id: `skill:${skill.name}`,
        name: skill.name,
        description: skill.description,
        icon: "skill",
        section: "skills",
        sourceLabel: skill.sourceLabel,
        disabled: false,
        ranges,
        intent: { kind: "insert", text: `$${skill.name} ` },
      },
      rank,
      name: skill.name,
    });
  });
  skillRows.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name)));

  return [...commandRows.map((row) => row.item), ...skillRows.map((row) => row.item)];
}

// ─────────────────────────────────────────────────────────────────────────
// Keyboard reducer (cut §4.3) — pure; effects (dispatch, textarea focus)
// stay with the caller.
// ─────────────────────────────────────────────────────────────────────────

function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index > count - 1) {
    return count - 1;
  }
  return index;
}

/** Exhaustive-switch guard, reused by both this module's reducer and its tests. */
export function assertNever(value: never): never {
  throw new Error(`slash-menu: unhandled case ${JSON.stringify(value)}`);
}

/**
 * Pure keyboard reducer: `itemCount` is passed in (not carried on state)
 * because wrap-around is only well-defined relative to the CURRENT filtered
 * list length, which changes every keystroke. `select` is intentionally a
 * near no-op on state — choosing a row is an effect the caller performs
 * (dispatch the intent / insert skill text / close the menu); the reducer
 * only clamps in case the list shrank since the last render.
 */
export function slashMenuReduce(state: SlashMenuState, event: SlashKeyEvent, itemCount: number): SlashMenuState {
  switch (event.kind) {
    case "down": {
      if (itemCount <= 0) {
        return { ...state, selectedIndex: 0 };
      }
      const current = clampIndex(state.selectedIndex, itemCount);
      return { ...state, selectedIndex: (current + 1) % itemCount };
    }
    case "up": {
      if (itemCount <= 0) {
        return { ...state, selectedIndex: 0 };
      }
      const current = clampIndex(state.selectedIndex, itemCount);
      return { ...state, selectedIndex: (current - 1 + itemCount) % itemCount };
    }
    case "escape":
      return { ...state, dismissed: true };
    case "select":
      return { ...state, selectedIndex: clampIndex(state.selectedIndex, itemCount) };
    default:
      return assertNever(event);
  }
}

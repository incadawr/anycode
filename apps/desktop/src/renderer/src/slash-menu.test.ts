/**
 * Pure-logic tests for the composer slash-command menu (design
 * slice-P7.23-cut.md §6 W1 gate). `.test.ts` under vitest's node
 * (no-jsdom) environment — same discipline as Composer.test.ts: these are
 * plain functions, no component mount, no DOM.
 */
import { describe, expect, it } from "vitest";
import type { SkillRowView } from "../../shared/skills-config.js";
import {
  assertNever,
  filterSlashItems,
  FOCUS_MODE_MENU_EVENT,
  FOCUS_MODEL_PILL_EVENT,
  openSettingsAddConnection,
  RUN_ACTION_EVENT,
  SETTINGS_ADD_CONNECTION_EVENT,
  SETTINGS_SELECT_PANE_EVENT,
  skillsToSlashSkills,
  slashMenuReduce,
  slashQueryAt,
  SLASH_COMMANDS,
  type SlashMenuCtx,
  type SlashMenuState,
  type SlashRunIntent,
} from "./slash-menu.js";

function skillRow(overrides: Partial<SkillRowView> = {}): SkillRowView {
  return {
    name: "dark-mode-notes",
    description: "dark mode helper",
    source: "user",
    sourceKind: "user",
    enabled: true,
    path: "/home/user/.anycode/skills/dark-mode-notes/SKILL.md",
    ...overrides,
  };
}

function ctx(overrides: Partial<SlashMenuCtx> = {}): SlashMenuCtx {
  return {
    mode: "build",
    model: "claude-x",
    running: false,
    ready: true,
    modelDisabled: false,
    // TASK.40 §2(f): default to core-shaped (every capability enabled) so
    // every pre-existing test — none of which cares about gating — keeps
    // seeing the full registry.
    supportsCorePermissions: true,
    supportsModelSelection: true,
    // TASK.92: default mirrors core — the Compact row is visible by default.
    supportsManualCompact: true,
    shellGitReadOnly: true,
    shellTerminal: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// slashQueryAt — trigger matrix
// ─────────────────────────────────────────────────────────────────────────

describe("slashQueryAt", () => {
  it("triggers at text offset 0", () => {
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashQueryAt("/mod", 4)).toEqual({ start: 0, query: "mod" });
  });

  it("triggers immediately after a newline", () => {
    const text = "hello\n/mod";
    expect(slashQueryAt(text, text.length)).toEqual({ start: 6, query: "mod" });
  });

  it("does not trigger on a mid-word slash (not offset-0, not after \\n)", () => {
    expect(slashQueryAt("foo/mod", 7)).toBeNull();
  });

  it("does not trigger when a second slash appears inside the token (path-like text)", () => {
    expect(slashQueryAt("/usr/bin", 8)).toBeNull();
  });

  it("does not trigger when non-whitespace text is glued directly after the token", () => {
    // caret sits exactly at the token's natural end, but '.' (not a token
    // char, not whitespace) follows immediately with no separator.
    expect(slashQueryAt("/mode.txt", 5)).toBeNull();
  });

  it("stays active with a truncated query when the caret sits mid-token", () => {
    expect(slashQueryAt("/model foo", 3)).toEqual({ start: 0, query: "mo" });
  });

  it("returns null for a literal '/ foo' (space right after the slash)", () => {
    expect(slashQueryAt("/ foo", 5)).toBeNull();
  });

  it("stays null once whitespace has been typed directly after the slash", () => {
    // caret placed right after the space: backward scan can't find a '/'
    // immediately behind the run (there is none — the run is empty).
    expect(slashQueryAt("/ foo", 2)).toBeNull();
  });

  it("deactivates on out-of-range caret", () => {
    expect(slashQueryAt("/mod", -1)).toBeNull();
    expect(slashQueryAt("/mod", 5)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// filterSlashItems — ranking, highlight ranges, section ordering
// ─────────────────────────────────────────────────────────────────────────

describe("filterSlashItems", () => {
  it("returns the full registry, unranked, no highlight ranges on an empty query", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "", ctx());
    expect(items).toHaveLength(SLASH_COMMANDS.length);
    expect(items.map((item) => item.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
    for (const item of items) {
      expect(item.ranges).toEqual([]);
    }
  });

  it("pins the /mod relative order: Model ranks before Plan mode, both present", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "mod", ctx());
    const modelIndex = items.findIndex((item) => item.name === "Model");
    const planModeIndex = items.findIndex((item) => item.name === "Plan mode");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(planModeIndex).toBeGreaterThanOrEqual(0);
    expect(modelIndex).toBeLessThan(planModeIndex);
  });

  it("gives an exact-prefix match rank 0 with a single highlight range over the prefix", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "mod", ctx());
    const model = items.find((item) => item.name === "Model")!;
    expect(model.ranges).toEqual([[0, 3]]);
  });

  it("gives a word-boundary match a single highlight range at the word start", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "mod", ctx());
    const planMode = items.find((item) => item.name === "Plan mode")!;
    expect(planMode.ranges).toEqual([[5, 8]]); // "Plan mode" -> "mod" starts at index 5
  });

  it("gives a contiguous (non-word-boundary) substring match one range", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "erm", ctx());
    const terminal = items.find((item) => item.name === "Terminal")!;
    expect(terminal.ranges).toEqual([[1, 4]]);
  });

  it("gives an in-name subsequence match per-char ranges", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "tml", ctx());
    const terminal = items.find((item) => item.name === "Terminal")!;
    expect(terminal).toBeDefined();
    expect(terminal.ranges).toEqual([
      [0, 1],
      [3, 4],
      [7, 8],
    ]);
  });

  it("matches on description with no name highlight when the name has no match at all", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "review", ctx());
    const gitChanges = items.find((item) => item.name === "Git changes")!;
    expect(gitChanges).toBeDefined();
    expect(gitChanges.ranges).toEqual([]);
  });

  it("excludes rows that match neither name nor description", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "zzzznomatch", ctx());
    expect(items).toEqual([]);
  });

  it("orders skills after all commands, alphabetically, in their own section", () => {
    const skills = [
      { name: "zeta-notes", description: "zeta helper", sourceLabel: "Personal" },
      { name: "alpha-notes", description: "alpha helper", sourceLabel: "Personal" },
    ];
    const items = filterSlashItems(SLASH_COMMANDS, skills, "notes", ctx());
    const sections = items.map((item) => item.section);
    // all "commands" entries (if any matched) precede all "skills" entries
    const firstSkillIndex = sections.indexOf("skills");
    expect(firstSkillIndex).toBeGreaterThan(-1);
    expect(sections.slice(firstSkillIndex).every((s) => s === "skills")).toBe(true);
    const skillNames = items.filter((item) => item.section === "skills").map((item) => item.name);
    expect(skillNames).toEqual(["alpha-notes", "zeta-notes"]);
  });

  it("carries a right-aligned sourceLabel on skill rows and an insert intent", () => {
    const skills = [{ name: "dark-mode-notes", description: "dark mode helper", sourceLabel: "Personal" }];
    const items = filterSlashItems(SLASH_COMMANDS, skills, "mod", ctx());
    const skillItem = items.find((item) => item.section === "skills")!;
    expect(skillItem.sourceLabel).toBe("Personal");
    expect(skillItem.intent).toEqual({ kind: "insert", text: "$dark-mode-notes " });
  });

  it("reflects dynamic descriptions and gating from ctx", () => {
    const planItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ mode: "plan" }));
    const plan = planItems.find((item) => item.name === "Plan mode")!;
    expect(plan.description).toBe("Turn plan mode off");

    const buildItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ mode: "build" }));
    const build = buildItems.find((item) => item.name === "Plan mode")!;
    expect(build.description).toBe("Turn plan mode on");

    // TASK.37 (D-S3-13): a running turn no longer gates the plan-mode toggle
    // (MR4 pins the mid-turn arc); not-ready is the sole surviving gate.
    const notReadyItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ ready: false }));
    const notReadyPlan = notReadyItems.find((item) => item.name === "Plan mode")!;
    expect(notReadyPlan.disabled).toBe(true);

    const modelItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ model: "gpt-5.6-terra" }));
    const model = modelItems.find((item) => item.name === "Model")!;
    expect(model.description).toBe("Current: gpt-5.6-terra");
  });

  it("gates the Model command's enabled/disabled row on ctx.modelDisabled (codex R1 P2 fix — mirrors ModelPill's own disabled predicate)", () => {
    const modelCommand = SLASH_COMMANDS.find((command) => command.id === "model")!;
    expect(modelCommand.enabled(ctx({ modelDisabled: true }))).toBe(false);
    expect(modelCommand.enabled(ctx({ modelDisabled: false }))).toBe(true);

    const disabledItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ modelDisabled: true }));
    expect(disabledItems.find((item) => item.name === "Model")!.disabled).toBe(true);

    const enabledItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ modelDisabled: false }));
    expect(enabledItems.find((item) => item.name === "Model")!.disabled).toBe(false);
  });

  it("TASK.146: /co resolves to Compact alone, rank 0, highlighted over the prefix", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "co", ctx());
    expect(items.map((item) => item.name)).toEqual(["Compact"]);
    expect(items[0]!.ranges).toEqual([[0, 2]]);
  });

  it("TASK.146: /c ranks Compact (prefix) above Git changes (word boundary) above MCP (substring)", () => {
    // Taskana 4704 §3.8: "Orchestrate" matches "c" as a SUBSTRING ("Or[c]hestrate")
    // at the same rank 2 as MCP but sits EARLIER in registry order (index 1 vs
    // 9), so it now takes the third slot — an intended, pinned consequence of
    // the row's mandated position right after plan-mode, not a ranking change.
    const items = filterSlashItems(SLASH_COMMANDS, [], "c", ctx());
    expect(items.map((item) => item.name).slice(0, 4)).toEqual(["Compact", "Git changes", "Orchestrate", "MCP"]);
  });

  it("TASK.146: the new row does not disturb the /mod pins — Compact does not match 'mod' at all", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "mod", ctx());
    expect(items.map((item) => item.name)).toEqual(["Mode", "Model", "Plan mode"]);
  });

  it("MR4 (TASK.37): the plan-mode command is enabled while running; not-ready still gates it", () => {
    const planModeCommand = SLASH_COMMANDS.find((command) => command.id === "plan-mode")!;
    expect(planModeCommand.enabled(ctx({ running: true, ready: true }))).toBe(true);
    expect(planModeCommand.enabled(ctx({ running: false, ready: false }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// skillsToSlashSkills — SkillRowView -> SlashSkill mapping (cut §3, W3)
// ─────────────────────────────────────────────────────────────────────────

describe("skillsToSlashSkills", () => {
  it("maps a user-scope row to the Personal label", () => {
    const rows = skillsToSlashSkills([skillRow({ sourceKind: "user" })]);
    expect(rows).toEqual([{ name: "dark-mode-notes", description: "dark mode helper", sourceLabel: "Personal" }]);
  });

  it("maps a project-scope row to the Project label", () => {
    const rows = skillsToSlashSkills([skillRow({ sourceKind: "project" })]);
    expect(rows[0]!.sourceLabel).toBe("Project");
  });

  it("maps a plugin-scope row to its plugin name", () => {
    const rows = skillsToSlashSkills([skillRow({ sourceKind: "plugin", pluginName: "superpowers" })]);
    expect(rows[0]!.sourceLabel).toBe("superpowers");
  });

  it("falls back to a generic label for a plugin row with no plugin name", () => {
    const rows = skillsToSlashSkills([skillRow({ sourceKind: "plugin", pluginName: undefined })]);
    expect(rows[0]!.sourceLabel).toBe("Plugin");
  });

  it("drops disabled rows", () => {
    const rows = skillsToSlashSkills([
      skillRow({ name: "enabled-one", enabled: true }),
      skillRow({ name: "disabled-one", enabled: false }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["enabled-one"]);
  });

  it("is total over an empty input", () => {
    expect(skillsToSlashSkills([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Merged filterSlashItems ordering + skill-row insert text, using the real
// skillsToSlashSkills mapping (cut §6 W3 gate).
// ─────────────────────────────────────────────────────────────────────────

describe("filterSlashItems with skillsToSlashSkills-mapped rows", () => {
  it("places commands before skills and highlights the matched skill name", () => {
    const rows: SkillRowView[] = [
      skillRow({ name: "dark-mode-notes", description: "toggle dark mode", sourceKind: "user" }),
    ];
    const items = filterSlashItems(SLASH_COMMANDS, skillsToSlashSkills(rows), "mod", ctx());
    const commandNames = items.filter((i) => i.section === "commands").map((i) => i.name);
    // "Mode" and "Model" both exact-prefix-match "mod" (rank 0, tie broken by
    // registry order: Mode precedes Model there); "Plan mode" is a
    // word-boundary match (rank 1).
    expect(commandNames).toEqual(["Mode", "Model", "Plan mode"]);
    const skillItem = items.find((i) => i.section === "skills")!;
    expect(skillItem.name).toBe("dark-mode-notes");
    expect(skillItem.sourceLabel).toBe("Personal");
    expect(skillItem.ranges).toEqual([[5, 8]]); // "dark-mode-notes" -> "mod" starts at index 5
    const sections = items.map((i) => i.section);
    const firstSkillIndex = sections.indexOf("skills");
    expect(sections.slice(0, firstSkillIndex).every((s) => s === "commands")).toBe(true);
  });

  it("gives a selected skill row an insert intent of \"$<name> \"", () => {
    const rows: SkillRowView[] = [skillRow({ name: "dark-mode-notes" })];
    const items = filterSlashItems(SLASH_COMMANDS, skillsToSlashSkills(rows), "dark", ctx());
    const skillItem = items.find((i) => i.section === "skills")!;
    expect(skillItem.intent).toEqual({ kind: "insert", text: "$dark-mode-notes " });
  });

  it("excludes a disabled skill from the menu entirely", () => {
    const rows: SkillRowView[] = [skillRow({ name: "off-skill", enabled: false })];
    const items = filterSlashItems(SLASH_COMMANDS, skillsToSlashSkills(rows), "off", ctx());
    expect(items.find((i) => i.section === "skills")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// slashMenuReduce — pure keyboard reducer
// ─────────────────────────────────────────────────────────────────────────

describe("slashMenuReduce", () => {
  const base: SlashMenuState = { selectedIndex: 0, dismissed: false };

  it("moves down with wrap", () => {
    const state = { ...base, selectedIndex: 2 };
    expect(slashMenuReduce(state, { kind: "down" }, 3)).toEqual({ ...base, selectedIndex: 0 });
  });

  it("moves up with wrap", () => {
    const state = { ...base, selectedIndex: 0 };
    expect(slashMenuReduce(state, { kind: "up" }, 3)).toEqual({ ...base, selectedIndex: 2 });
  });

  it("sets dismissed on escape without touching selectedIndex", () => {
    const state = { ...base, selectedIndex: 1 };
    expect(slashMenuReduce(state, { kind: "escape" }, 5)).toEqual({ selectedIndex: 1, dismissed: true });
  });

  it("clamps an out-of-range selectedIndex when the list shrinks", () => {
    const state = { ...base, selectedIndex: 5 };
    expect(slashMenuReduce(state, { kind: "select" }, 2)).toEqual({ ...base, selectedIndex: 1 });
  });

  it("is a no-op on select when selectedIndex is already valid", () => {
    const state = { selectedIndex: 1, dismissed: false };
    expect(slashMenuReduce(state, { kind: "select" }, 5)).toEqual(state);
  });

  it("resets selectedIndex to 0 on down/up when the item count is zero", () => {
    expect(slashMenuReduce({ ...base, selectedIndex: 3 }, { kind: "down" }, 0)).toEqual({
      ...base,
      selectedIndex: 0,
    });
    expect(slashMenuReduce({ ...base, selectedIndex: 3 }, { kind: "up" }, 0)).toEqual({
      ...base,
      selectedIndex: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Registry invariants
// ─────────────────────────────────────────────────────────────────────────

describe("SLASH_COMMANDS registry invariants", () => {
  it("has the exact §2 name/order pinned", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      "Plan mode",
      // Taskana 4704 §3.8: /orchestrate sits right after plan-mode (the
      // orchestration posture's nearest neighbor).
      "Orchestrate",
      "Mode",
      "Model",
      "Compact",
      "New task",
      "Tasks",
      "Git changes",
      "Terminal",
      "MCP",
      "Skills",
      // Taskana 4704 §3.9: /roles deep-links to the Roles settings pane.
      "Roles",
      "Plugins",
      "Settings",
    ]);
  });

  it("Taskana 4704: the Orchestrate row sits at index 1 — after plan-mode, before Mode", () => {
    expect(SLASH_COMMANDS[1]!.id).toBe("orchestrate");
    expect(SLASH_COMMANDS[1]!.run).toEqual({ kind: "orchestrate_submit" });
    expect(SLASH_COMMANDS[1]!.description(ctx())).toBe("Delegate <task> to child agents in the background");
    // Same not-ready gate as plan-mode (TASK.37 posture: the host silently
    // drops a busy/absent toggle; ready is the sole renderer gate).
    expect(SLASH_COMMANDS[1]!.enabled(ctx({ ready: false }))).toBe(false);
    expect(SLASH_COMMANDS[1]!.enabled(ctx({ ready: true }))).toBe(true);
    // Core-only: set_orchestrate is rejected without supportsCorePermissions.
    expect(SLASH_COMMANDS[1]!.visible(ctx({ supportsCorePermissions: true }))).toBe(true);
    expect(SLASH_COMMANDS[1]!.visible(ctx({ supportsCorePermissions: false }))).toBe(false);
  });

  it("TASK.146: the Compact row sits at index 4 — last in the core cluster, before the common one", () => {
    // The module doc declares this array's order LAW ("rank ties among
    // commands break by this array's order"), so the index is the pin.
    // Taskana 4704 §3.8 moved it one slot down (Orchestrate inserted at 1).
    expect(SLASH_COMMANDS[4]!.id).toBe("compact");
    expect(SLASH_COMMANDS[4]!.name).toBe("Compact");
    // TASK.92: routed through the engine's own native compactNow (Claude has
    // one now — the allowlisted /compact passthrough), not a core-only control.
    expect(SLASH_COMMANDS[4]!.source).toBe("engine");
    expect(SLASH_COMMANDS[4]!.run).toEqual({ kind: "compact_now" });
    expect(SLASH_COMMANDS[4]!.icon).toBe("compact");
    expect(SLASH_COMMANDS[4]!.description(ctx())).toBe("Summarize the conversation to free context");
    // Its neighbours are what make it "last in the core cluster".
    expect(SLASH_COMMANDS[3]!.id).toBe("model");
    expect(SLASH_COMMANDS[5]!.id).toBe("new-task");
  });

  it("TASK.92: the Compact row is visible iff supportsManualCompact (Claude yes, codex no), enabled still keyed to modelDisabled", () => {
    const compact = SLASH_COMMANDS.find((command) => command.id === "compact")!;
    // Visible for core-shaped ctx (default) and Claude (capability true)...
    expect(compact.visible(ctx())).toBe(true);
    expect(compact.visible(ctx({ supportsManualCompact: true }))).toBe(true);
    // ...hidden for a codex-shaped ctx (no user-triggerable compaction pinned).
    expect(compact.visible(ctx({ supportsManualCompact: false }))).toBe(false);
    // The enabled predicate is untouched by TASK.92.
    expect(compact.enabled(ctx({ modelDisabled: true }))).toBe(false);
    expect(compact.enabled(ctx({ modelDisabled: false }))).toBe(true);
    // And the full filter path hides the row entirely when the capability is off.
    const hidden = filterSlashItems(SLASH_COMMANDS, [], "com", ctx({ supportsManualCompact: false }));
    expect(hidden.find((item) => item.name === "Compact")).toBeUndefined();
    const shown = filterSlashItems(SLASH_COMMANDS, [], "com", ctx({ supportsManualCompact: true }));
    expect(shown.find((item) => item.name === "Compact")).toBeDefined();
  });

  it("TASK.146: the Compact row is gray for exactly the Model row's not-truly-idle window", () => {
    const compact = SLASH_COMMANDS.find((command) => command.id === "compact")!;
    expect(compact.enabled(ctx({ modelDisabled: true }))).toBe(false);
    expect(compact.enabled(ctx({ modelDisabled: false }))).toBe(true);

    const disabled = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ modelDisabled: true }));
    expect(disabled.find((item) => item.name === "Compact")!.disabled).toBe(true);
    const enabled = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ modelDisabled: false }));
    expect(enabled.find((item) => item.name === "Compact")!.disabled).toBe(false);
  });

  it("has unique ids", () => {
    const ids = SLASH_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes the window-event identifiers W2 must reuse verbatim", () => {
    expect(FOCUS_MODE_MENU_EVENT).toBe("anycode:focus-mode-menu");
    expect(FOCUS_MODEL_PILL_EVENT).toBe("anycode:focus-model-pill");
  });

  it("every SlashRunIntent kind is handled by an exhaustive switch (compile-time + runtime)", () => {
    function intentKindLabel(intent: SlashRunIntent): string {
      switch (intent.kind) {
        case "set_mode_toggle":
          return "set_mode_toggle";
        case "window_event":
          return `window_event:${intent.event}`;
        case "run_action":
          return `run_action:${intent.action}`;
        case "store_git_panel":
          return "store_git_panel";
        case "compact_now":
          return "compact_now";
        case "orchestrate_submit":
          return "orchestrate_submit";
        case "settings_pane":
          return `settings_pane:${intent.pane}`;
        case "insert":
          return `insert:${intent.text}`;
        default:
          return assertNever(intent);
      }
    }

    const sampleIntents: SlashRunIntent[] = [
      ...SLASH_COMMANDS.map((c) => c.run),
      { kind: "insert", text: "$example " },
    ];
    const seenKinds = new Set(sampleIntents.map((intent) => intent.kind));
    // all 8 SlashRunIntent kinds are represented across the registry + the
    // manually-constructed "insert" sample (skills produce it dynamically).
    expect(seenKinds).toEqual(
      new Set([
        "set_mode_toggle",
        "window_event",
        "run_action",
        "store_git_panel",
        "settings_pane",
        "insert",
        "compact_now",
        "orchestrate_submit",
      ])
    );
    for (const intent of sampleIntents) {
      expect(() => intentKindLabel(intent)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Capability gating — no dead actions (design TASK.40 §2(f))
// ─────────────────────────────────────────────────────────────────────────

describe("SLASH_COMMANDS capability gating — no dead actions (design TASK.40 §2(f))", () => {
  /** Every named gate false — mirrors a Codex session before B2 wires model selection. */
  const codexShapedCtx = ctx({
    supportsCorePermissions: false,
    supportsModelSelection: false,
    supportsManualCompact: false,
    shellGitReadOnly: false,
    shellTerminal: false,
  });

  it("hides every core-only command (its target control isn't rendered) when the engine lacks the matching capability", () => {
    const names = filterSlashItems(SLASH_COMMANDS, [], "", codexShapedCtx).map((item) => item.name);
    expect(names).not.toContain("Plan mode");
    expect(names).not.toContain("Mode");
    expect(names).not.toContain("Model");
  });

  it("hides every shell-owned command when its named shell capability is false", () => {
    const names = filterSlashItems(SLASH_COMMANDS, [], "", codexShapedCtx).map((item) => item.name);
    expect(names).not.toContain("Git changes");
    expect(names).not.toContain("Terminal");
  });

  it("keeps engine-independent common commands visible regardless of engine/shell capabilities", () => {
    const names = filterSlashItems(SLASH_COMMANDS, [], "", codexShapedCtx).map((item) => item.name);
    expect(names).toEqual(["New task", "Tasks", "MCP", "Skills", "Roles", "Plugins", "Settings"]);
  });

  it("TASK.146/TASK.92: hides Compact on a codex-shaped profile (no compactNow) — the list a codex boot sees stays byte-identical", () => {
    const names = filterSlashItems(SLASH_COMMANDS, [], "", codexShapedCtx).map((item) => item.name);
    expect(names).not.toContain("Compact");
    expect(names).toEqual(["New task", "Tasks", "MCP", "Skills", "Roles", "Plugins", "Settings"]);
    // Not even by query: a codex boot cannot reach the row at all.
    expect(filterSlashItems(SLASH_COMMANDS, [], "co", codexShapedCtx)).toEqual([]);
  });

  it("TASK.92: supportsManualCompact is the gate on Compact — supportsCorePermissions off (a Claude boot) still SHOWS it", () => {
    // A Claude session: no core permissions, but a real native compactNow —
    // the row must be there (that is the whole TASK.92 change).
    const corePermissionsOff = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ supportsCorePermissions: false })).map(
      (item) => item.name,
    );
    expect(corePermissionsOff).toContain("Compact");
    expect(corePermissionsOff).toContain("Model");

    const modelSelectionOff = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ supportsModelSelection: false })).map(
      (item) => item.name,
    );
    expect(modelSelectionOff).toContain("Compact");
    expect(modelSelectionOff).not.toContain("Model");

    // Only the manual-compact capability itself hides it.
    const manualCompactOff = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ supportsManualCompact: false })).map(
      (item) => item.name,
    );
    expect(manualCompactOff).not.toContain("Compact");
  });

  it("shows the full registry once every named capability is available (core-shaped ctx, the pre-TASK.40 default)", () => {
    expect(filterSlashItems(SLASH_COMMANDS, [], "", ctx())).toHaveLength(SLASH_COMMANDS.length);
  });

  it("each named gate independently hides only its own command(s), not the rest of the registry", () => {
    const onlyCorePermissionsOff = filterSlashItems(
      SLASH_COMMANDS,
      [],
      "",
      ctx({ supportsCorePermissions: false }),
    ).map((item) => item.name);
    expect(onlyCorePermissionsOff).not.toContain("Plan mode");
    expect(onlyCorePermissionsOff).not.toContain("Mode");
    expect(onlyCorePermissionsOff).toEqual(
      expect.arrayContaining(["Model", "New task", "Tasks", "Git changes", "Terminal", "MCP", "Skills", "Roles", "Plugins", "Settings"]),
    );

    const onlyGitReadOnlyOff = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ shellGitReadOnly: false })).map(
      (item) => item.name,
    );
    expect(onlyGitReadOnlyOff).not.toContain("Git changes");
    expect(onlyGitReadOnlyOff).toContain("Terminal");
    expect(onlyGitReadOnlyOff).toContain("Model");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// openSettingsAddConnection — the shared empty-menu action (Taskana 4237)
// ─────────────────────────────────────────────────────────────────────────

describe("openSettingsAddConnection", () => {
  /** Capture the CustomEvents the helper dispatches, without a DOM: node's vitest env has no `window`, so the helper's call-time `window` is stubbed. */
  function capture(): Array<{ type: string; detail: unknown }> {
    const events: Array<{ type: string; detail: unknown }> = [];
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: Event) => {
        events.push({ type: event.type, detail: (event as CustomEvent).detail });
        return true;
      },
    };
    try {
      openSettingsAddConnection();
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
    return events;
  }

  it("dispatches the run-action 'settings.open' FIRST, then the dedicated add-connection event", () => {
    expect(capture()).toEqual([
      { type: RUN_ACTION_EVENT, detail: "settings.open" },
      { type: SETTINGS_ADD_CONNECTION_EVENT, detail: null },
    ]);
  });

  it("is a DISTINCT event from the pane-select seam (so the dialog can retain the request)", () => {
    expect(SETTINGS_ADD_CONNECTION_EVENT).not.toBe(SETTINGS_SELECT_PANE_EVENT);
  });
});

// ── Taskana 4732 S1-C: /plugins opens Settings → Plugins ──

describe("/plugins command (Taskana 4732 S1-C)", () => {
  it("exists, is common-gated, and routes to the plugins settings pane", () => {
    const command = SLASH_COMMANDS.find((c) => c.id === "plugins");
    expect(command).toBeDefined();
    expect(command?.name).toBe("Plugins");
    expect(command?.run).toEqual({ kind: "settings_pane", pane: "plugins" });
    expect(command?.source).toBe("common");
    expect(command?.visible(ctx())).toBe(true);
    expect(command?.enabled(ctx())).toBe(true);
  });

  it("matches the /plug query", () => {
    const items = filterSlashItems(SLASH_COMMANDS, [], "plug", ctx());
    expect(items.map((i) => i.name)).toContain("Plugins");
  });
});

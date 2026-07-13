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

    const runningItems = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ running: true }));
    const runningPlan = runningItems.find((item) => item.name === "Plan mode")!;
    expect(runningPlan.disabled).toBe(true);

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
      "Mode",
      "Model",
      "New task",
      "Tasks",
      "Git changes",
      "Terminal",
      "MCP",
      "Skills",
      "Settings",
    ]);
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
    // all 6 SlashRunIntent kinds are represented across the registry + the
    // manually-constructed "insert" sample (skills produce it dynamically).
    expect(seenKinds).toEqual(
      new Set(["set_mode_toggle", "window_event", "run_action", "store_git_panel", "settings_pane", "insert"])
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
    expect(names).toEqual(["New task", "Tasks", "MCP", "Skills", "Settings"]);
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
      expect.arrayContaining(["Model", "New task", "Tasks", "Git changes", "Terminal", "MCP", "Skills", "Settings"]),
    );

    const onlyGitReadOnlyOff = filterSlashItems(SLASH_COMMANDS, [], "", ctx({ shellGitReadOnly: false })).map(
      (item) => item.name,
    );
    expect(onlyGitReadOnlyOff).not.toContain("Git changes");
    expect(onlyGitReadOnlyOff).toContain("Terminal");
    expect(onlyGitReadOnlyOff).toContain("Model");
  });
});

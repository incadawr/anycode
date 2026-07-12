/**
 * Pure-logic tests for SkillsPane's exported helpers (P7.20/F23 W3, design
 * slice-P7.20-cut.md §5 W3 gate). Same `.test.ts`-only, no-jsdom rationale as
 * every other component test in this directory (vitest.config.ts runs
 * `environment: "node"`, no jsdom/testing-library in the tree — see
 * McpServersPane.test.ts's own docstring) — every behavior the cut's gate
 * asks for (group/badge split, toggle/delete/reveal wiring builders,
 * problems-strip label, import default-check logic incl. conversion+conflict
 * badges, create validation, plugin rows exposing no mutation affordances)
 * is exercised through the component's exported pure builders.
 */
import { describe, expect, it } from "vitest";
import type { SkillImportCandidateView, SkillRowView } from "../../../shared/skills-config.js";
import {
  blankSkillCreateFields,
  buildDeleteRequest,
  buildRevealRequest,
  buildSetEnabledRequest,
  buildSkillCreateRequest,
  buildSkillsImportApplyRequest,
  canManageSkillRow,
  canSubmitSkillCreate,
  defaultImportChecked,
  defaultImportSelection,
  filterSkillRows,
  filterSkillsBySource,
  findCreatedSkillRow,
  groupSkillImportCandidates,
  importConflictBadge,
  isValidSkillName,
  partitionSkillRows,
  problemsStripLabel,
  selectedImportIds,
  skillHarnessLabel,
  skillImportResultText,
  skillRefusalMessage,
  skillsImportFooterLabel,
  sortSkillRows,
  sourceKindBadgeLabel,
} from "./SkillsPane.js";

function row(overrides: Partial<SkillRowView> = {}): SkillRowView {
  return {
    name: "asana-tasks",
    description: "Use when the user asks to check tasks.",
    source: "user",
    sourceKind: "user",
    enabled: true,
    path: "/Users/x/.anycode/skills/asana-tasks/SKILL.md",
    ...overrides,
  };
}

function candidate(overrides: Partial<SkillImportCandidateView> = {}): SkillImportCandidateView {
  const base = {
    harness: "claude" as const,
    sourceDir: "/Users/x/.claude/skills/browser",
    name: "browser",
    description: "Browse the web.",
    compatible: true,
    needsConversion: false,
    conversionNotes: [] as string[],
    alreadyPresent: false,
    ...overrides,
  };
  return { id: `${base.harness} ${base.sourceDir} ${base.name}`, ...base };
}

// ── search / source filter / sort ──

describe("filterSkillRows", () => {
  it("is a case-insensitive substring filter over name AND description — no fuzzy matching", () => {
    const rows = [row({ name: "Asana-Tasks", description: "task board" }), row({ name: "codex-agent", description: "parallel review" })];
    expect(filterSkillRows(rows, "asan").map((r) => r.name)).toEqual(["Asana-Tasks"]);
    expect(filterSkillRows(rows, "review").map((r) => r.name)).toEqual(["codex-agent"]);
    expect(filterSkillRows(rows, "  ")).toHaveLength(2);
    expect(filterSkillRows(rows, "zzz")).toEqual([]);
  });
});

describe("filterSkillsBySource", () => {
  it("'all' passes every row through; a specific kind narrows to only that sourceKind", () => {
    const rows = [row({ name: "a", sourceKind: "project" }), row({ name: "b", sourceKind: "user" }), row({ name: "c", sourceKind: "plugin" })];
    expect(filterSkillsBySource(rows, "all")).toHaveLength(3);
    expect(filterSkillsBySource(rows, "project").map((r) => r.name)).toEqual(["a"]);
    expect(filterSkillsBySource(rows, "user").map((r) => r.name)).toEqual(["b"]);
    expect(filterSkillsBySource(rows, "plugin").map((r) => r.name)).toEqual(["c"]);
  });
});

describe("sortSkillRows", () => {
  it("sorts alphabetically by name (reference screenshot's a-z row order)", () => {
    const rows = [row({ name: "zcode" }), row({ name: "asana-tasks" }), row({ name: "imagegen" })];
    expect(sortSkillRows(rows).map((r) => r.name)).toEqual(["asana-tasks", "imagegen", "zcode"]);
  });
});

// ── grouping + badges (design §1.4/§1.5) ──

describe("partitionSkillRows", () => {
  it("combines project+user into 'personal', splits plugin into its own read-only group", () => {
    const rows = [
      row({ name: "a", sourceKind: "project" }),
      row({ name: "b", sourceKind: "user" }),
      row({ name: "c", sourceKind: "plugin" }),
    ];
    const { personal, plugin } = partitionSkillRows(rows);
    expect(personal.map((r) => r.name)).toEqual(["a", "b"]);
    expect(plugin.map((r) => r.name)).toEqual(["c"]);
  });
});

describe("sourceKindBadgeLabel", () => {
  it("maps sourceKind to the reference badge text (project=Workspace, user=Personal, plugin=Plugin)", () => {
    expect(sourceKindBadgeLabel("project")).toBe("Workspace");
    expect(sourceKindBadgeLabel("user")).toBe("Personal");
    expect(sourceKindBadgeLabel("plugin")).toBe("Plugin");
  });
});

// ── plugin rows expose NO mutation affordances (design §2 D1) ──

describe("canManageSkillRow (plugin read-only gate)", () => {
  it("refuses management of a plugin row", () => {
    expect(canManageSkillRow(row({ sourceKind: "plugin" }))).toBe(false);
  });

  it("allows management of project/user rows", () => {
    expect(canManageSkillRow(row({ sourceKind: "project" }))).toBe(true);
    expect(canManageSkillRow(row({ sourceKind: "user" }))).toBe(true);
  });
});

// ── problems strip (design §1.3: literal "N skill(s) failed to load" wording) ──

describe("problemsStripLabel", () => {
  it("uses the literal reference wording regardless of count (not pluralization-aware)", () => {
    expect(problemsStripLabel([])).toBe("0 skill(s) failed to load");
    expect(problemsStripLabel(["broken/SKILL.md: bad frontmatter"])).toBe("1 skill(s) failed to load");
    expect(problemsStripLabel(["a", "b", "c"])).toBe("3 skill(s) failed to load");
  });
});

// ── refusal messages ──

describe("skillRefusalMessage", () => {
  it("has a distinct, non-empty message per refusal reason", () => {
    const reasons = ["invalid", "no_workspace", "read_only_source", "not_found", "io_error"] as const;
    const messages = reasons.map((r) => skillRefusalMessage(r));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
    }
  });
});

// ── request builders (identity = name, NEVER a path — design §4 path custody) ──

describe("buildSetEnabledRequest / buildDeleteRequest / buildRevealRequest", () => {
  it("carry only tabId + name (+ enabled for the toggle) — structurally cannot smuggle a path", () => {
    const setEnabled = buildSetEnabledRequest("tab-1", row({ name: "asana-tasks", enabled: true }), false);
    expect(setEnabled).toEqual({ tabId: "tab-1", name: "asana-tasks", enabled: false });
    expect(Object.keys(setEnabled).sort()).toEqual(["enabled", "name", "tabId"]);

    const del = buildDeleteRequest("tab-1", "asana-tasks");
    expect(del).toEqual({ tabId: "tab-1", name: "asana-tasks" });
    expect("path" in del).toBe(false);

    const reveal = buildRevealRequest(undefined, "asana-tasks");
    expect(reveal).toEqual({ tabId: undefined, name: "asana-tasks" });
    expect("path" in reveal).toBe(false);
  });
});

// ── create form (design §2 D1: scaffold-only, name/description/scope, default Personal) ──

describe("isValidSkillName / SKILL_NAME_RE", () => {
  it("accepts alnum-leading names with -/_ , rejects everything else", () => {
    expect(isValidSkillName("asana-tasks")).toBe(true);
    expect(isValidSkillName("incadawr_node_db")).toBe(true);
    expect(isValidSkillName("9lives")).toBe(true);
    expect(isValidSkillName("-leading-dash")).toBe(false);
    expect(isValidSkillName("has space")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("__proto__")).toBe(false); // leading "_" fails the alnum-start rule (SKILL_NAME_RE) before any proto-guard is even relevant
  });
});

describe("blankSkillCreateFields", () => {
  it("defaults scope to Personal ('user') regardless of an active workspace tab (design §5 W3: 'default Personal')", () => {
    expect(blankSkillCreateFields()).toEqual({ name: "", description: "", scope: "user" });
  });
});

describe("canSubmitSkillCreate", () => {
  it("requires a valid name AND a non-empty description", () => {
    const base = blankSkillCreateFields();
    expect(canSubmitSkillCreate(base)).toBe(false);
    expect(canSubmitSkillCreate({ ...base, name: "srv" })).toBe(false);
    expect(canSubmitSkillCreate({ ...base, name: "srv", description: "  " })).toBe(false);
    expect(canSubmitSkillCreate({ ...base, name: "srv", description: "does a thing" })).toBe(true);
    expect(canSubmitSkillCreate({ ...base, name: "bad name", description: "does a thing" })).toBe(false);
  });
});

describe("buildSkillCreateRequest", () => {
  it("trims name/description and carries the chosen scope", () => {
    const fields = { name: "  my-skill  ", description: "  does a thing  ", scope: "project" as const };
    expect(buildSkillCreateRequest("tab-1", fields)).toEqual({
      tabId: "tab-1",
      scope: "project",
      name: "my-skill",
      description: "does a thing",
    });
  });
});

describe("findCreatedSkillRow", () => {
  it("finds the row matching the created name + scope-mapped sourceKind (project/user)", () => {
    const snapshot = {
      rows: [row({ name: "other", sourceKind: "user" }), row({ name: "my-skill", sourceKind: "project", path: "/ws/.anycode/skills/my-skill/SKILL.md" })],
      problems: [],
    };
    const found = findCreatedSkillRow(snapshot, { name: "my-skill", description: "x", scope: "project" });
    expect(found?.path).toBe("/ws/.anycode/skills/my-skill/SKILL.md");
  });

  it("maps scope 'user' to sourceKind 'user' (Personal)", () => {
    const snapshot = { rows: [row({ name: "my-skill", sourceKind: "user", path: "/home/.anycode/skills/my-skill/SKILL.md" })], problems: [] };
    const found = findCreatedSkillRow(snapshot, { name: "my-skill", description: "x", scope: "user" });
    expect(found?.path).toBe("/home/.anycode/skills/my-skill/SKILL.md");
  });

  it("returns undefined when no row matches (defensive — should not happen after a successful create)", () => {
    const snapshot = { rows: [row({ name: "other", sourceKind: "user" })], problems: [] };
    expect(findCreatedSkillRow(snapshot, { name: "missing", description: "x", scope: "user" })).toBeUndefined();
  });
});

// ── import dialog: default-check logic incl. conversion+conflict badges (design §2 D2/D3) ──

describe("defaultImportChecked / defaultImportSelection", () => {
  it("default-checks a compatible, not-already-present candidate", () => {
    expect(defaultImportChecked(candidate())).toBe(true);
  });

  it("does NOT default-check an already-present candidate (conflict badge instead)", () => {
    expect(defaultImportChecked(candidate({ alreadyPresent: true }))).toBe(false);
  });

  it("does NOT default-check an incompatible candidate", () => {
    expect(defaultImportChecked(candidate({ compatible: false }))).toBe(false);
  });

  it("DOES default-check a candidate that merely needsConversion (compatible, not present)", () => {
    expect(defaultImportChecked(candidate({ needsConversion: true, conversionNotes: ["dropped: metadata"] }))).toBe(true);
  });

  it("defaultImportSelection applies the same rule per candidate identity", () => {
    const fresh = candidate({ name: "fresh" });
    const conflict = candidate({ name: "conflict", alreadyPresent: true });
    const incompatible = candidate({ name: "bad", compatible: false });
    const selection = defaultImportSelection([fresh, conflict, incompatible]);
    expect(selection).toEqual({ [fresh.id]: true, [conflict.id]: false, [incompatible.id]: false });
  });
});

describe("importConflictBadge", () => {
  it("renders the literal '-2' suffix hint from the candidate's own name (design §5 W3 wording)", () => {
    expect(importConflictBadge(candidate({ name: "alpha" }))).toBe("already exists — will import as alpha-2");
  });
});

describe("groupSkillImportCandidates", () => {
  it("groups by harness+sourceDir, first-seen order", () => {
    const groups = groupSkillImportCandidates([
      candidate({ harness: "claude", sourceDir: "~/.claude/skills", name: "a" }),
      candidate({ harness: "codex", sourceDir: "~/.codex/skills", name: "b" }),
      candidate({ harness: "claude", sourceDir: "~/.claude/skills", name: "c" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.candidates.map((c) => c.name)).toEqual(["a", "c"]);
    expect(groups[1]!.candidates.map((c) => c.name)).toEqual(["b"]);
  });
});

describe("skillHarnessLabel", () => {
  it("has a distinct label per harness kind", () => {
    const kinds = ["claude", "claude-project", "codex", "zcode", "claude-plugin"] as const;
    const labels = kinds.map(skillHarnessLabel);
    expect(new Set(labels).size).toBe(kinds.length);
  });
});

describe("selectedImportIds / skillsImportFooterLabel", () => {
  it("collects only checked identities and singularizes the footer count (design §5 W3 / F5#1b: 'enabled in newly started tasks', D2 default-enabled)", () => {
    const selection = { a: true, b: false, c: true };
    expect(selectedImportIds(selection).sort()).toEqual(["a", "c"]);
    expect(skillsImportFooterLabel({ a: true })).toBe("Import 1 skill — enabled in newly started tasks");
    expect(skillsImportFooterLabel(selection)).toBe("Import 2 skills — enabled in newly started tasks");
    expect(skillsImportFooterLabel({})).toBe("Import 0 skills — enabled in newly started tasks");
  });
});

describe("buildSkillsImportApplyRequest", () => {
  it("carries tabId + scope + only the checked identities", () => {
    const request = buildSkillsImportApplyRequest("tab-1", "user", { a: true, b: false });
    expect(request).toEqual({ tabId: "tab-1", scope: "user", ids: ["a"] });
  });
});

describe("skillImportResultText", () => {
  it("distinguishes skipped reasons / plain-applied / suffixed / converted", () => {
    expect(skillImportResultText({ id: "1", name: "a", applied: false, suffixed: false, converted: false, skipped: "incompatible", notes: [] })).toBe(
      "a: skipped — incompatible",
    );
    expect(skillImportResultText({ id: "2", name: "b", applied: false, suffixed: false, converted: false, skipped: "unsafe_name", notes: [] })).toBe(
      "b: skipped — invalid name",
    );
    expect(skillImportResultText({ id: "3", name: "c", applied: false, suffixed: false, converted: false, skipped: "io_error", notes: [] })).toBe(
      "c: skipped — couldn't write",
    );
    expect(skillImportResultText({ id: "4", name: "d", applied: true, suffixed: false, converted: false, notes: [] })).toBe("d: imported");
    expect(skillImportResultText({ id: "5", name: "d-2", applied: true, suffixed: true, converted: false, notes: [] })).toBe(
      "d-2: imported (renamed to avoid a conflict)",
    );
    expect(skillImportResultText({ id: "6", name: "e", applied: true, suffixed: false, converted: true, notes: [] })).toBe("e: imported (converted)");
    expect(skillImportResultText({ id: "7", name: "e-2", applied: true, suffixed: true, converted: true, notes: [] })).toBe(
      "e-2: imported (renamed to avoid a conflict, converted)",
    );
  });
});

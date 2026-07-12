/**
 * Pure-logic tests for SubagentsPane's exported helpers (P7.21/F21 W3, design
 * slice-P7.21-cut.md §4 W3 gate). Same `.test.ts`-only, no-jsdom rationale as
 * every other component test in this directory (vitest.config.ts runs
 * `environment: "node"`, no jsdom/testing-library in the tree — see
 * SkillsPane.test.ts's own docstring) — every behavior the cut's gate asks for
 * (group/badge split, built-in rows exposing NO mutation affordance, editor
 * validation surfacing, preview request shape, delete/reveal/save request
 * custody) is exercised through the component's exported pure builders.
 */
import { describe, expect, it } from "vitest";
import type { SubagentProfileDraft, SubagentRowView, SubagentsRefusalReason } from "../../../shared/subagents-config.js";
import {
  blankSubagentEditorFields,
  builtinIdLine,
  buildCreateRequest,
  buildDeleteRequest,
  buildPreviewRequest,
  buildReadRequest,
  buildRevealRequest,
  buildSaveRequest,
  buildSubagentDraft,
  canManageSubagentRow,
  canSubmitSubagentDraft,
  filterSubagentRows,
  filterSubagentsBySource,
  firstRevealableRow,
  formatEffectiveToolsLine,
  isValidSubagentName,
  partitionSubagentRows,
  problemsStripLabel,
  SUBAGENT_TOOL_CHOICES,
  subagentEditorFieldsEqual,
  subagentEditorFieldsFromDraft,
  subagentRefusalMessage,
  sortSubagentRows,
  toggleSubagentToolChip,
  userRowSourceBadgeLabel,
  utf8ByteLength,
} from "./SubagentsPane.js";

function row(overrides: Partial<SubagentRowView> = {}): SubagentRowView {
  return {
    name: "general-purpose",
    description: "Full-tool subagent under the parent's permission gate.",
    toolsBadge: "All tools",
    toolCount: 9,
    source: "builtin",
    sourceKind: "builtin",
    editable: false,
    ...overrides,
  };
}

// ── search / source filter / sort ──

describe("filterSubagentRows", () => {
  it("is a case-insensitive substring filter over name AND description — no fuzzy matching", () => {
    const rows = [row({ name: "researcher", description: "digs through docs" }), row({ name: "summarizer", description: "condenses code" })];
    expect(filterSubagentRows(rows, "resear").map((r) => r.name)).toEqual(["researcher"]);
    expect(filterSubagentRows(rows, "condenses").map((r) => r.name)).toEqual(["summarizer"]);
    expect(filterSubagentRows(rows, "  ")).toHaveLength(2);
    expect(filterSubagentRows(rows, "zzz")).toEqual([]);
  });
});

describe("filterSubagentsBySource", () => {
  it("'all' passes every row through; a specific kind narrows to only that sourceKind", () => {
    const rows = [
      row({ name: "a", sourceKind: "builtin" }),
      row({ name: "b", sourceKind: "project", editable: true }),
      row({ name: "c", sourceKind: "user", editable: true }),
      row({ name: "d", sourceKind: "plugin" }),
    ];
    expect(filterSubagentsBySource(rows, "all")).toHaveLength(4);
    expect(filterSubagentsBySource(rows, "builtin").map((r) => r.name)).toEqual(["a"]);
    expect(filterSubagentsBySource(rows, "project").map((r) => r.name)).toEqual(["b"]);
    expect(filterSubagentsBySource(rows, "user").map((r) => r.name)).toEqual(["c"]);
    expect(filterSubagentsBySource(rows, "plugin").map((r) => r.name)).toEqual(["d"]);
  });
});

describe("sortSubagentRows", () => {
  it("sorts alphabetically by name (User/Plugin group convention)", () => {
    const rows = [row({ name: "zeta" }), row({ name: "alpha" }), row({ name: "middle" })];
    expect(sortSubagentRows(rows).map((r) => r.name)).toEqual(["alpha", "middle", "zeta"]);
  });
});

// ── grouping + badges (design §1) ──

describe("partitionSubagentRows", () => {
  it("splits builtin / (project+user combined as 'user') / plugin into their three groups, preserving input order (no implicit sort)", () => {
    const rows = [
      row({ name: "explore", sourceKind: "builtin" }),
      row({ name: "general-purpose", sourceKind: "builtin" }),
      row({ name: "a", sourceKind: "project", editable: true }),
      row({ name: "b", sourceKind: "user", editable: true }),
      row({ name: "c", sourceKind: "plugin" }),
    ];
    const { builtin, user, plugin } = partitionSubagentRows(rows);
    expect(builtin.map((r) => r.name)).toEqual(["explore", "general-purpose"]);
    expect(user.map((r) => r.name)).toEqual(["a", "b"]);
    expect(plugin.map((r) => r.name)).toEqual(["c"]);
  });
});

describe("userRowSourceBadgeLabel", () => {
  it("maps project/user to the Workspace/Personal reference labels", () => {
    expect(userRowSourceBadgeLabel("project")).toBe("Workspace");
    expect(userRowSourceBadgeLabel("user")).toBe("Personal");
  });
});

// ── built-in rows expose NO mutation affordance (ref-PNG §1 law) ──

describe("canManageSubagentRow (built-in/plugin read-only gate)", () => {
  it("refuses management of a builtin row", () => {
    expect(canManageSubagentRow(row({ sourceKind: "builtin", editable: false }))).toBe(false);
  });

  it("refuses management of a plugin row", () => {
    expect(canManageSubagentRow(row({ sourceKind: "plugin", editable: false }))).toBe(false);
  });

  it("allows management of project/user rows", () => {
    expect(canManageSubagentRow(row({ sourceKind: "project", editable: true }))).toBe(true);
    expect(canManageSubagentRow(row({ sourceKind: "user", editable: true }))).toBe(true);
  });
});

describe("builtinIdLine", () => {
  it("renders the literal 'built-in:<name>' id line (ref-PNG §1.3), independent of the internal 'builtin' sourceKind spelling", () => {
    expect(builtinIdLine("general-purpose")).toBe("built-in:general-purpose");
    expect(builtinIdLine("explore")).toBe("built-in:explore");
  });
});

// ── problems strip (design §1 point 4: literal "N profile(s) failed to load" wording) ──

describe("problemsStripLabel", () => {
  it("uses the literal reference wording regardless of count (not pluralization-aware)", () => {
    expect(problemsStripLabel([])).toBe("0 profile(s) failed to load");
    expect(problemsStripLabel(["broken.md: bad frontmatter"])).toBe("1 profile(s) failed to load");
    expect(problemsStripLabel(["a", "b", "c"])).toBe("3 profile(s) failed to load");
  });
});

// ── refusal messages (7-reason surface, design §2-D6) ──

describe("subagentRefusalMessage", () => {
  it("has a distinct, non-empty message per refusal reason", () => {
    const reasons: SubagentsRefusalReason[] = [
      "invalid",
      "no_workspace",
      "read_only_source",
      "not_found",
      "io_error",
      "reserved_name",
      "validation_failed",
    ];
    const messages = reasons.map((r) => subagentRefusalMessage(r));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
    }
  });
});

// ── firstRevealableRow (header "open-folder" target — no dedicated reveal-root channel) ──

describe("firstRevealableRow", () => {
  it("picks the first editable row, skipping builtin/plugin", () => {
    const rows = [row({ name: "a", sourceKind: "builtin", editable: false }), row({ name: "b", sourceKind: "user", editable: true })];
    expect(firstRevealableRow(rows)?.name).toBe("b");
  });

  it("returns undefined when nothing is editable", () => {
    expect(firstRevealableRow([row({ sourceKind: "builtin", editable: false })])).toBeUndefined();
  });
});

// ── request builders (identity = name+sourceKind, NEVER a path — design §2-D7 path custody) ──

describe("buildReadRequest / buildDeleteRequest / buildRevealRequest", () => {
  it("carry only tabId + name + sourceKind — structurally cannot smuggle a path", () => {
    const r = row({ name: "researcher", sourceKind: "user", path: "/home/.anycode/agents/researcher.md" });

    const read = buildReadRequest("tab-1", r);
    expect(read).toEqual({ tabId: "tab-1", name: "researcher", sourceKind: "user" });
    expect("path" in read).toBe(false);

    const del = buildDeleteRequest("tab-1", r);
    expect(del).toEqual({ tabId: "tab-1", name: "researcher", sourceKind: "user" });
    expect("path" in del).toBe(false);

    const reveal = buildRevealRequest(undefined, r);
    expect(reveal).toEqual({ tabId: undefined, name: "researcher", sourceKind: "user" });
    expect("path" in reveal).toBe(false);
  });
});

describe("buildSaveRequest", () => {
  it("carries the EXISTING identity (name+sourceKind) plus the new draft — a rename lives entirely inside draft.name", () => {
    const draft: SubagentProfileDraft = { name: "researcher-2", description: "renamed", body: "x" };
    const req = buildSaveRequest("tab-1", "researcher", "user", draft);
    expect(req).toEqual({ tabId: "tab-1", name: "researcher", sourceKind: "user", draft });
  });
});

describe("buildCreateRequest / buildPreviewRequest", () => {
  it("create carries tabId+scope+draft; preview carries only the draft (no identity at all)", () => {
    const draft: SubagentProfileDraft = { name: "new-one", description: "d", body: "b" };
    expect(buildCreateRequest("tab-1", "project", draft)).toEqual({ tabId: "tab-1", scope: "project", draft });
    const preview = buildPreviewRequest(draft);
    expect(preview).toEqual({ draft });
    expect(Object.keys(preview)).toEqual(["draft"]);
  });
});

// ── editor: name/tools validation, draft round-trip, dirty check ──

describe("isValidSubagentName", () => {
  it("accepts alnum-leading names with -/_ , rejects everything else", () => {
    expect(isValidSubagentName("researcher")).toBe(true);
    expect(isValidSubagentName("code_reviewer-2")).toBe(true);
    expect(isValidSubagentName("9lives")).toBe(true);
    expect(isValidSubagentName("-leading-dash")).toBe(false);
    expect(isValidSubagentName("has space")).toBe(false);
    expect(isValidSubagentName("")).toBe(false);
  });
});

describe("SUBAGENT_TOOL_CHOICES", () => {
  it("never offers the two spawn-locked tools (Agent/Workflow) — selecting either always fails save-time validation", () => {
    expect(SUBAGENT_TOOL_CHOICES).not.toContain("Agent");
    expect(SUBAGENT_TOOL_CHOICES).not.toContain("Workflow");
  });

  it("does offer Skill (not a spawn tool, design 3.3-R8) and the 9 general-purpose baseline tools", () => {
    for (const tool of ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch", "Skill"]) {
      expect(SUBAGENT_TOOL_CHOICES).toContain(tool);
    }
  });
});

describe("blankSubagentEditorFields / subagentEditorFieldsFromDraft round trip", () => {
  it("blank fields start with no tools selected (inherit-all default) and a non-empty template body", () => {
    const blank = blankSubagentEditorFields();
    expect(blank).toEqual({ name: "", description: "", tools: [], body: blank.body });
    expect(blank.body.length).toBeGreaterThan(0);
  });

  it("a draft with explicit tools round-trips through fields->draft byte-stably (name/description trimmed, tools preserved)", () => {
    const draft: SubagentProfileDraft = { name: "researcher", description: "digs", tools: ["Read", "Grep"], body: "You research things." };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields).toEqual({ name: "researcher", description: "digs", tools: ["Read", "Grep"], body: "You research things." });
    expect(buildSubagentDraft(fields)).toEqual(draft);
  });

  it("a draft with NO explicit tools (absent field) maps to an empty tools array (inherit)", () => {
    const draft: SubagentProfileDraft = { name: "researcher", description: "digs", body: "x" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.tools).toEqual([]);
  });
});

describe("buildSubagentDraft", () => {
  it("omits 'tools' entirely when the selection is empty — matches SubagentProfileDraft's inherit-baseline semantics", () => {
    const draft = buildSubagentDraft({ name: "  a  ", description: "  b  ", tools: [], body: "c" });
    expect(draft).toEqual({ name: "a", description: "b", body: "c" });
    expect("tools" in draft).toBe(false);
  });

  it("includes 'tools' when at least one chip is selected", () => {
    const draft = buildSubagentDraft({ name: "a", description: "b", tools: ["Read"], body: "c" });
    expect(draft).toEqual({ name: "a", description: "b", tools: ["Read"], body: "c" });
  });
});

describe("toggleSubagentToolChip", () => {
  it("adds an unselected tool, removes a selected one", () => {
    const base = { name: "a", description: "b", tools: ["Read"], body: "c" };
    expect(toggleSubagentToolChip(base, "Grep").tools).toEqual(["Read", "Grep"]);
    expect(toggleSubagentToolChip(base, "Read").tools).toEqual([]);
  });
});

describe("canSubmitSubagentDraft", () => {
  const valid = { name: "researcher", description: "digs through docs", tools: [], body: "short body" };

  it("requires a valid name, a non-empty single-line description, and a body under the byte cap", () => {
    expect(canSubmitSubagentDraft(valid)).toBe(true);
    expect(canSubmitSubagentDraft({ ...valid, name: "" })).toBe(false);
    expect(canSubmitSubagentDraft({ ...valid, name: "bad name" })).toBe(false);
    expect(canSubmitSubagentDraft({ ...valid, description: "" })).toBe(false);
    expect(canSubmitSubagentDraft({ ...valid, description: "  " })).toBe(false);
    expect(canSubmitSubagentDraft({ ...valid, description: "line one\nline two" })).toBe(false);
  });

  it("refuses a body over the 32768-byte cap (design §2-D7: refuse, never truncate)", () => {
    expect(canSubmitSubagentDraft({ ...valid, body: "x".repeat(32_768) })).toBe(true);
    expect(canSubmitSubagentDraft({ ...valid, body: "x".repeat(32_769) })).toBe(false);
  });
});

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes, not JS string length (multi-byte chars cost more than 1)", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
  });
});

describe("subagentEditorFieldsEqual (dirty check)", () => {
  const base = { name: "a", description: "b", tools: ["Read", "Grep"], body: "c" };

  it("is true for an identical value, including a reordered tool set (order-insensitive)", () => {
    expect(subagentEditorFieldsEqual(base, { ...base })).toBe(true);
    expect(subagentEditorFieldsEqual(base, { ...base, tools: ["Grep", "Read"] })).toBe(true);
  });

  it("is false when any scalar field or the tool SET differs", () => {
    expect(subagentEditorFieldsEqual(base, { ...base, name: "z" })).toBe(false);
    expect(subagentEditorFieldsEqual(base, { ...base, description: "z" })).toBe(false);
    expect(subagentEditorFieldsEqual(base, { ...base, body: "z" })).toBe(false);
    expect(subagentEditorFieldsEqual(base, { ...base, tools: ["Read"] })).toBe(false);
    expect(subagentEditorFieldsEqual(base, { ...base, tools: ["Read", "Grep", "Bash"] })).toBe(false);
  });
});

describe("formatEffectiveToolsLine", () => {
  it("joins the effective tools, or reports 'none' for an empty list", () => {
    expect(formatEffectiveToolsLine(["Read", "Grep"])).toBe("Effective tools: Read, Grep");
    expect(formatEffectiveToolsLine([])).toBe("Effective tools: none");
  });
});

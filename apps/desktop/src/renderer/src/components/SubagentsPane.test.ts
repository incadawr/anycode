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
import type { EngineModelChoice } from "../../../shared/protocol.js";
import type { SubagentProfileDraft, SubagentRowView, SubagentsRefusalReason } from "../../../shared/subagents-config.js";
import {
  blankSubagentEditorFields,
  buildModelSelectOptions,
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
  engineModelChoicesToModelList,
  filterSubagentRows,
  filterSubagentsBySource,
  firstRevealableRow,
  formatEffectiveToolsLine,
  isValidSubagentName,
  partitionSubagentRows,
  problemsStripLabel,
  resolveSubagentModelOptions,
  SUBAGENT_ENGINE_OPTIONS,
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
    expect(blank).toEqual({ name: "", description: "", tools: [], body: blank.body, model: "", engine: "" });
    expect(blank.body.length).toBeGreaterThan(0);
  });

  it("a draft with explicit tools round-trips through fields->draft byte-stably (name/description trimmed, tools preserved)", () => {
    const draft: SubagentProfileDraft = { name: "researcher", description: "digs", tools: ["Read", "Grep"], body: "You research things." };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields).toEqual({
      name: "researcher",
      description: "digs",
      tools: ["Read", "Grep"],
      body: "You research things.",
      model: "",
      engine: "",
    });
    expect(buildSubagentDraft(fields)).toEqual(draft);
  });

  it("a draft with NO explicit tools (absent field) maps to an empty tools array (inherit)", () => {
    const draft: SubagentProfileDraft = { name: "researcher", description: "digs", body: "x" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.tools).toEqual([]);
  });

  // The editor rewrites the whole file from the draft it loaded, so a `model`
  // that survives the load but not the round trip is silently ERASED from disk
  // on the next save — the profile keeps its name and quietly starts inheriting
  // the parent's model. This pair pins both directions of that trip.
  it("carries a pinned model through load -> edit -> save unchanged", () => {
    const draft: SubagentProfileDraft = { name: "reviewer", description: "reviews", body: "b", model: "k3" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.model).toBe("k3");
    expect(buildSubagentDraft(fields)).toEqual(draft);
  });

  it("maps an absent model to an empty field, and an empty field back to an absent key (inherit stays inherit)", () => {
    const draft: SubagentProfileDraft = { name: "plain", description: "d", body: "b" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.model).toBe("");
    const rebuilt = buildSubagentDraft(fields);
    expect("model" in rebuilt).toBe(false);
  });

  it("clearing a pinned model drops the key entirely rather than writing a blank one", () => {
    const fields = { ...subagentEditorFieldsFromDraft({ name: "r", description: "d", body: "b", model: "k3" }), model: "   " };
    expect("model" in buildSubagentDraft(fields)).toBe(false);
  });

  // Same silent-erasure hazard as `model` above, now for the engine-selection
  // slice's second additive field.
  it("carries a pinned engine through load -> edit -> save unchanged, alongside a pinned model", () => {
    const draft: SubagentProfileDraft = { name: "reviewer", description: "reviews", body: "b", model: "k3", engine: "claude" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.engine).toBe("claude");
    expect(fields.model).toBe("k3");
    expect(buildSubagentDraft(fields)).toEqual(draft);
  });

  it("maps an absent engine to an empty field, and an empty field back to an absent key (inherit stays inherit)", () => {
    const draft: SubagentProfileDraft = { name: "plain", description: "d", body: "b" };
    const fields = subagentEditorFieldsFromDraft(draft);
    expect(fields.engine).toBe("");
    const rebuilt = buildSubagentDraft(fields);
    expect("engine" in rebuilt).toBe(false);
  });
});

describe("buildSubagentDraft", () => {
  it("omits 'tools' entirely when the selection is empty — matches SubagentProfileDraft's inherit-baseline semantics", () => {
    const draft = buildSubagentDraft({ name: "  a  ", description: "  b  ", tools: [], body: "c", model: "", engine: "" });
    expect(draft).toEqual({ name: "a", description: "b", body: "c" });
    expect("tools" in draft).toBe(false);
  });

  it("includes 'tools' when at least one chip is selected", () => {
    const draft = buildSubagentDraft({ name: "a", description: "b", tools: ["Read"], body: "c", model: "", engine: "" });
    expect(draft).toEqual({ name: "a", description: "b", tools: ["Read"], body: "c" });
  });

  it("includes 'engine' only when set — 'Same as parent' (\"\") omits the key entirely", () => {
    const inherited = buildSubagentDraft({ name: "a", description: "b", tools: [], body: "c", model: "", engine: "" });
    expect("engine" in inherited).toBe(false);
    const codex = buildSubagentDraft({ name: "a", description: "b", tools: [], body: "c", model: "", engine: "codex" });
    expect(codex).toEqual({ name: "a", description: "b", body: "c", engine: "codex" });
  });
});

describe("toggleSubagentToolChip", () => {
  it("adds an unselected tool, removes a selected one", () => {
    const base = { name: "a", description: "b", tools: ["Read"], body: "c", model: "", engine: "" as const };
    expect(toggleSubagentToolChip(base, "Grep").tools).toEqual(["Read", "Grep"]);
    expect(toggleSubagentToolChip(base, "Read").tools).toEqual([]);
  });
});

describe("canSubmitSubagentDraft", () => {
  const valid = { name: "researcher", description: "digs through docs", tools: [], body: "short body", model: "", engine: "" as const };

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

  it("accepts a blank model (inherit) and a well-formed id, refuses one the loader would reject", () => {
    expect(canSubmitSubagentDraft({ ...valid, model: "" })).toBe(true);
    expect(canSubmitSubagentDraft({ ...valid, model: "claude-opus-5" })).toBe(true);
    expect(canSubmitSubagentDraft({ ...valid, model: "anthropic/claude-3" })).toBe(true);
    expect(canSubmitSubagentDraft({ ...valid, model: "a model with spaces" })).toBe(false);
    expect(canSubmitSubagentDraft({ ...valid, model: "-leading-dash" })).toBe(false);
  });
});

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes, not JS string length (multi-byte chars cost more than 1)", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
  });
});

describe("subagentEditorFieldsEqual (dirty check)", () => {
  const base = { name: "a", description: "b", tools: ["Read", "Grep"], body: "c", model: "", engine: "" as const };

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

  // Save is gated on this dirty check, so a model-only edit that compares equal
  // would render an editable field whose changes can never be saved.
  it("is false when only the model differs, so a model-only edit can be saved", () => {
    expect(subagentEditorFieldsEqual(base, { ...base, model: "k3" })).toBe(false);
    expect(subagentEditorFieldsEqual({ ...base, model: "k3" }, { ...base, model: "" })).toBe(false);
  });

  // Same reasoning as the model-only case above, for the engine-selection slice.
  it("is false when only the engine differs, so an engine-only edit can be saved", () => {
    expect(subagentEditorFieldsEqual(base, { ...base, engine: "codex" })).toBe(false);
    expect(subagentEditorFieldsEqual({ ...base, engine: "codex" }, { ...base, engine: "claude" })).toBe(false);
    expect(subagentEditorFieldsEqual({ ...base, engine: "codex" }, { ...base, engine: "" })).toBe(false);
  });
});

describe("formatEffectiveToolsLine", () => {
  it("joins the effective tools, or reports 'none' for an empty list", () => {
    expect(formatEffectiveToolsLine(["Read", "Grep"])).toBe("Effective tools: Read, Grep");
    expect(formatEffectiveToolsLine([])).toBe("Effective tools: none");
  });
});

// ── engine + model selects (design: engine-selection slice) ──

describe("SUBAGENT_ENGINE_OPTIONS", () => {
  it("is the fixed 3-item list: inherit ('') first, then Codex, then Claude", () => {
    expect(SUBAGENT_ENGINE_OPTIONS).toEqual([
      { value: "", label: "Same as parent" },
      { value: "codex", label: "Codex" },
      { value: "claude", label: "Claude" },
    ]);
  });
});

describe("buildModelSelectOptions", () => {
  it("always puts the inherit option first, using the caller's label", () => {
    const options = buildModelSelectOptions([], "", "Same as parent");
    expect(options).toEqual([{ value: "", label: "Same as parent" }]);
  });

  it("lists every model, preferring its display name over the bare id", () => {
    const options = buildModelSelectOptions([{ id: "claude-opus-5" }, { id: "gpt-5", name: "GPT-5" }], "", "Default");
    expect(options).toEqual([
      { value: "", label: "Default" },
      { value: "claude-opus-5", label: "claude-opus-5" },
      { value: "gpt-5", label: "GPT-5" },
    ]);
  });

  it("appends the current value as its own option ONLY when it isn't already in the list — a hand-edited or stale saved model is never silently dropped", () => {
    const inList = buildModelSelectOptions([{ id: "claude-opus-5" }], "claude-opus-5", "Default");
    expect(inList).toEqual([{ value: "", label: "Default" }, { value: "claude-opus-5", label: "claude-opus-5" }]);

    const notInList = buildModelSelectOptions([{ id: "claude-opus-5" }], "some-custom-id", "Default");
    expect(notInList).toEqual([
      { value: "", label: "Default" },
      { value: "claude-opus-5", label: "claude-opus-5" },
      { value: "some-custom-id", label: "some-custom-id" },
    ]);
  });

  it("does not append an empty current value as a spurious option", () => {
    const options = buildModelSelectOptions([{ id: "claude-opus-5" }], "", "Default");
    expect(options).toEqual([{ value: "", label: "Default" }, { value: "claude-opus-5", label: "claude-opus-5" }]);
  });
});

describe("engineModelChoicesToModelList", () => {
  it("maps EngineModelChoice[] down to {id, name?}, using the label as the display name", () => {
    const choices: EngineModelChoice[] = [{ id: "gpt-5.1", label: "GPT-5.1" }, { id: "gpt-5-mini" }];
    expect(engineModelChoicesToModelList(choices)).toEqual([{ id: "gpt-5.1", name: "GPT-5.1" }, { id: "gpt-5-mini" }]);
  });

  it("maps an empty list to an empty list", () => {
    expect(engineModelChoicesToModelList([])).toEqual([]);
  });
});

describe("resolveSubagentModelOptions", () => {
  const parentCatalogModels = [{ id: "claude-opus-5", name: "Claude Opus" }];
  const codexChoices: EngineModelChoice[] = [{ id: "gpt-5.1", label: "GPT-5.1" }];

  it("engine '' (Same as parent): uses the parent's catalog models and the 'Same as parent' label", () => {
    expect(resolveSubagentModelOptions("", parentCatalogModels, {})).toEqual({
      models: parentCatalogModels,
      inheritLabel: "Same as parent",
    });
  });

  it("engine 'codex' with a cached choice list: maps it and uses the 'Default' label", () => {
    expect(resolveSubagentModelOptions("codex", parentCatalogModels, { codex: codexChoices })).toEqual({
      models: [{ id: "gpt-5.1", name: "GPT-5.1" }],
      inheritLabel: "Default",
    });
  });

  it("engine 'claude' with NO cache entry yet (still loading, or the recheck failed): degrades to an empty list", () => {
    expect(resolveSubagentModelOptions("claude", parentCatalogModels, {})).toEqual({
      models: [],
      inheritLabel: "Default",
    });
  });

  it("engine 'claude' cached as an empty list (a real recheck that yielded nothing): still an empty list, not a re-fetch signal", () => {
    expect(resolveSubagentModelOptions("claude", parentCatalogModels, { claude: [] })).toEqual({
      models: [],
      inheritLabel: "Default",
    });
  });
});

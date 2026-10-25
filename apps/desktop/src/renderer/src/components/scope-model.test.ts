/**
 * Taskana 4758: pure-model tests for the Settings scope dropdown. The renderer
 * package runs vitest in node, so behaviour is pinned through these helpers.
 */
import { describe, expect, it } from "vitest";
import type { ScopeWorkspaceEntry } from "../../../shared/scope-workspaces.js";
import {
  countLabel,
  disambiguateScopeLabels,
  filterScopeEntries,
  mcpStatusActive,
  nextActiveIndex,
  resolveScopeSelection,
  SCOPE_MACHINE_LABEL,
  scopeHintFor,
  scopeRefFor,
  userScopeLabel,
  type ScopeSelection,
} from "./scope-model.js";

const entry = (overrides: Partial<ScopeWorkspaceEntry> & { id: string; name: string; displayPath: string }): ScopeWorkspaceEntry => ({
  exists: true,
  tabIds: [],
  ...overrides,
});

const USER: ScopeSelection = { kind: "user" };

describe("scope model (Taskana 4758)", () => {
  it("userScopeLabel is 'User · This computer' and the machine label lives in one constant", () => {
    expect(userScopeLabel()).toBe("User · This computer");
    expect(SCOPE_MACHINE_LABEL).toBe("This computer");
  });

  it("disambiguateScopeLabels keeps unique names plain", () => {
    const labels = disambiguateScopeLabels([
      entry({ id: "ws_a", name: "app", displayPath: "~/work/app" }),
      entry({ id: "ws_b", name: "site", displayPath: "~/work/site" }),
    ]);
    expect(labels.get("ws_a")).toBe("app");
    expect(labels.get("ws_b")).toBe("site");
  });

  it("disambiguateScopeLabels turns duplicate basenames into 'name (parent)'", () => {
    const labels = disambiguateScopeLabels([
      entry({ id: "ws_a", name: "app", displayPath: "~/work/app" }),
      entry({ id: "ws_b", name: "app", displayPath: "~/old/app" }),
    ]);
    expect(labels.get("ws_a")).toBe("app (work)");
    expect(labels.get("ws_b")).toBe("app (old)");
  });

  it("disambiguateScopeLabels falls back to the full displayPath when parents collide too", () => {
    const labels = disambiguateScopeLabels([
      entry({ id: "ws_a", name: "app", displayPath: "~/work/x/app" }),
      entry({ id: "ws_b", name: "app", displayPath: "~/work/y/app" }),
      entry({ id: "ws_c", name: "app", displayPath: "~/other/app" }),
    ]);
    expect(labels.get("ws_a")).toBe("app (x)");
    expect(labels.get("ws_b")).toBe("app (y)");
    expect(labels.get("ws_c")).toBe("app (other)");

    const collide = disambiguateScopeLabels([
      entry({ id: "ws_1", name: "app", displayPath: "~/a/work/app" }),
      entry({ id: "ws_2", name: "app", displayPath: "~/b/work/app" }),
      entry({ id: "ws_3", name: "app", displayPath: "~/c/work/app" }),
    ]);
    expect(collide.get("ws_1")).toBe("~/a/work/app");
    expect(collide.get("ws_2")).toBe("~/b/work/app");
    expect(collide.get("ws_3")).toBe("~/c/work/app");
  });

  it("filterScopeEntries is case-insensitive over name and displayPath; empty query keeps all; no match is []", () => {
    const entries = [
      entry({ id: "ws_a", name: "Alpha", displayPath: "~/work/Alpha" }),
      entry({ id: "ws_b", name: "beta", displayPath: "~/Code/beta" }),
    ];
    expect(filterScopeEntries(entries, "ALPHA").map((e) => e.id)).toEqual(["ws_a"]);
    expect(filterScopeEntries(entries, "code").map((e) => e.id)).toEqual(["ws_b"]);
    expect(filterScopeEntries(entries, "")).toHaveLength(2);
    expect(filterScopeEntries(entries, "zzz")).toEqual([]);
  });

  it("resolveScopeSelection: user => ref undefined; known existing workspace => ref is its id", () => {
    const entries = [entry({ id: "ws_a", name: "a", displayPath: "~/a" })];
    expect(resolveScopeSelection(USER, entries)).toMatchObject({ ref: undefined, fellBack: false });
    expect(resolveScopeSelection({ kind: "workspace", id: "ws_a" }, entries)).toMatchObject({
      ref: "ws_a",
      fellBack: false,
    });
    expect(scopeRefFor({ kind: "workspace", id: "ws_a" }, entries)).toBe("ws_a");
  });

  it("resolveScopeSelection falls back to user when the selected folder vanished, or no longer exists, or entries are empty", () => {
    const gone = resolveScopeSelection({ kind: "workspace", id: "ws_x" }, [entry({ id: "ws_a", name: "a", displayPath: "~/a" })]);
    expect(gone).toMatchObject({ selection: USER, ref: undefined, fellBack: true });
    const missing = resolveScopeSelection(
      { kind: "workspace", id: "ws_a" },
      [entry({ id: "ws_a", name: "a", displayPath: "~/a", exists: false })],
    );
    expect(missing).toMatchObject({ selection: USER, ref: undefined, fellBack: true });
    const none = resolveScopeSelection({ kind: "workspace", id: "ws_a" }, []);
    expect(none).toMatchObject({ selection: USER, fellBack: true });
    expect(resolveScopeSelection(USER, [])).toMatchObject({ fellBack: false });
  });

  it("mcpStatusActive is true only when the active tab is open in the selected folder", () => {
    const open = entry({ id: "ws_a", name: "a", displayPath: "~/a", tabIds: ["tab-1"] });
    const recent = entry({ id: "ws_b", name: "b", displayPath: "~/b", tabIds: [] });
    expect(mcpStatusActive(open, "tab-1")).toBe(true);
    expect(mcpStatusActive(recent, "tab-1")).toBe(false);
    expect(mcpStatusActive(undefined, "tab-1")).toBe(false);
    expect(mcpStatusActive(open, null)).toBe(false);
  });

  it("scopeHintFor shows the hint only for a selected workspace without an open tab", () => {
    const open = entry({ id: "ws_a", name: "a", displayPath: "~/a", tabIds: ["tab-1"] });
    const recent = entry({ id: "ws_b", name: "b", displayPath: "~/b", tabIds: [] });
    expect(scopeHintFor({ kind: "workspace", id: "ws_b" }, recent)).toContain("This folder has no open tab.");
    expect(scopeHintFor({ kind: "workspace", id: "ws_a" }, open)).toBeNull();
    expect(scopeHintFor(USER, undefined)).toBeNull();
  });

  it("countLabel formats per pane and is empty while loading", () => {
    expect(countLabel("mcp", 3)).toBe("Servers 3");
    expect(countLabel("language-servers", 2)).toBe("Servers 2");
    expect(countLabel("skills", 18)).toBe("Skills 18");
    expect(countLabel("subagents", 4)).toBe("Subagents 4");
    expect(countLabel("skills", null)).toBe("");
    expect(countLabel("provider", 1)).toBe("");
  });

  it("nextActiveIndex wraps arrows, jumps Home/End and skips disabled options", () => {
    // Options 0..4; option 1 and 3 are disabled.
    const enabled = [0, 2, 4];
    expect(nextActiveIndex("ArrowDown", 0, enabled)).toBe(2);
    expect(nextActiveIndex("ArrowDown", 4, enabled)).toBe(0);
    expect(nextActiveIndex("ArrowUp", 2, enabled)).toBe(0);
    expect(nextActiveIndex("ArrowUp", 0, enabled)).toBe(4);
    expect(nextActiveIndex("Home", 4, enabled)).toBe(0);
    expect(nextActiveIndex("End", 0, enabled)).toBe(4);
    expect(nextActiveIndex("Enter", 2, enabled)).toBe(2);
    expect(nextActiveIndex("ArrowDown", 0, [])).toBe(0);
  });
});

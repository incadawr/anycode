/**
 * Taskana 4758: render tests for the scope dropdown. The renderer package runs
 * vitest in node, so markup is checked with renderToStaticMarkup, mirroring
 * SessionAccessRow.test.ts. The open menu is rendered through the exported
 * ScopeMenuView; keyboard movement is pinned through nextActiveIndex.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScopeWorkspaceEntry } from "../../../shared/scope-workspaces.js";
import { buildScopeOptions, ScopeDropdown, ScopeMenuView } from "./ScopeSwitcher.js";
import { nextActiveIndex } from "./scope-model.js";

const entry = (overrides: Partial<ScopeWorkspaceEntry> & { id: string; name: string }): ScopeWorkspaceEntry => ({
  displayPath: `~/work/${overrides.name}`,
  exists: true,
  tabIds: [],
  ...overrides,
});

const noop = () => {};

function closed(entries: ScopeWorkspaceEntry[], extra: Partial<Parameters<typeof ScopeDropdown>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ScopeDropdown, {
      selection: { kind: "user" },
      entries,
      loading: false,
      onOpen: noop,
      onSelect: noop,
      ...extra,
    }),
  );
}

function menu(entries: ScopeWorkspaceEntry[], extra: Partial<Parameters<typeof ScopeMenuView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ScopeMenuView, {
      selection: { kind: "user" },
      entries,
      query: "",
      activeIndex: 0,
      ...extra,
    }),
  );
}

describe("ScopeDropdown (Taskana 4758)", () => {
  it("closed state renders the trigger with its data attributes and the User label", () => {
    const html = closed([]);
    expect(html).toContain("data-scope-trigger");
    expect(html).toContain('data-scope-value="user"');
    expect(html).toContain("User · This computer");
    expect(html).not.toContain("data-scope-menu");
  });

  it("closed state shows the workspace name for a selected folder", () => {
    const html = closed([entry({ id: "ws_a1", name: "app" })], { selection: { kind: "workspace", id: "ws_a1" } });
    expect(html).toContain('data-scope-value="ws_a1"');
    expect(html).toContain(">app<");
  });

  it("open menu lists User first, then the Workspaces header, then entries in order, with aria-selected on the selected one", () => {
    const entries = [entry({ id: "ws_1", name: "alpha" }), entry({ id: "ws_2", name: "beta", tabIds: ["t1"] })];
    const html = menu(entries, { selection: { kind: "workspace", id: "ws_2" }, activeIndex: 1 });
    const userAt = html.indexOf('data-scope-option="user"');
    const headingAt = html.indexOf("Workspaces");
    const firstAt = html.indexOf('data-scope-option="ws_1"');
    const secondAt = html.indexOf('data-scope-option="ws_2"');
    expect(userAt).toBeGreaterThan(-1);
    expect(userAt).toBeLessThan(headingAt);
    expect(headingAt).toBeLessThan(firstAt);
    expect(firstAt).toBeLessThan(secondAt);
    expect(html).toMatch(/aria-selected="true"[^>]*data-scope-option="ws_2"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-scope-option="user"/);
    expect(html).toContain('role="listbox"');
    expect(html).toContain(">open<");
  });

  it("empty entries show the empty-state sentence and no filter input", () => {
    const html = menu([]);
    expect(html).toContain("No recent folders yet. Start a session in a folder and it will appear here.");
    expect(html).not.toContain("data-scope-search");
  });

  it("the filter input appears only above six folders", () => {
    const six = Array.from({ length: 6 }, (_, i) => entry({ id: `ws_${i}`, name: `f${i}` }));
    const seven = Array.from({ length: 7 }, (_, i) => entry({ id: `ws_${i}`, name: `f${i}` }));
    expect(menu(six)).not.toContain("data-scope-search");
    expect(menu(seven)).toContain('aria-label="Filter workspaces"');
    expect(menu(seven)).toContain("data-scope-search");
  });

  it("a folder that no longer exists renders aria-disabled and 'folder not found', and is not selectable", () => {
    const entries = [entry({ id: "ws_gone", name: "gone", exists: false })];
    const html = menu(entries);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-scope-option="ws_gone"/);
    expect(html).toContain("folder not found");
    expect(buildScopeOptions(entries, "")[1]).toMatchObject({ enabled: false });
  });

  it("the open badge shows only for folders with open tabs, and the hint renders only when provided", () => {
    const withTab = menu([entry({ id: "ws_t", name: "t", tabIds: ["tab-9"] })]);
    const without = menu([entry({ id: "ws_n", name: "n" })]);
    expect(withTab).toContain("scope-dropdown-badge");
    expect(without).not.toContain("scope-dropdown-badge");
    expect(closed([], { hint: "This folder has no open tab." })).toContain("data-scope-hint");
    expect(closed([], { hint: null })).not.toContain("data-scope-hint");
  });

  it("filters folders by the query in the open menu", () => {
    const entries = [entry({ id: "ws_a", name: "alpha" }), entry({ id: "ws_b", name: "beta" })];
    const html = menu(entries, { query: "alp" });
    expect(html).toContain('data-scope-option="ws_a"');
    expect(html).not.toContain('data-scope-option="ws_b"');
    expect(menu(entries, { query: "zzz" })).toContain("No matching folders.");
  });

  it("keyboard model: arrows wrap, Home/End jump, disabled options are skipped", () => {
    const entries = [
      entry({ id: "ws_a", name: "a" }),
      entry({ id: "ws_b", name: "b", exists: false }),
      entry({ id: "ws_c", name: "c" }),
    ];
    const options = buildScopeOptions(entries, "");
    const enabled = options.flatMap((option, index) => (option.enabled ? [index] : []));
    expect(enabled).toEqual([0, 1, 3]);
    expect(nextActiveIndex("ArrowDown", 0, enabled)).toBe(1);
    expect(nextActiveIndex("ArrowDown", 3, enabled)).toBe(0);
    expect(nextActiveIndex("ArrowUp", 0, enabled)).toBe(3);
    expect(nextActiveIndex("End", 0, enabled)).toBe(3);
    expect(nextActiveIndex("Home", 3, enabled)).toBe(0);
  });
});

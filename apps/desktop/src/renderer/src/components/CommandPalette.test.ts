/**
 * Pure-logic tests for the command palette's row builder (ui-roadmap §4-R5).
 * `.test.ts`, node env: `buildPaletteRows` carries the filtering / ranking /
 * grouping / hint / raw-title logic, so it is covered directly — the React
 * component (dialog lifecycle, roving, focus) is exercised by the visual
 * harness, never rendered here.
 */
import { describe, expect, it } from "vitest";
import type { SidebarGroup } from "./Sidebar.js";
import { buildPaletteRows, type PaletteAction, type PaletteRow } from "./CommandPalette.js";

type ActionRow = Extract<PaletteRow, { kind: "action" }>;
type TabRow = Extract<PaletteRow, { kind: "tab" }>;
type SessionRow = Extract<PaletteRow, { kind: "session" }>;

const isAction = (r: PaletteRow): r is ActionRow => r.kind === "action";
const isTab = (r: PaletteRow): r is TabRow => r.kind === "tab";
const isSession = (r: PaletteRow): r is SessionRow => r.kind === "session";

function action(over: Partial<PaletteAction> & Pick<PaletteAction, "id" | "label">): PaletteAction {
  return { hint: null, enabled: true, run: () => {}, ...over };
}

function label(r: PaletteRow): string {
  if (r.kind === "action") return r.action.label;
  if (r.kind === "tab") return r.title;
  if (r.kind === "session") return r.displayTitle;
  return `[group ${r.label}]`;
}

describe("buildPaletteRows — actions mode", () => {
  it("empty query lists every action in declared order, no group rows", () => {
    const actions = [
      action({ id: "session.new", label: "New session", hint: "⌘N" }),
      action({ id: "settings.open", label: "Open settings", hint: "⌘," }),
    ];
    const rows = buildPaletteRows({ mode: "actions", query: "", actions, groups: [], tabOrder: [], platform: "darwin" });
    expect(rows.map((r) => r.kind)).toEqual(["action", "action"]);
    expect(rows.map(label)).toEqual(["New session", "Open settings"]);
  });

  it("query filters + ranks (boundary bonus decides) and keeps disabled rows", () => {
    const actions = [
      action({ id: "session.new", label: "New session", hint: "⌘N" }),
      action({ id: "settings.open", label: "Settings", hint: "⌘," }),
      action({ id: "terminal.toggle", label: "Show terminal", hint: "⌘J", enabled: false }),
    ];
    const rows = buildPaletteRows({
      mode: "actions",
      query: "se",
      actions,
      groups: [],
      tabOrder: [],
      platform: "darwin",
    });
    // "Settings" (start-of-target +2) outranks the two mid-word matches, which
    // tie on score and break to the shorter label ("New session" < "Show terminal").
    expect(rows.filter(isAction).map((r) => r.action.label)).toEqual(["Settings", "New session", "Show terminal"]);
    const term = rows.filter(isAction).find((r) => r.action.id === "terminal.toggle");
    expect(term?.action.enabled).toBe(false);
  });

  it("hint-only hit keeps the row with no highlight ranges", () => {
    const actions = [
      action({ id: "terminal.toggle", label: "Show terminal", hint: "⌘J" }),
      action({ id: "session.new", label: "New session", hint: "⌘N" }),
    ];
    const rows = buildPaletteRows({ mode: "actions", query: "j", actions, groups: [], tabOrder: [], platform: "darwin" });
    const term = rows.filter(isAction).find((r) => r.action.id === "terminal.toggle");
    expect(term).toBeDefined();
    expect(term!.ranges).toEqual([]);
    // "New session" matches neither its label nor its hint (⌘N) on "j" → dropped.
    expect(rows.filter(isAction).some((r) => r.action.id === "session.new")).toBe(false);
  });

  it("no matches → empty array", () => {
    const actions = [action({ id: "session.new", label: "New session", hint: "⌘N" })];
    const rows = buildPaletteRows({
      mode: "actions",
      query: "zzzzz",
      actions,
      groups: [],
      tabOrder: [],
      platform: "darwin",
    });
    expect(rows).toEqual([]);
  });
});

describe("buildPaletteRows — sessions mode", () => {
  const alpha: SidebarGroup = {
    workspace: "/w/alpha",
    label: "alpha",
    rows: [
      { kind: "open", key: "t1", title: "Tab One", age: null, tabId: "t1" },
      { kind: "resumable", key: "s1", title: "Session One", age: "3m", sessionId: "s1" },
    ],
  };

  it("empty query emits group rows before members; tab rows before session rows; ages carried", () => {
    const rows = buildPaletteRows({
      mode: "sessions",
      query: "",
      actions: [],
      groups: [alpha],
      tabOrder: ["t1"],
      platform: "darwin",
    });
    expect(rows.map((r) => r.kind)).toEqual(["group", "tab", "session"]);
    expect(rows[0]).toEqual({ kind: "group", label: "alpha" });
    const session = rows.filter(isSession)[0]!;
    expect(session.age).toBe("3m");
  });

  it("query flattens to ranked rows (no group rows) with a workspace micro-label on each", () => {
    const rows = buildPaletteRows({
      mode: "sessions",
      query: "one",
      actions: [],
      groups: [alpha],
      tabOrder: ["t1"],
      platform: "darwin",
    });
    expect(rows.every((r) => r.kind !== "group")).toBe(true);
    // "Tab One" (boundary-dense) outranks "Session One" (buried greedy match).
    expect(rows.map(label)).toEqual(["Tab One", "Session One"]);
    for (const r of rows) {
      expect((r as TabRow | SessionRow).workspaceLabel).toBe("alpha");
    }
  });

  it("tab ⌘n hints follow tabOrder, not group order; past the 9th → null", () => {
    const tabOrder = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"];
    const group: SidebarGroup = {
      workspace: "/w",
      label: "w",
      rows: [
        { kind: "open", key: "t10", title: "Ten", age: null, tabId: "t10" },
        { kind: "open", key: "t9", title: "Nine", age: null, tabId: "t9" },
        { kind: "open", key: "t1", title: "One", age: null, tabId: "t1" },
      ],
    };
    const rows = buildPaletteRows({
      mode: "sessions",
      query: "",
      actions: [],
      groups: [group],
      tabOrder,
      platform: "darwin",
    });
    const hintByTab = new Map(rows.filter(isTab).map((r) => [r.tabId, r.hint]));
    expect(hintByTab.get("t1")).toBe("⌘1");
    expect(hintByTab.get("t9")).toBe("⌘9");
    expect(hintByTab.get("t10")).toBeNull();
  });

  it("session rows carry the raw (possibly undefined) title AND the display fallback separately", () => {
    const group: SidebarGroup = {
      workspace: "/w",
      label: "w",
      rows: [
        { kind: "resumable", key: "s1", title: "Untitled task", age: "1d", sessionId: "s1" },
        { kind: "resumable", key: "s2", title: "Real Title", age: "2d", sessionId: "s2" },
      ],
    };
    const rows = buildPaletteRows({
      mode: "sessions",
      query: "",
      actions: [],
      groups: [group],
      tabOrder: [],
      platform: "darwin",
    });
    const sessions = rows.filter(isSession);
    const s1 = sessions.find((r) => r.sessionId === "s1")!;
    const s2 = sessions.find((r) => r.sessionId === "s2")!;
    // Untitled: display shows the fallback, but the forwarded title is undefined
    // so resume never persists "Untitled task" as a real title.
    expect(s1.title).toBeUndefined();
    expect(s1.displayTitle).toBe("Untitled task");
    expect(s2.title).toBe("Real Title");
    expect(s2.displayTitle).toBe("Real Title");
  });
});

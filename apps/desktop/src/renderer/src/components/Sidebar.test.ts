/**
 * Pure-logic tests for the Sidebar's session-index assembly (design
 * ui-redesign-direction.md §2.3). Deliberately `.test.ts`, not `.test.tsx`:
 * this package's vitest config runs `environment: "node"` with no jsdom (same
 * rationale as SessionPicker.test.ts / App.test.ts) — the exported pure
 * functions `buildSidebarGroups` and `formatAge` carry all of the grouping /
 * dedupe / ordering / label logic, so they are covered directly instead of
 * DOM-rendering the component.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../../shared/tabs.js";
import type { TabInfo } from "../tabs-store.js";
import {
  applyHiddenProjects,
  buildSidebarGroups,
  bulkDeleteConfirm,
  capSessionPage,
  clampMenuLeft,
  deleteOlderNotice,
  filterSidebarGroups,
  formatAge,
  isRowDeletable,
  limitGroupRows,
  parseOlderThanDays,
  sidebarConfirmCopy,
  singleDeleteConfirm,
  SIDEBAR_GROUP_ROW_LIMIT,
  SIDEBAR_SESSIONS_LIMIT,
  SessionIndexController,
  tabsSessionKey,
  type FilteredSidebarRow,
  type SidebarGroup,
  type SidebarRow,
} from "./Sidebar.js";
import { fuzzyMatch } from "../fuzzy.js";

function tab(overrides: Partial<TabInfo> & Pick<TabInfo, "tabId" | "workspace">): TabInfo {
  return {
    sessionId: null,
    hostExited: false,
    terminalOpen: false,
    lspPanelOpen: false,
    hooksPanelOpen: false,
    timelinePanelOpen: false,
    ...overrides,
  };
}

function summaries(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`, workspace: "/w", model: "m", mode: "build", createdAt: 1_000 + i, updatedAt: 2_000 + i,
  }));
}

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "workspace">): SessionSummary {
  return {
    model: "m1",
    mode: "build",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("buildSidebarGroups", () => {
  it("groups by raw workspace with a basename label and full path as the workspace key", () => {
    const groups = buildSidebarGroups([tab({ tabId: "t1", workspace: "/home/me/project-alpha" })], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.workspace).toBe("/home/me/project-alpha");
    expect(groups[0]!.label).toBe("project-alpha");
  });

  it("groups relocated worktree tabs and sessions under their stable projectRoot", () => {
    const target = "/repo/.anycode/worktrees/task-5";
    const worktree = { id: "task-5", path: target, branch: "anycode-wt/task-5", baseRef: "HEAD", ownedByAnyCode: true };
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: target, projectRoot: "/repo", worktree })],
      [session({ id: "s2", workspace: target, projectRoot: "/repo", worktree })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ workspace: "/repo", label: "repo" });
    expect(groups[0]!.rows.map((row) => row.kind)).toEqual(["open", "resumable"]);
    expect(groups[0]!.rows.map((row) => row.worktree)).toEqual([worktree, worktree]);
  });

  it("derives the basename from the trailing path segment, tolerating trailing slashes and Windows separators", () => {
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/home/me/alpha/" }), tab({ tabId: "t2", workspace: "C:\\Users\\me\\beta" })],
      [],
    );

    expect(groups.map((g) => g.label)).toEqual(["alpha", "beta"]);
  });

  it("orders open tab rows first (tabs-store order), then resumable session rows (updated_at DESC input order) within a workspace", () => {
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/ws", title: "Live tab" })],
      [
        session({ id: "s-new", workspace: "/ws", title: "Recent", updatedAt: 2000 }),
        session({ id: "s-old", workspace: "/ws", title: "Older", updatedAt: 1000 }),
      ],
      3000,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => ({ kind: r.kind, key: r.key }))).toEqual([
      { kind: "open", key: "t1" },
      { kind: "resumable", key: "s-new" },
      { kind: "resumable", key: "s-old" },
    ]);
  });

  it("dedupes a session whose openInTabId matches a live tab (it folds into the open row, not a second resumable row)", () => {
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/ws", title: "Live" })],
      [session({ id: "s1", workspace: "/ws", title: "Same session", openInTabId: "t1" })],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]).toMatchObject({ kind: "open", key: "t1", tabId: "t1" });
  });

  it("keeps a resumable session whose openInTabId points at a tab that is NOT live", () => {
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/ws" })],
      [session({ id: "s1", workspace: "/ws", title: "Stale bind", openInTabId: "t-dead" })],
    );

    expect(groups[0]!.rows.map((r) => r.kind)).toEqual(["open", "resumable"]);
  });

  it("orders groups by first-seen across tabs then sessions, so open-tab workspaces float above session-only ones", () => {
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/ws-b" })],
      [
        session({ id: "s1", workspace: "/ws-a" }),
        session({ id: "s2", workspace: "/ws-b" }),
        session({ id: "s3", workspace: "/ws-c" }),
      ],
    );

    // /ws-b seen first (via the tab), then /ws-a and /ws-c in session order.
    expect(groups.map((g) => g.workspace)).toEqual(["/ws-b", "/ws-a", "/ws-c"]);
  });

  it("returns an empty array when there are no tabs and no sessions", () => {
    expect(buildSidebarGroups([], [])).toEqual([]);
  });

  it("renders open tabs only while sessions are still loading (null) — no resumable rows, fail-soft", () => {
    const groups = buildSidebarGroups([tab({ tabId: "t1", workspace: "/ws", title: "Live" })], null);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.kind).toBe("open");
  });

  it("returns an empty array for null sessions and no open tabs", () => {
    expect(buildSidebarGroups([], null)).toEqual([]);
  });

  it("falls back to 'Untitled task' for tabs and sessions without a title, and sets age null on open rows / an age label on resumable rows", () => {
    const now = 100_000_000;
    const groups = buildSidebarGroups(
      [tab({ tabId: "t1", workspace: "/ws", hostExited: true })],
      [session({ id: "s1", workspace: "/ws", updatedAt: now - 5 * 3_600_000 })],
      now,
    );

    const rows = groups[0]!.rows;
    expect(rows[0]).toMatchObject({
      kind: "open",
      key: "t1",
      title: "Untitled task",
      age: null,
      hostExited: true,
      tabId: "t1",
    });
    expect(rows[1]).toMatchObject({
      kind: "resumable",
      key: "s1",
      title: "Untitled task",
      age: "5h",
      sessionId: "s1",
    });
  });
});

describe("formatAge", () => {
  const now = 1_000_000_000;

  it("formats minute / hour / day buckets compactly with no suffix", () => {
    expect(formatAge(now - 3 * 60_000, now)).toBe("3m");
    expect(formatAge(now - 22 * 3_600_000, now)).toBe("22h");
    expect(formatAge(now - 4 * 86_400_000, now)).toBe("4d");
  });

  it("labels a sub-minute age as 'now'", () => {
    expect(formatAge(now - 5_000, now)).toBe("now");
  });

  it("clamps a just-over-a-minute age to at least 1m", () => {
    expect(formatAge(now - 61_000, now)).toBe("1m");
  });
});

describe("filterSidebarGroups", () => {
  /** Terse builders — a resumable row unless `kind` says otherwise; the key/id derive from the title. */
  function row(title: string, kind: SidebarRow["kind"] = "resumable"): SidebarRow {
    return kind === "open"
      ? { kind: "open", key: `t-${title}`, title, age: null, tabId: `t-${title}` }
      : { kind: "resumable", key: `s-${title}`, title, age: "1h", sessionId: `s-${title}` };
  }
  function group(workspace: string, label: string, rows: SidebarRow[]): SidebarGroup {
    return { workspace, label, rows };
  }

  it("empty query is a total structure passthrough — every group/row present, same order, all ranges empty", () => {
    const groups = [group("/a", "alpha", [row("One"), row("Two")]), group("/b", "beta", [row("Three")])];
    const out = filterSidebarGroups(groups, "");

    expect(out.map((g) => g.workspace)).toEqual(["/a", "/b"]);
    expect(out[0]!.labelRanges).toEqual([]);
    expect(out[0]!.rows.map((r) => r.row.title)).toEqual(["One", "Two"]);
    expect(out[0]!.rows.every((r) => r.ranges.length === 0)).toBe(true);
    expect(out[1]!.rows.map((r) => r.row.title)).toEqual(["Three"]);
  });

  it("a title match keeps only that row with its ranges; the non-matching sibling is dropped, the group retained", () => {
    const groups = [group("/a", "alpha", [row("Refactor login"), row("Deploy pipeline")])];
    const out = filterSidebarGroups(groups, "login");

    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toHaveLength(1);
    expect(out[0]!.rows[0]!.row.title).toBe("Refactor login");
    expect(out[0]!.rows[0]!.ranges).toEqual(fuzzyMatch("login", "Refactor login")!.ranges);
    expect(out[0]!.labelRanges).toEqual([]);
  });

  it("drops a group with a non-matching label and zero matching rows", () => {
    const groups = [group("/a", "alpha", [row("Refactor login")]), group("/b", "beta", [row("Something else")])];
    const out = filterSidebarGroups(groups, "login");

    expect(out.map((g) => g.workspace)).toEqual(["/a"]);
  });

  it("a label match keeps ALL of the group's rows with empty ranges and populates labelRanges", () => {
    const groups = [group("/anycode", "anycode", [row("Fix bug"), row("Write docs")])];
    const out = filterSidebarGroups(groups, "anycode");

    expect(out).toHaveLength(1);
    expect(out[0]!.rows.map((r) => r.row.title)).toEqual(["Fix bug", "Write docs"]);
    expect(out[0]!.rows.every((r) => r.ranges.length === 0)).toBe(true);
    expect(out[0]!.labelRanges).toEqual(fuzzyMatch("anycode", "anycode")!.ranges);
  });

  it("label + title both match: all rows kept, only the title-matching row carries ranges, labelRanges populated", () => {
    const groups = [group("/app", "app", [row("app server"), row("database")])];
    const out = filterSidebarGroups(groups, "app");

    expect(out[0]!.rows).toHaveLength(2);
    expect(out[0]!.rows[0]!.row.title).toBe("app server");
    expect(out[0]!.rows[0]!.ranges).toEqual(fuzzyMatch("app", "app server")!.ranges);
    expect(out[0]!.rows[1]!.row.title).toBe("database");
    expect(out[0]!.rows[1]!.ranges).toEqual([]);
    expect(out[0]!.labelRanges).toEqual(fuzzyMatch("app", "app")!.ranges);
  });

  it("preserves group and within-group order (scores ignored) even when a later row out-scores an earlier one", () => {
    const groups = [
      // "the eastern setup" is a scattered subsequence of "test"; "test harness" is an
      // exact prefix that would out-score it — order must stay input order regardless.
      group("/1", "one", [row("the eastern setup"), row("test harness")]),
      group("/2", "two", [row("latest tests")]),
    ];
    const out = filterSidebarGroups(groups, "test");

    expect(out.map((g) => g.workspace)).toEqual(["/1", "/2"]);
    expect(out[0]!.rows.map((r) => r.row.title)).toEqual(["the eastern setup", "test harness"]);
  });

  it("matches case-insensitively (delegated to fuzzyMatch)", () => {
    const groups = [group("/a", "alpha", [row("deploy service")])];
    const out = filterSidebarGroups(groups, "DEPLOY");

    expect(out).toHaveLength(1);
    expect(out[0]!.rows[0]!.row.title).toBe("deploy service");
  });

  it("returns [] when nothing matches anywhere (drives the empty state + Enter-to-create arm)", () => {
    const groups = [group("/a", "alpha", [row("one")]), group("/b", "beta", [row("two")])];

    expect(filterSidebarGroups(groups, "zzz")).toEqual([]);
  });

  it("does not mutate the input groups (purity)", () => {
    const groups = [
      group("/a", "alpha", [row("Refactor login"), row("Deploy")]),
      group("/b", "beta", [row("Test")]),
    ];
    const snapshot = structuredClone(groups);
    filterSidebarGroups(groups, "login");

    expect(groups).toEqual(snapshot);
  });

  it("uses the query verbatim (no trim): a single space filters to titles containing a space", () => {
    const groups = [group("/a", "alpha", [row("has space"), row("nospace")])];
    const out = filterSidebarGroups(groups, " ");

    expect(out).toHaveLength(1);
    expect(out[0]!.rows.map((r) => r.row.title)).toEqual(["has space"]);
  });
});

describe("limitGroupRows (TASK.125)", () => {
  function rows(spec: readonly ("open" | "resumable")[]): FilteredSidebarRow[] {
    return spec.map((kind, i) => ({
      row:
        kind === "open"
          ? { kind, key: `t${i}`, title: `task ${i}`, age: null, tabId: `t${i}` }
          : { kind, key: `s${i}`, title: `task ${i}`, age: "1h", sessionId: `s${i}` },
      ranges: [],
    }));
  }
  const resumables = (n: number) => rows(Array.from({ length: n }, () => "resumable" as const));

  it("passes a group at the limit through untouched", () => {
    const input = resumables(SIDEBAR_GROUP_ROW_LIMIT);

    expect(limitGroupRows(input)).toEqual({ shown: input, hidden: 0 });
  });

  it("cuts a long group to the limit and reports the hidden count", () => {
    const input = resumables(18);
    const { shown, hidden } = limitGroupRows(input);

    expect(hidden).toBe(13);
    // A prefix, in order — the cut hides the tail, it never re-ranks.
    expect(shown).toEqual(input.slice(0, SIDEBAR_GROUP_ROW_LIMIT));
  });

  it("does not take a cut that would hide a single row (the toggle costs that row's space)", () => {
    const input = resumables(SIDEBAR_GROUP_ROW_LIMIT + 1);

    expect(limitGroupRows(input)).toEqual({ shown: input, hidden: 0 });
  });

  it("never hides an open row — the cut moves down past the last live tab", () => {
    const input = rows([...Array.from({ length: 8 }, () => "open" as const), "resumable", "resumable", "resumable"]);
    const { shown, hidden } = limitGroupRows(input);

    expect(hidden).toBe(3);
    expect(shown).toHaveLength(8);
    expect(shown.every((r) => r.row.kind === "open")).toBe(true);
  });

  it("keeps an open row past the limit even when the tail is too short to cut", () => {
    const input = rows(["resumable", "resumable", "resumable", "resumable", "resumable", "open"]);

    expect(limitGroupRows(input)).toEqual({ shown: input, hidden: 0 });
  });

  it("honours an explicit limit (the constant is a default, not a hard-coded law)", () => {
    const { shown, hidden } = limitGroupRows(resumables(10), 2);

    expect(shown).toHaveLength(2);
    expect(hidden).toBe(8);
  });
});

describe("tabsSessionKey (TASK.125 — real session-set membership)", () => {
  it("identity-only mutations keep the key: title/flag flips", () => {
    const base = tab({ tabId: "t1", workspace: "/w", sessionId: "s1" });
    const flipped = { ...base, title: "B", hostExited: true, terminalOpen: true };
    expect(tabsSessionKey([flipped])).toBe(tabsSessionKey([base]));
  });
  it("a second tab bound to the same session, and unbound-tab churn, keep the key; order never matters", () => {
    const t1 = tab({ tabId: "t1", workspace: "/w", sessionId: "s1" });
    const t2 = tab({ tabId: "t2", workspace: "/w", sessionId: "s1" });
    const draft = tab({ tabId: "t3", workspace: "/w" }); // sessionId null
    expect(tabsSessionKey([t1, t2])).toBe(tabsSessionKey([t1]));
    expect(tabsSessionKey([t1, draft])).toBe(tabsSessionKey([t1]));
    expect(tabsSessionKey([t1, draft])).toBe(tabsSessionKey([draft, t1]));
  });
  it("a bind (null→id) and a bound-tab close change the key", () => {
    const bound = tab({ tabId: "t1", workspace: "/w", sessionId: "s1" });
    const unbound = tab({ tabId: "t1", workspace: "/w" });
    expect(tabsSessionKey([bound])).not.toBe(tabsSessionKey([unbound]));
    expect(tabsSessionKey([bound])).not.toBe(tabsSessionKey([]));
  });
});

describe("capSessionPage (TASK.125)", () => {
  it("a probe page at or under the limit passes through whole, hasMore false", () => {
    const page = summaries(SIDEBAR_SESSIONS_LIMIT);
    expect(capSessionPage(page)).toEqual({ page, hasMore: false });
  });
  it("an over-limit probe page (LIMIT+1) is cut to the limit and flagged, order preserved", () => {
    const { page, hasMore } = capSessionPage(summaries(SIDEBAR_SESSIONS_LIMIT + 1));
    expect(page).toHaveLength(SIDEBAR_SESSIONS_LIMIT);
    expect(page[0]?.id).toBe("s0");
    expect(hasMore).toBe(true);
  });
});

describe("SessionIndexController (TASK.125 — fetch discipline; the hook delegates here)", () => {
  function rig(rows: readonly SessionSummary[]) {
    const fetchList = vi.fn(async (limit?: number): Promise<readonly SessionSummary[]> => {
      if (limit === undefined && rows.length > SIDEBAR_SESSIONS_LIMIT) {
        return rows; // full list regardless of cap
      }
      return rows.slice(0, limit ?? rows.length);
    });
    return { controller: new SessionIndexController(fetchList), fetchList };
  }
  const bound = (id = "t1", session = "s1") => tab({ tabId: id, workspace: "/w", sessionId: session });

  it("initial sync fetches the bounded probe page (LIMIT+1) and applies the cap", async () => {
    const { controller, fetchList } = rig(summaries(SIDEBAR_SESSIONS_LIMIT + 1));
    await controller.sync([bound()], false);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(fetchList).toHaveBeenCalledWith(SIDEBAR_SESSIONS_LIMIT + 1);
    expect(controller.sessions).toHaveLength(SIDEBAR_SESSIONS_LIMIT);
    expect(controller.hasMore).toBe(true);
    expect(controller.error).toBe(false);
  });

  it("identity-only tab mutations do NOT fetch (key guard, not array identity)", async () => {
    const { controller, fetchList } = rig([]);
    await controller.sync([bound()], false);
    const before = fetchList.mock.calls.length;
    await controller.sync([{ ...bound(), title: "B", hostExited: true, terminalOpen: true }], false);
    expect(fetchList.mock.calls.length).toBe(before);
  });

  it("a second tab on the same session and unbound-tab churn do NOT fetch; a bind and a bound-tab close DO", async () => {
    const { controller, fetchList } = rig([]);
    await controller.sync([bound()], false);
    let before = fetchList.mock.calls.length;
    await controller.sync([bound(), bound("t2")], false); // same session set
    await controller.sync([bound(), tab({ tabId: "t3", workspace: "/w" })], false); // unbound draft
    expect(fetchList.mock.calls.length).toBe(before);
    await controller.sync([bound(), tab({ tabId: "t3", workspace: "/w", sessionId: "s2" })], false); // bind
    expect(fetchList.mock.calls.length).toBe(++before);
    await controller.sync([tab({ tabId: "t3", workspace: "/w", sessionId: "s2" })], false); // bound close
    expect(fetchList.mock.calls.length).toBe(++before);
  });

  it("switching to full (search/show-all) fetches UNcapped and keeps old sessions reachable", async () => {
    const rows = summaries(SIDEBAR_SESSIONS_LIMIT + 30);
    const { controller, fetchList } = rig(rows);
    await controller.sync([bound()], false); // capped
    await controller.sync([bound()], true); // full
    expect(fetchList).toHaveBeenLastCalledWith(); // zero args — full list
    expect(controller.sessions).toHaveLength(rows.length); // the old tail is present (deletion access)
    expect(controller.hasMore).toBe(false);
  });

  it("load() is the unconditional path (delete flows) and respects the current mode", async () => {
    const { controller, fetchList } = rig([]);
    await controller.sync([bound()], true);
    await controller.load(true);
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(fetchList).toHaveBeenLastCalledWith();
  });

  it("a rejected fetch fails soft AND retries on the next sync (key cleared on failure)", async () => {
    const fetchList = vi.fn(async (): Promise<readonly SessionSummary[]> => {
      throw new Error("ipc down");
    });
    const controller = new SessionIndexController(fetchList);
    await controller.sync([bound()], false);
    expect(controller.error).toBe(true);
    expect(controller.sessions).toBeNull();
    await controller.sync([{ ...bound(), title: "flip-only" }], false); // same key — but failure cleared it
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
});

describe("focus refetch removal (TASK.125)", () => {
  it("Sidebar.tsx no longer subscribes to window focus — no fetch path may hang off it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "Sidebar.tsx"), "utf8");
    expect(src).not.toContain('addEventListener("focus"');
  });
});

describe("applyHiddenProjects", () => {
  function openRow(title: string): SidebarRow {
    return { kind: "open", key: `t-${title}`, title, age: null, tabId: `t-${title}` };
  }
  function resumableRow(title: string): SidebarRow {
    return { kind: "resumable", key: `s-${title}`, title, age: "1h", sessionId: `s-${title}` };
  }
  function group(workspace: string, rows: SidebarRow[]): SidebarGroup {
    return { workspace, label: workspace, rows };
  }

  it("empty hidden list is a passthrough — same groups, same order, a fresh array (purity)", () => {
    const groups = [group("/a", [openRow("one")]), group("/b", [resumableRow("two")])];
    const out = applyHiddenProjects(groups, []);

    expect(out.map((g) => g.workspace)).toEqual(["/a", "/b"]);
    expect(out).not.toBe(groups);
  });

  it("drops a session-only group whose workspace is hidden", () => {
    const groups = [group("/keep", [openRow("live")]), group("/gone", [resumableRow("old")])];
    const out = applyHiddenProjects(groups, ["/gone"]);

    expect(out.map((g) => g.workspace)).toEqual(["/keep"]);
  });

  it("keeps a hidden group that still has an open row (belt-and-suspenders for the addTab self-heal, R4)", () => {
    const groups = [group("/w", [openRow("live"), resumableRow("old")])];
    const out = applyHiddenProjects(groups, ["/w"]);

    expect(out.map((g) => g.workspace)).toEqual(["/w"]);
  });

  it("keeps a session-only group whose workspace is NOT hidden", () => {
    const groups = [group("/a", [resumableRow("x")])];
    const out = applyHiddenProjects(groups, ["/other"]);

    expect(out.map((g) => g.workspace)).toEqual(["/a"]);
  });

  it("preserves survivor order when a middle group is dropped", () => {
    const groups = [group("/a", [openRow("a")]), group("/b", [resumableRow("b")]), group("/c", [openRow("c")])];
    const out = applyHiddenProjects(groups, ["/b"]);

    expect(out.map((g) => g.workspace)).toEqual(["/a", "/c"]);
  });

  it("drops multiple hidden session-only groups at once", () => {
    const groups = [
      group("/a", [resumableRow("a")]),
      group("/b", [openRow("b")]),
      group("/c", [resumableRow("c")]),
    ];
    const out = applyHiddenProjects(groups, ["/a", "/c"]);

    expect(out.map((g) => g.workspace)).toEqual(["/b"]);
  });

  it("does not mutate the input array or its groups (purity)", () => {
    const groups = [group("/a", [openRow("a")]), group("/gone", [resumableRow("g")])];
    const snapshot = structuredClone(groups);
    applyHiddenProjects(groups, ["/gone"]);

    expect(groups).toEqual(snapshot);
  });
});

describe("clampMenuLeft", () => {
  it("prefers the trigger's left when the menu fits within the viewport", () => {
    expect(clampMenuLeft(100, 224, 1200)).toBe(100);
  });

  it("pulls back from the right edge so the menu never overflows (left = viewport - width - margin)", () => {
    // viewport 500, width 224, margin 8 → maxLeft = 268; trigger at 400 clamps to 268.
    expect(clampMenuLeft(400, 224, 500)).toBe(268);
  });

  it("never sits closer to the left edge than the margin", () => {
    expect(clampMenuLeft(-50, 224, 1200)).toBe(8);
  });

  it("honors a custom margin", () => {
    expect(clampMenuLeft(-50, 100, 1200, 20)).toBe(20);
  });
});

// TASK.114: session-delete message/verdict helpers (pure, node-env — same
// discipline as buildSidebarGroups above).
describe("isRowDeletable (TASK.114)", () => {
  it("offers delete only on resumable rows", () => {
    expect(isRowDeletable("resumable", false)).toBe(true);
    expect(isRowDeletable("open", false)).toBe(false);
  });

  // Live smoke 15.08 (defect 3): the argument used to be "the project has a
  // live tab", which hid the affordance from every row of a project as soon
  // as one session there was open. It now asks about THIS row's session, so a
  // sibling being open cannot reach this verdict at all.
  it("refuses only while THAT session is open in a tab (main would refuse too)", () => {
    expect(isRowDeletable("resumable", true)).toBe(false);
  });
});

describe("singleDeleteConfirm (TASK.114)", () => {
  it("names the task and states irreversibility", () => {
    expect(singleDeleteConfirm("Fix login")).toBe("Delete “Fix login” permanently? This cannot be undone.");
  });
});

describe("parseOlderThanDays (TASK.114)", () => {
  it("accepts whole days within 1..3650 (main's zod bounds)", () => {
    expect(parseOlderThanDays("30")).toBe(30);
    expect(parseOlderThanDays(" 7 ")).toBe(7);
    expect(parseOlderThanDays("1")).toBe(1);
    expect(parseOlderThanDays("3650")).toBe(3650);
  });

  it("rejects cancel, non-numeric, fractional, zero, and out-of-range input", () => {
    expect(parseOlderThanDays(null)).toBeNull();
    expect(parseOlderThanDays("")).toBeNull();
    expect(parseOlderThanDays("abc")).toBeNull();
    expect(parseOlderThanDays("3.5")).toBeNull();
    expect(parseOlderThanDays("0")).toBeNull();
    expect(parseOlderThanDays("3651")).toBeNull();
    expect(parseOlderThanDays("-5")).toBeNull();
  });
});

describe("bulkDeleteConfirm (TASK.114)", () => {
  it("quotes the exact candidate count before anything is deleted (decision 5)", () => {
    expect(bulkDeleteConfirm(1, 30)).toBe("Permanently delete 1 task older than 30 days? This cannot be undone.");
    expect(bulkDeleteConfirm(42, 1)).toBe("Permanently delete 42 tasks older than 1 day? This cannot be undone.");
  });
});

// TASK.126: the ConfirmDialog copy per pending confirm — must reuse the exact
// singleDeleteConfirm / bulkDeleteConfirm text the old window.confirm calls
// quoted (their own tests above stay authoritative for that text).
describe("sidebarConfirmCopy (TASK.126)", () => {
  it("single: 'Delete task' title, singleDeleteConfirm body, 'Delete' verb", () => {
    expect(sidebarConfirmCopy({ kind: "delete-session", sessionId: "s1", title: "Fix login" })).toEqual({
      title: "Delete task",
      body: singleDeleteConfirm("Fix login"),
      confirmLabel: "Delete",
    });
  });

  it("bulk: 'Delete old tasks' title, bulkDeleteConfirm body, count-carrying verb", () => {
    expect(sidebarConfirmCopy({ kind: "delete-older", workspace: "/w", days: 30, count: 42 })).toEqual({
      title: "Delete old tasks",
      body: bulkDeleteConfirm(42, 30),
      confirmLabel: "Delete 42",
    });
  });

  it("bulk count 1 keeps the singular body and a 'Delete 1' verb", () => {
    expect(sidebarConfirmCopy({ kind: "delete-older", workspace: "/w", days: 30, count: 1 })).toEqual({
      title: "Delete old tasks",
      body: bulkDeleteConfirm(1, 30),
      confirmLabel: "Delete 1",
    });
  });
});

describe("deleteOlderNotice (TASK.114)", () => {
  it("reports the deleted count", () => {
    expect(deleteOlderNotice(3, 0)).toBe("Deleted 3 tasks.");
  });

  it("singularizes one task", () => {
    expect(deleteOlderNotice(1, 0)).toBe("Deleted 1 task.");
  });

  it("never silently drops skipped actives", () => {
    expect(deleteOlderNotice(3, 1)).toBe("Deleted 3 tasks. Skipped 1 open task.");
    expect(deleteOlderNotice(3, 2)).toBe("Deleted 3 tasks. Skipped 2 open tasks.");
  });
});

// ---------------------------------------------------------------------------
// REVIEW 15.08 (TASK.114 defect 1) + TASK.126 — THE NATIVE DIALOG GUARD.
// window.prompt is NOT supported by Electron: it THROWS "prompt() is not
// supported" the moment it is called. window.confirm/alert are blocking and
// freeze the renderer behind a dialog the WebContentsView overlay can't hide.
// This guard fails on ANY occurrence of confirm/alert/prompt in the
// renderer's PRODUCTION source — bare, `window.`-qualified or
// `globalThis.`-qualified — so the next builder cannot quietly reintroduce a
// blocking native dialog. Pure-fn tests around handlers can never catch this
// class of bug.

describe("renderer native-dialog guard (TASK.114 review 15.08, TASK.126)", () => {
  it("no renderer production source calls confirm/alert/prompt — window., globalThis. or bare (Electron blocks/freezes them)", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join, extname } = await import("node:path");

    const rendererRoot = join(__dirname, "..");
    const banned = /(?<![.\w$])(?:(?:window|globalThis)\s*\.\s*)?(?:confirm|alert|prompt)\(/;

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") {
            continue;
          }
          yield* walk(p);
        } else if (/\.[cm]?[jt]sx?$/.test(extname(p)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
          // Production source only: this very guard's title mentions the
          // banned call, and specs may quote it in assertions.
          yield p;
        }
      }
    }

    const offenders: string[] = [];
    for await (const file of walk(rendererRoot)) {
      const src = await readFile(file, "utf8");
      // Strip comments so a mentioned-in-passing call never trips the guard;
      // real call sites survive the strip.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      if (banned.test(stripped)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Table-driven pinning of the guard's matching contract itself: all nine
  // banned forms (3 names × 3 qualifications) must match, while member
  // methods on other objects and longer identifiers containing the banned
  // name as a substring must not.
  it("the banned regex matches all nine native call forms and only them", () => {
    const banned = /(?<![.\w$])(?:(?:window|globalThis)\s*\.\s*)?(?:confirm|alert|prompt)\(/;
    const bannedForms = [
      "confirm(",
      "window.confirm(",
      "globalThis.confirm(",
      "alert(",
      "window.alert(",
      "globalThis.alert(",
      "prompt(",
      "window.prompt(",
      "globalThis.prompt(",
    ];
    for (const form of bannedForms) {
      expect(banned.test(form)).toBe(true);
    }
    expect(banned.test("dialog.confirm(")).toBe(false);
    expect(banned.test("myWindow.alert(")).toBe(false);
    expect(banned.test("confirmed(")).toBe(false);
    expect(banned.test("alerts(")).toBe(false);
    expect(banned.test("prompted(")).toBe(false);
    // UI copy such as "System prompt (body)" is prose, not a call.
    expect(banned.test("System prompt (body)")).toBe(false);
  });
});

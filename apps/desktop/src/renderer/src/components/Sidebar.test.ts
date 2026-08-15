/**
 * Pure-logic tests for the Sidebar's session-index assembly (design
 * ui-redesign-direction.md §2.3). Deliberately `.test.ts`, not `.test.tsx`:
 * this package's vitest config runs `environment: "node"` with no jsdom (same
 * rationale as SessionPicker.test.ts / App.test.ts) — the exported pure
 * functions `buildSidebarGroups` and `formatAge` carry all of the grouping /
 * dedupe / ordering / label logic, so they are covered directly instead of
 * DOM-rendering the component.
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/tabs.js";
import type { TabInfo } from "../tabs-store.js";
import {
  applyHiddenProjects,
  buildSidebarGroups,
  bulkDeleteConfirm,
  clampMenuLeft,
  deleteOlderNotice,
  filterSidebarGroups,
  formatAge,
  isRowDeletable,
  parseOlderThanDays,
  singleDeleteConfirm,
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
// REVIEW 15.08 (TASK.114 defect 1) — THE PROMPT GUARD. window.prompt is NOT
// supported by Electron: it THROWS "prompt() is not supported" the moment it
// is called. The old bulk-delete flow called it as the FIRST line of its
// handler (before every try), via `void …` — so the button silently did
// nothing: no dialog, no error, no notice. This guard fails on ANY occurrence
// of window.prompt / globalThis.prompt in the renderer's PRODUCTION source —
// so the next builder cannot quietly reintroduce a dead dialog. Pure-fn
// tests around the handler can never catch this class of bug.

describe("renderer prompt guard (TASK.114 review 15.08)", () => {
  it("no renderer production source calls window.prompt / globalThis.prompt (Electron throws on it)", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join, extname } = await import("node:path");

    const rendererRoot = join(__dirname, "..");
    const banned = /(?:window|globalThis)\s*\.\s*prompt\s*\(/;

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
      // Strip comments so a mentioned-in-passing prompt never trips the guard;
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
});

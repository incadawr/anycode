/**
 * Pure-logic tests for the shared pending-resume marker store (the sidebar /
 * command-palette "one row per session while it opens" dedupe). Deliberately
 * `.test.ts`, not `.test.tsx`: this package's vitest config runs
 * `environment: "node"` with no jsdom (same rationale as Sidebar.test.ts) —
 * the exported pure helpers carry the whole marker lifecycle and are covered
 * directly, `resumeWithMarker` runs against the app singleton (reset per
 * test), and the per-entry-point wiring is pinned source-level (the repo's
 * readFileSync guard idiom), since those callers are React handlers this
 * suite cannot render.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TabInfo } from "./tabs-store.js";
import type { CreateTabResult } from "../../shared/tabs.js";
import {
  clearPendingResume,
  createPendingResumesStore,
  markPendingResume,
  prunePendingResumes,
  resumedRepresentingTabId,
  resumeWithMarker,
  usePendingResumes,
} from "./pending-resumes.js";

function tab(overrides: Partial<TabInfo> & Pick<TabInfo, "tabId" | "workspace">): TabInfo {
  return {
    sessionId: null,
    hostExited: false,
    terminalOpen: false,
    lspPanelOpen: false,
    hooksPanelOpen: false,
    tasksPanelOpen: false,
    ...overrides,
  };
}

describe("markPendingResume / clearPendingResume", () => {
  it("arms without a tabId as null (the reply has not named the representing tab yet)", () => {
    expect(markPendingResume(new Map(), "s1")).toEqual(new Map([["s1", null]]));
  });

  it("re-targets the representing tabId once the reply lands", () => {
    const marks = markPendingResume(new Map(), "s1");
    expect(markPendingResume(marks, "s1", "t1")).toEqual(new Map([["s1", "t1"]]));
  });

  it("clears only the named session and never mutates the input (purity)", () => {
    const prev = new Map<string, string | null>([
      ["s1", "t1"],
      ["s2", null],
    ]);
    const next = clearPendingResume(prev, "s1");
    expect(next).toEqual(new Map([["s2", null]]));
    expect([...prev.entries()]).toEqual([
      ["s1", "t1"],
      ["s2", null],
    ]);
  });
});

describe("prunePendingResumes (the marker lifecycle)", () => {
  it("keeps an unbound + live representing tab (the hydration window)", () => {
    const prev = new Map([["s1", "t1"]]);
    expect(prunePendingResumes(prev, [tab({ tabId: "t1", workspace: "/w" })])).toBe(prev);
  });

  it("keeps a marker still awaiting its representing tab (armed, reply not landed)", () => {
    const prev = new Map<string, string | null>([["s1", null]]);
    expect(prunePendingResumes(prev, [tab({ tabId: "t-other", workspace: "/w" })])).toBe(prev);
  });

  it("drops a marker once any tab bound the session (the sessionId dedupe takes over)", () => {
    const prev = new Map([["s1", "t1"]]);
    const tabs = [tab({ tabId: "t1", workspace: "/w", sessionId: "s1" })];
    expect(prunePendingResumes(prev, tabs)).toEqual(new Map());
  });

  it("drops a bound marker even while its representing tabId is still unknown", () => {
    const prev = new Map<string, string | null>([["s1", null]]);
    const tabs = [tab({ tabId: "t9", workspace: "/w", sessionId: "s1" })];
    expect(prunePendingResumes(prev, tabs)).toEqual(new Map());
  });

  it("drops a marker whose representing tab closed mid-hydration (the history row must come back)", () => {
    const prev = new Map([["s1", "t1"]]);
    expect(prunePendingResumes(prev, [tab({ tabId: "t2", workspace: "/w" })])).toEqual(new Map());
  });

  it("drops a marker whose representing tab's host exited before host_ready (the session must be re-resumable)", () => {
    const prev = new Map([["s1", "t1"]]);
    const tabs = [tab({ tabId: "t1", workspace: "/w", hostExited: true })];
    expect(prunePendingResumes(prev, tabs)).toEqual(new Map());
  });

  it("prunes selectively: settled siblings drop, in-flight ones survive, input untouched (purity)", () => {
    const prev = new Map<string, string | null>([
      ["s-done", "t1"],
      ["s-live", "t2"],
      ["s-armed", null],
    ]);
    const tabs = [
      tab({ tabId: "t1", workspace: "/w", sessionId: "s-done" }),
      tab({ tabId: "t2", workspace: "/w" }),
    ];
    const next = prunePendingResumes(prev, tabs);
    expect(next).toEqual(
      new Map<string, string | null>([
        ["s-live", "t2"],
        ["s-armed", null],
      ]),
    );
    expect(prev.size).toBe(3);
  });

  it("an empty marker set stays empty and returns the same reference (no spurious store writes)", () => {
    const prev = new Map<string, string | null>();
    expect(prunePendingResumes(prev, [tab({ tabId: "t1", workspace: "/w" })])).toBe(prev);
  });
});

describe("resumedRepresentingTabId", () => {
  it("ok → the new tab; already_open → the focused existing tab", () => {
    expect(resumedRepresentingTabId({ ok: true, tabId: "t1", workspace: "/w" })).toBe("t1");
    expect(resumedRepresentingTabId({ ok: false, reason: "already_open", focusTabId: "t2" })).toBe("t2");
  });

  it("any other refusal → undefined (the marker must clear)", () => {
    expect(resumedRepresentingTabId({ ok: false, reason: "max_tabs" })).toBeUndefined();
  });
});

describe("resumeWithMarker (against the app singleton, reset per test)", () => {
  const reset = (): void => {
    usePendingResumes.setState({ marks: new Map() });
  };

  it("arms the marker synchronously — BEFORE the createTab reply lands — then settles it with the tabId", async () => {
    reset();
    let resolve!: (result: CreateTabResult) => void;
    const createTab = (): Promise<CreateTabResult> =>
      new Promise<CreateTabResult>((res) => {
        resolve = res;
      });

    const pending = resumeWithMarker("s1", createTab);

    // The reply is still pending, yet the marker is already armed (null tabId).
    expect(usePendingResumes.getState().marks.get("s1")).toBeNull();
    resolve({ ok: true, tabId: "t1", workspace: "/w" });
    await expect(pending).resolves.toEqual({ ok: true, tabId: "t1", workspace: "/w" });
    expect(usePendingResumes.getState().marks.get("s1")).toBe("t1");
  });

  it("already_open marks the focused existing tab", async () => {
    reset();
    await resumeWithMarker("s1", async () => ({ ok: false, reason: "already_open", focusTabId: "t2" }));
    expect(usePendingResumes.getState().marks.get("s1")).toBe("t2");
  });

  it("a plain refusal clears the marker (the history row comes back)", async () => {
    reset();
    await resumeWithMarker("s1", async () => ({ ok: false, reason: "max_tabs" }));
    expect(usePendingResumes.getState().marks.has("s1")).toBe(false);
  });

  it("a rejected call clears the marker and rethrows (the caller's error handling runs unchanged)", async () => {
    reset();
    const boom = new Error("ipc down");
    await expect(
      resumeWithMarker("s1", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(usePendingResumes.getState().marks.has("s1")).toBe(false);
  });

  it("forwards the replacementConnectionId re-pin (W10-FIX F1) verbatim in the resume request", async () => {
    reset();
    let seen: unknown;
    await resumeWithMarker(
      "s1",
      async (request) => {
        seen = request;
        return { ok: true, tabId: "t1", workspace: "/w" };
      },
      "conn-2",
    );
    expect(seen).toEqual({ kind: "resume", sessionId: "s1", replacementConnectionId: "conn-2" });
  });

  it("forwards the plain resume request when no replacement is given", async () => {
    reset();
    let seen: unknown;
    await resumeWithMarker("s1", async (request) => {
      seen = request;
      return { ok: true, tabId: "t1", workspace: "/w" };
    });
    expect(seen).toEqual({ kind: "resume", sessionId: "s1" });
  });
});

describe("createPendingResumesStore (the factory; test isolation like createTabsStore)", () => {
  it("mark/clear/prune are thin wrappers over the pure helpers", () => {
    const store = createPendingResumesStore();
    expect(store.getState().marks.size).toBe(0);
    store.getState().mark("s1");
    expect(store.getState().marks.get("s1")).toBeNull();
    store.getState().mark("s1", "t1");
    expect(store.getState().marks.get("s1")).toBe("t1");
    // A prune with nothing to drop keeps the reference (no spurious writes).
    const before = store.getState().marks;
    store.getState().prune([tab({ tabId: "t1", workspace: "/w" })]);
    expect(store.getState().marks).toBe(before);
    store.getState().prune([tab({ tabId: "t1", workspace: "/w", sessionId: "s1" })]);
    expect(store.getState().marks.size).toBe(0);
    store.getState().clear("s1");
    expect(store.getState().marks.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING GUARD. The dedupe only holds if EVERY resume entry point goes
// through `resumeWithMarker` and BOTH buildSidebarGroups consumers feed it the
// shared markers. Pure-fn tests around the helpers can never catch a caller
// quietly bypassing the seam, so this pins the source itself (the same
// readFileSync guard idiom as Sidebar.test.ts's focus/native-dialog guards).
describe("every resume entry point goes through resumeWithMarker (source wiring)", () => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  // Strip comments so a request literal mentioned in passing (doc comments
  // describe the wire shape) never trips the no-bypass check; real call sites
  // survive the strip.
  const code = (path: string): string =>
    src(path)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  const bypass = /createTab\(\s*\{\s*kind:\s*"resume"/;

  it("the sidebar click path arms the shared marker", () => {
    expect(src("./components/Sidebar.tsx")).toMatch(/resumeWithMarker\(/);
    // No local bypass left: the component never builds the resume createTab
    // request literal directly anymore.
    expect(code("./components/Sidebar.tsx")).not.toMatch(bypass);
  });

  it("the command-palette path (App's runResumeSession) arms the shared marker", () => {
    const source = src("./App.tsx");
    const run = source.slice(
      source.indexOf("function runResumeSession"),
      source.indexOf("function runToggleTerminal"),
    );
    expect(run.length).toBeGreaterThan(0);
    expect(run).toContain("resumeWithMarker(");
    expect(code("./App.tsx")).not.toMatch(bypass);
  });

  it("the Codex rollout import path arms the shared marker", () => {
    const source = src("./components/CodexRolloutImportDialog.tsx");
    const open = source.slice(
      source.indexOf("export async function openImportedSession"),
      source.indexOf("export interface PerformImportParams"),
    );
    expect(open.length).toBeGreaterThan(0);
    expect(open).toContain("resumeWithMarker(");
    expect(code("./components/CodexRolloutImportDialog.tsx")).not.toMatch(bypass);
  });

  it("the automation facade path arms the shared marker", () => {
    const source = src("./automation.ts");
    const fn = source.slice(
      source.indexOf("async resumeSession(sessionId"),
      source.indexOf("async closeTab(tabId"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("resumeWithMarker(");
    expect(code("./automation.ts")).not.toMatch(bypass);
  });

  it("both buildSidebarGroups consumers feed it the shared markers", () => {
    const call = /buildSidebarGroups\(tabs, sessions, undefined, new Set\(pendingResumes\.keys\(\)\)\)/;
    expect(src("./components/Sidebar.tsx")).toMatch(call);
    const palette = src("./components/CommandPalette.tsx");
    expect(palette).toMatch(call);
    expect(palette).toMatch(/usePendingResumes\(/);
  });
});

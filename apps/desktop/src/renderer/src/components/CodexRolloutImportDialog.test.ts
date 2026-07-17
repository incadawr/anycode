/**
 * Pure-logic tests for CodexRolloutImportDialog's exported helpers (TASK.52,
 * codex-profiles cut §8.8). Same `.test.ts`-only, no-jsdom rationale as every
 * other component test in this directory (CodexEnginePane.test.ts's own
 * header): this package's vitest config runs `environment: "node"`, so the
 * wizard's stage/view-state derivation and the import+open orchestration are
 * exercised through the component's exported pure builders/async functions,
 * not a rendered DOM.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodexProfileRecord } from "../../../shared/settings.js";
import type { CreateTabResult } from "../../../shared/tabs.js";
import {
  buildRolloutProfileOptions,
  describeRolloutListFailure,
  describeRolloutStageFailure,
  deriveRolloutRowLabel,
  formatRolloutSize,
  formatRolloutStatsLines,
  formatRolloutTimestamp,
  importDisabled,
  openImportedSession,
  performImportAndOpen,
  resolveDefaultImportModel,
  rolloutListProvenance,
  rolloutListViewState,
  rolloutPreviewProvenance,
  rolloutPreviewViewState,
  truncateRolloutPreview,
  type CodexRolloutImportResult,
  type CodexRolloutImportStats,
  type CodexRolloutListResult,
  type CodexRolloutPreviewResult,
  type RolloutStageFailureReason,
  type RolloutTabOpenDeps,
} from "./CodexRolloutImportDialog.js";

function profile(overrides: Partial<CodexProfileRecord> = {}): CodexProfileRecord {
  return { id: "personal", label: "Personal", createdAt: "2026-07-14T00:00:00.000Z", ...overrides };
}

const ZERO_STATS: CodexRolloutImportStats = {
  messages: 0,
  toolPairs: 0,
  reasoningDropped: 0,
  developerDropped: 0,
  imagesDropped: 0,
  orphansSynthesized: 0,
  collapsedToText: 0,
  malformedLines: 0,
  unknownRecordsSkipped: 0,
  unknownItemsSkipped: 0,
  unknownPartsSkipped: 0,
};

// ── buildRolloutProfileOptions ──

describe("buildRolloutProfileOptions", () => {
  it("always prepends the system pseudo-profile ahead of every registered profile", () => {
    const options = buildRolloutProfileOptions([profile({ id: "a", label: "A" }), profile({ id: "b", label: "B" })]);
    expect(options).toEqual([
      { id: "system", label: "System (current environment)" },
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
  });

  it("still yields just the system entry when there are no registered profiles", () => {
    expect(buildRolloutProfileOptions([])).toEqual([{ id: "system", label: "System (current environment)" }]);
  });
});

// ── formatRolloutTimestamp / formatRolloutSize / truncateRolloutPreview ──

describe("formatRolloutTimestamp", () => {
  it("formats as a fixed UTC 'YYYY-MM-DD HH:mm' label, independent of host timezone", () => {
    const mtimeMs = Date.parse("2026-07-14T09:05:00.000Z");
    expect(formatRolloutTimestamp(mtimeMs)).toBe("2026-07-14 09:05 UTC");
  });

  it("zero-pads single-digit month/day/hour/minute", () => {
    const mtimeMs = Date.parse("2026-01-02T03:04:00.000Z");
    expect(formatRolloutTimestamp(mtimeMs)).toBe("2026-01-02 03:04 UTC");
  });
});

describe("formatRolloutSize", () => {
  it("renders bytes below 1 KiB as a plain byte count", () => {
    expect(formatRolloutSize(512)).toBe("512 B");
  });

  it("renders KiB-scale sizes with one decimal", () => {
    expect(formatRolloutSize(2048)).toBe("2.0 KB");
  });

  it("renders MiB-scale sizes with one decimal", () => {
    expect(formatRolloutSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("truncateRolloutPreview", () => {
  it("passes undefined through unchanged", () => {
    expect(truncateRolloutPreview(undefined)).toBeUndefined();
  });

  it("collapses internal whitespace/newlines and leaves short text untouched", () => {
    expect(truncateRolloutPreview("hello\n  there   friend")).toBe("hello there friend");
  });

  it("truncates long text with an ellipsis marker rather than showing the whole thing", () => {
    const long = "x".repeat(200);
    const result = truncateRolloutPreview(long);
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.length).toBeLessThan(long.length);
  });
});

// ── deriveRolloutRowLabel (TASK.57: the list row's PRIMARY, human-readable name) ──

describe("deriveRolloutRowLabel", () => {
  const mtimeMs = Date.parse("2026-07-14T09:05:00.000Z");

  it("uses the first line of firstUserMessage, trimmed", () => {
    expect(deriveRolloutRowLabel({ firstUserMessage: "  fix the flaky test  ", mtimeMs })).toBe("fix the flaky test");
  });

  it("uses ONLY the first line of a multi-line message", () => {
    expect(deriveRolloutRowLabel({ firstUserMessage: "fix the flaky test\nhere are the details...", mtimeMs })).toBe("fix the flaky test");
  });

  it("caps at 80 characters, mirroring deriveSessionTitle's convention", () => {
    const long = "x".repeat(200);
    const result = deriveRolloutRowLabel({ firstUserMessage: long, mtimeMs });
    expect(result.length).toBe(80);
    expect(result).toBe(long.slice(0, 80));
  });

  it("falls back to the formatted timestamp when firstUserMessage is absent", () => {
    expect(deriveRolloutRowLabel({ mtimeMs })).toBe(formatRolloutTimestamp(mtimeMs));
  });

  it("falls back to the formatted timestamp when firstUserMessage is empty/whitespace-only", () => {
    expect(deriveRolloutRowLabel({ firstUserMessage: "   ", mtimeMs })).toBe(formatRolloutTimestamp(mtimeMs));
  });
});

// ── view-state derivation (enumerates every branch) ──

describe("rolloutListViewState", () => {
  it("null (no request yet) -> loading", () => {
    expect(rolloutListViewState(null)).toEqual({ kind: "loading" });
  });

  it("ok:false profile_not_found -> error carrying that reason", () => {
    const result: CodexRolloutListResult = { ok: false, reason: "profile_not_found" };
    expect(rolloutListViewState(result)).toEqual({ kind: "error", reason: "profile_not_found" });
  });

  it("ok:false not_readable -> error carrying that reason", () => {
    const result: CodexRolloutListResult = { ok: false, reason: "not_readable" };
    expect(rolloutListViewState(result)).toEqual({ kind: "error", reason: "not_readable" });
  });

  it("ok:true with zero rollouts -> the explicit empty state, not a silently blank list", () => {
    const result: CodexRolloutListResult = { ok: true, rollouts: [] };
    expect(rolloutListViewState(result)).toEqual({ kind: "empty" });
  });

  it("ok:true with rollouts -> loaded, carrying them", () => {
    const rollouts = [{ fileName: "2026/07/01/rollout-a.jsonl", sizeBytes: 100, mtimeMs: 1 }];
    const result: CodexRolloutListResult = { ok: true, rollouts };
    expect(rolloutListViewState(result)).toEqual({ kind: "loaded", rollouts });
  });
});

describe("rolloutPreviewViewState", () => {
  const REASONS: RolloutStageFailureReason[] = ["profile_not_found", "invalid_file_name", "not_readable", "too_large"];

  it("null -> loading", () => {
    expect(rolloutPreviewViewState(null)).toEqual({ kind: "loading" });
  });

  it.each(REASONS)("ok:false %s -> error carrying that reason", (reason) => {
    const result: CodexRolloutPreviewResult = { ok: false, reason };
    expect(rolloutPreviewViewState(result)).toEqual({ kind: "error", reason });
  });

  it("ok:true -> loaded, carrying the report", () => {
    const report = { stats: ZERO_STATS, meta: {}, warnings: [] };
    const result: CodexRolloutPreviewResult = { ok: true, report };
    expect(rolloutPreviewViewState(result)).toEqual({ kind: "loaded", report });
  });
});

// ── per-reason failure text (mirrors CodexEnginePane.test.ts's/SettingsScreen.test.ts's own "every reason has distinct, non-empty text" pattern) ──

describe("describeRolloutListFailure", () => {
  it("covers every reason with distinct, non-empty text", () => {
    const reasons: ("profile_not_found" | "not_readable")[] = ["profile_not_found", "not_readable"];
    const texts = reasons.map(describeRolloutListFailure);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("describeRolloutStageFailure", () => {
  it("covers every reason with distinct, non-empty text", () => {
    const reasons: RolloutStageFailureReason[] = ["profile_not_found", "invalid_file_name", "not_readable", "too_large", "invalid_model"];
    const texts = reasons.map(describeRolloutStageFailure);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("states the real 32 MiB cap for too_large, not a vague message", () => {
    expect(describeRolloutStageFailure("too_large")).toContain("32 MiB");
  });

  it("tells the user to pick a model for invalid_model, distinct from the profile_not_found message (F2 review lane FXH)", () => {
    expect(describeRolloutStageFailure("invalid_model")).toBe("Pick a model for the new session first.");
  });
});

// ── formatRolloutStatsLines (cut §8.8's honesty requirement) ──

describe("formatRolloutStatsLines", () => {
  it("a lossless report (every counter zero) renders no lines at all", () => {
    expect(formatRolloutStatsLines(ZERO_STATS)).toEqual([]);
  });

  it("surfaces reasoning-dropped, tools-collapsed, and images-omitted with their real counts", () => {
    const stats: CodexRolloutImportStats = { ...ZERO_STATS, reasoningDropped: 3, collapsedToText: 2, imagesDropped: 1 };
    expect(formatRolloutStatsLines(stats)).toEqual(["3 reasoning dropped", "2 tools collapsed to text", "1 images omitted"]);
  });

  it("sums malformed + all three unknown-skip counters into one unrecognized-lines line", () => {
    const stats: CodexRolloutImportStats = { ...ZERO_STATS, malformedLines: 1, unknownRecordsSkipped: 2, unknownItemsSkipped: 3, unknownPartsSkipped: 4 };
    expect(formatRolloutStatsLines(stats)).toEqual(["10 unrecognized lines skipped"]);
  });

  it("omits a counter's line entirely when it is zero, even alongside other non-zero counters", () => {
    const stats: CodexRolloutImportStats = { ...ZERO_STATS, imagesDropped: 5 };
    const lines = formatRolloutStatsLines(stats);
    expect(lines).toEqual(["5 images omitted"]);
    expect(lines.some((line) => line.includes("reasoning"))).toBe(false);
  });
});

// ── resolveDefaultImportModel ──

describe("resolveDefaultImportModel", () => {
  const catalog = [{ id: "gpt-5", name: "GPT-5" }, { id: "opus", name: "Opus" }];

  it("keeps the active model when it is a member of the catalog", () => {
    expect(resolveDefaultImportModel("opus", catalog)).toBe("opus");
  });

  it("falls back to the catalog's first entry when the active model isn't in it", () => {
    expect(resolveDefaultImportModel("stale-model", catalog)).toBe("gpt-5");
  });

  it("falls back to the catalog's first entry when there is no active model at all", () => {
    expect(resolveDefaultImportModel(undefined, catalog)).toBe("gpt-5");
  });

  it("falls back to the raw active model when the catalog is empty/absent", () => {
    expect(resolveDefaultImportModel("whatever-model", undefined)).toBe("whatever-model");
  });

  it("resolves to an empty string when there is neither an active model nor a catalog", () => {
    expect(resolveDefaultImportModel(undefined, undefined)).toBe("");
  });
});

// ── importDisabled (F2 review lane FXH: honest gate — a custom provider's
// active connection with no model picks an empty "" model, which the old
// `previewState.kind !== "loaded" || importing` gate left clickable) ──

describe("importDisabled", () => {
  it("a loaded preview, not importing, with a real picked model -> enabled", () => {
    expect(importDisabled("loaded", false, "gpt-5")).toBe(false);
  });

  it("an empty model disables Import even though the preview loaded and nothing is importing (red-proof: the old gate never checked model)", () => {
    expect(importDisabled("loaded", false, "")).toBe(true);
  });

  it("a non-loaded preview disables Import regardless of model", () => {
    expect(importDisabled("loading", false, "gpt-5")).toBe(true);
    expect(importDisabled("error", false, "gpt-5")).toBe(true);
  });

  it("an in-flight import disables Import regardless of model", () => {
    expect(importDisabled("loaded", true, "gpt-5")).toBe(true);
  });
});

// ── provenance stamps (W4-F0c finding B): the DOM signs WHOSE reply it
// renders. The stamp derives from the RESULT's own provenance — never from
// the current selection — so the stale-window/stale-reply states an
// automation probe can observe are honestly labelled with their origin. ──

describe("rolloutListProvenance", () => {
  it("stamps from the RESULT's provenance, not the current select: state {profileId:'B', listResult.forProfileId:'A'} renders data-rollouts-for='A'", () => {
    // The exact transient the passive-effect window / a stale reply creates:
    // the select already committed B while the state still holds A's reply.
    // The honest stamp signs the CONTENT's origin (A); a from-select
    // derivation would dishonestly sign it as B.
    const staleListResult: { forProfileId: string; result: CodexRolloutListResult } = {
      forProfileId: "A",
      result: { ok: true, rollouts: [{ fileName: "2026/07/01/rollout-a.jsonl", sizeBytes: 100, mtimeMs: 1 }] },
    };
    expect(rolloutListProvenance({ profileId: "B", listResult: staleListResult })).toBe("A");
  });

  it("no stamp while loading (null result) — the attribute is absent, never pre-stamped with the pending profile", () => {
    expect(rolloutListProvenance({ profileId: "B", listResult: null })).toBeUndefined();
  });
});

describe("rolloutPreviewProvenance", () => {
  const report = { stats: ZERO_STATS, meta: {}, warnings: [] };

  it("stamps from the RESULT's provenance, not the current selection: state {selectedFileName:'b.jsonl', previewResult.forFileName:'a.jsonl'} renders data-preview-for='a.jsonl'", () => {
    const stalePreviewResult: { forFileName: string; result: CodexRolloutPreviewResult } = {
      forFileName: "a.jsonl",
      result: { ok: true, report },
    };
    expect(rolloutPreviewProvenance({ selectedFileName: "b.jsonl", previewResult: stalePreviewResult })).toBe("a.jsonl");
  });

  it("no stamp while loading (null result) — the attribute is absent, never pre-stamped with the pending file", () => {
    expect(rolloutPreviewProvenance({ selectedFileName: "b.jsonl", previewResult: null })).toBeUndefined();
  });
});

// ── openImportedSession / performImportAndOpen (the resume-path red-proof surface) ──

function fakeTabsStore() {
  const addTab = vi.fn();
  const setActiveTab = vi.fn();
  const state = { addTab, setActiveTab };
  return { tabsStore: { getState: () => state } as RolloutTabOpenDeps["tabsStore"], addTab, setActiveTab };
}

describe("openImportedSession", () => {
  it("resumes via kind:resume with the given sessionId, then adds + focuses the RESULTING tab (not any id from the caller)", async () => {
    const { tabsStore, addTab, setActiveTab } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "tab-77", workspace: "/real/workspace" }));

    const message = await openImportedSession("session-abc", { createTab, tabsStore });

    expect(createTab).toHaveBeenCalledWith({ kind: "resume", sessionId: "session-abc" });
    expect(addTab).toHaveBeenCalledWith({ tabId: "tab-77", workspace: "/real/workspace" });
    expect(setActiveTab).toHaveBeenCalledWith("tab-77");
    expect(message).toBeNull();
  });

  it("an already-open session focuses the existing tab instead of adding a new one", async () => {
    const { tabsStore, addTab, setActiveTab } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "already_open", focusTabId: "tab-existing" }));

    const message = await openImportedSession("session-abc", { createTab, tabsStore });

    expect(addTab).not.toHaveBeenCalled();
    expect(setActiveTab).toHaveBeenCalledWith("tab-existing");
    expect(message).not.toBeNull();
  });

  it("a plain resume failure (e.g. max_tabs) returns notice text and touches neither store method", async () => {
    const { tabsStore, addTab, setActiveTab } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "max_tabs" }));

    const message = await openImportedSession("session-abc", { createTab, tabsStore });

    expect(addTab).not.toHaveBeenCalled();
    expect(setActiveTab).not.toHaveBeenCalled();
    expect(message).toBe("Cannot open another tab — the maximum number of tabs is already open.");
  });
});

describe("performImportAndOpen", () => {
  it("sends the import request with exactly the caller's profileId/fileName/model — the user's picked model, not a default", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-xyz", workspace: "/imported/workspace", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "tab-1", workspace: "/imported/workspace" }));

    await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "profile-1", fileName: "2026/07/01/rollout-a.jsonl", model: "picked-model" });

    expect(rolloutImport).toHaveBeenCalledWith("profile-1", "2026/07/01/rollout-a.jsonl", "picked-model");
  });

  it("opens EXACTLY the returned sessionId via resume, never a blank new tab — and uses the resume result's own tabId/workspace, not the import result's", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-returned-by-import", workspace: "workspace-from-import", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore, addTab, setActiveTab } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "tab-from-resume", workspace: "workspace-from-resume" }));

    const outcome = await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" });

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith({ kind: "resume", sessionId: "session-returned-by-import" });
    // Red-proof: if the implementation ever opened `{kind:"new"}` or reused the import
    // result's own workspace instead of the resume call's, this would fail.
    expect(addTab).toHaveBeenCalledWith({ tabId: "tab-from-resume", workspace: "workspace-from-resume" });
    expect(setActiveTab).toHaveBeenCalledWith("tab-from-resume");
    expect(outcome).toEqual({ ok: true, openMessage: null });
  });

  it("a refused import never calls createTab at all — there is nothing to resume", async () => {
    const rolloutImport = vi.fn(async (): Promise<CodexRolloutImportResult> => ({ ok: false, reason: "too_large" }));
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "should-not-happen", workspace: "x" }));

    const outcome = await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" });

    expect(createTab).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "too_large" });
  });

  it("a successful import whose resume then fails still reports ok:true (the session IS persisted) but surfaces the resume failure as openMessage", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-1", workspace: "ws", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore, addTab } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "max_tabs" }));

    const outcome = await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" });

    expect(addTab).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.openMessage).toBe("Cannot open another tab — the maximum number of tabs is already open.");
  });

  // ── onOpened (TASK.57 "open means open": fires the Settings-dialog close callback ONLY on a full success) ──

  it("fires onOpened exactly once when the import AND the resume both succeed", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-1", workspace: "ws", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "tab-1", workspace: "ws" }));
    const onOpened = vi.fn();

    await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" }, onOpened);

    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("never fires onOpened when the import itself is refused", async () => {
    const rolloutImport = vi.fn(async (): Promise<CodexRolloutImportResult> => ({ ok: false, reason: "too_large" }));
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "should-not-happen", workspace: "x" }));
    const onOpened = vi.fn();

    await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" }, onOpened);

    expect(onOpened).not.toHaveBeenCalled();
  });

  it("never fires onOpened when the import succeeds but the resume/open fails (the user must still see the error, staying in Settings)", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-1", workspace: "ws", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "max_tabs" }));
    const onOpened = vi.fn();

    await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" }, onOpened);

    expect(onOpened).not.toHaveBeenCalled();
  });

  it("an already-open session (focus, not add) still carries a notice — openMessage stays non-null, so onOpened does NOT fire", async () => {
    const rolloutImport = vi.fn(
      async (): Promise<CodexRolloutImportResult> => ({ ok: true, sessionId: "session-1", workspace: "ws", report: { stats: ZERO_STATS, meta: {}, warnings: [] } }),
    );
    const { tabsStore } = fakeTabsStore();
    const createTab = vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "already_open", focusTabId: "tab-existing" }));
    const onOpened = vi.fn();

    const outcome = await performImportAndOpen({ rolloutImport }, { createTab, tabsStore }, { profileId: "p", fileName: "f", model: "m" }, onOpened);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.openMessage).not.toBeNull();
    expect(onOpened).not.toHaveBeenCalled();
  });
});

/**
 * Pure-logic tests for the New Session start screen (slice P7.12 §4.5). Same
 * `.test.ts`-only rationale as App.test.ts/TodoPanel.test.ts: no jsdom in this
 * package's vitest config, so the exported decision functions are exercised
 * directly rather than through DOM rendering.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyStarterPreset,
  computeModelChipDisplay,
  computeProjectLabel,
  computeSendDisabledReason,
  deriveRecentWorkspaces,
  guardedSubmit,
  isSendKeydown,
  pickFolderForDraft,
  pickModelForDraft,
  resolveProviderDefaultModel,
  seedWorkspaceFromRecents,
  type FolderPickDeps,
  type ModelPickDeps,
} from "./StartScreen.js";
import { createTabsStore } from "../tabs-store.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import type { StartSubmitResult } from "../start-session.js";

function session(over: Partial<SessionSummary> & { id: string; workspace: string; updatedAt: number }): SessionSummary {
  return { model: "m1", mode: "build", createdAt: over.updatedAt, ...over };
}

describe("computeProjectLabel (§2-D2)", () => {
  it("shows the workspace's basename once one is selected", () => {
    expect(computeProjectLabel("/Users/dev/my-project")).toBe("my-project");
    expect(computeProjectLabel("/Users/dev/my-project/")).toBe("my-project");
  });

  it("prompts to choose a project while none is selected", () => {
    expect(computeProjectLabel(null)).toBe("Choose a project");
  });
});

describe("computeSendDisabledReason (§3-D3)", () => {
  it("disabled with 'Choose a project first' while workspace is null, regardless of prompt", () => {
    expect(computeSendDisabledReason({ workspace: null, prompt: "", engine: "core", model: null, mode: "build" })).toBe("Choose a project first");
    expect(computeSendDisabledReason({ workspace: null, prompt: "hello", engine: "core", model: null, mode: "build" })).toBe("Choose a project first");
  });

  it("disabled with 'Type a message to send' once a folder is chosen but the prompt is blank/whitespace", () => {
    expect(computeSendDisabledReason({ workspace: "/ws/a", prompt: "", engine: "core", model: null, mode: "build" })).toBe("Type a message to send");
    expect(computeSendDisabledReason({ workspace: "/ws/a", prompt: "   ", engine: "core", model: null, mode: "build" })).toBe("Type a message to send");
  });

  it("enabled (undefined reason) once both a folder and a non-blank prompt are present", () => {
    expect(computeSendDisabledReason({ workspace: "/ws/a", prompt: "hello", engine: "core", model: null, mode: "build" })).toBeUndefined();
  });
});

describe("isSendKeydown (Composer.tsx parity)", () => {
  it("Enter without Shift sends", () => {
    expect(isSendKeydown({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("Shift+Enter is a newline, not a send", () => {
    expect(isSendKeydown({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("any other key is not a send", () => {
    expect(isSendKeydown({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("applyStarterPreset", () => {
  it("fills an empty draft", () => {
    expect(applyStarterPreset("", "Review the changes.")).toBe("Review the changes.");
  });

  it("appends without destroying a typed draft", () => {
    expect(applyStarterPreset("My notes", "Review the changes.")).toBe("My notes\nReview the changes.");
  });
});

describe("deriveRecentWorkspaces (§3-D4)", () => {
  it("dedupes by workspace, keeping the max updatedAt", () => {
    const sessions = [
      session({ id: "1", workspace: "/ws/a", updatedAt: 100 }),
      session({ id: "2", workspace: "/ws/a", updatedAt: 200 }),
    ];
    expect(deriveRecentWorkspaces(sessions, [])).toEqual(["/ws/a"]);
  });

  it("orders by recency, most recent first", () => {
    const sessions = [
      session({ id: "1", workspace: "/ws/old", updatedAt: 100 }),
      session({ id: "2", workspace: "/ws/new", updatedAt: 300 }),
      session({ id: "3", workspace: "/ws/mid", updatedAt: 200 }),
    ];
    expect(deriveRecentWorkspaces(sessions, [])).toEqual(["/ws/new", "/ws/mid", "/ws/old"]);
  });

  it("excludes hidden workspaces", () => {
    const sessions = [
      session({ id: "1", workspace: "/ws/hidden", updatedAt: 300 }),
      session({ id: "2", workspace: "/ws/visible", updatedAt: 100 }),
    ];
    expect(deriveRecentWorkspaces(sessions, ["/ws/hidden"])).toEqual(["/ws/visible"]);
  });

  it("caps at the given limit (default 8, bumped from F5#1a's 5 now that recents live in a popover)", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session({ id: String(i), workspace: `/ws/${i}`, updatedAt: i }));
    expect(deriveRecentWorkspaces(sessions, [])).toHaveLength(8);
    expect(deriveRecentWorkspaces(sessions, [], 2)).toHaveLength(2);
  });

  it("returns [] for no sessions", () => {
    expect(deriveRecentWorkspaces([], [])).toEqual([]);
  });
});

describe("guardedSubmit (double-submit guard, codex P7.12 review fix)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("a second submit fired while the first is still in-flight does not call submit twice", async () => {
    const { promise, resolve } = deferred<StartSubmitResult>();
    const submit = vi.fn(() => promise);
    const setSubmitting = vi.fn();
    const onToast = vi.fn();
    const guard = { current: false };

    const first = guardedSubmit({ canSend: true, guard, setSubmitting, submit, onToast });
    const second = guardedSubmit({ canSend: true, guard, setSubmitting, submit, onToast });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(guard.current).toBe(true);

    resolve({ ok: true, tabId: "t1" });
    await Promise.all([first, second]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(guard.current).toBe(false);
    expect(setSubmitting).toHaveBeenNthCalledWith(1, true);
    expect(setSubmitting).toHaveBeenNthCalledWith(2, false);
  });

  it("canSend===false is a no-op — submit is never called", async () => {
    const submit = vi.fn(async (): Promise<StartSubmitResult> => ({ ok: true, tabId: "t1" }));
    const guard = { current: false };

    await guardedSubmit({ canSend: false, guard, setSubmitting: vi.fn(), submit, onToast: vi.fn() });

    expect(submit).not.toHaveBeenCalled();
    expect(guard.current).toBe(false);
  });

  it("a {ok:false} result surfaces via onToast and the guard resets for a retry", async () => {
    const submit = vi.fn(async (): Promise<StartSubmitResult> => ({ ok: false, message: "nope" }));
    const onToast = vi.fn();
    const guard = { current: false };

    await guardedSubmit({ canSend: true, guard, setSubmitting: vi.fn(), submit, onToast });

    expect(onToast).toHaveBeenCalledWith("shell_error", "nope");
    expect(guard.current).toBe(false);
  });
});

describe("pickFolderForDraft (§4.5 folder control wiring)", () => {
  function makeDeps(result: { workspace: string | null }): { deps: FolderPickDeps; tabsStore: ReturnType<typeof createTabsStore> } {
    const tabsStore = createTabsStore();
    const pickWorkspace = vi.fn(async () => result);
    return { deps: { pickWorkspace, tabsStore }, tabsStore };
  }

  it("a non-cancelled pick writes the workspace onto the draft", async () => {
    const { deps, tabsStore } = makeDeps({ workspace: "/picked/dir" });
    tabsStore.getState().openDraft();

    await pickFolderForDraft(deps);

    expect(tabsStore.getState().draft?.workspace).toBe("/picked/dir");
  });

  it("a cancelled pick (workspace: null) leaves the draft's workspace untouched", async () => {
    const { deps, tabsStore } = makeDeps({ workspace: null });
    tabsStore.getState().openDraft("/existing");

    await pickFolderForDraft(deps);

    expect(tabsStore.getState().draft?.workspace).toBe("/existing");
  });
});

describe("resolveProviderDefaultModel (§3-D3)", () => {
  it("prefers the per-provider default over the top-level provider.model", () => {
    expect(resolveProviderDefaultModel("gpt-5", { anthropic: { model: "claude-opus" } }, "anthropic")).toBe("claude-opus");
  });

  it("falls back to provider.model when no per-provider default is recorded for this pid", () => {
    expect(resolveProviderDefaultModel("gpt-5", undefined, "anthropic")).toBe("gpt-5");
    expect(resolveProviderDefaultModel("gpt-5", { other: { model: "x" } }, "anthropic")).toBe("gpt-5");
  });

  it("falls back to '' when neither a default nor provider.model is set", () => {
    expect(resolveProviderDefaultModel(undefined, undefined, "custom")).toBe("");
  });
});

describe("computeModelChipDisplay (§3-D3)", () => {
  const models = [
    { id: "claude-opus", name: "Claude Opus" },
    { id: "claude-sonnet", name: "Claude Sonnet" },
  ];

  it("shows the resolved default, marked isDefault, while the draft has no explicit pick", () => {
    expect(computeModelChipDisplay(null, "claude-opus", models)).toEqual({
      modelId: "claude-opus",
      label: "Claude Opus",
      isDefault: true,
    });
  });

  it("shows the draft's explicit pick, not marked isDefault, once one is chosen", () => {
    expect(computeModelChipDisplay("claude-sonnet", "claude-opus", models)).toEqual({
      modelId: "claude-sonnet",
      label: "Claude Sonnet",
      isDefault: false,
    });
  });

  it("falls back to the raw id as the label for a free-text/uncatalogued model", () => {
    expect(computeModelChipDisplay("custom-model", "claude-opus", models)).toEqual({
      modelId: "custom-model",
      label: "custom-model",
      isDefault: false,
    });
  });
});

describe("pickModelForDraft (§3-D3 model-chip wiring)", () => {
  function makeDeps(): { deps: ModelPickDeps; tabsStore: ReturnType<typeof createTabsStore> } {
    const tabsStore = createTabsStore();
    return { deps: { tabsStore }, tabsStore };
  }

  it("writes the clicked model id onto the draft via setDraftModel", () => {
    const { deps, tabsStore } = makeDeps();
    tabsStore.getState().openDraft("/ws/a");

    pickModelForDraft("claude-sonnet", deps);

    expect(tabsStore.getState().draft?.model).toBe("claude-sonnet");
  });

  it("is a no-op while there is no draft (setDraftModel's own guard)", () => {
    const { deps, tabsStore } = makeDeps();

    pickModelForDraft("claude-sonnet", deps);

    expect(tabsStore.getState().draft).toBeNull();
  });
});

describe("seedWorkspaceFromRecents (slice-start-composer-cut §5 — preselect last project)", () => {
  it("returns recents[0] when a draft exists with no workspace chosen yet", () => {
    expect(seedWorkspaceFromRecents({ workspace: null, prompt: "", engine: "core", model: null, mode: "build" }, ["/ws/a", "/ws/b"])).toBe("/ws/a");
  });

  it("does not overwrite an explicit workspace pick", () => {
    expect(seedWorkspaceFromRecents({ workspace: "/explicit", prompt: "", engine: "core", model: null, mode: "build" }, ["/ws/a"])).toBeNull();
  });

  it("returns null for empty recents — keeps the 'Choose a project first' gate intact", () => {
    expect(seedWorkspaceFromRecents({ workspace: null, prompt: "", engine: "core", model: null, mode: "build" }, [])).toBeNull();
  });

  it("returns null when there is no draft at all", () => {
    expect(seedWorkspaceFromRecents(null, ["/ws/a"])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  beginToastExit,
  enqueueToast,
  removeToast,
  rewriteToastText,
  TOAST_AUTO_HIDE_MS,
  TOAST_CAP,
  toastGlyph,
  toastTone,
  type Toast,
  type ToastKind,
} from "./toasts.js";

const ALL_KINDS: ToastKind[] = [
  "turn_rejected",
  "mode_change_rejected",
  "permission_settled",
  "compaction_start",
  "compaction_end",
  "microcompact",
  "stream_retry",
  "session_history_truncated",
  "image_attach_rejected",
  "background_task_rejected",
  "rewind_restored",
  "rewind_rejected",
  "shell_error",
];

describe("enqueueToast", () => {
  it("inserts one live entry into an empty list", () => {
    const result = enqueueToast([], { id: 1, kind: "compaction_start", text: "Compacting…" });
    expect(result).toEqual([{ id: 1, kind: "compaction_start", text: "Compacting…", leaving: false, revision: 0 }]);
  });

  it("is newest-first for distinct kinds", () => {
    const afterA = enqueueToast([], { id: 1, kind: "compaction_start", text: "A" });
    const afterB = enqueueToast(afterA, { id: 2, kind: "microcompact", text: "B" });
    expect(afterB.map((t) => t.id)).toEqual([2, 1]);
  });

  it("coalesces a same-kind live arrival into one entry, bumping revision", () => {
    const afterA = enqueueToast([], { id: 1, kind: "stream_retry", text: "Attempt 1" });
    const afterB = enqueueToast(afterA, { id: 2, kind: "stream_retry", text: "Attempt 2" });
    expect(afterB).toHaveLength(1);
    expect(afterB[0]).toEqual({ id: 1, kind: "stream_retry", text: "Attempt 2", leaving: false, revision: 1 });
  });

  it("does not coalesce into a leaving entry of the same kind", () => {
    const leavingList: readonly Toast[] = [
      { id: 1, kind: "stream_retry", text: "Attempt 1", leaving: true, revision: 0 },
    ];
    const result = enqueueToast(leavingList, { id: 2, kind: "stream_retry", text: "Attempt 2" });
    expect(result).toEqual([
      { id: 2, kind: "stream_retry", text: "Attempt 2", leaving: false, revision: 0 },
      { id: 1, kind: "stream_retry", text: "Attempt 1", leaving: true, revision: 0 },
    ]);
  });

  it("marks a live compaction_start as leaving when compaction_end arrives", () => {
    const afterStart = enqueueToast([], { id: 1, kind: "compaction_start", text: "Compacting…" });
    const afterEnd = enqueueToast(afterStart, { id: 2, kind: "compaction_end", text: "Compacted." });
    expect(afterEnd).toEqual([
      { id: 2, kind: "compaction_end", text: "Compacted.", leaving: false, revision: 0 },
      { id: 1, kind: "compaction_start", text: "Compacting…", leaving: true, revision: 0 },
    ]);
  });

  it("supersede is a no-op when there is no live target", () => {
    const result = enqueueToast([], { id: 1, kind: "compaction_end", text: "Compacted." });
    expect(result).toEqual([{ id: 1, kind: "compaction_end", text: "Compacted.", leaving: false, revision: 0 }]);
  });

  it("caps live entries at TOAST_CAP, marking the oldest as leaving (not removed)", () => {
    let list: readonly Toast[] = [];
    list = enqueueToast(list, { id: 1, kind: "compaction_start", text: "1" });
    list = enqueueToast(list, { id: 2, kind: "microcompact", text: "2" });
    list = enqueueToast(list, { id: 3, kind: "session_history_truncated", text: "3" });
    list = enqueueToast(list, { id: 4, kind: "shell_error", text: "4" });
    expect(list).toHaveLength(4);
    const oldest = list.find((t) => t.id === 1);
    expect(oldest?.leaving).toBe(true);
    expect(list.filter((t) => !t.leaving)).toHaveLength(TOAST_CAP);
  });

  it("ignores leaving entries when counting toward the cap", () => {
    const list: readonly Toast[] = [
      { id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 },
      { id: 2, kind: "microcompact", text: "2", leaving: false, revision: 0 },
      { id: 3, kind: "session_history_truncated", text: "3", leaving: true, revision: 0 },
      { id: 4, kind: "stream_retry", text: "4", leaving: true, revision: 0 },
    ];
    const result = enqueueToast(list, { id: 5, kind: "shell_error", text: "5" });
    expect(result.filter((t) => !t.leaving)).toHaveLength(3);
    expect(result.filter((t) => t.leaving)).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 }];
    const snapshot = JSON.parse(JSON.stringify(list));
    enqueueToast(list, { id: 2, kind: "microcompact", text: "2" });
    expect(list).toEqual(snapshot);
  });
});

describe("beginToastExit", () => {
  it("marks the matching entry as leaving", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 }];
    expect(beginToastExit(list, 1)).toEqual([{ id: 1, kind: "compaction_start", text: "1", leaving: true, revision: 0 }]);
  });

  it("is idempotent on an already-leaving entry", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: true, revision: 0 }];
    expect(beginToastExit(list, 1)).toEqual(list);
  });

  it("is a no-op for an unknown id", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 }];
    expect(beginToastExit(list, 99)).toEqual(list);
  });

  it("leaves other entries untouched", () => {
    const list: readonly Toast[] = [
      { id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 },
      { id: 2, kind: "microcompact", text: "2", leaving: false, revision: 0 },
    ];
    const result = beginToastExit(list, 1);
    expect(result[1]).toEqual(list[1]);
  });

  it("does not mutate the input array", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: false, revision: 0 }];
    const snapshot = JSON.parse(JSON.stringify(list));
    beginToastExit(list, 1);
    expect(list).toEqual(snapshot);
  });
});

describe("removeToast", () => {
  it("removes the matching entry", () => {
    const list: readonly Toast[] = [
      { id: 1, kind: "compaction_start", text: "1", leaving: true, revision: 0 },
      { id: 2, kind: "microcompact", text: "2", leaving: false, revision: 0 },
    ];
    expect(removeToast(list, 1)).toEqual([list[1]]);
  });

  it("is a no-op for an unknown id", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: true, revision: 0 }];
    expect(removeToast(list, 99)).toEqual(list);
  });

  it("does not mutate the input array", () => {
    const list: readonly Toast[] = [{ id: 1, kind: "compaction_start", text: "1", leaving: true, revision: 0 }];
    const snapshot = JSON.parse(JSON.stringify(list));
    removeToast(list, 1);
    expect(list).toEqual(snapshot);
  });
});

describe("toastTone", () => {
  it("maps all kinds to their exact tone", () => {
    expect(toastTone("turn_rejected")).toBe("warning");
    expect(toastTone("permission_settled")).toBe("warning");
    expect(toastTone("stream_retry")).toBe("warning");
    expect(toastTone("mode_change_rejected")).toBe("danger");
    expect(toastTone("shell_error")).toBe("danger");
    expect(toastTone("compaction_start")).toBe("neutral");
    expect(toastTone("compaction_end")).toBe("neutral");
    expect(toastTone("microcompact")).toBe("neutral");
    expect(toastTone("session_history_truncated")).toBe("neutral");
    expect(toastTone("rewind_restored")).toBe("neutral");
    expect(toastTone("rewind_rejected")).toBe("danger");
  });
});

describe("toastGlyph", () => {
  it("maps neutral kinds to info and warning/danger kinds to warning", () => {
    for (const kind of ALL_KINDS) {
      const expected = toastTone(kind) === "neutral" ? "info" : "warning";
      expect(toastGlyph(kind)).toBe(expected);
    }
  });
});

describe("rewriteToastText", () => {
  it("rewrites all four table rows exactly", () => {
    expect(rewriteToastText("mode_change_rejected", "cannot change mode during an active turn")).toBe(
      "Mode change rejected — finish the running turn first.",
    );
    expect(
      rewriteToastText("turn_rejected", "Message rejected: the agent is still running the current turn."),
    ).toBe("Message not sent — stop the running turn or wait for it to finish.");
    expect(rewriteToastText("turn_rejected", "Message rejected: the host is not ready yet.")).toBe(
      "Message not sent — still connecting. Try again in a moment.",
    );
    expect(rewriteToastText("permission_settled", "Permission request timed out — denied.")).toBe(
      "Permission request timed out — the tool was denied. Run the turn again to retry.",
    );
  });

  it("passes through unknown text for a matching kind", () => {
    expect(rewriteToastText("mode_change_rejected", "some other reason")).toBe("some other reason");
  });

  it("passes through known text under the wrong kind", () => {
    expect(rewriteToastText("turn_rejected", "cannot change mode during an active turn")).toBe(
      "cannot change mode during an active turn",
    );
  });

  it("passes through shell_error text verbatim", () => {
    expect(rewriteToastText("shell_error", "Failed to create a new task.")).toBe(
      "Failed to create a new task.",
    );
  });
});

describe("constants", () => {
  it("TOAST_CAP is 3", () => {
    expect(TOAST_CAP).toBe(3);
  });

  it("TOAST_AUTO_HIDE_MS is 5000", () => {
    expect(TOAST_AUTO_HIDE_MS).toBe(5000);
  });
});

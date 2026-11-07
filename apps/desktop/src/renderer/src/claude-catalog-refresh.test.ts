import { describe, expect, it } from "vitest";
import { startClaudeCatalogRefresh } from "./use-claude-draft-models.js";
import { CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
import type { ClaudeDoctorReport } from "../../shared/claude-doctor.js";

it("uses fallback before confirmation, then cached choices, then fallback on failed identity", async () => {
  let apply = (_snapshot: { report: ClaudeDoctorReport }) => {};
  const writes: unknown[] = [];
  const stop = startClaudeCatalogRefresh({ recheck: async () => ({ report: { status: "ready", models: [{ id: "cached", label: "Cached 6.0" }] } }), onSnapshotChanged: fn => { apply = fn; return () => {}; } }, models => writes.push(models));
  expect(writes[0]).toBe(CLAUDE_DRAFT_MODELS);
  await Promise.resolve();
  expect(writes.at(-1)).toEqual([{ id: "cached", label: "Cached 6.0" }]);
  apply({ report: { status: "ready" } });
  expect(writes.at(-1)).toBe(CLAUDE_DRAFT_MODELS);
  stop();
});

describe("Claude catalog refresh ordering", () => {
  it("ignores a stale async reply after a newer account snapshot or disposal", async () => {
    let resolve!: (value: { report: ClaudeDoctorReport }) => void;
    let apply = (_snapshot: { report: ClaudeDoctorReport }) => {};
    const writes: unknown[] = [];
    const stop = startClaudeCatalogRefresh({ recheck: () => new Promise(done => { resolve = done; }), onSnapshotChanged: fn => { apply = fn; return () => {}; } }, models => writes.push(models));
    apply({ report: { status: "signed_out" } });
    resolve({ report: { status: "ready", models: [{ id: "stale" }] } });
    await Promise.resolve();
    expect(writes.at(-1)).toBe(CLAUDE_DRAFT_MODELS);
    stop();
    const count = writes.length;
    apply({ report: { status: "ready", models: [{ id: "disposed" }] } });
    expect(writes).toHaveLength(count);
  });
});

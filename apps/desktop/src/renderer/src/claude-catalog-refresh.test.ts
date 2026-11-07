import { describe, expect, it, vi } from "vitest";
import { startClaudeCatalogRefresh } from "./use-claude-draft-models.js";
import { createStartTabRequest } from "./start-session.js";
import { resolveClaudeDraftModel, CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
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

it("prefers arriving confirmed choices and normalizes display and submit to the same alias", async () => {
  const models = [{ id: "opus", label: "Confirmed Opus 5.5", resolvedId: "claude-opus-5-5" }];
  let choices: typeof CLAUDE_DRAFT_MODELS = [];
  const stop = startClaudeCatalogRefresh({ recheck: async () => ({ report: { status: "ready", models } }), onSnapshotChanged: () => () => {} }, value => { choices = value; });
  await Promise.resolve();
  expect(choices).toBe(models);
  const draft = { workspace: "/ws", engine: "claude" as const, model: "claude-opus-5-5" };
  expect(createStartTabRequest(draft, null, choices)).toMatchObject({ engineModel: resolveClaudeDraftModel(draft.model, choices) });
  expect(resolveClaudeDraftModel(draft.model, choices)).toBe("opus");
  stop();
});

it("keeps a fresh confirmed catalog across picker mounts without another probe", () => {
  const models = [{ id: "opus", resolvedId: "claude-opus-5-5" }];
  let probes = 0, writes = 0;
  let push = (_snapshot: { report: ClaudeDoctorReport }) => {};
  const stop = startClaudeCatalogRefresh({ recheck: async () => { probes++; return { report: { status: "ready" } }; }, onSnapshotChanged: fn => { push = fn; return () => {}; } }, () => { writes++; }, models, Date.now());
  expect(probes).toBe(0);
  expect(writes).toBe(0);
  push({ report: { status: "signed_out" } });
  expect(writes).toBe(1);
  stop();
});
it("does not seed fallback over an existing stale catalog", () => {
  const writes: unknown[] = [];
  const stop = startClaudeCatalogRefresh({ recheck: () => new Promise(() => {}), onSnapshotChanged: () => () => {} }, value => writes.push(value), [{ id: "opus" }]);
  expect(writes).toEqual([]);
  stop();
});

it("keeps confirmed choices on transient error and timeout", async () => {
  const models = [{ id: "opus" }];
  const writes: unknown[] = [];
  let push = (_snapshot: { report: ClaudeDoctorReport }) => {};
  const stop = startClaudeCatalogRefresh({ recheck: async () => { throw new Error("timeout"); }, onSnapshotChanged: fn => { push = fn; return () => {}; } }, value => writes.push(value), models);
  await Promise.resolve();
  push({ report: { status: "error" } });
  expect(writes).toEqual([]);
  push({ report: { status: "ready", catalogIdentity: "new-identity" } });
  expect(writes).toEqual([CLAUDE_DRAFT_MODELS]);
  stop();
});
it("backs off repeated fallback mounts for sixty seconds", async () => {
  let probes = 0;
  const bridge = { recheck: async () => { probes++; return { report: { status: "signed_out" as const } }; }, onSnapshotChanged: () => () => {} };
  const mount = () => startClaudeCatalogRefresh(bridge, () => {}, CLAUDE_DRAFT_MODELS);
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  try {
    mount()();
    await Promise.resolve();
    now.mockReturnValue(159_999);
    mount()();
    expect(probes).toBe(1);
    now.mockReturnValue(160_000);
    mount()();
    expect(probes).toBe(2);
  } finally { now.mockRestore(); }
});
it("omits engineModel when a shared draft id has no Claude match", () => {
  const draft = { workspace: "/ws", engine: "claude" as const, model: "gpt-other" };
  for (const models of [CLAUDE_DRAFT_MODELS, [{ id: "opus" }]]) {
    expect(resolveClaudeDraftModel(draft.model, models)).toBe("");
    expect(createStartTabRequest(draft, null, models)).not.toHaveProperty("engineModel");
  }
});

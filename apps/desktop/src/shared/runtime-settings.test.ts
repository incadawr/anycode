import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SqlitePersistenceAdapter, runtimeSettingsSchema, checkedRuntimeSettings, type RuntimeSettings } from "@anycode/core";
import { runtimeSwitchCommitSchema } from "./engine-switch-control.js";

const base = { version: 1 as const, engine: "claude" as const, model: "model", preset: "read-only" as const,
  permissionMode: "plan" as const, mcpDigest: "a".repeat(64), tools: ["Read"] };
const enabled: RuntimeSettings = { model: "model", mode: "read-only", orchestration: { enabled: true, baseMode: "plan", nativeBase: base } };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const oldSettings = z.object({ model: z.string(), mode: z.string(), effort: z.string().optional(), fast: z.boolean().optional(),
  orchestration: z.object({ enabled: z.literal(true), baseMode: z.enum(["plan", "build", "edit", "auto", "yolo"]) }).strict().optional() }).strict();

describe("durable native settings", () => {
  it("round-trips legacy and native payloads without widening old authority", () => {
    for (const value of [{ model: "m", mode: "read-only" }, { ...enabled, orchestration: { enabled: true, baseMode: "plan" } }, enabled]) {
      expect(runtimeSettingsSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    expect(oldSettings.safeParse(enabled).success).toBe(false);
    expect(oldSettings.safeParse({ model: "model", mode: "read-only" }).success).toBe(true);
  });
  it.each([{ version: 2 }, { engine: "other" }, { preset: "unknown" }, { permissionMode: "default" },
    { mcpDigest: "bad" }, { tools: null }, { env: { TOKEN: "credential-sentinel" } }, { configPath: "/private/config" }])("rejects malformed or unrecognized base %j", patch => {
    expect(runtimeSettingsSchema.safeParse({ ...enabled, orchestration: { ...enabled.orchestration, nativeBase: { ...base, ...patch } } }).success).toBe(false);
  });
  it("accepts only the versioned Codex policy digest contract", () => {
    const value = { ...enabled, orchestration: { enabled: true, baseMode: "plan", nativeBase:
      { version: 1, engine: "codex", model: "m", preset: "read-only", configDigest: "b".repeat(64) } } };
    expect(runtimeSettingsSchema.parse(value)).toEqual(value);
    expect(runtimeSettingsSchema.safeParse({ ...value, orchestration: { ...value.orchestration,
      nativeBase: { ...value.orchestration.nativeBase, config: { env: "credential-sentinel" } } } }).success).toBe(false);
  });
  it("rejects engine mismatch in settings and strict switch wire", () => {
    expect(() => checkedRuntimeSettings(enabled, "codex")).toThrow("engine mismatch");
    const record = { expectedRevision: 0, sourceSegmentId: "legacy", sourceItems: [],
      segment: { id: "next", engine: "codex", accountScope: "", nativeState: "fresh", selected: enabled, applied: enabled, startedAt: 1, coverage: "available_history" },
      boundary: { id: "b", segmentId: "next", text: "boundary", createdAt: 1 },
      handoff: { id: "h", segmentId: "next", sourceWatermark: null, payload: "", digest: "a".repeat(64), state: "pending" } };
    expect(runtimeSwitchCommitSchema.safeParse(record).success).toBe(false);
    record.segment.engine = "claude";
    expect(runtimeSwitchCommitSchema.parse(record)).toEqual(record);
    expect(runtimeSwitchCommitSchema.safeParse({ ...record, unknown: true }).success).toBe(false);
  });
  it("reads extended JSON from a database backup and downgrades wire only after checked OFF", async () => {
    const root = mkdtempSync(join(tmpdir(), "native-settings-")); roots.push(root);
    const path = join(root, "source.sqlite");
    const store = new SqlitePersistenceAdapter(path);
    await store.createSession({ id: "s", workspace: "/workspace", model: "model", mode: "plan", engineId: "claude" });
    store.ensureRuntimeSession("s");
    store.updateRuntimeSettings("s", "legacy", enabled, enabled);
    await store.close();
    const backup = join(root, "backup.sqlite"); copyFileSync(path, backup);
    const oldReader = new DatabaseSync(backup);
    const row = oldReader.prepare("SELECT selected_json,applied_json FROM runtime_segments").get()!;
    expect(JSON.parse(String(row.applied_json))).toEqual(enabled);
    expect(String(row.selected_json)).not.toContain("credential-sentinel");
    oldReader.close();
    const reopened = new SqlitePersistenceAdapter(backup);
    expect(reopened.loadRuntimeSession("s")!.segments[0]!.applied).toEqual(enabled);
    const raw = new DatabaseSync(backup);
    raw.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'write failed'); END");
    const off = { model: "model", mode: "read-only" };
    expect(() => reopened.updateRuntimeSettings("s", "legacy", off, off)).toThrow("write failed");
    expect(reopened.loadRuntimeSession("s")!.segments[0]).toMatchObject({ selected: enabled, applied: enabled });
    raw.exec("DROP TRIGGER fail_settings");
    reopened.updateRuntimeSettings("s", "legacy", off, off);
    expect(oldSettings.parse(reopened.loadRuntimeSession("s")!.segments[0]!.applied)).toEqual(off);
    raw.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'write failed'); END");
    expect(() => reopened.updateRuntimeSettings("s", "legacy", enabled, enabled)).toThrow("write failed");
    expect(reopened.loadRuntimeSession("s")!.segments[0]).toMatchObject({ selected: off, applied: off });
    raw.exec("DROP TRIGGER fail_settings");
    expect(() => reopened.updateRuntimeSettings("s", "legacy", enabled, { ...enabled, orchestration: { ...enabled.orchestration!, nativeBase: { ...base, version: 99 } } } as unknown as RuntimeSettings)).toThrow();
    expect(reopened.loadRuntimeSession("s")!.segments[0]!.applied).toEqual(off);
    raw.close(); await reopened.close();
  });
});

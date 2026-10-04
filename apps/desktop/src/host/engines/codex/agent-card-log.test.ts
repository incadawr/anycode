import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, type ToolResultPresentation } from "@anycode/core";
import { SqliteCodexAgentCardLog } from "./agent-card-log.js";

const presentation: ToolResultPresentation = { subagent: {
  kind: "subagent", version: 1,
  target: { kind: "session", childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" },
  identity: { agentType: "glm-lead", description: "review task", model: "glm-5.3", engine: null },
  counters: { turns: 3, toolCalls: 2, lastTool: "Agent" },
  activity: { entries: [{ toolName: "Agent", summary: "Flash completed" }], dropped: 0 },
  final: { status: "completed", durationMs: 500 },
} };

async function createParent(persistence: SqlitePersistenceAdapter) {
  await persistence.createSession({ id: "parent", workspace: "/repo", model: "gpt-6.1-sol", mode: "build", engineId: "codex", externalSessionRef: "native-thread" });
}

describe("Codex durable Agent card metadata", () => {
  it("restores the exact child target and counters after reopening SQLite without copying native transcript text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anycode-agent-cards-"));
    const path = join(directory, "history.sqlite");
    let persistence = new SqlitePersistenceAdapter(path);
    try {
      await createParent(persistence);
      const log = new SqliteCodexAgentCardLog(persistence, "parent");
      log.record("call-1", presentation);
      expect(await log.list()).toEqual(new Map([["call-1", presentation]]));
      const metadata = await persistence.loadHistory("parent");
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toMatchObject({ id: "codex-agent-card:call-1", tokenEstimate: 0,
        message: { role: "tool", content: [expect.objectContaining({ text: "" })] } });
      await persistence.close();
      persistence = new SqlitePersistenceAdapter(path);
      expect(await new SqliteCodexAgentCardLog(persistence, "parent").list()).toEqual(new Map([["call-1", presentation]]));
      await persistence.deleteSessionTree("parent");
      expect(await new SqliteCodexAgentCardLog(persistence, "parent").list()).toEqual(new Map());
    } finally {
      await persistence.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores ordinary transcript rows and isolates other session metadata", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    await createParent(persistence);
    await persistence.appendHistory("parent", [{ id: "native-transcript", createdAt: Date.now(),
      message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-2", toolName: "Agent", text: "text", status: "success", presentation }] } }]);
    const log = new SqliteCodexAgentCardLog(persistence, "parent");
    expect(await log.list()).toEqual(new Map());
    log.record("call-1", presentation);
    expect(await log.list()).toEqual(new Map([["call-1", presentation]]));
    expect(await new SqliteCodexAgentCardLog(persistence, "other-session").list()).toEqual(new Map());
    await persistence.close();
  });

  it("captures a snapshot and logs disk failures without failing the live tool", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    await createParent(persistence);
    const log = new SqliteCodexAgentCardLog(persistence, "parent");
    const mutable = structuredClone(presentation);
    log.record("call-1", mutable);
    mutable.subagent!.target = { kind: "inline" };
    expect((await log.list()).get("call-1")).toEqual(presentation);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    persistence.appendHistory = vi.fn().mockRejectedValue(new Error("disk full"));
    log.record("call-2", presentation);
    await log.list();
    expect(error).toHaveBeenCalledWith("[codex] agent card metadata write failed");
    error.mockRestore();
    await persistence.close();
  });
});

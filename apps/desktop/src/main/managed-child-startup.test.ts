import { SqlitePersistenceAdapter } from "@anycode/core";
import { describe, expect, it } from "vitest";
import { resolveBootSession } from "../host/boot.js";

describe("child boot workspace persistence", () => {
  it("creates a fresh child at the host workspace and resumes the stored workspace", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const args = { sessionId: "child-1", resume: false, child: { parentSessionId: "parent-1", spawnToolCallId: "call-1", initialMode: "plan" as const } };
      const fresh = await resolveBootSession(persistence, { args, workspace: "/managed", model: "m" });
      expect(fresh.sessionMeta.workspace).toBe("/managed");
      const resumed = await resolveBootSession(persistence, { args: { sessionId: "child-1", resume: true }, workspace: "/other", model: "m" });
      expect(resumed.sessionMeta.workspace).toBe("/managed");
    } finally {
      await persistence.close();
    }
  });
});

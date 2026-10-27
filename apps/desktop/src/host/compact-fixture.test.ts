import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../shared/protocol.js";
import { AppServerClient } from "./engines/codex/app-server-client.js";
import { createNativeCodexSession } from "./engines/codex/codex-engine.js";
import { ClaudeClient } from "./engines/claude/claude-client.js";
import { ClaudeEngine } from "./engines/claude/claude-engine.js";
import { ClaudeModelCatalog } from "./engines/claude/models.js";
import { findClaudePreset } from "./engines/claude/presets.js";
import { createHarness } from "./test-harness.js";

describe("Claude compact protocol fixture", () => {
  it("routes idle compact to the CLI and refuses a busy request without another frame", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-claude-wire-"));
    const fixture = fileURLToPath(new URL("../../scripts/compact-fixtures/claude.mjs", import.meta.url));
    const client = new ClaudeClient({ binaryPath: fixture, cwd: home, sourceEnv: { HOME: home, PATH: process.env.PATH }, enableSlashPassthrough: true });
    let h: ReturnType<typeof createHarness> | undefined;
    try {
      await client.start();
      const init = await client.initialize();
      const engine = new ClaudeEngine(client, "fixture-session", undefined, {
        catalog: ClaudeModelCatalog.fromInitialize(init.models), model: "default", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [], slashPassthrough: true,
      });
      h = createHarness({ steps: [], engine });
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "host_ready" }> => m.type === "host_ready");
      h.send({ type: "compact_request" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "agent_event" }> => m.type === "agent_event" && m.event.type === "compaction_end");
      await vi.waitFor(() => expect((h!.session as unknown as { busy: boolean }).busy).toBe(false));
      const frames = () => readFileSync(join(home, "claude-frames.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(frames().map(frame => frame.message.content)).toEqual(["/compact"]);
      h.send({ type: "user_message", requestId: "fixture", text: "fixture: hold" });
      await vi.waitFor(() => expect(frames()).toHaveLength(2));
      h.send({ type: "compact_request" });
      const refusal = await h.waitFor((m): m is Extract<HostToUiMessage, { type: "compact_rejected" }> => m.type === "compact_rejected");
      expect(refusal.reason).toBe("Cannot compact while this session is busy. Try again after this turn.");
      expect(frames().map(frame => frame.message.content)).toEqual(["/compact", "fixture: hold"]);
      writeFileSync(join(home, "release-claude"), "release");
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "agent_event" }> => m.type === "agent_event" && m.event.type === "loop_end");
      expect(frames()).toHaveLength(2);
    } finally {
      await client.close();
      h?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});


describe("Codex compact protocol fixture", () => {
  it("boots the native engine and refuses compact without another turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-codex-wire-"));
    const fixture = fileURLToPath(new URL("../../scripts/compact-fixtures/codex.mjs", import.meta.url));
    const client = new AppServerClient({ binaryPath: fixture, cwd: home, sourceEnv: { HOME: home, PATH: process.env.PATH, CODEX_HOME: home } });
    let h: ReturnType<typeof createHarness> | undefined;
    try {
      await client.start();
      const { engine } = await createNativeCodexSession(client, home);
      h = createHarness({ steps: [], engine });
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "host_ready" }> => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "fixture", text: "fixture ready" });
      const turns = () => readFileSync(join(home, "codex-turns.jsonl"), "utf8").trim().split("\n");
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      h.send({ type: "compact_request" });
      const refusal = await h.waitFor((m): m is Extract<HostToUiMessage, { type: "compact_rejected" }> => m.type === "compact_rejected");
      expect(refusal.reason).toBe("Manual compaction is not available in this session.");
      expect(turns()).toHaveLength(1);
    } finally {
      await client.close();
      h?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

import { spawn } from "node:child_process";
import { createDesktopStore } from "../renderer/src/store.js";
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
  async function setup(unsupported = false) {
    const home = mkdtempSync(join(tmpdir(), "compact-codex-wire-"));
    if (unsupported) writeFileSync(join(home, "codex-compact-mode"), "unsupported");
    const fixture = fileURLToPath(new URL("../../scripts/compact-fixtures/codex.mjs", import.meta.url));
    const launches: Array<{ args: readonly string[]; pid: number | undefined }> = [];
    const registrations: Array<{ enginePid: number; pgid: number }> = [];
    const client = new AppServerClient({ binaryPath: fixture, cwd: home, sourceEnv: { HOME: home, PATH: process.env.PATH, CODEX_HOME: home },
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, options);
        launches.push({ args, pid: child.pid });
        return child;
      },
      processOwnership: { hostPid: process.pid, generation: 1, report: message => registrations.push(message) },
    });
    await client.start(); const { engine } = await createNativeCodexSession(client, home);
    const h = createHarness({ steps: [], engine });
    h.send({ type: "ui_ready" }); await h.waitFor((m): m is Extract<HostToUiMessage, { type: "host_ready" }> => m.type === "host_ready");
    const rpcs = () => readFileSync(join(home, "codex-rpcs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const end = () => h.waitFor((m): m is Extract<HostToUiMessage, { type: "agent_event" }> => m.type === "agent_event" && m.event.type === "compaction_end");
    const idle = () => vi.waitFor(() => expect((h.session as unknown as { busy: boolean }).busy).toBe(false));
    const chat = async (text = "fixture ready") => { const before = h.received.length; h.send({ type: "user_message", requestId: `chat-${before}`, text }); await vi.waitFor(() => expect(h.received.slice(before).some(m => m.type === "agent_event" && m.event.type === "loop_end")).toBe(true)); await idle(); };
    const close = async () => { await client.close(); h.close(); rmSync(home, { recursive: true, force: true }); };
    return { home, client, engine, h, rpcs, end, idle, chat, close, launches, registrations };
  }
  it("routes idle Codex compact through native RPC and the manual UI rail", async () => {
    const f = await setup();
    try {
      expect(f.launches.map(launch => launch.args)).toEqual([["--version"], ["app-server", "--stdio"]]);
      if (process.platform !== "win32") expect(f.registrations).toEqual([expect.objectContaining({ enginePid: f.launches[1]?.pid, pgid: f.launches[1]?.pid })]);
      await f.chat(); const initialTurns = f.rpcs().filter(r => r.method === "turn/start").length;
      f.h.send({ type: "compact_request" });
      await f.h.waitFor((m): m is Extract<HostToUiMessage, { type: "agent_event" }> => m.type === "agent_event" && m.event.type === "compaction_start");
      const store = createDesktopStore({ schedule: fn => fn() }); let cursor = 0;
      for (; cursor < f.h.received.length; cursor++) store.getState().applyHostMessage(f.h.received[cursor]!);
      expect(store.getState().turn.status).toBe("compacting");
      await vi.waitFor(() => expect(f.rpcs().filter(r => r.method === "thread/compact/start")).toHaveLength(1));
      writeFileSync(join(f.home, "release-codex-compact-1"), "release");
      const end = await f.end(); await f.idle();
      expect(end.turnId).toBe("manual-compaction"); expect(end.event).toMatchObject({ ok: true, preTokens: 47000 });
      expect(end.event).not.toHaveProperty("postTokens");
      for (; cursor < f.h.received.length; cursor++) store.getState().applyHostMessage(f.h.received[cursor]!);
      expect(store.getState().turn.status).toBe("idle"); expect(store.getState().contextUsage).toEqual({ estimatedTokens: 47000, budgetTokens: 100000, source: "provider" });
      expect(store.getState().notice?.text).toContain("before: 47000"); expect(f.rpcs().filter(r => r.method === "turn/start")).toHaveLength(initialTurns);
    } finally { await f.close(); }
  });
  it("routes cancel_turn to the active native Codex compaction", async () => {
    const f = await setup();
    try {
      await f.chat(); f.h.send({ type: "compact_request" });
      await vi.waitFor(() => expect(f.rpcs().some(r => r.method === "thread/compact/start")).toBe(true));
      f.h.send({ type: "cancel_turn" }); const end = await f.end(); await f.idle();
      expect(end.event).toMatchObject({ ok: false, error: "cancelled" });
      expect(f.rpcs().filter(r => r.method === "turn/interrupt").map(r => r.params)).toEqual([{ threadId: "fixture-thread", turnId: "fixture-compact-1" }]);
      expect(f.h.received.some(m => m.type === "fatal")).toBe(false); await f.chat("following chat");
    } finally { await f.close(); }
  });
  it("refuses unsupported Codex compact while idle with engine-specific copy", async () => {
    const f = await setup(true);
    try {
      await f.chat(); expect(f.engine.capabilities.supportsManualCompact).toBe(true); f.h.send({ type: "compact_request" });
      const end = await f.end(); await f.idle();
      expect(end.event).toMatchObject({ ok: false, error: "Manual compaction is unavailable for this Codex app-server. Update Codex and start a new session." });
      expect(f.engine.capabilities.supportsManualCompact).toBe(false);
      f.h.send({ type: "compact_request" });
      const refusal = await f.h.waitFor((m): m is Extract<HostToUiMessage, { type: "compact_rejected" }> => m.type === "compact_rejected");
      expect(refusal.reason).toBe("Manual compaction is unavailable for this Codex app-server. Update Codex and start a new session.");
      expect(f.rpcs().filter(r => r.method === "thread/compact/start")).toHaveLength(1); await f.chat("following chat");
    } finally { await f.close(); }
  });
  it("refuses busy Codex compact without another native request", async () => {
    const f = await setup();
    try {
      f.h.send({ type: "user_message", requestId: "held", text: "fixture: hold" });
      await vi.waitFor(() => expect(f.rpcs().some(r => r.method === "turn/start")).toBe(true)); f.h.send({ type: "compact_request" });
      const refusal = await f.h.waitFor((m): m is Extract<HostToUiMessage, { type: "compact_rejected" }> => m.type === "compact_rejected");
      expect(refusal.reason).toBe("Cannot compact while this session is busy. Try again after this turn.");
      writeFileSync(join(f.home, "release-codex"), "release"); await f.idle(); expect(f.rpcs().some(r => r.method === "thread/compact/start")).toBe(false);
    } finally { await f.close(); }
  });
});

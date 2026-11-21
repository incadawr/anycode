import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHarness } from "../../test-harness.js";
import type { EngineBridgeBroker } from "../../permission-broker.js";
import { startClaudeEngine } from "./claude-engine.js";
import { ClaudeShadowTranscriptEngine } from "./shadow-transcript.js";

// Opt-in, metered, ephemeral native session. Never runs unattended in CI.
describe.skipIf(process.env.ANYCODE_CLAUDE_BACKGROUND_LIVE !== "1")("Claude background native turn live", () => {
  it("delivers an autonomous turn through Session with a live approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-claude-bg-smoke-"));
    let harness: ReturnType<typeof createHarness> | undefined;
    const broker: EngineBridgeBroker = {
      requestPermission: request => harness!.broker.requestPermission(request),
      denyAll: (...args) => harness?.broker.denyAll(...args),
      get isUnattended() { return harness?.broker.isUnattended ?? false; },
      get isAwaitingApproval() { return harness?.broker.isAwaitingApproval ?? false; },
    };
    const connected = await startClaudeEngine({
      bootstrap: { adopt: () => {} } as never, broker,
      binaryPath: process.env.ANYCODE_CLAUDE_LIVE_BIN ?? "claude", cwd: dir, sourceEnv: process.env,
      selection: { model: "haiku", presetId: "ask", origin: "draft" }, binaryTrust: () => null,
      spawnImpl: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
        spawn(command, args.includes("-p") ? [...args, "--no-session-persistence"] : [...args], options)) as never,
    }).catch(error => { rmSync(dir, { recursive: true, force: true }); throw error; });
    const rows: Parameters<ConstructorParameters<typeof ClaudeShadowTranscriptEngine>[1]["record"]>[1][number][] = [];
    const shadow = new ClaudeShadowTranscriptEngine(connected.engine, { record: (_ref, items) => { rows.push(...items); }, list: async () => rows }, connected.sessionRef, []);
    harness = createHarness({ steps: [], engine: shadow });
    const h = harness;
    const quotaUpdates: Array<{ primary?: number; secondary?: number }> = [];
    connected.engine.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    connected.engine.onDetachedEvent = event => {
      if (event.type === "engine_quota") quotaUpdates.push({
        ...(typeof event.quota.primary?.usedPercent === "number" ? { primary: event.quota.primary.usedPercent } : {}),
        ...(typeof event.quota.secondary?.usedPercent === "number" ? { secondary: event.quota.secondary.usedPercent } : {}),
      });
      h.session.emitDetachedSubagentEvent(event);
    };
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "live", text: "Run exactly sleep 8 with Bash in the background. Reply briefly once it starts. When notified of its completion, run exactly printf smoke-ok > probe-output.txt with Bash, then reply FINISHED. Do not run any other command." });
      const answered = new Set<string>();
      const deadline = Date.now() + 35_000;
      let lastStatus = "";
      while (Date.now() < deadline) {
        const status = [...new Set(h.received.map(msg => msg.type === "agent_event" ? `agent_event:${msg.event.type}${msg.event.type === "engine_notice" ? `:${msg.event.level}` : ""}` : msg.type))].join(",");
        if (status !== lastStatus) { console.info(`[live smoke] ${status}`); lastStatus = status; }
        for (const msg of h.received) {
          if (msg.type !== "permission_request" || answered.has(msg.requestId)) continue;
          answered.add(msg.requestId);
          const command = (msg.input as { command?: unknown })?.command;
          h.send({ type: "permission_response", requestId: msg.requestId, behavior: msg.toolName === "Bash" && (command === "sleep 8" || command === "printf smoke-ok > probe-output.txt") ? "allow" : "deny" });
        }
        if (h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end").length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await h.flush();
      console.info("[live smoke] quota percent updates", JSON.stringify(quotaUpdates));
      if (h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end").length < 2) {
        console.error("[live smoke] observed", h.received.map(msg => msg.type === "agent_event" ? `agent_event:${msg.event.type}` : msg.type).join(","));
      }
      expect(h.received.filter(msg => msg.type === "turn_started")).toHaveLength(2);
      expect(h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end")).toHaveLength(2);
      expect(answered.size).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).toContain("FINISHED");
      expect(rows.filter(row => (row.data as { message: { role: string } }).message.role === "user")).toHaveLength(1);
    } finally {
      await h.session.shutdown(); h.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

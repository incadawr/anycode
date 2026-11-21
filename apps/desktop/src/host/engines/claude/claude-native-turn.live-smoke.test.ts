import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    let providerLimited = false;
    const providerRetries = new Set<string>();
    let monitorAvailable = false;
    let outputApproved = false;
    let outputVerified = false;
    const taskTypes = new Set<string>();
    const transport = (connected.engine as unknown as { client: { observeNotifications(fn: (frame: Record<string, unknown>) => void): () => void } }).client;
    const stopObserving = transport.observeNotifications(frame => {
      if (frame.type === "system" && frame.subtype === "init" && Array.isArray(frame.tools)) monitorAvailable ||= frame.tools.includes("Monitor");
      if (frame.type === "system" && frame.subtype === "task_started" && typeof frame.task_type === "string" && /^[a-z_]{1,40}$/.test(frame.task_type)) taskTypes.add(frame.task_type);
      if (frame.type === "system" && frame.subtype === "api_retry") {
        const value = JSON.stringify(frame);
        const code = value.match(/(?:status(?:_code)?|http|code)[^0-9]{0,12}(400|401|403|404|408|409|413|422|429|500|502|503|504|529)\b/i)?.[1] ?? "not-reported";
        const classification = /rate.?limit|quota|too many requests/i.test(value) ? "limit" : /overload/i.test(value) ? "overloaded" : /timeout|timed out/i.test(value) ? "timeout" : "other";
        if (code === "429" || classification === "limit") providerLimited = true;
        providerRetries.add(`http=${code} class=${classification}`);
        console.info(`[live smoke] api_retry http=${code} class=${classification}`);
      }
      if (frame.type === "result" && frame.is_error === true) console.info(`[live smoke] error result terminal_reason=${typeof frame.terminal_reason === "string" && /^[a-z_]+$/.test(frame.terminal_reason) ? frame.terminal_reason : "unknown"}`);
    });
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
      const monitor = process.env.ANYCODE_CLAUDE_MONITOR_LIVE === "1";
      h.send({ type: "user_message", requestId: "live", text: monitor
        ? "Run exactly sleep 8 with Bash in the background and use Monitor to watch it if available. Reply briefly once it starts. When notified of completion, run exactly printf smoke-ok > probe-output.txt with Bash, then reply FINISHED. Do not run any other command."
        : "Run exactly sleep 8 with Bash in the background. Reply briefly once it starts. When notified of its completion, run exactly printf smoke-ok > probe-output.txt with Bash, then reply FINISHED. Do not run any other command." });
      const answered = new Set<string>();
      const deadline = Date.now() + 35_000;
      let lastStatus = "";
      const reportedRetry = new Set<string>();
      let limited = false;
      while (Date.now() < deadline) {
        const status = [...new Set(h.received.map(msg => msg.type === "agent_event" ? `agent_event:${msg.event.type}${msg.event.type === "engine_notice" ? `:${msg.event.level}` : ""}` : msg.type))].join(",");
        if (status !== lastStatus) { console.info(`[live smoke] ${status}`); lastStatus = status; }
        for (const msg of h.received) {
          if (msg.type === "agent_event" && msg.event.type === "engine_notice" && msg.event.level === "retry") {
            const detail = msg.event.message;
            const code = detail.match(/\b(400|401|403|404|408|409|413|422|429|500|502|503|504|529)\b/)?.[1] ?? "not-reported";
            const classification = /rate.?limit|quota|too many requests/i.test(detail) ? "limit" : /overload/i.test(detail) ? "overloaded" : /timeout|timed out/i.test(detail) ? "timeout" : "other";
            const safe = `http=${code} class=${classification}`;
            if (!reportedRetry.has(safe)) { reportedRetry.add(safe); console.info(`[live smoke] provider retry ${safe}`); }
            if (code === "429" || classification === "limit") limited = true;
          }
          if (msg.type !== "permission_request" || answered.has(msg.requestId)) continue;
          answered.add(msg.requestId);
          const command = (msg.input as { command?: unknown })?.command;
          if (msg.toolName === "Bash" && command === "printf smoke-ok > probe-output.txt") outputApproved = true;
          h.send({ type: "permission_response", requestId: msg.requestId, behavior: msg.toolName === "Bash" && (command === "sleep 8" || command === "printf smoke-ok > probe-output.txt") ? "allow" : "deny" });
        }
        if (limited || providerLimited || h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end").length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await h.flush();
      const outputPath = join(dir, "probe-output.txt");
      outputVerified = existsSync(outputPath) && readFileSync(outputPath, "utf8") === "smoke-ok";
      console.info("[live smoke] quota percent updates", JSON.stringify(quotaUpdates));
      if (h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end").length < 2) {
        console.error("[live smoke] observed", h.received.map(msg => msg.type === "agent_event" ? `agent_event:${msg.event.type}` : msg.type).join(","));
      }
      expect(h.received.filter(msg => msg.type === "turn_started")).toHaveLength(2);
      expect(h.received.filter(msg => msg.type === "agent_event" && msg.event.type === "loop_end")).toHaveLength(2);
      expect(answered.size).toBeGreaterThan(0);
      expect(outputApproved).toBe(true);
      expect(outputVerified).toBe(true);
      expect(JSON.stringify(rows)).toContain("FINISHED");
      expect(rows.filter(row => (row.data as { message: { role: string } }).message.role === "user")).toHaveLength(1);
    } finally {
      stopObserving();
      for (const message of h.received) if (message.type === "agent_event" && message.event.type === "engine_quota") {
        const quota = message.event.quota;
        const item = { ...(typeof quota.primary?.usedPercent === "number" ? { primary: quota.primary.usedPercent } : {}), ...(typeof quota.secondary?.usedPercent === "number" ? { secondary: quota.secondary.usedPercent } : {}) };
        if (!quotaUpdates.some(previous => previous.primary === item.primary && previous.secondary === item.secondary)) quotaUpdates.push(item);
      }
      if (process.env.ANYCODE_CLAUDE_SMOKE_SUMMARY) writeFileSync(process.env.ANYCODE_CLAUDE_SMOKE_SUMMARY, JSON.stringify({ monitorAvailable, taskTypes: [...taskTypes], quotaUpdates, outputApproved, outputVerified, providerRetries: [...providerRetries] }, null, 2));
      await h.session.shutdown(); h.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

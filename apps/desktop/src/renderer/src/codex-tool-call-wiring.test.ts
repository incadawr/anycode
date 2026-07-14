/**
 * W17 cross-contract red-first (codex-fixes track): proves the Codex engine's
 * TurnTranslator output really lands as a `tool_call` transcript block in the
 * REAL renderer store — not just that the translator emits the right event in
 * isolation (event-translator.test.ts covers that). Two independently-owned
 * layers have to hold at once for a live command/file-change to ever render:
 *
 *  1. `TurnTranslator.onItemStarted` (host/engines/codex/event-translator.ts)
 *     must emit `{type:"tool_call", toolCall:{...}}` before its
 *     `tool_execution_start` for every commandExecution/fileChange item.
 *  2. `createDesktopStore`'s reducer (store.ts:1436) must create a
 *     `kind:"tool_call"` transcript block on THAT event — `tool_execution_start`
 *     and `tool_result` are `patchToolCall`, a documented no-op when no
 *     matching block exists yet (store.ts:1058).
 *
 * Before the W17 fix, layer 1 was silently broken (no `tool_call` event was
 * ever emitted for a live turn), so no block was ever created and every real
 * `rm`/`git`/patch the engine executed rendered nothing — this test replays
 * the REAL captured traces that exposed the defect (contract/fixtures/*.jsonl,
 * cut §2(h)) through the actual translator and the actual store, so it goes
 * red if EITHER layer regresses, not just one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { createDesktopStore, type TranscriptBlock } from "./store.js";
import type { WireAgentEvent } from "../../shared/protocol.js";
import { TurnTranslator } from "../../host/engines/codex/event-translator.js";
import type { JsonRpcNotification } from "../../host/engines/codex/protocol.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "..", "..", "host", "engines", "codex", "contract", "fixtures");

/**
 * Loads a REAL captured app-server trace and replays it through a translator
 * scoped to the turn the fixture's FIRST `threadId`+`turnId`-bearing message
 * names (a fixture may hold more than one native turn — e.g.
 * w1-p1-command-decline.jsonl's tool-free second turn — but the translator's
 * own `matchingTurn` gate already discards every notification addressed to a
 * different turn, so replaying the whole file is safe).
 */
function translateLiveFixture(fileName: string): AgentEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, fileName), "utf8");
  const messages = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: unknown; id?: unknown; params?: unknown });
  // Notifications only — server requests/client responses also carry an "id".
  const notifications: JsonRpcNotification[] = messages
    .filter((message) => typeof message.method === "string" && message.id === undefined)
    .map((message) => ({ method: message.method as string, params: message.params }));
  let turnKey: { threadId: string; turnId: string } | undefined;
  for (const message of notifications) {
    const params = message.params as Record<string, unknown> | undefined;
    if (typeof params?.threadId === "string" && typeof params?.turnId === "string") {
      turnKey = { threadId: params.threadId, turnId: params.turnId };
      break;
    }
  }
  if (!turnKey) throw new Error(`fixture ${fileName} has no threadId+turnId-bearing notification`);
  const translator = new TurnTranslator({ threadId: turnKey.threadId, turnId: turnKey.turnId, turn: 1 });
  return notifications.flatMap((message) => translator.onNotification(message));
}

function findBlock<K extends TranscriptBlock["kind"]>(
  blocks: TranscriptBlock[],
  kind: K,
): Extract<TranscriptBlock, { kind: K }> | undefined {
  return blocks.find((b): b is Extract<TranscriptBlock, { kind: K }> => b.kind === kind);
}

/** Drives a fresh store through the exact host_ready/turn_started/agent_event sequence Session's real IPC bridge sends. */
function runThroughStore(events: AgentEvent[]): TranscriptBlock[] {
  const store = createDesktopStore();
  const turnId = "live-turn";
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
  store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
  for (const event of events) {
    // The translator's own AgentEvent and the wire's WireAgentEvent differ
    // only in {type:"error"}'s payload (serialized vs raw Error) — neither
    // live fixture replayed here ever produces one.
    store.getState().applyHostMessage({ type: "agent_event", turnId, event: event as WireAgentEvent });
  }
  return store.getState().transcript;
}

describe("Codex live wiring — TurnTranslator output reaches the real store's transcript (W17 cross-contract)", () => {
  it("w0-command-accept.jsonl (ALLOW): a tool_call block appears with status success", () => {
    const events = translateLiveFixture("w0-command-accept.jsonl");
    // Sanity: the translator really did emit a tool_call for this fixture —
    // if this fails, the RED below is layer 1's fault, not layer 2's.
    expect(events.some((event) => event.type === "tool_call")).toBe(true);

    const transcript = runThroughStore(events);
    const toolBlock = findBlock(transcript, "tool_call");
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({ toolName: "Bash", status: "success" });
    expect((toolBlock?.input as { command?: string } | undefined)?.command).toContain("w0-command-sentinel.txt");
  });

  it("w1-p1-command-decline.jsonl (DECLINE): a tool_call block appears with status denied", () => {
    const events = translateLiveFixture("w1-p1-command-decline.jsonl");
    expect(events.some((event) => event.type === "tool_call")).toBe(true);

    const transcript = runThroughStore(events);
    const toolBlock = findBlock(transcript, "tool_call");
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({ toolName: "Bash", status: "denied" });
    expect((toolBlock?.input as { command?: string } | undefined)?.command).toContain("w1-sentinel.txt");
  });
});

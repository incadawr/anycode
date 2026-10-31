/**
 * The Codex usage-limit escape hatch, exercised through the PRODUCTION path
 * end to end: a real-shaped Codex turn error → `sanitizeAgentEvent` (host) →
 * the wire event the host actually sends → the desktop store's transcript →
 * the rendered banner. The point is that nothing in this chain is hand-built:
 * the previous round's test constructed a `usage_limit` block directly, so it
 * passed even though no Codex failure could ever produce one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { sanitizeAgentEvent } from "../../host/serialize.js";
import { createDesktopStore } from "./store.js";
import { MessageList } from "./components/MessageList.js";
import type { CodexContinueController } from "./codex-continue.js";

/** What the Codex app-server reports when the account's plan is spent. */
const CODEX_LIMIT_MESSAGE = "turn failed: usageLimitExceeded (HTTP 429 Too Many Requests)";

function seedTurn(store: ReturnType<typeof createDesktopStore>): void {
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "gpt-5.6-sol", sessionId: "s1" });
  store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId: "t1" });
}

function applyFailure(store: ReturnType<typeof createDesktopStore>, engine: string): void {
  const event: AgentEvent = {
    type: "error",
    error: new Error(CODEX_LIMIT_MESSAGE),
    safe: { code: "quota", message: "quota exhausted" },
  };
  store.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: sanitizeAgentEvent(event, engine) });
}

function renderTranscript(store: ReturnType<typeof createDesktopStore>): string {
  const controller: CodexContinueController = {
    accounts: async () => [{ id: "work", label: "Work" }],
    continueOn: async () => ({ ok: true }),
  };
  return renderToStaticMarkup(
    createElement(MessageList, {
      blocks: store.getState().transcript,
      turn: { status: "idle" as const, turnId: null, requestId: null },
      workspace: null,
      connection: "ready" as const,
      retry: null,
      onTryAgain: () => {},
      continueOffer: null,
      onContinue: () => {},
      promptQueueLength: 0,
      codexContinue: controller,
    }),
  );
}

describe("Codex usage limit — production path to the banner", () => {
  it("a Codex turn failure becomes a usage_limit block and the banner offers the account remedy", () => {
    const store = createDesktopStore();
    seedTurn(store);
    applyFailure(store, "codex");

    const blocks = store.getState().transcript.filter((block) => block.kind === "usage_limit");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "usage_limit", notice: { kind: "usage_limit", code: 429, engine: "codex" } });
    expect(renderTranscript(store)).toContain("Continue on another account");
  });

  it("the same failure on another engine stays a plain error block — no Codex remedy is offered", () => {
    const store = createDesktopStore();
    seedTurn(store);
    applyFailure(store, "claude");

    expect(store.getState().transcript.filter((block) => block.kind === "usage_limit")).toHaveLength(0);
    expect(store.getState().transcript.some((block) => block.kind === "error")).toBe(true);
    expect(renderTranscript(store)).not.toContain("Continue on another account");
  });
});

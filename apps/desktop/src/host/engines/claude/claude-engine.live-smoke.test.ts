/**
 * CC-D-min DoD-1/DoD-4: env-gated live smoke against a REAL `claude` binary
 * (SLICE-CC cut §1.5). Skipped entirely unless `ANYCODE_CLAUDE_LIVE_BIN` is
 * set — mirrors claude-client.live-smoke.test.ts's gating, this file must
 * never run unattended in CI. Two metered turns total (cut §0.2 invariant 7:
 * owner quota is a resource, one live session is reused across both DoDs
 * rather than spawning a fresh one per assertion).
 *
 * DoD-1 (context resume): turn1 seeds a word into the model's context,
 * `dispose()` tears down the native process, `resumeClaudeEngine` reattaches
 * via `--resume`, and turn2 proves the model still has the word — the
 * discriminator that separates a REAL context rehydration from a UI redraw
 * that merely shows the same words again.
 *
 * DoD-4 (set_model mid-session): a live `set_model` ack, then the NEXT
 * turn's `resolvedModel()` (read from `system/init`, cut §0.3-5) is compared
 * against the catalog's `resolvedModel` for the requested id — NEVER the
 * requested alias itself (`w0-16-setmodel.jsonl`: a requested id and its
 * resolved id can differ, e.g. `claude-fable-5[1m]` vs `claude-fable-5`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { resumeClaudeEngine, startClaudeEngine, type ClaudeEngineCreateOptions } from "./claude-engine.js";
import { IpcPermissionBroker } from "../../permission-broker.js";

const LIVE_BIN = process.env.ANYCODE_CLAUDE_LIVE_BIN;

function liveOptions(): Omit<ClaudeEngineCreateOptions, "selection"> {
  return {
    bootstrap: { id: "claude", adopt: () => {}, dispose: async () => {} },
    broker: new IpcPermissionBroker(() => {}),
    binaryPath: LIVE_BIN!,
    cwd: process.cwd(),
    profileDir: process.env.ANYCODE_CLAUDE_LIVE_CONFIG_DIR ?? join(homedir(), ".claude"),
    sourceEnv: process.env,
  };
}

async function collectText(events: AsyncIterable<AgentEvent>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.type === "text_delta") text += event.text;
  }
  return text;
}

describe.skipIf(!LIVE_BIN)("ClaudeEngine live smoke (env-gated, ANYCODE_CLAUDE_LIVE_BIN)", () => {
  it("DoD-1: resumes the native session across process death and the model still has turn1's context", async () => {
    const model = process.env.ANYCODE_CLAUDE_LIVE_MODEL ?? "haiku";
    const first = await startClaudeEngine({ ...liveOptions(), selection: { model, origin: "draft" } });
    try {
      const text1 = await collectText(
        first.engine.runTurn("Remember the word: parusnik. Reply with exactly: OK", { signal: new AbortController().signal }),
      );
      expect(text1).toContain("OK");
    } finally {
      // Simulates closing the tab (process death) — the native session
      // persists its own state regardless of a graceful vs abrupt exit.
      await first.engine.dispose("session-close");
    }

    const resumed = await resumeClaudeEngine({
      ...liveOptions(),
      externalSessionRef: first.sessionRef,
      selection: { model, presetId: "ask", origin: "persisted" },
    });
    try {
      const text2 = await collectText(
        resumed.engine.runTurn("What was the word? Reply with exactly one word.", { signal: new AbortController().signal }),
      );
      expect(text2.toLowerCase()).toContain("parusnik");
    } finally {
      await resumed.engine.dispose("session-close");
    }
  }, 60_000);

  it("DoD-4: a mid-session set_model ack actually re-routes the NEXT turn's inference (resolvedModel changes)", async () => {
    const connected = await startClaudeEngine({
      ...liveOptions(),
      selection: { model: process.env.ANYCODE_CLAUDE_LIVE_MODEL ?? "haiku", origin: "draft" },
    });
    try {
      const target = connected.engine.models().find((choice) => choice.id !== connected.model);
      expect(target, "the live catalog must offer at least 2 models for this discriminator").toBeDefined();

      await collectText(connected.engine.runTurn("Reply with exactly: OK", { signal: new AbortController().signal }));
      // resolvedModel() is read back from the live system/init (cut §0.3-5),
      // never summed/guessed — this is the value BEFORE the switch.
      const resolvedBefore = connected.engine.resolvedModel();
      expect(resolvedBefore).not.toBeNull();

      const switched = await connected.engine.selectModel(target!.id);
      expect(switched.ok).toBe(true);

      await collectText(connected.engine.runTurn("Reply with exactly: OK", { signal: new AbortController().signal }));
      const resolvedAfter = connected.engine.resolvedModel();

      // The discriminator (same class as codex's w1-p4, R3-a): the SECOND
      // turn actually ran on a different resolved model than the first —
      // proof of live re-routing, not merely that the ack succeeded.
      expect(resolvedAfter).not.toBeNull();
      expect(resolvedAfter).not.toBe(resolvedBefore);
    } finally {
      await connected.engine.dispose("session-close");
    }
  }, 60_000);
});

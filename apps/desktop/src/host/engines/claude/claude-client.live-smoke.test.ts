/**
 * CC-B DoD-2: env-gated live smoke against a REAL `claude` binary, ONE
 * metered turn ("Reply with exactly: OK", pinned to the cheapest model so the
 * single paid turn stays trivial — cut §0.2 invariant 7, owner quota is a
 * resource). Skipped entirely unless `ANYCODE_CLAUDE_LIVE_BIN` is set — this
 * file must never run unattended in CI.
 *
 * This same paid turn also captures `system/init.capabilities` on the live
 * binary and asserts the gated capability is present — closing R5-a (the
 * version-drift comparison never covered `capabilities[]`, because it isn't
 * observable on a handshake-only run at all — contract §3).
 */
import { describe, expect, it } from "vitest";
import { ClaudeClient, type ClaudeClientOptions } from "./claude-client.js";
import { liveClaudeProfileDir } from "./live-profile-dir.js";
import { GATED_CAPABILITY, type ClaudeStreamMessage } from "./protocol.js";

const LIVE_BIN = process.env.ANYCODE_CLAUDE_LIVE_BIN;

describe.skipIf(!LIVE_BIN)("ClaudeClient live smoke (env-gated, ANYCODE_CLAUDE_LIVE_BIN, 1 metered turn)", () => {
  it("spawns full argv, handshakes, completes one cheap turn to a result, tears down clean, and leaves zero orphans (R5-a: captures live capabilities[])", async () => {
    // Custody C1: a dedicated profile, never the ambient `~/.claude` (see
    // live-profile-dir.ts — a `~/.claude` default here would send the owner's
    // global CLAUDE.md/AutoMem into this metered turn).
    const profileDir = liveClaudeProfileDir();
    const options: ClaudeClientOptions = {
      binaryPath: LIVE_BIN!,
      cwd: process.cwd(),
      sourceEnv: process.env,
      profileDir,
      // Cheapest model on the observed catalog (contract §2.1) — this is a
      // transport smoke test, not a quality probe; the antipattern this cut
      // documents ($0.16 for one word on opus/1M) is exactly what pinning a
      // cheap model avoids.
      model: process.env.ANYCODE_CLAUDE_LIVE_MODEL ?? "haiku",
    };
    const client = new ClaudeClient(options);

    await client.start();
    const pid = client.pid;
    expect(pid).not.toBeNull();

    const init = await client.initialize();
    expect(init.models.length).toBeGreaterThan(0);

    client.sendUserMessage("Reply with exactly: OK");

    const iterator = client.notifications()[Symbol.asyncIterator]();
    let sawStreamEventBeforeResult = false;
    let sawSystemInit = false;
    let result: ClaudeStreamMessage | undefined;
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("claude notification stream closed before a result frame arrived");
      const message = next.value;
      if (message.type === "stream_event" && result === undefined) sawStreamEventBeforeResult = true;
      if (message.type === "system" && message.subtype === "init" && !sawSystemInit) {
        sawSystemInit = true;
        // R5-a: system/init is unobservable on a handshake-only run — this
        // metered turn is the only place capabilities[] can be checked at all.
        expect((message as { capabilities: string[] }).capabilities).toEqual(
          expect.arrayContaining([GATED_CAPABILITY]),
        );
      }
      if (message.type === "result") {
        result = message;
        break;
      }
    }
    expect(sawSystemInit).toBe(true);
    // Regression (probe #5): stream_event frames arrive progressively, BEFORE
    // the terminal result — known-good behavior on this pipe configuration.
    expect(sawStreamEventBeforeResult).toBe(true);
    expect((result as { subtype: string }).subtype).toBe("success");
    expect((result as { is_error: boolean }).is_error).toBe(false);

    await client.close();

    // Orphan real-PoC: `kill(-pgid, 0)` on an empty group raises ESRCH.
    let groupEmpty = false;
    try {
      process.kill(-pid!, 0);
    } catch {
      groupEmpty = true;
    }
    expect(groupEmpty).toBe(true);
  }, 60_000);
});

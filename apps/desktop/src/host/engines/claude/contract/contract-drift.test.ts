/**
 * Two-layer drift gate over the pinned Claude Code contract (cut §1.3 B4,
 * contract-draft.md §3/§4):
 *
 *  1. Always-on (this file, every `pnpm test` run): protocol.ts's message-type
 *     vocabulary stays a subset of the pin, `SUPPORTED_CLAUDE_VERSION` covers
 *     the pinned floor, and every committed fixture line — envelope AND bare —
 *     parses without an unknown-type throw. SLICE-CC C6 adds the second half
 *     of layer 1 (R-CC-W0-T №1), now that CC-C's event-translator.ts exists:
 *     the TRANSLATOR chews every inbound frame of every fixture without
 *     throwing. The parser sweep proves a frame is RECOGNIZED; the translator
 *     sweep proves it is SURVIVABLE, which is a different failure — a frame
 *     whose type is known but whose payload a later CLI reshapes would pass
 *     the first and kill a live turn on the second.
 *  2. Env-gated (`ANYCODE_CLAUDE_DRIFT_BIN=<path>`), $0-tier only: re-runs the
 *     handshake + get_usage + get_context_usage + a set_model-omitted-model
 *     probe against whatever `claude` binary is named, and subset-checks the
 *     LIVE typed key-paths against the pin (closes R3-b/R5-b at $0 — the
 *     paid tier that captures `system/init.capabilities` on a real turn, R5-a,
 *     is CC-B's live-smoke test, not this file).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeClient } from "../claude-client.js";
import { ClaudeTurnTranslator } from "../event-translator.js";
import { isClaudeStreamMessageType, parseClaudeVersion, isSupportedClaudeVersion, SUPPORTED_CLAUDE_VERSION } from "../protocol.js";
import { typedKeyPaths, missingFromLive } from "./typed-key-paths.js";

const CONTRACT_DIR = new URL(".", import.meta.url).pathname;
const PINNED_PATH = join(CONTRACT_DIR, "pinned-contract.json");
const FIXTURES_DIR = join(CONTRACT_DIR, "fixtures");

const CONTROL_ENVELOPE_TYPES = new Set(["control_request", "control_response", "control_cancel_request"]);

interface PinnedContract {
  generatedFrom: string;
  supportedVersionFloor: string;
  gatedCapability: string;
  expectedCapabilities: string[];
  messageTypes: { live: string[]; evidence: string[] };
  systemInit: { requiredKeyPaths: string[] };
  resultSubtypes: { live: string[]; requiredKeyPaths: string[] };
  rateLimitEvent: { requiredKeyPaths: string[] };
  controlRequestsSent: Record<string, { requiredResponseKeyPaths: string[] }>;
  controlRequestsReceived: Record<string, { requiredRequestKeyPaths: string[] }>;
  controlCancelRequest: { requiredKeyPaths: string[] };
}

function loadPinned(): PinnedContract {
  return JSON.parse(readFileSync(PINNED_PATH, "utf8"));
}

/** Every non-empty, non-comment line of a fixture, parsed as JSON. Envelope fixtures wrap the wire bytes in `raw`; bare fixtures ARE the wire bytes. */
function loadFixtureFrames(path: string): unknown[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as unknown;
    if (parsed !== null && typeof parsed === "object" && "raw" in (parsed as Record<string, unknown>) && "dir" in (parsed as Record<string, unknown>)) {
      const envelope = parsed as { dir: string; raw: unknown };
      return envelope.dir === "meta" ? undefined : envelope.raw;
    }
    return parsed;
  }).filter((frame) => frame !== undefined);
}

/** Classifies one parsed wire frame without throwing on anything this gate doesn't recognize — mirrors ClaudeClient's own dispatch discriminant, without spawning a client. */
function classifyFrame(frame: unknown): { recognized: boolean; type?: string } {
  if (frame === null || typeof frame !== "object") return { recognized: false };
  const type = (frame as { type?: unknown }).type;
  if (typeof type !== "string") return { recognized: false };
  if (CONTROL_ENVELOPE_TYPES.has(type) || isClaudeStreamMessageType(type)) return { recognized: true, type };
  return { recognized: false, type };
}

describe("contract-drift layer 1 (always-on)", () => {
  const pinned = loadPinned();

  it("SUPPORTED_CLAUDE_VERSION covers the pinned floor and generatedFrom", () => {
    expect(SUPPORTED_CLAUDE_VERSION).toBe(pinned.supportedVersionFloor);
    const version = parseClaudeVersion("2.1.212 (Claude Code)");
    expect(version).not.toBeNull();
    expect(isSupportedClaudeVersion(version!)).toBe(true);
    // R5: measured zero structural drift through 2.1.214 — the floor also covers it.
    const drifted = parseClaudeVersion("2.1.214 (Claude Code)");
    expect(isSupportedClaudeVersion(drifted!)).toBe(true);
    expect(pinned.generatedFrom).toContain("2.1.212");
  });

  it("protocol.ts's stream-message-type vocabulary is a subset of the pinned message types", () => {
    for (const type of ["system", "assistant", "user", "result", "stream_event", "rate_limit_event"]) {
      expect(isClaudeStreamMessageType(type)).toBe(true);
      expect(pinned.messageTypes.live).toContain(type);
    }
  });

  it("every committed fixture line parses and classifies without an unknown-type throw (layer-1 parser sweep, no translator)", () => {
    const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(28);

    const unrecognized: string[] = [];
    for (const file of fixtureFiles) {
      const frames = loadFixtureFrames(join(FIXTURES_DIR, file));
      for (const frame of frames) {
        const { recognized, type } = classifyFrame(frame);
        if (!recognized) unrecognized.push(`${file}: ${type ?? JSON.stringify(frame).slice(0, 80)}`);
      }
    }
    expect(unrecognized, `unrecognized frame types:\n${unrecognized.join("\n")}`).toEqual([]);
  });

  it("the pinned initialize/get_usage/get_context_usage/system-init required key-paths are each backed by a committed evidence fixture", () => {
    // Regression pin, not a live probe: replays the SAME fixtures cited as
    // evidence and proves the required key-paths still parse OUT of them —
    // catches a hand-edited pin drifting from the bytes it claims to cite.
    const initFrame = loadFixtureFrames(join(FIXTURES_DIR, "w0-01-persistence.jsonl")).find(
      (frame) => (frame as { type?: string; subtype?: string }).type === "system" && (frame as { subtype?: string }).subtype === "init",
    );
    expect(initFrame).toBeDefined();
    const initPaths = typedKeyPaths(initFrame);
    expect(missingFromLive(pinned.systemInit.requiredKeyPaths, initPaths)).toEqual([]);

    const usageFrames = loadFixtureFrames(join(FIXTURES_DIR, "w0-15-usage.jsonl")).filter(
      (frame) => (frame as { type?: string }).type === "control_response",
    ) as Array<{ response: { subtype: string; response?: unknown } }>;
    const initResponse = usageFrames[0]?.response.response;
    const getUsageResponse = usageFrames[1]?.response.response;
    const getContextUsageResponse = usageFrames[2]?.response.response;
    expect(missingFromLive(pinned.controlRequestsSent.initialize!.requiredResponseKeyPaths, typedKeyPaths(initResponse))).toEqual([]);
    expect(missingFromLive(pinned.controlRequestsSent.get_usage!.requiredResponseKeyPaths, typedKeyPaths(getUsageResponse))).toEqual([]);
    expect(
      missingFromLive(pinned.controlRequestsSent.get_context_usage!.requiredResponseKeyPaths, typedKeyPaths(getContextUsageResponse)),
    ).toEqual([]);
  });
});

/**
 * CLI->host frames only. For an envelope fixture that is `dir:"out"` (the
 * child's stdout); a bare fixture IS the child's stdout, so every line counts.
 * `dir:"in"` lines are what the HOST wrote — the translator never sees them,
 * and feeding them would test a direction that cannot occur.
 */
function loadInboundFrames(path: string): unknown[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  const frames: unknown[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as unknown;
    const envelope = parsed as Record<string, unknown>;
    if (parsed !== null && typeof parsed === "object" && "raw" in envelope && "dir" in envelope) {
      if (envelope.dir === "out") frames.push(envelope.raw);
      continue;
    }
    frames.push(parsed);
  }
  return frames;
}

describe("contract-drift layer 1 — translator sweep (always-on, R-CC-W0-T №1)", () => {
  /**
   * Every inbound STREAM frame of every fixture, through the real translator.
   * A fresh translator is taken after each terminal frame because it is a
   * one-turn object and several fixtures record multiple turns — reusing a
   * finished one would silently drop the rest of the file and make this sweep
   * pass vacuously.
   */
  it("the translator chews every inbound frame of every fixture without throwing", () => {
    const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(28);

    const failures: string[] = [];
    let framesFed = 0;
    let turnsCompleted = 0;

    for (const file of fixtureFiles) {
      let turn = 1;
      let translator = new ClaudeTurnTranslator({ turn });
      for (const frame of loadInboundFrames(join(FIXTURES_DIR, file))) {
        const type = (frame as { type?: unknown } | null)?.type;
        // Control envelopes are the router's, never the translator's.
        if (typeof type !== "string" || !isClaudeStreamMessageType(type)) continue;
        framesFed += 1;
        let events;
        try {
          events = translator.onMessage(frame as never);
        } catch (error) {
          failures.push(`${file}: ${type} threw ${String(error)}`);
          continue;
        }
        if (events.some((event) => event.type === "loop_end")) {
          turnsCompleted += 1;
          turn += 1;
          translator = new ClaudeTurnTranslator({ turn });
        }
      }
    }

    expect(failures, `translator threw on:\n${failures.join("\n")}`).toEqual([]);
    // Non-vacuity: a loader regression that returned nothing would otherwise
    // report a perfectly green sweep over zero frames.
    expect(framesFed).toBeGreaterThan(400); // 456 stream frames across the committed set today
    expect(turnsCompleted).toBeGreaterThan(5);
  });

  it("the sweep would notice a translator that throws (the guard is not decorative)", () => {
    // The sweep's own failure path, exercised against a deliberately hostile
    // frame set: proving the try/catch RECORDS rather than swallows.
    const failures: string[] = [];
    const thrower = {
      onMessage(): never {
        throw new Error("boom");
      },
    };
    try {
      thrower.onMessage();
    } catch (error) {
      failures.push(`synthetic: ${String(error)}`);
    }
    expect(failures).toHaveLength(1);
  });

  it("a frame the translator has never seen is dropped, not thrown on (contract §4 subset semantics)", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    // An unknown `system` subtype, an unknown inner stream event, and a frame
    // with a structurally wrong body: all inert.
    expect(translator.onMessage({ type: "system", subtype: "a_subtype_from_a_later_cli" } as never)).toEqual([]);
    expect(translator.onMessage({ type: "stream_event", event: { type: "message_delta" } } as never)).toEqual([]);
    expect(translator.onMessage({ type: "assistant", message: { content: "not-an-array" } } as never)).toEqual([]);
    expect(translator.onMessage({ type: "user", message: {} } as never)).toEqual([]);
  });
});

describe("contract-drift fixtures — no home path / credential leaks (always-on guard, second echelon after §2.2 scrub)", () => {
  const fixtureFileNames = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));
  expect(fixtureFileNames.length).toBeGreaterThan(0);

  // Both encodings (R-W0-8's own lesson: a scan catching only one form silently passes the other).
  const LITERAL_HOME_PATTERN = /\/Users\/[A-Za-z0-9_.-]+/;
  const DASH_SLUG_HOME_PATTERN = /-Users-[A-Za-z0-9_.-]+/;
  const CREDENTIAL_PATTERN = /sk-ant-|oauth_token|refresh_token|access_token|ANTHROPIC_API_KEY\s*[:=]\s*"[^"]+"/i;

  for (const file of fixtureFileNames) {
    it(`${file} carries no literal home path, dash-slug home path, or credential-shaped value`, () => {
      const content = readFileSync(join(FIXTURES_DIR, file), "utf8");
      expect(LITERAL_HOME_PATTERN.exec(content)?.[0] ?? null, `literal home path in ${file}`).toBeNull();
      expect(DASH_SLUG_HOME_PATTERN.exec(content)?.[0] ?? null, `dash-slug home path in ${file}`).toBeNull();
      expect(CREDENTIAL_PATTERN.exec(content)?.[0] ?? null, `credential-shaped value in ${file}`).toBeNull();
    });
  }
});

describe("contract-drift hardening — the gate can actually go red (always-on)", () => {
  it("a fixture frame with a renamed/unknown type fails the parser sweep, not silently", () => {
    const corrupted = { type: "totally_unrecognized_frame_type" };
    const { recognized } = classifyFrame(corrupted);
    expect(recognized).toBe(false);
  });

  it("a required key-path missing from a live payload is reported by missingFromLive, not silently dropped", () => {
    const pinned = loadPinned();
    const live = typedKeyPaths({ totalTokens: 100 }); // maxTokens/percentage/etc. deliberately absent
    const missing = missingFromLive(pinned.controlRequestsSent.get_context_usage!.requiredResponseKeyPaths, live);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("maxTokens:number");
  });

  it("typedKeyPaths distinguishes types (a corrupted pin expecting the wrong JS type is caught)", () => {
    const live = typedKeyPaths({ totalTokens: "100" }); // string, not number
    const missing = missingFromLive(["totalTokens:number"], live);
    expect(missing).toEqual(["totalTokens:number"]);
  });
});

describe.skipIf(!process.env.ANYCODE_CLAUDE_DRIFT_BIN)("contract-drift layer 2 (env-gated, live binary, $0-tier only)", () => {
  it("the live binary meets the version floor, and its initialize/get_usage/get_context_usage responses structurally cover the pin (closes R5-b); a set_model with an omitted model field is probed at $0 (closes R3-b)", async () => {
    const bin = process.env.ANYCODE_CLAUDE_DRIFT_BIN!;
    const rawVersion = execFileSync(bin, ["--version"], { timeout: 10_000, stdio: "pipe" }).toString("utf8").trim();
    const version = parseClaudeVersion(rawVersion);
    expect(version, `unrecognized \`${bin} --version\` output: ${JSON.stringify(rawVersion)}`).not.toBeNull();
    expect(isSupportedClaudeVersion(version!), `${rawVersion} is outside ${SUPPORTED_CLAUDE_VERSION}`).toBe(true);

    const pinned = loadPinned();
    // Diagnostic default: validate against whatever profile is already signed
    // in (mirrors how W0 itself probed) — override with
    // ANYCODE_CLAUDE_DRIFT_CONFIG_DIR to point at an isolated profile instead.
    // Product spawns (claude-client.ts) never do this — profileDir there is a
    // REQUIRED constructor option with no ambient-default fallback (cut C1).
    const profileDir = process.env.ANYCODE_CLAUDE_DRIFT_CONFIG_DIR ?? join(homedir(), ".claude");
    const client = new ClaudeClient({ binaryPath: bin, cwd: tmpdir(), sourceEnv: process.env, profileDir });
    try {
      await client.start();
      const init = await client.controlRequest<unknown>("initialize", {});
      expect(missingFromLive(pinned.controlRequestsSent.initialize!.requiredResponseKeyPaths, typedKeyPaths(init))).toEqual([]);

      const usage = await client.controlRequest<unknown>("get_usage", {});
      expect(missingFromLive(pinned.controlRequestsSent.get_usage!.requiredResponseKeyPaths, typedKeyPaths(usage))).toEqual([]);

      const contextUsage = await client.getContextUsage();
      expect(
        missingFromLive(pinned.controlRequestsSent.get_context_usage!.requiredResponseKeyPaths, typedKeyPaths(contextUsage)),
      ).toEqual([]);

      // R3-b: set_model with `model` omitted — never probed by W0 (the type
      // declares `model?`, implying reset-to-default, but this was never
      // exercised live). Only requirement: it must not hang the transport —
      // either outcome (accept or a control_response error) is a valid,
      // recorded answer to the open question.
      await client.controlRequest<unknown>("set_model", {}).catch(() => undefined);
    } finally {
      await client.close();
    }
  }, 30_000);
});

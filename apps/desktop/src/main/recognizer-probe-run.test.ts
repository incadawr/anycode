/**
 * TASK.203: tests for the probe child's ACTUAL write path — the same
 * `runRecognizerProbe` helper recognizer-probe-child.ts's main() calls, with
 * an injected ask function and the REAL `JsonlTelemetrySink` against a
 * temporary directory. Nothing here re-implements the record shapers; every
 * assertion reads back what the helper itself wrote.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RecognizerEndpoint } from "@anycode/core";
import { runRecognizerProbe, type RecognizerProbeAskFn } from "./recognizer-probe-run.js";
import { RECOGNIZER_PROBE_IMAGE_BASE64, RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE, RECOGNIZER_PROBE_QUESTION, type RecognizerProbeChildInput } from "./recognizer-probe.js";

const ENDPOINT: RecognizerEndpoint = {
  transport: "openai-chat-completions",
  baseUrl: "https://vision.example.com",
  model: "vision-model",
  apiKey: "sk-secret-probe-key",
  providerName: "openai",
};

function input(over: Partial<RecognizerProbeChildInput> = {}): RecognizerProbeChildInput {
  return {
    endpoint: ENDPOINT,
    image: { mediaType: RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE, data: RECOGNIZER_PROBE_IMAGE_BASE64 },
    question: RECOGNIZER_PROBE_QUESTION,
    timeoutMs: 1_000,
    ...over,
  };
}

/** An ask stub answering `result`, recording the options it was called with. */
function askFor(result: Awaited<ReturnType<RecognizerProbeAskFn>>): {
  ask: RecognizerProbeAskFn;
  calls: { endpoint: unknown; image: unknown; question: unknown; signal: unknown }[];
} {
  const calls: { endpoint: unknown; image: unknown; question: unknown; signal: unknown }[] = [];
  const ask = vi.fn(async (opts: { endpoint: unknown; image: unknown; question: unknown; signal: unknown }) => {
    calls.push(opts);
    return result;
  }) as unknown as RecognizerProbeAskFn;
  return { ask, calls };
}

const OK_USAGE = {
  ok: true,
  text: "the left square is red, the right is blue",
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
} as const;

describe("runRecognizerProbe — telemetry enabled", () => {
  it("writes exactly one vision-probe JSONL with session_start then usage, flushes before returning, and records no secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-run-"));
    try {
      const { ask, calls } = askFor(OK_USAGE);
      const result = await runRecognizerProbe(input({ telemetry: { dir, session: "vision-probe-1700000000000" } }), ask);
      expect(result).toEqual(OK_USAGE);

      // Flush-before-return proof: the file is readable IMMEDIATELY after the
      // helper resolves, with no extra wait — dispose() ran before return.
      const names = await readdir(dir);
      expect(names).toEqual(["vision-probe-1700000000000.jsonl"]);
      const lines = (await readFile(join(dir, names[0]!), "utf-8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        v: 1,
        session: "vision-probe-1700000000000",
        t: "session_start",
        model: "vision-model",
        provider: "openai",
      });
      expect(lines[1]).toMatchObject({
        v: 1,
        session: "vision-probe-1700000000000",
        t: "usage",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 40,
      });
      // Order: session_start strictly before usage.
      expect((lines[0]!.ts as number) <= (lines[1]!.ts as number)).toBe(true);

      // Nothing secret or free-form ever landed in the file.
      const raw = await readFile(join(dir, names[0]!), "utf-8");
      expect(raw).not.toContain("sk-secret-probe-key");
      expect(raw).not.toContain(RECOGNIZER_PROBE_QUESTION);
      expect(raw).not.toContain(RECOGNIZER_PROBE_IMAGE_BASE64);
      expect(raw).not.toContain("the left square is red");

      // The ask got exactly the endpoint/image/question, plus a timeout signal.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.endpoint).toEqual(ENDPOINT);
      expect(calls[0]!.image).toEqual({ mediaType: RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE, data: RECOGNIZER_PROBE_IMAGE_BASE64 });
      expect(calls[0]!.question).toBe(RECOGNIZER_PROBE_QUESTION);
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the transport for provider when the endpoint carries no providerName", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-run-"));
    try {
      const { ask } = askFor({ ok: true, text: "red, blue" });
      const bare: RecognizerEndpoint = { transport: "anthropic-messages", baseUrl: "https://bare.example.com", model: "m", apiKey: "k" };
      await runRecognizerProbe(input({ endpoint: bare, telemetry: { dir, session: "vision-probe-1700000000001" } }), ask);
      const name = (await readdir(dir))[0]!;
      const first = JSON.parse((await readFile(join(dir, name), "utf-8")).split("\n")[0]!) as Record<string, unknown>;
      expect(first.provider).toBe("anthropic-messages");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runRecognizerProbe — no-usage / failure / disabled paths", () => {
  it("a disabled input (no telemetry) produces no sink call at all — nothing to clean up, ask still runs", async () => {
    const { ask } = askFor(OK_USAGE);
    const result = await runRecognizerProbe(input(), ask);
    expect(result).toEqual(OK_USAGE);
  });

  it("an unsuccessful AskResult writes session_start only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-run-"));
    try {
      const { ask } = askFor({ ok: false, kind: "provider", error: "upstream 500" });
      await runRecognizerProbe(input({ telemetry: { dir, session: "vision-probe-1700000000002" } }), ask);
      const name = (await readdir(dir))[0]!;
      const lines = (await readFile(join(dir, name), "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).t).toBe("session_start");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a success WITHOUT usage writes session_start only — no fake usage is invented", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-run-"));
    try {
      const { ask } = askFor({ ok: true, text: "red, blue" });
      await runRecognizerProbe(input({ telemetry: { dir, session: "vision-probe-1700000000003" } }), ask);
      const name = (await readdir(dir))[0]!;
      const lines = (await readFile(join(dir, name), "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).t).toBe("session_start");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a THROWN ask still flushes session_start before the rejection propagates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-run-"));
    try {
      const ask = vi.fn(async () => {
        throw new Error("socket exploded");
      }) as unknown as RecognizerProbeAskFn;
      await expect(runRecognizerProbe(input({ telemetry: { dir, session: "vision-probe-1700000000004" } }), ask)).rejects.toThrow(
        "socket exploded",
      );
      const name = (await readdir(dir))[0]!;
      const lines = (await readFile(join(dir, name), "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).t).toBe("session_start");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The Vision panel probe's child entry (TASK.198 срез E2): a plain node
 * process (spawned with `ELECTRON_RUN_AS_NODE=1`, see recognizer-probe.ts's
 * module doc) that reads ONE `RecognizerProbeChildInput` from its own stdin,
 * calls `ask()` — the SAME one-shot vision primitive a live host uses
 * (packages/core/src/vision/recognizer.ts) — exactly once, and prints the
 * result. No request-building logic of its own: reusing `ask()` here rather
 * than reimplementing "which AI-SDK provider factory does this transport
 * need" is the entire reason this probe is a real child process instead of an
 * inline script (recognizer-probe.ts's module doc).
 *
 * This file is its own bundled entry point (electron.vite.config.ts's third
 * `main` target input, key `"recognizer-probe-child"`) — `@anycode/core` is
 * excluded from externalization for the whole `main` target, so `ask()` and
 * everything it pulls in are bundled directly into the emitted
 * `recognizer-probe-child.js` (and whatever shared chunk rollup hoists it
 * into), never resolved from `node_modules` at run time.
 *
 * The api key travels here over stdin ONLY — never argv (visible to any
 * process on the machine via `ps`) and never env — so this file reads the
 * WHOLE stream before doing anything else, exactly once.
 */

import { ask } from "@anycode/core";
import type { ImageAttachment, RecognizerEndpoint } from "@anycode/core";
import type { RecognizerProbeChildInput } from "./recognizer-probe.js";
import { RECOGNIZER_PROBE_MARKER } from "./recognizer-probe.js";

/** Reads `process.stdin` to completion as a single utf-8 string. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", (err) => reject(err));
  });
}

/**
 * Writes the one result line and exits explicitly. `process.exit` is called
 * from the write CALLBACK, not immediately after `write()` returns, because
 * stdout to a pipe is asynchronous on POSIX and exiting before the flush
 * would truncate the only output the parent's classifier has — same
 * measured reasoning as proxy-probe.ts's own child script.
 */
function emit(payload: unknown, exitCode: number): void {
  process.stdout.write(RECOGNIZER_PROBE_MARKER + JSON.stringify(payload) + "\n", () => process.exit(exitCode));
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as RecognizerProbeChildInput;
  const endpoint: RecognizerEndpoint = input.endpoint;
  const image: ImageAttachment = { mediaType: input.image.mediaType, data: input.image.data };
  const result = await ask({
    endpoint,
    image,
    question: input.question,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  emit(result, 0);
}

main().catch((err: unknown) => {
  // `ask()` itself never throws (its own doc) — this only fires on a
  // malformed stdin payload (JSON.parse) or a stdin stream error, neither of
  // which the parent's classifier can distinguish from a provider failure,
  // so it is folded into the SAME `AskResult`-shaped "provider" kind the
  // parent already knows how to classify, rather than inventing a second
  // failure vocabulary for the child alone.
  const message = err instanceof Error ? err.message : String(err);
  emit({ ok: false, kind: "provider", error: message }, 1);
});

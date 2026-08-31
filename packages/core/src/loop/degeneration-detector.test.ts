/**
 * Unit tests for the degenerate-generation loop detector (TASK.210). Covers
 * the pure detection primitive in isolation from AgentLoop — the loop
 * integration seam (abort, reset on stream_retry, supervised-root exemption)
 * is exercised separately in agent-loop.test.ts.
 */

import { describe, expect, it } from "vitest";
import { DegenerationDetector } from "./degeneration-detector.js";
import {
  DEGENERATION_CHECK_STRIDE_CHARS,
  DEGENERATION_MIN_PERIOD_CHARS,
  DEGENERATION_MIN_REPEATS,
  DEGENERATION_MIN_RUN_CHARS,
} from "../types/config.js";

/** Splits `text` into chunks of `size` characters, mirroring how a real stream arrives in pieces. */
function chunk(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

/** Feeds every chunk in order, returning the first non-null verdict (or null if none fired). */
function feedAll(detector: DegenerationDetector, chunks: string[]) {
  for (const c of chunks) {
    const verdict = detector.feed(c);
    if (verdict) return verdict;
  }
  return null;
}

// Stand-in for the incident's looping phrase; length is deliberately not a
// round number so the period the detector reports isn't a suspicious coincidence.
const INCIDENT_PHRASE = "Запускаю тест. Прогон. ФИНАЛЬНО. Погнали. ";

/**
 * Repeats `phrase` past `minChars`, with enough slack for the check's own
 * detection lag (checks run only every DEGENERATION_CHECK_STRIDE_CHARS fed
 * characters, so the last checkpoint before a short stream ends may still
 * land short of MIN_RUN_CHARS — see the STRIDE constant's docstring for the
 * "MIN_RUN + STRIDE + one chunk" bound this margin covers).
 */
function repeatToAtLeast(phrase: string, minChars: number): string {
  const target = minChars + DEGENERATION_CHECK_STRIDE_CHARS + 256;
  const times = Math.ceil(target / phrase.length) + DEGENERATION_MIN_REPEATS;
  return phrase.repeat(times);
}

describe("DegenerationDetector — positive cases", () => {
  it("fires on the incident phrase repeated past MIN_RUN, chunked at 50-200 chars", () => {
    const loopText = repeatToAtLeast(INCIDENT_PHRASE, DEGENERATION_MIN_RUN_CHARS);
    for (const size of [50, 73, 137, 200]) {
      const detector = new DegenerationDetector();
      const verdict = feedAll(detector, chunk(loopText, size));
      expect(verdict).not.toBeNull();
      expect(verdict!.period).toBeGreaterThanOrEqual(DEGENERATION_MIN_PERIOD_CHARS);
      // The reported period should land on (a multiple close to) the phrase length —
      // the detector is free to report a shorter aliasing period, but it must not
      // report something wildly off (e.g. a single-character period).
      expect(verdict!.period).toBeGreaterThanOrEqual(Math.floor(INCIDENT_PHRASE.length / 2));
      expect(verdict!.repeats).toBeGreaterThanOrEqual(DEGENERATION_MIN_REPEATS);
    }
  });

  it("fires even when 3000 chars of normal prose precede the loop (suffix-only check)", () => {
    const prose =
      "This is an ordinary, varied paragraph of generated prose that never repeats itself verbatim and just keeps describing unrelated things at length so that it reaches a few thousand characters of unique content before anything resembling a loop begins to happen in the stream. ".repeat(
        20,
      );
    expect(prose.length).toBeGreaterThan(3_000);
    const loopText = repeatToAtLeast(INCIDENT_PHRASE, DEGENERATION_MIN_RUN_CHARS);
    const detector = new DegenerationDetector();
    const verdict = feedAll(detector, chunk(prose + loopText, 97));
    expect(verdict).not.toBeNull();
  });

  it("still fires on a period matching the measured incident (~296 chars) after MIN_PERIOD_CHARS was raised (codex review finding)", () => {
    // Built from pseudo-random word concatenation (same technique as the
    // "connected prose" negative test below) so its OWN minimal period is
    // its full 296-char length, not some accidental smaller period.
    const words = [
      "Запускаю",
      "тест",
      "снова",
      "Прогон",
      "идёт",
      "медленно",
      "чтобы",
      "точно",
      "поймать",
      "степень",
      "повторения",
      "до",
      "конца",
      "цикла",
    ];
    let phrase = "";
    let seed = 11;
    while (phrase.length < 296) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      phrase += words[seed % words.length] + " ";
    }
    phrase = phrase.slice(0, 296);
    const loopText = repeatToAtLeast(phrase, DEGENERATION_MIN_RUN_CHARS);
    const detector = new DegenerationDetector();
    const verdict = feedAll(detector, chunk(loopText, 137));
    expect(verdict).not.toBeNull();
    expect(verdict!.period).toBe(296);
    expect(verdict!.repeats).toBeGreaterThanOrEqual(DEGENERATION_MIN_REPEATS);
  });
});

describe("DegenerationDetector — negative cases (must stay silent)", () => {
  it("does not fire on a diff with 3 identical short lines", () => {
    const diffLine = "-    const value = computeSomething(a, b, c);\n";
    const text = diffLine.repeat(3) + "+    const value = computeSomethingElse(a, b, c);\n".repeat(3);
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 40))).toBeNull();
  });

  it("does not fire on a long run of a 3-char data period ('0, ' x1500)", () => {
    const text = "0, ".repeat(1500);
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 61))).toBeNull();
  });

  it("does not fire on a long run of '=' rule characters", () => {
    const text = "=".repeat(2500);
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 83))).toBeNull();
  });

  it("does not fire on a period-exactly-8 base64-shaped data block repeated hundreds of times (codex review finding)", () => {
    // sol's exact example: valid base64 for a repeating 6-byte sequence,
    // period 8 — legitimate structured data, not a phrase. With the original
    // MIN_PERIOD_CHARS=8 this block DOES trip the detector (period>=8 alone
    // qualified it); the constant was raised specifically to exclude it while
    // the measured incident period (~296, tested above) stays comfortably clear.
    const BASE64_BLOCK = "AAECAwQF";
    const text = BASE64_BLOCK.repeat(300);
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 61))).toBeNull();
  });

  it("does not fire on 2000 chars of connected, non-repeating prose", () => {
    const words = [
      "the",
      "system",
      "carefully",
      "walks",
      "through",
      "every",
      "candidate",
      "before",
      "committing",
      "to",
      "a",
      "final",
      "plan",
      "and",
      "then",
      "explains",
      "its",
      "reasoning",
      "in",
      "detail",
      "for",
      "the",
      "reader",
    ];
    let text = "";
    let seed = 7;
    while (text.length < 2_000) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      text += words[seed % words.length] + " ";
    }
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 71))).toBeNull();
  });

  it("does not fire on a near-repeat with a running counter", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 400; i++) {
      lines.push(`Attempt ${i}: retrying the operation once more before giving up entirely.\n`);
    }
    const text = lines.join("");
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(text, 89))).toBeNull();
  });
});

/**
 * Pseudo-random word generator (same technique used throughout this file) —
 * gives a phrase of exactly `target` chars whose own minimal period is its
 * full length, so a repeat of it exercises the detector on a clean, known
 * period rather than risking an accidental shorter one.
 */
function buildNonRepeatingPhrase(target: number, seedStart: number): string {
  const words = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
  ];
  let phrase = "";
  let seed = seedStart;
  while (phrase.length < target) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    phrase += words[seed % words.length] + " ";
  }
  return phrase.slice(0, target);
}

describe("DegenerationDetector — structural blind spot above WINDOW/MIN_REPEATS (codex review finding, TASK.210 second pass)", () => {
  it("a period of 1500 chars (> WINDOW_CHARS/MIN_REPEATS ≈ 1365) is NEVER detected, no matter how much text is fed", () => {
    const phrase = buildNonRepeatingPhrase(1500, 5);
    // 20 repeats (30,000 chars) is far past anything a real turn would need
    // for detection to kick in if it were going to — this is the documented
    // hard ceiling from DEGENERATION_WINDOW_CHARS's own docstring, not a
    // detection-lag question.
    const loopText = phrase.repeat(20);
    const detector = new DegenerationDetector();
    expect(feedAll(detector, chunk(loopText, 137))).toBeNull();
  });

  it("a period of 1200 chars (< the ~1365 ceiling) DOES eventually fire — the ceiling is exact, not overly conservative", () => {
    const phrase = buildNonRepeatingPhrase(1200, 7);
    const loopText = phrase.repeat(20);
    const detector = new DegenerationDetector();
    const verdict = feedAll(detector, chunk(loopText, 137));
    expect(verdict).not.toBeNull();
    expect(verdict!.period).toBe(1200);
  });
});

describe("DegenerationDetector — reset()", () => {
  it("clears buffered state so a post-reset run must independently clear MIN_RUN", () => {
    const detector = new DegenerationDetector();
    const half = repeatToAtLeast(INCIDENT_PHRASE, 1_024).slice(0, 1_024);

    // First half-run alone must not be enough to trip the detector.
    expect(feedAll(detector, chunk(half, 64))).toBeNull();

    detector.reset();

    // A second half-run right after reset must ALSO not trip it — if reset()
    // failed to clear the buffer, concatenating the two halves would exceed
    // MIN_RUN_CHARS and produce a false positive here.
    expect(feedAll(detector, chunk(half, 64))).toBeNull();
  });
});

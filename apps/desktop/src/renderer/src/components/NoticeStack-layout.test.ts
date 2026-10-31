/**
 * UI audit v0.0.49 §C2 — the toast stack must never sit on the composer.
 *
 * The stack is a window-level overlay (`position: fixed`), the composer is a
 * flex child of the conversation column, and the two meet at the worst possible
 * moment: a refusal lands in the bottom-right corner exactly while the user is
 * reaching for Stop, the send arrow or the context meter.
 *
 * `composer-clearance.ts` publishes the composer's measured clearance as
 * `--composer-clearance`; `.notice-stack` consumes it as its `bottom`. This test
 * renders the real shell CSS in a real browser at the two widths the report
 * names (900 and 1400 px) — because the overlap is a LAYOUT fact, not something
 * a class-name assertion can see:
 *
 *  1. WITHOUT the property, the stack lands on the composer and covers the send
 *     button — the defect, reproduced as the baseline;
 *  2. WITH the property valued by the SAME pure function the composer uses, the
 *     whole stack clears the card and its controls, and stays on screen.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { composerClearancePx } from "../composer-clearance.js";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const css = ["tokens.css", "app.css"]
  .map((file) => readFileSync(resolve(import.meta.dirname, "..", file), "utf8"))
  .join("\n");

/** Three toasts = the live cap: the tallest the stack ever gets. */
const TOASTS = `
  <div class="notice-stack">
    <div class="notice-toast notice-toast-compaction_end notice-toast-tone-neutral">
      <span class="notice-toast-text">Compaction not applied: model unreachable</span>
      <button type="button" class="notice-toast-dismiss" aria-label="Dismiss notice">×</button>
    </div>
    <div class="notice-toast notice-toast-slash_command_rejected notice-toast-tone-warning">
      <span class="notice-toast-text">Cannot compact while this session is busy. Try again after this turn.</span>
      <button type="button" class="notice-toast-dismiss" aria-label="Dismiss notice">×</button>
    </div>
    <div class="notice-toast notice-toast-stream_retry notice-toast-tone-neutral">
      <span class="notice-toast-text">Retrying… (attempt 5/8: rate limited)</span>
      <button type="button" class="notice-toast-dismiss" aria-label="Dismiss notice">×</button>
    </div>
  </div>`;

function fixture(clearancePx: number | null): string {
  return `<!doctype html>
<html lang="en" data-theme="dark"${clearancePx === null ? "" : ` style="--composer-clearance: ${clearancePx}px"`}>
<head><meta charset="utf-8"><style>${css}
  /* Geometry, not motion: the enter animation must not be mid-frame. */
  *, *::before, *::after { animation: none !important; transition: none !important; }
</style></head>
<body>
  <main class="app">
    <aside class="sidebar"></aside>
    <div class="main-pane">
      <div class="session-content">
        <div class="session-conversation">
          <div class="message-list">
            <div class="message">A message in the transcript.</div>
            <div class="message">Another one, so the column has content to scroll.</div>
          </div>
          <div class="composer">
            <textarea class="composer-textarea" rows="1" placeholder="Message"></textarea>
            <div class="composer-footer">
              <div class="composer-footer-left">
                <button type="button" class="composer-mode">Build</button>
              </div>
              <div class="composer-footer-right">
                <button type="button" class="composer-ctx-meter" id="meter">42%</button>
                <button type="button" class="composer-send" id="send" aria-label="Send">↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    ${TOASTS}
  </main>
  <pre id="result"></pre>
  <script>
    const box = (element) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    document.querySelector('#result').textContent = JSON.stringify({
      viewport: { width: innerWidth, height: innerHeight },
      composer: box(document.querySelector('.composer')),
      stack: box(document.querySelector('.notice-stack')),
      toasts: [...document.querySelectorAll('.notice-toast')].map(box),
      send: box(document.querySelector('#send')),
      meter: box(document.querySelector('#meter')),
    });
  </script>
</body></html>`;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Measured {
  viewport: { width: number; height: number };
  composer: Box;
  stack: Box | null;
  toasts: Box[];
  send: Box | null;
  meter: Box | null;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function measure(html: string, width: number): Measured {
  const directory = mkdtempSync(resolve(tmpdir(), "anycode-toast-layout-"));
  try {
    const file = resolve(directory, "shell.html");
    writeFileSync(file, html);
    const run = spawnSync(
      chrome,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-background-networking",
        "--no-first-run",
        `--user-data-dir=${directory}/profile`,
        `--window-size=${width},900`,
        "--dump-dom",
        `file://${file}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const match = run.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    expect(match, run.stdout.slice(0, 2000)).not.toBeNull();
    return JSON.parse(match![1]!) as Measured;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("notice stack vs composer (UI audit v0.0.49 C2)", () => {
  it.skipIf(!existsSync(chrome))(
    "clears the composer at 900 and 1400 px, and the corner fallback is what used to cover it",
    () => {
      for (const width of [900, 1400]) {
        // Baseline: no clearance published (start screen / welcome fallback).
        const bare = measure(fixture(null), width);
        expect(bare.viewport.width).toBe(width);
        expect(bare.stack).not.toBeNull();
        expect(bare.send).not.toBeNull();
        // The defect this fix names: at both widths the stack reaches over the
        // composer card and its send button.
        expect(overlaps(bare.stack!, bare.composer)).toBe(true);
        expect(overlaps(bare.stack!, bare.send!)).toBe(true);

        // Fixed: the same function the composer publishes its clearance with.
        const clearance = composerClearancePx(bare.composer.top, bare.viewport.height);
        const fixed = measure(fixture(clearance), width);

        // The stack as a whole sits ABOVE the card, with the gap intact.
        expect(fixed.stack!.bottom).toBeLessThanOrEqual(fixed.composer.top);
        // …so no toast overlaps the card, the send arrow or the meter.
        expect(fixed.toasts).toHaveLength(3);
        for (const toast of fixed.toasts) {
          expect(overlaps(toast, fixed.composer)).toBe(false);
          expect(overlaps(toast, fixed.send!)).toBe(false);
          expect(overlaps(toast, fixed.meter!)).toBe(false);
        }
        // Lifting must not push the stack off screen, and the right-hand corner
        // anchor is unchanged (only the vertical offset moves).
        expect(fixed.stack!.top).toBeGreaterThanOrEqual(0);
        expect(Math.round(fixed.stack!.right)).toBe(Math.round(bare.stack!.right));
      }
    },
    120_000,
  );
});

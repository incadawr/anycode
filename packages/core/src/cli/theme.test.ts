/**
 * cli/theme.ts unit tests (design slice-4.1-cut.md §3.2, §5.2 item 3): the
 * detectColorEnabled precedence matrix (frozen contract, task 4.1.1 — verified
 * here rather than changed) and the real SGR palette createCliTheme/paint
 * ships in task 4.1.3, including the no-color identity byte-invariant that
 * anchors main.test.ts's existing snapshots.
 */

import { describe, expect, it } from "vitest";
import { createCliTheme, detectColorEnabled, type CliStyleRole } from "./theme.js";

const ALL_ROLES: CliStyleRole[] = [
  "banner",
  "toolName",
  "toolResultOk",
  "toolResultError",
  "error",
  "warn",
  "usage",
  "progress",
  "ask",
  "askHint",
  "dim",
  "diffAdd",
  "diffRemove",
  "reasoning",
  "spinner",
];

describe("detectColorEnabled (design §3.2 precedence — frozen contract)", () => {
  it("--no-color flag wins over everything else", () => {
    expect(
      detectColorEnabled({
        env: { NO_COLOR: undefined, FORCE_COLOR: "1", TERM: "xterm" } as NodeJS.ProcessEnv,
        outputIsTTY: true,
        noColorFlag: true,
      }),
    ).toBe(false);
  });

  it("NO_COLOR (any value, including empty string) beats FORCE_COLOR/isTTY", () => {
    expect(
      detectColorEnabled({
        env: { NO_COLOR: "", FORCE_COLOR: "1" } as unknown as NodeJS.ProcessEnv,
        outputIsTTY: true,
        noColorFlag: false,
      }),
    ).toBe(false);
    expect(
      detectColorEnabled({
        env: { NO_COLOR: "1", FORCE_COLOR: "1" } as unknown as NodeJS.ProcessEnv,
        outputIsTTY: true,
        noColorFlag: false,
      }),
    ).toBe(false);
  });

  it("FORCE_COLOR=1 forces color on even when the output stream is not a TTY", () => {
    expect(
      detectColorEnabled({
        env: { FORCE_COLOR: "1" } as NodeJS.ProcessEnv,
        outputIsTTY: false,
        noColorFlag: false,
      }),
    ).toBe(true);
  });

  it("FORCE_COLOR=0 does NOT force color on (treated the same as unset)", () => {
    expect(
      detectColorEnabled({
        env: { FORCE_COLOR: "0" } as NodeJS.ProcessEnv,
        outputIsTTY: false,
        noColorFlag: false,
      }),
    ).toBe(false);
  });

  it("FORCE_COLOR='' (present but empty) does NOT force color on", () => {
    expect(
      detectColorEnabled({
        env: { FORCE_COLOR: "" } as NodeJS.ProcessEnv,
        outputIsTTY: false,
        noColorFlag: false,
      }),
    ).toBe(false);
  });

  it("TERM=dumb disables color even on a TTY, below FORCE_COLOR in precedence", () => {
    expect(
      detectColorEnabled({
        env: { TERM: "dumb" } as NodeJS.ProcessEnv,
        outputIsTTY: true,
        noColorFlag: false,
      }),
    ).toBe(false);
    expect(
      detectColorEnabled({
        env: { TERM: "dumb", FORCE_COLOR: "1" } as NodeJS.ProcessEnv,
        outputIsTTY: true,
        noColorFlag: false,
      }),
    ).toBe(true);
  });

  it("falls through to outputIsTTY when nothing else applies", () => {
    expect(
      detectColorEnabled({ env: {} as NodeJS.ProcessEnv, outputIsTTY: true, noColorFlag: false }),
    ).toBe(true);
    expect(
      detectColorEnabled({ env: {} as NodeJS.ProcessEnv, outputIsTTY: false, noColorFlag: false }),
    ).toBe(false);
  });
});

describe("createCliTheme — color=false is pure identity (design §0.1 no-color byte anchor)", () => {
  it("paint returns the exact same string content for every role", () => {
    const theme = createCliTheme({ color: false });
    expect(theme.color).toBe(false);
    for (const role of ALL_ROLES) {
      const text = `sample text for ${role}`;
      expect(theme.paint(role, text)).toBe(text);
    }
  });

  it("is byte-for-byte identity even for strings that already contain escape-like sequences or are empty", () => {
    const theme = createCliTheme({ color: false });
    expect(theme.paint("error", "")).toBe("");
    expect(theme.paint("banner", "\x1b[31mnot really an escape\x1b[0m")).toBe(
      "\x1b[31mnot really an escape\x1b[0m",
    );
    expect(theme.paint("toolName", "line one\nline two\n")).toBe("line one\nline two\n");
  });
});

describe("createCliTheme — color=true wraps each role in exactly one SGR escape (design §3.2 palette)", () => {
  const theme = createCliTheme({ color: true });

  it.each<[CliStyleRole, string]>([
    ["banner", "1"],
    ["toolName", "36"],
    ["toolResultOk", "32"],
    ["toolResultError", "31"],
    ["error", "31;1"],
    ["warn", "33"],
    ["usage", "2"],
    ["progress", "2"],
    ["ask", "35;1"],
    ["askHint", "2"],
    ["dim", "2"],
    ["diffAdd", "32"],
    ["diffRemove", "31"],
    ["reasoning", "2"],
    ["spinner", "36"],
  ])("role %s paints with SGR params %s", (role, params) => {
    expect(theme.paint(role, "hello")).toBe(`\x1b[${params}mhello\x1b[0m`);
  });

  it("roles are atomic — no nested escapes are introduced by painting an already-painted string", () => {
    const inner = theme.paint("toolName", "Write");
    const outer = theme.paint("error", inner);
    // Exactly one reset immediately after "Write", then the outer reset at the end —
    // painting never re-wraps or strips the inner escape, it just concatenates.
    expect(outer).toBe(`\x1b[31;1m\x1b[36mWrite\x1b[0m\x1b[0m`);
  });

  it("theme.color reports true", () => {
    expect(theme.color).toBe(true);
  });
});

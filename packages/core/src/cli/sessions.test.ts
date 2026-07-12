/**
 * cli/sessions.ts tests (design slice-4.4-cut.md §7 B1 unit plan):
 * formatRelativeTime's 5 buckets on a fixed `now`, shortSessionId,
 * renderSessionsTable's column/theme/sanitization behaviour (mirrors
 * render.test.ts's renderMcpStatusTable/renderSkillsTable coverage, A18),
 * and promptSessionSelection's answer-mapping/abort/rl-lifecycle contract
 * driven over a real readline.Interface + PassThrough (mirrors
 * terminal-broker.test.ts's "real readline over PassThrough" style).
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../ports/persistence.js";
import { createCliTheme } from "./theme.js";
import {
  SESSIONS_PICKER_MAX_REPROMPTS,
  SESSIONS_TITLE_MAX_CHARS,
  formatRelativeTime,
  promptSessionSelection,
  renderSessionsTable,
  shortSessionId,
} from "./sessions.js";

const NOCOLOR = createCliTheme({ color: false });
const COLOR = createCliTheme({ color: true });

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-0000000000000001",
    workspace: "/workspace/one",
    model: "test-model",
    mode: "build",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("shortSessionId", () => {
  it("returns the first 8 characters of a longer id", () => {
    expect(shortSessionId("session-0000000000000001")).toBe("session-");
  });

  it("returns the id unchanged when it is 8 characters or shorter", () => {
    expect(shortSessionId("abcdefgh")).toBe("abcdefgh");
    expect(shortSessionId("abc")).toBe("abc");
    expect(shortSessionId("")).toBe("");
  });
});

describe("formatRelativeTime — deterministic buckets on a fixed now", () => {
  const now = 1_700_000_000_000;

  it("<60s -> \"just now\"", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 59_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 59_999, now)).toBe("just now");
  });

  it("<60m -> \"Nm ago\"", () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 90_000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59m ago");
  });

  it("<24h -> \"Nh ago\"", () => {
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
  });

  it("<7d -> \"Nd ago\"", () => {
    expect(formatRelativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(formatRelativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6d ago");
  });

  it(">=7d -> the UTC calendar date as yyyy-mm-dd", () => {
    const sevenDaysMs = 7 * 24 * 60 * 60_000;
    expect(formatRelativeTime(now - sevenDaysMs, now)).toBe(new Date(now - sevenDaysMs).toISOString().slice(0, 10));
    const wayBack = Date.UTC(2020, 0, 15, 12, 0, 0);
    expect(formatRelativeTime(wayBack, now)).toBe("2020-01-15");
  });

  it("never reads the clock itself (pure function of its two arguments)", () => {
    expect(formatRelativeTime(1000, 1000)).toBe(formatRelativeTime(1000, 1000));
  });
});

describe("renderSessionsTable", () => {
  const now = 1_700_000_000_000;

  it("empty input renders the none-found placeholder", () => {
    expect(renderSessionsTable([], { now })).toBe("[sessions] none found\n");
  });

  it("basic table: columns id/title/mode/updated, no leading # or trailing workspace", () => {
    const metas = [
      makeSession({ id: "aaaaaaaa-1111", title: "Fix the flaky test", mode: "build", updatedAt: now - 60_000 }),
      makeSession({ id: "bbbbbbbb-2222", title: "Refactor sessions", mode: "plan", updatedAt: now - 3_600_000 }),
    ];
    const text = renderSessionsTable(metas, { now });
    const lines = text.split("\n");
    expect(lines[0]).toBe("id        title               mode   updated");
    expect(lines[1]).toBe("aaaaaaaa  Fix the flaky test  build  1m ago");
    expect(lines[2]).toBe("bbbbbbbb  Refactor sessions   plan   1h ago");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("numbered: true adds a leading # column, 1-indexed", () => {
    const metas = [makeSession({ id: "aaaaaaaa-1", title: "one" }), makeSession({ id: "bbbbbbbb-2", title: "two" })];
    const text = renderSessionsTable(metas, { now, numbered: true });
    const lines = text.split("\n");
    expect(lines[0]?.startsWith("#")).toBe(true);
    expect(lines[1]?.startsWith("1  ")).toBe(true);
    expect(lines[2]?.startsWith("2  ")).toBe(true);
  });

  it("currentId suffixes a \"*\" onto the matching session's id cell only", () => {
    const metas = [makeSession({ id: "aaaaaaaa-1" }), makeSession({ id: "bbbbbbbb-2" })];
    const text = renderSessionsTable(metas, { now, currentId: "bbbbbbbb-2" });
    const lines = text.split("\n");
    expect(lines[1]).toContain("aaaaaaaa ");
    expect(lines[1]).not.toContain("aaaaaaaa*");
    expect(lines[2]).toContain("bbbbbbbb*");
  });

  it("showWorkspace adds a trailing workspace column", () => {
    const metas = [makeSession({ id: "aaaaaaaa-1", workspace: "/ws/a" })];
    const text = renderSessionsTable(metas, { now, showWorkspace: true });
    const lines = text.split("\n");
    expect(lines[0]?.endsWith("workspace")).toBe(true);
    expect(lines[1]).toContain("/ws/a");
  });

  it("(untitled) fallback when title is undefined or sanitizes to empty", () => {
    const metas = [
      makeSession({ id: "aaaaaaaa-1", title: undefined }),
      makeSession({ id: "bbbbbbbb-2", title: "<system-reminder>only reminder text</system-reminder>" }),
    ];
    const text = renderSessionsTable(metas, { now });
    const lines = text.split("\n");
    expect(lines[1]).toContain("(untitled)");
    expect(lines[2]).toContain("(untitled)");
  });

  it("caps a long title at SESSIONS_TITLE_MAX_CHARS with an ellipsis", () => {
    const longTitle = "x".repeat(SESSIONS_TITLE_MAX_CHARS + 20);
    const metas = [makeSession({ id: "aaaaaaaa-1", title: longTitle })];
    const text = renderSessionsTable(metas, { now });
    const lines = text.split("\n");
    const titleCell = lines[1]?.split(/\s{2,}/)[1];
    expect(titleCell).toBe(`${"x".repeat(SESSIONS_TITLE_MAX_CHARS)}…`);
  });

  it("sanitizes paired reminder-tag blocks out of a title before display", () => {
    const metas = [
      makeSession({
        id: "aaaaaaaa-1",
        title: "<hook-context>ignored</hook-context>Real title",
      }),
    ];
    const text = renderSessionsTable(metas, { now });
    expect(text).toContain("Real title");
    expect(text).not.toContain("hook-context");
    expect(text).not.toContain("ignored");
  });

  it("is byte-identical with no theme and with a color=false theme", () => {
    const metas = [makeSession({ id: "aaaaaaaa-1" })];
    const noTheme = renderSessionsTable(metas, { now });
    const noColor = renderSessionsTable(metas, { now, theme: NOCOLOR });
    expect(noTheme).toBe(noColor);
  });

  it("with color=true, wraps ONLY the header row in dim and preserves body alignment (widths computed unpainted, A18/L8)", () => {
    const metas = [
      makeSession({ id: "aaaaaaaa-1", title: "short" }),
      makeSession({ id: "bbbbbbbb-2", title: "a much longer title here" }),
    ];
    const plain = renderSessionsTable(metas, { now });
    const colored = renderSessionsTable(metas, { now, theme: COLOR });
    const [plainHeader, ...plainBody] = plain.split("\n");
    const [coloredHeader, ...coloredBody] = colored.split("\n");
    expect(coloredHeader).toBe(`\x1b[2m${plainHeader}\x1b[0m`);
    expect(coloredBody).toEqual(plainBody);
  });

  it("placeholder line (no sessions) is unaffected by theme", () => {
    expect(renderSessionsTable([], { now, theme: COLOR })).toBe("[sessions] none found\n");
  });
});

describe("promptSessionSelection — real readline over PassThrough (design §2.2/§2.4-para.2)", () => {
  const now = 1_700_000_000_000;
  const sessions: SessionMeta[] = [
    makeSession({ id: "aaaaaaaa-1", title: "first session" }),
    makeSession({ id: "bbbbbbbb-2", title: "second session" }),
  ];

  it("prints the numbered table before asking", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    expect(out).toContain("#");
    expect(out).toContain("first session");
    expect(out).toContain("second session");
    expect(out).toContain("pick a session (1-2), Enter = new, q = quit: ");
    input.write("q\n");
    await pending;
  });

  it("picks session 1 by index", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.write("1\n");
    await expect(pending).resolves.toEqual({ kind: "resume", session: sessions[0] });
  });

  it("picks the last session (K) by index", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.write("2\n");
    await expect(pending).resolves.toEqual({ kind: "resume", session: sessions[1] });
  });

  it("an out-of-range index re-prompts, then a valid answer resolves", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.write("99\n2\n");
    await expect(pending).resolves.toEqual({ kind: "resume", session: sessions[1] });
    expect(out.split("pick a session").length - 1).toBe(2);
  });

  it("after SESSIONS_PICKER_MAX_REPROMPTS unrecognised answers, fails soft to new", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    const garbage = Array.from({ length: SESSIONS_PICKER_MAX_REPROMPTS }, () => "nonsense").join("\n") + "\n";
    input.write(garbage);
    await expect(pending).resolves.toEqual({ kind: "new" });
  });

  it('empty answer ("") resolves to new', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.write("\n");
    await expect(pending).resolves.toEqual({ kind: "new" });
  });

  it('"n"/"new" resolve to new', async () => {
    for (const answer of ["n", "new", "N", "NEW"]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
      input.write(`${answer}\n`);
      await expect(pending).resolves.toEqual({ kind: "new" });
    }
  });

  it('"q"/"quit" resolve to abort', async () => {
    for (const answer of ["q", "quit", "Q", "QUIT"]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
      input.write(`${answer}\n`);
      await expect(pending).resolves.toEqual({ kind: "abort" });
    }
  });

  it("EOF (input ends with no answer given) resolves to abort", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.end();
    await expect(pending).resolves.toEqual({ kind: "abort" });
  });

  it("closes its own rl unconditionally: the input stream's listeners are fully released after resolving, on every path (resume/new/abort/EOF)", async () => {
    const drivers: Array<(input: PassThrough) => void> = [
      (input) => input.write("1\n"),
      (input) => input.write("n\n"),
      (input) => input.write("q\n"),
      (input) => input.end(),
    ];
    for (const drive of drivers) {
      const input = new PassThrough();
      const output = new PassThrough();
      const baseline = input.eventNames();
      const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
      drive(input);
      await pending;
      expect(input.eventNames()).toEqual(baseline);
    }
  });

  it("reuses the input stream immediately for a brand-new readline.Interface right after resolving", async () => {
    const { createInterface } = await import("node:readline");
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptSessionSelection({ sessions, input, output, theme: NOCOLOR, now });
    input.write("n\n");
    await expect(pending).resolves.toEqual({ kind: "new" });

    const rl2 = createInterface({ input, output });
    const linePromise = new Promise<string>((resolve) => rl2.once("line", resolve));
    input.write("hello\n");
    await expect(linePromise).resolves.toBe("hello");
    rl2.close();
  });
});

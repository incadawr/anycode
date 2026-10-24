import { describe, expect, it } from "vitest";

import { COMMAND_HELP, KNOWN_SLASH_COMMANDS } from "./commands.js";
import { slashCompletions } from "./completions.js";

describe("slashCompletions (Taskana 4082)", () => {
  it("`/` returns all commands in KNOWN_SLASH_COMMANDS order with their COMMAND_HELP summaries", () => {
    const result = slashCompletions("/");
    expect(result.map((c) => c.command)).toEqual([...KNOWN_SLASH_COMMANDS]);
    expect(result).toEqual(COMMAND_HELP.map((entry) => ({ command: entry.command, summary: entry.summary })));
  });

  it("`/c` matches /compact, /commit, /context", () => {
    expect(slashCompletions("/c").map((c) => c.command)).toEqual(["/compact", "/commit", "/context"]);
  });

  it("`/co` matches /compact, /commit, /context", () => {
    expect(slashCompletions("/co").map((c) => c.command)).toEqual(["/compact", "/commit", "/context"]);
  });

  it("`/con` matches only /context", () => {
    expect(slashCompletions("/con").map((c) => c.command)).toEqual(["/context"]);
  });

  it("`/com` matches /compact and /commit", () => {
    expect(slashCompletions("/com").map((c) => c.command)).toEqual(["/compact", "/commit"]);
  });

  it("rejects non-slash queries: uppercase `/Q`, bare `help`, empty string", () => {
    expect(slashCompletions("/Q")).toEqual([]);
    expect(slashCompletions("help")).toEqual([]);
    expect(slashCompletions("")).toEqual([]);
  });

  it("`/x` (no match) returns []", () => {
    expect(slashCompletions("/x")).toEqual([]);
  });

  it("property: every known command completes itself, and every completion starts with the query", () => {
    for (const command of KNOWN_SLASH_COMMANDS) {
      const self = slashCompletions(command).map((c) => c.command);
      expect(self).toContain(command);
    }
    const queries = ["", "/", "/c", "/co", "/con", "/s", "/m", "/x", "help", "/Q"];
    for (const query of queries) {
      for (const completion of slashCompletions(query)) {
        expect(completion.command.startsWith(query)).toBe(true);
      }
    }
  });
});

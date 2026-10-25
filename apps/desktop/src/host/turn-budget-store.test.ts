/**
 * TASK.4721: the desktop's turn-budget history store. Hosts are separate
 * processes, so the file is a JSONL append log: these tests pin the tolerant
 * reader, the per-role window, the size cap rewrite, and the port wiring
 * (learned = formula over the file, record = append) with a real tmp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TURN_BUDGET_HISTORY_KEEP_PER_ROLE,
  TURN_BUDGET_HISTORY_MAX_BYTES,
  appendTurnBudgetRecord,
  createSubagentBudgetPort,
  defaultTurnBudgetHistoryPath,
  readTurnBudgetHistory,
  recordAcceptedChildBudget,
  stampLearnedMaxTurns,
} from "./turn-budget-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "turn-budget-"));
  file = join(dir, "nested", "turn-budget-history.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaultTurnBudgetHistoryPath", () => {
  it("lives next to settings.json under <home>/.anycode", () => {
    expect(defaultTurnBudgetHistoryPath("/home/u")).toBe("/home/u/.anycode/turn-budget-history.jsonl");
  });
});

describe("appendTurnBudgetRecord + readTurnBudgetHistory", () => {
  it("round-trips records in order, creating the directory on first write", () => {
    appendTurnBudgetRecord(file, { role: "explore", model: "m1", turns: 7 }, 1);
    appendTurnBudgetRecord(file, { role: "general-purpose", turns: 12 }, 2);
    expect(readTurnBudgetHistory(file)).toEqual([
      { role: "explore", model: "m1", turns: 7 },
      { role: "general-purpose", turns: 12 },
    ]);
  });

  it("writes one small JSON line per record with v:1 and a timestamp", async () => {
    appendTurnBudgetRecord(file, { role: "explore", turns: 3 }, 42);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ v: 1, role: "explore", turns: 3, at: 42 });
  });

  it("returns an empty history when the file does not exist", () => {
    expect(readTurnBudgetHistory(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("readTurnBudgetHistory tolerance", () => {
  it("skips malformed, foreign-version and invalid-shape lines", async () => {
    await writeFile(
      file.replace("nested/", ""),
      [
        '{"v":1,"role":"explore","turns":5,"at":1}',
        "not json at all",
        '{"v":2,"role":"explore","turns":9,"at":2}',
        '{"v":1,"role":"","turns":9,"at":3}',
        '{"v":1,"role":"explore","turns":-4,"at":4}',
        '{"v":1,"role":"explore","turns":2.5,"at":5}',
        '{"v":1,"role":"explore","turns":11,"model":7,"at":6}',
        '{"v":1,"role":"explore","turns":6,"at":7}',
        "",
      ].join("\n"),
    );
    expect(readTurnBudgetHistory(file.replace("nested/", ""))).toEqual([
      { role: "explore", turns: 5 },
      { role: "explore", turns: 6 },
    ]);
  });

  it("keeps only the last TURN_BUDGET_HISTORY_KEEP_PER_ROLE records per role", () => {
    for (let i = 1; i <= TURN_BUDGET_HISTORY_KEEP_PER_ROLE + 5; i += 1) {
      appendTurnBudgetRecord(file, { role: "explore", turns: i }, i);
    }
    appendTurnBudgetRecord(file, { role: "other", turns: 99 }, 0);
    const history = readTurnBudgetHistory(file);
    const explore = history.filter((r) => r.role === "explore");
    expect(explore).toHaveLength(TURN_BUDGET_HISTORY_KEEP_PER_ROLE);
    expect(explore[0]?.turns).toBe(6);
    expect(explore[explore.length - 1]?.turns).toBe(TURN_BUDGET_HISTORY_KEEP_PER_ROLE + 5);
    expect(history.filter((r) => r.role === "other")).toEqual([{ role: "other", turns: 99 }]);
  });
});

describe("appendTurnBudgetRecord size cap", () => {
  it("rewrites the tail once the file passes the cap, keeping the newest lines", async () => {
    const pad = "x".repeat(900);
    const total = Math.ceil(TURN_BUDGET_HISTORY_MAX_BYTES / 500) + 50;
    for (let i = 1; i <= total; i += 1) {
      appendTurnBudgetRecord(file, { role: `r${i}`, model: pad, turns: 1 }, i);
    }
    const size = (await stat(file)).size;
    expect(size).toBeLessThanOrEqual(TURN_BUDGET_HISTORY_MAX_BYTES);
    const history = readTurnBudgetHistory(file);
    // The newest record always survives the rewrite.
    expect(history[history.length - 1]?.role).toBe(`r${total}`);
  });

  it("never throws when the rewrite cannot happen (fail-soft)", () => {
    expect(() => appendTurnBudgetRecord(join(dir, "nope", "\0bad", "h.jsonl"), { role: "r", turns: 1 }, 1)).not.toThrow();
  });
});

describe("createSubagentBudgetPort", () => {
  it("learned() is undefined until the pool holds enough accepted runs, then the formula", () => {
    const port = createSubagentBudgetPort(file);
    expect(port.learned({ role: "explore" })).toBeUndefined();
    for (let i = 0; i < 5; i += 1) {
      port.record({ role: "explore", turns: 40 });
    }
    // p90 40 * 1.25 = 50
    expect(port.learned({ role: "explore" })).toBe(50);
  });

  it("record() appends only what it is given and never throws on a bad path", () => {
    const port = createSubagentBudgetPort(join(dir, "\0bad", "h.jsonl"));
    expect(() => port.record({ role: "explore", turns: 3 })).not.toThrow();
    expect(port.learned({ role: "explore" })).toBeUndefined();
  });
});

describe("session-tier budget wiring (TASK.4721)", () => {
  /** A learned port with a fixed value and a record spy (session tier has no store file here). */
  function fakePort(learned: number | undefined) {
    const records: Array<{ role: string; model?: string; turns: number }> = [];
    const keys: Array<{ role: string; model?: string }> = [];
    return {
      records,
      keys,
      port: {
        learned: (key: { role: string; model?: string }) => {
          keys.push(key);
          return learned;
        },
        record: (entry: { role: string; model?: string; turns: number }) => {
          records.push(entry);
        },
      },
    };
  }

  const base = { agentType: "explore", description: "d", prompt: "p" };

  it("stamps the learned budget only when adaptive is on and no explicit bound exists", () => {
    const { port, keys } = fakePort(48);
    const req: { agentType: string; description: string; prompt: string; model?: string; maxTurns?: number } = {
      ...base,
      model: "m-x",
    };
    const stamped = stampLearnedMaxTurns(req, { adaptive: true, settingsBudgetSet: false, port });
    expect(stamped.maxTurns).toBe(48);
    expect(keys).toEqual([{ role: "explore", model: "m-x" }]);
  });

  it("adaptive OFF: the request is returned as the SAME object and the port is never asked", () => {
    const { port, keys } = fakePort(48);
    const req = { ...base };
    expect(stampLearnedMaxTurns(req, { adaptive: false, settingsBudgetSet: false, port })).toBe(req);
    expect(keys).toHaveLength(0);
  });

  it("an explicit request maxTurns, an explicit setting, or an engine child is never overridden", () => {
    const { port } = fakePort(48);
    const explicit = { ...base, maxTurns: 9 };
    expect(stampLearnedMaxTurns(explicit, { adaptive: true, settingsBudgetSet: false, port })).toBe(explicit);
    const settingsBound = { ...base };
    expect(stampLearnedMaxTurns(settingsBound, { adaptive: true, settingsBudgetSet: true, port })).toBe(settingsBound);
    const engine = { ...base, engine: "codex" };
    expect(stampLearnedMaxTurns(engine, { adaptive: true, settingsBudgetSet: false, port })).toBe(engine);
  });

  it("no learned value => the request is unchanged", () => {
    const { port } = fakePort(undefined);
    const req = { ...base };
    expect(stampLearnedMaxTurns(req, { adaptive: true, settingsBudgetSet: false, port })).toBe(req);
  });

  it("records an accepted child (completed) and never a cut-off or a failed one", () => {
    const { port, records } = fakePort(undefined);
    recordAcceptedChildBudget(port, { status: "completed", turns: 6 }, { ...base, model: "m1" });
    recordAcceptedChildBudget(port, { status: "max_turns", turns: 30 }, base);
    recordAcceptedChildBudget(port, { status: "max_turns", turns: 30, declaredDoneAtCeiling: true }, base);
    recordAcceptedChildBudget(port, { status: "error", turns: 2 }, base);
    recordAcceptedChildBudget(port, { status: "cancelled", turns: 2 }, base);
    recordAcceptedChildBudget(port, { status: "completed", turns: 6 }, { ...base, engine: "claude" });
    expect(records).toEqual([
      { role: "explore", model: "m1", turns: 6 },
      { role: "explore", turns: 30 },
    ]);
  });

  it("adaptive OFF (no port): recording is a no-op", () => {
    expect(() => recordAcceptedChildBudget(undefined, { status: "completed", turns: 3 }, base)).not.toThrow();
  });
});

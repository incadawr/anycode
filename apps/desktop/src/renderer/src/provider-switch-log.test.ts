import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConnectionSwitches, saveConnectionSwitch, type ConnectionSwitchRecord } from "./provider-switch-log.js";

afterEach(() => vi.unstubAllGlobals());

function stubStorage(options: { deny?: boolean } = {}) {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => {
        if (options.deny) throw new Error("denied");
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.deny) throw new Error("denied");
        values.set(key, value);
      },
    },
  });
  return values;
}

function record(overrides: Partial<ConnectionSwitchRecord> = {}): ConnectionSwitchRecord {
  return {
    id: "switch-1",
    fromLabel: "A",
    toLabel: "B",
    model: "m1",
    afterItemId: "h1",
    ...overrides,
  };
}

describe("provider-switch local log", () => {
  it("round-trips a record under its session id and isolates sessions", () => {
    const values = stubStorage();
    saveConnectionSwitch("session-a", record());

    expect(loadConnectionSwitches("session-a")).toEqual([record()]);
    expect(loadConnectionSwitches("session-b")).toEqual([]);
    expect([...values.keys()]).toEqual(["anycode.provider-switches.v1:session-a"]);
  });

  it("saves chronologically and retains older records (no count cap)", () => {
    stubStorage();
    const records = Array.from({ length: 25 }, (_, index) => record({ id: `switch-${index}` }));
    for (const item of records) {
      saveConnectionSwitch("session-a", item);
    }
    expect(loadConnectionSwitches("session-a")).toEqual(records);
  });

  it("dedupes by id", () => {
    stubStorage();
    saveConnectionSwitch("session-a", record());
    saveConnectionSwitch("session-a", record());
    expect(loadConnectionSwitches("session-a")).toEqual([record()]);
  });

  it("drops corrupt and invalid records, fails soft on non-array JSON", () => {
    const values = stubStorage();
    values.set(
      "anycode.provider-switches.v1:session-a",
      JSON.stringify([
        record(),
        { id: 7, fromLabel: "A", toLabel: "B", model: "m", afterItemId: null },
        "garbage",
        null,
        record({ id: "switch-2", effortResetTo: "high", afterItemId: null }),
      ]),
    );
    expect(loadConnectionSwitches("session-a")).toEqual([record(), record({ id: "switch-2", effortResetTo: "high", afterItemId: null })]);

    values.set("anycode.provider-switches.v1:session-b", JSON.stringify({ nope: true }));
    expect(loadConnectionSwitches("session-b")).toEqual([]);
    values.set("anycode.provider-switches.v1:session-c", "not json{{{");
    expect(loadConnectionSwitches("session-c")).toEqual([]);
  });

  it("returns [] with no window at all", () => {
    expect(loadConnectionSwitches("session-a")).toEqual([]);
    // A write must not throw either.
    expect(() => saveConnectionSwitch("session-a", record())).not.toThrow();
  });

  it("fails soft on denied storage (no read or write throw)", () => {
    stubStorage({ deny: true });
    expect(loadConnectionSwitches("session-a")).toEqual([]);
    expect(() => saveConnectionSwitch("session-a", record())).not.toThrow();
  });
});

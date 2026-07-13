import { describe, expect, it, vi } from "vitest";
import { SIGKILL_GRACE_MS } from "@anycode/core";
import { createEngineProcessReaper } from "./engine-reaper.js";

describe("createEngineProcessReaper", () => {
  it("signals one POSIX group once and escalates after the shared grace", () => {
    const kill = vi.fn();
    let scheduled: (() => void) | undefined;
    const reaper = createEngineProcessReaper({
      platform: "darwin",
      kill,
      schedule: (fn, delay) => {
        expect(delay).toBe(SIGKILL_GRACE_MS);
        scheduled = fn;
      },
    });
    const registration = { hostPid: 10, generation: 2, enginePid: 20, pgid: 20 };

    reaper(registration);
    reaper(registration);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-20, "SIGTERM");
    scheduled?.();
    expect(kill).toHaveBeenLastCalledWith(-20, "SIGKILL");
  });

  it("makes no Windows tree-cleanup claim", () => {
    const kill = vi.fn();
    const reaper = createEngineProcessReaper({ platform: "win32", kill });
    reaper({ hostPid: 10, generation: 1, enginePid: 20, pgid: 20 });
    expect(kill).not.toHaveBeenCalled();
  });
});

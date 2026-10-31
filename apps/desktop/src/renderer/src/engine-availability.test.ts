import { describe, expect, it, vi } from "vitest";
import { watchExternalEngines } from "./engine-availability.js";
import { useTabsStore } from "./tabs-store.js";
import type { EngineId } from "../../shared/engines.js";

function deferred() {
  let resolve!: (value: { engineIds: EngineId[] }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ engineIds: EngineId[] }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("first-run engine readiness", () => {
  it("advances after sign-in and ignores an older in-flight startup verdict", async () => {
    const startup = deferred();
    const login = deferred();
    let changed!: () => void;
    const unsubscribe = vi.fn();
    const bridge = {
      listAvailableEngines: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(login.promise),
      onEnginesChanged: (callback: () => void) => { changed = callback; return unsubscribe; },
    };
    const apply = vi.fn();
    const stop = watchExternalEngines(bridge, apply);
    changed();
    login.resolve({ engineIds: ["claude"] });
    await Promise.resolve();
    startup.resolve({ engineIds: ["core"] });
    await Promise.resolve();
    expect(apply.mock.calls).toEqual([[true, ["claude"]]]);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("handles failed discovery and stops applying results after unmount", async () => {
    const first = deferred();
    const second = deferred();
    let changed!: () => void;
    const apply = vi.fn();
    const stop = watchExternalEngines({
      listAvailableEngines: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      onEnginesChanged: (callback) => { changed = callback; return () => {}; },
    }, apply);
    first.reject(new Error("IPC unavailable"));
    await Promise.resolve();
    expect(apply.mock.calls).toEqual([[false, []]]);
    changed();
    stop();
    second.resolve({ engineIds: ["codex"] });
    await Promise.resolve();
    expect(apply.mock.calls).toEqual([[false, []]]);
  });

  it("publishes every confirmed verdict to the shell store, so a pane that subscribed once stays current", async () => {
    const startup = deferred();
    const login = deferred();
    let changed!: () => void;
    useTabsStore.setState({ availableEngines: ["core"] });
    const stop = watchExternalEngines({
      listAvailableEngines: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(login.promise),
      onEnginesChanged: (callback) => { changed = callback; return () => {}; },
    }, () => {});
    // Signing in after the dialog/editor is already open is the case that used
    // to leave a ready engine reading "not connected".
    changed();
    login.resolve({ engineIds: ["core", "claude"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(useTabsStore.getState().availableEngines).toEqual(["core", "claude"]);
    startup.resolve({ engineIds: ["core"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(useTabsStore.getState().availableEngines).toEqual(["core", "claude"]);
    stop();
    useTabsStore.setState({ availableEngines: ["core"] });
  });
});

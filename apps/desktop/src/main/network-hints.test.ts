/**
 * attachNetworkHintForwarders (Taskana 4772): fake net/powerMonitor emitters
 * and a post spy; no Electron, no timers.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachNetworkHintForwarders } from "./network-hints.js";

describe("attachNetworkHintForwarders (Taskana 4772)", () => {
  function setup() {
    const net = new EventEmitter();
    const powerMonitor = new EventEmitter();
    const postAll = vi.fn();
    const detach = attachNetworkHintForwarders({
      net: net as unknown as Parameters<typeof attachNetworkHintForwarders>[0]["net"],
      powerMonitor: powerMonitor as unknown as Parameters<typeof attachNetworkHintForwarders>[0]["powerMonitor"],
      postAll,
    });
    return { net, powerMonitor, postAll, detach };
  }

  it("online, resume and unlock-screen each post exactly one network hint", () => {
    const { net, powerMonitor, postAll } = setup();

    net.emit("online");
    expect(postAll).toHaveBeenCalledTimes(1);
    expect(postAll).toHaveBeenLastCalledWith({ type: "anycode:network-hint" });

    powerMonitor.emit("resume");
    expect(postAll).toHaveBeenCalledTimes(2);

    powerMonitor.emit("unlock-screen");
    expect(postAll).toHaveBeenCalledTimes(3);
    expect(postAll.mock.calls.every(([message]) => message.type === "anycode:network-hint")).toBe(true);
  });

  it("detach stops posting and leaves no listeners behind", () => {
    const { net, powerMonitor, postAll, detach } = setup();

    detach();
    net.emit("online");
    powerMonitor.emit("resume");
    powerMonitor.emit("unlock-screen");

    expect(postAll).not.toHaveBeenCalled();
    expect(net.listenerCount("online")).toBe(0);
    expect(powerMonitor.listenerCount("resume")).toBe(0);
    expect(powerMonitor.listenerCount("unlock-screen")).toBe(0);
  });

  it("the listeners are persistent: they keep firing after the first hint", () => {
    const { net, postAll } = setup();
    net.emit("online");
    net.emit("online");
    expect(postAll).toHaveBeenCalledTimes(2);
  });
});

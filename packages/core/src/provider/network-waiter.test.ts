/**
 * tcpReachable (Taskana 4772): every path is driven through the injected
 * connector and fake timers, so no socket is ever opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbeOnlyNetworkWaiter, tcpReachable, tcpTargetOf } from "./network-waiter.js";

describe("tcpTargetOf", () => {
  it("derives host and port from the origin, defaulting by scheme", () => {
    expect(tcpTargetOf("https://api.example.com/v1/messages")).toEqual({ host: "api.example.com", port: 443 });
    expect(tcpTargetOf("http://localhost:8080/v1")).toEqual({ host: "localhost", port: 8080 });
    expect(tcpTargetOf("http://example.com")).toEqual({ host: "example.com", port: 80 });
    expect(tcpTargetOf("http://[::1]:9000/")).toEqual({ host: "::1", port: 9000 });
  });

  it("rejects garbage and non-http schemes", () => {
    expect(tcpTargetOf("not a url")).toBeUndefined();
    expect(tcpTargetOf("ftp://example.com")).toBeUndefined();
  });
});

describe("tcpReachable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true on connect and destroys the socket", async () => {
    const destroy = vi.fn();
    const connect = vi.fn((_host: string, _port: number, done: (ok: boolean) => void) => {
      queueMicrotask(() => done(true));
      return { destroy };
    });
    await expect(tcpReachable("https://api.example.com", 3_000, { connect })).resolves.toBe(true);
    expect(connect).toHaveBeenCalledWith("api.example.com", 443, expect.any(Function));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("resolves false on a connection error", async () => {
    const connect = (_h: string, _p: number, done: (ok: boolean) => void) => {
      queueMicrotask(() => done(false));
      return undefined;
    };
    await expect(tcpReachable("https://api.example.com", 3_000, { connect })).resolves.toBe(false);
  });

  it("resolves false when the connect never answers (timeout)", async () => {
    const connect = () => ({ destroy: vi.fn() });
    const pending = tcpReachable("https://api.example.com", 3_000, { connect });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe(false);
  });

  it("resolves false at once when the signal is already aborted", async () => {
    const connect = vi.fn(() => ({ destroy: vi.fn() }));
    const controller = new AbortController();
    controller.abort();
    await expect(tcpReachable("https://api.example.com", 3_000, { connect, signal: controller.signal })).resolves.toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("resolves false when aborted while connecting", async () => {
    const connect = () => ({ destroy: vi.fn() });
    const controller = new AbortController();
    const pending = tcpReachable("https://api.example.com", 3_000, { connect, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });

  it("resolves false for an unusable URL without connecting", async () => {
    const connect = vi.fn(() => ({ destroy: vi.fn() }));
    await expect(tcpReachable("::::", 3_000, { connect })).resolves.toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("the probe-only waiter exposes a monotonic clock and no hints", () => {
    const waiter = createProbeOnlyNetworkWaiter();
    expect(typeof waiter.probe).toBe("function");
    expect(waiter.onHint).toBeUndefined();
    const a = waiter.monotonicNow();
    expect(waiter.monotonicNow()).toBeGreaterThanOrEqual(a);
  });
});

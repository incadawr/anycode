/**
 * tcpReachable (Taskana 4772): every path is driven through the injected
 * connector and fake timers, so no socket is ever opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbeOnlyNetworkWaiter, probeTargetOf, tcpReachable, tcpTargetOf } from "./network-waiter.js";

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

// Taskana 4772 review F1: the probe must measure the hop model traffic
// actually takes. With Node's env-proxy path enabled and a scheme proxy
// configured (the desktop's applyConnectionProxy writes exactly this env),
// undici routes every request through the proxy — so the probe connects to
// the PROXY, not the origin. NO_PROXY entries bypass it, and the flag off
// (or no proxy set) keeps the origin probe unchanged.
describe("probeTargetOf (proxy-aware probe target)", () => {
  it("targets the proxy host:port when NODE_USE_ENV_PROXY=1 and HTTPS_PROXY is set", () => {
    expect(
      probeTargetOf("https://api.example.com/v1", {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.corp.internal:3128",
      }),
    ).toEqual({ host: "proxy.corp.internal", port: 3128 });
  });

  it("honors a lowercase scheme proxy and the proxy port's scheme default", () => {
    expect(
      probeTargetOf("https://api.example.com", {
        NODE_USE_ENV_PROXY: "1",
        https_proxy: "https://proxy.internal",
      }),
    ).toEqual({ host: "proxy.internal", port: 443 });
  });

  it("keeps the origin when NO_PROXY covers the target (exact host)", () => {
    expect(
      probeTargetOf("https://api.example.com", {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.corp.internal:3128",
        NO_PROXY: "api.example.com",
      }),
    ).toEqual({ host: "api.example.com", port: 443 });
  });

  it("keeps the origin when NO_PROXY covers the target (domain suffix)", () => {
    expect(
      probeTargetOf("https://api.example.com", {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.corp.internal:3128",
        no_proxy: ".example.com",
      }),
    ).toEqual({ host: "api.example.com", port: 443 });
  });

  it("keeps the origin when the env-proxy path is off or no proxy is configured", () => {
    expect(probeTargetOf("https://api.example.com", { HTTPS_PROXY: "http://proxy:3128" })).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(
      probeTargetOf("https://api.example.com", { NODE_USE_ENV_PROXY: "1" }),
    ).toEqual({ host: "api.example.com", port: 443 });
  });

  it("returns undefined for a non-http(s) target regardless of proxy config", () => {
    expect(
      probeTargetOf("ftp://example.com", { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128" }),
    ).toBeUndefined();
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

  // Taskana 4772 review F1: on a proxied connection the probe must go through
  // the proxy — otherwise a firewalled origin with a healthy proxy answers
  // "online" while every model request is offline.
  it("tcpReachable connects to the configured proxy, not the origin (NODE_USE_ENV_PROXY=1)", async () => {
    const destroy = vi.fn();
    const connect = vi.fn((_host: string, _port: number, done: (ok: boolean) => void) => {
      queueMicrotask(() => done(true));
      return { destroy };
    });
    // The machine's own shell may export a proxy; pass an explicit env so the
    // assertion reads the test's proxy, not the developer's.
    await expect(
      tcpReachable("https://api.example.com", 3_000, {
        connect,
        env: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.corp.internal:3128" },
      }),
    ).resolves.toBe(true);
    expect(connect).toHaveBeenCalledWith("proxy.corp.internal", 3128, expect.any(Function));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("tcpReachable keeps the origin probe when the env explicitly has no proxy", async () => {
    const connect = vi.fn((_host: string, _port: number, done: (ok: boolean) => void) => {
      queueMicrotask(() => done(true));
      return { destroy: vi.fn() };
    });
    await expect(
      tcpReachable("https://api.example.com", 3_000, {
        connect,
        env: { NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "http://proxy.corp.internal:3128" },
      }),
    ).resolves.toBe(true);
    expect(connect).toHaveBeenCalledWith("api.example.com", 443, expect.any(Function));
  });
});

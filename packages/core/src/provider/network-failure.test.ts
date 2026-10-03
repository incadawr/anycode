import { describe, expect, it, vi, afterEach } from "vitest";
import { classifyNetworkConfigurationFailure, contextualizeNetworkFailure } from "./network-failure.js";
import { isRetryableStreamError } from "./retry.js";
import { classifyProviderFailure } from "./failure.js";
afterEach(() => vi.unstubAllEnvs());
describe("proxy/TLS failure without credential exposure", () => {
  it("stops retries only when the refused socket is the configured proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "http://user:secret-poison@127.0.0.1:9911");
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9911"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 9911 }) });
    expect(isRetryableStreamError(error)).toBe(false);
    expect(classifyProviderFailure(error).code).toBe("proxy_unreachable");
    expect(JSON.stringify(classifyProviderFailure(error))).not.toContain("secret-poison");
    const direct = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 9912 }) });
    expect(isRetryableStreamError(direct)).toBe(true);
  });
  it.each([
    [new TypeError("fetch failed", { cause: new Error("Proxy response (407) !== 200 when HTTP Tunneling secret-poison") }), "proxy_auth"],
    [Object.assign(new Error("secret-poison"), { statusCode: 407, isRetryable: true }), "proxy_auth"],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("secret-poison"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) }), "tls"],
  ])("recognizes measured configuration errors before generic fetch/retry", (error, code) => {
    expect(classifyNetworkConfigurationFailure(error)).toBe(code);
    expect(isRetryableStreamError(error)).toBe(false);
    expect(classifyProviderFailure(error).retryable).toBe(false);
    expect(JSON.stringify(classifyProviderFailure(error))).not.toContain("secret-poison");
  });
  it("bounds cyclic and aggregate cause chains", () => {
    const error: { cause?: unknown } = {}; error.cause = error;
    expect(classifyNetworkConfigurationFailure(error)).toBeUndefined();
    expect(classifyNetworkConfigurationFailure(new AggregateError([Object.assign(new Error(), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })]))).toBe("tls");
  });
});


it("names a DNS proxy whose refused socket has only a resolved IP, and respects NO_PROXY", () => {
  vi.stubEnv("NODE_USE_ENV_PROXY", "1");
  vi.stubEnv("HTTPS_PROXY", "http://user:secret-poison@proxy.invalid:9911");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("NO_PROXY", "localhost,.internal.invalid:443");
  vi.stubEnv("no_proxy", "localhost,.internal.invalid:443");
  // Empty lowercase vars are removed here so Node's uppercase proxy applies.
  delete process.env.https_proxy;
  const error = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.5:9911"), { code: "ECONNREFUSED", address: "192.0.2.5", port: 9911 }) });
  const contextual = contextualizeNetworkFailure(error, "https://api.invalid");
  expect(classifyProviderFailure(contextual).code).toBe("proxy_unreachable");
  expect(isRetryableStreamError(contextual)).toBe(false);
  expect(JSON.stringify(classifyProviderFailure(contextual))).not.toContain("secret-poison");
  expect(contextualizeNetworkFailure(error, "https://api.internal.invalid")).toBe(error);
  expect(contextualizeNetworkFailure(error, "https://localhost")).toBe(error);
  expect(contextualizeNetworkFailure(error, "https://api.internal.invalid:444")).not.toBe(error);
  vi.stubEnv("NO_PROXY", "*"); vi.stubEnv("no_proxy", "*");
  expect(contextualizeNetworkFailure(error, "https://api.invalid")).toBe(error);
});

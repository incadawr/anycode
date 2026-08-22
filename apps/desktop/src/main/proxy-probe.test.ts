/**
 * Unit tests for the proxy spawn-probe (TASK.141 §6).
 *
 * The classifier is exercised over the `MEASURED_*` fixtures — the error shapes
 * LIVE-MEASURED on 2026-08-22 against local stub proxies on this repo's runtime
 * (Electron 43.0.0 / node 24.17.0 / undici 7.28.0), not invented ones. That is
 * the whole point of the fixtures: a classifier tested against strings someone
 * imagined is a green gate resting on behaviour nobody observed, which is the
 * defect class this track has already shipped twice.
 *
 * The spawn itself is exercised through an injected spawner, so no test starts a
 * process or touches a network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MEASURED_OK_401,
  MEASURED_PROXY_407,
  MEASURED_PROXY_DEAD,
  MEASURED_PROXY_RESET,
  MEASURED_TARGET_DNS,
  MEASURED_TIMEOUT,
  MEASURED_TLS_CORPORATE_CA,
  MEASURED_TLS_SELF_SIGNED,
  PROXY_PROBE_KILL_GRACE_MS,
  PROXY_PROBE_MARKER,
  PROXY_PROBE_SCRIPT,
  PROXY_PROBE_TIMEOUT_MS,
  classifyProbeOutput,
  describeClassification,
  maskProxyCredentials,
  probeVerdict,
  readProbePayload,
  runProxyProbe,
  type ProxyProbeRawOutput,
  type ProxyProbeSpawnRequest,
  type ProxyProbeSpawner,
} from "./proxy-probe.js";

/** Renders a child payload the way the real child writes it. */
function stdoutFor(payload: unknown, noise = ""): string {
  return `${noise}${PROXY_PROBE_MARKER}${JSON.stringify(payload)}\n`;
}

function raw(payload: unknown, overrides: Partial<ProxyProbeRawOutput> = {}): ProxyProbeRawOutput {
  return { exitCode: 0, stdout: stdoutFor(payload), stderr: "", ...overrides };
}

describe("readProbePayload", () => {
  it("finds the result line among runtime noise on stdout", () => {
    expect(readProbePayload(stdoutFor(MEASURED_OK_401, "some electron warning\n"))).toEqual({ ok: true, status: 401 });
  });

  it("returns undefined when the child printed nothing recognisable", () => {
    expect(readProbePayload("")).toBeUndefined();
    expect(readProbePayload("no marker here")).toBeUndefined();
    expect(readProbePayload(`${PROXY_PROBE_MARKER}{not json`)).toBeUndefined();
  });
});

describe("classifyProbeOutput over the measured shapes", () => {
  it("classifies a target answer as an http response", () => {
    expect(classifyProbeOutput(raw(MEASURED_OK_401))).toEqual({ kind: "http_response", status: 401 });
  });

  it("classifies a dead proxy as a refused connection", () => {
    expect(classifyProbeOutput(raw(MEASURED_PROXY_DEAD))).toEqual({
      kind: "connect_refused",
      message: "connect ECONNREFUSED 127.0.0.1:9",
    });
  });

  it("reads the 407 out of undici's tunnel-abort sentence, three causes deep", () => {
    expect(classifyProbeOutput(raw(MEASURED_PROXY_407))).toEqual({ kind: "proxy_auth", status: 407 });
  });

  it("classifies a self-signed MITM certificate as TLS", () => {
    expect(classifyProbeOutput(raw(MEASURED_TLS_SELF_SIGNED))).toEqual({
      kind: "tls",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      message: MEASURED_TLS_SELF_SIGNED.chain[1].message,
    });
  });

  it("classifies a corporate MITM CA as TLS too — the code differs, the family does not", () => {
    expect(classifyProbeOutput(raw(MEASURED_TLS_CORPORATE_CA))).toEqual({
      kind: "tls",
      code: "SELF_SIGNED_CERT_IN_CHAIN",
      message: "self signed certificate in certificate chain",
    });
  });

  it("classifies a proxy that destroyed the socket as a reset", () => {
    expect(classifyProbeOutput(raw(MEASURED_PROXY_RESET))).toEqual({ kind: "connect_reset", message: "read ECONNRESET" });
  });

  it("classifies a name that does not resolve as DNS", () => {
    expect(classifyProbeOutput(raw(MEASURED_TARGET_DNS))).toEqual({
      kind: "dns",
      message: "getaddrinfo ENOTFOUND target.invalid",
    });
  });

  it("classifies the abort as a timeout even though its top-level error has no fetch-failed wrapper", () => {
    expect(classifyProbeOutput(raw(MEASURED_TIMEOUT))).toEqual({ kind: "timeout" });
  });
});

describe("classifyProbeOutput edge cases", () => {
  it("treats a non-407 tunnel refusal as its own class", () => {
    const payload = {
      ok: false,
      chain: [{ name: "AbortError", message: "Proxy response (502) !== 200 when HTTP Tunneling", code: "UND_ERR_ABORTED" }],
    };
    expect(classifyProbeOutput(raw(payload))).toEqual({ kind: "proxy_tunnel_rejected", status: 502 });
  });

  it("treats a bare 407 status as proxy auth, never as a target answer", () => {
    expect(classifyProbeOutput(raw({ ok: true, status: 407 }))).toEqual({ kind: "proxy_auth", status: 407 });
  });

  it("classifies a socket hang up as a reset", () => {
    expect(classifyProbeOutput(raw({ ok: false, chain: [{ name: "Error", message: "socket hang up" }] }))).toEqual({
      kind: "connect_reset",
      message: "socket hang up",
    });
  });

  it("says it does not know rather than inventing a cause when the child printed nothing", () => {
    expect(classifyProbeOutput({ exitCode: 1, stdout: "", stderr: "boom" })).toEqual({ kind: "unknown", message: "boom" });
    expect(classifyProbeOutput({ exitCode: null, stdout: "", stderr: "" })).toEqual({
      kind: "unknown",
      message: "probe produced no result (exit null)",
    });
  });
});

describe("probeVerdict", () => {
  it("reports any target answer as ok — a 401 proves the round trip completed", () => {
    expect(probeVerdict({ kind: "http_response", status: 401 }, { proxyUsed: true })).toBe("ok");
  });

  it("reports 407 and TLS the same way whether or not a proxy was assumed", () => {
    expect(probeVerdict({ kind: "proxy_auth", status: 407 }, { proxyUsed: true })).toBe("proxy_auth");
    expect(probeVerdict({ kind: "tls", code: "X", message: "" }, { proxyUsed: false })).toBe("tls");
  });

  it("blames the proxy for a transport failure only when a proxy was in play", () => {
    for (const kind of ["connect_refused", "connect_reset", "dns"] as const) {
      const classification = { kind, message: "m" } as const;
      expect(probeVerdict(classification, { proxyUsed: true })).toBe("proxy_unreachable");
      expect(probeVerdict(classification, { proxyUsed: false })).toBe("target_unreachable");
    }
  });

  it("blames the far end for a timeout in both cases — a dead proxy refuses in milliseconds", () => {
    expect(probeVerdict({ kind: "timeout" }, { proxyUsed: true })).toBe("target_unreachable");
    expect(probeVerdict({ kind: "timeout" }, { proxyUsed: false })).toBe("target_unreachable");
  });

  it("maps a rejected tunnel to an unreachable proxy", () => {
    expect(probeVerdict({ kind: "proxy_tunnel_rejected", status: 502 }, { proxyUsed: true })).toBe("proxy_unreachable");
  });
});

describe("maskProxyCredentials", () => {
  it("masks userinfo embedded anywhere in a text, not just in a parseable URL", () => {
    expect(maskProxyCredentials("connect failed for http://bob:s3cr3t@proxy:3128 (retrying)")).toBe(
      "connect failed for http://bob:***@proxy:3128 (retrying)",
    );
  });

  it("masks a password that appears without its URL around it", () => {
    expect(maskProxyCredentials("Proxy-Authorization rejected for s3cr3t", ["s3cr3t"])).toBe(
      "Proxy-Authorization rejected for ***",
    );
  });

  it("leaves a credential-free text byte-identical", () => {
    expect(maskProxyCredentials("via http://proxy:3128: target answered HTTP 401")).toBe(
      "via http://proxy:3128: target answered HTTP 401",
    );
  });
});

describe("describeClassification", () => {
  it("never lets a password reach the description", () => {
    const text = describeClassification(
      { kind: "unknown", message: "handshake with http://bob:s3cr3t@proxy:3128 failed; token s3cr3t" },
      ["s3cr3t"],
    );
    expect(text).not.toContain("s3cr3t");
    expect(text).toContain("bob:***@proxy:3128");
  });

  it("names the status of a proxy-auth refusal", () => {
    expect(describeClassification({ kind: "proxy_auth", status: 407 })).toContain("407");
  });
});

describe("the child program", () => {
  it("writes exactly one marked line and exits explicitly (a probe child is measured to outlive its own abort)", () => {
    expect(PROXY_PROBE_SCRIPT).toContain(PROXY_PROBE_MARKER);
    expect(PROXY_PROBE_SCRIPT).toContain("process.exit(0)");
    expect(PROXY_PROBE_SCRIPT).toContain("AbortController");
    expect(PROXY_PROBE_SCRIPT).toContain('redirect: "manual"');
  });
});

describe("runProxyProbe", () => {
  function spawnerFor(payload: unknown): { spawn: ProxyProbeSpawner; calls: ProxyProbeSpawnRequest[] } {
    const calls: ProxyProbeSpawnRequest[] = [];
    const spawn: ProxyProbeSpawner = vi.fn(async (request) => {
      calls.push(request);
      return raw(payload);
    });
    return { spawn, calls };
  }

  it("forces ELECTRON_RUN_AS_NODE and passes the target and budget as argv", async () => {
    const { spawn, calls } = spawnerFor(MEASURED_OK_401);
    await runProxyProbe(spawn, {
      targetUrl: "https://api.anthropic.com/",
      env: { PATH: "/usr/bin", HTTPS_PROXY: "http://p:1" },
      execPath: "/electron",
      proxyUsed: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.execPath).toBe("/electron");
    expect(calls[0]?.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(calls[0]?.env.HTTPS_PROXY).toBe("http://p:1");
    expect(calls[0]?.args).toEqual([
      "-e",
      PROXY_PROBE_SCRIPT,
      "https://api.anthropic.com/",
      String(PROXY_PROBE_TIMEOUT_MS),
    ]);
  });

  it("gives the parent's kill a grace over the child's own budget", async () => {
    const { spawn, calls } = spawnerFor(MEASURED_OK_401);
    await runProxyProbe(spawn, {
      targetUrl: "https://t/",
      env: {},
      execPath: "/electron",
      proxyUsed: true,
      timeoutMs: 1000,
    });
    expect(calls[0]?.timeoutMs).toBe(1000 + PROXY_PROBE_KILL_GRACE_MS);
  });

  it("spawns exactly once — zero retries", async () => {
    const { spawn } = spawnerFor(MEASURED_PROXY_DEAD);
    await runProxyProbe(spawn, { targetUrl: "https://t/", env: {}, execPath: "/e", proxyUsed: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("carries the verdict, the description and the classification back together", async () => {
    const { spawn } = spawnerFor(MEASURED_PROXY_407);
    const outcome = await runProxyProbe(spawn, {
      targetUrl: "https://t/",
      env: {},
      execPath: "/e",
      proxyUsed: true,
      secrets: ["s3cr3t"],
    });
    expect(outcome.verdict).toBe("proxy_auth");
    expect(outcome.classification.kind).toBe("proxy_auth");
    expect(outcome.detail).toContain("407");
    expect(outcome.detail).not.toContain("s3cr3t");
  });
});

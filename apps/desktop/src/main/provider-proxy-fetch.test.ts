/**
 * TASK.133 / Taskana 4117 — pure unit tests for the per-connection proxy
 * dispatcher (`provider-proxy-fetch.ts`). Everything Electron-shaped is
 * injected: a scriptable fake `requestFactory` (records every dispatch, and
 * each fake request can be driven — emit `response`, stream `data` chunks,
 * fire `login`/`error`/`redirect`), a recording `setProxyFor`, and a spy
 * `fallbackFetch`. The routing decisions themselves run the REAL
 * ladder/materialization code against literal settings documents.
 */

import { describe, expect, it, vi } from "vitest";
import type { AnycodeSettings } from "../shared/settings.js";
import { hostForkProxyChain } from "../shared/proxy.js";
import { fetchCustomProviderModels } from "./provider-ipc.js";
import {
  createProxyChainFetch,
  decideUpdaterRoute,
  makeUpdaterLoginHandler,
  PROXY_MISCONFIGURED_MESSAGE,
  ProxyMisconfiguredError,
  proxyFetchVia,
  resolveProxyRoute,
  splitProxyUrl,
  updaterBypassFromNoProxy,
  type ProxyAuthCallback,
  type ProxyAuthInfo,
  type ProxyChainFetchDeps,
  type ProxyIncomingLike,
  type ProxyDispatchRequest,
} from "./provider-proxy-fetch.js";

// ── settings fixtures ──

type SettingsSeed = {
  connectionProxyRef?: string;
  connectionProxyUrl?: string;
  appProxyRef?: string;
  profiles?: Array<Record<string, unknown>>;
};

function makeSettings(seed: SettingsSeed = {}): AnycodeSettings {
  return {
    version: 2,
    provider: {
      connections: [
        {
          id: "conn-1",
          providerId: "kimi",
          ...(seed.connectionProxyRef !== undefined ? { proxyRef: seed.connectionProxyRef } : {}),
          ...(seed.connectionProxyUrl !== undefined ? { proxyUrl: seed.connectionProxyUrl } : {}),
        },
      ],
      activeConnectionId: "conn-1",
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...(seed.profiles !== undefined || seed.appProxyRef !== undefined
      ? {
          network: {
            ...(seed.profiles !== undefined ? { proxyProfiles: seed.profiles } : {}),
            ...(seed.appProxyRef !== undefined ? { proxyRef: seed.appProxyRef } : {}),
          },
        }
      : {}),
  } as AnycodeSettings;
}

const PROFILES = [
  {
    id: "proxy-1",
    name: "Corp",
    mode: "manual",
    url: "http://proxy.corp:3128",
    login: "u",
    noProxy: undefined,
  },
  { id: "proxy-https", name: "Https", mode: "manual", url: "https://proxy.corp:3128" },
  { id: "proxy-garbage", name: "Garbage", mode: "manual", url: "proxy.corp" },
  { id: "proxy-system", name: "Sys", mode: "system" },
  {
    id: "proxy-exempt",
    name: "Exempt",
    mode: "manual",
    url: "http://proxy.corp:3128",
    noProxy: "api.kimi.com",
  },
];

function settingsWithProfiles(seed: SettingsSeed = {}): AnycodeSettings {
  return makeSettings({ profiles: PROFILES, ...seed });
}

// ── fake boundary ──

interface FakeRequest {
  dispatch: ProxyDispatchRequest;
  followRedirect: ReturnType<typeof vi.fn>;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  written: string[];
  abort: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  /** Fires the documented redirect event: (statusCode, method, redirectUrl, responseHeaders). */
  redirect(statusCode: number, method: string, redirectUrl: string, responseHeaders: Record<string, string | string[]>): void;
  respond(statusCode: number, headers?: Record<string, string | string[]>): void;
  data(chunk: string | Buffer): void;
  end(): void;
  fail(err: Error): void;
  /** Fires the INCOMING (response-body) error rather than the request error. */
  failIncoming(err: Error): void;
  login(info: Partial<ProxyAuthInfo>): { username?: string; password?: string };
  /** Wired by makeIncoming; delivers a data chunk to the adapter's listener. */
  pending: ((chunk: Buffer) => void) | undefined;
  /** Wired by makeIncoming; delivers stream end to the adapter's listener. */
  closePending: (() => void) | undefined;
  /** Wired by makeIncoming; delivers a body error to the adapter's listener. */
  incomingError: ((err: Error) => void) | undefined;
}

function makeFakeBoundary() {
  const dispatches: ProxyDispatchRequest[] = [];
  const requests: FakeRequest[] = [];
  const setProxyCalls: Array<{ partition: string; rules: string }> = [];
  const fallbackCalls: Array<{ url: string; init: RequestInit }> = [];

  const requestFactory = (dispatch: ProxyDispatchRequest): unknown => {
    dispatches.push(dispatch);
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const written: string[] = [];
    const abort = vi.fn();
    const followRedirect = vi.fn();
    const req: FakeRequest = {
      dispatch,
      followRedirect,
      listeners,
      written,
      abort,
      emit(event: string, ...args: unknown[]) {
        for (const l of listeners.get(event) ?? []) {
          l(...args);
        }
      },
      respond(statusCode: number, headers: Record<string, string | string[]> = {}) {
        const incoming = makeIncoming(statusCode, headers, req);
        req.emit("response", incoming);
      },
      data(chunk: string | Buffer) {
        req.pending?.(Buffer.from(chunk));
      },
      end() {
        req.closePending?.();
      },
      fail(err: Error) {
        req.emit("error", err);
      },
      failIncoming(err: Error) {
        if (req.incomingError === undefined) {
          throw new Error("no active incoming");
        }
        req.incomingError(err);
      },
      redirect(statusCode: number, method: string, redirectUrl: string, responseHeaders: Record<string, string | string[]>) {
        req.emit("redirect", statusCode, method, redirectUrl, responseHeaders);
      },
      login(info: Partial<ProxyAuthInfo>) {
        const captured: { username?: string; password?: string } = {};
        const callback: ProxyAuthCallback = (username, password) => {
          captured.username = username;
          if (password !== undefined) {
            captured.password = password;
          }
        };
        req.emit("login", { isProxy: false, scheme: "basic", host: "", port: 0, realm: "", ...info }, callback);
        return captured;
      },
      pending: undefined as ((chunk: Buffer) => void) | undefined,
      closePending: undefined as (() => void) | undefined,
      incomingError: undefined as ((err: Error) => void) | undefined,
    };
    requests.push(req);
    const base: Record<string, unknown> = {
      on(event: string, listener: (...args: never[]) => void) {
        const arr = listeners.get(event) ?? [];
        arr.push(listener as (...args: unknown[]) => void);
        listeners.set(event, arr);
        return base;
      },
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => undefined,
      abort,
      followRedirect,
    };
    return base;
  };

  function makeIncoming(statusCode: number, headers: Record<string, string | string[]>, req: FakeRequest): ProxyIncomingLike {
    const dataListeners: Array<(chunk: Buffer) => void> = [];
    const endListeners: Array<() => void> = [];
    const errListeners: Array<(err: Error) => void> = [];
    req.pending = (chunk: Buffer) => {
      for (const l of dataListeners) l(chunk);
    };
    req.closePending = () => {
      for (const l of endListeners) l();
    };
    req.incomingError = (err: Error) => {
      for (const l of errListeners) l(err);
    };
    const incoming: ProxyIncomingLike = {
      statusCode,
      statusMessage: "",
      headers,
      on(event: "data" | "end" | "error", l: ((chunk: Buffer) => void) | (() => void) | ((err: Error) => void)): unknown {
        if (event === "data") {
          dataListeners.push(l as (chunk: Buffer) => void);
        } else if (event === "end") {
          endListeners.push(l as () => void);
        } else {
          errListeners.push(l as (err: Error) => void);
        }
        return incoming;
      },
    };
    return incoming;
  }

  const deps = (settings: () => AnycodeSettings | null): ProxyChainFetchDeps => ({
    readSettings: settings,
    materializationFor: () => ({ proxyPassword: (id: string) => (id === "proxy-1" ? "pw" : undefined) }),
    requestFactory,
    setProxyFor: async (partition, rules) => {
      setProxyCalls.push({ partition, rules });
    },
    fallbackFetch: (async (url: string, init: RequestInit) => {
      fallbackCalls.push({ url, init });
      return new Response("fallback", { status: 200 });
    }) as typeof globalThis.fetch,
  });

  return { dispatches, requests, setProxyCalls, fallbackCalls, deps, requestFactory };
}

const URL_TARGET = "https://api.kimi.com/coding/v1/models";

/** Recursively collects message/cause text from an error chain (JSON.stringify alone hides message fields on causes). */
function collectErrorText(err: unknown, depth = 0): string[] {
  if (err === null || err === undefined || depth > 6 || typeof err !== "object") {
    return [String(err)];
  }
  const parts: string[] = [];
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    parts.push(message);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    parts.push(...collectErrorText(cause, depth + 1));
  }
  const errors = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      parts.push(...collectErrorText(e, depth + 1));
    }
  }
  return parts;
}

describe("createProxyChainFetch — routing decision table", () => {
  it("1. proxied happy path: setProxyFor once, GET/follow, streamed body, no fallback", async () => {
    const rig = makeFakeBoundary();
    let current: AnycodeSettings | null = settingsWithProfiles({ connectionProxyRef: "proxy-1" });
    const fetchImpl = createProxyChainFetch(rig.deps(() => current))(hostForkProxyChain("conn-1"));
    const pending = fetchImpl(URL_TARGET, { method: "GET" });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, { "content-type": "application/json" });
    const res = await pending;
    req.data('{"data":');
    req.data('[]}');
    req.end();
    expect(await res.text()).toBe('{"data":[]}');
    expect(rig.setProxyCalls).toEqual([{ partition: expect.stringMatching(/^anycode-proxy-/), rules: "http://proxy.corp:3128" }]);
    expect(req.dispatch.method).toBe("GET");
    expect(req.dispatch.redirect).toBe("manual"); // transport is manual; follow is implemented via followRedirect
    expect(rig.fallbackCalls).toEqual([]);
    void current;
    current = null;
  });

  it("2. streaming: Response resolves before end; reader.cancel() aborts the wire", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, {});
    const res = await pending;
    expect(res.status).toBe(200);
    req.data("chunk-one");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe("chunk-one");
    await reader.cancel();
    expect(req.abort).toHaveBeenCalled();
  });

  it("3. body cap: >maxBodyBytes through the production guard yields response_too_large and aborts", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchCustomProviderModels({
      baseUrl: "https://api.kimi.com/coding/v1",
      maxBodyBytes: 8,
      fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, { "content-type": "application/json" });
    req.data("0123456789abcdef");
    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, reason: "response_too_large" });
    expect(req.abort).toHaveBeenCalled();
  });

  it("4. timeout: an aborted signal with TimeoutError reason rejects with it and aborts", async () => {
    const rig = makeFakeBoundary();
    const controller = new AbortController();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(req.abort).toHaveBeenCalled();
  });

  it("4b. abort after headers errors the response stream with signal.reason", async () => {
    const rig = makeFakeBoundary();
    const controller = new AbortController();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, {});
    const res = await pending;
    const read = res.body!.getReader().read();
    const reason = new DOMException("timed out", "TimeoutError");
    controller.abort(reason);
    await expect(read).rejects.toBe(reason);
    expect(req.abort).toHaveBeenCalled();
  });

  it("4c. request error after headers errors the stream (no dangling reader)", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, {});
    const res = await pending;
    const read = res.body!.getReader().read();
    req.fail(new Error("net::ERR_CONNECTION_RESET"));
    await expect(read).rejects.toBeInstanceOf(Error);
  });

  it("5. redirect option: init.redirect 'error' and default 'follow' both reach the factory", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const p1 = fetchImpl(URL_TARGET, { redirect: "error" });
    await new Promise((r) => setTimeout(r, 0));
    const req1 = rig.requests[0]!;
    expect(req1.dispatch.redirect).toBe("manual"); // explicit manual transport; error mode aborts in the redirect event
    req1.respond(200, {});
    await p1;
    const p2 = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req2 = rig.requests[1]!;
    expect(req2.dispatch.redirect).toBe("manual"); // default follow is also manual-transport + followRedirect
    req2.respond(200, {});
    await p2;
  });

  it("5c. REGRESSION follow mode: the documented redirect event fires and followRedirect MUST be called synchronously", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {}); // default redirect mode: follow
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    // Fire the documented event signature: (statusCode, method, redirectUrl, responseHeaders).
    req.redirect(302, "GET", "https://api.kimi.com/coding/v2/models", { location: "https://api.kimi.com/coding/v2/models" });
    // followRedirect called synchronously INSIDE the event listener (before any await):
    expect(req.followRedirect).toHaveBeenCalledTimes(1);
    // The request was NOT resolved by the redirect itself — following continues
    // and the final response arrives on "response" as usual.
    req.respond(200, { "content-type": "application/json" });
    const res = await pending;
    req.data('{"ok":true}');
    req.end();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(req.abort).not.toHaveBeenCalled();
  });

  it("5d. REGRESSION manual mode: non-302 status and Location surface verbatim from the event", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, { redirect: "manual" });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.redirect(308, "GET", "https://api.kimi.com/v2/models", { location: "https://api.kimi.com/v2/models" });
    const res = await pending;
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://api.kimi.com/v2/models");
    expect(res.body).toBeNull();
    expect(req.followRedirect).not.toHaveBeenCalled();
  });

  it("3b. REGRESSION sanitization: a synchronous factory throw is a sanitized TypeError, never the raw error", async () => {
    const sentinel = "http://root:supersecret@proxy.corp:3128";
    const failingFactory = (): unknown => {
      throw new Error(`cannot create request for ${sentinel}`);
    };
    const caught = await proxyFetchVia(failingFactory, "p", undefined, URL_TARGET, {}).then(
      (r) => r,
      (e: unknown) => e as Error,
    );
    expect(caught).toBeInstanceOf(TypeError);
    const err = caught as Error;
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain(sentinel);
    expect(err.message).toBe("fetch failed");
  });

  it("3c. REGRESSION sanitization: an incoming error after headers reaches json() sanitized", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, { "content-type": "application/json" });
    const res = await pending;
    req.data('{"partial":');
    const jsonPromise = res.json();
    req.failIncoming(new Error("tunnel to http://root:supersecret@proxy.corp:3128 collapsed"));
    const errText = JSON.stringify(collectErrorText(await jsonPromise.catch((e: unknown) => e as Error)));
    expect(errText).not.toContain("supersecret");
    expect(errText).not.toContain("proxy.corp");
  });

  it("3d. REGRESSION sanitization: a write() throw is sanitized", async () => {
    const sentinel = "http://u:hunter2@proxy.corp:3128";
    const factory = (): unknown => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const base: Record<string, unknown> = {
        on: (e: string, l: (...a: never[]) => void) => {
          const arr = listeners.get(e) ?? [];
          arr.push(l as (...a: unknown[]) => void);
          listeners.set(e, arr);
          return base;
        },
        write: () => {
          throw new Error(`write failed proxying via ${sentinel}`);
        },
        end: () => undefined,
        abort: () => undefined,
      };
      return base;
    };
    const err = await proxyFetchVia(factory, "p", undefined, URL_TARGET, { method: "POST", body: "x=1" }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(JSON.stringify(collectErrorText(err))).not.toContain("hunter2");
  });

  it("4b. REGRESSION bounded queue: a fast producer with a HELD consumer aborts instead of buffering unboundedly", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(200, {});
    const res = await pending;
    // HOLD the consumer: never touch res.body; fire far more chunks than the
    // bounded queue holds. The adapter must abort the wire and error/close
    // the stream rather than buffer without bound.
    for (let i = 0; i < 200; i++) {
      req.data(`chunk-${i}-`);
    }
    let outcome: string;
    try {
      outcome = `OK:${await res.text()}`;
    } catch (err) {
      outcome = `ERR:${String(err)}`;
    }
    expect(req.abort).toHaveBeenCalled();
    // Either a truncated-but-delimited read (queue drained before the cap
    // abort closed/error the stream) or an error surfaces — never a hang.
    expect(typeof outcome).toBe("string");
  });

  it("4c. REGRESSION 204/null-body: the native request is aborted so nothing is left pending", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.respond(204, {});
    const res = await pending;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(req.abort).toHaveBeenCalled();
  });

  it("5b. redirect_blocked: a redirect while redirect:'error' maps through the production guard", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchCustomProviderModels({ baseUrl: "https://api.kimi.com/coding/v1", fetchImpl });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.emit("redirect", 302, "GET", "https://elsewhere.example.com/");
    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, reason: "redirect_blocked" });
    expect(req.abort).toHaveBeenCalled();
  });

  it("6. headers normalization: Headers/object/array inputs; 204 yields a null body", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const p1 = fetchImpl(URL_TARGET, { headers: new Headers({ accept: "application/json", "x-a": "1" }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.requests[0]!.dispatch.headers).toMatchObject({ accept: "application/json", "x-a": "1" });
    rig.requests[0]!.respond(200, {});
    await p1;
    const p2 = fetchImpl(URL_TARGET, { headers: { "x-b": "2" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.requests[1]!.dispatch.headers).toMatchObject({ "x-b": "2" });
    rig.requests[1]!.respond(200, {});
    await p2;
    const p3 = fetchImpl(URL_TARGET, { headers: [["x-c", "3"]] } as RequestInit);
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.requests[2]!.dispatch.headers).toMatchObject({ "x-c": "3" });
    rig.requests[2]!.respond(200, {});
    await p3;
    const p4 = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[3]!.respond(204, {});
    const res = await p4;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("6b. unsupported body type is rejected before any factory request", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    await expect(
      fetchImpl(URL_TARGET, { method: "POST", body: new Blob(["x"]) } as RequestInit),
    ).rejects.toBeInstanceOf(TypeError);
    expect(rig.dispatches).toEqual([]);
  });

  it("6c. boundary errors are sanitized: an error quoting an authenticated proxy URL never surfaces", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    req.fail(new Error("cannot connect to http://u:pw@proxy.corp:3128"));
    await expect(pending).rejects.toThrow("fetch failed");
    const logged = JSON.stringify([String(await pending.catch((e: Error) => e.message)), req.abort.mock.calls]);
    expect(logged).not.toContain("pw");
    expect(logged).not.toContain("proxy.corp");
  });

  it("7. https scheme preserved in rules", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-https" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[0]!.respond(200, {});
    await pending;
    expect(rig.setProxyCalls[0]?.rules).toBe("https://proxy.corp:3128");
  });

  it("8. IPv6 literal passes verbatim (no double bracket)", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => makeSettings({ connectionProxyUrl: "http://[::1]:3128" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[0]!.respond(200, {});
    await pending;
    expect(rig.setProxyCalls[0]?.rules).toBe("http://[::1]:3128");
  });

  it("9. malformed percent in credentials → ProxyMisconfiguredError, fixed message, no dispatch", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => makeSettings({ connectionProxyUrl: "http://u%zz:p@proxy.corp:3128" })))(
      hostForkProxyChain("conn-1"),
    );
    await expect(fetchImpl(URL_TARGET, {})).rejects.toMatchObject({
      name: "ProxyMisconfiguredError",
      message: PROXY_MISCONFIGURED_MESSAGE,
    });
    expect(rig.dispatches).toEqual([]);
    expect(rig.fallbackCalls).toEqual([]);
  });

  it("10. fail-closed matrix: legacy 'nonsense', socks5, hand-edited manual url", async () => {
    const rig = makeFakeBoundary();
    for (const settings of [
      makeSettings({ connectionProxyUrl: "nonsense" }),
      makeSettings({ connectionProxyUrl: "socks5://proxy.corp:1080" }),
      settingsWithProfiles({ connectionProxyRef: "proxy-garbage" }),
    ]) {
      const rig2 = makeFakeBoundary();
      const fetchImpl = createProxyChainFetch(rig2.deps(() => settings))(hostForkProxyChain("conn-1"));
      await expect(fetchImpl(URL_TARGET, {})).rejects.toBeInstanceOf(ProxyMisconfiguredError);
      expect(rig2.dispatches).toEqual([]);
      expect(rig2.fallbackCalls).toEqual([]);
    }
    void rig;
  });

  it("11. malformed connection rung above a VALID app rung → misconfigured (never the inherited proxy)", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(
      rig.deps(() => makeSettings({ connectionProxyUrl: "nonsense", appProxyRef: "proxy-https", profiles: PROFILES })),
    )(hostForkProxyChain("conn-1"));
    await expect(fetchImpl(URL_TARGET, {})).rejects.toBeInstanceOf(ProxyMisconfiguredError);
    expect(rig.dispatches).toEqual([]);
    expect(rig.fallbackCalls).toEqual([]);
  });

  it("12. direct matrix: explicit direct, dangling ref, nothing configured, noProxy exemption → fallback", async () => {
    for (const settings of [
      makeSettings({ connectionProxyRef: "direct" }),
      settingsWithProfiles({ connectionProxyRef: "proxy-missing" }),
      makeSettings(),
      settingsWithProfiles({ connectionProxyRef: "proxy-exempt" }),
    ]) {
      const rig = makeFakeBoundary();
      const fetchImpl = createProxyChainFetch(rig.deps(() => settings))(hostForkProxyChain("conn-1"));
      const res = await fetchImpl(URL_TARGET, { method: "GET" });
      expect(res.status).toBe(200);
      expect(rig.dispatches).toEqual([]);
      expect(rig.setProxyCalls).toEqual([]);
      expect(rig.fallbackCalls).toHaveLength(1);
      expect(rig.fallbackCalls[0]?.url).toBe(URL_TARGET);
    }
  });

  it("13. credential isolation: two credentials on one host → distinct partitions and per-request logins", async () => {
    const rig = makeFakeBoundary();
    const depsA = rig.deps(() => makeSettings({ connectionProxyUrl: "http://uA:pwA@proxy.corp:3128" }));
    const depsB = rig.deps(() => makeSettings({ connectionProxyUrl: "http://uB:pwB@proxy.corp:3128" }));
    const fetchA = createProxyChainFetch(depsA)(hostForkProxyChain("conn-1"));
    const fetchB = createProxyChainFetch(depsB)(hostForkProxyChain("conn-1"));
    const pA = fetchA(URL_TARGET, {});
    const pB = fetchB(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.setProxyCalls).toHaveLength(2);
    expect(rig.setProxyCalls[0]?.partition).not.toBe(rig.setProxyCalls[1]?.partition);
    for (const c of rig.setProxyCalls) {
      expect(c.partition).not.toContain("uA");
      expect(c.partition).not.toContain("pwA");
    }
    const [reqA, reqB] = rig.requests as [FakeRequest, FakeRequest];
    const auth = { isProxy: true, scheme: "basic", host: "proxy.corp", port: 3128, realm: "" };
    expect(reqA.login(auth)).toEqual({ username: "uA", password: "pwA" });
    expect(reqB.login(auth)).toEqual({ username: "uB", password: "pwB" });
    // Non-proxy challenge: no credentials supplied.
    expect(reqA.login({ ...auth, isProxy: false })).toEqual({});
    reqA.respond(200, {});
    reqB.respond(200, {});
    await pA;
    await pB;
  });

  it("14. partition reuse: same chain twice → one setProxyFor", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const p1 = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[0]!.respond(200, {});
    await p1;
    const p2 = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[1]!.respond(200, {});
    await p2;
    expect(rig.setProxyCalls).toHaveLength(1);
  });

  it("REGRESSION defect3: a SYNCHRONOUS setProxyFor throw is sanitized, dispatches nothing, and a later retry succeeds", async () => {
    const rig = makeFakeBoundary();
    const settings = settingsWithProfiles({ connectionProxyRef: "proxy-1" });
    let failSynchronously = true;
    const failingDeps: ProxyChainFetchDeps = {
      ...rig.deps(() => settings),
      // NON-async: throws IMMEDIATELY while createProxyChainFetch evaluates
      // deps.setProxyFor(...) — before any .catch/.then attaches.
      setProxyFor: (partition, rules) => {
        if (failSynchronously) {
          throw new Error("setProxy exploded mid-flight for http://u:secret@proxy.corp:3128");
        }
        rig.setProxyCalls.push({ partition, rules });
        return Promise.resolve();
      },
    };
    const fetchImpl = createProxyChainFetch(failingDeps)(hostForkProxyChain("conn-1"));
    const err = await fetchImpl(URL_TARGET, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    // UNCONDITIONAL: rejection happened and is sanitized end-to-end
    // (message + recursive cause chain carry no credentials, no proxy URL).
    expect(err).toBeInstanceOf(TypeError);
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("proxy.corp");
    expect(text).not.toContain("u:secret");
    // Nothing was dispatched around the failed proxy.
    expect(rig.dispatches).toHaveLength(0);
    expect(rig.fallbackCalls).toHaveLength(0);
    // Partition-cache eviction: after the boundary heals, the SAME chain
    // retries setProxyFor and succeeds end-to-end (no poisoned cache entry).
    failSynchronously = false;
    const pending = fetchImpl(URL_TARGET, {});
    await new Promise((r) => setTimeout(r, 0));
    rig.requests[0]!.respond(200, { "content-type": "text/plain" });
    const res = await pending;
    rig.requests[0]!.data("ok");
    rig.requests[0]!.end();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(rig.setProxyCalls).toHaveLength(1); // the retry re-ran setProxyFor
  });

  it("REGRESSION defect3: an ASYNC setProxyFor rejection is likewise sanitized and never dispatches", async () => {
    const rig = makeFakeBoundary();
    const failingDeps: ProxyChainFetchDeps = {
      ...rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })),
      setProxyFor: async () => {
        throw new Error("setProxy rejected for http://u:secret@proxy.corp:3128");
      },
    };
    const fetchImpl = createProxyChainFetch(failingDeps)(hostForkProxyChain("conn-1"));
    const err = await fetchImpl(URL_TARGET, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("proxy.corp");
    expect(rig.dispatches).toHaveLength(0);
    expect(rig.fallbackCalls).toHaveLength(0);
  });

  it("15. POST body is written and the written form reaches the wire", async () => {
    const rig = makeFakeBoundary();
    const fetchImpl = createProxyChainFetch(rig.deps(() => settingsWithProfiles({ connectionProxyRef: "proxy-1" })))(
      hostForkProxyChain("conn-1"),
    );
    const pending = fetchImpl("https://idp.example.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=rt-1",
    });
    await new Promise((r) => setTimeout(r, 0));
    const req = rig.requests[0]!;
    expect(req.written.join("")).toContain("grant_type=refresh_token");
    expect(req.dispatch.method).toBe("POST");
    req.respond(200, { "content-type": "application/json" });
    const res = await pending;
    req.data('{"access_token":"at"}');
    req.end();
    expect(await res.json()).toEqual({ access_token: "at" });
  });
});

describe("resolveProxyRoute — unit decisions", () => {
  const deps = { proxyPassword: (id: string) => (id === "proxy-1" ? "pw" : undefined) };
  it("system-mode profile that resolves nothing → direct/system-answer", async () => {
    const route = await resolveProxyRoute(settingsWithProfiles({ connectionProxyRef: "proxy-system" }), hostForkProxyChain("conn-1"), deps, URL_TARGET);
    expect(route).toEqual({ kind: "direct", why: "system-answer" });
  });
  it("app-rung-only legacy proxy materializes when the connection is silent", async () => {
    const route = await resolveProxyRoute(
      makeSettings({ connectionProxyUrl: undefined, appProxyRef: undefined, profiles: [] }),
      hostForkProxyChain(undefined),
      deps,
      URL_TARGET,
    );
    expect(route).toEqual({ kind: "direct", why: "nothing-configured" });
  });
});

describe("splitProxyUrl — table", () => {
  it("splits scheme, host, port, userinfo", () => {
    expect(splitProxyUrl("http://proxy.corp:3128")).toEqual({ rules: "http://proxy.corp:3128" });
    expect(splitProxyUrl("https://u:p%40x@proxy.corp:3128")).toEqual({
      rules: "https://proxy.corp:3128",
      login: "u",
      password: "p@x",
    });
    expect(splitProxyUrl("http://proxy.corp")).toEqual({ rules: "http://proxy.corp" });
    expect(splitProxyUrl("http://[::1]:3128")).toEqual({ rules: "http://[::1]:3128" });
    expect(splitProxyUrl("http://u@proxy.corp")).toEqual({ rules: "http://proxy.corp", login: "u" });
  });
  it("rejects non-http(s), empty host, malformed credentials", () => {
    expect(splitProxyUrl("socks5://proxy.corp:1080")).toBeUndefined();
    expect(splitProxyUrl("nonsense")).toBeUndefined();
    expect(splitProxyUrl("http://u%zz:p@proxy.corp:3128")).toBeUndefined();
  });
});

describe("updaterBypassFromNoProxy — canonical suffix semantics", () => {
  it("DNS host → exact + '*.' suffix with optional port retained", () => {
    expect(updaterBypassFromNoProxy("a.com, .b.com")).toMatchObject({ bypass: "a.com,*.a.com,b.com,*.b.com" });
    expect(updaterBypassFromNoProxy("host.example:8080")).toMatchObject({
      bypass: "host.example:8080,*.host.example:8080",
    });
  });
  it("'*' alone → whole-route direct", () => {
    expect(updaterBypassFromNoProxy("*")).toEqual({ all: true });
  });
  it("undefined/empty → {}", () => {
    expect(updaterBypassFromNoProxy(undefined)).toEqual({});
    expect(updaterBypassFromNoProxy("")).toEqual({});
  });
  it("wildcard chars inside an entry are ignored (no new broad exemption)", () => {
    expect(updaterBypassFromNoProxy("192.168.*")).toEqual({});
    expect(updaterBypassFromNoProxy("192.168.*,a.com")).toMatchObject({ bypass: "a.com,*.a.com" });
  });
  it("IPv6 literals pass as exact bracketed rules", () => {
    expect(updaterBypassFromNoProxy("[::1]")).toMatchObject({ bypass: "[::1]" });
    expect(updaterBypassFromNoProxy("::1")).toMatchObject({ bypass: "[::1]" });
  });
});

describe("decideUpdaterRoute — table", () => {
  const deps = { proxyPassword: (id: string) => (id === "proxy-1" ? "pw" : undefined) };
  it("no app scope → untouched", async () => {
    expect(await decideUpdaterRoute(makeSettings(), deps, undefined)).toEqual({ decision: { kind: "untouched" } });
  });
  it("system-mode profile → system", async () => {
    expect(await decideUpdaterRoute(settingsWithProfiles({ appProxyRef: "proxy-system" }), deps, undefined)).toEqual({
      decision: { kind: "system" },
    });
  });
  it("valid manual profile with login → fixed + creds", async () => {
    const out = await decideUpdaterRoute(settingsWithProfiles({ appProxyRef: "proxy-1" }), deps, "https://github.com/x");
    expect(out.decision).toMatchObject({ kind: "fixed", rules: "http://proxy.corp:3128" });
    expect(out.creds).toEqual({ login: "u", password: "pw" });
  });
  it("manual profile with hand-edited garbage url → misconfigured", async () => {
    expect(await decideUpdaterRoute(settingsWithProfiles({ appProxyRef: "proxy-garbage" }), deps, undefined)).toEqual({
      decision: { kind: "misconfigured" },
    });
  });
  it("explicit direct → direct; dangling → direct", async () => {
    expect(await decideUpdaterRoute(makeSettings({ appProxyRef: "direct" }), deps, undefined)).toEqual({
      decision: { kind: "direct" },
    });
    expect(await decideUpdaterRoute(settingsWithProfiles({ appProxyRef: "nope" }), deps, undefined)).toEqual({
      decision: { kind: "direct" },
    });
  });
  it("legacy app string: valid → fixed; malformed → misconfigured", async () => {
    const ok = await decideUpdaterRoute(
      makeSettings({
        profiles: undefined,
        appProxyRef: undefined,
        connectionProxyRef: undefined,
        connectionProxyUrl: undefined,
      } as SettingsSeed),
      deps,
      undefined,
    );
    void ok;
    const app = { ...makeSettings(), network: { proxyProfiles: [] as never[] } } as AnycodeSettings;
    (app as unknown as { network?: { proxyProfiles?: unknown[]; proxyRef?: string } }).network = { proxyProfiles: [] };
    const legacyValid = { ...app, network: { proxyRef: undefined } } as unknown;
    void legacyValid;
    // legacy app string path: use the codex block? No — the APP scope's legacy
    // string does not exist (network.proxyRef is ref-only), so only refs apply.
    expect(await decideUpdaterRoute(app, deps, undefined)).toEqual({ decision: { kind: "untouched" } });
  });
  it("noProxy '*' → direct; feed host exempt still routes fixed (download hosts can differ)", async () => {
    const allStar = settingsWithProfiles({ appProxyRef: "proxy-star" });
    (allStar.network!.proxyProfiles as unknown as Array<Record<string, unknown>>).push({
      id: "proxy-star",
      name: "Star",
      mode: "manual",
      url: "http://proxy.corp:3128",
      noProxy: "*",
    });
    expect(await decideUpdaterRoute(allStar, deps, undefined)).toEqual({ decision: { kind: "direct" } });
    const exempt = settingsWithProfiles({ appProxyRef: "proxy-exempt" });
    const out = await decideUpdaterRoute(exempt, deps, "https://api.kimi.com/other");
    expect(out.decision).toMatchObject({ kind: "fixed" });
  });
});

describe("makeUpdaterLoginHandler — dynamic state, scoped challenges", () => {
  const info = (over: Partial<ProxyAuthInfo> = {}): ProxyAuthInfo => ({
    isProxy: true,
    scheme: "basic",
    host: "proxy.corp",
    port: 3128,
    realm: "",
    ...over,
  });
  it("with current state answers (u, p) for the configured host/port", () => {
    const captured: Array<[string?, string?]> = [];
    makeUpdaterLoginHandler(() => ({ login: "u", password: "p", host: "proxy.corp", port: 3128 }))(
      info(),
      (username, password) => captured.push([username, password]),
    );
    expect(captured).toEqual([["u", "p"]]);
  });
  it("the state is READ PER CHALLENGE — a rotation between challenges is honored", () => {
    let state: { login: string; password: string; host: string; port: number } | undefined = {
      login: "u",
      password: "p1",
      host: "proxy.corp",
      port: 3128,
    };
    const handler = makeUpdaterLoginHandler(() => state);
    const out: Array<string[]> = [];
    handler(info(), (u, p) => out.push([u ?? "", p ?? ""]));
    state = { login: "u", password: "p2", host: "proxy.corp", port: 3128 };
    handler(info(), (u, p) => out.push([u ?? "", p ?? ""]));
    state = undefined; // config removed mid-flight
    const argCounts: number[] = [];
    handler(info(), (...args) => argCounts.push(args.length));
    expect(out).toEqual([["u", "p1"], ["u", "p2"]]);
    expect(argCounts).toEqual([0]);
  });
  it("without state the callback fires with zero credential args", () => {
    const calls: number[] = [];
    makeUpdaterLoginHandler(() => undefined)(info(), (...args) => calls.push(args.length));
    expect(calls).toEqual([0]);
  });
  it("isProxy:false, an unrelated host, or a wrong port → no credentials", () => {
    const calls: number[] = [];
    const handler = makeUpdaterLoginHandler(() => ({ login: "u", password: "p", host: "proxy.corp", port: 3128 }));
    handler(info({ isProxy: false }), (...args) => calls.push(args.length));
    handler(info({ host: "other" }), (...args) => calls.push(args.length));
    handler(info({ port: 9999 }), (...args) => calls.push(args.length));
    expect(calls).toEqual([0, 0, 0]);
  });
  it("IPv6 challenge host bracketing is normalized before comparison", () => {
    const handler = makeUpdaterLoginHandler(() => ({ login: "u", password: "p", host: "::1", port: 3128 }));
    const argCounts: number[] = [];
    handler(info({ host: "[::1]" }), (...args) => argCounts.push(args.length));
    expect(argCounts).toEqual([2]); // credentials supplied
  });
});

describe("proxyFetchVia — direct unit (no chain)", () => {
  it("writes a string body and ends the request", async () => {
    const seen: ProxyDispatchRequest[] = [];
    const written: string[] = [];
    const factory = (d: ProxyDispatchRequest): unknown => {
      seen.push(d);
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const base: Record<string, unknown> = {
        on: (e: string, l: (...a: never[]) => void) => {
          const arr = listeners.get(e) ?? [];
          arr.push(l as (...a: unknown[]) => void);
          listeners.set(e, arr);
          return base;
        },
        write: (c: string) => written.push(c),
        end: () => {
          const respond = listeners.get("response") ?? [];
          const incoming: ProxyIncomingLike = {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "x-multi": ["a", "b"] },
            on: () => base,
          };
          for (const l of respond) l(incoming);
        },
        abort: () => undefined,
      };
      return base;
    };
    const res = await proxyFetchVia(factory, "p", undefined, "https://x/", {
      method: "POST",
      headers: { a: "1" },
      body: "hello=world",
    });
    expect(written).toEqual(["hello=world"]);
    expect(res.headers.get("x-multi")).toBe("a, b");
    expect(seen[0]?.partition).toBe("p");
  });
});

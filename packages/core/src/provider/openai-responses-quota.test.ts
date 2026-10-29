/**
 * Quota-fetch wiring tests for the openai-responses factory (Taskana 4090 /
 * TASK.71, §3 test 3). The SDK factory's options are spied via vi.mock for
 * the dormancy pins; the COMPOSITION case (quota wrapper OUTER over the
 * Authorization-stripping fetch) is asserted against a real node:http
 * loopback server — the wrapper must both observe quota headers AND still
 * strip the ambient empty-Bearer Authorization before the request hits the
 * wire. No external network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointConfig } from "./endpoint.js";
import type { ProviderQuotaUpdate } from "./quota.js";
import { createOpenAIResponsesLanguageModel } from "./openai-responses.js";

const mockCreateOpenAI = vi.fn();

vi.mock("@ai-sdk/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
  return {
    ...actual,
    createOpenAI: (...args: Parameters<typeof actual.createOpenAI>) => {
      mockCreateOpenAI(...args);
      return actual.createOpenAI(...args);
    },
  };
});

const { createOpenAIResponsesLanguageModel: createModel } = await import("./openai-responses.js");

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    transport: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    model: "gpt-6.1-sol",
    ...overrides,
  };
}

describe("createOpenAIResponsesLanguageModel quota fetch wiring (Taskana 4090)", () => {
  it("passes NO fetch key when neither onQuotaHeaders nor stripping applies (dormancy pin)", () => {
    createModel(config());
    const options = mockCreateOpenAI.mock.calls.at(-1)![0];
    expect("fetch" in options).toBe(false);
  });

  it("wraps fetch when onQuotaHeaders is set", () => {
    const onQuotaHeaders = vi.fn();
    createModel(config({ onQuotaHeaders }));
    const options = mockCreateOpenAI.mock.calls.at(-1)![0];
    expect("fetch" in options).toBe(true);
    expect(typeof options.fetch).toBe("function");
  });

  it("still installs the stripping fetch alone when apiKey is absent and no observer is set", () => {
    createModel(config({ apiKey: undefined }));
    const options = mockCreateOpenAI.mock.calls.at(-1)![0];
    expect("fetch" in options).toBe(true);
    expect(typeof options.fetch).toBe("function");
  });

  // COMPOSITION: apiKey absent (strip applies) + onQuotaHeaders set (quota
  // applies) ⇒ quota wrapper is the OUTER. Asserted end-to-end against a
  // loopback 200: the request must arrive WITHOUT an Authorization header
  // (stripping still effective) and the observer must fire with the parsed
  // quota update (quota sees the final response).
  it("composes quota OUTER over Authorization stripping: no Authorization on the wire, observer still fires", async () => {
    let sawAuthorization: string | undefined;
    const origin = await listen((req, res) => {
      sawAuthorization = req.headers.authorization;
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-requests-limit": "50",
        "x-ratelimit-requests-remaining": "10",
      });
      res.end("{}");
    });

    const seen: Array<ProviderQuotaUpdate | null> = [];
    const onQuotaHeaders = (update: ProviderQuotaUpdate | null) => seen.push(update);
    createModel(config({ apiKey: undefined, baseUrl: `${origin}/v1`, onQuotaHeaders }));

    // Drive the wrapped fetch chain directly: the options object captured by
    // the mock IS what the SDK would call with; invoking its fetch against
    // the loopback proves the composition without a full streamText run.
    const options = mockCreateOpenAI.mock.calls.at(-1)![0] as { fetch: typeof fetch };
    const res = await options.fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer " }, // the ambient empty Bearer the SDK emits
    });
    expect(res.status).toBe(200);
    expect(sawAuthorization).toBeUndefined(); // stripped before the wire
    expect(seen).toHaveLength(1); // quota saw the final response
    expect(seen[0]).toEqual({
      primary: { usedPercent: 80 },
      primarySource: "x-ratelimit-requests-limit",
      sources: ["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining"],
    });
  });
});

describe("createOpenAIResponsesLanguageModel response-activity tap (#27)", () => {
  it("installs a fetch wrapper when onResponseActivity is given and nothing else wraps", () => {
    createModel(config(), vi.fn()); const options=mockCreateOpenAI.mock.calls.at(-1)![0]; expect(typeof options.fetch).toBe("function");
  });
  it("taps outside quota and Authorization stripping: bytes observed, quota fires, header stripped", async () => {
    let sawAuthorization: string | undefined;
    const origin=await listen((req,res)=>{ sawAuthorization=req.headers.authorization; res.writeHead(200,{"x-ratelimit-requests-limit":"50","x-ratelimit-requests-remaining":"10"}); res.write("data: a\n\n"); setTimeout(()=>res.end("data: b\n\n"),10); });
    const seen: Array<ProviderQuotaUpdate | null>=[]; const activity=vi.fn();
    createModel(config({apiKey:undefined,baseUrl:`${origin}/v1`,onQuotaHeaders: update=>seen.push(update)}),activity);
    const options=mockCreateOpenAI.mock.calls.at(-1)![0] as {fetch:typeof fetch};
    const res=await options.fetch(`${origin}/v1/responses`,{method:"POST",headers:{authorization:"Bearer "}});
    expect(await res.text()).toBe("data: a\n\ndata: b\n\n"); expect(activity.mock.calls.length).toBeGreaterThanOrEqual(2); expect(seen).toHaveLength(1); expect(sawAuthorization).toBeUndefined();
  });
});

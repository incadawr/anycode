import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { providerSmokeApi, stopProviderSmokeLauncher, registerProviderSmokeChild, providerSmokeTeardown } from "../../scripts/provider-connections-smoke-api.mjs";
import { verifiedAutomationRequest } from "../../scripts/verified-automation-http.mjs";
import { verifyCdpPeer } from "../../scripts/isolated-cdp.mjs";

describe("provider smoke automation", () => {
  it.each(["/settings/open", "/quit"])("sends no command or bearer token to a foreign peer for %s", async path => {
    const socket = Object.assign(new EventEmitter(), {destroy:vi.fn(), remoteAddress:"127.0.0.1", localAddress:"127.0.0.1", remotePort:1234, localPort:4567});
    const requestImpl = vi.fn();
    const ctx = {port:1234, token:"fixture-token", cdp:{automation: (_info:unknown, target:string, method:string, body:unknown) => {
      const pending = verifiedAutomationRequest({port:1234, token:"fixture-token", path:target, method, body, connectImpl:() => socket, requestImpl, verifyPeer:localPort => verifyCdpPeer({records:`p999\nn127.0.0.1:1234->127.0.0.1:${localPort}\n`, browserPid:300, port:1234, localPort})});
      queueMicrotask(() => socket.emit("connect"));
      return pending;
    }}};
    await expect(providerSmokeApi(ctx, "POST", path, {})).rejects.toThrow("another process");
    expect(requestImpl).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it("refuses commands and quit before launcher identity is verified", async () => {
    for (const path of ["/settings/open", "/quit"]) await expect(providerSmokeApi({port:1234, token:"fixture-token"}, "POST", path, {})).rejects.toThrow("Verified automation channel is unavailable");
  });
  it("preserves HTTP status and response body for a verified channel", async () => {
    const automation = vi.fn().mockResolvedValue({status:403, result:{error:"fixture"}});
    await expect(providerSmokeApi({port:1234, token:"fixture-token", cdp:{automation}}, "POST", "/settings/open", {})).resolves.toEqual({status:403, body:{error:"fixture"}});
    expect(automation).toHaveBeenCalledWith({port:1234, token:"fixture-token"}, "/settings/open", "POST", {});
  });
});


it("does not send SIGKILL after the owned launcher has exited", async () => {
  const child = {pid:123, exitCode:null as number | null, signalCode:null as NodeJS.Signals | null};
  const kill = vi.fn();
  const sleep = vi.fn(async () => {child.exitCode = 0;});
  await stopProviderSmokeLauncher(child, {kill, sleep, graceMs:750});
  expect(kill).toHaveBeenCalledOnce();
  expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
});

it("sends SIGKILL only while the owned launcher still runs", async () => {
  const child = {pid:123, exitCode:null, signalCode:null};
  const kill = vi.fn();
  await stopProviderSmokeLauncher(child, {kill, sleep:async () => {}, graceMs:750});
  expect(kill.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
});


it("registers the launched child before startup and shares one teardown with a signal", async () => {
  const ctx = {child:null as unknown, teardownPromise:null as Promise<void> | null};
  const child = {pid:123};
  let current: typeof ctx | null = null;
  registerProviderSmokeChild(ctx, child, value => {current = value;});
  expect(current).toBe(ctx);
  expect(ctx.child).toBe(child);
  let finish!: () => void;
  const teardownApp = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
  const signal = providerSmokeTeardown(ctx, [], teardownApp);
  const startupFailure = providerSmokeTeardown(ctx, [], teardownApp);
  expect(signal).toBe(startupFailure);
  expect(teardownApp).toHaveBeenCalledOnce();
  finish();
  await signal;
});

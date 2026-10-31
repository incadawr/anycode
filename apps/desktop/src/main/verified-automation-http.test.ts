import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { verifiedAutomationRequest } from "../../scripts/verified-automation-http.mjs";

it("does not send a bearer token or request to a foreign connected peer", async () => {
  const socket = Object.assign(new EventEmitter(), {destroy:vi.fn(), remoteAddress:"127.0.0.1", localAddress:"127.0.0.1", remotePort:1234, localPort:4567});
  const requestImpl = vi.fn();
  const pending = verifiedAutomationRequest({port:1234, token:"fixture-token", path:"/quit", method:"POST", connectImpl:() => socket, requestImpl, verifyPeer:() => {throw new Error("foreign peer");}});
  socket.emit("connect");
  await expect(pending).rejects.toThrow("foreign peer");
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(requestImpl).not.toHaveBeenCalled();
});

it("sends a request only after verification on the same synthetic socket", async () => {
  const { Duplex } = await import("node:stream");
  let wire = "";
  const socket = Object.assign(new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      wire += chunk.toString(); callback();
      if (wire.includes("\r\n\r\n")) queueMicrotask(() => { socket.push('HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}'); socket.push(null); });
    },
  }), { remoteAddress:"127.0.0.1", localAddress:"127.0.0.1", remotePort:1234, localPort:4567, setTimeout:() => socket, setNoDelay:() => socket, setKeepAlive:() => socket });
  const verifyPeer = vi.fn(() => { expect(wire).toBe(""); });
  const pending = verifiedAutomationRequest({port:1234, token:"fixture-token", path:"/state", connectImpl:() => socket, verifyPeer});
  socket.emit("connect");
  await expect(pending).resolves.toEqual({status:200, ok:true, result:{ok:true}});
  expect(verifyPeer).toHaveBeenCalledWith(4567);
  expect(wire).toContain("Bearer fixture-token");
});

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { openVerifiedWebSocket } from "../../scripts/verified-websocket.mjs";

it("aborts a stalled upgrade without sending browser commands", async () => {
  vi.useFakeTimers();
  try {
    const req = Object.assign(new EventEmitter(), { end:vi.fn(), destroy:vi.fn() });
    const opening = openVerifiedWebSocket({port:1234, path:"/fixture", verifyPeer:vi.fn(), requestImpl:() => req, timeoutMs:100});
    const failure = expect(opening).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(req.destroy).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("checks the established peer before any WebSocket frame and fails closed", async () => {
  const socket = Object.assign(new EventEmitter(), { pause:vi.fn(), resume:vi.fn(), destroy:vi.fn(), write:vi.fn(), remoteAddress:"127.0.0.1", localAddress:"127.0.0.1", remotePort:1234, localPort:4567 });
  const requestImpl = (options: {headers:Record<string, string>}) => {
    const req = Object.assign(new EventEmitter(), { destroy:vi.fn(), end:() => {
      const accept = createHash("sha1").update(`${options.headers["Sec-WebSocket-Key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      queueMicrotask(() => req.emit("upgrade", {headers:{"sec-websocket-accept":accept}}, socket, Buffer.alloc(0)));
    } });
    return req;
  };
  await expect(openVerifiedWebSocket({port:1234, path:"/fixture", requestImpl, verifyPeer:() => {throw new Error("foreign peer");}})).rejects.toThrow("foreign peer");
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(socket.write).not.toHaveBeenCalled();
  expect(socket.resume).not.toHaveBeenCalled();
});

it("sends masked commands on the verified socket and decodes a text reply", async () => {
  const socket = Object.assign(new EventEmitter(), { pause:vi.fn(), resume:vi.fn(), destroy:vi.fn(), write:vi.fn(), remoteAddress:"127.0.0.1", localAddress:"127.0.0.1", remotePort:1234, localPort:4567 });
  const requestImpl = (options: {headers:Record<string, string>}) => {
    const req = Object.assign(new EventEmitter(), {destroy:vi.fn(), end:() => {
      const accept = createHash("sha1").update(`${options.headers["Sec-WebSocket-Key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      queueMicrotask(() => req.emit("upgrade", {headers:{"sec-websocket-accept":accept}}, socket, Buffer.alloc(0)));
    }});
    return req;
  };
  const verifyPeer = vi.fn(() => expect(socket.write).not.toHaveBeenCalled());
  const peer = await openVerifiedWebSocket({port:1234, path:"/fixture", requestImpl, verifyPeer});
  const received = vi.fn(); peer.onmessage = received;
  peer.send("hello");
  const frame = socket.write.mock.calls[0]![0] as Buffer;
  expect(frame[0]).toBe(0x81); expect(frame[1]).toBe(0x85);
  expect(Buffer.from(frame.subarray(6).map((value, index) => value ^ frame[2 + index % 4]!)).toString()).toBe("hello");
  socket.emit("data", Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("ok")]));
  expect(received).toHaveBeenCalledWith({data:"ok"});
  peer.close();
});

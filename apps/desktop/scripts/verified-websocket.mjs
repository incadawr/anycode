import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

// Minimal CDP WebSocket transport. The TCP peer is verified before any frame is sent.
export function openVerifiedWebSocket({ port, path, verifyPeer, requestImpl = request, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const req = requestImpl({ hostname:"127.0.0.1", port, path, method:"GET", headers:{ Connection:"Upgrade", Upgrade:"websocket", "Sec-WebSocket-Version":"13", "Sec-WebSocket-Key":key } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("Debug endpoint connection timed out")); }, timeoutMs);
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.on("response", response => { clearTimeout(timer); response.resume(); reject(new Error("Debug endpoint refused upgrade")); });
    req.on("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      socket.pause();
      try {
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        if (response.headers["sec-websocket-accept"] !== accept || socket.remoteAddress !== "127.0.0.1" || socket.localAddress !== "127.0.0.1" || socket.remotePort !== port || !socket.localPort) throw new Error("Invalid browser socket");
        verifyPeer(socket.localPort);
      } catch (error) { socket.destroy(); reject(error); return; }
      let buffer = Buffer.from(head), fragments = [], fragmentBytes = 0;
      const peer = { onmessage: undefined, readyState: 1, close: () => { peer.readyState = 3; socket.destroy(); }, send: text => sendFrame(1, Buffer.from(text)) };
      function sendFrame(opcode, body) {
        const mask = randomBytes(4), header = body.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | body.length]) : body.length <= 65535 ? Buffer.from([0x80 | opcode, 0x80 | 126, body.length >> 8, body.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(body.length), 2); return h; })();
        const masked = Buffer.from(body); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      }
      function receive(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const first = buffer[0], second = buffer[1]; let length = second & 127, offset = 2;
          if (second & 128) { peer.close(); return; }
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 33554432n) { peer.close(); return; } length = Number(n); offset = 10; }
          if (length > 33554432 || buffer.length < offset + length) return;
          const body = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          const opcode = first & 15;
          if (opcode === 8) { peer.close(); return; }
          if (opcode === 9) { sendFrame(10, body); continue; }
          if (opcode === 10) continue;
          if (opcode !== 0 && opcode !== 1) { peer.close(); return; }
          fragments.push(body); fragmentBytes += body.length;
          if (fragmentBytes > 33554432) { peer.close(); return; }
          if (first & 128) { const data = Buffer.concat(fragments).toString("utf8"); fragments = []; fragmentBytes = 0; peer.onmessage?.({data}); }
        }
      }
      socket.on("error", () => peer.close()); socket.on("close", () => { peer.readyState = 3; }); socket.on("data", receive);
      resolve(peer); socket.resume(); if (buffer.length) { const initial = buffer; buffer = Buffer.alloc(0); receive(initial); }
    });
    req.end();
  });
}

import { connect } from "node:net";
import { request } from "node:http";

/** Connect first, verify the exact TCP peer, then send credentials and the request. */
export function verifiedAutomationRequest({ port, token, path, method = "GET", body, verifyPeer, connectImpl = connect, requestImpl = request }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token) || !/^\/[\x21-\x7e]*$/.test(path) || !["GET", "POST"].includes(method)) throw new Error("Invalid automation endpoint");
  return new Promise((resolve, reject) => {
    const socket = connectImpl({host:"127.0.0.1", port});
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Automation request timed out")); }, 30000);
    const fail = error => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.once("connect", () => {
      try {
        if (socket.remoteAddress !== "127.0.0.1" || socket.localAddress !== "127.0.0.1" || socket.remotePort !== port || !socket.localPort) throw new Error("Invalid automation socket");
        verifyPeer(socket.localPort);
        const payload = body === undefined ? "" : JSON.stringify(body);
        const req = requestImpl({host:"127.0.0.1", port, path, method, agent:{addRequest: client => client.onSocket(socket)}, headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json", Connection:"close", "Content-Length":Buffer.byteLength(payload) }}, response => {
          const chunks = []; let size = 0;
          response.on("data", chunk => { size += chunk.length; if (size > 33554432) { fail(new Error("Automation response too large")); return; } chunks.push(chunk); });
          response.on("error", fail);
          response.on("end", () => { clearTimeout(timer); try { resolve({ok:response.statusCode >= 200 && response.statusCode < 300, result:JSON.parse(Buffer.concat(chunks).toString("utf8"))}); } catch (error) { fail(error); } });
        });
        req.on("error", fail);
        req.end(payload);
      } catch (error) { fail(error); }
    });
  });
}

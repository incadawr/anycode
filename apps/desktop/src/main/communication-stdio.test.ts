import { spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const token = "a".repeat(32);
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => instance.close(() => resolve())));
  return { instance, url: `http://127.0.0.1:${(instance.address() as { port: number }).port}/mcp` };
}
async function launch(path: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../../examples/agent-communication/stdio.mjs", import.meta.url)), path], { stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id: number) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "test" })}\n`);
    return JSON.parse((await lines.next()).value!);
  };
  return { call, child };
}
async function bridge(url: string) {
  const dir = await mkdtemp(join(tmpdir(), "anycode-stdio-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "endpoint.json");
  const discovery = async (url: string, value = token) => writeFile(path, JSON.stringify({ url, token: value }), { mode: 0o600 });
  await discovery(url);
  const { call } = await launch(path);
  return { discovery, call, path };
}
function ok(id = 1) { return JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }); }

describe("stdio discovery refresh", () => {
  it("survives being started while the host is down and reaches it once it is up", async () => {
    const s = await server((_req, res) => res.end(ok()));
    const dir = await mkdtemp(join(tmpdir(), "anycode-stdio-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "endpoint.json");
    // No discovery file yet: the previous host removed it on its way down. Exiting
    // here would leave the client with a dead server and force a manual reconnect.
    const { call } = await launch(path);
    expect((await call(1)).error).toBeDefined();
    await writeFile(path, JSON.stringify({ url: s.url, token }), { mode: 0o600 });
    expect((await call(2)).result).toBe("ok");
  });
  it("reloads a changed endpoint after a network failure", async () => {
    const old = await server((_req, res) => res.end(ok()));
    const b = await bridge(old.url);
    expect((await b.call(1)).result).toBe("ok");
    await new Promise<void>((resolve) => old.instance.close(() => resolve()));
    const next = await server((_req, res) => res.end(ok(2)));
    await b.discovery(next.url);
    expect((await b.call(2)).result).toBe("ok");
  });
  it("reaches a restarted host on its new port and token without reconnecting", async () => {
    // The surviving adapter process must follow a host restart: the old instance
    // dies with its keep-alive socket open (RST, not a clean close), the new one
    // listens elsewhere with a regenerated token, and the discovery file is
    // already rewritten. The very next call has to succeed against the new host.
    const retired: Socket[] = [];
    let oldRequests = 0;
    const old = await server((_req, res) => {
      oldRequests += 1;
      if (oldRequests === 1) { res.end(ok(1)); return; }
      res.writeHead(503).end();
    });
    old.instance.on("connection", (socket) => retired.push(socket));
    const b = await bridge(old.url);
    expect((await b.call(1)).result).toBe("ok");

    const nextToken = "c".repeat(32);
    const seen: Array<string | undefined> = [];
    const next = await server((req, res) => { seen.push(req.headers.authorization); res.end(ok(2)); });
    await b.discovery(next.url, nextToken);
    for (const socket of retired) socket.resetAndDestroy();
    expect((await b.call(2)).result).toBe("ok");
    expect(seen).toEqual([`Bearer ${nextToken}`]);
    expect(oldRequests).toBe(1);
  });
  it("uses a regenerated token on the first attempt instead of after a 401", async () => {
    let expected = token;
    let requests = 0;
    const s = await server((req, res) => {
      requests += 1;
      if (req.headers.authorization !== `Bearer ${expected}`) { res.writeHead(401).end(); return; }
      res.end(ok());
    });
    const b = await bridge(s.url);
    expect((await b.call(1)).result).toBe("ok");
    expected = "d".repeat(32);
    await b.discovery(s.url, expected);
    expect((await b.call(2)).result).toBe("ok");
    expect(requests).toBe(2);
  });
  it("reloads a changed token after 401 and retries only once", async () => {
    let calls = 0;
    const nextToken = "b".repeat(32);
    const s = await server((req, res) => {
      calls++;
      if (req.headers.authorization !== `Bearer ${nextToken}`) { res.writeHead(401).end(); return; }
      res.end(ok(2));
    });
    const b = await bridge(s.url);
    expect((await b.call(1)).error.message).toContain("401");
    expect(calls).toBe(2);
    await b.discovery(s.url, nextToken);
    expect((await b.call(2)).result).toBe("ok");
    expect(calls).toBe(3);
  });
  it("does not retry a request when the connection drops after delivery", async () => {
    let calls = 0;
    const s = await server((req) => { calls++; req.socket.destroy(); });
    const b = await bridge(s.url);
    expect((await b.call(1)).error.message).toContain("fetch failed");
    expect(calls).toBe(1);
  });
  it("revalidates file permissions before retrying", async () => {
    const s = await server((_req, res) => res.writeHead(401).end());
    const b = await bridge(s.url);
    expect((await b.call(1)).error.message).toContain("401");
    await chmod(b.path, 0o644);
    expect((await b.call(2)).error.message).toContain("private regular file");
  });
});

import { spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
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
async function bridge(url: string) {
  const dir = await mkdtemp(join(tmpdir(), "anycode-stdio-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "endpoint.json");
  const discovery = async (url: string, value = token) => writeFile(path, JSON.stringify({ url, token: value }), { mode: 0o600 });
  await discovery(url);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../../examples/agent-communication/stdio.mjs", import.meta.url)), path], { stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id: number) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "test" })}\n`);
    return JSON.parse((await lines.next()).value!);
  };
  return { discovery, call, path };
}
function ok(id = 1) { return JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }); }

describe("stdio discovery refresh", () => {
  it("reloads a changed endpoint after a network failure", async () => {
    const old = await server((_req, res) => res.end(ok()));
    const b = await bridge(old.url);
    expect((await b.call(1)).result).toBe("ok");
    await new Promise<void>((resolve) => old.instance.close(() => resolve()));
    const next = await server((_req, res) => res.end(ok(2)));
    await b.discovery(next.url);
    expect((await b.call(2)).result).toBe("ok");
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
    expect(calls).toBe(4);
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

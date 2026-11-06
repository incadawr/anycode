import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { startCapture } from "./capture-responses-stream.mjs";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("captures raw SSE bytes and request bodies while forwarding authentication only upstream", async () => {
  const raw = Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"思"}\r\n\r\ndata: [DONE]\n\n');
  let authorization: string | undefined;
  let upstreamPath: string | undefined;
  const upstream = createServer((req, res) => {
    authorization = req.headers.authorization;
    upstreamPath = req.url;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(raw.subarray(0, 33));
      res.end(raw.subarray(33));
    });
  });
  servers.push(upstream);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const dir = await mkdtemp(join(tmpdir(), "responses-capture-"));
  dirs.push(dir);
  const proxy = await startCapture({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, out: dir });
  servers.push(proxy);
  const baseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const body = JSON.stringify({ model: "gateway-model", stream: true });
  const response = await fetch(`${baseUrl}/v1/responses`, { method: "POST", body, headers: { authorization: "Bearer fixture-secret" } });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(raw);
  expect(authorization).toBe("Bearer fixture-secret");
  expect(upstreamPath).toBe("/v1/responses");
  const files = await readdir(dir);
  expect(files).toHaveLength(2);
  expect(await readFile(join(dir, files.find(name => name.endsWith(".request.json"))!), "utf8")).toBe(body);
  expect(await readFile(join(dir, files.find(name => name.endsWith(".response.sse"))!))).toEqual(raw);
  for (const name of files) {
    expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, name), "utf8"))).not.toContain("fixture-secret");
  }
  expect((await fetch(`${baseUrl}/other`)).status).toBe(404);
});

it.each([
  ["--out"], ["--out", "--port", "8787"], ["--out", "x", "--port"],
  ["--out", "x", "--port", "bad"], ["--out", "x", "--port", "65536"],
  ["--out", "x", "--port", "-1"], ["--out", ""],
  ["--out", "x", "--port", ""], ["--out", "x", "--upstream"],
  ["--out", "x", "--unknown", "value"],
])("prints usage for invalid flags %j", (...args) => {
  const result = spawnSync(process.execPath, ["scripts/capture-responses-stream.mjs", "--upstream", "https://gateway.example/v1", ...args], { encoding: "utf8", timeout: 2000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage:");
  expect(result.stderr).not.toContain("TypeError");
  expect(result.stderr).not.toContain("ERR_SOCKET_BAD_PORT");
  expect(result.stderr).not.toContain("./private-capture");
});

it("forwards response headers before the first upstream body byte", async () => {
  let release = () => {};
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    release = () => res.end("data: [DONE]\n\n");
  });
  servers.push(upstream);
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const dir = await mkdtemp(join(tmpdir(), "responses-capture-")); dirs.push(dir);
  const proxy = await startCapture({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, out: dir }); servers.push(proxy);
  const response = fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/responses`, { method: "POST", body: "{}" });
  const early = await Promise.race([response.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]);
  release();
  await (await response).text();
  expect(early).toBe(true);
});

it("reports startup errors without usage, stack or checkout path", () => {
  const result = spawnSync(process.execPath, ["scripts/capture-responses-stream.mjs", "--upstream", "https://gateway.example/v1", "--out", "package.json/child"], { encoding: "utf8", timeout: 2000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("ENOTDIR");
  expect(result.stderr).not.toContain("Usage:");
  expect(result.stderr).not.toContain(process.cwd());
  expect(result.stderr).not.toContain("    at ");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { providerProxyConfig } from "../src/main/provider-proxy-config.mjs";

if (!process.versions.electron) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-proxy-smoke-"));
  try {
    const electron = createRequire(import.meta.url)("electron");
    const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HOME: profile, ANYCODE_SMOKE_PROFILE: profile },
      stdio: "inherit", timeout: 30000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
} else {
  const { app, net, session } = await import("electron");
  app.setPath("userData", process.env.ANYCODE_SMOKE_PROFILE);
  app.setPath("sessionData", process.env.ANYCODE_SMOKE_PROFILE);
  void app.whenReady().then(async () => {
    const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    const close = server => new Promise(resolve => server.close(resolve));
    let directRequests = 0;
    let proxyRequests = 0;
    const target = createServer((_req, res) => { directRequests++; res.end("direct"); });
    const proxy = createServer((req, res) => {
      proxyRequests++;
      assert.equal(req.url, targetUrl);
      assert.equal(req.headers.authorization, "Bearer smoke-key");
      res.end("proxied");
    });
    const targetPort = await listen(target);
    const targetUrl = `http://127.0.0.1:${targetPort}/v1/models`;
    const proxyPort = await listen(proxy);
    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await close(unavailable);
    const request = partition => new Promise((resolve, reject) => {
      const req = net.request({ url: targetUrl, method: "GET", partition, session: session.fromPartition(partition, { cache: false }) });
      req.setHeader("Authorization", "Bearer smoke-key");
      req.on("response", res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    try {
      const failed = session.fromPartition("unreachable", { cache: false });
      await failed.setProxy(providerProxyConfig(`http=127.0.0.1:${unavailablePort}`));
      await assert.rejects(request("unreachable"));
      assert.equal(directRequests, 0);
      const working = session.fromPartition("working", { cache: false });
      await working.setProxy(providerProxyConfig(`http=127.0.0.1:${proxyPort}`));
      assert.equal(await request("working"), "proxied");
      assert.equal(proxyRequests, 1);
      assert.equal(directRequests, 0);
      console.log("PASS: loopback requests fail closed and use the selected proxy");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      await Promise.all([close(proxy), close(target)]);
      app.exit(process.exitCode ?? 0);
    }
  });
}

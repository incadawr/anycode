import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Explicitly started local diagnostic proxy; response bytes are saved before any SDK parsing. */
export async function startCapture({ upstream, out, port = 0 }) {
  const target = new URL(upstream);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error("Use an HTTP(S) upstream base URL without credentials, query or fragment");
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    let file;
    try {
      // This proxy deliberately accepts only Responses requests, with no client-controlled upstream.
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const name = `${Date.now()}-${++sequence}`;
      const request = [];
      for await (const chunk of req) request.push(chunk);
      const body = Buffer.concat(request);
      // Store request bodies to correlate model/options; never persist authentication headers.
      await writeFile(resolve(out, `${name}.request.json`), body, { mode: 0o600, flag: "wx" });
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined && !["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(key)) {
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const response = await fetch(`${target.href.replace(/\/$/, "")}/responses`, {
        method: "POST", headers, body, redirect: "error", signal: abort.signal,
      });
      file = createWriteStream(resolve(out, `${name}.response.sse`), { mode: 0o600, flags: "wx" });
      // Attach immediately: file errors must also interrupt a pending upstream read.
      file.on("error", () => abort.abort());
      await once(file, "open");
      const responseHeaders = Object.fromEntries([...response.headers].filter(([key]) =>
        !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)));
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        for await (const chunk of response.body) {
          if (!file.write(chunk)) await once(file, "drain");
          if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
        }
      }
      file.end();
      await once(file, "finish");
      res.end();
    } catch {
      abort.abort();
      file?.destroy();
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes("--upstream") || !args.includes("--out")) {
    console.error("Usage: node scripts/capture-responses-stream.mjs --upstream https://gateway.example/v1 --out ./private-capture [--port 8787]");
    process.exitCode = 1;
  } else {
    const server = await startCapture({ upstream: option("--upstream"), out: resolve(option("--out")), port: args.includes("--port") ? Number(option("--port")) : 8787 });
    console.log(`Capture proxy: http://127.0.0.1:${server.address().port}/v1`);
    console.log("Request bodies and response text are saved locally. Stop with Ctrl+C after reproducing.");
  }
}

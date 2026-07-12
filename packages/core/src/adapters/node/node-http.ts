/**
 * HttpPort adapter over global fetch (design §2.4): follows redirects, applies
 * the timeout via AbortSignal (combined with the caller's abortSignal when
 * given), and reads at most maxBytes of the (decompressed) body — overflow
 * cancels the stream early and sets `truncated`. Wired for WebFetch.
 */

import type { HttpPort, HttpTextRequest, HttpTextResponse } from "../../ports/http.js";

function capUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

/** Reads a fetch Response body, capping at maxBytes without buffering past the cap. */
async function readCappedBody(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    const capped = capUtf8Bytes(text, maxBytes);
    return { body: capped.text, truncated: capped.truncated };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (received + value.byteLength > maxBytes) {
      const remaining = maxBytes - received;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }

  if (truncated) {
    await reader.cancel().catch(() => undefined);
  } else {
    reader.releaseLock();
  }

  const bodyText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  return { body: bodyText, truncated };
}

export class NodeHttpAdapter implements HttpPort {
  async fetchText(req: HttpTextRequest): Promise<HttpTextResponse> {
    const timeoutSignal = AbortSignal.timeout(req.timeoutMs);
    const signal = req.abortSignal ? AbortSignal.any([req.abortSignal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(req.url, {
      headers: req.headers,
      redirect: "follow",
      signal,
    });

    const { body, truncated } = await readCappedBody(response, req.maxBytes);

    return {
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.url || req.url,
      contentType: response.headers.get("content-type"),
      body,
      truncated,
    };
  }
}

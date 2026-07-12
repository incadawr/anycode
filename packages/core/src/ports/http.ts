/**
 * HttpPort (design §2.4): tools never touch global fetch directly (ports
 * rule). The Node adapter (adapters/node/node-http.ts) implements it over
 * global fetch; WebFetch is the only Phase 1 consumer.
 */

export interface HttpTextRequest {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Response body cap in bytes; overflow sets `truncated`. */
  maxBytes: number;
  abortSignal?: AbortSignal;
}

export interface HttpTextResponse {
  status: number;
  statusText: string;
  /** URL after redirects. */
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export interface HttpPort {
  fetchText(req: HttpTextRequest): Promise<HttpTextResponse>;
}

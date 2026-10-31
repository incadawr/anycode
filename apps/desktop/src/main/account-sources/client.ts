import { accountBudgetSchema, accountCatalogSchema } from "@anycode/core/plugins-admin";

export class AccountHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) { super(`Account endpoint returned HTTP ${status}`); }
}

/** Read a bounded response, cancelling the wire as soon as the limit is exceeded. */
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty account response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("Account response too large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Called only after the current descriptor, binding and credential have been verified. */
export async function fetchAccountDocument(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  apiBaseUrl: string,
  endpoint: "catalog" | "budget",
  apiKey: string | undefined,
  signal: AbortSignal,
) {
  const base = new URL(apiBaseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL(endpoint, base);
  if (url.origin !== base.origin) throw new Error("Account origin mismatch");
  const response = await fetcher(url.href, {
    method: "GET", redirect: "error", signal,
    headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
  });
  if (!response.ok) { await response.body?.cancel(); throw new AccountHttpError(response.status, response.headers.get("retry-after")); }
  const raw = await boundedJson(response, endpoint === "catalog" ? 1024 * 1024 : 64 * 1024);
  return endpoint === "catalog" ? { kind: "catalog" as const, data: accountCatalogSchema.parse(raw) }
    : { kind: "budget" as const, data: accountBudgetSchema.parse(raw) };
}

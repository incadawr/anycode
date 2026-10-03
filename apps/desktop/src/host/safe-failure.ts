/** Raw engine text is used only to select a constant, never displayed or logged. */
const MESSAGES = {
  auth: "Sign-in failed or expired. Sign in again in Settings, then retry.",
  forbidden: "This account cannot use the selected model. Check account access or choose another model.",
  quota: "This account has reached its usage limit. Wait for it to reset or choose another account.",
  rate_limited: "Too many requests. Wait a moment, then retry.",
  proxy_unreachable: "Proxy unavailable. Check Network settings and that the proxy is running, then retry.",
  proxy_auth: "Proxy authentication failed. Check the proxy username and password in Network settings.",
  tls: "TLS certificate is not trusted. Configure NODE_EXTRA_CA_CERTS with your trusted CA certificate and restart AnyCode.",
  network: "The agent could not reach the service. Check Network settings and retry.",
  connect_timeout: "The service did not respond in time. Check Network settings and retry.",
  server: "The service failed to complete the request. Retry in a moment.",
  context_limit: "The conversation is too large for this model. Start a new task or choose a model with more context.",
  engine_connection: "The agent process disconnected. Start a new task; if it repeats, recheck the engine in Settings.",
  engine_protocol: "The agent returned an unsupported response. Recheck its version in Settings.",
  unknown: "The agent request failed. Retry or recheck the selected connection in Settings.",
} as const;

export type SafeFailureCode = keyof typeof MESSAGES;
export function safeFailureCode(code: string): SafeFailureCode {
  return Object.hasOwn(MESSAGES, code) ? code as SafeFailureCode : "unknown";
}
export function safeFailureMessage(code: string): string {
  return MESSAGES[safeFailureCode(code)];
}

export function classifyEngineFailure(error: unknown): { code: SafeFailureCode; message: string; statusCode?: number } {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.statusCode === "number" ? value.statusCode : typeof value.status === "number" ? value.status : undefined;
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let code: SafeFailureCode = "unknown";
  if (status === 401 || /authentication.failed|not signed in|unauthorized|auth.*expired|login required/i.test(text)) code = "auth";
  else if (status === 403 || /permission denied|organization.*not.*permit|forbidden/i.test(text)) code = "forbidden";
  else if (/quota|usage limit|billing.*(?:problem|error)|credit.*exhaust/i.test(text)) code = "quota";
  else if (status === 429 || /rate.?limit|too many requests/i.test(text)) code = "rate_limited";
  else if (/prompt.too.long|context.*(?:limit|length|exceed)|maximum.*tokens/i.test(text)) code = "context_limit";
  else if (/timeout|timed out/i.test(text)) code = "connect_timeout";
  else if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|cannot connect/i.test(text)) code = "network";
  else if ((status !== undefined && status >= 500 && status < 600) || /server error/i.test(text)) code = "server";
  else if (/transport.*clos|process.*exit|disconnected|broken pipe|EOF/i.test(text)) code = "engine_connection";
  else if (/protocol|unsupported|malformed|invalid.*response/i.test(text)) code = "engine_protocol";
  return { code, message: MESSAGES[code], ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { statusCode: status } : {}) };
}

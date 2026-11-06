import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import type { SystemProxyResolver } from "../shared/proxy.js";
import { registerSettingsIpc } from "./settings-ipc.js";
import type { ConnectionProbeOutcome } from "./settings-ipc.js";
import type { ProxyRoute } from "./provider-proxy-fetch.js";
import { prepareModelFetchContext } from "./model-fetch-guard.js";
import { isOpenCodeGoConnection } from "../shared/opencode-go-quota.js";
import { parseOpenCodeGoQuota } from "./opencode-go-quota-adapter.js";

// The existing quota endpoint authenticates without generating tokens.
const TARGET = "https://opencode.ai/zen/go/v1/usage";
export function createConnectionProbe(deps: {
  settings(): Promise<AnycodeSettings>;
  vault: { getSecretValue(key: SecretKey): Promise<string | undefined> };
  systemProxy?: SystemProxyResolver;
  fetch(route: ProxyRoute): (url: string, init: RequestInit) => Promise<Response>;
}) {
  return async (connection: ProviderConnection, credential: string): Promise<ConnectionProbeOutcome | undefined> => {
    if (!isOpenCodeGoConnection(connection)) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConnectionProbeOutcome>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, code: "connect_timeout" }); }, 10_000);
    });
    const run = async (): Promise<ConnectionProbeOutcome | undefined> => {
      try {
        const settings = await deps.settings();
        if (settings.provider.custom?.some(c => c.id === connection.providerId)) return undefined;
        const context = await prepareModelFetchContext(settings, connection, deps.vault, TARGET, deps.systemProxy);
        if (controller.signal.aborted) return { ok: false, code: "connect_timeout" };
        if (!context.ok || (context.route.kind === "direct" && context.route.why === "dangling-ref")) return { ok: false, code: "network" };
        if (context.apiKey !== credential) return undefined;
        const response = await deps.fetch(context.route)(TARGET, {
          method: "GET", headers: { Authorization: `Bearer ${credential}` },
          redirect: "error", signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, code: response.status === 401 ? "auth" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "server" : "unexpected_response" };
        }
        let body: unknown;
        try { body = await response.json(); }
        catch { return { ok: false, code: controller.signal.aborted ? "connect_timeout" : "unexpected_response" }; }
        return parseOpenCodeGoQuota(body, Date.now()) ? { ok: true } : { ok: false, code: "unexpected_response" };
      } catch { return { ok: false, code: controller.signal.aborted ? "connect_timeout" : "network" }; }
    };
    try { return await Promise.race([run(), timeout]); }
    finally { clearTimeout(timer); }
  };
}

/** Production composition, also exercised through the registered IPC callback. */
export function registerSettingsIpcWithProbe(
  deps: Parameters<typeof registerSettingsIpc>[0],
  probeDeps: Parameters<typeof createConnectionProbe>[0],
): void {
  registerSettingsIpc({ ...deps, probeConnection: createConnectionProbe(probeDeps) });
}

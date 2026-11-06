export interface GoQuotaWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface GoQuotaSnapshot {
  observedAt: string;
  windows: { rolling?: GoQuotaWindow; weekly?: GoQuotaWindow; monthly?: GoQuotaWindow };
}

export function isOpenCodeGoConnection(connection: { providerId: string; baseUrl?: string }): boolean {
  if (connection.providerId !== "opencode" && connection.providerId !== "opencode-openai") return false;
  const base = connection.baseUrl?.trim() || (connection.providerId === "opencode" ? "https://opencode.ai/inference/go/anthropic" : "https://opencode.ai/inference/go/openai/v1");
  try {
    const url = new URL(base);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname === "opencode.ai" && !url.search && !url.hash && /^\/inference\/go\/(?:anthropic(?:\/v1)?|openai\/v1)\/?$/.test(url.pathname);
  } catch { return false; }
}

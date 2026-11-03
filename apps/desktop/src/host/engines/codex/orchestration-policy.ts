/** Process-level policy: thread config alone does not disable ambient MCPs. */
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface BaseConfig {
  names: string[];
  ambientNames: string[];
  values: Map<string, unknown>;
  features: unknown;
  sandbox: unknown;
  approval: unknown;
}

export function captureBaseConfig(response: unknown, forwarded: Record<string, unknown> = {}): BaseConfig {
  const config = object(object(response)?.config);
  if (!config) throw new Error("Codex config/read returned no config");
  const servers = object(config.mcp_servers);
  if (!servers || (config.features !== undefined && !object(config.features))) throw new Error("Malformed Codex config inventory");
  for (const value of Object.values(servers)) if (!object(value)) throw new Error("Malformed Codex MCP inventory");
  const names = [...new Set([...Object.keys(servers), ...Object.keys(forwarded)])].sort();
  return { names, ambientNames: Object.keys(servers).sort(), values: new Map(names.map((name) => [name, object(servers[name])?.enabled])),
    features: object(config.features)?.multi_agent, sandbox: config.sandbox_mode, approval: config.approval_policy };
}

export function orchestrationOverrides(base: BaseConfig): string[] {
  return [...base.names.map((name) => `mcp_servers.${JSON.stringify(name)}.enabled=false`),
    "features.multi_agent=false", 'sandbox_mode="read-only"', 'approval_policy="never"'];
}

export function verifyConfig(response: unknown, base: BaseConfig, enabled: boolean): void {
  const current = captureBaseConfig(response);
  if (enabled) {
    if (current.names.length !== base.names.length || current.names.some((name, i) => name !== base.names[i]) ||
        base.names.some((name) => current.values.get(name) !== false) || current.features !== false ||
        current.sandbox !== "read-only" || current.approval !== "never") throw new Error("Codex orchestration config was not applied");
  } else if (current.ambientNames.length !== base.ambientNames.length || current.ambientNames.some((name, i) => name !== base.ambientNames[i]) || base.names.some((name) => current.values.get(name) !== base.values.get(name)) ||
      current.features !== base.features || current.sandbox !== base.sandbox || current.approval !== base.approval) {
    throw new Error("Codex base config was not restored");
  }
}

export function verifyReadOnlyEcho(response: unknown): void {
  const result = object(response);
  const sandbox = object(result?.sandbox);
  if (result?.approvalPolicy !== "never" || sandbox?.type !== "readOnly" || sandbox.networkAccess !== false) {
    throw new Error("Codex did not confirm read-only orchestration policy");
  }
}

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
  apps: Map<string, unknown>;
  plugins: unknown;
  remotePlugin: unknown;
}

export function requireCompleteReadback(response: unknown): void {
  const config = object(object(response)?.config);
  const features = object(config?.features);
  if (!config || (config.features != null && !features) ||
      (features?.multi_agent !== undefined && typeof features.multi_agent !== "boolean") ||
      (config.sandbox_mode != null && (typeof config.sandbox_mode !== "string" || !config.sandbox_mode)) ||
      (config.approval_policy != null && (typeof config.approval_policy !== "string" || !config.approval_policy))) throw new Error("Incomplete Codex config readback");
}

export function captureBaseConfig(response: unknown, forwarded: Record<string, unknown> = {}): BaseConfig {
  const result = object(response);
  const config = object(result?.config);
  if (!config) throw new Error("Codex config/read returned no config");
  const servers = object(config.mcp_servers);
  if (!servers || (config.features !== undefined && !object(config.features))) throw new Error("Malformed Codex config inventory");
  for (const value of Object.values(servers)) if (!object(value)) throw new Error("Malformed Codex MCP inventory");
  // 0.166.0 exposes AppsConfig/AppConfig, but no plugin config schema.
  // Fail closed for plugin configuration until its override is established.
  const unsupportedPlugins = (value: Record<string, unknown>, featureFlags = false): boolean => Object.entries(value).some(([key, entry]) =>
    !(featureFlags && key === "remote_plugin" && typeof entry === "boolean") && /plugin/i.test(key) && entry != null && entry !== false && (!object(entry) || Object.keys(object(entry)!).length > 0));
  const layers = result?.layers;
  if (layers != null && (!Array.isArray(layers) || layers.some((layer) => !object(layer) || !object(object(layer)?.config)))) {
    throw new Error("Codex orchestration unavailable: malformed config layers");
  }
  if (unsupportedPlugins(config) || unsupportedPlugins(object(config.features) ?? {}, true) ||
      (Array.isArray(layers) && layers.some((layer) => {
        const layerConfig = object(object(layer)?.config)!;
        return unsupportedPlugins(layerConfig) || unsupportedPlugins(object(layerConfig.features) ?? {}, true);
      }))) {
    throw new Error("Codex orchestration unavailable: unsupported plugins configuration");
  }
  const remotePlugin = object(config.features)?.remote_plugin;
  if (remotePlugin !== undefined && typeof remotePlugin !== "boolean") throw new Error("Codex orchestration unavailable: malformed remote plugin flag");
  const apps = config.apps == null ? {} : object(config.apps);
  if (!apps) throw new Error("Codex orchestration unavailable: unsupported apps configuration");
  const appValues = new Map<string, unknown>();
  for (const [name, value] of Object.entries(apps)) {
    if (name === "_default" && value == null) continue;
    const entry = object(value);
    if (!entry || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) {
      throw new Error("Codex orchestration unavailable: unsupported apps configuration");
    }
    appValues.set(name, entry.enabled);
  }
  const names = [...new Set([...Object.keys(servers), ...Object.keys(forwarded)])].sort();
  if ([...names, ...appValues.keys()].some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) {
    throw new Error("Codex orchestration unavailable: unsupported config name");
  }
  return { names, ambientNames: Object.keys(servers).sort(), values: new Map(names.map((name) => [name, object(servers[name])?.enabled])),
    features: object(config.features)?.multi_agent, sandbox: config.sandbox_mode, approval: config.approval_policy,
    apps: appValues, plugins: config.plugins, remotePlugin };
}

export function orchestrationOverrides(base: BaseConfig): string[] {
  // A forwarded-only server has no process-level transport to merge with.
  // Supply an inert stdio transport; never expose forwarded credentials on argv.
  const transports = base.names.filter((name) => !base.ambientNames.includes(name))
    .map((name) => `mcp_servers.${name}.command="anycode-disabled-mcp"`);
  return [...transports, ...base.names.map((name) => `mcp_servers.${name}.enabled=false`),
    ...[...new Set(["_default", ...base.apps.keys()])].map((name) => `apps.${name}.enabled=false`),
    "features.multi_agent=false", "features.remote_plugin=false", 'sandbox_mode="read-only"', 'approval_policy="never"'];
}

export function verifyConfig(response: unknown, base: BaseConfig, enabled: boolean): void {
  const current = captureBaseConfig(response);
  if (enabled) {
    // config/read confirms the flag, not the model-facing native delegation tool inventory.
    if (current.names.length !== base.names.length || current.names.some((name, i) => name !== base.names[i]) ||
        base.names.some((name) => current.values.get(name) !== false) || current.features !== false || current.remotePlugin !== false ||
        current.apps.get("_default") !== false || [...base.apps.keys()].some((name) => current.apps.get(name) !== false) ||
        [...current.apps.values()].some((value) => value !== false) ||
        current.sandbox !== "read-only" || current.approval !== "never") throw new Error("Codex orchestration config was not applied");
  } else if (current.ambientNames.length !== base.ambientNames.length || current.ambientNames.some((name, i) => name !== base.ambientNames[i]) || base.names.some((name) => current.values.get(name) !== base.values.get(name)) ||
      current.apps.size !== base.apps.size || [...base.apps].some(([name, value]) => !current.apps.has(name) || current.apps.get(name) !== value) || JSON.stringify(current.plugins) !== JSON.stringify(base.plugins) ||
      current.features !== base.features || current.remotePlugin !== base.remotePlugin || current.sandbox !== base.sandbox || current.approval !== base.approval) {
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

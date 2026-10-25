/**
 * Plugins module barrel (Phase 3 slice 3.3 + Taskana 4732 S1-A). Manifest
 * v1 (schema + derived capabilities), tiered discovery (managed store from
 * state.json), and the managed-store state file primitives.
 */

export {
  pluginManifestSchema,
  pluginWorkflowsDirs,
  capabilities,
  declaresOfficialOnly,
  MANIFEST_VERSION,
  OFFICIAL_ONLY_CONTRIBUTIONS,
  PLUGIN_NAME_RE,
} from "./manifest.js";
export type { PluginManifest, PluginCapabilities } from "./manifest.js";
export { discoverPlugins } from "./discovery.js";
export type {
  DiscoverPluginsOptions,
  PluginDiscoveryResult,
  PluginTier,
} from "./discovery.js";
export {
  PLUGIN_STATE_FILE,
  PLUGIN_STATE_VERSION,
  canonicalJson,
  emptyPluginState,
  hasMcpConsent,
  pluginsStateSchema,
  pluginTrustSchema,
  readPluginState,
  serversHash,
  writePluginState,
} from "./state.js";
export type {
  McpConsentEntry,
  PluginStateEntry,
  PluginTrust,
  PluginStateReadResult,
  PluginsState,
} from "./state.js";

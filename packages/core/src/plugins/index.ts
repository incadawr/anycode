/**
 * Plugins-lite module barrel (Phase 3 slice 3.3). Manifest shape (task 3.3.1
 * scaffold) + discovery (task 3.3.4).
 */

export { pluginManifestSchema } from "./manifest.js";
export type { PluginManifest } from "./manifest.js";
export { discoverPlugins } from "./discovery.js";
export type { DiscoverPluginsOptions, PluginDiscoveryResult } from "./discovery.js";

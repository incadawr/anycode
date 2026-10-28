/**
 * Host wiring for the plugin runtime (Taskana 4732 xfix C1/C2/H1(a)): the ONE
 * place that turns settings + the builtin name sets into the discovery options
 * host/index.ts hands to `discoverExtensions`. Kept pure so the wiring is
 * unit-testable without booting the host.
 */

import { defaultPluginStatePath, type McpConsentEntry } from "@anycode/core/plugins-admin";

export interface PluginsDiscoveryWiringInput {
  /** The home the user-tier roots use (`resolveExtensionsHomeOverride ?? homedir()`). */
  home: string;
  /** The settings `plugins` block; undefined = the block is absent or unreadable. */
  pluginsSettings: { mcpConsent?: readonly McpConsentEntry[] } | undefined;
  /** Every builtin skill name the host registers (buildHostBuiltinSkills). */
  builtinSkillNames: readonly string[];
  /** Builtin persona (agent profile) names (core PERSONAS keys). */
  builtinPersonaNames: readonly string[];
}

export interface PluginsDiscoveryWiring {
  pluginStatePath: string;
  /** Always present: undefined consent means DENY until granted (never legacy allow-all). */
  mcpConsent: readonly McpConsentEntry[];
  reservedSkillNames: ReadonlySet<string>;
  reservedAgentNames: ReadonlySet<string>;
}

export function pluginsDiscoveryWiring(input: PluginsDiscoveryWiringInput): PluginsDiscoveryWiring {
  return {
    // The managed store's state.json lives under the SAME home the roots use.
    pluginStatePath: defaultPluginStatePath(input.home),
    // `?? []` ACTIVATES the consent gate: discovery treats an undefined list as
    // the legacy "servers contribute with no consent" posture. A fresh install
    // has no array, so the default must be deny-until-consent.
    mcpConsent: input.pluginsSettings?.mcpConsent ?? [],
    // Third-party/local/project/legacy plugins may not shadow these names
    // (design §4/§9.5); official plugins may.
    reservedSkillNames: new Set(input.builtinSkillNames),
    reservedAgentNames: new Set(input.builtinPersonaNames),
  };
}

/** What the Skills pane's `registerSkillsIpc` dependency hands plugin discovery. */
export interface SkillsPaneDiscoveryOptions {
  pluginStatePath: string;
  appVersion: string;
  reservedSkillNames: ReadonlySet<string>;
  reservedAgentNames: ReadonlySet<string>;
}

export interface SkillsPaneDiscoveryInput extends PluginsDiscoveryWiringInput {
  /** The running app's version — gates `engines.anycode`. */
  appVersion: string;
}

/**
 * The plugin discovery options the Skills pane registers with
 * `registerSkillsIpc` (main/index.ts). Extracted so the PRODUCTION wiring is
 * covered by a test instead of being re-implemented next to it: the state path
 * is load-bearing — drop it and a plugin the user switched OFF starts reporting
 * its problems in the Skills pane again, while every handler-level test that
 * builds its own options still passes.
 *
 * `mcpConsent` is deliberately dropped: an un-granted plugin MCP server is the
 * MCP pane's problem, and forwarding the consent gate here would turn "needs
 * approval" into a Skills-pane warning.
 */
export function skillsPaneDiscoveryOptions(input: SkillsPaneDiscoveryInput): SkillsPaneDiscoveryOptions {
  const wiring = pluginsDiscoveryWiring(input);
  return {
    pluginStatePath: wiring.pluginStatePath,
    appVersion: input.appVersion,
    reservedSkillNames: wiring.reservedSkillNames,
    reservedAgentNames: wiring.reservedAgentNames,
  };
}

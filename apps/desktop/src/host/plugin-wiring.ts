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

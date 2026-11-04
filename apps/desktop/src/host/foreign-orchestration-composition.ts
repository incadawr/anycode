import { isRoleRouteName, isReservedPersonaName, runAgentBridgeCall, type AgentBridgeCallDeps, type AgentBridgeCallInput, type AgentBridgeCatalogEntry, type PersonaDefinition, type RoleRouteEntry, type RoleRouteResolution, type SessionSubagentPort } from "@anycode/core";
import { activeConnection, resolveProviderConnection, type AnycodeSettings } from "../shared/settings.js";
import { resolveProfileRoles } from "../shared/role-profiles.js";
import { roleCatalog } from "./role-catalog.js";
import { entryLabel, resolveRoleRouteChain, type RoleHealthCache } from "./role-route.js";
import type { createRoutedChildComposition } from "./routed-child-composition.js";
import { createForeignSpawnModeCell } from "./spawn-mode-cell.js";
import { codexAgentPermissionMode } from "./engines/codex/dynamic-tool-bridge.js";

export function selectedCodexPreset(engine: { snapshot(): { activePresetId: string }; pendingSnapshot(): { activePresetId: string } | null }): string {
  return (engine.pendingSnapshot() ?? engine.snapshot()).activePresetId;
}

/** Composition for a native root. The overlay owner calls capture/clear at its verified transition boundary. */
export function createForeignOrchestrationComposition(options: {
  settings(): AnycodeSettings | undefined;
  profiles(): Promise<readonly PersonaDefinition[]>;
  projectRoot: string;
  preset(): string;
  health: RoleHealthCache;
  routed: ReturnType<typeof createRoutedChildComposition>;
}) {
  const authority = createForeignSpawnModeCell(() => codexAgentPermissionMode(options.preset()));
  let enabled = false;
  const facts = new WeakMap<AgentBridgeCatalogEntry, { settings: AnycodeSettings | undefined; claimed: boolean }>();

  async function catalog(): Promise<AgentBridgeCatalogEntry[]> {
    const [profiles, settings] = await Promise.all([options.profiles(), Promise.resolve(options.settings())]);
    const claimed = new Set(profiles.filter(p => !isReservedPersonaName(p.name)).map(p => p.name));
    const entries = roleCatalog(profiles, settings ? resolveProfileRoles(settings, options.projectRoot) : undefined);
    for (const entry of entries) facts.set(entry, { settings, claimed: claimed.has(entry.name) });
    return entries;
  }

  function target(entry: RoleRouteEntry, settings: AnycodeSettings | undefined, explicitModel?: string): RoleRouteEntry | undefined {
    if (entry.engine !== undefined) return { ...entry };
    if (!settings) return undefined;
    const connection = entry.connection !== undefined
      ? settings.provider.connections.find(c => c.id === entry.connection)
      : entry.provider !== undefined ? resolveProviderConnection(settings, entry.provider) : activeConnection(settings);
    const model = entry.model ?? connection?.model ?? explicitModel;
    if (!connection || !model?.trim()) return undefined;
    return { connection: connection.id, model, ...(entry.effort !== undefined ? { effort: entry.effort } : {}) };
  }

  async function call(input: AgentBridgeCallInput, deps: AgentBridgeCallDeps) {
    const entry = deps.catalog.find(e => e.name === input.agent_type);
    const context = entry && facts.get(entry);
    let snapshot: RoleRouteResolution | undefined;
    const resolver = (role: import("@anycode/core").RoleRouteName): RoleRouteResolution => {
      const roles = context?.settings ? resolveProfileRoles(context.settings, options.projectRoot) : undefined;
      const config = context?.claimed ? undefined : roles?.[role];
      const source: RoleRouteEntry[] = config ? [config.primary, ...(config.fallbacks ?? [])] : [{
        ...(entry?.engine ? { engine: entry.engine } : {}), ...(entry?.connection ? { connection: entry.connection } : {}),
        ...(entry?.provider ? { provider: entry.provider } : {}), ...(entry?.model ? { model: entry.model } : {}),
        ...(entry?.effort ? { effort: entry.effort } : {}),
      }];
      const restricted = entry?.restrictions !== undefined;
      const candidates = source.map(item => {
        // A native engine child cannot enforce a restricted role's read-only
        // rules, so engine entries never qualify for one.
        const blockedEngine = restricted && item.engine !== undefined ? item.engine : undefined;
        return { item, blockedEngine, resolved: blockedEngine === undefined ? target(item, context?.settings, input.model) : undefined };
      });
      const valid = candidates.flatMap(candidate => candidate.resolved ? [candidate.resolved] : []);
      const resolved = valid[0] ? resolveRoleRouteChain({
        role, config: { primary: valid[0], fallbacks: valid.slice(1) }, claimedByMdProfile: false,
        health: options.health.snapshot(), now: Date.now(),
      }) : null;
      const head = resolved?.entries[0];
      const pickedIndex = head ? valid.findIndex(item => item.engine === head.engine && item.connection === head.connection && item.provider === head.provider && item.model === head.model && item.effort === head.effort) : -1;
      const skipped: { entry: RoleRouteEntry; reason: string }[] = [];
      let validIndex = 0;
      for (const candidate of candidates) {
        if (candidate.blockedEngine !== undefined) {
          skipped.push({ entry: candidate.item, reason: `engine ${candidate.blockedEngine} cannot enforce this role's read-only restrictions` });
        } else if (candidate.resolved === undefined) {
          skipped.push({ entry: candidate.item, reason: "connection or model is unavailable; configure the role" });
        } else if (validIndex === pickedIndex) break;
        else {
          const unhealthy = resolved?.skipped[validIndex];
          if (unhealthy) skipped.push(unhealthy);
          validIndex++;
        }
      }
      snapshot = { entries: resolved?.entries ?? [], skipped };
      return snapshot;
    };
    const original = deps.port;
    const port: SessionSubagentPort = {
      ...original,
      run(req, opts) {
        if (snapshot && req.routeStamped) options.routed.snapshot(req, snapshot);
        // Custom core profiles cannot inherit a Codex model as an API model.
        if (!isRoleRouteName(req.agentType) && !req.engine && !req.resumeChildSessionId) {
          const resolved = target({ ...(req.connectionId ? { connection: req.connectionId } : {}), ...(req.provider ? { provider: req.provider } : {}), ...(req.model ? { model: req.model } : {}) }, context?.settings);
          if (!resolved) return Promise.resolve({ status: "error" as const, finalText: "Agent: no usable API connection or model. Configure the agent profile.", turns: 0, toolCalls: 0, durationMs: 0, truncated: false, childSessionId: "", parentSessionId: "", spawnToolCallId: req.spawnToolCallId });
          const { provider: _provider, ...rest } = req;
          return original.run({ ...rest, connectionId: resolved.connection, model: resolved.model }, opts);
        }
        return original.run(req, opts);
      },
      send: original.send.bind(original),
    };
    const result = await runAgentBridgeCall(input, { ...deps, claimedRoles: context?.claimed ? new Set([input.agent_type]) : undefined, port, policy: { resolveRoleRoute: resolver, defaultDetach: enabled } });
    const selected: RoleRouteResolution | undefined = snapshot;
    if (selected && selected.entries[0] && selected.skipped.length && !result.isError) {
      return { ...result, text: `Role ${input.agent_type} ran on ${entryLabel(selected.entries[0])} because ${selected.skipped[0]!.reason}.\n${result.text}` };
    }
    return result;
  }
  return {
    catalog, call,
    childMode: () => authority.read(),
    captureBaseAuthority(preset: string) { authority.capture(codexAgentPermissionMode(preset)); enabled = true; },
    clearBaseAuthority() { authority.clear(); enabled = false; },
  };
}

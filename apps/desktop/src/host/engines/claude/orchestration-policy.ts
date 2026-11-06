import { orchestrationDeveloperBlock } from "@anycode/core";
import { permissionModeToFlag } from "./protocol.js";

export type ClaudeOrchestrationPosture = "off" | "on" | "transitioning" | "quarantined";
export const CLAUDE_ORCHESTRATION_TOOLS = Object.freeze([
  "Read", "Glob", "Grep", "mcp__anycode__agent", "mcp__anycode__agent_status",
]);
const equivalenceFields = ["authSource", "provider", "baseUrl", "model", "env", "apiKeyHelper"] as const;
const settingSources = ["user", "project", "local", "plugins"] as const;
export interface ClaudeOrchestrationFacts {
  version?: string;
  equivalence?: Partial<Record<typeof equivalenceFields[number], string>>;
  suppression?: Partial<Record<typeof settingSources[number], string>>;
  managed?: { state?: string; hooks?: boolean; permissions?: boolean };
  prePayload?: string;
}
// No native version has qualified live evidence. Synthetic fixtures cannot grant admission.
const qualifiedVersions: readonly string[] = Object.freeze([]);
export function claudeOrchestrationAvailability(enabled: boolean, version: string, facts: ClaudeOrchestrationFacts = {}) {
  const reasons: string[] = [];
  if (!enabled) reasons.push("Claude orchestration is disabled.");
  if (facts.version !== version) reasons.push("Settings evidence does not match the Claude version.");
  for (const key of equivalenceFields) if (facts.equivalence?.[key] !== "equal") reasons.push(`Verify unchanged ${key} across OFF/ON/OFF.`);
  for (const key of settingSources) if (facts.suppression?.[key] !== "verified") reasons.push(`Verify suppression of ${key} execution surfaces.`);
  if (!["absent", "safe-verified"].includes(facts.managed?.state ?? "") || facts.managed?.hooks !== false || facts.managed?.permissions !== false)
    reasons.push("Managed policy is unknown or contains hooks/permissions; orchestration is unavailable.");
  if (facts.prePayload !== "verified") reasons.push("Verify the spawn contract before sending a payload.");
  if (!qualifiedVersions.includes(version)) reasons.push("No live orchestration capability proof qualifies this Claude version.");
  return reasons.length ? { supported: false as const, reason: reasons.join(" ") } : { supported: true as const };
}

const issued = new WeakSet<object>();
export interface ClaudeOrchestrationSpawnSnapshot {
  readonly version: string;
  readonly permissionMode: "default";
}
/** Issue only after native capability and settings gates, before stopping the old transport. */
export function prepareClaudeOrchestrationSpawn(enabled: boolean, version: string, facts: ClaudeOrchestrationFacts): ClaudeOrchestrationSpawnSnapshot {
  const gate = claudeOrchestrationAvailability(enabled, version, facts);
  if (!gate.supported) throw new Error(gate.reason);
  const snapshot = Object.freeze({ version, permissionMode: "default" as const });
  issued.add(snapshot);
  return snapshot;
}
/** Fixed host-owned spawn inputs; caller-provided argv is never accepted. */
export function claudeOrchestrationSpawnOptions(snapshot: ClaudeOrchestrationSpawnSnapshot) {
  if (!issued.has(snapshot)) throw new Error("Unverified Claude orchestration spawn snapshot");
  return {
    permissionModeFlag: permissionModeToFlag(snapshot.permissionMode),
    enableSlashPassthrough: false,
    settingSources: "",
    mcpConfig: '{"mcpServers":{}}',
    tools: "Read,Glob,Grep",
    settings: '{"disableAllHooks":true}',
    appendPrompt: orchestrationDeveloperBlock("claude"),
  };
}
export function assertClaudeOrchestrationReadback(init: {
  claude_code_version?: string; permissionMode?: string; tools?: readonly string[];
  skills?: readonly unknown[]; slash_commands?: readonly unknown[]; mcp_servers?: readonly { name: string }[];
}, snapshot: ClaudeOrchestrationSpawnSnapshot, peerToolNames: ReadonlySet<string> = new Set()): void {
  const allowed = [...CLAUDE_ORCHESTRATION_TOOLS, ...peerToolNames];
  const tools = init.tools;
  if (init.claude_code_version !== snapshot.version || init.permissionMode !== "default"
    || !tools || tools.length !== allowed.length || new Set(tools).size !== tools.length
    || tools.some(tool => !allowed.includes(tool))
    || init.skills?.length !== 0 || init.slash_commands?.length !== 0
    || init.mcp_servers?.length !== 1 || init.mcp_servers[0]?.name !== "anycode")
    throw new Error("Claude orchestration posture drift");
}
export function claudeOrchestrationDeniesTool(restricted: boolean, tool: string, ownedBridge: boolean): boolean {
  return restricted && !(ownedBridge && (tool === "mcp__anycode__agent" || tool === "mcp__anycode__agent_status"));
}

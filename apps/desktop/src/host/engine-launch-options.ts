import type { CoreEngineOptions } from "./engines/core-engine.js";
import type { CodexEngineCreateOptions } from "./engines/codex/codex-engine.js";
import type { ClaudeEngineCreateOptions } from "./engines/claude/claude-engine.js";

export type CodexLaunchOptions = Omit<CodexEngineCreateOptions, "bootstrap">;
export type ClaudeLaunchOptions = Omit<ClaudeEngineCreateOptions, "bootstrap">;

import type { parseHostArgs } from "./boot.js";
import type { SessionPermissionRules } from "@anycode/core";
import { codexChildAutoAcceptsWorkspacePatches } from "./engines/child-permission-map.js";
import { CLAUDE_AGENT_BRIDGE_PROMPT } from "./engines/claude/claude-client.js";
import type { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";

type Child = ReturnType<typeof parseHostArgs>["child"];
interface CommonLaunchContext {
  workspace: string;
  binaryPath: string;
  sourceEnv: NonNullable<CodexLaunchOptions["sourceEnv"]>;
  binaryTrust: NonNullable<CodexLaunchOptions["binaryTrust"]>;
  processOwnership?: CodexLaunchOptions["processOwnership"];
  child?: Child;
}

export interface CodexLaunchContext extends CommonLaunchContext {
  broker: CodexLaunchOptions["broker"];
  fs: NonNullable<CodexLaunchOptions["patchAutoApproval"]>["fs"];
  rules: SessionPermissionRules;
  agentBridge?: CodexLaunchOptions["agentBridge"];
  agentCardLog?: CodexLaunchOptions["agentCardLog"];
  shadowLog?: CodexLaunchOptions["shadowLog"];
  persistOrchestrationThreadId?: CodexLaunchOptions["persistOrchestrationThreadId"];
  onMcpNotification?: CodexLaunchOptions["onMcpNotification"];
  tempDir?: string;
  profile: { home: string; homeTrust: NonNullable<CodexLaunchOptions["homeTrust"]> } | null;
  forwardOptions: Pick<CodexLaunchOptions, "mcpForward">;
}

/** Build runtime-owned launch inputs while borrowing this session's services. */
export function buildCodexLaunchOptions(ctx: CodexLaunchContext): CodexLaunchOptions {
  const { workspace, binaryPath, sourceEnv, binaryTrust, processOwnership, child, broker,
    fs, rules, agentBridge, agentCardLog, shadowLog, persistOrchestrationThreadId,
    onMcpNotification, tempDir, profile, forwardOptions } = ctx;
  return {
    broker,
    patchAutoApproval: {
      fs,
      workspaceWritesAllowed: child !== undefined && codexChildAutoAcceptsWorkspacePatches(child.initialMode),
      rules,
    },
    binaryPath,
    cwd: workspace,
    workspace,
    ...(child?.maxTurns !== undefined
      ? {
          bootNotices: [
            {
              type: "engine_notice" as const,
              level: "warning" as const,
              message: `Profile maxTurns (${child.maxTurns}) is not enforced for the codex engine; the child is bounded only by its time/stall limits.`,
            },
          ],
        }
      : {}),
    ...(agentBridge ? { agentBridge } : {}),
    agentCardLog,
    ...(persistOrchestrationThreadId ? { persistOrchestrationThreadId } : {}),
    ...(onMcpNotification ? { onMcpNotification } : {}),
    sourceEnv: { ...sourceEnv },
    shadowLog,
    binaryTrust,
    ...(processOwnership !== undefined ? { processOwnership } : {}),
    ...(tempDir !== undefined ? { tempDir } : {}),
    ...(profile !== null
      ? {
          codexHome: profile.home,
          homeTrust: profile.homeTrust,
        }
      : {}),
    ...forwardOptions,
  };
}

export interface ClaudeLaunchContext extends CommonLaunchContext {
  orchestrationFeatureEnabled?: boolean;
  orchestrationSpawn?: ClaudeLaunchOptions["orchestrationSpawn"];
  orchestrationRestricted?: ClaudeLaunchOptions["orchestrationRestricted"];
  broker: ClaudeLaunchOptions["broker"];
  projectTrusted: boolean;
  profileDir?: string;
  mcpConfigPath?: string | null;
  resolveMcpForward?: ClaudeLaunchOptions["resolveMcpForward"];
  bootNotices: NonNullable<ClaudeLaunchOptions["bootNotices"]>;
  mcpBridge?: ClaudeLaunchOptions["mcpBridge"];
  stamp?: ReturnType<typeof createBridgePresentationStamp>;
  agentCatalogNonEmpty: boolean;
  browserToolNames?: ReadonlySet<string>;
  peerToolNames?: ReadonlySet<string>;
}

export function buildClaudeLaunchOptions(ctx: ClaudeLaunchContext): ClaudeLaunchOptions {
  const { workspace, binaryPath, sourceEnv, binaryTrust, processOwnership, child, broker,
    projectTrusted, profileDir, mcpConfigPath, resolveMcpForward, bootNotices, mcpBridge, stamp,
    agentCatalogNonEmpty, browserToolNames, peerToolNames } = ctx;
  return {
    broker,
    binaryPath,
    cwd: workspace,
    ...(child?.maxTurns !== undefined ? { maxTurns: child.maxTurns } : {}),
    enableSlashPassthrough: child === undefined,
    orchestrationFeatureEnabled: child === undefined && ctx.orchestrationFeatureEnabled === true,
    ...(child === undefined && ctx.orchestrationFeatureEnabled === true ? { orchestrationSpawn: ctx.orchestrationSpawn, orchestrationRestricted: ctx.orchestrationRestricted } : {}),
    projectTrusted,
    profileDir,
    sourceEnv: { ...sourceEnv },
    binaryTrust,
    ...(processOwnership !== undefined ? { processOwnership } : {}),
    ...(mcpConfigPath != null ? { mcpConfigPath } : {}),
    ...(resolveMcpForward !== undefined ? { resolveMcpForward } : {}),
    ...(bootNotices.length > 0 ? { bootNotices: bootNotices } : {}),
    ...(mcpBridge !== undefined && stamp !== undefined
      ? {
          mcpBridge,
          ...(agentCatalogNonEmpty
            ? { agentBridgePrompt: CLAUDE_AGENT_BRIDGE_PROMPT }
            : {}),
          takePresentation: stamp.takePresentation,
          dropPresentations: stamp.dropPresentations,
          browserToolNames, peerToolNames,
        }
      : {}),
  };
}

export function buildCoreLaunchOptions(
  runtime: Pick<CoreEngineOptions, "loop" | "config">,
  controls: Omit<CoreEngineOptions, "loop" | "config"> = {},
): CoreEngineOptions {
  // The loop and controls must share this exact mutable config, including at boot.
  return { ...controls, ...runtime };
}

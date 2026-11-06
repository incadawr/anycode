/** Read only in main; connection environments and renderer selections are not authorities. */
export function claudeOrchestrationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ANYCODE_CLAUDE_ORCHESTRATE_ENABLED === "1";
}

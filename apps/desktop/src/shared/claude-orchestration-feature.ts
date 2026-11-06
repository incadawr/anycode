/** Main-owned launch intent only; native policy readiness is a separate gate. */
export const CLAUDE_ORCHESTRATE_ARG = "--claude-orchestrate-enabled";

export function claudeOrchestrationBootEnabled(argv: readonly string[]): boolean {
  return argv.includes(CLAUDE_ORCHESTRATE_ARG);
}

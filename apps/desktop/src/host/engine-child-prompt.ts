const NO_DELEGATION = "Delegation (subagents) is unavailable in this child; do the work with your current tools and report any unmet need to your parent.";

export function engineChildPrompt(prompt: string, hasAgentBridge: boolean): string {
  return hasAgentBridge ? prompt : `${NO_DELEGATION}\n\n${prompt}`;
}

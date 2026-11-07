import { limitSubagentBashOutput, subagentContextWindow, type ToolRegistry } from "@anycode/core";

export function sessionContextWindow(child: boolean, tokens: number): number;
export function sessionContextWindow(child: boolean, tokens: number | undefined): number | undefined;
export function sessionContextWindow(child: boolean, tokens: number | undefined): number | undefined {
  return child ? subagentContextWindow(tokens) : tokens;
}

export function applySessionChildToolBudget(child: boolean, registry: ToolRegistry): void {
  if (child) limitSubagentBashOutput(registry);
}

export function sessionChildCeiling(child: boolean): { enabled: false } | undefined {
  return child ? { enabled: false } : undefined;
}

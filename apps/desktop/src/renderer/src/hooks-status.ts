import type { CommandHookDeclaration } from "@anycode/core";
import { groupHooksByEvent } from "./components/HooksPanel.js";

/** "3 hooks (PreToolUse 1, PostToolUse 2)" / "None" — reuses HooksPanel's stable event order. */
export function formatEnvironmentHooksDetail(hooks: readonly CommandHookDeclaration[]): string {
  if (hooks.length === 0) return "None";
  const groups = groupHooksByEvent(hooks);
  const parts = groups.map((g) => `${g.event} ${g.count}`).join(", ");
  return `${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"} (${parts})`;
}

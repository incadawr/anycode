/**
 * Spawn-capable tool names withheld from every child registry (non-recursion
 * lock #1, design §2.5/§3.5). A child subagent — and, transitively, a workflow
 * step's child — never sees an Agent OR Workflow declaration, so it cannot even
 * propose recursion; combined with lock #2 (the child config carries neither
 * port) this keeps the spawn depth pinned at 1. Skill is deliberately NOT here:

 *
 * ⚠ Leaf module (P7.21 W1, design §2-D8): extracted out of `subagents/runner.ts`
 * so `subagents/profiles.ts` (and the main-safe `@anycode/core/subagents-admin`
 * surface built atop it) can consume the single-source SPAWN_TOOLS set WITHOUT
 * importing the runner and dragging `loop/agent-loop.ts` into the Electron main
 * process. `runner.ts` re-exports this const byte-compatibly.
 */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Workflow"]);

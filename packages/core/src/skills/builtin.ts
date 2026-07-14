import type { SkillMeta } from "../ports/skills.js";

/**
 * A trusted, in-memory skill supplied by an application surface. Built-ins
 * are opt-in discovery inputs, not global system-prompt policy, and always
 * sit below project, user, and plugin skills in name precedence.
 */
export interface BuiltinSkillDefinition {
  name: string;
  description: string;
  body: string;
}

export const BUILTIN_SKILL_SOURCE = "builtin";

export function builtinSkillPath(name: string): string {
  return `builtin://${name}/SKILL.md`;
}

export function builtinSkillMeta(skill: BuiltinSkillDefinition): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    source: BUILTIN_SKILL_SOURCE,
    path: builtinSkillPath(skill.name),
  };
}

/**
 * Optional guidance for desktop surfaces that register EnterWorktree and
 * ExitWorktree. The skill recommends the capability; it never performs Git
 * operations itself and is deliberately absent unless the caller opts in.
 */
export const USING_GIT_WORKTREES_SKILL: BuiltinSkillDefinition = {
  name: "using-git-worktrees",
  description:
    "Use EnterWorktree and ExitWorktree when isolated Git work is requested or useful.",
  body: `# Using Git worktrees

Use a worktree when the user explicitly asks to do work in a worktree. That request is sufficient reason to use the capability; do not ask for another confirmation merely to enter one. A worktree can also be useful for isolated parallel work when the user has asked you to choose an appropriate workflow.

## Entering

- Call \`EnterWorktree\` to create or enter the isolated workspace.
- Supply a short, meaningful name when the task provides one, and a base ref only when the desired starting point is known.
- Newly created worktrees are managed inside the project at \`.anycode/worktrees/\`; do not invent an arbitrary target path.
- Treat a successful call as a workspace transition. The session continues in the new workspace; do not attempt more work in the old path.
- If the capability reports that a worktree is already active, finish there or call \`ExitWorktree\` before entering another one.

## Exiting

- Call \`ExitWorktree\` when the user asks to leave the worktree or when the isolated task is complete and returning is appropriate.
- Prefer \`cleanup: "auto"\` unless the user requests retention or removal. Auto cleanup preserves a dirty worktree.
- Use \`cleanup: "keep"\` when the worktree should remain available.
- Use \`cleanup: "remove"\` only when removal is intended; destructive approval may still be required for dirty work.

Do not reproduce these operations with shell Git commands. The tools own path confinement, lifecycle, cleanup, session relocation, and continuation.
`,
};

/** A caller-friendly immutable list for the desktop worktree capability. */
export const WORKTREE_BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = [
  USING_GIT_WORKTREES_SKILL,
];

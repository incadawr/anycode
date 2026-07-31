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

/**
 * Optional guidance for desktop surfaces that register BrowserOpen and
 * BrowserRead (night-track wave-1 cut §2.9). Docs-only: the skill never opens
 * a preview itself, and is deliberately absent unless the caller opts in
 * (same gate as the worktree skill above — mirrored by the same
 * preview-availability boolean the host uses to register the tools).
 */
export const USING_BROWSER_PREVIEW_SKILL: BuiltinSkillDefinition = {
  name: "using-browser-preview",
  description:
    "Use BrowserOpen/BrowserRead (and BrowserScreenshot, when available) to preview and iterate on a local HTML/Markdown artifact or a localhost dev server.",
  body: `# Using the browser preview

Use the browser-preview tools to see what an HTML or Markdown artifact you wrote actually looks like, and to catch runtime/console errors before telling the user it works.

## Workflow

1. Write the artifact (Write/Edit) — an \`.html\`/\`.htm\` file, a \`.md\` file, or point at a running localhost dev server.
2. Call \`BrowserOpen\` with \`path\` (a local file) or \`url\` (a localhost dev server, e.g. \`http://localhost:3000\`). A remote (non-localhost) URL requires the user's explicit approval — expect that call to pause for it.
3. Call \`BrowserScreenshot\` when it is registered to see the visible area as rendered (no scroll-stitching — only what fits in the window). Not every session has image input enabled; if the tool reports that, fall back to \`BrowserRead\`.
4. Call \`BrowserRead\` with \`include_console\` left at its default (true) to catch JavaScript errors and console warnings alongside the page text/HTML.
5. Fix anything the screenshot or console tail surfaced, then reload with \`BrowserOpen\` again using the SAME \`preview_id\` (navigates the existing window instead of stacking a new one).

## Notes

- \`.md\` files render through a sanitized Markdown pipeline; relative image paths in the source are not resolved — use absolute or data-URI images if a rendered screenshot needs to show one.
- Omitting \`preview_id\` targets the most recently opened live preview; if none is open, open one first.
- A remote URL is a deliberate escalation (network access outside the workspace) — do not retry around a declined approval.
`,
};

/** A caller-friendly immutable list for the desktop browser-preview capability. */
export const PREVIEW_BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = [
  USING_BROWSER_PREVIEW_SKILL,
];

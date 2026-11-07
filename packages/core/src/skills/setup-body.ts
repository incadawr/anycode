/** Shared setup policy; import-free so engine adapters need no runtime graph. */
export function anycodeSetupBody(location: string, tools: string): string {
  return `# AnyCode setup

${location}
${tools}

## Read the guide first

Read README.md first at the app documentation location above. It maps questions
and symptoms to pages and anchors. Follow only the relevant page, including its
scope, merge rules and verification instructions. Use the app's documentation,
not an unrelated workspace's docs/user folder. Do not maintain a separate topic
list or guess behavior from another engine.

## Secrets and edits

- NEVER print, quote or summarize API keys, tokens, passwords or other secret
  values. Refer to a secret by its env-var name or vault slot only.
- NEVER read ~/.anycode/secrets.json or auth files. Nothing needed for setup
  diagnosis requires their contents. Never copy credentials between files.
- Diagnose by reading relevant non-secret keys; do not dump entire settings files.
- Propose the minimal edit and obtain the user's approval before changing config.
  Prefer the Settings pane. Use only the approved editing tools; never write
  config through a shell command. Respect normal sandbox and approval restrictions.
- Expand ~ to the absolute home directory before file operations. If the home
  path is unknown, ask for it rather than guessing. Check environment variable
  names without printing values that could contain secrets.

## Diagnosis workflow, in order

1. Identify the tab's engine, workspace, folder trust and relevant Settings pane.
   Native connections and permission modes differ from CLI accounts and presets.
   Check load-problem strips and launch environment overrides before editing.
2. Read only the relevant sections of ~/.anycode/settings.json: provider
   connections (name and id, never credentials), permissions.alwaysAllow and
   permissions.classifier, tools, network, recognizer, roles, roleProfiles,
   codex, claude, communication, browser, sessionLimits, plugins, security,
   preview, ui or keybindings. Do not echo credential or authentication fields.
3. Check <project>/.anycode/config.json, then ~/.anycode/config.json for relevant
   mcpServers, lspServers, skills.disabled, hooks, telemetry, repoMap or webSearch.
   Use the guide's section-specific merge and trust rules; hooks from both
   files run user-first, and some sections replace the entire user section.
   Check <project>/.mcp.json if MCP is relevant, without exposing inline secrets.
4. List only relevant extension directories: <project>/.anycode/skills,
   <project>/.agents/skills, ~/.anycode/skills, ~/.agents/skills,
   <project>/.anycode/agents, ~/.anycode/agents, <project>/.anycode/workflows,
   ~/.anycode/workflows, <project>/.anycode/plugins and ~/.anycode/plugins.
   Inspect hook declarations in config rather than looking for a hooks folder.
   Consult the guide for worktree roots, managed plugin storage and data paths.
5. Report which setting applies and from which file, citing paths and the guide
   page. Explain the minimal fix and the pane where it can be checked. Do not
   change unrelated configuration.

## Verify after an approved change

Use README.md to find the relevant verification section. Most settings, MCP,
skills, hooks and workflows require a new session. Native profile changes can
apply on the next turn; new profile names in engine tabs require a new session.
App builtins use separate engine aliases; skills.disabled uses the original
builtin ids. Same-name filesystem files do not replace the engine app catalog.
Check the relevant pane and documentation before claiming a change took effect.
If a required reading tool or capability is unavailable, explain the limitation
and ask for the relevant non-secret excerpt; never invent a tool or result.
`;
}

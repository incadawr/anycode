# Troubleshooting

Checklists for the three common failures, and where problems are shown. Most
configuration (MCP servers, skills, profiles) is read when a **session starts**.
"Start a new session" is the first step almost everywhere.

## Scenario 1: "I added an MCP server and nothing happened"

1. Start a **new session**.
2. Open **Settings → MCP** and find the server row:
   - **Row present, failed**: the process or endpoint rejected the connection.
     The row shows the error (a bad command, a bad URL or an expired token).
   - **Row present, connected with a tool count**: it works. The tools may
     simply have names you have not tried yet.
   - **Row absent**: the entry was skipped at load time. Go to step 3.
3. Read the problem strip in the same pane. The usual causes:
   - Invalid JSON in the file. One bad comma drops every server in that file
     (`Invalid JSON in MCP config <path>: …`).
   - An entry with both `command` and `url`, or with neither
     (`must have exactly one of "command" (stdio) or "url" (http)`).
   - An unset `${env:NAME}` variable, which skips the server (`env var 'NAME'
     is not set — server skipped`). A Dock-launched app does not see your shell
     profile; see [mcp.md](mcp.md).
4. Fix the file, start a new session and check the pane again. The full reference
   is [mcp.md](mcp.md).

## Scenario 2: "How do I configure orchestrator roles?"

1. Read [orchestration.md](orchestration.md) for the pattern.
2. A role is a **markdown profile**, not a config key: one file per role in
   `<project>/.anycode/agents/<name>.md`. The format, the hard frontmatter rules,
   and examples are in [subagents.md](subagents.md).
3. Open **Settings → Subagents**. A profile that failed to load is missing from
   the list, and the pane shows a strip ("N profile(s) failed to load"). Expand it
   for the reason. Common causes: a missing `description`, `tools:` combined with
   `engine:`, or `connection:` combined with `provider:`.
4. Start a new session after you add or rename a profile. Native tabs pick up a
   new profile on the next turn; Codex and Claude tabs need the new session.

## Scenario 3: "Why is my skill not visible?"

Work down this list:

1. **Invalid file.** The name does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
   the `description` is missing, or the frontmatter is invalid. Open **Settings →
   Skills** and expand the "N skill(s) failed to load" strip.
2. **Shadowed.** A same-name skill exists in a higher root (project, then user,
   then plugins, then built-ins). Your file may be the one doing the shadowing.
3. **Disabled.** The name is in `skills.disabled` in the shared config, or was
   switched off in Settings → Skills.
4. **Too many skills.** At most 64 skills load per session after deduplication,
   and the prompt's skill list holds about 8,000 characters. Prune unused skills
   or shorten descriptions.
5. **Large body.** A body over 64 KiB still appears in the list, but it is cut
   off when loaded. Split it.
6. **No new session yet.** Discovery runs when a session starts.
7. **Engine tab.** Codex and Claude tabs do not receive AnyCode skills. Use a
   Native tab.

Reference: [skills.md](skills.md).

## Where problems are shown

- **In the panes.** Settings → Skills, Settings → Subagents and Settings → MCP
  show a strip for each file or entry that failed to load. Check these first.
- **In the app's console output.** Startup messages with the `[host]` prefix go to
  the console of the app process. Start AnyCode from a terminal to see them.
  AnyCode does not keep a log file.
- **In Settings → Environment.** Telemetry and repo-map status for the workspace.

## Still stuck?

Ask the model to use the built-in `anycode-setup` skill, for example "use the
anycode-setup skill to check why my MCP server is missing", in a Native tab. It
reads your settings and config files without changing them, names the file to
fix, and never prints secrets. Any edit it proposes still needs your approval.

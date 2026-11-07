# Troubleshooting

Checklists for the three common failures, and where problems are shown. Most
configuration (MCP servers, skills, profiles) is read when a **session starts**.
"Start a new session" is the first step almost everywhere.

## First look

Check the tab's engine, folder trust, relevant Settings pane and any launch
environment override. Native uses API connections and AnyCode permissions;
Codex and Claude use their CLI accounts and presets. A setting saved for new
sessions may not change a running tab.

## MCP server missing

1. Start a **new session**.
2. Open **Settings → MCP** and find the server row:
   - **Row present, failed**: the process or endpoint rejected the connection.
     The row shows the error (a bad command, a bad URL or an expired token).
   - **Row present, connected with a tool count**: it works. The tools may
     simply have names you have not tried yet.
   - **Row absent**: the entry was skipped at load time. Go to step 3.
3. Read the problem strip in the same pane. The usual causes:
   - Invalid JSON in the file. One bad comma drops every server in that file
     (`Invalid JSON in MCP config <path>`).
   - An entry with both `command` and `url`, or with neither
     (`must have exactly one of "command" (stdio) or "url" (http)`).
   - An unset `${env:NAME}` variable, which skips the server (`env var 'NAME'
     is not set — server skipped`). A Dock-launched app does not see your shell
     profile; see [mcp.md](mcp.md).
4. In an untrusted folder, project config and `.mcp.json` servers are skipped.
   Review [workspace trust](getting-started.md#workspace-trust). Engine tabs
   receive MCP config when the CLI process starts.
5. Fix the file, start a new session and check the pane again. The full reference
   is [mcp.md](mcp.md).

## Role refused in Orchestrate

1. Read [orchestration.md](orchestration.md) for Orchestrate mode and the
   manual pattern.
2. **Settings → Roles** routes five roles: `orchestrator` for the parent tab
   and `planner`, `executor`, `reviewer`, `explore` for child sessions. Child roles
   have an ordered fallback chain of engine, connection, model and effort.
   In Native tabs only, the `orchestrator` route is checked at turn start and
   can switch only model and effort, keeping the parent's engine and connection.
   In Codex Orchestrate, choose the parent model and effort on the tab; this role
   provides no automatic parent fallback. `planner`, `reviewer`
   and `explore` must stay on the Native engine; a refusal names the role and the fix.
3. To replace a role or add your own, write a markdown profile in
   `<project>/.anycode/agents/<name>.md`; a same-named profile replaces
   `planner`, `executor` or `reviewer` and its Settings → Roles route.
   `explore` and `general-purpose` are reserved. The format is in
   [subagents.md](subagents.md).
4. Open **Settings → Subagents**. A profile that failed to load is missing from
   the list, and the pane shows a strip ("N profile(s) failed to load"). Common
   causes: a missing `description`, `tools:` combined with `engine:`, or
   `connection:` combined with `provider:`.
5. Start a new session after you add or rename a profile. Native tabs pick up a
   new profile on the next turn; Codex and Claude tabs need the new session.

## Skill or profile missing

Work down this list:

1. **Invalid file.** The name does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
   the `description` is missing, or the frontmatter is invalid. Open **Settings →
   Skills** and expand the "N skill(s) failed to load" strip.
2. **Shadowed.** A same-name skill exists in a higher root: project `.anycode/skills`, project
   `.agents/skills`, user `.anycode/skills`, user `.agents/skills`, plugins,
   then built-ins. Your file may be the one doing the shadowing.
   Plugin contributions are listed per plugin in Settings → Plugins — see
   [plugins.md](plugins.md) for the tiers and consent rules. Non-official
   plugins cannot shadow builtin skill names; rejected roots show a problem.
3. **Disabled.** The name is in `skills.disabled` in the shared config, or was
   switched off in Settings → Skills.
4. **Too many skills.** At most 64 skills load per session after deduplication,
   and the prompt's skill list holds about 8,000 characters. Prune unused skills
   or shorten descriptions.
5. **Large body.** A body over 64 KiB still appears in the list, but it is cut
   off when loaded. Split it.
6. **No new session yet.** Discovery runs when a session starts.
7. **Engine tab.** Root Claude and Codex processes can receive the three app
   built-ins `anycode-setup`, `using-browser-preview`, and `control-browser`
   under [engine aliases](skills.md#built-into-anycode-in-claude-and-codex-tabs);
   browser skills require browser tools. Enable them and start a new process.
   Windows forwarding is unavailable, and CLI compatibility or preparation
   failures can leave them unavailable. Recognition does not guarantee model use.
   User and plugin filesystem skills are not forwarded; use a Native tab for
   those, or install skills independently under the CLI's own rules. File-based
   skills in a separate worktree are discovered from that worktree, not the main
   checkout. Child worktree isolation currently applies to new Core session
   children only; it separates working folders, not security permissions.
8. **Profile parse problem.** Unknown frontmatter keys are reported but do not
   prevent loading. Missing description, tools with engine, connection with
   provider and malformed supported fields reject the profile. Native picks
   profiles up on the next turn; engine tabs need a new session after new names.

Reference: [skills.md](skills.md).

## Child session limit reached

Wait for a child to finish, or inspect Settings → Tools.
`sessionLimits.childSessionsPerParentMax` is 1–8 (default 3);
`childSessionsGlobalMax` is 1–24 (default 8). A role profile's
`maxParallelChildren` can only lower the per-parent limit. Detached spawns fail
at capacity; synchronous spawns queue. See [roles](roles.md#parallel-children).

## Provider errors

- **401 / 403 or rejected key:** read the sanitized provider error and re-enter
  the key through the connection drawer. Subscription keys and pay-as-you-go
  keys may belong to different products, particularly MiniMax.
- **Model not found:** check the exact id in Settings → Provider. Catalog
  choices are hints; use Fetch models when offered, or enter an id.
- **Effort rejected:** choose a supported level. For custom endpoints, set
  Reasoning support and the accepted level list for that model.
- **Reasoning replay rejected:** AnyCode retries once without replay and
  remembers the rejection. Per-model Reasoning replay → Off avoids it.
- **No image understanding:** check Image input and Settings → Vision.
- **Quota:** inspect the connection card's provider-reported windows and reset
  times. An empty quota display does not prove the account is unlimited.
- **Timeouts or stalls:** `tools.stallTimeoutMs` defaults to 90 seconds per
  stream attempt; `maxRetries` to 8; `networkRetryBudgetMs` to five minutes;
  `networkWaitMaxMs` to 30 minutes. Check [proxy](proxy.md) and
  [launch overrides](configuration.md#environment-overrides) before changing them.

See [providers](providers.md) for the connection and per-model settings.

## Codex or Claude tab not ready

Read Settings → Codex / Claude status: binary missing, update required, not
trusted, signed out or error. Check launch overrides `ANYCODE_CODEX_BIN` /
`ANYCODE_CLAUDE_BIN` and binary consent. Codex can be installed from its pane;
Claude must be installed separately. Claude's sign-in action works only on
macOS; elsewhere run `claude auth login` in your terminal.
See [engines](engines.md). Claude Orchestrate is disabled in 0.0.90 because no
CLI version has qualified live capability evidence.

## Logs and crash dumps

- **Problem strips:** Settings → Skills, Subagents, MCP and Plugins show loading
  problems. Extensions → Hooks → Details shows hook config and matcher issues.
- **Diagnostic log:** `<userData>/logs/anycode.log`, with one rotated copy
  `anycode.log.1`, 1 MiB each. Known secret forms are redacted; review before sharing.
- **Native crashes:** `<userData>/crash-dumps/`, never automatically uploaded.
- **Export diagnostics:** the session Environment menu offers an anonymised
  bundle for the session and children, with a preview before saving. Existing
  telemetry records can be included even when new collection is off. Paths and
  prompts can still be sensitive.
- **Telemetry / repo map:** check Settings → Environment for workspace status.

`<userData>` is `~/Library/Application Support/AnyCode` on macOS,
`%APPDATA%\AnyCode` on Windows and normally `~/.config/AnyCode` on Linux
(or `$XDG_CONFIG_HOME/AnyCode`). See [files and paths](files-and-paths.md).

## Still stuck?

Ask the model to use the built-in `anycode-setup` skill, for example "use the
anycode-setup skill to check why my MCP server is missing", in any root tab.
Claude lists it as `anycode-app:anycode-setup`; Codex as `anycode-app-setup`. It
reads your settings and config files without changing them, names the file to
fix, and never prints secrets. Any edit it proposes still needs your approval.

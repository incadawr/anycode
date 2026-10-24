# Troubleshooting

Step-by-step checklists for the three classic failures, plus where the logs
live. General rule first: most configuration (MCP, skills, profiles) is read
at **session boot** — "restart the session" is step one of nearly everything
here, and "restart the app" fixes the rest.

## Scenario 1 — "I added an MCP server and nothing happened"

1. Start a **new session**. `mcpServers` is read at boot; a live session
   never picks up an edit.
2. Open **Settings → MCP** and look for the server row:
   - **Row present, `failed`** — the process/endpoint rejected the handshake;
     the row's detail text carries the error (bad command, bad URL, expired
     token).
   - **Row present, `connected · N tools`** — it works; the server just
     exports tools under names you have not tried yet.
   - **Row absent entirely** — the entry never made it past loading. Go to 3.
3. Row absent: the config was skipped **silently** (fail-soft). Check the
   logs, then the file, for the two usual causes:
   - **Invalid JSON** in the file — one bad comma drops *every* server in
     that file (`Invalid MCP config <path>: …` in the logs).
   - **Both `command` and `url`, or neither** — the entry needs exactly one
     (`must have exactly one of "command" (stdio) or "url" (http)`).
   - An unset `${env:MY_TOKEN}` variable also skips the server
     (`env var 'MY_TOKEN' is not set — server skipped`).
4. Fix, restart the session, re-check the pane. Full reference:
   [mcp.md](mcp.md).

## Scenario 2 — "How do I configure orchestrator roles?"

1. Read the pointer page: [orchestration.md](orchestration.md) — then the
   deep dive it links, `docs/orchestration.md`, for accounts, connections and
   the watchdog.
2. Roles are **markdown profiles**, not config keys: one file per role in
   `<project>/.anycode/agents/<name>.md`. The format, the three hard
   frontmatter rules, and one complete example per engine kind:
   [subagents.md](subagents.md).
3. Profile problems surface in **Settings → Subagents**: a profile rejected
   for a frontmatter problem (missing `description`, `tools:` combined with
   `engine:`, a bad `connection:`/`provider:` combination) is simply **absent**
   from the list — compare against the files on disk.
4. Remember the pickup rule: Native tabs pick a new profile up on the next
   turn; **Codex/Claude tabs need a new session** to see a new or renamed
   profile (body edits apply from the next spawn).

## Scenario 3 — "Why is my skill not visible?"

Work down this list — every item is silent by design:

1. **Frontmatter invalid** — `name` missing the pattern
   `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, or `description` absent. The skill is
   skipped with a problem line in the logs (`Skill discovery: skipping …`),
   never a chat error.
2. **Shadowed** — a same-name skill exists in a higher-precedence root
   (project > user > plugins > built-ins). Yours may be the one *doing* the
   shadowing while you stare at the other one's behavior.
3. **Disabled** — the name is in `skills.disabled` in the shared config.
   Settings → Skills shows disabled state.
4. **The 64-skill cap** — discovery stops at 64 skills after dedupe
   (lowest precedence dropped first); prune unused skills.
5. **Body over 64 KiB** — the skill *is* visible and listed; its body is
   **truncated** when loaded, not hidden. Split it.
6. **No new session yet** — discovery runs at session boot.
7. "Skill works in a Native tab but an engine tab doesn't see it" — engine
   tabs snapshot their skill list at session boot: start a **new session** in
   that tab.

Reference: [skills.md](skills.md).

## Where the logs live

- **The host log** — the session's host process writes boot and problem lines
  (`[host] …`) to its console output; on macOS the app's console output lands
  in Console.app under the AnyCode process. Every "silently skipped" item
  above writes a line here.
- **The per-session console** — the Console view in the app's bottom panel
  shows the live session's own output; discovery problems reported by the
  extensions bootstrap are visible there too.
- **Settings → Environment** — telemetry and repo-map status (including their
  config problems) for the workspace.

## Still stuck?

Run the built-in `anycode-setup` skill in a session (mention `$anycode-setup`
or call the `Skill` tool with it): it reads your settings and config files
read-only and points at the exact file to fix — it never edits anything
without your approval and never prints secrets.

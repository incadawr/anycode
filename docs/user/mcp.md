# MCP servers

MCP (Model Context Protocol) servers give the model extra tools. You declare a
server in a shared config file, never in `settings.json`. A server runs as a
local process (stdio) or is a remote endpoint (HTTP).

## Config files, in precedence order

A server name claimed by a higher source wins. The same name in a lower source is
ignored, even if the higher entry is disabled or failed.

1. `<workspace>/.anycode/config.json`: project scope.
2. `~/.anycode/config.json`: user scope.
3. `<workspace>/.mcp.json`: the Claude-ecosystem compatibility file, with the
   same `mcpServers` shape. The MCP pane shows these entries read-only, and
   **Import to project** copies one into the project config.

## One stdio server

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"],
      "cwd": "/optional/working/dir",
      "env": { "API_TOKEN": "${env:MY_TOKEN}" },
      "enabled": true
    }
  }
}
```

- `command` and `args` start the process. `cwd` is optional.
- `env` sets variables for the child. `${env:NAME}` takes its value from the
  environment AnyCode was started with.
- `inheritEnv: true` passes the whole parent environment, minus every `ANYCODE_*`
  variable. By default the child gets only `PATH`, `HOME` and `LANG`. Explicit
  `env` entries apply on top either way.
- `"enabled": false` turns the entry off without deleting it.

## One HTTP server

```json
{
  "mcpServers": {
    "internal-search": {
      "url": "https://mcp.internal.example.com/sse",
      "headers": { "Authorization": "Bearer ${env:SEARCH_TOKEN}" }
    }
  }
}
```

An entry needs exactly one of `command` (stdio) or `url` (HTTP). An entry with
both, or with neither, is skipped and reported.

## Secrets: `${env:NAME}` and `${secret:NAME}`

Never paste a literal token into a config file. Reference it instead. Two
references are available, and both work in `env` and `headers` values only:

- `${env:NAME}` reads an environment variable.
- `${secret:NAME}` reads AnyCode's secret store, the same encrypted store that
  holds your provider keys. It works for an app launched from the Dock or Finder,
  so no shell setup is needed.

A value can mix both, and a value can carry several references. For example:

```json
"headers": { "Authorization": "Bearer ${secret:GITHUB_TOKEN}" }
```

To add a secret, open **Settings → MCP → Secrets**, enter the name and the value,
and save. Values are write-only: the pane shows names and never shows a value
again. Names follow the environment-variable shape (letters, digits and
underscores, starting with a letter or underscore, up to 64 characters).

Changes apply to new sessions, not to a session already running. An unset
reference, for either form, skips the whole server rather than starting it with
an empty credential. The problem names the missing variable or secret, never a
value. `${secret:NAME}` does not apply to `command`, `args`, `cwd` or `url`, and
it is not available in the terminal CLI, which takes `${env:NAME}` only. Servers
declared by a plugin can use `${secret:NAME}` only when the same name is also
referenced by one of your config files; otherwise they skip with the same message.

For `${env:NAME}`, the variable must exist in the environment AnyCode starts from:

- A terminal-launched AnyCode inherits the variables exported in that terminal.
- A Dock- or Finder-launched app does not read `~/.zshrc` or any other shell
  profile. On macOS, set the variable with `launchctl setenv NAME value`, then
  restart AnyCode.

## Server instructions

A connected MCP server can send short usage instructions. AnyCode adds them to
the system prompt under a labelled block, one block per server, sorted by server
name. Each server's text is capped at 4,000 characters and the whole block at
12,000 characters. A server that is not loaded, or that failed to connect, never
contributes. Project servers contribute only after you trust the folder. The text
is third-party advice about that server's tools. It never overrides AnyCode's
rules, your instructions, or permission prompts.

## Failure behaviour

MCP loading is fail-soft, per file:

- A config file with invalid JSON is skipped entirely. Other files still load.
  The problem reads `Invalid JSON in MCP config <path>: …`.
- A file that fails the schema is skipped entirely, with `Invalid MCP config <path>: …`.
- A single entry that fails its checks is skipped alone, with
  `MCP server '<name>' in <path>: …`. Examples are a missing `command` or `url`,
  or an unset `${env:NAME}` variable.

These problems appear as strips in **Settings → MCP**.

## Managing servers in the pane

**Settings → MCP** lists the servers for the scope chosen at the top: **Global (user)**
or **Project** (with a workspace picker). The pane offers:

- **Add server**: name, transport (stdio or HTTP), command, arguments, working
  directory, URL, and environment variables. Values typed into the environment
  rows are masked afterwards; for tokens, prefer a `${env:NAME}` reference.
- **Import**: scans Claude, Codex, zcode and `.mcp.json` for servers and offers to
  add them. Imported servers start disabled until you enable them.
- Per-row controls to enable, edit or delete a server.

## How to verify it applied

1. **Start a new session.** `mcpServers` is read when a session starts. A live
   session does not pick up an edit.
2. Open **Settings → MCP** and find the server row. A connected row shows a
   tool-count badge such as `12 tools`. A row that failed shows its error.
3. A server missing from the list was skipped at load time. Look for the problem
   strip in the same pane.

For more causes, see [troubleshooting.md](troubleshooting.md).

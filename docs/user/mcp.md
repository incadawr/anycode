# MCP servers

MCP (Model Context Protocol) servers give the model extra tools. An MCP server
is declared in the shared config — never in `settings.json` — and can run as a
local process (stdio) or a remote endpoint (HTTP).

Requires AnyCode 0.0.35 or newer.

## Config files, in precedence order

A server name claimed by a higher-priority source wins; the same name in a
lower source is ignored.

1. `<workspace>/.anycode/config.json` — project scope
2. `~/.anycode/config.json` — user scope
3. `<workspace>/.mcp.json` — Claude-ecosystem compatibility file (same
   `mcpServers` shape)

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

- `command`/`args` spawn the process; `cwd` is optional.
- `env` sets variables for the child — `${env:VAR}` substitutes from the
  environment AnyCode runs in. **A referenced variable that is unset skips the
  whole server** (fail-closed, with a problem line in the logs).
- `inheritEnv: true` passes the full parent environment (minus `ANYCODE_*`
  keys) instead of the minimal `PATH/HOME/LANG` base; explicit `env` entries
  still apply on top.
- `"enabled": false` disables the entry without deleting it.

## One HTTP server

```json
{
  "mcpServers": {
    "internal-search": {
      "url": "https://mcp.internal.example.com/sse",
      "headers": {
        "Authorization": "Bearer ${env:SEARCH_TOKEN}"
      }
    }
  }
}
```

Exactly one of `command` (stdio) or `url` (http) per entry — an entry with
both, or with neither, is skipped with a problem line.

## The env-var secret pattern

Never paste a literal token into config. Reference it:

```json
{ "headers": { "Authorization": "Bearer ${env:SEARCH_TOKEN}" } }
```

The `${env:NAME}` substitution works in every `env` and `headers` value, and a
missing variable skips the server rather than sending an empty credential.
Export the variable in the environment AnyCode starts from (e.g. your shell
profile), so the substitution finds it after every restart.

## Failure behavior

MCP boot is fail-soft: a config file with invalid JSON, or entries that fail
validation, is skipped and **the app starts with zero servers from that file**
— other files still load, and nothing crashes. The skip reasons land in the
host log as problem lines (`[host] extensions: …`, `Invalid MCP config …`).

## How to verify it applied

1. **Restart the session** — `mcpServers` is read at session boot; a live
   session never picks up an edit.
2. Open **Settings → MCP** and find the server row: its status goes
   `connecting…` → `connected` with a tool count (e.g. `12 tools`), or
   `failed` with the error text. A server absent from the list entirely means
   its config was skipped — check the logs (invalid JSON, missing/extra
   `command`/`url`, or an unset `${env:…}` variable).
3. Run one of the tools the server exports in the session; a connected server
   with zero tools usually means the process started but the handshake failed
   — the row's detail text carries the error.

More checklists: [troubleshooting.md](troubleshooting.md).

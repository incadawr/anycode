# Language servers

Language servers (LSP) give the agent go-to-definition, references, and
diagnostics after edits. A server is a local process AnyCode starts and talks
LSP over stdio. You declare servers in the shared config file, never in
`settings.json`.

## Config files, in precedence order

A server name claimed by a higher source wins. Extensions are matched
lowercase with a leading dot; the first server claiming a file's extension
handles it.

1. `<workspace>/.anycode/config.json`: project scope. Entries here start only
   after you trust the folder.
2. `~/.anycode/config.json`: user scope, every project.

## One server entry

```json
{
  "lspServers": [
    {
      "name": "typescript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    }
  ]
}
```

- `name`: unique id, used for dedup between scopes.
- `command`: one executable name or an absolute path. The server binary must
  already be installed and on your PATH — AnyCode never installs it.
- `args`: fixed arguments (for most servers that is `["--stdio"]` or none).
- `extensions`: file extensions this server claims.
- `initializationOptions` (optional): passed through to the server on
  initialize. Not editable in the UI.

## The Settings pane

Settings → Language servers shows a catalog of known servers with a Found /
Not installed badge (an existence check over PATH and the common install
dirs, plus the project's `node_modules/.bin`; nothing is executed). For a
missing server the pane shows a copyable install command. **Enable for this
project** writes the entry into the project config; **Enable for all
projects** writes it into the user config. Remove deletes the entry. A
custom-entry form covers servers not in the catalog.

The pane also lists the configured entries per scope, shows the live status
of the active tab's servers (with a Restart action for crashed ones), and
surfaces config problems. The scope dropdown at the top picks the folder whose
config the pane edits, the same way as in the MCP pane. The scope dropdown at the top picks **User · This computer** (your user files) or a recent folder. The folder list is built from your recent sessions and open tabs; a folder with no open tab can still be edited, and its changes apply when a session starts there. A folder that no longer exists is shown as "folder not found" and cannot be selected. The chip shows the number of configured entries.

## When changes apply

The config is read once, when a session starts. Changes apply to NEW sessions
and tabs; open tabs keep the servers they started with. Restarting a crashed
server does not reload config.

## Related

- [configuration.md](configuration.md): the shared config file and its other
  keys.

# Hooks

A hook runs a shell command at a point in the agent loop. Hooks run in Native
sessions only, including the terminal client. They are trusted configuration:
the command itself does not go through a tool approval prompt. Review commands
before enabling them. A hook's decision controls the subsequent tool call.

## Configure a hook

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "^Bash$", "command": ".anycode/bin/check-bash.sh", "timeoutMs": 10000 }
    ],
    "PostToolUse": [
      { "matcher": "^(Write|Edit)$", "command": "pnpm -s lint --fix" }
    ]
  }
}
```

## Events and input

- **Where:** `hooks` in `<project>/.anycode/config.json` and `~/.anycode/config.json`.
  Hooks from **both** files run, user hooks first. Project hooks need a trusted
  folder.
- **Events:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`,
  `Stop`, `SubagentStop`.
- **Matcher** (optional regular expression) is tested against the tool name (tool
  events), the prompt text (`UserPromptSubmit`) or the subagent type
  (`SubagentStop`). `Stop` ignores it.
- **Input:** a JSON payload on stdin (`{ "event": …, … }`; for `PreToolUse`:
  `toolCallId`, `toolName`, `input`). Environment: `ANYCODE_HOOK_EVENT`,
  `ANYCODE_TOOL_NAME`, `ANYCODE_PROJECT_DIR`, plus `ANYCODE_SESSION_ID` and
  `ANYCODE_SESSION_WORKSPACE`. The working directory is the workspace.
- **Timeout:** `timeoutMs`, default 60,000 ms. Output is read up to 32 KB.
## Results and failures

- **Results:**
  - `PreToolUse`, exit 0: optional JSON on stdout
    `{ "permissionDecision": "allow" | "ask" | "deny", "reason": "…", "updatedInput": { … } }`.
    Empty or non-JSON output means no opinion. `updatedInput` is validated against the tool's
    schema again. A non-zero exit or timeout **denies** the call.
  - A hook can only make the decision stricter: its `allow` never bypasses an ask or a
    deny from the permission rules.
  - `UserPromptSubmit`: stdout is added to the prompt as context. A failure is skipped.
  - Other events: observers; a failure is logged as a warning.
- **Invalid JSON or schema:** loading hook configuration fails and no command hooks
  are registered. Check both config files and the panel error before retrying.
- **Check:** Extensions → Hooks shows the count per event; **Details** opens the
  Hooks panel (command, matcher, timeout, config error). In the CLI, use `/hooks`.

Plugin manifests may declare `hooks`, but plugins do not contribute hooks yet.


## Verify and troubleshoot

Start a new session after changing hooks. Open the session **Extensions → Hooks**
entry and **Details** to inspect event, command, matcher, timeout and load errors.
`/hooks` lists the loaded hooks in the CLI.

If a hook does not run, check folder trust, both config files, its regular
expression and whether the tab is Native. If calls are denied, inspect the
PreToolUse command's exit status and timeout. A successful hook with `allow`
cannot grant permission that the session's mode denies.

See [permissions](permissions.md), [configuration](configuration.md) and
[workspace trust](getting-started.md#workspace-trust).

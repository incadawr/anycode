# Workflows

A workflow is a fixed chain of subagent steps the model runs with the `Workflow`
tool.

## Define a workflow

```json
{
  "description": "Research a question on the web and write a cited summary.",
  "steps": [
    { "id": "search", "agentType": "general-purpose", "tools": ["WebSearch"], "maxTurns": 6,
      "promptTemplate": "Find sources for: ${input}" },
    { "id": "write", "agentType": "general-purpose", "dependsOn": ["search"], "maxTurns": 4,
      "promptTemplate": "Write a summary of ${input} from these sources:\n${steps.search}" }
  ],
  "outputTemplate": "${steps.write}"
}
```

## Discovery and validation

- **Where:** `<project>/.anycode/workflows/*.json`, then `~/.anycode/workflows/`, then
  plugin workflow folders, then bundled presets available in source checkouts. The higher source wins a name. Subfolders are not read. At most 32.
- **Schema:** `description` (required), optional `name` (defaults to the file
  name), 1–16 `steps`, each with `id`, `agentType` (a persona or profile name),
  `promptTemplate`, optional `dependsOn`, `tools` (extra tools such as `WebSearch`)
  and `maxTurns` (any positive integer), plus an optional `outputTemplate`.
- **Templates:** `${input}` and `${steps.<id>}`. A step can reference only steps listed
  in its own `dependsOn`. Cycles, duplicate ids and unknown steps reject the file.
- **Limits:** 600 s per step, 1,800 s per run, 100,000 bytes of output.
- **Run:** ask the model, for example "run the deep-research workflow on …". The system
  prompt lists available workflows. Children cannot start workflows. In the CLI,
  `/workflows` lists them.
- The `deep-research` example lives in the source repository
  ([deep-research.json](https://github.com/incadawr/anycode/blob/master/examples/workflows/deep-research.json)). Copy it into `.anycode/workflows/` to use it in
  the packaged app.


## Run and inspect

Ask for the workflow by name and supply its input. The Native `Workflow` tool
accepts the workflow name and input text; workflows use the same permissions
and configured profiles as other delegated work. A workflow is not a shell
script and does not bypass approval for its steps.

Independent steps can run when their dependencies are ready. Outputs flow
through declared dependencies; use `outputTemplate` for the final result.
Without one, the result combines terminal-step outputs.

An invalid definition is skipped with a problem rather than partially loaded.
An unknown `agentType` fails when the run starts. If a workflow is missing,
check `/workflows`, its flat file location, JSON syntax, name and step ids,
dependencies and source precedence. Start a new session after editing it.

The workflow list is available to Native sessions. Engine bridge catalogs
provide delegation, but do not expose this Native `Workflow` tool. See
[subagents](subagents.md) and [hooks](hooks.md) for other automation options.

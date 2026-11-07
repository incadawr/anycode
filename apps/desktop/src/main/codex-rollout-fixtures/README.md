# Codex rollout fixtures

These fixtures are synthetic and hand-written to match real rollout record shapes. They describe an invented TypeScript project, todo-cli, and contain no session content.

## Coverage matrix

Numbers refer to the coverage checklist (1 = plain chat, 2 = `exec_command` call/output pairs,
3 = `apply_patch` custom_tool_call + output, 4 = `exec` custom_tool_call with raw-string input,
5 = `message{role:"developer"}`, 6 = `reasoning` with empty AND non-empty `summary`, 7 =
`input_image`, 8 = unpaired call (no output), 9 = `custom_tool_call_output` with array output, 10
= a deliberately malformed JSON line, 11 = `web_search_call` / other exotic type).

| Fixture | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `basic-chat-developer-reasoning.jsonl` | x | | | | x | x(empty) | | | | | |
| `exec-pairs-and-apply-patch.jsonl` | | x | x | | x | x(empty) | | | | | |
| `exec-custom-tool-call-array-output.jsonl` | | | | x | x | | | | x | | |
| `unpaired-call-and-web-search.jsonl` | | | | | x | x(empty) | | x | | | x (`web_search_call`) |
| `input-image.jsonl` | | | | | x | x(empty) | x | | | | |
| `reasoning-nonempty-summary.jsonl` | | x | | | x | x(non-empty) | | | | | |
| `tool-search-and-batched-exec.jsonl` | | x | | | x | x(empty) | | | | | x (`tool_search_call`/`_output`) |
| `agent-message-inter-agent.jsonl` | | | | x | x | x(empty) | | | x | | x (`agent_message` as `response_item`, `inter_agent_communication_metadata`) |
| `malformed-json-line.jsonl` | x | | | | x | x(empty) | | | | x | |

All 11 checklist items are covered. `unknown-item-type.jsonl` also covers an unrecognized response item; the agent-message fixture covers unknown top-level and content-part types. The malformed line and the unpaired call are intentional.

## AnyCode setup

For questions about configuring AnyCode, read the documentation map first:
https://raw.githubusercontent.com/incadawr/anycode/master/docs/user/README.md
Follow the matching task or symptom to its page and anchor.
Resolve relative page links under the same raw docs/user/ directory.
Read only the relevant pages; check the installed version and engine.
Identify the workspace, folder trust and relevant Settings pane before editing.
Inspect only relevant non-secret settings; do not dump whole config files.
Apply the documented section-specific merge rules and launch overrides.
Never read ~/.anycode/secrets.json or any other secret or authentication store.
Never read ~/.codex/auth.json, $CODEX_HOME/auth.json or managed profile auth.json.
Managed Codex profiles live under `~/.anycode/codex/profile-<id>/`.
Never print, quote or summarize keys, tokens, passwords or other secret values.
Refer to secrets by environment-variable name or vault slot only.
Propose a minimal fix; obtain approval before changing configuration.
Prefer Settings; retain the reading/editing tools' normal approval restrictions.
Verify using the guide's instructions, including a new session when required.
If documentation cannot be read, ask for a relevant non-secret excerpt.

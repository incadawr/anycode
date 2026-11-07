# Engine builtin probes

Run `node apps/desktop/scripts/engine-skills-probe.mjs --self-test` first.
For Claude, pass `claude /absolute/path/to/installed/executable` instead.
Use the executable itself when a wrapper depends on the ambient home.
The probe creates disposable HOME, CLAUDE_CONFIG_DIR, XDG directories and cwd,
with an allowlisted environment and no copied authentication. It sends only
control initialize, never a user/model frame. It never logs raw CLI output.
A timeout, login requirement or missing catalog is an open compatibility result,
not proof of successful discovery. Do not retry with owner credentials.

The synthetic sealed plugin checks session-local directory loading and reports
whether this child's control catalog mentions the app namespace. The preview
browser is not involved. Catalog visibility does not prove SKILL.md body use,
full namespace/layout compatibility, or that the CLI never attempts writes.
Disabled omission and native synthetic clash have not been run.
No writable fallback is permitted. Runtime help gates the flag; preparation
failure disables the adapter. An unknown boot failure with `--plugin-dir` retries
once without the adapter so ordinary chat can open.
Known non-plugin failures (sign-in, binary trust/version, post-initialize
verification, cancellation) retain their original error without retry.

For app catalog scope, precedence and next-process switch behavior, see
[Skills](../user/skills.md#built-into-anycode-in-claude-and-codex-tabs). Model-use
acceptance is performed separately by the owner in a fresh authenticated profile.

For Codex, run `node apps/desktop/scripts/engine-skills-probe.mjs codex /absolute/native/codex`.
This mode requires a direct native executable, constructs fresh HOME/CODEX_HOME,
XDG, temp and cwd, and uses only initialize/initialized and skill RPCs. On macOS
it verifies a `sandbox-exec` deny-network guard with a synthetic connection;
without a working guard it runs offline help/schema only (handshake NOT RUN).
Tests run synthetic Node children and the harness self-test, never a real CLI.
The synthetic probe checks parent, `skills` and individual skill roots (including
sibling omission), process locality,
reset, duplicate coexistence and sealed bytes/modes. Codex 0.166.0 needed no
experimentalApi for these RPCs; the product capability still follows agentBridge.
The adapter supplies individual `<snapshot>/skills/<alias>` roots so a native
same-name entry suppresses only its app copy without changing sealed files.
Root host options enable delivery for fresh/resume and orchestration replacement.
Before thread work, exact metadata is checked against the native catalog. A wrong
readback requires verified reset; unknown set/reset state retires the process and
restarts once without forwarding. No foreign metadata-path bodies are read.
This proves neither model use nor compatibility with other CLI versions.

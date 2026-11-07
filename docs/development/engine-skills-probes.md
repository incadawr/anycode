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
No writable fallback is permitted. Runtime help gates the flag; preparation or
plugin boot failure disables the adapter and ordinary chat remains available.

`anycode-app` supplies a separate app builtin catalog. Filesystem skills do not
replace app definitions. The CLI's native registry follows CLI rules; AnyCode's
builtin disabled IDs apply on the next new process, including resume. Model-use
acceptance is performed separately by the owner in a fresh authenticated profile.

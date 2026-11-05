# Crash diagnostics

AnyCode saves native crash dumps locally and does not upload them. After a crash,
look for `.dmp` files anywhere under the `crash-dumps` folder in the app data
directory. On Windows, check `reports`; on macOS and Linux, check `completed`
and sometimes `pending`. The diagnostic log is
in `logs/anycode.log`, with one rotated file, `anycode.log.1`.

Default app data locations for packaged AnyCode:

- Windows: `%APPDATA%\AnyCode`
- macOS: `~/Library/Application Support/AnyCode`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/AnyCode`

Custom or isolated profiles use their own app data directory. If that directory
cannot be created, Electron uses its default crash dump location instead.

**Dumps can contain process memory, including secrets and private content.** Host output is filtered to a small set of diagnostic messages; other lines are counted and suppressed. Logs
redact common credential patterns but may still contain paths, prompts, file
contents, or secrets. Review what you can and decide whether to share these files;
AnyCode does not send them automatically.

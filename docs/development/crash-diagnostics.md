# Crash diagnostics

AnyCode saves native crash dumps locally and does not upload them. After a crash,
look in the `crash-dumps` folder under the app data directory. Electron may put
completed dumps in its `completed` or `pending` subfolder. The diagnostic log is
in `logs/anycode.log`, with one rotated file, `anycode.log.1`.

Default app data locations for packaged AnyCode:

- Windows: `%APPDATA%\AnyCode`
- macOS: `~/Library/Application Support/AnyCode`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/AnyCode`

Custom or isolated profiles use their own app data directory. If that directory
cannot be created, Electron uses its default crash dump location instead.

**Dumps can contain process memory, including secrets and private content.** Logs
redact common credential patterns but may still contain paths, prompts, file
contents, or secrets. Review what you can and decide whether to share these files;
AnyCode does not send them automatically.

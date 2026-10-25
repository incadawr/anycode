# channel-echo (example)

A copy-and-modify template for a channel: a plugin service that moves text between files and a Sessions API session.

1. Settings -> Plugins -> Install from folder, pick this `channel-echo` folder, and approve the service.
2. Settings -> Sessions API: turn the API on.
3. In a session's environment menu, turn on "Sessions API" and set a handle, for example `build-bot`.
4. Drop `build-bot__hello.txt` into `~/anycode-channel-echo/inbox/` (or `$CHANNEL_ECHO_DIR/inbox/`).
5. The answer appears as `outbox/build-bot__hello.answer.txt`.

See `docs/development/channel-plugins.md` for the author guide.

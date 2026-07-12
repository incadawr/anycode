# Developer workflow

`docs/development/` is public documentation for developers and coding agents:
reproducible commands, environment boundaries, and verification conventions.

It intentionally differs from local `working-docs/`:

- only first-party, publication-safe guidance belongs here;
- private research material, extracted prompts, tokens, session exports,
  screenshots containing user data, and other private artifacts do not;
- `working-docs/` remains local and is ignored by Git.

## Documents

- [Automation smoke](automation-smoke.md) — dev-only loopback automation,
  GUI smoke execution, and release-boundary verification.
- [Release policy](release.md) — versioning, alpha/beta stages, and the changelog.

## Basic change cycle

1. Isolate work in a branch or worktree and make the smallest viable change.
2. Run the narrowest relevant tests, then typecheck.
3. For desktop UI changes, run a production build; run the relevant smoke for
   an affected user flow.
4. Do not commit `out/`, `dist/`, profiles, screenshots, secrets, or local
   research notes.
5. Record the result and verification commands in the commit or PR.

This process is vendor-neutral: it can be executed manually or by Claude Code,
Codex, or another locally installed agent. The repository does not store their
credentials, system prompts, or private session artifacts.

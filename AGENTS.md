# AGENTS.md

See [CONTRIBUTING.md](CONTRIBUTING.md) for the public contribution workflow.

Public, versioned development guidance lives in
[`docs/development/`](docs/development/README.md):

- [automation smoke](docs/development/automation-smoke.md) — dev-only execution
  and the release boundary;
- [release policy](docs/development/release.md) — the alpha/beta line and release
  procedure;
- [`CHANGELOG.md`](CHANGELOG.md) — concise user-facing changes by version.

## UI work

Before changing UI, read `docs/development/ui.md` and check the public API of the UI-kit. Use or extend the kit primitives. If no suitable primitive exists, first implement it in `ui/` with an export, a Gallery entry and tests, then connect the feature. This may be done in one task; a separate task is needed only when the work is independently sized. A hand-made temporary overlay and an increase of a legacy baseline are not allowed. A UI hand-in needs the evidence described in `docs/development/ui.md`.

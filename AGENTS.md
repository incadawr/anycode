# AGENTS.md

Entry point for agents working in this repository. Local project history is
kept in `working-docs/references/anycode-inception/` (`START-HERE.md`,
`BLUEPRINT-anycode.md`) and is not published in Git. Working material and build
progress live in `working-docs/`.

Public, versioned development guidance lives in
[`docs/development/`](docs/development/README.md):

- [automation smoke](docs/development/automation-smoke.md) — dev-only execution
  and the release boundary;
- [release policy](docs/development/release.md) — the alpha/beta line and release
  procedure;
- [`CHANGELOG.md`](CHANGELOG.md) — concise user-facing changes by version.

## Task workflow

Use the project's configured task system and follow the local instructions for
starting, tracking, and submitting work. Review returned tasks and owner answers
first. Define new work with its context and acceptance criteria; submit finished
work for owner review rather than marking it accepted yourself. Historical task
files are an archive, not the active task list.

## Track orchestration

Multi-session background tracks (bg-orchestrator chains) are assembled ONLY
from the canonical template `working-docs/ORCHESTRATOR-TEMPLATE.md`: `[FIXED]`
sections are copied verbatim, `[FILL]` slots come from readable sources named
in the prompt. Do not author a track bootstrap from memory or from scratch.

## Other conventions

- `working-docs/build/**` belongs to the build track (`PROGRESS.md` is its source of truth); do not write there blindly from unrelated sessions.
- This repository often has two concurrent sessions; avoid placing coordination material in the shared tree unless necessary.

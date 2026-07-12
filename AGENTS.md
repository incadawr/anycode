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

## Task system (`working-docs`)

A lightweight task tracker lives in `working-docs/`:

| File | Purpose |
|------|-----------|
| `working-docs/TASKS.md` | Open tasks. One line per task: **ID · title · creation date · 5–10-word description**. |
| `working-docs/TASKS.DONE.md` | Completed tasks: rows moved from `TASKS.md` with a completion date. |
| `working-docs/tasks/TASK.{id}.md` | Full task description: context, symptom, root cause, work to do, and Definition of Done. |
| `working-docs/BACKLOG.md` | Unstructured notes and ideas that are not tasks yet. |

### Workflow

1. **Create a task:** take the next unused numeric `id`, create `working-docs/tasks/TASK.{id}.md` with the full detail, and add one row to `TASKS.md`.
2. **Complete a task:** move its row from `TASKS.md` to `TASKS.DONE.md` with the completion date and change `Status: open` to `done` in its `TASK.{id}.md`.
3. Put **notes that are not tasks** in `BACKLOG.md`; turn them into a `TASK.{id}` once they are ready.

> The initial tasks, created on 2026-07-05, are TASK.1 and TASK.2: two independent defects from one incident (`glm-5.2`, project `/tmp/test-1`).

## Other conventions

- `working-docs/build/**` belongs to the build track (`PROGRESS.md` is its source of truth); do not write there blindly from unrelated sessions.
- This repository often has two concurrent sessions; avoid placing coordination material in the shared tree unless necessary.

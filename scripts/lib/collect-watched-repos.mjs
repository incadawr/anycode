/**
 * Repositories the scheduled codex-manifest watch may open its tracking
 * issue against (`.github/workflows/codex-manifest-watch.yml` passes
 * `--repo ${{ github.repository }}`).
 *
 * A list, not a single string, on purpose: a future claude-doctor support
 * range can join without redesigning the flag grammar or the issue flow.
 */
export const WATCHED_REPOS = Object.freeze(["incadawr/anycode"]);

/**
 * Taskana 4104 (TASK.110): the desktop's artifact-store root — the SAME
 * conditional the CLI uses (cli/main.ts artifactsRoot) and the desktop's own
 * checkpoints root uses (host/index.ts checkpointsRoot): beside the sqlite DB,
 * `:memory:` falls back to `<home>/.anycode/artifacts`. One helper, both
 * processes (main sweeps, host writes), so the two can never drift.
 *
 * Host/main-ONLY module: nothing under apps/desktop/src/renderer may import it
 * (renderer-bundled shared/ modules must stay zero-Node; see shared/previewable.ts).
 */
import { dirname, join } from "node:path";

export function artifactsRootFor(dbPath: string, home: string): string {
  return dbPath === ":memory:"
    ? join(home, ".anycode", "artifacts")
    : join(dirname(dbPath), "artifacts");
}

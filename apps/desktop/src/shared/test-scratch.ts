/**
 * TEST-ONLY. A scratch directory for tests that place a REAL executable on disk
 * and let the production trust gate (shared/codex-binary-trust.ts) stat it.
 *
 * `os.tmpdir()` cannot serve that purpose, and the tests that assumed it could
 * ("mkdtemp gives a 0700 directory we own — trusted by construction") were
 * wrong: the policy walks the FULL ANCESTOR CHAIN of the binary, and on Linux
 * `os.tmpdir()` is `/tmp`, mode 0777+sticky. The policy refuses that on
 * purpose — anyone can plant a file there and win the swap race, and the sticky
 * bit does not rescue it (see `unsafeReason`; codex-binary.test.ts asserts
 * exactly this "the /tmp shape" refusal). A 0700 `mkdtemp` CHILD of /tmp does
 * not help: /tmp itself is the swap surface.
 *
 * macOS hides the whole problem, because its per-user `$TMPDIR`
 * (`/var/folders/…/T/`) is 0700 — which is why these tests were green on every
 * developer machine and red the first time they ran on a Linux CI runner.
 *
 * The scratch therefore lives inside the package's own (git-ignored)
 * `node_modules`, i.e. inside the checkout: an ancestor chain owned by us and
 * writable by nobody else on both platforms — the same chain a real `codex`
 * install has to satisfy.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_ROOT = fileURLToPath(new URL("../../node_modules/.anycode-scratch/", import.meta.url));

/** A fresh `<prefix>-XXXXXX` directory the Codex trust policy accepts. Caller removes it. */
export function makeTrustedScratchDir(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
}

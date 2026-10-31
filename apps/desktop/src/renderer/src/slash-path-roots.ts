/**
 * The names that exist directly under the filesystem root, for the slash guard
 * (slash-menu.ts's `unknownSlashCommandNotice`). A draft like `/tmp`, `/etc` or
 * `/Users` is a user writing an absolute path; `/foo` is a mistyped command.
 * Both are spelled the same way and only the disk can tell them apart.
 *
 * The renderer is sandboxed and cannot stat anything, so main names the entries
 * of the filesystem root once per session (`window.anycode.paths.roots()`, see
 * shared/path-roots.ts). `STANDARD_ROOT_NAMES` answers until that read lands, if
 * it never does, and on top — an unusual root-level directory the live list
 * adds is a path too.
 */

/**
 * Conventional entries of a Unix/macOS filesystem root. Only names — this is a
 * starting answer, not an allowlist: the live listing from main is merged in
 * and wins for anything it names.
 */
export const STANDARD_ROOT_NAMES: ReadonlySet<string> = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "cores",
  "dev",
  "etc",
  "home",
  "media",
  "mnt",
  "net",
  "nix",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "snap",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
]);

let names: ReadonlySet<string> = STANDARD_ROOT_NAMES;
let readStarted = false;

/**
 * The root entry names known so far. The FIRST call starts the one-shot live
 * read (it is idempotent), so callers never have to think about priming — the
 * conventional names already answer synchronously, which is what a submit-time
 * guard needs.
 */
export function slashPathRootNames(): ReadonlySet<string> {
  if (!readStarted) {
    readStarted = true;
    const bridge = typeof window === "undefined" ? undefined : window.anycode?.paths;
    void bridge
      ?.roots()
      .then((result) => {
        if (result.names.length > 0) {
          names = new Set([...STANDARD_ROOT_NAMES, ...result.names]);
        }
      })
      .catch(() => undefined);
  }
  return names;
}

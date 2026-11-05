import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Start before app readiness and before spawning renderers or utility processes. */
export function startLocalCrashReporting(
  app: { getPath(name: "userData"): string; setPath(name: "crashDumps", path: string): void },
  reporter: { start(options: { uploadToServer: false }): void },
  makeDirectory: (path: string) => void = (path) => { mkdirSync(path, { recursive: true }); },
): void {
  try {
    const directory = join(app.getPath("userData"), "crash-dumps");
    makeDirectory(directory);
    app.setPath("crashDumps", directory);
  } catch { /* retain Electron's default crash directory if the override fails */ }
  reporter.start({ uploadToServer: false });
}

import type { App } from "electron";

const processTypes = new Set(["Browser", "Tab", "Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker", "Unknown", "renderer"]);
const reasons = new Set(["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure"]);

export function processGoneLine(type: unknown, reason: unknown, exitCode: unknown): string {
  const safeType = typeof type === "string" && processTypes.has(type) ? type : "unknown";
  const safeReason = typeof reason === "string" && reasons.has(reason) ? reason : "unknown";
  const safeCode = typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? String(exitCode) : "unknown";
  return `process gone: type=${safeType} reason=${safeReason} exitCode=${safeCode}`;
}

export function installProcessDiagnostics(app: Pick<App, "on">, write: (line: string) => void): void {
  app.on("child-process-gone", (_event, details) => {
    try { write(processGoneLine(details.type, details.reason, details.exitCode)); } catch { /* best effort */ }
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    try { write(processGoneLine("renderer", details.reason, details.exitCode)); } catch { /* best effort */ }
  });
}

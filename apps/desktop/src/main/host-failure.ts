import { classifyHostStderr } from "../host/safe-failure.js";
import type { HostFailure } from "../shared/host-failure.js";

/** Raw stderr is used only to select fixed descriptions. */
export function hostFailure(code: HostFailure["code"], stderr = "", exitCode?: number, signal?: string): HostFailure {
  const description = code === "global_storm" ? "Session host stopped after repeated crashes across tabs." : code === "per_tab_crash_loop" ? "Session host stopped after repeated crashes." : "Session host could not start.";
  const { kind, systemCode: system } = classifyHostStderr(stderr);
  const safeExit = Number.isInteger(exitCode) && exitCode! >= 0 && exitCode! <= 255 ? exitCode : undefined;
  const safeSignal = signal && ["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP"].includes(signal) ? signal : undefined;
  const details = [safeExit !== undefined ? `exit code ${safeExit}` : "", safeSignal ?? "", kind ?? "", system ?? ""].filter(Boolean).join(", ");
  return { code, message: `${description}${details ? ` (${details})` : ""}`.slice(0, 256), ...(safeExit !== undefined ? { exitCode: safeExit } : {}), ...(safeSignal ? { signal: safeSignal } : {}) };
}

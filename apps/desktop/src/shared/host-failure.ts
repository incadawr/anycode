/** Safe, main-owned description of a terminal host failure. */
export interface HostFailure {
  code: "per_tab_crash_loop" | "global_storm" | "spawn_refused";
  message: string;
  exitCode?: number;
  signal?: string;
}

import type { GitInput } from "../tools/schemas.js";
import type { ExecStatus } from "./execution.js";

export interface GitReadOutput {
  notice?: string;
  status: ExecStatus;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdout: string;
  stderr: string;
}

export interface GitReadPort {
  read(input: GitInput, cwd: string, signal: AbortSignal): Promise<GitReadOutput>;
}
